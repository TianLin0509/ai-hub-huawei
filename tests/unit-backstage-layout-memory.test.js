'use strict';
// 按会话记住「后台显示方式」（2026-11-18 反馈：切走再回来就恢复默认）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../core/backstage-layout-memory.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }
function store() { const data = {}; return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } }; }

test('没记过的会话 = 卡片（默认行为不变）', () => {
  const map = M.readBackstageLayouts(store());
  assert.strictEqual(M.backstageLayoutFor(map, 'a'), 'card');
});

test('记住并排/后台，改回卡片就删掉记录，读写往返一致', () => {
  const s = store(), map = M.readBackstageLayouts(s);
  assert.ok(M.rememberBackstageLayout(map, 'a', 'split'));
  assert.ok(M.rememberBackstageLayout(map, 'b', 'pty'));
  M.writeBackstageLayouts(s, map);
  const again = M.readBackstageLayouts(s);
  assert.strictEqual(M.backstageLayoutFor(again, 'a'), 'split');
  assert.strictEqual(M.backstageLayoutFor(again, 'b'), 'pty');
  assert.ok(M.rememberBackstageLayout(again, 'a', 'card'));
  assert.strictEqual(M.backstageLayoutFor(again, 'a'), 'card');
  assert.strictEqual(M.rememberBackstageLayout(again, 'zz', 'card'), false, '本来就是卡片：不用落盘');
});

test('坏数据当没记过；超过上限丢最早的', () => {
  const s = store(); s.setItem(M.STORAGE_KEY, '{bad');
  assert.strictEqual(M.readBackstageLayouts(s).size, 0);
  const map = new Map();
  for (let i = 0; i < M.LIMIT + 5; i++) M.rememberBackstageLayout(map, 'id' + i, 'split');
  M.writeBackstageLayouts(s, map);
  const back = M.readBackstageLayouts(s);
  assert.strictEqual(back.size, M.LIMIT);
  assert.ok(!back.has('id0') && back.has('id' + (M.LIMIT + 4)));
});

test('界面接线：后台按钮、菜单两项都记；切回会话时停后台的进后台、并排的重新并排', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /onSingle: \(\) => \{[^\n]*rememberBackstageLayoutForSession\(activeSessionId, currentView === 'pty' \? 'pty' : 'card'\)/);
  assert.match(src, /if \(sessionSplit\.isBackstage\(\)\) rememberBackstageLayoutForSession\(activeSessionId, 'split'\)/);
  assert.match(src, /sessionSplit\.leaveBackstage\(\); syncBackstageButton\(\); rememberBackstageLayoutForSession\(activeSessionId, 'card'\); return;/);
  assert.match(src, /backstageLayoutFor\(backstageLayoutBySession, sessionId\) === 'pty'\) return 'pty'/);
  assert.match(src, /if \(!opts\.inspectOnly\) setTimeout\(\(\) => restoreBackstageLayout\(id\), 0\);/);
  const split = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-split.js'), 'utf8');
  assert.match(split, /layout: \(\) => backstage \? 'backstage' : enabled \? 'two' : 'single'/);
});

console.log(`unit-backstage-layout-memory: ${passed} passed`);
