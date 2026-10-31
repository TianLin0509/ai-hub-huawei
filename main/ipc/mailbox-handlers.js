'use strict';
// 账号页 · Claude 账号邮箱保管（2026-10-30）。界面只拿到「有没有存密码 / 2FA」，
// 复制密码由主进程直接写剪贴板，45 秒后若剪贴板仍是这段内容就清空。
const fs = require('fs');
const path = require('path');
const { MailboxVault } = require('../../core/claude-mailbox-vault');
const { getHubDataDir } = require('../../core/data-dir');

const CLEAR_AFTER_MS = 45000;
// Where the person keeps the account file (2026-10-30, folder readable only by their Windows user).
const DEFAULT_IMPORT_DIR = 'C:\\AppData\\AccountVault';

function createMailboxService({ dataDir = getHubDataDir(), safeStorage, clipboard, openInLoginEnv, pickFile = async () => '', clearAfterMs = CLEAR_AFTER_MS } = {}) {
  const vault = new MailboxVault({ dataDir, safeStorage });
  let clearTimer = null;
  function toClipboard(text) {
    clipboard.writeText(text);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { try { if (clipboard.readText() === text) clipboard.writeText(''); } catch {} }, clearAfterMs);
    clearTimer.unref?.();
  }
  const wait = Math.round(clearAfterMs / 1000);
  return {
    vault,
    list: () => vault.list(),
    save: ({ profileId, ...input }) => ({ entry: vault.save(profileId, input), message: '已保存邮箱资料，密码已加密存在本机' }),
    copy({ profileId, which = 'main' }) {
      if (which === 'totp') {
        const { code, secondsLeft } = vault.totpCode(profileId);
        toClipboard(code);
        return { message: `已复制 2FA 验证码 ${code}，还有 ${secondsLeft} 秒有效${secondsLeft < 8 ? '（快过期了，可以等下一个再点）' : ''}` };
      }
      toClipboard(vault.secret(profileId, which));
      return { message: `已复制${which === 'recovery' ? '辅助邮箱' : '邮箱'}密码，${wait} 秒后自动从剪贴板清除` };
    },
    async open({ profileId, which = 'main', confirmed = false }) {
      const { url } = vault.target(profileId, which);
      return openInLoginEnv({ profileId, url, confirmed });
    },
    async importFile({ file } = {}) {
      const chosen = file || await pickFile(fs.existsSync(DEFAULT_IMPORT_DIR) ? DEFAULT_IMPORT_DIR : '');
      if (!chosen) return { cancelled: true, message: '已取消导入' };
      const r = vault.importFile(path.resolve(chosen));
      return { ...r, message: `已导入 ${r.imported.length} 个账号的邮箱资料，全部加密存在本机${r.skipped.length ? `；跳过 ${r.skipped.length} 条（缺账号标识或邮箱）` : ''}` };
    },
  };
}

function registerMailboxIpc(ipcMain, deps) {
  const service = createMailboxService(deps);
  const wrap = fn => async (_e, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('mailbox:list', wrap(() => service.list()));
  ipcMain.handle('mailbox:save', wrap(p => service.save(p)));
  ipcMain.handle('mailbox:copy', wrap(p => service.copy(p)));
  ipcMain.handle('mailbox:open', wrap(p => service.open(p)));
  ipcMain.handle('mailbox:import', wrap(p => service.importFile(p)));
  return service;
}

module.exports = { createMailboxService, registerMailboxIpc, CLEAR_AFTER_MS, DEFAULT_IMPORT_DIR };
