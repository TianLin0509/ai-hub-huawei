'use strict';
// 启动中心「启动配置」C 布局（2026-11-01 用户从五套 mock 里选定 C）：
//   - 有多账号的 AI（Claude、Codex、Antigravity）左栏竖排用量账号，每行带 5h / 7d 剩余条与会话数，右栏放参数；
//     没有多账号的 AI（DeepSeek、Kimi、千问…）不显示账号栏，参数占满整行（用户同日补充）。
// 原来的 <select> 都留在页面里、只是藏起来：取值、change 事件、默认值保存等现有逻辑一行不改，
// 点账号行或分段按钮就是替你选中对应的那一项并发出 change。
const { viewRows } = require('./account-quota-panel.js');

const SEGMENTED = [
  { id: 'new-session-deepseek-route', max: 4 },
  { id: 'new-session-model', max: 5 },
  { id: 'new-session-effort', max: 7 },
  { id: 'new-session-codex-tier', max: 4 },
  { id: 'new-session-mcp', max: 6 },
];
const QUOTA_PROVIDER = { claude: 'claude', codex: 'codex', gemini: 'antigravity' };
const QUOTA_TTL = 30000;

function level(pct) { return pct === null || pct === undefined ? 'off' : pct < 15 ? 'bad' : pct <= 40 ? 'warn' : 'ok'; }

function createLaunchConfigLayout({ document, ipcRenderer, escapeHtml: esc }) {
  const section = document.getElementById('new-session-config-section');
  if (!section) return { paint() {} };
  // 一次性改结构：标题行之下分左右两栏；原有字段全部挪进右栏，顺序不变。
  if (section.querySelector(':scope > .lcc-body')) throw new Error('启动配置布局已初始化过');
  const heading = section.querySelector('.session-config-heading');
  const body = document.createElement('div'); body.className = 'lcc-body';
  const left = document.createElement('div'); left.className = 'lcc-accounts'; left.id = 'new-session-account-list'; left.setAttribute('role', 'listbox'); left.setAttribute('aria-label', '用量账号');
  const right = document.createElement('div'); right.className = 'lcc-params';
  for (const node of [...section.childNodes]) if (node !== heading) right.appendChild(node);
  body.append(left, right); section.appendChild(body);
  section.classList.add('lcc');

  let quota = {}, quotaAt = 0, quotaFlight = null, lastCtx = null;
  function loadQuota() {
    if (quotaFlight || Date.now() - quotaAt < QUOTA_TTL) return;
    quotaFlight = Promise.resolve(ipcRenderer.invoke('account-profile-usage')).then(cached => {
      const next = {};
      for (const provider of Object.values(QUOTA_PROVIDER)) {
        const rows = viewRows(provider, { accounts: { [provider]: cached?.[provider] || [] } }, '', Date.now());
        next[provider] = Object.fromEntries(rows.map(r => [r.profileId || 'default', r]));
      }
      quota = next; quotaAt = Date.now();
    }).catch(() => { quotaAt = Date.now(); }).finally(() => { quotaFlight = null; if (lastCtx) paintAccounts(lastCtx); });
  }

  const pill = (name, pct) => pct === null || pct === undefined
    ? `<span class="lcc-pill off"><span>${name} 待读取</span></span>`
    : `<span class="lcc-pill ${level(pct)}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i><span>${name} 余 ${pct}%</span></span>`;

  function paintAccounts(ctx) {
    const { kind, showAccount, accounts = [], selectedId, disabled, ranking } = ctx;
    const on = !!showAccount && accounts.length > 0;
    body.classList.toggle('has-accounts', on);
    left.hidden = !on;
    // 清空时连同缓存一起清：否则 Claude → DeepSeek → Claude 回来时内容与缓存相同、跳过重画，左栏就是空的。
    if (!on) { left.innerHTML = ''; delete left.dataset.html; return; }
    const provider = QUOTA_PROVIDER[kind];
    const rows = new Map((ranking?.rows || []).map(r => [r.id, r]));
    const html = `<div class="lcc-h">用量账号</div>` + accounts.map(a => {
      const r = rows.get(a.id), q = quota[provider]?.[a.id];
      const p5 = r ? r.spare5h : q ? q.remain5h : null, p7 = r ? r.spare7d : q ? q.remain7d : null;
      const sessions = r ? r.running + r.idle : null;
      const name = a.label || a.id, sub = a.email || '账号未确认';
      const side = a.risk ? `<span class="lcc-tag risk" title="${esc(a.risk)}">⚠ 风控</span>` : a.recommended ? (ranking && !ranking.plenty ? '<span class="lcc-tag soft" title="没有号同时满足会话 ≤ 1、5h > 70%、7d 高于节奏，按综合余量排第一">较优</span>' : `<span class="lcc-tag" title="${esc(r ? `会话 ${r.running + r.idle} 个 · 5h 剩 ${r.spare5h}% · 7d 剩 ${r.spare7d}%，按每周用 70% 的节奏此时该剩 ${r.expected7d}%，余量 +${r.margin}%` : '')}">推荐</span>`) : sessions ? `<span class="lcc-sessions">${sessions} 个会话${r.running ? `（${r.running} 在跑）` : ''}</span>` : '';
      const has5h = kind !== 'codex' || p5 !== null;
      return `<button type="button" class="lcc-acct" role="option" data-lcc-account="${esc(a.id)}" aria-selected="${a.id === selectedId}" ${disabled ? 'disabled' : ''} title="${esc(name + ' · ' + sub)}"><span class="lcc-acct-top"><b>${esc(name)}</b>${side}</span><span class="lcc-acct-mail">${esc(sub)}</span><span class="lcc-pills">${has5h ? pill('5h', p5) : ''}${pill('7d', p7)}</span></button>`;
    }).join('');
    if (left.dataset.html !== html) { left.innerHTML = html; left.dataset.html = html; }
  }

  // 分段按钮：跟着 <select> 的选项和取值重画；选项太多或字段藏着时照旧用下拉框。
  function paintSegments() {
    for (const { id, max } of SEGMENTED) {
      const select = document.getElementById(id);
      if (!select) continue;
      const field = select.closest('.session-tuning-field');
      let seg = select.parentElement.querySelector(`.lcc-seg[data-for="${id}"]`);
      const options = [...select.options].filter(o => !o.hidden);
      // CodeAgent 的模型下拉里带每个模型的今日用量（launch-select-popover 读 data-usage），保持下拉框。
      const keepDropdown = id === 'new-session-model' && lastCtx?.kind === 'codeagent';
      const use = !keepDropdown && !(field && field.hidden) && options.length >= 2 && options.length <= max;
      select.classList.toggle('lcc-hidden', use);
      if (!use) { if (seg) seg.hidden = true; continue; }
      if (!seg) { seg = document.createElement('div'); seg.className = 'lcc-seg'; seg.dataset.for = id; seg.setAttribute('role', 'radiogroup'); select.insertAdjacentElement('afterend', seg); }
      seg.hidden = false;
      seg.setAttribute('aria-label', field?.querySelector('span')?.textContent || '');
      const html = options.map(o => {
        // 只写名称；「最强」「省额度」「不加载工具」等说明放在悬停提示里，免得一行放不下。
        const main = o.textContent.split(' · ')[0].replace(/\s+(最强|深入思考|省额度|最省|默认)$/, '');
        const off = /不可用$/.test(o.textContent) ? '<small>不可用</small>' : '';
        return `<button type="button" role="radio" data-lcc-value="${esc(o.value)}" aria-checked="${o.value === select.value}" ${select.disabled || o.disabled ? 'disabled' : ''} title="${esc(o.textContent)}">${esc(main)}${off}</button>`;
      }).join('');
      if (seg.dataset.html !== html) { seg.innerHTML = html; seg.dataset.html = html; }
    }
  }

  function choose(select, value) {
    if (!select || select.disabled || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  section.addEventListener('click', event => {
    const acct = event.target.closest('[data-lcc-account]');
    if (acct && !acct.disabled) { choose(document.getElementById('new-session-account'), acct.dataset.lccAccount); return; }
    const b = event.target.closest('.lcc-seg [data-lcc-value]');
    if (b && !b.disabled) choose(document.getElementById(b.closest('.lcc-seg').dataset.for), b.dataset.lccValue);
  });

  return {
    paint(ctx) {
      lastCtx = ctx;
      if (ctx.showAccount && QUOTA_PROVIDER[ctx.kind]) loadQuota();
      paintAccounts(ctx);
      paintSegments();
    },
  };
}

module.exports = { createLaunchConfigLayout };
