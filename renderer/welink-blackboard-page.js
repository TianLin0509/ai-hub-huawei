'use strict';
// 「WeLink (Beta)」公共黑板工作台（2026-11-26）：左栏「社区」分组里的入口，只在公司版启用。
// 本机所有调 WeLink 命令行的功能（助理、分身、手机对话、一键反馈、一键入群、只读工具、外部组件）共用一块磁盘黑板，
// 这一页把黑板读出来：登录与命令行状态、限流冷却与锁、谁在用额度、最近的脱敏调用流水、读群节流策略。
// 三个子页签各一屏（1440×900 无纵向滚动）：总览与自救 / 调用流水（每页 8 条）/ 策略与工具。
// 少打扰：正常时不弹任何提示；左栏入口只在异常时带一个小圆点；出错就在出错的位置给一行字和一个能直接点的按钮。
// 数据只经 IPC welink-blackboard:* 读写；主进程有显著变化时推 welink-blackboard:changed，这里不轮询主进程，
// 只有 429 冷却倒计时在本页每秒本地走字，倒数到 0 时再取一次快照。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-US');
const pad = n => String(n).padStart(2, '0');
const hhmm = at => { if (!at) return ''; const d = new Date(Number(at)); return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };
const hhmmss = at => { if (!at) return ''; const d = new Date(Number(at)); return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : ''; };
const PAGE_SIZE = 8;
const TABS = [
  { id: 'overview', name: '总览与自救' },
  { id: 'events', name: '调用流水' },
  { id: 'policy', name: '策略与工具' },
];
const FILTERS = [
  { id: 'all', name: '全部' },
  { id: 'ok', name: '正常' },
  { id: 'rate_limited', name: '限流' },
  { id: 'failed', name: '失败' },
];
const LOGOUT_CONFIRM = '退出后：① 助理、分身、手机对话、入群等功能将暂停读写 WeLink；② WeLink 邮件和日历的登录配置也会一起清空，之后需重新扫码。确定退出吗？';
const COOLDOWN_CONFIRM = '服务端可能仍在限流，立即重试可能再次被限，确定吗？';
const RED_ZONE_NOTE = '红区无摄像头暂不支持扫码，请先在蓝区电脑完成登录或联系团队了解免扫码进展';
const B2_PREVIEW = '本机消息检索与待回复中轴（数据仅留本机不出公司）敬请期待';
const PRIVACY_BADGE = '仅记录本机脱敏操作，不含聊天正文';

// 黑板里约定的调用方顺序；黑板里多出来的调用方排在后面。
const CALLER_ORDER = ['assistant', 'avatar', 'phone', 'feedback', 'join', 'welink-ro', 'external'];
const CALLER_LABEL = { assistant: '公司助理', avatar: '数字分身', phone: '手机对话', feedback: '一键反馈', join: '一键入群', 'welink-ro': '会话只读工具', external: '其他外部组件' };
const CALLER_STATUS = {
  idle: { text: '空闲', tone: 'mute' }, ok: { text: '正常', tone: 'ok' }, running: { text: '调用中', tone: 'info' },
  rate_limited: { text: '被限流', tone: 'warn' }, auth_error: { text: '登录失效', tone: 'err' }, error: { text: '失败', tone: 'err' },
};
const EVENT_STATUS = {
  ok: { text: '正常', tone: 'ok' }, rate_limited: { text: '限流', tone: 'warn' }, auth_error: { text: '登录失效', tone: 'err' }, error: { text: '失败', tone: 'err' },
};
const AUTH_STATE = {
  online: { text: '已登录', tone: 'ok' }, needs_scan: { text: '需要扫码', tone: 'warn' }, desktop_unavailable: { text: '桌面端未连上', tone: 'warn' },
  account_mismatch: { text: '账号不一致', tone: 'warn' }, cli_missing: { text: '命令行未安装', tone: 'err' }, cli_outdated: { text: '命令行版本旧', tone: 'warn' },
  rate_limited: { text: '限流冷静中', tone: 'warn' }, network_error: { text: '网络不通', tone: 'err' }, signed_out: { text: '已退出登录', tone: 'warn' }, unknown: { text: '还没检测', tone: 'mute' },
};
const CLI_SOURCE = { managed: 'Hub 托管', npm: 'npm 全局', path: '系统 PATH', manual: '手动指定', missing: '未找到' };

// 自救条：每种异常一句人话 + 主按钮。主进程给了 advice 就用它的文字，没给的部分按这里补齐。
const ACTIONS = {
  'install-cli': { label: '一键安装', channel: 'install-cli' },
  'upgrade-cli': { label: '一键升级', channel: 'install-cli', payload: { upgrade: true } },
  'find-cli': { label: '重新扫描', channel: 'find-cli' },
  'start-login': { label: '扫码登录', channel: 'start-login' },
  'restart-login': { label: '重新生成二维码', channel: 'start-login', payload: { restart: true } },
  refresh: { label: '重新检测', channel: 'refresh' },
  'clear-cooldown': { label: '不等了，立即重试', channel: 'clear-cooldown', confirm: 'cooldown' },
};
const ACTION_ALIAS = { install: 'install-cli', upgrade: 'upgrade-cli', 'find': 'find-cli', rescan: 'find-cli', login: 'start-login', scan: 'start-login', 'scan-login': 'start-login', retry: 'refresh', recheck: 'refresh', detect: 'refresh', 'clear-cooldown': 'clear-cooldown', cooldown: 'clear-cooldown' };
const ADVICE = {
  cli_missing: { tone: 'err', title: '本机还没装 WeLink 命令行', detail: '装好后助理、分身、入群等功能才能读写 WeLink', primary: 'install-cli', secondary: 'find-cli' },
  cli_outdated: { tone: 'warn', title: 'WeLink 命令行版本偏旧', detail: '旧版容易掉登录或被限流，建议升级', primary: 'upgrade-cli', secondary: 'find-cli' },
  proxy_auth: { tone: 'err', title: '下载被代理拦下（407 需要代理认证）', detail: '检查代理账号是否已登录，再点重试', primary: 'install-cli', secondary: 'refresh', primaryLabel: '重试安装' },
  proxy_timeout: { tone: 'err', title: '下载超时（504 代理网关超时）', detail: '确认连着公司网络，稍后重试', primary: 'install-cli', secondary: 'refresh', primaryLabel: '重试安装' },
  proxy: { tone: 'err', title: '下载经过代理时失败', detail: '检查代理设置后重试', primary: 'install-cli', secondary: 'refresh', primaryLabel: '重试安装' },
  needs_scan: { tone: 'warn', title: 'WeLink 登录已失效，需要扫码', detail: '用手机 WeLink 扫码即可恢复', primary: 'start-login', redZone: true },
  signed_out: { tone: 'warn', title: '已退出 WeLink 登录', detail: '扫码登录后各功能自动恢复', primary: 'start-login', redZone: true },
  desktop_unavailable: { tone: 'warn', title: '没连上 WeLink 桌面端', detail: '打开并登录 WeLink 桌面端后点重新检测', primary: 'refresh' },
  account_mismatch: { tone: 'warn', title: '命令行与桌面端登录的不是同一个账号', detail: '在桌面端切到同一账号，或重新扫码', primary: 'refresh', secondary: 'start-login', secondaryLabel: '换号扫码' },
  rate_limited: { tone: 'warn', title: 'WeLink 限流，本机正在冷静等待', detail: '倒计时结束自动恢复，不用操作', primary: 'refresh', secondary: 'clear-cooldown', secondaryLabel: '不等了，立即重试' },
  network_error: { tone: 'err', title: '暂时连不上 WeLink 服务', detail: '确认网络后重试', primary: 'refresh', primaryLabel: '重试' },
};
const ADVICE_ALIAS = { proxy_407: 'proxy_auth', proxy_504: 'proxy_timeout', proxy_error: 'proxy', cooldown: 'rate_limited', login: 'needs_scan', scan: 'needs_scan', desktop: 'desktop_unavailable', mismatch: 'account_mismatch', network: 'network_error', outdated: 'cli_outdated', missing: 'cli_missing' };

function normAction(a, fallbackLabel) {
  if (!a) return null;
  const raw = typeof a === 'string' ? a : (a.action || a.id || a.kind || '');
  const id = ACTIONS[raw] ? raw : (ACTION_ALIAS[raw] || '');
  if (!id) return null;
  const label = (typeof a === 'object' && a.label) || fallbackLabel || ACTIONS[id].label;
  return { id, label: String(label) };
}

// 倒计时：优先按黑板的绝对时间 cooldown.until 算；没有就用快照里的剩余秒数减去收到快照后过去的时间。
function cooldownLeft(snap, now, receivedAt) {
  const until = Number(snap && snap.cooldown && snap.cooldown.until) || 0;
  if (until > 0) return Math.max(0, Math.ceil((until - now) / 1000));
  const sec = Number(snap && snap.cooldownRemainingSec) || 0;
  if (sec <= 0) return 0;
  const passed = receivedAt ? Math.floor(Math.max(0, now - receivedAt) / 1000) : 0;
  return Math.max(0, sec - passed);
}

function adviceOf(snap, left) {
  const a = snap.advice && typeof snap.advice === 'object' ? snap.advice : null;
  const authState = (snap.auth && snap.auth.state) || '';
  let kind = a ? String(a.kind || '') : '';
  kind = ADVICE[kind] ? kind : (ADVICE_ALIAS[kind] || kind);
  if (!kind) {
    if (left > 0) kind = 'rate_limited';
    else if (ADVICE[authState] && authState !== 'rate_limited') kind = authState;
    else if (snap.cli && (snap.cli.source === 'missing' || (!snap.cli.path && snap.cli.checkedAt))) kind = 'cli_missing';
    else if (snap.cli && snap.cli.outdated) kind = 'cli_outdated';
  }
  // 冷却已经数完、主进程还没来得及推新快照：不再显示限流条。
  if (kind === 'rate_limited' && left <= 0 && !(a && a.kind && a.kind !== 'rate_limited')) return null;
  const base = ADVICE[kind];
  if (!base && !a) return null;
  const b = base || { tone: 'warn', title: '', detail: '', primary: 'refresh' };
  const primary = normAction(a && a.primaryAction, b.primaryLabel) || normAction(b.primary, b.primaryLabel);
  const secondary = normAction(a && a.secondaryAction, b.secondaryLabel) || normAction(b.secondary, b.secondaryLabel);
  const install = snap.installFlow && typeof snap.installFlow === 'object' ? snap.installFlow : null;
  // 红区提示只跟扫码有关：主进程对每种异常都附了这句，这里只在需要扫码时显示，文字统一成一行短句，原句放悬停。
  const scanRelated = !!b.redZone || (primary && primary.id === 'start-login' && kind !== 'desktop_unavailable');
  const redZone = scanRelated ? RED_ZONE_NOTE : '';
  const redZoneTip = scanRelated && a && a.redZoneNote ? String(a.redZoneNote) : '';
  return {
    kind: kind || 'other', tone: (a && a.tone) || b.tone,
    title: String((a && a.title) || b.title || '状态异常'), detail: String((a && a.detail) || b.detail || ''),
    primary, secondary: secondary && primary && secondary.id === primary.id ? null : secondary,
    redZoneNote: redZone, redZoneTip,
    proxyHint: install && install.proxyHint ? String(install.proxyHint) : '',
    countdown: kind === 'rate_limited' ? left : 0,
  };
}

const LOGIN_STATUS = { waiting: '等待扫码', pending: '等待扫码', scanned: '已扫码，请在手机上确认', confirmed: '已确认，正在登录…', expired: '二维码已过期，点重新生成', failed: '这次没登录上，可以重新生成二维码' };
const SAFE_QR_DATA_URL = /^data:image\/(png|svg\+xml|jpeg)[;,]/i;
function loginOf(snap, hideLogin) {
  const f = snap.loginFlow && typeof snap.loginFlow === 'object' ? snap.loginFlow : null;
  if (!f || !f.active || hideLogin) return null;
  // 二维码只当图片显示（白名单 data: URL 的 <img>），兼容真实 data:image/svg+xml;base64,... 与原始 SVG。
  let qr = '';
  if (typeof f.qrSvg === 'string' && SAFE_QR_DATA_URL.test(f.qrSvg.trim())) qr = f.qrSvg.trim();
  else if (typeof f.qrSvg === 'string' && /^\s*<svg[\s>]/i.test(f.qrSvg)) qr = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(f.qrSvg);
  else if (typeof f.url === 'string' && SAFE_QR_DATA_URL.test(f.url.trim())) qr = f.url.trim();
  const raw = String(f.status || '');
  const status = LOGIN_STATUS[raw] || (/[一-鿿]/.test(raw) ? raw : '');
  return { qr, status, message: String(f.message || (qr ? '请用手机 WeLink 扫码' : '正在生成二维码…')), redZoneNote: RED_ZONE_NOTE };
}

function callersOf(snap) {
  const src = snap.callers && typeof snap.callers === 'object' ? snap.callers : {};
  const ids = [...CALLER_ORDER.filter(id => src[id]), ...Object.keys(src).filter(id => !CALLER_ORDER.includes(id))];
  const list = (ids.length ? ids : CALLER_ORDER).slice(0, 8).map(id => {
    const c = src[id] || {};
    const st = CALLER_STATUS[c.lastStatus] || CALLER_STATUS.idle;
    return {
      id, label: String(c.label || CALLER_LABEL[id] || id), external: c.kind === 'external',
      calls: Number(c.calls1h) || 0, ok: Number(c.ok1h) || 0, limited: Number(c.rateLimited1h) || 0, errors: Number(c.errors1h) || 0,
      last: hhmm(c.lastAt), status: st.text, tone: st.tone,
    };
  });
  const top = list.reduce((m, c) => Math.max(m, c.calls), 0);
  return list.map(c => ({ ...c, top: top > 0 && c.calls === top }));
}

function durationText(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} s`;
}

function eventsOf(snap, filter, page) {
  const all = (Array.isArray(snap.events) ? snap.events : []).filter(e => e && typeof e === 'object');
  const match = e => filter === 'all' || (filter === 'ok' ? e.status === 'ok' : filter === 'rate_limited' ? e.status === 'rate_limited' : e.status === 'auth_error' || e.status === 'error');
  const hit = all.filter(match);
  const pages = Math.max(1, Math.ceil(hit.length / PAGE_SIZE));
  const cur = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = hit.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE).map(e => {
    const st = EVENT_STATUS[e.status] || { text: String(e.status || '未知'), tone: 'mute' };
    return { id: String(e.id || ''), time: hhmmss(e.at), caller: String(e.callerLabel || CALLER_LABEL[e.caller] || e.caller || ''), command: String(e.command || ''), duration: durationText(e.durationMs), status: st.text, tone: st.tone, summary: String(e.summary || '') };
  });
  const counts = { all: all.length, ok: 0, rate_limited: 0, failed: 0 };
  for (const e of all) { if (e.status === 'ok') counts.ok++; else if (e.status === 'rate_limited') counts.rate_limited++; else if (e.status === 'auth_error' || e.status === 'error') counts.failed++; }
  return { rows, page: cur, pages, total: hit.length, counts, filter };
}

// 把快照整理成页面要显示的内容（纯函数，单测用）。uiState：tab、filter、page、confirmLogout、busy、err、now、receivedAt、feedback。
function viewModel(snapshot, uiState = {}) {
  const ui = uiState || {};
  const tab = TABS.some(t => t.id === ui.tab) ? ui.tab : 'overview';
  const filter = FILTERS.some(f => f.id === ui.filter) ? ui.filter : 'all';
  const base = { tab, filter, busy: ui.busy || '', err: ui.err || null, confirmLogout: !!ui.confirmLogout, confirmCooldown: !!ui.confirmCooldown, feedback: !!ui.feedback, copied: !!ui.copied };
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
  if (!snap) {
    return { ...base, available: false, health: 'unknown', dot: '', headline: ui.loading ? '正在读取公共黑板…' : '', loadError: String(ui.loadError || (ui.loading ? '' : '暂时读不到公共黑板')) };
  }
  const now = Number(ui.now) || Date.now();
  const left = cooldownLeft(snap, now, Number(ui.receivedAt) || 0);
  const auth = snap.auth || {}, cli = snap.cli || {};
  // 限流是全机的事，放在「限流与锁」一格；登录格照常显示登录本身（限流时仍是已登录）。
  const authInfo = auth.state === 'rate_limited' ? AUTH_STATE.online : (AUTH_STATE[auth.state] || AUTH_STATE.unknown);
  const advice = adviceOf(snap, left);
  let health = ['healthy', 'warning', 'error'].includes(snap.health) ? snap.health : (advice ? (advice.tone === 'err' ? 'error' : 'warning') : 'healthy');
  if (left > 0 && health === 'healthy') health = 'warning';
  const synced = hhmm(snap.lastSuccessAt || snap.updatedAt);
  let headline = left > 0 ? `限流冷静中 · 剩余 ${left} 秒` : health === 'healthy' ? '一切正常' : String(snap.headline || (advice ? advice.title : authInfo.text));
  if (left <= 0 && health === 'healthy' && synced && !/上次同步/.test(headline)) headline += ` · 上次同步 ${synced}`;
  const callers = callersOf(snap);
  const totals = callers.reduce((t, c) => ({ calls: t.calls + c.calls, ok: t.ok + c.ok, limited: t.limited + c.limited, errors: t.errors + c.errors }), { calls: 0, ok: 0, limited: 0, errors: 0 });
  const lock = snap.lockHolder && typeof snap.lockHolder === 'object' ? snap.lockHolder : null;
  const cliMissing = cli.source === 'missing' || !cli.path;
  const policy = snap.policy || {};
  return {
    ...base, available: true, health, dot: health === 'healthy' ? '' : (health === 'error' ? 'err' : 'warn'),
    isOnline: auth.state === 'online' || auth.state === 'rate_limited',
    headline, synced, advice, login: loginOf(snap, !!ui.hideLogin),
    installing: !!(snap.installFlow && snap.installFlow.running), installLine: snap.installFlow && snap.installFlow.running ? String(snap.installFlow.message || snap.installFlow.stage || '正在安装…') : '',
    cooldownLeft: left,
    metrics: {
      auth: { value: authInfo.text, tone: authInfo.tone, account: String(auth.accountLabel || ''), desktop: auth.desktopOnline === true ? '桌面端已连接' : auth.desktopOnline === false ? '桌面端未连接' : '桌面端未检测', desktopTone: auth.desktopOnline === true && !auth.desktopMismatch ? 'ok' : 'warn', mismatch: !!auth.desktopMismatch, reason: String(auth.reason || '') },
      cli: { value: cliMissing ? '未安装' : (cli.version ? 'v' + cli.version : '版本未知'), tone: cliMissing ? 'err' : cli.outdated ? 'warn' : 'ok', outdated: !!cli.outdated && !cliMissing, missing: cliMissing, min: String(cli.minRecommendedVersion || ''), source: CLI_SOURCE[cli.source] || String(cli.source || ''), path: String(cli.path || '') },
      limit: { value: left > 0 ? `冷却 ${left} 秒` : lock ? '使用中' : '空闲', tone: left > 0 ? 'warn' : lock ? 'info' : 'ok', holder: lock ? { label: String(CALLER_LABEL[lock.owner] || lock.owner || '某个调用方'), op: String(lock.op || ''), age: lock.ageSec != null ? Number(lock.ageSec) || 0 : null } : null, reason: left > 0 ? String((snap.cooldown && snap.cooldown.reason) || '') : '', consecutive: Number(snap.cooldown && snap.cooldown.consecutive) || 0, caller: left > 0 ? String(CALLER_LABEL[snap.cooldown && snap.cooldown.caller] || (snap.cooldown && snap.cooldown.caller) || '') : '' },
      calls: totals,
    },
    callers,
    events: eventsOf(snap, filter, ui.page),
    policy: { mode: policy.groupReadMode === 'conservative_30s' ? 'conservative_30s' : 'hotspot_first', conservativeSec: Number(policy.conservativeIntervalSec) || 30, hotspotSec: Number(policy.hotspotIntervalSec) || 10 },
    paths: { blackboard: String((snap.paths && snap.paths.blackboardFile) || ''), lock: String((snap.paths && snap.paths.lockFile) || '') },
    canLogout: auth.state !== 'signed_out' && auth.state !== 'cli_missing',
  };
}

const chip = (text, tone) => `<span class="wbb-chip ${esc(tone || 'mute')}">${esc(text)}</span>`;
const info = text => `<span class="wbb-info" tabindex="0" title="${esc(text)}" aria-label="${esc(text)}">ⓘ</span>`;
const btn = (label, act, { cls = '', payload = null, disabled = false, title = '' } = {}) => `<button type="button" class="wbb-btn ${cls}" data-wbb="${esc(act)}"${payload ? ` data-wbb-arg="${esc(JSON.stringify(payload))}"` : ''}${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
const actBtn = (a, cls, vm) => a ? btn(a.label, 'act:' + a.id, { cls, disabled: !!vm.busy || vm.installing }) : '';

// 出错位置的一行字：where 对应页面上的区域，只在那一处出现。
function errLine(vm, where) {
  const e = vm.err;
  if (!e || e.where !== where) return '';
  return `<div class="wbb-errline" role="alert"><span>${esc(e.text || '操作没完成')}</span>${e.retry ? btn('重试', e.retry, { cls: 's' }) : ''}${btn('知道了', 'dismiss-err', { cls: 's ghost' })}</div>`;
}

function headHtml(vm) {
  const tone = vm.cooldownLeft > 0 ? 'warn' : vm.dot || 'ok';
  const feedback = vm.feedback ? btn('反馈', 'feedback', { cls: 'ghost', title: '把这一页的状态附在反馈里一起发送' }) : '';
  const tabs = `<div class="wbb-tabs" role="tablist">${TABS.map(t => `<button type="button" role="tab" data-wbb-tab="${t.id}" aria-selected="${t.id === vm.tab}" class="${t.id === vm.tab ? 'on' : ''}">${esc(t.name)}${t.id === 'events' && vm.available && vm.events.counts.all ? `<em>${num(vm.events.counts.all)}</em>` : ''}</button>`).join('')}</div>`;
  return `<header class="wbb-head">
    <div class="wbb-title"><h1>WeLink 公共黑板<span class="wbb-beta">Beta</span></h1>${info('本机所有用到 WeLink 的功能共用这块黑板：同一时间只有一个调用方登录或扫码，遇到限流大家一起冷静，避免互相挤掉登录、刷爆额度。')}</div>
    <div class="wbb-status ${tone}"><i aria-hidden="true"></i><span data-slot="headline">${esc(vm.headline)}</span></div>
    ${vm.available ? tabs : ''}
    <div class="wbb-actions">${btn(vm.busy === 'refresh' ? '检测中…' : '刷新状态', 'act:refresh', { cls: 'ghost', disabled: !!vm.busy })}${vm.available && !vm.isOnline ? btn('扫码登录', 'act:start-login', { cls: 'ghost', disabled: !!vm.busy || vm.installing }) : ''}${feedback}</div>
  </header>${errLine(vm, 'head')}`;
}

function loginHtml(vm) {
  const l = vm.login;
  if (!l) return '';
  return `<div class="wbb-login">
    <div class="wbb-qr">${l.qr ? `<img src="${esc(l.qr)}" alt="WeLink 登录二维码" draggable="false">` : '<span class="wbb-qr-wait">生成中…</span>'}</div>
    <div class="wbb-login-side"><b>用手机 WeLink 扫一扫</b>${l.status ? `<span>${esc(l.status)}</span>` : ''}<span class="wbb-soft">${esc(l.redZoneNote)}</span>
    <div class="wbb-row">${btn('重新生成二维码', 'act:restart-login', { cls: 's', disabled: !!vm.busy })}${btn('扫完了，检测一下', 'act:refresh', { cls: 's ghost', disabled: !!vm.busy })}${btn('收起', 'login-dismiss', { cls: 's ghost' })}</div></div></div>`;
}

function adviceHtml(vm) {
  const a = vm.advice;
  if (vm.installing) return `<div class="wbb-advice info" role="status"><span class="wbb-spin" aria-hidden="true"></span><b data-i18n-skip>${esc(vm.installLine)}</b>${a && a.proxyHint ? `<span class="wbb-hint">${esc(a.proxyHint)}</span>` : ''}</div>${errLine(vm, 'advice')}`;
  if (!a) return errLine(vm, 'advice');
  const cd = a.countdown > 0 ? `<span class="wbb-cd" data-slot="cd">剩余 ${a.countdown} 秒</span>` : '';
  const detailText = !a.proxyHint && !a.redZoneNote && a.detail ? a.detail : '';
  return `<div class="wbb-advice ${esc(a.tone)}" role="status" data-kind="${esc(a.kind)}">
    <i class="wbb-adot" aria-hidden="true"></i><b>${esc(a.title)}</b>${cd}
    ${detailText ? `<span class="wbb-soft" title="${esc(detailText)}">${esc(detailText)}</span>` : ''}
    ${a.proxyHint ? `<span class="wbb-hint" title="${esc(a.proxyHint)}">${esc(a.proxyHint)}</span>` : ''}
    ${a.redZoneNote && !vm.login ? `<span class="wbb-soft"${a.redZoneTip ? ` title="${esc(a.redZoneTip)}"` : ''}>${esc(a.redZoneNote)}</span>` : ''}
    <span class="wbb-advice-btns">${actBtn(a.secondary, 'ghost', vm)}${actBtn(a.primary, 'p', vm)}</span></div>${errLine(vm, 'advice')}`;
}

function metricsHtml(vm) {
  const m = vm.metrics;
  const card = (k, v, tone, sub, extra = '') => `<div class="wbb-metric"><div class="wbb-k">${k}</div><div class="wbb-v ${esc(tone)}">${v}</div><div class="wbb-sub">${sub}</div>${extra}</div>`;
  const auth = card('登录与账号', esc(m.auth.value), m.auth.tone,
    `${m.auth.account ? `<span data-i18n-skip>${esc(m.auth.account)}</span> · ` : ''}${chip(m.auth.mismatch ? '桌面端账号不一致' : m.auth.desktop, m.auth.mismatch ? 'warn' : m.auth.desktopTone)}`,
    `${m.auth.reason ? `<div class="wbb-sub soft" title="${esc(m.auth.reason)}">${esc(m.auth.reason)}</div>` : ''}${vm.isOnline ? `<button type="button" class="wbb-link" data-wbb="act:start-login"${vm.busy || vm.installing ? ' disabled' : ''}>换号扫码</button>` : ''}`);
  const cli = card('命令行版本', `${esc(m.cli.value)}${m.cli.outdated ? chip('旧版', 'warn') : ''}`, m.cli.tone,
    m.cli.missing ? '<span>本机没找到可用副本</span>' : `<span>${esc(m.cli.source)}</span>${m.cli.outdated && m.cli.min ? ` · <span>建议 ≥ v${esc(m.cli.min)}</span>` : ''}`,
    `${m.cli.path ? `<div class="wbb-sub soft wbb-path" data-i18n-skip title="${esc(m.cli.path)}">${esc(m.cli.path)}</div>` : ''}${m.cli.outdated || m.cli.missing ? `<button type="button" class="wbb-link" data-wbb="act:${m.cli.missing ? 'install-cli' : 'upgrade-cli'}"${vm.busy || vm.installing ? ' disabled' : ''}>${m.cli.missing ? '一键安装' : '一键升级'}</button>` : ''}`);
  const lim = card('限流与锁', `<span data-slot="limit">${esc(m.limit.value)}</span>`, m.limit.tone,
    m.limit.holder ? `<span>正在用：</span><span>${esc(m.limit.holder.label)}</span>${m.limit.holder.op ? ` · <span data-i18n-skip>${esc(m.limit.holder.op)}</span>` : ''}${m.limit.holder.age != null ? ` · <span>已占用 ${num(m.limit.holder.age)} 秒</span>` : ''}` : (vm.cooldownLeft > 0 ? `${m.limit.caller ? `<span>${esc(m.limit.caller)}</span> <span>触发</span>` : '<span>全机一起等待</span>'}${m.limit.consecutive > 1 ? ` · <span>连续 ${num(m.limit.consecutive)} 次</span>` : ''}` : '<span>当前没有调用方占用</span>'),
    m.limit.reason ? `<div class="wbb-sub soft" title="${esc(m.limit.reason)}">${esc(m.limit.reason)}</div>` : '');
  const c = m.calls;
  const calls = card('近 1 小时全机调用', num(c.calls), c.limited ? 'warn' : 'plain',
    `<span>成功 ${num(c.ok)}</span> · <span class="${c.limited ? 'warn' : ''}">被限流 ${num(c.limited)}</span>${c.errors ? ` · <span class="err">失败 ${num(c.errors)}</span>` : ''}`);
  return `<div class="wbb-metrics">${auth}${cli}${lim}${calls}</div>`;
}

function callersHtml(vm) {
  const cards = vm.callers.map(c => `<div class="wbb-caller${c.top ? ' top' : ''}" data-caller="${esc(c.id)}">
      <div class="wbb-caller-h"><b>${esc(c.label)}</b>${c.external ? '<span class="wbb-kind">外部</span>' : ''}${chip(c.status, c.tone)}</div>
      <div class="wbb-caller-n"><span class="n">${num(c.calls)}</span><span class="u">次</span>${c.top ? '<span class="wbb-top">用得最多</span>' : ''}</div>
      <div class="wbb-caller-s"><span>成功 ${num(c.ok)}</span><span class="${c.limited ? 'warn' : ''}">限流 ${num(c.limited)}</span><span class="${c.errors ? 'err' : ''}">失败 ${num(c.errors)}</span>${c.last ? `<span class="t">${esc(c.last)}</span>` : ''}</div></div>`).join('');
  return `<section class="wbb-card wbb-callers-card"><h3><span>全机调用方</span><span class="wbb-soft">近 1 小时</span>${info('每个用到 WeLink 的功能各自的调用次数和被限流次数；数字最大的那个最耗额度。')}</h3><div class="wbb-callers">${cards}</div></section>`;
}

function overviewHtml(vm) {
  return `${adviceHtml(vm)}${loginHtml(vm)}${metricsHtml(vm)}${callersHtml(vm)}`;
}

function eventsHtml(vm) {
  const ev = vm.events;
  const filters = `<div class="wbb-seg" role="group" aria-label="按结果筛选">${FILTERS.map(f => `<button type="button" data-wbb-filter="${f.id}" class="${f.id === ev.filter ? 'on' : ''}" aria-pressed="${f.id === ev.filter}">${esc(f.name)}<em>${num(ev.counts[f.id])}</em></button>`).join('')}</div>`;
  const bar = `<div class="wbb-evbar">${filters}<span class="wbb-privacy" title="${esc(PRIVACY_BADGE)}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>${esc(PRIVACY_BADGE)}</span>${btn('清空记录', 'act-clear-events', { cls: 's ghost', disabled: !!vm.busy || !ev.counts.all })}</div>`;
  const empty = ev.counts.all ? '这一类暂时没有记录' : '还没有调用记录，用到 WeLink 的功能调用一次后就会出现在这里';
  const rows = ev.rows.length ? ev.rows.map(r => `<tr><td class="t">${esc(r.time)}</td><td>${esc(r.caller)}</td><td class="cmd" data-i18n-skip title="${esc(r.command)}">${esc(r.command)}</td><td class="d">${esc(r.duration)}</td><td>${chip(r.status, r.tone)}</td><td class="sum" title="${esc(r.summary)}">${esc(r.summary)}</td></tr>`).join('') : `<tr class="wbb-empty-row"><td colspan="6">${esc(empty)}</td></tr>`;
  const pager = `<div class="wbb-pager">${btn('上一页', 'page-prev', { cls: 's ghost', disabled: ev.page <= 1 })}<span>第 ${ev.page}/${ev.pages} 页</span>${btn('下一页', 'page-next', { cls: 's ghost', disabled: ev.page >= ev.pages })}<span class="wbb-soft">共 ${num(ev.total)} 条 · 最多保留最近 30 条</span></div>`;
  return `${bar}${errLine(vm, 'events')}<section class="wbb-card wbb-table-card"><table class="wbb-table"><colgroup><col style="width:92px"><col style="width:128px"><col style="width:210px"><col style="width:84px"><col style="width:96px"><col></colgroup><thead><tr><th>时间</th><th>调用方</th><th>命令</th><th>耗时</th><th>结果</th><th>摘要</th></tr></thead><tbody>${rows}</tbody></table>${pager}</section>`;
}

function policyHtml(vm) {
  const p = vm.policy;
  const opt = (id, title, desc, tag) => `<button type="button" class="wbb-opt${p.mode === id ? ' on' : ''}" data-wbb-policy="${id}" role="radio" aria-checked="${p.mode === id}"${vm.busy ? ' disabled' : ''}><span class="wbb-radio" aria-hidden="true"></span><span class="wbb-opt-b"><b>${esc(title)}${tag ? `<span class="wbb-rec">${esc(tag)}</span>` : ''}</b><span>${esc(desc)}</span></span></button>`;
  const policy = `<section class="wbb-card"><h3><span>读群节流策略</span>${info('所有用到 WeLink 的功能共用这一档；改完立即对全机生效。')}</h3>
    <div class="wbb-opts" role="radiogroup" aria-label="读群节流策略">${opt('hotspot_first', '热点会话优先', `正在聊的会话和核心群约 ${p.hotspotSec} 秒查一次，其余群保守降频`, '推荐')}${opt('conservative_30s', `${p.conservativeSec} 秒保守模式`, `所有群统一按 ${p.conservativeSec} 秒间隔查询，最大限度减少限流`, '')}</div>${errLine(vm, 'policy')}</section>`;
  const tools = `<section class="wbb-card"><h3><span>工具与安全操作</span></h3>
    <div class="wbb-tools">
      <div class="wbb-tool"><b>重新扫描命令行</b><span>在本机查找所有副本，选用最高的可用版本</span>${btn(vm.busy === 'find-cli' ? '扫描中…' : '重新扫描', 'act:find-cli', { cls: 's', disabled: !!vm.busy || vm.installing })}</div>
      <div class="wbb-tool"><b>升级到最新版</b><span>${vm.metrics.cli.missing ? '本机还没装，点一下直接安装' : `当前版本 ${esc(vm.metrics.cli.value)}`}</span>${btn(vm.installing ? '安装中…' : (vm.metrics.cli.missing ? '一键安装' : '一键升级'), 'act:' + (vm.metrics.cli.missing ? 'install-cli' : 'upgrade-cli'), { cls: 's', disabled: !!vm.busy || vm.installing })}</div>
      <div class="wbb-tool"><b>安全退出登录</b><span>退出后各功能暂停读写 WeLink，扫码可恢复</span>${btn('退出登录', 'logout-ask', { cls: 's danger', disabled: !!vm.busy || !vm.canLogout })}</div>
    </div>${errLine(vm, 'tools')}</section>`;
  const local = `<section class="wbb-card"><h3><span>本机协作信息</span>${info('外部脚本或组件按约定读写这个文件即可加入公共黑板，共享登录、限流与锁。')}</h3>
    <div class="wbb-pathrow"><span class="k">黑板文件</span>${vm.paths.blackboard ? `<code data-i18n-skip title="${esc(vm.paths.blackboard)}">${esc(vm.paths.blackboard)}</code>` : '<code>主进程还没写出黑板文件</code>'}${btn(vm.copied ? '已复制' : '复制路径', 'copy-path', { cls: 's ghost', disabled: !vm.paths.blackboard })}</div>
    ${vm.paths.lock ? `<div class="wbb-pathrow"><span class="k">锁文件</span><code data-i18n-skip title="${esc(vm.paths.lock)}">${esc(vm.paths.lock)}</code></div>` : ''}
    <div class="wbb-b2"><span class="wbb-kind">下一步</span><span>${esc(B2_PREVIEW)}</span></div></section>`;
  return `<div class="wbb-policy-grid">${policy}${tools}</div>${local}`;
}

function confirmHtml(vm) {
  if (vm.confirmLogout) {
    return `<div class="wbb-mask" data-wbb="logout-cancel"><div class="wbb-dialog" role="alertdialog" aria-modal="true" aria-labelledby="wbb-dlg-t" data-wbb-stop>
      <b id="wbb-dlg-t">安全退出登录</b><p>${esc(LOGOUT_CONFIRM)}</p>
      <div class="wbb-row end">${btn('取消', 'logout-cancel', { cls: 'ghost' })}${btn(vm.busy === 'logout' ? '退出中…' : '确定退出', 'logout-confirm', { cls: 'danger-fill', disabled: vm.busy === 'logout' })}</div></div></div>`;
  }
  if (vm.confirmCooldown) {
    return `<div class="wbb-mask" data-wbb="cooldown-cancel"><div class="wbb-dialog" role="alertdialog" aria-modal="true" aria-labelledby="wbb-dlg-c" data-wbb-stop>
      <b id="wbb-dlg-c">确认立即重试</b><p>${esc(COOLDOWN_CONFIRM)}</p>
      <div class="wbb-row end">${btn('继续等待', 'cooldown-cancel', { cls: 'ghost' })}${btn(vm.busy === 'clear-cooldown' ? '处理中…' : '确定重试', 'cooldown-confirm', { cls: 'p', disabled: vm.busy === 'clear-cooldown' })}</div></div></div>`;
  }
  return '';
}

function pageHtml(vm) {
  const head = headHtml(vm);
  if (!vm.available) {
    const body = vm.loadError ? `<div class="wbb-emptybox"><b>${esc(vm.loadError)}</b><span>其他功能不受影响</span>${btn('重试', 'act:refresh', { cls: 'p' })}</div>` : '<div class="wbb-emptybox"><span>正在读取…</span></div>';
    return `<div class="wbb-root">${head}<div class="wbb-body">${body}</div></div>`;
  }
  const body = vm.tab === 'events' ? eventsHtml(vm) : vm.tab === 'policy' ? policyHtml(vm) : overviewHtml(vm);
  return `<div class="wbb-root" data-tab="${esc(vm.tab)}">${head}<div class="wbb-body">${body}</div>${confirmHtml(vm)}</div>`;
}

// 左栏圆点：正常不显示；warning 橙点，error 红点。
function dotOf(summary) {
  if (!summary || typeof summary !== 'object') return '';
  if (summary.health === 'error') return 'err';
  if (summary.health === 'warning' || Number(summary.cooldownRemainingSec) > 0) return 'warn';
  return '';
}

const RAIL_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M8 20h8M12 16.5V20M7.5 9h5M7.5 12h8"/></svg>';

function createWelinkBlackboardPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage = () => {} }) {
  let page = null, snap = null, receivedAt = 0, timer = null, reloadTimer = null, copiedTimer = null;
  const ui = { tab: 'overview', filter: 'all', page: 1, confirmLogout: false, confirmCooldown: false, hideLogin: false, busy: '', err: null, loading: false, loadError: '', copied: false };
  const invoke = (channel, payload) => ipcRenderer.invoke('welink-blackboard:' + channel, payload || {});
  const isOpen = () => !!page && !page.hidden;

  function nav() {
    let b = document.getElementById('btn-welink-blackboard');
    if (b) return b;
    const list = document.querySelector('#scene-rail .rail-navigation');
    if (!list) return null;
    b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-shell-nav'; b.id = 'btn-welink-blackboard';
    b.title = 'WeLink 公共黑板 Beta · 登录、限流与调用情况'; b.setAttribute('aria-label', 'WeLink 公共黑板 Beta'); b.setAttribute('aria-controls', 'welink-blackboard-page');
    b.innerHTML = `<i class="rail-beta" aria-hidden="true">Beta</i><span class="btn-icon" aria-hidden="true">${RAIL_ICON}</span><span class="btn-label">WeLink</span><em class="wbb-dot" hidden></em>`;
    const anchor = document.getElementById('btn-community') || document.getElementById('btn-company-forum');
    if (anchor && anchor.parentElement === list) anchor.after(b); else list.append(b);
    b.addEventListener('click', () => { if (isOpen()) close(); else void open(); });
    return b;
  }
  function paintDot(summary) {
    const d = nav()?.querySelector('.wbb-dot');
    if (!d) return;
    const tone = dotOf(summary);
    d.hidden = !tone;
    d.className = 'wbb-dot' + (tone ? ' ' + tone : '');
    const line = summary && summary.headline ? ' · ' + summary.headline : '';
    nav().title = 'WeLink 公共黑板 Beta' + (tone ? line || ' · 需要处理' : ' · 登录、限流与调用情况');
  }

  function build() {
    if (page) return;
    page = document.createElement('section');
    page.className = 'welink-blackboard-page'; page.id = 'welink-blackboard-page'; page.hidden = true; page.setAttribute('aria-label', 'WeLink 公共黑板');
    document.body.append(page);
    page.addEventListener('click', onClick);
    page.addEventListener('keydown', e => {
      if (e.key === 'Escape' && (ui.confirmLogout || ui.confirmCooldown)) { e.stopPropagation(); ui.confirmLogout = false; ui.confirmCooldown = false; render(); }
    });
    if (window.MutationObserver) new window.MutationObserver(() => {
      if (isOpen() && [...document.body.classList].some(c => c !== 'welink-blackboard-page-open' && /-page-open$/.test(c))) close();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  function onClick(event) {
    const t = event.target;
    const tab = t.closest('[data-wbb-tab]');
    if (tab) { ui.tab = tab.dataset.wbbTab; ui.err = null; render(); return; }
    const f = t.closest('[data-wbb-filter]');
    if (f) { ui.filter = f.dataset.wbbFilter; ui.page = 1; render(); return; }
    const pol = t.closest('[data-wbb-policy]');
    if (pol) { if (!pol.disabled) void setPolicy(pol.dataset.wbbPolicy); return; }
    const b = t.closest('[data-wbb]');
    if (!b || b.disabled) return;
    // 点到确认框里面（不是按钮）时不当作点遮罩
    if (b.classList.contains('wbb-mask') && t.closest('[data-wbb-stop]')) return;
    event.preventDefault();
    void action(b.dataset.wbb).catch(e => fail(String(b.dataset.wbb).startsWith('act:') ? whereOf(b.dataset.wbb.slice(4)) : 'head', e && e.message, null));
  }
  const whereOf = id => ui.tab === 'policy' ? 'tools' : ui.tab === 'events' ? 'events' : (snap ? 'advice' : 'head');
  function fail(where, text, retry) { ui.err = { where, text: text || '操作没完成，稍后再试', retry }; render(); }

  function accept(r) {
    if (r && r.ok !== false && r.snapshot && typeof r.snapshot === 'object') { snap = r.snapshot; receivedAt = Date.now(); paintDot(snap); }
    return r;
  }
  async function call(channel, payload, where, retry) {
    ui.busy = channel; ui.err = null; render();
    let r;
    try { r = await invoke(channel, payload); }
    catch (e) { r = { ok: false, error: /No handler/i.test(String(e && e.message)) ? '当前版本还没接上公共黑板服务' : String((e && e.message) || '操作没完成') }; }
    ui.busy = '';
    accept(r);
    if (!r || r.ok === false) { fail(where, (r && r.error) || '操作没完成，稍后再试', retry); return null; }
    render(); tick();
    return r;
  }

  async function action(name) {
    if (name.startsWith('act:')) {
      const id = name.slice(4), a = ACTIONS[id];
      if (!a) return;
      if (a.confirm === 'cooldown') { ui.confirmCooldown = true; ui.err = null; render(); page.querySelector('.wbb-dialog [data-wbb="cooldown-cancel"]')?.focus(); return; }
      const where = whereOf(id);
      if (a.channel === 'start-login') { ui.hideLogin = false; if (ui.tab !== 'overview') ui.tab = 'overview'; }
      await call(a.channel, a.payload, a.channel === 'start-login' ? 'advice' : where, name);
      return;
    }
    if (name === 'login-dismiss') { ui.hideLogin = true; render(); return; }
    if (name === 'cooldown-cancel') { ui.confirmCooldown = false; render(); return; }
    if (name === 'cooldown-confirm') {
      ui.confirmCooldown = false;
      await call('clear-cooldown', {}, 'advice', 'act:clear-cooldown');
      return;
    }
    if (name === 'act-clear-events') { await call('clear-events', {}, 'events', name); ui.page = 1; render(); return; }
    if (name === 'page-prev') { ui.page = Math.max(1, ui.page - 1); render(); return; }
    if (name === 'page-next') { ui.page += 1; render(); return; }
    if (name === 'dismiss-err') { ui.err = null; render(); return; }
    if (name === 'logout-ask') { ui.confirmLogout = true; ui.err = null; render(); page.querySelector('.wbb-dialog [data-wbb="logout-cancel"]')?.focus(); return; }
    if (name === 'logout-cancel') { ui.confirmLogout = false; render(); return; }
    if (name === 'logout-confirm') {
      ui.busy = 'logout'; render();
      let r;
      try { r = await invoke('logout', { confirmed: true }); } catch (e) { r = { ok: false, error: String((e && e.message) || '退出没完成') }; }
      ui.busy = ''; ui.confirmLogout = false;
      accept(r);
      if (!r || r.ok === false) { fail('tools', (r && r.error) || '退出没完成，稍后再试', 'logout-ask'); return; }
      if (r.warning) { fail('tools', r.warning, 'act:refresh'); return; }
      render(); return;
    }
    if (name === 'copy-path') {
      const text = snap && snap.paths && snap.paths.blackboardFile;
      if (!text) return;
      try { await window.navigator.clipboard.writeText(text); } catch { try { require('electron').clipboard.writeText(text); } catch { fail('tools', '复制没成功，可以手动选中路径复制', null); return; } }
      ui.copied = true; render();
      clearTimeout(copiedTimer); copiedTimer = setTimeout(() => { ui.copied = false; if (isOpen()) render(); }, 2000);
      return;
    }
    if (name === 'feedback') {
      const vm = viewModel(snap, { ...ui, now: Date.now(), receivedAt });
      window.__hubFeedback?.open?.({ description: `WeLink 公共黑板：${vm.headline}${vm.advice ? `（${vm.advice.title}）` : ''}` });
    }
  }

  async function setPolicy(mode) {
    if (!snap || (snap.policy && snap.policy.groupReadMode === mode)) return;
    const r = await call('update-policy', { groupReadMode: mode }, 'policy', null);
    if (r) showMessage(mode === 'conservative_30s' ? '已切到保守模式，全机生效' : '已切到热点会话优先，全机生效');
  }

  function render() {
    if (!page) return;
    const focusAct = document.activeElement && page.contains(document.activeElement) ? document.activeElement.getAttribute('data-wbb') || document.activeElement.getAttribute('data-wbb-tab') : null;
    page.innerHTML = pageHtml(viewModel(snap, { ...ui, now: Date.now(), receivedAt, feedback: !!(window.__hubFeedback && window.__hubFeedback.open) }));
    if (focusAct) page.querySelector(`[data-wbb="${focusAct}"],[data-wbb-tab="${focusAct}"]`)?.focus?.();
  }

  // 冷却倒计时：只在页面打开且冷却中时每秒改几处文字，不重画整页、不调主进程；数到 0 再取一次快照。
  function tick() {
    clearInterval(timer); timer = null;
    if (!isOpen() || !snap || cooldownLeft(snap, Date.now(), receivedAt) <= 0) return;
    timer = setInterval(() => {
      if (!isOpen()) { clearInterval(timer); timer = null; return; }
      const left = cooldownLeft(snap, Date.now(), receivedAt);
      if (left <= 0) { clearInterval(timer); timer = null; void load(); return; }
      for (const el of page.querySelectorAll('[data-slot="cd"]')) el.textContent = `剩余 ${left} 秒`;
      const lim = page.querySelector('[data-slot="limit"]'); if (lim) lim.textContent = `冷却 ${left} 秒`;
      const h = page.querySelector('[data-slot="headline"]'); if (h) h.textContent = `限流冷静中 · 剩余 ${left} 秒`;
    }, 1000);
  }

  async function load() {
    ui.loading = !snap; if (!snap) render();
    try {
      const r = await invoke('snapshot');
      if (r && r.ok !== false && r.snapshot) { accept(r); ui.loadError = ''; }
      else if (!snap) ui.loadError = (r && r.error) || '暂时读不到公共黑板';
    } catch (e) {
      if (!snap) ui.loadError = /No handler/i.test(String(e && e.message)) ? '当前版本还没接上公共黑板服务' : '暂时读不到公共黑板';
    }
    ui.loading = false;
    if (isOpen()) { render(); tick(); }
  }

  function place() {
    if (!isOpen()) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }
  const onResize = () => place();

  async function open() {
    build(); closeOtherPanels();
    for (const n of ['__communityHide', '__avatarHide', '__weclawHide', '__teamHide', '__cloudHide', '__profileHide', '__companyRoomsHide', '__companyMeetingHide', '__assistantHide', '__wirelessHide', '__companyAssistantHide', '__companyForumHide', '__companyPptHide', '__companyAttendanceHide', '__companyW3Hide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide', '__webSessionHide', '__webRoundtableHide']) { try { window[n]?.(); } catch { /* 别的页自己的收起出错不影响这里 */ } }
    // 每次打开都回到「总览与自救」首屏：异常时第一眼就能看到自救条。
    Object.assign(ui, { tab: 'overview', filter: 'all', page: 1, confirmLogout: false, confirmCooldown: false, hideLogin: false, err: null });
    page.hidden = false; document.body.classList.add('welink-blackboard-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    render();
    await load();
  }
  function close() {
    if (!isOpen()) return;
    page.hidden = true; ui.confirmLogout = false; ui.confirmCooldown = false; ui.hideLogin = false; ui.err = null;
    document.body.classList.remove('welink-blackboard-page-open');
    document.getElementById('btn-welink-blackboard')?.classList.remove('active');
    window.removeEventListener('resize', onResize);
    clearInterval(timer); timer = null;
    clearTimeout(reloadTimer); reloadTimer = null;
    clearTimeout(copiedTimer); copiedTimer = null;
  }

  nav();
  document.addEventListener('click', e => { if (isOpen() && e.target.closest && e.target.closest('#scene-rail button:not(#btn-welink-blackboard):not(#btn-theme):not(#btn-options)')) close(); });
  // 主进程只在黑板显著变化时推一条摘要：更新左栏圆点；页面开着就重取一次完整快照（合并 300ms 内的连发）。
  ipcRenderer.on?.('welink-blackboard:changed', (_e, s) => {
    paintDot(s);
    if (isOpen()) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => void load(), 300); }
  });
  setTimeout(() => { if (snap) return; invoke('snapshot').then(r => { if (r && r.ok !== false && r.snapshot && !snap) { snap = r.snapshot; receivedAt = Date.now(); paintDot(snap); } }).catch(() => {}); }, 1500);
  return { open, close, isOpen, _state: () => ({ ui: { ...ui }, snap }) };
}

module.exports = { createWelinkBlackboardPage, viewModel, pageHtml, dotOf, cooldownLeft, PAGE_SIZE, TABS, FILTERS, LOGOUT_CONFIRM, COOLDOWN_CONFIRM, RED_ZONE_NOTE };
