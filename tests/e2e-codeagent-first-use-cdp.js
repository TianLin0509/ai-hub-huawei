'use strict';
// Real hidden Hub and mouse clicks, with a synthetic CLI file and credential-free saved account.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/codeagent-first-use');
const repo = path.resolve(__dirname, '..');
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
function windows(pid) {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-first-use-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  for (const dir of [data, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const savedAccount = require('../core/codeagent-pool').addAccount(data, { note: '保留的测试号' });
  const command = path.join(root, 'codeagent-fixture.cmd'), welink = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false,loggedIn:false}));');
  const result = { passed: false, root, checks: [], screenshots: [], windowAudits: [], realModel: false, realCredentials: false, companyRequests: false, egressProbe: 'local fixture', rendererNetwork: 'HTTP(S) blocked' };
  const save = () => fs.writeFileSync(path.join(out, 'first-use.json'), JSON.stringify(result, null, 2));
  let hub, c, timer, auditError;
  const audit = () => { const record = windows(hub.pid); result.windowAudits.push(record); save(); assert.deepEqual(record.visible, [], 'isolated Hub must not create visible windows'); };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await port(), windowMode: 'hidden', label: 'CodeAgent first use', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test', error: '离线界面测试' }, foreign: { ok: false, errorCode: 'offline_test', error: '离线界面测试' } }),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
    } });
    result.pid = hub.pid; save();
    timer = setTimeout(() => { try { audit(); } catch (error) { auditError = error; } }, 45000);
    c = await connectFirstPage(hub); audit();
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const wait = async (expression, name) => { for (const end = Date.now() + 30000; Date.now() < end;) { if (auditError) throw auditError; if (await c.eval(expression)) return; await _waitMs(120); } throw Error('timeout: ' + name); };
    const click = async selector => {
      await wait(`(()=>{const e=${q(selector)};if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width>0&&r.height>0;})()`, selector);
      const xy = await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(h===e||e.contains(h)))throw Error('covered: '+${JSON.stringify(selector)});return{x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const shot = async name => { await _waitMs(150); const data = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data.data, 'base64')); result.screenshots.push(name + '.png'); save(); };
    const guide = async () => wait(`${q('#codeagent-install-guide')}?.open`, 'bundled guide');
    const closeGuide = async () => { await click('#codeagent-install-guide .company-api-close'); await wait(`!${q('#codeagent-install-guide')}`, 'guide closed'); };
    const home = async () => { if (await c.eval(`${q('#new-session-menu')}?.style.display!=='none' && !!${q('#new-session-close')}?.offsetWidth`)) await click('#new-session-close'); await click('#btn-home'); await wait(`${q('#home-create-session')}?.offsetWidth>0`, 'home'); };
    await wait(`!!window.LaunchCenter && ${q('[data-provider="codeagent"]')}?.dataset.installed==='0'`, 'missing CLI');
    const initialSessions = await c.eval(`ipcRenderer.invoke('get-sessions')`);
    const guard = await c.eval(`ipcRenderer.invoke('codeagent-pool:personal-login')`);
    assert.equal(guard.ok, false); assert.match(guard.error, /CodeAgent 未安装/);
    assert.deepEqual(await c.eval(`ipcRenderer.invoke('get-sessions')`), initialSessions);
    result.loginGuard = guard; result.checks.push('Missing CLI login IPC rejects before terminal spawn; no session created (spawn suppression also covered by unit test)');
    for (const width of [1440, 1280]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await home(); await shot(`${width}-missing-home`);
      await click('[data-provider="codeagent"] button'); await guide();
      assert.match(await c.eval(`${q('#codeagent-install-guide')}.textContent`), /说明已随 Hub 安装/);
      assert.doesNotMatch(await c.eval(`${q('#codeagent-install-guide')}.textContent`), /AI_HUB_CODEAGENT_COMMAND/);
      await shot(`${width}-bundled-guide`); await closeGuide();
      await click('#community-guide'); await guide(); await closeGuide();
      await click('#home-create-session'); await click('.new-session-option[data-kind="codeagent"]');
      await wait(`${q('#new-session-submit')}?.textContent==='查看安装说明'`, 'install action');
      assert.match(await c.eval(`${q('.new-session-option[data-kind="codeagent"]')}.textContent`), /未安装/);
      assert.equal(await c.eval(`${q('#new-session-codeagent-account-field')}.hidden`), true);
      assert.match(await c.eval(`${q('#new-session-codeagent-account-note')}.textContent`), /CodeAgent 未安装/);
      assert.doesNotMatch(await c.eval(`${q('#new-session-codeagent-account-note')}.textContent`), /仍可创建会话|需登录/);
      await shot(`${width}-missing-launch`); await click('#new-session-submit'); await guide(); await closeGuide(); await home();
      await wait(`${q('.qp')}?.textContent.includes('CodeAgent 未安装')`, 'missing quota');
      const folded = await c.eval(`${q('.qp')}.classList.contains('is-collapsed')`);
      await click(folded ? '.qp-rail [data-qp-action="install-guide"]' : '.qp-f [data-qp-action="install-guide"]'); await guide(); await closeGuide();
      await click('#btn-rail-accounts'); await wait(`${q('#codeagent-accounts-page')}?.textContent.includes('未检测到 CodeAgent')`, 'missing account');
      assert.equal(await c.eval(`${q('#codeagent-accounts-page [data-ca="login"]:not(:disabled)')}`), null);
      assert.match(await c.eval(`${q('#codeagent-accounts-page')}.textContent`), /保留的测试号/);
      assert.match(await c.eval(`${q('.caa-me-card')}.textContent`), /未检测到 CodeAgent/);
      assert.doesNotMatch(await c.eval(`${q('.caa-me-card')}.textContent`), /需登录|个人账号尚未登录|还没登录/);
      assert.equal(await c.eval(`${q('[data-ca-account="' + savedAccount + '"]')}?.dataset.caAccount`), savedAccount);
      await shot(`${width}-missing-accounts`); await click('[data-ca="install-guide"]'); await guide(); await closeGuide();
      result.checks.push(`${width}: homepage both guide entries, launch install action, quota guide and account guide use real mouse clicks`); save();
    }
    // File appearance is the only change: the next real setup call sees it.
    fs.writeFileSync(command, '@echo off\r\necho 1.26.15\r\nexit /b 0\r\n');
    await click('[data-ca="check-install"]');
    await wait(`!${q('#codeagent-accounts-page')}?.textContent.includes('未检测到 CodeAgent') && !!${q('#codeagent-accounts-page [data-ca="login"]:not(:disabled)')}`, 'account recovery');
    await wait(`${q('[data-provider="codeagent"]')}?.dataset.installed==='1' && !${q('.qp')}?.textContent.includes('CodeAgent 未安装')`, 'shared state recovery');
    result.checks.push('Real file discovery changes installed status; one recheck updates homepage, accounts and quota together');
    for (const width of [1440, 1280]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await shot(`${width}-installed-accounts`); await home(); await shot(`${width}-installed-home`);
      await click('#home-create-session'); await click('.new-session-option[data-kind="codeagent"]');
      await wait(`${q('#new-session-submit')}?.textContent==='创建会话'`, 'launch recovery');
      assert.equal(await c.eval(`${q('#new-session-codeagent-account-field')}.hidden`), false);
      assert.equal(await c.eval(`${q('.new-session-option[data-kind="codeagent"] .company-cli-status')}?.hidden`), true);
      await shot(`${width}-installed-launch`); await home(); await click('#btn-rail-accounts');
    }
    assert.deepEqual(await c.eval(`ipcRenderer.invoke('get-sessions')`), initialSessions, 'No installed CLI session/login was started');
    audit(); result.passed = true; save();
  } catch (error) {
    result.error = error.stack; save();
    if (c) try { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(image.data, 'base64')); } catch {}
    process.exitCode = 1;
  } finally { clearTimeout(timer); if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub); save(); }
  process.stdout.write(JSON.stringify({ passed: result.passed, checks: result.checks.length, out, error: result.error || null }) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
