'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const semver = require('semver');

function npmInvocation(env = process.env, platform = process.platform) {
  const dirs = String(env[Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'] || '').split(path.delimiter);
  for (const dir of dirs) {
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) {
      const node = require('../local-node').findNode({ env });
      if (node) return { file: node, prefix: [cli] };
    }
  }
  if (platform === 'win32') return { file: require('../windows-powershell').windowsPowerShellPath(), prefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& npm'] };
  return { file: 'npm', prefix: [] };
}
function killNpmTree(child, platform = process.platform, exec = execFile) {
  if (!child?.pid) return Promise.resolve();
  return new Promise(resolve => {
    try {
      if (platform === 'win32') exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolve);
      else { child.kill?.(); resolve(); }
    } catch { resolve(); /* This installation already exited. */ }
  });
}
function runNpm(args, { env = process.env, signal, timeoutMs = 600000, exec = execFile, platform = process.platform, kill = killNpmTree } = {}) {
  const invocation = npmInvocation(env, platform);
  let argv = [...invocation.prefix, ...args];
  if (invocation.prefix.at(-1) === '& npm') argv = [...invocation.prefix.slice(0, -1), '& npm ' + args.map(a => "'" + String(a).replace(/'/g, "''") + "'").join(' ')];
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, stopping = false;
    const finish = (error, stdout = '', stderr) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) reject(Object.assign(error, { stderr })); else resolve(String(stdout || '').trim());
    };
    const stop = async error => {
      if (settled || stopping) return; stopping = true;
      try { await kill(child, platform); } catch { /* Still report the original cancellation. */ }
      finish(error);
    };
    const onAbort = () => stop(Object.assign(new Error('npm 安装已取消'), { name: 'AbortError', cancelled: true }));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = exec(invocation.file, argv, {
        windowsHide: true, env, cwd: env.USERPROFILE || env.HOME || undefined,
        encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => { if (!stopping) finish(error, stdout, stderr); });
      child?.on?.('error', error => { if (!stopping) finish(error); });
      if (!settled) {
        timer = setTimeout(() => stop(Object.assign(new Error('npm 安装超时'), { code: 'ETIMEDOUT', killed: true })), timeoutMs);
        timer.unref?.();
      }
    } catch (error) { finish(error); }
  });
}
// global：「装到我的全局 npm」用 npm 的全局模式（--global --prefix），和用户自己 npm i -g 的结果一致——
// 命令入口 dsh.cmd 生成在全局目录本身（PATH 上的那个），而不是 node_modules 下的 .bin。Hub 自管目录用局部模式。
function globalLayout(prefix, platform = process.platform) {
  return platform === 'win32'
    ? { modules: path.join(prefix, 'node_modules'), shims: [path.join(prefix, 'dsh.cmd')] }
    : { modules: path.join(prefix, 'lib', 'node_modules'), shims: [path.join(prefix, 'bin', 'dsh')] };
}
async function installDshWithUserNpm({ env = process.env, signal, run = runNpm, onProgress = () => {}, targetRoot = null, global = false, platform = process.platform } = {}) {
  if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot)) throw new Error('DSH 安装目标必须显式指定绝对路径');
  const layout = global ? globalLayout(targetRoot, platform) : { modules: path.join(targetRoot, 'node_modules'), shims: [] };
  onProgress({ phase: 'npm-fallback' });
  // npm itself reads user/global npmrc and npm_config_*; no registry or proxy override.
  const readInstalled = name => {
    if (!targetRoot) return null;
    try { return JSON.parse(fs.readFileSync(path.join(layout.modules, name, 'package.json'), 'utf8')); } catch { return null; }
  };
  const version = String(readInstalled('@deepseek-ai/dsh')?.version || await run(['view', '@deepseek-ai/dsh', 'version'], { env, signal, timeoutMs: 30000 })).trim();
  if (!semver.valid(version)) throw new Error('npm 没有返回可用的 DSH 版本');
  let tuiName = ['@deepseek-ai/dsh-tui', '@deepseek-harness-tui/dsh-tui'].find(name => readInstalled(name)?.version) || '@deepseek-ai/dsh-tui', metadata;
  const readMeta = async spec => JSON.parse(await run(['view', spec, 'version', 'peerDependencies', '--json'], { env, signal, timeoutMs: 30000 }));
  try { metadata = await readMeta(tuiName + '@' + (readInstalled(tuiName)?.version || version)); }
  catch (error) {
    // The published terminal package currently has its own scope and version series.
    if (!/E404|ETARGET|not found|No match found/i.test(String(error.stderr || error.message))) throw error;
    tuiName = '@deepseek-harness-tui/dsh-tui';
    metadata = await readMeta(tuiName);
  }
  const validTui = value => {
    if (!semver.valid(value?.version || '')) throw new Error('npm 没有返回可用的 DSH 终端界面版本');
    return value;
  };
  const compatible = value => Object.entries(value.peerDependencies || {}).every(([name, range]) =>
    !(name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) || semver.satisfies(version, String(range), { includePrerelease: true }));
  validTui(metadata);
  if (!compatible(metadata)) {
    const previous = metadata.version;
    metadata = validTui(await readMeta(tuiName));
    if (!compatible(metadata)) throw new Error(`DSH ${version} 与 ${tuiName}@${previous} 不兼容，最新界面包 ${metadata.version} 也不兼容；组织版本不匹配，请安装组织提供的配套版本`);
  }
  const packages = ['@deepseek-ai/dsh@' + version, tuiName + '@' + metadata.version];
  for (const name of Object.keys(metadata.peerDependencies || {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    // Pin every DSH peer; npm validates its full semver range and reports any
    // dependency conflict, including prerelease, caret and tilde constraints.
    packages.push(name + '@' + version);
  }
  await run(['install', ...(global ? ['--global'] : []), '--prefix', targetRoot, ...packages], { env, signal });
  const prefix = targetRoot;
  const modules = layout.modules;
  const entry = path.join(modules, '@deepseek-ai/dsh/lib/bin.js');
  if (!path.isAbsolute(prefix) || !fs.existsSync(entry) || !fs.existsSync(path.join(modules, tuiName, 'package.json'))) {
    throw new Error('npm 已执行，但 DSH 与终端界面包没有同时就绪，请检查 npm 全局安装目录');
  }
  const expected = { '@deepseek-ai/dsh': version, [tuiName]: metadata.version,
    ...Object.fromEntries(Object.keys(metadata.peerDependencies || {}).filter(name => name.startsWith('@deepseek-ai/dsh-')).map(name => [name, version])) };
  for (const [name, wanted] of Object.entries(expected)) {
    let installed;
    try { installed = JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')); } catch {}
    if (installed?.version !== wanted) throw new Error(`DSH 安装后 ${name} 没有就绪到 ${wanted}，尚未修复完成`);
  }
  const missingShim = layout.shims.find(file => !fs.existsSync(file));
  if (missingShim) throw new Error(`npm 已装好 DSH，但全局命令入口 ${missingShim} 没有生成，终端里还不能直接用 dsh`);
  return { version, prefix, tuiName, tuiVersion: metadata.version, source: 'user-npm' };
}
// pi（r39）：组件目录里还没有 pi 时的后备——按用户自己的 npm 配置（registry、代理）把固定版本装进 Hub 自管目录。
// node：将来跑 pi 用的 Node（调用方已核过 >=22.19）；probe(node, [入口, '--version'])：真跑一次入口，通过才算装好（r39 审查）。
async function installPiWithUserNpm({ env = process.env, signal, run = runNpm, onProgress = () => {}, targetRoot = null, node = '', probe = null } = {}) {
  if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot)) throw new Error('pi 安装目标必须显式指定绝对路径');
  if (!node || typeof probe !== 'function') throw new Error('pi 安装缺少可用的 Node.js 或试运行步骤，没有开始安装');
  const { PI_PACKAGE, PI_ENTRY, PI_VERSION } = require('../pi-cli-profile');
  onProgress({ phase: 'npm-fallback' });
  fs.mkdirSync(targetRoot, { recursive: true });
  await run(['install', '--prefix', targetRoot, '--no-audit', '--no-fund', PI_PACKAGE + '@' + PI_VERSION], { env, signal });
  const entry = path.join(targetRoot, 'node_modules', ...PI_ENTRY.split('/'));
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(path.join(targetRoot, 'node_modules', PI_PACKAGE, 'package.json'), 'utf8')); } catch {}
  if (!fs.existsSync(entry) || installed?.version !== PI_VERSION) throw new Error(`npm 已执行，但 pi ${PI_VERSION} 没有就绪`);
  onProgress({ phase: 'probing' });
  try { await probe(node, [entry, '--version']); }
  catch (error) {
    if (error.cancelled || error.name === 'AbortError') throw error;
    throw new Error(`npm 已装好 pi ${PI_VERSION} 的文件，但用 ${node} 试运行没有通过（${error.killed ? '90 秒内没有响应' : String(error.stderr || error.message || '').trim().slice(0, 200)}），没有登记为装好`);
  }
  return { version: PI_VERSION, prefix: targetRoot, source: 'user-npm', node };
}
// R37（2026-11-24）：只走公司内源时 DSH 不再落回 npm（公司内部 npm 源缺 @deepseek-ai/dsh-terminal 等同代插件，npm 会卡到超时）。
// 给用户一条能照抄的手动命令：体检认出缺哪几个同代插件就只补这几个（@deepseek-ai/dsh-* 钉到已装核心的版本），
// 否则按程序自带组件快照里的版本装核心 + 界面包。走公网 npm 源，因为公司内部源本来就缺这些包（同事实测这样装好）。
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';
function dshManualCommand({ catalogVersion = '', diagnosis = null } = {}) {
  // 拼进给用户照抄的终端命令：版本只用 semver.valid 归一化后的值，包名只收合法 npm 包名（R37 审查 #2，防命令注入）。
  const [rawCore, rawTui] = String(catalogVersion || '').split('+tui.');
  const core = semver.valid(rawCore) || '', tui = semver.valid(rawTui) || '';
  const coreVer = semver.valid(diagnosis && diagnosis.core && diagnosis.core.version) || core;
  const missing = diagnosis && diagnosis.state === 'incomplete' && Array.isArray(diagnosis.missing)
    ? diagnosis.missing.filter(name => typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) : [];
  let pkgs = missing.map(name => (coreVer && (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) ? name + '@' + coreVer : name));
  if (!pkgs.length) pkgs = ['@deepseek-ai/dsh' + (core ? '@' + core : ''), '@deepseek-harness-tui/dsh-tui' + (tui ? '@' + tui : '')];
  return `npm i -g ${pkgs.join(' ')} --registry=${PUBLIC_NPM_REGISTRY}`;
}
module.exports = { npmInvocation, runNpm, killNpmTree, installDshWithUserNpm, installPiWithUserNpm, globalLayout, dshManualCommand, PUBLIC_NPM_REGISTRY };
