'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../../core/atomic-write');

// 工作目录可能被删了，也可能在断开的网络盘上：不在主进程同步探路径，最多等 1.5 秒，再退回默认位置。
async function defaultDirectory(cwd, fallback, fsModule = fs) {
  if (!cwd) return fallback;
  const probe = fsModule.promises.stat(cwd).then(stat => stat.isDirectory(), () => false);
  const timeout = new Promise(resolve => { setTimeout(resolve, 1500, false).unref?.(); });
  return (await Promise.race([probe, timeout])) ? cwd : fallback;
}

async function saveSessionExport(payload = {}, { showSaveDialog, documentsDir, env = process.env, fsModule = fs }) {
  const content = payload.content;
  if (typeof content !== 'string' || !content) return { ok: false, error: '没有可以导出的内容' };
  const name = path.basename(String(payload.suggestedName || '对话.md'));
  // 隔离实例没有人点对话框，由测试直接给出保存路径；日常运行不走这条路。
  const scripted = env.CLAUDE_HUB_E2E_WINDOW_MODE && env.AI_HUB_SESSION_EXPORT_PATH;
  const selected = scripted ? { canceled: false, filePath: scripted } : await showSaveDialog({
    title: '导出对话（发给别人前请确认没有敏感内容）',
    defaultPath: path.join(await defaultDirectory(payload.cwd, documentsDir, fsModule), name),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };
  try {
    writeFileAtomic(fsModule, selected.filePath, content);
  } catch (error) {
    return { ok: false, error: error?.code === 'EPERM' || error?.code === 'EACCES'
      ? `没有权限写入 ${selected.filePath}，换个位置再试` : (error?.message || String(error)) };
  }
  return { ok: true, filePath: selected.filePath };
}

function registerSessionExportIpc(ipcMain) {
  ipcMain.handle('session-export:save', (_event, payload) => {
    const { app, dialog } = require('electron');
    return saveSessionExport(payload, { showSaveDialog: options => dialog.showSaveDialog(options), documentsDir: app.getPath('documents') });
  });
}

module.exports = { defaultDirectory, registerSessionExportIpc, saveSessionExport };
