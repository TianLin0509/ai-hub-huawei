'use strict';

// 技能广场（2026-11-27）：skill-plaza:list / preview / import / remove / delegate / open-manage。
// 统一返回 {ok:true,data} 或 {ok:false,error:'一句中文'}。
function registerSkillPlazaIpc(ipcMain, getService) {
  const handlers = {
    list: (service, request) => service.list({ refresh: request.refresh === true }),
    preview: (service, request) => service.preview({ id: request.id }),
    import: (service, request) => service.import({ id: request.id, targets: request.targets, acknowledgeRewrite: request.acknowledgeRewrite === true }),
    remove: (service, request) => service.remove({ id: request.id }),
    delegate: (service, request) => service.delegate({ id: request.id }),
    'open-manage': service => service.openManage(),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('skill-plaza:' + name, async (_event, request) => {
      try {
        const service = getService();
        if (!service) return { ok: false, error: '技能广场还没准备好，请稍后再试' };
        const body = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
        return { ok: true, data: await handler(service, body) };
      } catch (error) {
        // 界面只留一行：多行系统报错压成一行，过长截断（全文在界面悬停里看）
        const text = String(error && error.message || error || '没有成功').replace(/\s*\n\s*/g, '；').trim();
        return { ok: false, error: text.length > 300 ? text.slice(0, 300) + '…' : text };
      }
    });
  }
}

module.exports = { registerSkillPlazaIpc };
