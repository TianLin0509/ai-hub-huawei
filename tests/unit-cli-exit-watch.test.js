'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCliExitWatch } = require('../core/cli-exit-watch');

function fake({ shell = true } = {}) {
  const entry = { info: { id: 's1', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }, agentTurnActive: true, lastOutputAt: 100 };
  const finished = [];
  const manager = {
    sessions: new Map([['s1', entry]]),
    isHostShellActive: () => shell,
    noteAgentTurnFinished: (id, ev) => { if (!entry.agentTurnActive) return false; entry.agentTurnActive = false; finished.push([id, ev]); return true; },
  };
  const exited = [];
  const watch = createCliExitWatch({ manager, onExited: e => exited.push(e), now: () => 5000 });
  return { entry, watch, finished, exited, manager };
}

test('two consecutive silent shell hits end the turn', () => {
  const { watch, finished, exited } = fake();
  watch.tick();
  assert.strictEqual(finished.length, 0);
  watch.tick();
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(finished[0][1].failedAt, 5000);
  assert.strictEqual(exited.length, 1);
});

test('new output between hits resets the count', () => {
  const { watch, entry, finished } = fake();
  watch.tick();
  entry.lastOutputAt = 200;
  watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('no shell prompt means nothing happens', () => {
  const { watch, finished } = fake({ shell: false });
  watch.tick(); watch.tick(); watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('non-CodeAgent sessions are left alone', () => {
  const { watch, entry, finished } = fake();
  entry.info.kind = 'claude';
  watch.tick(); watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('renderer lets the cli-exited failure event through for CodeAgent only', () => {
  const src = require('node:fs').readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
  assert.match(src, /isCodeAgentKind\(kind\) && payload\.signalSource === 'cli-exited-to-shell'/);
  const main = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');
  assert.match(main, /signalSource: 'cli-exited-to-shell'/);
});
