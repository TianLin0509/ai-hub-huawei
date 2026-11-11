'use strict';
// 公司版「助理」页（5.5.11 起，2026-11-05 用户定稿）：左边是和 CodeAgent 卡片视图一致的对话，右边是可折叠的「今天」栏（原今日简报）。
// 页头只留标题「助理」和一个连接状态点：悬停看 WeLink、邮件日历、手机对话、会话工具各自状态；有问题时页头下出一条提示并给处理按钮。
// 设置分四页：简报与提醒 / WeLink 与邮箱 / 手机 / 桌宠。邮箱 Hub 先从 WeLink 账号自动读、自动配好，读不到才请用户在设置里填一次。
// 写法同无线页：盖在主区域上的一层，点左侧其他按钮自动关闭。左侧按钮只在公司版（gate.js）插入。

// ---- 纯函数（单测直接调用，见 tests/unit-company-assistant-page-chat.test.js）----
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unescHtml = v => String(v ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));
// PPT 入口发起的问答归 PPT 页，不在助理页显示。
const visibleChat = list => (Array.isArray(list) ? list : []).filter(c => c && c.entry !== 'ppt');
// 旧格式回答：开头一段「> **Hub 核实的查询范围**」引用块。剥出来当查询范围明细，正文只留后面的部分。
const LEGACY_COVERAGE_HEAD = /^>\s*\*\*Hub 核实的查询范围\*\*\s*$/;
function splitLegacyCoverage(text) {
  const lines = String(text || '').split('\n');
  if (!LEGACY_COVERAGE_HEAD.test(lines[0] || '')) return null;
  let i = 1; const details = [];
  for (; i < lines.length && /^>/.test(lines[i]); i++) { const line = lines[i].replace(/^>\s?/, '').trim(); if (line) details.push(line); }
  return { body: lines.slice(i).join('\n').replace(/^\s+/, ''), details };
}
// 回答底部的查询范围：后端给结构化 coverage = {ok, line, details[]}；旧数据从正文前缀或 queryCoverage 里取，line 用「查询范围」。
function answerCoverage(item = {}) {
  const legacy = splitLegacyCoverage(item.a);
  const body = legacy ? legacy.body : String(item.a || '');
  const c = item.coverage;
  if (c && typeof c === 'object' && (c.line || (Array.isArray(c.details) && c.details.length))) {
    return { body, coverage: { ok: c.ok !== false, line: String(c.line || '查询范围'), details: (Array.isArray(c.details) ? c.details : []).map(String).filter(Boolean), legacy: false } };
  }
  const details = legacy?.details?.length ? legacy.details : Array.isArray(item.queryCoverage) ? item.queryCoverage.filter(x => typeof x === 'string' && x.trim()) : [];
  return { body, coverage: details.length ? { ok: null, line: '查询范围', details, legacy: true } : null };
}
// 出处标签表：后端给 item.sources = { 'msg:…': '周工 · 私聊 10:12' }（也认 [{id,label}]）。
function sourceLabels(sources) {
  if (Array.isArray(sources)) return Object.fromEntries(sources.filter(s => s && s.id).map(s => [String(s.id), String(s.label || '')]));
  return sources && typeof sources === 'object' ? sources : {};
}
// 正文里的出处编号 [msg:…] [meeting:…]（旧写法 mtg:）[cal:…] [mail:…]（或包在行内代码里）换成灰色小标签；点开看出处。作用在已转义 / 已净化的 HTML 上。
const SOURCE_RE = /<code>\[([^\]<>]+)\]<\/code>|\[([^\]<>]+)\]/g;
const SOURCE_ID = /^(?:msg|meeting|mtg|cal|mail):\S+$/;
function tagSources(html, labelOf = () => '出处') {
  return String(html || '').replace(SOURCE_RE, (all, coded, plain, offset, whole) => {
    // 链接文字 [..](..) 与属性里的方括号不动。
    if (whole[offset + all.length] === '(' || /=["'][^"']*$/.test(whole.slice(Math.max(0, offset - 200), offset))) return all;
    const ids = unescHtml(coded ?? plain).split(/[,，;；、]\s*|\s+/).map(s => s.trim()).filter(Boolean);
    if (!ids.length || !ids.every(id => SOURCE_ID.test(id))) return all;
    return ids.map(id => `<button type="button" class="ca-src-tag" data-ca="source:${escHtml(id)}" title="查看出处">${escHtml(labelOf(id) || '出处')}</button>`).join('');
  });
}
// 「今天」栏折叠：存 localStorage；从没设过时，窗口窄于 1100px 默认收起。
const TODAY_FOLD_KEY = 'hub.companyAssistant.todayFolded';
function todayFolded(storage, width) {
  let v = null; try { v = storage?.getItem(TODAY_FOLD_KEY); } catch { /* 读不到按宽度 */ }
  return v === '1' ? true : v === '0' ? false : Number(width) < 1100;
}
function saveTodayFolded(storage, folded) { try { storage?.setItem(TODAY_FOLD_KEY, folded ? '1' : '0'); } catch { /* 存不了只影响下次默认 */ } }
// 「今天」栏标题下的一句状态和空列表说明。数据正在分批更新时如实说「暂显示上次完成的」，不说成数据没取全。
// 「今天」栏最多列几条提醒：按时间新的在前取（服务端给的是新到旧，这里不再依赖顺序）。
function latestNotices(notices, limit = 2) {
  return (notices || []).filter(n => n.kind !== 'brief').slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}
function todayStatus(d = {}, clock = at => String(at)) {
  const b = d.brief, sections = (b?.sections || []).filter(s => s.items?.length);
  const updating = !!d.updating?.length;
  const up = d.refreshing ? '正在刷新数据…' : updating ? '数据正在更新，暂显示上次完成的简报' : d.refreshedAt ? `数据 ${clock(d.refreshedAt)} 更新` : '还没取过数据';
  let empty = '';
  if (b && b.by !== 'none' && !sections.length) empty = updating ? '数据正在更新，暂显示上次完成的简报；里面没有待处理事项。' : d.errors?.length ? '本次数据尚未取全，已取到的内容里没有待处理事项。' : '已查询的范围内没有需要你处理的会议、消息和邮件。';
  return { up, empty, organizing: !!b?.organizing };
}
// 「今天」栏里会议行只显示时刻：去掉后端完整写法里的日期（今天的会都是今天）和「（上海 UTC+08:00）」时区说明。
const shortMeetingText = text => String(text || '').replace(/\d{4}-\d{2}-\d{2}\s*（周.）\s*/g, '').replace(/\s*（上海 UTC\+08:00）/g, '').replace(/\s{2,}/g, ' ').trim();
// 时间一律按上海时间显示（和后端 D.dayKey / D.clock 一致），不跟电脑本地时区走。
const SHANGHAI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shanghaiParts = at => Object.fromEntries(SHANGHAI.formatToParts(new Date(at)).map(p => [p.type, p.value]));
const shanghaiClock = at => { if (!at) return '—'; const p = shanghaiParts(at); return `${p.hour}:${p.minute}`; };
const shanghaiDay = at => { const p = shanghaiParts(at); return `${p.year}-${p.month}-${p.day}`; };
// '2026-11-05' → '11月5日 周四'（按日期本身算星期，与时区无关）。
function dayTitle(day) {
  const [y, m, d] = String(day || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${m}月${d}日 周${'日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}
// 助理回答进行中的阶段（2026-11-06 用户：等 CodeAgent 时要看到在哪一步、等了多久）；规则与 PPT 检索共用。
const waitPhase = c => require('./wait-progress').assistantChatPhase(c) || { label: '正在查…', verb: '已用', from: c.startedAt || c.askedAt, hint: '' };
const secondsText = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

function createCompanyAssistantPage({ document, window, ipcRenderer, openSession, closeOtherPanels = () => {}, showMessage }) {
  const { ASSISTANT_AVATAR_SRC, USER_AVATAR_SRC } = require('./chat-avatar');
  const { connectionState } = require('./company-assistant-connection');
  const toolPicker = require('./tool-version-picker').createToolVersionPicker({ document, ipcRenderer });
  const { queryRows, refreshNotice } = require('./company-assistant-query-status');
  const { renderMessageBody } = require('./conversation-message-view');
  let page = null, data = null, timer = null, tick = null, sending = false, gate = null, firstPaint = true;
  const openCoverage = new Set();
  const esc = escHtml;
  const clock = shanghaiClock, dayOf = shanghaiDay;
  const when = at => {
    if (!at) return '';
    const day = dayOf(at), now = Date.now();
    if (day === dayOf(now)) return clock(at);
    if (day === dayOf(now + 86400000)) return '明天 ' + clock(at);
    const [, m, d] = day.split('-').map(Number);
    return `${m}-${d} ${clock(at)}`;
  };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-assistant:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  let md = null;
  const markdown = text => {
    try {
      if (!md) md = { marked: require('marked').marked, purify: require('dompurify') };
      return md.purify.sanitize(md.marked.parse(String(text || ''), { breaks: true, gfm: true }));
    } catch { return esc(text).replace(/\n/g, '<br>'); }
  };
  // 正文渲染复用卡片视图的 renderMessageBody（用户原文转义、助理 markdown）；助理页不折长消息，正文不套框。
  const body = (text, isUser) => renderMessageBody(text, { isUser, foldLong: false, escapeHtml: esc, renderMarkdown: markdown });

  const svg = d => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9H8"/><path d="M12 7.5V12l3 2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>'),
    send: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    refresh: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>'),
    fold: svg('<path d="m9 6 6 6-6 6"/>'),
    unfold: svg('<path d="m15 6-6 6 6 6"/>'),
  };
  function nav() {
    let btn = document.getElementById('btn-company-assistant');
    if (btn) return btn;
    // 规则收进了悬停分组（rail-groups.js，2026-10-24）：公司入口要排在整个分组之后，不能塞进分组的抽屉里。
    const rules = document.getElementById('btn-rules');
    const anchor = rules?.closest('.rail-group') || rules || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-assistant';
    btn.title = '助理 · 今天的工作与对话（只读 WeLink，数据只留本机）'; btn.setAttribute('aria-label', '助理');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><img src="assets/assistant/penguin.png" alt="" /></span><span class="btn-label">助理</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-assistant-page'; page.id = 'company-assistant-page'; page.hidden = true; page.setAttribute('aria-label', '助理');
    page.innerHTML = `<main class="ca-main">
      <header class="ca-head">
        <h1>助理</h1><span data-slot="conn"></span>
        <div class="ca-head-right">
          <button type="button" class="ca-head-btn" data-ca="open-session" title="在会话里看助理的完整记录">${ICON.history}<span>历史</span></button>
          <button type="button" class="ca-head-btn" data-ca="settings" title="助理设置：简报与提醒 / WeLink 与邮箱 / 手机 / 桌宠" aria-label="助理设置">${ICON.gear}<span>设置</span></button></div>
      </header>
      <div class="ca-alert" data-slot="alert" role="status"></div>
      <div class="ca-tool-hint" data-slot="tool-hint"></div>
      <div data-slot="action-error" role="alert" hidden></div>
      <div class="ca-panel" data-slot="panel" hidden></div>
      <div class="ca-split" data-slot="split">
        <div class="ca-chat">
          <div class="ca-scroll"><div class="ca-thread"><div data-slot="onboarding"></div><div data-slot="chat"></div></div></div>
          <footer class="ca-foot"><form class="ca-cbox" data-slot="form">
            <div class="ca-cstate" data-slot="job"></div>
            <textarea rows="2" placeholder="问助理任何事，例如「把某个群今天的讨论整理成三点」（Enter 发送，Shift+Enter 换行）" aria-label="问助理"></textarea>
            <div class="ca-cbar"><div class="ca-chips" data-slot="chips"></div><button type="submit" class="ca-send" aria-label="发送" title="发送（Enter）">${ICON.send}</button></div>
          </form></footer>
        </div>
        <aside class="ca-today" data-slot="today" aria-label="今天"></aside>
      </div></main>`;
    document.body.append(page);
    // 可选功能（默认关，renderer/optional-feature-gate.js）：关着时整页提示开启，开着时页头有「已开启 · 关闭」。
    gate = require('./optional-feature-gate').createFeatureGate({ document, window, id: 'assistant', page, showMessage,
      badgeSlot: badge => page.querySelector('.ca-head-right').prepend(badge), onEnabled: () => { void startData(); } });
    // Esc 关掉盖在上面的设置和出处。
    page.addEventListener('keydown', event => {
      const panel = page.querySelector('[data-slot="panel"]');
      if (event.key === 'Escape' && ['settings', 'source'].includes(panel.dataset.kind) && !panel.hidden) closePanel();
    });
    page.addEventListener('click', event => {
      const panel = page.querySelector('[data-slot="panel"]');
      // 出处浮层：点外面的灰底关闭。
      if (event.target === panel && panel.dataset.kind === 'source') { closePanel(); return; }
      const b = event.target.closest('[data-ca]');
      if (b && !b.disabled) {
        event.preventDefault();
        const feedback = page.querySelector('[data-slot="action-error"]'); feedback.hidden = true;
        void action(b.dataset.ca, b).catch(e => {
          b.disabled = false;
          feedback.textContent = '操作未完成：' + e.message + '。可以重试，已填写的内容会保留。'; feedback.hidden = false;
          showMessage?.(e.message);
        }).finally(() => { b.disabled = false; if (data) render(); });
      }
    });
    const form = page.querySelector('[data-slot="form"]'), input = form.querySelector('textarea');
    form.addEventListener('submit', e => { e.preventDefault(); void send(input.value); });
    input.addEventListener('keydown', e => { if (require('./composer-enter-key').isSendKey(e, require('./composer-enter-key').readMode(window.localStorage)) && !e.isComposing) { e.preventDefault(); void send(input.value); } });
  }
  function place() {
    if (!page || page.hidden) return;
    // 底边按底栏高度算（同云端页）：以前按会话区算，从「规则」切过来时会话区被规则页藏着，量出来高度是 0，页面被压成一条、和规则页叠在一起（2026-10-19 用户）。
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
    if (data) applyFold();
  }

  // ---- 页头连接状态点 ----
  // 每一路一行：{ name, color: ok|warn|run|'', text, action }。悬停状态点看全部，点某一行去对应设置。
  function statusRows() {
    const d = data, auth = d.auth || {}, phone = d.phone || {}, p = phone.settings || {};
    const connection = connectionState(d), online = connection.kind === 'online';
    const coverages = [['会议', d.meetingCoverage], ['日程', d.calendarCoverage], ['邮件', d.mailCoverage]];
    const mailText = d.calendarNeedsSetup ? '未接入' : coverages.map(([name, c]) => name + ({ complete: '已查', partial: '未取全', failed: '失败' }[c?.status] || '待查')).join(' · ');
    const loginText = online ? (auth.lastRenewAt ? '已连接 · 自动续期，上次 ' + clock(auth.lastRenewAt) : '已连接 · 自动维护登录') : connection.title;
    const phoneText = !p.groupId ? '未接通（可在设置·手机里接通）' : phone.lastError ? phone.lastError : !p.enabled ? '已暂停' : '已开启 · ' + (p.groupName || '群 ' + p.groupId.slice(-6));
    const rows = [
      { name: 'WeLink', color: auth.state === 'renewing' ? 'run' : online ? 'ok' : 'warn', text: loginText, action: d.cliFound && auth.state === 'needs-scan' ? 'login' : 'settings-tab:welink' },
      { name: '邮件日历', color: d.calendarNeedsSetup || coverages.some(([, c]) => c?.status === 'failed') ? 'warn' : coverages.every(([, c]) => c?.status === 'complete') ? 'ok' : '', text: mailText, action: 'settings-tab:welink' },
      { name: '手机对话', color: p.enabled && p.groupId && !phone.lastError ? 'ok' : phone.lastError ? 'warn' : '', text: phoneText, action: 'settings-tab:phone' },
    ];
    const tools = toolsRow();
    if (tools) rows.push(tools);
    return rows;
  }
  // 会话工具（v3.1.1）：助理会话里查、管其他会话的 hub_sessions 接没接上。
  let toolsTimer = null;
  function toolsRow() {
    const t = data.tools;
    clearTimeout(toolsTimer);
    if (!t || t.state === 'ready') return null;
    // 「正在接通」到期（会话起来满 90 秒）时重新取一次状态，到点翻成「未接上」。
    if (t.state === 'starting' && t.checkAt) toolsTimer = setTimeout(() => { void load().catch(() => {}); }, Math.max(1000, t.checkAt - (data.now || Date.now()) + 500));
    return { name: '会话工具', color: { linked: 'ok', starting: 'run', missing: 'warn' }[t.state] || '', text: t.label || ({ linked: '已接上', starting: '正在接通', missing: '没接上' }[t.state] || t.state), action: t.state === 'missing' ? 'reopen-session' : 'open-session' };
  }
  function status() {
    const rows = statusRows();
    const overall = rows.some(r => r.color === 'warn') ? 'warn' : rows.some(r => r.color === 'run') ? 'run' : rows[0].color === 'ok' ? 'ok' : '';
    const label = { warn: '有问题', run: '正在连接', ok: '已连接' }[overall] || '未连接';
    return `<span class="ca-status" tabindex="0" aria-label="连接状态：${label}"><i class="ca-conn-dot ${overall}"></i><span>${label}</span>
      <span class="ca-status-tip" role="tooltip">${rows.map(r => `<button type="button" class="ca-status-row" data-ca="${r.action}" title="${esc(r.name + ' · ' + r.text)}"><i class="ca-conn-dot ${r.color}"></i><b>${esc(r.name)}</b><span>${esc(r.text)}</span></button>`).join('')}</span></span>`;
  }
  // 页头下的提示条：只在有问题时出现，每个问题一行并附处理按钮（补填邮箱、会话工具告警都只在这里出现）。
  function alerts() {
    const d = data, out = [];
    const connection = connectionState(d);
    const btn = (actionName, label, primary) => `<button type="button" class="ca-btn small${primary ? ' primary' : ''}" data-ca="${actionName}">${esc(label)}</button>`;
    if (connection.kind !== 'online' && !onboardingShown()) out.push([connection.title, connection.detail, (connection.action ? btn(connection.action, connection.label, true) : '') + (connection.alt ? btn(connection.alt, connection.altLabel) : '')]);
    if (connection.kind === 'online' && d.calendarNeedsSetup) {
      const auto = d.mailSetup || {};
      const why = auto.reason === 'no-email' ? 'WeLink 账号信息里没读到你的邮箱，需要补填一次。' : auto.email ? `用 ${auto.email} 自动配置没成功${auto.output ? '（' + auto.output + '）' : ''}。` : '还没接入。';
      out.push(['邮件和日历暂不可用', why, `<div class="ca-row"><input type="email" data-ca-email placeholder="填写公司邮箱" value="${esc(auto.email || d.settings?.email || '')}">${btn('configure-mail', '保存并配置', true)}<span class="ca-note" data-ca-mail-msg></span></div>`]);
    }
    const failed = [['会议', d.meetingCoverage], ['日程', d.calendarCoverage], ['邮件', d.mailCoverage]].filter(([, c]) => c?.status === 'failed').map(([n]) => n);
    if (connection.kind === 'online' && !d.calendarNeedsSetup && failed.length) out.push([failed.join('、') + '查询失败', '已取到的内容照常显示，可以稍后刷新。', btn('refresh', '刷新')]);
    const t = d.tools;
    if (t?.state === 'missing') out.push(['会话工具没接上', (t.label || '') + (t.reason ? '。原因：' + t.reason : ''), btn('reopen-session', '重开助理会话')]);
    const phone = d.phone || {};
    if (phone.lastError && phone.settings?.enabled) out.push(['手机对话出错', phone.lastError, btn('settings-tab:phone', '去设置')]);
    return out.map(([title, detail, button]) => `<div class="ca-alert-row"><span class="ca-alert-mark">⚠</span><b>${esc(title)}</b><span class="ca-alert-text">${esc(detail)}</span>${button}</div>`).join('');
  }

  // welink-cli 没找到时（2026-10-19）：后台在全盘找就显示进度；找完还没有就给「再找一次」「手动选择…」。
  const CLI_STAGE = { path: '看系统路径', npm: '问 npm 全局目录', disk: '在各个硬盘里找' };
  function cliChip(d) {
    const s = d.cliSearch || {};
    if (s.state === 'searching') return `<span class="ca-chip run">正在查找 welink-cli…${CLI_STAGE[s.stage] ? '（' + CLI_STAGE[s.stage] + '）' : ''}</span>`;
    const inst = d.cliInstall || {};
    if (['checking', 'downloading', 'verifying'].includes(inst.phase)) return `<span class="ca-chip run">${esc(inst.message || '正在安装 welink-cli…')}</span>`;
    const installBtn = d.cliInstallAvailable ? `<button type="button" class="ca-btn small primary" data-ca="install-cli">${inst.phase === 'error' ? '重试安装' : '一键安装'}</button>` : '';
    return `<span class="ca-chip bad">${inst.phase === 'error' ? esc(inst.error || '安装未完成') : s.state === 'error' ? '查找未完成' : '尚未检测到 welink-cli'}</span>${installBtn}<button type="button" class="ca-btn small" data-ca="find-cli">再找一次</button><button type="button" class="ca-btn small" data-ca="pick-cli">手动选择…</button>`;
  }
  function installGuide() {
    return `<details class="ca-install-guide"><summary>还没安装？查看安装步骤</summary><ol><li>在公司电脑连接公司网络，按内部 WeLink CLI 文档安装 <code>@welink/welink-cli</code>。已有 Node.js / npm 且配置好公司指定的软件源时，安装命令为：<pre>npm install -g @welink/welink-cli</pre>版本、软件源和权限要求以内部安装文档为准。</li><li>如果拿到的是公司分发的安装包，先完成安装，再点“手动选择…”选择 <code>welink-cli.exe</code> 或 <code>welink-cli.cmd</code>。</li><li>安装后点“已安装，重新检测”，确认连接后按提示扫码登录。邮件和日历可随后配置。</li></ol><p class="ca-note">${data.cliInstallAvailable ? '一键安装不需要这些步骤；只有一键安装失败时才需要手动操作。' : '这里提供操作说明；这个版本不提供一键安装。'}</p></details>`;
  }
  // 首次接入引导：还没连上 WeLink 或还没取过数据时出现在对话区开头（连上并取过数后消失）。
  function onboardingShown() { const c = connectionState(data); return !(c.kind === 'online' && data.refreshedAt); }
  function onboarding() {
    if (!onboardingShown()) return '';
    const c = connectionState(data), ready = c.kind === 'online';
    return `<article class="ca-onboarding" data-connection="${c.kind}"><h2>${esc(ready ? '正在获取今天的工作信息' : c.title)}</h2><p>${esc(c.detail)}</p><div class="ca-onboarding-steps" aria-label="接入进度"><span>${data.cliFound ? '✓' : '1'} 安装工具</span><span>${ready ? '✓' : '2'} 确认登录</span><span>${ready && data.refreshedAt ? '✓' : '3'} 获取工作信息</span></div>${c.action ? `<button type="button" class="ca-btn primary" data-ca="${c.action}">${esc(c.label)}</button>` : ''}${c.alt ? `<button type="button" class="ca-btn" data-ca="${c.alt}">${esc(c.altLabel)}</button>` : ''}${!data.cliFound ? '<button type="button" class="ca-btn" data-ca="pick-cli">手动选择…</button>' + installGuide() : ''}<p class="ca-note">接通前也可以直接提问，讨论已有的材料。</p>${!ready && ['missing', 'login', 'unknown'].includes(c.kind) && window.HubErrorCard ? window.HubErrorCard.assistHtml({ area: 'welink', title: c.title, symptom: c.detail, details: [c.title, c.detail, data.cliSearch?.error].filter(Boolean).join(' · ') }) : ''}</article>`;
  }
  function loginPanel() {
    const f = data.loginFlow;
    if (!f || f.state === 'ok') return '';
    // 2026-10-22 v3.1.1：真机二维码是字符画，主进程转成 SVG（kind:'blocks'）按原尺寸显示，不缩放免得模块边缘发糊；
    // 登录网页（f.url）不是图片，只做下面那行「在浏览器打开」。
    const p = f.progress || {};
    const failed = f.state === 'failed' || p.phase === 'failed', scanned = !failed && p.phase === 'scanned';
    // 超时或失败后旧二维码已失效、扫码成功后也用不着了，都不再显示。
    let qr = '';
    if (failed || scanned) { /* 不显示 */ } else if (f.qr?.kind === 'blocks') qr = `<img class="ca-qr ca-qr-blocks" src="${esc(f.qr.value)}" width="${Number(f.qr.px) || ''}" height="${Number(f.qr.px) || ''}" alt="WeLink 登录二维码">`;
    else if (f.qr?.kind === 'data') qr = `<img class="ca-qr" src="${esc(f.qr.value)}" alt="WeLink 登录二维码">`;
    else if (f.qr?.kind === 'file') qr = `<img class="ca-qr" src="${esc('file:///' + f.qr.value.replace(/\\/g, '/'))}" alt="WeLink 登录二维码">`;
    const reason = p.phase === 'failed' ? p.reason : f.error;
    const state = failed ? '登录没成功：' + esc(reason || '') : scanned ? '已扫码，正在登录…'
      // 字符画已经输出完（进入等待扫码）却没能还原成二维码：同样提示改用链接，下面附上原样输出备查。
      : { waiting: f.garbled || (!f.qr && p.phase === 'waiting') ? '二维码显示失败，请用下方链接。' : '用手机 WeLink 扫下面的二维码；扫完这里会自动刷新。', finished: '登录命令已结束，正在核对登录状态…', ok: '' }[f.state] || '';
    const tickLine = f.state === 'waiting' && !failed && p.phase === 'waiting' ? `<p class="ca-qr-status">等待扫码 · ${Number(p.elapsed) || 0} 秒</p>` : '';
    const link = !scanned && /^https:\/\//i.test(f.url || '') ? `<p class="ca-qr-link">二维码扫不出来？<button type="button" class="ca-link" data-ca="open-login-url">在浏览器打开</button></p>` : '';
    // 认不出的输出原样给出来（排查用）；框还在流式输出（obtaining）、判成乱码或已结束时不贴。
    const raw = !f.qr && f.text && !f.garbled && !failed && !scanned && p.phase !== 'obtaining' ? `<pre class="ca-qr-text">${esc(f.text.slice(-3000))}</pre>` : '';
    const retry = failed || (f.state === 'finished' && !scanned) ? '<button type="button" class="ca-btn primary" data-ca="login">重新获取二维码</button>' : '';
    return `<div class="ca-login"><b>扫码登录 WeLink</b><p>${state}</p>${qr}${tickLine}${link}${raw}<div class="ca-row"><button type="button" class="ca-btn" data-ca="close-panel">收起</button>${retry}</div></div>`;
  }

  // ---- 右栏「今天」（原今日简报）----
  const SECTION_SHORT = { meetings: '会', awaiting: '回', commitments: '诺', groups: '群', mail: '邮' };
  const NOTICE_NAMES = { reminder: '重要提醒', digest: '定时汇总', brief: '简报', 'meeting-prep': '会前准备', 'awaiting-reply': '等你回复', 'commitment-due': '答应的事', overbooked: '会议太满', 'day-summary': '下班小结', keyword: '关注词' };
  // 会议节：已结束的置灰，下一场标「下一场」，正在开的标「进行中」。
  function meetingStates(items, now) {
    const next = items.filter(i => Number.isFinite(i.start) && i.start > now).sort((a, b) => a.start - b.start)[0];
    return new Map(items.map(i => [i, Number.isFinite(i.end) && i.end <= now ? 'past' : Number.isFinite(i.start) && i.start <= now && (!Number.isFinite(i.end) || i.end > now) ? 'live' : i === next ? 'next' : '']));
  }
  function briefLabelMap() {
    const map = new Map();
    for (const s of data.brief?.sections || []) for (const i of s.items || []) { if (i.source && i.sourceLabel) map.set(i.source, i.sourceLabel); }
    return map;
  }
  function todayItem(i, key, day, state) {
    const tags = [state === 'next' ? '<span class="ca-ti-tag next">下一场</span>' : state === 'live' ? '<span class="ca-ti-tag next">进行中</span>' : '',
      i.merged ? `<span class="ca-ti-tag">${esc(i.mergedLabel || 'WeLink + 日历')}</span>` : '', i.guess ? '<span class="ca-ti-tag amber">推测</span>' : '', i.due ? `<span class="ca-ti-tag red">截止 ${esc(i.due)}</span>` : '',
      i.settledLabel ? `<span class="ca-ti-tag">${esc(i.settledLabel)}</span>` : ''].join('');
    // 会议行的出处标签（「会议 · 04:08 方案评审」）和正文重复，不再列。
    const label = i.sourceLabel && i.sourceLabel !== '查看出处' && !(key === 'meetings' && /^(会议|日程) · /.test(i.sourceLabel)) ? i.sourceLabel : '';
    // 等我回复用了 AI 的「事 → 建议」写法时，已等多久放在小字里（2026-11-07）。
    const sub = [label ? esc(label) : '', i.waited ? esc(i.waited) : '', state === 'past' ? '已结束' : ''].filter(Boolean).join(' · ');
    // 会议行：后端给了紧凑字段（when / subject / location）就排成「时间加粗 + 主题」一行、地点小字一行；没有就退回整段 text（去掉日期与时区）。
    const compact = key === 'meetings' && i.subject && i.when;
    const text = key === 'meetings' ? shortMeetingText(i.text) : i.text;
    const subLine = [compact && i.location ? esc(i.location) : '', sub].filter(Boolean).join(' · ');
    return `<div class="ca-ti${state === 'past' ? ' past' : ''}" data-key="${esc(key)}">
      <button type="button" class="ca-ti-main" data-ca="source:${esc(i.source)}" data-source-day="${esc(day)}" title="查看出处">${compact ? `<b class="ca-ti-when">${esc(i.when)}</b>${esc(i.subject)}` : esc(text)}${tags ? `<span class="ca-ti-tags">${tags}</span>` : ''}${subLine ? `<small>${subLine}</small>` : ''}${i.preparation ? `<small class="ca-ti-prep">会前准备：${esc(i.preparation)}</small>` : ''}</button>
      <span class="ca-ti-acts"><button type="button" data-ca="ask-about:${esc(i.source)}" title="把这件事填进输入框问助理">问助理</button>${state === 'past' ? '' : `<button type="button" data-ca="done:${esc(i.source)}" title="点了以后不再出现在今天里">处理了</button>`}</span></div>`;
  }
  function todayHtml() {
    const d = data, b = d.brief, now = d.now || Date.now();
    const sections = (b?.sections || []).filter(s => s.items?.length);
    if (isFolded()) {
      const badges = sections.map(s => {
        const states = s.key === 'meetings' ? meetingStates(s.items, now) : null;
        const n = s.items.filter(i => states?.get(i) !== 'past').length;
        return n ? `<span class="ca-today-badge" title="${esc(s.title)} ${n} 条">${esc(SECTION_SHORT[s.key] || s.title.slice(0, 1))} ${n}</span>` : '';
      }).join('');
      const count = (d.notices || []).filter(n => n.kind !== 'brief').length;
      const notices = count ? `<span class="ca-today-badge amber" title="提醒 ${count} 条">醒 ${count}</span>` : '';
      return `<button type="button" class="ca-fold-btn" data-ca="today-fold" title="展开今天" aria-label="展开今天" aria-expanded="false">${ICON.unfold}</button><button type="button" class="ca-today-vt" data-ca="today-fold" title="展开今天">今天</button>${notices}${badges}`;
    }
    const day = b?.day || d.day || dayOf(now);
    const { up, empty } = todayStatus(d, clock);
    const head = `<div class="ca-today-hd"><h2>今天 · ${dayTitle(d.day || dayOf(now))}</h2>
        <button type="button" class="ca-fold-btn" data-ca="refresh" title="刷新数据" aria-label="刷新数据"${d.refreshing ? ' disabled' : ''}>${ICON.refresh}</button>
        <button type="button" class="ca-fold-btn" data-ca="today-fold" title="收起" aria-label="收起今天" aria-expanded="true">${ICON.fold}</button></div>
      <div class="ca-today-up">${esc(up)}${b?.organizing ? ' · <span class="ca-today-ai">AI 正在挑重点</span>' : ''}</div>`;
    // 助理批注：简报整体的说明（AI 没整理完、改用规则清单的原因等），放在标题下面。
    const note = b?.note && b.by !== 'none' && !b.organizing ? `<p class="ca-today-note" data-slot="brief-note">${esc(b.note)}</p>` : '';
    // 「简报已生成」这类提醒就是本栏本身，不再重复列。
    const noticeAll = (d.notices || []).filter(n => n.kind !== 'brief'), noticeList = latestNotices(d.notices, 2);
    const notices = noticeList.length ? `<div class="ca-tg"><span>提醒</span><small>${noticeAll.length}</small></div>${noticeList.map(n => `<div class="ca-notice" data-notice-id="${esc(n.id)}"><button type="button" class="ca-ti-main ca-notice-line"${n.detail?.source ? ` data-ca="source:${esc(n.detail.source)}"` : ''} title="${esc([n.title, n.text && n.text !== n.title ? n.text : ''].filter(Boolean).join('\n'))}"><span class="ca-ti-tag amber">${esc(NOTICE_NAMES[n.kind] || n.kind)}</span><span class="ca-notice-title">${esc(n.title)}</span><time>${n.kind === 'digest' ? '汇总于 ' : ''}${when(n.at)}</time></button>${n.kind === 'digest' ? require('./company-assistant-digest').digestList(n, esc) : ''}</div>`).join('')}` : '';
    let list;
    if (!b) list = `<p class="ca-today-empty">今天的摘要还没生成。</p><button type="button" class="ca-btn small primary" data-ca="brief-now">现在生成</button>`;
    else if (b.by === 'none') list = `<p class="ca-today-empty">${esc(b.note || '今天暂时没有可整理的信息。')}</p>`;
    else if (!sections.length) list = `<p class="ca-today-empty">${esc(empty)}</p>`;
    else list = sections.map(s => {
      const states = s.key === 'meetings' ? meetingStates(s.items, now) : new Map();
      const top = s.items.filter(i => i.top !== false), rest = s.items.filter(i => i.top === false);
      const shown = top.length ? top : rest, more = top.length ? rest : [];
      return `<section class="ca-tsec" data-section="${esc(s.key)}"><div class="ca-tg"><span>${esc(s.title)}</span><small>${s.items.length}</small></div>${shown.map(i => todayItem(i, s.key, day, states.get(i))).join('')}${more.length ? `<details class="ca-tmore"><summary>还有 ${more.length} 条</summary>${more.map(i => todayItem(i, s.key, day, states.get(i))).join('')}</details>` : ''}</section>`;
    }).join('');
    const regen = b && b.by !== 'none' ? `<div class="ca-today-foot"><button type="button" class="ca-link quiet" data-ca="brief-now" title="按最新数据重新整理今天">重新整理</button></div>` : '';
    return head + note + notices + list + regen;
  }
  let folded = null;
  const isFolded = () => folded ?? todayFolded(window.localStorage, window.innerWidth);
  function applyFold() { page.querySelector('[data-slot="split"]').classList.toggle('fold', isFolded()); }

  // ---- 左栏对话（卡片视图样式）----
  function labelFor(item) {
    const own = sourceLabels(item.sources), brief = briefLabelMap();
    return id => own[id] || brief.get(id) || '出处';
  }
  function coverageLine(c, id) {
    if (!c) return '';
    const open = openCoverage.has(id);
    const link = c.details.length ? `<button type="button" class="ca-cov-link" data-ca="cov:${esc(id)}" aria-expanded="${open}">${open ? '收起' : '查询范围'}</button>` : '';
    const line = c.ok === null ? '' : c.ok ? `<span><span class="ca-cov-ok">✓</span> 已查 ${esc(c.line)}</span>` : `<span>⚠ ${esc(c.line)}</span>`;
    return `<div class="ca-cov${c.ok === false ? ' warn' : ''}">${line}${link}</div>${open && c.details.length ? `<div class="ca-covd">${c.details.map(x => `<div>${esc(x)}</div>`).join('')}</div>` : ''}`;
  }
  function chatList() {
    const list = visibleChat(data.chat);
    if (!list.length) return onboardingShown() ? '' : '<p class="ca-empty-chat">还没有提问。下面输入框可以直接问，或点一个常用问题；右边「今天」里的事项悬停后也能直接问助理。</p>';
    let lastDay = '';
    return list.map(c => {
      const labelOf = labelFor(c), id = c.id || '';
      const day = c.askedAt ? dayOf(c.askedAt) : '';
      const divider = day && day !== lastDay && lastDay ? `<div class="ca-day-divider"><span>${dayTitle(day).split(' ')[0]}</span></div>` : '';
      lastDay = day || lastDay;
      const words = [...String(c.q || '')].length;
      const user = `<div class="ca-turn user" data-chat-id="${esc(id)}"><span class="ca-turn-avatar av-user"><img src="${USER_AVATAR_SRC}" alt=""></span><div class="ca-turn-content">
          <div class="ca-turn-head"><b class="ca-turn-who">我</b>${c.via === 'phone' ? '<span class="ca-turn-tag">手机</span>' : ''}${c.askedAt ? `<time>${when(c.askedAt)}</time>` : ''}<span>${words} 字</span></div>
          <div class="ca-bubble">${tagSources(body(c.q, true), labelOf)}</div></div></div>`;
      let answer, meta;
      if (c.state === 'done') {
        const { body: text, coverage } = answerCoverage(c);
        const pptLinks = (c.pptResults || []).map(p => `<div class="ca-ppt-reference"><span>${esc(p.name)} · 第 ${esc(p.page)} 页</span><button type="button" class="ca-link" data-ca="ppt-open:${esc(p.id)}">打开到第 ${esc(p.page)} 页</button></div>`).join('');
        answer = `<div class="ca-answer">${tagSources(body(text, false), labelOf)}</div>${pptLinks}${coverageLine(coverage, id)}`;
        meta = `${c.answeredAt ? `<time>${when(c.answeredAt)}</time>` : ''}${c.answeredAt && (c.startedAt || c.askedAt) ? `<span>用时 ${secondsText(c.answeredAt - (c.startedAt || c.askedAt))}${c.startedAt && c.answeringAt ? `（准备 ${secondsText(c.answeringAt - c.startedAt)} · 回答 ${secondsText(c.answeredAt - c.answeringAt)}）` : ''}</span>` : ''}`;
      } else if (c.state === 'error') {
        const why = c.stopped ? '已停止这一问' : `没答上：${esc(c.error || '原因未知')}`;
        answer = `<div class="ca-turn-error${c.stopped ? ' is-stopped' : ''}"><span>${why}</span><button type="button" class="ca-btn small" data-ca="retry:${esc(id)}">重问</button></div>${!c.stopped && window.HubErrorCard ? window.HubErrorCard.knownHtml({ area: 'codeagent', title: c.error || '助理没答上', details: c.error || '' }) : ''}`;
        meta = c.askedAt ? `<time>${when(c.askedAt)}</time>` : '';
      } else {
        // 三段：排队 → CodeAgent 准备中（开会话、送入问题，通常 10–20 秒）→ 正在查（问题已送进去）。
        const guide = c.state === 'running' && c.guide?.kinds?.length ? `按「${c.guide.kinds.join('、')}」作答${c.guide.items ? ` · 已备好材料 ${c.guide.items} 条` : ''} · 正在写…` : '';
        const phase = waitPhase(c);
        const from = phase.from;
        const since = from ? `<span>${phase.verb} <span data-since="${Number(from)}">${secondsText(Date.now() - from)}</span>${phase.hint ? `<span class="ca-wait-hint">（${phase.hint}）</span>` : ''}</span>` : '';
        const label = guide && phase.label === '正在查…' ? esc(guide) : phase.label;
        // 审计 A3-17：等着的问题可以停下（只结束这一问，其他队列照常）。
        answer = `<div class="ca-think"><span class="ca-dots"><i></i><i></i><i></i></span>${label}${c.notReadySince != null && !c.answeringAt ? '<button type="button" class="ca-btn small" data-ca="open-session">打开助理会话</button>' : ''}<button type="button" class="ca-btn small ca-stop" data-ca="stop:${esc(id)}">停止这一问</button></div>`;
        meta = since;
      }
      const assistant = `<div class="ca-turn assistant${c.state === 'done' || c.state === 'error' ? '' : ' is-thinking'}"><span class="ca-turn-avatar"><img src="${ASSISTANT_AVATAR_SRC}" alt=""></span><div class="ca-turn-content">
          <div class="ca-turn-head"><b class="ca-turn-who">助理</b>${meta}</div>${answer}</div></div><div class="ca-turn-sep" aria-hidden="true"></div>`;
      return divider + user + assistant;
    }).join('');
  }
  // 进行中的已用秒数每秒刷新（只改数字，不重画）。
  function tickElapsed() {
    if (!page || page.hidden) return;
    page.querySelectorAll('[data-since]').forEach(e => { e.textContent = secondsText(Date.now() - Number(e.dataset.since)); });
  }

  function render() {
    if (!page || !data) return;
    page.querySelector('[data-slot="conn"]').innerHTML = status();
    const panel = page.querySelector('[data-slot="panel"]');
    if (!panel.dataset.kind || panel.dataset.kind === 'login') { const html = loginPanel(); panel.innerHTML = html; panel.hidden = !html; panel.dataset.kind = html ? 'login' : ''; }
    const querySlot = panel.querySelector('[data-slot="query-rows"]');
    if (querySlot) querySlot.innerHTML = querySnapshotRows(data);
    const queryTime = panel.querySelector('[data-slot="query-time"]');
    if (queryTime) queryTime.textContent = '最近一次取数（' + (data.refreshedAt ? when(data.refreshedAt) : '还没取过') + '）';
    // 内容没变就不重画；重画时保留折叠块（还有 N 条、查询范围）的展开状态。
    const setHtml = (slot, html) => {
      const el = page.querySelector(`[data-slot="${slot}"]`);
      if (el.dataset.html === html) return false;
      const opened = [...el.querySelectorAll('details')].map(d => d.open);
      el.innerHTML = html; el.dataset.html = html;
      el.querySelectorAll('details').forEach((d, i) => { if (opened[i]) d.open = true; });
      return true;
    };
    const alertHtml = alerts();
    setHtml('alert', alertHtml); page.querySelector('[data-slot="alert"]').hidden = !alertHtml;
    // 装了多个版本的 welink-cli（2026-11-07）：一行不打扰的提示，点开是版本选择器（renderer/tool-version-picker.js）。
    setHtml('tool-hint', toolPicker.hintHtml(data.cliChoice));
    applyFold();
    setHtml('today', todayHtml());
    setHtml('onboarding', onboarding());
    // 新提问后滚到底（send 里做）；其余重绘保留滚动位置；第一次打开时停在最新一条。
    const scroll = page.querySelector('.ca-scroll'), top = scroll.scrollTop;
    const changed = setHtml('chat', chatList());
    if (firstPaint) { scroll.scrollTop = scroll.scrollHeight; if (visibleChat(data.chat).length) firstPaint = false; } else if (changed) scroll.scrollTop = top;
    const customChipStart = data.chips.length - data.settings.chips.length;
    page.querySelector('[data-slot="chips"]').innerHTML = data.chips.map((c, i) => {
      const chip = `<button type="button" class="ca-chip-btn${c.custom ? ' custom' : ''}" data-ca="chip:${i}" title="${esc(c.text)}">${esc(c.label)}</button>`;
      return c.custom ? `<span class="ca-chip-wrap">${chip}<button type="button" class="ca-chip-del" data-ca="del-chip:${i - customChipStart}" title="删除常用：${esc(c.label)}" aria-label="删除常用：${esc(c.label)}">×</button></span>` : chip;
    }).join('') + '<button type="button" class="ca-chip-btn add" data-ca="save-chip" title="把输入框里的问题存成常用">＋ 存为常用</button>';
    const job = data.job ? (data.job.type === 'brief' ? '助理正在整理今天的摘要…' : '助理正在回答…') + (data.queued ? `（还有 ${data.queued} 个排队）` : '') : '已就绪 · 只读，草稿你自己发';
    const jobEl = page.querySelector('[data-slot="job"]');
    jobEl.innerHTML = `<i class="${data.job ? 'run' : ''}"></i>${esc(job)}`;
    page.querySelectorAll('[data-ca="refresh"]').forEach(b => { b.disabled = !!data.refreshing; });
  }
  async function load() { data = await call('status'); render(); }

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || sending) return;
    sending = true;
    try {
      await call('ask', { text: q });
      page.querySelector('[data-slot="form"] textarea').value = '';
      await load();
      const scroll = page.querySelector('.ca-scroll'); scroll.scrollTop = scroll.scrollHeight;
    } catch (error) { showMessage?.('没发出去：' + error.message); } finally { sending = false; }
  }

  // 点小标签：要补内容的（汇总某个群…）只填进输入框，其余直接发出。
  function useChip(c) {
    if (!c) return;
    const input = page.querySelector('[data-slot="form"] textarea');
    if (c.fill) { input.value = c.text; input.focus(); const at = c.text.indexOf('「」'); if (at >= 0) input.setSelectionRange(at + 1, at + 1); return; }
    return send(c.text);
  }
  // 「今天」条目悬停「问助理」：把「关于这件事：<内容> [出处]」填进输入框，光标停在末尾等你补一句要问什么（不替你直接发）。
  function askAbout(source) {
    const input = page.querySelector('[data-slot="form"] textarea');
    const item = (data.brief?.sections || []).flatMap(s => s.items || []).find(i => i.source === source);
    if (!item) return;
    if (input.value.trim()) { input.focus(); showMessage?.('输入框里已有草稿，请先处理后再问这件事。'); return; }
    input.value = `关于这件事：${item.text} [${source}]\n`;
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
  // 桌宠（hub-pet，2026-10-16）：点桌宠或右键里的事项，在 window 上发 hub-pet:open-assistant，
  // detail = { source, action?, prompt?, noticeId?, sessionId? }。打开助理页；action 对上小标签就等于点那个标签，
  // 否则把 prompt 填进输入框（输入框里已有内容不覆盖）；noticeId 对应的提醒在「今天」栏里高亮并滚到眼前。
  async function fromPet(detail = {}) {
    await open();
    // 桌宠右键「桌宠设置…」「更多形象…」：直接打开设置的对应分页。助理没开时只揭开设置，不启动助理。
    if (detail.settingsTab) {
      if (gate && !gate.isOn()) { gate.peek(); await load().catch(() => {}); }
      openSettings(String(detail.settingsTab)); return;
    }
    const input = page.querySelector('[data-slot="form"] textarea');
    const chip = detail.action ? (data?.chips || []).find(c => c.action === detail.action) : null;
    if (chip && !(chip.fill && input.value.trim())) await useChip(chip);
    else if (detail.prompt && !input.value.trim()) { input.value = String(detail.prompt); input.focus(); }
    if (detail.noticeId) {
      if (String(detail.noticeId).startsWith('digest:') && !data.notices?.some(notice => notice.id === detail.noticeId)) {
        try { const result = await call('digest-notice', { id: detail.noticeId }); data.notices = [result.notice, ...(data.notices || [])]; render(); }
        catch (error) { showMessage?.(error.message); }
      }
      if (isFolded()) { folded = false; saveTodayFolded(window.localStorage, false); render(); }
      const row = [...page.querySelectorAll('.ca-notice')].find(n => n.dataset.noticeId === String(detail.noticeId));
      if (row) { row.classList.add('focus'); row.scrollIntoView({ block: 'center' }); setTimeout(() => row.classList.remove('focus'), 3000); }
    }
  }

  function closePanel() { const panel = page.querySelector('[data-slot="panel"]'); panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = 'closed'; }
  async function action(name, button) {
    const input = page.querySelector('[data-slot="form"] textarea');
    const [verb, arg] = name.split(/:(.*)/s);
    if (verb === 'chip') return useChip(data.chips[Number(arg)]);
    if (verb === 'save-chip') {
      const text = input.value.trim(); if (!text) { showMessage?.('先在输入框里写好要存的问题'); return; }
      const label = text.replace(/\s+/g, ' ').slice(0, 10);
      await call('set-settings', { chips: [...data.settings.chips, { label, text }] }); showMessage?.('已存为常用：' + label); await load(); return;
    }
    if (verb === 'del-chip') {
      const chip = data.settings.chips[Number(arg)]; if (!chip) return;
      await call('set-settings', { chips: data.settings.chips.filter(c => c !== chip) }); showMessage?.('已删除常用：' + chip.label); await load(); return;
    }
    if (verb === 'today-fold') { folded = !isFolded(); saveTodayFolded(window.localStorage, folded); render(); return; }
    if (verb === 'cov') { if (openCoverage.has(arg)) openCoverage.delete(arg); else openCoverage.add(arg); render(); return; }
    if (verb === 'ask-about') return askAbout(arg);
    // 点了就有回应（2026-11-06）：先说在干什么；结束后一定给结论——没连上就说原因，以前登录没认出时什么提示都没有，看起来像没点上。
    if (verb === 'refresh') {
      button.disabled = true;
      showMessage?.(data.refreshing ? '后台这一轮先让路，马上按你这次取数（只补有变化和置顶的会话）…' : '正在检查 WeLink 登录并取数…');
      try { data = await call('refresh'); } catch (error) { button.disabled = false; showMessage?.('没完成：' + error.message); return; }
      render();
      const after = connectionState(data);
      if (after.kind !== 'online') { showMessage?.(`${after.title}${after.detail ? '：' + after.detail : ''}`); return; }
      if (data.refreshJoined) { button.disabled = !!data.refreshing; showMessage?.(`WeLink 已连接；后台这一轮取数${data.refreshSince ? '从 ' + clock(data.refreshSince) + ' 开始' : ''}还在进行（最多约 6 分钟），完成后自动更新`); return; }
      showMessage?.(refreshNotice(data) || 'WeLink 已连接，数据已更新');
      return;
    }
    if (verb === 'brief-now') { button.disabled = true; data = await call('brief-now'); render(); return; }
    if (verb === 'done') { await call('mark-done', { source: arg }); await load(); return; }
    if (verb === 'source') return openSource(arg, button.dataset.sourceDay);
    if (verb === 'retry') { await call('retry-chat', { id: arg }); await load(); return; }
    if (verb === 'stop') {
      button.disabled = true; button.textContent = '正在停止…';
      try { await call('stop-chat', { id: arg }); } catch (error) { showMessage?.('没停下：' + error.message); }
      await load(); return;
    }
    if (verb === 'login') { button.disabled = true; const panel = page.querySelector('[data-slot="panel"]'); panel.dataset.kind = 'login'; await call('login'); await load(); return; }
    if (verb === 'open-login-url') { const url = data.loginFlow?.url || ''; if (/^https:\/\//i.test(url)) await require('electron').shell.openExternal(url); return; }
    if (verb === 'close-panel') { closePanel(); return; }
    if (verb === 'settings') return openSettings();
    if (verb === 'ppt-open') {
      button.disabled = true;
      try { const r = await call('ppt-open', { id: arg }); if (r.pageFocused === false) showMessage?.(`已打开文件，请查看第 ${r.page} 页；当前环境未能自动跳页`); }
      catch (error) { showMessage?.(error.message); }
      finally { button.disabled = false; }
      return;
    }
    if (verb === 'settings-tab') return openSettings(arg);
    if (verb === 'configure-mail') return setupMail(page.querySelector('[data-ca-email]'), page.querySelector('[data-ca-mail-msg]'), button);
    if (verb === 'open-session') return window.__companyAssistantOpenSession();
    if (verb === 'reopen-session') { button.disabled = true; showMessage?.('正在重开助理会话…'); await call('reopen-session'); await load(); showMessage?.('助理会话已重开，会话工具接上后状态点会变绿'); return; }
    const reopenSettings = () => { const p = page.querySelector('[data-slot="panel"]'); if (p.dataset.kind === 'settings' && !p.hidden) openSettings(); };
    if (verb === 'install-cli') {
      button.disabled = true;
      const r = await call('install-cli');
      await load(); reopenSettings();
      if (!r.ok) { showMessage?.(r.error || '安装未完成，可以重试或手动选择'); return; }
      showMessage?.(r.already ? '这台电脑已经装了 welink-cli，直接用它' : '安装好了，正在进入登录');
      if (data.auth?.login?.ok) return;
      await call('login'); await load(); return;
    }
    if (verb === 'find-cli') { button.disabled = true; await call('find-cli'); await load(); reopenSettings(); showMessage?.(data.cliFound ? '找到 welink-cli 了，正在确认连接' : data.cliSearch?.state === 'error' ? '查找未完成，可以重试或手动选择' : '暂未找到，可查看安装步骤或手动选择已安装的工具'); return; }
    if (verb === 'pick-cli') { const r = await call('pick-cli'); if (!r.canceled) { showMessage?.('已用 ' + r.path); await load(); reopenSettings(); } return; }
  }

  async function openSource(source, day) {
    const panel = page.querySelector('[data-slot="panel"]');
    panel.dataset.kind = 'source'; panel.dataset.source = source; panel.hidden = false;
    const head = '<div class="ca-source-head"><h2>查看出处</h2><button type="button" class="ca-btn small" data-ca="close-panel">关闭</button></div>';
    panel.innerHTML = `<div class="ca-source" role="dialog" aria-label="查看出处">${head}<p class="ca-note">正在读取本机原文…</p></div>`;
    try {
      const result = await call('source', { source, day: day || data.day });
      if (panel.dataset.kind !== 'source' || panel.dataset.source !== source) return;
      const fullWhen = at => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '时间未提供';
      let html;
      if (result.entry.kind === 'message') {
        html = result.context.map(m => `<article class="ca-source-message${m.sourceId === source ? ' selected' : ''}">
          <div class="ca-source-meta"><b>${esc(m.sender || m.account)}</b><span>${esc(m.account)}</span><time>${esc(fullWhen(m.at))}</time>${m.sourceId === source ? '<span class="ca-chip">这条出处</span>' : ''}</div>
          ${m.nameStatus && m.nameStatus !== 'resolved' && !m.mine ? '<p class="ca-note">姓名尚未确认，账号已保留。</p>' : ''}
          ${m.contentComplete === false ? '<p class="ca-note bad">这是旧版留下的截断内容，刷新数据后会重新补取。</p>' : ''}
          <pre class="ca-source-text">${esc(m.text || m.preview || '消息正文为空')}</pre>
          ${!m.text && m.content ? `<details><summary>原始消息内容</summary><pre class="ca-source-text">${esc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2))}</pre></details>` : ''}</article>`).join('');
      } else {
        const m = result.entry.item;
        html = `<article class="ca-source-message selected"><h3>${esc(m.subject || result.entry.label)}</h3><p>${esc(m.from || '')} ${esc(fullWhen(m.start || m.at))}${m.end ? ' — ' + esc(fullWhen(m.end)) : ''}</p><p>${esc(m.location || '')}</p>${m.preview ? `<p class="ca-note">以下为邮件预览，可让助理进一步查询完整邮件。</p><pre class="ca-source-text">${esc(m.preview)}</pre>` : ''}</article>`;
      }
      panel.innerHTML = `<div class="ca-source" role="dialog" aria-label="查看出处">${head}<p class="ca-note">${esc(result.entry.label)} · 采集于 ${esc(fullWhen(result.capturedAt))} · 原文只读，不会替你发送</p>${result.coverage?.cacheWindowIncomplete || result.coverage?.status && !['complete', 'cached'].includes(result.coverage.status) ? `<p class="ca-note bad">该会话只取到部分消息：${esc(result.coverage.reasonLabel)}</p>` : ''}${html}<p class="ca-note">${result.entry.kind === 'message' ? '显示本机已获取的原文与前后各两条消息。' : '显示本机已获取的这条记录。'}</p></div>`;
      panel.querySelector('.ca-source').scrollTop = 0; panel.querySelector('[data-ca="close-panel"]').focus();
    } catch (error) {
      if (panel.dataset.kind === 'source' && panel.dataset.source === source) panel.innerHTML = `<div class="ca-source" role="dialog" aria-label="查看出处">${head}<p>${esc(error.message)}</p></div>`;
    }
  }

  async function setupMail(input, msg, button) {
    if (button) button.disabled = true;
    if (msg) msg.textContent = '正在配置邮件和日历…';
    try {
      const r = await call('setup-calendar', { email: input ? input.value : '' });
      if (msg) msg.textContent = r.needsSetup ? '还没成功：' + (r.output || '请核对邮箱地址') : '邮箱连接已配置；各项查询状态见下方。';
      await load();
    } catch (error) { if (msg) msg.textContent = '没成功：' + error.message; } finally { if (button) button.disabled = false; }
  }

  const TABS = [['brief', '简报与提醒'], ['welink', 'WeLink 与邮箱'], ['phone', '手机'], ['pet', '桌宠']];
  let phoneTimer = null, phoneData = null;

  // 「手机」页（2026-10-18）：在手机 WeLink 的专用群里和助理对话。群由用户自己在手机上建，这里只选群、开关和看往来。
  const KIND_TAG = { other: '别人发的', stale: '过期没执行', throttled: '太快没处理', unsupported: '不是文字', failed: '没发出去', ack: '回执', done: '会话答完', stuck: '会话卡住', welcome: '接通', test: '测试', error: '没答上', info: '提示' };
  function phoneLive() {
    const p = phoneData.phone, st = p.settings;
    // 群消息轮询间隔见 core/company-assistant/phone.js 的 POLL_MS（6 秒）。
    const line = !st.groupId ? '<span class="ca-chip">还没选群</span>' : !st.enabled ? '<span class="ca-chip">没开启</span>'
      : p.lastError ? `<span class="ca-chip warn">出错</span><span class="ca-note">${esc(p.lastError)}</span>`
        : p.lastOkAt ? `<span class="ca-chip ok">已接通</span><span class="ca-note">每 6 秒查一次群消息，上次 ${clock(p.lastOkAt)}${p.pending ? ` · 正在答 ${p.pending} 条` : ''}</span>` : '<span class="ca-chip run">正在接通…</span>';
    const watching = p.watching.length ? `<p class="ca-note">正在盯 ${p.watching.length} 个会话：${p.watching.map(w => esc(w.title || w.id)).join('、')}（答完或卡住时推到手机）</p>` : '';
    const log = p.log.length ? p.log.map(x => `<div class="ca-src-row ca-phone-row"><span>${clock(x.at)} ${x.dir === 'in' ? '手机→' : '→手机'}</span>${x.kind && KIND_TAG[x.kind] ? `<span class="ca-chip${['failed', 'stale', 'throttled'].includes(x.kind) ? ' warn' : ''}">${KIND_TAG[x.kind]}</span>` : ''}<span class="ca-note" title="${esc(x.text)}">${esc(x.text)}</span></div>`).join('')
      : '<p class="ca-note">还没有往来。</p>';
    return `<div class="ca-row">${line}</div>${watching}<div class="ca-sec small">最近往来</div>${log}`;
  }
  function phoneTab() {
    const st = phoneData.phone.settings, check = phoneData.phone.groupCheck;
    const groups = (phoneData.conversations || []).filter(c => c.group);
    if (st.groupId && !groups.some(g => g.id === st.groupId)) groups.unshift({ id: st.groupId, name: st.groupName || st.groupId, group: true });
    const options = ['<option value="">从最近会话选择…</option>', ...groups.map(g => `<option value="${esc(g.id)}" data-name="${esc(g.name)}">${esc(g.name)} · ${esc(g.id)}</option>`)].join('');
    const checkLine = check && check.groupId === st.groupId ? `<span class="ca-chip${check.ok ? ' ok' : ' warn'}">${check.ok ? '成员没问题' : '有其他人'}</span><span class="ca-note">${esc(check.note)}</span>` : '';
    return `<fieldset class="col"><legend>接通状态</legend><div data-slot="phone-live">${phoneLive()}</div></fieldset>
      <fieldset class="col"><legend>助理消息群 ID</legend>
        <p class="ca-note">先在 WeLink 建好专用消息群，把群 ID 填在这里。接通后，欢迎消息会发到这个群，之后直接在群里和助理说话。</p>
        <div class="ca-row"><input class="ca-phone-group" data-f="phone-group" type="text" inputmode="numeric" placeholder="粘贴群 ID" aria-label="助理消息群 ID" value="${esc(st.groupId)}"><button type="button" class="ca-btn primary" data-x="phone-connect">接通</button></div>
        <div data-slot="phone-connect-result" role="status"></div>
        <details><summary class="ca-note">不知道群 ID？从最近会话里找</summary><div class="ca-row"><select data-f="phone-recent">${options}</select><button type="button" class="ca-btn small" data-x="phone-refresh">刷新群列表</button></div></details>
        <div class="ca-row"><button type="button" class="ca-btn small" data-x="phone-check">查看群成员</button><span class="ca-note">群内其他人能看到助理的回答，建议用专用群。</span></div>
        <div class="ca-row" data-slot="phone-check">${checkLine}</div></fieldset>
      <fieldset class="col"><legend>额外属于我的账号</legend>
        <p class="ca-note" id="ca-phone-extra-ids-help">换工号后，如果手机消息被识别成“别人发的”，把新工号填在这里。只填写 8 位数字工号，不要带字母，前导零要保留。手机消息里的带字母账号仍按数字部分匹配。</p>
        <textarea data-f="phone-extraIds" rows="3" inputmode="numeric" aria-label="额外属于我的账号" aria-describedby="ca-phone-extra-ids-help ca-phone-extra-ids-error" placeholder="每行一个 8 位工号，或用逗号分隔">${esc((st.extraIds || []).join('\n'))}</textarea>
        <p class="ca-note bad" id="ca-phone-extra-ids-error" role="alert"></p></fieldset>
      <fieldset class="col"><legend>开关与推送</legend>
        <label><input type="checkbox" data-f="phone-enabled"${st.enabled ? ' checked' : ''}>开启手机对话</label>
        <label><input type="checkbox" data-f="phone-pushWatched"${st.pushWatched ? ' checked' : ''}>助理派出的、让它盯着的会话答完或卡住时，推到手机</label>
        <label><input type="checkbox" data-f="phone-pushStuck"${st.pushStuck ? ' checked' : ''}>其他会话卡住等你时也推到手机（电脑前 5 分钟内有人操作就不推）</label></fieldset>
      <div class="ca-row end"><button type="button" class="ca-btn" data-x="phone-test"${st.groupId ? '' : ' disabled'}>发一条测试消息</button><button type="button" class="ca-btn primary" data-x="phone-save">保存</button></div>`;
  }
  async function mountPhoneTab(panel) {
    const tabBody = panel.querySelector('.ca-tab-body');
    if (!tabBody.innerHTML.trim()) tabBody.innerHTML = '<p class="ca-note">正在读取…</p>';
    try { phoneData = await call('phone-status'); } catch (error) { tabBody.innerHTML = `<p class="ca-note bad">手机设置没能打开：${esc(error.message)}</p>`; return; }
    if (panel.dataset.tab !== 'phone' || !tabBody.isConnected) return;
    tabBody.innerHTML = phoneTab();
    const groupSel = tabBody.querySelector('[data-f="phone-group"]');
    const extraIdsInput = tabBody.querySelector('[data-f="phone-extraIds"]');
    const settingsError = tabBody.querySelector('#ca-phone-extra-ids-error');
    const showSettingsError = error => {
      settingsError.textContent = error.message;
      settingsError.scrollIntoView({ block: 'center' });
    };
    extraIdsInput.oninput = () => { settingsError.textContent = ''; };
    const chosen = () => {
      const groupId = groupSel.value.trim(), recent = (phoneData.conversations || []).find(g => g.group && g.id === groupId);
      return { groupId, groupName: recent?.name || (groupId === phoneData.phone.settings.groupId ? phoneData.phone.settings.groupName : '') || '' };
    };
    tabBody.querySelector('[data-f="phone-recent"]').onchange = e => { if (e.target.value) groupSel.value = e.target.value; };
    tabBody.querySelector('[data-x="phone-connect"]').onclick = async e => {
      const g = chosen(), slot = tabBody.querySelector('[data-slot="phone-connect-result"]');
      if (!g.groupId) { slot.textContent = '请先填入群 ID'; return; }
      e.target.disabled = true; settingsError.textContent = ''; slot.textContent = '正在校验设置并发送欢迎消息…';
      try {
        const r = await call('phone-settings', { ...g, enabled: true, extraIds: extraIdsInput.value });
        if (!r.ok) { slot.innerHTML = `<p class="ca-note bad">${esc(r.error)}</p>`; return; }
        await mountPhoneTab(panel); showMessage?.('手机对话已接通');
      } catch (error) { slot.innerHTML = `<p class="ca-note bad">没有接通：${esc(error.message)}</p>`; showSettingsError(error); }
      finally { e.target.disabled = false; }
    };
    tabBody.querySelector('[data-x="phone-refresh"]').onclick = async e => {
      e.target.disabled = true;
      try { await call('refresh'); await mountPhoneTab(panel); showMessage?.('群列表已刷新'); } catch (error) { e.target.disabled = false; showMessage?.('没刷新：' + error.message); }
    };
    tabBody.querySelector('[data-x="phone-check"]').onclick = async e => {
      const g = chosen(); if (!g.groupId) { showMessage?.('请先填群 ID'); return; }
      e.target.disabled = true;
      const slot = tabBody.querySelector('[data-slot="phone-check"]');
      try { const r = await call('phone-check-group', { groupId: g.groupId }); slot.innerHTML = `<span class="ca-chip${r.ok ? ' ok' : ' warn'}">${r.ok ? '成员没问题' : '有其他人'}</span><span class="ca-note">${esc(r.note)}</span>`; }
      catch (error) { slot.innerHTML = `<span class="ca-note bad">没查到：${esc(error.message)}</span>`; } finally { e.target.disabled = false; }
    };
    tabBody.querySelector('[data-x="phone-test"]').onclick = async e => {
      e.target.disabled = true;
      try { const r = await call('phone-test'); showMessage?.(r.ok ? '测试消息已发到群里，去手机上看看' : '没发出去，原因见「最近往来」'); } catch (error) { showMessage?.('没发出去：' + error.message); } finally { e.target.disabled = false; }
    };
    tabBody.querySelector('[data-x="phone-save"]').onclick = async e => {
      const g = chosen(), on = f => tabBody.querySelector(`[data-f="phone-${f}"]`).checked;
      if (on('enabled') && !g.groupId) { showMessage?.('请先填群 ID'); return; }
      e.target.disabled = true; settingsError.textContent = '';
      try {
        const r = await call('phone-settings', { ...g, enabled: on('enabled'), pushWatched: on('pushWatched'), pushStuck: on('pushStuck'), extraIds: extraIdsInput.value });
        if (!r.ok) { showMessage?.('没有接通：' + r.error); e.target.disabled = false; return; }
        showMessage?.(r.welcome ? '已接通：欢迎消息已发到手机群' : '手机设置已保存');
        await mountPhoneTab(panel);
      } catch (error) { e.target.disabled = false; showSettingsError(error); showMessage?.('没有保存：' + error.message); }
    };
    // 开着这页时每 3 秒刷新界面上的状态和往来（只换这一块，不打断正在改的选项）；后台查群消息是 6 秒一次。
    clearInterval(phoneTimer);
    phoneTimer = setInterval(async () => {
      if (panel.hidden || panel.dataset.tab !== 'phone' || !tabBody.isConnected) { clearInterval(phoneTimer); phoneTimer = null; return; }
      try { phoneData = await call('phone-status'); const live = tabBody.querySelector('[data-slot="phone-live"]'); if (live) live.innerHTML = phoneLive(); } catch { /* 下次再刷 */ }
    }, 3000);
  }

  function querySnapshotRows(d) {
    return queryRows(d).map(status => `<div class="ca-src-row"><span>${status.name}</span>${status.label ? `<span class="ca-chip ${status.color}">${esc(status.label)}</span>` : ''}${status.detail ? `<span class="ca-note">${esc(status.detail)}</span>` : ''}</div>`).join('');
  }
  function welinkTab() {
    const d = data, s = d.settings;
    const connection = connectionState(d);
    const loginLine = !d.cliFound ? cliChip(d) + installGuide()
      : connection.kind === 'online' ? `<span class="ca-chip ok">已登录</span><span class="ca-note">账号 ${esc(d.auth.login.uid || '')}</span>`
        : `<span class="ca-chip warn">${esc(connection.title)}</span><span class="ca-note">${esc(connection.detail)}</span>${connection.action ? `<button type="button" class="ca-btn small primary" data-ca="${connection.action}">${esc(connection.label)}</button>` : ''}${connection.alt ? `<button type="button" class="ca-btn small" data-ca="${connection.alt}">${esc(connection.altLabel)}</button>` : ''}`;
    const from = s.emailFrom === 'welink' ? '从 WeLink 账号自动读到' : s.emailFrom === 'git' ? '从本机 Git 自动读到（公司域名已核对）' : s.email ? '你填写的' : '';
    const snapRows = querySnapshotRows(d);
    const VIA = { path: '系统路径里找到的', npm: 'npm 全局目录里找到的', disk: '在硬盘里找到的', manual: '你手动选的' };
    const cliLine = d.cliFound ? `<fieldset class="col"><legend>welink-cli 位置</legend><div class="ca-row"><span class="ca-chip ok">已找到</span><span class="ca-note" title="${esc(d.cliPath)}">${esc(d.cliPath)}${VIA[d.cliSearch?.via] ? '（' + VIA[d.cliSearch.via] + '）' : ''}</span>${d.cliVersion ? `<span class="ca-note">版本 ${esc(d.cliVersion)}</span>` : ''}${toolPicker.switchHtml(d.cliChoice, { className: 'ca-note' })}</div>${toolPicker.hintHtml(d.cliChoice)}
        <div class="ca-row"><button type="button" class="ca-btn small" data-ca="find-cli">重新查找</button><button type="button" class="ca-btn small" data-ca="pick-cli">手动选择…</button></div></fieldset>` : '';
    return `<fieldset><legend>WeLink 登录</legend><div class="ca-row">${loginLine}</div></fieldset>${cliLine}
      <fieldset class="col"><legend>公司邮箱（邮件和日历要用）</legend>
        <div class="ca-row">${s.emailFrom === 'welink' && s.email ? `<span>邮箱（自动读取）：${esc(s.email)}</span>` : `<input type="email" data-f="email" placeholder="自动读取失败，可补填公司邮箱" value="${esc(s.email || '')}">`}<button type="button" class="ca-btn primary" data-x="mail">${d.calendarNeedsSetup ? '配置邮件和日历' : '重新配置'}</button>${from ? `<span class="ca-note">${from}</span>` : ''}</div>
        <p class="ca-note" data-f="mail-msg">${d.calendarNeedsSetup ? '还没接入。' : '已接入。'}只让 welink-cli 按邮箱找一次公司邮件服务器，不发邮件。</p></fieldset>
      <fieldset class="col"><legend data-slot="query-time">最近一次取数（${d.refreshedAt ? when(d.refreshedAt) : '还没取过'}）</legend><div data-slot="query-rows">${snapRows}</div>
        <div class="ca-row"><button type="button" class="ca-btn small" data-ca="refresh">刷新数据</button></div></fieldset>
      <fieldset><legend>我的名字（用来认群里 @我）</legend><input type="text" data-f="myName" value="${esc(s.myName)}" placeholder="WeLink 里的显示名"><button type="button" class="ca-btn small" data-x="name">保存</button></fieldset><p class="ca-note">WeLink 数据只留在本机。</p>`;
  }

  function briefTab() {
    const s = data.settings, sc = data.scope;
    const opts = (list, cur, fmt = x => x) => list.map(x => `<option value="${x}"${String(x) === String(cur) ? ' selected' : ''}>${fmt(x)}</option>`).join('');
    // 2026-10-18：不再手动勾「关注群」，默认取回看时间内所有私聊和群。免打扰、置顶 welink-cli 拿不到（Q-1018-10），不做这两个设置。
    const last = sc ? `上次取到 ${sc.withMessages} 个会话（私聊 ${sc.p2p}、群 ${sc.withMessages - sc.p2p}）共 ${sc.messages} 条消息${sc.limited ? `，按设置只取了最近 ${sc.maxConversations} 个会话` : ''}。` : '还没取过数据：先扫码登录、点「刷新数据」。';
    // 自存的常用问题在输入框上方直接悬停 × 删除（5.5.11 起设置里不再重复列一份）。
    return `<fieldset class="col"><legend>聊天记录范围（今天、提醒和对话都用这份数据）</legend>
        <div class="ca-row"><label>回看最近<select data-f="lookbackHours">${opts([12, 24, 36, 48, 72], s.lookbackHours, x => x + ' 小时')}</select></label>
          <label>会话个数<select data-f="maxConversations">${opts([0, 10, 20, 30], s.maxConversations, x => (Number(x) ? '最近 ' + x + ' 个' : '全部（默认）'))}</select></label></div>
        <p class="ca-note">平时更新有变化的会话、估计的置顶组并轮转核对，其余使用后台缓存；定期完整核对最近目录。即时提问只补查变化和置顶会话，并标明缓存时间。每个会话按回看时间翻页，未取全会显示原因。目录外从未发现的会话仍可能遗漏。</p>
        <p class="ca-note">${last}</p></fieldset>
      <fieldset><legend>提醒</legend>
        <label>关注词（逗号分隔）<input type="text" data-f="keywords" value="${esc(s.keywords.join('，'))}"></label>
        <label>定时汇总<select data-f="digestHours">${opts([0, 1, 2, 4], s.digestHours, x => x ? '每 ' + x + ' 小时' : '关闭')}</select></label>
        <p class="ca-note">工作日 9:00–20:00 汇总私聊超过 30 分钟未回、@你后尚未在群里发言、今明到期的承诺和重要未读邮件。有新增才通知，不占每小时提醒名额；开启后不单独发「等你回复」，关闭后按下方时长提醒。使用本机已获取的数据。</p>
        <label>等你回复超过<select data-f="waitHours">${opts([1, 2, 3, 4, 6, 8, 12, 24], s.waitHours, x => x + ' 小时')}</select>提醒</label>
        <label>开会前<select data-f="prepMinutes">${opts([5, 10, 15, 20, 30], s.prepMinutes, x => x + ' 分钟')}</select>出准备卡</label>
        <label>每小时最多<select data-f="maxPerHour">${opts([1, 2, 3, 4, 5], s.maxPerHour, x => x + ' 条')}</select></label></fieldset>
      <fieldset><legend>时间</legend>
        <label>简报（工作日）<input type="time" data-f="briefTime" value="${esc(s.briefTime)}"></label>
        <label>下班前小结<input type="time" data-f="summaryTime" value="${esc(s.summaryTime)}"></label>
        <label>自动取数据间隔<select data-f="refreshMinutes">${opts([5, 10, 15, 30], s.refreshMinutes, x => x + ' 分钟')}</select></label></fieldset>
      <fieldset class="col"><legend>助理记忆</legend><div data-slot="assistant-memory"><p class="ca-note">正在读取…</p></div></fieldset>
      <div class="ca-row end"><button type="button" class="ca-btn primary" data-x="save">保存</button></div>`;
  }

  // 会议室已是左栏独立页面（2026-11-04 起助理页不再放会议室状态、消息和设置页签）；PPT 素材库在左栏 PPT 页（5.5.11 起设置里不再有 PPT 页签）。
  function openSettings(tab) {
    const panel = page.querySelector('[data-slot="panel"]');
    const current = TABS.some(([k]) => k === tab) ? tab : (panel.dataset.kind === 'settings' && TABS.some(([k]) => k === panel.dataset.tab) && panel.dataset.tab) || 'brief';
    panel.dataset.kind = 'settings'; panel.dataset.tab = current; panel.hidden = false;
    // 面板定位在 ca-main 内，保留侧栏可操作。
    panel.innerHTML = `<div class="ca-settings" role="dialog" aria-label="助理设置">
      <div class="ca-settings-head"><h3>助理设置</h3><div class="ca-tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" class="ca-tab${k === current ? ' on' : ''}" aria-selected="${k === current}" data-ca="settings-tab:${k}">${label}</button>`).join('')}</div>
        <button type="button" class="ca-btn small" data-ca="close-panel">关闭</button></div>
      <div class="ca-tab-body" data-tab="${current}">${current === 'brief' ? briefTab() : current === 'welink' ? welinkTab() : current === 'pet' ? '<div data-slot="pet-tab"></div>' : ''}</div></div>`;
    if (current !== 'phone') { clearInterval(phoneTimer); phoneTimer = null; }
    if (current === 'phone') { void mountPhoneTab(panel); return; }
    if (current === 'pet') {
      const host = panel.querySelector('[data-slot="pet-tab"]');
      try { require('./hub-pet/pet-settings-tab.js').mountPetSettingsTab(host, { ipcRenderer, window, document }); }
      catch (error) { host.innerHTML = `<p class="ca-note">桌宠设置没能打开：${esc(error.message)}</p>`; }
      return;
    }
    if (current === 'brief') require('./company-assistant-memory').mountMemory(panel.querySelector('[data-slot="assistant-memory"]'), { call, showMessage });
    if (current === 'welink') {
      panel.querySelector('[data-x="mail"]').onclick = e => setupMail(panel.querySelector('[data-f="email"]'), panel.querySelector('[data-f="mail-msg"]'), e.target).then(() => { if (panel.dataset.tab === 'welink') openSettings('welink'); });
      panel.querySelector('[data-x="name"]').onclick = async () => { try { await call('set-settings', { myName: panel.querySelector('[data-f="myName"]').value }); await load(); showMessage?.('名字已保存'); } catch (error) { showMessage?.('没有保存：' + error.message); } };
      return;
    }
    panel.querySelector('[data-x="save"]').onclick = async e => {
      const v = f => panel.querySelector(`[data-f="${f}"]`).value;
      e.target.disabled = true;
      try {
        await call('set-settings', {
          lookbackHours: Number(v('lookbackHours')), maxConversations: Number(v('maxConversations')),
          keywords: v('keywords'), waitHours: Number(v('waitHours')), digestHours: Number(v('digestHours')), prepMinutes: Number(v('prepMinutes')), maxPerHour: Number(v('maxPerHour')),
          briefTime: v('briefTime'), summaryTime: v('summaryTime'), refreshMinutes: Number(v('refreshMinutes')),
        });
        panel.hidden = true; panel.innerHTML = ''; panel.dataset.kind = ''; await load(); showMessage?.('助理设置已保存');
      } catch (error) { e.target.disabled = false; showMessage?.('没有保存：' + error.message); }
    };
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels();
    window.__companyRoomsHide?.();
    window.__companyMeetingHide?.(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyForumHide?.(); window.__companyAttendanceHide?.();
    // 规则、写作、研究等整页面板也关掉（同云端页），不然从这些页切过来会叠在一起。
    for (const name of ['__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.(); window.setShellNavActive?.('company-assistant');
    const wasHidden = page.hidden;
    page.hidden = false; document.body.classList.add('company-assistant-page-open'); place();
    if (wasHidden) firstPaint = true;
    const btn = nav(); btn?.classList.add('active'); btn?.classList.remove('has-unread');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = null;
    if (await gate.check()) await startData();
  }
  async function startData() {
    if (!page || page.hidden) return;
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 20000);
    clearInterval(tick); tick = setInterval(tickElapsed, 1000);
    try {
      await load();
      // 打开页面时今天还没有简报：当场生成（工作日、非工作日都可以手动看）。
      if (!data.brief && connectionState(data).kind === 'online') { data = await call('brief-now'); render(); }
    } catch (error) { showMessage?.('助理状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-assistant-page-open');
    document.getElementById('btn-company-assistant')?.classList.remove('active');
    clearInterval(timer); timer = null; clearInterval(tick); tick = null; clearInterval(phoneTimer); phoneTimer = null; window.removeEventListener('resize', onResize);
  }
  nav();
  // 侧栏「助理」一栏的占位行（助理会话还没打开时）点进来：恢复或新开助理会话，再选中它。
  window.__companyAssistantOpenSession = async () => {
    try { const r = await call('open-session'); close(); await openSession(r.sessionId); }
    catch (error) { showMessage?.('助理会话没能打开：' + error.message); }
  };
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-assistant)')) close(); });
  ipcRenderer.on('company-assistant:changed', () => { if (page && !page.hidden) void load().catch(() => {}); });
  document.addEventListener('tool-version-changed', e => { if (['welink', 'ppt-doctor'].includes(e.detail?.tool) && page && !page.hidden) void load().then(() => { const panel = page.querySelector('[data-slot="panel"]'); if (e.detail.tool === 'welink' && panel?.dataset.kind === 'settings' && !panel.hidden) openSettings(); }).catch(() => {}); });
  ipcRenderer.on('company-assistant:notice', (_e, notice) => {
    if (notice?.title) showMessage?.(notice.title);
    if (!page || page.hidden) document.getElementById('btn-company-assistant')?.classList.add('has-unread');
  });
  // 点桌面通知：打开助理页（主进程用固定编号 company-assistant）。
  ipcRenderer.on('desktop-notification:open-session', (_e, payload) => { if (payload?.sessionId === 'company-assistant') void fromPet({ noticeId: payload.noticeId }); });
  window.addEventListener('hub-pet:open-assistant', e => { void fromPet(e.detail || {}).catch(error => showMessage?.(error.message)); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createCompanyAssistantPage, latestNotices, todayStatus, shortMeetingText, shanghaiClock, shanghaiDay, dayTitle, visibleChat, splitLegacyCoverage, answerCoverage, sourceLabels, tagSources, todayFolded, saveTodayFolded, TODAY_FOLD_KEY, secondsText, waitPhase };
