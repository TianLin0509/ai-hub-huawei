'use strict';
// Hub 正好在读额度时退出：临时 serve 和它的子进程都要结束，不留在后台。隔离实例 + 模拟 CodeAgent，窗口隐藏。
// 模拟 serve 用 never-ready 模式卡在就绪前，保证退出时它正在跑。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const ENTRY = path.resolve(process.argv[2] || REPO);
const pool = require(path.join(ENTRY, 'core/codeagent-pool'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-quit-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'serve.jsonl');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const seed = (dir, id) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'quit-fixture-' + id, accountId: id, expiresAt: Date.now() + 72 * 3600e3 } })); };

(async () => {
  for (const dir of [DATA, WORK]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  seed(PERSONAL, 'quit-personal');
  seed(pool.accountDir(DATA, pool.addAccount(DATA, { note: '测试号' })), 'quit-pool');
  const hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), label: 'quota-quit', windowMode: 'hidden', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', SERVE_FAKE_MODE: 'never-ready', SERVE_FAKE_LOG: LOG,
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  let serve = null;
  try {
    for (let i = 0; i < 100 && !(await c.eval('!!window.codeagentQuotaPanel')); i += 1) await sleep(100);
    await c.eval("window.codeagentQuotaPanel.refresh();1");
    for (let i = 0; i < 300 && !serve; i += 1) {
      if (fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').trim()) serve = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[0]);
      else await sleep(100);
    }
    assert.ok(serve, 'temporary serve started');
    assert.equal(alive(serve.pid), true); assert.equal(alive(serve.child), true);
  } finally {
    await c.close().catch(() => {});
    await gracefulQuit(hub, { timeoutMs: 30000 });
  }
  for (let i = 0; i < 50 && (alive(serve.pid) || alive(serve.child)); i += 1) await sleep(100);
  const after = { serve: alive(serve.pid), child: alive(serve.child) };
  const count = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
  console.log(JSON.stringify({ ok: !after.serve && !after.child, after, serveStarts: count }));
  // 没结束时收掉自己起的进程，免得留在机器上
  for (const pid of [serve.pid, serve.child]) { try { process.kill(pid); } catch { /* 已退出 */ } }
  assert.deepEqual(after, { serve: false, child: false }, 'temporary serve must not outlive the Hub');
  process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
