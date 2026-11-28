'use strict';

// 长消息悬停复制与「复制为图片」（2026-11-28）。
const assert = require('assert');
const { captureSlices, describeResult, PAD } = require('../renderer/message-image-copy.js');
const { renderMessageBody } = require('../renderer/conversation-message-view.js');
const { registerAppUtilityIpc } = require('../main/ipc/app-utility-handlers.js');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  OK ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}\n    ${error.stack}`); }
}

// 一个 600 高的滚动区（视口 y∈[100,700]），里面放一个高 height 的元素，元素在内容里的位置是 contentTop。
function fakeScene({ height, contentTop = 50, scrollTop = 0, scrollHeight = 10000 }) {
  const scroller = { scrollTop, scrollHeight, clientHeight: 600, parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 100, right: 1000, bottom: 700 }) };
  const el = { parentElement: scroller,
    getBoundingClientRect() {
      const top = 100 + contentTop - scroller.scrollTop;
      return { left: 100, right: 900, top, bottom: top + height, height, width: 800 };
    } };
  const win = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle: node => ({ overflowY: node === scroller ? 'auto' : 'visible' }),
    requestAnimationFrame: cb => cb() };
  const captured = [];
  const capture = async rect => { captured.push({ ...rect, scrollTop: scroller.scrollTop }); return new Uint8Array([1]); };
  return { scroller, el, win, captured, capture };
}

(async () => {
  await test('长消息块带悬停复制与复制为图片按钮，且不进卡片整体复制', () => {
    const long = 'x'.repeat(1300);
    const html = renderMessageBody(long, { escapeHtml: s => s, renderMarkdown: s => `<p>${s}</p>` });
    assert.match(html, /<div class="conversation-long-actions" data-copy-exclude>/);
    assert.match(html, /data-action="long-copy"/);
    assert.match(html, /data-action="long-copy-image"/);
    const short = renderMessageBody('短消息', { escapeHtml: s => s, renderMarkdown: s => `<p>${s}</p>` });
    assert.doesNotMatch(short, /long-copy/);
  });

  await test('一屏装得下：不滚动，一次截完并带四周留白', async () => {
    const scene = fakeScene({ height: 300, contentTop: 100 });
    const shot = await captureSlices(scene.el, { win: scene.win, capture: scene.capture });
    assert.strictEqual(scene.captured.length, 1);
    assert.strictEqual(scene.captured[0].scrollTop, 0);
    assert.deepStrictEqual({ x: scene.captured[0].x, y: scene.captured[0].y, w: scene.captured[0].width, h: scene.captured[0].height },
      { x: 100 - PAD, y: 200 - PAD, w: 800 + 2 * PAD, h: 300 + 2 * PAD });
    assert.strictEqual(shot.truncated, false);
    assert.strictEqual(shot.slices[0].offset, 0);
  });

  await test('超过一屏：逐屏滚动截取，拼接位置首尾相接覆盖全高', async () => {
    const scene = fakeScene({ height: 1500, contentTop: 400 });
    const shot = await captureSlices(scene.el, { win: scene.win, capture: scene.capture });
    assert.ok(scene.captured.length >= 3, `截了 ${scene.captured.length} 屏`);
    let covered = 0;
    for (const s of shot.slices) { assert.ok(Math.abs(s.offset - covered) < 0.01, `拼接缝 ${s.offset} vs ${covered}`); covered += s.rect.height; }
    assert.ok(Math.abs(covered - (1500 + 2 * PAD)) < 0.01);
    assert.strictEqual(shot.height, 1500 + 2 * PAD);
  });

  await test('滚到底部被夹住时仍能截完最后一段', async () => {
    const scene = fakeScene({ height: 900, contentTop: 400, scrollHeight: 1350 });
    const realScroller = scene.scroller;
    let top = 0;
    Object.defineProperty(realScroller, 'scrollTop', { get: () => top, set: v => { top = Math.max(0, Math.min(1350 - 600, v)); } });
    const shot = await captureSlices(scene.el, { win: scene.win, capture: scene.capture });
    const covered = shot.slices.reduce((n, s) => n + s.rect.height, 0);
    assert.ok(Math.abs(covered - (900 + 2 * PAD)) < 0.01);
  });

  await test('超长内容按画布上限截断并报告比例', async () => {
    const scene = fakeScene({ height: 5000, contentTop: 0 });
    const shot = await captureSlices(scene.el, { win: scene.win, capture: scene.capture, maxDeviceHeight: 2000 });
    assert.strictEqual(shot.truncated, true);
    assert.strictEqual(shot.height, 2000);
    const r = describeResult({ ok: true, image: true, truncated: true, percent: 40 });
    assert.match(r.notice, /前 40%/);
  });

  await test('结果提示：成功、退回文字、失败各有一句人话', () => {
    assert.deepStrictEqual(describeResult({ ok: true, image: true }), { label: '已复制图片', notice: '' });
    assert.match(describeResult({ ok: true, fellBack: true, error: '窗口当前不可见' }).notice, /已改为复制文字/);
    assert.match(describeResult({ ok: false, error: 'x' }).notice, /复制为图片失败/);
  });

  await test('主进程：截图与写剪贴板两个通道', async () => {
    const handlers = new Map();
    const ipc = { handle: (c, fn) => handlers.set(c, fn), on() {} };
    let written = null;
    const image = { isEmpty: () => false, getSize: () => ({ width: 4, height: 3 }), toPNG: () => Buffer.from('img') };
    registerAppUtilityIpc(ipc, {
      clipboard: { writeImage: img => { written = img; }, readImage: () => written || { isEmpty: () => true, getSize: () => ({}) },
        writeText() {}, readText: () => '' },
      nativeImage: { createFromBuffer: () => image },
      getMainWindow: () => null, getHookPort: () => 0, path: require('path'), fs: require('fs'), crypto: require('crypto'), imageDir: '.',
      getNetworkEgressStatus: async () => ({}), acknowledgeNetworkEgressChange: async () => ({}),
      clashDelay: { sample: async () => ({}) }, liveTelemetry: { sample: async () => ({}) },
    });
    assert.ok(handlers.has('message-image:capture'));
    const res = await handlers.get('message-image:write')({}, new Uint8Array([1, 2]));
    assert.deepStrictEqual(res, { ok: true, size: { width: 4, height: 3 } });
    assert.strictEqual(written, image);
    const shot = await handlers.get('message-image:capture')({ sender: { capturePage: async box => {
      assert.deepStrictEqual(box, { x: 10, y: 20, width: 31, height: 41 });
      return { isEmpty: () => false, toPNG: () => Buffer.from('png') };
    } } }, { x: 10.6, y: 20.2, width: 30.1, height: 40.5 });
    assert.strictEqual(shot.ok, true);
    // 第一屏起占住顺序号；期间有新的文字复制，后续截图直接让位
    const sender = { capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }) };
    assert.strictEqual((await handlers.get('message-image:capture')({ sender }, { x: 0, y: 0, width: 5, height: 5, first: true })).ok, true);
    await handlers.get('clipboard:write-text')({}, '新复制的文字');
    const late = await handlers.get('message-image:capture')({ sender }, { x: 0, y: 5, width: 5, height: 5 });
    assert.strictEqual(late.reason, 'superseded');
    const empty = await handlers.get('message-image:capture')({ sender: { capturePage: async () => ({ isEmpty: () => true }) } }, { x: 0, y: 0, width: 1, height: 1 });
    assert.strictEqual(empty.ok, false);
  });

  await test('并发点击只做一张；跟随最新在截图期间暂停、结束后恢复；被新复制取代时不回退文字', async () => {
    const { copyElementAsImage } = require('../renderer/message-image-copy.js');
    const calls = [];
    const scroller = { scrollTop: 0, scrollHeight: 1200, clientHeight: 600, parentElement: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      _cardFollowController: { isFollowing: () => true, pause: () => calls.push('pause'), follow: () => calls.push('follow') } };
    const classes = new Set();
    const body = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
    const doc = { body, querySelectorAll: () => [] };
    const win = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, getComputedStyle: n => ({ overflowY: n === scroller ? 'auto' : 'visible' }),
      requestAnimationFrame: cb => cb() };
    doc.defaultView = win;
    const el = { parentElement: scroller, ownerDocument: doc, matches: () => false, querySelectorAll: () => [], classList: body.classList,
      getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 300, height: 200, width: 400 }) };
    let release;
    const gate = new Promise(r => { release = r; });
    const ipc = { capture: async () => { await gate; throw new Error('截图失败'); }, write: async () => {} };
    const first = copyElementAsImage(el, { ipc, fallbackText: 'x', copyText: async () => ({ ok: true }) });
    const second = await copyElementAsImage(el, { ipc });
    assert.match(second.error, /还在生成/);
    release();
    const r1 = await first;
    assert.strictEqual(r1.fellBack, true);
    assert.deepStrictEqual(calls, ['pause', 'follow']);
    const superseded = await copyElementAsImage(el, { ipc: { capture: async () => { throw Object.assign(new Error('期间有新的复制操作'), { superseded: true }); } },
      fallbackText: 'x', copyText: async () => { throw new Error('不该回退'); } });
    assert.strictEqual(superseded.superseded, true);
    assert.strictEqual(describeResult(superseded).notice, '');
  });

  if (failed) { console.error(`${failed} message image copy test(s) failed`); process.exit(1); }
  console.log('All message image copy tests passed.');
})();
