'use strict';
// 给 JS 写的 CLI 挑一份够新的 Node（定位中心）。
// 黄区实测（2026-11-20）：本机 Node 22.11，CodeAgent 自带 Node 24.12，DSH 0.2.2 要 24.9 以上——本机那份不够时借用够新的另一份，
// 并在 runtime.nodeSource 写清用的是哪份。只列文件；版本由调用方按需跑一次 node --version（按文件缓存）。
const path = require('node:path');
const { envGet } = require('./specs');
const { nodeManagerPlaces, pathDirs, byVersionDesc, isTestInstance, testInstanceAllows } = require('./sources');

const NODE_LABELS = Object.freeze({
  pinned: '你指定的 Node',
  configured: 'Hub 设置里指定的 Node（nodePath）',
  shim: '命令壳旁边自带的 Node',
  'hub-managed': 'Hub 一键安装的 Node',
  path: '本机 PATH 上的 Node',
  'registry-path': '注册表最新 PATH 上的 Node',
  'known-dir': '本机安装目录里的 Node',
  nvm: 'nvm 管理的 Node',
  fnm: 'fnm 管理的 Node',
  volta: 'volta 管理的 Node',
  scoop: 'scoop 装的 Node',
  codeagent: '借用 CodeAgent 自带的 Node',
});

function subdirs(fsImpl, dir) {
  try { return fsImpl.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}
function isFile(fsImpl, f) { try { return fsImpl.statSync(f).isFile(); } catch { return false; } }

// 本机所有可能的 node.exe，按优先级。ctx 同 sources.placesFor（env、fs、platform、registryDirs、hubManaged、codeagentInstalls）。
function nodeCandidates(ctx) {
  const { env, fs: fsImpl, platform } = ctx;
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const out = [];
  const seen = new Set();
  const add = (file, source) => {
    if (!file || !path.isAbsolute(file)) return;
    const k = platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (seen.has(k) || !isFile(fsImpl, file)) return;
    seen.add(k);
    out.push({ file, source, label: NODE_LABELS[source] || source });
  };
  const inDir = (dir, source) => dir && add(path.join(dir, exe), source);
  // 设置里给这个 CLI 指定了 Node（DSH 的 nodePath）：建会话只用它，试跑也只用它，不够新就如实报。
  if (ctx.nodeExplicit) { add(ctx.nodeExplicit, 'configured'); return out; }
  if (ctx.nodePin) add(ctx.nodePin, 'pinned');
  try { const m = ctx.hubManaged && ctx.hubManaged('node'); if (m && m.bin) add(m.bin, 'hub-managed'); } catch { /* 没装 */ }
  for (const dir of pathDirs(env)) inDir(dir, 'path');
  for (const dir of ctx.registryDirs || []) inDir(dir, 'registry-path');
  for (const pf of [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramW6432'), envGet(env, 'ProgramFiles(x86)')]) if (pf) inDir(path.join(pf, 'nodejs'), 'known-dir');
  if (envGet(env, 'LOCALAPPDATA')) inDir(path.join(envGet(env, 'LOCALAPPDATA'), 'Programs', 'nodejs'), 'known-dir');
  for (const p of nodeManagerPlaces(ctx)) if (p.source === 'nvm' || p.source === 'fnm') inDir(p.path, p.source);
  const volta = envGet(env, 'VOLTA_HOME') || (envGet(env, 'LOCALAPPDATA') && path.join(envGet(env, 'LOCALAPPDATA'), 'Volta'));
  if (volta) for (const v of subdirs(fsImpl, path.join(volta, 'tools', 'image', 'node')).sort(byVersionDesc)) inDir(path.join(volta, 'tools', 'image', 'node', v), 'volta');
  const home = envGet(env, 'USERPROFILE');
  if (home) for (const app of ['nodejs', 'nodejs-lts']) inDir(path.join(home, 'scoop', 'apps', app, 'current'), 'scoop');
  // CodeAgent 自带的 Node：安装目录下的 node\、node-v*\，以及 %USERPROFILE%\OCHOME\node-v*\（黄区实测 node-v24.12.0）。
  const caRoots = [];
  for (const rec of ctx.codeagentInstalls || []) caRoots.push(typeof rec === 'string' ? rec : rec.dir);
  if (envGet(env, 'ProgramFiles')) caRoots.push(path.join(envGet(env, 'ProgramFiles'), 'CodeAgentCLI'));
  const ochome = envGet(env, 'OCHOME') || (home && path.join(home, 'OCHOME'));
  if (ochome) caRoots.push(ochome);
  for (const root of caRoots.filter(Boolean)) {
    inDir(path.join(root, 'node'), 'codeagent');
    for (const name of subdirs(fsImpl, root).filter(n => /^node-v\d/i.test(n)).sort(byVersionDesc)) inDir(path.join(root, name), 'codeagent');
  }
  // 测试实例不借本机安装目录里的 Node（见 sources.js isTestInstance）。
  return isTestInstance(env) ? out.filter(c => testInstanceAllows(env, c.source, c.file)) : out;
}

function parseNodeVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : '';
}
function versionAtLeast(version, min) {
  if (!min) return true;
  const p = v => (String(v || '').match(/\d+/g) || []).slice(0, 3).map(Number);
  const a = p(version), b = p(min);
  if (!a.length) return false;
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
// 包的 engines.node（如 ">=24.9.0"、"^22.19 || >=24"）的最低版本；和表里的 nodeMin 取更严的那个。
function requiredNode(nodeMin, engines) {
  let fromPkg = '';
  const range = engines && engines.node;
  // 自己解析，不用 semver 包：对照脚本要在没有 node_modules 的公司电脑上直接跑。各「||」分支取最低的那个下限。
  if (range) {
    const lows = String(range).split('||').map(part => {
      const m = /(?:>=|\^|~|=|v)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(part.replace(/>\s*=/, '>='));
      if (!m) return '';
      const n = x => (x === undefined || x === 'x' || x === '*' ? 0 : Number(x));
      return `${Number(m[1])}.${n(m[2])}.${n(m[3])}`;
    }).filter(Boolean).sort((a, b) => (versionAtLeast(a, b) ? (a === b ? 0 : 1) : -1));
    fromPkg = lows[0] || '';
  }
  if (!fromPkg) return nodeMin || '';
  if (!nodeMin) return fromPkg;
  return versionAtLeast(fromPkg, nodeMin) ? fromPkg : nodeMin;
}

// 选第一份够新的。versions：file → '24.12.0'（读不出为 ''）。
//   { node, version, source, label }                    找到够新的
//   { tooOld: true, best: { …最高的那份 }, required }   都不够新
//   { none: true }                                      一份都没有
function pickNode(candidates, versions, required) {
  const withV = candidates.map(c => ({ ...c, version: versions.get(c.file) || '' }));
  const hit = withV.find(c => c.version && versionAtLeast(c.version, required));
  if (hit) return { node: hit.file, version: hit.version, source: hit.source, label: hit.label };
  const known = withV.filter(c => c.version).sort((a, b) => byVersionDesc(a.version, b.version));
  if (known.length) return { tooOld: true, best: known[0], required, all: known };
  if (withV.length) return { unknown: true, best: withV[0], required };
  return { none: true, required };
}

module.exports = { nodeCandidates, pickNode, requiredNode, versionAtLeast, parseNodeVersion, NODE_LABELS };
