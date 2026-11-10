'use strict';
// Real isolated Hub -> signed secretary exe -> original engine -> local mock webpage.
// Every booking action is a mouse click; no company network or real messages.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs: sleep } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const component = require('../core/company-assistant/room-component');
const { stageRuntime } = require('../core/company-assistant/room-component/build-runtime');
const REPO = path.resolve(__dirname, '..'), ROOT = path.resolve(process.env.ROOM_UI_ENTRY || REPO);
const OUT = path.resolve(process.env.ROOM_UI_OUT || path.join(REPO, 'artifacts', '20261102-room-ui-codex1'));
const SOURCE = process.env.MSZ_SOURCE;
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const until = async (fn, label, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(300); } throw Error('timeout: ' + label); };
(async () => {
  assert.ok(SOURCE, 'MSZ_SOURCE required'); fs.mkdirSync(OUT, { recursive: true });
  stageRuntime({ appDir: ROOT, source: path.join(SOURCE, 'release/v2.1.0/MishuTerminator-2.1.0.exe') });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-page-')), dataDir = path.join(root, 'data'), home = path.join(dataDir, 'company-assistant/meeting-room');
  const result = { root, checks: [], shots: [], realEngine: true, localMockOnly: true }, errors = [];
  let mock, hub, c, windowCheck;
  try {
    mock = spawn(path.join(SOURCE, '.venv/Scripts/python.exe'), [path.join(__dirname, 'fixtures/company-room-mock.py'), home, SOURCE], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    mock.stderr.on('data', x => errors.push(String(x)));
    await until(() => fs.existsSync(path.join(home, 'mock-ready.json')), 'mock startup');
    const info = JSON.parse(fs.readFileSync(path.join(home, 'mock-ready.json')));
    const bookings = async () => (await fetch(`http://127.0.0.1:${info.port}/__state`)).json();
    hub = await launchIsolatedHub({ entryPath: ROOT, dataDir, port: await port(), label: 'room-ui', windowMode: 'background', extraEnv: {
      ...(fs.existsSync(path.join(ROOT, 'community-edition.json')) ? {} : { CLAUDE_HUB_COMPANY_ASSISTANT: '1' }), CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures/welink-cli-standin.js'), MSZ_HUB_TEST_INSTANCE: 'room-ui-' + process.pid,
    } });
    // One-minute no-window audit for this Hub's exact descendant tree only.
    windowCheck = setTimeout(() => {
      try {
        const cmd = `$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${hub.pid}); do { $added=0; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added++}} } while($added -gt 0); Get-Process | Where-Object { $ids.Contains($_.Id) -and $_.Id -ne ${hub.pid} -and $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress`;
        result.windowAudit = execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }).trim() || 'no visible native windows';
      } catch (e) { result.windowAudit = e.message; }
    }, 60000);
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const wait = (expr, label, ms) => until(() => c.eval(expr).catch(() => false), label, ms);
    const click = async selector => {
      await wait(`${q(selector)} && !${q(selector)}.disabled`, 'enabled ' + selector);
      const box = await c.eval(`(() => { const e=${q(selector)}; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
    };
    const fill = async (selector, value) => { await click(selector); await c.eval(`${q(selector)}.select()`); await c.send('Input.insertText', { text: value }); };
    const shot = async name => { const f = path.join(OUT, `20261102-room-${name}-codex1.png`); fs.writeFileSync(f, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(f); };
    const persisted = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
    const status = () => JSON.parse(fs.readFileSync(path.join(home, 'hub-control/status.json')));
    await wait("!!document.getElementById('btn-company-rooms')", 'room navigation', 60000);
    await click('#btn-rules'); await click('#btn-company-rooms');
    await wait(`${q('[data-cr-slot="version"]')}?.textContent === '2.1.2'`, 'signed new adapter', 150000);
    await wait("document.getElementById('btn-company-rooms').getAttribute('aria-current') === 'page'", 'room nav current');
    assert.equal(await c.eval("(() => { const p=document.getElementById('rules-panel'); return !p || p.hidden || getComputedStyle(p).display === 'none'; })()"), true);
    assert.equal(await c.eval(`${q('[data-cr-slot="login"]')}.textContent`), '未检查');
    assert.deepEqual(await bookings(), []); result.checks.push('rules -> independent room tab, signed 2.1.2 ready, no booking on open, login unknown is not valid');
    await shot('01-overview');
    await click('[data-cr-tab="settings"]');
    await fill('[data-cr-field="抢订设置.最大重试次数"]', '7'); await click('[data-cr-op="save"]');
    await until(() => persisted().抢订设置.最大重试次数 === 7, 'first-use settings with zero rooms');
    assert.deepEqual(persisted().优先会议室, []);
    result.checks.push('first use: settings save with zero rooms; no placeholder room required');
    await click('[data-cr-tab="plan"]');
    await fill('[data-cr-field="主题"]', 'Hub 会议室验收');
    await fill('[data-cr-new-room]', '练秋湖F12-3-13R'); await click('[data-cr-op="add"]');
    await fill('[data-cr-new-room]', '备用会议室'); await click('[data-cr-op="add"]');
    await click('[data-cr-op="up"][data-index="1"]'); await click('[data-cr-op="down"][data-index="0"]');
    await c.eval(`(() => { const rows=document.querySelectorAll('[data-cr-room-row]'), data=new DataTransfer(); rows[0].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data})); rows[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()`);
    assert.equal(await c.eval(`${q('[data-cr-room-name="0"]')}.value`), '备用会议室');
    await click('[data-cr-op="down"][data-index="0"]');
    await click('[data-cr-tab="settings"]'); await click('[data-cr-tab="plan"]');
    assert.equal(await c.eval(`${q('[data-cr-field="主题"]')}.value`), 'Hub 会议室验收');
    await sleep(3400);
    assert.equal(await c.eval(`${q('[data-cr-field="主题"]')}.value`), 'Hub 会议室验收');
    await click('[data-cr-op="save"]');
    await until(() => persisted().主题 === 'Hub 会议室验收', 'GUI-thread save');
    assert.deepEqual(persisted().优先会议室, ['练秋湖F12-3-13R', '备用会议室']);
    result.checks.push('plan: add/reorder/rename draft survives tab switch and poll; signed adapter persists original config');
    await click('[data-cr-op="read-rooms"]');
    await wait(`${q('[data-cr-slot="room-picker"]')}?.textContent.includes('加入所选')`, 'real engine reads rooms', 90000);
    await click('[data-cr-found]:not(:disabled)'); await click('[data-cr-op="add-selected"]');
    assert.equal(await c.eval("document.querySelectorAll('[data-cr-room-name]').length"), 3);
    await click('[data-cr-op="delete"][data-index="2"]'); await click('[data-cr-op="save"]');
    result.checks.push('original engine reads real local webpage room list, checkboxes returned without Qt popup');
    await shot('02-plan');
    await click('[data-cr-tab="post"]'); await shot('03-post');
    await click('[data-cr-tab="settings"]');
    await fill('[data-cr-field="抢订设置.最大重试次数"]', '6'); await click('[data-cr-op="save"]');
    await until(() => persisted().抢订设置.最大重试次数 === 6, 'advanced settings saved');
    assert.equal(persisted().高级.无界面, true); assert.equal(persisted().系统.开机自动启动守护, false);
    await shot('04-settings');
    result.checks.push('advanced settings persist; runtime headless and Hub lifecycle settings remain intact');
    await click('[data-cr-tab="overview"]'); await click('[data-cr-op="test"]');
    await until(() => fs.existsSync(path.join(home, 'booking_history.json')) && JSON.parse(fs.readFileSync(path.join(home, 'booking_history.json'))).some(r => r.状态 === '测试'), 'real test fill', 90000);
    await until(() => !status().running, 'test completed'); assert.deepEqual(await bookings(), []);
    result.checks.push('UI test-fill runs original browser engine and writes test history, zero submitted bookings');
    await click('[data-cr-op="once"]');
    await until(async () => (await bookings()).length === 1, 'one real local mock booking', 150000);
    await until(() => !status().running, 'once exits');
    assert.equal((await bookings())[0].start, '14:00'); result.checks.push('UI immediately-book-once submits exactly once to local mock at configured time and exits');
    await click('[data-cr-op="start"]'); await until(() => status().running && status().mode === 'daemon', 'daemon started');
    await click('[data-cr-tab="plan"]'); await wait(`${q('[data-cr-field="主题"]')}.disabled`, 'rules locked while running');
    await click('[data-cr-tab="overview"]'); await click('[data-cr-op="pause"]'); await until(() => !status().running, 'daemon stopped');
    await wait(`${q('[data-cr-slot="side-status"]')}.textContent === '未启动'`, 'UI reflects stopped state');
    assert.equal((await bookings()).length, 1);
    result.checks.push('start daemon -> editing disabled -> stop -> idle; existing booking is not duplicated');
    await click('[data-cr-tab="history"]'); await wait(`${q('[data-cr-slot="history"]')}?.textContent.includes('成功')`, 'history visible'); await shot('05-history');
    await click('[data-cr-tab="logs"]'); await wait(`${q('[data-cr-slot="logs"]')}?.textContent.includes('Hub 会议室验收') || ${q('[data-cr-slot="logs"]')}?.textContent.length > 100`, 'live logs'); await shot('06-logs');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 680, deviceScaleFactor: 1, mobile: false });
    await click('[data-cr-tab="settings"]');
    const sizes = await c.eval(`(() => {const p=${q('#company-rooms-page')}, c=${q('[data-cr-slot="content"]')}, b=${q('[data-cr-op="save"]')}.getBoundingClientRect(); return {overflow:p.scrollWidth>p.clientWidth,scroll:c.scrollHeight>c.clientHeight,save:b.bottom<=innerHeight};})()`);
    assert.equal(sizes.overflow, false); assert.equal(sizes.scroll, true); assert.equal(sizes.save, true); await shot('07-short-screen');
    result.checks.push('1366x680: settings scroll, save remains visible, no horizontal overflow');
    await click('#btn-company-assistant'); assert.equal(await c.eval(`${q('#company-rooms-page')}.hidden`), true);
    await click('#btn-company-meeting'); await click('#btn-company-rooms'); assert.equal(await c.eval(`${q('#company-meeting-page')}.hidden`), true);
    await click('#btn-home'); assert.equal(await c.eval(`${q('#company-rooms-page')}.hidden`), true);
    await click('#btn-company-rooms');
    assert.equal(await c.eval("getReadingSurface().id"), 'company-rooms-page');
    await c.eval('escapeToHome()'); assert.equal(await c.eval(`${q('#company-rooms-page')}.hidden`), true);
    result.checks.push('room / assistant / recording meeting / home navigation closes old page without overlapping');
    result.ok = true;
  } catch (e) { result.ok = false; result.error = e.stack; process.exitCode = 1; }
  finally {
    clearTimeout(windowCheck);
    try {
      const file = path.join(home, 'hub-control/status.json');
      if (fs.existsSync(file)) { const helper = JSON.parse(fs.readFileSync(file)); const info = component.bundledRuntime(); const exe = component.runtimeCachePath({ dir: path.dirname(home) }, info.baseline);
        const actual = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(helper.pid)} -ErrorAction Stop).Path`], { windowsHide: true, encoding: 'utf8' }).trim();
        assert.equal(path.resolve(actual).toLowerCase(), path.resolve(exe).toLowerCase()); await component.killTree({ pid: helper.pid });
      }
    } catch (e) { result.teardownError = e.message; }
    if (hub) { fs.writeFileSync(path.join(OUT, '20261102-room-hub-codex1.log'), hub.log().join('\n')); await gracefulQuit(hub).catch(e => { result.quitError = e.message; }); }
    await c?.close(); if (mock?.exitCode == null) mock.kill(); result.mockErrors = errors;
    fs.writeFileSync(path.join(OUT, '20261102-room-evidence-codex1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, checks: result.checks.length, output: OUT, error: result.error, teardownError: result.teardownError }));
  }
})();
