'use strict';
// 按组队、助理等调用方的口径（session:send-prompt + waitForCliReady）发一条消息，60 秒后应回「会话还没就绪……终端最后一屏已存：<文件>」，
// 文件在 diagnostics/cli-start-timeouts 下、含那一屏文字、已去掉用户目录与密钥。
// 用法：node tests/e2e-cli-start-timeout-dump-cdp.js [--out 目录]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const outIdx = process.argv.indexOf('--out');
const ART = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(REPO, 'artifacts', `cli-start-dump-${Date.now()}`));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-start-dump-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), BIN = path.join(ROOT, 'bin');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 60000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(250); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }

(async () => {
  for (const d of [DATA, WORK, ART, PERSONAL, BIN]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'p-fixture', expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  // 假 CLI：--version / --help 正常回答；交互启动时停在登录提示，永远不出输入框。屏上故意带用户目录和一个 token。
  const home = os.homedir();
  fs.writeFileSync(path.join(BIN, 'never-ready.js'), `
const a = process.argv.slice(2);
if (a.includes('--version') || a.includes('-v')) { console.log('2.9.0 (CodeAgent)'); process.exit(0); }
if (a.includes('--help') || a.includes('-h')) { console.log('Usage: codeagent [options]'); process.exit(0); }
process.stdout.write('\\x1b[2J\\x1b[H\\x1b[1mCodeAgent\\x1b[0m 2.9.0\\r\\n');
process.stdout.write('需要先登录：在浏览器打开 https://example.invalid/login?token=SECRET123456 完成认证\\r\\n');
process.stdout.write('配置目录：${home.replace(/\\/g, '\\\\\\\\')}\\\\.codeagent\\r\\n');
process.stdout.write('等待登录中…\\r\\n');
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(path.join(BIN, 'codeagent.cmd'), `@echo off\r\nnode "%~dp0never-ready.js" %*\r\n`);
  const evidence = { checks: [], root: ROOT, model: 'none; never-ready CodeAgent fixture' };
  const ok = (label, c = true) => { assert(c, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, failure;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'cli-start-dump', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(BIN, 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'),
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url), { commandTimeoutMs: 200000 }); // 发送要等满 60 秒就绪检查
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(() => cdp.eval('typeof sessions!=="undefined"'), 'renderer ready');
    const s = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '起不来的 CodeAgent', codeagentAccount: 'personal' } });
    ok('建了 CodeAgent 会话', !!s?.id);
    await sleep(5000); // 让假 CLI 把登录屏打出来
    const t0 = Date.now();
    // 真实链路：发送前 Hub 先按账号模型过一次启动模型菜单，这一步的就绪检查 60 秒没过就落现场；
    // 发送本身随后撞上 CodeAgent 120 秒发送期限，那条提示末尾补上现场文件路径；logs/codeagent-model.log 的失败原因里也有。
    const r = await invoke('session:send-prompt', { sessionId: s.id, text: '你好，看一下这个仓库', clientSubmissionId: 'e2e-start-dump-1', waitForCliReady: true });
    evidence.result = r; evidence.waitedMs = Date.now() - t0;
    ok('消息没发出去', r && r.ok === false && r.notSent === true);
    const dumpDir = path.join(DATA, 'diagnostics', 'cli-start-timeouts');
    const file = await wait(() => fs.existsSync(dumpDir) && fs.readdirSync(dumpDir).filter(n => n.endsWith('.txt')).map(n => path.join(dumpDir, n))[0], 'dump file', 30000);
    ok('超时现场文件在数据目录 diagnostics/cli-start-timeouts 下', fs.existsSync(file) && new RegExp(`-${s.id.slice(0, 8)}-codeagent\\.txt$`).test(file));
    const modelLog = fs.readFileSync(path.join(DATA, 'logs', 'codeagent-model.log'), 'utf8');
    ok('发送超时的提示里带着现场文件路径', String(r.message || '').includes('终端最后一屏已存：' + file));
    ok('失败原因里带着现场文件路径（日志行会截断，只核对开头）', modelLog.includes('终端最后一屏已存：' + dumpDir.slice(0, 20)));
    const body = fs.readFileSync(file, 'utf8');
    fs.copyFileSync(file, path.join(ART, '20261128-cli-start-timeout-sample.txt'));
    ok('文件里能看到它停在哪一屏', /需要先登录/.test(body) && /等待登录中/.test(body));
    ok('已去掉用户目录和 token', !body.includes(home) && !body.includes('SECRET123456'));
    evidence.ok = true;
  } catch (e) { failure = e; evidence.error = e.stack || String(e); }
  finally {
    try { if (cdp) await cdp.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch (e) { evidence.exitError = e.message; }
    fs.writeFileSync(path.join(ART, '20261128-cli-start-timeout-evidence.json'), JSON.stringify(evidence, null, 2));
    if (!failure) try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
  if (failure) { console.error(failure); process.exit(1); }
  console.log('e2e-cli-start-timeout-dump: ok');
})();
