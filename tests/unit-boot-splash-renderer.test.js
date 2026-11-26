'use strict';
// 播放器拆分回归：画布预算、无 DOM 绘制内核、后台线程的完成 / 异常 / 缩放契约。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { canvasSize, createScene } = require('../renderer/boot-splash-draw');
function canvas() {
  const ctx = new Proxy({}, { get(o, k) {
    if (k in o) return o[k];
    if (String(k).startsWith('create')) return () => ({ addColorStop() {} });
    return () => {};
  } });
  return { getContext: () => ctx, width: 0, height: 0 };
}
const spec = { anim: 'galaxy', weather: 'stars', tone: ['rgba(200,210,255,.9)', '#cfd8ff'], product: 'AI Hub', version: 'test' };

test('普通窗口保留像素密度；4K / 高 DPI 画布不超过四百万像素', () => {
  assert.deepEqual(canvasSize(1200, 756, 1), { width: 1200, height: 756, scale: 1, pixelWidth: 1200, pixelHeight: 756 });
  for (const [w, h, dpr] of [[3840, 2116, 2], [7680, 4276, 3], [1440, 856, 1.5]]) {
    const size = canvasSize(w, h, dpr);
    assert.ok(size.pixelWidth * size.pixelHeight <= 4000000);
    assert.ok(size.scale <= dpr); assert.equal(size.width, w); assert.equal(size.height, h);
  }
});

test('三套动画在没有 DOM 的环境里使用 ImageBitmap 尺寸绘制，缩放后仍覆盖整个内容区', () => {
  for (const anim of ['soft', 'rush', 'galaxy']) {
    const cv = canvas();
    const scene = createScene({ ...spec, anim, canvas: cv, image: { width: 1920, height: 1080 }, ...canvasSize(1440, 856, 1), makeCanvas: canvas });
    for (const t of [0, 0.5, 1.2, 2.2, scene.duration]) scene.draw(t, 0.016);
    assert.equal(cv.width, 1440); assert.equal(cv.height, 856); assert.ok(scene.duration >= 2.5);
  }
});

function workerFixture(drawing = { createScene }) {
  let now = 0, scheduled, closed = false;
  const messages = [], ctx = {
    importScripts() {}, HubBootSplashDrawing: drawing, OffscreenCanvas: class { constructor() { return canvas(); } },
    performance: { now: () => now }, postMessage: m => messages.push(m), close: () => { closed = true; },
    setTimeout: fn => { scheduled = fn; return 1; }, clearTimeout() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/boot-splash-worker.js'), 'utf8'), ctx);
  return { messages, send: data => ctx.onmessage({ data }), advance(ms) { now = ms; scheduled(); }, get closed() { return closed; } };
}

test('Worker 只回报进度，缩放后继续播放，结束释放图片；绘制异常明确回报并退出', () => {
  const w = workerFixture(); let released = 0;
  w.send({ type: 'start', spec, size: canvasSize(1200, 756), canvas: canvas(), image: { width: 1920, height: 1080, close: () => released++ } });
  assert.equal(w.messages[0].type, 'ready');
  w.send({ type: 'resize', size: canvasSize(1920, 1036, 2) });
  w.advance(2000); assert.equal(w.closed, false);
  w.advance(4000); assert.equal(w.messages.at(-1).type, 'done'); assert.equal(w.closed, true); assert.equal(released, 1);
  const broken = workerFixture({ createScene() { throw new Error('上下文不可用'); } });
  broken.send({ type: 'start', spec, size: canvasSize(1200, 756), canvas: canvas(), image: { close: () => released++ } });
  assert.equal(broken.messages[0].type, 'error'); assert.equal(broken.messages[0].message, '上下文不可用'); assert.equal(broken.closed, true);
  assert.equal(released, 2, '启动失败同样释放图片');
});

// 执行实际播放器；只替换 DOM、解码和线程边界，精确控制迟到的异步结果。
function playerFixture({ bitmap, readFile, prefs = {} } = {}) {
  const elements = [], images = [], workers = [], keys = new Set(), resizes = new Set(), timers = new Map(), revoked = [];
  let nextTimer = 0, released = 0;
  function element(tag) {
    const events = new Map();
    return {
      tag, dataset: {}, style: {}, clientWidth: 1440, clientHeight: 856, currentTime: 0, volume: 1,
      set innerHTML(html) {
        if (html.includes('<canvas>')) this.cv = element('canvas');
        if (html.includes('<video ')) { this.video = element('video'); this.sub = element('div'); }
      },
      querySelector: function (selector) { return selector === 'video' ? this.video : selector === '.boot-splash-sub' ? this.sub : this.cv; },
      insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() { this.src = ''; },
      play() { this.played = true; return Promise.resolve(); }, pause() {}, load() {}, classList: { add() {} },
      transferControlToOffscreen: () => ({}),
      getBoundingClientRect: () => ({ width: 1440, height: 856 }),
      addEventListener: (name, fn) => events.set(name, fn),
      emit(name) { events.get(name)?.(); },
      click() { events.get('click')({ target: { closest: () => null } }); },
      prepend() {}, remove() { const i = elements.indexOf(this); if (i >= 0) elements.splice(i, 1); },
    };
  }
  const preferences = { frequency: 'daily', selected: 'test', ...prefs };
  const context = {
    console: { warn() {} }, AbortController, Blob,
    URL: class extends URL {
      static next = 0;
      static createObjectURL() { return 'blob:test-' + ++this.next; }
      static revokeObjectURL(src) { revoked.push(src); }
    },
    setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    Image: class {
      constructor() { images.push(this); this.naturalWidth = 1920; this.naturalHeight = 1080; }
      decode() { return Promise.resolve(); }
      removeAttribute() { this.src = ''; }
    },
    Worker: class {
      constructor() { workers.push(this); this.messages = []; this.terminated = 0; }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated++; }
      emit(data) { this.onmessage({ data }); }
    },
    createImageBitmap: bitmap || (async () => ({ close() { released++; } })),
    require(name) {
      if (name === 'electron') return { ipcRenderer: { on() {}, invoke: async name => name === 'boot-splash:startup' ? null : ({ preferences, items: [] }) } };
      if (name === './boot-splash-draw') return { canvasSize };
      if (name === './launch-field-hint') return { setIconHint() {} };
      if (name === 'fs') return { promises: { readFile } };
      if (name === 'url') return require('node:url');
      return {};
    },
    document: {
      baseURI: 'file:///app/renderer/index.html', createElement: element,
      body: { appendChild: el => elements.push(el) },
      getElementById: id => elements.find(el => el.id === id) || null,
      addEventListener: (_, fn) => keys.add(fn), removeEventListener: (_, fn) => keys.delete(fn),
    },
    window: { devicePixelRatio: 2, addEventListener: (_, fn) => resizes.add(fn), removeEventListener: (_, fn) => resizes.delete(fn) },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/boot-splash.js'), 'utf8'), context);
  return {
    ...context.window.hubBootSplash, elements, images, workers, keys, resizes, timers, revoked,
    get released() { return released; },
    key(key = 'Escape') { for (const fn of keys) fn({ key, preventDefault() {}, stopPropagation() {} }); },
  };
}
const imageSpec = { anim: 'galaxy', weather: 'stars', who: 'hub', src: 'test.webp' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('图片加载中按 Esc、Enter、空格或点击即可取消，回调仅一次且不残留监听器或定时器', async () => {
  for (const key of ['Escape', 'Enter', ' ', 'click']) {
    const f = playerFixture(); let done = 0;
    const pending = f.play(imageSpec, { onDone: () => done++ });
    assert.equal(f.elements[0].dataset.phase, 'loading');
    if (key === 'click') f.elements[0].click(); else f.key(key);
    await pending; f.stop();
    assert.equal(done, 1); assert.equal(f.elements.length, 0); assert.equal(f.workers.length, 0);
    assert.equal(f.keys.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.images[0].src, '');
  }
});

test('解码迟到和连续重播不会复活旧遮罩，也不触发旧预览回调', async () => {
  const f = playerFixture(); let release, oldDone = 0, newDone = 0;
  const old = f.play(imageSpec, { onDone: () => oldDone++ });
  f.images[0].decode = () => new Promise(r => { release = r; });
  const decoding = f.images[0].onload();
  const current = f.play(imageSpec, { onDone: () => newDone++ });
  await f.images[1].onload(); await current;
  release(); await decoding; await old;
  assert.equal(f.elements.length, 1); assert.equal(f.workers.length, 1); assert.equal(oldDone, 0);
  f.key(); f.workers[0].emit({ type: 'done' });
  assert.equal(newDone, 1); assert.equal(f.elements.length, 0); assert.equal(f.resizes.size, 0);
  assert.equal(f.workers[0].terminated, 1); assert.equal(f.timers.size, 0);
});

test('位图转换中跳过后，迟到的位图释放而不创建绘制线程', async () => {
  let release, closed = 0;
  const f = playerFixture({ bitmap: () => new Promise(r => { release = r; }) });
  const pending = f.play(imageSpec); await f.images[0].onload(); await flush();
  f.key(); release({ close() { closed++; } }); await pending;
  assert.equal(closed, 1); assert.equal(f.workers.length, 0); assert.equal(f.elements.length, 0);
});

test('Worker 淡出中失败恢复静态图可见度，错误与超时完成都只通知一次', async () => {
  const f = playerFixture(); let done = 0;
  const pending = f.play(imageSpec, { onDone: () => done++ }); await f.images[0].onload(); await pending;
  const worker = f.workers[0], el = f.elements[0];
  worker.emit({ type: 'ready', duration: 3 });
  for (const resize of f.resizes) resize();
  assert.equal(worker.messages.at(-1).type, 'resize');
  worker.emit({ type: 'opacity', opacity: 0.1 }); worker.emit({ type: 'error', message: '绘制失败' });
  assert.equal(el.dataset.renderer, 'poster'); assert.equal(el.style.opacity, '1');
  for (const timer of [...f.timers.values()]) timer();
  worker.emit({ type: 'done' }); f.stop();
  assert.equal(done, 1); assert.equal(f.elements.length, 0); assert.equal(f.resizes.size, 0); assert.equal(f.timers.size, 0);
});

test('图片读取失败或加载超时都可自动退出，不把遮罩永久留在界面上', async () => {
  for (const mode of ['error', 'timeout']) {
    const f = playerFixture(); let done = 0;
    const pending = f.play(imageSpec, { onDone: () => done++ });
    if (mode === 'error') f.images[0].onerror(); else for (const timer of [...f.timers.values()]) timer();
    await pending;
    assert.equal(done, 1); assert.equal(f.elements.length, 0); assert.equal(f.keys.size, 0); assert.equal(f.timers.size, 0);
  }
});

test('本地视频转 Blob 并按片段起播，重播与停止只释放各自的资源', async () => {
  const f = playerFixture({ readFile: async () => Buffer.from('video') });
  const spec = { anim: 'video', src: 'file:///D:/Temp/video.mp4', clip: { start: 7.5, subs: [] } };
  await f.play(spec); await flush();
  const first = f.elements[0].video, firstSrc = first.src;
  assert.match(firstSrc, /^blob:/); assert.equal(first.played, true);
  first.emit('loadedmetadata'); assert.equal(first.currentTime, 7.5);
  await f.play(spec); await flush();
  const secondSrc = f.elements[0].video.src;
  assert.notEqual(firstSrc, secondSrc); assert.deepEqual(f.revoked, [firstSrc]);
  first.emit('error'); assert.equal(f.elements.length, 1, '旧视频迟到错误不打断新视频');
  f.stop(); assert.deepEqual(f.revoked, [firstSrc, secondSrc]); assert.equal(f.timers.size, 0);
});

test('开场视频默认静音：老偏好没有声音开关也静音；用户打开「播放声音」才出声，启动时带的偏好优先', async () => {
  const quiet = playerFixture({ readFile: async () => Buffer.from('video') }); await flush();
  await quiet.play({ anim: 'video', src: 'file:///D:/Temp/video.mp4' }); await flush();
  assert.equal(quiet.elements[0].video.muted, true, '没打开过声音就静音');
  quiet.stop();
  const loud = playerFixture({ readFile: async () => Buffer.from('video'), prefs: { sound: true } }); await flush();
  await loud.play({ anim: 'video', src: 'file:///D:/Temp/video.mp4' }); await flush();
  assert.equal(loud.elements[0].video.muted, false, '预览 / 重播按当前偏好出声');
  await loud.play({ anim: 'video', src: 'file:///D:/Temp/video.mp4' }, { sound: false }); await flush();
  assert.equal(loud.elements[0].video.muted, true, '启动时带来的静音偏好优先');
  loud.stop();
});

test('本地视频读取中可取消，读取结果迟到时释放 Blob、不再播放或提示错误', async () => {
  let release, signal;
  const f = playerFixture({ readFile: (_, options) => { signal = options.signal; return new Promise(r => { release = r; }); } });
  await f.play({ anim: 'video', src: 'file:///D:/Temp/video.mp4' });
  const video = f.elements[0].video;
  f.key(); assert.equal(signal.aborted, true);
  release(Buffer.from('video')); await flush();
  assert.equal(video.played, undefined); assert.equal(f.revoked.length, 1); assert.equal(f.elements.length, 0); assert.equal(f.timers.size, 0);
});

test('视频读取失败保留主干的群星回退与可见提示，外部 Blob 不由播放器释放', async () => {
  const broken = playerFixture({ readFile: async () => { throw new Error('读取失败'); } });
  await broken.play({ anim: 'video', src: 'file:///D:/Temp/missing.mp4' }); await flush();
  assert.ok(broken.elements.some(el => el.id === 'boot-splash-fallback'));
  assert.equal(broken.images.length, 1, '改播群星图片');
  broken.stop();
  const external = playerFixture(); await external.play({ anim: 'video', src: 'blob:external' }); await flush();
  external.stop(); assert.deepEqual(external.revoked, []);
});
