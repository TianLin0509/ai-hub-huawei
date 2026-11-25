'use strict';
const { MeetingCapture } = require('./meeting-capture');
const { meetingTemplate } = require('./company-meeting-template');
const { flowEntries, flowStamp, entryVersion, meetingNavigation } = require('./company-meeting-flow');
const { meetingAsrState } = require('./company-meeting-asr-state');
const { createScrollGuard, scrollWithin, nearBottom } = require('./company-meeting-scroll-guard');
const { questionQueue, questionStatus, cardVersion, chatCardHtml, applyQuestionPush, mergeQuestionState, createChatBadge, laneAlert, isInFlight } = require('./company-meeting-chat');
const { backstageHtml, fallbackLog, logText, isMissingHandler } = require('./company-meeting-backstage');
const { tickWait } = require('./wait-progress');
const understandingView = require('./company-meeting-understanding');
function createCompanyMeetingPage({ document, window, call, markdown, openSession, openBackstage }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = ms => `${String(Math.floor((ms || 0) / 60000)).padStart(2, '0')}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
  let root, id = null, capture, state, poll, sourceList = [], playback = null, playRequest = 0;
  let busy = false, refreshing = false, evidenceRequest = 0, thumbsObserver, meterTimer, activeSeq = null, refreshAgain = false;
  const EXCLUSIVE_ACTS = new Set(['start', 'start-without-asr', 'pause', 'stop', 'new', 'delete-meeting', 'delete-video', 'cancel-record-only', 'retry-save']);
  const running = new Set();
  // 右栏 tab、聊天列表、角标、后台抽屉（2026-11-24）。
  let asideTab = 'minutes', chatReveal = false, chatFollow = true, chatTimer = null, backstage = null, backstageUnsupported = false, pushBound = false;
  const chatBadge = createChatBadge();
  const QSPEED_HINT = { fast: '快速：只带纪要和最近原话，先出字', normal: '中等：多带一些早期原话，更全', deep: '深入：逐项核对全文，最慢' };
  const thumbCache = new Map(); // 缩略图 LRU：命中时挪到最新，满了丢最久没用的
  const THUMB_LIMIT = 120;
  const scrollGuard = createScrollGuard({ log: fixed => console.warn('[meeting] 外层容器被滚动，已复位', fixed) });
  // 切走再回来保留各列表的滚动位置（页面 display:none 会把 scrollTop 清零）。
  let savedScroll = null, summaryKey = null, dismissedMessage = '';
  // 提示条：文字变了才更新（按钮不重建、点击不丢）。只有轮询带来的同一条错误，在用户关掉后不再弹；
  // 用户自己操作触发的提示照常显示（并清掉「已关闭」记忆），轮询发现错误已消失也清掉。
  function message(s, { fromPoll = false } = {}) {
    if (!root) return;
    const text = String(s || '').replace(/cli-not-ready/g, 'CodeAgent 还没启动好，稍后点重试');
    if (fromPoll && text && text === dismissedMessage) return;
    if (!fromPoll) dismissedMessage = '';
    const box = root.querySelector('[data-m="message"]');
    if (box.textContent === text) return;
    box.textContent = text;
    const help = window.HubErrorCard?.knownHtml({ area: 'codeagent', details: s }) || '';
    const helpBox = root.querySelector('[data-m="agent-help"]');
    if (helpBox.dataset.html !== help) { helpBox.innerHTML = help; helpBox.dataset.html = help; }
  }
  function dismissMessage() {
    dismissedMessage = root.querySelector('[data-m="message"]').textContent;
    root.querySelector('[data-m="message"]').textContent = '';
    const helpBox = root.querySelector('[data-m="agent-help"]'); helpBox.innerHTML = ''; helpBox.dataset.html = '';
  }
  // 改会议名称：点标题旁的笔变成输入框，回车或点别处保存，Esc 放弃。
  function startRename() {
    const title = el('session-title'), meetingId = id, current = state?.meeting?.title || '';
    if (!meetingId || root.querySelector('.meeting-rename-input')) return;
    const input = document.createElement('input');
    input.className = 'meeting-rename-input'; input.value = current; input.maxLength = 160; input.setAttribute('aria-label', '会议名称');
    let finished = false;
    const finish = async save => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      input.remove(); title.hidden = false; el('rename-title').hidden = false;
      if (!save || !next || next === current) return;
      title.textContent = next;
      try { await call('meeting-rename', { id: meetingId, title: next }); await refresh(); }
      catch (error) { title.textContent = current; message('改名没成功：' + error.message); }
    };
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finish(false); }
    });
    input.addEventListener('blur', () => { void finish(true); });
    title.hidden = true; el('rename-title').hidden = true;
    title.after(input); input.focus({ preventScroll: true }); input.select();
  }
  const EMPTY_SUMMARY = '<div class="meeting-summary-empty"><strong>讨论的脉络，在这里慢慢清晰</strong><p>结论、待确认的问题与行动项会随理解更新；点击来源标记，回到对应画面和原话。</p><small>理解与问答需要 CodeAgent；未安装也可先采集和回看。</small></div>';
  function meters() {
    const box = root && el('levels'); if (!box) return;
    const tracks = capture?.running ? (state?.meeting?.audio || []) : [];
    const key = tracks.join(',');
    if (box.dataset.key !== key) { box.dataset.key = key; box.innerHTML = tracks.map(k => `<span class="meeting-meter" data-track="${k}" title="${k === 'mic' ? '麦克风' : '系统声音'}音量">${k === 'mic' ? '麦克风' : '系统声音'}<i>${'<b></b>'.repeat(5)}</i></span>`).join(''); }
    for (const meter of box.querySelectorAll('[data-track]')) { const lit = Math.round(Math.sqrt(capture.paused ? 0 : capture.levels[meter.dataset.track] || 0) * 5); meter.querySelectorAll('b').forEach((b, i) => b.classList.toggle('on', i < lit)); }
  }
  function citations(element) {
    const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT), nodes = []; let node;
    while ((node = walker.nextNode())) if (!node.parentElement.closest('a,button,code,pre') && /\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/.test(node.textContent)) nodes.push(node);
    for (const node of nodes) {
      const fragment = document.createDocumentFragment(), text = node.textContent; let last = 0;
      for (const match of text.matchAll(/\[(?:事件\s*(\d+)|画面\s*(\d+):(\d{2}))\]/g)) { fragment.append(document.createTextNode(text.slice(last, match.index))); const button = document.createElement('button'); button.className = 'ca-link'; if(match[1]){button.dataset.event = match[1]; const at = state.meeting?.events?.find(x => x.seq === Number(match[1]))?.at; button.textContent = '事件 ' + match[1]; button.title = Number.isFinite(at) ? '跳到 ' + time(at) : '查看事件 ' + match[1];}else{button.dataset.playAt=String((Number(match[2])*60+Number(match[3]))*1000); button.textContent = '画面 ' + match[2] + ':' + match[3]; button.title = '跳到 ' + match[2] + ':' + match[3];} fragment.append(button); last = match.index + match[0].length; }
      fragment.append(document.createTextNode(text.slice(last))); node.replaceWith(fragment);
    }
  }
  const shortDate = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const el = name => root.querySelector(`[data-m="${name}"]`);
  const recordingInterrupted = () => !!capture?.running && !!(capture.ending || capture.released || capture.recorder?.full?.recorder.state === 'inactive');
  function updateLiveStatus() {
    const status = recordingInterrupted() ? '已中断' : capture?.paused ? '已暂停' : '实时';
    const stage = root.querySelector('.meeting-stage');
    stage.dataset.liveStatus = status;
    el('live').setAttribute('aria-label', '共享画面 · ' + status);
    if (stage.dataset.view === 'live') el('viewer-label').textContent = '共享画面 · ' + status;
  }
  function view(mode, label) {
    root.querySelector('.meeting-viewer > .meeting-ppt-results')?.remove();
    root.querySelector('.meeting-stage').dataset.view = mode;
    // 回看（会后）点一条不自动放大：放大会把时间流挤没。会中只有画面区下方还留得出 160px 时间流才自动放大。
    if (mode === 'evidence' || mode === 'replay') { if (root.dataset.phase !== 'review' && roomToExpand()) setViewerExpanded(true); }
    else setViewerExpanded(false);
    el('viewer-label').textContent = label || ({ live:'共享画面 · 实时', replay:'会议录像回放', evidence:'会议出处', empty:'共享画面' })[mode];
    updateLiveStatus();
    root.querySelector('[data-act="live"]').hidden = !capture?.running || mode === 'live';
    if (mode !== 'replay') el('player').pause();
    if (mode !== 'evidence') el('evidence').querySelector('audio')?.pause();
  }
  function setViewerExpanded(expanded) {
    root.querySelector('.meeting-viewer').classList.toggle('is-expanded', expanded);
    const button = root.querySelector('[data-act-local="expand-viewer"]');
    button.setAttribute('aria-pressed', String(expanded)); button.textContent = expanded ? '收起' : '放大';
  }
  function roomToExpand() {
    const pane = root.querySelector('.meeting-evidence-pane');
    return (pane?.clientHeight || 0) >= 640;
  }
  function updateFollowButton() {
    root.querySelector('[data-act-local="latest"]').hidden = nearBottom(el('timeline'));
  }
  function renderFlow(meeting) {
    const list = el('timeline'), entries = flowEntries(meeting), stamp = flowStamp(id, meeting, entries);
    if (list.dataset.stamp === stamp) return;
    const follow = nearBottom(list);
    // 找视口里第一条当锚点：先按 scrollTop 二分定位，不逐条量几千个节点。
    const anchor = follow ? null : firstVisibleRow(list);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const existing = new Map([...list.querySelectorAll(':scope > [data-flow-key]')].map(n => [n.dataset.flowKey, n]));
    list.querySelector(':scope > .meeting-empty')?.remove();
    for (const [index, entry] of entries.entries()) {
      let row = existing.get(entry.key); existing.delete(entry.key);
      if (!row) { row = document.createElement('div'); row.dataset.flowKey = entry.key; }
      const cls = `meeting-flow-event is-${entry.kind}`, at = entry.at === null ? '' : String(entry.at);
      if (row.className !== cls) row.className = cls;
      if (row.dataset.at !== at) row.dataset.at = at;
      const version = entryVersion(entry) + (entry.event?.speaker ? '\u0001' + speakerName(entry.event) : '');
      if (row.dataset.version !== version) {
        const label = entry.at === null ? '未记录' : time(entry.at), e = entry.event;
        const content = e.kind === 'slide' ? `<div class="meeting-frame-item"><button class="meeting-frame" data-event="${e.seq}" aria-label="查看 ${time(e.at)} 的截图"><img data-thumb="${e.seq}" alt="会议截图"></button><div><strong>共享画面${e.revisit ? ' · 再次展示' : ''}</strong><p>${e.forced ? '手动截图' : '自动精选'}</p><button class="ca-link" data-find-ppt="${e.seq}">找原稿</button></div></div>`
          : `<button class="meeting-event ${e.kind === 'mark' ? 'is-mark' : ''}${e.seq === activeSeq ? ' is-active' : ''}" data-event="${e.seq}"><b>${e.kind === 'mark' ? '★ 重点' : esc(speakerName(e))}</b><span>${esc(e.text)}</span></button>`;
        row.innerHTML = `<time>${label}</time><div class="meeting-flow-content">${content}</div>`;
        citations(row); row.dataset.version = version;
      }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    for (const node of existing.values()) node.remove();
    if (!entries.length) list.innerHTML = '<p class="meeting-empty">开始后，截图、原话和重点会按时间显示在这里；问答在右栏「助手对话」。</p>';
    list.dataset.stamp = stamp; thumbnails(); markActive();
    el('flow-count').textContent = `${entries.filter(e => e.kind === 'slide').length} 张画面 · ${entries.filter(e => ['transcript','mark'].includes(e.kind)).length} 条原话与重点`;
    if (follow) list.scrollTop = list.scrollHeight;
    else if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    updateFollowButton();
  }
  // ---------- 右栏两个 tab：「会议理解」「助手对话」（2026-11-24 用户反馈：问答别淹没在纪要和时间流里） ----------
  function switchTab(name) {
    asideTab = name === 'chat' ? 'chat' : 'minutes';
    root.dataset.asideTab = asideTab;
    root.querySelectorAll('[data-aside-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.asideTab === asideTab)));
    root.querySelectorAll('[data-aside-panel]').forEach(p => { p.hidden = p.dataset.asidePanel !== asideTab; });
    if (asideTab === 'chat') { const list = el('chat-list'); if (chatFollow) list.scrollTop = list.scrollHeight; }
    else closeBackstage();
    syncBadge(state?.meeting);
    scrollGuard.check(root);
  }
  function syncBadge(m) {
    const n = chatBadge.sync(m, asideTab === 'chat' && !root.hidden), badge = el('chat-badge');
    badge.hidden = !n; badge.textContent = n ? String(n) : '';
    badge.title = n ? `${n} 条新回答` : '';
  }
  function chatContext(q, queue) {
    return { queueAhead: queue.has(q.id) ? queue.get(q.id) : null, engines: (state?.engines || []).map(e => e.id).join(','), backstageOpen: backstage?.id === q.id };
  }
  function renderChat(m) {
    const list = el('chat-list'), answers = m?.answers || [], queue = questionQueue(m), engines = state?.engines || [];
    const follow = chatReveal || nearBottom(list);
    const existing = new Map([...list.querySelectorAll(':scope > [data-answer]')].map(n => [n.dataset.answer, n]));
    let index = 0;
    for (const q of answers) {
      if (!q?.id) continue;
      const card = upsertCard(q, existing.get(q.id), queue, engines); existing.delete(q.id);
      if (list.children[index + 1] !== card) list.insertBefore(card, list.children[index + 1] || null); // 第 0 个是空状态说明
      index++;
    }
    for (const node of existing.values()) node.remove();
    el('chat-empty').hidden = index > 0;
    syncChatSummary(m);
    const alert = laneAlert(state, m), alertBox = el('lane-alert');
    alertBox.hidden = !alert; alertBox.dataset.kind = alert?.kind || '';
    if (el('lane-alert-text').textContent !== (alert?.text || '')) el('lane-alert-text').textContent = alert?.text || '';
    if (follow) list.scrollTop = list.scrollHeight;
    chatFollow = nearBottom(list); chatReveal = false;
    if (backstage) { renderBackstage(); syncBackstageFinal(); }
    syncChatTimer();
  }
  // 一张卡：版本没变（只是多出了字）就就地改文字；阶段等变了才整卡重画。
  function upsertCard(q, card, queue, engines) {
    const ctx = chatContext(q, queue), version = cardVersion(q, ctx);
    if (card && card.dataset.version === version) { patchPartial(card, q, ctx); return card; }
    const box = document.createElement('div');
    box.innerHTML = chatCardHtml(q, { markdown, queueAhead: ctx.queueAhead, engines, clock: clockText(q.queuedAt ?? q.at) });
    const next = box.firstElementChild;
    if (card?.querySelector('.meeting-chat-history')?.open) next.querySelector('.meeting-chat-history')?.setAttribute('open', '');
    citations(next); next.dataset.version = version; tickWait(next);
    if (card) card.replaceWith(next);
    return next;
  }
  function syncChatSummary(m) {
    const inFlight = (m?.answers || []).filter(isInFlight).length, busyBox = el('chat-busy');
    busyBox.hidden = !inFlight; const text = inFlight ? ` · ${inFlight} 题在答` : ''; if (busyBox.textContent !== text) busyBox.textContent = text;
    syncBadge(m);
  }
  // 抽屉开着时这题从在途变成完成/失败：补读一次后台记录，最后的 stderr 尾巴、退出码、结束时间才会出现。
  function syncBackstageFinal() {
    const q = backstage && findQuestion(backstage.id); if (!q) return;
    const now = isInFlight(q);
    if (backstage.wasInFlight && !now) void loadBackstage(true);
    backstage.wasInFlight = now;
  }
  // 出字时只改这张卡的文字和状态行，不整卡重画（选中、展开不丢）。
  function patchPartial(card, q, ctx) {
    const partial = isInFlight(q) ? String(q.live?.partial || '') : '', box = card.querySelector('.meeting-chat-partial');
    if (box && box.textContent !== partial) { box.textContent = partial; box.hidden = !partial; }
    const label = card.querySelector('.meeting-chat-label'), text = questionStatus(q, ctx).label;
    if (label && label.textContent !== text) label.textContent = text;
  }
  function clockText(at) { if (!Number.isFinite(at)) return ''; const d = new Date(at), p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
  // 在途卡才跑 1 秒计时器（「已等 N 秒」只改数字）；后台抽屉开着且这题在途时同一个计时器每秒刷新记录。
  function syncChatTimer() {
    const need = (state?.meeting?.answers || []).some(isInFlight);
    if (need && !chatTimer) chatTimer = setInterval(() => {
      if (!root || root.hidden) return;
      tickWait(el('chat-list'));
      const q = backstage && findQuestion(backstage.id);
      if (q && isInFlight(q)) void loadBackstage();
    }, 1000);
    else if (!need && chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  }
  const findQuestion = qid => (state?.meeting?.answers || []).find(q => q.id === qid);
  // 主进程推送一题的阶段 / 流式文字：就地更新这一张卡，不等 2.5 秒轮询（契约第 2 节）。
  function onQuestionPush(_event, payload) {
    const m = state?.meeting;
    if (!root || !m || payload?.meetingId !== m.id) return;
    const before = findQuestion(payload.questionId)?.phase;
    const q = applyQuestionPush(m, payload);
    if (!q) return;
    // 阶段切换（启动、等首字、失败、完成）：推送不带步骤、引擎、错误原因，立即补拉一次状态（最多每 400ms 一次）。
    if (payload.phase && payload.phase !== 'streaming' && payload.phase !== before) scheduleDetailRefresh();
    // 只更新这一张卡（契约：推送就地更新，不整列重画）；阶段变了 upsertCard 会整卡重画这一张。
    const list = el('chat-list'), card = list.querySelector(`:scope > [data-answer="${CSS.escape(q.id)}"]`);
    if (!card) { renderChat(m); return; }
    const follow = nearBottom(list);
    upsertCard(q, card, questionQueue(m), state?.engines || []);
    syncChatSummary(m);
    if (follow) list.scrollTop = list.scrollHeight;
    if (backstage?.id === q.id) { renderBackstage(); syncBackstageFinal(); }
    syncChatTimer();
  }
  let detailTimer = null, detailAt = 0;
  function scheduleDetailRefresh() {
    if (detailTimer) return;
    const wait = Math.max(0, 400 - (Date.now() - detailAt));
    detailTimer = setTimeout(() => { detailTimer = null; detailAt = Date.now(); void refresh().catch(e => message(e.message, { fromPoll: true })); }, wait);
  }
  // ---------- 看后台：右栏内抽屉 ----------
  function openBackstageFor(qid) {
    backstage = { id: qid, log: null, error: '', fallback: !!backstageUnsupported, loading: false, wasInFlight: isInFlight(findQuestion(qid)) };
    el('backstage').hidden = false; renderBackstage(); void loadBackstage();
  }
  function closeBackstage() { backstage = null; const box = el('backstage'); if (box) { box.hidden = true; box.innerHTML = ''; box.dataset.html = ''; } }
  async function loadBackstage(force = false) {
    const b = backstage; if (!b || b.fallback || !id) return;
    if (b.loading) { if (force) b.reload = true; return; } // 正在读：读完再补一次，不丢「结束时」那一读
    b.loading = true; b.reload = false;
    try { const log = await call('meeting-question-log', { meetingId: id, questionId: b.id }); if (backstage === b) { b.log = log; b.error = ''; } }
    catch (error) { if (backstage === b) { if (isMissingHandler(error)) { b.fallback = true; backstageUnsupported = true; } else b.error = error.message; } }
    finally { b.loading = false; }
    if (backstage === b) { renderBackstage(); if (b.reload) void loadBackstage(true); }
  }
  function renderBackstage() {
    const b = backstage, box = el('backstage'), q = b && findQuestion(b.id);
    if (!b || !q) { closeBackstage(); return; }
    const html = backstageHtml(q, currentLog(q.id), { engines: state?.engines || [], error: b.error, sessionNote: b.sessionNote });
    if (box.dataset.html === html) return;
    const lines = box.querySelector('.meeting-backstage-lines'), stick = !lines || nearBottom(lines), linesTop = lines?.scrollTop || 0;
    const menuOpen = box.querySelector('.meeting-engine-menu')?.open;
    const openLong = [...box.querySelectorAll('.meeting-backstage-long[open]')].map(d => d.dataset.long);
    box.innerHTML = html; box.dataset.html = html;
    if (menuOpen) box.querySelector('.meeting-engine-menu')?.setAttribute('open', '');
    for (const d of box.querySelectorAll('.meeting-backstage-long')) if (openLong.includes(d.dataset.long)) d.open = true;
    const nextLines = box.querySelector('.meeting-backstage-lines'); if (nextLines && !stick) nextLines.scrollTop = linesTop;
    const next = box.querySelector('.meeting-backstage-lines'); if (next && stick) next.scrollTop = next.scrollHeight;
  }
  // 新后端的记录到了用它；老后端（没有读取接口）用题目上的持久字段并注明；第一次读取还没回来时先显示持久字段、不下结论。
  function currentLog(qid) {
    const base = fallbackLog(findQuestion(qid), state?.meeting);
    if (backstage?.fallback) return base;
    return backstage?.log || { ...base, fallback: false };
  }
  // 问答控制（重答、取消）：老后端不认识的操作，说清是版本问题。
  async function questionControl(op, value) {
    if (!id) return;
    try { await call('meeting-control', { id, op, value }); }
    catch (error) {
      if (/不支持这个操作/.test(error.message)) throw new Error(({ reanswer: '换档重答', 'cancel-question': '取消这题', 'question-speed': '问答档位' })[op] + '需要新版 Hub 后端，当前版本还不支持。');
      throw error;
    }
    await refresh();
  }
  function firstVisibleRow(list) {
    const rows = list.children, top = list.getBoundingClientRect().top;
    if (root.dataset.hideTranscripts === 'true') return [...rows].find(n => n.offsetParent && n.getBoundingClientRect().bottom > top) || null;
    let lo = 0, hi = rows.length - 1, found = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].getBoundingClientRect().bottom > top) { found = rows[mid]; hi = mid - 1; } else lo = mid + 1; }
    return found;
  }
  function renderNavigation(meeting) {
    const nav = meetingNavigation(meeting), box = el('topics');
    const stamp = JSON.stringify([id, nav]);
    if (box.dataset.stamp !== stamp) {
      el('topics-label').textContent = nav.kind === 'topics' ? '议题' : '时间定位';
      el('topics-hint').textContent = nav.kind === 'topics' ? '来自纪要，点击回到出处' : '议题尚未整理，先按画面与重点回看';
      box.innerHTML = nav.items.map((t, i) => `<button class="meeting-topic" data-topic="${t.seq}" data-event="${t.seq}"><span>${i + 1}. ${esc(t.title)}</span><small>${time(t.at)}</small></button>`).join('') || '<p class="meeting-empty">采集开始后，这里会逐步留下定位入口。</p>';
      box.dataset.stamp = stamp;
    }
    markActive();
  }
  function thumbnails() {
    thumbsObserver?.disconnect();
    const meetingId = id;
    const queue = []; let active = 0;
    async function load(img) {
      const key = meetingId + ':' + img.dataset.thumb;
      try {
        let url = thumbGet(key);
        if (!url) {
          const asset = await call('meeting-asset', { id: meetingId, seq: Number(img.dataset.thumb) });
          const image = new window.Image(); image.src = 'data:image/jpeg;base64,' + asset.data;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = Math.max(1, Math.round(240 * image.height / image.width));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          url = canvas.toDataURL('image/jpeg', .72); thumbSet(key, url);
        }
        if (id === meetingId && img.isConnected) { img.src = url; img.dataset.loaded = '1'; }
      } catch (error) { if (img.isConnected) { img.alt = '预览未加载，点击查看'; img.title = error.message; } }
      finally { active--; drain(); }
    }
    function drain() { while (active < 3 && queue.length) { active++; void load(queue.shift()); } }
    thumbsObserver = new window.IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { thumbsObserver.unobserve(e.target); queue.push(e.target); }
      drain();
    }, { root: el('timeline'), rootMargin: '200px' });
    // 已加载的不再观察；缓存里有的直接贴上，不排队。
    el('timeline').querySelectorAll('img[data-thumb]:not([data-loaded])').forEach(img => {
      const url = thumbGet(meetingId + ':' + img.dataset.thumb);
      if (url) { img.src = url; img.dataset.loaded = '1'; } else thumbsObserver.observe(img);
    });
  }
  function thumbGet(key) { const url = thumbCache.get(key); if (url) { thumbCache.delete(key); thumbCache.set(key, url); } return url; }
  function thumbSet(key, url) { thumbCache.delete(key); thumbCache.set(key, url); while (thumbCache.size > THUMB_LIMIT) thumbCache.delete(thumbCache.keys().next().value); }
  // 材料位置（2026-11-19 用户反馈「升级后找不到以前会议的录屏、纪要」）：写明当前文件夹；旧目录并进来的、读不出的都说清在哪。
  function renderStorage(st) {
    if (!st) return;
    const where = `材料保存在 ${st.root}`, notes = [];
    for (const x of st.extra || []) notes.push(`另有 ${x.count} 场在以前的数据目录 ${x.dir}，已一并列出`);
    if (st.corrupt?.length) notes.push(`${st.corrupt.length} 场的记录文件读不出，原文件仍在 ${st.corrupt[0].dir}${st.corrupt.length > 1 ? ' 等处' : ''}`);
    for (const c of st.copies || []) notes.push(`这场会议在 ${c.dir} 还有一份（${({ older: '较旧', newer: '较新' })[c.relation] || '时间相同'}），当前显示的是 ${st.current}`);
    if (st.dataRootError) notes.push(st.dataRootError);
    if (el('storage-text').textContent !== where) { el('storage-text').textContent = where; el('storage-text').title = where; }
    const note = notes.join('；');
    if (el('storage-note').textContent !== note) { el('storage-note').textContent = note; el('storage-note').hidden = !note; }
  }
  async function refresh() {
    if (!root?.isConnected) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true; refreshAgain = false;
    try {
      const requested = id, next = await call('meeting-status', { id });
      if (requested !== id) return;
      // 推送可能比这次轮询更新：旧轮询不把卡片退回去（partial 变短、完成闪回在答）。
      if (next.meeting && state?.meeting?.id === next.meeting.id) next.meeting = mergeQuestionState(state.meeting, next.meeting);
      state = next;
      const m = state.meeting, asr = state.asr || {};
      if (state.meetingError) message(`这场会议暂时读不出：${state.meetingError}。文件仍在原处，其他会议不受影响。`, { fromPoll: true });
      const history = '<option value="">历史会议…</option>' + state.meetings.map(x => `<option value="${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.title)} · ${shortDate(x.startedAt)}${x.videoBytes ? ' · ' + size(x.videoBytes) : ''}</option>`).join('');
      renderSpeakers(m); renderGlossaryHints(m);
      const videoTotal = state.meetings.reduce((n, x) => n + (x.videoBytes || 0), 0);
      el('video-total').textContent = videoTotal ? `全部录像占用 ${size(videoTotal)}` : '';
      renderStorage(state.storage);
      if (el('history').dataset.html !== history) { el('history').innerHTML = history; el('history').dataset.html = history; }
      el('asr').textContent = asr.error || (asr.progress ? '正在安装本地转写组件，可以先录音，装好后自动补转写。' : asr.phase) || (asr.upgrade ? `本地转写可用（旧引擎，较慢）。升级到新引擎更快、中文更准，约 ${asr.sizeText}。` : asr.ready ? `本地转写已就绪 · ${asr.voiceprint ? '自动区分发言人 · ' : ''}CPU 模式` : `首次使用需下载本地转写组件（约 ${asr.sizeText || '300 MB'}，断了可续）；未安装也可先录音，之后补转写。`);
      asrBar(asr.progress);
      const speech = meetingAsrState(asr, m);
      el('setup-asr').textContent = speech.setupText;
      el('setup-asr-install').hidden = !speech.install;
      el('setup-asr-install').textContent = speech.installLabel;
      // r58：本地转写包的内源状态，最多每分钟刷新一次（render 很频繁）。
      if (!(Date.now() - Number(root.dataset.dlSourceAt || 0) < 60000)) { root.dataset.dlSourceAt = String(Date.now()); void require('./download-source-view').fill(root).catch(() => {}); }
      root.querySelectorAll('[data-act="install"]').forEach(button => { button.disabled = speech.installing; });
      if (asr.ready) el('record-only-confirm').hidden = true;
      const phase = m ? recordingInterrupted() ? '已中断' : ({ recording: capture?.paused ? '已暂停' : '采集中', paused:'已暂停', ended:'已结束', interrupted:'采集已中断' })[m.state] : '尚未开始';
      el('record-label').textContent = phase;
      updateLiveStatus();
      el('record-dot').dataset.state = capture?.running && !capture.paused ? 'recording' : capture?.running ? 'paused' : m ? 'ended' : 'idle';
      el('footer-dot').dataset.state = m?.state === 'interrupted' || capture?.saveError ? 'error' : el('record-dot').dataset.state;
      root.dataset.phase = capture?.running ? 'live' : m ? 'review' : 'idle';
      root.dataset.recording = String(!!capture?.running && !capture.paused);
      root.dataset.thinking = String(!!m?.job && ['understand', 'question'].includes(m.job.kind) && m.job.state !== 'error');
      const reviewing = root.dataset.phase === 'review', exportButton = root.querySelector('[data-act="export"]');
      const exportParent = root.querySelector(reviewing ? '.meeting-actions' : '.meeting-summary-heading');
      if (exportButton.parentElement !== exportParent) {
        if (reviewing) exportParent.prepend(exportButton); else exportParent.append(exportButton);
      }
      exportButton.classList.toggle('primary', reviewing);
      exportButton.querySelector('span').hidden = !reviewing;
      el('duration').textContent = time(m?.capturedMs);
      meters();
      el('clock').textContent = time(capture?.running ? capture.displayMs() : m?.capturedMs);
      if (!root.querySelector('.meeting-rename-input')) el('session-title').textContent = m?.title || '准备开始一场会议';
      el('rename-title').hidden = !m;
      el('source-label').textContent = m ? m.sourceName || '本地会议记录' : '选择共享窗口，让会议内容有据可查';
      el('progress').textContent = m ? `${phase} · 已采集 ${time(m.capturedMs)} · 转写至 ${time(m.transcribedMs)} · 理解至 ${time(m.understoodMs)}` : '尚未开始采集 · 先选窗口和音源';
      for (const name of ['pause','stop']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running;
      const cannotResume = capture?.paused && recordingInterrupted();
      const pauseButton = root.querySelector('[data-act="pause"]');
      if (cannotResume) pauseButton.disabled = true;
      pauseButton.title = cannotResume ? '这场不能再继续录了，请结束会议' : '';
      root.querySelector('[data-act="pause"]').classList.toggle('is-paused', !!capture?.paused);
      for (const name of ['mark','snap']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running || capture.paused;
      for (const name of ['understand','ask','export','retry-asr']) root.querySelector(`[data-act="${name}"]`).disabled = !m;
      root.querySelector('[data-act="start"]').disabled = !!capture?.running || !el('record-only-confirm').hidden;
      root.querySelector('[data-act="pause"] span').textContent = capture?.paused ? '继续' : '暂停';
      root.querySelector('[data-act="retry-save"]').hidden = !(capture?.saveError || capture?.recorder?.error || capture?.recorder?.lifecycleError || capture?.recorder?.queue.length || capture?.queue.length);
      el('history').disabled = busy || !!capture?.running;
      for (const name of ['source','title','system','mic']) el(name).disabled = !!capture?.running;
      root.querySelectorAll('[data-crop]').forEach(input => { input.disabled = !!capture?.running; });
      const rec = m?.recording, replayable = canReplayFull(rec) || !!rec?.segments.some(s => s.status === 'ready');
      for (const op of ['open-full','save-video']) root.querySelector(`[data-act="${op}"]`).disabled = !canReplayFull(rec);
      for (const op of ['play','extract']) root.querySelector(`[data-act="${op}"]`).disabled = !replayable;
      root.querySelector('[data-act="delete-video"]').disabled = !replayable || !!capture?.running;
      root.querySelector('[data-act="delete-meeting"]').disabled = !m || ['recording', 'paused'].includes(m.state) || !!capture?.running;
      el('seek').max = String(Math.max(0, (m?.capturedMs || 0) / 1000));
      // 录像补索引（m6）：进行中/等待/失败都写清，别让人以为「保存视频」「完整录像」卡死。
      const repair = understandingView.repairText(rec?.full);
      el('recording-status').textContent = rec?.deleted ? '录像已删除，纪要、转写和截图都保留' : rec ? `本地录像已保存至 ${time(rec.savedThrough)} · ${(rec.bytes / 1024 / 1024).toFixed(1)} MB${rec.full?.status === 'writing' ? ' · 保存中' : ''}${repair ? ' · ' + repair : ''}` : m ? '此会议没有录像，仍可查看截图与录音' : '材料仅保存到本机';
      for (const op of ['open-full', 'save-video']) root.querySelector(`[data-act="${op}"]`).title = repair;
      el('gaps').textContent = [...(rec?.gaps || []), ...(rec?.openGap ? [{...rec.openGap,end:null}] : [])].map(g => `${time(g.at)}—${g.end==null || g.open ? '未恢复' : time(g.end)} ${g.reason}`).join('；');
      const waited = m?.job?.sentAt ? Math.max(0, Math.round((Date.now() - m.job.sentAt) / 1000)) : 0;
      const aiName = String(m?.engineLabel || state.engineCurrent || 'CodeAgent').split(' · ')[0];
      // 理解线此刻在哪一步（契约 7.1 understandingStage.text，已是白话、引擎名取实际）；老后端退回原来的写法。
      const stageText = understandingView.stageLine(state);
      const jobText = stageText || (!m?.job ? '' : m.job.state === 'error' ? (m.job.kind === 'question' ? '回答失败，可重试' : '理解失败，可重试')
        : m.job.kind === 'prime' ? `${aiName} 正在预热（${waited} 秒）` : m.job.kind === 'question' ? `正在回答提问（${waited} 秒）` : `${aiName} 正在整理（${waited} 秒）`);
      el('understanding-status').textContent = m ? `第 ${m.revision} 版 · 理解至 ${time(m.understoodMs)}${jobText ? ' · ' + jobText : m.summary ? ' · 来源可点击回查' : ` · 等待 ${aiName} 理解`}${m.lastDuration && !m.job ? ` · 上轮用时 ${Math.round(m.lastDuration / 1000)} 秒` : ''}` : '采集、本地转写与会议理解独立进行';
      // 一眼看出这一轮改了什么（模型写的「本轮小结」），不用逐条对比纪要。
      if (m?.lastChange && !m.job) el('understanding-status').textContent += ` · 刚更新：${m.lastChange.length > 40 ? m.lastChange.slice(0, 40) + '…' : m.lastChange}`;
      el('understanding-status').title = m?.lastChange ? '本轮变化：' + m.lastChange : '';
      renderUnderstandingHealth(m);
      // 会议专属 CodeAgent：状态、速度档、自动间隔、打开会话（2026-10-25）。
      const agent = m?.agent?.state || (m?.sessionId ? 'ready' : 'none');
      const agentBox = el('agent-state'); agentBox.dataset.state = m?.job && m.job.state !== 'error' && m.job.kind !== 'prime' ? 'busy' : agent;
      const who = aiName; /* 底栏也用实际引擎名（engineLabel → engineCurrent），不硬写 CodeAgent */
      agentBox.querySelector('span').textContent = !m ? `${who} 未启动` : agent === 'starting' ? `${who} 预热中` : agent === 'error' ? `${who} 启动异常` : m.job && m.job.state !== 'error' ? `${who} 工作中` : `${who} 已就绪`;
      agentBox.title = m?.engineLabel ? '会议 AI：' + m.engineLabel : '';
      root.querySelectorAll('[data-speed]').forEach(b => { const on = b.dataset.speed === (m?.speed || 'normal'); b.setAttribute('aria-checked', String(on)); b.disabled = !m; });
      if (document.activeElement !== el('interval')) el('interval').value = String(m ? (m.autoUnderstand === false ? 0 : (m.autoIntervalMin ?? 1)) : 3);
      el('interval').disabled = !m;
      root.querySelector('[data-act-local="open-agent"]').disabled = !m?.sessionId || !openSession;
      // 会议 AI（2026-11-08）：本机装了、接上了模型的终端都列出来，自动 = 按评测排出的推荐；能选时旧的「快速档模型」收起来。
      const engines = state.engines || [], engineSelect = el('engine');
      el('engine-field').hidden = !engines.length; el('fast-model-field').hidden = engines.length > 0;
      const recommended = engines.find(x => x.id === state.recommendedEngine);
      const engineHtml = `<option value="">自动${recommended ? ' · ' + esc(recommended.label) : ''}</option>` + engines.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
      if (engineSelect.dataset.html !== engineHtml) { engineSelect.innerHTML = engineHtml; engineSelect.dataset.html = engineHtml; }
      if (document.activeElement !== engineSelect) engineSelect.value = m?.engine || ''; engineSelect.disabled = !m;
      const modelSelect = el('fast-model');
      const modelHtml = `<option value="">自动${state.defaultFastModel ? ' · ' + esc(state.defaultFastModel) : ' · 沿用当前模型'}</option>` + (state.models || []).map(x => `<option value="${esc(x.id)}">${esc(x.label || x.id)}</option>`).join('');
      if (modelSelect.dataset.html !== modelHtml) { modelSelect.innerHTML = modelHtml; modelSelect.dataset.html = modelHtml; }
      if (document.activeElement !== modelSelect) modelSelect.value = m?.fastModel || ''; modelSelect.disabled = !m;
      const questionSessionButton = root.querySelector('[data-act-local="open-question-agent"]');
      questionSessionButton.hidden = !m?.questionSessionId;
      questionSessionButton.disabled = !m?.questionSessionId || !openSession;
      // 问答档位：本场默认（契约 questionSpeed），与纪要档位互不影响；老后端没有这个字段时按「快速」显示。
      const qspeed = m?.questionSpeed || state.questionSpeed || 'fast';
      root.querySelectorAll('[data-qspeed]').forEach(b => { b.setAttribute('aria-checked', String(b.dataset.qspeed === qspeed)); b.disabled = !m; });
      el('qspeed-hint').textContent = QSPEED_HINT[qspeed] || '';
      // 新后端的理解出错已在「会议理解」tab 顶部带原因和按钮显示，提示条不再重复；问答异常在「助手对话」顶部。
      const pollError = state.recordingError || (state.understandingStage ? '' : m?.error) || ('questionLaneError' in state ? '' : m?.questionError) || m?.asrError || rec?.full?.durationError;
      if (pollError) message(pollError, { fromPoll: true });
      else if (!state.meetingError) dismissedMessage = '';
      renderFlow(m); renderChat(m); renderNavigation(m); renderReviewHero(m);
      // 纪要文本没变就不重跑 Markdown 与消毒（长纪要每 2.5 秒一次很费）。
      const nextSummaryKey = (m?.id || '') + '\u0000' + (m?.summary || '');
      if (summaryKey !== nextSummaryKey) {
        const summary = el('summary'), html = m?.summary ? markdown(plainMinutes(m.summary)) : EMPTY_SUMMARY;
        if (summary.dataset.html !== html) { summary.innerHTML = html; citations(summary); summary.dataset.html = html; }
        summaryKey = nextSummaryKey;
      }
      scrollGuard.check(root);
    } finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh().catch(e => message(e.message)); } }
  }
  async function action(op) {
    if (op === 'live') { evidenceRequest++; view('live'); return; }
    if (op === 'new') { if (capture?.running) throw new Error('请先点「结束会议」，没存完的内容会留在这一场里。'); selectMeeting(''); el('title').value = ''; el('title').focus({ preventScroll: true }); return; }
    if (op === 'sources') { const r = await call('meeting-sources'); sourceList = r.sources; root.querySelector('[data-m="source"]').innerHTML = sourceList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); renderSourceGrid(); preview(); return; }
    if (op === 'install') { await call('meeting-asr-install'); await refresh(); return; }
    if (op === 'cancel-record-only') { el('record-only-confirm').hidden = true; const start = root.querySelector('[data-act="start"]'); start.disabled = false; start.focus({ preventScroll: true }); return; }
    if (op === 'start' || op === 'start-without-asr') {
      const selected = root.querySelector('[data-m="source"]').value; if (!selected) throw new Error('先刷新并选择共享窗口');
      if (op === 'start' && !state?.asr?.ready) {
        el('record-only-confirm').hidden = false;
        root.querySelector('[data-act="start-without-asr"]').focus({ preventScroll: true });
        return;
      }
      if (op === 'start-without-asr' && el('record-only-confirm').hidden) return;
      el('record-only-confirm').hidden = true;
      const crop = {}; for (const k of ['x', 'y', 'w', 'h']) crop[k] = Number(root.querySelector(`[data-crop="${k}"]`).value) / 100;
      if (Object.values(crop).some(v => !Number.isFinite(v)) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('截图区域应在画面范围内');
      const audio = { system: root.querySelector('[data-m="system"]').checked, mic: root.querySelector('[data-m="mic"]').checked };
      let captureId;
      const next = new MeetingCapture({ document, window, save: r => call('meeting-capture', { id: captureId, ...r }), status: message });
      await next.open(selected, audio);
      root.querySelector('[data-m="mic"]').checked = audio.mic;
      try { const r = await call('meeting-start', { title: root.querySelector('[data-m="title"]').value, sourceName: sourceList.find(s => s.id === selected)?.name, audio: Object.keys(audio).filter(k => audio[k]) }); id = captureId = r.meeting.id; resetPlayer(); capture = next; capture.start(crop); el('live').srcObject = capture.video.srcObject; await el('live').play(); view('live'); el('setup').open = false; message([next.warning, r.diskWarning].filter(Boolean).join('；') || '已开始连续录屏。原始画面和声音本地留底，CodeAgent 默认只读取提炼图文；截图区域不裁掉原始录像。'); }
      catch (e) {
        let cleanupError;
        try { await next.dispose(); } catch (error) { cleanupError = error; }
        if (capture === next) {
          if (cleanupError || next.queue.length || next.saving || next.recorder?.queue.length || next.recorder?.saving) {
            next.running = true; next.paused = true; next.ending = true;
            throw new Error('会议没能开始：' + e.message + '。请先点「重试保存」，再点「结束会议」。');
          }
          try { await call('meeting-control', { id: captureId, op: 'stop' }); }
          catch (error) { next.running = true; next.ending = true; throw error; }
          next.running = false; capture = null;
        }
        throw cleanupError || e;
      }
    } else if (op === 'retry-save') { await capture?.retry(); message(capture?.ending || capture?.released ? '已补存好，请再点一次「结束会议」。' : capture?.recorder?.full?.recorder.state === 'inactive' ? '已补存好。录像已中断，请点「结束会议」，再新开一场。' : '已重试保存，点击继续恢复采集。'); }
    else if (op === 'pause') { if (capture.paused) { capture.assertCanResume(); await call('meeting-control', { id, op: state.meeting.state === 'paused' ? 'resume' : 'auto', value: state.meeting.autoUnderstand }); capture.resume(); } else { await capture.pause(); await call('meeting-control', { id, op: 'pause' }); } }
    else if (op === 'stop') {
      await capture.stop(); capture.running = true;
      // Keep ownership until the meeting service confirms its terminal state, including a lost reply.
      try { await capture.wait(call('meeting-control', { id, op: 'stop' }), '会议还没结束完，请稍后再点一次「结束会议」，先别关 Hub。'); }
      catch (error) {
        let confirmed;
        try { confirmed = await capture.wait(call('meeting-status', { id }), '会议还没结束完，请稍后再点一次「结束会议」，先别关 Hub。'); } catch (_) {}
        if (confirmed?.meeting?.id !== id || confirmed.meeting.state !== 'ended') throw error;
      }
      capture.running = false;
      el('live').srcObject = null; const latest = state.meeting?.events.filter(e => e.kind === 'slide').at(-1); if (latest) await showEvidence(latest.seq); else view('empty'); message('采集已结束，剩余转写和会后复核继续处理。');
    }
    else if (op === 'snap') await capture.frame(true);
    else if (op === 'mark') { if (capture.paused) throw new Error('请先继续采集'); capture.enqueue({ kind: 'mark', at: capture.elapsed(), text: root.querySelector('[data-m="note"]').value || '重点' }); root.querySelector('[data-m="note"]').value = ''; await capture.frame(true); }
    else if (op === 'open-folder') { await call('meeting-open-folder', { id }); }
    else if (op === 'export') { if (!id) throw new Error('先选择会议'); await call('meeting-export', { id }); }
    else if (op === 'open-full') { if (!id) throw new Error('先选择会议'); await call('meeting-open-full', { id }); }
    else if (op === 'play' && playback && !el('player').paused) { el('player').pause(); return; }
    else if (op === 'delete-video') { if (!id) throw new Error('先选择会议'); const done = await call('meeting-delete-video', { id }); if (!done.canceled) { resetPlayer(); message(`录像已删除，腾出 ${size(done.freed)}。纪要、转写和截图都保留。`); await refresh(); } }
    else if (op === 'delete-meeting') {
      if (!id) throw new Error('先选择会议');
      const target = id, m = state?.meeting?.id === target ? state.meeting : null, title = m?.title || '这场会议';
      const video = m?.recording?.bytes ? `，含录像 ${size(m.recording.bytes)}` : '';
      const ok = await require('./ui-feedback').confirmHubAction(`删除「${title}」${video}？\n纪要、原话、截图、录音和录像都会删掉，不能恢复。只删这一场，其他会议和专业词库不受影响。${state?.storage?.copies?.length ? '\n另一个目录还有这场会议的一份，下一步再选要不要一起删。' : ''}`,
        { document, title: '删除这场会议？', acceptLabel: '删除这场会议', danger: true });
      if (!ok || id !== target) return;
      // 同一场在别的目录还有一份：再问一次要不要一起删，默认（取消、Esc）只删当前显示的这份。
      const copies = state?.storage?.copies || [];
      const alsoCopies = copies.length > 0 && await require('./ui-feedback').confirmHubAction(`另一个目录还有这场会议的一份（${({ older: '较旧', newer: '较新' })[copies[0].relation] || '时间相同'}）：\n${copies.map(c => c.dir).join('\n')}\n\n默认只删当前显示的这份，另一份留在原处、不再显示；选「一起删」会把它也删掉，不能恢复。`,
        { document, title: '另一份也删吗？', acceptLabel: '一起删', cancelLabel: '只删显示的这份', danger: true });
      if (id !== target) return;
      const done = await call('meeting-delete', { id: target, alsoCopies });
      const keptNote = done.kept?.length ? `另一份仍在 ${done.kept[0]}，已不再显示。` : '';
      selectMeeting(''); message(done.warning || `已删除「${done.title || title}」，其他会议不受影响。${keptNote}`); await refresh(); return;
    }
    else if (op === 'save-video') { if (!id) throw new Error('先选择会议'); const saved = await call('meeting-save-video', { id }); if (saved.file) message('视频已保存：' + saved.file); }
    else if (op === 'play') { const rec=state.meeting?.recording, first=canReplayFull(rec)?rec.full:rec?.segments.find(s=>s.status==='ready'); await playAt(Number(root.querySelector('[data-m="seek-seconds"]').value)*1000 || first?.at || 0,true); }
    else if (op === 'extract') { const at=playback ? playbackTime(root.querySelector('[data-m="player"]').currentTime) : Number(root.querySelector('[data-m="seek-seconds"]').value)*1000; const requested = id; const result=await call('meeting-frames',{id,timesMs:[Math.round(at)]}); if(requested!==id)return; view('evidence', '录像回查'); const frame=result.frames[0]; root.querySelector('[data-m="evidence"]').innerHTML=`<p>录像回查 · ${time(frame.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${frame.data}" alt="从录像提取的画面">`; addPptLookup(frame.path); }
    else if (op === 'ask') { const input = el('question'), value = input.value, requested = id; if (!requested) throw new Error('先选择会议'); await call('meeting-control', { id: requested, op: 'ask', value }); if (id === requested) { if (input.value === value) input.value = ''; chatReveal = true; switchTab('chat'); } }
    else { if (!id) throw new Error('先选择会议'); await call('meeting-control', { id, op }); }
    await refresh();
  }
  function preview() {
    const s = sourceList.find(s => s.id === root.querySelector('[data-m="source"]').value); root.querySelector('[data-m="preview"]').src = s?.thumbnail || '';
    root.querySelectorAll('[data-source-id]').forEach(b => { const on = b.dataset.sourceId === s?.id; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  }
  // 共享窗口缩略图网格：只是原下拉框的另一种选法，选中后同步下拉框（2026-11-04 定稿 C）。
  function renderSourceGrid() {
    el('source-grid').innerHTML = sourceList.map(s => `<button type="button" class="meeting-source" role="radio" data-source-id="${esc(s.id)}" title="${esc(s.name)}">${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="">` : '<img alt="">'}<span>${esc(s.name)}</span></button>`).join('');
  }
  // 「会议理解」tab 顶部：卡在哪、为什么、能点什么；会议 AI 用的是谁、来自哪里。
  function renderUnderstandingHealth(m) {
    const line = m ? understandingView.engineLine(state) : '', lineBox = el('engine-line');
    lineBox.hidden = !line; if (lineBox.textContent !== line) lineBox.textContent = line;
    const alert = m ? understandingView.understandingAlert(state, { live: !!capture?.running }) : null, box = el('und-alert');
    box.hidden = !alert; box.dataset.tone = alert?.tone || '';
    if (el('und-alert-text').textContent !== (alert?.text || '')) el('und-alert-text').textContent = alert?.text || '';
    el('und-alert-sub').hidden = !alert?.sub; if (el('und-alert-sub').textContent !== (alert?.sub || '')) el('und-alert-sub').textContent = alert?.sub || '';
    const ops = (alert?.ops || []).map(o => `<button type="button" class="ca-btn" data-und-op="${esc(o.op)}">${esc(o.label)}</button>`).join('');
    if (el('und-alert-ops').dataset.html !== ops) { el('und-alert-ops').innerHTML = ops; el('und-alert-ops').dataset.html = ops; }
  }
  function pickEngine() { el('more').open = true; const pick = el('engine-field').hidden ? el('fast-model') : el('engine'); pick.focus({ preventScroll: true }); scrollGuard.check(root); }
  // 会后大卡片的头部：会议名、版本与时长等真实读数（纯展示）。
  function renderReviewHero(m) {
    const box = el('review-hero'); if (!box) return;
    if (!m) { if (box.dataset.html) { box.innerHTML = ''; box.dataset.html = ''; } return; }
    const slides = (m.events || []).filter(e => e.kind === 'slide').length, minutes = Math.round((m.capturedMs || 0) / 60000);
    const speech = meetingAsrState(state?.asr, m);
    // 纪要失败（原因 + 重新整理 / 换引擎）与「整理中」分开（契约 7.1）。
    const failed = understandingView.reviewStage(state, speech.reviewReady);
    if (failed) { speech.reviewText = failed.text + (failed.detail ? '：' + (failed.detail.length > 60 ? failed.detail.slice(0, 60) + '…' : failed.detail) : ''); speech.reviewFailed = failed; }
    const speechAction = speech.reviewAction ? `<button class="ca-btn" data-act="${speech.reviewAction}"${speech.reviewAction === 'install' && speech.installing ? ' disabled' : ''}>${speech.reviewAction === 'install' ? esc(speech.installLabel) : '重试失败转写'}</button>` : '';
    const failedActions = speech.reviewFailed?.tone === 'red' ? '<button class="ca-btn" data-und-op="understand">重新整理</button><button class="ca-btn" data-und-op="pick-engine">换引擎</button>' : '';
    const html = `<div class="hw-row"><span class="hw-tag ${speech.reviewReady ? 'green' : speech.reviewFailed?.tone === 'red' ? 'red' : 'amber'}" title="${esc(speech.reviewFailed?.detail || '')}">${esc(speech.reviewText)}</span>${speechAction}${failedActions}<span class="hw-meta">${esc(shortDate(m.startedAt))} · 第 ${esc(m.revision ?? 0)} 版</span></div>`
      + (speech.pending && (state?.asr?.phase || state?.asr?.error) ? `<p class="meeting-asr">${esc(speech.setupText)}</p>` : '')
      + `<h2>${esc(m.title || '本地会议记录')}</h2>`
      + `<div class="hw-facts"><div><b>${minutes}<span> 分钟</span></b><small>会议时长</small></div><div><b>${slides}</b><small>张画面</small></div><div><b>${(m.events || []).filter(e => e.kind === 'mark').length}</b><small>条重点</small></div><div><b>${m.answers?.length || 0}</b><small>条问答</small></div></div>`;
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }
  async function open(parent) {
    if (!root) {
      root = document.createElement('section'); root.className = 'company-meeting'; root.dataset.phase = 'idle'; root.innerHTML = meetingTemplate();
      root.addEventListener('click', e => {
        const button = e.target.closest('[data-act]'); if (button && !button.disabled) {
          // 提问、截图、记重点等各自防重，不被别的按钮没跑完挡掉（以前点了会被静默丢弃）；录制生命周期类操作互斥。
          const act = button.dataset.act, exclusive = EXCLUSIVE_ACTS.has(act);
          if (!(exclusive && busy) && !running.has(act)) {
            running.add(act); if (exclusive) { busy = true; el('history').disabled = true; } button.disabled = true;
            void action(act).catch(e => message(e.message)).finally(() => { running.delete(act); if (exclusive) busy = false; button.disabled = false; void refresh().catch(e => message(e.message)); });
          }
        }
        if (!e.target.closest('.meeting-more')) el('more').open = false;
        if (e.target.closest('[data-act-local="dismiss"]')) dismissMessage();
        if (e.target.closest('[data-act-local="rename-title"]')) startRename();
        if (e.target.closest('[data-act-local="add-hints"]')) addGlossaryHints();
        const transcriptToggle = e.target.closest('[data-act-local="toggle-transcript"]');
        if (transcriptToggle) { const hide = root.dataset.hideTranscripts !== 'true'; root.dataset.hideTranscripts = String(hide); transcriptToggle.setAttribute('aria-pressed', String(hide)); transcriptToggle.textContent = hide ? '显示时间流中的原话' : '隐藏时间流中的原话'; }
        if (e.target.closest('[data-act-local="expand-viewer"]')) setViewerExpanded(!root.querySelector('.meeting-viewer').classList.contains('is-expanded'));
        if (e.target.closest('[data-act-local="latest"]')) el('timeline').scrollTop = el('timeline').scrollHeight;
        if (e.target.closest('[data-act-local="open-agent"]') && state?.meeting?.sessionId && openSession) void openSession(state.meeting.sessionId).catch(err => message(err.message));
        if (e.target.closest('[data-act-local="open-question-agent"]') && state?.meeting?.questionSessionId && openSession) void openSession(state.meeting.questionSessionId).catch(err => message(err.message));
        const tab = e.target.closest('[data-aside-tab]'); if (tab) switchTab(tab.dataset.asideTab);
        const undOp = e.target.closest('[data-und-op]'); if (undOp && id && !undOp.disabled) {
          if (undOp.dataset.undOp === 'pick-engine') pickEngine();
          else { undOp.disabled = true; void call('meeting-control', { id, op: undOp.dataset.undOp }).then(() => refresh()).catch(err => message(err.message)).finally(() => { undOp.disabled = false; }); }
        }
        const qspeed = e.target.closest('[data-qspeed]'); if (qspeed && id && !qspeed.disabled) void questionControl('question-speed', qspeed.dataset.qspeed).catch(err => message(err.message));
        const reanswer = e.target.closest('[data-reanswer]'); if (reanswer && id && !reanswer.disabled) {
          reanswer.disabled = true; const value = { id: reanswer.dataset.reanswer };
          if (reanswer.dataset.speedTo) value.speed = reanswer.dataset.speedTo; if (reanswer.dataset.engineTo) value.engine = reanswer.dataset.engineTo;
          chatReveal = true; void questionControl('reanswer', value).catch(err => message(err.message)).finally(() => { reanswer.disabled = false; });
        }
        const cancelQ = e.target.closest('[data-cancel-question]'); if (cancelQ && id && !cancelQ.disabled) { cancelQ.disabled = true; void questionControl('cancel-question', cancelQ.dataset.cancelQuestion).catch(err => message(err.message)).finally(() => { cancelQ.disabled = false; }); }
        const openLog = e.target.closest('[data-backstage]'); if (openLog) openBackstageFor(openLog.dataset.backstage);
        if (e.target.closest('[data-backstage-close]')) closeBackstage();
        const copyLog = e.target.closest('[data-backstage-copy]'); if (copyLog) { const q = findQuestion(copyLog.dataset.backstageCopy); if (q) void Promise.resolve().then(() => require('electron').clipboard.writeText(logText(q, currentLog(q.id)))).then(() => { copyLog.textContent = '已复制'; }).catch(err => message(`复制未完成：${err.message}`)); }
        const sessionLog = e.target.closest('[data-open-backstage-session]'); if (sessionLog) void openUnderstandingBackstage(sessionLog.dataset.openBackstageSession);
        if (e.target.closest('[data-act-local="lane-engine"]')) pickEngine();
        if (e.target.closest('[data-act-local="lane-backstage"]')) void openUnderstandingBackstage(state?.meeting?.sessionId);
        const retry = e.target.closest('[data-retry-question]'); if (retry && id && !retry.disabled) { retry.disabled = true; void call('meeting-control', { id, op: 'retry-question', value: retry.dataset.retryQuestion }).then(() => refresh()).catch(err => message(err.message)).finally(() => { retry.disabled = false; }); }
        const followup = e.target.closest('[data-followup-question]'); if (followup) { const q = state?.meeting?.answers?.find(q => q.id === followup.dataset.followupQuestion); if (q) { switchTab('chat'); el('question').value = q.q; el('question').focus({ preventScroll: true }); scrollGuard.check(root); } }
        const copy = e.target.closest('[data-copy-answer]'); if (copy) {
          const body = copy.closest('[data-answer]')?.querySelector('.meeting-answer-body');
          if (body) { copy.disabled = true; void Promise.resolve().then(() => require('electron').clipboard.writeText(body.innerText.trim())).then(() => { copy.textContent = '已复制'; }).catch(err => message(`复制未完成：${err.message}`)).finally(() => { copy.disabled = false; }); }
        }
        const findPpt = e.target.closest('[data-find-ppt]'); if (findPpt) void showEvidence(Number(findPpt.dataset.findPpt)).then(file => file && lookupPpt(file)).catch(err => message(err.message));
        const findImage = e.target.closest('[data-find-image]'); if (findImage) void lookupPpt(findImage.dataset.findImage).catch(err => message(err.message));
        const openPpt = e.target.closest('[data-ppt-open]'); if (openPpt) void call('ppt-open', { id: openPpt.dataset.pptOpen }).then(r => { if (r.pageFocused === false) message('原文件已打开，请手动切到候选页面。'); }).catch(err => message(err.message));
        const speedButton = e.target.closest('[data-speed]'); if (speedButton && id && !speedButton.disabled) void call('meeting-control', { id, op: 'speed', value: speedButton.dataset.speed }).then(() => refresh()).catch(err => message(err.message));
        const quick = e.target.closest('[data-quick]'); if (quick) { el('more').open = false; switchTab('chat'); el('question').value = quick.dataset.quick; el('question').focus({ preventScroll: true }); const ask = root.querySelector('[data-act="ask"]'); if (!ask.disabled) ask.click(); }
        const event = e.target.closest('[data-event]'); if (event) {
          const seq = Number(event.dataset.event), entry = state.meeting?.events.find(x => x.seq === seq);
          if (event.dataset.topic) { const row = el('timeline').querySelector(`:scope > [data-flow-key="event-${seq}"]`); scrollWithin(el('timeline'), row, 'center'); scrollGuard.check(root); }
          if (entry && event.closest('.meeting-flow') && entry.kind !== 'slide' && !capture?.running && canReplayAt(entry.at)) { activeSeq = seq; markActive(); void playAt(entry.at, true).catch(e => message(e.message)); }
          else void showEvidence(seq).catch(e => message(e.message));
        }
        const sourceTile = e.target.closest('[data-source-id]'); if (sourceTile && !capture?.running) { const select = el('source'); select.value = sourceTile.dataset.sourceId; select.dispatchEvent(new window.Event('change', { bubbles: true })); }
        const frame=e.target.closest('[data-play-at]');if(frame)void playAt(Number(frame.dataset.playAt),true).catch(e=>message(e.message));
      });
      root.querySelector('[data-m="source"]').addEventListener('change', preview);
      root.addEventListener('keydown', e => { if (e.key === 'Escape' && el('more').open) { el('more').open = false; el('more').querySelector('summary').focus({ preventScroll: true }); } });
      el('timeline').addEventListener('scroll', updateFollowButton, { passive: true });
      el('chat-list').addEventListener('scroll', () => { chatFollow = nearBottom(el('chat-list')); }, { passive: true });
      if (ipcRenderer && !pushBound) { pushBound = true; ipcRenderer.on('company-assistant:meeting-question', onQuestionPush); }
      root.querySelector('[data-m="history"]').addEventListener('change', e => selectMeeting(e.target.value));
      void call('meeting-glossary', {}).then(r => { if (document.activeElement !== el('glossary')) el('glossary').value = r.text || ''; }).catch(() => {});
      el('glossary').addEventListener('change', e => { void call('meeting-glossary-save', { text: e.target.value }).then(r => message(`专业词库已保存：${r.terms.length} 个词${r.fixes.length ? `，${r.fixes.length} 条替换（对之后的转写生效）` : ''}`)).catch(err => message(err.message)); });
      el('speakers').addEventListener('change', e => { const sid = e.target.dataset?.speaker; if (id && sid) void call('meeting-control', { id, op: 'speaker-name', value: { id: Number(sid), name: e.target.value } }).then(() => refresh()).catch(err => message(err.message)); });
      el('interval').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'interval', value: Number(e.target.value) }).then(() => refresh()).catch(err => message(err.message)); });
      el('engine').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'engine', value: e.target.value }).then(() => refresh()).catch(err => message(err.message)); });
      el('engine').addEventListener('focus', () => { void modelSync.read(); });
      el('model-catalog-retry').addEventListener('click', () => { void modelSync.retry(); });
      el('fast-model').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'fast-model', value: e.target.value }).then(() => refresh()).catch(err => message(err.message)); });
      el('note').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); root.querySelector('[data-act="mark"]').click(); } });
      el('question').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); root.querySelector('[data-act="ask"]').click(); } });
      const player = el('player'), playIcon = () => root.querySelector('.meeting-play').classList.toggle('is-playing', !player.paused);
      for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, playIcon);
      meterTimer = setInterval(() => { if (capture?.running && !root.hidden) meters(); }, 150);
      root.querySelector('[data-m="seek"]').addEventListener('change',e=>{root.querySelector('[data-m="seek-seconds"]').value=e.target.value;void playAt(Number(e.target.value)*1000,false).catch(e=>message(e.message));});
            player.addEventListener('timeupdate',()=>{if(!playback)return;const at=playbackTime(player.currentTime);root.querySelector('[data-m="seek"]').value=String(at/1000);root.querySelector('[data-m="play-time"]').textContent=time(at);root.querySelector('[data-m="seek-seconds"]').value=(at/1000).toFixed(1);});
      el('rate').addEventListener('change',e=>{const rate=Number(e.target.value);player.defaultPlaybackRate=rate;player.playbackRate=rate;});
      player.addEventListener('ended',()=>{if(!playback||playback.spans)return;const next=state.meeting?.recording?.segments.find(s=>s.status==='ready'&&s.at>playback.segment.at);if(next){if(next.at>playback.segment.end+1000)message(`跳过未录制时段 ${time(playback.segment.end)}—${time(next.at)}`);void playAt(Math.max(next.at,playback.segment.end),true).catch(e=>message(e.message));}});
      poll = setInterval(() => { if (!root.hidden || capture?.running) void refresh().catch(e => message(e.message, { fromPoll: true })); }, 2500);
    }
    if (!root.isConnected) parent.append(root); root.hidden = false; void modelSync.read(); restoreScroll(); await refresh(); if (!sourceList.length) await action('sources');
  }
  const SCROLLERS = ['timeline', 'summary-scroll', 'chat-list'];
  const scroller = name => name === 'summary-scroll' ? root.querySelector('.meeting-summary-scroll') : el(name);
  function rememberScroll() {
    if (!root) return;
    if (savedScroll && savedScroll.id === id && !root.querySelector('[data-m="timeline"]').clientHeight) return; /* 已隐藏时不覆盖上次记下的位置 */
    savedScroll = { id, lists: Object.fromEntries(SCROLLERS.map(name => { const n = scroller(name); return [name, n && n.clientHeight ? { top: n.scrollTop, follow: nearBottom(n) } : null]; /* 没在排版（已隐藏）读到的都是 0，不记 */ })) };
  }
  function restoreScroll() {
    const saved = savedScroll; savedScroll = null;
    if (!saved || saved.id !== id) return;
    for (const name of SCROLLERS) { const n = scroller(name), s = saved.lists[name]; if (n && s) n.scrollTop = s.follow ? n.scrollHeight : s.top; }
    updateFollowButton(); scrollGuard.check(root);
  }
  async function showEvidence(seq) {
    const e = state.meeting?.events.find(e => e.seq === seq); if (!e) return;
    const request = ++evidenceRequest, meetingId = id;
    const target = el('evidence');
    activeSeq = seq; markActive();
    let imagePath;
    if (e.kind === 'slide') { const r = await call('meeting-asset', { id, seq }); if(request!==evidenceRequest || meetingId!==id)return; view('evidence', '精选画面 · ' + time(e.at)); target.innerHTML = `<p>事件 ${seq} · ${time(e.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${r.data}" alt="会议页面">`; imagePath = r.path; addPptLookup(imagePath); }
    else if (e.audioSeq) { const r = await call('meeting-asset', { id, seq: e.audioSeq }), audio = state.meeting.events.find(x => x.seq === e.audioSeq); if(request!==evidenceRequest || meetingId!==id)return; view('evidence','原音回查 · ' + time(e.at)); target.innerHTML = `<p>${esc(e.text)}</p><audio controls src="data:audio/wav;base64,${r.data}"></audio>`; target.querySelector('audio').currentTime = Math.max(0, (e.at - audio.at) / 1000); }
    else { view('evidence', '会议重点 · ' + time(e.at)); target.innerHTML = `<p>${esc(e.text)}</p>`; }
    if(canReplayAt(e.at)){const b=document.createElement('button');b.className='ca-btn';b.dataset.playAt=String(e.at);b.textContent='回放此处';target.append(b);}
    return imagePath;
  }
  // 「打开理解会话后台」：切到会议理解会话并打开它的后台终端（renderer.js 的 __hubOpenBackstage）。
  // 打不开（会话已休眠/已关闭）时留在会议页，把原因写在抽屉里（抽屉没开就写提示条）。
  async function openUnderstandingBackstage(sessionId) {
    const tell = text => { if (backstage) { backstage.sessionNote = text; renderBackstage(); } else message(text); };
    if (!sessionId) { tell('这场会议还没有理解会话，会议 AI 起来后才有后台可看。'); return; }
    try {
      const r = openBackstage ? await openBackstage(sessionId) : await window.__hubOpenBackstage?.(sessionId);
      if (!r?.ok) tell('理解会话已休眠或已关闭，后台打不开。点「会议理解」tab 的「更新」或下一轮自动理解会重新建会话；也可在「更多 › 打开理解会话」重开。');
    } catch (error) { tell('理解会话没打开：' + error.message); }
  }
  function addPptLookup(file) {
    if (!file) return;
    const button = document.createElement('button'); button.className = 'ca-btn meeting-find-original'; button.dataset.findImage = file; button.textContent = '找原稿'; el('evidence').append(button);
  }
  async function lookupPpt(imagePath) {
    const meetingId = id, request = ++evidenceRequest, target = root.querySelector('.meeting-viewer');
    target.querySelector('.meeting-ppt-results')?.remove();
    const box = document.createElement('section'); box.className = 'meeting-ppt-results'; box.setAttribute('role', 'status'); box.textContent = '正在识别此页并查找原稿…'; target.append(box);
    try {
      const result = await call('ppt-lookup-frame', { imagePath, limit: 5 }); if (request !== evidenceRequest || meetingId !== id || !box.isConnected) return;
      if (result.ok === false) throw new Error(result.error || '原稿查找失败，请重试');
      box.innerHTML = '<strong>候选原稿 · 请核对画面</strong>' + (result.candidates?.length ? result.candidates.map(c => `<div><button class="ca-link" data-ppt-open="${esc(c.id)}">${esc(c.ref?.name || c.title || '候选文件')} · 第 ${esc(c.ref?.page || '?')} 页</button><span>${esc(c.snippet || c.title || '')}</span></div>`).join('') : '<div>本次没有找到匹配文字的素材。</div>');
    } catch (error) {
      if (request !== evidenceRequest || meetingId !== id || !box.isConnected) return;
      box.innerHTML = `<strong>${esc(error.message)}</strong><button class="ca-btn" data-find-image="${esc(imagePath)}">重试找原稿</button>`;
    }
  }
  // 只动「上一个高亮」和「当前该高亮」的那几个按钮，不遍历整条时间流（长会议几千条）。
  function markActive() {
    const want = activeSeq == null ? [] : [...root.querySelectorAll(`[data-m="timeline"] [data-event="${activeSeq}"], [data-m="topics"] [data-event="${activeSeq}"]`)];
    for (const b of root.querySelectorAll('[data-m="timeline"] .is-active[data-event], [data-m="topics"] .is-active[data-event]')) if (!want.includes(b)) { b.classList.remove('is-active'); if (b.dataset.topic) b.setAttribute('aria-current', 'false'); }
    for (const b of want) { b.classList.add('is-active'); if (b.dataset.topic) b.setAttribute('aria-current', 'true'); }
  }
  function selectMeeting(value) {
    if (capture?.running) { el('history').value = id || ''; message('请先点「结束会议」，没存完的内容会留在这一场里。'); return; }
    el('record-only-confirm').hidden = true;
    id = value || null; activeSeq = null; chatReveal = false; chatFollow = true; closeBackstage(); evidenceRequest++; resetPlayer(); view('empty'); message(''); el('more').open = false;
    el('history').value = value || ''; el('timeline').dataset.stamp = ''; el('timeline').innerHTML = ''; el('chat-list').querySelectorAll(':scope > [data-answer]').forEach(n => n.remove()); el('evidence').innerHTML = '';
    void refresh().catch(e => message(e.message));
  }
  // 回放优先走整场录像；只有 5.5.0 之前的老会议才退回分段。
  // 发言人：按声音自动区分，名字在「更多」里改（core/company-assistant/meeting-speakers.js）。
  function speakerName(e){const s=(state?.meeting?.speakers?.list||[]).find(x=>x.id===e.speaker);return s?(s.name||`发言人${s.id}`):e.track==='mic'?'麦克风':'系统声音';}
  // 会后复核给的「词库建议」：词库里已有的不再提示；点一下追加进词库并保存。
  function pendingHints(m){const have=el('glossary').value;return (m?.glossaryHints||[]).filter(h=>!have.split(/\r?\n/).some(l=>l.replace(/\s/g,'')===h.replace(/\s/g,'')));}
  function renderGlossaryHints(m){const hints=pendingHints(m),box=el('glossary-hints');box.hidden=!hints.length;el('glossary-hint-text').textContent=hints.length?`本场常听错：${hints.join('、')}`:'';if(hints.length&&box.dataset.shown!==m.id){box.dataset.shown=m.id;message(`本场发现 ${hints.length} 个常听错的专业词，可在「更多 › 专业词库」一键加入`);}}
  function addGlossaryHints(){const hints=pendingHints(state?.meeting);if(!hints.length)return;const box=el('glossary');box.value=(box.value.replace(/\s+$/,'')+'\n'+hints.join('\n')).replace(/^\n/,'')+'\n';void call('meeting-glossary-save',{text:box.value}).then(r=>{message(`已加入词库，之后的转写会自动改对（共 ${r.fixes.length} 条替换）`);renderGlossaryHints(state?.meeting);}).catch(err=>message(err.message));}
  function renderSpeakers(m){
    const box=el('speakers'),list=m?.speakers?.list||[],key=(m?.id||'')+':'+list.map(s=>`${s.id}/${s.name}/${s.n}`).join(',');
    if(box.dataset.key===key||box.contains(document.activeElement))return; box.dataset.key=key; box.hidden=!list.length;
    box.innerHTML=list.length?`<p>发言人（按声音自动区分；改名后时间流和纪要都用新名字，同一人被分成两位时改成同一个名字）</p>`+list.map(s=>`<label>${esc(s.track==='mic'?'麦克风':'系统声音')} · ${s.n} 句<input data-speaker="${s.id}" maxlength="40" value="${esc(s.name)}" placeholder="发言人${s.id}"></label>`).join(''):'';
  }
  const ipcRenderer = (() => { try { return require('electron').ipcRenderer; } catch { return null; } })();
  const modelSync = require('./company-meeting-models').createMeetingModelSync({ ipcRenderer,
    onUpdate: () => refresh(),
    onCatalog: catalog => {
      if (!root) return;
      const loading = catalog.state === 'loading', failed = catalog.state === 'failed';
      el('model-catalog').hidden = !loading && !failed;
      el('model-catalog-status').textContent = loading ? '正在读取账号可用模型，通常几秒，最久约 3 分钟；现有选项仍可使用。'
        : failed ? `模型清单读取失败：${catalog.error || '请稍后重试'}。现有选项仍可使用。` : '';
      el('model-catalog-retry').hidden = !failed;
    },
  });
  // r59：本地转写包下载的统一进度条（两处：顶部本地转写行、「本地转写」折叠区）。2.5 秒轮询之间由进度总线实时推。
  let asrBusSub = null;
  function asrBar(progress) {
    if (!root) return;
    if (!asrBusSub && ipcRenderer) asrBusSub = require('./download-progress-view').subscribe('meeting-asr', p => asrBar(p), ipcRenderer);
    const html = progress ? require('./download-progress-view').html(progress, { title: '下载本地转写组件' }) : '';
    root.querySelectorAll('[data-asr-dlp]').forEach(host => { if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; } });
  }
  // 纪要条目编号（[D2] 等）只给模型对齐用，界面不显示（core/company-assistant/meeting-minutes.js）。
  function plainMinutes(s){return String(s||'').replace(/^(\s*[-*]\s*)\[[TFDAQ]\d{1,3}\]\s*/gm,'$1');}
  function size(bytes){return bytes>=1024**3?(bytes/1024**3).toFixed(1)+' GB':Math.max(1,Math.round(bytes/1024**2))+' MB';}
  function canReplayFull(rec){return !!rec?.full?.bytes&&rec.full.status!=='writing';}
  function canReplayAt(at){const rec=state.meeting?.recording;return canReplayFull(rec)||!!rec?.segments.some(s=>s.status==='ready'&&s.at<=at&&s.end>at);}
  function playbackTime(seconds){const ms=seconds*1000;if(!playback.spans)return playback.segment.at+ms;const span=[...playback.spans].reverse().find(x=>x.mediaAt<=ms)||playback.spans[0];return span.at+ms-span.mediaAt;}
  function resetPlayer(){playRequest++;playback=null;const p=root.querySelector('[data-m="player"]');p.pause();p.removeAttribute('src');p.load();root.querySelector('[data-m="seek-seconds"]').value='0';root.querySelector('[data-m="seek"]').value='0';}
  async function playAt(at,autoplay){
    if(!id)throw new Error('先选择会议');const request=++playRequest,meetingId=id;
    const r=await call('meeting-playback',{id,at:Math.round(at)});if(request!==playRequest||meetingId!==id)return;
    const video=root.querySelector('[data-m="player"]');video.pause(); evidenceRequest++; view('replay');
    if(playback?.segment.key!==r.segment.key){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('回放加载超时')),15000);const ok=()=>done();const bad=()=>done(new Error('录像无法播放'));function done(e){clearTimeout(timer);video.removeEventListener('loadeddata',ok);video.removeEventListener('error',bad);e?reject(e):resolve();}video.addEventListener('loadeddata',ok,{once:true});video.addEventListener('error',bad,{once:true});video.src=r.url;video.load();});}
    if(request!==playRequest||meetingId!==id)return;playback=r;video.currentTime=r.offsetMs/1000;root.querySelector('[data-m="play-time"]').textContent=time(at);if(autoplay)await video.play();
  }
  window.addEventListener('beforeunload', e => { if (capture?.running || capture?.queue.length || capture?.saving || capture?.recorder?.queue.length || capture?.recorder?.saving) { e.preventDefault(); e.returnValue = false; } });
  return { open, close: () => { if (root) { if (!root.hidden) rememberScroll(); root.hidden = true; el('player').pause(); el('evidence').querySelector('audio')?.pause(); } }, dispose: () => { modelSync.dispose(); clearInterval(poll); clearInterval(chatTimer); if (pushBound) ipcRenderer?.removeListener('company-assistant:meeting-question', onQuestionPush); clearInterval(meterTimer); thumbsObserver?.disconnect(); void capture?.dispose().catch(e => message(e.message)); } };
}
module.exports = { createCompanyMeetingPage };
