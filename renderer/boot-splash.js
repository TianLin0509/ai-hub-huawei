'use strict';
// 开场动画（2026-11-22）：启动时在界面最上层盖一块 Canvas 播 2.5–3 秒，Hub 在下面照常加载；点画面或 Esc 跳过。
// 右下角提示「点这里更换开场动画」，点开是选择面板：群星 / Claude / Codex / DeepSeek 各一页，内置的直接用，其余一键下载并使用。
// 三种动画在后台 Worker 绘制，视频用浏览器媒体管线；标题栏始终露出，加载中也可跳过，结束即释放资源。
(function bootSplash() {
  const { ipcRenderer } = require('electron');
  let distribution = {};
  try { distribution = require('../core/distribution'); } catch (_) {}
  let version = '';
  try { version = require('../package.json').version; } catch (_) {}
  const PRODUCT = distribution.productName || 'AI Hub';
  const TONE = { claude: ['rgba(255,150,70,.9)', '#ffb27a'], codex: ['rgba(90,220,240,.9)', '#8be9f5'], deepseek: ['rgba(110,150,255,.9)', '#9db4ff'], hub: ['rgba(200,210,255,.9)', '#cfd8ff'] };

  /* ---------------- 播放层 ---------------- */
  const { canvasSize } = require('./boot-splash-draw');
  let layer = null;
  // 加载开始就建立可取消的播放会话；异步解码、Worker、视频和所有定时器都归它清理。
  function createLayer(opts, video = false) {
    const el = document.createElement('div');
    el.id = 'boot-splash-layer'; el.className = 'boot-splash-layer' + (video ? ' is-video' : '');
    el.dataset.phase = 'loading';
    el.innerHTML = `${video ? '<video playsinline preload="metadata"></video><div class="boot-splash-sub" aria-live="off"></div>' : '<canvas></canvas>'}<button type="button" class="boot-splash-skip">跳过 ›</button>${opts.hint ? '<button type="button" class="boot-splash-hint">✨ 点这里更换开场动画</button>' : ''}`;
    document.body.appendChild(el);
    let dead = false, deadline = null;
    const cleanup = new Set();
    const session = {
      el, active: () => !dead,
      clean(fn) { if (dead) fn(); else cleanup.add(fn); },
      deadline(ms, action = () => session.finish()) { clearTimeout(deadline); deadline = setTimeout(action, ms); },
      finish(notify = true) {
        if (dead) return; dead = true; clearTimeout(deadline);
        for (const fn of cleanup) { try { fn(); } catch (_) {} } cleanup.clear();
        el.remove(); if (layer === session) layer = null;
        if (notify && opts.firstHint) afterHint();
        if (notify && typeof opts.onDone === 'function') opts.onDone();
      },
    };
    const onKey = e => { if (['Escape', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); session.finish(); } };
    document.addEventListener('keydown', onKey, true);
    session.clean(() => document.removeEventListener('keydown', onKey, true));
    el.addEventListener('click', e => {
      const picker = e.target.closest('.boot-splash-hint'); session.finish();
      if (picker) { void markHintSeen(); void openPicker(); }
    });
    session.deadline(10000); layer = session; return session;
  }
  function loadImage(src, session) {
    return new Promise((resolve, reject) => {
      const im = new Image(); im.decoding = 'async';
      session.clean(() => { im.onload = im.onerror = null; im.removeAttribute('src'); reject(new Error('播放已取消')); });
      im.onload = async () => {
        try { if (im.decode) await im.decode(); if (session.active()) resolve(im); }
        catch (error) { reject(error); }
      };
      im.onerror = () => reject(new Error('开场图片读取失败'));
      im.src = src;
    });
  }
  async function play(spec, opts = {}) {
    // 替换播放时不让上一轮预览的回调重新弹出模态框。
    if (layer) layer.finish(false);
    if (spec.anim === 'video') return playVideo(spec, opts);
    const session = createLayer(opts), el = session.el;
    try {
      const im = await loadImage(spec.src, session);
      if (!session.active()) return;
      const cv = el.querySelector('canvas');
      const size = () => { const r = el.getBoundingClientRect(); return canvasSize(r.width, r.height, window.devicePixelRatio); };
      const poster = error => {
        if (!session.active() || el.dataset.renderer === 'poster') return;
        console.warn('[boot-splash] 后台绘制不可用，显示静态开场', error?.message || error);
        cv.remove(); im.className = 'boot-splash-poster'; el.prepend(im);
        // 绘制可能在淡出中失败，静态图重新显示时恢复可见度。
        el.style.opacity = '1';
        el.dataset.renderer = 'poster'; el.dataset.phase = 'playing'; session.deadline(3000);
      };
      if (!cv.transferControlToOffscreen || typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') { poster('绘制线程不可用'); return; }
      // decode/createImageBitmap 都异步完成；不在首帧 drawImage 时隐式解码大图。
      const ratio = Math.min(1, Math.sqrt(4000000 / (im.naturalWidth * im.naturalHeight)));
      const bitmap = await createImageBitmap(im, { resizeWidth: Math.max(1, Math.floor(im.naturalWidth * ratio)), resizeHeight: Math.max(1, Math.floor(im.naturalHeight * ratio)), resizeQuality: 'high' });
      if (!session.active()) { bitmap.close(); return; }
      let worker;
      try {
        worker = new Worker(new URL('boot-splash-worker.js', document.baseURI));
        session.clean(() => worker.terminate());
        worker.onmessage = ({ data: msg }) => {
          if (!session.active()) return;
          if (msg.type === 'ready') { el.dataset.renderer = 'worker'; el.dataset.phase = 'playing'; session.deadline(Math.max(500, (msg.duration - (opts.startAt || 0)) * 1000 + 1000)); }
          else if (msg.type === 'opacity') el.style.opacity = String(msg.opacity);
          else if (msg.type === 'done') session.finish();
          else if (msg.type === 'error') { worker.terminate(); poster(msg.message); }
        };
        worker.onerror = error => { error.preventDefault(); worker.terminate(); poster(error); };
        const offscreen = cv.transferControlToOffscreen();
        worker.postMessage({ type: 'start', canvas: offscreen, image: bitmap, size: size(), spec: { anim: spec.anim, weather: spec.weather, tone: TONE[spec.who] || TONE.hub, product: PRODUCT, version, startAt: opts.startAt } }, [offscreen, bitmap]);
        const resize = () => { if (session.active() && el.dataset.renderer !== 'poster') worker.postMessage({ type: 'resize', size: size() }); };
        window.addEventListener('resize', resize); session.clean(() => window.removeEventListener('resize', resize));
      } catch (error) { bitmap.close(); worker?.terminate(); poster(error); }
    } catch (error) { if (session.active()) { console.warn('[boot-splash]', error.message); session.finish(); } }
  }

  // 视频交给浏览器媒体管线；本地视频保留安装版需要的 Blob 兼容路径，不做逐帧拷贝。
  function playVideo(spec, opts) {
    const session = createLayer(opts, true), el = session.el;
    const video = el.querySelector('video'), sub = el.querySelector('.boot-splash-sub');
    const glow = (TONE[spec.who] || TONE.hub)[1];
    const logo = '<svg viewBox="0 0 64 56" aria-hidden="true"><rect x="4" y="2" width="56" height="40" rx="12" fill="#fff"/><rect x="12" y="38" width="10" height="14" rx="3" fill="#fff"/><rect x="27" y="38" width="10" height="14" rx="3" fill="#fff"/><rect x="42" y="38" width="10" height="14" rx="3" fill="#fff"/><path d="M17 15l7 7-7 7M47 15l-7 7 7 7" fill="none" stroke="#1d1f26" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.insertAdjacentHTML('beforeend', `<div class="boot-splash-brand" style="--glow:${glow}">${logo}<div><b>${PRODUCT}</b><small>多 AI 协作工作台${version ? ' · v' + version : ''}</small></div></div>`);
    const clip = spec.clip || { start: 0, fadeAt: Infinity, end: Infinity, subs: [] };
    const resize = () => { sub.style.fontSize = Math.max(18, Math.min(el.clientWidth * 0.6 / 17, el.clientHeight * 0.09)) + 'px'; };
    resize(); window.addEventListener('resize', resize); session.clean(() => window.removeEventListener('resize', resize));
    let fading = false, fadeTimer = null, shown = -1;
    const fadeOut = ms => {
      if (fading || !session.active()) return; fading = true;
      const t0 = Date.now(), v0 = video.volume;
      fadeTimer = setInterval(() => {
        const k = Math.min(1, (Date.now() - t0) / ms); el.style.opacity = String(1 - k); video.volume = v0 * (1 - k);
        if (k >= 1) session.finish();
      }, 40);
    };
    const tick = setInterval(() => {
      if (!session.active()) return;
      const t = video.currentTime;
      if (!fading) video.volume = t < clip.start + 0.3 ? Math.max(0, Math.min(1, (t - clip.start) / 0.3)) : 1;
      const i = (clip.subs || []).findIndex(([, a, b]) => t >= a && t <= b);
      if (i < 0) sub.style.opacity = '0';
      else { const [text, a, b] = clip.subs[i]; if (i !== shown) { shown = i; sub.textContent = text; } sub.style.opacity = String(Math.max(0, Math.min(1, (t - a) / 0.5, (b - t) / 0.5))); }
      if (t >= clip.start + 0.25) el.classList.add('brand-on');
      if (t >= clip.fadeAt) fadeOut(Math.max(200, (clip.end - clip.fadeAt) * 1000));
    }, 80);
    session.clean(() => { clearInterval(tick); clearInterval(fadeTimer); video.pause(); video.removeAttribute('src'); video.load(); });
    video.addEventListener('playing', () => { if (session.active()) { el.dataset.phase = 'playing'; session.deadline(10000); } });
    // 2026-11-23：只有声音、画面解不出来（公司电脑关 GPU 时 HEVC 视频就是这样）不会触发 error，屏幕黑着只剩字幕。
    // 开播 1 秒还没有画面就当放不出来处理，并自动去下兼容版（2.0.1 起原作两套改成 H.264）。
    video.addEventListener('playing', () => setTimeout(() => {
      if (!session.active()) return;
      const frames = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : 1;
      if (video.videoWidth === 0 || frames === 0) fallback('no-picture');
    }, 1000), { once: true });
    video.addEventListener('timeupdate', () => {
      if (!session.active()) return;
      session.deadline(10000);
      if (video.duration && video.duration - video.currentTime < 0.6) fadeOut(500);
    });
    video.addEventListener('ended', () => fadeOut(200));
    const fallback = reason => {
      if (!session.active()) return;
      console.warn('[boot-splash] 开场视频放不出来，改播群星', reason === 'no-picture' ? reason : video.error?.code);
      session.finish(false); fallbackNotice(spec);
      void play({ id: 'galaxy-constellation', who: 'hub', anim: 'galaxy', weather: 'stars', src: 'assets/boot-splash/galaxy-constellation.webp' }, opts);
    };
    video.addEventListener('error', fallback);
    video.volume = clip.start > 0 ? 0 : 1;
    // 安装版从 app.asar 页面读取数据目录视频时可能报格式错误，保留主干的 Blob 播放兼容。
    // 文件读取和 Blob 释放都归当前会话；取消或重播不会影响下一轮视频。
    const controller = new AbortController(); session.clean(() => controller.abort());
    if (clip.start > 0) video.addEventListener('loadedmetadata', () => {
      if (session.active() && video.currentTime < clip.start) video.currentTime = clip.start;
    }, { once: true });
    void videoSource(spec.src, controller.signal).then(source => {
      session.clean(source.release);
      if (!session.active()) return;
      video.src = source.src;
      video.play().catch(() => { if (session.active()) { video.muted = true; video.play().catch(fallback); } });
    }, fallback);
  }
  async function videoSource(src, signal) {
    if (!/^file:/i.test(src)) return { src, release() {} };
    const u = new URL(src); u.search = ''; u.hash = '';
    const buf = await require('fs').promises.readFile(require('url').fileURLToPath(u), { signal });
    const blob = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
    return { src: blob, release: () => URL.revokeObjectURL(blob) };
  }
  // 保留主干的视频失败提示，自动退回群星时说明原因。
  // 下载过的视频有兼容新版时（目录版本更高），提示里给一个「下载兼容版」按钮：大文件只在用户点了以后才下（2026-11-23 定）。
  function fallbackNotice(spec) {
    if (document.getElementById('boot-splash-fallback')) return;
    const tip = document.createElement('div');
    tip.id = 'boot-splash-fallback'; tip.className = 'boot-splash-toast'; tip.setAttribute('role', 'status');
    const say = (title, text, ms, button) => {
      tip.innerHTML = `<b>${title}</b><span>${text}</span>${button ? `<button type="button" class="appearance-btn primary" data-bsp-repair>${button}</button>` : ''}`;
      clearTimeout(tip._t); tip._t = setTimeout(() => tip.remove(), ms);
    };
    say('这段开场视频在本机放不出画面', '这台电脑解码不了它的视频格式，已临时改播群星。', 9000);
    document.body.appendChild(tip);
    if (!spec || spec.bundled || !spec.id) return;
    void (async () => {
      try {
        const snap = await ipcRenderer.invoke('boot-splash:check');
        const it = snap.items.find(i => i.id === spec.id);
        if (!it || !it.update) { say('这段开场视频在本机放不出画面', '这台电脑解码不了它的视频格式，已临时改播群星；可以在开场动画里换一套。', 9000); return; }
        say('有本机能放的兼容版', `「${esc(it.name)}」已出兼容新版（${kb(it.bytes)}），点下面按钮下载；不点就继续播群星。`, 30000, `下载兼容版 ${kb(it.bytes)}`);
        tip.addEventListener('click', async e => {
          if (!e.target.closest('[data-bsp-repair]')) return;
          say('正在下载兼容版', `「${esc(it.name)}」正在后台下载，可以继续用 Hub…`, 180000);
          const after = await ipcRenderer.invoke('boot-splash:download', spec.id).catch(() => null);
          const done = after && after.items.find(i => i.id === spec.id);
          if (done && done.installed && !done.update) say('兼容版已下好', `「${esc(done.name)}」下次启动就能正常播放，也可以在开场动画里点「预览」马上看。`, 12000);
          else say('兼容版没下成', '稍后在开场动画里点这一套的「更新」重试；现在先播群星。', 12000);
        });
      } catch (_) { say('这段开场视频在本机放不出画面', '已临时改播群星；可以在开场动画里换一套。', 9000); }
    })();
  }
  function stop() { layer?.finish(); }
  async function markHintSeen() { try { await ipcRenderer.invoke('boot-splash:save', { hintSeen: true }); } catch (_) {} }
  // 第一次看到开场动画：播完在右下角多留一会儿「可以更换」的提示，点了直接打开面板。
  function afterHint() {
    if (document.getElementById('boot-splash-toast')) return;
    const tip = document.createElement('button');
    tip.type = 'button'; tip.id = 'boot-splash-toast'; tip.className = 'boot-splash-toast';
    tip.innerHTML = '<b>开场动画可以换</b><span>Claude、Codex、DeepSeek 等 60 多套可选，点这里挑一套 ›</span>';
    tip.addEventListener('click', () => { tip.remove(); void openPicker(); });
    document.body.appendChild(tip);
    void markHintSeen();
    setTimeout(() => tip.remove(), 12000);
  }

  /* ---------------- 选择面板 ---------------- */
  // 第一个页签「已下载」：本机已有的（内置的群星 + 三套掌心魔法阵，以及下载过的），打开面板默认停在这里。
  const TABS = [['mine', '已下载'], ['picks', '作者推荐'], ['hub', '群星'], ['claude', 'Claude'], ['codex', 'Codex'], ['deepseek', 'DeepSeek'], ['settings', '播放设置']];
  const ANIM_NAME = { soft: '柔光登场', rush: '冲击登场', galaxy: '群星登场', video: '有声视频' };
  const FREQ = [['daily', '每天第一次启动时播放', '默认。一天看一次，之后重启直接进入'], ['always', '每次启动都播放', '约 3 秒，点画面或按 Esc 随时跳过'], ['off', '不播放', '直接进入 Hub']];
  const WHO_ORDER = { hub: 0, claude: 1, codex: 2, deepseek: 3 };
  const inTab = id => (id === 'picks' ? data.items.filter(i => i.recommend).sort((a, b) => WHO_ORDER[a.who] - WHO_ORDER[b.who])
    : id === 'mine' ? data.items.filter(i => i.installed).sort((a, b) => WHO_ORDER[a.who] - WHO_ORDER[b.who]) : data.items.filter(i => i.who === id).sort((a, b) => (!!b.recommend - !!a.recommend) || ((b.anim === 'video') - (a.anim === 'video'))));
  let dialog = null, data = null, tab = 'mine', message = '', busy = false;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const kb = n => (!n ? '' : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  function card(it, full) {
    const current = data.preferences.selected === it.id, st = data.state || {}, active = st.activeId === it.id;
    const tag = current ? '<i class="bsp-tag on">正在使用</i>' : it.installed ? `<i class="bsp-tag">${it.bundled ? '内置' : '已下载'}</i>` : `<i class="bsp-tag dl">可下载${it.bytes ? ' ' + kb(it.bytes) : ''}</i>`;
    const action = it.update ? `<button class="appearance-btn primary" data-get="${it.id}" ${st.activeId ? 'disabled' : ''}>${active ? '更新中…' : '更新'}</button>`
      : current ? `<button class="appearance-btn" data-preview="${it.id}">预览</button>`
      : it.installed ? `<button class="appearance-btn primary" data-use="${it.id}">使用</button>`
        : `<button class="appearance-btn" data-get="${it.id}" ${st.activeId ? 'disabled' : ''}>${active ? '下载中…' : '下载并使用'}</button>`;
    return `<div class="bsp-card${current ? ' current' : ''}${it.anim === 'video' ? ' orig' : ''}"><button class="bsp-thumb" data-${it.installed ? 'preview' : 'get'}="${it.id}" title="${it.installed ? '点击预览' : '点击下载并使用'}"><img src="${esc(it.thumb)}" alt="">${it.recommend ? '<em class="bsp-pick">★ 推荐</em>' : ''}${tag}<span${it.credit ? ` title="原作：${esc(it.credit)}，${esc(it.creditUrl || '')}"` : ''}>${it.credit ? '原作 · ' + esc(it.credit.split(' · ')[0]) + ' · 有声' : ANIM_NAME[it.anim] || ''}</span></button><div class="bsp-meta"><strong title="${esc(it.name)}">${esc(full ? it.name : it.name.replace(/^.+? · /, ''))}</strong>${action}</div></div>`;
  }
  function settings() {
    const f = data.preferences.frequency;
    return `<div class="bsp-settings"><h3>什么时候播放</h3>${FREQ.map(([id, name, note]) => `<label class="bsp-radio"><input type="radio" name="bsp-freq" value="${id}" ${f === id ? 'checked' : ''}><span><b>${name}</b><small>${note}</small></span></label>`).join('')}
      <h3>下载来源</h3><p>按需下载的开场动画优先从公司内源取，取不到再走阿里云；每套 50–150 KB。</p>${require('./download-source-view').slotHtml('boot-splash', 'div')}
      <h3>关于「原作」开场</h3><p>Claude、Codex 页签里带「原作」的两套，来自 wynneceles 的开源项目 ai-boot-animations（github.com/wynneceles/ai-boot-animations），按 CC BY-NC-ND 4.0 原样收录、带原声，仅供非商业的个人使用；人物为网络流传的同人形象，著作权归原设计者。</p>
      <div class="bsp-row"><button class="appearance-btn" data-action="check">检查新的开场动画</button><button class="appearance-btn" data-preview="${esc(data.preferences.selected)}">预览当前开场动画</button></div></div>`;
  }
  function render() {
    if (!dialog || !data) return;
    const st = data.state || {}, cur = data.items.find(i => i.id === data.preferences.selected);
    const mine = tab === 'mine' || tab === 'picks';
    const list = tab === 'settings' ? settings()
      : `${tab === 'picks' ? '<p class="bsp-lead">三家的有声开场，带台词和字幕。每家第一个「掌心法阵·有声」约 3 秒，是 Hub 自制；Claude、Codex 的「原作」来自 wynneceles 的 ai-boot-animations（按 CC BY-NC-ND 4.0 原样收录），DeepSeek「深海魔法阵」也是 Hub 自制。</p>' : ''}${tab === 'mine' ? '<p class="bsp-lead">本机已有的开场动画，点图片全屏预览，点「使用」下次启动就播它。更多款式在右边的群星、Claude、Codex、DeepSeek 页签里，一键下载。</p>' : ''}<div class="bsp-grid${mine ? ' mine' : ''}${tab === 'picks' ? ' picks' : ''}">${inTab(tab).map(it => card(it, mine)).join('')}</div>`;
    const progress = st.activeId ? `<div class="appearance-download">${require('./download-progress-view').html({ ...(st.progress || {}), phase: st.progress && st.progress.total ? 'downloading' : 'connecting' }, { title: '下载开场动画' })}<button class="appearance-btn" data-action="cancel">取消</button></div>` : '';
    const status = st.error ? `<span class="bsp-error" role="alert">${esc(st.error)}</span>` : esc(message);
    dialog.innerHTML = `<div class="appearance-head"><div><strong>开场动画</strong><span>当前：${esc(cur ? cur.name : '群星')} · ${esc((FREQ.find(x => x[0] === data.preferences.frequency) || FREQ[0])[1])}</span></div><button class="appearance-close" data-action="close" aria-label="关闭">×</button></div>
      <div class="appearance-tabs" role="tablist">${TABS.map(([id, name]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}"${id === 'mine' ? ' class="bsp-tab-mine"' : ''}>${id === 'mine' ? '★ ' : ''}${name}${id === 'settings' ? '' : `<small>${inTab(id).length}</small>`}</button>`).join('')}</div>
      <section class="bsp-content">${list}</section>
      <div class="appearance-foot">${progress}<span class="appearance-feedback" role="status">${status}</span><button class="appearance-btn primary" data-action="close">完成</button></div>`;
    if (dialog.querySelector('[data-dl-source]')) void require('./download-source-view').fill(dialog).catch(() => {});
  }
  async function refresh() { data = await ipcRenderer.invoke('boot-splash:get'); syncSettings(); render(); }
  async function openPicker() {
    data = await ipcRenderer.invoke('boot-splash:get');
    syncSettings();
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'appearance-dialog boot-splash-dialog'; dialog.id = 'boot-splash-dialog';
      dialog.setAttribute('aria-label', '开场动画');
      document.body.appendChild(dialog);
      dialog.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tab) { tab = b.dataset.tab; message = ''; render(); return; }
        if (b.dataset.action === 'close') { dialog.close(); return; }
        if (b.dataset.action === 'cancel') { void ipcRenderer.invoke('boot-splash:cancel'); return; }
        if (b.dataset.preview) {
          const it = data.items.find(i => i.id === b.dataset.preview); if (!it || !it.src) return;
          // 预览时先收起面板（模态框在最顶层，会挡住动画），播完或跳过后原样回来。
          dialog.close();
          void play(it, { onDone: () => { if (!dialog.open) { render(); dialog.showModal(); } } });
          return;
        }
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            if (b.dataset.use) { data = await ipcRenderer.invoke('boot-splash:save', { selected: b.dataset.use }); message = '已换好，下次启动就播这一套。'; }
            else if (b.dataset.get) {
              const id = b.dataset.get; message = '';
              data = await ipcRenderer.invoke('boot-splash:download', id);
              const it = data.items.find(i => i.id === id);
              if (it && it.installed) { data = await ipcRenderer.invoke('boot-splash:save', { selected: id }); message = `「${it.name}」已下载并设为开场动画。`; }
            } else if (b.dataset.action === 'check') { data = await ipcRenderer.invoke('boot-splash:check'); message = data.state.error ? '' : '已是最新的开场动画目录。'; }
          } catch (error) { message = error.message || String(error); }
          finally { busy = false; render(); }
        })();
      });
      dialog.addEventListener('change', e => {
        const r = e.target.closest('input[name="bsp-freq"]'); if (!r) return;
        void ipcRenderer.invoke('boot-splash:save', { frequency: r.value }).then(next => { data = next; message = '已保存。'; render(); }).catch(error => { message = error.message; render(); });
      });
    }
    tab = 'mine'; message = ''; render();
    if (!dialog.open) dialog.showModal();
  }
  ipcRenderer.on('boot-splash:state', (_e, state) => { if (data) { data.state = state; if (dialog?.open) render(); } });
  ipcRenderer.on('boot-splash:changed', (_e, next) => { data = next; syncSettings(); if (dialog?.open) render(); });

  // 复用同一份播放偏好与播放器；手动重播不调用 startup，不消耗「每天第一次」或改动频率。
  const frequency = document.getElementById('cfg-boot-splash-frequency');
  const replay = document.getElementById('cfg-boot-splash-play');
  const settingsStatus = document.getElementById('cfg-boot-splash-status');
  function settingsError(error) {
    if (!settingsStatus) return;
    settingsStatus.textContent = error ? `启动动画：${error.message || error}，请重试。` : '';
    settingsStatus.hidden = !error;
  }
  function syncSettings() {
    if (frequency && data) { frequency.value = data.preferences.frequency; frequency.disabled = false; }
    if (replay && data) replay.disabled = false;
  }
  require('./launch-field-hint').setIconHint(document.getElementById('cfg-boot-splash-label'),
    '默认每天第一次启动时播放，修改后立即保存。现在播放一次只重播当前动画，不改变启动频率；点击画面或按 Esc 可跳过。更换动画可选其他款式。');
  frequency?.addEventListener('change', async () => {
    frequency.disabled = true; settingsError(null);
    try { data = await ipcRenderer.invoke('boot-splash:save', { frequency: frequency.value }); }
    catch (error) { settingsError(error); }
    finally { syncSettings(); render(); }
  });
  replay?.addEventListener('click', async () => {
    replay.disabled = true; settingsError(null);
    try {
      data = await ipcRenderer.invoke('boot-splash:get');
      const current = data.items.find(it => it.id === data.preferences.selected);
      if (!current?.src) throw new Error('当前动画不可用，请更换动画');
      await play(current);
    } catch (error) { settingsError(error); }
    finally { syncSettings(); }
  });
  document.getElementById('cfg-boot-splash-picker')?.addEventListener('click', () => {
    settingsError(null);
    void openPicker().catch(settingsError);
  });
  void refresh().catch(settingsError);

  document.getElementById('options-boot-splash')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('theme-menu'); if (menu) menu.style.display = 'none';
    document.getElementById('btn-theme')?.setAttribute('aria-expanded', 'false');
    void openPicker().catch(error => console.error('[boot-splash]', error));
  });

  window.hubBootSplash = { play, stop, openPicker, refresh };
  ipcRenderer.invoke('boot-splash:startup').then(spec => { if (spec) void play(spec, { hint: spec.showHint, firstHint: spec.firstHint }); })
    .catch(error => console.warn('[boot-splash]', error));
})();
