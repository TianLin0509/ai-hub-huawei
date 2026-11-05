'use strict';
// Real isolated renderer and clicks; room service and account metadata are local fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..'), out = path.resolve(process.argv[2] || 'artifacts/onboarding-states-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function installFixture() {
  const ipc = require('electron').ipcRenderer, original = ipc.invoke.bind(ipc), now = Date.now();
  const account = (id, note, hours, renewable) => ({ id, note, state: 'ready', accountLabel: 'fixture-' + id, method: 'idaas', renewable, expiresAt: now + hours * 3600000,
    activeSessions: 0, models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', modelsAuthoritative: true, credit: { remaining: 800, total: 1000, pct: 80 } });
  const fixture = window.__onboardingFixture = { calls: [], rejected: [], now, rooms: {
    available: true, connected: true, capabilities: ['full-ui'], version: '2.1.2', running: false, loginState: null, loginNeeded: false,
    rules: { 主题: '界面验证会议', 开始时间: '14:00', 时长小时: 2, 时长分钟: 0, 优先会议室: [], 抢订日: [1, 2, 3, 4, 5] }, preferences: {}, history: [], pending: [], phases: {}, logs: '', cliAvailable: true,
  }, pool: { ok: true, accounts: [account('renewable', '三天后 · 可续期', 72, true), account('soon', '今天内 · 不能续期', 1, false), account('expired-renewable', '已过期 · 可续期', -48, true)], personal: account('personal', '三天后 · 不能续期', 72, false) } };
  ipc.invoke = async (channel, args = {}) => {
    if (channel.startsWith('company-assistant:')) {
      fixture.calls.push({ channel, args });
      const op = channel.slice('company-assistant:'.length);
      if (op === 'room-details' || op === 'room-status') return { ok: true, rooms: structuredClone(fixture.rooms) };
      if (op === 'room-command') {
        if (args.op === 'configure') Object.assign(fixture.rooms.rules, structuredClone(args.rules));
        else if (args.op === 'login') Object.assign(fixture.rooms, { loginState: true, loginNeeded: false, loginCheckedAt: new Date().toISOString() });
        else if (args.op === 'start') Object.assign(fixture.rooms, { running: true, mode: 'daemon' });
        else if (args.op === 'pause') Object.assign(fixture.rooms, { running: false });
        else { fixture.rejected.push(args.op); throw Error('External room action forbidden in fixture: ' + args.op); }
        return { ok: true, rooms: structuredClone(fixture.rooms) };
      }
      throw Error('Company operation forbidden in fixture: ' + op);
    }
    if (channel === 'codeagent-pool:list') return structuredClone(fixture.pool);
    if (channel === 'codeagent-pool:local') return { ok: true, candidates: [] };
    if (channel.startsWith('codeagent-pool:')) throw Error('Account action forbidden in fixture: ' + channel);
    return original(channel, args);
  };
}

function audit(pid) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(pid)],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, fixture: 'real isolated Hub renderer with synthetic room IPC and account metadata; no company network/login/model calls', checks: [], screenshots: [] };
  const save = () => fs.writeFileSync(path.join(out, 'onboarding-states-cdp.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-onboarding-states-')), dataDir = path.join(root, 'data');
    for (const dir of [dataDir, path.join(root, 'personal'), path.join(root, 'work'), path.join(root, 'scan')]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    result.testRoot = root;
    const launchedAt = Date.now();
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir, port: await freePort(), windowMode: 'hidden', label: 'onboarding-state-fixture', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake-codeagent.jsonl'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test', error: '离线界面测试' }, foreign: { ok: false, errorCode: 'offline_test', error: '离线界面测试' } }),
    } });
    result.pid = hub.pid; save();
    result.windowAudit = audit(hub.pid); result.windowAuditAfterMs = Date.now() - launchedAt;
    assert.deepEqual(result.windowAudit.visible, [], 'own process tree must have no visible windows'); save();
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const until = async (expr, label) => { for (const end = Date.now() + 20000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('Timeout: ' + label + '; ' + await c.eval(`document.querySelector('[data-cr-slot=message]')?.textContent || ''`)); };
    const click = async selector => {
      let point;
      await until(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.hidden})()`, 'enabled ' + selector);
      point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!(hit===e||e.contains(hit)))throw Error('occluded '+${JSON.stringify(selector)});return{x,y}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const fill = async (selector, text) => { await click(selector); await c.eval(`document.querySelector(${JSON.stringify(selector)}).select()`); await c.send('Input.insertText', { text }); };
    const widths = async (label, selectors) => {
      for (const width of [1440, 1280]) {
        await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await until(`Array.from(document.querySelectorAll('.cr-seg button')).every(e=>e.getAnimations().every(a=>a.playState==='finished'))`, 'room navigation transition');
        await c.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        assert.deepEqual(await c.eval(`${JSON.stringify(selectors)}.filter(s=>{const e=document.querySelector(s);return e&&e.clientWidth&&e.scrollWidth>e.clientWidth+2})`), [], 'overflow ' + label + ' ' + width);
        if (label === '01-rooms-first-use') {
          const buttons = await c.eval(`Array.from(document.querySelectorAll('[data-cr-slot=first-use] button')).map(e=>({text:e.textContent,width:e.getBoundingClientRect().width,parentWidth:e.parentElement.getBoundingClientRect().width}))`);
          assert.equal(buttons.length, 2); assert.ok(buttons.every(b => b.width < 240 && b.width < b.parentWidth * 0.7), 'first-use buttons fit content');
          (result.firstUseButtons ||= []).push({ width, buttons });
        }
        const file = `${label}-${width}.png`, shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, file), Buffer.from(shot.data, 'base64')); result.screenshots.push(file);
      }
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    };
    await until('!!document.getElementById("btn-company-rooms") && !!document.getElementById("btn-rail-accounts")', 'navigation');
    await c.eval('(' + installFixture.toString() + ')()');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await click('#btn-company-rooms');
    await until(`document.querySelector('[data-cr-slot=first-use]')?.textContent.includes('还差 2 步')`, 'first-use checklist');
    assert.ok(await c.eval(`document.querySelector('[data-cr-op=start]').disabled`));
    await widths('01-rooms-first-use', ['#company-rooms-page', '.cr-sheet', '.cr-content']);
    result.checks.push('U4 empty plan and unknown login show two required steps; guard disabled');
    await click('.cr-side [data-cr-op=plan]');
    await until(`document.activeElement?.matches('[data-cr-new-room]')`, 'plan focus');
    await fill('[data-cr-new-room]', '验证专用会议室'); await click('[data-cr-op=add]');
    await until(`document.querySelector('[data-cr-room-name]')?.value==='验证专用会议室'`, 'added room');
    await click('[data-cr-op=save]');
    await until(`__onboardingFixture.rooms.rules.优先会议室[0]==='验证专用会议室'`, 'saved room');
    await click('[data-cr-tab=overview]');
    await until(`document.querySelector('[data-cr-slot=first-use]').textContent.includes('登录尚未检查') && !document.querySelector('[data-cr-op=start]').disabled`, 'unknown login may auto-check');
    assert.equal(await c.eval(`__onboardingFixture.calls.filter(c=>c.args.op==='login').length`), 0);
    await widths('02a-rooms-restarted-unchecked', ['#company-rooms-page', '.cr-sheet', '.cr-content']);
    await click('[data-cr-op=start]');
    await until(`__onboardingFixture.rooms.running && !document.querySelector('[data-cr-op=pause]').hidden`, 'guard starts without login browser');
    assert.equal(await c.eval(`__onboardingFixture.calls.filter(c=>c.args.op==='login').length`), 0);
    await click('[data-cr-op=pause]');
    await until(`!__onboardingFixture.rooms.running && !document.querySelector('[data-cr-op=start]').hidden`, 'stopped fixture guard');
    await c.eval(`Object.assign(__onboardingFixture.rooms,{loginState:false,loginNeeded:true})`);
    await click('#btn-rail-accounts'); await click('#btn-company-rooms');
    await until(`document.querySelector('[data-cr-op=start]').disabled && document.querySelector('[data-cr-op=once]').disabled`, 'explicit login failure blocks booking');
    await widths('02b-rooms-login-expired', ['#company-rooms-page', '.cr-sheet', '.cr-content']);
    result.checks.push('U4 saved plan with unknown login starts guard without login; explicit login failure blocks start/once');
    await click('.cr-side [data-cr-op=login]');
    await until(`document.querySelector('[data-cr-slot=first-use]').hidden && !document.querySelector('[data-cr-op=start]').disabled`, 'ready to guard');
    assert.ok(await c.eval(`document.querySelector('[data-cr-op=start]').classList.contains('cr-btn-pri')`));
    await widths('02-rooms-ready', ['#company-rooms-page', '.cr-sheet', '.cr-content']);
    result.checks.push('U4 real clicks: plan input focused, room added/saved, fixture login checked, checklist hidden and primary guard restored');
    await click('[data-cr-tab=plan]'); await fill('[data-cr-field="主题"]', ''); await click('[data-cr-tab=overview]');
    await click('[data-cr-op=start]');
    await until(`document.activeElement?.matches('[data-cr-new-room]') && document.querySelector('[data-cr-slot=message]').textContent.includes('会议主题')`, 'invalid plan redirects and focuses');
    assert.equal(await c.eval(`__onboardingFixture.calls.filter(c=>c.channel==='company-assistant:room-command'&&c.args.op==='start').length`), 1, 'invalid plan must not send another start');
    await widths('03-rooms-invalid-plan', ['#company-rooms-page', '.cr-sheet', '.cr-content']);
    result.checks.push('U4 invalid draft redirects to plan and focuses room input without sending start');
    await click('#btn-rail-accounts');
    await until(`!!document.querySelector('[data-ca-account=expired-renewable]')`, 'account rows');
    result.accountText = await c.eval(`Object.fromEntries(['personal','renewable','soon','expired-renewable'].map(id=>{const row=document.querySelector('[data-ca-account="'+id+'"]'),e=row.querySelector('.caa-status-cell .caa-cell-sub');return[id,{text:e.textContent,warning:e.classList.contains('caa-warn'),color:getComputedStyle(e).color}]}))`);
    assert.match(result.accountText.personal.text, /\d{2}-\d{2} \d{2}:\d{2} 到期/); assert.equal(result.accountText.personal.warning, false);
    assert.equal(result.accountText.renewable.text, '会自动续期'); assert.equal(result.accountText.renewable.warning, false);
    assert.match(result.accountText.soon.text, /\d{2}:\d{2} 到期/); assert.equal(result.accountText.soon.warning, true); assert.equal(result.accountText.soon.color, 'rgb(232, 120, 12)');
    assert.equal(result.accountText['expired-renewable'].text, '会自动续期'); assert.equal(result.accountText['expired-renewable'].warning, false);
    await widths('04-account-expiry', ['#codeagent-accounts-page', '.caa-page', '.caa-list']);
    result.checks.push('U2 personal expiry includes date; renewable future/past credentials show auto renewal; only nonrenewable within 24h is orange');
    result.calls = await c.eval('__onboardingFixture.calls'); assert.deepEqual(await c.eval('__onboardingFixture.rejected'), []);
    result.finalWindowAudit = audit(hub.pid); assert.deepEqual(result.finalWindowAudit.visible, []);
    result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {}
  } finally {
    try { if (hub) result.teardown = await gracefulQuit(hub); } catch (error) { result.teardownError = error.message; result.passed = false; process.exitCode = 1; }
    if (c) await c.close(); save(); console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error, windowAuditAfterMs: result.windowAuditAfterMs, teardown: result.teardown }));
  }
})();
