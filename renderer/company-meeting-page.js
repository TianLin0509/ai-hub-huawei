'use strict';
const { MeetingCapture } = require('./meeting-capture');
const { meetingTemplate } = require('./company-meeting-template');
function createCompanyMeetingPage({ document, window, call, markdown, openSession }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = ms => `${String(Math.floor((ms || 0) / 60000)).padStart(2, '0')}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
  let root, id = null, capture, state, poll, sourceList = [], playback = null, playRequest = 0;
  let busy = false, refreshing = false, evidenceRequest = 0, thumbsObserver, tab = 'summary', meterTimer, activeSeq = null;
  const thumbCache = new Map();
  function message(s) { if (root) root.querySelector('[data-m="message"]').textContent = s; }
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
      for (const match of text.matchAll(/\[(?:事件\s*(\d+)|画面\s*(\d+):(\d{2}))\]/g)) { fragment.append(document.createTextNode(text.slice(last, match.index))); const button = document.createElement('button'); button.className = 'ca-link'; if(match[1])button.dataset.event = match[1];else button.dataset.playAt=String((Number(match[2])*60+Number(match[3]))*1000); button.textContent = match[0]; fragment.append(button); last = match.index + match[0].length; }
      fragment.append(document.createTextNode(text.slice(last))); node.replaceWith(fragment);
    }
  }
  const shortDate = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const el = name => root.querySelector(`[data-m="${name}"]`);
  function view(mode, label) {
    root.querySelector('.meeting-stage').dataset.view = mode;
    el('viewer-label').textContent = label || ({ live:'共享画面 · 实时', replay:'会议录像回放', evidence:'会议出处', empty:'共享画面' })[mode];
    root.querySelector('[data-act="live"]').hidden = !capture?.running || mode === 'live';
    if (mode !== 'replay') el('player').pause();
    if (mode !== 'evidence') el('evidence').querySelector('audio')?.pause();
  }
  function switchTab(value) {
    tab = value;
    root.querySelectorAll('.meeting-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    root.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
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
      const history = '<option value="">历史会议…</option>' + state.meetings.map(x => `<option value="${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.title)} · ${shortDate(x.startedAt)}</option>`).join('');
      if (el('history').dataset.html !== history) { el('history').innerHTML = history; el('history').dataset.html = history; }
      el('asr').textContent = asr.error || asr.phase || (asr.ready ? '本地转写已就绪 · CPU 模式' : '首次使用可安装独立本地转写组件（模型约 500 MB）；未安装也可先录音，之后补转写。');
      const phase = m ? ({ recording: capture?.paused ? '已暂停' : '采集中', paused:'已暂停', ended:'已结束', interrupted:'采集已中断' })[m.state] : '尚未开始';
      el('record-label').textContent = phase;
      el('record-dot').dataset.state = capture?.running && !capture.paused ? 'recording' : capture?.running ? 'paused' : m ? 'ended' : 'idle';
      el('footer-dot').dataset.state = m?.state === 'interrupted' || capture?.saveError ? 'error' : el('record-dot').dataset.state;
      root.dataset.phase = capture?.running ? 'live' : m ? 'review' : 'idle';
      el('duration').textContent = time(m?.capturedMs);
      meters();
      el('clock').textContent = time(capture?.running ? capture.elapsed() : m?.capturedMs);
      el('session-title').textContent = m?.title || '准备开始一场会议';
      el('source-label').textContent = m ? m.sourceName || '本地会议记录' : '选择共享窗口，让会议内容有据可查';
      el('progress').textContent = m ? `${phase} · 已采集 ${time(m.capturedMs)} · 转写至 ${time(m.transcribedMs)} · 理解至 ${time(m.understoodMs)}` : '尚未开始采集 · 先选窗口和音源';
      for (const name of ['pause','stop']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running;
      root.querySelector('[data-act="pause"]').classList.toggle('is-paused', !!capture?.paused);
      for (const name of ['mark','snap']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running || capture.paused;
      for (const name of ['understand','ask','export','retry-asr']) root.querySelector(`[data-act="${name}"]`).disabled = !m;
      root.querySelector('[data-act="start"]').disabled = !!capture?.running;
      root.querySelector('[data-act="pause"] span').textContent = capture?.paused ? '继续' : '暂停';
      root.querySelector('[data-act="retry-save"]').hidden = !(capture?.saveError || capture?.recorder?.queue.length || capture?.queue.length);
      el('history').disabled = busy || !!capture?.running;
      for (const name of ['source','title','system','mic']) el(name).disabled = !!capture?.running;
      const rec = m?.recording, ready = rec?.segments.filter(s => s.status === 'ready') || [];
      for (const op of ['play','extract']) root.querySelector(`[data-act="${op}"]`).disabled = !ready.length;
      el('seek').max = String(Math.max(0, (m?.capturedMs || 0) / 1000));
      el('recording-status').textContent = rec ? `本地录像已保存至 ${time(rec.savedThrough)} · ${(rec.bytes / 1024 / 1024).toFixed(1)} MB · ${ready.length} 个可回放片段${rec.segments.some(s=>s.status==='writing') ? ' · 当前片段保存中' : ''}` : m ? '此会议没有录像，仍可查看截图与录音' : '材料仅保存到本机';
      el('gaps').textContent = [...(rec?.gaps || []), ...(rec?.openGap ? [{...rec.openGap,end:null}] : [])].map(g => `${time(g.at)}—${g.end==null || g.open ? '未恢复' : time(g.end)} ${g.reason}`).join('；');
      const waited = m?.job?.sentAt ? Math.max(0, Math.round((Date.now() - m.job.sentAt) / 1000)) : 0;
      const jobText = !m?.job ? '' : m.job.state === 'error' ? (m.job.kind === 'question' ? '回答失败，可重试' : '理解失败，可重试')
        : m.job.kind === 'prime' ? `CodeAgent 正在预热（${waited} 秒）` : m.job.kind === 'question' ? `正在回答提问（${waited} 秒）` : `CodeAgent 正在整理（${waited} 秒）`;
      el('understanding-status').textContent = m ? `第 ${m.revision} 版 · 理解至 ${time(m.understoodMs)}${jobText ? ' · ' + jobText : m.summary ? ' · 来源可点击回查' : ' · 等待 CodeAgent 理解'}${m.lastDuration && !m.job ? ` · 上轮用时 ${Math.round(m.lastDuration / 1000)} 秒` : ''}` : '采集、本地转写与会议理解独立进行';
      // 会议专属 CodeAgent：状态、速度档、自动间隔、打开会话（2026-10-25）。
      const agent = m?.agent?.state || (m?.sessionId ? 'ready' : 'none');
      const agentBox = el('agent-state'); agentBox.dataset.state = m?.job && m.job.state !== 'error' && m.job.kind !== 'prime' ? 'busy' : agent;
      agentBox.querySelector('span').textContent = !m ? 'CodeAgent 未启动' : agent === 'starting' ? 'CodeAgent 预热中' : agent === 'error' ? 'CodeAgent 启动异常' : m.job && m.job.state !== 'error' ? 'CodeAgent 工作中' : 'CodeAgent 已就绪';
      root.querySelectorAll('[data-speed]').forEach(b => { const on = b.dataset.speed === (m?.speed || 'normal'); b.setAttribute('aria-checked', String(on)); b.disabled = !m; });
      if (document.activeElement !== el('interval')) el('interval').value = String(m ? (m.autoUnderstand === false ? 0 : (m.autoIntervalMin ?? 1)) : 3);
      el('interval').disabled = !m;
      root.querySelector('[data-act-local="open-agent"]').disabled = !m?.sessionId || !openSession;
      if (m?.error || m?.asrError) message(m.error || m.asrError);
      const events = (m?.events || []).filter(e => ['slide','transcript','mark'].includes(e.kind)).sort((a,b) => a.at-b.at || a.seq-b.seq);
      const slides = events.filter(e => e.kind === 'slide'), speech = events.filter(e => e.kind !== 'slide');
      el('frame-count').textContent = `${slides.length} 张`;
      el('transcript-count').textContent = speech.length ? `${speech.length} 条记录` : asr.ready ? '等待发言' : '本地转写未就绪';
      // 转写区默认收起，只留一行（2026-10-25 用户：基本没用到）；出现转写或重点后自动展开，用户手动开合后按用户的来。
      const section = root.querySelector('.meeting-transcripts');
      if (!section.dataset.userToggled) setTranscriptOpen(speech.length > 0);
      const stamp = `${id}:${events.length}:${events.at(-1)?.seq || 0}`;
      if (el('timeline').dataset.stamp !== stamp) {
        const list = el('timeline'), scroll = list.scrollLeft;
        list.dataset.stamp = stamp;
        list.innerHTML = slides.map(e => `<button class="meeting-frame" data-event="${e.seq}" aria-label="查看 ${time(e.at)} 的截图"><img data-thumb="${e.seq}" alt="会议截图"><span>${time(e.at)}${e.revisit ? ' · 再次展示' : ''}</span></button>`).join('') || '<p class="meeting-empty">翻页后自动留下清晰截图，也可以手动补截图。</p>';
        list.scrollLeft = scroll; thumbnails(); markActive();
        el('transcript').innerHTML = speech.map(e => `<button class="meeting-event ${e.kind==='mark'?'is-mark':''}" data-event="${e.seq}"><time>${time(e.at)}</time><b>${e.kind==='mark'?'★ 重点':e.track==='mic'?'麦克风':'系统声音'}</b><span>${esc(e.text)}</span></button>`).join('') || '<p class="meeting-empty">本地识别完成后，发言按时间显示；没有 CodeAgent 也能保留这些材料。</p>';
      }
      const summary = el('summary'), html = m?.summary ? markdown(m.summary) : EMPTY_SUMMARY;
      if (summary.dataset.html !== html) { summary.innerHTML = html; citations(summary); summary.dataset.html = html; }
      const answers = (m?.answers || []).map(q => `<details data-answer="${esc(q.id)}"><summary>${esc(q.q)} · ${{queued:'排队中',running:'回答中',done:'已回答',error:'失败，可重试'}[q.state] || esc(q.state)}</summary>${markdown(q.answer || '等待 CodeAgent 回答')}</details>`).join('') || '<p class="meeting-empty">围绕本场会议提问，回答会保留在这里。</p>';
      if (el('answers').dataset.html !== answers) { const opened = new Set([...el('answers').querySelectorAll('details[open]')].map(d=>d.dataset.answer)); el('answers').innerHTML=answers;el('answers').dataset.html=answers;el('answers').querySelectorAll('details').forEach(d=>{d.open=opened.has(d.dataset.answer);});citations(el('answers')); }
    } finally { refreshing = false; }
  }
  async function action(op) {
    if (op === 'live') { evidenceRequest++; view('live'); return; }
    if (op === 'new') { selectMeeting(''); el('title').value = ''; el('title').focus(); return; }
    if (op === 'sources') { const r = await call('meeting-sources'); sourceList = r.sources; root.querySelector('[data-m="source"]').innerHTML = sourceList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); preview(); return; }
    if (op === 'install') { await call('meeting-asr-install'); await refresh(); return; }
    if (op === 'start') {
      const selected = root.querySelector('[data-m="source"]').value; if (!selected) throw new Error('先刷新并选择共享窗口');
      const crop = {}; for (const k of ['x', 'y', 'w', 'h']) crop[k] = Number(root.querySelector(`[data-crop="${k}"]`).value) / 100;
      if (Object.values(crop).some(v => !Number.isFinite(v)) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('截图区域应在画面范围内');
      const audio = { system: root.querySelector('[data-m="system"]').checked, mic: root.querySelector('[data-m="mic"]').checked };
      const next = new MeetingCapture({ document, window, save: r => call('meeting-capture', { id, ...r }), status: message });
      await next.open(selected, audio);
      try { const r = await call('meeting-start', { title: root.querySelector('[data-m="title"]').value, sourceName: sourceList.find(s => s.id === selected)?.name, audio: Object.keys(audio).filter(k => audio[k]) }); id = r.meeting.id; resetPlayer(); capture = next; capture.start(crop); el('live').srcObject = capture.video.srcObject; await el('live').play(); view('live'); el('setup').open = false; message('已开始连续录屏。原始画面和声音本地留底，CodeAgent 默认只读取提炼图文；截图区域不裁掉原始录像。'); }
      catch (e) { next.running = false; try { await next.dispose(); } catch (_) {} if (capture === next) { capture = null; await call('meeting-control', { id, op: 'stop' }).catch(() => {}); } throw e; }
    } else if (op === 'retry-save') { await capture?.retry(); message('已重试保存，点击继续恢复采集。'); }
    else if (op === 'pause') { if (capture.paused) { await call('meeting-control', { id, op: state.meeting.state === 'paused' ? 'resume' : 'auto', value: state.meeting.autoUnderstand }); capture.resume(); } else { await capture.pause(); await call('meeting-control', { id, op: 'pause' }); } }
    else if (op === 'stop') { await capture.stop(); await call('meeting-control', { id, op: 'stop' }); el('live').srcObject = null; const latest = state.meeting?.events.filter(e => e.kind === 'slide').at(-1); if (latest) await showEvidence(latest.seq); else view('empty'); message('采集已结束，剩余转写和会后复核继续处理。'); }
    else if (op === 'snap') await capture.frame(true);
    else if (op === 'mark') { if (capture.paused) throw new Error('请先继续采集'); capture.enqueue({ kind: 'mark', at: capture.elapsed(), text: root.querySelector('[data-m="note"]').value || '重点' }); root.querySelector('[data-m="note"]').value = ''; await capture.frame(true); }
    else if (op === 'export') { if (!id) throw new Error('先选择会议'); await call('meeting-export', { id }); }
    else if (op === 'play' && playback && !el('player').paused) { el('player').pause(); return; }
    else if (op === 'play') { const first=state.meeting?.recording?.segments.find(s=>s.status==='ready'); await playAt(Number(root.querySelector('[data-m="seek-seconds"]').value)*1000 || first?.at || 0,true); }
    else if (op === 'extract') { const at=playback ? playback.segment.at+root.querySelector('[data-m="player"]').currentTime*1000 : Number(root.querySelector('[data-m="seek-seconds"]').value)*1000; const requested = id; const result=await call('meeting-frames',{id,timesMs:[Math.round(at)]}); if(requested!==id)return; view('evidence', '录像回查'); const frame=result.frames[0]; root.querySelector('[data-m="evidence"]').innerHTML=`<p>录像回查 · ${time(frame.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${frame.data}" alt="从录像提取的画面">`; }
    else if (op === 'ask') { const input = root.querySelector('[data-m="question"]'); if (!id) throw new Error('先选择会议'); await call('meeting-control', { id, op: 'ask', value: input.value }); input.value = ''; switchTab('answers'); }
    else { if (!id) throw new Error('先选择会议'); await call('meeting-control', { id, op }); }
    await refresh();
  }
  function preview() { const s = sourceList.find(s => s.id === root.querySelector('[data-m="source"]').value); root.querySelector('[data-m="preview"]').src = s?.thumbnail || ''; }
  async function open(parent) {
    if (!root) {
      root = document.createElement('section'); root.className = 'company-meeting'; root.dataset.phase = 'idle'; root.innerHTML = meetingTemplate();
      root.addEventListener('click', e => {
        const button = e.target.closest('[data-act]'); if (button && !button.disabled && !busy) { busy = true; el('history').disabled = true; button.disabled = true; void action(button.dataset.act).catch(e => message(e.message)).finally(() => { busy = false; button.disabled = false; void refresh().catch(e => message(e.message)); }); }
        const tabButton = e.target.closest('.meeting-tabs [data-tab]'); if (tabButton) switchTab(tabButton.dataset.tab);
        if (e.target.closest('[data-act-local="dismiss"]')) message('');
        if (e.target.closest('[data-act-local="toggle-transcript"]')) { const s = root.querySelector('.meeting-transcripts'); s.dataset.userToggled = '1'; setTranscriptOpen(s.dataset.collapsed === 'true'); }
        if (e.target.closest('[data-act-local="open-agent"]') && state?.meeting?.sessionId && openSession) void openSession(state.meeting.sessionId).catch(err => message(err.message));
        const speedButton = e.target.closest('[data-speed]'); if (speedButton && id && !speedButton.disabled) void call('meeting-control', { id, op: 'speed', value: speedButton.dataset.speed }).then(() => refresh()).catch(err => message(err.message));
        const quick = e.target.closest('[data-quick]'); if (quick) { el('question').value = quick.dataset.quick; el('question').focus(); const ask = root.querySelector('[data-act="ask"]'); if (!ask.disabled) ask.click(); }
        const event = e.target.closest('[data-event]'); if (event) void showEvidence(Number(event.dataset.event)).catch(e => message(e.message));
        const frame=e.target.closest('[data-play-at]');if(frame)void playAt(Number(frame.dataset.playAt),true).catch(e=>message(e.message));
      });
      root.querySelector('[data-m="source"]').addEventListener('change', preview);
      root.querySelector('[data-m="history"]').addEventListener('change', e => selectMeeting(e.target.value));
      el('interval').addEventListener('change', e => { if (id) void call('meeting-control', { id, op: 'interval', value: Number(e.target.value) }).then(() => refresh()).catch(err => message(err.message)); });
      el('note').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); root.querySelector('[data-act="mark"]').click(); } });
      el('question').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); root.querySelector('[data-act="ask"]').click(); } });
      const player = el('player'), playIcon = () => root.querySelector('.meeting-play').classList.toggle('is-playing', !player.paused);
      for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, playIcon);
      meterTimer = setInterval(() => { if (capture?.running && !root.hidden) meters(); }, 150);
      root.querySelector('[data-m="seek"]').addEventListener('change',e=>{root.querySelector('[data-m="seek-seconds"]').value=e.target.value;void playAt(Number(e.target.value)*1000,false).catch(e=>message(e.message));});
            player.addEventListener('timeupdate',()=>{if(!playback)return;const at=playback.segment.at+player.currentTime*1000;root.querySelector('[data-m="seek"]').value=String(at/1000);root.querySelector('[data-m="play-time"]').textContent=time(at);root.querySelector('[data-m="seek-seconds"]').value=(at/1000).toFixed(1);});
      player.addEventListener('ended',()=>{if(!playback)return;const next=state.meeting?.recording?.segments.find(s=>s.status==='ready'&&s.at>playback.segment.at);if(next){if(next.at>playback.segment.end+1000)message(`跳过未录制时段 ${time(playback.segment.end)}—${time(next.at)}`);void playAt(Math.max(next.at,playback.segment.end),true).catch(e=>message(e.message));}});
      poll = setInterval(() => { if (!root.hidden || capture?.running) void refresh().catch(e => message(e.message)); }, 2500);
    }
    if (!root.isConnected) parent.append(root); root.hidden = false; await refresh(); if (!sourceList.length) await action('sources');
  }
  async function showEvidence(seq) {
    const e = state.meeting?.events.find(e => e.seq === seq); if (!e) return;
    const request = ++evidenceRequest, meetingId = id;
    const target = el('evidence');
    activeSeq = seq; markActive();
    if (e.kind === 'slide') { const r = await call('meeting-asset', { id, seq }); if(request!==evidenceRequest || meetingId!==id)return; view('evidence', '精选画面 · ' + time(e.at)); target.innerHTML = `<p>事件 ${seq} · ${time(e.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${r.data}" alt="会议页面">`; }
    else if (e.audioSeq) { const r = await call('meeting-asset', { id, seq: e.audioSeq }), audio = state.meeting.events.find(x => x.seq === e.audioSeq); if(request!==evidenceRequest || meetingId!==id)return; view('evidence','原音回查 · ' + time(e.at)); target.innerHTML = `<p>${esc(e.text)}</p><audio controls src="data:audio/wav;base64,${r.data}"></audio>`; target.querySelector('audio').currentTime = Math.max(0, (e.at - audio.at) / 1000); }
    else { view('evidence', '会议重点 · ' + time(e.at)); target.innerHTML = `<p>${esc(e.text)}</p>`; }
    if(state.meeting?.recording?.segments.some(s=>s.status==='ready'&&s.at<=e.at&&s.end>e.at)){const b=document.createElement('button');b.className='ca-btn';b.dataset.playAt=String(e.at);b.textContent='回放此处';target.append(b);}
  }
  function setTranscriptOpen(open) {
    const section = root.querySelector('.meeting-transcripts');
    section.dataset.collapsed = String(!open); section.querySelector('[data-act-local="toggle-transcript"]').setAttribute('aria-expanded', String(open));
    root.querySelector('.meeting-evidence-pane').classList.toggle('transcripts-collapsed', !open);
  }
  function markActive() { root.querySelectorAll('[data-m="timeline"] [data-event], [data-m="transcript"] [data-event]').forEach(b => b.classList.toggle('is-active', Number(b.dataset.event) === activeSeq)); }
  function selectMeeting(value) {
    id = value || null; activeSeq = null; evidenceRequest++; resetPlayer(); view('empty'); message('');
    el('history').value = value || ''; el('timeline').dataset.stamp = ''; el('evidence').innerHTML = '';
    void refresh().catch(e => message(e.message));
  }
  function resetPlayer(){playRequest++;playback=null;const p=root.querySelector('[data-m="player"]');p.pause();p.removeAttribute('src');p.load();root.querySelector('[data-m="seek-seconds"]').value='0';root.querySelector('[data-m="seek"]').value='0';}
  async function playAt(at,autoplay){
    if(!id)throw new Error('先选择会议');const request=++playRequest,meetingId=id;
    const r=await call('meeting-playback',{id,at:Math.round(at)});if(request!==playRequest||meetingId!==id)return;
    const video=root.querySelector('[data-m="player"]');video.pause(); evidenceRequest++; view('replay');
    if(playback?.segment.key!==r.segment.key){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('回放加载超时')),15000);const ok=()=>done();const bad=()=>done(new Error('录像无法播放'));function done(e){clearTimeout(timer);video.removeEventListener('loadeddata',ok);video.removeEventListener('error',bad);e?reject(e):resolve();}video.addEventListener('loadeddata',ok,{once:true});video.addEventListener('error',bad,{once:true});video.src=r.url;video.load();});}
    if(request!==playRequest||meetingId!==id)return;playback=r;video.currentTime=r.offsetMs/1000;root.querySelector('[data-m="play-time"]').textContent=time(at);if(autoplay)await video.play();
  }
  window.addEventListener('beforeunload', e => { if (capture?.running || capture?.queue.length) { e.preventDefault(); e.returnValue = false; } });
  return { open, close: () => { if (root) { root.hidden = true; el('player').pause(); el('evidence').querySelector('audio')?.pause(); } }, dispose: () => { clearInterval(poll); clearInterval(meterTimer); thumbsObserver?.disconnect(); void capture?.dispose(); } };
}
module.exports = { createCompanyMeetingPage };
