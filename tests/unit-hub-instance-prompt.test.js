'use strict';
// 多开 Hub 提示（core/hub-instance-prompt.js，体验 7）。用临时数据目录 + 真本机 HTTP 服务模拟「先开的 Hub」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const prompt = require('../core/hub-instance-prompt');

function tmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-multi-open-'));
  fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
  return dir;
}
function writeControl(dataDir, info) {
  fs.writeFileSync(path.join(dataDir, 'control', `${info.pid}.json`), JSON.stringify(info));
}
async function fakeHub({ token = 'tok', shuttingDown = false, focusOk = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push(parsed.action);
      if (req.url !== prompt.ROUTE) { res.writeHead(404); res.end('{}'); return; }
      if (parsed.token !== token) { res.writeHead(403); res.end('{}'); return; }
      if (parsed.action === 'focus') {
        if (shuttingDown || !focusOk) { res.writeHead(503); res.end(JSON.stringify({ ok: false, shuttingDown })); return; }
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true, shuttingDown, startedAt: 1000 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}
const alive = () => true;
const quiet = { warn() {}, log() {} };

test('没有别的 Hub：不弹窗', async () => {
  const dataDir = tmpDataDir();
  let asked = 0;
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet,
    showMessageBox: async () => { asked += 1; return { response: 0 }; } });
  assert.equal(r.action, 'none');
  assert.equal(asked, 0);
});

test('只有自己的控制文件、或别的进程已死：不算在运行', () => {
  const dataDir = tmpDataDir();
  writeControl(dataDir, { pid: 1, hookPort: 1, token: 't' });
  writeControl(dataDir, { pid: 2, hookPort: 2, token: 't' });
  assert.deepEqual(prompt.listOtherInstances({ dataDir, selfPid: 1, isAlive: (pid) => pid === 1 }), []);
});

test('别的 Hub 在运行：问「切过去？」，选切过去 → 请求它到前台并退出本实例', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub();
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'tok', startedAt: 1 });
  let options = null; let quit = 0;
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet, now: 1000 + 5 * 60000,
    showMessageBox: async (o) => { options = o; return { response: 0, checkboxChecked: false }; }, quit: () => { quit += 1; } });
  await hub.close();
  assert.equal(r.action, 'switched');
  assert.equal(quit, 1);
  assert.deepEqual(hub.seen, ['ping', 'focus']);
  assert.equal(options.message, 'AI Hub 已在运行，切过去？');
  assert.deepEqual(options.buttons, ['切过去', '再开一个']);
  assert.match(options.detail, /5 分钟前打开/);
});

test('选「再开一个」：不退出、不请求切换；勾了不再提示就记下', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub();
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'tok' });
  let quit = 0; let suppressed = 0;
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet,
    showMessageBox: async () => ({ response: 1, checkboxChecked: true }), quit: () => { quit += 1; }, setSuppressed: () => { suppressed += 1; } });
  await hub.close();
  assert.equal(r.action, 'stay');
  assert.equal(quit, 0);
  assert.equal(suppressed, 1);
  assert.deepEqual(hub.seen, ['ping']);
});

test('先开的 Hub 正在退出（更新重启、远程重启的老进程）：不弹窗', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub({ shuttingDown: true });
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'tok' });
  let asked = 0;
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet,
    showMessageBox: async () => { asked += 1; return { response: 0 }; } });
  await hub.close();
  assert.equal(r.action, 'none');
  assert.equal(asked, 0);
});

test('控制文件在、端口没人应（端口已关）：不弹窗', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub();
  const port = hub.port; await hub.close();
  writeControl(dataDir, { pid: 4242, hookPort: port, token: 'tok' });
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet, timeoutMs: 500,
    showMessageBox: async () => ({ response: 0 }) });
  assert.equal(r.action, 'none');
});

test('令牌对不上（端口被别的程序复用）：不弹窗', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub({ token: 'right' });
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'wrong' });
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet,
    showMessageBox: async () => ({ response: 0 }) });
  await hub.close();
  assert.equal(r.action, 'none');
});

test('切换请求被拒：本实例不退出，返回 switch-failed', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub({ focusOk: false });
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'tok' });
  let quit = 0;
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet,
    showMessageBox: async () => ({ response: 0 }), quit: () => { quit += 1; } });
  await hub.close();
  assert.equal(r.action, 'switch-failed');
  assert.equal(quit, 0);
});

test('关掉了「再打开 Hub 时提示」：完全不看', async () => {
  const dataDir = tmpDataDir();
  const hub = await fakeHub();
  writeControl(dataDir, { pid: 4242, hookPort: hub.port, token: 'tok' });
  const r = await prompt.promptIfAnotherHubRunning({ dataDir, selfPid: 1, isAlive: alive, logger: quiet, enabled: () => false,
    showMessageBox: async () => ({ response: 0 }) });
  await hub.close();
  assert.equal(r.action, 'none');
  assert.deepEqual(hub.seen, []);
});

test('可选功能：multiOpen 默认开，可关并持久化', () => {
  const dataDir = tmpDataDir();
  const { createOptionalFeatures, CATALOG } = require('../core/optional-features');
  assert.ok(CATALOG.multiOpen.name);
  const a = createOptionalFeatures({ dataDir, logger: quiet });
  assert.equal(a.get('multiOpen'), true);
  a.set('multiOpen', false);
  assert.equal(createOptionalFeatures({ dataDir, logger: quiet }).get('multiOpen'), false);
});

test('对方回到一半断开连接：探测按没回应结束，不挂住', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Length': '100' }); res.write('{"ok":'); setTimeout(() => req.socket.destroy(), 50); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const reply = await prompt.callInstance({ hookPort: server.address().port, token: 't' }, 'ping', { timeoutMs: 5000 });
  await new Promise((r) => server.close(r));
  assert.equal(reply.ok, false);
  assert.ok(Date.now() - started < 3000);
});
