'use strict';
// 蒸馏自己 · 主进程服务（2026-11-28）：取材 → 去敏 → 统计 → 模型提炼 → 存本机画像，并提供 IPC。
//   取材只读本机已有的 WeLink 长期档案（没建好时退回助理快照里最近 36 小时），不新增任何 WeLink 请求；只取本人消息，别人的只用时间戳。
//   后端按「设置 › 功能模型 › 蒸馏自己」：CodeAgent / Claude Code（含部门 key 等来源）/ 只统计；没选过有 CodeAgent 就用 CodeAgent（沿用助理的模型偏好）。
//   画像与审计只在本机 <dataDir>/self-distill/ 下；本人原话只在内存里做出口拦截，不落盘。
// 三方审查修复（2026-11-28 下午）：
//   并发——每次蒸馏有代次，删除让在途任务作废；写回前重读最新画像再合并（锁定条目、tags、apply 不被冲掉）。
//   出口——社区出口失败即关：原话索引不可用、检查出错一律 ok:false；检查的是最终显示 / 发送的文本。
//   取材——分批读档案、每个会话之间让出主线程；原话索引只在蒸馏后、画像变更后或过期时重建。
//   变更——保存、开关、删除、蒸馏完成都发 self-distill:changed，主进程订阅方（桌宠）用 onChanged 立即失效缓存。
const fs = require('node:fs');
const path = require('node:path');
const SD = require('../core/self-distill');

const DAY = 86400000, ARCHIVE_DAYS = 100, SNAPSHOT_MS = 36 * 3600000, CORPUS_TTL = 6 * 3600000;
const BUBBLE_MAX = 40; // 社区气泡最长字数（与 renderer/community-scene.js 一致）
const yieldNow = () => new Promise(r => setImmediate(r));

// 主进程里订阅画像变更的回调（桌宠控制器等）。
const listeners = new Set();
function onChanged(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }

function createSelfDistillService({ dataDir, getAssistant = () => null, sendToRenderer = () => {}, runModel = null, resolveBackend = null,
  findCommand = null, now = Date.now, logger = console } = {}) {
  const store = SD.createStore({ dataDir, now });
  let running = false, epoch = 0;
  let corpus = null, building = null; // corpus：{ owner, at, index, names }，只在内存
  const assistant = () => { try { return getAssistant() || null; } catch { return null; } };
  const emit = ev => { try { sendToRenderer('self-distill:progress', ev); } catch { /* 窗口没开 */ } };
  const changed = why => {
    try { sendToRenderer('self-distill:changed', { why }); } catch { /* 窗口没开 */ }
    for (const fn of listeners) { try { fn({ why }); } catch { /* 订阅方自己的错不影响这里 */ } }
  };

  // 账号与分身一致：快照里确认过的登录优先，其次长期档案记下的账号。
  function owner() {
    const a = assistant(); if (!a) return null;
    try { const snap = a.snapshot?.(); if (snap?.login?.ok && snap.login.uid) return String(snap.login.uid); } catch { /* 没有快照 */ }
    try { return a.archive?.owner?.() || null; } catch { return null; }
  }
  function archiveReady(o) {
    const a = assistant();
    try { const st = a?.archive?.status?.(o); return !!(st && st.available && st.messages > 0); } catch { return false; }
  }

  // ---- 后端 ----
  function backend() {
    const choice = require('../core/feature-agent-choice');
    let sel = null;
    if (resolveBackend) sel = resolveBackend();
    else try { sel = choice.resolve(dataDir, 'distill').selected; } catch { sel = null; }
    if (sel?.kind === choice.STATS_ONLY) return { kind: 'stats-only', model: '', label: '只统计（不调模型）', statsOnly: true };
    let run = null;
    if (sel?.kind === 'codeagent') run = sel;
    else if (sel?.kind === 'codeagent-lite') run = { ...sel, kind: 'codeagent' }; // 单次调用没有常驻会话，Lite 与 CodeAgent 同一条线
    else if (sel?.kind === choice.GATEWAY) run = { kind: 'claude', source: 'gateway', model: sel.model || '' };
    else if (sel?.kind === 'claude' && sel.source) run = sel;
    if (!run && !sel) {
      let has = false;
      try { has = !!(findCommand || require('../core/community-setup').findCommand)('codeagent'); } catch { has = false; }
      if (has) run = { kind: 'codeagent', model: '' };
    }
    if (!run) return { kind: 'stats-only', model: '', label: '只统计（没找到可用的模型后端）', none: true };
    // 默认 CodeAgent、没单独指定模型：沿用助理设置的模型与供应商（和设置页「CodeAgent · 助理模型与供应商」一致）。
    if (run.kind === 'codeagent' && !run.model) {
      try {
        const pref = require('../core/codeagent-assistant-route').preference(dataDir);
        if (pref?.model) run = { ...run, model: pref.model, ...require('../core/codeagent-model-choice').routeFields(pref) };
      } catch { /* 没有助理偏好就用 CLI 默认模型 */ }
    }
    const label = run.source === 'gateway' ? '部门 API key' : run.kind === 'codeagent' ? 'CodeAgent' : 'Claude Code';
    return { kind: sel?.kind || run.kind, model: run.model || '', label: run.model ? `${label} · ${run.model}` : label, run };
  }
  async function callModel(b, prompt) {
    if (runModel) return runModel(prompt, b);
    require('../core/company-ai-policy').assertExternalAiAllowed();
    return require('../core/feature-agent-run').run(b.run, prompt, { dataDir, timeoutMs: 300000, crew: true });
  }

  // ---- 取材 ----
  // 人名名单：长期档案的通讯录缓存、会话名、快照里的发送人、助理的姓名缓存（names-*.json）。只在内存里用。
  // 只排除账号标识（等于某个账号、带数字或 @）；已解析的英文姓名照样保留（审查 P1）。
  function namesFrom(a, idx, snap) {
    const out = new Set(), accounts = new Set();
    for (const [acc, n] of Object.entries(idx?.names || {})) { accounts.add(acc); out.add(n); }
    for (const [acc, meta] of Object.entries(idx?.convs || {})) { accounts.add(acc); if (meta && !meta.group && meta.name) out.add(meta.name); }
    for (const c of snap?.conversations || []) { if (c.id) accounts.add(String(c.id)); if (!c.group && c.name) out.add(c.name); }
    for (const list of Object.values(snap?.messages || {})) for (const m of list || []) { if (m.account) accounts.add(String(m.account)); if (!m.mine && m.sender) out.add(m.sender); }
    try {
      for (const f of fs.readdirSync(a.dir).filter(f => /^names-[0-9a-f]{64}\.json$/.test(f))) {
        const c = JSON.parse(fs.readFileSync(path.join(a.dir, f), 'utf8'));
        for (const [acc, e] of Object.entries(c.entries || {})) { accounts.add(acc); if (e && e.name) out.add(e.name); }
      }
    } catch { /* 没有姓名缓存 */ }
    return [...out].map(s => String(s).trim()).filter(s => s.length >= 2 && !accounts.has(s) && !/[\d@]/.test(s));
  }
  // 分会话读档案，每个会话之间让出主线程（100 天档案几百万字，一次同步读完会卡界面）。
  async function collect(o) {
    const a = assistant();
    let snap = null; try { snap = a?.snapshot?.() || null; } catch { snap = null; }
    const rows = [];
    if (archiveReady(o)) {
      const idx = a.archive.loadIndex(o), since = now() - ARCHIVE_DAYS * DAY;
      let failed = 0;
      for (const [convId, meta] of Object.entries(idx.convs || {})) {
        let list = [];
        try { list = a.archive.read(o, convId, { since }); } catch { list = []; failed += 1; }
        for (const r of list) rows.push({ at: r.at, c: convId, g: meta?.group ? 1 : 0, ...(r.m ? { m: 1, t: r.t, ct: r.ct } : {}) });
        await yieldNow();
      }
      return { kind: 'archive', rows, failed, names: namesFrom(a, idx, snap) };
    }
    const since = now() - SNAPSHOT_MS;
    for (const conv of snap?.conversations || []) {
      for (const m of (snap.messages || {})[conv.id] || []) {
        if (!m || (m.at || 0) < since) continue;
        rows.push({ at: m.at || 0, c: conv.id, g: conv.group ? 1 : 0, ...(m.mine ? { m: 1, t: m.text || '', ct: m.contentType || '' } : {}) });
      }
    }
    return { kind: 'snapshot', rows, names: namesFrom(a, null, snap) };
  }

  // ---- 对外 ----
  function status() {
    const o = owner(), p = o ? store.read(o) : null, b = backend();
    return { ok: true, enabled: !!p, portrait: p, archiveReady: o ? archiveReady(o) : false, backendLabel: b.label, backendOk: !b.none, running,
      ...(o ? {} : { reason: '还没确认 WeLink 登录：先在「助理」页完成登录和取数' }) };
  }
  async function runNow({ statsOnly = false } = {}, myEpoch) {
    const o = owner();
    if (!o) { emit({ step: 'error', text: '还没确认 WeLink 登录：先在「助理」页完成登录和取数，再点「蒸馏自己」' }); return; }
    const stale = () => myEpoch !== epoch || owner() !== o;
    try {
      emit({ step: 'collect', text: archiveReady(o) ? '从本机长期档案取你自己发的消息' : '长期档案还没建好，先用最近 36 小时的消息出初版' });
      const got = await collect(o), mine = got.rows.filter(r => r.m).length;
      emit({ step: 'collect', text: `取到你自己发的消息 ${mine} 条（${got.kind === 'archive' ? '长期档案' : '最近 36 小时'}）`, n: mine });
      const b = statsOnly ? { kind: 'stats-only', model: '', label: '只统计（不调模型）', statsOnly: true } : backend();
      const r = await SD.distill({ rows: got.rows, names: got.names, source: { kind: got.kind }, previous: store.read(o), statsOnly: !!b.statsOnly, noBackend: !!b.none,
        backend: b, runModel: (b.run || runModel) ? prompt => callModel(b, prompt) : null, onStep: emit });
      if (stale()) { emit({ step: 'error', text: '画像在蒸馏过程中被删除或换了账号，这次结果已作废' }); return; }
      emit({ step: 'save', text: '保存到本机画像' });
      // 写回前重读最新画像再合并：蒸馏期间本人做的锁定、勾选和开关都保留。
      const saved = store.write(o, SD.mergePrevious(r.fresh, store.read(o)));
      corpus = { owner: o, at: now(), index: r.corpus, names: got.names };
      store.audit(o, { op: 'distill', source: got.kind, msgs: r.counts.msgs, kept: r.counts.kept, dropped: r.counts.dropped, backend: saved.backend.kind, note: r.noteCode || '', tone: saved.speak.tone.length, examples: saved.speak.examples.length });
      changed('distill');
      emit({ step: 'done', text: saved.note ? `画像已更新。${saved.note}` : `画像已更新：${saved.speak.tone.length} 条口吻、${saved.speak.examples.length} 句仿写例句`, n: r.counts.kept, total: r.counts.msgs });
    } catch (e) {
      logger.warn?.('[self-distill] 蒸馏失败：', e.message);
      emit({ step: 'error', text: '蒸馏没完成，可稍后重试' });
    }
  }
  function run(req = {}) {
    if (running) return { ok: true, started: false, running: true };
    running = true;
    const job = runNow(req, epoch).finally(() => { running = false; });
    service.lastJob = job;
    return { ok: true, started: true };
  }
  function need() { const o = owner(); if (!o) throw new Error('还没确认 WeLink 登录：先在「助理」页完成登录和取数'); return o; }
  function save({ patch } = {}) {
    const o = need(), p = store.read(o);
    if (!p) throw new Error('还没有画像，先点「蒸馏自己」');
    const next = store.write(o, SD.applyPatch(p, patch || {}));
    store.audit(o, { op: 'save', catchphrases: next.speak.catchphrases.length, tone: next.speak.tone.length, examples: next.speak.examples.length, topics: next.habits.topics.length, tags: (next.tags || []).filter(t => t.on).length });
    changed('save');
    return { ok: true, portrait: next };
  }
  function apply({ target, on } = {}) {
    const o = need(), p = store.read(o);
    if (!p) throw new Error('还没有画像，先点「蒸馏自己」');
    if (!SD.TARGETS.includes(target)) throw new Error('未知的应用对象');
    const next = store.write(o, { ...p, apply: { ...SD.emptyApply(), ...p.apply, [target]: !!on } });
    store.audit(o, { op: 'apply', target, on: !!on });
    changed('apply');
    return { ok: true, apply: next.apply };
  }
  function remove() {
    const o = need();
    epoch += 1; // 在途的蒸馏作废，不会把画像写回来
    store.remove(o); corpus = null;
    changed('delete');
    return { ok: true };
  }
  function forTarget(target) { const o = owner(); return o ? SD.forTarget({ dataDir, owner: o, target, store }) : null; }
  // 桌宠等主进程调用方用（同步）：当前账号 + 本服务的 dataDir；没登录、没画像、没打开或出错一律 null。
  function forTargetCurrent(target) { try { return forTarget(target) || null; } catch { return null; } }

  // 出口拦截用的原话索引：只在内存；蒸馏完成时直接换成新的，过期（6 小时）或换账号才在后台重建。
  async function guardContext() {
    const o = owner(); if (!o) return null;
    if (corpus && corpus.owner === o && now() - corpus.at < CORPUS_TTL) return corpus;
    if (!building) {
      building = (async () => {
        const got = await collect(o);
        // 有会话读失败时原话索引不完整，出口检查按不可用处理（失败即关），也不缓存。
        if (got.failed) throw new Error(`档案有 ${got.failed} 个会话没读出来`);
        const originals = got.rows.filter(r => r.m && r.t).map(r => r.t);
        corpus = { owner: o, at: now(), index: SD.buildCorpusIndex(originals), names: got.names };
        return corpus;
      })().finally(() => { building = null; });
    }
    try { const c = await building; return c && c.owner === o ? c : null; } catch (e) { logger.warn?.('[self-distill] 原话索引没建好：', e.message); return null; }
  }
  // 说出去之前过闸（社区代答、社区气泡）：和原话重合 ≥12 字、带人名 / 代号 / 联系方式、敏感内容、替本人应承 → 拦，记审计（不含原话）。
  // 失败即关：没登录、原话索引不可用、检查本身出错，一律 ok:false。
  async function guard(text, { where = '' } = {}) {
    let ctx = null;
    try { ctx = await guardContext(); } catch { ctx = null; }
    if (!ctx) return { ok: false, text: '', hit: 'unavailable' };
    let out;
    try {
      const r = SD.verbatimGuard(text, { corpus: ctx.index, names: ctx.names });
      out = r.ok && SD.commitRisk(text) ? { ok: false, text: '', hit: 'commit' } : r;
    } catch { out = { ok: false, text: '', hit: 'error' }; }
    if (!out.ok) store.audit(ctx.owner, { op: 'guard-block', where, hit: out.hit, len: String(text || '').length });
    return out;
  }
  // 气泡最终显示的文字：去标签、并空白、截到气泡长度。检查的就是这段，渲染进程原样显示。
  const bubbleText = t => String(t || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, BUBBLE_MAX);
  // 渲染进程要的社区 / 桌宠内容：社区的例句先生成最终显示文本再过闸，拦下的剔除。
  async function forTargetIpc({ target } = {}) {
    if (!['community', 'pet'].includes(target)) return null;
    const v = forTarget(target);
    if (v && target === 'community') {
      const out = [];
      for (const t of v.examples.map(bubbleText).filter(Boolean)) if ((await guard(t, { where: 'community-scene' })).ok) out.push(t);
      v.examples = out;
      // 检查期间画像被关掉或删除：不再返回旧内容。
      if (!forTarget(target)) return null;
    }
    return v;
  }

  function registerIpc(ipcMain) {
    const wrap = fn => async (_e, req = {}) => { try { return await fn(req || {}); } catch (e) { return { ok: false, error: e.message }; } };
    ipcMain.handle('self-distill:status', wrap(() => status()));
    ipcMain.handle('self-distill:run', wrap(req => run({ statsOnly: !!req.statsOnly })));
    ipcMain.handle('self-distill:save', wrap(req => save(req)));
    ipcMain.handle('self-distill:apply', wrap(req => apply(req)));
    ipcMain.handle('self-distill:delete', wrap(() => remove()));
    // 约定：直接返回 forTarget 结果；关着或出错都给 null（渲染侧按关闭处理）。
    ipcMain.handle('self-distill:for-target', async (_e, req = {}) => { try { return await forTargetIpc(req || {}); } catch { return null; } });
  }
  const service = { status, run, save, apply, remove, delete: remove, forTarget, forTargetCurrent, forTargetIpc, guard, bubbleText, owner, registerIpc, store, lastJob: null };
  current = service;
  return service;
}
// 模块级入口：用最近创建的服务实例（main.js 启动时建一个）；还没建或出错返回 null。
let current = null;
function forTargetCurrent(target) { try { return current ? current.forTargetCurrent(target) : null; } catch { return null; } }

module.exports = { createSelfDistillService, forTargetCurrent, onChanged, BUBBLE_MAX };
