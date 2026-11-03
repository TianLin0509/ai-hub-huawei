'use strict';
// 负责人组队（2026-11-01 用户）：任何会话都能当负责人。负责人提交招人计划（几个会话、各用哪个账号、各做什么），
// 用户在侧栏批准后 Hub 才建子会话，子会话挂在负责人下面。负责人与成员直接互发消息；成员之间默认不直连，
// 由负责人开放。招人只认界面上的批准（decide 只从 IPC 进来），模型无论怎么调接口都绕不过这一步。
// 调用入口：hookServer 的 POST /api/team（共享 token + 与 sessionId 绑定的 CLAUDE_HUB_TEAM_TOKEN），
// 命令行 scripts/hub-team.js 包了一层。投递复用普通会话的提交闭环（submitPrompt），插话复用群聊的 injector。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_MEMBERS = 8;
const NOTICE_LIMIT = 1800;
const TICK_MS = 3000;
const LEAD = 'lead';

const newId = prefix => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const clip = (text, n) => (text.length > n ? text.slice(0, n) + `…（超过约 ${n} 字已截断，长内容请写进文件后发路径）` : text);

function createTeamService(deps) {
  const allowedKinds = ['codeagent'];
  const approver = '用户';
  const {
    getHubDataDir, sessionManager, sendToRenderer = () => {}, logger = console, now = () => Date.now(),
    createSession, submitPrompt, injectPrompt = null, restartSession = null,
    listAccounts = () => ({ rows: [] }), commandPath = () => '', wakeSession = null,
  } = deps;
  const teams = new Map();
  const sending = new Set();
  const decisions = new Map(); // 同一负责人审批串行，不阻塞其他团队。
  const wakeTried = new Map();   // sid → 上次尝试唤醒的时间：休眠的收件人一分钟内只叫一次
  let timer = null, loaded = false, frozen = false;

  const dir = () => path.join(getHubDataDir(), 'teams');
  const fileOf = leadSid => path.join(dir(), leadSid + '.json');
  const safeSid = sid => typeof sid === 'string' && /^[\w-]{4,80}$/.test(sid);

  function load() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try { names = fs.readdirSync(dir()).filter(n => n.endsWith('.json')); } catch { return; }
    for (const name of names) {
      try {
        const team = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8'));
        if (!team || !safeSid(team.leadSid)) continue;
        // Hub 重启时正在送的消息结果不明：保留内容，交给负责人决定是否重发，不自动重发。
        let changed = false;
        for (const m of team.messages || []) if (m.state === 'sending') { m.state = 'unconfirmed'; m.error = 'Hub 重启前可能已送达，请先核对对方会话再决定是否重发'; changed = true; }
        teams.set(team.leadSid, team);
        for (const plan of team.plans || []) {
          const interrupted = (plan.members || []).filter(m => m.status === 'creating');
          if (!interrupted.length) continue;
          for (const spec of interrupted) {
            spec.status = 'interrupted';
            const member = team.members?.find(m => m.memberId === spec.memberId);
            if (member?.status === 'creating') member.status = 'interrupted';
          }
          enqueue(team, 'hub', LEAD, `计划 ${plan.id} 有 ${interrupted.length} 人没建完（Hub 中途重启），请重新提交这几人的计划：${interrupted.map(m => m.title).join('、')}`, { wake: true });
          changed = true;
        }
        if (changed) save(team);
      } catch (error) { logger.warn?.('[team] 读取失败', name, error.message); }
    }
  }
  function save(team) {
    team.updatedAt = now();
    fs.mkdirSync(dir(), { recursive: true });
    const file = fileOf(team.leadSid), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(team, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    sendToRenderer('team:changed', { leadSid: team.leadSid, team: publicView(team) });
  }

  function teamOfLead(sid) { load(); return teams.get(sid) || null; }
  function teamOfMember(sid) {
    load();
    for (const team of teams.values()) {
      const member = (team.members || []).find(m => m.sid === sid && m.status !== 'dismissed');
      if (member) return { team, member };
    }
    return null;
  }
  function memberBySid(team, sid) {
    if (sid === team.leadSid) return { memberId: LEAD, sid, role: '负责人' };
    return (team.members || []).find(m => m.sid === sid) || null;
  }
  function memberById(team, id) {
    if (id === LEAD) return { memberId: LEAD, sid: team.leadSid, role: '负责人' };
    return (team.members || []).find(m => m.memberId === id && m.sid && m.status === 'active') || null;
  }
  function sessionState(sid) {
    const s = sessionManager.getSession(sid);
    if (!s) return 'missing';
    if (s.status === 'dormant') return 'dormant';
    return sessionManager.isAgentTurnActive(sid) ? 'running' : 'idle';
  }

  function publicView(team) {
    return {
      leadSid: team.leadSid, createdAt: team.createdAt, updatedAt: team.updatedAt,
      members: (team.members || []).map(m => ({ memberId: m.memberId, sid: m.sid, role: m.role, kind: m.kind, account: m.account || '', title: m.title, status: m.status, ...(m.model ? {model:m.model} : {}) })),
      plans: (team.plans || []).map(p => ({ id: p.id, status: p.status, goal: p.goal, members: p.members, submittedAt: p.submittedAt, decidedAt: p.decidedAt || 0, note: p.note || '' })),
      grants: (team.grants || []).slice(),
    };
  }
  function listTeams() { load(); return [...teams.values()].map(publicView); }

  // ---- 计划 ----
  function rejectTuning(raw) {
    const fields = ['model', 'effort', 'codexSpeedTier', 'fastMode', 'speed']
      .filter(key => key !== 'model' && Object.hasOwn(raw || {}, key));
    if (fields.length) throw Error(`公司组队计划只支持选择账号和模型，不能指定 ${fields.join(' / ')}`);
  }
  function normalizePlan(args, team) {
    rejectTuning(args);
    const goal = String(args.goal || '').trim();
    const list = Array.isArray(args.members) ? args.members : [];
    if (!goal) throw Error('计划要写 goal：这批人一起要完成什么');
    if (!list.length) throw Error('计划至少招 1 人：members 是数组，每项写 role、task，可选 kind、account、cwd、title');
    const active = occupiedSlots(team);
    if (active + list.length > MAX_MEMBERS) throw Error(`每位负责人最多 ${MAX_MEMBERS} 名成员（现有 ${active} 名）`);
    const accountList=listAccounts();
    return { goal, members: list.map((raw, i) => {
      rejectTuning(raw);
      const role = String(raw?.role || '').trim(), task = String(raw?.task || '').trim();
      const kind = String(raw?.kind || 'codeagent').trim();
      if (!role || !task) throw Error(`第 ${i + 1} 人要写 role（分工）和 task（开工任务，可写任务书路径）`);
      if (!allowedKinds.includes(kind)) throw Error(`第 ${i + 1} 人的 kind 只能是 ${allowedKinds.join(' / ')}`);
      const account = String(raw?.account || accountList.recommendedId || '').trim();
      let model='';
      {
        const row=(accountList.rows || []).find(a=>a.id===account);
        if(!row || !row.usable)throw Error(`第 ${i+1} 人的号池账号不可用，请用 accounts 查看并选择可用账号`);
        model=String(raw?.model || '').trim();
        if(model&&!require('../../core/codeagent-models').isSafeModelId(model))throw Error(`第 ${i+1} 人的模型名称无效`);
        if(model&&row.modelsAuthoritative&&!row.models.some(m=>m.toLowerCase()===model.toLowerCase()))throw Error(`第 ${i+1} 人的账号没有 ${model} 权限，请从该账号的 models 清单选择`);
        if(model)model=row.models.find(m=>m.toLowerCase()===model.toLowerCase()) || model;
      }
      const cwd = String(raw?.cwd || '').trim();
      if (cwd && !fs.existsSync(cwd)) throw Error(`第 ${i + 1} 人的工作目录不存在：${cwd}`);
      return { role, task, kind, account, cwd, title: String(raw?.title || role).trim().slice(0, 40), model };
    }) };
  }
  function propose(callerSid, args) {
    if(!/^codeagent(?:-resume)?$/.test(sessionManager.getSession(callerSid)?.kind || ''))throw Error('公司组队请从 CodeAgent 会话提交计划');
    if (teamOfMember(callerSid)) throw Error('成员不能招人；需要人手请向负责人提');
    let team = teamOfLead(callerSid);
    const plan = normalizePlan(args, team);
    if (!team) {
      team = { leadSid: callerSid, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(callerSid, team);
    }
    for (const p of team.plans) if (p.status === 'pending') { p.status = 'withdrawn'; p.decidedAt = now(); p.note = '负责人提交了新版计划'; }
    const item = { id: newId('plan'), status: 'pending', ...plan, submittedAt: now() };
    team.plans.push(item);
    save(team);
    return { planId: item.id, status: 'pending', note: `计划已提交，等${approver}在 Hub 侧栏（你这个会话那一行的「待批准」）批准。批准前不会建任何会话；批准或驳回的结果会作为一条消息发给你。` };
  }

  // 只由界面调用（main/ipc/team-handlers.js）：用户点批准或驳回。
  function occupiedSlots(team) { return (team?.members || []).filter(m => !['dismissed', 'failed', 'interrupted'].includes(m.status)).length; }
  function decide(request) {
    if (frozen) return Promise.reject(Error('Hub 正在关闭'));
    const previous = decisions.get(request.leadSid);
    const result = previous ? previous.catch(() => {}).then(() => decideNow(request)) : decideNow(request);
    decisions.set(request.leadSid, result);
    const clear = () => { if (decisions.get(request.leadSid) === result) decisions.delete(request.leadSid); };
    result.then(clear, clear);
    return result;
  }
  async function decideNow({ leadSid, planId, approve, note = '', edits = null }) {
    if (frozen) throw Error('Hub 正在关闭');
    const team = teamOfLead(leadSid);
    const plan = team?.plans.find(p => p.id === planId);
    if (!plan || plan.status !== 'pending') throw Error('这份计划已经处理过或不存在');
    note = String(note || '').trim();
    if (!approve) {
      plan.status = 'rejected'; plan.decidedAt = now(); plan.note = note;
      save(team);
      enqueue(team, 'hub', LEAD, `${approver}驳回了招人计划 ${plan.id}${note ? '：' + note : ''}。按意见修改后可重新提交。`, { wake: true });
      return { ok: true, status: 'rejected' };
    }
    const occupied = occupiedSlots(team);
    if (occupied + plan.members.length > MAX_MEMBERS) throw Error(`每位负责人最多 ${MAX_MEMBERS} 名成员（已有及创建中 ${occupied} 名，本计划 ${plan.members.length} 名），无法批准`);
    // 批准时核对当前账号状态；公司版还允许修改模型，分工和任务保持计划内容。
    {
      // Revalidate the edited account/model and current pool state before any
      // member is created. A stale approval must not fall back to another kind.
      const members=plan.members.map((m,i)=>({...m,...(typeof edits?.[i]?.account==='string'?{account:edits[i].account}:{}),
        ...(typeof edits?.[i]?.model==='string'?{model:edits[i].model}:{})}));
      plan.members=normalizePlan({...plan,members},team).members;
    }
    plan.status = 'approved'; plan.decidedAt = now(); plan.note = note;
    // 首个 await 前预留本计划全部编号和名额，落盘后才启动会话。
    let nextId = Math.max(0, ...team.members.map(m => Number(m.memberId.slice(1)) || 0));
    for (const spec of plan.members) {
      spec.memberId = 'm' + (++nextId); spec.status = 'creating';
      team.members.push({ memberId: spec.memberId, sid: null, role: spec.role, kind: spec.kind,
        account: spec.account, title: spec.title, planId: plan.id, status: 'creating', model: spec.model });
    }
    save(team);
    const lead = sessionManager.getSession(leadSid);
    const created = [], failed = [];
    for (const spec of plan.members) {
      if (frozen) break; // 未启动的名额留 creating，重启时转 interrupted 并通知负责人。
      const memberId = spec.memberId;
      const member = team.members.find(m => m.memberId === memberId);
      try {
        // 未选模型时沿用所选号池账号的默认模型。
        const opts = { cwd: spec.cwd || lead?.cwd || undefined, title: spec.title, workspaceLabel: spec.title,
          codeagentAccount: 'pool', codeagentPoolPick: spec.account };
        if (spec.model) { opts.model = spec.model; opts.codeagentModelPick = true; }
        const session = await createSession({ kind: spec.kind, opts });
        if (!session?.id) throw Error('Hub 没返回新会话');
        const account = spec.account || session.codeagentPoolAccount;
        Object.assign(member, { sid: session.id, account: account || '', joinedAt: now(), status: 'active' });
        spec.status = 'created'; spec.sid = session.id;
        save(team);
        created.push(member);
        enqueue(team, LEAD, memberId, kickoff(team, member, spec, plan), { kickoff: true });
      } catch (error) {
        spec.status = 'failed'; spec.error = String(error.message || error);
        member.status = 'failed'; member.error = spec.error;
        failed.push(`${spec.title}：${spec.error}`); save(team);
      }
    }
    save(team);
    const roster = created.map(m => `${m.memberId} ${m.title}（${m.role}${m.account ? '，账号 ' + m.account : ''}）`).join('；');
    enqueue(team, 'hub', LEAD, `${approver}批准了招人计划 ${plan.id}${note ? '（备注：' + note + '）' : ''}。已建成员：${roster || '无'}。` +
      (failed.length ? `未建成：${failed.join('；')}。` : '') + '已创建成员的开工任务已排队；用 status 查看全队状态。', { wake: true });
    return { ok: true, status: 'approved', created: created.map(m => m.memberId), failed };
  }

  function kickoff(team, member, spec, plan) {
    const cmd = commandPath();
    return [
      `【组队开工 · 来自负责人】你是成员 ${member.memberId}，分工：${spec.role}。`,
      `团队目标：${plan.goal}`,
      `你的任务：${spec.task}`,
      '',
      '通信规矩：',
      `- 向负责人汇报：\`"${cmd}" send --to lead --message "结论 + 文件路径"\`；不急的加 \`--no-wake\`（不叫醒负责人，攒到它下次醒来一起看）。`,
      `- 消息只写结论和文件路径，超过约 ${NOTICE_LIMIT} 字会被截断，长内容写进文件。`,
      '- 要和其他成员直接交流，先向负责人说明原因，由负责人开放。',
      `- 看全队：\`"${cmd}" status\`。`,
      '- 在 PowerShell 里运行时，命令前加 `&`（例：`& "…hub-team.cmd" status`）。',
      '- 本团队只使用 CodeAgent；你不能再招人，需要人手请向负责人说明。',
      '- 里程碑、卡住、需要拍板、完成时都汇报一次。',
    ].join('\n');
  }

  // ---- 消息 ----
  function enqueue(team, from, to, text, extra = {}) {
    team.messages ||= [];
    const item = { id: newId('msg'), from, to, text, state: 'queued', at: now(), ...extra };
    team.messages.push(item);
    if (team.messages.length > 500) team.messages = team.messages.filter(m => m.state !== 'sent').concat(team.messages.slice(-300)).filter((m, i, a) => a.indexOf(m) === i);
    save(team);
    setImmediate(() => flush(team).catch(error => logger.warn?.('[team] 投递失败', error.message)));
    return item;
  }
  function send(callerSid, args) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD, sid: callerSid } } : teamOfMember(callerSid);
    if (!found) throw Error('你还不在任何团队里；负责人先用 propose 提交招人计划');
    const { team, member: caller } = found;
    const target = memberById(team, String(args.to || ''));
    const text = String(args.message || '').trim();
    if (!text) throw Error('message 不能为空');
    if (!target || target.memberId === caller.memberId) throw Error('to 写本队另一位成员编号（负责人是 lead，成员是 m1、m2…）');
    const peer = caller.memberId !== LEAD && target.memberId !== LEAD;
    if (peer && !(team.grants || []).includes(pair(caller.memberId, target.memberId))) throw Error('成员之间直接交流要负责人先开放；请先发给 lead 说明原因');
    const wake = target.memberId === LEAD ? args.wake !== false : true;
    const interrupt = caller.memberId === LEAD && args.interrupt === true;
    const item = enqueue(team, caller.memberId, target.memberId, clip(text, NOTICE_LIMIT), { wake, interrupt });
    if (peer) enqueue(team, caller.memberId, LEAD, `（抄送）${caller.memberId} → ${target.memberId}：${clip(text, 600)}`, { wake: false, copy: true });
    return { messageId: item.id, status: 'queued', note: target.memberId === LEAD
      ? (wake ? '已排队，负责人空闲时送达（会叫醒它）。' : '已留言，负责人下次被叫醒时一起送达。')
      : (interrupt ? '对方忙时直接插进它当前的工作，空闲时作为新任务送达。' : '已排队，对方空闲时送达。') };
  }
  const pair = (a, b) => [a, b].sort().join(':');
  function allow(callerSid, args) {
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能开放或收回成员间交流');
    const a = memberById(team, String(args.memberA || '')), b = memberById(team, String(args.memberB || ''));
    if (!a || !b || a.memberId === b.memberId || a.memberId === LEAD || b.memberId === LEAD) throw Error('memberA、memberB 写两位不同的成员编号');
    if (typeof args.allow !== 'boolean') throw Error('allow 写 true 或 false');
    const key = pair(a.memberId, b.memberId), had = team.grants.includes(key);
    if (args.allow && !had) team.grants.push(key);
    if (!args.allow && had) team.grants = team.grants.filter(g => g !== key);
    save(team);
    if (args.allow !== had) {
      const reason = String(args.reason || '').trim();
      const text = args.allow ? `负责人开放了 ${a.memberId} 与 ${b.memberId} 的直接交流${reason ? '：' + reason : ''}。用 send --to <对方编号> 互发，消息会抄送负责人。`
        : `负责人收回了 ${a.memberId} 与 ${b.memberId} 的直接交流。之后经负责人沟通。`;
      enqueue(team, LEAD, a.memberId, text); enqueue(team, LEAD, b.memberId, text);
    }
    return { ok: true, grants: team.grants.slice() };
  }

  // 收件人空闲才送；发给负责人的消息只有「要叫醒」的那条到了，才连同攒着的留言一起送。
  async function flush(team) {
    if (frozen) return;
    const queued = (team.messages || []).filter(m => m.state === 'queued');
    const targets = [...new Set(queued.map(m => m.to))];
    for (const to of targets) {
      if (frozen) return;
      const target = memberById(team, to);
      if (!target) { for (const m of queued.filter(x => x.to === to)) { m.state = 'failed'; m.error = '收件人已离队'; } save(team); continue; }
      const lock = team.leadSid + ':' + to;
      if (sending.has(lock)) continue;
      // 重新取一遍：同时进行的另一轮投递可能已经送走了其中几条。
      const items = (team.messages || []).filter(m => m.state === 'queued' && m.to === to);
      if (!items.length || (to === LEAD && !items.some(m => m.wake !== false))) continue;
      if (target.kind === 'powershell' || sessionManager.getSession(target.sid)?.kind === 'powershell') {
        // 只在隔离测试里出现的非 AI 成员：消息记为已处理，不往终端里敲字。
        for (const m of items) { m.state = 'sent'; m.via = 'not-ai'; m.sentAt = now(); }
        save(team); continue;
      }
      const state = sessionState(target.sid);
      if (state === 'missing' || state === 'dormant') {
        // Hub 会让空闲会话自动休眠：有消息要送时把它叫醒（只叫侧栏里登记为休眠的会话，关掉的不复活）。
        if (typeof wakeSession === 'function' && now() - (wakeTried.get(target.sid) || 0) > 60000) {
          wakeTried.set(target.sid, now());
          sending.add(lock);
          try { await wakeSession(target.sid); } catch (error) { logger.warn?.('[team] 唤醒失败', target.sid, error.message); }
          finally { sending.delete(lock); }
        }
        continue;
      }
      if (state === 'running') {
        const urgent = items.find(m => m.interrupt);
        if (urgent && typeof injectPrompt === 'function') await interruptNow(team, urgent, target);
        continue;
      }
      sending.add(lock);
      const batch = to === LEAD ? items : [items[0]];
      batch.forEach(m => { m.state = 'sending'; });
      save(team);
      try {
        const text = batch.length === 1 && batch[0].kickoff ? batch[0].text : formatBatch(team, batch, to);
        const result = await submitPrompt(target.sid, text);
        // 回车后才按停止（stopped 但 notSent 不为 true）：成员可能已收到，按「待核对」处理，避免重发出两遍。
        if (result?.unconfirmed || (result?.stopped && !result.notSent)) markUnconfirmed(team, batch, to, result.message || result.error || '发送后被停止，可能已送达');
        else {
          // 粘贴时按停止，CodeAgent 回 {ok:true, stopped:true, notSent:true}：算没送达。
          if (result && (result.ok === false || result.notSent)) throw Error(result.message || result.error || '未发送（发送时被停止）');
          batch.forEach(m => { m.state = 'sent'; m.sentAt = now(); });
        }
      } catch (error) {
        batch.forEach(m => { m.state = 'failed'; m.error = String(error.message || error).slice(0, 300); });
        if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息没送达：${String(error.message || error).slice(0, 200)}。内容保留，可用 status 查看后重发。`);
      } finally {
        sending.delete(lock);
        save(team);
        if ((team.messages || []).some(m => m.state === 'queued' && m.to === to)) setImmediate(() => flush(team).catch(() => {}));
      }
    }
  }
  function markUnconfirmed(team, items, to, error) {
    const warning = '可能已送达，请先核对对方会话再决定是否重发';
    for (const item of items) { item.state = 'unconfirmed'; item.error = error ? `${String(error).slice(0, 200)}；${warning}` : warning; }
    if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息${warning}。用 status 查看保留的正文。`);
  }
  function formatBatch(team, batch, to) {
    const name = id => (id === 'hub' ? 'Hub' : id === LEAD ? '负责人' : `${id} ${memberById(team, id)?.title || ''}`.trim());
    const lines = batch.map(m => `- [${name(m.from)}${m.wake === false ? ' · 留言' : ''}] ${m.text}`);
    const cmd = commandPath();
    return [`【团队消息 · ${batch.length} 条】`, ...lines, '',
      to === LEAD ? `回复成员：\`"${cmd}" send --to <成员编号> --message "…"\`；看全队：\`"${cmd}" status\`。`
        : `回复：\`"${cmd}" send --to ${batch[0].from === 'hub' ? LEAD : batch[0].from} --message "…"\`。`].join('\n');
  }
  async function interruptNow(team, item, target) {
    const lock = team.leadSid + ':' + item.to;
    sending.add(lock); item.state = 'sending'; save(team);
    try {
      const result = await injectPrompt(target.sid, `## 负责人追加指示（${item.id}）\n${item.text}\n\n按这条指示调整当前工作，不重做已完成的部分。`);
      if (result?.uncertain) markUnconfirmed(team, [item], item.to);
      else if (result?.accepted) { item.state = 'sent'; item.sentAt = now(); item.via = 'interrupt'; }
      else {
        item.state = 'failed'; item.error = result?.message || result?.error || '插话未发送';
        enqueue(team, 'hub', LEAD, `发给 ${item.to} 的消息没送达：${item.error}。用 status 查看保留的正文。`);
      }
    } catch (error) { markUnconfirmed(team, [item], item.to, error.message); }
    finally { sending.delete(lock); save(team); }
  }

  // ---- 其他动作 ----
  function status(callerSid) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD } } : teamOfMember(callerSid);
    if (!found) return { team: null, note: `你还不在任何团队里。当负责人：先用 accounts 看可用账号，再用 propose 提交招人计划，等${approver}批准。` };
    const { team, member } = found;
    const mine = (team.messages || []).filter(m => m.to === member.memberId || m.from === member.memberId);
    return {
      you: member.memberId, leadSid: team.leadSid,
      members: [{ memberId: LEAD, title: sessionManager.getSession(team.leadSid)?.title || '负责人', state: sessionState(team.leadSid) }]
        .concat((team.members || []).map(m => ({ memberId: m.memberId, title: m.title, role: m.role, kind: m.kind, account: m.account, ...(m.model ? { model: m.model } : {}), status: m.status, state: m.status === 'dismissed' ? 'dismissed' : sessionState(m.sid) }))),
      plans: member.memberId === LEAD ? (team.plans || []).map(p => ({ id: p.id, status: p.status, size: p.members.length, note: p.note || '' })) : undefined,
      grants: team.grants,
      pendingForYou: mine.filter(m => m.to === member.memberId && m.state === 'queued').map(m => ({ from: m.from, text: m.text, wake: m.wake !== false })),
      undelivered: mine.filter(m => m.from === member.memberId && ['queued', 'failed', 'unconfirmed'].includes(m.state)).map(m => ({ id: m.id, to: m.to, state: m.state, text: m.text.slice(0, 200), error: m.error || '' })),
    };
  }
  async function restart(callerSid, args) {
    if (frozen) throw Error('Hub 正在关闭');
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能重启成员');
    const m = memberById(team, String(args.memberId || ''));
    if (!m || m.memberId === LEAD) throw Error('memberId 写成员编号');
    if (typeof restartSession !== 'function') throw Error('当前 Hub 不支持重启成员');
    const result = await restartSession(m.sid);
    if (result?.ok === false || result?.error) throw Object.assign(Error(result.message || result.error || '重启失败'), { code: result.error });
    if (result?.ok !== true && !(result?.id === m.sid && sessionManager.getSession(m.sid))) throw Error('Hub 未确认会话已重启');
    return { ok: true, note: '已重启（接着原会话历史）；需要的话再 send 一条让它继续。' };
  }
  function dismiss(callerSid, args) {
    const team = teamOfLead(callerSid);
    if (!team) throw Error('只有负责人能让成员离队');
    const m = memberById(team, String(args.memberId || ''));
    if (!m || m.memberId === LEAD) throw Error('memberId 写成员编号');
    m.status = 'dismissed'; m.dismissedAt = now();
    team.grants = team.grants.filter(g => !g.split(':').includes(m.memberId));
    save(team);
    return { ok: true, note: `已离队：不再收发团队消息，会话本身保留在侧栏，${approver}可以自己关闭。` };
  }

  async function invoke(callerSid, action, args = {}) {
    if (!safeSid(callerSid) || !sessionManager.getSession(callerSid)) throw Error('调用者不是本 Hub 的会话（缺 CLAUDE_HUB_SESSION_ID）');
    switch (action) {
      case 'status': return status(callerSid);
      case 'accounts': return accounts();
      case 'propose': return propose(callerSid, args);
      case 'send': return send(callerSid, args);
      case 'allow': return allow(callerSid, args);
      case 'restart': return restart(callerSid, args);
      case 'dismiss': return dismiss(callerSid, args);
      default: throw Error('未知动作；可用：status / accounts / propose / send / allow / restart / dismiss');
    }
  }

  function tick() { if (!frozen) for (const team of teams.values()) flush(team).catch(error => logger.warn?.('[team] 投递失败', error.message)); }
  function start() { load(); if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.(); } }
  function stop() { clearInterval(timer); timer = null; }

  function accounts() { return { ...listAccounts(), note: 'id 填进计划 account，model 从该账号 models 清单选择；省略 model 沿用账号设置。用户在批准时可改账号和模型。' }; }
  return { start, stop, invoke, decide, accounts, listTeams, teamOfLead, teamOfMember, flush: lead => { const t = teamOfLead(lead); return t ? flush(t) : null; },
    freeze: () => { frozen = true; }, unfreeze: () => { frozen = false; } };
}

module.exports = { createTeamService, MAX_MEMBERS, NOTICE_LIMIT };
