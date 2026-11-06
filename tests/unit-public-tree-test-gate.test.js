'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readArgs, validateTree, phasePlans, statusOf, executePhases, runPublicTree } = require('../scripts/test-public-tree');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-test-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, 'export'); fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  fs.writeFileSync(path.join(tree, 'package-lock.json'), '{}');
  return { root, tree, logDir: path.join(root, 'logs') };
}

test('public test plan installs in the export and gives tests a fresh 900 second budget', () => {
  const phases = phasePlans('export');
  assert.deepEqual(phases.map(x => [x.name, x.seconds, x.npm, x.cwd]), [
    ['install', 600, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], 'export'],
    ['test', 900, ['test'], 'export'],
  ]);
  for (const phase of phases) {
    assert.equal(phase.command, 'python');
    assert.deepEqual(phase.args.slice(-phase.npm.length - 1), ['npm.cmd', ...phase.npm]);
  }
  assert.throws(() => readArgs(['--tree']), /Missing value/);
  assert.throws(() => readArgs(['--anything']), /Unknown/);
  assert.equal(readArgs(['--tree', 'export']).tree, path.resolve('export'));
  assert.equal(readArgs(['--tree', 'export', '--require-ledger']).requireLedger, true);
});

test('dependency install failure, timeout, and spawn failure stop before tests', t => {
  const f = fixture(t);
  for (const [index, failure] of [{ status: 7 }, { status: 124 }, { status: null, error: new Error('start failed') }].entries()) {
    let calls = 0;
    const result = executePhases({ tree: f.tree, logDir: path.join(f.root, `case-${index}`) }, {
      log() {}, spawn(command, args, options) {
        calls++; assert.equal(options.cwd, f.tree); assert.equal(options.windowsHide, true);
        return failure;
      },
    });
    assert.equal(calls, 1); assert.equal(result.ok, false);
    assert.equal(result.exitCode, index === 2 ? 125 : failure.status);
    assert.equal(result.phase, 'install');
  }
  assert.equal(statusOf({ status: 0, signal: 'SIGTERM' }), 125);
});

test('missing exported asset makes the real test process red and retains the complete error log', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.tree, 'check.cjs'), "require('fs').readFileSync('removed.css','utf8');");
  const spawn = (command, args, options) => args.includes('public-install') ? { status: 0 }
    : spawnSync(process.execPath, ['check.cjs'], options);
  const failed = executePhases(f, { spawn, log() {} });
  assert.equal(failed.ok, false); assert.equal(failed.exitCode, 1); assert.equal(failed.phase, 'test');
  assert.match(fs.readFileSync(failed.phases[1].stderr, 'utf8'), /ENOENT[\s\S]*removed\.css/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.logDir, 'result.json'))).exitCode, 1);
  fs.writeFileSync(path.join(f.tree, 'removed.css'), 'body {}');
  const passed = executePhases({ ...f, logDir: path.join(f.root, 'restored-logs') }, { spawn, log() {} });
  assert.equal(passed.ok, true); assert.equal(passed.exitCode, 0);
});

test('an available ledger is mandatory and a failed admission never falls back to direct tests', t => {
  const f = fixture(t), ledger = path.join(f.root, 'ledger.py'); fs.writeFileSync(ledger, '');
  let calls = 0;
  const failed = runPublicTree(f, { ledger, platform: 'win32', log() {}, spawn(command, args, options) {
    calls++; assert.equal(command, 'python'); assert.equal(args[0], ledger);
    assert.deepEqual(args.slice(1, 4), ['run', '--cores', '4']);
    assert.ok(args.includes('--execute-in-slot')); assert.equal(options.windowsHide, true);
    return { status: 7 };
  } });
  assert.equal(calls, 1); assert.equal(failed.ok, false); assert.equal(failed.exitCode, 7);
  // Reusing a log directory with an old pass cannot make an empty admission pass.
  fs.writeFileSync(path.join(f.logDir, 'result.json'), JSON.stringify({ ok: true, exitCode: 0 }));
  const empty = runPublicTree(f, { ledger, platform: 'win32', log() {}, spawn: () => ({ status: 0 }) });
  assert.equal(empty.ok, false); assert.equal(empty.exitCode, 125);
});

test('dependency isolation and unsupported platform fail explicitly', t => {
  const f = fixture(t), other = path.join(f.root, 'shared-modules'); fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(f.tree, 'node_modules'), 'junction');
  assert.throws(() => validateTree(f.tree, 'win32'), /linked node_modules/);
  fs.rmdirSync(other);
  assert.equal(fs.existsSync(path.join(f.tree, 'node_modules')), false);
  assert.throws(() => validateTree(f.tree, 'win32'), /linked node_modules/, 'dangling junction is also unsafe');
  assert.throws(() => validateTree(f.tree, 'linux'), /requires Windows/);
});

test('required ledger absence fails before installation; optional absence keeps both watchdog budgets', t => {
  const f = fixture(t); let calls = 0;
  assert.throws(() => runPublicTree({ ...f, requireLedger: true }, {
    ledger: null, platform: 'win32', log() {}, spawn() { calls++; return { status: 0 }; },
  }), /Required machine ledger/);
  assert.equal(calls, 0);
  const result = runPublicTree({ ...f, requireLedger: false }, {
    ledger: null, platform: 'win32', log() {}, spawn(command, args) {
      calls++; assert.equal(command, 'python'); assert.match(args[0], /test-budget\.py$/);
      return { status: 0 };
    },
  });
  assert.equal(calls, 2); assert.equal(result.ok, true);
});

