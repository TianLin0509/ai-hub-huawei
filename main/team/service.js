'use strict';
// 负责人组队（2026-11-01 用户）：任何会话都能当负责人。负责人提交招人计划（几个会话、各用哪个账号、各做什么），
// 用户在侧栏批准后 Hub 才建子会话，子会话挂在负责人下面。负责人与成员直接互发消息；成员之间默认不直连，
// 由负责人开放。招人默认按规则自动批准（2026-11-18）：账号与模型按批准时同一套号池校验，每位负责人成员上限照旧；
// 设置里关掉「负责人组队自动批准」（config team.autoApproveLeads=false）后，回到只认界面上的批准（decide 只从 IPC 进来）。
// 调用入口：hookServer 的 POST /api/team（共享 token + 与 sessionId 绑定的 CLAUDE_HUB_TEAM_TOKEN），
// 命令行 scripts/hub-team.js 包了一层。投递复用普通会话的提交闭环（submitPrompt），插话复用群聊的 injector。
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { delegationGuidance, RECEIPT_FORMAT } = require('./member-guidance');
const { NO_UPDATE_MARK } = require('../../core/team-silent-reply');
const { formatAbsoluteTime } = require('../../core/beijing-time');

// 每位负责人名下成员数：2026-11-22 起去掉组队人数上限，由 8 提到 100，只当防失控的安全阀。
const MAX_MEMBERS = 100;
const NOTICE_LIMIT = 1800;
const TICK_MS = 3000;
const WATCH_MS = 60 * 1000;
const STALL_MS = 10 * 60 * 1000;
const MISSING_ALERT_MS = 3 * 60 * 1000;
const RETRY_BACKOFF_MS = [60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000];
const { PERSONAL_ACCOUNT_ID, PERSONAL_SHARED_NOTE } = require('./codeagent-accounts');
const RESTART_COOLDOWN_MS = 30 * 60 * 1000;
const NOWAKE_MAX_AGE_MS = 20 * 60 * 1000;
const NOWAKE_MAX_COUNT = 8;
const LEAD_INBOX_CHARS = 6000;
const FOOTER_FULL_EVERY_MS = 4 * 60 * 60 * 1000;
const URGENT_RE = /卡住|阻塞|受阻|失败|报错|崩溃|拍板|请示|求助|紧急|blocked|\berror\b|\bfailed\b|\bstuck\b/i;
const RESOURCE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const RECEIPT_WAIT_MS = 3 * 60 * 1000;
const LEAD = 'lead';
const PERSONAL_MEMBER_LIMIT = 3; // 个人账号上同时干活的成员数；超出的成员消息留在队列里。
const PERSONAL_CLAIM_MS = 30 * 1000; // 刚提交、回合状态还没变成运行中时先占住名额。
// 交付即收工：成员用 --deliver 交付后，交付消息送进负责人会话、负责人这一轮处理完（不在运行）且至少过了这么久，
// 又没再给它派活，就让它离队并休眠，腾出内存。
// 本段与下面的拉起退避、全队空转提醒共用一个总开关 config team.antiStall（默认开；=false 完全回到旧行为）。
const RELEASE_AFTER_ACK_MS = 60 * 1000;
// 自动拉起：离线/休眠的收件人有消息排队时由 Hub 拉起，前两次间隔 1 分钟，之后最多每 10 分钟一次；
// 拉起失败够 2 次才合并提醒负责人。
const WAKE_RETRY_MS = 60 * 1000;
const REVIVE_COOLDOWN_MS = 10 * 60 * 1000;
const REVIVE_ALERT_AFTER = 2;
// 全队空转：负责人与在队成员都空闲这么久、没有排队消息，提醒负责人一次。
const IDLE_TEAM_MS = 20 * 60 * 1000;
// 离队休眠暂时不成（还在忙、刚有活动、正被看着）时，心跳每分钟再试；其余原因（置顶等）是用户的意思，不再尝试。
const SUSPEND_RETRY_ERRORS = ['pty-turn-unfinished', 'native-turn-unfinished', 'native-session-id-missing', 'suspend-pending',
  'focused', 'codeagent-not-settled', 'recently-active'];

const newId = prefix => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function createTeamService(deps) {
  const allowedKinds = ['codeagent'];
  const approver = '用户';
  const {
    getHubDataDir, sessionManager, sendToRenderer = () => {}, logger = console, now = () => Date.now(),
    createSession, submitPrompt, injectPrompt = null, restartSession = null, reconcileTurn = null,
    listAccounts = () => ({ rows: [] }), commandPath = () => '', wakeSession = null,
    getConfig = () => ({}),
    // 运行表里没有的会话，侧栏是否登记为可恢复（休眠）；用户主动关闭的返回 false。未接入时一律按不在运行处理。
    isResumable = () => false,
    getSessionMetadata = () => null,
    memInfo = () => { const os = require('node:os'); return { free: os.freemem(), total: os.totalmem() }; },
  } = deps;
  // 主进程传 autoApproveLeadsDefault=true（默认开）；单测等未传时保持人工批准。
  const autoApproveLeads = () => (getConfig()?.team?.autoApproveLeads ?? deps.autoApproveLeadsDefault) === true;
  const antiStall = () => getConfig()?.team?.antiStall !== false;
  const teams = new Map();
  const sending = new Set();
  const decisions = new Map(); // 同一负责人审批串行，不阻塞其他团队。
  const alerted = new Map();
  const modelWaits = new Map();
  const personalClaims = new Map(); // sid → 最近一次向个人账号成员提交消息的时间
  const resourceAlerted = new Map(); // 每位负责人独立去重，避免其他团队漏掉提醒。
  const onModelWait = event => {
    const previousWait = modelWaits.get(event.sessionId);
    if (event.active) modelWaits.set(event.sessionId, event);
    else if (modelWaits.get(event.sessionId)?.key === event.key) modelWaits.delete(event.sessionId);
    else return;
    for (const team of teams.values()) {
      const target = memberBySid(team, event.sessionId);
      if (!target || (event.active && target.memberId !== LEAD && target.status === 'dismissed')) continue;
      for (const item of team.messages || []) {
        if (item.to !== target.memberId) continue;
        const matches = event.clientSubmissionIds?.includes(item.submissionId)
          || (event.operation === 'resume' && (item.state === 'queued' || item.modelWait?.previousState === 'queued'));
        if (event.active && matches && ['sending', 'queued', 'waiting-model'].includes(item.state)) {
          item.modelWait = { ...event, previousState: item.modelWait?.previousState || (item.state === 'waiting-model' ? 'sending' : item.state) };
          item.state = 'waiting-model'; item.notSent = true;
        } else if (item.modelWait?.key === event.key) {
          if (!event.active && !event.selectedModel && event.cancelReason !== 'user' && frozen && item.state === 'waiting-model') {
            item.modelWait.recovered = true;
          } else if (!event.active && event.selectedModel && event.operation !== 'resume' && item.state === 'waiting-model') {
            item.modelWait = { ...item.modelWait, confirmed: true, reason: `正在切换模型（原模型 ${event.originalModel}，所选 ${event.selectedModel}），原任务尚未发送。` };
          } else {
            if (item.state === 'waiting-model') {
              item.state = !event.active && !event.selectedModel ? 'failed' : item.modelWait.previousState || 'sending';
              if (!event.active && !event.selectedModel) item.error = '已取消模型确认，原任务未发送';
            }
            delete item.modelWait;
          }
        }
      }
      save(team);
      if (event.active && previousWait?.key !== event.key && target.memberId !== LEAD) enqueue(team, 'hub', LEAD, `${target.memberId}（${target.title || target.role}）：${event.reason}`, { wake: true });
    }
  };
  const onSubmissionHandoff = event => {
    for (const team of teams.values()) {
      const target = memberBySid(team, event.sessionId);
      if (!target) continue;
      const changed = [];
      for (const item of team.messages || []) {
        if (item.to !== target.memberId || item.submissionId !== event.clientSubmissionId || item.notSent !== true) continue;
        changed.push({ item, state: item.state, notSent: item.notSent, modelWait: item.modelWait });
        item.state = 'sending'; item.notSent = false; delete item.modelWait;
      }
      if (changed.length) {
        try { save(team); }
        catch (error) {
          for (const before of changed) {
            before.item.state = before.state; before.item.notSent = before.notSent;
            if (before.modelWait === undefined) delete before.item.modelWait; else before.item.modelWait = before.modelWait;
          }
          // This listener is synchronous and the watcher has not written a
          // byte yet. Only this proved boundary grants a fresh retry attempt.
          throw Object.assign(error, { retryableBeforeHandoff: true });
        }
      }
    }
  };
  function modelWaitFor(sid) {
    if (modelWaits.has(sid)) return modelWaits.get(sid);
    for (const team of teams.values()) for (const item of team.messages || []) {
      if (item.state !== 'waiting-model' || !item.modelWait) continue;
      const targetSid = item.to === LEAD ? team.leadSid : team.members?.find(member => member.memberId === item.to)?.sid;
      if (targetSid === sid) return item.modelWait;
    }
    return null;
  }
  sessionManager.on?.('session-model-wait', onModelWait);
  sessionManager.on?.('session-submission-handoff', onSubmissionHandoff);
  let lastWatch = 0;
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
        for (const m of team.messages || []) if (m.state === 'waiting-model' && m.modelWait) {
          m.modelWait.recovered = true; m.notSent = true;
          const targetSid = m.to === LEAD ? team.leadSid : team.members?.find(member => member.memberId === m.to)?.sid;
          if (targetSid && !modelWaits.has(targetSid)) modelWaits.set(targetSid, m.modelWait);
          changed = true;
        }
        for (const m of team.messages || []) if (m.state === 'sending') {
          m.state = m.notSent === true ? 'queued' : 'unconfirmed';
          m.error = m.notSent === true ? 'Hub 重启前尚未写入，保留原任务等待投递' : 'Hub 重启前可能已送达，请先核对对方会话再决定是否重发'; changed = true;
        }
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
  // 真休眠的会话会从运行表删除：靠侧栏持久记录区分「休眠可叫醒」和「用户已关闭」。
  function offlineState(sid) {
    if (!antiStall()) return 'missing';
    try { return isResumable(sid) ? 'dormant' : 'missing'; } catch { return 'missing'; }
  }
  // 自动拉起的冷却、失败次数与提醒标记落盘在 team.revive[成员编号]，Hub 重启后照样按退避走；老数据没有就是零。
  const reviveOf = (team, id) => team.revive?.[id] || { at: 0, failures: 0, error: '' };
  function setRevive(team, id, rec) { team.revive ||= {}; team.revive[id] = rec; }
  function clearRevive(team, id) { if (!team.revive?.[id]) return false; delete team.revive[id]; return true; }
  function sessionState(sid) {
    const s = sessionManager.getSession(sid);
    if (modelWaitFor(sid)) return 'waiting-model';
    if (!s) return offlineState(sid);
    if (s.status === 'dormant') return 'dormant';
    return sessionManager.isAgentTurnActive(sid) ? 'running' : 'idle';
  }

  // 个人账号的并发名额按全 Hub 算：多个负责人共用同一个号。
  function personalSlotsFull(target) {
    if (target?.account !== PERSONAL_ACCOUNT_ID) return false;
    let busy = 0;
    for (const team of teams.values()) for (const m of team.members || []) {
      if (m.account !== PERSONAL_ACCOUNT_ID || m.status !== 'active' || !m.sid || m.sid === target.sid) continue;
      if (sessionState(m.sid) === 'running' || sending.has(team.leadSid + ':' + m.memberId) || now() - (personalClaims.get(m.sid) || 0) < PERSONAL_CLAIM_MS) busy++;
    }
    return busy >= PERSONAL_MEMBER_LIMIT;
  }
  function publicView(team) {
    return {
      leadSid: team.leadSid, createdAt: team.createdAt, updatedAt: team.updatedAt,
      members: (team.members || []).map(m => ({ memberId: m.memberId, sid: m.sid, role: m.role, kind: m.kind, account: m.account || '', ...(m.account === PERSONAL_ACCOUNT_ID ? { sharedNote: PERSONAL_SHARED_NOTE } : {}), title: m.title, status: m.status, state: m.status === 'dismissed' ? 'dismissed' : sessionState(m.sid), reason: modelWaitFor(m.sid)?.reason || '', ...(m.model ? {model:m.model} : {}),
        ...(m.dismissReason ? { dismissReason: m.dismissReason } : {}), ...(m.deliveredAt ? { delivered: true } : {}) })),
      plans: (team.plans || []).map(p => ({ id: p.id, status: p.status, goal: p.goal, members: p.members, submittedAt: p.submittedAt, decidedAt: p.decidedAt || 0, note: p.note || '' })),
      grants: (team.grants || []).slice(),
      messages: (team.messages || []).map(m => deliveryView(team, m)),
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
      let account = String(raw?.account || accountList.recommendedId || '').trim();
      let model='';
      {
        const rows=accountList.rows || [];
        let row=rows.find(a=>a.id===account);
        // 点名的号和个人账号（或号池里另一个号）是同一个人：换成那个本尊，单号也能组队，不再报「重复」。
        // 只有号池这份本身已登录、没暂停时才换；暂停或登录过期的按原因拒绝，不借本尊绕过暂停。
        if(row&&!row.usable&&row.sameAs){
          const hint=accountList.recommendedId?`，请省略 account 用推荐的 ${accountList.recommendedId}`:'';
          if(row.paused)throw Error(`第 ${i+1} 人的号池账号不可用（暂停中：这个号在号池里被暂停或避让，暂停期间不分配给成员）${hint}`);
          if(row.state!=='ready')throw Error(`第 ${i+1} 人的号池账号不可用（未登录：${row.state==='expired'?'这个号在号池里的登录已过期':'这个号在号池里没有可用登录'}，请先在左栏「账号」重新登录）${hint}`);
          const same=rows.find(a=>a.id===row.sameAs&&a.usable);
          if(same){row=same;account=same.id;}
        }
        if(row?.personal&&!row.usable)throw Error(`第 ${i+1} 人没有可用账号：${row.unavailableReason || '个人账号暂不可用'}`);
        if(!row || !row.usable)throw Error(`第 ${i+1} 人的号池账号不可用${row?.unavailableReason ? '（' + row.unavailableReason + '）' : ''}，请用 accounts 查看并选择可用账号${accountList.recommendedId ? '，或省略 account 用推荐的 ' + accountList.recommendedId : ''}`);
        model=String(raw?.model || '').trim();
        if(model&&!require('../../core/codeagent-models').isSafeModelId(model))throw Error(`第 ${i+1} 人的模型名称无效`);
        // Valid model intent is resolved by the shared creation policy after approval.
        // Account availability and model syntax are still checked before approval.
        if(model)model=(row.models || []).find(m=>m.toLowerCase()===model.toLowerCase()) || model;
      }
      const cwd = String(raw?.cwd || '').trim();
      if (cwd && !fs.existsSync(cwd)) throw Error(`第 ${i + 1} 人的工作目录不存在：${cwd}`);
      return { role, task, kind, account, cwd, title: String(raw?.title || role).trim().slice(0, 40), model,
        ...(raw?.fresh === true ? { fresh: true } : {}) };
    }) };
  }
  async function propose(callerSid, args) {
    if(!/^codeagent(?:-resume)?$/.test(sessionManager.getSession(callerSid)?.kind || ''))throw Error('公司组队请从 CodeAgent 会话提交计划');
    if (teamOfMember(callerSid)) throw Error('成员不能招人；需要人手请向负责人提');
    let team = teamOfLead(callerSid);
    require('../../core/secret-guard').assertPlanFree(args);
    const plan = normalizePlan(args, team);
    const recalled = [], hints = [];
    if (team && antiStall()) {
      const { planRecalls, recallText } = require('./recall-match');
      const sessionInfo = sid => {
        const live = sessionManager.getSession(sid);
        if (!live && !isResumable(sid)) return null;
        const saved = getSessionMetadata(sid);
        // CodeAgent 的占用值也可能只在侧栏记录里；运行表缺值时补齐，未知仍按新人处理。
        const s = live ? { ...saved, ...live, contextPct: live.contextPct ?? saved?.contextPct } : saved;
        return s ? { ...s, exists: true, inOtherTeam: !!(teamOfLead(sid) || teamOfMember(sid)) } : null;
      };
      const keep = [];
      for (const d of planRecalls(plan.members, team, { now: now(), leadCwd: sessionManager.getSession(callerSid)?.cwd, sessionInfo })) {
        const spec = plan.members[d.index];
        if (d.action === 'recall') {
          const rec = team.members.find(m => m.memberId === d.memberId);
          try {
            send(callerSid, { to: d.memberId, message: recallText(spec, rec) });
            recalled.push({ memberId: d.memberId, insteadOf: spec.title, reason: d.reason });
            continue;
          } catch (error) { hints.push({ memberId: d.memberId, for: spec.title, reason: `叫回未成功（${error.message}），按计划新招` }); }
        } else if (d.action === 'hint') hints.push({ memberId: d.memberId, for: spec.title, reason: d.reason });
        keep.push(spec);
      }
      plan.members = keep;
    }
    const reuse = r => ({ ...r, ...(recalled.length ? { recalled } : {}), ...(hints.length ? { hints,
      hintNote: '岗位相近的老成员可用 send --to 编号 叫回；明确要新人时在计划项中加 fresh: true。' } : {}) });
    if (!plan.members.length) {
      for (const p of team.plans) if (p.status === 'pending') { p.status = 'withdrawn'; p.decidedAt = now(); p.note = '负责人改为叫回原成员'; }
      save(team);
      return reuse({ ok: true, status: 'recalled', note: '已叫回原会话，新任务已排队；没有新建成员。' });
    }
    if (!team) {
      team = { leadSid: callerSid, createdAt: now(), updatedAt: now(), plans: [], members: [], grants: [], messages: [] };
      teams.set(callerSid, team);
    }
    for (const p of team.plans) if (p.status === 'pending') { p.status = 'withdrawn'; p.decidedAt = now(); p.note = '负责人提交了新版计划'; }
    const item = { id: newId('plan'), status: 'pending', ...plan, submittedAt: now() };
    team.plans.push(item);
    save(team);
    if (autoApproveLeads()) {
      // 与界面批准走同一条 decide：账号、模型、成员上限的校验和报错完全一致；校验不过时计划留在待批准。
      let result;
      try { result = await decide({ leadSid: callerSid, planId: item.id, approve: true, note: '', byRule: true }); }
      catch (error) { throw Error(`${error.message || error}（未自动批准：计划留在侧栏「待批准」，可修改后重新提交，或由${approver}在界面处理）`); }
      return reuse({ ...result, planId: item.id, note: `已按规则自动批准；账号与模型已按号池校验。设置里可关掉「负责人组队自动批准」改回人工批准。${result.sharedAccountNote || ''}` });
    }
    return reuse({ planId: item.id, status: 'pending', note: `计划已提交，等${approver}在 Hub 侧栏（你这个会话那一行的「待批准」）批准。批准前不会建任何会话；批准或驳回的结果会作为一条消息发给你。` });
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
  async function decideNow({ leadSid, planId, approve, note = '', edits = null, byRule = false }) {
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
    if (byRule) plan.approvedByRule = true;
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
        // 未选模型时沿用所选账号的默认模型；个人账号和普通个人会话走同一条启动路径。
        const opts = { cwd: spec.cwd || lead?.cwd || undefined, title: spec.title, workspaceLabel: spec.title, openInBackground: true,
          ...(spec.account === PERSONAL_ACCOUNT_ID ? { codeagentAccount: 'personal' } : { codeagentAccount: 'pool', codeagentPoolPick: spec.account }),
          modelCreationContext: `负责人 ${lead?.title || leadSid} / 新成员 ${spec.title || spec.role}` };
        if (spec.model) { opts.model = spec.model; opts.codeagentModelPick = true; }
        const session = await createSession({ kind: spec.kind, opts });
        if (!session?.id) throw Error('Hub 没返回新会话');
        const account = spec.account || session.codeagentPoolAccount;
        const actualModel = session.fixedModel || session.currentModel?.id || spec.model;
        if (actualModel) { spec.model = actualModel; member.model = actualModel; }
        Object.assign(member, { sid: session.id, account: account || '', joinedAt: now(), status: 'active' });
        spec.status = 'created'; spec.sid = session.id;
        save(team);
        created.push(member);
        enqueue(team, LEAD, memberId, kickoff(team, member, spec, plan), { kickoff: true });
        resourceNotice(team);
      } catch (error) {
        spec.status = 'failed'; spec.error = String(error.message || error);
        member.status = 'failed'; member.error = spec.error;
        failed.push(`${spec.title}：${spec.error}`); save(team);
      }
    }
    save(team);
    const roster = created.map(m => `${m.memberId} ${m.title}`).join('、');
    const sharedAccountNote = created.some(m => m.account === PERSONAL_ACCOUNT_ID) ? `用个人账号的成员：${PERSONAL_SHARED_NOTE}。同时最多 ${PERSONAL_MEMBER_LIMIT} 位在干活，其余自动排队。` : '';
    enqueue(team, 'hub', LEAD, `${byRule ? '已按规则自动批准' : approver + '批准了'}招人计划 ${plan.id}${note ? '（备注：' + note + '）' : ''}。已建成员：${roster || '无'}。` +
      (failed.length ? `未建成：${failed.join('；')}。` : '') + '已创建成员的开工任务已排队；用 status 查看全队状态。' + sharedAccountNote, { wake: true });
    return { ok: true, status: 'approved', created: created.map(m => m.memberId), failed, ...(sharedAccountNote ? { sharedAccountNote } : {}) };
  }

  function kickoff(team, member, spec, plan) {
    const cmd = commandPath();
    return [
      `【组队开工 · 来自负责人】你是成员 ${member.memberId}，分工：${spec.role}。`,
      `团队目标：${plan.goal}`,
      `你的任务：${spec.task}`,
      '',
      '通信规矩：',
      `- 向负责人汇报：\`"${cmd}" send --to lead --message "结论 + 文件路径"\`。默认留言，攒满 8 条或最老一条超过 20 分钟时负责人空闲就会收到；卡住、失败、要拍板或影响别人判断的发现，加 \`--wake\`。`,
      ...(antiStall() ? [`- 任务做完、交可验收的结果时加 \`--deliver\`（\`"${cmd}" send --to lead --deliver --message "…"\`）：负责人收到并处理完后，Hub 让你离队休眠、腾出内存；要返工负责人直接发消息，Hub 会叫醒你接着干。汇报进度、提问、卡住时不加。`] : []),
      `- 消息写结论和证据路径；超过约 ${NOTICE_LIMIT} 字自动保存完整正文，通知提供原文路径。用 read --id <消息编号> 可取原文。`,
      '- 要和其他成员直接交流，先向负责人说明原因，由负责人开放。',
      `- 看全队：\`"${cmd}" status\`。`,
      '- 在 PowerShell 里运行时，命令前加 `&`（例：`& "…hub-team.cmd" status`）。',
      `- ${delegationGuidance()}你不能再招 Hub 成员。`,
      '- 普通告知无需回执；任务、合同变更、阻塞解除确认一次即可。同一提交已审过时引用原结论。',
      '- 普通收到、开工确认、纯进度和排期更新无需发消息。',
      ...RECEIPT_FORMAT,
    ].join('\n');
  }

  // ---- 消息 ----
  function resourceNotice(team) {
    try {
      const { free, total } = memInfo() || {};
      if (!Number.isFinite(free) || free < 0 || !(total > 0)) return;
      if (free >= 6 * 1024 ** 3 && free / total >= 0.1) return;
      const last = resourceAlerted.get(team.leadSid), t = now();
      if (last != null && t - last < RESOURCE_ALERT_COOLDOWN_MS) return;
      resourceAlerted.set(team.leadSid, t);
      enqueue(team, 'hub', LEAD, `【内存提醒，不拦人】本机可用内存只剩 ${(free / 1024 ** 3).toFixed(1)} GB（共 ${(total / 1024 ** 3).toFixed(0)} GB），新成员已创建。建议让已交付或闲置成员离队休眠，腾出内存。`, { wake: false });
    } catch (error) { logger.warn?.('[team] 内存提醒失败', error.message); }
  }
  // 短号只在本队内递增；旧消息继续保留长编号。
  function nextSeq(team) { team.msgSeq = Math.max(Number(team.msgSeq) || 0, ...(team.messages || []).map(m => Number(m.seq) || 0)) + 1; return team.msgSeq; }
  const ref = m => m.seq ? `#${m.seq}` : m.id;
  const srcRef = m => m.sourceSeq ? `#${m.sourceSeq}` : m.sourceId;
  const cmdLine = (cmd, parts) => `下文 hub-team 指 \`"${cmd}"\`（调用写完整路径，PowerShell 前加 &）：${parts.join('；')}。`;
  function enqueue(team, from, to, text, extra = {}) {
    team.messages ||= [];
    const item = { id: newId('msg'), from, to, text, state: 'queued', at: now(), ...extra };
    if (!item.seq) item.seq = nextSeq(team);
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
    const toId = String(args.to || '');
    const text = String(args.message || '');
    if (!text.trim()) throw Error('message 不能为空');
    const deliver = antiStall() && args.deliver === true;
    if (deliver && (caller.memberId === LEAD || toId !== LEAD)) throw Error('--deliver 只用于成员向负责人交付结果（send --to lead --deliver）');
    const rec = caller.memberId === LEAD ? (team.members || []).find(m => m.memberId === toId) : null;
    // 交付后被 Hub 收工的成员：负责人再派活就叫回它（同一会话、上下文还在），不用重新招人。
    if (rec?.status === 'dismissed' && rec.dismissReason === 'delivered' && rec.sid) {
      if (sessionState(rec.sid) === 'missing') throw Error(`${toId} 的会话已被关闭，需要人手请重新提交计划`);
      if (teamOfMember(rec.sid) || teamOfLead(rec.sid)) throw Error(`${toId} 的会话离队后已加入别的团队或成了负责人，不能叫回；需要人手请重新提交计划`);
      if (occupiedSlots(team) >= MAX_MEMBERS) throw Error(`每位负责人最多 ${MAX_MEMBERS} 名成员，先让用不上的成员离队再叫回 ${toId}`);
      rec.status = 'active'; rec.recalledAt = now();
      for (const key of ['dismissedAt', 'dismissReason', 'suspendPending', 'suspendError', 'suspendedAt']) delete rec[key];
    }
    const target = memberById(team, toId);
    if (!target || target.memberId === caller.memberId) throw Error('to 写本队另一位成员编号（负责人是 lead，成员是 m1、m2…）');
    const peer = caller.memberId !== LEAD && target.memberId !== LEAD;
    if (peer && !(team.grants || []).includes(pair(caller.memberId, target.memberId))) throw Error('成员之间直接交流要负责人先开放；请先发给 lead 说明原因');
    const wake = target.memberId === LEAD ? (deliver || args.wake === true || (args.wake !== false && URGENT_RE.test(text))) : true;
    const interrupt = caller.memberId === LEAD && args.interrupt === true;
    // 负责人给已交付的成员派新活：交付作废，它重新算在干活，不会被收工。
    if (rec && rec.deliveredAt) for (const key of ['deliveredAt', 'deliverMsgId', 'deliverSentAt']) delete rec[key];
    // 先完整落盘再排队；不能把只剩前半段的合同当成功投递。
    const id = newId('msg'), at = now(), seq = nextSeq(team);
    const archiveDir = path.join(dir(), 'messages', team.leadSid);
    fs.mkdirSync(archiveDir, { recursive: true });
    const bodyPath = text.length > NOTICE_LIMIT ? path.join(archiveDir, id + '.md') : undefined;
    if (bodyPath) fs.writeFileSync(bodyPath, text, { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(archiveDir, id + '.json'), JSON.stringify({ id, seq, from: caller.memberId, to: target.memberId, at, text, bodyPath }), { encoding: 'utf8', flag: 'wx' });
    const notice = bodyPath ? `正文已完整保存（${text.length} 字符），执行前先读：${bodyPath}\n以下仅为预览：${text.slice(0, 240)}…` : text;
    if (deliver) {
      // 交付消息送进负责人会话、负责人处理完后再离队休眠，见 releaseDelivered。
      const self = (team.members || []).find(m => m.memberId === caller.memberId);
      if (self) { self.deliveredAt = at; self.deliverMsgId = id; delete self.deliverSentAt; }
    }
    const item = enqueue(team, caller.memberId, target.memberId, notice, { id, seq, at, wake, interrupt, bodyPath, ...(deliver ? { deliver: true } : {}) });
    if (peer) enqueue(team, caller.memberId, LEAD, `（抄送）${caller.memberId} → ${target.memberId}：${text.slice(0, 160)}${text.length > 160 ? '…（摘要，原文见消息编号）' : ''}`, { wake: false, copy: true, sourceId: id, sourceSeq: seq, copyTo: target.memberId });
    return { messageId: item.id, seq: item.seq, bodyPath, status: 'queued', note: target.memberId === LEAD
      ? (deliver ? (antiStall() ? '已作为交付发给负责人（会叫醒它）。负责人收到并处理完后，Hub 让你离队休眠；要返工它会直接叫醒你。' : '已作为交付发给负责人（会叫醒它）。')
        : wake ? '已排队，负责人空闲时送达（会叫醒它）。' : '已留言，负责人下次被叫醒时一起送达。')
      : (interrupt ? '对方忙时直接插进它当前的工作，空闲时作为新任务送达。' : '已排队，对方空闲时送达。') };
  }
  function read(callerSid, args) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD } } : teamOfMember(callerSid);
    if (!found) throw Error('你还不在任何团队里');
    let id = String(args.messageId || '').trim();
    const { team, member } = found;
    const short = /^#?(\d{1,7})$/.exec(id);
    if (short) id = findBySeq(team, Number(short[1])) || '';
    if (!/^msg-[a-zA-Z0-9-]{1,90}$/.test(id)) throw Error(short ? `本团队没有 #${short[1]} 这条消息` : '消息编号无效');
    let item;
    try { item = JSON.parse(fs.readFileSync(path.join(dir(), 'messages', team.leadSid, id + '.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; item = (team.messages || []).find(m => m.id === id); }
    if (!item) throw Error('本团队没有这条消息；旧版已清理的记录无法恢复');
    if (member.memberId !== LEAD && item.from !== member.memberId && item.to !== member.memberId) throw Error('只有负责人或该消息参与者能读取原文');
    const current = (team.messages || []).find(m => m.id === id);
    return { id: item.id, ...(item.seq ? { seq: item.seq } : {}), from: item.from, to: item.to, at: item.at, text: item.text, bodyPath: item.bodyPath, sourceId: item.sourceId,
      delivery: current ? deliveryView(team, current) : null };
  }
  function findBySeq(team, seq) {
    const hit = (team.messages || []).find(m => m.seq === seq);
    if (hit) return hit.id;
    const archive = path.join(dir(), 'messages', team.leadSid);
    try {
      for (const name of fs.readdirSync(archive)) {
        if (!/^msg-[\w-]+\.json$/.test(name)) continue;
        try { const item = JSON.parse(fs.readFileSync(path.join(archive, name), 'utf8')); if (item.seq === seq) return item.id; } catch {}
      }
    } catch {}
    return null;
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
    const ready = m => (m.state === 'queued' || (m.state === 'waiting-model' && (m.modelWait?.recovered || m.modelWait?.confirmed))) && !(m.retryAt > now());
    const queued = (team.messages || []).filter(ready);
    const targets = [...new Set(queued.map(m => m.to))];
    for (const to of targets) {
      if (frozen) return;
      const target = memberById(team, to);
      if (!target) { for (const m of queued.filter(x => x.to === to)) { m.state = 'failed'; m.error = '收件人已离队'; } save(team); continue; }
      const lock = team.leadSid + ':' + to;
      if (sending.has(lock)) continue;
      // 重新取一遍：同时进行的另一轮投递可能已经送走了其中几条。
      const items = (team.messages || []).filter(m => ready(m) && m.to === to);
      if (!items.length || (to === LEAD && !leadDue(items))) continue;
      if (target.kind === 'powershell' || sessionManager.getSession(target.sid)?.kind === 'powershell') {
        // 只在隔离测试里出现的非 AI 成员：消息记为已处理，不往终端里敲字。
        for (const m of items) { m.state = 'sent'; m.via = 'not-ai'; m.sentAt = now(); }
        if (to === LEAD) noteDeliverySent(team, items);
        save(team); continue;
      }
      let state = sessionState(target.sid);
      if (modelWaits.get(target.sid)?.recovered) {
        const live = sessionManager.getSession(target.sid);
        state = !live ? offlineState(target.sid) : live.status === 'dormant' ? 'dormant' : sessionManager.isAgentTurnActive(target.sid) ? 'running' : 'idle';
      }
      if (state === 'dormant' && personalSlotsFull(target)) continue; // 轮到它再叫醒
      if (state === 'missing' || state === 'dormant') {
        // Hub 会让空闲会话自动休眠：有消息要送时把它拉起（只拉侧栏里登记为休眠的会话，关掉的不复活）。
        // 冷却：前两次间隔 1 分钟，之后每 10 分钟最多一次；失败次数供心跳合并提醒负责人。
        const rec = { ...reviveOf(team, to) };
        const gap = antiStall() && rec.failures >= REVIVE_ALERT_AFTER ? REVIVE_COOLDOWN_MS : WAKE_RETRY_MS;
        if (typeof wakeSession === 'function' && !(rec.at && now() - rec.at < gap)) {
          rec.at = now(); setRevive(team, to, rec); save(team); // 先落盘再拉起：重启不重置冷却
          sending.add(lock);
          const stopWake = failure => {
            clearRevive(team, to);
            for (const item of items) { item.state = 'failed'; item.error = String(failure.message || '已取消恢复，待发消息保持停止').slice(0, 300); }
            save(team);
            if (to !== LEAD) enqueue(team, 'hub', LEAD, `${to} 的恢复已停止，原待发任务未发送；${failure.message || '需要时请重新发起'}。`, { wake: true });
          };
          let error = '';
          try {
            const result = await wakeSession(target.sid);
            if (result?.stopped && result.notSent !== false) { stopWake(result); continue; }
            if (result === false) error = '侧栏里没有可恢复的记录（可能已被关闭）';
            else if (['missing', 'dormant'].includes(sessionState(target.sid))) error = '拉起后会话仍未运行';
          } catch (e) {
            if (e.stopped && e.notSent !== false) { stopWake(e); continue; }
            error = String(e?.message || e).slice(0, 160) || '拉起失败';
            logger.warn?.('[team] 唤醒失败', target.sid, error);
          } finally { sending.delete(lock); }
          if (error) { rec.failures += 1; rec.error = error; setRevive(team, to, rec); } else clearRevive(team, to);
          save(team);
        }
        continue;
      }
      if (state === 'running') {
        const urgent = items.find(m => m.interrupt);
        if (urgent && typeof injectPrompt === 'function') { await interruptNow(team, urgent, target); continue; }
        if (typeof reconcileTurn !== 'function') continue;
        sending.add(lock);
        const targetSid = target.sid;
        try {
          const evidence = await reconcileTurn(targetSid);
          const currentTarget = memberById(team, to);
          if (!currentTarget || currentTarget.sid !== targetSid) {
            for (const item of items) if (item.state === 'queued') { item.state = 'failed'; item.error = '收件人已离队或会话已变化，未发送'; }
            save(team); continue;
          }
          if (items.some(item => item.state !== 'queued' || !team.messages.includes(item))) continue;
          const reason = evidence?.reason || '尚无同回合完成证据，等待核对';
          const changed = items.some(m => m.waitReason !== reason);
          for (const item of items) item.waitReason = reason;
          if (changed) save(team);
          if (frozen || !evidence?.reconciled || sessionState(target.sid) !== 'idle') continue;
        } catch (error) {
          for (const item of items) item.waitReason = `回合状态待核对：${String(error.message || error).slice(0, 160)}`;
          save(team); continue;
        } finally { sending.delete(lock); }
      }
      if (personalSlotsFull(target)) continue;
      sending.add(lock);
      if (target.account === PERSONAL_ACCOUNT_ID) personalClaims.set(target.sid, now());
      const batch = to === LEAD ? items : [items[0]];
      const submissionId = batch.map(item => item.id).join(':').slice(0, 160);
      let confirmedNotSent = false;
      try {
        batch.forEach(m => {
          if (m.state === 'waiting-model' && m.modelWait?.recovered) {
            const live = sessionManager.getSession(target.sid);
            // A fresh process has no old invocation or confirmation UI. Keep
            // the durable not-sent state until a fresh choice is made. A model
            // explicitly selected since that wait is already user consent.
            const alreadyChosen = live?.modelPinSource === 'user' && live.fixedModel
              && live.fixedModel !== m.modelWait.originalModel && !live.modelConfirmationRequired;
            if (alreadyChosen) {
              if (modelWaits.get(target.sid)?.key === m.modelWait.key) modelWaits.delete(target.sid);
              delete m.modelWait; m.state = 'sending';
            } else {
              sessionManager.updateSessionMeta?.(target.sid, { modelConfirmationRequired: true, modelUnavailableReason: m.modelWait.reason });
              m.modelWait.recovered = false;
            }
          } else m.state = 'sending';
          m.sendingAt = now(); m.submissionId = submissionId;
        });
        save(team);
        const text = batch.length === 1 && batch[0].kickoff ? batch[0].text : to === LEAD ? leadBatchText(team, batch) : formatBatch(team, batch, to);
        const targetSid = target.sid;
        const shouldSubmit = () => !frozen && memberById(team, to)?.sid === targetSid
          && batch.every(item => team.messages.includes(item) && ['sending', 'waiting-model'].includes(item.state));
        const result = await submitPrompt(targetSid, text, { clientSubmissionId: submissionId, shouldSubmit });
        if (frozen && batch.every(item => item.notSent === true && item.modelWait)) return;
        // These IPC preflight errors precede any write. Also recognize legacy
        // receipts without notSent, but never override explicit uncertainty.
        const preflightRejected = result?.ok === false && !result.unconfirmed && result.notSent !== false
          && (!result.stopped || result.notSent === true) && !['stuck', 'content-mismatch'].includes(result.sendStatus)
          && ['no-session', 'bad-request'].includes(result.error);
        confirmedNotSent = result?.notSent === true || preflightRejected;
        // 回车后才按停止（stopped 但 notSent 不为 true）：成员可能已收到，按「待核对」处理，避免重发出两遍。
        if (result?.unconfirmed || (!confirmedNotSent && (result?.stopped || result?.ok === false
            || ['stuck', 'content-mismatch'].includes(result?.sendStatus))))
          markUnconfirmed(team, batch, to, result.message || result.error || '提交未获得明确确认，可能已送达');
        // A user stop is final even when nothing was sent. Only retry confirmed not-sent receipts.
        else if (result?.ok === false && result.notSent === true && !preflightRejected && !result.stopped && await retryLater(team, batch, to, target, result)) { /* queued with backoff */ }
        else {
          // 粘贴时按停止，CodeAgent 回 {ok:true, stopped:true, notSent:true}：算没送达。
          if (result && (result.ok === false || result.notSent)) {
            const reason = result.message || result.error || '未发送（发送时被停止）';
            batch.forEach(m => { m.state = 'failed'; m.error = String(reason).slice(0, 300); });
            if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息没送达：${String(reason).slice(0, 200)}。内容保留，可用 status 查看后核对。`);
          } else if (result?.ok === true) {
            batch.forEach(m => { m.state = 'sent'; m.notSent = false; m.sentAt = now(); });
            if (to === LEAD) {
              if (team.leadFooterAt == null || now() - team.leadFooterAt >= FOOTER_FULL_EVERY_MS) team.leadFooterAt = now();
              noteDeliverySent(team, batch);
            }
          }
          else markUnconfirmed(team, batch, to, '提交未返回明确回执');
        }
      } catch (error) {
        if (frozen && batch.every(item => item.notSent === true && item.modelWait)) return;
        if (confirmedNotSent || batch.every(item => item.notSent === true)) {
          batch.forEach(m => { m.state = 'failed'; m.error = String(error.message || error).slice(0, 300); });
          if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息没送达：${String(error.message || error).slice(0, 200)}。内容保留，可用 status 查看。`);
        } else markUnconfirmed(team, batch, to, error.message || error);
      } finally {
        sending.delete(lock);
        if (batch.every(item => ['queued', 'failed'].includes(item.state))) personalClaims.delete(target.sid);
        for (const item of batch) if (!['sending', 'waiting-model'].includes(item.state)) delete item.modelWait;
        save(team);
        if ((team.messages || []).some(m => ready(m) && m.to === to)) setImmediate(() => flush(team).catch(() => {}));
      }
    }
  }
  // 交付消息进了负责人会话：从这一刻起等负责人处理完，再让该成员离队休眠（见 releaseDelivered）。
  function noteDeliverySent(team, batch) {
    for (const m of batch.filter(x => x.deliver)) {
      const rec = (team.members || []).find(x => x.memberId === m.from);
      if (rec && rec.deliverMsgId === m.id) rec.deliverSentAt = m.sentAt;
    }
  }
  // Hub 的旁听通知（passive，如「m3 已交付、已离队休眠」）只是记录，自己不触发投递，跟着下一批正式消息一起送。
  function leadDue(all) {
    const items = all.filter(m => !m.passive);
    if (!items.length) return false;
    if (items.some(m => m.wake !== false) || items.length >= NOWAKE_MAX_COUNT) return true;
    return now() - Math.min(...items.map(m => Number(m.at) || now())) >= NOWAKE_MAX_AGE_MS;
  }
  // 明确没写进对方输入框的消息：按 1/3/10 分钟退避重发；输入待处理时交给用户，其余故障可自动重启一次。
  async function retryLater(team, items, to, target, result) {
    const reason = String(result.message || result.error || '未发送').slice(0, 160);
    const tries = Math.max(...items.map(m => m.retries || 0));
    if (tries < RETRY_BACKOFF_MS.length) {
      for (const m of items) {
        m.retries = tries + 1; m.state = 'queued'; m.retryAt = now() + RETRY_BACKOFF_MS[tries];
        m.error = `${reason}；第 ${tries + 1} 次自动重发排在 ${Math.round(RETRY_BACKOFF_MS[tries] / 60000)} 分钟后`;
      }
      return true;
    }
    // 重启会清空终端草稿；输入保护回执只通知负责人，也兼容旧入口仅返回文字的回执。
    if ([result.code, result.error].includes('codeagent-input-residual')
        || /终端输入框有未发送内容|尚未确认终端输入已清空|终端输入已变化或无法确认/.test(String(result.message || result.error || ''))) {
      throw Error('终端输入框有未发送内容或尚未确认已清空，未自动重启；请先到该成员终端处理');
    }
    if (to === LEAD || items.some(m => m.restarted)) return false;
    // 30 分钟内同一成员只自动重启一次；刚重启过的，排在后面的消息也等重启后再试一轮。
    if (!target.autoRestartAt || now() - target.autoRestartAt >= RESTART_COOLDOWN_MS) {
      if (typeof restartSession !== 'function') return false;
      // Persist before invoking: a Hub restart must not reset the attempt limit.
      target.autoRestartAt = now(); target.autoRestartConfirmed = false; save(team);
      let ok = false;
      try { const r = await restartSession(target.sid); ok = r?.ok === true || (r?.id === target.sid && !!sessionManager.getSession(target.sid)); }
      catch (error) { logger.warn?.('[team] 自动重启失败', target.sid, error.message); }
      target.autoRestartConfirmed = ok;
      if (!ok) return false;
      enqueue(team, 'hub', LEAD, `${to} 连续 ${RETRY_BACKOFF_MS.length + 1} 次没能接收消息（${reason}），Hub 已自动重启它一次（接着原会话历史），消息会在它就绪后重发。`);
    }
    if (!target.autoRestartConfirmed) return false;
    for (const m of items) { m.restarted = true; m.retries = 0; m.state = 'queued'; m.retryAt = now() + RETRY_BACKOFF_MS[0]; m.error = `${reason}；已自动重启 ${to}，1 分钟后重发`; }
    return true;
  }
  function lastOutputAt(sid) {
    return typeof sessionManager.getGroupChatLastActivity === 'function' ? Number(sessionManager.getGroupChatLastActivity(sid)) || 0 : 0;
  }
  // 心跳巡检：只读、零 token。成员运行中却长时间无输出、离线且自动拉起失败够次数、全队空转，就叫醒负责人说明；
  // 交付后负责人已处理完的成员在这里离队休眠。
  function watch() {
    const t = now();
    if (t - lastWatch < WATCH_MS) return;
    lastWatch = t;
    for (const team of teams.values()) {
      let changed = false;
      const offline = [];
      for (const m of team.members || []) {
        if (m.status === 'dismissed' && m.suspendPending) { if (antiStall()) suspendDismissed(team, m); continue; }
        if (m.status !== 'active' || !m.sid) continue;
        const state = sessionState(m.sid);
        if ((state === 'running' || state === 'idle') && clearRevive(team, m.memberId)) changed = true;
        if (state === 'running') {
          const last = lastOutputAt(m.sid);
          if (!last || t - last < STALL_MS) { if (alerted.get(m.sid)?.kind === 'stall') alerted.delete(m.sid); continue; }
          const key = 'stall:' + last;
          if (alerted.get(m.sid)?.key === key) continue;
          alerted.set(m.sid, { kind: 'stall', key });
          enqueue(team, 'hub', LEAD, `${m.memberId}（${m.title}）显示在运行中，但已 ${Math.round((t - last) / 60000)} 分钟没有任何终端输出，可能卡住；发给它的消息会一直排队。先看一眼它的会话，确认卡住再用 restart --member ${m.memberId}。`);
        } else if (state === 'missing' || state === 'dormant') {
          const waiting = (team.messages || []).filter(x => x.to === m.memberId && x.state === 'queued');
          if (!waiting.length || (state === 'dormant' && personalSlotsFull(m))) continue;
          const oldest = Math.min(...waiting.map(x => Number(x.at) || t));
          if (t - oldest < MISSING_ALERT_MS) continue;
          const key = 'missing:' + oldest;
          if (alerted.get(m.sid)?.key === key) continue;
          if (antiStall() && typeof wakeSession === 'function') {
            // 先由投递循环自动拉起；拉起失败够次数才提醒负责人，同一次巡检合并成一条；提醒标记落盘，重启后不重复提醒。
            const rec = team.revive?.[m.memberId];
            if (!rec || rec.failures < REVIVE_ALERT_AFTER || rec.alertKey === key) continue;
            offline.push({ m, key, waiting: waiting.length, failures: rec.failures, error: rec.error });
            continue;
          }
          alerted.set(m.sid, { kind: 'missing', key });
          enqueue(team, 'hub', LEAD, `${m.memberId}（${m.title}）的会话${state === 'dormant' ? '已休眠且没能叫醒' : '已不在运行（进程退出或被关闭）'}，有 ${waiting.length} 条消息送不到，最早一条已等 ${Math.round((t - oldest) / 60000)} 分钟。用 restart --member ${m.memberId} 重启后会自动补送。`);
        } else if (alerted.has(m.sid)) alerted.delete(m.sid);
      }
      if (offline.length) {
        for (const x of offline) { team.revive[x.m.memberId].alertKey = x.key; changed = true; }
        const tries = Math.max(...offline.map(x => x.failures));
        const reason = offline.find(x => x.error)?.error;
        enqueue(team, 'hub', LEAD, `${offline.map(x => x.m.memberId).join('、')} 未能启动，Hub 已尝试自动拉起 ${tries} 次失败${reason ? '（' + reason.slice(0, 60) + '）' : ''}，${offline.reduce((n, x) => n + x.waiting, 0)} 条消息待送；之后每 10 分钟再试一次。可看侧栏或 restart --member <编号> 重试。`);
      }
      if (antiStall() && releaseDelivered(team, t)) changed = true;
      if (antiStall() && watchIdle(team, t)) changed = true;
      if (changed) save(team);
    }
  }
  // 交付即收工：成员 --deliver 的交付消息已送进负责人会话、负责人这一轮处理完（不在运行）且过了
  // RELEASE_AFTER_ACK_MS，又没再给它派活、它自己也停下了 → 离队并休眠。负责人之后再 send 给它，Hub 叫回原会话。
  function releaseDelivered(team, t) {
    const released = [];
    for (const m of team.members || []) {
      if (m.status !== 'active' || !m.deliveredAt || !m.deliverSentAt || t - m.deliverSentAt < RELEASE_AFTER_ACK_MS) continue;
      if (sessionState(team.leadSid) === 'running') continue;
      if ((team.messages || []).some(x => x.to === m.memberId && ['queued', 'sending', 'waiting-model'].includes(x.state))) continue;
      if (sessionState(m.sid) === 'running') continue;
      m.status = 'dismissed'; m.dismissedAt = t; m.dismissReason = 'delivered'; m.suspendPending = true;
      for (const key of ['deliveredAt', 'deliverMsgId', 'deliverSentAt']) delete m[key];
      team.grants = (team.grants || []).filter(g => !g.split(':').includes(m.memberId));
      suspendDismissed(team, m);
      released.push(m.memberId);
    }
    if (!released.length) return false;
    enqueue(team, 'hub', LEAD, `${released.join('、')} 已交付、你已收到，Hub 已让它离队休眠（会话保留在侧栏）。要它返工直接 send --to <编号>，Hub 会叫醒原会话接着干。`, { wake: false, passive: true });
    return true;
  }
  // 离队休眠：进程退出、内存释放，会话保留在侧栏，点开即恢复。还在忙、刚有活动或正被看着的，由心跳每分钟再试。
  function suspendDismissed(team, m) {
    const live = m.sid && sessionManager.getSession(m.sid);
    if (!live || live.status === 'dormant' || typeof sessionManager.suspendSession !== 'function') { delete m.suspendPending; return false; }
    let result;
    try {
      result = sessionManager.suspendSession(m.sid, { reason: m.dismissReason === 'delivered' ? 'team-delivered' : 'team-dismissed',
        excludeFocused: true, excludePinned: true, requireSettledCodeAgent: true, minIdleMs: RELEASE_AFTER_ACK_MS });
    } catch (error) { logger.warn?.('[team] 离队休眠失败', m.sid, error.message); return false; }
    if (result?.ok) { delete m.suspendPending; delete m.suspendError; m.suspendedAt = now(); save(team); return true; }
    const error = result?.error || 'unknown';
    m.suspendError = error;
    if (!SUSPEND_RETRY_ERRORS.includes(error)) delete m.suspendPending;
    save(team);
    return false;
  }
  // 全队空转：负责人与所有在队成员都空闲（含已休眠）超过 20 分钟、没有排队消息、没有待批计划，提醒负责人一次。
  // 「同一段」以成员活动和非 Hub 消息为界：提醒后负责人自己的输出不算新的一段，避免每 20 分钟催一次。
  function watchIdle(team, t) {
    const active = (team.members || []).filter(m => m.status === 'active' && m.sid && m.kind !== 'powershell');
    if (!active.length || (team.plans || []).some(p => p.status === 'pending')) return false;
    if ((team.members || []).some(m => m.status === 'creating')) return false;
    if ((team.messages || []).some(m => !m.copy && !m.passive && ['queued', 'sending', 'waiting-model'].includes(m.state))) return false;
    const idle = sid => ['idle', 'dormant'].includes(sessionState(sid));
    if (!idle(team.leadSid) || !active.every(m => idle(m.sid))) return false;
    const real = (team.messages || []).filter(m => m.from !== 'hub');
    const memberMark = Math.max(0, ...active.map(m => Math.max(lastOutputAt(m.sid), Number(m.joinedAt) || 0, Number(m.recalledAt) || 0)),
      ...real.map(m => Math.max(Number(m.at) || 0, Number(m.sentAt) || 0)));
    const lastActive = Math.max(memberMark, lastOutputAt(team.leadSid));
    if (!lastActive || t - lastActive < IDLE_TEAM_MS || (team.idleAlertAt || 0) >= memberMark) return false;
    team.idleAlertAt = t;
    enqueue(team, 'hub', LEAD, `全队已空闲 ${Math.round((t - lastActive) / 60000)} 分钟，没有排队消息。请决定：继续派活（send），还是收尾（dismiss 成员）。`);
    return true;
  }
  function markUnconfirmed(team, items, to, error) {
    const warning = '可能已送达，请先核对对方会话再决定是否重发';
    for (const item of items) { item.state = 'unconfirmed'; item.notSent = false; item.error = error ? `${String(error).slice(0, 200)}；${warning}` : warning; }
    if (to !== LEAD) enqueue(team, 'hub', LEAD, `发给 ${to} 的消息${warning}。用 status 查看保留的正文。`);
  }
  const leadQuietRule = () => `对${approver}：成员消息不逐条转述，只在里程碑、坏消息或要拍板时汇报，先答最近的问题或离总目标还差多少。其余处理完只回一行 ${NO_UPDATE_MARK}（界面不显示）。`;
  function leadFooter(team, full) {
    return team.leadFooterAt == null || now() - team.leadFooterAt >= FOOTER_FULL_EVERY_MS
      ? full : `（规则同前；无里程碑、坏消息或待拍板只回 ${NO_UPDATE_MARK}）`;
  }
  function leadBatchText(team, batch) {
    const full = formatBatch(team, batch, LEAD);
    const total = batch.reduce((n, m) => n + String(m.text || '').length, 0);
    const configured = Number(getConfig()?.team?.leadInboxChars);
    if (total <= (configured > 0 ? configured : LEAD_INBOX_CHARS)) return full;
    const folder = path.join(dir(), 'inbox', team.leadSid), file = path.join(folder, newId('batch') + '.md');
    try { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, full, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { logger.warn?.('[team] 长批次落盘失败，改为整批直送', error.message); return full; }
    for (const m of batch) m.inboxFile = file;
    const bySender = new Map();
    for (const m of batch) { if (!bySender.has(m.from)) bySender.set(m.from, []); bySender.get(m.from).push(m); }
    const lines = [...bySender].map(([from, ms]) => {
      const who = from === 'hub' ? 'Hub' : from === LEAD ? '负责人' : `${from} ${team.members.find(m => m.memberId === from)?.title || ''}`.trim();
      return `- [${who}] ${ms.length} 条 · ${ms.reduce((n, m) => n + String(m.text || '').length, 0)} 字 · ${ms.map(ref).join('、')}`;
    });
    return [`【团队消息 · ${batch.length} 条 · 原文已存文件】`, ...lines, `原文：${file}`,
      `共 ${total} 字，按成员分段读完，只关注结论和要你处理的事。`,
      leadFooter(team, cmdLine(commandPath(), ['原文 hub-team read --id <短号数字>', '回复 hub-team send --to <成员编号> --message "…"']) + leadQuietRule())].join('\n');
  }
  function formatBatch(team, batch, to) {
    const name = id => (id === 'hub' ? 'Hub' : id === LEAD ? '负责人' : `${id} ${memberById(team, id)?.title || ''}`.trim());
    // 抄送按交流双方合并，原消息编号全部保留；旧版抄送不猜关联，原样展示。
    const groups = new Map(), notices = [];
    for (const m of batch) {
      if (to === LEAD && m.copy && m.sourceId && m.copyTo) {
        const key = `${m.from}:${m.copyTo}`;
        if (!groups.has(key)) { const group = { items: [] }; groups.set(key, group); notices.push(group); }
        groups.get(key).items.push(m);
      } else notices.push({ items: [m] });
    }
    const named = new Set();
    const tag = id => { if (id === 'hub' || id === LEAD || named.has(id)) return id === 'hub' || id === LEAD ? name(id) : id; named.add(id); return name(id); };
    const lines = notices.map(({ items }) => {
      const m = items[items.length - 1];
      const stamp = `${ref(m)} ${formatAbsoluteTime(m.at, now())}`;
      const text = items.length > 1
        ? `（抄送汇总）${m.from}→${m.copyTo} ${items.length} 条，最新：${m.text.replace(/^（抄送）[^：]*：/, '')}\n（只是最新一条的摘要，判断前读原文 ${items.map(srcRef).join('、')}）`
        : `${m.text}${m.sourceId ? '（原文 ' + srcRef(m) + '）' : ''}`;
      return `- [${tag(m.from)}${m.wake === false ? ' · 留言' : ''}] ${stamp}\n${text}`;
    });
    const cmd = commandPath();
    if (to === LEAD) return [`【团队消息 · ${notices.length} 条】`, ...lines, '',
      leadFooter(team, '普通告知无需回执。' + cmdLine(cmd, ['原文 hub-team read --id <短号数字>', '回复 hub-team send --to <成员编号> --message "…"', '全队 hub-team status']) + leadQuietRule())].join('\n');
    return [`【团队消息 · ${notices.length} 条】`, ...lines, '',
      `普通告知无需回执；处理旧消息先核对编号和当前任务。读完整原文：\`"${cmd}" read --id <短号数字>\`。`,
      to === LEAD ? `回复成员：\`"${cmd}" send --to <成员编号> --message "…"\`；看全队：\`"${cmd}" status\`。`
        : `回复：\`"${cmd}" send --to ${batch[0].from === 'hub' ? LEAD : batch[0].from} --message "…"\`。`].join('\n');
  }
  async function interruptNow(team, item, target) {
    const lock = team.leadSid + ':' + item.to;
    sending.add(lock); item.state = 'sending'; item.sendingAt = now(); item.submissionId = item.id; save(team);
    try {
      const targetSid = target.sid;
      const shouldSubmit = () => !frozen && memberById(team, item.to)?.sid === targetSid
        && team.messages.includes(item) && ['sending', 'waiting-model'].includes(item.state);
      const result = await injectPrompt(targetSid, `## 负责人追加指示（${item.id}）\n${item.text}\n\n按这条指示调整当前工作，不重做已完成的部分。`, { clientSubmissionId: item.id, shouldSubmit });
      if (frozen && item.notSent === true && item.modelWait) return;
      if (result?.uncertain) markUnconfirmed(team, [item], item.to);
      else if (result?.accepted) { item.state = 'sent'; item.sentAt = now(); item.via = 'interrupt'; }
      else {
        item.state = 'failed'; item.error = result?.message || result?.error || '插话未发送';
        enqueue(team, 'hub', LEAD, `发给 ${item.to} 的消息没送达：${item.error}。用 status 查看保留的正文。`);
      }
    } catch (error) { if (!(frozen && item.notSent === true && item.modelWait)) markUnconfirmed(team, [item], item.to, error.message); }
    finally { sending.delete(lock); save(team); }
  }

  // ---- 其他动作 ----
  function deliveryView(team, m) {
    const target = memberById(team, m.to);
    const waitedMs = Math.max(0, (m.sentAt || now()) - m.at);
    const receiptOverdue = m.state === 'sending' && m.notSent !== true && now() - (m.sendingAt ?? m.at) >= RECEIPT_WAIT_MS;
    const sessionWait = modelWaits.get(target?.sid);
    const wait = ['queued', 'sending', 'waiting-model'].includes(m.state) && (m.modelWait
      || (sessionWait && ((m.state === 'queued' && sessionWait.operation === 'resume')
        || sessionWait.clientSubmissionIds?.includes(m.submissionId)) && sessionWait));
    const stage = wait ? 'waiting-model' : receiptOverdue ? 'unconfirmed' : m.state;
    let reason = m.error || '';
    if (m.state === 'sending') reason = receiptOverdue ? '暂未收到确认，送达结果待核对；不会自动重发' : '正在提交，等待送达回执';
    else if (m.state === 'sent') reason = '提交已确认；不代表对方已阅读或完成任务';
    else if (m.state === 'queued' && !(m.retryAt > now())) {
      const state = target ? sessionState(target.sid) : 'missing';
      reason = ['idle', 'dormant'].includes(state) && personalSlotsFull(target) ? `个人账号上已有 ${PERSONAL_MEMBER_LIMIT} 位成员在干活，排队等空位`
        : state === 'running' ? (m.waitReason || '等待对方回合结束') : state === 'dormant' ? '等待唤醒会话' : state === 'missing' ? '目标会话不可用' :
        m.to === LEAD && m.wake === false ? '留言等待负责人唤醒或批量送达' : '等待投递';
    }
    if (wait) reason = wait.reason;
    return { id: m.id, ...(m.seq ? { seq: m.seq } : {}), from: m.from, to: m.to, targetSessionId: target?.sid || null, state: m.state, stage,
      label: ({ 'waiting-model': '等待模型确认', queued: '排队', sending: '发送中', sent: '已送', failed: '提交失败', unconfirmed: '送达结果待核对' })[stage] || stage,
      reason, ...(wait || m.notSent === true ? { notSent: true } : {}), at: m.at, sendingAt: m.sendingAt || null, sentAt: m.sentAt || null, waitedMs,
      retryAt: m.state === 'queued' && m.retryAt > now() ? m.retryAt : null };
  }
  function status(callerSid) {
    const found = teamOfLead(callerSid) ? { team: teamOfLead(callerSid), member: { memberId: LEAD } } : teamOfMember(callerSid);
    if (!found) return { team: null, note: `你还不在任何团队里。当负责人：先用 accounts 看可用账号，再用 propose 提交招人计划，等${approver}批准。` };
    const { team, member } = found;
    const mine = (team.messages || []).filter(m => m.to === member.memberId || m.from === member.memberId);
    return {
      you: member.memberId, leadSid: team.leadSid,
      members: [{ memberId: LEAD, title: sessionManager.getSession(team.leadSid)?.title || '负责人', state: sessionState(team.leadSid), reason: modelWaitFor(team.leadSid)?.reason || '', runtime: runtimeOf(team.leadSid) }]
        .concat((team.members || []).map(m => ({ memberId: m.memberId, title: m.title, role: m.role, kind: m.kind, account: m.account, ...(m.model ? { model: m.model } : {}), runtime: runtimeOf(m.sid), status: m.status, state: m.status === 'dismissed' ? 'dismissed' : sessionState(m.sid), reason: modelWaitFor(m.sid)?.reason || '',
          ...(m.deliveredAt ? { delivered: true } : {}), ...(m.dismissReason ? { dismissReason: m.dismissReason } : {}) }))),
      plans: member.memberId === LEAD ? (team.plans || []).map(p => ({ id: p.id, status: p.status, size: p.members.length, note: p.note || '' })) : undefined,
      grants: team.grants,
      messages: mine.map(m => deliveryView(team, m)),
      pendingForYou: mine.filter(m => m.to === member.memberId && ['queued', 'sending', 'waiting-model', 'unconfirmed'].includes(m.state)).map(m => ({ ...deliveryView(team, m), text: m.text, sourceId: m.sourceId, bodyPath: m.bodyPath, wake: m.wake !== false })),
      undelivered: mine.filter(m => m.from === member.memberId && ['queued', 'sending', 'waiting-model', 'failed', 'unconfirmed'].includes(m.state)).map(m => ({ ...deliveryView(team, m), text: m.text.slice(0, 200), error: m.error || '' })),
    };
  }
  function runtimeOf(sid) {
    const s = sessionManager.getSession(sid);
    if (!s) return null;
    const last = lastOutputAt(sid);
    return { source: 'Hub 会话登记值，未独立核验 CLI 实际生效配置',
      account: s.codeagentPoolAccount || null, model: s.currentModel?.id || s.model || null,
      cwd: s.cwd || null, lastOutputMinAgo: last ? Math.max(0, Math.floor((now() - last) / 60000)) : null };
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
      case 'read': return read(callerSid, args);
      case 'allow': return allow(callerSid, args);
      case 'restart': return restart(callerSid, args);
      case 'dismiss': return dismiss(callerSid, args);
      default: throw Error('未知动作；可用：status / accounts / propose / send / read / allow / restart / dismiss');
    }
  }

  function tick() {
    if (frozen) return;
    try { watch(); } catch (error) { logger.warn?.('[team] 心跳巡检失败', error.message); }
    for (const team of teams.values()) flush(team).catch(error => logger.warn?.('[team] 投递失败', error.message));
  }
  function start() { sessionManager.off?.('session-model-wait', onModelWait); sessionManager.on?.('session-model-wait', onModelWait); sessionManager.off?.('session-submission-handoff', onSubmissionHandoff); sessionManager.on?.('session-submission-handoff', onSubmissionHandoff); load(); if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.(); } }
  function stop() { clearInterval(timer); timer = null; sessionManager.off?.('session-model-wait', onModelWait); sessionManager.off?.('session-submission-handoff', onSubmissionHandoff); }

  function accounts() {
    const list = listAccounts();
    return { ...list, note: 'id 填进计划 account，model 从该账号 models 清单选择；省略 model 沿用账号设置。用户在批准时可改账号和模型。'
      + (list.recommendedId === PERSONAL_ACCOUNT_ID ? `号池没有可用号，成员会用个人账号：${PERSONAL_SHARED_NOTE}。` : '') };
  }
  return { start, stop, invoke, decide, accounts, listTeams, teamOfLead, teamOfMember, flush: lead => { const t = teamOfLead(lead); return t ? flush(t) : null; },
    freeze: () => { frozen = true; }, unfreeze: () => { frozen = false; }, watch: () => { lastWatch = 0; watch(); } };
}

module.exports = { createTeamService, MAX_MEMBERS, NOTICE_LIMIT };
