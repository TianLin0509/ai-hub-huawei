'use strict';
// Real hidden Electron renderer and mouse; IPC is intercepted before it can run npm.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/dsh-repair-e2e');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let hub, c;
const result = { passed: false, checks: [] };
(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dsh-repair-'));
    for (const dir of ['data', 'work', 'personal', 'scan']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'data/optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'dsh-repair',
      ...(process.env.AI_HUB_TEST_ELECTRON ? { executablePath: process.env.AI_HUB_TEST_ELECTRON } : {}), extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '0', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: '1', CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test' }, foreign: { ok: false, errorCode: 'offline_test' } }),
    } });
    result.pid = hub.pid;
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    for (const end = Date.now() + 20000; !(await c.eval('!!document.body && !!window.HubErrorCard'));) {
      if (Date.now() > end) throw new Error('Renderer error-card interface was not ready');
      await _waitMs(100);
    }
    await c.eval(`(() => {
      const ipc = require('electron').ipcRenderer, orig = ipc.invoke.bind(ipc);
      window.__repairFixture = { calls: [], pending: null };
      ipc.invoke = (channel, request) => {
        if (channel !== 'cli-tools:install') return orig(channel, request);
        window.__repairFixture.calls.push({ channel, request });
        return new Promise(resolve => window.__repairFixture.pending = resolve);
      };
      require('../renderer/hub-error-card').install({ document, window, ipcRenderer: ipc });
      const host = document.createElement('div'); host.id = 'dsh-repair-case';
      host.style.cssText = 'position:fixed;inset:100px 240px auto 240px;z-index:2147483647;background:white;padding:24px;color:#222';
      host.innerHTML = window.HubErrorCard.html({ area:'session-create', title:'DSH 启动失败', details:"Cannot find package '@deepseek-ai/dsh-user-questions'" });
      document.body.append(host);
    })()`);
    const button = '#dsh-repair-case [data-hub-err-act="known:dsh-repair"]';
    const click = async () => {
      const p = await c.eval(`(() => { const e=document.querySelector(${JSON.stringify(button)}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
    };
    for (const width of [1440, 1280]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await _waitMs(100);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'repair-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
    await click(); await _waitMs(50); await click();
    assert.deepEqual(await c.eval('window.__repairFixture.calls'), [{ channel: 'cli-tools:install', request: { id: 'dsh', repair: true } }]);
    assert.equal(await c.eval(`document.querySelector(${JSON.stringify(button)}).disabled`), true);
    result.checks.push('实际鼠标点击进入配套包修复，处理中防连点，IPC 不执行全局安装');
    await c.eval('window.__repairFixture.pending({ ok: true })'); await _waitMs(50);
    assert.match(await c.eval(`document.querySelector(${JSON.stringify(button)}).textContent`), /已修复/);
    result.checks.push('模拟安装完成后明确提示重新新建会话');
    result.passed = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true }).catch(error => { result.quitError = error.message; process.exitCode = 1; });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result));
  }
})();
