'use strict';

// 「员工助手 Beta」页的接口：weclaw:status / connect / disconnect / set-pool / open / new-chat / upgrade / test。
// 不是公司版（没有公司模型）时 status 返回 missing，页面入口不显示。
function registerWeclawLinkIpc(ipcMain, getService) {
  const handlers = {
    status: service => service.status(),
    connect: (service, request) => service.connect({ allowPool: request.allowPool }),
    disconnect: service => service.disconnect(),
    'set-pool': (service, request) => service.setAllowPool(request.allowPool === true),
    open: service => service.open(),
    'new-chat': service => service.newChat(),
    upgrade: service => service.upgrade(),
    test: service => service.test(),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('weclaw:' + name, async (_event, request = {}) => {
      try {
        const service = getService();
        if (!service) return { ok: true, available: false, missing: true };
        return await handler(service, request || {});
      } catch (error) { return { ok: false, error: error.message }; }
    });
  }
}

module.exports = { registerWeclawLinkIpc };
