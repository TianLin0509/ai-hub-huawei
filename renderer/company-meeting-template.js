'use strict';

// C layout: grounded topic navigation, one evidence stream, and persistent minutes.
const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  export: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const QUICK_QUESTIONS = ['目前确定了哪些结论？', '还有哪些问题待确认？', '行动项和负责人是谁？'];

function meetingTemplate() {
  return `<header class="meeting-topbar">
    <div class="meeting-record-state"><i data-m="record-dot"></i><strong data-m="record-label">尚未开始</strong><span data-m="clock">00:00</span></div>
    <div class="meeting-levels" data-m="levels"></div>
    <div class="meeting-session-name"><h3 data-m="session-title">会议伴侣</h3><button type="button" class="meeting-rename-btn" data-act-local="rename-title" data-m="rename-title" title="改会议名称" aria-label="改会议名称" hidden>✎</button><span data-m="source-label">截图、原话和问答，按时间留下来</span></div>
    <div class="meeting-actions">
      <button class="ca-btn meeting-when-live" data-act="pause" disabled>${icon(ICONS.pause)}<span>暂停</span></button>
      <button class="ca-btn meeting-stop meeting-when-live" data-act="stop" disabled>${icon(ICONS.stop)}<span>结束会议</span></button>
      <button class="ca-btn meeting-when-review" data-act="open-full" disabled>${icon(ICONS.play)}<span>完整录像</span></button>
      <button class="ca-btn meeting-when-review" data-act="new">${icon(ICONS.plus)}<span>新会议</span></button>
      <details class="meeting-more" data-m="more"><summary class="ca-btn" aria-label="更多会议操作" title="更多会议操作">${icon(ICONS.more)}<span>更多</span></summary><div class="meeting-more-panel">
        <label class="meeting-menu-field">历史会议<select data-m="history" aria-label="历史会议"></select></label>
        <label class="meeting-menu-field">自动更新理解<select data-m="interval" aria-label="自动更新间隔">${[[0,'关闭'],[1,'每 1 分钟'],[3,'每 3 分钟'],[5,'每 5 分钟'],[10,'每 10 分钟']].map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="meeting-menu-field">快速档模型<select data-m="fast-model" aria-label="快速档模型"></select></label>
        <details class="meeting-advanced"><summary>截图区域</summary><div class="meeting-region-row"><img data-m="preview" alt="所选窗口预览"><p>精选截图使用指定区域，原始录像保留完整共享窗口。</p><div class="meeting-crop">${[['x','左',0],['y','上',0],['w','宽',100],['h','高',100]].map(([k,l,v]) => `<label>${l}<input type="number" min="0" max="100" value="${v}" data-crop="${k}" aria-label="截图区域${l}">%</label>`).join('')}</div></div></details>
        <details class="meeting-advanced"><summary>本地转写</summary><p class="meeting-asr" data-m="asr"></p><div class="meeting-tools"><button class="ca-btn" data-act="install">安装 / 修复本地转写</button><button class="ca-btn" data-act="retry-asr">重试失败转写</button></div></details>
        <div class="meeting-menu-actions"><button class="ca-btn" data-act="sources">刷新共享窗口列表</button><button class="ca-btn" data-act-local="toggle-transcript" aria-pressed="false">隐藏时间流中的原话</button><button class="ca-btn" data-act-local="open-agent" disabled>打开理解会话</button><button class="ca-btn" data-act-local="open-question-agent" hidden disabled>打开问答会话</button></div>
        <details class="meeting-advanced"><summary>快捷提问</summary><div class="meeting-quick">${QUICK_QUESTIONS.map(q => `<button type="button" data-quick="${q}">${q}</button>`).join('')}</div></details>
      </div></details>
    </div>
  </header>
  <div class="meeting-notice"><p class="meeting-message" role="status" data-m="message"></p><button class="ca-btn" data-act="retry-save" hidden>重试保存</button><button class="meeting-notice-close" data-act-local="dismiss" aria-label="关闭提示">${icon(ICONS.close,14)}</button></div>
  <div class="meeting-columns">
    <nav class="meeting-topic-pane" aria-label="会议议题与时间定位"><h3 data-m="topics-label">议题</h3><p class="meeting-topic-hint" data-m="topics-hint">有出处的议题会显示在这里</p><div data-m="topics"></div></nav>
    <main class="meeting-evidence-pane">
      <section class="meeting-setup-card" data-m="setup"><div class="meeting-setup-main"><h3>准备开始一场会议</h3><p>选好共享窗口和声音来源。录像和声音只留在本机，CodeAgent 只读取提炼后的图文。</p><div class="meeting-setup">
        <label class="meeting-field"><span>会议名称</span><input data-m="title" aria-label="会议名称" placeholder="可选，例如：无线算法周例会"></label>
        <div class="meeting-field"><span>采集声音</span><span class="meeting-inline"><label class="meeting-chip"><input type="checkbox" data-m="system" checked>${icon(ICONS.speaker,15)}系统声音</label><label class="meeting-chip"><input type="checkbox" data-m="mic" checked>${icon(ICONS.mic,15)}麦克风</label></span></div>
      </div><div class="meeting-asr meeting-inline" role="status"><span data-m="setup-asr">正在检查本地转写…</span><button class="ca-btn" data-act="install" data-m="setup-asr-install" hidden>现在安装</button></div>
      <div class="meeting-asr" data-m="record-only-confirm" role="group" aria-label="缺少本地转写，确认继续" hidden><p>先只录音，装好转写后再出纪要。共享窗口也会保存在本机。</p><div class="meeting-inline"><button class="ca-btn primary" data-act="start-without-asr">先只录音</button><button class="ca-btn" data-act="cancel-record-only">取消</button></div></div>
      <div class="meeting-setup-go"><button class="ca-btn primary meeting-start" data-act="start"><i></i><span>开始会议</span></button><small>开始后可随时暂停</small></div></div>
      <div class="meeting-setup-sources"><div class="meeting-setup-sources-head"><h3>共享哪个窗口</h3><button class="ca-btn" data-act="sources">刷新</button></div><select data-m="source" aria-label="共享窗口"></select><div class="meeting-source-grid" data-m="source-grid" role="radiogroup" aria-label="选择共享窗口"></div></div></section>
      <section class="meeting-viewer">
        <div class="meeting-stage" data-view="empty"><video data-m="live" muted playsinline aria-label="正在采集的共享画面"></video><video data-m="player" preload="metadata" aria-label="会议录像回放"></video><div data-m="evidence"></div><div class="meeting-stage-empty">选择时间流中的一处，回看对应画面</div></div>
        <div class="meeting-viewer-controls"><div class="meeting-section-heading"><h3 data-m="viewer-label">共享画面</h3><button class="ca-btn" data-act="live" hidden>返回实时</button><button class="ca-btn meeting-viewer-size" data-act-local="expand-viewer" aria-pressed="false">放大</button></div>
          <p class="meeting-viewer-hint">点时间流里的截图，可在这里回看当时画面</p>
          <div class="meeting-mark-bar"><button class="ca-btn" data-act="snap" disabled>${icon(ICONS.camera,14)}<span>截图</span></button><input data-m="note" placeholder="记下重点，回车保存" aria-label="重点备注"><button class="ca-btn" data-act="mark" disabled>${icon(ICONS.star,14)}<span>记重点</span></button></div>
          <div class="meeting-replay"><div class="meeting-replay-row"><button class="meeting-play" data-act="play" disabled aria-label="回放">${icon(ICONS.play,14)}</button><span class="meeting-play-time"><span data-m="play-time">00:00</span> / <span data-m="duration">00:00</span></span><button class="ca-btn" data-act="extract" disabled>${icon(ICONS.camera,14)}<span>截取此帧</span></button></div><input data-m="seek" type="range" min="0" max="0" value="0" step="0.1" aria-label="会议时间轴"><input data-m="seek-seconds" type="number" min="0" value="0" step="1" hidden aria-label="跳转到会议秒数"><p class="meeting-gaps" data-m="gaps"></p></div>
        </div>
      </section>
      <div class="meeting-flow-heading"><h3>时间流</h3><span data-m="flow-count">截图、原话与问答</span><button class="ca-link" data-act-local="latest" hidden>回到最新</button></div>
      <div class="meeting-flow" data-m="timeline" aria-label="截图、原话、重点与问答时间流"></div>
    </main>
    <aside class="meeting-understanding"><div class="meeting-review-hero" data-m="review-hero"></div><div class="meeting-summary-heading"><h3>纪要</h3><span class="meeting-speed" role="radiogroup" aria-label="理解速度">${[['fast','快速'],['normal','中等'],['deep','深入']].map(([v,l])=>`<button type="button" role="radio" data-speed="${v}">${l}</button>`).join('')}</span><button class="ca-btn" data-act="understand" disabled title="更新理解">${icon(ICONS.spark,14)}<span>更新</span></button><button class="ca-btn" data-act="export" title="导出纪要" aria-label="导出纪要">${icon(ICONS.export,14)}<span hidden>导出纪要</span></button></div>
      <div class="meeting-understanding-status" role="status" data-m="understanding-status">开始采集后，再逐步整理讨论内容</div>
      <div class="meeting-summary-scroll"><article data-m="summary"></article></div>
      <div class="meeting-chat"><div class="meeting-question-pending" data-m="question-pending" role="status" hidden></div><div class="meeting-ask-box"><textarea id="meeting-question" data-m="question" rows="2" placeholder="问一下这场会议，不打断纪要" aria-label="会议问题"></textarea><button class="meeting-send" data-act="ask" disabled title="问 CodeAgent（Ctrl+Enter）" aria-label="问 CodeAgent">${icon(ICONS.send,16)}</button></div></div>
    </aside>
  </div>
  <footer class="meeting-footer"><span class="meeting-footer-state"><i data-m="footer-dot"></i><span data-m="progress">尚未开始采集</span></span><span class="meeting-agent-state" data-m="agent-state"><i></i><span>CodeAgent 未启动</span></span><span data-m="recording-status">材料仅保存到本机</span></footer>`;
}
module.exports = { meetingTemplate };
