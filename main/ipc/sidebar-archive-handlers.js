'use strict';

function registerSidebarArchiveIpc(ipcMain, { store, publish = () => {} }) {
  const actions = {
    list: args => store.list({ legacyDays: args.legacyDays }),
    archive: args => store.archive(args.keys),
    restore: args => store.restore(args.keys),
    'set-auto': args => store.setAuto(args.enabled, args.rule),
  };
  for (const [action, run] of Object.entries(actions)) ipcMain.handle('sidebar-archive:' + action, async (_event, args = {}) => {
    try {
      const state = await run(args || {});
      if (action !== 'list') publish(state);
      return { ok: true, state };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}

module.exports = { registerSidebarArchiveIpc };
