'use strict';
const path = require('node:path');

function createPptHandlers(service) {
  return {
    'ppt-status': async () => ({ ok: true, ppt: await service.ppt.refresh({ force: true }) }),
    'ppt-search': request => {
      const folder = String(request?.folder || '');
      if (folder && !path.isAbsolute(folder)) throw new Error('请选择有效的素材文件夹');
      return service.ppt.execute('search', { query: String(request?.query || ''), ...(folder ? { roots: [folder] } : {}), limit: 30 });
    },
    'ppt-ask': request => ({ ok: true, item: service.ask(String(request?.question || ''), { entry: 'ppt' }) }),
    'ppt-page-state': request => ({ ok: true, ppt: service.ppt.status(), chat: request?.chatId ? service.chat().find(c => c.id === request.chatId) : null,
      trace: request?.chatId ? service.ppt.trace?.(request.chatId) || null : null }),
    'ppt-preview': async request => {
      try { return await service.ppt.preview(request?.id); }
      catch (error) { return { ok: false, code: error.code || 'PPT_PREVIEW_FAILED', error: error.message }; }
    },
    'ppt-page-detail': async request => ({ ok: true, page: await service.ppt.resolvePage(request?.id) }),
    'ppt-show-folder': request => service.ppt.showFolder(request?.id),
    'ppt-copy': request => service.ppt.copy(request?.id),
    'ppt-convert-page': request => service.ppt.convertPage(request?.id),
    'ppt-lookup-frame': async request => {
      try { return await service.ppt.lookupFrame(request); }
      catch (error) { return { ok: false, code: error.code || 'PPT_LOOKUP_FAILED', error: error.message }; }
    },
    'ppt-imgtext-start': request => service.ppt.imgtext.start(request?.imagePath),
    'ppt-imgtext-status': request => ({ ok: true, job: service.ppt.imgtext.snapshot(request?.jobId) }),
    'ppt-imgtext-retry': request => service.ppt.imgtext.retry(request?.jobId),
    'ppt-imgtext-fallback': request => service.ppt.imgtext.retry(request?.jobId, true),
    'ppt-imgtext-workdir': request => service.ppt.imgtext.openWorkdir(request?.jobId),
    'ppt-imgtext-open': request => service.ppt.imgtext.open(request?.jobId),
    'ppt-pick-doctor': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择 PPT Doctor 程序', properties: ['openFile'], filters: [{ name: 'PPT Doctor', extensions: ['exe'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      service.setSettings({ ppt: { doctorExe: r.filePaths[0] } });
      return { ok: true, ppt: await service.ppt.refresh({ force: true }) };
    },
    'ppt-download-doctor': request => require('./ppt-doctor-download').downloadDoctor(request?.source || 'mirror', service.deps),
    'ppt-pick-image': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择要转为可编辑PPT的图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
      return r.canceled ? { ok: true, canceled: true } : { ok: true, imagePath: r.filePaths[0] };
    },
    'ppt-index': () => ({ ok: true, ppt: service.ppt.startIndex() }),
    // 素材 Tab（2026-11-10）：只读 PPT Doctor 素材库 + 用户打开的素材包；插入 / 复制只在用户点击时执行。
    'ppt-materials': request => service.ppt.materials.list({ query: String(request?.query || ''), category: String(request?.category || ''), offset: request?.offset, limit: request?.limit, force: request?.force === true }),
    'ppt-material-preview': async request => {
      try { return await service.ppt.materials.preview(request?.id); }
      catch (error) { return { ok: false, code: error.code || 'MATERIAL_PREVIEW_FAILED', error: error.message }; }
    },
    'ppt-material-insert': request => service.ppt.materials.transfer(request?.id, 'insert'),
    'ppt-material-copy': request => service.ppt.materials.transfer(request?.id, 'copy'),
    'ppt-material-pick-pack': async request => {
      // 拖进素材 Tab 的文件直接给路径；点按钮时弹选择框。
      if (request?.file) return service.ppt.materials.addPack(String(request.file));
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择团队素材包（.pptx）', properties: ['openFile'], filters: [{ name: '团队素材包', extensions: ['pptx'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return service.ppt.materials.addPack(r.filePaths[0]);
    },
    'ppt-open-doctor': async () => {
      const exe = await service.ppt.doctor.discover();
      require('node:child_process').spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { ok: true };
    },
    'ppt-pick-folders': async () => {
      const { dialog } = require('electron');
      const selected = await dialog.showOpenDialog({ title: '选择 1–3 个 PPT 素材文件夹', properties: ['openDirectory', 'multiSelections'] });
      if (selected.canceled || !selected.filePaths.length) return { ok: true, canceled: true };
      const roots = [...new Set(selected.filePaths.map(p => path.resolve(p)))];
      if (roots.length > 3) throw new Error('最多选择 3 个素材文件夹，本次没有改动索引设置');
      service.setSettings({ ppt: { roots } });
      return { ok: true, ppt: service.ppt.startIndex() };
    },
  };
}

module.exports = { createPptHandlers };
