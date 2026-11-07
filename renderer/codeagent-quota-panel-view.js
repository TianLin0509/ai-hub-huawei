'use strict';

const { accountState, pauseReason } = require('./codeagent-account-state');
const { durationMinutes } = require('../core/codeagent-usage-menu');
const { tokenUsage, TOKEN_DANGER_PERCENT } = require('./codeagent-quota-bar');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = value => Math.max(0, Math.min(100, value));
const BUCKETS = { busyDay: ['busyDay', '今日忙时', '忙时'], idleDay: ['idleDay', '闲时'], monthly: ['monthly', '月度'] };
const LABELS = { busyDay: '今日忙时', idleDay: '闲时', monthly: '月度' };
const fmt = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });

function readTime(at, now = Date.now()) {
  if (!(number(at) > 0)) return '';
  const date = new Date(Number(at) + 8 * 3600000).toISOString();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  return date.slice(0, 10) === today ? date.slice(11, 16) : date.slice(5, 16).replace('T', ' ');
}

function metric(row, bucket) {
  const usage = row.credit?.[bucket];
  const stats = row.creditReading;
  const usedPct = number(usage?.pct);
  const statsPct = stats && BUCKETS[bucket].includes(stats.bucket) ? number(stats.pct) : null;
  const usageAt = number(row.creditAt) || 0, statsAt = number(row.creditReadingAt) || 0;
  if (statsPct !== null && (usedPct === null || statsAt >= usageAt)) {
    return { pct: clamp(statsPct), remaining: number(stats.remaining), total: number(stats.total), at: statsAt, source: 'stats' };
  }
  if (usedPct === null) return null;
  const total = number(usage.total), used = number(usage.used);
  return { pct: clamp(100 - usedPct), remaining: total !== null && used !== null ? Math.max(0, total - used) : null,
    total, at: usageAt, source: 'usage' };
}

// 主数字：这个号当前模型的 Token 今日剩余（2026-11-05 用户定）。Credit 总额很大、比例长期接近 100%，只放悬停。
// CodeAgent 不给重置时间（公司真机 Q-1105-04，1.2615.02.03 缓存里没有任何 reset 字段），只能按自然日、整点、整分推断读数还算不算当前窗口：
// 昨天的读数不当今天的显示，上一个小时、上一分钟的读数不用来报警。旧缓存没有 modelsAt 时用 at。
function tokenMetric(account, currentModel, now = Date.now()) {
  const token = tokenUsage(account.usage, currentModel || account.defaultModel || '');
  if (!token) return null;
  const at = number(account.usage?.modelsAt) || number(account.usage?.at) || 0;
  const stamp = ms => new Date(ms + 8 * 3600000).toISOString();
  const same = length => at > 0 && stamp(at).slice(0, length) === stamp(now).slice(0, length);
  const fresh = { day: same(10), hour: same(13), min: same(16) };
  const warning = [['hour', '小时窗'], ['min', '分钟窗']]
    .map(([window, label]) => ({ window, label, pct: token.periods[window] }))
    .filter(item => fresh[item.window] && Number.isFinite(item.pct) && item.pct >= TOKEN_DANGER_PERCENT)
    .sort((a, b) => b.pct - a.pct)[0] || null;
  const model = account.usage?.models?.find(item => item.name === token.name) || null;
  return { pct: fresh.day ? clamp(100 - token.pct) : null, expired: !fresh.day, name: token.name, warning, periods: token.periods, fresh, at,
    windows: { day: model?.day || null, hour: model?.hour || null, min: model?.min || null } };
}
// 向下取整：用过一点就不显示 100%；还有余量时至少显示 1%，只有真的用完才写「用完」。
const wholePct = pct => (pct > 0 ? Math.max(1, Math.floor(pct)) : 0);
// 今日 / 1 小时 / 1 分钟三档剩余（2026-11-07 用户：不要只显示今日）。口径同今日：剩余百分比，≤20% 琥珀，0 写「用完」；
// 读不到写「—」；不在当前窗口（上一小时、上一分钟的读数）置灰，不报警。
const WINDOWS = [['day', '今日', '今日'], ['hour', '1 小时', '时'], ['min', '1 分钟', '分']];
function tokenWindows(token) {
  if (!token) return [];
  return WINDOWS.map(([key, label, short]) => {
    const used = token.periods?.[key];
    if (!Number.isFinite(used)) return { key, label, short, pct: null, text: '—', level: 'none', title: `${label}：未读取（CodeAgent 这次没给这一档的用量）` };
    const pct = clamp(100 - used), whole = wholePct(pct), fresh = !!token.fresh?.[key];
    const text = whole === 0 ? '用完' : `${whole}%`;
    if (!fresh) return { key, label, short, pct, text, level: 'stale', title: `${label}：上次读数剩 ${whole}%，这一轮可能已重置（按整天、整点、整分钟估算）` };
    return { key, label, short, pct, text, level: whole === 0 ? 'out' : whole <= 20 ? 'low' : '', title: `${label}：剩 ${whole}%` };
  });
}

function idleView(rows, now) {
  const source = rows.filter(row => row.credit && (row.credit.idleDiscountActive || row.credit.idleDiscountIn || row.credit.idleDiscountUntil))
    .sort((a, b) => (b.creditAt || 0) - (a.creditAt || 0))[0];
  if (!source) return null;
  const credit = source.credit;
  const discount = credit.idleDiscount ? String(credit.idleDiscount).replace(/\s*折$/, ' 折') : '优惠';
  const minutes = durationMinutes(credit.idleDiscountIn);
  const until = number(credit.idleDiscountUntil) || (minutes !== null && source.creditAt ? source.creditAt + minutes * 60000 : 0);
  if (credit.idleDiscountActive || (until > 0 && now >= until)) return { active: true, text: `闲时 ${discount}进行中`, at: source.creditAt };
  if (!(until > now)) return null;
  const left = Math.ceil((until - now) / 60000), hours = Math.floor(left / 60);
  const time = hours ? `${hours} 时${left % 60 ? ` ${left % 60} 分` : ''}` : `${left} 分`;
  return { active: false, text: `闲时 ${discount}还有 ${time}`, at: source.creditAt };
}

function quotaView(snapshot, { now = Date.now(), currentAccountId = '', currentModel = '', loadingKeys = new Set(), installed } = {}) {
  const sharedDown = !!(snapshot?.shared && snapshot.connection && snapshot.connection !== 'online');
  // 不分个人和号池：个人账号排第一，和它相同或互相重复的号只算一个，没登录的个人账号不占位。
  const rows = (snapshot?.rows || []).map((account, index) => ({ account, index }))
    .filter(({ account }) => !account.sameAsPersonal && !account.duplicateOf && !(account.personal && account.present === false))
    .map(({ account, index }) => {
    const health = accountState(account, { personal: account.personal });
    const busy = metric(account, 'busyDay'), idle = metric(account, 'idleDay'), month = metric(account, 'monthly');
    const current = !!currentAccountId && account.id === currentAccountId;
    const token = tokenMetric(account, current ? currentModel : '', now);
    const loading = loadingKeys.has(account.id) || account.refresh?.status === 'in-flight';
    // 第二行（s1 样稿）：模型名 · 告警 · 读数时间；状态类的文字（暂停、需登录、读取失败）占模型名的位置。
    let detail = token?.name || '下次读取后显示', alert = '';
    let warning = false, windowAlert = false;
    if (sharedDown) { detail = snapshot.connection === 'revoked' ? '口令已撤销 · 上次读数' : '主机连接中断 · 上次读数'; warning = true; }
    else if (account.avoid) { detail = pauseReason(account.avoid, now); warning = true; }
    else if (!health.usable) { detail = health.detail || health.label; warning = true; }
    else if (loading) detail = '读取中…';
    else if (account.refresh?.status === 'failed' || account.refresh?.error) { detail = token || busy || month ? '读取失败，保留上次读数' : '读取失败，暂未读到额度'; warning = true; }
    else if (account.refresh?.status === 'disabled') detail = token || busy || month ? '暂未开启额度读取 · 显示上次读数' : '暂未开启额度读取';
    else if (token?.pct === 0) alert = '约 00:00 恢复';
    else if (token?.warning) { alert = `${token.warning.label} ${Math.round(token.warning.pct)}%`; windowAlert = true; }
    const at = token?.at || Math.max(busy?.at || 0, month?.at || 0);
    const name = account.personal ? '我的账号' : account.label || account.note || account.accountLabel || '未备注账号';
    const needsLogin = !sharedDown && account.state !== 'ready' && !account.avoid;
    return { ...account, name, token, busy, idle, month, at, current, loading, warning, detail, alert, windowAlert, needsLogin, statusLabel: sharedDown ? '主机离线' : health.label,
      usable: health.usable && !sharedDown, dim: sharedDown || !health.usable || token?.pct === 0 || busy?.pct === 0 || month?.pct === 0,
      avatar: account.personal ? '我' : [...name][0],
      tint: account.personal ? 'brand' : ['tint-room', 'tint-assist', 'tint-meet', 'tint-room', 'tint-forum'][(index - 1 + 5) % 5] };
  });
  return { rows, installed: snapshot?.shared ? true : installed, shared: !!snapshot?.shared, message: snapshot?.shared ? snapshot.message : '', visible: snapshot?.shared || rows.length > 1, total: rows.length, usable: rows.filter(row => row.usable).length,
    idle: idleView(snapshot?.rows || [], now), at: Math.max(0, ...rows.map(row => row.at)) };
}

const ICON_PATHS = {
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  fold: '<path d="m7 7 5 5-5 5m6-10 5 5-5 5"/>',
  unfold: '<path d="m11 7-5 5 5 5m6-10-5 5 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 3 3"/>',
  dockBottom: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 15h16M12 7v5m-2-2 2 2 2-2"/>',
  dockRight: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 4v16M8 12h4m-2-2 2 2-2 2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
function metricTitle(value, bucket, now) {
  if (!value) return `${LABELS[bucket]}：未读取`;
  const quantity = value.remaining !== null ? `剩 ${fmt(value.remaining)}${value.total !== null ? ` / ${fmt(value.total)}` : ''} · ` : '';
  return `${LABELS[bucket]}：${quantity}${Math.round(value.pct)}%${value.at ? ` · ${readTime(value.at, now)} 读取` : ' · 读取时间未记录'}`;
}
// 悬停：Token 三个窗口 + Credit 三档，都写明是剩余还是已用。
function tokenLines(token, now) {
  if (!token) return ['Token：未读取'];
  const used = (label, window) => `${label}${token.fresh[window] ? '' : '上次'}已用 ${Number.isFinite(token.periods[window]) ? `${Math.round(token.periods[window] * 10) / 10}%` : '未读取'}`;
  return [token.expired ? `${token.name} Token 今日未读取` : `${token.name} Token 今日剩余 ${wholePct(token.pct)}%`,
    [used('今日', 'day'), used('本小时', 'hour'), used('本分钟', 'min')].join(' · '),
    ...(token.fresh.min ? [] : ['这份读数可能已过时：CodeAgent 不告诉重置时间，按整天、整点、整分钟估算已经换了新一轮']),
    ...(token.at ? [`${readTime(token.at, now)} 读取`] : [])];
}
function quotaTitle(row, now) {
  return [...tokenLines(row.token, now), ...[['busyDay', row.busy], ['idleDay', row.idle], ['monthly', row.month]].filter(([, value]) => value)
    .map(([bucket, value]) => `Credit ${metricTitle(value, bucket, now)}`)].join('\n');
}
function capsule(row) {
  const token = row.token;
  if (row.needsLogin) return '<span class="qp-cap none" data-qp-bucket="token">需登录</span>';
  if (!token) return '<span class="qp-cap none" data-qp-bucket="token">未读取</span>';
  if (token.expired) return '<span class="qp-cap none" data-qp-bucket="token">待读取</span>';
  const pct = wholePct(token.pct), classes = pct === 0 ? ' out' : pct <= 20 ? ' low' : '';
  return `<span class="qp-cap${classes}" data-qp-bucket="token" style="--v:${token.pct}"><span>${pct === 0 ? '用完' : `${pct}%`}</span></span>`;
}
// 读数时间：今天的写时刻，超过 1 小时写「N 小时前」并标琥珀。
function readAge(at, now) {
  const hours = Math.floor((now - at) / 3600000);
  if (hours < 1) return { text: readTime(at, now), old: false };
  return { text: hours < 48 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`, old: true };
}
function windowsHtml(row) {
  if (row.needsLogin || !row.token) return '';
  const cells = tokenWindows(row.token).filter(item => item.key !== 'day').map(item =>
    `<span class="qp-win${item.level ? ` ${item.level}` : ''}" data-qp-window="${item.key}" aria-label="${esc(item.title)}"><i>${item.label}</i><span class="qp-mini"${item.pct !== null ? ` style="--v:${item.pct}"` : ''}><span>${esc(item.text)}</span></span></span>`);
  return `<div class="qp-wins">${cells.join('')}</div>`;
}
function rowHtml(row, now) {
  const first = row.warning ? `<span class="warn">${esc(row.detail)}</span>` : `<span>${esc(row.detail)}</span>`;
  // 小时窗、分钟窗告警由第三行的小胶囊变琥珀来表达；第二行再写「已用 86%」会和胶囊上的「剩 14%」打架。
  const alert = row.alert && !row.windowAlert ? `<span class="warn">${esc(row.alert)}</span>` : '';
  const showAt = row.at && !row.loading && !row.warning;
  const age = showAt ? readAge(row.at, now) : null;
  return `<div class="qp-row${row.current ? ' is-current' : ''}${row.dim ? ' dim' : ''}${row.loading ? ' is-loading' : ''}" data-qp-account="${esc(row.id)}" role="button" tabindex="0" aria-label="${esc(`打开账号页并定位到「${row.name}」`)}">
    <span class="qp-av" style="--av:var(--hw-${row.tint})">${esc(row.avatar)}</span><span class="qp-name"><span class="qp-name-text">${esc(row.name)}</span>${row.personal ? '<i class="qp-tag">个人</i>' : ''}</span>
    ${capsule(row)}
    <div class="qp-sub"${row.refresh?.error ? ` title="${esc(row.refresh.error)}"` : ''}>${first}${alert}${age ? `<span class="qp-at${age.old ? ' warn' : ''}">${esc(age.text)}</span>` : ''}</div>${windowsHtml(row)}</div>`;
}
// 悬停卡（s1 样稿）：三档 Token + Credit，一行一项；只有已用 ≥80% 的那档标琥珀；只写读取时间，不写没实现的行为。
function tipHtml(row, now) {
  const token = row.token, lines = [];
  const pctText = value => `${Math.round(value * 10) / 10}%`;
  const tokenRow = (label, window) => {
    const data = token.windows[window], pct = token.periods[window], fresh = token.fresh[window];
    if (!Number.isFinite(pct)) return `<div class="tk"><span>${label}</span><em>未读取</em><span></span></div>`;
    const right = !fresh ? `上次 ${pctText(pct)}` : window === 'day' ? `剩 ${wholePct(100 - pct)}%` : `已用 ${pctText(pct)}`;
    return `<div class="tk${fresh && pct >= TOKEN_DANGER_PERCENT ? ' warn' : ''}"><span>${label}</span><em>${esc(data?.used ?? '')}${data?.total ? ` / ${esc(data.total)}` : ''}</em><span>${right}</span></div>`;
  };
  if (token) lines.push(tokenRow('今日', 'day'), tokenRow('本小时', 'hour'), tokenRow('本分钟', 'min'));
  else lines.push('<div class="tk"><span>Token</span><em>未读取</em><span></span></div>');
  const credits = [['monthly', row.month], ['busyDay', row.busy], ['idleDay', row.idle]].filter(([, value]) => value);
  if (credits.length) lines.push('<hr>', ...credits.map(([bucket, value]) => `<div class="tk"><span>Credit ${LABELS[bucket]}</span><em>${value.remaining !== null ? `${fmt(value.remaining)}${value.total !== null ? ` / ${fmt(value.total)}` : ''}` : ''}</em><span>剩 ${wholePct(value.pct)}%</span></div>`));
  const notes = [row.at ? `${readTime(row.at, now)} 读取` : '', token && !token.fresh.min ? '这份读数可能已过时：CodeAgent 不告诉重置时间，按整天、整点、整分钟估算已经换了新一轮' : '', row.warning ? row.detail : ''].filter(Boolean);
  return `<b>${esc(row.name)}${token ? ` · ${esc(token.name)}` : ''}</b>${lines.join('')}${notes.map(text => `<p>${esc(text)}</p>`).join('')}`;
}
function ringHtml(row, now) {
  const cls = row.dim ? 'off' : !row.token || row.token.expired ? 'none' : row.token.pct <= 20 ? 'low' : '';
  const title = [row.name, quotaTitle(row, now), row.detail].join('\n');
  return `<button type="button" class="qp-ring ${cls}${row.current ? ' is-current' : ''}" data-qp-account="${esc(row.id)}" style="--v:${row.token?.pct || 0}" aria-label="${esc(title)}"><span class="qp-av" style="--av:var(--hw-${row.tint})">${esc(row.avatar)}</span></button>`;
}
// 底部状态栏形态（2026-11-07 用户）：极简一行「今日 62% · 时 80% · 分 95%」。多号时只放当前会话的号，没有就放最紧张的号，悬停看全部。
// 只有 1 个号时右侧栏不出现，这一行就是它的额度（不论位置怎么选）。
function tightest(row) {
  const fresh = tokenWindows(row.token).filter(item => item.pct !== null && item.level !== 'stale');
  return row.needsLogin || !row.token || row.token.expired || !fresh.length ? Infinity : Math.min(...fresh.map(item => item.pct));
}
function footerPick(view) {
  return view.rows.find(row => row.current) || view.rows.reduce((best, row) => (tightest(row) < tightest(best) ? row : best), view.rows[0]);
}
function footerLine(row) {
  const token = row.token;
  if (row.needsLogin || !token) return `${row.name}：${row.needsLogin ? '需登录' : '未读取'}`;
  return `${row.name}：${tokenWindows(token).map(item => `${item.label} ${item.key === 'day' && token.expired ? '待读取' : item.level === 'stale' ? `上次 ${item.text}` : item.text}`).join(' · ')}`;
}
function renderQuotaFooter(view, { now = Date.now() } = {}) {
  const row = footerPick(view);
  if (!row) return '';
  const token = row.token, pct = token && !token.expired ? wholePct(token.pct) : null;
  const today = row.needsLogin ? '需登录' : !token ? '未读取' : token.expired ? '待读取' : pct === 0 ? '用完' : `${pct}%`;
  const wins = row.needsLogin || !token ? [] : tokenWindows(token).filter(item => item.key !== 'day');
  const level = row.warning || row.alert || (pct !== null && pct <= 20) || wins.some(item => item.level === 'low' || item.level === 'out') ? ' low' : '';
  const others = view.rows.length - 1;
  const title = [view.rows.length > 1 ? `${view.usable}/${view.total} 个号可用` : '', ...view.rows.map(footerLine), row.warning ? row.detail : '',
    token && !token.fresh.min ? '读数可能已过时：CodeAgent 不告诉重置时间，按整天、整点、整分钟估算' : '', token?.at ? `${readTime(token.at, now)} 读取` : '', '点击打开账号页'].filter(Boolean).join('\n');
  const move = view.visible ? `<button type="button" class="qp-foot-move" data-qp-action="to-right" title="移回右侧额度栏" aria-label="把号池额度移回右侧栏">${icon('dockRight')}</button>` : '';
  // 「移回右侧」放在最左：额度项的悬停卡从右边弹出，放右边会被它盖住。
  return `<div class="qp-foot" role="group" aria-label="CodeAgent Token 剩余">${move}<button type="button" class="qp-foot-item${level}${row.current ? ' is-current' : ''}${row.dim ? ' dim' : ''}" data-qp-account="${esc(row.id)}" title="${esc(title)}">`
    + `<span class="qp-av" style="--av:var(--hw-${row.tint})">${esc(row.avatar)}</span><span class="qp-foot-name">${esc(row.name)}</span>`
    + `<span class="qp-foot-w${pct === 0 ? ' out' : pct !== null && pct <= 20 ? ' low' : pct === null ? ' none' : ''}" data-qp-window="day">今日 <b>${esc(today)}</b></span>${wins.map(item => `<span class="qp-foot-w${item.level ? ` ${item.level}` : ''}" data-qp-window="${item.key}">${item.short} <b>${esc(item.text)}</b></span>`).join('')}`
    + `${others > 0 ? `<span class="qp-foot-more">+${others}</span>` : ''}</button></div>`;
}
function renderQuota(view, { now = Date.now(), refreshing = false, loadingCount = 0, message = '' } = {}) {
  if (view.installed === false) return `<div class="qp-h"><h3>号池额度</h3><span class="sp"></span><button type="button" class="icon-btn qp-fold" data-qp-action="collapse" aria-label="收起额度栏">${icon('fold')}</button></div><div class="qp-note" role="status">CodeAgent 未安装</div><div class="qp-list"><div class="qp-empty">先安装 CodeAgent，再登录读取额度。</div></div><div class="qp-f"><button type="button" class="btn btn-ghost btn-sm" data-qp-action="install-guide">查看安装说明</button></div><div class="qp-rail"><button type="button" class="icon-btn" data-qp-action="expand" aria-label="展开号池额度">${icon('unfold')}</button><button type="button" class="icon-btn" data-qp-action="install-guide" title="CodeAgent 未安装 · 查看安装说明" aria-label="CodeAgent 未安装，查看安装说明">${icon('key')}</button></div>`;
  const note = refreshing ? (view.shared ? '正在同步主机额度…' : `正在读取 ${loadingCount} 个号…`) : message || view.message;
  return `<div class="qp-h"><h3>${view.shared ? '共享号池额度' : '号池额度'}</h3><span class="qp-n"><b>${view.usable}</b>/${view.total} 可用</span><span class="sp"></span>
    <button type="button" class="icon-btn qp-refresh" data-qp-action="refresh" title="刷新全部号的读数（同一个号 10 分钟内只读一次）" aria-label="刷新全部额度"${refreshing ? ' disabled' : ''}>${icon('refresh')}</button>
    <button type="button" class="icon-btn qp-move${view.total === 1 ? ' with-text' : ''}" data-qp-action="to-bottom" title="${view.total === 1 ? '只有 1 个号，放到底部状态栏更省地方' : '移到底部状态栏'}" aria-label="把号池额度移到底部状态栏">${icon('dockBottom')}${view.total === 1 ? '<span>移到底栏</span>' : ''}</button>
    <button type="button" class="icon-btn qp-fold" data-qp-action="collapse" title="收起成细栏" aria-label="收起额度栏">${icon('fold')}</button></div>
    ${note ? `<div class="qp-note" role="status"><i class="d"></i><span>${esc(note)}</span></div>` : ''}
    ${view.idle ? `<div class="qp-idle${view.idle.active ? ' on' : ''}" title="${esc(`按最近读数计算 · ${readTime(view.idle.at, now) || '读取时间未知'}`)}">${icon('clock')}<span>${esc(view.idle.text)}</span></div>` : ''}
    <div class="qp-cols"><span>账号 · 当前模型</span><span>今日 Token</span></div><div class="qp-list">${view.rows.map(row => rowHtml(row, now)).join('')}</div>
    <div class="qp-f"><button type="button" class="btn btn-ghost btn-sm" data-qp-action="accounts">${icon('key')}${view.shared ? '共享详情' : '打开账号页'}</button><small title="CodeAgent 不告诉重置时间，按整天估算">通常每日 00:00 重置</small></div>
    <div class="qp-rail"><button type="button" class="icon-btn" data-qp-action="expand" title="展开号池额度" aria-label="展开号池额度">${icon('unfold')}</button>
    <div class="qp-rail-sum"><b>${view.usable}</b>/${view.total}</div><span class="qp-rail-line"></span>${view.rows.map(row => ringHtml(row, now)).join('')}
    <span class="sp"></span><button type="button" class="icon-btn" data-qp-action="accounts" title="打开账号页" aria-label="打开账号页">${icon('key')}</button></div>`;
}

module.exports = { metric, tokenMetric, tokenWindows, footerPick, wholePct, idleView, quotaView, readTime, renderQuota, renderQuotaFooter, metricTitle, quotaTitle, tipHtml };
