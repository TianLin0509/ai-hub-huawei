'use strict';
// 试跑（定位中心）：用将来启动时同一条命令跑一次（只多 --version 这类参数），隐藏窗口、限时、限并发。
//   - 单次 10 秒超时，超时只结束自己起的这一棵进程树；
//   - 只对 1 秒内的快速失败重试 1 次（刚装完、杀毒软件正在扫描时偶发）；
//   - 全局最多 4 个试跑同时进行；
//   - 在系统临时目录里跑，不读写用户的项目目录。
// 测试里整个 run 函数可以替换成假的（locator 的 deps.run）。
const os = require('node:os');

function createLimiter(max = 4) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

function cmdQuote(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_.=:\\/-]+$/.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
}

// 真正起进程：.cmd/.bat 经 cmd.exe 原样传命令行；.ps1 经 Windows PowerShell -File（不改执行策略，被拦就如实报）。
function spawnOnce({ command, args = [], env = process.env, cwd = os.tmpdir(), shell = '', timeoutMs = 10000 }, { execFileImpl } = {}) {
  const cp = require('node:child_process');
  const run = execFileImpl || cp.execFile;
  const t0 = Date.now();
  return new Promise(resolve => {
    let child = null, done = false, timer = null;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); resolve({ ...v, ms: Date.now() - t0 }); };
    const opts = { windowsHide: true, encoding: 'utf8', env, cwd, maxBuffer: 512 * 1024 };
    const callback = (error, stdout, stderr) => finish({
      code: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
      errno: error && !Number.isInteger(error.code) ? String(error.code || '') : '',
      error: error ? String(error.message || error) : '',
      stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: false,
    });
    try {
      if (shell === 'cmd' || (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command))) {
        const line = `"call ${cmdQuote(command)}${args.length ? ' ' + args.map(cmdQuote).join(' ') : ''}"`;
        child = run(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true }, callback);
      } else if (shell === 'ps1' || /\.ps1$/i.test(command)) {
        const ps = require('../windows-powershell').windowsPowerShellPath(env);
        child = run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', command, ...args], opts, callback);
      } else child = run(command, args, opts, callback);
    } catch (error) { finish({ code: null, errno: String(error.code || ''), error: String(error.message || error), stdout: '', stderr: '', timedOut: false }); return; }
    // 不 unref：这个计时器负责让卡住的试跑按时返回。
    timer = setTimeout(() => {
      finish({ code: null, errno: 'ETIMEDOUT', error: `${Math.round(timeoutMs / 1000)} 秒没有返回`, stdout: '', stderr: '', timedOut: true });
      const pid = child && child.pid;
      if (pid && process.platform === 'win32') { try { cp.execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* 已退出 */ } }
      else { try { child && child.kill(); } catch { /* 已退出 */ } }
    }, timeoutMs);
  });
}

// 一次试跑（含快速失败重试一次）。ok 的判定由 verdict.js 做，这里只管跑。
async function trial(spec, { run = spawnOnce, limit, retryWindowMs = 1000, retryDelayMs = 300, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const once = () => (limit ? limit(() => run(spec)) : run(spec));
  let r = await once();
  const failed = r.timedOut ? false : (r.code !== 0 || !!r.errno);
  if (failed && r.ms < retryWindowMs && r.errno !== 'ENOENT') {
    await sleep(retryDelayMs);
    const again = await once();
    r = { ...again, retried: true };
  }
  return r;
}

module.exports = { spawnOnce, trial, createLimiter, cmdQuote };
