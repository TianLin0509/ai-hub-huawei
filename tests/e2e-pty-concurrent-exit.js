'use strict';
// Run on the shipping Electron runtime in a separate process: an access violation must fail the
// caller, never take down the test runner or get counted as a normal PTY exit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('SKIP: Windows ConPTY concurrent exit regression');
} else if (!process.argv.includes('--worker')) {
  const result = spawnSync(require('electron'), [__filename, '--worker'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, stdio: 'inherit', timeout: 180_000,
  });
  if (result.error) console.error(result.error.message);
  assert.equal(result.signal, null, 'native exit worker must finish without a signal');
  assert.equal(result.status, 0, 'native exit worker must finish without an access violation');
} else {
  const pty = require(process.env.HUB_PTY_TEST_MODULE || 'node-pty');
  const host = require('../core/pty-host');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-concurrent-exit-'));
  const fixture = path.join(root, 'fixture.ps1');
  fs.writeFileSync(fixture, `param([string]$Trigger,[string]$Ready)\n[IO.File]::WriteAllText($Ready,'ready')\nWrite-Output 'PTY_READY'\n$end=(Get-Date).AddSeconds(90)\nwhile (!(Test-Path -LiteralPath $Trigger)) { if ((Get-Date) -gt $end) { exit 2 }; Start-Sleep -Milliseconds 10 }\nexit 0\n`);
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const children = new Set();
  async function batch(index, kill) {
    const trigger = path.join(root, String(index));
    const states = Array.from({ length: 12 }, (_, i) => ({ readyFile: path.join(root, `ready-${index}-${i}`), text: '' }));
    const waits = states.map(state => {
      // No external provider: this is a real PTY with a local PowerShell
      // fixture. A shared file releases all native watcher threads together.
      const child = host.spawnPty(pty, shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Trigger', trigger, '-Ready', state.readyFile], {
        cols: 80, rows: 24, cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        useConpty: true, conptyInheritCursor: false,
      });
      state.child = child;
      children.add(child);
      child.onData(data => { state.text += data; });
      return new Promise(resolve => child.onExit(exit => {
        children.delete(child);
        state.exit = exit;
        resolve();
      }));
    });
    const end = Date.now() + 45_000;
    while (!states.every(state => fs.existsSync(state.readyFile))) {
      const detail = () => JSON.stringify(states.map(s => ({ ready: fs.existsSync(s.readyFile), exit: s.exit, tail: s.text.slice(-300) })));
      assert(Date.now() < end, 'all PTYs must report ready before simultaneous exit: ' + detail());
      assert(states.every(state => !state.exit), 'no fixture may exit before release: ' + detail());
      await sleep(20);
    }
    // Release the fixture even for kill mode so any survivors finish naturally
    // if an old native addon crashes the worker part way through the kill loop.
    fs.writeFileSync(trigger, 'exit');
    if (kill) for (const state of states) state.child.kill();
    await Promise.all(waits);
    // On Windows the public exit event can precede the native watcher callback
    // when kill closes the pipe first. Confirm the native callback too, so an
    // explicit probe exit cannot skip the very cleanup race we are testing.
    const nativeDeadline = Date.now() + 10_000;
    while (states.some(state => state.child._agent.exitCode === undefined)) {
      assert(Date.now() < nativeDeadline, 'all native exit callbacks must finish');
      await sleep(10);
    }
    if (!kill) for (const state of states) assert.equal(state.exit.exitCode, 0);
    console.log(JSON.stringify({ batch: index, mode: kill ? 'kill' : 'natural', exited: states.length }));
  }
  (async () => {
    const timer = setTimeout(() => {
      console.error('Concurrent PTY exit regression timed out');
      process.exitCode = 1;
      for (const child of children) { try { child.kill(); } catch {} }
    }, 150_000);
    try {
      for (let i = 0; i < 8; i++) await batch(i, i % 2 === 1);
    } finally {
      clearTimeout(timer);
      for (const child of children) { try { child.kill(); } catch {} }
    }
  // node-pty can retain its pipe/worker handles after all native exit callbacks
  // have fired. This process only probes concurrent exits; the packaged Hub
  // E2E separately verifies complete application teardown without force-kill.
  })().then(() => { process.exit(process.exitCode || 0); }).catch(error => { console.error(error.stack); process.exit(1); });
}
