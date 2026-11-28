'use strict';
// R57 复现：CodeAgent 会话的工作目录短暂失效、回落到主目录后，同一个对话号在两个记录目录里各有一份、
// 之后各自增长；Hub 下次启动时会挑错那一份，用户看到的是「回落那天」的旧上下文。
// 两条路径各用一个会话：
//   S1 原目录已恢复：启动自愈把工作目录改回原目录 → CLI 在原目录续接 → 读到回落前的旧副本（接到旧会话）。
//   S2 原目录仍不在：每次启动都重新「迁移」记录，按目录枚举顺序取第一份 → 旧副本覆盖主目录里的新记录（今天的内容被覆盖）。
// 隔离实例 + 模拟 CodeAgent（tests/fixtures/codeagent-pool-fake），窗口隐藏；不调用任何模型。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const ENTRY = path.resolve(process.argv[2] || REPO);
const ROOT = fs.mkdtempSync(path.join(process.env.R57_E2E_ROOT || os.tmpdir(), 'hub-r57-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
// 主目录与原工作目录放在同一层，名字让原目录的记录桶在枚举顺序里排在主目录前面（S2 的触发条件）。
const HOME = path.join(ROOT, 'home');
const A1 = path.join(ROOT, 'a-proj1'), A2 = path.join(ROOT, 'a-proj2');
const LOG = path.join(ROOT, 'fake-launch.jsonl');
const OLD = 'R57-OLD-1123', NEW = 'R57-NEW-1126';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const slug = dir => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
const bucketFile = (dir, id) => path.join(PERSONAL, 'projects', slug(dir), id + '.jsonl');
const appendLine = (file, cwd, text) => fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
const launches = hubSession => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
  .filter(r => !r.probe && Array.isArray(r.args) && r.hubSession === hubSession);
const observations = {};
const results = [];
const check = (label, value, detail) => { results.push({ label, ok: !!value, detail }); console.log((value ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + JSON.stringify(detail) : '')); };

const SCALE = Math.max(1, Number(process.env.HUB_TEST_TIMEOUT_SCALE) || 1);

function hubEnv() {
  return { AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
    AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, USERPROFILE: HOME, HOME,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0' };
}

async function withHub(label, fn) {
  const hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), label, windowMode: 'hidden', extraEnv: hubEnv() });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  let failure = null;
  try {
    for (let i = 0; i < 150 && !(await c.eval("typeof selectSession==='function' && typeof resumeDormantSession==='function'")); i += 1) await sleep(100);
    const invoke = (channel, ...payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},...${JSON.stringify(payload)}).then(v=>v,e=>({thrown:e.message}))`);
    await fn({ c, invoke });
  } catch (error) { failure = error; }
  await c.close().catch(() => {});
  try { await gracefulQuit(hub, { timeoutMs: 30000 * SCALE }); } catch (error) { failure ||= error; }
  if (failure) throw failure;
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs * SCALE;
  let last;
  while (Date.now() < deadline) { last = await fn(); if (last) return last; await sleep(250); }
  throw new Error('timeout: ' + label);
}

(async () => {
  for (const dir of [DATA, WORK, HOME, A1, A2]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.mkdirSync(PERSONAL, { recursive: true });
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'r57', accountId: 'r57-personal', expiresAt: Date.now() + 72 * 3600e3 } }));
  const sessions = {};

  // 第一次启动：在原目录建两个会话、等它们绑定原生对话号；然后让原目录失效、重启会话 → 回落主目录。
  await withHub('r57-a', async ({ c, invoke }) => {
    for (const [key, cwd] of [['s1', A1], ['s2', A2]]) {
      const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd, codeagentAccount: 'personal', title: 'R57 ' + key } });
      assert.ok(created?.id, JSON.stringify(created));
      const bound = await waitFor(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), key + ' bound');
      sessions[key] = { id: created.id, cwd, cc: bound.ccSessionId };
      appendLine(bucketFile(cwd, bound.ccSessionId), cwd, OLD + ' 回落之前的对话');
    }
    // 先休眠（终端进程退出、不再占着原目录），再让原目录失效，然后唤醒 → 回落主目录。
    for (const key of ['s1', 's2']) {
      const r = await invoke('suspend-session', sessions[key].id);
      assert.ok(r?.ok, JSON.stringify(r));
      await waitFor(async () => !(await invoke('get-sessions')).some(x => x.id === sessions[key].id), key + ' suspended');
    }
    await sleep(1500);
    fs.renameSync(A1, A1 + '.gone');
    fs.renameSync(A2, A2 + '.gone');
    for (const key of ['s1', 's2']) {
      const s = sessions[key];
      const before = launches(s.id).length;
      observations[key + 'Wake'] = await c.eval(`resumeDormantSession(${JSON.stringify(s.id)}).then(()=>true,e=>e.message)`);
      await waitFor(() => launches(s.id).length > before, key + ' relaunch after fallback');
      const live = await waitFor(async () => (await invoke('get-sessions')).find(x => x.id === s.id && x.ccSessionId), key + ' rebound');
      const launch = launches(s.id).at(-1);
      observations[key + 'Fallback'] = { cwd: live.cwd, cwdFellBackFrom: live.cwdFellBackFrom || null, ccSessionId: live.ccSessionId, cliCwd: launch.cwd, cliResume: launch.args.includes('--resume') ? launch.args[launch.args.indexOf('--resume') + 1] : null };
      check(key + ' 原目录失效后回落到主目录、按原对话号续接', path.resolve(live.cwd) === path.resolve(HOME) && launch.args.includes(s.cc), observations[key + 'Fallback']);
      // 回落期间的新对话写进主目录那一份（真 CLI 在主目录续接后就往这里追加）。
      appendLine(bucketFile(HOME, s.cc), HOME, NEW + ' 回落之后（今天）的对话');
    }
    for (const key of ['s1', 's2']) await invoke('suspend-session', sessions[key].id);
    await sleep(3000); // 让界面把会话快照落盘
  });

  // 原目录 1 恢复，原目录 2 仍不在。第二次启动 Hub。
  fs.renameSync(A1 + '.gone', A1);
  await withHub('r57-b', async ({ c, invoke }) => {
    const dormant = (await invoke('get-dormant-sessions')).sessions || [];
    for (const key of ['s1', 's2']) {
      const s = sessions[key];
      const snap = dormant.find(x => (x.hubId || x.id) === s.id);
      observations[key + 'Boot'] = snap && { cwd: snap.cwd, cwdFellBackFrom: snap.cwdFellBackFrom || null, ccSessionId: snap.ccSessionId };
      const before = launches(s.id).length;
      const live = (await invoke('get-sessions')).find(x => x.id === s.id);
      observations[key + 'BootLive'] = live ? { status: live.status, cwd: live.cwd } : null;
      // 启动时已自动拉起就等它；没有新的 CLI 启动就按用户点侧栏的路径唤醒。
      try { await waitFor(() => launches(s.id).length > before, key + ' auto resumed', 5000); }
      catch {
        // 和界面唤醒同一个入口：按休眠快照组恢复参数，直接调 resume-session，并记下返回结果。
        observations[key + 'Wake2'] = await c.eval(`(async()=>{const snap=(await require('electron').ipcRenderer.invoke('get-dormant-sessions')).sessions.find(x=>(x.hubId||x.id)===${JSON.stringify(s.id)});
          const meta=require('../core/session-capabilities.js').buildSessionResumeMeta(snap);
          const r=await require('electron').ipcRenderer.invoke('resume-session',meta,{});return r&&{ok:r.ok,id:r.id,error:r.error,message:r.message,cwd:r.cwd};})().catch(e=>({thrown:e.message}))`);
        await waitFor(() => launches(s.id).length > before, key + ' resumed after reboot');
      }
      await sleep(1500);
      const launch = launches(s.id).at(-1);
      const resumedFile = bucketFile(launch.cwd, s.cc);
      const text = fs.existsSync(resumedFile) ? fs.readFileSync(resumedFile, 'utf8') : '';
      const homeText = fs.existsSync(bucketFile(HOME, s.cc)) ? fs.readFileSync(bucketFile(HOME, s.cc), 'utf8') : '';
      observations[key + 'Resume'] = { cliCwd: launch.cwd, resumeArg: launch.args.includes('--resume') ? launch.args[launch.args.indexOf('--resume') + 1] : null,
        resumedFile, resumedHasOld: text.includes(OLD), resumedHasNew: text.includes(NEW), homeCopyHasNew: homeText.includes(NEW) };
    }
  });

  // 正确行为：续上的那份记录里必须有回落之后（今天）的对话。
  check('S1 原目录恢复后，续接的记录包含今天的对话（否则就是接到了旧会话）', observations.s1Resume?.resumedHasNew, observations.s1Resume);
  check('S2 原目录仍不在时，主目录里今天的对话没有被旧副本覆盖', observations.s2Resume?.homeCopyHasNew && observations.s2Resume?.resumedHasNew, observations.s2Resume);
  const out = path.join(process.env.R57_E2E_OUT || ROOT, 'r57-e2e-observations.json');
  fs.writeFileSync(out, JSON.stringify({ root: ROOT, sessions, observations, results }, null, 2));
  console.log('observations: ' + out);
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ ok: !failed.length, checks: results.length, failed: failed.map(r => r.label) }));
  process.exit(failed.length ? 1 : 0);
})().catch(error => { console.error(error.stack); try { fs.writeFileSync(path.join(process.env.R57_E2E_OUT || ROOT, 'r57-e2e-observations.json'), JSON.stringify({ root: ROOT, observations, results, error: error.message }, null, 2)); } catch {} process.exit(2); });
