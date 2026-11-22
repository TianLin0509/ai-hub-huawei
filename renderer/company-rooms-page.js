'use strict';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGES = [['overview', '总览'], ['plan', '抢订计划'], ['post', '会后动作'], ['history', '历史'], ['logs', '运行日志'], ['settings', '设置']];
// 抢订计划的一句话说明（2026-11-17 同事反馈「看不出什么时候抢什么会议室」）：把放号时刻、提前天数、会议日、时段和房间顺序连成一句。
function planSummary({ days = [], span = '', rooms = [], advanceDays = 7, openTime = '', switchNext = true } = {}) {
  const W = ['一', '二', '三', '四', '五', '六', '日'];
  const picked = W.filter((_, i) => days.includes(i + 1)).map(d => '周' + d);
  const open = String(openTime || '').slice(0, 5) || '放号时刻';
  if (!picked.length || !span || !rooms.length) {
    const miss = [!picked.length && '勾选会议在周几', !span && '填开始时间和时长', !rooms.length && '添加至少一间会议室'].filter(Boolean);
    return `还差：${miss.join('、')}。填好后，Hub 会在每天 ${open} 放号时，替你预订 ${advanceDays} 天后那天的会议室。`;
  }
  const order = rooms.length > 3 ? `${rooms.slice(0, 3).join(' → ')} 等 ${rooms.length} 间` : rooms.join(' → ');
  const sorted = [...new Set(days)].sort((a, b) => a - b).join(',');
  const which = sorted === '1,2,3,4,5,6,7' ? '' : sorted === '1,2,3,4,5' ? '周一至周五' : picked.join('、');
  const when = which ? `如果 ${advanceDays} 天后那天是${which}，就替你预订那天` : `替你预订 ${advanceDays} 天后那天`;
  return `按现在的设置：每天 ${open} 放号时，${when} ${span} 的会议室，按 ${order} 的顺序${rooms.length > 1 ? (switchNext ? '，前一间被抢走就换下一间' : '，只抢第一间') : ''}。`;
}

function roomReadiness(rules = {}, status = {}) {
  const rooms = rules.优先会议室 || [];
  const plan = rooms.length > 0 && rooms.length <= 30 && rooms.every(r => typeof r === 'string' && r.trim() && r.trim().length <= 120);
  const login = status.loginState === true && !status.loginNeeded;
  // The helper resets its in-memory login check on restart and checks again before booking.
  // An unknown check must not force returning users to reopen the login browser.
  const loginFailed = status.loginState === false || !!status.loginNeeded;
  return { plan, login, missing: Number(!plan) + Number(!login), ready: plan && !loginFailed };
}
// Page subtitles follow the frozen CDCCBCC design; the data shown below stays the real helper state.
const SUBTITLES = { overview: '秘书终结者，每天自动抢订', plan: '定好抢什么，按优先顺序自动尝试', post: '散会后做什么', history: '历史记录', logs: '运行日志', settings: '设置' };
const DEFAULTS = { 主题: '日常会议', 开始时间: '14:00', 时长小时: 2, 时长分钟: 0, 优先会议室: [], 抢订日: [1, 2, 3, 4, 5, 6, 7],
  抢订设置: { 开放时间: '12:00:00', 提前填表秒数: 60, 最大重试次数: 5, 重试间隔毫秒: 200, 抢不到换下一间: true, 登录预检提前分钟: 15, 校准服务器时间: true },
  会后动作: { 模式: '不动作', 小鲁班ID: '', 提醒提前分钟: 5 }, 系统: { 守护时阻止睡眠: true },
  高级: { 网址: '', 浏览器: '自动', 自动标定网格: true, 网格起点X: 472, 格子宽度: 30, 网格起始时间: '08:30', 'welink-cli路径': '' },
  // 会议室所在地域（2026-11-22）：对应预订弹窗的三级下拉；都空＝沿用网页上次的选择，与原来一致。
  地域: { '国家/地区': '', 城市: '', 楼宇: '' } };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
// Stroke icons from the CDCCBCC design set (24×24, currentColor).
const ICONS = {
  tick: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  bolt: '<path d="M13 2L5 13.5h6L10 22l8-11.5h-6z" fill="currentColor"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
  acct: '<circle cx="8" cy="12" r="4.2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 12h9M17.5 12v3.5M20.5 12v2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor"/>',
  play: '<path d="M8 5.5v13a1 1 0 001.5.86l10.4-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" fill="currentColor"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>',
  arrowU: '<path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  arrowD: '<path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  send: '<path d="M4 12l16-8-6 17-3-7z" fill="currentColor"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" fill="currentColor"/><path d="M10 20.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  folder: '<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" fill="none"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v4.2h-4.2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (name, size = 16) => `<svg class="cr-ic" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
const copy = v => JSON.parse(JSON.stringify(v));
const pad2 = n => String(n).padStart(2, '0');
// 'YYYY-MM-DD[ HH:MM:SS]' -> 'MM-DD' (the run day shown in 最近 5 次).
const monthDay = iso => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[1]}-${m[2]}` : ''; };
// 'YYYY-MM-DD' -> 'MM-DD 周X' (calendar date, no timezone shift).
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `${m[2]}-${m[3]} 周${WEEK[day]}`;
}
function resultTone(status) { return status === '成功' ? 'green' : status === '失败' ? 'red' : ''; }
function createCompanyRoomsPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let host, gate = null, footer, state = {}, draft = copy(DEFAULTS), tab = 'overview', dirty = false, busy = false, polling = false, timer, clockTimer, generation = 0, loaded = false, logCleared = '', logsShown = null;
  const changed = new Set();
  let draggedRoom = null;
  // 抢订节奏（提前天数 + 开放时刻）由 Hub 按园区推断并保存；schedChanged 表示设置页改过、保存时一起存。
  let schedDraft = { advanceDays: 7 }, schedChanged = false, pendingOp = '';
  const sched = () => state.schedule || { advanceDays: 7, openTime: draft.抢订设置.开放时间 || '12:00:00', source: 'default', text: '' };
  // 现有组件只抢 7 天后；规则不是 7 天且组件不支持时，按 Hub 算出的开抢时刻和目标日期显示，不拿组件的 7 天结果误导。
  const schedBlocked = () => sched().advanceDays !== 7 && !sched().advanceDaysSupported;
  const componentAgrees = () => !schedBlocked() && (!sched().componentOpenTime || sched().componentOpenTime === sched().openTime);
  const effOpen = () => componentAgrees() && state.nextOpen ? state.nextOpen : sched().hubNextOpen;
  const effTarget = () => componentAgrees() && state.targetDate ? state.targetDate : sched().hubTargetDate;
  const hm = t => String(t || '').slice(0, 5);
  const sourceLabel = () => sched().source === 'manual' ? '你设置的' : sched().source === 'campus' ? `按${sched().campus}园区规则` : '默认规则';
  const call = async (name, args) => {
    const result = await ipcRenderer.invoke('company-assistant:' + name, args);
    if (result?.ok === false) throw Error(result.error || '会议室操作未完成');
    return result;
  };
  // kind: pri | sec | ghost | danger; extra: size class or attributes.
  const button = (op, title, kind = 'sec', extra = '') => `<button type="button" class="cr-btn cr-btn-${kind}${extra.startsWith(' ') ? '' : ' ' + extra}" data-cr-op="${op}"${extra.startsWith(' ') ? extra : ''}>${title}</button>`;
  const nav = document.createElement('button');
  nav.id = 'btn-company-rooms'; nav.type = 'button'; nav.className = 'btn-shell-nav'; nav.title = '会议室 · 自动抢订与计划'; nav.setAttribute('aria-label', '会议室');
  nav.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 21V3h13v18M2 21h20M17 7h3v14M8 7h5M8 11h5M8 15h5"/></svg></span><span class="btn-label">会议室</span>';
  (document.getElementById('btn-company-meeting') || document.getElementById('btn-company-assistant') || document.getElementById('btn-home'))?.after(nav);
  const slot = name => host.querySelector(`[data-cr-slot="${name}"]`);
  const value = key => key.split('.').reduce((v, k) => v?.[k], draft);
  function setValue(key, v) { const bits = key.split('.'), last = bits.pop(); bits.reduce((o, k) => o[k], draft)[last] = v; dirty = true; changed.add(key.split('.')[0]); }
  const input = (key, label, type = 'text', attrs = '') => `<input class="cr-input" data-cr-field="${key}" type="${type}" value="${escape(value(key))}" aria-label="${escape(label)}" ${attrs}>`;
  function field(key, title, type = 'text', attrs = '') {
    return `<label class="cr-field"><span>${title}</span><input class="cr-input" data-cr-field="${key}" type="${type}" value="${escape(value(key))}" ${attrs}></label>`;
  }
  const choice = (key, label, options) => `<span class="cr-select"><select class="cr-input" data-cr-field="${key}" aria-label="${escape(label)}">${options.map(v => `<option value="${escape(v)}"${String(value(key)) === String(v) ? ' selected' : ''}>${escape(v)}</option>`).join('')}</select></span>`;
  const select = (key, title, options) => `<label class="cr-field"><span>${title}</span>${choice(key, title, options)}</label>`;
  const check = (key, title) => `<label class="cr-check"><input data-cr-field="${key}" type="checkbox"${value(key) ? ' checked' : ''}>${title}</label>`;
  const toggle = (key, label) => `<label class="cr-switch" title="${escape(label)}"><input data-cr-field="${key}" type="checkbox" aria-label="${escape(label)}"${value(key) ? ' checked' : ''}><i></i></label>`;
  const head = (title, extra = '') => `<div class="cr-h"><h3>${title}</h3>${extra}</div>`;
  const setRow = (title, desc, control, wide = false) => `<div class="cr-set"><div class="cr-grow"><b>${title}</b>${desc ? `<p>${desc}</p>` : ''}</div><div class="cr-set-ctl${wide ? ' wide' : ''}">${control}</div></div>`;
  function build() {
    if (host) return;
    host = document.createElement('section'); host.id = 'company-rooms-page'; host.className = 'company-rooms-page'; host.hidden = true; host.setAttribute('aria-label', '会议室');
    host.innerHTML = `<header class="cr-top"><h1>会议室</h1><span class="cr-sub" data-cr-slot="subtitle"></span><div class="cr-top-right"><nav class="cr-seg" aria-label="会议室导航">${PAGES.map(([id, title]) => `<button type="button" data-cr-tab="${id}">${title}${id === 'post' ? '<em class="cr-seg-n cr-num" data-cr-slot="pending-count" hidden></em>' : ''}</button>`).join('')}</nav><span class="cr-pill" data-cr-pill="off"><i class="cr-dot"></i><span data-cr-slot="side-status">正在检查</span><span class="cr-pill-ver">组件 <span data-cr-slot="version">—</span></span></span><button type="button" class="cr-icon-btn" data-cr-op="refresh" title="刷新" aria-label="刷新">${icon('refresh', 16)}</button></div></header>
      <div class="cr-sheet"><div class="cr-col"><div class="cr-banner" data-cr-slot="connection" role="status" hidden></div><div class="cr-message" data-cr-slot="message" role="status" aria-live="polite"></div>
      <div class="cr-content" data-cr-slot="content"></div><footer class="cr-footer">${button('save', '保存设置', 'pri')}<span class="cr-save-state" data-cr-slot="save-state">设置保存在这台电脑</span></footer></div><aside class="cr-side" data-cr-slot="side" hidden></aside></div>`;
    footer = host.querySelector('.cr-footer');
    document.body.append(host);
    // 可选功能「会议室」（默认开，2026-11-19 反馈 1b517a0b）：关着时盖一层说明和「开启」，不读状态、不拉起组件。
    gate = require('./optional-feature-gate').createFeatureGate({ document, window, id: 'rooms', page: host, showMessage,
      badgeSlot: b => host.querySelector('[data-cr-op="refresh"]')?.before(b), onEnabled: () => {} });
    // 停在本页时被关掉：立刻停掉页面自己的轮询和时钟。
    // 从关到开（页面上点「开启」或在设置里打开）：停在本页就恢复轮询；只认这一跳，免得和打开页面时的启动重复。
    let roomsOn = null;
    window.addEventListener('hub-optional-features', () => {
      const on = !gate || gate.isOn();
      if (!on) { clearInterval(timer); clearInterval(clockTimer); timer = null; clockTimer = null; }
      else if (roomsOn === false && host && !host.hidden) void startLive();
      roomsOn = on;
    });
    host.addEventListener('input', event => {
      const e = event.target;
      if (e.matches('[data-cr-sched-field]')) { schedDraft.advanceDays = Number(e.value); dirty = true; schedChanged = true; }
      if (e.dataset.crField === '抢订设置.开放时间') schedChanged = true;
      if (e.matches('[data-cr-field]')) { setValue(e.dataset.crField, e.type === 'checkbox' ? e.checked : e.type === 'number' || ['时长分钟'].includes(e.dataset.crField) ? Number(e.value) : e.value); }
      if (e.matches('[data-cr-day]')) { draft.抢订日 = [...host.querySelectorAll('[data-cr-day]:checked')].map(x => Number(x.dataset.crDay)); dirty = true; changed.add('抢订日'); }
      if (e.matches('[data-cr-room-name]')) { draft.优先会议室[Number(e.dataset.crRoomName)] = e.value; dirty = true; changed.add('优先会议室'); }
      if (tab === 'plan') updatePlanSide();
      updateControls();
    });
    host.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.crTab) { tab = b.dataset.crTab; render(); return; }
      if (b.dataset.crOp) void act(b.dataset.crOp, b);
    });
    host.addEventListener('dragstart', event => {
      const row = event.target.closest('[data-cr-room-row]');
      if (!row || busy || state.running || !state.connected || state.controlBusy) { event.preventDefault(); return; }
      draggedRoom = Number(row.dataset.crRoomRow); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(draggedRoom));
    });
    host.addEventListener('dragover', event => { if (draggedRoom !== null && event.target.closest('[data-cr-room-row]')) event.preventDefault(); });
    host.addEventListener('drop', event => {
      const row = event.target.closest('[data-cr-room-row]');
      if (draggedRoom === null || !row || busy || state.running || state.controlBusy) return;
      event.preventDefault(); const target = Number(row.dataset.crRoomRow);
      const [room] = draft.优先会议室.splice(draggedRoom, 1); draft.优先会议室.splice(target, 0, room);
      draggedRoom = null; dirty = true; changed.add('优先会议室'); render();
    });
    host.addEventListener('dragend', () => { draggedRoom = null; });
  }
  function span() {
    const [h, m] = String(draft.开始时间 || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
    const end = h * 60 + m + Number(draft.时长小时) * 60 + Number(draft.时长分钟);
    return `${draft.开始时间}–${pad2(Math.floor(end / 60) % 24)}:${pad2(end % 60)}`;
  }
  // Relative day label for an ISO time ('今天 / 明天 / MM-DD' + HH:MM:SS), using the helper's server clock offset.
  function whenLabel(iso) {
    const t = new Date(iso);
    if (!iso || !Number.isFinite(t.getTime())) return '';
    const now = new Date(Date.now() + (state.clockOffset || 0)), day = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const prefix = day(t) === day(now) ? '今天' : day(t) === day(tomorrow) ? '明天' : `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    return `${prefix} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
  }
  function historyRows(records) {
    return records.length ? records.map(r => `<div class="cr-tr"><span class="cr-num">${escape(dayLabel(r.日期) || r.日期 || '')}<small>${escape(r.时间 || '')}</small></span><span><span class="cr-tag cr-result ${resultTone(r.状态)}" data-result="${escape(r.状态)}">${escape(r.状态)}</span></span><b>${escape(r.会议室 || '—')}</b><span class="cr-muted">${escape(r.备注 || '')}<small>${escape(r.时间戳 || '')}</small></span></div>`).join('') : '<p class="cr-empty">还没有抢订记录。测试填表的结果也会保存在这里。</p>';
  }
  function overview() {
    const fact = (id, label) => `<div><span>${label}</span><b data-cr-slot="${id}">—</b><em data-cr-slot="${id}-note"></em></div>`;
    return `<section data-cr-slot="first-use" role="status" hidden></section><div class="cr-count"><div class="cr-count-l"><div class="cr-cap">距开放　<span data-cr-slot="countdown-note">接通后显示</span></div><div class="cr-big cr-num" data-cr-slot="countdown">—</div></div><div class="cr-facts">${fact('target', '目标日期')}${fact('login', '登录状态')}${fact('last', '上次结果')}</div></div>
      <section>${head('今天的流程')}<div class="cr-journey" data-cr-slot="phases"></div></section>
      <section>${head('最近 5 次', `<span class="cr-sp"></span><button type="button" class="cr-btn cr-btn-ghost cr-btn-sm" data-cr-tab="history">全部历史</button>`)}<div class="cr-tbl" data-cr-slot="recent"></div></section>`;
  }
  function overviewSide() {
    return `<div class="cr-side-h">守护<span class="cr-tag" data-cr-slot="guard">—</span></div><div class="cr-side-b"><p class="cr-side-p" data-cr-slot="rule-text"></p><div class="cr-sched" data-cr-slot="sched-card" hidden></div>
      <div class="cr-acts">${button('plan', '去填抢订计划', 'pri')}${button('start', icon('play', 14) + '启动守护', 'pri')}${button('once', icon('bolt', 15) + '立即抢一次')}${button('test', icon('eye', 15) + '测试填表（不提交）')}${button('login', icon('acct', 15) + '登录 / 检查登录')}${button('pause', icon('stop', 14) + '<span data-cr-slot="pause-label">停止</span>', 'danger')}</div>
      <div class="cr-h cr-h-sm"><h3>下一次</h3></div><dl class="cr-kv" data-cr-slot="next"></dl></div>`;
  }
  function plan() {
    const rooms = draft.优先会议室;
    return `<p class="cr-plan-sum" data-cr-slot="plan-summary" role="status"></p><section>${head('会议')}<div class="cr-form">${field('主题', '会议主题', 'text', 'maxlength="120"')}${field('开始时间', '开始时间', 'time', 'step="1800"')}${field('时长小时', '时长 · 小时', 'number', 'min="0" max="12" step="1"')}${select('时长分钟', '时长 · 分钟', [0, 30])}</div><p class="cr-hint">时长为 30 分钟至 12 小时，结束时间不能跨天。</p>
      <div class="cr-field cr-days-field"><span>会议在周几<em>　按开会那天算，不是抢的那天</em></span><div class="cr-days">${['一', '二', '三', '四', '五', '六', '日'].map((d, i) => `<label class="cr-dy" title="周${d}"><input type="checkbox" data-cr-day="${i + 1}"${draft.抢订日.includes(i + 1) ? ' checked' : ''}><span>${d}</span></label>`).join('')}</div></div><p class="cr-hint">${escape(`每天 ${hm(sched().openTime)} 放号，能订 ${sched().advanceDays} 天后那天的会议室；所以想要周一的会议室，要在 ${sched().advanceDays} 天前的放号时刻去抢，Hub 会按时替你抢。`)}</p></section>
      <section>${head('优先会议室', `<span class="cr-n cr-num">${rooms.length} / 30</span><span class="cr-sp"></span>${button('read-rooms', icon('download', 14) + '从页面读取', 'ghost', 'cr-btn-sm')}`)}<p class="cr-hint cr-hint-top">按从上到下的顺序尝试，可拖动排序或点上下移，直接编辑名称。所在地域留空＝不切换；要抢别的城市就填上（建议填到楼宇），再点「从页面读取」核对；清空后自动切回原来的地域。</p>${areaRow()}
      <ol class="cr-rooms">${rooms.map((name, i) => `<li class="cr-rc${i === 0 ? ' first' : ''}" draggable="true" data-cr-room-row="${i}"><span class="cr-grip" aria-hidden="true">${icon('grip', 16)}</span><span class="cr-rc-n cr-num">${i + 1}</span><input class="cr-rc-name" aria-label="第 ${i + 1} 优先会议室" data-cr-room-name="${i}" value="${escape(name)}">${i === 0 ? '<span class="cr-tag blue">首选</span>' : ''}<span class="cr-ops"><button type="button" class="cr-icon-btn" data-cr-op="up" data-index="${i}" aria-label="上移 ${escape(name)}" title="上移"${!i ? ' disabled' : ''}>${icon('arrowU', 15)}</button><button type="button" class="cr-icon-btn" data-cr-op="down" data-index="${i}" aria-label="下移 ${escape(name)}" title="下移"${i === rooms.length - 1 ? ' disabled' : ''}>${icon('arrowD', 15)}</button><button type="button" class="cr-icon-btn" data-cr-op="delete" data-index="${i}" aria-label="删除 ${escape(name)}" title="删除">${icon('x', 15)}</button></span></li>`).join('')}</ol>${rooms.length ? '' : '<p class="cr-empty">还没有会议室。在下面填写全名添加，或点「从页面读取」。</p>'}
      <div class="cr-add"><input class="cr-input" data-cr-new-room aria-label="会议室全名" placeholder="会议室全名，需与网页一致">${button('add', icon('plus', 14) + '添加', 'sec', 'cr-btn-sm')}</div><div class="cr-picker-slot" data-cr-slot="room-picker"></div>${check('抢订设置.抢不到换下一间', '首选被抢走时，自动换下一间（约 20–30 秒）')}</section>`;
  }
  // 「所在地域」一行：抢别的城市或楼宇时填，「从页面读取」和抢订都先在网页弹窗里切到这里。
  function areaRow() {
    const ok = !state.connected || state.capabilities?.includes('area');
    const box = (k, ph) => `<input class="cr-input" data-cr-field="地域.${k}" aria-label="会议室所在${k}" placeholder="${ph}" maxlength="60" value="${escape(value('地域.' + k))}">`;
    return `<div class="cr-area" title="抢别的城市或楼宇时填，写法与网页下拉一致，中文名即可；改完先点「从页面读取」核对"><span class="cr-area-l">所在地域</span>${box('国家/地区', '国家/地区')}${box('城市', '城市，如 北京')}${box('楼宇', '楼宇，如 练秋湖F12栋')}</div>${ok ? '' : '<p class="cr-hint cr-area-hint cr-error" data-cr-slot="area-hint">当前会议室组件还不支持切换地域，Hub 会在空闲时自动换上新版组件，换好后这里的设置才生效。</p>'}`;
  }
  function planSide() {
    return `<div class="cr-side-h">接下来 5 次</div><div class="cr-side-b"><div class="cr-cal" data-cr-slot="calendar"></div><dl class="cr-kv cr-kv-top" data-cr-slot="plan-kv"></dl></div>`;
  }
  function postPage() {
    const modes = [['不动作', '抢到就结束。'], ['通知模式', '会前给指定账号发提醒。'], ['自动释放', '会议开始时取消这场会，把会议室让出来。']];
    return `<section>${head('抢到会议室后')}<div class="cr-opts" role="radiogroup" aria-label="抢到会议室后">${modes.map(([mode, desc]) => `<label class="cr-opt"><input type="radio" name="cr-post-mode" data-cr-field="会后动作.模式" value="${mode}"${draft.会后动作.模式 === mode ? ' checked' : ''}><span><b>${mode}</b><p>${desc}</p></span></label>`).join('')}</div></section>
      <section>${head('提醒')}<div class="cr-form cr-form-post">${field('会后动作.小鲁班ID', '提醒接收人 · WeLink 账号 ID')}${field('会后动作.提醒提前分钟', '提前提醒 · 分钟', 'number', 'min="1" max="60"')}<div class="cr-field"><span>&nbsp;</span>${button('test-message', icon('send', 14) + '发一条测试消息')}</div></div><p class="cr-hint" data-cr-slot="cli"></p><p class="cr-hint">只在点击后向上方接收人发送一条测试消息。</p></section>
      <section>${head('待执行', '<span class="cr-n cr-num" data-cr-slot="pending-n"></span>')}<div class="cr-items" data-cr-slot="pending"></div><p class="cr-hint">关闭页面后仍会继续执行；电脑关机错过的提醒会自动作废。</p></section>`;
  }
  function settings() {
    return `<section>${head('抢订节奏')}<div class="cr-sets">${setRow('开放时间', escape('预订系统每天放号的时刻 · ' + sourceLabel()), input('抢订设置.开放时间', '开放时间', 'time', 'step="1"'))}${setRow('提前天数', escape('抢几天后的会议室 · ' + sourceLabel()), `<input class="cr-input" data-cr-sched-field="advanceDays" type="number" min="1" max="14" step="1" value="${escape(schedDraft.advanceDays)}" aria-label="提前天数">`)}${setRow('提前填表 · 秒', '开放前把表单填好，只差提交', input('抢订设置.提前填表秒数', '提前填表秒数', 'number', 'min="5" max="600"'))}${setRow('整点连点', '开放那一刻连续提交：次数 / 间隔毫秒', `${input('抢订设置.最大重试次数', '整点连点次数', 'number', 'min="1" max="30"')}${input('抢订设置.重试间隔毫秒', '连点间隔毫秒', 'number', 'min="50" max="3000" step="50"')}`)}${setRow('登录预检 · 提前分钟', '发现登录过期会提醒你', input('抢订设置.登录预检提前分钟', '登录预检提前分钟', 'number', 'min="0" max="180"'))}${setRow('按 WeLink 服务器时间对齐整点', '本机时间不准也不影响', toggle('抢订设置.校准服务器时间', '按 WeLink 服务器时间对齐整点'))}</div></section>
      <section>${head('电脑')}<div class="cr-sets">${setRow('守护期间阻止电脑自动睡眠', '合上笔记本仍可能睡眠', toggle('系统.守护时阻止睡眠', '守护期间阻止电脑自动睡眠'))}</div><p class="cr-hint">启动与更新由 AI Hub 统一管理，会议室组件不另设开机启动和自动更新。</p></section>
      <section>${head('页面适配')}<p class="cr-hint cr-hint-top">页面改版时再调整；先用总览里的「测试填表」核对。</p><div class="cr-sets">${setRow('预订页地址', '', input('高级.网址', '预订页地址', 'url'), true)}${setRow('浏览器', '', choice('高级.浏览器', '浏览器', ['自动', 'Edge', 'Chrome', '内置Chromium']))}${setRow('welink-cli 路径', '留空自动查找', input('高级.welink-cli路径', 'welink-cli 路径'), true)}${setRow('自动标定时间网格', '关闭后使用下面的手动标定', toggle('高级.自动标定网格', '自动标定时间网格'))}${setRow('手动标定', '起点 X / 格子宽度 / 首格时间', `${input('高级.网格起点X', '手动标定起点 X', 'number', 'min="0" max="3000"')}${input('高级.格子宽度', '格子宽度', 'number', 'min="10" max="100"')}${input('高级.网格起始时间', '首格时间', 'time')}`, true)}</div></section>
      <section>${head('本机数据')}<div class="cr-sets">${setRow('数据目录', `<span class="cr-path">${escape(state.home || '')}</span>`, button('folder-data', icon('folder', 14) + '打开数据目录', 'sec', 'cr-btn-sm'))}</div><p class="cr-hint">配置、历史和登录资料保留在本机。组件随 Hub 更新。</p></section>`;
  }
  function historyPage() {
    return `<section>${head('最近 50 次', `<span class="cr-n" data-cr-slot="history-counts"></span><span class="cr-sp"></span>${button('folder-screenshots', icon('open', 14) + '打开截图目录', 'ghost', 'cr-btn-sm')}`)}<div class="cr-tbl cr-tbl-wide" data-cr-slot="history"></div></section>`;
  }
  function logsPage() {
    return `<section>${head('运行日志', `<span class="cr-sp"></span>${button('clear-log', '清空显示', 'ghost', 'cr-btn-sm')}${button('folder-logs', icon('open', 14) + '打开日志目录', 'sec', 'cr-btn-sm')}`)}<div class="cr-log" data-cr-slot="logs"></div></section>`;
  }
  function render() {
    if (!host || host.hidden) return;
    host.querySelectorAll('[data-cr-tab]').forEach(b => { b.classList.toggle('active', b.dataset.crTab === tab); b.setAttribute('aria-current', b.dataset.crTab === tab ? 'page' : 'false'); });
    const side = slot('side'), sheet = host.querySelector('.cr-sheet');
    host.querySelector('.cr-col').append(footer); // detach before the side panel is rebuilt
    slot('content').innerHTML = tab === 'overview' ? overview() : tab === 'plan' ? plan() : tab === 'post' ? postPage() : tab === 'settings' ? settings() : tab === 'history' ? historyPage() : logsPage();
    side.innerHTML = tab === 'overview' ? overviewSide() : tab === 'plan' ? planSide() : '';
    side.hidden = !side.innerHTML; sheet.classList.toggle('cr-solo', side.hidden);
    if (tab === 'plan') { footer.classList.add('cr-footer-side'); side.append(footer); } else footer.classList.remove('cr-footer-side');
    footer.hidden = !['plan', 'post', 'settings'].includes(tab);
    logsShown = null;
    slot('content').scrollTop = 0; updateLive();
    // 组件还没接通时 updateLive 不刷新计划侧栏：一句话说明要一进页就有。
    if (tab === 'plan') updatePlanSide();
  }
  function updateControls() {
    if (!host) return;
    const readiness = roomReadiness(draft, state);
    const checklist = slot('first-use');
    // 「登录 / 检查登录」灰着时写明原因（2026-11-21：首次用户看到灰按钮不知道为什么）。
    const loginWhy = !state.connected ? '要先接通会议室组件（上方下载或连接），接通后才能登录'
      : state.loginBusy ? '正在打开登录页…' : state.running ? '守护运行中，先停止守护再登录'
      : (busy || state.controlBusy) ? '正在处理上一步，稍等' : !loaded ? '正在读取配置…' : '';
    if (checklist) {
      checklist.hidden = (readiness.plan && readiness.login) || !!state.running;
      const html = readiness.ready
        ? head('登录尚未检查') + '<p class="cr-side-p">可以启动守护，组件会在抢订前自动检查登录；如登录失效，会提醒你重新登录。</p>'
        : head(`还差 ${readiness.missing} 步`) + `${!readiness.login ? `<p class="cr-side-p">① 登录会议室网页 ${button('login', '登录 / 检查登录', 'sec', 'cr-btn-sm')}${loginWhy ? `<small class="cr-why" data-cr-slot="login-why">${escape(loginWhy)}</small>` : ''}</p>` : ''}${!readiness.plan ? `<p class="cr-side-p">② 在抢订计划里加会议室 ${button('plan', '去填抢订计划', 'sec', 'cr-btn-sm')}</p>` : ''}`;
      if (checklist.dataset.html !== html) { checklist.innerHTML = html; checklist.dataset.html = html; }
    }
    const locked = busy || !state.connected || state.running || state.loginBusy || state.controlBusy;
    const full = state.capabilities?.includes('full-ui');
    host.querySelectorAll('[data-cr-field], [data-cr-day], [data-cr-room-name], [data-cr-new-room]').forEach(e => { e.disabled = !!locked || !loaded || !full; });
    host.querySelectorAll('[data-cr-op]').forEach(b => {
      const op = b.dataset.crOp;
      if (['start', 'once', 'test', 'login', 'save', 'read-rooms', 'test-message', 'add', 'delete', 'up', 'down', 'add-selected', 'remove-pending'].includes(op)) {
        b.disabled = !!locked || !loaded || (!full && !['start', 'test', 'login'].includes(op));
        if (op === 'up' && Number(b.dataset.index) === 0 || op === 'down' && Number(b.dataset.index) === draft.优先会议室.length - 1) b.disabled = true;
      }
      if (op === 'pause') b.disabled = busy || !state.connected || !state.running;
      if (op === 'connect' || op === 'install') b.disabled = busy || state.preparing || state.download?.phase === 'downloading';
      // One guard button at a time: start while idle, stop while a task runs.
      if (op === 'plan') b.hidden = readiness.plan || !!state.running;
      if (op === 'start') { b.hidden = !!state.running; b.disabled ||= !readiness.ready; b.classList.toggle('cr-btn-pri', readiness.ready); b.classList.toggle('cr-btn-sec', !readiness.ready); }
      if (op === 'once') b.disabled ||= !readiness.ready;
      // 规则不是 7 天而组件还只会抢 7 天：启动和立即抢会白跑，按钮停用，原因写在旁边的节奏卡里。
      if ((op === 'start' || op === 'once') && schedBlocked()) b.disabled = true;
      if (op === 'login') b.title = b.disabled && loginWhy ? loginWhy : '';
      if (op === 'login' && b.closest('.cr-side-b')) { b.classList.toggle('cr-btn-pri', readiness.plan && !readiness.ready); b.classList.toggle('cr-btn-sec', !(readiness.plan && !readiness.ready)); }
      if (op === 'pause') b.hidden = !state.running;
    });
    slot('save-state').textContent = dirty ? '有未保存的修改 · 切页会保留' : state.running ? '运行中，停止后可修改设置' : '设置已与本机组件同步';
  }
  function updatePlanSide() {
    const cal = slot('calendar'), kv = slot('plan-kv'), sum = slot('plan-summary');
    if (sum) sum.textContent = planSummary({ days: draft.抢订日 || [], span: span(), rooms: (draft.优先会议室 || []).filter(Boolean), advanceDays: sched().advanceDays, openTime: sched().openTime, switchNext: draft.抢订设置?.抢不到换下一间 !== false });
    if (!cal || !kv) return;
    const days = draft.抢订日 || [], target = /^(\d{4})-(\d{2})-(\d{2})/.exec(effTarget() || '');
    const dates = [];
    if (target && days.length) {
      // Upcoming target dates from the helper's next target, following the selected weekdays (Mon=1 … Sun=7).
      const d = new Date(Date.UTC(+target[1], +target[2] - 1, +target[3]));
      for (let i = 0; i < 60 && dates.length < 5; i++, d.setUTCDate(d.getUTCDate() + 1)) if (days.includes(d.getUTCDay() || 7)) dates.push(new Date(d));
    }
    cal.innerHTML = dates.length ? dates.map((d, i) => `<div class="cr-cd${i === 0 ? ' next' : ''}"><span>周${WEEK[d.getUTCDay()]}</span><b class="cr-num">${d.getUTCDate()}</b><em>${d.getUTCMonth() + 1} 月</em></div>`).join('') : `<p class="cr-empty">${target ? '先选择要抢的日子' : '接通组件后显示'}</p>`;
    const skip = ['一', '二', '三', '四', '五', '六', '日'].filter((_, i) => !days.includes(i + 1)).map(d => '周' + d);
    kv.innerHTML = `<dt>时段</dt><dd class="cr-num">${escape(span() || '—')}</dd><dt>开抢</dt><dd>目标日前 ${sched().advanceDays} 天的 ${escape(hm(sched().openTime) || '—')}</dd><dt>不抢</dt><dd>${escape(skip.join('、') || '无')}</dd>`;
  }
  function renderLogs() {
    const log = slot('logs'); if (!log) return;
    const text = state.logs || '', shown = logCleared && text.startsWith(logCleared) ? text.slice(logCleared.length) : text;
    if (shown === logsShown) return;
    logsShown = shown;
    // The helper sends its log view as plain text («HH:MM:SS  message»); levels are not part of it.
    const rows = shown.split(/\r?\n/).filter(line => line.trim()).reverse().map(line => {
      const m = /^(\d{1,2}:\d{2}:\d{2})[\s ]+([\s\S]*)$/.exec(line), msg = m ? m[2] : line;
      const tone = /失败|错误/.test(msg) ? 'red' : /成功/.test(msg) ? 'green' : '';
      return `<div class="cr-lg"><time class="cr-num">${escape(m ? m[1] : '')}</time><span>${tone ? `<span class="cr-tag ${tone}">${tone === 'red' ? '失败' : '成功'}</span>` : ''}</span><span>${escape(msg)}</span></div>`;
    });
    log.innerHTML = rows.join('') || '<p class="cr-empty">尚无运行日志。接通组件后在这里查看每一步。</p>';
  }
  function updateLive() {
    if (!host || host.hidden) return;
    const history = [...(state.history || [])].reverse(), last = history.find(r => r.状态 !== '测试');
    const phase = state.preparing ? '正在准备' : !state.connected ? '尚未接通' : state.controlBusy ? '正在处理' : state.running ? state.mode === 'daemon' ? '守护中' : '运行中' : '未启动';
    slot('side-status').textContent = phase; slot('version').textContent = state.version || '—';
    host.querySelector('.cr-pill').dataset.crPill = state.running ? 'run' : state.preparing || state.controlBusy ? 'busy' : state.connected ? 'idle' : 'off';
    const pendingCount = (state.pending || []).length, badge = slot('pending-count');
    badge.hidden = !pendingCount; badge.textContent = pendingCount || '';
    slot('subtitle').textContent = SUBTITLES[tab] || '';
    const connection = slot('connection'), d = state.download || {};
    connection.hidden = !!state.connected && !state.error && !state.loginNeeded && state.capabilities?.includes('full-ui');
    if (!connection.hidden) {
      const available = state.available || d.installed;
      // r59：统一进度条（进度、速度、剩余时间、来源）。
      const progress = d.phase === 'downloading' ? require('./download-progress-view').html({ ...d, total: d.total || d.bytes || 0 }, { title: '下载会议室组件' }) : '';
      const blocked = d.attempts?.find(a => a.blocked && a.url);
      const message = state.error || d.error || (state.loginNeeded ? '会议室网页登录已失效，请重新登录。' : state.connected ? '控制组件需要更新，请停止任务后重新接通。' : state.preparing ? '正在准备组件，首次可能需要约 2 分钟。' : available ? '会议室组件已就绪，接通后即可操作。' : '首次使用需下载约 77 MB 的会议室组件，无需另外安装秘书终结者。');
      connection.dataset.tone = state.error || d.error || state.loginNeeded || blocked ? 'warn' : 'info';
      connection.innerHTML = `<span>${escape(message)}${progress}${blocked ? `<br>公司网络拦截了下载。<button type="button" class="cr-btn-sm" data-room-open-pass="${escape(blocked.url)}">打开放行页</button>` : ''}</span>${state.loginNeeded ? button('login', '打开登录', 'sec', 'cr-btn-sm') : available ? button('connect', '重新接通', 'sec', 'cr-btn-sm') : button('install', d.error ? '重新下载会议室组件' : '下载会议室组件', 'sec', 'cr-btn-sm')}`;
      // r58：会议室组件还要下载时，旁边显示「下载源：公司内源」。
      if (!d.installed) { connection.insertAdjacentHTML('beforeend', require('./download-source-view').slotHtml('room-runtime', 'span')); void require('./download-source-view').fill(connection, { ipcRenderer }); }
      connection.querySelector('[data-room-open-pass]')?.addEventListener('click', event => { event.currentTarget.disabled = true; const b = event.currentTarget; void ipcRenderer.invoke('net-pass:open-window', b.dataset.roomOpenPass).then(() => window.__hubToast?.('放行页已打开：放行后回来点「重新下载」'), error => { b.disabled = false; window.__hubToast?.('放行页没打开：' + (error?.message || '未知原因')); }); });
    }
    if (tab === 'overview') {
      const tgt = effTarget(), after = `开放日 ${sched().advanceDays} 天后`;
      slot('target').textContent = dayLabel(tgt) || tgt || '—';
      slot('target-note').textContent = tgt ? `${span()} · ${state.mode === 'once' || state.mode === 'test' ? '本次目标' : after}` : after;
      updateSchedCard();
      const login = slot('login');
      login.textContent = !state.connected ? '未连接' : state.loginState === true ? '有效' : state.loginState === false ? '失效' : '未检查';
      login.className = state.connected && state.loginState === true ? 'ok' : state.connected && state.loginState === false ? 'bad' : '';
      slot('login-note').textContent = state.loginCheckedAt ? '检查于 ' + state.loginCheckedAt.replace('T', ' ').slice(5, 16) : '抢订前自动检查';
      const lastEl = slot('last');
      lastEl.innerHTML = last ? `<span class="${resultTone(last.状态) === 'green' ? 'ok' : resultTone(last.状态) === 'red' ? 'bad' : ''}">${escape(last.状态)}</span> ${escape(last.会议室 || '')}` : '—';
      slot('last-note').textContent = last ? `${last.日期}${last.时间 ? ' · ' + last.时间 : ''}` : '还没有正式抢订记录';
      slot('phases').innerHTML = [['precheck', '登录预检'], ['prepare', '填表选会议室'], ['submit', '整点提交'], ['post', '会后动作']].map(([key, title]) => {
        const p = state.phases?.[key], status = p?.[0] || p?.status || '', text = p?.[1] || p?.text || '等待执行';
        return `<div class="cr-jy" data-state="${escape(status)}"><span class="cr-jy-ic">${icon(status === 'ok' ? 'tick' : status === 'bad' ? 'x' : 'clock', 14)}</span><b>${title}</b><p>${escape(text)}</p></div>`;
      }).join('');
      slot('recent').innerHTML = history.slice(0, 5).map(r => `<div class="cr-tr"><span class="cr-num">${escape(monthDay(r.时间戳) || monthDay(r.日期))}</span><span><span class="cr-tag cr-result ${resultTone(r.状态)}" data-result="${escape(r.状态)}">${escape(r.状态)}</span></span><b>${escape(r.会议室 || '—')}</b><span class="cr-muted">${escape(r.备注 || [dayLabel(r.日期) && '订 ' + dayLabel(r.日期), r.时间].filter(Boolean).join(' '))}</span></div>`).join('') || '<p class="cr-empty">还没有记录</p>';
      const guard = slot('guard');
      guard.textContent = phase; guard.className = 'cr-tag ' + (state.running ? 'green' : state.preparing || state.controlBusy ? 'amber' : '');
      slot('pause-label').textContent = state.running && state.mode === 'daemon' ? '停止守护' : '停止';
      const rooms = draft.优先会议室.filter(Boolean);
      slot('next').innerHTML = `<dt>开抢</dt><dd>${escape(whenLabel(effOpen()) || (state.connected ? '—' : '接通后显示'))}</dd><dt>订的是</dt><dd>${escape(tgt ? `${dayLabel(tgt)}　${span()}` : '—')}</dd><dt>顺序</dt><dd>${escape(rooms.length ? rooms.slice(0, 3).join(' → ') + (rooms.length > 3 ? ` 等 ${rooms.length} 间` : '') : '还没有会议室')}</dd><dt>连点</dt><dd>${escape(`${draft.抢订设置.最大重试次数} 次，间隔 ${draft.抢订设置.重试间隔毫秒} ms`)}</dd>`;
      updateClock();
    }
    if (tab === 'history') {
      slot('history').innerHTML = historyRows(history);
      const counts = ['成功', '失败', '测试'].map(s => [s, history.filter(r => r.状态 === s).length]).filter(([, n]) => n);
      slot('history-counts').textContent = counts.map(([s, n]) => `${s} ${n}`).join('　');
    }
    if (tab === 'logs') renderLogs();
    if (tab === 'post') {
      // 2026-11-07：没找到时不再让用户去设置页填路径，而是走 Hub 的自动发现（与助理页同一套，多个版本时可切换）。
      const test = state.messageTest?.state === 'running' ? ' · 正在发送测试消息…' : state.messageTest?.state === 'done' ? ' · 测试消息已发送' : state.messageTest?.error ? ' · ' + state.messageTest.error : '';
      slot('cli').innerHTML = state.cliAvailable ? escape('已找到 welink-cli' + test)
        : escape('还没找到 welink-cli' + test) + ' ' + button('find-cli', '查找或一键安装', 'sec', 'cr-btn-sm');
      slot('pending-n').textContent = pendingCount ? String(pendingCount) : '';
      slot('pending').innerHTML = (state.pending || []).map(p => `<div class="cr-item"><span class="cr-svc">${icon('bell', 15)}</span><span class="cr-grow">${escape(p.description)}</span><button type="button" class="cr-btn cr-btn-ghost cr-btn-sm" data-cr-op="remove-pending" data-id="${escape(p.id)}">删除</button></div>`).join('') || '<p class="cr-empty">暂无待执行事项</p>';
    }
    if (tab === 'plan') {
      const r = state.roomRead || {}, picker = slot('room-picker');
      // Preserve checked choices during polling; rebuild only when the result changes.
      const signature = JSON.stringify(r);
      if (picker.dataset.signature !== signature) {
        picker.dataset.signature = signature;
        picker.innerHTML = r.state === 'running' ? '<p class="cr-picker-note">正在读取网页上的会议室，通常约 20 秒…</p>' : r.error ? `<div class="cr-picker"><p class="cr-error">${escape(r.error)}</p>${button('read-rooms', '重新读取', 'sec', 'cr-btn-sm')}</div>` : r.state === 'done' ? `<div class="cr-picker">${r.names?.length ? `<p class="cr-picker-note">从网页读到 ${r.names.length} 间，勾选后加入：</p><div class="cr-picker-list">${r.names.map(name => `<label class="cr-check"><input type="checkbox" data-cr-found="${escape(name)}"${draft.优先会议室.includes(name) ? ' disabled' : ''}>${escape(name)}</label>`).join('')}</div>${button('add-selected', '加入所选', 'pri', 'cr-btn-sm')}` : '<p class="cr-picker-note">没有读取到会议室，请确认登录和网页筛选条件后重试。</p>'}</div>` : '';
      }
      updatePlanSide();
    }
    updateControls();
  }
  function updateClock() {
    if (tab !== 'overview' || !host || host.hidden) return;
    const open = effOpen(), ms = new Date(open).getTime() - (Date.now() + (state.clockOffset || 0));
    slot('countdown').textContent = !Number.isFinite(ms) ? '—' : ms <= 0 ? '进行中' : [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':');
    slot('countdown-note').textContent = open ? `${whenLabel(open)}${state.connected && state.serverNow ? '（按服务器时间）' : ''}` : '接通后显示';
  }
  async function refresh() {
    if (polling || (gate && !gate.isOn())) return;
    polling = true; const epoch = generation;
    try {
      const next = (await call('room-details')).rooms;
      if (epoch !== generation || host.hidden) return;
      if (state.roomRead?.state === 'running' && next.roomRead?.state !== 'running') {
        slot('message').textContent = next.roomRead?.error ? '读取未完成：' + next.roomRead.error : `已读取 ${next.roomRead?.names?.length || 0} 间会议室，请勾选后加入。`;
      }
      if (state.running && !next.running && next.connected && !busy) slot('message').textContent = '任务已结束，可在历史记录和运行日志中查看结果。';
      next.clockOffset = next.serverNow ? new Date(next.serverNow).getTime() - Date.now() : 0; state = next;
      if (next.rules && !dirty && !busy) { draft = { ...copy(DEFAULTS), ...next.rules }; for (const key of ['抢订设置', '会后动作', '系统', '高级', '地域']) draft[key] = { ...DEFAULTS[key], ...next.preferences?.[key] }; if (next.schedule) { draft.抢订设置.开放时间 = next.schedule.openTime; schedDraft = { advanceDays: next.schedule.advanceDays }; schedChanged = false; } const first = !loaded; loaded = true; if (first || ['plan', 'post', 'settings'].includes(tab) && !host.contains(document.activeElement)) render(); }
      updateLive();
    } catch (error) { if (epoch === generation && !host.hidden) { slot('message').textContent = '状态刷新失败：' + error.message + '；可点击刷新重试。'; } }
    finally { polling = false; }
  }
  function validate(requirePlan = false) {
    const topic = draft.主题.trim(), rooms = draft.优先会议室.map(r => r.trim()), time = /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(draft.开始时间);
    if (!topic || topic.length > 120) throw Error('会议主题须为 1–120 字');
    if (!time) throw Error('开始时间须为整点或半点');
    const duration = Number(draft.时长小时) * 60 + Number(draft.时长分钟), [h, m] = draft.开始时间.split(':').map(Number);
    if (!Number.isInteger(Number(draft.时长小时)) || ![0, 30].includes(Number(draft.时长分钟)) || duration < 30 || duration > 720 || h * 60 + m + duration > 1440) throw Error('会议时长须为 30 分钟至 12 小时，结束时间不能跨天');
    if (requirePlan && !rooms.length || rooms.length > 30 || rooms.some(r => !r || r.length > 120)) throw Error('请填写 1–30 个有效的优先会议室');
    if (new Set(rooms).size !== rooms.length) throw Error('优先会议室不能重复');
    if (!draft.抢订日.length) throw Error('至少选择一个抢订日');
    return { ...copy(draft), 主题: topic, 优先会议室: rooms };
  }
  async function save() {
    if (draft.会后动作.模式 !== '不动作' && !draft.高级['welink-cli路径']) {
      const status = await call('status');
      if (status.cliPath) { draft.高级['welink-cli路径'] = status.cliPath; changed.add('高级'); }
    }
    const rules = validate(); const patch = Object.fromEntries([...changed].map(k => [k, rules[k]]));
    if (patch.地域 && state.connected && !state.capabilities?.includes('area')) {
      if (Object.values(patch.地域).some(v => String(v).trim())) throw Error('当前会议室组件还不支持切换地域，等 Hub 自动换上新版组件后再保存地域；其他设置可先把地域清空再保存');
      delete patch.地域; // 旧组件不认这一项：全空时不发，免得其他设置一起保存失败
    }
    if (Object.keys(patch).length) await call('room-command', { op: 'configure', rules: patch });
    if (schedChanged) { await call('room-schedule', { advanceDays: schedDraft.advanceDays, openTime: rules.抢订设置.开放时间 }); schedChanged = false; }
    draft = rules; dirty = false; changed.clear();
  }
  // 复用 Hub 的自动发现与一键安装；找到后把路径写进会议室组件的设置。
  async function findCli() {
    busy = true; slot('message').textContent = '正在自动查找 welink-cli，最长约 2 分钟…'; updateControls();
    try {
      await call('find-cli');
      let status = await call('status');
      if (!status.cliPath && status.cliInstallAvailable) {
        slot('message').textContent = '正在一键安装 welink-cli，装好后会自动填入路径…';
        const result = await call('install-cli');
        if (!result.ok) throw new Error(result.error || '安装未完成，请再点「查找或一键安装」重试');
        status = await call('status');
      }
      if (!status.cliPath) { slot('message').textContent = '暂未找到 welink-cli。可在助理页点「一键安装」，或手动选择已安装的工具。'; return; }
      draft.高级['welink-cli路径'] = status.cliPath; dirty = true; changed.add('高级');
      await save();
      const version = status.cliChoice?.current?.version || status.cliVersion;
      slot('message').textContent = '已找到 welink-cli' + (version ? ' v' + version : '') + (status.cliChoice?.needsPick ? `（本机有 ${status.cliChoice.candidates.length} 个版本，已用最新的，可到助理设置里切换）` : '');
    } catch (error) { slot('message').textContent = '自动查找没完成：' + error.message; }
    finally { busy = false; await refresh(); updateControls(); }
  }
  async function act(op, b) {
    if (op === 'plan') { tab = 'plan'; render(); host.querySelector('[data-cr-new-room]')?.focus(); return; }
    if (busy && !['folder-data', 'folder-logs', 'folder-screenshots', 'clear-log'].includes(op)) return;
    if (op === 'find-cli') { await findCli(); return; }
    if (op === 'sched-save') { await saveSchedCard(); return; }
    // 认不出园区、也没确认过节奏：开抢前先在旁边就地确认两项，点「保存并继续」接着做刚才那一步。
    if (['start', 'once'].includes(op) && schedBlocked()) { updateSchedCard(true); slot('message').textContent = `按现在的规则要抢 ${sched().advanceDays} 天后的会议室，当前会议室组件只会抢 7 天后，本次未启动；原因见右侧`; return; }
    if (['start', 'once', 'test'].includes(op) && sched().needsConfirm) {
      pendingOp = op; updateSchedCard(true);
      slot('message').textContent = '先确认抢订节奏：提前几天、几点开放，点「保存并继续」后接着' + ({ start: '启动守护', once: '立即抢一次', test: '测试填表' })[op];
      host.querySelector('[data-cr-sched-input="advanceDays"]')?.focus(); return;
    }
    if (op === 'clear-log') { logCleared = state.logs || ''; updateLive(); return; }
    if (op.startsWith('folder-')) { try { await call('room-open-folder', { kind: op.slice(7) }); } catch (e) { slot('message').textContent = e.message; } return; }
    if (op === 'add' || op === 'add-selected') {
      const names = op === 'add' ? [host.querySelector('[data-cr-new-room]').value.trim()] : [...host.querySelectorAll('[data-cr-found]:checked')].map(e => e.dataset.crFound);
      if (!names.length || names.some(n => !n)) { slot('message').textContent = '先填写或选择会议室'; return; }
      const all = [...new Set([...draft.优先会议室, ...names])];
      if (all.length > 30) { slot('message').textContent = '最多配置 30 间会议室'; return; }
      draft.优先会议室 = all; dirty = true; changed.add('优先会议室'); render(); return;
    }
    if (['up', 'down', 'delete'].includes(op)) { const i = Number(b.dataset.index), rooms = draft.优先会议室; if (op === 'delete') rooms.splice(i, 1); else { const j = i + (op === 'up' ? -1 : 1); if (j >= 0 && j < rooms.length) [rooms[i], rooms[j]] = [rooms[j], rooms[i]]; } dirty = true; changed.add('优先会议室'); render(); return; }
    busy = true; slot('message').textContent = op === 'install' ? '正在下载组件…可以切页，下载会继续。' : op === 'connect' ? '正在接通，首次可能需要约 2 分钟…' : '正在处理…'; updateControls();
    try {
      if (op === 'refresh') await refresh();
      else if (op === 'connect' || op === 'install') { await call(op === 'connect' ? 'room-reconnect' : 'room-install'); }
      else {
        if (['start', 'test', 'once'].includes(op)) {
          try { validate(true); }
          catch (error) { tab = 'plan'; render(); error.focusPlan = true; throw error; }
        }
        if (op === 'save' || dirty && ['start', 'test', 'once', 'test-message', 'read-rooms'].includes(op)) await save();
        if (op !== 'save') await call('room-command', { op, rules: op === 'remove-pending' ? { id: b.dataset.id } : {} });
      }
      slot('message').textContent = ({ save: '设置已保存', pause: '已请求停止，待浏览器退出后即可修改', start: '已启动守护', once: '已启动本次抢订，请在流程和记录中查看结果', test: '正在测试填表，不会提交预订', login: '请在打开的浏览器中完成登录', 'read-rooms': '正在读取会议室，通常约 20 秒', 'test-message': '正在发送测试消息，请查看下方发送结果' })[op] || '操作已完成';
    } catch (error) { slot('message').textContent = '操作未完成：' + error.message; if (error.focusPlan) host.dataset.focusPlan = '1'; }
    finally { busy = false; await refresh(); updateControls(); if (host.dataset.focusPlan) { delete host.dataset.focusPlan; host.querySelector('[data-cr-new-room]')?.focus(); } }
  }
  // 总览右栏的节奏卡：认不出园区时就地确认两项；规则不是 7 天而组件还只会抢 7 天时，如实说明。
  function updateSchedCard(force = false) {
    const card = slot('sched-card'), text = slot('rule-text');
    if (!card || !text) return;
    const s = sched();
    const mode = s.needsConfirm ? 'confirm' : schedBlocked() ? 'blocked' : '';
    // 节奏卡出现时右栏只留规则一句，保证一屏放下。
    text.textContent = (s.text || `每天 ${hm(s.openTime)} 放号，抢 ${s.advanceDays} 天后的会议室`) + (mode ? '。' : '。立即抢一次会真实提交；尚未开放时等到今天的开放时刻。');
    const sig = JSON.stringify([mode, s.advanceDays, s.openTime, s.campus, pendingOp]);
    if (!force && card.dataset.sig === sig) return;
    card.dataset.sig = sig; card.hidden = !mode;
    if (mode === 'confirm') card.innerHTML = `<b>确认抢订节奏</b><p>没从会议室名称和日程地点认出所在园区。各园区放号规则不同，核对后保存一次。</p>
      <div class="cr-sched-row"><label>提前<input class="cr-input" data-cr-sched-input="advanceDays" type="number" min="1" max="14" step="1" value="${escape(s.advanceDays)}" aria-label="提前几天">天</label><label>每天<input class="cr-input" data-cr-sched-input="openTime" type="time" step="60" value="${escape(hm(s.openTime))}" aria-label="几点开放">开放</label></div>
      ${button('sched-save', pendingOp ? '保存并继续' : '保存', 'pri', 'cr-btn-sm')}`;
    else if (mode === 'blocked') card.innerHTML = `<b>${escape(s.source === 'campus' ? `${s.campus}园区提前 ${s.advanceDays} 天放号` : `提前 ${s.advanceDays} 天放号`)}</b><p class="cr-error">当前会议室组件只会抢 7 天后的会议室，按这个规则抢不到，暂不启动；更新会议室组件后自动按 ${s.advanceDays} 天抢。开放时刻 ${escape(hm(s.openTime))} 已按规则设置。</p>`;
    else card.innerHTML = '';
  }
  async function saveSchedCard() {
    const days = Number(host.querySelector('[data-cr-sched-input="advanceDays"]')?.value), open = host.querySelector('[data-cr-sched-input="openTime"]')?.value || '';
    busy = true; updateControls();
    let next = '';
    try {
      await call('room-schedule', { advanceDays: days, openTime: open });
      next = pendingOp; pendingOp = '';
      slot('message').textContent = `已保存：每天 ${hm(open)} 放号，抢 ${days} 天后的会议室`;
    } catch (error) { slot('message').textContent = '没保存：' + error.message; }
    finally { busy = false; await refresh(); updateSchedCard(true); updateControls(); }
    if (next) await act(next);
  }
  function place() {
    if (!host || host.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footerBar = document.getElementById('hub-system-footer');
    Object.assign(host.style, { left: `${rail?.getBoundingClientRect().right || 52}px`, top: `${bar?.getBoundingClientRect().bottom || 44}px`, bottom: `${footerBar?.getBoundingClientRect().height || 0}px` });
  }
  async function open() {
    build(); closeOtherPanels();
    for (const key of ['__companyAssistantHide', '__companyMeetingHide', '__companyForumHide', '__companyAttendanceHide', '__companyW3Hide', '__profileHide', '__assistantHide', '__teamHide', '__avatarHide', '__cloudHide', '__wirelessHide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[key]?.();
    generation++; host.hidden = false; nav.classList.add('active'); window.setShellNavActive?.('company-rooms'); document.body.classList.add('company-rooms-page-open'); place(); render();
    window.addEventListener('resize', place); clearInterval(timer); clearInterval(clockTimer); timer = null; clockTimer = null;
    if (gate && !(await gate.check())) return;
    await startLive();
  }
  async function startLive() {
    if (!host || host.hidden) return;
    clearInterval(timer); clearInterval(clockTimer);
    timer = setInterval(() => { void refresh(); }, 3000); clockTimer = setInterval(updateClock, 1000);
    await refresh();
    if (!state.connected && state.available && !state.preparing && !state.error && !busy) await act('connect');
  }
  function close() { generation++; if (host) host.hidden = true; nav.classList.remove('active'); document.body.classList.remove('company-rooms-page-open'); clearInterval(timer); clearInterval(clockTimer); window.removeEventListener('resize', place); }
  nav.addEventListener('click', () => { void open().catch(e => showMessage?.(e.message)); });
  document.addEventListener('click', e => { if (e.target.closest('#scene-rail button:not(#btn-company-rooms)')) close(); });
  return { open, close };
}
module.exports = { createCompanyRoomsPage, roomReadiness, planSummary };
