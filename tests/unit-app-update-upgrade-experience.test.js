'use strict';
// 升级体验（2026-11-13，用户反馈第一痛点）：真实跑替换脚本，覆盖
//   正常升级有分步进度；升级途中再点图标交给进度窗；别的 Hub 开着（含托盘）先问再关；残留子进程自动结束；
//   替换失败一键重试；旧窗口不退出时不再多开旧版；进度小窗能画出来。
// 「别的 Hub」用复制到临时安装目录的 powershell.exe 冒充（同一路径的 exe），全程隐藏、不弹窗。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { HELPER, PROGRESS_UI, stagingPaths } = require('../core/app-update/apply.js');
const guard = require('../core/app-update/launch-guard.js');

const winOnly = { skip: process.platform !== 'win32' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const q = s => String(s).replace(/'/g, "''");

function makeCase(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upx-'));
  const p = stagingPaths(dataDir);
  const appDir = path.join(dataDir, 'install');
  const resources = path.join(appDir, 'resources');
  fs.mkdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true });
  fs.mkdirSync(path.join(p.newDir, 'app.asar.unpacked'), { recursive: true });
  const asar = path.join(resources, 'app.asar');
  fs.writeFileSync(asar, 'old-asar');
  fs.writeFileSync(path.join(p.newDir, 'app.asar'), 'new-asar');
  const exe = path.join(appDir, 'FakeHub.exe');
  fs.copyFileSync(PS, exe);
  const plan = { version: '5.6.21', from: '5.6.20', pid: 0, exe, args: [], relaunch: false, waitSeconds: 30, resourcesDir: resources, appDir, leftoverWaitSeconds: 0,
    newDir: p.newDir, stagingDir: p.root, resultFile: p.result, startedFile: p.started, cancelFile: p.cancel, progressFile: p.progress, decisionFile: p.decision,
    progressUi: false, productName: 'AI Hub', swapTries: 4, files: [{ path: 'app.asar', sha256: sha(Buffer.from('new-asar')) }], ...extra };
  fs.writeFileSync(p.plan, JSON.stringify(plan), 'utf8');
  fs.writeFileSync(p.helper, '\uFEFF' + HELPER, 'utf8');
  const kids = [];
  const k = {
    dataDir, p, asar, exe, plan, kids,
    setPlan(more) { Object.assign(plan, more); fs.writeFileSync(p.plan, JSON.stringify(plan), 'utf8'); },
    start() { const c = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', p.helper, '-Plan', p.plan], { windowsHide: true, stdio: 'ignore' }); kids.push(c); return c; },
    runSync() { return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', p.helper, '-Plan', p.plan], { windowsHide: true, encoding: 'utf8', timeout: 90000 }); },
    progress() { try { return JSON.parse(fs.readFileSync(p.progress, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; } },
    result() { return JSON.parse(fs.readFileSync(p.result, 'utf8').replace(/^\uFEFF/, '')); },
    decide(action) { fs.writeFileSync(p.decision, JSON.stringify({ action })); },
    // 冒充一个占着 app.asar 的进程：exe 用安装目录里的 FakeHub.exe（= 别的 Hub）或系统的 powershell（= 外部程序）。
    async hold({ asHub = true, tag = '', seconds = 60 } = {}) {
      const flag = path.join(dataDir, `hold-${kids.length}.flag`);
      const script = `$f=[IO.File]::Open('${q(asar)}','Open','Read','Read');Set-Content -LiteralPath '${q(flag)}' -Value x;Start-Sleep -Seconds ${seconds};$f.Close() # ${tag}`;
      const c = spawn(asHub ? exe : PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
      kids.push(c);
      for (let i = 0; i < 150 && !fs.existsSync(flag); i++) await sleep(100);
      assert.ok(fs.existsSync(flag), '占用进程没起来');
      return c;
    },
    async waitFor(fn, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(150); } return null; },
    done() { if (process.env.UPX_LOG) { try { console.log(fs.readFileSync(path.join(p.root, 'upgrade-log.txt'), 'utf8')); } catch (_) {} } for (const c of kids) { try { c.kill(); } catch (_) {} } setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }, 1500).unref(); },
  };
  return k;
}
const alive = c => c.exitCode === null && c.signalCode === null;
const exited = c => new Promise(r => (alive(c) ? c.once('exit', () => r()) : r()));

test('正常升级：分步写进度（第 1→4 步、已等多久、通常多久），最后是完成', winOnly, async () => {
  const k = makeCase();
  const oldHub = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 1500'], { windowsHide: true, stdio: 'ignore' });
  k.kids.push(oldHub);
  k.setPlan({ pid: oldHub.pid });
  const seen = new Set();
  const helper = k.start();
  const timer = setInterval(() => { const s = k.progress(); if (s) seen.add(`${s.step}:${s.state}`); }, 100);
  await exited(helper);
  clearInterval(timer);
  const s = k.progress();
  assert.ok(seen.has('1:running'), `看到了第 1 步：${[...seen]}`);
  assert.equal(s.state, 'done');
  assert.equal(s.step, 4);
  assert.equal(s.total, 4);
  assert.equal(s.version, '5.6.21');
  assert.ok(Date.parse(s.startedAt) && Date.parse(s.stepStartedAt) && Date.parse(s.updatedAt));
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.equal(k.result().ok, true);
  k.done();
});

test('升级途中再点图标：新启动的程序交给进度窗并退出；升级结束后照常启动', winOnly, async () => {
  const k = makeCase();
  const oldHub = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 4'], { windowsHide: true, stdio: 'ignore' });
  k.kids.push(oldHub);
  k.setPlan({ pid: oldHub.pid });
  assert.equal(guard.deferToRunningUpgrade({ dataDir: k.dataDir }), false, '没在升级时照常启动');
  const helper = k.start();
  assert.ok(await k.waitFor(() => k.progress()?.state === 'running'));
  assert.equal(guard.deferToRunningUpgrade({ dataDir: k.dataDir }), true, '升级进行中：交给进度窗');
  const flag = JSON.parse(fs.readFileSync(k.p.focus, 'utf8'));
  assert.ok(flag.at && flag.pid, '留下了「用户又点了」的标记');
  await exited(helper);
  assert.equal(k.progress().state, 'done');
  assert.equal(guard.deferToRunningUpgrade({ dataDir: k.dataDir }), false, '升级完成：新版照常启动');
  k.done();
});

test('升级守卫：进度过期、脚本已结束、读不出来时都照常启动', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upg-'));
  const root = path.join(dataDir, 'app-update'); fs.mkdirSync(root, { recursive: true });
  assert.equal(guard.runningUpgrade(dataDir), null, '没有进度文件');
  fs.writeFileSync(path.join(root, 'progress.json'), '{bad');
  assert.equal(guard.runningUpgrade(dataDir), null, '进度文件损坏');
  fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ state: 'running', updatedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(root, 'helper.lock'), '');
  assert.equal(guard.runningUpgrade(dataDir), null, '锁没人占着（脚本已经结束）');
  fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ state: 'running', updatedAt: new Date(Date.now() - 10 * 60000).toISOString() }));
  assert.equal(guard.runningUpgrade(dataDir), null, '进度十分钟没更新');
  assert.equal(guard.deferToRunningUpgrade({ dataDir: null }), false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('另开的 Hub 最小化在托盘（没有窗口）：不再被当残留直接结束；没有进度窗时不硬换并点名', winOnly, async () => {
  const k = makeCase();
  const other = await k.hold({ asHub: true });
  const r = k.runSync();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(alive(other), '用户另开的 Hub 没被结束');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
  assert.equal(k.result().ok, false);
  assert.match(k.result().reason, /还有别的 Hub 开着，这次没有升级.*FakeHub/);
  k.done();
});

test('别的 Hub 开着：进度窗里问「关闭它们并继续升级」，同意后关掉再换', winOnly, async () => {
  const k = makeCase({ assumeUi: true });
  const other = await k.hold({ asHub: true });
  const helper = k.start();
  const ask = await k.waitFor(() => { const s = k.progress(); return s && s.need === 'close-others' ? s : null; });
  assert.ok(ask, '进度窗收到了要用户选择的提示');
  assert.equal(ask.others.length, 1);
  assert.match(ask.others[0], /FakeHub（最小化到托盘，进程 \d+）/);
  assert.ok(alive(other), '用户没点之前不动它');
  k.decide('close-others');
  await exited(helper);
  assert.ok(!alive(other) || await Promise.race([exited(other).then(() => true), sleep(3000).then(() => false)]), '同意后关掉了');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.equal(k.result().ok, true);
  assert.equal(k.progress().state, 'done');
  k.done();
});

test('别的 Hub 开着、用户选「这次先不升级」：不换、不结束它、说清原因', winOnly, async () => {
  const k = makeCase({ assumeUi: true });
  const other = await k.hold({ asHub: true });
  const helper = k.start();
  assert.ok(await k.waitFor(() => k.progress()?.need === 'close-others'));
  k.decide('cancel');
  await exited(helper);
  assert.ok(alive(other));
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
  assert.match(k.result().reason, /还有别的 Hub 开着，这次没有升级/);
  assert.equal(k.progress().state, 'failed');
  k.done();
});

test('主程序退出后残留的子进程（带 --type=）占着文件：自动结束后换上', winOnly, async () => {
  const k = makeCase();
  const child = await k.hold({ asHub: true, tag: '--type=gpu-process' });
  const t0 = Date.now();
  const r = k.runSync();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.equal(k.result().ok, true);
  await Promise.race([exited(child), sleep(3000)]);
  assert.ok(!alive(child), '残留子进程已结束');
  assert.ok(Date.now() - t0 < 25000, `用时 ${Date.now() - t0}ms`);
  k.done();
});

test('替换失败已还原：进度窗给出原因和「结束占用的程序并重试」，重试成功', winOnly, async () => {
  const k = makeCase({ assumeUi: true });
  const holder = await k.hold({ asHub: false, seconds: 60 });
  const helper = k.start();
  const failed = await k.waitFor(() => { const s = k.progress(); return s && s.need === 'retry' ? s : null; });
  assert.ok(failed, '给出了重试');
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /替换 app\.asar 失败：文件被占用/);
  assert.doesNotMatch(failed.reason, /别的 Hub|（（/, '占用的是外部程序，不能说成别的 Hub');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar', '失败时是原来的版本');
  holder.kill(); await exited(holder);
  k.decide('retry');
  await exited(helper);
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.equal(k.result().ok, true);
  assert.equal(k.progress().state, 'done');
  k.done();
});

test('旧窗口一直不退出（会话没保存完、Hub 取消了关闭）：不替换，也不再多开一个旧版', winOnly, async () => {
  const k = makeCase({ waitSeconds: 2, relaunch: true });
  const marker = path.join(k.dataDir, 'relaunched.flag');
  // relaunch 用的 exe 换成一个只写标记的程序：被拉起就说明又开了一个。
  k.setPlan({ exe: PS, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Set-Content -LiteralPath '${q(marker)}' -Value x`] });
  const oldHub = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'], { windowsHide: true, stdio: 'ignore' });
  k.kids.push(oldHub);
  k.setPlan({ pid: oldHub.pid });
  const r = k.runSync();
  assert.equal(r.status, 1);
  assert.equal(k.result().ok, false);
  assert.match(k.result().reason, /旧窗口一直没有退出/);
  assert.equal(k.progress().state, 'failed');
  await sleep(800);
  assert.equal(fs.existsSync(marker), false, '没有再拉起旧版');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
  k.done();
});

test('替换脚本和进度小窗都能被 Windows PowerShell 5.1 解析', winOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upparse-'));
  for (const [name, body] of [['helper.ps1', HELPER], ['ui.ps1', PROGRESS_UI]]) {
    const file = path.join(dir, name); fs.writeFileSync(file, '﻿' + body, 'utf8');
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', `$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${q(file)}',[ref]$null,[ref]$e);$e.Count`], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '0', `${name} 有语法错误`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('进度小窗：各状态都能画出来（不显示窗口）', winOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upui-'));
  const ui = path.join(dir, 'upgrade-progress.ps1');
  fs.writeFileSync(ui, '\uFEFF' + PROGRESS_UI, 'utf8');
  const now = Date.now(), iso = ms => new Date(now - ms).toISOString();
  const base = { version: '5.6.21', from: '5.6.20', product: 'AI Hub', total: 4, startedAt: iso(25000), updatedAt: iso(0), helperPid: process.pid };
  const states = {
    running: { ...base, state: 'running', step: 2, label: '等待后台进程收尾', typical: '通常 0–10 秒', stepStartedAt: iso(6000) },
    focus: { ...base, state: 'running', step: 1, label: '保存会话并关闭旧窗口', typical: '通常 3–20 秒', stepStartedAt: iso(12000), focusNote: '你刚才又点了一次图标：升级还在进行，完成后会自动打开新版，不用再点。' },
    others: { ...base, state: 'running', step: 2, label: '还有别的 Hub 开着', typical: '', stepStartedAt: iso(3000), need: 'close-others', others: ['AI Hub（最小化到托盘，进程 1234）'] },
    retry: { ...base, state: 'failed', step: 3, label: '这次没换成，已恢复原版本', typical: '', stepStartedAt: iso(2000), need: 'retry', reason: '替换 app.asar 失败：文件被占用', leftovers: ['OpenConsole(4321)'] },
    done: { ...base, state: 'done', step: 4, label: '打开新版本', typical: '通常 3–10 秒', stepStartedAt: iso(500) },
  };
  for (const [name, s] of Object.entries(states)) {
    const stateFile = path.join(dir, `${name}.json`), png = path.join(dir, `${name}.png`);
    fs.writeFileSync(stateFile, JSON.stringify(s), 'utf8');
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', ui, '-Dir', dir, '-Snapshot', png, '-State', stateFile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(fs.statSync(png).size > 2000, `${name} 画出来了`);
  }
  if (process.env.AI_HUB_UPX_SNAPSHOT_DIR) for (const n of Object.keys(states)) fs.copyFileSync(path.join(dir, `${n}.png`), path.join(process.env.AI_HUB_UPX_SNAPSHOT_DIR, `upgrade-progress-${n}.png`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('点「立即重启」写的计划带进度窗；静默替换和测试开关下不开', () => {
  const { stageIncremental } = require('../core/app-update/apply.js');
  const { packPayload } = require('../core/app-update/payload.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upst-'));
  const res = path.join(root, 'res'); fs.mkdirSync(res); fs.writeFileSync(path.join(res, 'app.asar'), 'x');
  const gz = path.join(root, 'p.gz'); packPayload(res, gz);
  const r = stageIncremental({ dataDir: path.join(root, 'data'), payloadFile: gz, resourcesDir: res, version: '1.0.1', from: '1.0.0', exe: 'C:\\x\\Hub.exe', progressUi: true, productName: 'AI Hub' });
  assert.equal(r.plan.progressUi, true);
  assert.equal(r.plan.leftoverWaitSeconds, 10, '安装目录里的其他残留最多再等 10 秒（原来 30 秒）');
  assert.ok(fs.existsSync(r.paths.progressUi));
  assert.equal(r.plan.progressFile, r.paths.progress);
  assert.match(HELPER, /if \(-not \$p\.progressUi -or \$p\.quiet -or \$Elevated/);
  assert.match(HELPER, /CreateNoWindow = \$true/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('静默替换（关 Hub 时顺手换）不写进度：升级守卫不会拦下用户紧接着的打开', winOnly, () => {
  const k = makeCase({ quiet: true });
  const r = k.runSync();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
  assert.equal(fs.existsSync(k.p.progress), false);
  assert.equal(guard.runningUpgrade(k.dataDir), null);
  k.done();
});

// ---- 2026-11-13 Codex 审查返工（r1 三处必须项） ----

test('读不到命令行（WMI 被禁用）时托盘 Hub 也不被直接结束：没有进度窗就不换', winOnly, async () => {
  const k = makeCase({ simulateNoWmi: true });
  const other = await k.hold({ asHub: true });
  const r = k.runSync();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(alive(other), '认不出是不是主程序时，不能当残留结束');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
  assert.equal(k.result().ok, false);
  assert.match(k.result().reason, /还有别的 Hub 开着，这次没有升级.*FakeHub/);
  k.done();
});

test('读不到命令行时：进度窗里先问，用户不同意就不换、不结束', winOnly, async () => {
  const k = makeCase({ simulateNoWmi: true, assumeUi: true });
  const other = await k.hold({ asHub: true });
  const helper = k.start();
  const ask = await k.waitFor(() => { const s = k.progress(); return s && s.need === 'close-others' ? s : null; });
  assert.ok(ask, '认不出时当作需要用户确认');
  assert.match(ask.others[0], /FakeHub（没有窗口，可能是最小化到托盘的 Hub，进程 \d+）/);
  assert.ok(alive(other));
  k.decide('cancel');
  await exited(helper);
  assert.ok(alive(other), '没同意就不结束');
  assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
  assert.equal(k.result().ok, false);
  k.done();
});

test('回滚也失败：立即停，不给重试、不自动重开，原备份改名留着', winOnly, async () => {
  const k = makeCase({ assumeUi: true, simulateFailure: '模拟替换出错', simulateRestoreFailure: true, relaunch: true });
  const marker = path.join(k.dataDir, 'relaunched.flag');
  k.setPlan({ exe: PS, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Set-Content -LiteralPath '${q(marker)}' -Value x`] });
  const seen = new Set();
  const helper = k.start();
  const timer = setInterval(() => { const s = k.progress(); if (s) seen.add(`${s.state}:${s.need || ''}`); }, 100);
  const fin = await k.waitFor(() => { const s = k.progress(); return s && s.restoreFailed ? s : null; });
  assert.ok(fin, '进度窗收到了「没能恢复」');
  assert.equal(fin.state, 'failed');
  assert.equal(fin.need, undefined, '不给重试按钮');
  assert.match(fin.reason, /没能把原来的文件全部恢复.*完整安装包.*backup-restore-failed-/);
  k.decide('close');
  const code = await new Promise(r => (alive(helper) ? helper.once('exit', c => r(c)) : r(helper.exitCode)));
  clearInterval(timer);
  assert.equal(code, 1);
  assert.ok(![...seen].some(x => x.endsWith(':retry')), `没出现过重试：${[...seen]}`);
  const res = k.result();
  assert.equal(res.ok, false);
  assert.equal(res.restoreFailed, true);
  assert.equal(res.rolledBack, false, '不能说成已恢复');
  await sleep(800);
  assert.equal(fs.existsSync(marker), false, '没有自动重开');
  const kept = fs.readdirSync(k.p.root).filter(n => n.startsWith('backup-restore-failed-'));
  assert.equal(kept.length, 1, '原备份改名留着，下次升级不会覆盖');
  assert.equal(fs.readFileSync(path.join(k.p.root, kept[0], 'app.asar'), 'utf8'), 'old-asar');
  assert.equal(fs.existsSync(path.join(k.p.root, 'backup')), false);
  k.done();
});

test('升级守卫：打开锁文件没权限（EPERM/EACCES）不算在升级，照常启动；只有共享冲突（EBUSY）才拦', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upg-perm-'));
  const root = path.join(dataDir, 'app-update'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ state: 'running', updatedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(root, 'helper.lock'), '');
  const orig = fs.openSync;
  try {
    for (const code of ['EPERM', 'EACCES']) {
      fs.openSync = () => { const e = new Error(code); e.code = code; throw e; };
      assert.equal(guard.runningUpgrade(dataDir), null, `${code} 放行`);
      assert.equal(guard.deferToRunningUpgrade({ dataDir }), false, `${code} 不退出`);
    }
    fs.openSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
    assert.ok(guard.runningUpgrade(dataDir), 'EBUSY（脚本独占着锁）才算在升级');
  } finally { fs.openSync = orig; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// 受保护目录仍由普通权限父脚本重开；进度窗存活时也不能等用户再点一次「先用原来的版本」。
for (const mode of ['cancel', 'plain']) {
  test(`受保护目录 ${mode}：失败结果写出后自动重开，不等待进度窗决定`, winOnly, async () => {
    const k = makeCase({ assumeUi: true, relaunch: true, elevateMode: mode });
    const marker = path.join(k.dataDir, 'relaunched.json');
    const script = path.join(k.dataDir, 'mark-relaunch.ps1');
    fs.writeFileSync(script, `@{ elevated = [bool]$Elevated; parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId } | ConvertTo-Json | Set-Content -LiteralPath '${q(marker)}'`, 'utf8');
    k.setPlan({ exe: PS, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script] });
    const sidResult = spawnSync(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(sidResult.status, 0, sidResult.stderr);
    const sid = sidResult.stdout.trim().split(',').pop().replace(/"/g, '');
    const resources = path.dirname(k.asar);
    // 只限制本用例的临时安装目录；清理前恢复，不改用户或生产目录权限。
    const acl = spawnSync('icacls.exe', [resources, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', `*${sid}:(OI)(CI)RX`, '/Q'], { windowsHide: true, encoding: 'utf8' });
    try {
      assert.equal(acl.status, 0, acl.stdout + acl.stderr);
      assert.throws(() => fs.writeFileSync(path.join(resources, 'probe.tmp'), 'x'), /EPERM|EACCES/);
      const helper = k.start();
      const started = Date.now();
      const restarted = await k.waitFor(() => fs.existsSync(marker), 20000);
      assert.ok(restarted, `写出结果后应自动重开；当前进度：${JSON.stringify(k.progress())}`);
      assert.ok(await k.waitFor(() => !alive(helper), 5000), '父脚本已结束，没有留在 600 秒的等待里');
      assert.ok(Date.now() - started < 25000);
      const r = k.result();
      assert.equal(r.ok, false);
      assert.equal(r.restoreFailed, false);
      assert.equal(r.elevated, mode === 'plain');
      assert.equal(r.rolledBack, mode === 'plain');
      assert.match(r.reason, mode === 'cancel' ? /管理员授权.*没有替换任何文件/ : /没有写入安装目录的权限|访问被拒绝|denied/i);
      assert.equal(fs.readFileSync(k.asar, 'utf8'), 'old-asar');
      assert.equal(k.progress().state, 'gave-up');
      assert.equal(k.progress().need, undefined, '权限失败不再提示结束占用进程');
      const launch = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(launch.parent, helper.pid, '普通权限父脚本负责重开，管理员副本只写结果');
      assert.equal(guard.deferToRunningUpgrade({ dataDir: k.dataDir }), false, '启动锁已释放');
    } finally {
      spawnSync('icacls.exe', [resources, '/reset', '/T', '/Q'], { windowsHide: true });
      k.done();
    }
  });
}

test('管理员副本替换成功：普通权限父脚本重开，成功进度不被启动锁拦住', winOnly, async () => {
  const k = makeCase({ assumeUi: true, relaunch: true, elevateMode: 'plain' });
  try {
    const marker = path.join(k.dataDir, 'relaunched-parent.txt');
    const script = path.join(k.dataDir, 'mark-relaunch.ps1');
    fs.writeFileSync(script, `(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId | Set-Content -LiteralPath '${q(marker)}'`, 'utf8');
    k.setPlan({ exe: PS, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script] });
    // 普通权限模拟授权成功：仅强制进入授权分支，管理员副本仍执行原版替换逻辑，不弹真实 UAC。
    fs.writeFileSync(k.p.helper, '\uFEFF' + HELPER.replace('if (Test-Writable $p.resourcesDir)', 'if ($false)'), 'utf8');
    const helper = k.start();
    assert.ok(await k.waitFor(() => fs.existsSync(marker), 20000), '替换成功后重开');
    assert.equal(Number(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, '').trim()), helper.pid);
    assert.ok(await k.waitFor(() => !alive(helper), 5000));
    assert.equal(k.result().ok, true);
    assert.equal(k.result().elevated, true);
    assert.equal(fs.readFileSync(k.asar, 'utf8'), 'new-asar');
    assert.equal(k.progress().state, 'done');
    assert.equal(guard.deferToRunningUpgrade({ dataDir: k.dataDir }), false);
  } finally { k.done(); }
});
