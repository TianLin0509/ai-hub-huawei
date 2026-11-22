'use strict';
// 隔离 Hub 中使用真实 DOM 和鼠标，额度来自本地夹具，不访问账号或模型服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'artifacts', '20261123-r10-small-quota-codex');
const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r10-small-'));
  let hub, cdp, failure;
  const evidence = { checks: [], providerNetworkTested: false };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(base, 'data'), port: await freePort(), label: 'r10-small-quota',
      extraEnv: { AI_HUB_CODEAGENT_SERVE: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', CLAUDE_HUB_CODEAGENT_QUOTA_AUTO_MS: '0' } });
    evidence.pid = hub.pid;
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.eval("document.readyState === 'complete' ? true : new Promise(resolve => window.addEventListener('load', () => resolve(true), { once: true }))");
    await cdp.eval(`(async () => {
      const { createCodeAgentQuotaPanel } = require(${JSON.stringify(path.join(repo, 'renderer/codeagent-quota-panel.js'))});
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;z-index:3000;background:var(--hw-bg,#f4f5f7);padding:40px;font:16px Microsoft YaHei';
      cover.textContent = '成员版额度栏 · 本地交互验收'; document.body.append(cover);
      const root = document.createElement('aside'); root.className = 'account-quota-panel';
      root.style.cssText = 'position:absolute;right:20px;top:65px;bottom:25px;margin:0;'; cover.append(root);
      const d = { createElement: tag => document.createElement(tag), body: document.body, defaultView: window,
        addEventListener: (...a) => document.addEventListener(...a), removeEventListener: (...a) => document.removeEventListener(...a),
        get activeElement() { return document.activeElement; } };
      const fixture = window.r10 = { root, clock: Date.parse('2026-11-23T01:00:00Z'), calls: [],
        snapshot: { ok: true, serveEnabled: true, rows: Array.from({ length: 30 }, (_, i) => ({ id: 'fixture-' + i, label: '测试账号 ' + (i + 1), state: 'ready',
          usage: { models: [{ name: '示例模型', day: { used: '1M', total: '10M', pct: 10 + i }, hour: { used: '1K', total: '10K', pct: 10 }, min: { used: '1', total: '10', pct: 10 } }],
            at: Date.parse('2026-11-23T00:59:00Z') } })) } };
      localStorage.setItem('hubClaudeQuotaPanel', JSON.stringify({ collapsed: false }));
      localStorage.removeItem('hubCodeAgentQuotaHidden');
      fixture.options = { document: d, window, root, storage: localStorage, now: () => fixture.clock,
        setIntervalFn: () => 0, clearIntervalFn() {}, ipcRenderer: { on() {}, removeListener() {}, invoke: async (name, payload) => {
          fixture.calls.push({ name, payload }); return name === 'community:setup' ? { providers: [{ id: 'codeagent', installed: true }] } : fixture.snapshot;
        } } };
      fixture.create = () => createCodeAgentQuotaPanel(fixture.options);
      fixture.panel = fixture.create(); await fixture.panel.whenIdle();
      fixture.list = root.querySelector('.qp-list'); fixture.rail = root.querySelector('.qp-rail'); fixture.list.scrollTop = 240;
      return true;
    })()`);
    assert.equal(await cdp.eval("r10.root.querySelector('.qp-cap').textContent.trim()"), '90%');
    const geometry = await cdp.eval(`(() => { const e=r10.list, r=e.getBoundingClientRect(), h=e.clientHeight*e.clientHeight/e.scrollHeight;
      return { x:r.right-3, y:r.top+e.scrollTop/(e.scrollHeight-e.clientHeight)*(e.clientHeight-h)+h/2, scroll:e.scrollTop }; })()`);
    assert.equal(geometry.scroll, 240);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y });
    assert.deepEqual(await cdp.eval(`(async()=>{r10.clock+=60000; await r10.panel.reload();return {same:r10.list===r10.root.querySelector('.qp-list'),rail:r10.rail===r10.root.querySelector('.qp-rail'),scroll:r10.list.scrollTop};})()`), { same: true, rail: true, scroll: 240 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, button: 'left', x: geometry.x, y: geometry.y + 50 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y + 50 });
    evidence.dragScroll = await cdp.eval('r10.list.scrollTop');
    assert.ok(evidence.dragScroll > 240, '刷新后仍可继续拖动原滚动条');
    evidence.checks.push('刷新保留列表和细栏滚动容器，拖动刷新后继续生效');
    async function rightClick(selector) {
      const point = await cdp.eval(`(()=>{const e=r10.root.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point });
    }
    await cdp.eval('(async()=>{r10.snapshot.rows=r10.snapshot.rows.slice(0,3);await r10.panel.reload();})()');
    for (let i = 0; i < 3; i++) await rightClick('.qp-row');
    assert.equal(await cdp.eval('r10.panel.view().rows.length'), 0);
    assert.equal(await cdp.eval('r10.root.hidden'), false);
    assert.equal(await cdp.eval('r10.snapshot.rows.length'), 3);
    await cdp.eval('(async()=>{r10.panel.destroy();r10.panel=r10.create();await r10.panel.whenIdle();})()');
    assert.equal(await cdp.eval('r10.panel.view().rows.length'), 0);
    await rightClick('.qp-h h3');
    assert.equal(await cdp.eval('r10.panel.view().rows.length'), 3);
    assert.equal(await cdp.eval('r10.calls.some(c=>c.payload?.refresh)'), false);
    evidence.checks.push('鼠标右键隐藏全部账号、重建后保持、右键标题恢复；不改账号也不触发额度请求');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, '20261123-r10-small-quota-codex.png'), Buffer.from(shot.data, 'base64'));
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = error.stack;
    failure = error;
  } finally {
    await cdp?.close();
    try { if (hub) evidence.exit = await gracefulQuit(hub, { captureDiagnostics: true }); }
    catch (error) {
      evidence.ok = false; evidence.teardownError = error.stack;
      evidence.teardownDiagnostics = error.cdpOwnershipDiagnostics;
      failure ||= error;
    }
    fs.writeFileSync(path.join(out, '20261123-r10-small-quota-codex.json'), JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
  console.log(JSON.stringify(evidence));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
