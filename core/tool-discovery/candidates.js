'use strict';
// 外部工具「收集全部候选 → 读版本 → 选一个」的公共逻辑（2026-11-07，5.5.24）。
// welink-cli、PPT Doctor、CodeAgent 都可能在一台电脑上装了好几份（npm 全局目录、旧安装目录、改过名的副本……），
// 以前各自「找到第一个就用」，用到的常常是旧版本。这里只做纯逻辑和读版本，不认识具体工具；
// 每个工具从哪些目录找、怎样算能用，由 core/tool-discovery/tools.js 决定。
const fs = require('node:fs');
const path = require('node:path');

// 版本号按数字逐段比（1.2615.02.01 与 1.2615.2.1 相同，缺的段当 0）；读不懂的排在最后。
function parseVersion(version) {
  const m = /(\d+(?:\.\d+)*)/.exec(String(version || ''));
  return m ? m[1].split('.').map(Number) : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
const sameVersion = (a, b) => compareVersions(a, b) === 0 && !!parseVersion(a) === !!parseVersion(b);

// 去重用的键：解开 junction / 符号链接 / 8.3 短名后的真实路径，Windows 上不分大小写。
function realKey(file, { fsModule = fs, platform = process.platform } = {}) {
  let real = path.resolve(String(file || ''));
  try { real = (fsModule.realpathSync.native || fsModule.realpathSync)(real); } catch { /* 不存在的按字面 */ }
  return platform === 'win32' ? real.replace(/\//g, '\\').toLowerCase() : real;
}
function isFile(file, fsModule = fs) {
  try { return fsModule.statSync(file).isFile(); } catch { return false; }
}

// 把候选路径（可带来源 via）去重、读版本、过滤掉跑不起来或校验不过的。
//   probe(file) → { ok: true, version } | { ok: false, reason }；version 读不出（超时等）时 ok 仍可为 true、version 为 null。
// 返回按原顺序（= 优先级）排列的可用候选：[{ path, version, via, order }]
async function collectCandidates(entries, { probe, fsModule = fs, platform = process.platform } = {}) {
  const seen = new Set(), list = [];
  for (const entry of entries || []) {
    const item = typeof entry === 'string' ? { path: entry } : entry;
    if (!item || !item.path || !path.isAbsolute(item.path) || !isFile(item.path, fsModule)) continue;
    const key = realKey(item.path, { fsModule, platform });
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ path: path.resolve(item.path), via: item.via || '', key });
  }
  const probed = await Promise.all(list.map(async (item, order) => {
    let result;
    try { result = probe ? await probe(item.path) : { ok: true, version: null }; } catch (error) { result = { ok: false, reason: error.message }; }
    return result && result.ok ? { path: item.path, version: result.version || null, via: item.via, order, key: item.key } : null;
  }));
  return probed.filter(Boolean);
}

// 推荐顺序：版本高的在前；版本相同按发现顺序（优先级）。
function rank(candidates) {
  return [...candidates].sort((a, b) => compareVersions(b.version, a.version) || a.order - b.order);
}

// 按规则选一个（纯函数）：
//   用户已指定且仍可用 → configured（不打扰）；
//   只有 1 个可用 → only（自动用，写回设置）；
//   多个、版本都一样 → same（按优先级取第一个，写回设置，不打扰）；
//   多个、版本不同 → newest（先用最高版本保证能用，界面出「点此切换」的提示，用户选完再写回）；
//   没有 → none。
// configuredMissing：用户指定过路径，但那个文件已经不在或跑不起来（被卸载 / 移动），这时回到扫描结果。
function choose(candidates, configured = '', { fsModule = fs, platform = process.platform } = {}) {
  const list = candidates || [];
  const ranked = rank(list);
  const versions = [];
  for (const c of ranked) if (!versions.some(v => sameVersion(v, c.version))) versions.push(c.version);
  const base = { candidates: ranked, versions: versions.length, configuredMissing: false };
  if (configured) {
    const key = realKey(configured, { fsModule, platform });
    const hit = list.find(c => c.key === key || realKey(c.path, { fsModule, platform }) === key);
    if (hit) return { ...base, pick: hit, reason: 'configured', writeBack: false };
    base.configuredMissing = true;
  }
  if (!ranked.length) return { ...base, pick: null, reason: 'none', writeBack: false };
  if (ranked.length === 1) return { ...base, pick: ranked[0], reason: 'only', writeBack: true };
  if (versions.length === 1) return { ...base, pick: [...list].sort((a, b) => a.order - b.order)[0], reason: 'same', writeBack: true };
  return { ...base, pick: ranked[0], reason: 'newest', writeBack: false };
}

// 跑「<程序> --version」读版本：隐藏窗口、有超时，只结束我们自己起的这个进程树。
//   .js / .cjs 是测试替身：用 Hub 自己的程序以 Node 方式运行；.cmd / .bat 经 cmd.exe 原样传命令行。
// 返回 { ok, version, reason }：程序起不来、退出码非 0 且没读到版本 → ok:false；超时 → ok:true、version:null（慢不等于坏，不能因此把它过滤掉）。
function probeVersion(file, { args = ['--version'], timeoutMs = 8000, env = process.env, parse = defaultParse, execFileImpl } = {}) {
  const { execFile } = require('node:child_process');
  const run = execFileImpl || execFile;
  return new Promise(resolve => {
    let finished = false, child = null;
    const done = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      done({ ok: true, version: null, reason: 'timeout' });
      const pid = child && child.pid;
      if (pid && process.platform === 'win32') run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { child && child.kill(); } catch { /* 已退出 */ } }
    }, timeoutMs);
    // 不 unref：这个计时器负责让卡住的读版本按时返回，unref 后进程可能先于它退出（11-07 CI 实测）。
    const callback = (error, stdout, stderr) => {
      const version = parse(String(stdout || '') + '\n' + String(stderr || ''));
      if (version) return done({ ok: true, version });
      if (error) return done({ ok: false, version: null, reason: error.code === 'ENOENT' ? '文件不存在' : `启动失败（${error.code ?? '未知原因'}）` });
      done({ ok: true, version: null, reason: 'no-version' });
    };
    const opts = { windowsHide: true, encoding: 'utf8', env, maxBuffer: 256 * 1024 };
    try {
      if (/\.c?js$/i.test(file)) child = run(process.execPath, [file, ...args], { ...opts, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }, callback);
      else if (/\.(?:cmd|bat)$/i.test(file) && process.platform === 'win32') {
        const line = `"call "${String(file).replace(/"/g, '')}" ${args.map(a => String(a).replace(/[^A-Za-z0-9_.=-]/g, '')).join(' ')}"`;
        child = run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true }, callback);
      } else child = run(file, args, opts, callback);
    } catch (error) { done({ ok: false, version: null, reason: error.message }); }
  });
}
function defaultParse(text) {
  for (const line of String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (/new version|update available|新版本|升级/i.test(line)) continue;
    const m = /(\d+\.\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/.exec(line);
    if (m) return m[1];
  }
  return '';
}

module.exports = { compareVersions, parseVersion, realKey, collectCandidates, choose, rank, probeVersion, defaultParse };
