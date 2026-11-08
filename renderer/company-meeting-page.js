'use strict';
const { MeetingCapture } = require('./meeting-capture');
const { meetingTemplate } = require('./company-meeting-template');
const { flowEntries, meetingNavigation } = require('./company-meeting-flow');
const { meetingAsrState } = require('./company-meeting-asr-state');
const netPassView = require('./net-pass-view');
function createCompanyMeetingPage({ document, window, call, markdown, openSession }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = ms => `${String(Math.floor((ms || 0) / 60000)).padStart(2, '0')}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
  let root, id = null, capture, state, poll, sourceList = [], playback = null, playRequest = 0;
  let busy = false, refreshing = false, evidenceRequest = 0, thumbsObserver, meterTimer, activeSeq = null, revealQuestion = false;
  const thumbCache = new Map();
  function message(s) { if (root) root.querySelector('[data-m="message"]').textContent = s; }
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
    title.after(input); input.focus(); input.select();
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
    setViewerExpanded(mode === 'evidence' || mode === 'replay');
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
  function updateFollowButton() {
    const list = el('timeline');
    root.querySelector('[data-act-local="latest"]').hidden = list.scrollHeight - list.clientHeight - list.scrollTop < 64;
  }
  function questionCard(q, expanded, queueAhead) {
    const status = q.state === 'queued' && q.waiting ? q.waiting : { queued: '排队中', running: '回答中', done: '已回答', error: '没答上' }[q.state] || '排队中';
    const refs = [...new Set(String(q.answer || '').match(/\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/g) || [])];
    const answer = String(q.answer || '').replace(/\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/g, '').trim();
    const answerBody = `<div class="meeting-answer-body">${markdown(answer)}</div>`;
    const error = String(q.error || '暂时没有收到回答').trim();
    const errorSentence = error + (/[。！？.!?]$/.test(error) ? '' : '。');
    const clipped = q.truncated ? '<p class="meeting-question-error">回答过长，仅保留部分内容。</p>' : '';
    const sources = refs.length ? `<span class="meeting-question-sources">依据 ${refs.map(esc).join(' ')}</span>` : '';
    const body = q.state === 'done' ? answerBody + clipped
      : q.state === 'error' ? `<p class="meeting-question-error">没答上：${esc(errorSentence)}纪要不受影响。</p>${answer ? '<p class="meeting-question-thinking">已收到的部分回答：</p>' + answerBody + clipped : ''}`
        : `<p class="meeting-question-thinking">${q.state === 'running' ? '<span class="meeting-question-dots" aria-hidden="true"><i></i><i></i><i></i></span>正在查阅会议内容…' : Number.isInteger(queueAhead) && queueAhead >= 0 ? `排队中 · 前面还有 ${queueAhead} 个问题，可继续提问` : '排队中 · 上一个问题答完就开始'}</p>`;
    const actions = q.state === 'done' ? `<div class="meeting-question-actions">${sources}<span class="meeting-question-tools"><button class="meeting-question-button" data-copy-answer="${esc(q.id)}">复制</button><button class="meeting-question-button" data-followup-question="${esc(q.id)}">追问</button></span></div>`
      : q.state === 'error' ? `<div class="meeting-question-actions">${answer ? sources : ''}<span class="meeting-question-tools"><button class="meeting-question-button primary" data-retry-question="${esc(q.id)}">重试</button></span></div>` : '';
    return `<details class="meeting-flow-answer" data-answer="${esc(q.id)}" data-question-state="${esc(q.state || 'queued')}"${expanded ? ' open' : ''}><summary><span class="meeting-question-badge" aria-hidden="true">问</span><span class="meeting-question-title">${esc(q.q)}</span><small class="meeting-question-isolation">单独回答 · 不影响纪要</small><span class="meeting-question-state">${status}</span></summary>${body}${actions}</details>`;
  }
  function renderFlow(meeting) {
    const list = el('timeline'), entries = flowEntries(meeting), stamp = JSON.stringify([id, entries]);
    if (list.dataset.stamp === stamp) return;
    const follow = list.scrollHeight - list.clientHeight - list.scrollTop < 64;
    const anchor = [...list.children].find(n => n.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const existing = new Map([...list.querySelectorAll(':scope > [data-flow-key]')].map(n => [n.dataset.flowKey, n]));
    list.querySelector(':scope > .meeting-empty')?.remove();
    for (const [index, entry] of entries.entries()) {
      let row = existing.get(entry.key); existing.delete(entry.key);
      if (!row) { row = document.createElement('div'); row.dataset.flowKey = entry.key; }
      row.className = `meeting-flow-event is-${entry.kind}`;
      row.dataset.at = entry.at === null ? '' : String(entry.at);
      const version = JSON.stringify(entry) + (entry.event?.speaker ? speakerName(entry.event) : '');
      if (row.dataset.version !== version) {
        const expanded = row.querySelector('details')?.open ?? true;
        const label = entry.afterMeeting ? '会后' : entry.at === null ? '未记录' : time(entry.at);
        let content;
        if (entry.kind === 'question') {
          content = questionCard(entry.question, expanded, entry.queueAhead);
        } else {
          const e = entry.event;
          content = e.kind === 'slide' ? `<div class="meeting-frame-item"><button class="meeting-frame" data-event="${e.seq}" aria-label="查看 ${time(e.at)} 的截图"><img data-thumb="${e.seq}" alt="会议截图"></button><div><strong>共享画面${e.revisit ? ' · 再次展示' : ''}</strong><p>${e.forced ? '手动截图' : '自动精选'}</p><button class="ca-link" data-find-ppt="${e.seq}">找原稿</button></div></div>`
            : `<button class="meeting-event ${e.kind === 'mark' ? 'is-mark' : ''}" data-event="${e.seq}"><b>${e.kind === 'mark' ? '★ 重点' : esc(speakerName(e))}</b><span>${esc(e.text)}</span></button>`;
        }
        row.innerHTML = `<time>${label}</time><div class="meeting-flow-content">${content}</div>`;
        citations(row); row.dataset.version = version;
      }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    for (const node of existing.values()) node.remove();
    if (!entries.length) list.innerHTML = '<p class="meeting-empty">开始后，截图、原话、重点和问答会按时间显示在这里。</p>';
    list.dataset.stamp = stamp; thumbnails(); markActive();
    el('flow-count').textContent = `${entries.filter(e => e.kind === 'slide').length} 张画面 · ${entries.filter(e => ['transcript','mark'].includes(e.kind)).length} 条原话与重点 · ${meeting?.answers?.length || 0} 条问答`;
    if (revealQuestion) {
      const answer = [...list.querySelectorAll('[data-answer]')].at(-1);
      if (answer) { answer.open = true; answer.scrollIntoView({ block: 'nearest' }); }
      revealQuestion = false;
    } else if (follow) list.scrollTop = list.scrollHeight;
    else if (anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    updateFollowButton();
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
        let url = thumbCache.get(key);
        if (!url) {
          const asset = await call('meeting-asset', { id: meetingId, seq: Number(img.dataset.thumb) });
          const image = new window.Image(); image.src = 'data:image/jpeg;base64,' + asset.data;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = Math.max(1, Math.round(240 * image.height / image.width));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          url = canvas.toDataURL('image/jpeg', .72); thumbCache.set(key, url);
          if (thumbCache.size > 80) thumbCache.delete(thumbCache.keys().next().value);
        }
        if (id === meetingId && img.isConnected) img.src = url;
      } catch (error) { if (img.isConnected) { img.alt = '预览未加载，点击查看'; img.title = error.message; } }
      finally { active--; drain(); }
    }
    function drain() { while (active < 3 && queue.length) { active++; void load(queue.shift()); } }
    thumbsObserver = new window.IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { thumbsObserver.unobserve(e.target); queue.push(e.target); }
      drain();
    }, { root: el('timeline'), rootMargin: '200px' });
    el('timeline').querySelectorAll('[data-thumb]').forEach(img => thumbsObserver.observe(img));
  }
  async function refresh() {
    if (!root?.isConnected || refreshing) return;
    refreshing = true;
    try {
      const requested = id, next = await call('meeting-status', { id });
      if (requested !== id) return;
      state = next;
      const m = state.meeting, asr = state.asr || {};
      const history = '<option value="">历史会议…</option>' + state.meetings.map(x => `<option value="${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.title)} · ${shortDate(x.startedAt)}${x.videoBytes ? ' · ' + size(x.videoBytes) : ''}</option>`).join('');
      renderSpeakers(m); renderGlossaryHints(m);
      const videoTotal = state.meetings.reduce((n, x) => n + (x.videoBytes || 0), 0);
      el('video-total').textContent = videoTotal ? `全部录像占用 ${size(videoTotal)}` : '';
      if (el('history').dataset.html !== history) { el('history').innerHTML = history; el('history').dataset.html = history; }
      el('asr').textContent = asr.error || asr.phase || (asr.upgrade ? `本地转写可用（旧引擎，较慢）。升级到新引擎更快、中文更准，约 ${asr.sizeText}。` : asr.ready ? `本地转写已就绪 · ${asr.voiceprint ? '自动区分发言人 · ' : ''}CPU 模式` : `首次使用需下载本地转写组件（约 ${asr.sizeText || '300 MB'}，断了可续）；未安装也可先录音，之后补转写。`);
      renderAsrPass(asr);
      const speech = meetingAsrState(asr, m);
      el('setup-asr').textContent = speech.setupText;
      el('setup-asr-install').hidden = !speech.install;
      el('setup-asr-install').textContent = speech.installLabel;
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
      el('clock').textContent = time(capture?.running ? capture.elapsed() : m?.capturedMs);
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
      el('seek').max = String(Math.max(0, (m?.capturedMs || 0) / 1000));
      el('recording-status').textContent = rec?.deleted ? '录像已删除，纪要、转写和截图都保留' : rec ? `本地录像已保存至 ${time(rec.savedThrough)} · ${(rec.bytes / 1024 / 1024).toFixed(1)} MB${rec.full?.status === 'writing' ? ' · 保存中' : ''}` : m ? '此会议没有录像，仍可查看截图与录音' : '材料仅保存到本机';
      el('gaps').textContent = [...(rec?.gaps || []), ...(rec?.openGap ? [{...rec.openGap,end:null}] : [])].map(g => `${time(g.at)}—${g.end==null || g.open ? '未恢复' : time(g.end)} ${g.reason}`).join('；');
      const waited = m?.job?.sentAt ? Math.max(0, Math.round((Date.now() - m.job.sentAt) / 1000)) : 0;
      const jobText = !m?.job ? '' : m.job.state === 'error' ? (m.job.kind === 'question' ? '回答失败，可重试' : '理解失败，可重试')
        : m.job.kind === 'prime' ? `CodeAgent 正在预热（${waited} 秒）` : m.job.kind === 'question' ? `正在回答提问（${waited} 秒）` : `CodeAgent 正在整理（${waited} 秒）`;
      el('understanding-status').textContent = m ? `第 ${m.revision} 版 · 理解至 ${time(m.understoodMs)}${jobText ? ' · ' + jobText : m.summary ? ' · 来源可点击回查' : ' · 等待 CodeAgent 理解'}${m.lastDuration && !m.job ? ` · 上轮用时 ${Math.round(m.lastDuration / 1000)} 秒` : ''}` : '采集、本地转写与会议理解独立进行';
      // 一眼看出这一轮改了什么（模型写的「本轮小结」），不用逐条对比纪要。
      if (m?.lastChange && !m.job) el('understanding-status').textContent += ` · 刚更新：${m.lastChange.length > 40 ? m.lastChange.slice(0, 40) + '…' : m.lastChange}`;
      el('understanding-status').title = m?.lastChange ? '本轮变化：' + m.lastChange : '';
      // 会议专属 CodeAgent：状态、速度档、自动间隔、打开会话（2026-10-25）。
      const agent = m?.agent?.state || (m?.sessionId ? 'ready' : 'none');
      const agentBox = el('agent-state'); agentBox.dataset.state = m?.job && m.job.state !== 'error' && m.job.kind !== 'prime' ? 'busy' : agent;
      const who = String(m?.engineLabel || 'CodeAgent').split(' · ')[0];
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
      const pending = (m?.answers || []).filter(q => ['queued', 'running'].includes(q.state));
      const pendingBox = el('question-pending');
      pendingBox.hidden = !pending.length;
      pendingBox.innerHTML = pending.length ? `<i aria-hidden="true"></i><span>${pending.length} 个问题处理中 · 答案会插回时间流</span>` : '';
      if (state.recordingError || m?.error || m?.asrError || rec?.full?.durationError) message(state.recordingError || m.error || m.asrError || rec?.full?.durationError);
      renderFlow(m); renderNavigation(m); renderReviewHero(m);
      const summary = el('summary'), html = m?.summary ? markdown(plainMinutes(m.summary)) : EMPTY_SUMMARY;
      if (summary.dataset.html !== html) { summary.innerHTML = html; citations(summary); summary.dataset.html = html; }
    } finally { refreshing = false; }
  }
  async function action(op) {
    if (op === 'live') { evidenceRequest++; view('live'); return; }
    if (op === 'new') { if (capture?.running) throw new Error('请先点「结束会议」，没存完的内容会留在这一场里。'); selectMeeting(''); el('title').value = ''; el('title').focus(); return; }
    if (op === 'sources') { const r = await call('meeting-sources'); sourceList = r.sources; root.querySelector('[data-m="source"]').innerHTML = sourceList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); renderSourceGrid(); preview(); return; }
    if (op === 'install') { await call('meeting-asr-install'); await refresh(); return; }
    if (op === 'cancel-record-only') { el('record-only-confirm').hidden = true; const start = root.querySelector('[data-act="start"]'); start.disabled = false; start.focus(); return; }
    if (op === 'start' || op === 'start-without-asr') {
      const selected = root.querySelector('[data-m="source"]').value; if (!selected) throw new Error('先刷新并选择共享窗口');
      if (op === 'start' && !state?.asr?.ready) {
        el('record-only-confirm').hidden = false;
        root.querySelector('[data-act="start-without-asr"]').focus();
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
      try { const r = await call('meeting-start', { title: root.querySelector('[data-m="title"]').value, sourceName: sourceList.find(s => s.id === selected)?.name, audio: Object.keys(audio).filter(k => audio[k]) }); id = captureId = r.meeting.id; resetPlayer(); capture = next; capture.start(crop); el('live').srcObject = capture.video.srcObject; await el('live').play(); view('live'); el('setup').open = false; if (r.diskWarning) message(r.diskWarning); else message('已开始连续录屏。原始画面和声音本地留底，CodeAgent 默认只读取提炼图文；截图区域不裁掉原始录像。'); }
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
    else if (op === 'export') { if (!id) throw new Error('先选择会议'); await call('meeting-export', { id }); }
    else if (op === 'open-full') { if (!id) throw new Error('先选择会议'); await call('meeting-open-full', { id }); }
    else if (op === 'play' && playback && !el('player').paused) { el('player').pause(); return; }
    else if (op === 'delete-video') { if (!id) throw new Error('先选择会议'); const done = await call('meeting-delete-video', { id }); if (!done.canceled) { resetPlayer(); message(`录像已删除，腾出 ${size(done.freed)}。纪要、转写和截图都保留。`); await refresh(); } }
    else if (op === 'save-video') { if (!id) throw new Error('先选择会议'); const saved = await call('meeting-save-video', { id }); if (saved.file) message('视频已保存：' + saved.file); }
    else if (op === 'play') { const rec=state.meeting?.recording, first=canReplayFull(rec)?rec.full:rec?.segments.find(s=>s.status==='ready'); await playAt(Number(root.querySelector('[data-m="seek-seconds"]').value)*1000 || first?.at || 0,true); }
    else if (op === 'extract') { const at=playback ? playbackTime(root.querySelector('[data-m="player"]').currentTime) : Number(root.querySelector('[data-m="seek-seconds"]').value)*1000; const requested = id; const result=await call('meeting-frames',{id,timesMs:[Math.round(at)]}); if(requested!==id)return; view('evidence', '录像回查'); const frame=result.frames[0]; root.querySelector('[data-m="evidence"]').innerHTML=`<p>录像回查 · ${time(frame.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${frame.data}" alt="从录像提取的画面">`; addPptLookup(frame.path); }
    else if (op === 'ask') { const input = el('question'), value = input.value, requested = id; if (!requested) throw new Error('先选择会议'); await call('meeting-control', { id: requested, op: 'ask', value }); if (id === requested) { if (input.value === value) input.value = ''; revealQuestion = true; } }
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
  // 会后大卡片的头部：会议名、版本与时长等真实读数（纯展示）。
  function renderReviewHero(m) {
    const box = el('review-hero'); if (!box) return;
    if (!m) { if (box.dataset.html) { box.innerHTML = ''; box.dataset.html = ''; } return; }
    const slides = (m.events || []).filter(e => e.kind === 'slide').length, minutes = Math.round((m.capturedMs || 0) / 60000);
    const speech = meetingAsrState(state?.asr, m);
    const speechAction = speech.reviewAction ? `<button class="ca-btn" data-act="${speech.reviewAction}"${speech.reviewAction === 'install' && speech.installing ? ' disabled' : ''}>${speech.reviewAction === 'install' ? esc(speech.installLabel) : '重试失败转写'}</button>` : '';
    const html = `<div class="hw-row"><span class="hw-tag ${speech.reviewReady ? 'green' : 'amber'}">${esc(speech.reviewText)}</span>${speechAction}<span class="hw-meta">${esc(shortDate(m.startedAt))} · 第 ${esc(m.revision ?? 0)} 版</span></div>`
      + (speech.pending && (state?.asr?.phase || state?.asr?.error) ? `<p class="meeting-asr">${esc(speech.setupText)}</p>` : '')
      + `<h2>${esc(m.title || '本地会议记录')}</h2>`
      + `<div class="hw-facts"><div><b>${minutes}<span> 分钟</span></b><small>会议时长</small></div><div><b>${slides}</b><small>张画面</small></div><div><b>${(m.events || []).filter(e => e.kind === 'mark').length}</b><small>条重点</small></div><div><b>${m.answers?.length || 0}</b><small>条问答</small></div></div>`;
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }
  async function open(parent) {
    if (!root) {
      root = document.createElement('section'); root.className = 'company-meeting'; root.dataset.phase = 'idle'; root.innerHTML = meetingTemplate();
      root.addEventListener('click', e => {
        const button = e.target.closest('[data-act]'); if (button && !button.disabled && !busy) { busy = true; el('history').disabled = true; button.disabled = true; void action(button.dataset.act).catch(e => message(e.message)).finally(() => { busy = false; button.disabled = false; void refresh().catch(e => message(e.message)); }); }
        if (!e.target.closest('.meeting-more')) el('more').open = false;
        if (e.target.closest('[data-act-local="dismiss"]')) message('');
        if (e.target.closest('[data-act-local="rename-title"]')) startRename();
        if (e.target.closest('[data-act-local="add-hints"]')) addGlossaryHints();
        const transcriptToggle = e.target.closest('[data-act-local="toggle-transcript"]');
        if (transcriptToggle) { const hide = root.dataset.hideTranscripts !== 'true'; root.dataset.hideTranscripts = String(hide); transcriptToggle.setAttribute('aria-pressed', String(hide)); transcriptToggle.textContent = hide ? '显示时间流中的原话' : '隐藏时间流中的原话'; }
        if (e.target.closest('[data-act-local="expand-viewer"]')) setViewerExpanded(!root.querySelector('.meeting-viewer').classList.contains('is-expanded'));
        if (e.target.closest('[data-act-local="latest"]')) el('timeline').scrollTop = el('timeline').scrollHeight;
        if (e.target.closest('[data-act-local="open-agent"]') && state?.meeting?.sessionId && openSession) void openSession(state.meeting.sessionId).catch(err => message(err.message));
        if (e.target.closest('[data-act-local="open-question-agent"]') && state?.meeting?.questionSessionId && openSession) void openSession(state.meeting.questionSessionId).catch(err => message(err.message));
        const retry = e.target.closest('[data-retry-question]'); if (retry && id && !retry.disabled) { retry.disabled = true; void call('meeting-control', { id, op: 'retry-question', value: retry.dataset.retryQuestion }).then(() => refresh()).catch(err => message(err.message)).finally(() => { retry.disabled = false; }); }
        const followup = e.target.closest('[data-followup-question]'); if (followup) { const q = state?.meeting?.answers?.find(q => q.id === followup.dataset.followupQuestion); if (q) { el('question').value = q.q; el('question').focus(); } }
        const copy = e.target.closest('[data-copy-answer]'); if (copy) {
          const body = copy.closest('[data-answer]')?.querySelector('.meeting-answer-body');
          if (body) { copy.disabled = true; void Promise.resolve().then(() => require('electron').clipboard.writeText(body.innerText.trim())).then(() => { copy.textContent = '已复制'; }).catch(err => message(`复制未完成：${err.message}`)).finally(() => { copy.disabled = false; }); }
        }
        const findPpt = e.target.closest('[data-find-ppt]'); if (findPpt) void showEvidence(Number(findPpt.dataset.findPpt)).then(file => file && lookupPpt(file)).catch(err => message(err.message));
        const findImage = e.target.closest('[data-find-image]'); if (findImage) void lookupPpt(findImage.dataset.findImage).catch(err => message(err.message));
        const openPpt = e.target.closest('[data-ppt-open]'); if (openPpt) void call('ppt-open', { id: openPpt.dataset.pptOpen }).then(r => { if (r.pageFocused === false) message('原文件已打开，请手动切到候选页面。'); }).catch(err => message(err.message));
        const speedButton = e.target.closest('[data-speed]'); if (speedButton && id && !speedButton.disabled) void call('meeting-control', { id, op: 'speed', value: speedButton.dataset.speed }).then(() => refresh()).catch(err => message(err.message));
        const quick = e.target.closest('[data-quick]'); if (quick) { el('more').open = false; el('question').value = quick.dataset.quick; el('question').focus(); const ask = root.querySelector('[data-act="ask"]'); if (!ask.disabled) ask.click(); }
        const event = e.target.closest('[data-event]'); if (event) {
          const seq = Number(event.dataset.event), entry = state.meeting?.events.find(x => x.seq === seq);
          if (event.dataset.topic) { const row = [...el('timeline').children].find(n => n.dataset.flowKey === `event-${seq}`); row?.scrollIntoView({ block: 'center' }); }
          if (entry && event.closest('.meeting-flow') && entry.kind !== 'slide' && !capture?.running && canReplayAt(entry.at)) { activeSeq = seq; markActive(); void playAt(entry.at, true).catch(e => message(e.message)); }
          else void showEvidence(seq).catch(e => message(e.message));
        }
        const sourceTile = e.target.closest('[data-source-id]'); if (sourceTile && !capture?.running) { const select = el('source'); select.value = sourceTile.dataset.sourceId; select.dispatchEvent(new window.Event('change', { bubbles: true })); }
        const frame=e.target.closest('[data-play-at]');if(frame)void playAt(Number(frame.dataset.playAt),true).catch(e=>message(e.message));
      });
      root.querySelector('[data-m="source"]').addEventListener('change', preview);
      root.addEventListener('keydown', e => { if (e.key === 'Escape' && el('more').open) { el('more').open = false; el('more').querySelector('summary').focus(); } });
      el('timeline').addEventListener('scroll', updateFollowButton, { passive: true });
      root.querySelector('[data-m="history"]').addEventListener('change', e => selectMeeting(e.target.value));
      void call('meeting-glossary', {}).then(r => { if (document.activeElement !== el('glossary')) el('glossary').value = r.text || ''; }).catch(() => {});
      el('glossary').addEventListener('change', e => { void call('meeting-glossary-save', { text: e.target.value }).then(r => message(`专业词库已保存：${r.terms.length} 个词${r.fixes.length ? `，${r.fixes.length} 条替换（对之后的转写生效）` : ''}`)).catch(err => message(err.message)); });
      el('speakers').addEventListener('change', e => { const sid = e.target.dataset?.speaker; if (id && sid) void call('meeting-control', { id, op: 'speaker-name', value: { id: Number(sid), name: e.target.value } }).then(() => refresh()).catch(err => message(err.message)); });
      el('interval').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'interval', value: Number(e.target.value) }).then(() => refresh()).catch(err => message(err.message)); });
      el('engine').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'engine', value: e.target.value }).then(() => refresh()).catch(err => message(err.message)); });
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
      poll = setInterval(() => { if (!root.hidden || capture?.running) void refresh().catch(e => message(e.message)); }, 2500);
    }
    if (!root.isConnected) parent.append(root); root.hidden = false; await refresh(); if (!sourceList.length) await action('sources');
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
  function markActive() { root.querySelectorAll('[data-m="timeline"] [data-event], [data-m="topics"] [data-event]').forEach(b => { const active = Number(b.dataset.event) === activeSeq; b.classList.toggle('is-active', active); if (b.dataset.topic) b.setAttribute('aria-current', String(active)); }); }
  function selectMeeting(value) {
    if (capture?.running) { el('history').value = id || ''; message('请先点「结束会议」，没存完的内容会留在这一场里。'); return; }
    el('record-only-confirm').hidden = true;
    id = value || null; activeSeq = null; revealQuestion = false; evidenceRequest++; resetPlayer(); view('empty'); message(''); el('more').open = false;
    el('history').value = value || ''; el('timeline').dataset.stamp = ''; el('timeline').innerHTML = ''; el('evidence').innerHTML = '';
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
  // 下载被公司代理拦下时，就地给「放行下载服务器」按钮（renderer/net-pass-view.js，和一键更新共用）。
  let netPass = null, netPassLast = null;
  const ipcRenderer = (() => { try { return require('electron').ipcRenderer; } catch { return null; } })();
  function renderAsrPass(asr){
    const slot=el('asr-pass'); if(!slot)return;
    if(!asr.blocked||!ipcRenderer){slot.hidden=true;slot.innerHTML='';return;}
    slot.hidden=false; netPassView.ensureCss();
    if(!netPass){void ipcRenderer.invoke('net-pass:status',{refresh:true}).then(v=>{netPass=v||{hosts:[]};renderAsrPass(state?.asr||{});}).catch(()=>{});return;}
    const html=netPassView.boxHtml(netPass,{last:netPassLast}); if(slot.dataset.html===html)return; slot.dataset.html=html; slot.innerHTML=html;
    netPassView.bind(slot,{ipcRenderer,onUpdate:(next,last)=>{if(next)netPass=next;netPassLast=last;slot.dataset.html='';renderAsrPass(state?.asr||{});}});
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
  return { open, close: () => { if (root) { root.hidden = true; el('player').pause(); el('evidence').querySelector('audio')?.pause(); } }, dispose: () => { clearInterval(poll); clearInterval(meterTimer); thumbsObserver?.disconnect(); void capture?.dispose().catch(e => message(e.message)); } };
}
module.exports = { createCompanyMeetingPage };
