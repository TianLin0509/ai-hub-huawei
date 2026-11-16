'use strict';
// Hub RoomBooking -> unchanged signed Python payload -> real headless browser -> local mock.
// Uses the source environment only for Python/Qt/Playwright dependencies; no company network.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { _waitMs: sleep } = require('./helpers/hub-launcher');
const { killTree } = require('../core/company-assistant/room-component');
const OUT = path.resolve(process.env.ROOM_RETRY_OUT || 'artifacts/r20/e2e');
const SOURCE = process.env.MSZ_SOURCE;
const until = async (fn, label, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(250); } throw Error('timeout: ' + label); };
(async () => {
  assert.ok(SOURCE, 'MSZ_SOURCE required'); fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(OUT, 'run-')), home = path.join(root, 'meeting-room'), marker = path.join(root, 'offline.flag');
  const python = path.join(SOURCE, '.venv/Scripts/python.exe');
  const bundle = path.resolve('core/company-assistant/room-component/msz-code-2.1.3.zip');
  const result = { root, localMockOnly: true, unchangedSignedPayload: bundle, realHeadlessBrowser: true, fullElectronUI: false, checks: [] };
  let mock, assistant, audit;
  const logs = [];
  const startedAt = Date.now();
  try {
    mock = spawn(python, [path.resolve('tests/fixtures/company-room-mock.py'), home, SOURCE], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    mock.stderr.on('data', x => logs.push(String(x)));
    await until(() => fs.existsSync(path.join(home, 'mock-ready.json')), 'mock ready', 30000);
    const ready = JSON.parse(fs.readFileSync(path.join(home, 'mock-ready.json')));
    const configFile = path.join(home, 'config.json'), cfg = JSON.parse(fs.readFileSync(configFile));
    // Preparation starts immediately, then reaches opening a few seconds later.
    const opened = new Date(Date.now() + 8000).toTimeString().slice(0, 8);
    cfg.抢订设置.开放时间 = opened;
    cfg.高级.网址 = `http://127.0.0.1:${ready.port}/meetingroom/?open=00:00:00&fullday=1#/`;
    cfg.主题 = '断网补抢本地回归'; cfg.优先会议室 = ['练秋湖F12-3-13R'];
    fs.writeFileSync(configFile, JSON.stringify(cfg)); fs.writeFileSync(marker, 'offline');
    assistant = new CompanyAssistant({ dataDir: path.join(root, 'data'), roomHome: home, noTimer: true, noTools: true, powerSaveBlocker: {},
      roomCommand: [python, path.resolve('tests/fixtures/company-room-offline-control.py'), bundle, marker],
      roomNetworkProbe: async () => !fs.existsSync(marker) && (await fetch(`http://127.0.0.1:${ready.port}/__state`)).ok,
      roomEnv: { PYTHONIOENCODING: 'utf-8', MSZ_HUB_TEST_INSTANCE: 'room-offline-' + process.pid } });
    const history = () => fs.existsSync(path.join(home, 'booking_history.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'booking_history.json'))) : [];
    const bookings = async () => (await fetch(`http://127.0.0.1:${ready.port}/__state`)).json();
    const auditWindows = () => {
      const pid = assistant.rooms.child?.pid;
      const cmd = `$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $added=0; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added++}} } while($added -gt 0); @(Get-Process | Where-Object { $ids.Contains($_.Id) -and $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle) | ConvertTo-Json -Compress`;
      const windows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }).trim() || '[]');
      assert.deepEqual(windows, [], 'test helper descendants must have no visible windows');
      result.windowAudit = 'no visible windows in helper process tree';
    };
    await assistant.rooms.ensure({ user: true });
    audit = setTimeout(() => { try { auditWindows(); } catch (e) { result.windowAuditError = e.message; } }, 60000);
    // A normal daemon encounters the injected network outage in its prepare phase.
    await assistant.rooms.command('start', {}, { user: true });
    // Run the production polling/recovery timers, while other assistant timers stay disabled.
    assistant.rooms.deps = { ...assistant.rooms.deps, noTimer: false };
    assistant.rooms.start();
    await until(() => history().some(r => /net::ERR_INTERNET_DISCONNECTED/.test(r.备注 || '')), 'real Page.goto disconnect');
    assert.deepEqual(await bookings(), []);
    result.checks.push('首次真实 Page.goto 报 ERR_INTERNET_DISCONNECTED，零预约');
    await until(() => assistant.state().roomOfflineRetries?.some(t => t.phase === 'waiting'), 'background detects offline booking');
    assert.deepEqual(await bookings(), []);
    result.checks.push('断网期间只等待网络，不提交预约');
    fs.unlinkSync(marker);
    await until(() => history().some(r => r.状态 === '成功'), 'automatic retry success', 150000);
    await until(() => assistant.rooms.status().mode === 'daemon', 'daemon restored', 30000);
    assert.equal((await bookings()).length, 1);
    assert.match(assistant.rooms.details().history.find(r => r.状态 === '错误').备注, /已在网络恢复后自动重试.*成功/);
    result.checks.push('网络恢复后自动 pause → once，真实页面提交成功且只预约 1 次');
    result.checks.push('历史保留原错误并展示自动重试成功，每日守护恢复');
    // Cover the required one-minute window audit while the restored daemon is idle.
    if (!result.windowAudit) { await sleep(Math.max(1, 60500 - (Date.now() - startedAt))); auditWindows(); }
    assert.equal(result.windowAuditError, undefined);
    fs.writeFileSync(path.join(OUT, 'history.json'), JSON.stringify(assistant.rooms.details().history, null, 2));
    fs.writeFileSync(path.join(OUT, 'recovery-state.json'), JSON.stringify(assistant.state().roomOfflineRetries, null, 2));
    result.ok = true;
  } catch (e) { result.ok = false; result.error = e.stack; process.exitCode = 1; }
  finally {
    clearTimeout(audit);
    assistant?.close();
    if (assistant?.rooms.child?.exitCode == null && assistant?.rooms.child?.pid) await killTree(assistant.rooms.child).catch(e => { result.teardownError = e.message; });
    if (mock?.exitCode == null) mock.kill();
    fs.writeFileSync(path.join(OUT, 'mock.log'), logs.join(''));
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})();
