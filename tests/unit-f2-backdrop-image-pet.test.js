'use strict';
// r7 F2（2026-11-22）回归：
//  1. 设置/自有 API 弹窗：在输入框里按下、拖到框外松开，不能当成「点遮罩」把弹窗关掉；真点遮罩照常关。
//  2. 粘贴图片：长边超过 2000px 保存时按比例缩小，并带回原尺寸与新尺寸供提示；不超的原样保存。
//  3. 桌宠：躲边（只露个头）时按住拖得动，拖出来后这次全屏期间不再躲（静态核对控制器代码）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bindBackdropDismiss } = require('../renderer/backdrop-dismiss.js');
const { saveClipboardImage, fitImageToMaxEdge, PASTE_IMAGE_MAX_EDGE } = require('../main/ipc/app-utility-handlers.js');

function fire(target, type, eventTarget) {
  const event = new Event(type);
  Object.defineProperty(event, 'target', { value: eventTarget });
  target.dispatchEvent(event);
}

test('在输入框里按下、拖到遮罩上松开：不关弹窗', () => {
  const modal = new EventTarget(); const input = {};
  let closed = 0;
  bindBackdropDismiss(modal, { onDismiss: () => { closed++; } });
  fire(modal, 'mousedown', input);
  fire(modal, 'click', modal); // 浏览器把 click 发给共同祖先＝遮罩
  assert.equal(closed, 0);
});

test('在遮罩上按下并松开：照常关弹窗；之后的拖选不受上一次影响', () => {
  const modal = new EventTarget(); const input = {};
  let closed = 0;
  bindBackdropDismiss(modal, { onDismiss: () => { closed++; } });
  fire(modal, 'mousedown', modal); fire(modal, 'click', modal);
  assert.equal(closed, 1);
  fire(modal, 'mousedown', input); fire(modal, 'click', modal);
  assert.equal(closed, 1);
});

test('设置弹窗与自有 API 弹窗都用按下+松开判定（不再只看 click 的目标）', () => {
  const root = path.join(__dirname, '..', 'renderer');
  const cfg = fs.readFileSync(path.join(root, 'config-modal.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'company-api-settings.js'), 'utf8');
  assert.match(cfg, /bindBackdropDismiss\(modal/);
  assert.doesNotMatch(cfg, /addEventListener\('click', \(e\) => \{ if \(e\.target === modal\) closeConfigModal\(\)/);
  assert.match(api, /bindBackdropDismiss\(self/);
  // 关掉自有 API 后回到设置（从设置点进来时）
  assert.match(api, /if \(backToSettings\) settings\.classList\.remove\('hidden'\)/);
});

function fakeImage(width, height) {
  return {
    width, height,
    isEmpty: () => false,
    getSize() { return { width: this.width, height: this.height }; },
    resize({ width: w, height: h }) { return fakeImage(w, h); },
    toPNG() { return Buffer.from(`png:${this.width}x${this.height}`); },
  };
}
function saveWith(image, options) {
  const written = {};
  const deps = {
    clipboard: { readImage: () => image },
    crypto: { randomBytes: () => Buffer.from([1, 2, 3]) },
    fs: { mkdirSync() {}, writeFileSync: (p, buf) => { written[p] = buf.toString(); } },
    imageDir: 'D:\hub\images', path, logger: { info() {}, warn() {} },
  };
  return { result: saveClipboardImage(deps, options), written };
}

test('3840×2160 截图：按比例缩到长边 2000 再保存，并带回尺寸', () => {
  assert.equal(PASTE_IMAGE_MAX_EDGE, 2000);
  const { result, written } = saveWith(fakeImage(3840, 2160), { withInfo: true });
  assert.equal(result.resized, true);
  assert.deepEqual(result.from, { width: 3840, height: 2160 });
  assert.deepEqual(result.to, { width: 2000, height: 1125 });
  assert.equal(written[result.path], 'png:2000x1125');
});

test('竖长图 1200×5000 也按长边缩；1920×1080 不动；不带参数仍只返回路径', () => {
  assert.deepEqual(fitImageToMaxEdge(fakeImage(1200, 5000)).to, { width: 480, height: 2000 });
  const small = saveWith(fakeImage(1920, 1080), { withInfo: true });
  assert.equal(small.result.resized, false);
  assert.equal(small.written[small.result.path], 'png:1920x1080');
  const legacy = saveWith(fakeImage(2400, 2400));
  assert.equal(typeof legacy.result, 'string');
  assert.equal(legacy.written[legacy.result], 'png:2000x2000');
});

test('输入框拿到缩小结果会提示，并插入路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'terminal-input-controller.js'), 'utf8');
  assert.equal((src.match(/ipcRenderer\.invoke\('save-clipboard-image', \{ withInfo: true \}\)/g) || []).length, 2);
  assert.match(src, /已自动缩小到/);
});

test('桌宠躲边时拖得动：拖开超过点击容差就退出躲边，全屏结束才复位', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'hub-pet-controller.js'), 'utf8');
  assert.doesNotMatch(src, /if \(fullscreen\) return; \/\/ 躲边时只认点击/);
  assert.match(src, /peekPulledOut = true;\s*fullscreen = false;/);
  assert.match(src, /if \(!screenFull\) peekPulledOut = false;/);
  assert.match(src, /!peekPulledOut\)/);
});
