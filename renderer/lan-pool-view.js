'use strict';
// 号池内网共享的界面片段：设置弹窗、账号页卡片、启动中心状态条共用同一套读数口径。
// 只做字符串渲染，不碰 IPC，便于单测。
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = t => Number.isFinite(t) && t > 0 ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const dayKey = t => new Date(t + 8 * 3600000).toISOString().slice(0, 10);
function ago(t, now = Date.now()) {
  if (!Number.isFinite(t) || t <= 0) return '还没用过';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? '刚刚' : s < 3600 ? Math.floor(s / 60) + ' 分钟前' : s < 86400 ? Math.floor(s / 3600) + ' 小时前' : clock(t);
}
const fmtTokens = n => !Number.isFinite(n) || n <= 0 ? '0' : n >= 1e8 ? (n / 1e8).toFixed(1) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(Math.round(n));
const hostOf = address => { try { return new URL(address).host; } catch { return String(address || ''); } };

// 每个共享号今日剩余：只认今天（北京时间）的读数，过期读数显示「今日待读取」。
function rowQuota(r, now = Date.now()) {
  const m = r.usage?.models?.find(m => Number.isFinite(m.day?.pct));
  const at = r.usage?.modelsAt || r.usage?.at || 0;
  const fresh = !!m && at > 0 && dayKey(at) === dayKey(now);
  const left = fresh ? Math.max(0, Math.floor(100 - m.day.pct)) : null;
  if (r.state !== 'ready') return { model: m?.name || '', left, text: '需主机处理', tone: 'bad' };
  if (r.avoid) return { model: m?.name || '', left, text: r.avoid.kind === 'rate-limit' ? '限流冷却' : '已暂停', tone: 'warn' };
  return { model: m?.name || '', left, text: left == null ? '今日待读取' : left + '% 剩余', tone: left != null && left < 20 ? 'warn' : 'ok' };
}
function clientSummary(snapshot, now = Date.now()) {
  const rows = snapshot?.rows || [];
  const down = snapshot?.connection && snapshot.connection !== 'online';
  const ready = down ? 0 : rows.filter(r => r.state === 'ready' && !r.avoid).length;
  const state = snapshot?.connection === 'revoked' ? { tone: 'bad', label: '口令已撤销', hint: '请联系主机管理员重新生成口令' }
    : down ? { tone: 'bad', label: '主机离线', hint: '每 30 秒自动重连，恢复后提示' }
      : ready === 0 ? { tone: 'warn', label: '暂无可用号', hint: '主机的号都在冷却、暂停或需登录' }
        : { tone: 'ok', label: '在线', hint: '新建 Claude Code、Codex、DSH 会话走共享号池' };
  return { rows: rows.map(r => ({ ...r, quota: rowQuota(r, now) })), ready, total: rows.length, state, models: snapshot?.models || [],
    at: snapshot?.checkedAt || null, member: snapshot?.member || null, myUsage: snapshot?.myUsage || null };
}
function hostSummary(settings) {
  const host = settings?.host || {}, gateway = settings?.gateway || {}, health = settings?.health || { phase: host.enabled ? 'starting' : 'off' };
  const members = host.members || [], active = members.filter(m => !m.revokedAt);
  // 有落盘统计时按「今天」口径（Hub 重启不清零）；老数据结构退回本次运行的内存计数。
  const usage = settings?.stats ? new Map(settings.stats.rows.map(r => [r.id, { requests: r.today.requests, succeeded: r.today.succeeded, failed: r.today.failed,
    active: r.active, lastAt: r.lastUsedAt, online: r.online, lastSeenAt: r.lastSeenAt }])) : new Map((gateway.members || []).map(u => [u.id, u]));
  const totals = settings?.stats ? { requests: settings.stats.totals.requests, active: settings.stats.totals.active, online: settings.stats.totals.online }
    : (gateway.members || []).reduce((t, u) => ({ requests: t.requests + (u.requests || 0), active: t.active + (u.active || 0) }), { requests: 0, active: 0 });
  const state = { off: { tone: 'mute', label: '未开启' }, serving: { tone: 'ok', label: '正在共享' }, 'waiting-model': { tone: 'warn', label: '模型服务准备中' },
    starting: { tone: 'warn', label: '正在启动' }, error: { tone: 'bad', label: '共享暂停' } }[health.phase] || { tone: 'mute', label: '未开启' };
  return { host, health, state, members, active, usage, totals, address: host.addresses?.[0] || '', localOnly: !!host.localOnly };
}
const dot = tone => `<i class="lp-dot lp-${tone}"></i>`;
const bar = (left, tone) => left == null ? '<span class="lp-bar lp-empty"><i></i></span>' : `<span class="lp-bar lp-${tone}"><i style="width:${Math.max(2, left)}%"></i></span>`;
const btn = (attrs, label, cls = '') => `<button type="button" class="${cls}" ${attrs}>${label}</button>`;

function quotaList(view) {
  if (!view.rows.length) return '<p class="lp-muted">主机还没有返回账号读数。</p>';
  return `<ul class="lp-quota${view.state.tone === 'bad' ? ' lp-stale' : ''}">${view.rows.map(r => `<li class="lp-q-${r.quota.tone}"><span class="lp-q-name">${esc(r.label)}</span><span class="lp-q-model">${esc(r.quota.model || '—')}</span>${bar(r.quota.left, r.quota.tone)}<b>${esc(r.quota.text)}</b></li>`).join('')}</ul>`;
}
function usageLine(view) {
  const u = view.myUsage, m = view.member;
  return [m ? `我的上限：同时 ${m.maxConcurrent} 个请求 · 每分钟 ${m.rpm} 次` : '', u ? `${u.scope === 'today' ? '今天' : '主机本次运行'}：我请求 ${u.requests} 次，成功 ${u.succeeded}${u.failed ? '，失败 ' + u.failed : ''}${u.tokens ? `，约 ${fmtTokens(u.tokens)} token` : ''}` : ''].filter(Boolean);
}

// ---- 设置弹窗：同事端 ----
function clientPanel(settings, snapshot, now = Date.now()) {
  const client = settings.client;
  if (!client?.connected) {
    return `<section class="lp-intro"><ol class="lp-steps"><li><b>拿到连接信息</b><span>找主机管理员要一行「地址 + 专属口令」</span></li><li><b>粘贴并验证</b><span>约 5 秒，失败不改本机配置</span></li><li><b>新建会话</b><span>Claude Code、Codex、DSH 自动走共享号池</span></li></ol></section>
      <form data-lan-connect class="lp-form"><label>连接信息或主机地址<input name="address" autocomplete="off" spellcheck="false" placeholder="粘贴整行，例如：AI Hub 号池共享 地址 http://10.1.2.3:18766 口令 …" value="${esc(client?.address || '')}" required></label>
        <label>专属口令<span class="lp-label-hint">粘贴整行时自动识别，可留空</span><input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${client?.keySet ? '已保存；重新连接时填写新口令' : '48 位，由主机管理员生成'}"></label>
        <footer><button type="submit" class="primary">验证并连接</button></footer></form>
      <p class="lp-foot">工具和项目文件仍在你自己的电脑上运行，主机只转发模型请求。断开后恢复连接前的工具配置。</p>`;
  }
  const v = clientSummary(snapshot, now);
  return `<section class="lp-status lp-${v.state.tone}" data-lan-client-state="${esc(snapshot?.connection || 'connecting')}">
      <div class="lp-status-main">${dot(v.state.tone)}<div><strong>${esc(v.state.label)}</strong>${v.state.tone === 'ok' ? `<span class="lp-big">${v.ready}<small>/${v.total} 个号可用</small></span>` : ''}<p>${esc(v.state.tone === 'ok' ? v.state.hint : snapshot?.message || v.state.hint)}</p></div></div>
      <dl class="lp-kv"><dt>主机</dt><dd class="lp-mono">${esc(client.address)}</dd><dt>读数时间</dt><dd>${esc(clock(v.at))}</dd><dt>模型</dt><dd>${v.models.map(m => `<span class="lp-chip">${esc(m)}</span>`).join('') || '—'}</dd></dl>
      ${usageLine(v).map(t => `<p class="lp-sub">${esc(t)}</p>`).join('')}
      <div class="lp-actions">${btn('data-lan-refresh', '立即刷新')}${btn('data-lan-disconnect', '断开并恢复原配置', 'lp-quiet')}</div></section>
    <h3 class="lp-h3">主机各号今日额度<small>所有同事共同消耗；刷新只同步主机已有读数</small></h3>${quotaList(v)}
    ${snapshot?.connection === 'revoked' ? `<form data-lan-connect class="lp-form lp-reconnect"><input type="hidden" name="address" value="${esc(client.address)}"><label>主机重新发来的口令<input name="key" type="password" autocomplete="off" required></label><footer><button type="submit" class="primary">用新口令重新连接</button></footer></form>` : ''}`;
}

// ---- 设置弹窗：主机端 ----
function hostPanel(settings, { oneTime = null, invite = '', confirmRevoke = '', now = Date.now(), dashboard = false } = {}) {
  const v = hostSummary(settings), host = v.host;
  const changed = v.health.addressChanged ? `<div class="lp-banner lp-warn">本机地址从 <code>${esc(v.health.addressChanged.from)}</code> 变成了 <code>${esc(v.health.addressChanged.to)}</code>，共享已跟着换过去。请把新地址发给同事；长期使用建议请 IT 给这台电脑固定 IP。</div>` : '';
  const error = v.health.error && host.enabled ? `<div class="lp-banner lp-${v.health.phase === 'error' ? 'bad' : 'warn'}">${esc(v.health.error)}${v.health.phase === 'error' ? ` · 每 ${v.health.retrySeconds || 30} 秒自动重试` : ''}</div>` : '';
  const options = [...(host.interfaces || []), '127.0.0.1'].map(a => `<option value="${esc(a)}" ${a === host.bindAddress ? 'selected' : ''}>${esc(a)}${a === '127.0.0.1' ? '（仅本机验证）' : ''}</option>`).join('');
  const status = `<section class="lp-status lp-${v.state.tone}" data-lan-host-state="${esc(v.health.phase)}">
      <div class="lp-status-main">${dot(v.state.tone)}<div><strong>${esc(v.state.label)}</strong>${host.enabled ? `<span class="lp-big">${v.active.length}<small> 位同事 · ${v.totals.active} 个请求进行中</small></span>` : ''}<p>${host.enabled ? '本机 Hub 退出或电脑休眠时同事暂时用不了；账号凭据不离开本机。' : '开启后，同事用你生成的口令通过内网使用本机号池。'}</p></div></div>
      ${host.enabled ? `<div class="lp-address"><span>同事填写的地址</span><code class="lp-mono">${esc(v.address)}</code>${btn(`data-lan-copy="${esc(v.address)}"`, '复制', 'lp-quiet lp-sm')}</div>${v.localOnly ? '<p class="lp-sub">当前只监听 127.0.0.1，仅供本机验证，同事连不上。</p>' : ''}` : ''}
      <form data-lan-host class="lp-host-form"><label>监听网卡<select name="bindAddress" ${host.enabled ? 'disabled' : ''}>${options}</select></label><label>端口<input name="port" type="number" min="1024" max="65535" value="${esc(host.port)}" ${host.enabled ? 'readonly' : ''}></label><button type="submit" class="${host.enabled ? 'lp-quiet' : 'primary'}">${host.enabled ? '关闭共享' : '开启共享'}</button></form>
      ${!host.enabled && !(host.interfaces || []).length ? '<p class="lp-sub">没有找到内网 IPv4 网卡，连上公司网络后再开启。</p>' : ''}</section>`;
  const secret = oneTime ? `<div class="lp-secret" role="status"><div><strong>新口令只显示这一次</strong><span>把整行发给对应同事，他粘贴到「连接共享主机」即可</span></div><code class="lp-mono" data-lan-invite>${esc(invite || oneTime)}</code><input class="lp-secret-raw" readonly value="${esc(oneTime)}" aria-label="新口令">${btn(`data-lan-copy="${esc(invite || oneTime)}"`, '复制连接信息', 'primary lp-sm')}</div>` : '';
  const revoked = v.members.filter(m => m.revokedAt);
  const row = m => {
    const u = v.usage.get(m.id) || {};
    const confirm = confirmRevoke === m.id;
    return `<tr class="${m.revokedAt ? 'lp-revoked' : ''}"><td>${u.online != null && !m.revokedAt ? `<span title="${u.online ? '在线' : '离线'}">${dot(u.online ? 'ok' : 'mute')}</span>` : ''}<strong>${esc(m.name)}</strong></td><td>${m.revokedAt ? '已撤销' : `同时 ${m.maxConcurrent} · 每分 ${m.rpm}`}</td><td class="lp-num">${u.requests || 0}<small> / 成功 ${u.succeeded || 0}${u.failed ? ' / 失败 ' + u.failed : ''}</small></td><td class="lp-num">${u.active ? `<span class="lp-live">${u.active}</span>` : '0'}</td><td>${esc(ago(u.lastAt, now))}</td><td>${m.revokedAt ? '' : confirm ? `${btn(`data-lan-revoke="${esc(m.id)}" data-confirmed="1"`, '确认撤销', 'lp-danger lp-sm')}${btn('data-lan-revoke-cancel', '取消', 'lp-quiet lp-sm')}` : btn(`data-lan-revoke="${esc(m.id)}"`, '撤销', 'lp-quiet lp-sm')}</td></tr>`;
  };
  const table = v.active.length ? `<table class="lp-table"><thead><tr><th>同事</th><th>上限</th><th>今天请求</th><th>进行中</th><th>最近使用</th><th></th></tr></thead><tbody>${v.active.map(row).join('')}</tbody></table>` : '<p class="lp-muted">还没有同事。填好备注生成口令，把连接信息发给他。</p>';
  const old = revoked.length ? `<details class="lp-old"><summary>已撤销 ${revoked.length} 位</summary><table class="lp-table"><tbody>${revoked.map(row).join('')}</tbody></table></details>` : '';
  return `${changed}${error}${status}
    <h3 class="lp-h3">同事口令<small>每人一个，撤销后立即断开他的在途请求</small>${dashboard && host.enabled ? `<span class="lp-grow"></span>${btn('data-lan-dashboard', '打开号池视图', 'lp-quiet lp-sm')}` : ''}</h3>
    <form data-lan-member class="lp-member-form"><label>同事备注<input name="name" maxlength="40" required placeholder="例如 张工（仅本机可见）"></label><label>同时请求<input name="maxConcurrent" type="number" min="1" max="16" value="2"></label><label>每分钟<input name="rpm" type="number" min="1" max="600" value="60"></label><button type="submit" class="primary">生成口令</button></form>
    ${secret}${table}${old}
    <p class="lp-foot">统计按天保留 14 天，只记次数和 token 数，不记录对话内容。</p>`;
}

// ---- 账号页卡片 ----
function accountCard(settings, snapshot, now = Date.now(), { dashboard = false } = {}) {
  if (!settings) return '';
  if (settings.client?.connected) {
    const v = clientSummary(snapshot, now);
    return `<section class="lp-card" aria-label="共享号池"><header><span class="lp-card-title">${dot(v.state.tone)}共享号池</span><span class="lp-tag">${esc(v.state.label)}</span><span class="lp-card-sub">来自主机 <span class="lp-mono">${esc(hostOf(settings.client.address))}</span> · 读数 ${esc(clock(v.at))}</span><span class="lp-grow"></span>${btn('data-lan-card="refresh"', '刷新', 'lp-quiet lp-sm')}${btn('data-lan-card="open"', '管理共享', 'lp-quiet lp-sm')}</header>
      <div class="lp-card-body"><div class="lp-card-stat"><b>${v.ready}</b><span>/${v.total} 个号可用</span><p>${esc(v.state.tone === 'ok' ? 'Claude Code、Codex、DSH 新会话走这里；下方本机 CodeAgent 账号只给 CodeAgent 会话用。' : snapshot?.message || v.state.hint)}</p>${usageLine(v).map(t => `<p>${esc(t)}</p>`).join('')}</div>${quotaList(v)}</div></section>`;
  }
  if (settings.host?.enabled) {
    const v = hostSummary(settings), top = v.active.slice().sort((a, b) => (v.usage.get(b.id)?.lastAt || 0) - (v.usage.get(a.id)?.lastAt || 0)).slice(0, 6);
    return `<section class="lp-card" aria-label="内网共享"><header><span class="lp-card-title">${dot(v.state.tone)}内网共享</span><span class="lp-tag">${esc(v.state.label)}</span><span class="lp-card-sub">同事地址 <code class="lp-mono">${esc(v.address)}</code>${btn(`data-lan-copy="${esc(v.address)}"`, '复制', 'lp-link')}</span><span class="lp-grow"></span>${dashboard ? btn('data-lan-card="dashboard"', '号池视图', 'primary lp-sm') : ''}${btn('data-lan-card="open"', '管理共享', 'lp-quiet lp-sm')}</header>
      ${v.health.addressChanged ? `<div class="lp-banner lp-warn">地址已从 ${esc(v.health.addressChanged.from)} 变为 ${esc(v.health.addressChanged.to)}，请把新地址发给同事。</div>` : ''}
      ${v.health.error ? `<div class="lp-banner lp-${v.health.phase === 'error' ? 'bad' : 'warn'}">${esc(v.health.error)}${v.health.phase === 'error' ? ' · 自动重试中' : ''}</div>` : ''}
      <div class="lp-card-body"><div class="lp-card-stat"><b>${v.active.length}</b><span> 位同事</span><p>${v.totals.online != null ? `${v.totals.online} 位在线 · ` : ''}今天共 ${v.totals.requests} 次请求，${v.totals.active} 个进行中。下方号池同时服务你和同事，「会话数」含同事的会话。</p></div>
      ${top.length ? `<ul class="lp-people">${top.map(m => { const u = v.usage.get(m.id) || {}; return `<li><span class="lp-avatar">${esc([...m.name][0] || '同')}</span><span class="lp-q-name">${u.online != null ? dot(u.online ? 'ok' : 'mute') : ''}${esc(m.name)}</span><span class="lp-muted">${u.online ? '在线' : ''}${u.online && u.lastAt ? ' · ' : ''}${u.lastAt || !u.online ? esc(ago(u.lastAt, now)) : ''}</span><b>${u.requests || 0} 次${u.active ? ` · <span class="lp-live">${u.active} 进行中</span>` : ''}</b></li>`; }).join('')}</ul>` : '<p class="lp-muted">还没有同事。点「管理共享」生成口令。</p>'}</div></section>`;
  }
  return `<section class="lp-card lp-card-slim" aria-label="号池内网共享"><span class="lp-card-title">号池内网共享</span><span class="lp-card-sub">把本机号池共享给同事，或连接同事电脑上的号池</span><span class="lp-grow"></span>${btn('data-lan-card="open"', '设置共享', 'lp-quiet lp-sm')}</section>`;
}

// ---- 启动中心状态条（只在同事端显示）----
function launchStrip(settings, snapshot, now = Date.now()) {
  if (!snapshot?.shared) return '';
  const v = clientSummary(snapshot, now);
  return `<div class="lp-strip lp-${v.state.tone}">${btn('data-lan-open', `${dot(v.state.tone)}共享号池 · ${v.state.tone === 'bad' ? esc(v.state.label) : v.ready + '/' + v.total + ' 可用'}`, 'lp-strip-btn')}
    <span class="lp-strip-meta">主机 ${esc(hostOf(settings?.client?.address))} · 读数 ${esc(clock(v.at))}${v.state.tone === 'bad' ? ' · ' + esc(v.state.hint) : ''}</span>
    <span class="lp-strip-q">${v.rows.map(r => `<span class="lp-q-${r.quota.tone}" title="${esc(r.quota.model)}">${esc(r.label.replace('共享号 ', '号'))} <b>${esc(r.quota.text)}</b></span>`).join('')}</span></div>`;
}

module.exports = { esc, clock, ago, fmtTokens, hostOf, dot, bar, rowQuota, clientSummary, hostSummary, clientPanel, hostPanel, accountCard, launchStrip };
