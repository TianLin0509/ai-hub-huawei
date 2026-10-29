'use strict';
// 网页 AI 自动提问与读回答 + Hub 网页圆桌（2026-10-28 用户）。
// 填字、发送、读回答用 AI 圆桌 lite 的网页脚本（core/web-roundtable/lite-vendor，原样拷贝）：它在 lite 里经过 6 家网站的
// 真实账号实测，自带「提问归属核对、不重复发送、草稿不覆盖、结束信号」等保护。这里在 Electron 隔离世界（网站自己的脚本
// 看不到）里给它一个 chrome.runtime 垫片，让它像在 Chrome 插件里一样运行；网页用的是「AI 网页」里已经登录的那份。
// 2026-10-28 用户拍板：网页版不接 Claude；队长默认 DeepSeek；lite 继续独立维护，Hub 的新功能只做在 Hub。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { composePrompts, KIND_NAMES, STYLE_NAMES } = require('../core/web-roundtable/hub-prompts');

const VENDOR = path.join(__dirname, '..', 'core', 'web-roundtable', 'lite-vendor');
const WORLD_ID = 1207;
// lite 已适配、Hub「AI 网页」也有的网站。智谱清言、MiniMax 在 lite 里还没有适配，先不进圆桌。
const SUPPORTED = Object.freeze(['deepseek', 'chatgpt', 'gemini', 'kimi', 'qwen', 'doubao']);
const ACTIVE = new Set(['queued', 'preparing', 'sending', 'sent', 'streaming', 'unconfirmed']);
const LABELS = Object.freeze({ queued: '排队中', preparing: '检查网页', sending: '正在发送', sent: '等待回答', streaming: '正在回答', unconfirmed: '发送待确认', done: '已完成', attention: '需要确认', error: '没有发出', stopped: '已停止', skipped: '已跳过' });
const MAX_TABLES = 60;
const MAX_MEMBERS = 6;
const POLL_MS = 1000;
const CALL_TIMEOUT_MS = 90000;

// lite 的 content.js 只用到 chrome.runtime 的三样：id、sendMessage（网页→后台的进度事件）、onMessage（后台→网页的操作）。
// 进度事件先存在网页里，主进程每秒取一次；操作直接调用监听函数并等它回复。
const SHIM = `(()=>{if(globalThis.__hubLiteShim)return;
 const listeners=[],events=[];
 const runtime={id:'hub-web-roundtable',sendMessage(m){events.push(m);if(events.length>400)events.splice(0,events.length-400);return Promise.resolve({ok:true});},onMessage:{addListener(fn){listeners.push(fn);}}};
 try{const c=globalThis.chrome&&typeof globalThis.chrome==='object'?globalThis.chrome:(globalThis.chrome={});Object.defineProperty(c,'runtime',{value:runtime,configurable:true});}catch(e){globalThis.chrome={runtime};}
 globalThis.__hubLiteShim={
  call(message){return new Promise(resolve=>{let settled=false;const respond=r=>{if(!settled){settled=true;resolve(r);}};
   if(!listeners.length){respond({ok:false,error:'网页脚本未就绪'});return;}
   for(const fn of listeners){try{fn(message,{id:runtime.id},respond);}catch(e){respond({ok:false,error:e.message});}}});},
  drain(){return events.splice(0);}
 };})();`;
let pageScript = null;
function script() {
  if (!pageScript) pageScript = [SHIM, fs.readFileSync(path.join(VENDOR, 'adapters.js'), 'utf8'), fs.readFileSync(path.join(VENDOR, 'content.js'), 'utf8'), 'true'].join('\n;\n');
  return pageScript;
}

const run = (wc, code) => wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }], true);
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
// 网页刷新或跳转后隔离世界会清空，每次操作前确认脚本还在。
async function ensureScript(wc) {
  const ready = await run(wc, 'typeof __hubLiteShim==="object"&&!!globalThis.__yuanzhuoLite').catch(() => false);
  if (!ready) await run(wc, script());
}
async function pageCall(wc, message) {
  await ensureScript(wc);
  const result = await within(run(wc, `__hubLiteShim.call(${JSON.stringify(message)})`), CALL_TIMEOUT_MS, '网页没有在 90 秒内回应，请打开原网页查看');
  if (!result?.ok) throw Object.assign(new Error(result?.error || '网页没有确认操作，请打开原网页检查。'), { code: result?.code, question: result?.question, notSent: result?.notSent });
  return result;
}
async function drain(wc) {
  return run(wc, 'typeof __hubLiteShim==="object"?__hubLiteShim.drain():null').catch(() => null);
}

function createWebRoundtable({ dataDir, web, onChanged = () => {}, now = Date.now, logger = console }) {
  const file = path.join(dataDir, 'web-roundtables.json');
  let tables = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.tables)) tables = saved.tables.filter(t => t && typeof t.id === 'string' && Array.isArray(t.members) && Array.isArray(t.rounds));
    // 上次 Hub 退出时还在进行的成员：网页可能已经发出，不能自动重发，标成需要确认。
    for (const t of tables) for (const r of t.rounds) for (const j of r.jobs) if (ACTIVE.has(j.status)) {
      j.status = j.phase === 'attempted' ? 'attention' : 'error';
      j.error = j.phase === 'attempted' ? 'Hub 重启前这位成员已经发出提问，回答没读完。可点「重新读取」接着读，不会重发。' : 'Hub 重启前还没发出，可点「重发」。';
    }
  } catch (e) { if (e.code !== 'ENOENT') logger.warn('[web-roundtable] 记录无法读取，按空列表启动：', e.message); }
  const watching = new Map(); // requestId → { table, round, job }
  let timer = null, saveTimer = null, emitTimer = null, disposed = false;

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const tmp = file + '.' + crypto.randomUUID() + '.tmp';
      try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ version: 1, tables }, null, 2), 'utf8'); fs.renameSync(tmp, file); }
      catch (e) { try { fs.unlinkSync(tmp); } catch {} logger.warn('[web-roundtable] 保存失败：', e.message); }
    }, 300);
  }
  function emit() { clearTimeout(emitTimer); emitTimer = setTimeout(() => onChanged(state()), 80); }
  const changed = () => { save(); emit(); };

  function memberInfo(id) {
    const item = web.state().items.find(i => i.id === id);
    if (!item) return { id, exists: false, name: '已关闭的网页', site: '', logo: '', identityLabel: '', title: '' };
    return { id, exists: true, name: item.siteName + (item.identity === 'alt' ? '（副）' : ''), site: item.site, logo: item.logo, identityLabel: item.identityLabel, title: item.displayTitle, status: item.status };
  }
  const label = id => memberInfo(id).name;
  function publicTable(t) {
    return { ...t, memberInfo: t.members.map(memberInfo), busy: t.rounds.some(r => r.jobs.some(j => ACTIVE.has(j.status))),
      rounds: t.rounds.map(r => ({ ...r, kindName: KIND_NAMES[r.kind] + (r.kind === 'discuss' ? ' · ' + STYLE_NAMES[r.style || 'debate'] : ''),
        jobs: r.jobs.map(j => ({ id: j.id, member: j.member, status: j.status, statusText: LABELS[j.status] || j.status, text: j.text || '', error: j.error || '', prompt: j.prompt, mode: j.mode || '', url: j.url || '', updatedAt: j.updatedAt })) })) };
  }
  function candidates() {
    return web.state().items.filter(i => SUPPORTED.includes(i.site)).map(i => ({ id: i.id, site: i.site, siteName: i.siteName, logo: i.logo, identity: i.identity, identityLabel: i.identityLabel, title: i.displayTitle, status: i.status }));
  }
  function state() {
    return { ok: true, tables: tables.map(publicTable), candidates: candidates(), supported: SUPPORTED, kinds: KIND_NAMES, styles: STYLE_NAMES };
  }
  const findTable = id => { const t = tables.find(x => x.id === id); if (!t) throw new Error('这个圆桌已不存在'); return t; };

  function create({ members, captain, title } = {}) {
    const ids = Array.isArray(members) ? [...new Set(members.map(String))] : [];
    if (ids.length < 2 || ids.length > MAX_MEMBERS) throw new Error(`请选 2–${MAX_MEMBERS} 个网页 AI 当成员。`);
    const items = web.state().items;
    for (const id of ids) {
      const item = items.find(i => i.id === id);
      if (!item) throw new Error('有成员对应的网页会话已关闭，请重新选择。');
      if (!SUPPORTED.includes(item.site)) throw new Error(`${item.siteName} 暂不支持自动提问。`);
    }
    // 队长默认 DeepSeek（用户 2026-10-28），没有 DeepSeek 成员就用第一位。
    const lead = ids.includes(captain) ? captain : ids.find(id => items.find(i => i.id === id)?.site === 'deepseek') || ids[0];
    const t = now();
    const table = { id: 'wrt-' + crypto.randomUUID().slice(0, 12), title: String(title || '').trim().slice(0, 80), members: ids, captain: lead, createdAt: t, updatedAt: t, rounds: [] };
    tables.unshift(table);
    if (tables.length > MAX_TABLES) tables = tables.filter((x, i) => i < MAX_TABLES || x.rounds.some(r => r.jobs.some(j => ACTIVE.has(j.status))));
    changed();
    return { ...state(), tableId: table.id };
  }
  function update({ tableId, members, captain, title } = {}) {
    const table = findTable(tableId);
    if (members !== undefined) {
      const ids = [...new Set((members || []).map(String))];
      if (ids.length < 2 || ids.length > MAX_MEMBERS) throw new Error(`请保留 2–${MAX_MEMBERS} 位成员。`);
      const items = web.state().items;
      if (ids.some(id => !items.find(i => i.id === id && SUPPORTED.includes(i.site)))) throw new Error('有成员对应的网页会话不可用，请重新选择。');
      table.members = ids;
      if (!ids.includes(table.captain)) table.captain = ids.find(id => items.find(i => i.id === id)?.site === 'deepseek') || ids[0];
    }
    if (captain !== undefined) { if (!table.members.includes(captain)) throw new Error('队长必须是圆桌成员。'); table.captain = captain; }
    if (title !== undefined) table.title = String(title || '').trim().slice(0, 80);
    table.updatedAt = now();
    changed();
    return state();
  }
  function remove({ tableId } = {}) {
    const table = findTable(tableId);
    for (const r of table.rounds) for (const j of r.jobs) if (ACTIVE.has(j.status)) void stopJob(j, false);
    tables = tables.filter(t => t !== table);
    changed();
    return state();
  }

  function ask({ tableId, kind = 'ask', text = '', style = 'debate', depth = '简要结论', fresh = false } = {}) {
    const table = findTable(tableId);
    if (table.rounds.some(r => r.jobs.some(j => ACTIVE.has(j.status)))) throw new Error('上一轮还有成员在回答，等它们答完或停止后再发。');
    const missing = table.members.filter(id => !web.state().items.some(i => i.id === id));
    if (missing.length) throw new Error('有成员对应的网页会话已关闭，请在「成员」里换掉它。');
    const prompts = composePrompts(kind, text, table, { captain: table.captain, depth, style: style === 'collab' ? 'collab' : 'debate', label });
    const t = now();
    const round = { id: 'r-' + crypto.randomUUID().slice(0, 8), kind, style: kind === 'discuss' ? (style === 'collab' ? 'collab' : 'debate') : undefined, prompt: kind === 'ask' ? text : text.trim(), depth: kind === 'summary' ? depth : undefined,
      fresh: kind === 'ask' && !!fresh, createdAt: t,
      jobs: prompts.map(p => ({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), member: p.member, prompt: p.prompt, status: 'queued', phase: 'not_sent', text: '', error: '', baseline: null, anchor: null, url: '', mode: '', updatedAt: t })) };
    if (!table.title && kind === 'ask') table.title = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    table.rounds.push(round);
    table.updatedAt = t;
    changed();
    for (const job of round.jobs) void dispatch(table, round, job);
    return { ...state(), tableId: table.id, roundId: round.id };
  }

  function set(job, patch) { Object.assign(job, patch, { updatedAt: now() }); changed(); }
  async function dispatch(table, round, job) {
    const item = web.state().items.find(i => i.id === job.member);
    if (!item) { set(job, { status: 'error', error: '这位成员的网页会话已关闭。' }); return; }
    web.setAutomation?.(job.member, true);
    try {
      set(job, { status: 'preparing' });
      const { wc } = await web.pageFor(job.member, { fresh: round.fresh, url: round.url || '' });
      if (job.status !== 'preparing') return;
      // lite 的保护：上几轮自己发过、可能残留在输入框里没发出的问题，允许清掉；用户自己打的草稿永不覆盖。
      const stale = table.rounds.slice(-6).flatMap(r => r.jobs).filter(j => j.member === job.member && j.id !== job.id && j.prompt).map(j => j.prompt);
      const prep = await pageCall(wc, { type: 'YZ_PREPARE', provider: item.site, prompt: job.prompt, stale });
      if (job.status !== 'preparing') return;
      set(job, { baseline: prep.baseline, url: prep.url, mode: prep.mode || '', status: 'sending', phase: 'attempted' });
      watching.set(job.requestId, { table, round, job, wc, provider: item.site });
      ensureTimer();
      await pageCall(wc, { type: 'YZ_SEND', provider: item.site, requestId: job.requestId, prompt: job.prompt, baseline: job.baseline });
      if (job.status === 'sending') set(job, { status: 'unconfirmed' });
    } catch (e) {
      watching.delete(job.requestId);
      if (e.notSent === true) job.phase = 'not_sent';
      set(job, { status: job.phase === 'attempted' ? 'attention' : 'error', error: e.message });
      web.setAutomation?.(job.member, false);
    }
  }

  // 读回答：lite 脚本在网页里自己盯着页面，把「已发出 / 正在回答 / 完成 / 需要确认」作为事件交回来。
  async function poll() {
    const byPage = new Map();
    for (const w of watching.values()) {
      if (!byPage.has(w.wc)) byPage.set(w.wc, []);
      byPage.get(w.wc).push(w);
    }
    for (const [wc, list] of byPage) {
      if (wc.isDestroyed()) {
        for (const w of list) { watching.delete(w.job.requestId); set(w.job, { status: 'attention', error: '网页已关闭或休眠，回答没读完。重新打开网页后点「重新读取」。' }); web.setAutomation?.(w.job.member, false); }
        continue;
      }
      const events = await drain(wc);
      if (events === null) {
        // 网页刷新或跳转把脚本清掉了：重新装上，按本轮的发送记录接着读（不会重发）。
        for (const w of list) if (!w.rereading) void reread(w);
        continue;
      }
      for (const event of events) {
        const w = watching.get(event?.requestId);
        if (!w || event.type !== 'YZ_EVENT') continue;
        const job = w.job;
        if ((event.sequence || 0) <= (job.sequence || 0)) continue;
        job.sequence = event.sequence;
        if (event.anchor) job.anchor = event.anchor;
        if (event.url) job.url = event.url;
        const patch = { status: event.status };
        if (typeof event.text === 'string' && (event.text || event.status === 'done')) patch.text = event.text;
        patch.error = event.error || '';
        set(job, patch);
        if (event.status === 'done') { try { const u = w.wc.getURL(); if (u && new URL(u).origin === new URL(job.url || u).origin) job.url = u; } catch {} }
        if (!ACTIVE.has(event.status)) { watching.delete(job.requestId); web.setAutomation?.(job.member, false); }
      }
    }
    if (!watching.size) { clearInterval(timer); timer = null; }
  }
  async function reread(w, { force = false } = {}) {
    w.rereading = true;
    try {
      await pageCall(w.wc, { type: 'YZ_REREAD', provider: w.provider, requestId: w.job.requestId, prompt: w.job.prompt, baseline: w.job.baseline, anchor: w.job.anchor, url: w.job.url, force });
    } catch (e) {
      watching.delete(w.job.requestId);
      set(w.job, { status: 'attention', error: e.message });
      web.setAutomation?.(w.job.member, false);
    } finally { w.rereading = false; }
  }
  function ensureTimer() {
    if (timer || disposed) return;
    timer = setInterval(() => { void poll().catch(e => logger.warn('[web-roundtable] 读取进度失败：', e.message)); }, POLL_MS);
    timer.unref?.();
  }
  function locate(tableId, jobId) {
    const table = findTable(tableId);
    for (const round of table.rounds) { const job = round.jobs.find(j => j.id === jobId); if (job) return { table, round, job }; }
    throw new Error('这位成员的回答记录已不存在');
  }
  // 「重新读取」：网页已经发出、但回答没读到（超时、网页刷新、需要确认）。force=用户确认网页上最新的提问就是这一轮。
  async function rereadJob({ tableId, jobId, force = false } = {}) {
    const { table, round, job } = locate(tableId, jobId);
    if (ACTIVE.has(job.status)) throw new Error('这位成员还在进行中');
    const item = web.state().items.find(i => i.id === job.member);
    if (!item) throw new Error('这位成员的网页会话已关闭');
    if (!job.baseline && !force) throw new Error('这一轮没有发出记录。要读取网页上最新的回答，请点「按网页最新回答读取」。');
    const { wc } = await web.pageFor(job.member, {});
    job.requestId = crypto.randomUUID(); job.sequence = 0;
    set(job, { status: 'sent', error: '' });
    const w = { table, round, job, wc, provider: item.site };
    watching.set(job.requestId, w);
    web.setAutomation?.(job.member, true);
    ensureTimer();
    await reread(w, { force });
    return state();
  }
  // 「重发」：只给确定没发出去的成员（phase=not_sent）；已经点过发送的不重发，防止网页上出现两条同样的提问。
  function resendJob({ tableId, jobId } = {}) {
    const { table, round, job } = locate(tableId, jobId);
    if (ACTIVE.has(job.status)) throw new Error('这位成员还在进行中');
    if (job.phase !== 'not_sent') throw new Error('这位成员的提问可能已经发出，为免重复不自动重发。请打开原网页核对，或点「重新读取」。');
    job.requestId = crypto.randomUUID(); job.sequence = 0;
    set(job, { status: 'queued', error: '', text: '' });
    void dispatch(table, round, job);
    return state();
  }
  async function stopJob(job, stopGeneration = true) {
    const w = watching.get(job.requestId);
    watching.delete(job.requestId);
    set(job, { status: 'stopped', error: job.error || '' });
    web.setAutomation?.(job.member, false);
    if (w && !w.wc.isDestroyed()) await pageCall(w.wc, { type: 'YZ_STOP', requestId: job.requestId, stopGeneration }).catch(() => {});
  }
  async function stop({ tableId, jobId } = {}) {
    const table = findTable(tableId);
    const jobs = table.rounds.flatMap(r => r.jobs).filter(j => ACTIVE.has(j.status) && (!jobId || j.id === jobId));
    await Promise.all(jobs.map(j => stopJob(j, true)));
    return state();
  }
  function skip({ tableId, jobId } = {}) {
    const { job } = locate(tableId, jobId);
    if (ACTIVE.has(job.status)) void stopJob(job, false);
    set(job, { status: 'skipped' });
    return state();
  }
  // 用户核对过网页后，确认这份（可能没有结束信号的）回答就是完整的。
  function accept({ tableId, jobId } = {}) {
    const { job } = locate(tableId, jobId);
    if (!job.text) throw new Error('还没有读到回答内容，不能确认完成。');
    set(job, { status: 'done', error: '' });
    return state();
  }
  // ── 命令行 AI 代问（网页圆桌 MCP 经本机接口调用，2026-10-28 用户：MCP 改用 AI 网页的登录）──
  // 每家网站用一个专门的网页会话「命令行代问」，侧栏里看得到它问了什么、答了什么；不占用用户正在看的网页。
  const asks = new Map();
  const AGENT_TITLE = '命令行代问';
  const memberBusy = id => [...watching.values()].some(w => w.job.member === id) || [...asks.values()].some(a => a.job.member === id && ACTIVE.has(a.job.status))
    || tables.some(t => t.rounds.some(r => r.jobs.some(j => j.member === id && ACTIVE.has(j.status))));
  function agentSession(provider) {
    const st = web.state();
    const mine = st.items.filter(i => i.site === provider && i.identity === 'main' && i.customTitle === AGENT_TITLE && i.id !== st.shownId && !memberBusy(i.id));
    if (mine.length) return mine[0].id;
    const created = web.create({ site: provider, identity: 'main' });
    web.rename(created.id, AGENT_TITLE);
    return created.id;
  }
  function askOne({ provider, prompt, url = '', member = '' } = {}) {
    if (!SUPPORTED.includes(provider)) throw new Error(`「AI 网页」不支持自动提问的网站：${provider}`);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 120000) throw new Error('问题必须是 1–120000 个字符');
    const items = web.state().items;
    let id = member && items.some(i => i.id === member && i.site === provider) ? member : '';
    if (id && memberBusy(id)) throw new Error('这个网页对话还在回答上一个问题，等它答完再追问。');
    // 追问要回到原来的对话：原会话已关闭时，用代问会话打开原对话地址。
    if (!id) id = agentSession(provider);
    const t = now();
    const job = { id: crypto.randomUUID(), requestId: crypto.randomUUID(), member: id, prompt, status: 'queued', phase: 'not_sent', text: '', error: '', baseline: null, anchor: null, url: '', mode: '', updatedAt: t };
    const round = { id: 'ask', kind: 'ask', fresh: !url, url, jobs: [job] };
    const task = { id: 'ask-' + crypto.randomUUID(), provider, table: { id: 'ask', rounds: [round] }, round, job, createdAt: t };
    asks.set(task.id, task);
    for (const [key, old] of asks) { if (asks.size <= 200) break; if (!ACTIVE.has(old.job.status)) asks.delete(key); }
    void dispatch(task.table, round, job);
    return { ok: true, id: task.id, member: id };
  }
  function askStatus({ id } = {}) {
    const task = asks.get(id);
    if (!task) return { ok: true, id, status: 'unknown', error: 'Hub 里没有这个提问的记录（Hub 可能重启过）。回答若已在网页上，请打开 AI 网页查看；不会自动重发。' };
    const j = task.job;
    return { ok: true, id, provider: task.provider, member: j.member, status: j.status, phase: j.phase, text: j.text, error: j.error, url: j.url, active: ACTIVE.has(j.status) };
  }
  async function askCollect({ id, force = false } = {}) {
    const task = asks.get(id);
    if (!task) throw new Error('Hub 里没有这个提问的记录');
    const j = task.job;
    if (ACTIVE.has(j.status) || j.status === 'done') return askStatus({ id });
    if (!j.baseline && !force) throw new Error('这个提问没有发出记录，不能补收');
    const item = web.state().items.find(i => i.id === j.member);
    if (!item) throw new Error('代问的网页会话已关闭');
    const { wc } = await web.pageFor(j.member, {});
    j.requestId = crypto.randomUUID(); j.sequence = 0;
    set(j, { status: 'sent', error: '' });
    const w = { table: task.table, round: task.round, job: j, wc, provider: item.site };
    watching.set(j.requestId, w);
    web.setAutomation?.(j.member, true);
    ensureTimer();
    await reread(w, { force });
    return askStatus({ id });
  }
  function dispose() { disposed = true; clearInterval(timer); timer = null; clearTimeout(saveTimer); const tmp = file + '.tmp'; try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, tables }, null, 2), 'utf8'); fs.renameSync(tmp, file); } catch {} }
  return { state, list: state, create, update, remove, ask, rereadJob, resendJob, stop, skip, accept, dispose, askOne, askStatus, askCollect };
}

function registerWebRoundtableIpc(ipcMain, { roundtable, getWindow }) {
  const trusted = event => { const win = getWindow(); return !!win && !win.isDestroyed() && event.sender === win.webContents; };
  const handlers = {
    'web-roundtable:list': () => roundtable.list(),
    'web-roundtable:create': r => roundtable.create(r),
    'web-roundtable:update': r => roundtable.update(r),
    'web-roundtable:remove': r => roundtable.remove(r),
    'web-roundtable:ask': r => roundtable.ask(r),
    'web-roundtable:reread': r => roundtable.rereadJob(r),
    'web-roundtable:resend': r => roundtable.resendJob(r),
    'web-roundtable:stop': r => roundtable.stop(r),
    'web-roundtable:skip': r => roundtable.skip(r),
    'web-roundtable:accept': r => roundtable.accept(r),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, request) => {
      if (!trusted(event)) return { ok: false, error: '无权操作网页圆桌' };
      try { return await fn(request || {}); } catch (e) { return { ok: false, error: e.message }; }
    });
  }
}

module.exports = { createWebRoundtable, registerWebRoundtableIpc, pageCall, ensureScript, SUPPORTED, SHIM, WORLD_ID, LABELS };
