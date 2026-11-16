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
module.exports = { npmInvocation, runNpm, killNpmTree, installDshWithUserNpm, globalLayout };
