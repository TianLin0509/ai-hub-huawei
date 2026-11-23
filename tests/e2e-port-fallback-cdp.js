'use strict';
// 真实隔离 Hub：在启动入口模拟保留端口，验证实际监听值、渲染进程和诊断。
// 故障只注入本测试子进程，不更改系统端口表，也不占用正在运行的 Hub。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rootDir = path.resolve(__dirname, '..');
const out = path.join(rootDir, 'artifacts', '20261123-port-fallback-codex-e2e');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function scenario(code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-port-fallback-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const personal = path.join(root, 'personal');
  fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: {
    xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 86400000,
  } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2' }));
  const command = path.join(root, 'codeagent.cmd'), router = path.join(root, 'codeagent-router.cjs');
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(rootDir, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`, 'utf8');
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const entry = path.join(root, 'port-entry.cjs');
  fs.writeFileSync(entry, `
const http = require('node:http');
const listen = http.Server.prototype.listen;
const code = ${JSON.stringify(code)};
http.Server.prototype.listen = function(port, ...args) {
  if (code && port >= 3456 && port <= 3475) {
    process.nextTick(() => this.emit('error', Object.assign(new Error('fixture bind denied'), { code })));
    return this;
  }
  return listen.call(this, port, ...args);
};
require('electron').app.setAppPath(${JSON.stringify(rootDir)});
require(${JSON.stringify(path.join(rootDir, 'main-bootstrap.js'))});
const { SessionManager } = require(${JSON.stringify(path.join(rootDir, 'core/session-manager.js'))});
const applyEnv = SessionManager.prototype._applyHubSessionEnv;
const sessionPorts = new Map();
SessionManager.prototype._applyHubSessionEnv = function(env, id) {
  applyEnv.call(this, env, id);
  sessionPorts.set(id, env.CLAUDE_HUB_PORT);
};
require('electron').ipcMain.handle('test:session-port', (_event, id) => sessionPorts.get(id));
`, 'utf8');
  let hub, cdp;
  const report = { mode: code || 'default', providerNetworkTested: false };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), entryPath: entry,
      label: `port-${code || 'default'}`, windowMode: 'hidden', extraEnv: {
        USERPROFILE: home, HOME: home, CLAUDE_HUB_HOME_DIR: home,
        CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
        AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: personal,
        AI_HUB_CODEAGENT_SERVE: '0', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      } });
    cdp = await connectFirstPage(hub);
    let status;
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      status = await cdp.eval(`require('electron').ipcRenderer.invoke('get-hook-status')`);
      if (status.up) break;
      await sleep(100);
    }
    assert.ok(status.up);
    assert.ok(status.port > 0);
    if (code) {
      assert.ok(status.port < 3456 || status.port > 3475);
      assert.match(status.message, code === 'EACCES' ? /系统保留或访问受限/ : /已被占用/);
      assert.ok(hub.log().some(line => line.includes(`已改用 ${status.port}`)));
    }
    const control = JSON.parse(fs.readFileSync(path.join(data, 'control', `${hub.pid}.json`), 'utf8'));
    assert.equal(control.hookPort, status.port);
    const diagnostic = await cdp.eval(`require('electron').ipcRenderer.invoke('harness:diagnosis', { ids: [] })`);
    assert.ok(diagnostic.text.includes(status.message));

    // 用真实成员终端注入环境，再用部署的 PowerShell hook 发回完成事件。
    const session = await cdp.eval(`require('electron').ipcRenderer.invoke('create-session', { kind: 'codeagent', opts: { cwd: ${JSON.stringify(root)}, codeagentAccount: 'personal' } })`);
    assert.ok(session.id, JSON.stringify(session));
    const memberPort = await cdp.eval(`require('electron').ipcRenderer.invoke('test:session-port', ${JSON.stringify(session.id)})`);
    assert.equal(memberPort, String(status.port));
    await cdp.eval(`window.__portHookSeen = []; require('electron').ipcRenderer.on('hook-event', (_e, event) => window.__portHookSeen.push(event));`);
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootDir, 'scripts/session-hub-hook.ps1'), 'stop'], {
        windowsHide: true, timeout: 10000, stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, CLAUDE_HUB_PORT: memberPort, CLAUDE_HUB_TOKEN: control.token, CLAUDE_HUB_SESSION_ID: session.id },
      });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`hook 退出 ${code}：${stderr}`)));
      child.stdin.end('{}');
    });
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      if (await cdp.eval(`window.__portHookSeen.some(e => e.sessionId === ${JSON.stringify(session.id)} && e.event === 'stop')`)) break;
      await sleep(100);
    }
    assert.ok(await cdp.eval(`window.__portHookSeen.some(e => e.sessionId === ${JSON.stringify(session.id)} && e.event === 'stop')`));
    report.port = status.port; report.message = status.message; report.passed = true;
  } catch (error) {
    report.error = error.stack; throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      report.teardown = await gracefulQuit(hub);
      fs.writeFileSync(path.join(out, `${code || 'default'}-hub.log`), hub.log().join('\n'), 'utf8');
    }
    fs.writeFileSync(path.join(out, `${code || 'default'}-result.json`), JSON.stringify(report, null, 2), 'utf8');
  }
  return report;
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const code of [null, 'EACCES', 'EADDRINUSE']) console.log(JSON.stringify(await scenario(code)));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
