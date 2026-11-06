'use strict';
// Company model proxy, first-time signer initialization and zone, through the real proxy process
// (server.mjs started hidden like Hub does, real upstream path, no --mock-upstream):
//   1. no signer cache anywhere -> Hub runs the CodeAgent CLI once (hidden PowerShell, CLI on a private desktop with
//      a console that is never shown, and a cmd /c grandchild shares it), reads the stamp from the signer log in a
//      fresh TEMP, and the cache appears in <Hub data>/company-model-proxy/signer-cache; status says how long;
//   0. for comparison, Node's windowsHide alone leaves the CLI without any console (a cmd grandchild would get a
//      new visible one) - the reason the CLI is not started that way;
//   7. the CLI leaves no stamp -> SIGNER_INIT_NO_STAMP with diagnostics (exit code, log exists, lines, marker, stamp).
//   2. restart -> cache reused, the CLI does not run again;
//   3. CodeAgent "upgraded" (new version) -> first init runs again by itself;
//   4. adapter builds the chat host from the zone and nothing names the zone -> ZONE_UNKNOWN in plain words;
//      the zone written by Settings (setUpstreamZone) -> ready, and the status says it was chosen there;
//      the zone in CodeAgent's own configuration -> ready, "已从 CodeAgent 的配置识别".
// The adapter is a synthetic package (its signer only reads the cache once Hub wrote it).
// The CLI is a tiny console program compiled here; it records its console window, its grandchild's console window,
// whether the prompt came on stdin and whether proxy / CodeAgent-session variables leaked to it.
//   node tests/e2e-company-proxy-signer-init.js   (artifacts: HUB_E2E_ARTIFACT_DIR or artifacts/company-proxy-signer-init)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildFakeCodeAgent, cliRuns, grandchildRuns } = require('./helpers/company-proxy-fake-adapter');

const root = path.join(__dirname, '..');
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(root, 'artifacts', 'company-proxy-signer-init'));
const report = { ok: false, checks: [], runs: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) throw new Error('check failed: ' + name + (detail ? ' ' + JSON.stringify(detail) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (process.platform !== 'win32') { console.log(JSON.stringify({ ok: true, skipped: 'windows only' })); return; }
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-signer-e2e-'));
  const home = path.join(work, 'home'), temp = path.join(work, 'temp'), dataDir = path.join(work, 'hub');
  for (const d of [home, temp, dataDir, path.join(home, '.cac')]) fs.mkdirSync(d, { recursive: true });
  const { codeagentDir, adapter, cliReport } = buildFakeCodeAgent(work);
  const upstreamFile = path.join(dataDir, 'company-model-proxy', 'upstream.json');
  fs.mkdirSync(path.dirname(upstreamFile), { recursive: true });
  const writeUpstream = extra => fs.writeFileSync(upstreamFile, JSON.stringify({ adapterPackage: adapter, codeagentDir, codeagentVersion: '9.1.2', ...extra }, null, 2));
  const proxy = require('../core/company-model-proxy');
  const endpoint = proxy.ensureEndpoint(dataDir, { preferredPort: 0 });
  const cacheFile = path.join(dataDir, 'company-model-proxy', 'signer-cache', 'codeagent-version-stamp');

  async function runProxy(label, until = s => s.code !== 'INITIALIZING', extraEnv = {}) {
    // CODEAGENT3_LAUNCHER_PID: as if Hub had been started from inside a CodeAgent session (the acceptance run is).
    const env = { ...process.env, AI_HUB_COMPANY_PROXY_KEY: endpoint.key, USERPROFILE: home, TEMP: temp, TMP: temp, FAKE_CLI_REPORT: cliReport,
      CODEAGENT3_LAUNCHER_PID: '4242', ...extraEnv };
    delete env.NODE_OPTIONS; delete env.CODEAGENT3_CONFIG_DIR; delete env.FAKE_AUTH_DIR;
    const stateFile = path.join(dataDir, 'company-model-proxy', 'proxy-state.json');
    fs.rmSync(stateFile, { force: true });
    const logFile = path.join(out, `20261106-signer-init-e2e-${label}-claude.log`);
    const fd = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['--use-system-ca', path.join(root, 'core', 'company-proxy', 'server.mjs'), '--data-dir', dataDir, '--port', '0'],
      { env, windowsHide: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    try {
      let state = null;
      for (let i = 0; i < 150 && !state; i++) { await sleep(100); try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (s.pid === child.pid) state = s; } catch { /* not yet */ } }
      if (!state) throw new Error(label + ': proxy did not open its port');
      const opened = Date.now();
      let status = null;
      for (let i = 0; i < 300; i++) {
        const r = await fetch(`http://127.0.0.1:${state.port}/admin/status`, { headers: { authorization: `Bearer ${endpoint.key}` } });
        status = await r.json();
        if (until(status)) break;
        await sleep(100);
      }
      const run = { label, ready: status.ready, code: status.code, message: status.message, zone: status.zone, firstInit: status.firstInit, msAfterPortOpen: Date.now() - opened };
      report.runs.push(run);
      await fetch(`http://127.0.0.1:${state.port}/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.key}` } }).catch(() => {});
      await new Promise(resolve => { if (child.exitCode !== null) return resolve(); const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 4000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
      return run;
    } catch (error) { try { child.kill(); } catch { /* gone */ } throw error; }
  }

  // 0. Comparison: the CLI started directly with Node's windowsHide (pipes) gets no console at all.
  await new Promise(resolve => { const c = spawn(path.join(codeagentDir, 'bin', 'codeagentcli.exe'), [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, FAKE_CLI_REPORT: cliReport + '.direct', TEMP: temp } }); c.stdin.end('x\n'); c.once('close', resolve); });
  const direct = cliRuns(cliReport + '.direct')[0] || '';
  check('对照：Node windowsHide 直接起命令行 → 命令行没有控制台（它再起 cmd 会新开可见窗口，所以不用这种方式）', /consoleWindow=0/.test(direct) && /grandchild=skipped-no-console/.test(direct), direct);
  // 1. First use: no cache anywhere (isolated home / TEMP), zone chosen explicitly.
  writeUpstream({ zone: 'yellow', signerCacheEnv: 'FAKE_AUTH_DIR' });
  const first = await runProxy('1-first-init');
  check('首次：反代先开端口，再在后台做首次签名初始化，完成后就绪', first.ready === true, first);
  check('首次：状态里写明首次初始化发生了、用时多少、跑了 1 次 CodeAgent 命令行', first.firstInit?.ran === true && first.firstInit.cliRuns === 1 && first.firstInit.ms > 0, first.firstInit);
  const p1 = first.firstInit?.probe || {};
  check('首次：诊断字段齐全（日志存在、行数、匹配到签名记录、解析出 stamp、写入 Hub 签名缓存）',
    p1.logExists === true && p1.logLines === 1 && p1.markerMatched === true && p1.stampParsed === true && first.firstInit.cacheWrite?.category === 'hub-signer-cache' &&
    ['stamp', 'exit'].includes(p1.stoppedBy) && !JSON.stringify(first.firstInit).includes('1730000000999'), first.firstInit);
  check('首次：签名缓存写进 Hub 数据目录 company-model-proxy/signer-cache', /^9\.1\.2\n1730000000999\n$/.test(fs.readFileSync(cacheFile, 'utf8')));
  const runs1 = cliRuns(cliReport);
  check('首次：CodeAgent 命令行只跑了 1 次', runs1.length === 1, runs1);
  check('首次：命令行有自己的控制台但不可见', /consoleWindow=1 visible=0/.test(runs1[0]), runs1[0]);
  const grand1 = grandchildRuns(cliReport);
  check('首次：命令行再起的 cmd /c 孙进程沿用同一个隐藏控制台，不弹窗', /grandchild=ran/.test(runs1[0]) && grand1.length === 1 && /consoleWindow=1 visible=0/.test(grand1[0]), { run: runs1[0], grand1 });
  check('首次：提示词经 stdin 交给命令行', /promptOnStdin=1/.test(runs1[0]), runs1[0]);
  check('首次：反代的本机 Key 和外层 CodeAgent 会话变量都没有传给命令行', /proxyKeyInherited=0/.test(runs1[0]) && /sessionVarsInherited=0/.test(runs1[0]), runs1[0]);
  // 2. Restart: cache reused.
  const second = await runProxy('2-cache-hit');
  check('再次启动：直接复用缓存，不再跑命令行', second.ready === true && second.firstInit?.ran === false && cliRuns(cliReport).length === 1, { second, runs: cliRuns(cliReport).length });
  // 3. CodeAgent upgraded.
  fs.writeFileSync(path.join(codeagentDir, 'version.txt'), '9.2.0');
  writeUpstream({ zone: 'yellow', signerCacheEnv: 'FAKE_AUTH_DIR', codeagentVersion: '9.2.0' });
  const third = await runProxy('3-upgrade');
  check('CodeAgent 升级后：自动重做一次首次初始化', third.ready === true && third.firstInit?.ran === true && third.firstInit.reason === 'version' && cliRuns(cliReport).length === 2, { third, runs: cliRuns(cliReport).length });
  check('CodeAgent 升级后：缓存换成新版本', /^9\.2\.0\n\d+\n$/.test(fs.readFileSync(cacheFile, 'utf8')));
  // 4. Zone: the adapter builds the chat host from the zone; signerCacheEnv / URLs / app id now come from the adapter scan.
  //    (signer.js names its variable as process.env.FAKE_AUTH_DIR, which the scan only accepts when it ends in AUTH_DIR.)
  writeUpstream({ codeagentVersion: '9.2.0', signerCacheEnv: 'FAKE_AUTH_DIR' });
  const unknown = await runProxy('4-zone-unknown');
  check('区域识别不出：不就绪，提示用户选择，不默默猜', unknown.ready === false && unknown.code === 'ZONE_UNKNOWN' && /「所在区域」里选择/.test(unknown.message) && /请在下面选择/.test(unknown.zone?.text) && unknown.zone?.zone === '', unknown);
  proxy.setUpstreamZone(dataDir, 'green');
  const chosen = await runProxy('5-zone-settings');
  check('设置里选了绿区：就绪，状态写明“你在这里选的”', chosen.ready === true && chosen.zone?.zone === 'green' && chosen.zone.text === '用的是绿区（你在这里选的）。', chosen.zone);
  proxy.setUpstreamZone(dataDir, '');
  fs.writeFileSync(path.join(home, '.cac', '.cac.json'), JSON.stringify({ enterpriseUserDetailCache: { region: 'b' } }));
  const detected = await runProxy('6-zone-codeagent');
  check('CodeAgent 记下的区域字母 b：自动识别为蓝区并说明来源', detected.ready === true && detected.zone?.zone === 'blue' && detected.zone.source === 'codeagent:.cac.json:letter' && /已从 CodeAgent 识别为蓝区/.test(detected.zone.text), detected.zone);
  // 7. The CLI leaves no stamp: plain words plus diagnostics, nothing raw.
  fs.rmSync(cacheFile, { force: true });
  const noStamp = await runProxy('7-no-stamp', undefined, { FAKE_CLI_NO_LOG: '1' });
  const p7 = noStamp.firstInit?.probe || {};
  check('命令行没留下签名：不就绪，报 SIGNER_INIT_NO_STAMP，带退出码/日志是否存在/行数/是否匹配/是否解析出 stamp',
    noStamp.ready === false && noStamp.code === 'SIGNER_INIT_NO_STAMP' && /签名日志没有生成/.test(noStamp.message) &&
    p7.cliExitCode === 0 && p7.logExists === false && p7.logLines === 0 && p7.markerMatched === false && p7.stampParsed === false && p7.error === 'LOG_MISSING', noStamp);
  report.ok = true;
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch(error => { report.error = String(error?.stack || error); process.exitCode = 1; })
  .finally(() => {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, '20261106-signer-init-e2e-result-claude.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).map(c => c.name), error: report.error?.split('\n')[0] }));
  });
