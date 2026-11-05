'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installSweepPulse, SWEEP_PERIOD_MS, SWEEP_MS, SWEEP_ID } = require('../renderer/sweep-pulse.js');

// 只模拟用到的 DOM：宿主元素、懒建的光条子元素、脚本动画。
function fakeNode({ visible = true, connected = true } = {}) {
  const node = { isConnected: connected, kids: [], anims: [], getClientRects: () => (visible ? [{}] : []), animate() {},
    querySelector: () => node.kids[0] || null, append: k => node.kids.push(k),
    getAnimations: () => node.anims.filter(a => a.playState === 'running') };
  node.ownerDocument = { createElement: tag => {
    const kid = { tag, attrs: {}, setAttribute: (k, v) => { kid.attrs[k] = v; },
      animate: (frames, opts) => { const a = { frames, opts, playState: 'running', id: '' }; node.anims.push(a); return a; } };
    return kid;
  } };
  return node;
}
function harness({ nodes, hidden = false, reduce = false }) {
  let tick = null, period = null;
  const doc = { hidden, querySelectorAll: sel => (sel === '.hw-sweep' ? nodes : []) };
  const win = { matchMedia: q => ({ matches: reduce && q.includes('reduce') }) };
  const pulse = installSweepPulse({ doc, win, setTimer: (fn, ms) => { tick = fn; period = ms; return 1; } });
  return { pulse, tick: () => tick(), period: () => period };
}

test('each beat plays one finite pass on a light bar inside every visible element', () => {
  const a = fakeNode(), b = fakeNode(), off = fakeNode({ visible: false });
  const h = harness({ nodes: [a, b, off] });
  assert.equal(h.period(), SWEEP_PERIOD_MS);
  assert.equal(SWEEP_PERIOD_MS, 8000);
  h.tick();
  for (const n of [a, b]) {
    assert.equal(n.kids.length, 1); assert.equal(n.kids[0].className, 'hw-sweep-light'); assert.equal(n.kids[0].attrs['aria-hidden'], 'true');
    assert.equal(n.anims.length, 1);
    const anim = n.anims[0];
    assert.equal(anim.id, SWEEP_ID);
    assert.deepEqual(anim.opts, { duration: SWEEP_MS, easing: 'linear', iterations: 1 });
    assert.equal(SWEEP_MS, 2200);
  }
  assert.equal(off.kids.length, 0, 'hidden elements are left alone');
});

test('a beat neither restarts a pass in progress nor adds a second light bar', () => {
  const a = fakeNode();
  const h = harness({ nodes: [a] });
  h.tick(); h.tick();
  assert.equal(a.anims.length, 1); assert.equal(h.pulse.beats(), 1);
  a.anims[0].playState = 'finished';
  h.tick();
  assert.equal(a.anims.length, 2, 'next beat after the pass ended plays again');
  assert.equal(a.kids.length, 1, 'the light bar is reused');
});

test('no sweep when the system asks for reduced motion or the window is hidden', () => {
  const a = fakeNode();
  harness({ nodes: [a], reduce: true }).tick();
  const hidden = harness({ nodes: [a], hidden: true }); hidden.tick();
  assert.equal(a.anims.length, 0);
  assert.equal(hidden.pulse.beats(), 0);
});

test('styles hold no CSS animation (moving an element cannot replay it) and keep the original colours', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/hw-sweep.css'), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /animation|@keyframes/);
  assert.match(css, /\.hw-sweep > \.hw-sweep-light\{position:absolute;[^}]*height:var\(--hw-sweep-h\)/);
  assert.match(css, /rgba\(10,89,247,\.55\) 55%,rgba\(207,10,44,\.35\) 78%/, 'keeps the original blue-to-red sweep colours');
  assert.match(css, /:root:not\(\[data-hw-shell\]\) \.hw-sweep > \.hw-sweep-light\{display:none\}/, 'home edition never shows the bar');
  const ask = fs.readFileSync(path.join(__dirname, '../renderer/styles/ask-aside.css'), 'utf8');
  assert.doesNotMatch(ask, /ask-sweep/, 'the old endless sweep is gone from the ask drawer');
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/ask-aside-ui.js'), 'utf8'), /thinking hw-sweep/);
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), /indicator\.className = 'streaming-indicator hw-sweep'/, 'card working pill is wired to the sweep');
});
