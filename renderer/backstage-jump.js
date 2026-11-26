'use strict';
// 跳转后台（2026-11-26）：助理、分身、会议、PPT、论坛、造梦等背后有 Agent 会话的入口，统一用一个「后台」按钮和状态点。
// 状态点显示后台会话现在的状态：运行中、空闲、等待操作、报错、休眠、卡住 N 秒。点按钮切到主页这个会话的后台终端，
// 顶部会出一条「← 返回 X」，点一下回到原来的入口。会话还没建或已经关了，就在按钮旁边说明原因，能重开的给「重新打开」。
// 这里只负责跳转和显示状态，不动会话本身。页面用 HTML 字符串渲染按钮，点击由文档级委托统一处理；
// 状态只读渲染进程内存里的会话表（renderer.js 的 __hubSessionRuntime），不发 IPC。

const STUCK_MS = 90 * 1000;      // 运行中且这么久没有新输出，就标成「可能卡住」
const TICK_MS = 2000;
const sources = new Map();       // from → { label, reopen, recreate, leave, diagnose, emptyText, closedText }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4"/></svg>';

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

// 状态点的含义。runtime 来自 window.__hubSessionRuntime(id)：null 表示会话表里没有这个会话（已关闭）。
function backstageStatus(sessionId, runtime, now = Date.now()) {
  if (!sessionId) return { tone: 'none', text: '当前没有后台会话' };
  if (!runtime) return { tone: 'closed', text: '后台会话已关闭' };
  const state = runtime.state;
  if (state === 'running' || state === 'starting') {
    const quietFor = runtime.lastOutputAt > 0 ? now - runtime.lastOutputAt : 0;
    if (state === 'running' && quietFor >= STUCK_MS) return { tone: 'stuck', text: `可能卡住 · ${seconds(quietFor)}没有新输出`, short: seconds(quietFor) };
    return { tone: 'running', text: (state === 'starting' ? '启动中' : '运行中') + (runtime.meta ? ` · ${runtime.meta}` : '') };
  }
  // 只放状态短文本，不拼报错原文或等待说明（可能带路径、业务文字），原文在报错区和终端里看。
  if (state === 'waiting') return { tone: 'waiting', text: '等待操作' };
  if (state === 'failed' || state === 'interrupted') return { tone: 'error', text: state === 'failed' ? '报错' : '已中断' };
  if (state === 'dormant') return { tone: 'dormant', text: '休眠中 · 点开会唤醒' };
  if (state === 'idle' || state === 'completed') return { tone: 'idle', text: '空闲' };
  return { tone: 'unknown', text: '状态待确认（可能断连或状态过期）' };
}

function hint(status, label) {
  return `${label ? label + '的' : ''}后台会话：${status.text}\n点一下先自检，再进主页看它正在做什么`;
}

// 页面头部用的按钮。sessionId 为空也渲染（灰点），点了就地说明「当前没有后台会话」。
// needsSetup：入口已知「没有这个能力」（没装 CodeAgent 也没接 API）——按钮写「需配置」，点开说清要配什么，不和故障混在一起。
const SETUP = { tone: 'setup', text: '需要先配置 CodeAgent 或部门 API' };
function backstageButtonHtml({ sessionId = '', from = '', label = '后台', runtime, needsSetup = false } = {}) {
  let st = backstageStatus(sessionId, runtime === undefined ? currentRuntime(sessionId) : runtime);
  if (needsSetup && (st.tone === 'none' || st.tone === 'closed')) { st = SETUP; label = '需配置'; }
  const src = sources.get(from);
  return `<button type="button" class="hub-bs-btn" data-hub-backstage="${esc(sessionId)}" data-hub-backstage-from="${esc(from)}"${needsSetup ? ' data-hub-bs-setup="1"' : ''} data-tone="${st.tone}" title="${esc(hint(st, src?.label))}" aria-label="${esc(label + '：' + st.text)}">`
    + `<span class="hub-bs-dot" aria-hidden="true"></span>${ICON}<span class="hub-bs-label">${esc(label)}</span><span class="hub-bs-sec">${st.tone === 'stuck' ? esc(st.short) : ''}</span></button>`;
}

// 报错提示里用的文字链接：没有会话 id 时不出（报错旁边不该再出一个说「没有会话」的链接）。
function backstageLinkHtml({ sessionId = '', from = '', label = '查看后台' } = {}) {
  if (!sessionId) return '';
  return `<button type="button" class="hub-bs-link" data-hub-backstage="${esc(sessionId)}" data-hub-backstage-from="${esc(from)}">${ICON}${esc(label)}</button>`;
}

function registerBackstageSource(from, spec = {}) {
  if (from) sources.set(String(from), { ...sources.get(String(from)), ...spec });
}

let win = typeof window !== 'undefined' ? window : null;
let doc = typeof document !== 'undefined' ? document : null;
function currentRuntime(sessionId) {
  if (!sessionId || typeof win?.__hubSessionRuntime !== 'function') return null;
  try { return win.__hubSessionRuntime(sessionId); } catch { return null; }
}

function paintButton(button, now) {
  if (button.classList.contains('hub-bs-link')) return;
  const id = button.dataset.hubBackstage || '';
  let st = backstageStatus(id, currentRuntime(id), now);
  if (button.dataset.hubBsSetup === '1' && (st.tone === 'none' || st.tone === 'closed')) st = SETUP;
  if (button.dataset.tone !== st.tone) button.dataset.tone = st.tone;
  const label = button.querySelector('.hub-bs-label')?.textContent || '后台';
  const title = hint(st, sources.get(button.dataset.hubBackstageFrom || '')?.label);
  // 悬停卡（renderer/hub-tooltip.js）显示期间把 title 挪到 data-hub-tip，这时更新那里，别把 title 写回来叠出系统提示。
  const tipKey = button.hasAttribute('data-hub-tip') ? 'data-hub-tip' : 'title';
  if (button.getAttribute(tipKey) !== title) { button.setAttribute(tipKey, title); button.setAttribute('aria-label', `${label}：${st.text}`); }
  const sec = button.querySelector('.hub-bs-sec'), want = st.tone === 'stuck' ? st.short : '';
  if (sec && sec.textContent !== want) sec.textContent = want;
}

function refreshBackstageButtons(now = Date.now()) {
  if (!doc) return 0;
  let painted = 0;
  for (const button of doc.querySelectorAll('.hub-bs-btn[data-hub-backstage]')) {
    if (!button.isConnected || button.offsetParent === null) continue;   // 页面收起时不画
    paintButton(button, now); painted += 1;
  }
  return painted;
}

// ---------- 就地说明（找不到会话时） ----------
function closePop() { doc?.getElementById('hub-bs-pop')?.remove(); }
function showPop(anchor, { text, from, sessionId = '' }) {
  closePop();
  const src = sources.get(from);
  const pop = doc.createElement('div');
  pop.id = 'hub-bs-pop'; pop.className = 'hub-bs-pop'; pop.setAttribute('role', 'status');
  pop.innerHTML = `<p>${esc(text)}</p>${src?.recreate ? '<button type="button" class="hub-bs-pop-btn" data-hub-bs-recreate>重新打开</button>' : ''}<button type="button" class="hub-bs-pop-x" data-hub-bs-pop-close aria-label="关闭">×</button>`;
  (anchor?.closest?.('dialog[open]') || doc.body).append(pop);   // 模态对话框里点的：放进对话框，不然被挡在后面点不到
  const r = anchor?.isConnected ? anchor.getBoundingClientRect() : { bottom: 60, right: (win.innerWidth || 1440) / 2 + 140 }, w = pop.offsetWidth || 280, vw = win.innerWidth || 1440;
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, r.right - w)))}px`;
  pop.addEventListener('click', async event => {
    if (event.target.closest('[data-hub-bs-pop-close]')) { closePop(); return; }
    const again = event.target.closest('[data-hub-bs-recreate]');
    if (!again) return;
    again.disabled = true; again.textContent = '正在打开…';
    try {
      const id = await src.recreate(sessionId);
      if (!id) throw new Error('没拿到会话');
      closePop();
      await jump(anchor, id, from);
    } catch (error) {
      again.disabled = false; again.textContent = '重新打开';
      pop.querySelector('p').textContent = '没打开：' + (error?.message || error);
    }
  });
  setTimeout(() => { if (pop.isConnected && !pop.matches(':hover')) pop.remove(); }, 12000);
}

// ---------- 先诊断再跳转（renderer/backstage-diagnose.js） ----------
const LEVEL_ICON = { ok: '✓', info: 'i', warn: '!', error: '!' };
function tryRequire(name) { try { return require(name); } catch { return null; } }
async function pendingUpdateVersion() {
  const ipc = tryRequire('electron')?.ipcRenderer;
  if (!ipc?.invoke) return '';
  try {
    const st = await Promise.race([ipc.invoke('app-update:get-state'), new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    return st && !st.pinned && st.latest && !st.latest.rollback && st.phase === 'available' ? String(st.latest.version || '') : '';
  } catch { return ''; }
}
// 有没有保存过部门 API key（只要是否，不取 key 本身）。
async function gatewayKeySaved() {
  const ipc = tryRequire('electron')?.ipcRenderer;
  if (!ipc?.invoke) return false;
  try {
    const r = await Promise.race([ipc.invoke('api-gateway:get'), new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    return !!r?.gateway?.keySet;
  } catch { return false; }
}
function appVersion() { return tryRequire('../package.json')?.version || ''; }

async function diagnoseFor(sessionId, from) {
  const src = sources.get(from);
  const runtime = currentRuntime(sessionId);
  let entry = {};
  try { entry = (await src?.diagnose?.(sessionId)) || {}; } catch { entry = {}; }
  const [version, gatewayKey] = await Promise.all([pendingUpdateVersion(), gatewayKeySaved()]);
  const D = require('./backstage-diagnose');
  const result = D.diagnoseBackstage({ sessionId, runtime, entry, env: { update: version ? { version } : null, gatewayKey }, canRecreate: !!src?.recreate, stuckMs: STUCK_MS });
  const kind = (() => { try { return win.__hubSessionBasics?.(sessionId)?.kind || ''; } catch { return ''; } })();
  const text = D.diagnosticText({ version: appVersion(), label: src?.label || from, sessionId, kind, runtime, entry, result, stuckMs: STUCK_MS });
  try { D.recordDiagnosis(win.localStorage, { cause: result.cause, from }); } catch { /* 本机计数失败不影响 */ }
  // 匿名计数随社区心跳上报（2026-11-26 经确认开启）：只报「入口:原因」，主进程记当天次数，社区关了就不发。
  try { void tryRequire('electron')?.ipcRenderer?.invoke('community:diag-record', { from, cause: result.cause })?.catch?.(() => {}); } catch { /* 老版本没有这个接口 */ }
  return { result, text, src };
}

async function openPanel(anchor, sessionId, from) {
  const { result, text, src } = await diagnoseFor(sessionId, from);
  closePop();
  const pop = doc.createElement('div');
  pop.id = 'hub-bs-pop'; pop.className = 'hub-bs-pop hub-bs-panel'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '后台自检');
  pop.dataset.level = result.level; pop.dataset.cause = result.cause;
  if (sessionId) pop.dataset.sessionId = sessionId;   // 「重启后台会话」等 known:* 动作按它找会话（renderer/hub-error-card.js）
  const fixes = result.actions.filter(a => !a.needsSession || result.canEnter)
    .map(a => `<button type="button" class="hub-bs-fix" ${a.act.startsWith('hub-bs:') ? 'data-hub-bs-act' : 'data-hub-err-act'}="${esc(a.act)}">${esc(a.label)}</button>`).join('');
  const canRecreate = !!src?.recreate && (result.cause === 'not-started' || result.cause === 'session-gone');
  const assist = win.HubErrorCard?.assistHtml ? win.HubErrorCard.assistHtml({ area: 'backstage', title: `${src?.label || ''}后台自检：${result.title}`, symptom: result.text, details: text }) : '';
  pop.innerHTML = `<header class="hub-bs-panel-head"><span class="hub-bs-level" aria-hidden="true">${LEVEL_ICON[result.level] || 'i'}</span><strong>${esc(result.title)}</strong>${result.capability ? '<em class="hub-bs-chip">需要配置，不是故障</em>' : ''}</header>`
    + `<p class="hub-bs-why">${esc(result.text)}</p>`
    + (result.todo ? `<p class="hub-bs-todo"><b>你可以这样做：</b>${esc(result.todo)}</p>` : '')
    + (fixes ? `<div class="hub-bs-fixes">${fixes}</div>` : '')
    + `<div class="hub-bs-panel-foot">${result.canEnter ? '<button type="button" class="hub-bs-pop-btn" data-hub-bs-enter>进入后台 →</button>' : ''}${canRecreate ? '<button type="button" class="hub-bs-pop-btn" data-hub-bs-recreate>重新打开</button>' : ''}<button type="button" class="hub-bs-ghost" data-hub-bs-copy title="版本、入口、后台状态、最近错误摘要、CodeAgent/API 是否可用；已脱敏，不含对话内容">复制诊断信息</button>${assist}</div>`
    + '<button type="button" class="hub-bs-pop-x" data-hub-bs-pop-close aria-label="关闭">×</button>';
  (anchor?.closest?.('dialog[open]') || doc.body).append(pop);
  place(pop, anchor);
  pop.addEventListener('click', async event => {
    if (event.target.closest('[data-hub-bs-pop-close]')) { closePop(); return; }
    if (event.target.closest('[data-hub-bs-enter]')) { closePop(); await jump(anchor, sessionId, from); return; }
    // 「改用部门 key」：打开「日常功能用哪个 Agent」设置，定位到这个功能（renderer/feature-agent-settings.js）。
    const local = event.target.closest('[data-hub-bs-act]');
    if (local?.dataset.hubBsAct === 'hub-bs:gateway-settings') { closePop(); void win.__companyApiOpen?.('claude'); return; }
    if (local?.dataset.hubBsAct === 'hub-bs:use-gateway') {
      closePop();
      if (typeof win.__featureAgents?.open === 'function') void win.__featureAgents.open([from === 'avatar' ? 'avatar' : 'assistant'], anchor);
      else if (typeof win.__companyApiOpen === 'function') void win.__companyApiOpen('claude');
      return;
    }
    const copy = event.target.closest('[data-hub-bs-copy]');
    if (copy) {
      let ok = false;
      try { tryRequire('electron').clipboard.writeText(text); ok = true; } catch { try { await win.navigator.clipboard.writeText(text); ok = true; } catch { ok = false; } }
      copy.textContent = ok ? '已复制，可直接发给维护人' : '复制没成功';
      setTimeout(() => { if (copy.isConnected) copy.textContent = '复制诊断信息'; }, 2500);
      return;
    }
    const again = event.target.closest('[data-hub-bs-recreate]');
    if (!again) return;
    again.disabled = true; again.textContent = '正在打开…';
    try {
      const id = await src.recreate(sessionId);
      if (!id) throw new Error('没拿到会话');
      closePop();
      await jump(anchor, id, from);
    } catch (error) {
      again.disabled = false; again.textContent = '重新打开';
      pop.querySelector('.hub-bs-why').textContent = '没打开：' + (error?.message || error);
    }
  });
  return { result, text };
}

function place(pop, anchor) {
  const vw = win.innerWidth || 1440, vh = win.innerHeight || 900, w = pop.offsetWidth || 340, h = pop.offsetHeight || 200;
  const r = anchor?.isConnected ? anchor.getBoundingClientRect() : { top: 52, bottom: 60, right: vw / 2 + w / 2 };
  const below = r.bottom + 6 + h <= vh - 8;
  pop.style.top = `${Math.round(below ? r.bottom + 6 : Math.max(8, r.top - h - 6))}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(vw - w - 8, r.right - w)))}px`;
}

// ---------- 返回条 ----------
let returnState = null;   // { from, sessionId, at }
function closeReturn() { returnState = null; doc?.getElementById('hub-bs-return')?.remove(); }
function showReturn(from, sessionId) {
  closeReturn();
  const src = sources.get(from);
  if (!src?.reopen) return;
  returnState = { from, sessionId, at: Date.now() };
  const bar = doc.createElement('div');
  bar.id = 'hub-bs-return'; bar.className = 'hub-bs-return'; bar.setAttribute('role', 'navigation');
  bar.innerHTML = `<button type="button" class="hub-bs-return-go" data-hub-bs-back><span aria-hidden="true">←</span>返回${esc(src.label || '')}</button><span class="hub-bs-return-note">正在看${esc(src.label || '')}的后台会话</span><button type="button" class="hub-bs-pop-x" data-hub-bs-return-close aria-label="关闭返回条">×</button>`;
  bar.addEventListener('click', async event => {
    if (event.target.closest('[data-hub-bs-return-close]')) { closeReturn(); return; }
    if (!event.target.closest('[data-hub-bs-back]')) return;
    closeReturn();
    try { await src.reopen(); } catch (error) { win.console?.warn?.('[backstage-jump] 返回失败', error); }
  });
  doc.body.append(bar);
}
// 用户自己切去别的会话或打开了别的页面：返回条就没意义了，收掉。
function syncReturn() {
  if (!returnState) return;
  const active = typeof win.__hubActiveSessionId === 'function' ? win.__hubActiveSessionId() : returnState.sessionId;
  const pageOpen = typeof win.__hubPageOpen === 'function' ? win.__hubPageOpen() : false;
  if (active !== returnState.sessionId || pageOpen || Date.now() - returnState.at > 30 * 60 * 1000) closeReturn();
}

async function jump(anchor, sessionId, from) {
  const src = sources.get(from);
  if (!sessionId) { showPop(anchor, { from, text: src?.emptyText || '当前没有后台会话：这个功能在处理请求时才会起会话。' }); return { ok: false, reason: 'none' }; }
  let r = null;
  try { r = typeof win.__hubOpenBackstage === 'function' ? await win.__hubOpenBackstage(sessionId) : null; }
  catch (error) { r = { ok: false, error: error?.message || String(error) }; }
  if (!r?.ok) {
    showPop(anchor, { from, sessionId, text: r?.error ? `没切过去：${r.error}` : src?.closedText || '后台会话已关闭或已被新会话替换，找不到了。' });
    return { ok: false, reason: 'closed' };
  }
  closePop();
  try { src?.leave?.(); } catch { /* 原入口已经收起 */ }   // 不走 __xxxHide 约定的浮层（如记忆面板）自己收起
  showReturn(from, sessionId);
  return { ok: true };
}

let installed = false, timer = null;
function installBackstageJump({ document: d = doc, window: w = win } = {}) {
  doc = d; win = w;
  if (installed || !doc || !win) return;
  installed = true;
  // 捕获阶段处理：各页面自己的点击委托（closest('[data-xx]')）不会再收到这次点击。
  doc.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-hub-backstage]');
    if (!button) { if (!event.target?.closest?.('#hub-bs-pop')) closePop(); return; }
    event.preventDefault(); event.stopPropagation();
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    // 先诊断：弹出自检结论（原因 + 你可以这样做 + 一键修复），里面再点「进入后台」。
    void openPanel(button, button.dataset.hubBackstage || '', button.dataset.hubBackstageFrom || '').catch(error => {
      showPop(button, { from: button.dataset.hubBackstageFrom || '', text: '自检没做完：' + (error?.message || error) });
    }).finally(() => { delete button.dataset.busy; });
  }, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') closePop(); });
  timer = win.setInterval(() => {
    if (doc.hidden) return;
    refreshBackstageButtons();
    syncReturn();
  }, TICK_MS);
}

module.exports = {
  STUCK_MS,
  backstageStatus,
  backstageButtonHtml,
  backstageLinkHtml,
  registerBackstageSource,
  refreshBackstageButtons,
  installBackstageJump,
  // 页面自己的「看后台」按钮（如会议引擎异常条）也先自检；要直接跳用 jumpDirect。
  jumpToBackstage: (anchor, sessionId, from) => openPanel(anchor, sessionId, from),
  jumpDirect: (anchor, sessionId, from) => jump(anchor, sessionId, from),
  diagnoseFor,
  _reset() { installed = false; if (timer && win) win.clearInterval(timer); timer = null; sources.clear(); returnState = null; },
};
