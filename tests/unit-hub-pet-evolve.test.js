'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../core/profile/rules');
const E = require('../renderer/hub-pet/pet-evolution');
const { createProfileController } = require('../main/profile-controller');
const { SpeechQueue } = require('../core/hub-pet/state');

test('进化规则：六个形态，逐一覆盖阈值前后和最终等级', () => {
  assert.deepEqual(R.EVOLUTIONS.map(e => e.level), [1, 10, 20, 30, 40, 50]);
  assert.equal(R.evolutionOf(10).name, '星冠');
  for (const e of R.EVOLUTIONS) {
    assert.equal(R.evolutionOf(e.level).n, e.n);
    assert.equal(R.evolutionOf(e.level + (e.n === 1 ? 8 : 9)).n, e.n);
    if (e.n > 1) assert.equal(R.evolutionOf(e.level - 1).n, e.n - 1);
  }
  assert.equal(R.evolutionOf(60).n, 6);
  assert.equal(R.evolutionOf(NaN).n, 1);
  assert.equal(R.evolutionChange(11, 19), null);
  assert.equal(R.evolutionChange(9, 40).n, 5);
  assert.deepEqual(R.perksOf(60), ['chip', 'sparkle', 'halo']);
});

test('跨形态结算：同次成就、段位和升级只给桌宠一张进化卡，连跨多档取最终形态', () => {
  for (const target of [10, 20, 30, 40, 50]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-evolve-'));
    const calls = [], events = [], handlers = {};
    const c = createProfileController({ dataDir: dir, ipcMain: { handle: (n, fn) => { handlers[n] = fn; } },
      sendToRenderer: (channel, payload) => events.push({ channel, payload }),
      getPet: () => ({ celebrate: payload => calls.push(payload), setProfile() {}, getSettings: () => ({ enabled: true }) }) });
    try {
      c.profile.state.xp = R.xpForLevel(target);
      c.profile.state.lastLevel = target === 40 ? 9 : target - 1;
      c.profile.settle();
      assert.equal(calls.length, 1);
      assert.match(calls[0].title, /^进化了！形态/);
      assert.equal(calls[0].evolution.n, R.evolutionOf(target).n);
      assert.equal(calls[0].art, 'evolve-' + R.evolutionOf(target).n);
      c.profile.settle();
      assert.equal(calls.length, 1, '同一级重复结算不补演');
    } finally { c.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('进化卡图片经过通知队列保留，越界和路径输入不接受', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    const q = new SpeechQueue({ now: () => 1000 });
    q.push({ id: 'e' + n, kind: 'growth', notify: true, title: '进化了', art: 'evolve-' + n });
    q.tick(() => ({ ok: true }));
    assert.equal(q.snapshot().bubble.art, 'evolve-' + n);
  }
  for (const art of ['evolve-7', 'evolve-1', '../head-3', 'evolve-2/../x']) {
    const q = new SpeechQueue({ now: () => 1000 });
    q.push({ id: 'e', kind: 'growth', notify: true, title: '进化了', art });
    q.tick(() => ({ ok: true }));
    assert.equal(q.snapshot().bubble.art, undefined);
  }
});

function bitmap(w, h, rectangles) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [left, top, right, bottom] of rectangles) {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) d[(y * w + x) * 4 + 3] = 255;
  }
  return d;
}
test('透明度定位：耳尖不当头顶，跟随偏心头部、当前帧和透明边', () => {
  const cat = E.measure(bitmap(100, 100, [[20, 30, 80, 90], [20, 10, 32, 40], [68, 10, 80, 40]]), 100, 100);
  assert.ok(Math.abs(cat.cx - 0.5) < 0.01);
  assert.equal(cat.top, 0.1);
  assert.equal(cat.head, 0.3);
  const moved = E.measure(bitmap(100, 100, [[40, 45, 90, 95]]), 100, 100);
  assert.equal(moved.cx, 0.65);
  assert.equal(moved.head, 0.45);
  assert.equal(E.measure(new Uint8ClampedArray(400), 10, 10), null);
  const prev = { x: 0.5, y: 0.3 };
  assert.deepEqual(E.anchor({ cx: 0.508, head: 0.305 }, prev, 150), prev);
  assert.deepEqual(E.anchor(moved, prev, 150), { x: 0.65, y: 0.45 });
  const tail = E.measure(bitmap(100, 100, [[10, 5, 20, 90], [40, 30, 90, 95]]), 100, 100);
  assert.ok(tail.cx > 0.6, '竖起的细尾巴不能把头部重心拉过去');
  assert.equal(tail.head, 0.3);
  const tuft = E.measure(bitmap(100, 100, [[48, 5, 51, 30], [25, 30, 75, 90]]), 100, 100);
  assert.equal(tuft.head, 0.3, '细发梢不能让头饰悬空');
});

test('进化素材：七张透明 webp，单张与总量符合上限，打包与公开版均保留', () => {
  const pkg = require('../package.json');
  const targetFile = path.join(__dirname, '../tools/public-edition/public-target.json');
  const target = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : { drop: [] };
  let total = 0;
  for (const name of ['head-2', 'head-3', 'head-4', 'head-5', 'head-6', 'wings-5', 'wings-6']) {
    const rel = 'renderer/assets/hub-pet/evolve/' + name + '.webp';
    const data = fs.readFileSync(path.join(__dirname, '..', rel));
    assert.equal(data.subarray(8, 12).toString(), 'WEBP');
    assert.ok(data.length <= 40 * 1024); total += data.length;
    assert.ok(!target.drop.some(p => rel.startsWith(p.replace(/\*.*$/, ''))));
  }
  assert.ok(total <= 250 * 1024);
  assert.ok(pkg.build.files.includes('renderer/**/*'));
});

test('真实透明度回归：伸懒腰的尾巴和拱背不能夺走头饰，企鹅细发梢不当头顶', async () => {
  const sharp = require('sharp');
  const sheet = path.join(__dirname, '../renderer/assets/hub-pet/01-cat/seq-stretch.webp');
  let reference;
  for (const f of [0, 8, 16]) {
    const data = await sharp(sheet).extract({ left: f % 5 * 250, top: Math.floor(f / 5) * 250, width: 250, height: 250 }).resize(192, 192).ensureAlpha().raw().toBuffer();
    const g = E.measure(data, 192, 192, reference);
    if (!reference) reference = g;
    assert.ok(g.cx > 0.45 && g.cx < 0.65, '皇冠留在头部水平区域');
    if (f) assert.ok(g.head > 0.24, '伸懒腰低头时皇冠跟着往下');
  }
  const data = await sharp(path.join(__dirname, '../renderer/assets/hub-pet/03-penguin/idle.webp')).resize(192, 192).ensureAlpha().raw().toBuffer();
  const g = E.measure(data, 192, 192);
  assert.ok(g.head - g.top > 0.035, '皇冠越过细发梢落在头部轮廓上');
});
