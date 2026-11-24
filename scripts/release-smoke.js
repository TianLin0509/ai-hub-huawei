#!/usr/bin/env node
'use strict';
// 发版前核心路径冒烟（2026-11-23）：把「用户每天必走、坏了就用不了」的几条真实界面路径各起一个隔离 Hub 跑一遍。
// 起因：v5.6.82–90 群聊回车发不出连发 9 版没人发现——单测全过，只有真实界面运行时才暴露。
// 每条路径都是 tests/ 下现成的 e2e 脚本：隐藏窗口、临时数据目录、替身 CLI / 假后端，不碰生产 Hub、不用真实 token。
// 失败的路径自动重跑一次再判（偶发抖动不拦车，两次都挂才算坏）。
//
//   node scripts/release-smoke.js                 跑全部路径（默认 3 条并行）
//   node scripts/release-smoke.js --only core,group-enter --jobs 2 --out D:/Temp/smoke-x
//   node scripts/release-smoke.js --list          列出路径
//   HUB_SMOKE_ENTRY=<另一份代码目录>              对另一份代码跑（默认本仓库）
//
// 发版时由 scripts/member-release.js 调用（runSmokeDetached：独立低优先级子进程），不过就不发车、版本号不占用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 单条路径的超时。正常 20～70 秒跑完；发版时和预检抢 CPU 会慢几倍，放宽到 7 分钟只拦真卡死。
const STEP_TIMEOUT_MS = 420000;

// name 是给人看的路径名；script 相对代码根目录；outEnv / outArg 指明该脚本把截图日志写到哪（统一引到本次运行目录，不写进仓库）。
const PATHS = [
  { id: 'core', name: '首页出来、设置页能开、新建普通会话回车发出、问问 Hub 发问', script: 'tests/e2e-release-smoke-core-cdp.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'group-enter', name: '群聊回车发送、换行与提取回答', script: 'tests/e2e-group-enter-send-cdp.js', outEnv: 'HUB_ENTER_E2E_OUT', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'home-composer', name: '主页建群聊并发言、单会话输入框发送与长消息编辑', script: 'tests/e2e-home-mid-composer-cdp.js', outArg: '--out', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'boot-splash', name: '启动画面播放、跳过与重启后照常进入', script: 'tests/e2e-boot-splash-cdp.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'first-run', name: '全新用户第一次打开：准备页自动进入主页，第二次不再等', script: 'tests/e2e-first-run-prep-cdp.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'session-restart', name: '右键重启会话后聊天框和左栏还在、仍停在该会话', script: 'tests/e2e-session-restart-ui-cdp.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: STEP_TIMEOUT_MS },
  { id: 'crash-recovery', name: '界面进程崩了自动重新载入、会话还在', script: 'tests/e2e-renderer-crash-recovery-cdp.js', outEnv: 'HUB_E2E_ARTIFACT_DIR', timeoutMs: STEP_TIMEOUT_MS },
];

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 只结束自己起的进程树（按 PID，不按命令行子串）
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 已退出 */ }
}

// 这条路径起的进程是否都收干净了：隔离 Hub 的 Chromium 子进程命令行带着数据目录（在本路径专属临时目录下），
// 替身 CLI 的命令行也带；主 Electron 进程不带，按「是这些进程的父进程且是 electron」补上。
// 匹配串经环境变量传进去，查询命令自己的命令行里没有它，不会误认自己。查询失败返回 null（不判失败）。
function findLeftovers(tmp) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = '$n=$env:HS_LEFTOVER_NEEDLE.ToLower(); $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine);'
    + ' $hit=@($all | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($n) });'
    + ' $ids=@($hit | ForEach-Object { $_.ProcessId }); $par=@($hit | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique);'
    + " $ids += @($all | Where-Object { $par -contains $_.ProcessId -and $_.Name -eq 'electron.exe' } | ForEach-Object { $_.ProcessId });"
    + " ($ids | Sort-Object -Unique) -join ','";
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30000, env: { ...process.env, HS_LEFTOVER_NEEDLE: tmp } },
      (error, stdout) => resolve(error ? null : String(stdout).trim().split(',').map(Number).filter(n => n > 0 && n !== process.pid)));
  });
}

// 子进程退出后最多等约 6 秒让 Chromium 子进程自然散掉，仍在的就是没收干净：按 PID 结束
async function checkTeardown(tmp, find, kill, pauseMs = 2000) {
  let left = [];
  for (let i = 0; i < 4; i++) {
    left = await find(tmp);
    if (left === null) return { checked: false, leftovers: [] };
    if (!left.length) return { checked: true, leftovers: [] };
    if (i < 3) await new Promise(r => setTimeout(r, pauseMs));
  }
  for (const pid of left) kill(pid);
  return { checked: true, leftovers: left };
}

// 各 e2e 脚本的收尾行不统一：有 PASS 行、没有 FAIL，或末尾 JSON 带 "ok":true，就算步骤都过了
function looksPassed(tail) {
  return !/\bFAIL\b|"ok"\s*:\s*false/.test(tail) && /\bPASS\b|"ok"\s*:\s*true/.test(tail);
}

function runOnce(p, { entry, dir, attempt, children, find = findLeftovers, kill = killTree, pauseMs }) {
  const out = path.join(dir, `${p.id}-${attempt}`);
  fs.mkdirSync(out, { recursive: true });
  // 子测试的临时目录要短：替身 CLI（Windows PowerShell 5.1）按工作目录拼会话记录路径，超过 260 字符就写不进去
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hs-${p.id}-`));
  const log = path.join(out, `${p.id}-${attempt}.log`);
  const fd = fs.openSync(log, 'w');
  const args = [path.join(entry, p.script), ...(p.outArg ? [p.outArg, out] : [])];
  const env = { ...process.env, TEMP: tmp, TMP: tmp, ...(p.outEnv ? { [p.outEnv]: out } : {}) };
  const started = Date.now();
  return new Promise(resolve => {
    // 输出直写文件：调用方在做同步预检时管道不会被塞满卡住子进程
    const child = spawn(process.execPath, args, { cwd: entry, env, stdio: ['ignore', fd, fd], windowsHide: true });
    child.tmp = tmp;
    children.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, p.timeoutMs);
    let finished = false;
    const done = async (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); children.delete(child);
      try { fs.closeSync(fd); } catch { /* 已关 */ }
      // 退出码 0 不等于收干净：e2e 脚本可能吞掉 gracefulQuit 的失败。调度器自己查一遍，残留就按 PID 结束并判失败
      const teardown = await checkTeardown(tmp, find, kill, pauseMs);
      const dirty = teardown.leftovers.length > 0;
      let tail = '';
      try { tail = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-6).join('\n'); } catch { /* 没日志 */ }
      if (dirty) tail += `\n[冒烟调度] 测试结束后还有 ${teardown.leftovers.length} 个进程没收干净（PID ${teardown.leftovers.join(',')}），已结束，按失败计`;
      // 超时时区分「步骤都 PASS 了、只是进程不退出」和「卡在某一步」，只影响提示，两种都判失败
      const exitStuck = timedOut && looksPassed(tail);
      resolve({ ok: !timedOut && code === 0 && !dirty, code, timedOut, exitStuck, teardown, error: error && error.message,
        seconds: Math.round((Date.now() - started) / 1000), log, out, tmp, tail });
    };
    child.on('error', error => { void done(null, error); });
    child.on('exit', code => { void done(code); });
  });
}

// 跑一组路径；返回 { ok, results, dir, seconds, abort }。results 每项：{ id, name, ok, flaky, attempts:[...] }
function runSmoke({ entry = process.env.HUB_SMOKE_ENTRY || ROOT, only = null, jobs = 3, dir = null, onProgress = () => {}, paths = PATHS,
  findLeftovers: find = findLeftovers, killPid: kill = killTree, teardownPauseMs: pauseMs = 2000 } = {}) {
  const list = only ? paths.filter(p => only.includes(p.id)) : paths;
  const unknown = only ? only.filter(id => !paths.some(p => p.id === id)) : [];
  if (unknown.length) throw new Error('没有这些冒烟路径：' + unknown.join('、'));
  dir = path.resolve(dir || path.join(os.tmpdir(), `${stamp()}-hub-release-smoke`));
  fs.mkdirSync(dir, { recursive: true });
  const children = new Set();
  let aborted = false;
  // 中途打断：结束自己起的进程树，删掉被打断那几条的临时数据（结果不完整，留着没用）
  const abort = () => { aborted = true; for (const c of children) { killTree(c.pid); try { fs.rmSync(c.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* 文件仍被占用 */ } } };
  const started = Date.now();
  const results = [];
  const queue = list.slice();
  const worker = async () => {
    while (queue.length && !aborted) {
      const p = queue.shift();
      const attempts = [await runOnce(p, { entry, dir, attempt: 1, children, find, kill, pauseMs })];
      if (!attempts[0].ok && !aborted) {
        onProgress({ id: p.id, name: p.name, event: 'retry', attempt: attempts[0] });
        attempts.push(await runOnce(p, { entry, dir, attempt: 2, children, find, kill, pauseMs }));
      }
      const last = attempts[attempts.length - 1];
      const r = { id: p.id, name: p.name, ok: last.ok, flaky: last.ok && attempts.length > 1, attempts };
      results.push(r);
      onProgress({ ...r, event: 'done' });
    }
  };
  const promise = Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, list.length)) }, worker)).then(() => {
    const ok = !aborted && results.length === list.length && results.every(r => r.ok);
    const summary = { ok, entry, dir, seconds: Math.round((Date.now() - started) / 1000), results: list.map(p => results.find(r => r.id === p.id)).filter(Boolean) };
    fs.writeFileSync(path.join(dir, 'release-smoke-summary.json'), JSON.stringify(summary, null, 2));
    // 通过的那次就删掉可重建的临时数据（隔离 Hub 的数据目录）；失败的那次留着排查
    for (const r of summary.results) for (const a of r.attempts) if (a.ok) { try { fs.rmSync(a.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 文件被占用时留着 */ } }
    return summary;
  });
  return { promise, abort, dir };
}

// 发版用：调度放进独立的低优先级子进程跑。
// 2026-11-24 首班实测：调度和预检同在发版进程里，预检同步执行约 4 分钟，期间事件循环停摆——
// core 等 3 条 22～35 秒就全部 PASS 并退出，调度却要等预检结束才收到退出事件，计时器又先触发，被误判超时，重跑后总时长 353 秒。
// 子进程有自己的事件循环，计时和收尾检查都按真实时间走；低优先级（Windows 下其后代 Electron 一并继承）让预检先用 CPU。
function runSmokeDetached({ entry = ROOT, jobs = 3, dir = null, lowPriority = true, script = __filename } = {}) {
  dir = path.resolve(dir || path.join(os.tmpdir(), `${stamp()}-hub-release-smoke`));
  fs.mkdirSync(dir, { recursive: true });
  // 各路径的隔离临时目录都建在这个短目录下（子进程的 TEMP），中途打断时整个删掉
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hsr-'));
  const fd = fs.openSync(path.join(dir, 'release-smoke-scheduler.log'), 'w');
  const child = spawn(process.execPath, [script, '--out', dir, '--jobs', String(jobs)],
    { cwd: entry, env: { ...process.env, HUB_SMOKE_ENTRY: entry, TEMP: tmpRoot, TMP: tmpRoot }, stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  if (lowPriority) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 调不了优先级就按普通跑 */ } }
  let ended = false;
  const promise = new Promise(resolve => {
    const finish = error => {
      if (ended) return;
      ended = true;
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'release-smoke-summary.json'), 'utf8')); } catch { /* 没写出汇总 */ }
      if (!summary) summary = { ok: false, entry, dir, seconds: 0, results: [], error: `冒烟调度进程异常结束（${error ? error.message : '没有写出汇总'}），日志 ${path.join(dir, 'release-smoke-scheduler.log')}` };
      try { fs.rmdirSync(tmpRoot); } catch { /* 有失败路径的数据留着排查 */ }
      resolve(summary);
    };
    child.on('error', finish);
    child.on('exit', () => finish());
  });
  const abort = () => {
    if (ended) return;
    killTree(child.pid);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* 文件仍被占用 */ }
  };
  return { promise, abort, dir, pid: child.pid };
}

function describe(summary) {
  const lines = [];
  for (const r of summary.results) {
    const last = r.attempts[r.attempts.length - 1];
    const secs = r.attempts.map(a => a.seconds + 's').join(' + ');
    if (r.ok) lines.push(`  ✓ ${r.name}（${secs}${r.flaky ? '，首次失败、重跑通过' : ''}）`);
    else {
      const why = last.exitStuck ? `步骤都过了，但 ${Math.round(STEP_TIMEOUT_MS / 1000)} 秒内进程没退出` : last.timedOut ? '超时' : last.code !== 0 ? '退出码 ' + last.code : '测试 Hub 没收干净';
      lines.push(`  ✗ ${r.name}（${secs}，${why}，重跑仍失败）`);
      lines.push(`      日志：${last.log}`);
      lines.push(`      截图：${last.out}；隔离 Hub 数据：${last.tmp}`);
      if (last.tail) lines.push(...last.tail.split('\n').map(l => '      | ' + l.slice(0, 240)));
    }
  }
  if (summary.error) lines.push('  ✗ ' + summary.error);
  lines.push(`冒烟${summary.ok ? '全部通过' : '没通过'}：${summary.results.filter(r => r.ok).length}/${summary.results.length} 条路径，用时 ${summary.seconds} 秒，记录 ${path.join(summary.dir, 'release-smoke-summary.json')}`);
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') { for (const p of PATHS) console.log(`${p.id.padEnd(16)} ${p.name}  (${p.script})`); return; }
    if (argv[i] === '--only') opts.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--jobs') opts.jobs = Math.max(1, Number(argv[++i]) || 3);
    else if (argv[i] === '--out') opts.dir = argv[++i];
    else throw new Error('不认识的参数：' + argv[i]);
  }
  const run = runSmoke({ ...opts, onProgress: e => { if (e.event === 'retry') console.log(`  … ${e.name} 首次失败，自动重跑一次`); } });
  console.log(`冒烟开始：记录在 ${run.dir}`);
  const stop = () => { run.abort(); process.exit(130); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const summary = await run.promise;
  console.log(describe(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

module.exports = { PATHS, STEP_TIMEOUT_MS, runSmoke, runSmokeDetached, describe, looksPassed, findLeftovers, checkTeardown };
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
