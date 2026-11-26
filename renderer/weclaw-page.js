'use strict';
// 「员工助手」页（Beta，2026-11-26 第二版「四步清单」）：最新版 → 打开并登录 → 接入 HUB-H → 试一次，四步全绿就能用。
// 右边画「接入后员工助手的模型下拉」（实时读员工助手的模型清单），以及跳转到员工助手的按钮。
// 页面只经 weclaw:* 接口读状态和发操作，配置写入、升级、试一次都在主进程（main/weclaw-link-service.js）。

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secs = ms => (ms / 1000).toFixed(ms < 10000 ? 1 : 0);

/** 接入这一项的灯色和一句话（纯函数，单测用）。 */
function describe(s) {
  const app = !s.installed && !s.running ? ['r', '没找到员工助手', '这台电脑上没装员工助手']
    : s.running ? ['g', '已打开', '员工助手正在运行'] : ['w', '没打开', '打开员工助手后会自动接入'];
  const notReady = s.proxy?.state === 'not-ready';
  const proxy = s.proxy?.state === 'running' ? ['g', '运行中', `本机端口 ${s.proxy.port}`]
    : notReady ? ['w', '上游未就绪', s.proxy?.message || '请检查 CodeAgent 账号是否已登录']
    : s.enabled ? ['w', '启动中', s.proxy?.message || '稍等几秒'] : ['', '未启动', '接入时自动启动'];
  let linked;
  if (!s.enabled && s.pendingRemove) linked = ['w', '待移除', s.running ? '员工助手里的 HUB-H 模型 1 分钟内自动移除' : '员工助手打开后自动移除 HUB-H 模型'];
  else if (!s.enabled) linked = s.linked?.present ? ['w', '有旧配置', '员工助手里还留着一条 HUB-H 配置，点「清掉旧配置」可移除'] : ['', '未接入', '点右边的按钮一键接入'];
  else if (!s.running) linked = ['w', '等员工助手打开', '打开后 1 分钟内自动接入'];
  else if (!s.linked?.present) linked = ['w', '接入中', '1 分钟内自动完成'];
  else if (s.stale) linked = ['w', '更新中', '员工助手里的配置和 HUB-H 当前的对不上，1 分钟内自动更新'];
  else if (notReady) linked = ['w', '已接入，暂不可用', '上游未就绪，员工助手里选 HUB-H 模型会报错，先用体验模型'];
  else linked = ['g', '已接入', `${s.linked.models.length} 个模型，${s.linked.pinned ? '只用你本人的账号' : '允许用号池'}`];
  return { app, proxy, linked };
}

/** 四步各自的状态：done 完成 / todo 待做 / busy 进行中 / bad 做不了；action 是旁边那个按钮。 */
function steps(s) {
  const v = s.version || {};
  const out = [];
  // 1 最新版
  if (!s.installed && !s.running) out.push({ state: 'bad', title: '装好员工助手', detail: '这台电脑上没找到员工助手，请先从公司软件中心安装' });
  else if (s.upgrading) out.push({ state: 'busy', title: '员工助手是最新版', detail: `正在升级到 ${v.latest || '新版'}，约 1 分钟，员工助手会先关掉、装完自动重开` });
  else if (v.upgradeAvailable) out.push({ state: 'todo', title: '员工助手是最新版', detail: `当前 ${v.installed}；新版 ${v.latest} 已下载好，升级约 1 分钟，期间员工助手会重启`
      + (s.lastUpgrade && !s.lastUpgrade.ok ? `（上次没成功：${s.lastUpgrade.error}）` : ''), action: { op: 'upgrade', label: s.lastUpgrade && !s.lastUpgrade.ok ? '重试升级' : '一键升级', primary: true } });
  else out.push({ state: 'done', title: '员工助手已装好', detail: (v.installed ? `当前 ${v.installed}，没有待安装的新版（员工助手会自己下载新版，下载好后这里提示升级）` : '已安装（读不到版本号）')
      + (s.lastUpgrade?.ok ? '；刚升级完成' : '') + (s.lastUpgrade?.relaunchError ? `；${s.lastUpgrade.relaunchError}` : '') });
  // 2 打开并登录
  if (!s.running) out.push({ state: s.installed ? 'todo' : 'bad', title: '已打开并登录', detail: '员工助手没打开', action: s.installed ? { op: 'open', label: '打开员工助手', primary: true } : null });
  else if (s.online?.loggedIn && !s.online?.healthy) out.push({ state: 'todo', title: '已打开并登录', detail: '员工助手的本机服务没有正常响应，试试重新打开员工助手', action: { op: 'open', label: '打开员工助手', primary: true } });
  else if (!s.online?.loggedIn) out.push({ state: 'todo', title: '已打开并登录', detail: '员工助手已打开，但还没登录（刚打开的话等几秒）', action: { op: 'open', label: '去登录', primary: true } });
  else out.push({ state: 'done', title: '已打开并登录', detail: '在线 · 已登录 · 引擎正常', action: { op: 'open', label: '打开员工助手' } });
  // 3 接入
  const [tone, word, hint] = describe(s).linked;
  if (tone === 'g') out.push({ state: 'done', title: '已接入 HUB-H', detail: hint, action: { op: 'disconnect', label: '断开', danger: true } });
  else if (!s.enabled) out.push({ state: 'todo', title: '接入 HUB-H', detail: s.pendingRemove ? hint : '把 HUB-H 的公司模型加进员工助手的模型下拉，不改员工助手的程序',
    action: s.pendingRemove ? null : { op: 'connect', label: '一键接入', primary: true }, extra: !s.pendingRemove && s.linked?.present ? { op: 'disconnect', label: '清掉旧配置' } : null });
  else out.push({ state: 'busy', title: '接入 HUB-H', detail: `${word}：${hint}`, action: { op: 'disconnect', label: '断开', danger: true } });
  // 4 试一次
  const t = s.lastTest;
  if (s.testing) out.push({ state: 'busy', title: '试一次', detail: '正在经 HUB-H 发一句话…' });
  else if (!s.enabled) out.push({ state: 'todo', title: '试一次', detail: '接入后，经员工助手同一条路发一句话，看 HUB-H 回得多快', action: { op: 'test', label: '测一下', disabled: true } });
  else if (t?.ok && (tone !== 'g' || s.proxy?.state !== 'running' || t.port !== s.proxy?.port)) out.push({ state: 'todo', title: '试一次', detail: '接入状态变过，之前的测试结果不算数了，再测一次', action: { op: 'test', label: '再测一次', primary: true } });
  else if (t?.ok) out.push({ state: 'done', title: '试一次', detail: `${t.label} 首字 ${secs(t.firstTokenMs)} 秒，共 ${secs(t.totalMs)} 秒${t.reply ? `，回复「${t.reply}」` : ''}`, action: { op: 'test', label: '再测一次' } });
  else if (t) out.push({ state: 'todo', title: '试一次', detail: `没成功：${t.error || '没有收到回复'}`, action: { op: 'test', label: '重试', primary: true } });
  else out.push({ state: 'todo', title: '试一次', detail: '经员工助手同一条路发一句话，看 HUB-H 回得多快（不会进员工助手的历史记录）', action: { op: 'test', label: '测一下', primary: true } });
  return out;
}

function createWeclawPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage = () => {} }) {
  let page = null, root = null, data = null, busy = '', error = '', actionError = '', timer = null;
  const isOpen = () => !!page && !page.hidden;
  const call = (op, payload) => ipcRenderer.invoke('weclaw:' + op, payload);

  async function load() {
    try {
      const r = await call('status');
      if (r?.ok === false) throw new Error(r.error || '读不到状态');
      data = r; if (!busy) error = actionError || (r?.lastError && r.enabled ? r.lastError : '');
    } catch (e) { error = e.message; }
    render();
  }
  const DONE = {
    connect: r => (r.applied ? '已接入：在员工助手的模型下拉里选「HUB-H · …」' : '已记下：打开员工助手后自动接入'),
    disconnect: r => (r.removed ? '已断开：员工助手里的 HUB-H 模型已移除' : '已断开：员工助手打开后自动移除 HUB-H 模型'),
    'set-pool': (r, p) => (p.allowPool ? '已允许用号池' : '已改为只用你本人的账号'),
    open: () => '已打开员工助手', 'new-chat': () => '已在员工助手里新建对话',
    upgrade: r => (r.started ? `开始升级到 ${r.version}，约 1 分钟` : '升级已经在进行'),
    test: r => (r.ok ? `首字 ${secs(r.firstTokenMs)} 秒` : `没成功：${r.error || ''}`),
  };
  async function run(op, payload = {}) {
    if (busy) return;
    busy = op; error = ''; actionError = ''; render();
    try {
      const r = await call(op, payload);
      if (!r || r.ok === false) throw new Error(r?.error || '没有成功');
      showMessage(DONE[op]?.(r, payload) || '已完成');
    } catch (e) { actionError = e.message; } finally { busy = ''; await load(); }
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'weclaw-page'; page.className = 'weclaw-page'; page.hidden = true; page.setAttribute('aria-label', '员工助手');
    page.innerHTML = '<div class="wcx-root"></div>'; root = page.firstChild; document.body.append(page);
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-wc]'); if (!b || b.disabled) return;
      if (b.dataset.wc === 'refresh') { actionError = ''; void load(); } else void run(b.dataset.wc);
    });
    page.addEventListener('change', event => {
      const box = event.target.closest('[data-wc-pool]'); if (box) void run('set-pool', { allowPool: box.checked });
    });
    window.addEventListener('resize', place);
    if (window.MutationObserver) new window.MutationObserver(() => {
      if (isOpen() && [...document.body.classList].some(c => c !== 'weclaw-page-open' && /-page-open$/.test(c))) close();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  function place() {
    if (!isOpen()) return;
    const rail = document.getElementById('scene-rail'), toolbar = document.getElementById('app-toolbar');
    const left = rail && rail.getBoundingClientRect().width > 0 ? rail.getBoundingClientRect().right : 0;
    const top = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const bodyRect = document.getElementById('app-body')?.getBoundingClientRect();
    const bottom = bodyRect?.height > 0 ? Math.max(0, window.innerHeight - bodyRect.bottom) : 0;
    Object.assign(page.style, { left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`, bottom: `${bottom}px` });
  }

  const button = (a, cls = '') => a ? `<button type="button" class="wcx-btn ${a.primary ? 'p' : ''} ${a.danger ? 'd' : ''} ${cls}" data-wc="${esc(a.op)}"${busy || a.disabled ? ' disabled' : ''}>${busy === a.op ? '请稍候…' : esc(a.label)}</button>` : '';
  function stepHtml(st, i, current) {
    const mark = st.state === 'done' ? '✓' : st.state === 'bad' ? '!' : st.state === 'busy' ? '…' : String(i + 1);
    const tone = st.state === 'done' ? 'g' : st.state === 'bad' ? 'r' : st.state === 'busy' ? 'w' : i === current ? 'b' : '';
    return `<div class="wcx-step ${tone}" data-step="${i + 1}" data-state="${st.state}"><span class="wcx-n ${tone}">${mark}</span><div class="wcx-st"><b>${esc(st.title)}</b><span>${esc(st.detail)}</span></div>`
      + `<div class="wcx-sa">${button(st.extra)}${button(st.action)}</div></div>`;
  }
  function preview() {
    const p = data.preview || { mine: [], others: [] };
    const pending = !p.mine.length;
    const mine = pending ? (data.models || []).map(m => `HUB-H · ${m.label}`) : p.mine;
    const group = (name, items, cls) => `<div class="wcx-g">${esc(name)}</div>` + items.map((m, i) => `<div class="wcx-i ${cls || ''}${!cls && i === 0 ? ' on' : ''}">${esc(m)}</div>`).join('');
    return `<div class="wcx-dd">${group(pending ? 'AI HUB-H（接入后出现）' : 'AI HUB-H（CodeAgent 公司模型）', mine, pending ? 'off' : '')}`
      + (p.others || []).map(o => group(o.name, o.models, 'x')).join('') + '</div>';
  }
  function render() {
    if (!root) return;
    const list = data ? steps(data) : [];
    const doneCount = list.filter(s => s.state === 'done').length;
    const current = list.findIndex(s => s.state !== 'done');
    const head = `<header class="wcx-head"><h1>员工助手<span class="wcx-beta">Beta</span></h1><p>让员工助手用 HUB-H 的公司模型，四步全绿就能用</p>`
      + (data ? `<span class="wcx-ch ${doneCount === 4 ? 'g' : 'b'}">${doneCount} / 4 完成</span>` : '')
      + `<button type="button" class="wcx-btn s" data-wc="refresh"${busy ? ' disabled' : ''}>刷新</button></header>`;
    if (!data) { root.innerHTML = head + '<div class="wcx-body"><p class="wcx-note">正在检查…</p></div>'; return; }
    const err = error ? `<div class="wcx-err">${esc(error)}</div>` : '';
    root.innerHTML = head + `<div class="wcx-body"><section class="wcx-steps">${list.map((s, i) => stepHtml(s, i, current)).join('')}${err}</section>
      <section class="wcx-card"><h2>接入后在员工助手里</h2>${preview()}
        <div class="wcx-actions">${button({ op: 'new-chat', label: '在员工助手里新建对话', disabled: !data.installed })}
        <label class="wcx-pool" title="默认只用你本人的 CodeAgent 账号；勾上后，本人额度不够时可用号池里的账号"><input type="checkbox" data-wc-pool${data.allowPool ? ' checked' : ''}${busy ? ' disabled' : ''}> 本人额度不够时允许用号池</label></div>
        <p class="wcx-note">在员工助手的模型下拉里选「HUB-H · …」就用上了；想用回原来的，选回「体验模型」，不用重启。数据只在本机和公司 CodeAgent 之间流动。</p></section></div>`;
  }

  function open() {
    build(); closeOtherPanels(); page.hidden = false; document.body.classList.add('weclaw-page-open');
    window.setShellNavActive?.('weclaw'); place(); render(); void load();
    clearInterval(timer); timer = setInterval(() => { if (isOpen() && !busy) void load(); }, 10000); timer.unref?.();
  }
  function close() { clearInterval(timer); timer = null; if (!page || page.hidden) return; page.hidden = true; document.body.classList.remove('weclaw-page-open'); }
  ipcRenderer.on?.('weclaw:changed', () => { if (isOpen() && !busy) void load(); });
  return { open, close, isOpen };
}

module.exports = { createWeclawPage, describe, steps };
