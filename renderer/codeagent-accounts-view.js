'use strict';
const { accountState, canStartAccount, pauseReason, accountExpiry } = require('./codeagent-account-state');
const { icon } = require('./codeagent-accounts-icons');
const automaticQuota = false;
const scopedIcon = (name, size = 'sm') => icon(name, size).replace(/class="([^"]*)"/g, (_, names) => `class="${names.split(/\s+/).filter(Boolean).map(name => 'caa-' + name).join(' ')}"`);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const method = a => a.method === 'idaas' ? '账号密码登录' : a.method === 'devuc' ? '浏览器登录' : '';
const canImport = a => !a.isPersonal && !a.sameAsPersonal && !a.alreadyInPool && a.state === 'ready';
const hasCredit = a => a.credit?.pct != null && a.credit?.remaining != null && Number.isFinite(Number(a.credit.pct)) && Number.isFinite(Number(a.credit.remaining));
const button = (action, label, cls = 'btn btn-secondary', attrs = '', ico = '') => `<button type="button" class="${cls}" data-ca="${action}" ${attrs}>${ico ? icon(ico, 'sm') : ''}${label}</button>`;
const idAttr = id => `data-id="${esc(id)}"`;

function modelsCell(a, state) {
  if (state.probing?.has(a.id) || state.pool?.probing?.includes(a.id)) return '<div class="cell models-cell"><span class="shimmer w1"></span><div class="cell-sub probe-state"><span class="spin"></span>正在读取模型菜单 · 约 10–20 秒</div></div>';
  if (state.queue?.includes(a.id)) return '<div class="cell models-cell"><span class="shimmer w2"></span><div class="cell-sub">排队中</div></div>';
  if (a.state !== 'ready') return '<div class="cell models-cell"><span class="empty-val">登录后可获取</span></div>';
  const models = a.models || [], attrs = idAttr(a.id);
  const chip = models.length ? `<span class="chip" title="${esc(models[0])}">${esc(models[0])}</span>` : '';
  return `<div class="cell models-cell">${models.length ? `<div class="chips">${chip}${models.length > 1 ? `<span class="chip more" title="${esc(models.join('、'))}">+${models.length - 1}</span>` : ''}</div>` : '<span class="empty-val">未获取</span>'}<div class="cell-sub">${models.length ? `${clock(a.modelsProbedAt)} 获取 · ` : ''}${button('probe', models.length ? '重新获取' : '获取', 'link quiet', attrs)}${models.length ? '' : ' · 约 10–20 秒'}</div>${a.configNote ? `<div class="cell-sub warn" title="${esc(a.configNote)}">${esc(a.configNote)}</div>` : ''}</div>`;
}
function quotaCell(a, state = {}) {
  // 有 Token 读数时和额度栏同一口径（今日剩余）；Credit 比例长期接近 100%，只在没有 Token 读数时才用。
  const token = state.tokenFor?.(a);
  if (token) {
    const left = token.expired ? null : token.pct > 0 ? Math.max(1, Math.floor(token.pct)) : 0;
    const reading = left === null ? '<span class="empty-val">待读取</span>'
      : `<div class="meter"><span class="meter-bar${left < 20 ? ' low' : ''}"><i style="width:${left}%"></i></span><span class="meter-text num">今日剩 ${left}%</span></div>`;
    const sub = a.avoid ? pauseReason(a.avoid) : [token.name, token.at ? clock(token.at) + ' 读取' : ''].filter(Boolean).join(' · ');
    return `<div class="cell quota-cell">${reading}<div class="cell-sub${a.avoid ? ' warn' : ''}" title="${esc(sub)}">${esc(sub)}</div></div>`;
  }
  const credit = a.credit, valid = hasCredit(a);
  const pct = valid ? Math.max(0, Math.min(100, Number(credit.pct))) : 0;
  const reading = valid ? `<div class="meter"><span class="meter-bar${pct < 20 ? ' low' : ''}"><i style="width:${pct}%"></i></span><span class="meter-text num">剩 ${esc(credit.remaining)} · ${esc(credit.pct)}%</span></div>` : '<span class="empty-val">未读取</span>';
  return `<div class="cell quota-cell">${reading}<div class="cell-sub${a.avoid ? ' warn' : ''}" title="${esc(pauseReason(a.avoid))}">${esc(a.avoid ? pauseReason(a.avoid) : valid ? [credit.bucket || 'Credit 余量', credit.at ? clock(credit.at) + ' 读取' : ''].filter(Boolean).join(' · ') : automaticQuota ? '下次读取后显示' : '')}</div></div>`;
}
function menu(a, sub) {
  const attrs = idAttr(a.id);
  const pause = sub ? `<div class="menu submenu" role="menu" aria-label="暂停多久"><div class="menu-cap">暂停多久</div>${[1, 2, 4, 24].map(h => button('pause', `${h} 小时${h === 2 ? '<span class="hint">常用</span>' : ''}`, 'menu-item', `${attrs} data-hours="${h}" role="menuitem"`)).join('')}<div class="menu-sep"></div>${button('pause', '直到手动恢复', 'menu-item', `${attrs} role="menuitem"`)}</div>` : '';
  const availability = a.id === 'personal' && a.avoid ? button('resume', '<span class="grow">恢复使用</span>', 'menu-item', `${attrs} role="menuitem"`, 'play')
    : `<div class="pause-menu">${button('pause-menu', `<span class="grow">暂停使用</span>${icon('right', 'sm')}`, 'menu-item', `${attrs} role="menuitem" aria-haspopup="menu" aria-expanded="${!!sub}"`, 'pause')}${pause}</div>`;
  return `<div class="menu" role="menu" aria-label="账号操作">${button('probe', '<span class="grow">获取模型权限</span>', 'menu-item', `${attrs} role="menuitem"${a.state !== 'ready' ? ' disabled' : ''}`, 'layers')}${button('login', '<span class="grow">重新登录</span>', 'menu-item', `${attrs} role="menuitem"`, 'login')}${availability}${a.id !== 'personal' ? `<div class="menu-sep"></div>${button('remove', '<span class="grow">移出号池</span>', 'menu-item danger', `${attrs} role="menuitem"`, 'trash')}` : ''}</div>`;
}
function row(a, state) {
  const personal = a.id === 'personal', status = accountState(a, { personal }), attrs = idAttr(a.id), opened = state.menu === a.id;
  const missingPersonalCli = personal && state.installed === false;
  if (missingPersonalCli) Object.assign(status, { label: '未检测到 CodeAgent', tone: 'muted', detail: '重新检测后可检查登录' });
  const title = personal ? '我的个人账号' : a.note || '未备注账号';
  const expiry = accountExpiry(a);
  const detail = status.detail || a.credentialsNote || expiry.text;
  const primary = canStartAccount(a, { personal }) ? button('session', '用这个号新建会话', 'btn btn-soft', attrs, 'plus')
    : a.state === 'ready' && a.avoid ? button('resume', '恢复使用', 'btn btn-secondary', attrs, 'play')
    : a.state !== 'ready' ? button('login', '重新登录', 'btn btn-primary', attrs, 'login')
    : button('session', '不参与选号', 'btn btn-secondary', `${attrs} disabled`);
  return `<div class="row${status.usable ? '' : ' is-dim'}${a.avoid || a.state !== 'ready' ? ' has-warning' : ''}${opened ? ' menu-open' : ''}" data-ca-account="${esc(a.id)}"><div class="who"><span class="avatar${personal ? ' me' : ''}">${personal ? '我' : esc([...title][0])}</span><div class="who-text"><div class="who-name">${esc(title)}${personal ? '<span class="tag accent">默认</span>' : ''}</div><div class="who-id" title="${esc(a.accountLabel)}">${a.accountLabel ? `<span class="mono">${esc(a.accountLabel)}</span> · ${personal ? '自动挑号时最后才用' : esc(method(a))}` : missingPersonalCli ? '安装检测尚未通过' : '还没登录'}</div></div></div><div class="cell status-cell"><span class="pill ${status.tone === 'muted' ? 'mute' : status.tone}">${esc(status.label)}</span><div class="cell-sub${!status.detail && !a.credentialsNote && expiry.warning ? ' warn' : ''}" title="${esc(detail)}">${esc(detail)}</div></div>${state.showQuota ? quotaCell(a, state) : ''}${modelsCell(a, state)}<div class="sessions${a.activeSessions ? '' : ' zero'}">${Number(a.activeSessions) || 0}</div><div class="actions">${primary}${button('menu', icon('more'), 'btn btn-icon' + (opened ? ' on' : ''), `${attrs} aria-label="更多操作" aria-haspopup="menu" aria-expanded="${opened}"`)}${opened ? menu(a, state.sub) : ''}</div></div>`;
}
function empty(local) {
  return `<div class="empty"><div class="empty-art"><div class="c c1"><i></i><b></b></div><div class="c c2"><i></i><b></b></div><div class="c c3"><i></i><b></b></div><span class="plus">${icon('plus', 'sm')}</span></div><h3>号池里还没有账号</h3><p>个人账号登录后就能开始使用，不必添加号池。需要在多个账号间选择时，可由号主在这台电脑上完成登录，再在新建会话时选用。Hub 不保存密码。</p><div class="cta">${button('drawer', '添加号池账号', 'btn btn-primary', '', 'plus')}${button('drawer', `导入本机已登录的号<span class="tag">${local.filter(canImport).length}</span>`, 'btn btn-secondary', '', 'download')}</div><div class="steps-inline"><span><em>1</em>填一个备注，例如 张工</span><span><em>2</em>号主在弹出的窗口里登录一次</span><span><em>3</em>新建会话时选这个号</span></div></div>`;
}
function summary(accounts, state) {
  const usable = accounts.filter(a => accountState(a).usable), paused = accounts.filter(a => a.avoid), needs = accounts.filter(a => !accountState(a).usable && !a.avoid);
  const ratio = n => accounts.length ? n / accounts.length * 100 : 0;
  const probing = state.probing?.size || state.queue?.length;
  const pausedNote = paused.map(a => `${a.id === 'personal' ? '个人账号' : a.note || '未备注账号'} · ${pauseReason(a.avoid)}`).join('；');
  const needsLabel = needs.every(a => a.state !== 'ready') ? '需登录' : '其他待处理';
  const actions = accounts.length > 1 ? `<div class="hero-actions">${button('drawer', '添加号池账号', 'btn btn-primary', '', 'plus')}${button('drawer', '导入本机已登录的号', 'btn btn-secondary')}${button('probe-all', probing ? '获取中…' : '获取全部模型权限', 'btn btn-ghost', probing ? 'disabled' : '')}</div>` : '';
  return `<section class="summary pool-hero" aria-label="概览"><div class="hero-head"><span class="hero-icon">${icon('users')}</span><b>账号</b><span>新建会话选「自动挑号」时，会跳过暂停或需登录的号，个人账号最后用</span></div><div class="hero-numbers"><div class="stat-value">${usable.length}<small>个号可用，共 ${accounts.length} 个</small></div><div class="hero-sessions"><b>${accounts.reduce((n, a) => n + (Number(a.activeSessions) || 0), 0)}</b><span>个会话正在用号池</span></div></div><div><div class="seg-bar" aria-hidden="true"><i class="ok" style="width:${ratio(usable.length)}%"></i><i class="warn" style="width:${ratio(paused.length)}%"></i><i style="width:${ratio(needs.length)}%"></i></div><div class="legend"><span><i class="ok"></i>可用 ${usable.length}</span><span title="${esc(pausedNote)}"><i class="warn"></i>暂停中 ${paused.length}</span><span><i></i>${needsLabel} ${needs.length}</span></div></div>${actions}</section>`;
}
function drawer(state, local) {
  return `<div class="scrim" data-ca="close-drawer"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="添加号池账号"><div class="drawer-head"><div class="grow"><h2>添加号池账号</h2><p>号主在这台电脑上登录一次，之后新建会话就能选这个号。</p></div>${button('close-drawer', icon('x'), 'btn btn-icon', 'aria-label="关闭"')}</div><div class="drawer-body"><label class="field-label" for="ca-note">备注 · 这是谁的号</label><input id="ca-note" class="input" value="${esc(state.note)}" maxlength="24" placeholder="例如 张工"><div class="field-help">只在本机显示，方便你在列表和新建会话里认出来。</div><ol class="steps"><li class="cur"><em>1</em><div><b>点「打开登录窗口」</b><span>会弹出一个命令行窗口。</span></div></li><li><em>2</em><div><b>号主输入 W3 用户名和密码</b><span>Hub 不保存密码，只用本机这份登录凭证。</span></div></li><li><em>3</em><div><b>登录成功后自动出现在列表里</b><span>状态从「需登录」变成「可用」，不用手动刷新。</span></div></li></ol><div class="callout">${icon('alert', 'sm')}<div><b>号池里的号不要执行退出登录。</b>退出会注销服务器上的这次登录，所有用它的会话一起掉线。要停用请用「移出号池」，号主那边不受影响。</div></div><div class="divider-label">或者，导入本机已登录的号</div><div class="local">${local.length ? local.map(a => `<div class="local-row">${icon('folder')}<div class="grow"><div class="t mono">${esc(a.name)}</div><div class="s">${esc(a.accountLabel)} · ${esc(method(a))}</div></div>${canImport(a) ? button('import', '导入', 'btn btn-sm btn-secondary', `data-dir="${esc(a.dir)}"`) : `<span class="why">${a.isPersonal || a.sameAsPersonal ? '个人账号，不放进号池' : a.alreadyInPool ? '已在号池里' : '需重新登录'}</span>`}</div>`).join('') : '<div class="local-row">未发现本机可导入的账号</div>'}</div><div class="field-help">同一台电脑上已登录的号可以直接导入，不用重新登录。导入后别在原目录执行退出登录。</div></div><div class="drawer-foot">${button('close-drawer', '取消', 'btn btn-ghost')}${button('add', '打开登录窗口', 'btn btn-primary', state.busy ? 'disabled' : '', 'terminal')}</div></aside>`;
}
function renderAccounts(pool, state = {}) {
  const installation = state.installed === false ? `<div class="notice warn" role="status"><span class="grow">未检测到 CodeAgent，已有账号仍保留；检测通过后可登录或新建会话。</span>${button('check-install', '重新检测', 'btn btn-sm btn-secondary')}${button('install-guide', '查看安装说明', 'btn btn-sm btn-ghost')}</div>` : '';
  const local = state.local || [], personal = { ...(pool?.personal || {}), id: 'personal' };
  personal.state ||= personal.present ? 'ready' : 'login-required';
  const accounts = pool?.accounts || [], all = [personal, ...accounts];
  const showQuota = automaticQuota || all.some(hasCredit);
  const probing = state.probing?.size || state.queue?.length;
  const head = `<header class="page-head"><div><h1 class="page-title">账号</h1><p class="page-sub">CodeAgent 号池 · 按不同账号新建会话，复用更多额度</p></div><div class="head-actions">${button('refresh', '刷新会话数', 'btn btn-ghost', state.loading ? 'disabled' : '', 'refresh')}</div></header>`;
  const notice = state.message || (!pool ? '正在读取账号状态…' : pool.ok === false ? '账号状态读取失败：' + pool.error : '');
  const newLocal = local.filter(canImport);
  const importer = newLocal.length ? `<div class="notice"><span class="ico">${icon('download', 'sm')}</span><div class="grow">本机还有 ${newLocal.length} 个已登录的号没导入 <span class="muted">· ${esc(newLocal.map(a => a.name).join('、'))}</span></div>${button('drawer', '查看并导入', 'btn btn-sm btn-ghost')}</div>` : '';
  const progress = probing ? `<div class="notice"><span class="ico">${icon('layers', 'sm')}</span><div class="grow">正在后台获取模型权限 <span class="muted">· 每个号约 10–20 秒，只读模型菜单，不发消息、不耗额度</span></div><span class="num muted">${state.completed || 0} / ${state.total || 1}</span></div>` : importer;
  const rules = pool?.quotaRules;
  const foot = automaticQuota ? `<div class="footnote">${icon('info', 'sm')}<div><b>额度规则：</b>识别到额度用完或限流的报错、或 Credit 余量低于阈值时，这个号自动暂停；读不到恢复时间就 1 小时后再试，Credit 恢复后提前解除。也可以在「更多」里手动暂停。已在跑的会话不受影响。${rules ? `额度报错识别规则 ${Number(rules.count) || 0} 条${rules.file ? '，' + button('rules', '打开规则文件', 'link quiet') : ''}。${rules.errors?.length ? esc('规则错误：' + rules.errors.join('；')) : ''}` : ''}</div></div>` : '';
  const statusOf = a => accountState(a, { personal: a.id === 'personal' });
  const usable = all.filter(a => statusOf(a).usable).length;
  const filter = ['usable', 'needs'].includes(state.filter) ? state.filter : 'all';
  const visible = all.filter(a => filter === 'all' || statusOf(a).usable === (filter === 'usable'));
  const filters = [['all', '全部', all.length], ['usable', '可用', usable], ['needs', '需处理', all.length - usable]]
    .map(([value, label, count]) => button('filter', `${label} ${count}`, value === filter ? 'current' : '', `data-filter="${value}" aria-pressed="${filter === value}"`)).join('');
  const emptyFilter = `<div class="empty filter-empty" role="status"><h3>${filter === 'usable' ? '暂无可用的账号' : '没有需要处理的账号'}</h3><p>${filter === 'usable' ? '可以在全部账号里恢复暂停的账号或重新登录。' : '当前账号均可使用。'}</p>${button('filter', '查看全部账号', 'btn btn-secondary', 'data-filter="all"')}</div>`;
  const html = `<main class="main"><div class="page">${head}<div class="notice warn" role="status" aria-live="polite" ${notice ? '' : 'hidden'}>${esc(notice)}</div>${pool && pool.ok !== false ? `<div class="account-top">${summary(all, state)}</div>${progress}<section class="list${showQuota ? '' : ' no-quota'}" aria-label="账号列表"><div class="list-title group"><b>全部账号</b><div class="counts" role="group" aria-label="筛选账号">${filters}</div><span class="grow"></span>${showQuota ? '<span>额度为当前模型今日 Token 剩余</span>' : ''}</div><div class="list-head"><span>账号</span><span>状态</span>${showQuota ? '<span>额度</span>' : ''}<span>模型权限</span><span class="r">会话</span><span></span></div>${visible.length ? visible.map(a => row(a, { ...state, pool, showQuota })).join('') : emptyFilter}${!accounts.length && filter === 'all' ? empty(local) : ''}</section>${foot}` : ''}</div></main>${state.drawer ? drawer(state, local) : ''}`;
  // Namespace prototype classes so its controls cannot affect existing pages.
  const withInstallation = html.replace(head, head + installation);
  // Keep saved account rows and management controls visible when the CLI cannot be found.
  const available = state.installed === false ? withInstallation.replace(/<button\b[^>]*>/g, tag => /data-ca="(?:login|session|add|probe|probe-all|drawer)"/.test(tag) && !/\bdisabled\b/.test(tag) ? tag.replace(/>$/, ' disabled title="检测到 CodeAgent 后可使用">') : tag) : withInstallation;
  return available.replace(/class="([^"]*)"/g, (_, names) => `class="${names.split(/\s+/).filter(Boolean).map(name => 'caa-' + name).join(' ')}"`);
}
// blocked：这个号此刻可用、但这次选不了的原因（公司模型启动中心：号没有所选模型的权限）。
function renderAccountOption({ type, account = {}, available = 0, blocked = '' }) {
  if (type === 'manage') return `${scopedIcon('users')}<span>管理账号…</span>`;
  const personal = type === 'personal', status = accountState(account, { personal });
  const stop = blocked && status.usable ? String(blocked) : '';
  let avatar = `<span class="avatar${personal ? ' me' : ''}">${personal ? '我' : esc([...(account.note || '号')][0])}</span>`;
  let title = personal ? '个人账号' : esc(account.note || '未备注账号');
  let sub = [account.accountLabel, stop || (account.avoid ? pauseReason(account.avoid) : status.detail), hasCredit(account) ? `剩 ${account.credit.remaining} · ${account.credit.pct}%` : ''].filter(Boolean).join(' · ');
  let badge = stop ? '<span class="pill mute">无此模型</span>' : `<span class="pill ${status.tone === 'muted' ? 'mute' : status.tone}">${esc(status.label)}</span>`;
  let count = `<span class="meta num">${Number(account.activeSessions) || 0} 个会话</span>`;
  if (['auto', 'manual', 'manage'].includes(type)) {
    avatar = `<span class="auto-ico">${icon(type === 'auto' ? 'sparkle' : 'users', 'sm')}</span>`;
    title = { auto: '自动挑号', manual: '号池 · 手动选择', manage: '去「账号」页添加…' }[type];
    sub = { auto: '挑会话最少的可用号，跳过暂停或需登录的号，个人账号最后用', manual: '指定一个账号，整段会话固定使用', manage: '登录、导入或恢复使用账号' }[type];
    badge = type === 'manage' ? '' : `<span class="tag accent">可用 ${Number(available) || 0}</span>`; count = '';
  }
  return `${avatar}<span class="grow"><span class="t">${title}${badge}</span><span class="s">${esc(sub)}</span></span>${count}<span class="check">${icon('check', 'sm')}</span>`.replace(/class="([^"]*)"/g, (_, names) => `class="${names.split(/\s+/).filter(Boolean).map(name => 'caa-' + name).join(' ')}"`);
}
function renderAccountControl({ type, account = {}, available = 0 }) {
  const personal = type === 'personal', automatic = type === 'auto';
  const name = automatic ? '自动挑号' : personal ? '个人账号' : account.note || '未备注账号';
  const avatar = automatic ? `<span class="caa-auto-ico">${scopedIcon('sparkle')}</span>` : `<span class="caa-avatar${personal ? ' caa-me' : ''}">${personal ? '我' : esc([...name][0])}</span>`;
  const state = accountState(account, { personal });
  return `${avatar}<span class="caa-grow">${esc(name)}</span>${automatic ? `<span class="caa-control-note">可用 ${Number(available) || 0}</span>` : `<span class="caa-pill ${'caa-' + (state.tone === 'muted' ? 'mute' : state.tone)}">${esc(state.label)}</span>`}${scopedIcon('down')}`;
}

module.exports = { renderAccounts, renderAccountOption, renderAccountControl, canImport };
