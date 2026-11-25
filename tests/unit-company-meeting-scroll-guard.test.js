'use strict';
// 会议页外层被代码滚走后的复位兜底（2026-11-24 用户截图：整页被顶走约 200px、翻不回去）。
const assert = require('node:assert/strict');
const { stuckScrollTargets, resetStuckScroll, createScrollGuard, scrollWithin, nearBottom, FIXED_SELECTORS } = require('../renderer/company-meeting-scroll-guard');
const { entryVersion, flowStamp, flowEntries } = require('../renderer/company-meeting-flow');

// 最小假 DOM：只要 tagName / parentElement / querySelectorAll / scrollTop。
function node(tagName, className = '', parent = null) {
  const n = { tagName, className, id: '', parentElement: parent, scrollTop: 0, scrollLeft: 0, children: [] };
  n.querySelectorAll = selector => {
    const cls = selector.replace(/^\./, ''), out = [];
    const walk = x => { for (const c of x.children) { if (c.className.split(' ').includes(cls)) out.push(c); walk(c); } };
    walk(n); return out;
  };
  if (parent) parent.children.push(n);
  return n;
}
const html = node('HTML'), body = node('BODY', '', html), host = node('SECTION', 'company-meeting-page', body);
const root = node('SECTION', 'company-meeting', host);
const columns = node('DIV', 'meeting-columns', root), pane = node('MAIN', 'meeting-evidence-pane', columns);
const aside = node('ASIDE', 'meeting-understanding', columns), flow = node('DIV', 'meeting-flow', pane);

const targets = stuckScrollTargets(root);
for (const n of [columns, pane, aside, root, host, body]) assert.ok(targets.includes(n), 'guards ' + n.className + n.tagName);
assert.ok(!targets.includes(html), 'html scrolling belongs to the Hub shell');
assert.ok(!targets.includes(flow), 'the timeline scrolls by itself and is never reset');
assert.ok(FIXED_SELECTORS.includes('.meeting-aside-panel'), 'right-pane tab panels are guarded too');

// 复现截图：外层被 scrollIntoView 顶走 200px；时间流自己的滚动位置保留。
pane.scrollTop = 200; host.scrollTop = 12; flow.scrollTop = 900;
const logs = [], guard = createScrollGuard({ log: fixed => logs.push(fixed) });
const fixed = guard.check(root);
assert.deepEqual(fixed.map(x => x.top), [200, 12]);
assert.equal(pane.scrollTop, 0); assert.equal(host.scrollTop, 0); assert.equal(flow.scrollTop, 900);
assert.match(fixed[0].node, /meeting-evidence-pane/);
pane.scrollLeft = 30; guard.check(root);
assert.equal(pane.scrollLeft, 0);
assert.equal(logs.length, 1, 'logs only once per page');
assert.equal(guard.count, 3);
assert.deepEqual(resetStuckScroll([null, { scrollTop: 0, scrollLeft: 0 }]), [], 'nothing to fix → empty');
assert.deepEqual(stuckScrollTargets(null), []);

// scrollWithin 只改列表自己的 scrollTop。
const rect = (top, height) => ({ top, bottom: top + height, height });
const list = { scrollTop: 100, getBoundingClientRect: () => rect(100, 300) };
const row = (top, h = 40) => ({ isConnected: true, getBoundingClientRect: () => rect(top, h) });
scrollWithin(list, row(600), 'nearest'); assert.equal(list.scrollTop, 100 + (640 - 400));
list.scrollTop = 100; scrollWithin(list, row(50), 'nearest'); assert.equal(list.scrollTop, 50);
list.scrollTop = 100; scrollWithin(list, row(150), 'nearest'); assert.equal(list.scrollTop, 100, 'already visible: no move');
list.scrollTop = 100; scrollWithin(list, row(700), 'center'); assert.equal(list.scrollTop, 100 + (720 - 250));
list.scrollTop = 100; scrollWithin(list, { isConnected: false }, 'center'); assert.equal(list.scrollTop, 100);

// 贴底阈值随可视高度变化：矮窗 48px，高窗最多 160px。
assert.equal(nearBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 760 }), true);
assert.equal(nearBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 740 }), false);
assert.equal(nearBottom({ scrollHeight: 3000, clientHeight: 1200, scrollTop: 1650 }), true);
assert.equal(nearBottom({ scrollHeight: 3000, clientHeight: 1200, scrollTop: 1600 }), false);

// 时间流的轻量版本号：文字、发言人、截图标记变了才变；无关字段不变。
const e = { seq: 7, kind: 'transcript', at: 3000, text: '原话', speaker: 2, track: 'system', asr: 'done' };
const v = entryVersion({ kind: 'transcript', at: 3000, event: e });
assert.equal(v, entryVersion({ kind: 'transcript', at: 3000, event: { ...e, asr: 'other', extra: 1 } }));
assert.notEqual(v, entryVersion({ kind: 'transcript', at: 3000, event: { ...e, text: '改过' } }));
assert.notEqual(v, entryVersion({ kind: 'transcript', at: 3000, event: { ...e, speaker: 3 } }));
const big = { startedAt: 0, events: Array.from({ length: 3000 }, (_, i) => ({ seq: i + 1, kind: i % 10 ? 'transcript' : 'slide', at: i * 1000, text: '第 ' + i + ' 句' })) };
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) flowStamp('m', big, flowEntries(big));
const msPerRound = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
assert.ok(msPerRound < 40, '3000-event stamp stays cheap: ' + msPerRound.toFixed(1) + ' ms');
console.log('meeting scroll guard: ancestor reset, list-only scroll, follow slack, cheap flow stamp PASS (' + msPerRound.toFixed(1) + ' ms/3000 events)');

// ---- 文本级回归：会议页代码里不再出现会滚动祖先的写法；外层容器 CSS 是 overflow:clip ----
{
  const fs = require('node:fs'), path = require('node:path'), dir = path.join(__dirname, '..', 'renderer');
  const files = fs.readdirSync(dir).filter(f => /^company-meeting-.*\.js$/.test(f));
  assert.ok(files.includes('company-meeting-page.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/[^\n'"`]*$/gm, '');
    assert.doesNotMatch(code.replace(/\/\*[\s\S]*?\*\//g, ''), /\.scrollIntoView\s*\(/, f + ' must not call scrollIntoView (scrolls overflow-hidden ancestors)');
    for (const m of code.matchAll(/\.focus\(([^)]*)\)/g)) assert.match(m[1], /preventScroll\s*:\s*true/, `${f}: .focus(${m[1]}) must pass { preventScroll: true }`);
  }
  const css = fs.readFileSync(path.join(dir, 'styles', 'company-meeting.css'), 'utf8');
  const rule = sel => { const i = css.indexOf('\n' + sel + '{'); assert.ok(i >= 0, 'rule ' + sel); return css.slice(i, css.indexOf('}', i)); };
  for (const sel of ['.company-meeting-page', '.company-meeting', '.meeting-evidence-pane', '.meeting-understanding', '.meeting-setup-main']) {
    assert.match(rule(sel), /overflow:clip/, sel + ' is overflow:clip (not scrollable by script)');
  }
  assert.match(rule('.meeting-flow'), /min-height:160px/, 'timeline keeps at least 160px');
  console.log('meeting scroll guard: source scan (no scrollIntoView, focus preventScroll, outer overflow:clip) PASS');
}
