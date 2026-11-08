'use strict';
// Isolated real renderer/mouse, deterministic component and install responses; no corporate/network login.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/20261107-components-e2e-codex1');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function fixture() {
  const electron = require('electron'), ipc = electron.ipcRenderer, original = ipc.invoke.bind(ipc);
  const state = window.__componentFixture = { calls: [], installed: new Set(), checks: 0, pending: null, failDoctor: true };
  electron.shell.openExternal = async () => { throw Error('External open blocked in isolated test'); };
  electron.shell.openPath = async () => { throw Error('External open blocked in isolated test'); };
  ipc.invoke = async (channel, args = {}) => {
    if (channel === 'env-check:run') {
      state.checks++;
      const names = { codeagent: 'CodeAgent', claude: 'Claude Code', codex: 'Codex', dsh: 'DSH', 'git-bash': 'Git Bash', welink: 'welink-cli', 'ppt-doctor': 'PPT Doctor', node: 'Node.js', 'company-proxy': '公司模型反代' };
      const items = Object.entries(names).map(([id, name]) => ({ id, name, status: state.installed.has(id) || ['codeagent', 'node'].includes(id) ? 'ok' : 'warn',
        detail: state.installed.has(id) ? '已安装，检测通过' : id === 'company-proxy' ? '公司模型初始化尚未完成，请检查 CodeAgent 登录' : '尚未安装；按需安装后即可继续',
        fixes: [{ label: '重新检测', act: 'recheck' }], steps: ['安装完成后自动重新检测'] }));
      return { ok: true, items, features: require('../core/feature-readiness').featureReadiness(items), counts: { ok: 2, warn: 7 }, ms: 24, report: 'Fixture check' };
    }
    if (channel === 'cli-tools:state') return { available: true, tools: {}, busy: null };
    if (channel === 'components:state') return { doctor: { phase: 'idle' } };
    if (channel === 'cli-tools:install') {
      state.calls.push({ channel, args });
      ipc.emit('cli-tools:state', {}, { available: true, busy: args.id, tools: { [args.id]: { phase: 'downloading', received: 50, total: 100, etaSec: 3 } } });
      await new Promise(resolve => { state.pending = resolve; });
      state.installed.add(args.id);
      return { ok: true, state: { available: true, busy: null, tools: { [args.id]: { phase: 'done' } } } };
    }
    if (channel === 'components:doctor-install') {
      state.calls.push({ channel });
      if (state.failDoctor) return { ok: false, error: '校验失败，原安装未更改', state: { phase: 'error', error: '校验失败，原安装未更改' } };
      state.installed.add('ppt-doctor'); return { ok: true, state: { phase: 'done', message: '已安装并接入' } };
    }
    if (/^(env-check:fix|cli-tools:cancel|components:doctor-cancel)$/.test(channel)) { state.calls.push({ channel }); return { ok: true }; }
    if (/open-external|open-path|login|install-provider/.test(channel)) throw Error('External action blocked');
    return original(channel, args);
  };
}
const result = { passed: false, checks: [], screenshots: [] };
let hub, c;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hub-components-'));
    result.isolation = root;
    for (const dir of ['data', 'work', 'personal', 'scan']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'data/optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'components-ui', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_CODEAGENT_POOL_LOGIN_FIXTURE: '1', CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test' }, foreign: { ok: false, errorCode: 'offline_test' } }),
    } });
    result.pid = hub.pid;
    const audit = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/component-window-audit.ps1'), '-RootProcessId', String(hub.pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
    result.initialAudit = audit(); assert.deepEqual(result.initialAudit.visible, []);
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const until = async expr => { for (const end = Date.now() + 20000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing or disabled element');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!r.width||!r.height||!(h===e||e.contains(h)))throw Error('Occluded element');return{x,y}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shots = async label => {
      for (const width of [1440, 1280]) {
        await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await _waitMs(150);
        const overflow = await c.eval(`(()=>{const e=document.querySelector('.ec-body');return e.scrollWidth>e.clientWidth+1})()`); assert.equal(overflow, false);
        const file = `20261107-${label}-${width}-codex1.png`;
        fs.writeFileSync(path.join(out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.screenshots.push(file);
      }
    };
    await until('!!window.__envCheck');
    await c.eval('(' + fixture.toString() + ')()');
    // Enter through the actual settings menu item, after exposing its parent menu.
    await c.eval(`document.getElementById('options-menu').style.display='block'`);
    await click('#options-env-check'); await until(`document.querySelector('#env-check-dialog')?.open && document.querySelectorAll('.ec-dependency').length>0`);
    await shots('components-features');
    assert.match(await c.eval(`document.querySelector('.ec-body').textContent`), /公司模型初始化尚未完成/);
    await click('[data-ec-component="claude"]'); await until(`document.querySelector('[data-ec-tab="components"]').getAttribute('aria-selected')==='true'`);
    await shots('components-missing');
    await click('[data-ec-install="claude"]'); await until('!!__componentFixture.pending');
    assert.ok(await c.eval(`!!document.querySelector('[data-ec-cancel="claude"]')`));
    await shots('components-downloading');
    const before = await c.eval('__componentFixture.checks');
    await c.eval('__componentFixture.pending()'); await until(`__componentFixture.checks>${before} && document.querySelector('[data-ec-id="claude"]').textContent.includes('检测通过')`);
    result.checks.push('真实鼠标：功能依赖跳组件、安装进度、完成自动复检');
    await click('[data-ec-install="ppt-doctor"]'); await until(`document.querySelector('.ec-body').textContent.includes('校验失败')`);
    await shots('components-retry');
    await c.eval('__componentFixture.failDoctor=false'); await click('[data-ec-install="ppt-doctor"]');
    await until(`document.querySelector('[data-ec-id="ppt-doctor"]').textContent.includes('检测通过')`);
    result.checks.push('PPT 安装失败可重试，成功自动接入并复检（安装响应为本地fixture）');
    await click('[data-ec-tab="environment"]'); await shots('components-environment');
    result.audit = audit();
    assert.deepEqual(result.audit.visible, []); result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try {
      result.failureState = await c.eval(`({open:document.querySelector('#env-check-dialog')?.open,result:window.__envCheck?.result(),text:document.body.innerText.slice(-5000),fixture:window.__componentFixture?{checks:__componentFixture.checks,calls:__componentFixture.calls}:null})`);
      fs.writeFileSync(path.join(out, '20261107-components-failure-codex1.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    } catch (e) { result.captureError = e.message; }
  }
  finally {
    if (hub) { try { result.teardown = await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; process.exitCode = 1; } }
    if (c) await c.close();
    fs.writeFileSync(path.join(out, '20261107-components-e2e-codex1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})();
