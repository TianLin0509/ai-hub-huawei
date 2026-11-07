'use strict';
// 启动中心记住上次用的工作目录（用户反馈：每次新建都要重新选目录，默认目录还在快满的 C 盘）。
// 只在真的建成会话后才记；目录已经不在时退回默认工作目录，不打扰用户。
const STORAGE_KEY = 'hub.launch.lastWorkspace.v1';

function remember(storage, { mode, workspace } = {}) {
  const record = mode === 'existing' && workspace?.path
    ? { mode: 'existing', workspace: { path: String(workspace.path), name: String(workspace.name || '') } }
    : mode === 'scratch' ? { mode: 'scratch' } : { mode: 'default' };
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(record)); } catch { /* 存不了就下次重选 */ }
  return record;
}

function recall(storage) {
  try {
    const record = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (record?.mode === 'existing' && typeof record.workspace?.path === 'string' && record.workspace.path) return record;
    if (record?.mode === 'scratch') return { mode: 'scratch' };
  } catch { /* 写坏了当没记过 */ }
  return null;
}

function forget(storage) { try { storage?.removeItem(STORAGE_KEY); } catch { /* 无所谓 */ } }

module.exports = { STORAGE_KEY, remember, recall, forget };
