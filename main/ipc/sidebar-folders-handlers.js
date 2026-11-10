'use strict';

function registerSidebarFoldersIpc(ipcMain, { store, entityExists, publish = () => {} }) {
  const actions = {
    list: () => store.list(),
    create: args => store.create(args.name),
    rename: args => store.rename(args.folderId, args.name),
    remove: args => store.remove(args.folderId),
    assign: args => {
      if (!entityExists(args.key)) throw new Error('会话或群聊不存在，请刷新侧栏后重试');
      return store.assign(args.key, args.folderId);
    },
  };
  for (const [action, run] of Object.entries(actions)) ipcMain.handle('sidebar-folders:' + action, async (_event, args = {}) => {
    try {
      const state = await run(args || {});
      if (action !== 'list') publish(state);
      return { ok: true, state };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}

module.exports = { registerSidebarFoldersIpc };
