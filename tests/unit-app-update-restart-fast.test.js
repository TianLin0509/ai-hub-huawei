'use strict';
// R48（2026-11-26）：点「立即重启」要秒响应。公司电脑取证：
//   ① 点击到替换脚本开始 9.7、15.4 秒（2 次里 2 次），卡在公司版重启关口等「正在重启」回报经中转送出；
//   ② 一个借本程序当 Node 跑的外部脚本（脚本在安装目录之外）每次升级都被当成「别的 Hub 开着」，要用户点一次，关不掉再白等约 11 秒。
// 这里覆盖：关口不等网络；外部脚本不算 Hub、不结束它、不白等；Hub 自己的脚本子进程算残留照旧结束；新版窗口没出来时给「手动启动」。
// 替换脚本是真实 PowerShell，全程隐藏；「本程序」用复制到临时安装目录的 node.exe 冒充（能跑 .mjs 脚本、不开窗口）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { HELPER, PROGRESS_UI, stagingPaths } = require('../core/app-update/apply.js');

const winOnly = { skip: process.platform !== 'win32' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const q = s => String(s).replace(/'/g, "''");
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

// 图形子系统的小程序（不弹控制台）：--flag <文件> 写 x 后退出。给「重开新版」用，看它被拉起几次。
const PROBE_SOURCE = String.raw`
using System.IO;
public static class LaunchProbe { public static int Main(string[] a) { for (int i = 0; i + 1 < a.Length; i += 2) if (a[i] == "--flag") File.AppendAllText(a[i + 1], "x"); return 0; } }`;
let probeExe = null;
function launchProbe() {
  if (probeExe && fs.existsSync(probeExe)) return probeExe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r48-probe-'));
  const src = path.join(dir, 'probe.cs'), exe = path.join(dir, 'LaunchProbe.exe');
  fs.writeFileSync(src, PROBE_SOURCE, 'utf8');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${q(src)}') -OutputType WindowsApplication -OutputAssembly '${q(exe)}'`], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.ok(fs.existsSync(exe), `编译替身失败：${r.stdout}${r.stderr}`);
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return (probeExe = exe);
}

function makeCase(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r48-'));
  const p = stagingPaths(dataDir);
  const appDir = path.join(dataDir, 'install');
  const resources = path.join(appDir, 'resources');
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true });
  fs.mkdirSync(path.join(p.newDir, 'app.asar.unpacked'), { recursive: true });
  const asar = path.join(resources, 'app.asar');
  fs.writeFileSync(asar, 'old-asar');
  fs.writeFileSync(path.join(p.newDir, 'app.asar'), 'new-asar');
  const exe = path.join(appDir, 'FakeHub.exe');
  fs.copyFileSync(process.execPath, exe);
  const plan = { version: '5.6.121', from: '5.6.120', pid: 0, exe, args: [], relaunch: false, waitSeconds: 30, resourcesDir: resources, appDir, leftoverWaitSeconds: 10,
    newDir: p.newDir, stagingDir: p.root, resultFile: p.result, startedFile: p.started, cancelFile: p.cancel, progressFile: p.progress, decisionFile: p.decision,
    progressUi: false, productName: 'AI Hub', swapTries: 4, files: [{ path: 'app.asar', sha256: sha(Buffer.from('new-asar')) }], ...extra };
  const kids = [];
  const k = {
    dataDir, p, asar, exe, appDir, resources, plan, kids,
    setPlan(more) { Object.assign(plan, more); fs.writeFileSync(p.plan, JSON.stringify(plan), 'utf8'); },
    helperArgs() { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', p.helper, '-Plan', p.plan]; },
    start() { const c = spawn(PS, k.helperArgs(), { windowsHide: true, stdio: 'ignore' }); kids.push(c.pid); return c; },
    runSync() { return spawnSync(PS, k.helperArgs(), { windowsHide: true, encoding: 'utf8', timeout: 90000 }); },
    log() { try { return fs.readFileSync(path.join(p.root, 'upgrade-log.txt'), 'utf8'); } catch (_) { return ''; } },
    progress() { try { return JSON.parse(fs.readFileSync(p.progress, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } },
    result() { return JSON.parse(fs.readFileSync(p.result, 'utf8').replace(/^\uFEFF/, '')); },
    decide(action) { fs.writeFileSync(p.decision, JSON.stringify({ action })); },
    // 用「本程序」（复制的 node.exe）跑一个常驻脚本：脚本在 dir 里，起来后写标记。
    async script(dir, name) {
      fs.mkdirSync(dir, { recursive: true });
      const flag = path.join(dataDir, `${name}.flag`), file = path.join(dir, name);
      const body = `writeFileSync(${JSON.stringify(flag)}, 'x'); setTimeout(() => {}, 120000);\n`;
      fs.writeFileSync(file, (name.endsWith('.mjs') ? "import { writeFileSync } from 'node:fs'; " : "const { writeFileSync } = require('node:fs'); ") + body);
      const c = spawn(exe, [file, 'AUTO', 'FIX', '2'], { windowsHide: true, stdio: 'ignore' });
      kids.push(c.pid);
      for (let i = 0; i < 100 && !fs.existsSync(flag); i++) await sleep(100);
      assert.ok(fs.existsSync(flag), '脚本进程没起来');
      return c;
    },
    async waitFor(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(150); } return null; },
    done() { for (const pid of kids) { try { process.kill(pid); } catch (_) {} } setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }, 1500).unref(); },
  };
  fs.writeFileSync(p.plan, JSON.stringify(plan), 'utf8');
  fs.writeFileSync(p.helper, '\uFEFF' + HELPER, 'utf8');
  return k;
}

test('借本程序跑的外部脚本（脚本在安装目录之外）：不算「别的 Hub」、不结束它、不白等残留，照常换成功', winOnly, async t => {
  // assumeUi：要是还把它当成别的 Hub，脚本会停在「关闭它们并继续升级」等人点，下面的 30 秒超时就会挂。
  const k = makeCase({ assumeUi: true });
  t.after(() => k.done());
  const ext = await k.script(path.join(k.dataDir, 'AIGrab'), 'vl_fix.mjs');
  const t0 = Date.now();
  const r = k.runSync();
  const ms = Date.now() - t0;
  const log = k.log();
  assert.equal(r.status, 0, log);
  assert.equal(k.result().ok, true, log);
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.doesNotMatch(log, /还有别的|关闭别的 Hub|结束残留进程/, log);
  assert.match(log, /不算 Hub：借本程序运行的外部脚本 vl_fix\.mjs（进程 \d+），不结束它/);
  assert.equal((log.match(/不算 Hub/g) || []).length, 1, '同一个进程只记一行');
  assert.ok(alive(ext.pid), '外部脚本还活着');
  // 以前：问一次 + 关不掉 + 残留等满 10 秒；现在不等它（留足 PowerShell 起动与快照的时间）。
  assert.ok(ms < 9500, `用了 ${ms} ms（旧做法至少等满 10 秒残留）`);
});

test('Hub 自己的脚本子进程（脚本在安装目录里）：算残留照旧结束，不再当成「最小化到托盘的 Hub」去问用户', winOnly, async t => {
  const k = makeCase({ assumeUi: true, leftoverWaitSeconds: 0 });
  t.after(() => k.done());
  const child = await k.script(path.join(k.resources, 'app.asar.unpacked', 'core'), 'serve-child.js');
  const r = k.runSync();
  const log = k.log();
  assert.equal(r.status, 0, log);
  assert.equal(k.result().ok, true, log);
  assert.doesNotMatch(log, /还有别的|关闭别的 Hub/, log);
  assert.match(log, /结束残留进程：.*\(\d+\)/);
  await k.waitFor(() => !alive(child.pid), 5000);
  assert.equal(alive(child.pid), false);
});

test('换好后新版窗口没出来：等满 launchWaitSeconds 后小窗给「手动启动」，点了再拉起一次；窗口没出来不报「升级完成」', winOnly, async t => {
  const k = makeCase({ assumeUi: true, assumeLaunchUi: true, relaunch: true, launchWaitSeconds: 1 });
  t.after(() => k.done());
  const marker = path.join(k.dataDir, 'launched.txt');
  // 替身没有窗口：Window-Up 永远看不到它，等同「新版起不来」。
  k.setPlan({ exe: launchProbe(), args: ['--flag', marker] });
  const helper = k.start();
  const asked = await k.waitFor(() => { const s = k.progress(); return s && s.state === 'failed' && s.need === 'launch' ? s : null; });
  assert.ok(asked, k.log());
  assert.equal(asked.step, 4);
  assert.match(asked.reason, /新版本已经换好，但 1 秒内还没看到窗口.*手动启动/);
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  await k.waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').length === 1, 5000);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x', '先自动拉起过一次');
  k.decide('launch');
  await k.waitFor(() => fs.readFileSync(marker, 'utf8').length === 2, 10000);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx', '点「手动启动」后又拉起一次');
  assert.match(k.log(), /用户点了手动启动/);
  // 再次等不到窗口时又给按钮（窗口没出来就不报完成）；用户关掉（不点）替换脚本就结束，进度收尾成完成、不留「要手动启动」的残留。
  const again = await k.waitFor(() => { const s = k.progress(); return s && s.state === 'failed' && s.need === 'launch' ? s : null; });
  assert.ok(again, '第二次等不到也给按钮');
  k.decide('dismiss');
  const gone = await k.waitFor(() => !alive(helper.pid), 10000);
  assert.ok(gone, '替换脚本结束');
  assert.equal(k.progress().state, 'done');
  assert.equal(k.progress().need, undefined);
});

test('没有进度小窗（测试、静默替换）或 launchWaitSeconds=0：不等新版窗口，直接报完成', winOnly, async t => {
  const k = makeCase({ relaunch: true });
  t.after(() => k.done());
  const marker = path.join(k.dataDir, 'launched.txt');
  k.setPlan({ exe: launchProbe(), args: ['--flag', marker] });
  const t0 = Date.now();
  const r = k.runSync();
  assert.equal(r.status, 0, k.log());
  assert.equal(k.progress().state, 'done');
  assert.ok(Date.now() - t0 < 8000);
  const k2 = makeCase({ relaunch: true, assumeUi: true, assumeLaunchUi: true, launchWaitSeconds: 0 });
  t.after(() => k2.done());
  k2.setPlan({ exe: launchProbe(), args: ['--flag', path.join(k2.dataDir, 'l.txt')] });
  assert.equal(k2.runSync().status, 0, k2.log());
  assert.equal(k2.progress().state, 'done');
});

test('进度小窗两套界面都认得「手动启动」这一步', () => {
  const ui = PROGRESS_UI;
  assert.equal((ui.match(/\$s\.need -eq 'launch'/g) || []).length, 2);
  assert.equal((ui.match(/Buttons '手动启动' 'launch' '关闭' 'close'/g) || []).length, 2);
  assert.match(HELPER, /\$d -eq 'launch'/);
  // WPF 小窗：离开点按钮时那一步就清掉「已点过」，同一提示再出现时按钮能再点（审查 P1-1）。
  assert.match(ui, /if \(\$script:decided -and \$script:decided -ne \$script:stateKey\) \{ \$script:decided = \$null \}/);
  // 手动启动前先看新版进程是不是还在启动，在就不重复拉起（审查 P2-3）。
  assert.match(HELPER, /新版进程还在启动，不重复拉起/);
});

test('命令行解析：带引号的开关值不拆开、正斜杠脚本路径换成反斜杠（按安装目录比对）', winOnly, () => {
  const i = HELPER.indexOf('function Script-Arg'), j = HELPER.indexOf('function Snap');
  const fn = HELPER.slice(i, j);
  const cases = [
    [String.raw`"C:\A B\Hub.exe" --use-system-ca "C:\X\vl_fix.mjs" AUTO`, String.raw`C:\X\vl_fix.mjs`],
    [String.raw`"C:\A B\Hub.exe" --k="a b" "C:/A B/resources/x.js"`, String.raw`C:\A B\resources\x.js`],
    [String.raw`"C:\A B\Hub.exe" --k="a b" C:/A B/resources/x.js`, ''],
    [String.raw`"C:\A B\Hub.exe" --type=renderer --lang=zh-CN`, ''],
    [String.raw`"C:\A B\Hub.exe"`, ''],
    [String.raw`"C:\A B\Hub.exe" C:\work\folder`, ''],
  ];
  const script = fn + cases.map(([cmd]) => `Write-Output ('<' + (Script-Arg '${q(cmd)}') + '>')`).join('\n');
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const got = (r.stdout || '').trim().split(/\r?\n/).map(l => l.replace(/^<|>$/g, ''));
  assert.deepEqual(got, cases.map(c => c[1]), r.stderr);
});

test('控制器：暂存计划带新版窗口等待秒数；隐藏窗口跑的测试 Hub 不等', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/app-update-controller.js'), 'utf8');
  assert.match(src, /launchWaitSeconds: env\.CLAUDE_HUB_E2E_WINDOW_MODE === 'hidden' \? 0 : 15/);
  // 等「已开始」标记每 50 毫秒看一次，不再先等 300 毫秒。
  assert.match(src, /setTimeout\(poll, 50\);\s*\};\s*\/\/ R48/);
});
