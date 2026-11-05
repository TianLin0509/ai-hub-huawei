'use strict';
// 自动挑号真实走一遍创建会话：其他号可用时不用个人号；其他号都暂停时用个人号；个人号也暂停时不启动。隔离实例 + 模拟 CodeAgent，窗口隐藏。
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
const quota = require(path.join(ENTRY, 'core/codeagent-quota'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-autopick-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const seed = (dir, id) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'autopick-' + id, accountId: id, expiresAt: Date.now() + 72 * 3600e3 } })); };
const results = [];
const ok = (label, value) => { assert.ok(value, label); results.push(label); console.log('PASS ' + label); };

(async () => {
  for (const dir of [DATA, WORK]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  seed(PERSONAL, 'autopick-personal');
  const ids = ['甲', '乙'].map((note, i) => { const id = pool.addAccount(DATA, { note }); seed(pool.accountDir(DATA, id), 'autopick-pool-' + i); return id; });
  const hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), label: 'autopick', windowMode: 'hidden', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  let failure = null;
  try {
    for (let i = 0; i < 100 && !(await c.eval("typeof selectSession==='function'")); i += 1) await sleep(100);
    const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)}).then(v=>v,e=>({thrown:e.message}))`);
    const auto = () => invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, codeagentAccount: 'pool' } });
    const account = async created => { assert.ok(created?.id, JSON.stringify(created)); return (await invoke('get-sessions')).find(s => s.id === created.id).codeagentPoolAccount || 'personal'; };
    const close = id => invoke('close-session', id).catch(() => {});

    const first = await auto();
    ok('其他号可用时不挑个人号', ids.includes(await account(first)));
    await close(first.id);

    for (const id of ids) quota.markAvoid(DATA, id, { source: 'manual', reason: '测试', until: null });
    const second = await auto();
    ok('其他号都暂停时挑个人号', (await account(second)) === 'personal');
    await close(second.id);

    quota.markAvoid(DATA, 'personal', { source: 'error', kind: 'quota', reason: '测试', until: Date.now() + 3600e3 });
    const before = (await invoke('get-sessions')).length;
    const third = await auto();
    ok('个人号也在避让时不启动', !third?.id && /暂时没有可用的账号/.test(JSON.stringify(third)));
    ok('不启动就不多出会话', (await invoke('get-sessions')).length === before);

    quota.clearAvoid(DATA, 'personal', { by: 'test' });
    quota.clearAvoid(DATA, ids[0], { by: 'test' });
    const fourth = await auto();
    ok('有号恢复后又回到号池', (await account(fourth)) === ids[0]);
    await close(fourth.id);
  } catch (error) { failure = error; }
  await c.close().catch(() => {});
  try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (error) { failure ||= error; }
  console.log(JSON.stringify({ ok: !failure, checks: results.length, error: failure?.message?.slice(0, 300) || null }));
  process.exit(failure ? 1 : 0);
})().catch(error => { console.error(error.stack); process.exit(1); });
