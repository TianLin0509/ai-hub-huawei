'use strict';
// 真机：隔离副本按真实用户路径「检查更新 → 下载 → 关 Hub 时换上」升到内源最新版（2026-11-28 v5.6.149 回归前置）。
// 被测副本是已发布的原包（带 app.asar），免安装版：完整安装包不会被运行，增量包在关 Hub 时由替换脚本换进副本自己的 resources。
// 隔离：全新数据目录、隐藏窗口、WeLink 假桩、显式 --user-data-dir（hub-launcher），起来后 5 秒隔离守卫。
//   ELECTRON_RUN_AS_NODE=1 "<任意 Hub exe>" e2e-company-update-real.js --exe "<被测副本 exe>" --out <目录> [--want 5.6.149]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2), arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe'), out = arg('--out'), want = arg('--want') || '';
const resources = path.join(path.dirname(exe), 'resources');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-flows-real-upd-')), dataDir = path.join(root, 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
// 读副本 app.asar 里的版本号要在一个用完就退的子进程里读：本进程用 Electron 的 asar 读一次就会一直占着 app.asar，
// 关 Hub 时替换脚本换不进去（2026-11-28 第一轮实测「文件被占用」回滚）。
const asarVersion = () => {
  const r = require('child_process').spawnSync(process.execPath, ['-e', `try{process.stdout.write(JSON.parse(require('fs').readFileSync(${j(path.join(resources, 'app.asar', 'package.json'))},'utf8')).version)}catch(e){process.stdout.write('ERR '+e.message.slice(0,80))}`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').trim() || 'ERR ' + String(r.stderr || r.error || '').slice(0, 80);
};
const t0 = Date.now(), sec = () => Math.round((Date.now() - t0) / 1000);
const report = { exe, startedAt: new Date().toISOString(), states: [], checks: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1));
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); save(); };
let hub, c;
async function main() {
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  report.versionBefore = asarVersion();
  const stub = path.join(root, 'welink-disabled.js'); fs.writeFileSync(stub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'update real', executablePath: exe,
    entryPath: path.join(resources, 'app.asar'), cwd: path.dirname(exe),
    extraEnv: { CLAUDE_HUB_WELINK_CLI: stub, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_UPDATE_STARTUP_DELAY_MS: String(864e5), DEEPSEEK_API_KEY: '' } });
  await require('./helpers/isolation-guard').guardIsolatedHub(hub, root);
  for (let i = 0; !c; i++) { try { c = await connectFirstPage(hub, t => /index\.html/.test(t.url), { waitMainMs: 15000 }); } catch (e) { if (i >= 8) throw e; await sleep(3000); } }
  await sleep(6000);
  const ipc = (ch, a) => c.eval(`require('electron').ipcRenderer.invoke(${j(ch)}${a === undefined ? '' : ', ' + j(a)}).then(x => JSON.parse(JSON.stringify(x || null)))`);
  const st = async tag => { const s = await ipc('app-update:get-state').catch(e => ({ err: String(e) })); report.states.push({ s: sec(), tag, phase: s && s.phase, current: s && (s.currentVersion || s.current), latest: s && s.latest && s.latest.version, plan: s && s.plan && { kind: s.plan.kind, variant: s.plan.variant, portable: s.plan.portable, reason: s.plan.reason }, error: s && (s.error || s.err), quiet: s && s.quiet }); save(); return s || {}; };
  await st('open');
  report.check = await ipc('app-update:check').then(x => ({ phase: x && x.phase })).catch(e => ({ err: String(e) }));
  let s = await st('after-check');
  for (let i = 0; i < 40 && !['available', 'ready', 'error', 'latest', 'uptodate', 'idle'].includes(s.phase); i++) { await sleep(3000); s = await st('checking'); }
  check('检查更新查到内源新版', s.latest && s.latest.version && (!want || s.latest.version === want), { phase: s.phase, latest: s.latest && s.latest.version, error: s.error });
  if (s.phase === 'available') {
    report.download = await ipc('app-update:download').then(x => ({ phase: x && x.phase })).catch(e => ({ err: String(e) }));
    for (let i = 0; i < 180 && !['ready', 'error'].includes(s.phase); i++) { await sleep(5000); s = await st('downloading'); }
  }
  check('下载完成、进入「已就绪，重启生效」', s.phase === 'ready', { phase: s.phase, error: s.error, plan: s.plan });
  // 真实用户：关掉 Hub，下次打开就是新版（关 Hub 时替换脚本把增量包换进副本自己的 resources）
  try { await gracefulQuit(hub); hub = null; } catch (e) { report.quitError = String(e).slice(0, 200); }
  let v = asarVersion();
  for (let i = 0; i < 60 && v === report.versionBefore; i++) { await sleep(3000); v = asarVersion(); }
  report.versionAfter = v;
  check(`关 Hub 后副本换成新版（${report.versionBefore} → ${v}）`, v !== report.versionBefore && (!want || v === want), { before: report.versionBefore, after: v });
}
main().catch(e => { report.error = String(e && e.stack || e).slice(0, 800); }).finally(async () => {
  if (hub) { try { await gracefulQuit(hub); } catch (e) { (report.quitErrors ||= []).push(String(e).slice(0, 200)); try { if (hub.child && hub.child.pid === hub.pid && hub.child.exitCode == null) hub.child.kill(); } catch (_) {} } }
  report.passed = require('./helpers/e2e-verdict').e2ePassed(report, true);
  report.finishedAt = new Date().toISOString(); save();
  console.log('REPORT ' + path.join(out, 'report.json'));
  process.exit(report.passed ? 0 : 1);
});
