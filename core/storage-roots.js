'use strict';

// 存储根的唯一来源（2026-10-07，C: 盘满后新增 D: 盘）。
//
// 用户决定：新工作与产物落在 D:，C: 上的存量数据继续按完整路径可用。
// 这一轮的教训是**不要用 junction 把 C: 目录接到 D:**——Hub 的路径检查、realpath 比对、
// 文件管理器都会主动拒绝链接，于是改成 D: 上的真实目录，用环境变量告诉 Hub：
//   AI_HUB_WORKSPACE_ROOT          当前平铺工作根（新会话、默认路径都落这里）
//   AI_HUB_LEGACY_WORKSPACE_ROOTS  旧工作根，按 path.delimiter（Windows 为 ;）分隔；
//                                  存量会话的 cwd 仍在这些根里，必须像当前根一样被认出来
//   AI_HUB_ARTIFACTS_ROOT          跨项目产物根；未设置时沿用 ~/AI-Artifacts
// 所有调用方都从这里取，别再各自写 'C:/Work' / homedir()+'AI-Artifacts'。

const fs = require('fs');
const os = require('os');
const path = require('path');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathKey(value) {
  const resolved = path.resolve(String(value)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const raw = clean(item);
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// 「Hub 设置 · 新建会话默认工作目录」（2026-11-19，config.json 的 workspace.default_root）。
// 主进程启动和保存设置时写进来；环境变量 AI_HUB_WORKSPACE_ROOT 仍然优先。
// **只影响新建会话的工作根**（workspace-service 用 sessionWorkspaceRoot）。手机信任根、手机分享落盘、
// 拍图助理落盘仍按 workspaceRoot() 的旧后备根：设了默认目录不能顺带扩大手机能读的范围（m5 审查 2026-11-19）。
let configuredRoot = '';
let configuredRootError = '';

function samePathOrInside(parent, child) {
  if (!parent) return false;
  const a = pathKey(parent), b = pathKey(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 不能当「新建会话默认工作目录」的位置。返回给用户看的理由，可用返回 ''。
//   盘符根 / UNC 共享根、用户主目录本身、Hub 程序目录与数据目录（含其下子目录）。
function defaultRootRejectReason(value, { home = os.homedir(), protectedDirs = [] } = {}) {
  const raw = clean(value);
  if (!raw) return '';
  if (!path.isAbsolute(raw) || (process.platform === 'win32' && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(raw))) {
    return '默认工作目录要填完整路径，例如 D:\\Work';
  }
  const resolved = path.resolve(raw);
  if (pathKey(path.parse(resolved).root) === pathKey(resolved)) return `${resolved} 是整个盘的根目录，不能当默认工作目录——请在下面新建一个文件夹，例如 ${path.join(resolved, 'Work')}`;
  if (home && pathKey(home) === pathKey(resolved)) return `${resolved} 是用户主目录本身，不能当默认工作目录——请选它下面的一个文件夹`;
  for (const dir of protectedDirs) {
    if (dir && samePathOrInside(dir, resolved)) return `${resolved} 在 Hub 自己的程序或数据目录里，不能当默认工作目录`;
  }
  return '';
}

// 设置值。传 checkOpts 时先校验，不合法就当没设，并记下理由给设置页显示。
function setConfiguredWorkspaceRoot(value, checkOpts = null) {
  const raw = clean(value);
  configuredRootError = '';
  if (raw && checkOpts) {
    let reason = defaultRootRejectReason(raw, checkOpts);
    if (!reason && checkOpts.requireExisting) {
      let isDir = false;
      try { isDir = fs.statSync(raw).isDirectory(); } catch { /* 不存在 */ }
      if (!isDir) reason = `设置里的默认工作目录 ${path.resolve(raw)} 已不存在，新会话暂时开在原来的默认位置；重新选一个或清空即可`;
    }
    if (reason) { configuredRoot = ''; configuredRootError = reason; return null; }
  }
  configuredRoot = raw;
  return configuredWorkspaceRoot();
}

function configuredWorkspaceRoot() {
  return configuredRoot ? path.resolve(configuredRoot) : null;
}

function configuredWorkspaceRootError() {
  return configuredRootError;
}

// 新建会话的工作根从哪来：'env'（环境变量）/ 'config'（Hub 设置）/ null（都没设，用调用方的默认）。
// 只有读真实 process.env 的调用才会看设置值，测试传入的 env 不受模块状态影响。
function workspaceRootSource({ env = process.env } = {}) {
  if (clean(env && env.AI_HUB_WORKSPACE_ROOT)) return 'env';
  if (env === process.env && configuredRoot) return 'config';
  return null;
}

// 环境变量指定的工作根；没设时返回调用方各自的 fallback（手机与助理沿用 'C:/Work'）。
// 不看 Hub 设置的默认目录——见上面 configuredRoot 的说明。
function workspaceRoot({ env = process.env, fallback = null } = {}) {
  const override = clean(env && env.AI_HUB_WORKSPACE_ROOT);
  if (override) return path.resolve(override);
  return fallback ? path.resolve(fallback) : null;
}

// 新建会话用的工作根：环境变量 > Hub 设置 > 调用方 fallback（workspace-service 有自己的隔离 / ~/Workspaces 逻辑）。
function sessionWorkspaceRoot({ env = process.env, fallback = null } = {}) {
  const override = clean(env && env.AI_HUB_WORKSPACE_ROOT);
  if (override) return path.resolve(override);
  if (env === process.env && configuredRoot) return path.resolve(configuredRoot);
  return fallback ? path.resolve(fallback) : null;
}

function legacyWorkspaceRoots({ env = process.env, current } = {}) {
  const raw = clean(env && env.AI_HUB_LEGACY_WORKSPACE_ROOTS);
  if (!raw) return [];
  const currentRoot = current === undefined ? workspaceRoot({ env }) : current;
  const currentKey = currentRoot ? pathKey(currentRoot) : null;
  return dedupe(raw.split(path.delimiter)).filter(root => pathKey(root) !== currentKey);
}

function artifactsRoot({ env = process.env, home = os.homedir() } = {}) {
  const override = clean(env && env.AI_HUB_ARTIFACTS_ROOT);
  return override ? path.resolve(override) : require('./work-file-root').directory('artifacts', path.join(home, 'AI-Artifacts'));
}

// 旧产物位置：只用于读取/对外提供存量文件，不再往里写（桌面目录尤其如此）。
function legacyArtifactsRoots({ home = os.homedir() } = {}) {
  return [path.join(home, 'AI-Artifacts'), path.join(home, 'Desktop', 'claude-artifacts'),
    ...require('./work-file-root').previousDirectories('artifacts', null)];
}

// 读取 / 对外提供文件时信任的根（手机发图、口播资料等）。
function trustedFileRoots({ dataDir, env = process.env, home = os.homedir(), workspaceFallback = 'C:/Work' } = {}) {
  const current = workspaceRoot({ env, fallback: workspaceFallback });
  return dedupe([
    dataDir,
    current,
    ...legacyWorkspaceRoots({ env, current }),
    artifactsRoot({ env, home }),
    ...legacyArtifactsRoots({ home }),
    ...(require('./work-file-root').current() ? [
      require('./work-file-root').directory('phone-inbox', null),
      require('./work-file-root').directory('photo-assistant', null),
    ] : []),
    ...require('./work-file-root').previousDirectories('phone-inbox', null),
    ...require('./work-file-root').previousDirectories('photo-assistant', null),
  ]);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

module.exports = {
  workspaceRoot,
  sessionWorkspaceRoot,
  workspaceRootSource,
  setConfiguredWorkspaceRoot,
  configuredWorkspaceRoot,
  configuredWorkspaceRootError,
  defaultRootRejectReason,
  legacyWorkspaceRoots,
  artifactsRoot,
  legacyArtifactsRoots,
  trustedFileRoots,
  dateStamp,
  pathKey,
};
