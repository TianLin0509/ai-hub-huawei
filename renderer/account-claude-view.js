'use strict';
// 账号页 · Claude 页签（2026-11-01 用户选定 B「左列表·右详情」）。
// 左栏一行一个账号：状态点、名称、5h 剩余小条、出口；右栏只放选中的那个账号，或「出口与 VPS」，或新建四步。
// 新建四步（用户 2026-11-01 定的流程）：① 起名 + 选出口，建账号和 VPS 远程浏览器 → ② 填邮箱和辅助邮箱
// → ③ 在远程浏览器里打开邮箱 / 辅助邮箱 / Claude 官网并检测出口 → ④ 官方授权。
// 账号在第 ① 步就建好，所以中途离开再回来，未授权的账号可从「继续设置」接着走。
const { authLabel, authorizeButton, accountFormHtml, accountMenuHtml, loginEnvHtml, envOptionsHtml, mailboxHtml, exitCheckHtml, riskHtml, EXIT_STATE } = require('./account-workspace-view');
const accountRisk = require('./account-risk-state');

const EXITS_ID = '__exits';
const AUTHED = new Set(['authorized', 'signed_in', 'api_key']);
const STEPS = ['选出口', '填邮箱', '登录 Claude', '授权'];
const ROUTE_CROWDED = 3;

const idOf = c => c.profileId || 'default';
const claudeRows = state => (state?.clis || []).filter(c => c.kind === 'claude');
// 名称里的编号，用来给新账号起默认名「账号N」。
function nextLabel(rows) {
  const nums = rows.map(c => Number(/(\d+)/.exec(c.label || '')?.[1])).filter(Number.isFinite);
  return '账号' + ((nums.length ? Math.max(...nums) : rows.length) + 1);
}
function envRow(vps, c) { return (vps?.accounts || []).find(a => a.profileId === idOf(c)) || null; }
function routeOf(vps, ip) { return ip ? (vps?.routes || []).find(r => r.ip === ip) || null : null; }
function routeName(r) { return r ? (r.shared ? '共享出口' : r.name) : ''; }
function exitOf(exits, c) {
  return (exits?.list || []).find(e => (e.accounts || []).includes(c.label || idOf(c))) || null;
}
// 一个账号此刻要不要人处理：授权、登录环境、出口检查三处的问题，取最要紧的一个。
function statusOf(c, vps, exits) {
  if (accountRisk.active('claude', idOf(c))) return { tone: 'bad', text: '风控观察中' };
  if (c.state === 'expired') return { tone: 'warn', text: '需要重新授权' };
  if (!AUTHED.has(c.state)) return { tone: 'warn', text: '未授权' };
  const env = envRow(vps, c);
  if (env && env.envId && !env.consistent) return { tone: 'bad', text: '登录环境出口不一致' };
  const exit = exitOf(exits, c);
  if (exit && exit.state !== 'ok') { const t = EXIT_STATE[exit.state] || '异常'; return { tone: 'bad', text: t.startsWith('出口') ? t : '出口' + t }; }
  if (c.isDefault) return { tone: 'use', text: '用量中' };
  return { tone: 'ok', text: '' };
}
const pct = v => (v === null || v === undefined ? null : Math.round(v));
const countdown = (at, now) => {
  if (!Number.isFinite(at) || at <= now) return '';
  const m = Math.round((at - now) / 60000);
  return m < 60 ? m + ' 分钟后重置' : m < 1440 ? Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分后重置' : new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 重置';
};

function listHtml(rows, o, esc) {
  const { vps, exits, quota = {}, selected, filter, query = '', wizard } = o;
  const q = query.trim().toLocaleLowerCase();
  const items = rows.map(c => {
    const s = statusOf(c, vps, exits), env = envRow(vps, c), r = routeOf(vps, env?.runIp), qv = quota[idOf(c)];
    return { c, s, env, r, qv, hay: [c.label, c.account, env?.runIp, routeName(r)].join(' ').toLocaleLowerCase() };
  });
  const pending = items.filter(i => ['warn', 'bad'].includes(i.s.tone)).length;
  const shown = items.filter(i => (!q || i.hay.includes(q)) && (!filter || ['warn', 'bad'].includes(i.s.tone)));
  const item = i => {
    const id = idOf(i.c), remain = pct(i.qv?.remain5h);
    const sub = (['warn', 'bad'].includes(i.s.tone) ? `<em class="acb-warn">${esc(i.s.text)}</em> · ` : '') + esc(i.env?.runIp ? routeName(i.r) + ' · ' + i.env.runIp : (i.c.account || '账号未确认'));
    return `<button class="acb-item" data-ac="acb-select" data-profile="${esc(id)}" aria-selected="${selected === id && !wizard}"><span class="acb-dot ${i.s.tone}" aria-hidden="true"></span><span class="acb-name">${esc(i.c.label || id)}${i.c.isDefault ? '<span class="acb-use">用量中</span>' : ''}</span><span class="acb-mini" title="${esc(remain === null ? '5 小时额度：暂无数据' : '5 小时剩余 ' + remain + '%')}"><i style="width:${remain === null ? 0 : Math.max(remain, 2)}%"></i></span><span class="acb-sub">${sub}</span></button>`;
  };
  const draft = wizard && !wizard.profileId ? `<button class="acb-item" data-ac="acb-wizard" aria-selected="true"><span class="acb-dot draft" aria-hidden="true"></span><span class="acb-name">${esc(wizard.value || '新账号')}</span><span></span><span class="acb-sub">新建中 · 第 ${wizard.step} / 4 步</span></button>` : '';
  const vpsOk = vps && vps.enabled !== false;
  return `<aside class="acb-list" aria-label="Claude 账号列表"><div class="acb-list-head"><button class="ac-open acb-new" data-ac="acb-new">＋ 新建账号</button><button class="ac-btn acb-filter" data-ac="acb-filter" aria-pressed="${!!filter}">${filter ? '显示全部' : '待处理 ' + pending}</button></div>
    <div class="acb-items" role="listbox" aria-label="账号">${draft}${shown.map(item).join('') || '<p class="acb-empty">没有匹配的账号</p>'}</div>
    <div class="acb-sec">基础设施</div>${vpsOk ? `<button class="acb-item" data-ac="acb-select" data-profile="${EXITS_ID}" aria-selected="${selected === EXITS_ID && !wizard}"><span class="acb-dot ${(exits?.list || []).some(e => e.state !== 'ok') ? 'bad' : 'ok'}" aria-hidden="true"></span><span class="acb-name">出口与 VPS</span><span></span><span class="acb-sub">${esc((vps.routes || []).length + ' 条出口 · ' + (vps.envs || []).length + ' 个远程浏览器')}</span></button>` : ''}
    <button class="ac-text-btn acb-import" data-ac="mail-import">导入邮箱资料</button><p class="ac-tool-help acb-hint" aria-label="Claude 用量账号说明">「使用此账号额度」只影响之后新建的会话；已有会话恢复、重启仍用原账号。</p></aside>`;
}

function quotaHtml(qv, now) {
  if (!qv || (qv.remain5h === null && qv.remain7d === null)) return '<section class="acb-sect"><h3>额度</h3><p class="ac-tool-help">还没有额度数据：这个账号在 Hub 里开过会话后，每 2 分钟自动读取一次。</p></section>';
  const bar = (name, v, at) => {
    const p = pct(v);
    return `<div class="acb-q"><div class="acb-q-top"><span>${name}</span><b>${p === null ? '—' : '剩余 ' + p + '%'}</b></div><div class="acb-bar"><i class="${p !== null && p < 15 ? 'bad' : p !== null && p <= 40 ? 'warn' : ''}" style="width:${p === null ? 0 : Math.max(p, 1)}%"></i></div><small>${countdown(at, now) || (p === 100 ? '未开始计时' : '')}</small></div>`;
  };
  return `<section class="acb-sect"><h3>额度</h3><div class="acb-quota">${bar('5 小时窗口', qv.remain5h, qv.reset5h)}${bar('7 天窗口', qv.remain7d, qv.reset7d)}</div></section>`;
}

// 本机 → VPS 线路 → 出口 IP → claude.ai，以及这个账号在「检测出口」里的那一行。
function exitHtml(c, o, esc) {
  const { vps, exits, edit } = o;
  const env = envRow(vps, c), r = routeOf(vps, env?.runIp), mine = exitOf(exits, c), id = idOf(c);
  const chain = env?.runIp ? `<div class="acb-chain"><span class="acb-hop"><small>本机</small>Hub</span><span class="acb-arr">加密隧道</span><span class="acb-hop"><small>线路</small>${esc(routeName(r) || '未登记线路')}</span><span class="acb-arr">出口</span><span class="acb-hop key"><small>出口 IP</small>${esc(env.runIp)}</span><span class="acb-arr"></span><span class="acb-hop"><small>目标</small>claude.ai</span></div>` : '';
  let check = '<p class="ac-tool-help">「检测出口」：经这个账号实际使用的本机通道连续请求 3 次，看出口 IP 是否与绑定一致、延迟多少。「看远程浏览器出口」会在该账号的远程浏览器里打开 IP 检测页。</p>';
  if (exits?.loading) check = '<p class="ac-tool-help" role="status">正在检测出口（每个出口连续请求 3 次，约 5–20 秒）…</p>';
  else if (exits?.error) check = `<p class="ac-item-error" role="alert">${esc('出口检测未完成：' + exits.error)}</p>`;
  else if (mine) {
    const ok = mine.state === 'ok';
    check = `<table class="acb-check" data-exit-state="${esc(mine.state)}"><tr><td>本机经此账号通道的最终出口</td><td>${esc(mine.ip || '—')} <span class="${ok ? 'acb-ok' : 'acb-bad'}">${ok ? '✓ 与绑定一致' : esc((EXIT_STATE[mine.state] || mine.state) + (mine.state === 'mismatch' ? '（应为 ' + mine.expected + '）' : ''))}</span></td></tr><tr><td>远程浏览器的出口</td><td>${env?.envId ? (env.consistent ? `${esc(env.runIp)} <span class="acb-ok">✓ 与运行出口一致</span>` : `<span class="acb-bad">${esc(env.problem || '不一致')}</span>`) : '还没有登录环境'}</td></tr><tr><td>经出口完整请求一次（3 次中位，含握手）</td><td>${mine.median == null ? '—' : esc((mine.median / 1000).toFixed(2) + ' 秒')}${mine.failed ? esc(' · 失败 ' + mine.failed + ' 次') : ''}</td></tr><tr><td>检测时间</td><td>${esc(new Date(exits.at).toLocaleTimeString())}</td></tr></table>`;
  }
  const canEnv = !!(env?.envId && env.consistent);
  return `<section class="acb-sect"><h3>出口与登录环境<span class="acb-h-actions"><button class="ac-btn acb-sm" data-ac="exit-check" ${exits?.loading ? 'disabled' : ''}>检测出口</button><button class="ac-btn acb-sm" data-ac="env-url" data-profile="${esc(id)}" data-page="ip" ${canEnv ? '' : 'disabled'}>看远程浏览器出口</button></span></h3>${chain}${loginEnvHtml(c, vps, esc, edit && edit.kind === 'claude' ? edit : null)}${check}</section>`;
}

function browserHtml(c, o, esc) {
  const env = envRow(o.vps, c), m = o.mail?.accounts?.[idOf(c)], id = esc(idOf(c));
  if (!o.vps || o.vps.enabled === false) return '';
  const can = !!(env?.envId && env.consistent);
  const why = can ? '' : ' title="这个账号还没有可用的登录环境"';
  return `<section class="acb-sect"><h3>远程浏览器</h3><div class="acb-btns"><button class="ac-btn" data-ac="mail-open" data-profile="${id}" data-which="main" ${can && m?.canOpen ? '' : 'disabled'}${why}>打开邮箱</button><button class="ac-btn" data-ac="mail-open" data-profile="${id}" data-which="recovery" ${can && m?.canOpenRecovery ? '' : 'disabled'} title="${m?.recoveryEmail && !m?.canOpenRecovery ? '这个辅助邮箱的网页版不在可打开名单里，请在远程浏览器地址栏输入' : ''}">打开辅助邮箱</button><button class="ac-open" data-ac="env-url" data-profile="${id}" data-page="claude" ${can ? '' : 'disabled'}${why}>打开 Claude 官网</button></div><p class="ac-tool-help">都在这个账号自己的 VPS 远程浏览器里打开，与 Claude 走同一个出口 IP。</p></section>`;
}

function detailHtml(c, o, esc) {
  const { edit, mail, now = Date.now() } = o, id = idOf(c);
  const editing = edit && edit.kind === 'claude' && edit.profileId === id && ['rename', 'remove'].includes(edit.mode);
  const authed = AUTHED.has(c.state);
  const resume = !authed ? `<p class="acb-resume">这个账号还没有完成授权。<button class="ac-text-btn" data-ac="acb-resume" data-profile="${esc(id)}">继续设置 →</button></p>` : '';
  return `<div class="acb-detail-in" data-account-profile="${esc(id)}"><div class="acb-head"><div><h2>${esc(c.label || id)}</h2><p>${esc(c.account || '账号未确认')}<span class="acb-tag ${authed ? 'ok' : 'warn'}">${authLabel(c.state)}</span>${c.isDefault ? '<span class="acb-tag use">当前用量账号</span>' : ''}</p></div><div class="ac-row-actions"><button class="ac-open" data-ac="claude-quota" data-profile="${esc(c.profileId)}" ${c.isDefault ? 'disabled aria-pressed="true"' : 'aria-pressed="false"'}>${c.isDefault ? '当前用量账号' : '使用此账号额度'}</button>${authorizeButton(c, esc)}${accountMenuHtml('claude', c, esc)}</div></div>${riskHtml('claude', c, esc, edit)}${editing ? accountFormHtml(edit, esc, c.label || id) : ''}${resume}
    ${quotaHtml(o.quota?.[id], now)}${exitHtml(c, o, esc)}${browserHtml(c, o, esc)}<section class="acb-sect acb-mail"><h3>邮箱资料</h3>${mailboxHtml(c, mail, esc, edit && edit.kind === 'claude' ? edit : null) || '<p class="ac-tool-help">邮箱资料读取中…</p>'}</section></div>`;
}

function exitsPageHtml(rows, o, esc) {
  const { vps, exits } = o;
  if (!vps || vps.enabled === false) return '<div class="acb-detail-in"><h2>出口与 VPS</h2><p class="ac-tool-help">本机没有配置 VPS 登录环境。</p></div>';
  if (vps.loading) return '<div class="acb-detail-in"><h2>出口与 VPS</h2><p class="ac-tool-help" role="status">正在读取 VPS（约 2–5 秒）…</p></div>';
  const bound = ip => rows.filter(c => envRow(vps, c)?.runIp === ip);
  const routes = (vps.routes || []).map(r => {
    const list = bound(r.ip), chk = (exits?.list || []).find(e => (e.ip || e.expected) === r.ip || e.expected === r.ip);
    return `<tr><td><b>${esc(routeName(r))}</b></td><td>${esc(r.ip)}</td><td>${chk ? `<span class="${chk.state === 'ok' ? 'acb-ok' : 'acb-bad'}">${esc(EXIT_STATE[chk.state] || chk.state)}</span>${chk.median == null ? '' : esc(' · ' + (chk.median / 1000).toFixed(2) + ' 秒')}` : '<span class="acb-faint">未检测</span>'}</td><td>${list.map(c => `<button class="ac-text-btn" data-ac="acb-select" data-profile="${esc(idOf(c))}">${esc(c.label || idOf(c))}</button>`).join(' ') || '<span class="acb-faint">无</span>'}${list.length > ROUTE_CROWDED ? ' <span class="acb-tag warn">偏多</span>' : ''}</td><td>${r.runnable ? '<span class="acb-ok">可用</span>' : '<span class="acb-faint">本机未接通</span>'}</td></tr>`;
  }).join('');
  const envs = (vps.envs || []).map(e => {
    const owner = rows.find(c => idOf(c) === e.boundTo);
    return `<tr><td>${esc(e.name)}</td><td>${esc(e.ip || '—')}</td><td>${owner ? esc(owner.label || e.boundTo) : '<span class="acb-faint">空闲</span>'}</td><td>${e.ready ? '<span class="acb-ok">就绪</span>' : '<span class="acb-faint">未就绪</span>'}</td></tr>`;
  }).join('');
  return `<div class="acb-detail-in"><div class="acb-head"><div><h2>出口与 VPS</h2><p>${esc((vps.routes || []).length + ' 条出口 · ' + (vps.envs || []).length + ' 个远程浏览器')}</p></div><div class="ac-row-actions"><button class="ac-open" data-ac="exit-check" ${exits?.loading ? 'disabled' : ''}>检测全部出口</button></div></div>
    ${vps.error ? `<p class="ac-item-error" role="alert">${esc('VPS 读取失败：' + vps.error)}</p>` : ''}${exitCheckHtml(exits, vps, esc)}
    <section class="acb-sect"><h3>出口线路</h3><table class="acb-table"><thead><tr><th>线路</th><th>出口 IP</th><th>检测</th><th>绑定账号</th><th>本机</th></tr></thead><tbody>${routes}</tbody></table><p class="ac-tool-help">${'一条出口绑的账号越多，被风控关联的可能越大；超过 ' + ROUTE_CROWDED + ' 个时标「偏多」，只提示不拦。'}</p></section>
    <section class="acb-sect"><h3>远程浏览器（VPS 登录环境）</h3><table class="acb-table"><thead><tr><th>名称</th><th>出口 IP</th><th>账号</th><th>状态</th></tr></thead><tbody>${envs || '<tr><td colspan="4" class="acb-faint">还没有</td></tr>'}</tbody></table></section></div>`;
}

function stepsHtml(step) {
  return `<ol class="acb-steps">${STEPS.map((t, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''}"><b>${i + 1 < step ? '✓' : i + 1}</b>${t}</li>`).join('')}</ol>`;
}
const mailField = (name, label, value, esc, type = 'text', placeholder = '') => `<label><span>${label}</span><input class="ac-account-input" data-wiz-field="${name}" type="${type}" autocomplete="off" spellcheck="false" maxlength="254" placeholder="${esc(placeholder)}" value="${esc(value || '')}"></label>`;

function wizardHtml(rows, o, esc) {
  const { wizard: w, vps, exits, mail, busy } = o;
  const err = w.error ? `<p class="ac-item-error" role="alert">${esc(w.error)}</p>` : '';
  const head = `<div class="acb-head"><div><h2>${esc(w.profileId ? (rows.find(c => idOf(c) === w.profileId)?.label || w.value) : '新建 ' + (w.value || 'Claude 账号'))}</h2><p>选出口 → 远程浏览器 → 登录 Claude → 授权</p></div></div>${stepsHtml(w.step)}`;
  if (w.step === 1) {
    if (!vps || vps.loading) return head + '<p class="ac-tool-help" role="status">正在读取 VPS 上的可用出口…</p>';
    // 本机没配 VPS 登录环境：和改版前一样只起名就建，出口沿用共享出口。
    if (vps.enabled === false) return head + `<div class="ac-account-form acb-wiz"><label><span>账号名称</span><input class="ac-account-input" data-account-input maxlength="40" spellcheck="false" value="${esc(w.value || '')}"></label>${err}<div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-cancel">取消</button><button class="ac-open" data-ac="acb-create" ${busy ? 'disabled' : ''}>创建账号</button></div><p class="ac-tool-help">本机没有配置 VPS 登录环境：新账号走共享出口，后面的远程浏览器按钮不可用。</p></div>`;
    if (vps.error) return head + `<p class="ac-item-error">${esc('VPS 读取失败：' + vps.error + '；读不到出口时不新建账号，请刷新后再试')}</p><div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-cancel">取消</button></div>`;
    const routes = (vps.routes || []).filter(r => r.runnable), route = routes.find(r => r.id === w.route);
    const list = routes.map(r => {
      const n = rows.filter(c => envRow(vps, c)?.runIp === r.ip).length, chk = (exits?.list || []).find(e => e.expected === r.ip || e.ip === r.ip);
      return `<button class="acb-route" role="radio" aria-checked="${w.route === r.id}" data-ac="acb-route" data-route="${esc(r.id)}"><span class="acb-radio" aria-hidden="true"></span><b>${esc(routeName(r))}</b><span>${esc(r.ip)}</span><span>${chk?.median == null ? '' : esc((chk.median / 1000).toFixed(2) + ' 秒')}</span><span>${n} 个账号</span><span>${n >= ROUTE_CROWDED ? '<span class="acb-tag warn">已偏多</span>' : '<span class="acb-tag ok">可用</span>'}</span></button>`;
    }).join('');
    return head + `<div class="ac-account-form acb-wiz"><label><span>账号名称</span><input class="ac-account-input" data-account-input maxlength="40" spellcheck="false" value="${esc(w.value || '')}"></label>
      <p class="acb-label">出口（建好后不再更换：网页登录、官方授权、日常 Claude 都走这个 IP）<button class="ac-text-btn" data-ac="exit-check" ${exits?.loading ? 'disabled' : ''}>${exits?.loading ? '测速中…' : '测各出口延迟'}</button></p><div class="acb-routes" role="radiogroup">${list || '<p class="ac-item-error">没有接到本机的出口</p>'}</div>
      ${route ? `<label><span>远程浏览器</span><select data-account-env>${envOptionsHtml(vps, route.ip, w.loginEnv || 'new', esc)}</select></label>` : ''}${err}
      <div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-cancel">取消</button><button class="ac-open" data-ac="acb-create" ${route && !busy ? '' : 'disabled'}>创建账号和远程浏览器</button></div><p class="ac-tool-help">会在本机新建独立的账号目录，并在所选出口的 VPS 上${w.loginEnv && w.loginEnv !== 'new' ? '沿用所选的' : '新建一个'}远程浏览器（约 15–45 秒）。</p></div>`;
  }
  const c = rows.find(x => idOf(x) === w.profileId);
  if (!c) return head + '<p class="ac-tool-help" role="status">正在读取新账号…</p>';
  if (w.step === 2) {
    const v = w.mail || {}, m = mail?.accounts?.[w.profileId];
    return head + `<div class="ac-account-form acb-wiz acb-mailform">${mailField('email', '邮箱', v.email, esc, 'text', 'Outlook / Gmail 地址')}${mailField('password', '邮箱密码', v.password, esc, 'password', m?.hasPassword ? '已保存，留空不改' : '可不填')}${mailField('recoveryEmail', '辅助邮箱', v.recoveryEmail, esc, 'text', '可不填')}${mailField('recoveryPassword', '辅助邮箱密码', v.recoveryPassword, esc, 'password', m?.hasRecoveryPassword ? '已保存，留空不改' : '可不填')}
      <p class="ac-tool-help">密码用 Windows 账户加密存在本机，界面和 AI 都看不到明文；之后打开邮箱时可一键复制。</p>${err}<div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-skip">跳过</button><button class="ac-open" data-ac="acb-mail-save" ${busy ? 'disabled' : ''}>保存，下一步</button></div></div>`;
  }
  if (w.step === 3) {
    return head + `<div class="acb-wiz">${browserHtml(c, o, esc)}${exitHtml(c, o, esc)}<div class="acb-state">在远程浏览器里先登录邮箱收验证码，再登录 Claude 官网。登录进 Claude 后点下一步。</div>${err}<div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-back">上一步</button><button class="ac-open" data-ac="acb-next">我已登录 Claude，下一步</button></div></div>`;
  }
  return head + `<div class="acb-wiz"><div class="acb-state">点「授权」后 Hub 会开一个授权会话：官方授权页在这个账号的远程浏览器里打开（同一出口），你在页面上点同意，授权会话里出现成功提示即完成。</div>${err}<div class="ac-row-actions acb-wfoot"><button class="ac-text-btn" data-ac="acb-back">上一步</button><button class="ac-open" data-ac="acb-authorize" data-id="${esc(c.id)}" ${busy ? 'disabled' : ''}>授权</button></div></div>`;
}

// o: { edit, vps, mail, exits, quota: {profileId: {remain5h, remain7d, reset5h, reset7d}}, selected, filter, query, wizard, busy, now }
function claudeWorkspaceHtml(state, esc, o = {}) {
  const rows = claudeRows(state);
  let selected = o.selected;
  if (selected !== EXITS_ID && !rows.some(c => idOf(c) === selected)) selected = idOf(rows.find(c => c.isDefault) || rows[0] || {});
  const opts = { ...o, selected };
  const add = o.edit && o.edit.kind === 'claude' && o.edit.mode === 'add';
  let right;
  if (o.wizard) right = wizardHtml(rows, opts, esc);
  else if (selected === EXITS_ID) right = exitsPageHtml(rows, opts, esc);
  else { const c = rows.find(x => idOf(x) === selected); right = c ? detailHtml(c, opts, esc) : '<p class="ac-empty">还没有 Claude 账号，点左上角「新建账号」</p>'; }
  return `<div class="acb" data-account-kind="claude">${listHtml(rows, opts, esc)}<section class="acb-detail" aria-label="账号详情">${add ? '' : right}</section></div>`;
}

module.exports = { claudeWorkspaceHtml, nextLabel, statusOf, EXITS_ID, STEPS };
