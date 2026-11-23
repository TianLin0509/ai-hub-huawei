'use strict';
// PPT 任务与缓存共用目录解析；程序、账号和助理设置仍保留原位置。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Hub 工作根只由主进程经 deps.pptHubRoots 注入（2026-11-23 急修）：测试和隔离实例不注入，
// 就不会读到本机真实的 AI_HUB_WORKSPACE_ROOT 或 Hub 设置，PPT 目录跟着自己的数据目录走。
function liveHubRoots({ env = process.env } = {}) {
  return { workFileRoot: require('../work-file-root').current(), workspaceRoot: require('../storage-roots').sessionWorkspaceRoot({ env }) };
}

function injectedHubRoots(assistant) {
  const provider = assistant.deps?.pptHubRoots;
  return typeof provider === 'function' ? (provider() || {}) : {};
}

function resolveWorkDir(assistant, roots = injectedHubRoots(assistant)) {
  const explicit = String(assistant.settings?.().ppt?.workDir || '').trim();
  if (explicit) return { path: path.resolve(explicit), from: 'ppt' };
  // 用户显式把助理数据搬到别处时，PPT 跟着数据目录走，不再被 Hub 工作根带走。
  if (assistant.defaultDir && assistant.dir && path.resolve(assistant.dir) !== path.resolve(assistant.defaultDir)) return { path: assistant.dir, from: 'data-root' };
  const { workFileRoot, workspaceRoot } = roots || {};
  if (workFileRoot) return { path: path.join(workFileRoot, 'ppt'), from: 'work-files' };
  if (workspaceRoot) return { path: path.join(workspaceRoot, 'ppt'), from: 'workspace' };
  return { path: assistant.dir, from: 'legacy' };
}

function ensureWritable(dir, fsModule = fs) {
  let probe;
  try {
    if (!path.isAbsolute(dir)) throw new Error('请选择完整路径');
    // Doctor 常驻队列只支持本机真实目录，设置时就给出同一条边界。
    require('./ppt-doctor-server').ensureLocalDirectory(dir);
    probe = path.join(dir, `.ppt-write-${randomUUID()}`);
    fsModule.writeFileSync(probe, '', { flag: 'wx' });
  } catch (error) {
    const failure = new Error(`PPT 工作目录不可写：${dir}（${error.message}）。请在 PPT → 素材库设置中重新选择目录。`);
    failure.code = 'PPT_WORK_DIR_UNWRITABLE';
    throw failure;
  } finally {
    if (probe) { try { fsModule.unlinkSync(probe); } catch { /* 探针未创建成功时无需清理 */ } }
  }
  return dir;
}

function validateWorkDir(value, assistant) {
  const dir = String(value || '').trim();
  if (!dir) return '';
  const reason = require('../storage-roots').defaultRootRejectReason(dir, {
    protectedDirs: [path.resolve(__dirname, '../..'), path.dirname(process.execPath), assistant.deps?.dataDir],
  });
  if (reason) throw new Error(reason);
  return ensureWritable(path.resolve(dir));
}

function workDir(assistant, { writable = false } = {}) {
  const resolved = resolveWorkDir(assistant);
  if (writable) {
    ensureWritable(resolved.path);
    const file = path.join(assistant.dir, 'ppt-work-roots.json');
    const roots = previousWorkDirs(assistant);
    if (!roots.includes(resolved.path)) {
      fs.mkdirSync(assistant.dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...roots, resolved.path]), 'utf8');
    }
  }
  return resolved.path;
}

function previousWorkDirs(assistant) {
  let roots = [];
  try { roots = JSON.parse(fs.readFileSync(path.join(assistant.dir, 'ppt-work-roots.json'), 'utf8')); } catch { /* 首次使用 */ }
  return [...new Set([assistant.dir, ...(Array.isArray(roots) ? roots : [])].filter(p => typeof p === 'string' && path.isAbsolute(p)))];
}

module.exports = { liveHubRoots, resolveWorkDir, ensureWritable, validateWorkDir, workDir, previousWorkDirs };
