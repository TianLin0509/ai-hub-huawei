'use strict';

// A layout: source evidence on the left, grounded understanding on the right.
const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  export: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
};
const QUICK_QUESTIONS = ['目前确定了哪些结论？', '还有哪些问题待确认？', '行动项和负责人是谁？'];

function meetingTemplate() {
  return `<header class="meeting-topbar">
    <div class="meeting-session-name"><span class="meeting-eyebrow">会议伴侣</span><h3 data-m="session-title">准备开始一场会议</h3><span data-m="source-label">选择共享窗口，让会议内容有据可查</span></div>
    <div class="meeting-record-state"><i data-m="record-dot"></i><strong data-m="record-label">尚未开始</strong><span data-m="clock">00:00</span></div>
    <div class="meeting-levels" data-m="levels"></div>
    <div class="meeting-actions">
      <button class="ca-btn meeting-when-live" data-act="pause" disabled>${icon(ICONS.pause)}<span>暂停</span></button>
      <button class="ca-btn meeting-stop meeting-when-live" data-act="stop" disabled>${icon(ICONS.stop)}<span>结束会议</span></button>
      <button class="ca-btn meeting-when-review" data-act="export">${icon(ICONS.export)}<span>导出纪要</span></button>
      <button class="ca-btn meeting-when-review" data-act="new">${icon(ICONS.plus)}<span>新会议</span></button>
      <select data-m="history" aria-label="历史会议"></select>
    </div>
  </header>
  <section class="meeting-setup-card" data-m="setup">
    <div class="meeting-setup">
      <label class="meeting-field meeting-field-source"><span>共享窗口</span><span class="meeting-inline"><select data-m="source" aria-label="共享窗口"></select><button class="ca-btn meeting-icon-btn" data-act="sources" title="刷新窗口列表" aria-label="刷新窗口">${icon(ICONS.refresh)}</button></span></label>
      <div class="meeting-field"><span>采集声音</span><span class="meeting-inline"><label class="meeting-chip"><input type="checkbox" data-m="system" checked>${icon(ICONS.speaker, 15)}系统声音</label><label class="meeting-chip"><input type="checkbox" data-m="mic" checked>${icon(ICONS.mic, 15)}麦克风</label></span></div>
      <label class="meeting-field meeting-field-title"><span>会议名称</span><input data-m="title" aria-label="会议名称" placeholder="可选，例如：无线算法周例会"></label>
      <button class="ca-btn primary meeting-start" data-act="start"><i></i><span>开始会议</span></button>
    </div>
    <details class="meeting-advanced"><summary>截图区域与本地转写</summary><div class="meeting-region-row"><img data-m="preview" alt="所选窗口预览"><div><p>精选截图只保留指定区域；原始录像仍保留完整共享窗口。</p><div class="meeting-crop">${[['x','左',0],['y','上',0],['w','宽',100],['h','高',100]].map(([k,label,v])=>`<label>${label}<input type="number" min="0" max="100" value="${v}" data-crop="${k}" aria-label="截图区域${label}">%</label>`).join('')}</div><p class="meeting-asr" data-m="asr"></p><div class="meeting-tools"><button class="ca-btn" data-act="install">安装 / 修复本地转写</button><button class="ca-btn" data-act="retry-asr">重试失败转写</button></div></div></div></details>
  </section>
  <div class="meeting-notice"><p class="meeting-message" role="status" data-m="message"></p><button class="ca-btn" data-act="retry-save" hidden>重试保存</button><button class="meeting-notice-close" data-act-local="dismiss" title="关闭提示" aria-label="关闭提示">${icon(ICONS.close, 14)}</button></div>
  <div class="meeting-columns"><main class="meeting-evidence-pane">
    <section class="meeting-viewer"><div class="meeting-section-heading"><h3 data-m="viewer-label">共享画面</h3><div class="meeting-tools"><button class="ca-btn" data-act="live" hidden>返回实时</button><button class="ca-btn meeting-when-live" data-act="snap" disabled>${icon(ICONS.camera)}<span>截图</span></button></div></div>
      <div class="meeting-stage" data-view="empty"><video data-m="live" muted playsinline aria-label="正在采集的共享画面"></video><video data-m="player" preload="metadata" aria-label="会议录像回放"></video><div data-m="evidence"></div><div class="meeting-stage-empty"><svg viewBox="0 0 64 48" aria-hidden="true"><rect x="3" y="3" width="58" height="36" rx="4"/><path d="M22 45h20M32 39v6M27 14l13 8-13 8z"/></svg><strong>把共享内容和讨论一起留下来</strong><span>在上方选好窗口和声音，点「开始会议」，画面会显示在这里</span><small>自动精选截图 · 本地录像回看 · 原话与结论互相定位</small></div></div>
      <div class="meeting-replay"><div class="meeting-replay-row"><button class="meeting-play" data-act="play" disabled title="从当前位置回放" aria-label="回放">${icon(ICONS.play, 14)}</button><span class="meeting-play-time"><span data-m="play-time">00:00</span> / <span data-m="duration">00:00</span></span><input data-m="seek" type="range" min="0" max="0" value="0" step="0.1" aria-label="会议时间轴"><input data-m="seek-seconds" type="number" min="0" value="0" step="1" hidden aria-label="跳转到会议秒数"><button class="ca-btn" data-act="extract" disabled title="把录像当前位置存为一张画面">${icon(ICONS.crop)}<span>截取此帧</span></button></div><p class="meeting-replay-note meeting-gaps" data-m="gaps"></p></div>
    </section>
    <section class="meeting-frames"><div class="meeting-section-heading"><h3>精选画面 <small data-m="frame-count">0 张</small></h3><span>点击画面查看出处</span></div><div class="meeting-filmstrip" data-m="timeline"><p class="meeting-empty">翻页后自动留下清晰截图，也可以手动截图。</p></div></section>
    <section class="meeting-transcripts" data-collapsed="true"><div class="meeting-section-heading"><button type="button" class="meeting-collapse" data-act-local="toggle-transcript" aria-expanded="false">${icon(ICONS.chevron, 14)}<h3>实时转写与重点 <small data-m="transcript-count">等待采集</small></h3></button><div class="meeting-mark-bar"><input data-m="note" placeholder="记下重点或疑问，回车保存" aria-label="重点备注"><button class="ca-btn" data-act="mark" disabled>${icon(ICONS.star)}<span>记重点</span></button></div></div><div class="meeting-transcript-list" data-m="transcript"><p class="meeting-empty">本地识别完成后，发言会按时间显示；尚未安装转写组件也能先录音。</p></div></section>
  </main>
  <aside class="meeting-understanding"><div class="meeting-tabs" role="tablist" aria-label="会议理解"><button role="tab" data-tab="summary" aria-selected="true">实时理解</button><button role="tab" data-tab="answers" aria-selected="false">会议问答</button><button class="ca-btn meeting-open-agent" data-act-local="open-agent" disabled title="打开这场会议专属的 CodeAgent 会话">${icon(ICONS.terminal, 14)}<span>会话</span></button><button class="ca-btn" data-act="understand" disabled>${icon(ICONS.spark, 14)}<span>更新理解</span></button></div>
    <div class="meeting-agent-bar"><span class="meeting-agent-state" data-m="agent-state"><i></i><span>CodeAgent 未启动</span></span>
      <span class="meeting-speed" role="radiogroup" aria-label="理解速度">${[['fast', '快速', '只看新增文字和最新 2 张截图，要点式更新'], ['normal', '中等', '新增文字和最新 5 张截图，完整但精炼'], ['deep', '深入', '逐项核对，必要时回查录像']].map(([v, l, t]) => `<button type="button" role="radio" data-speed="${v}" title="${t}">${l}</button>`).join('')}</span>
      <label class="meeting-interval" title="采集中按这个间隔自动更新理解；随时可以手动点「更新理解」"><span>自动</span><select data-m="interval" aria-label="自动更新间隔">${[[0, '关闭'], [1, '每 1 分钟'], [3, '每 3 分钟'], [5, '每 5 分钟'], [10, '每 10 分钟']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
    <div class="meeting-understanding-status" data-m="understanding-status">开始采集后，再逐步整理讨论内容</div>
    <div class="meeting-summary-scroll" data-panel="summary"><article data-m="summary"></article></div><div class="meeting-summary-scroll" data-panel="answers" hidden><div data-m="answers"><p class="meeting-empty">围绕本场会议提问，回答会保留在这里。</p></div></div>
    <div class="meeting-chat"><div class="meeting-ask-box"><textarea id="meeting-question" data-m="question" rows="2" placeholder="基于本场会议内容提问，Ctrl+Enter 发送" aria-label="会议问题"></textarea><button class="meeting-send" data-act="ask" disabled title="问 CodeAgent（Ctrl+Enter）" aria-label="问 CodeAgent">${icon(ICONS.send, 16)}</button></div><div class="meeting-quick">${QUICK_QUESTIONS.map(q => `<button type="button" data-quick="${q}">${q}</button>`).join('')}</div></div>
  </aside></div>
  <footer class="meeting-footer"><span class="meeting-footer-state"><i data-m="footer-dot"></i><span data-m="progress">尚未开始采集</span></span><span data-m="recording-status">材料仅保存到本机</span></footer>`;
}
module.exports = { meetingTemplate };
