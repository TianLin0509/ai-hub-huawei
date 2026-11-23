'use strict';
// 粒子、模糊和大图缩放都留在绘制线程；主界面只接收淡出进度与结束信号。
importScripts('boot-splash-draw.js');
let scene, spec, image, canvas, started = 0, last = 0, timer = null;
function finish(message) {
  clearTimeout(timer);
  image?.close();
  postMessage(message); close();
}
function rebuild(size) {
  scene = globalThis.HubBootSplashDrawing.createScene({ ...spec, ...size, canvas, image, makeCanvas: () => new OffscreenCanvas(64, 64) });
}
function frame() {
  try {
    const now = performance.now(), t = (now - started) / 1000, dt = Math.min(0.05, (now - last) / 1000);
    last = now; scene.draw(t, dt);
    const opacity = Math.max(0, Math.min(1, (scene.duration - t) / scene.fade));
    if (opacity < 1) postMessage({ type: 'opacity', opacity });
    if (t >= scene.duration) { finish({ type: 'done' }); return; }
    timer = setTimeout(frame, 1000 / 60);
  } catch (error) { finish({ type: 'error', message: error.message }); }
}
onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      ({ canvas, image, spec } = data); rebuild(data.size);
      started = performance.now() - (spec.startAt || 0) * 1000; last = performance.now();
      postMessage({ type: 'ready', duration: scene.duration }); frame();
    } else if (data.type === 'resize' && scene) rebuild(data.size);
  } catch (error) { finish({ type: 'error', message: error.message }); }
};
