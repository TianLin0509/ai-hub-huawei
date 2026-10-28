'use strict';

const NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', tokenPlan: 'Token Plan', antigravity: 'Antigravity' };
// User decision 2026-10-25: the footer shows only the Gemini models' weekly window; other
// model groups and the 5h window stay in the hover details.
function antigravityMetrics(data) {
  const gemini = (data.groups || []).find(group => group.id === 'gemini');
  return gemini?.usage7d ? { gemini: { label: '7d', usage: gemini.usage7d } } : {};
}
function remainingPercent(window) {
  const used = window?.pct;
  return typeof used === 'number' && Number.isFinite(used) && used >= 0
    ? Math.max(0, 100 - Math.min(100, used)) : null;
}

function formatResetCountdown(resetsAt, now = Date.now()) {
  const reset = resetsAt ? new Date(resetsAt).getTime() : NaN;
  if (!Number.isFinite(reset)) return '—';
  if (reset <= now) return '0m';
  const minutes = Math.ceil((reset - now) / 60000);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h' + (minutes % 60 ? minutes % 60 + 'm' : '');
  return Math.floor(hours / 24) + 'd' + (hours % 24 ? hours % 24 + 'h' : '');
}

// Each account is a stable keyboard-accessible target; both quota windows stay inline.
function createSidebarAccountUsage({ document, root, refresh, formatAge, formatBalance, freshness, nowFn = Date.now }) {
  const el = (tag, cls, parent, text) => {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node); return node;
  };
  const quota = el('div', 'sidebar-quota', root);
  const claudeRow = el('div', 'sidebar-quota-claude', quota);
  const pair = el('div', 'sidebar-quota-pair', quota);
  const codexRow = el('div', 'sidebar-quota-codex', pair);
  const entries = {};
  function createEntry(provider, key, profileId = '') {
    const row = el('button', 'sidebar-quota-provider', provider === 'claude' ? claudeRow : provider === 'codex' ? codexRow : ['tokenPlan', 'antigravity'].includes(provider) ? quota : pair);
    row.type = 'button';
    row.dataset.provider = provider;
    row.dataset.profileId = profileId;
    const icon = el('span', 'sidebar-quota-icon ' + (provider === 'tokenPlan' ? 'token-plan-icon' : 'ai-logo logo-' + (provider === 'antigravity' ? 'gemini' : provider)), row,
      provider === 'tokenPlan' ? 'T' : '');
    icon.setAttribute('aria-hidden', 'true');
    el('span', 'sidebar-quota-name', row, NAMES[provider]);
    const account = el('span', 'sidebar-quota-account', row);
    const metrics = el('span', 'sidebar-quota-metrics', row);
    const windows = provider === 'antigravity' ? ['gemini'] : ['claude','codex'].includes(provider) ? ['5h', '7d'] : provider === 'tokenPlan' ? ['7d'] : ['balance'];
    const cells = {};
    function addCell(window, label) {
      const cell = el('span', 'sidebar-quota-metric', metrics); cell.dataset.window = window;
      const line = el('span', 'sidebar-quota-reading', cell);
      if (['claude','codex'].includes(provider)) el('span', 'sidebar-quota-window', line, window);
      const labelNode = provider === 'antigravity' && label ? el('span', 'sidebar-quota-window', line, label) : null;
      const value = el('b', 'sidebar-quota-value', line, '—');
      const period = el('span', 'sidebar-quota-period', line, '');
      const track = window !== 'balance' ? el('span', 'sidebar-quota-track', cell) : null;
      const fill = track ? el('i', '', track) : null;
      if (track) track.setAttribute('aria-hidden', 'true');
      cells[window] = { cell, value, fill, period, labelNode };
    }
    for (const window of windows) addCell(window, provider === 'antigravity' ? '7d' : undefined);
    const button = row;
    button.setAttribute('aria-label', '刷新 ' + NAMES[provider]);
    button.addEventListener('click', () => {
      // Controller retains and renders errors for every programmatic/UI caller.
      refresh(provider, profileId).catch(error => { row.title = NAMES[provider] + ' 刷新失败：' + error.message; });
    });
    entries[key] = { row, button, cells, account, addCell };
  }
  for (const provider of Object.keys(NAMES)) createEntry(provider, provider + ':');
  return {
    detailsHost: claudeRow,
    render(snapshot, states) {
      const now = nowFn();
      const wanted = Object.keys(NAMES).flatMap(provider => {
        const accounts = snapshot.accounts?.[provider];
        return (accounts?.length ? accounts : [snapshot[provider] || {}]).map((data, index) =>
          ({ provider, data, index, key: provider + ':' + (data.profileId || ''), profileId: data.profileId || '' }));
      });
      const keys = new Set(wanted.map(item => item.key));
      for (const key of Object.keys(entries)) if (!keys.has(key)) { entries[key].row.remove(); delete entries[key]; }
      for (const { provider, data, index, key, profileId } of wanted) {
        if (!entries[key]) createEntry(provider, key, profileId);
        const { row, cells, button, account, addCell } = entries[key];
        const agyMetrics = provider === 'antigravity' ? antigravityMetrics(data) : {};
        for (const [key, metric] of Object.entries(agyMetrics)) {
          if (!cells[key]) addCell(key, metric.label);
          else if (cells[key].labelNode) cells[key].labelNode.textContent = metric.label;
        }
        row.style.order = String(index);
        account.textContent = ['claude','codex','antigravity'].includes(provider) ? String(index + 1) : '';
        if (account.dataset) account.dataset.no = account.textContent;
        const state = profileId ? { error: data.error, inFlight: data.inFlight } : states[provider] || {};
        row.dataset.freshness = provider === 'tokenPlan' && data.lastSeen
          ? (now - data.lastSeen > 600000 || state.error ? 'stale' : 'fresh') : state.error ? 'stale' : freshness(data.lastSeen);
        const age = formatAge(data.lastSeen);
        const tokenReset = provider === 'tokenPlan' && (data.usage7d || data.usage30d)?.resetsAt;
        const resetTip = tokenReset && Number.isFinite(new Date(tokenReset).getTime())
          ? '重置：' + new Date(tokenReset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京时间' : '';
        const status = state.inFlight ? '刷新中…' : state.error ? '刷新失败：' + state.error
          : state.result ? state.result.fresh ? '已取得新数据' : '未取得新数据，保留旧值' : '';
        row.title = [NAMES[provider], data.profileLabel, data.apiKey ? 'API 登录，无订阅额度' : '', age, status, resetTip].filter(Boolean).join(' · ');
        row.title = '点击刷新 · ' + row.title;
        if (provider === 'antigravity') {
          const details = (data.groups || []).flatMap(g => ['usage5h','usage7d'].filter(k => g[k]).map(k => `${g.label} ${k === 'usage5h' ? '5小时' : '周'}剩余 ${Math.round(remainingPercent(g[k]))}% · 重置 ${g[k].resetsAt ? new Date(g[k].resetsAt).toLocaleString() : '未知'}`));
          row.title += '\n' + details.join('\n') + `\ncredits 余额：${data.credits ?? '未知'}${data.creditsError ? ' · ' + data.creditsError : ''}`;
        }
        button.setAttribute('aria-label', '刷新 ' + NAMES[provider] + (status ? ' · ' + status : ''));
        button.setAttribute('aria-disabled', String(!!state.inFlight));
        button.setAttribute('aria-busy', String(!!state.inFlight));
        button.dataset.state = state.inFlight ? 'loading' : state.error ? 'error' : 'idle';
        for (const [window, cell] of Object.entries(cells)) {
          if (window === 'balance') {
            cell.value.textContent = formatBalance(data);
            const raw = (data.balance || data).totalBalance;
            row.dataset.level = cell.value.textContent !== '—' && Number(raw) < 20 ? 'warn' : 'normal';
            cell.cell.title = '余额 · ' + age + ((data.balance || data).available === false ? ' · 当前不可用' : '')
              + ' · 点击刷新 ' + NAMES[provider] + (status ? ' · ' + status : '');
            if (provider === 'antigravity') cell.cell.title += '\n' + row.title;
          } else {
            // Token Plan 单格自适应：服务端给周窗口就用周，改给月窗口就跟随月。
            const observation = provider === 'antigravity' ? agyMetrics[window]?.usage
              : provider === 'tokenPlan' ? (data.usage7d || data.usage30d || null)
              // 5h 窗口不可能在 5 小时以后才重置；旧版本把 Codex 周窗口误记成 5h 的缓存在这里丢掉。
              : provider === 'codex' && window === '5h' && new Date(data.usage5h?.resetsAt).getTime() > now + 5.5 * 3600_000 ? null
              : data['usage' + window];
            const windowLabel = provider === 'antigravity' ? agyMetrics[window]?.label || '7d' : provider === 'tokenPlan'
              ? (data.usage7d ? '7d' : data.usage30d ? '30d' : window) : window;
            cell.cell.dataset.period = windowLabel;
            const pct = remainingPercent(observation);
            cell.value.textContent = pct === null ? (provider === 'tokenPlan' && data.needsLogin ? '需登录' : '—')
              : (provider === 'tokenPlan' ? pct.toFixed(2) : Math.round(pct)) + '%';
            cell.fill.style.width = (pct ?? 0) + '%';
            // Codex 订阅没有 5 小时窗口，服务端不给数据时整格隐藏，省出底栏空间。
            cell.cell.hidden = provider === 'codex' && window === '5h' && !observation;
            cell.cell.dataset.level = pct !== null && pct < 15 ? 'danger' : pct !== null && pct <= 40 ? 'warn' : 'normal';
            const countdown = formatResetCountdown(observation?.resetsAt, now);
            const reset = observation?.resetsAt ? new Date(observation.resetsAt).getTime() : NaN;
            const knownReset = Number.isFinite(reset);
            const expired = knownReset && reset <= now;
            // 只写倒计时本身，不加箭头；重置时间未知就不占位。
            cell.period.textContent = !knownReset ? '' : expired ? '待刷新' : countdown;
            cell.cell.dataset.resetState = !knownReset ? 'unknown' : expired ? 'due' : 'countdown';
            cell.cell.title = windowLabel + ' 剩余额度 · ' + formatAge(observation?.observedAt || data.lastSeen)
              + (expired ? ' · 上次记录，等待刷新' : knownReset ? ' · 距离额度重置 ' + countdown : ' · 重置时间未知')
              + (knownReset ? ' · 重置：' + new Date(reset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京时间' : '')
              + ' · 点击刷新 ' + NAMES[provider] + (status ? ' · ' + status : '');
          }
        }
        button.setAttribute('aria-label', NAMES[provider] + (data.profileLabel ? ' · ' + data.profileLabel : '') + ' · ' + Object.entries(cells).filter(([, cell]) => !cell.cell.hidden).map(([window, cell]) =>
          (window === 'balance' ? '余额 ' : cell.cell.dataset.period + ' 剩余 ') + cell.value.textContent + ' ' + cell.period.textContent
        ).join(' · ') + ' · 点击刷新' + (status ? ' · ' + status : ''));
      }
    },
  };
}
module.exports = { createSidebarAccountUsage, remainingPercent, formatResetCountdown };
