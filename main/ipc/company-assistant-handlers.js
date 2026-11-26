'use strict';
// 公司版「助理」页的主进程入口（2026-10-16）：页面只经这些 IPC 读状态、提问、改设置；
// 扫码登录、日历初始化只在用户点按钮时调用（core/company-assistant/service.js）。
function registerCompanyAssistantIpc(ipcMain, service) {
  const handlers = {
    status: () => service.status(),
    refresh: async () => { const r = service.manualRefresh ? await service.manualRefresh() : (await service.refresh({ force: true, priority: 'user', trigger: 'manual' }), {});
      return { ...service.status(), refreshJoined: !!r.joined, refreshSince: r.since || null }; },
    'brief-now': async () => { await service.generateBrief({ force: true }); return service.status(); },
    ask: request => ({ ok: true, item: service.ask(String(request?.text || ''), { entry: request?.entry === 'ppt' ? 'ppt' : '' }) }),
    'retry-chat': request => ({ ok: true, item: service.retryChat(String(request?.id || '')) }),
    // 「停止这一问」（审计 A3-17）：只结束这一问，其他队列照常。
    'stop-chat': async request => ({ ok: true, item: await service.stopChat(String(request?.id || '')) }),
    'mark-done': request => service.markDone(String(request?.source || ''), request?.done !== false),
    // 2026-11-16：「等你回复」全部处理了 / 撤销放回 / 立即 AI 复核
    'mark-awaiting-done': () => service.markAwaitingDone(),
    'restore-awaiting': request => service.restoreAwaiting(request?.items),
    'reply-review-now': () => ({ ok: true, ...service.startReplyReview('manual'), status: service.status() }),
    'digest-notice': request => service.digestNotice(String(request?.id || '')),
    source: request => service.sourceContext(String(request?.source || ''), request?.day),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    'model-settings': request => service.modelSettings(request?.account || 'personal'),
    'set-model-choice': request => service.setModelChoice(request || {}),
    memory: request => service.memory.execute(request || { op: 'list' }, { fromSettings: true }),
    login: async request => ({ ok: true, flow: await service.login({ restart: !!request?.restart, clean: !!request?.clean }) }),
    // 2026-11-19：设置里「退出 WeLink 登录」——清掉本机 welink-cli 凭据并停掉自动续期。
    'welink-logout': async () => ({ ok: true, ...(await service.logout()) }),
    'setup-calendar': request => service.setupCalendar(String(request?.email || '')),
    // 「手机」设置页（2026-10-18）：选群、开关、推送范围；测试消息只发到选定的群。
    // 找 welink-cli（2026-10-19）：「再找一次」立刻全盘找；「手动选择…」弹系统选择框。
    'find-cli': async () => ({ ok: true, search: await service.findCli({ force: true }) }),
    'install-cli': () => service.installCli(),
    'pick-cli': async () => {
      const { dialog, BrowserWindow } = require('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: '选择 welink-cli', properties: ['openFile'], filters: [{ name: 'welink-cli', extensions: ['exe', 'cmd'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return service.useCliPath(r.filePaths[0]);
    },
    'pick-data-root': async () => {
      const { dialog, BrowserWindow } = require('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: '选择助理数据目录', defaultPath: service.dir, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, settings: service.setSettings({ dataRoot: r.filePaths[0] }) };
    },
    'pick-work-dir': async () => {
      const { dialog, BrowserWindow } = require('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: '选择我的工作目录', defaultPath: service.userWorkDir().path || undefined, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, settings: service.setSettings({ workDir: r.filePaths[0] }) };
    },
    'phone-status': () => {
      const phone = service.phone.status(), reg = phone.bot?.register;
      // 二维码图画不出来时只少一张图，「在电脑 WeLink 里打开」照样能用，不让整页打不开。
      if (reg?.weUrl && ['waiting', 'scanned'].includes(reg.status)) { try { reg.qr = require('../../core/company-assistant/welink-bot').qrImage(reg.weUrl); } catch (e) { reg.qr = ''; reg.qrError = e.message; } }
      return { ok: true, phone, conversations: service.status().conversations };
    },
    // WeLink 私聊助理（beta）：用户点了才扫码绑定；在电脑 WeLink 里直接打开确认页；解除绑定。
    'bot-register': async () => { await service.bot.register(); return { ok: true }; },
    'bot-open': async () => {
      const url = service.bot.status().register?.pcUrl;
      if (!url || !/^welink:\/\//i.test(url)) throw new Error('二维码还没生成，先点「绑定到 WeLink」');
      await require('electron').shell.openExternal(url);
      return { ok: true };
    },
    'bot-forget': async () => { service.bot.forget(); await service.setPhone({ enabled: false, transport: 'group' }); return { ok: true }; },
    'phone-settings': request => service.setPhone(request || {}),
    'phone-test': async () => ({ ok: await service.phone.send('测试消息：Hub 能往这个群发消息。在这里直接跟我说话就行。', 'test') }),
    'phone-check-group': request => service.phone.checkGroup(String(request?.groupId || '')),
    'ppt-status': async () => ({ ok: true, ppt: await service.ppt.refresh({ force: true }) }),
    'ppt-query': request => service.ppt.execute(request?.op || 'status', request || {}),
    'ppt-open': request => service.ppt.open(String(request?.id || '')),
    'room-status': async () => { await service.rooms.tick(); return { ok: true, rooms: service.rooms.status() }; },
    'room-details': () => ({ ok: true, rooms: service.rooms.details() }),
    'room-open-folder': async request => {
      const names = { data: '', logs: 'logs', screenshots: 'screenshots' };
      if (!Object.hasOwn(names, request?.kind)) throw new Error('不支持的会议室目录');
      const fs = require('node:fs'), path = require('node:path');
      const dir = path.join(service.rooms.home(), names[request.kind]);
      fs.mkdirSync(dir, { recursive: true });
      const error = await require('electron').shell.openPath(dir);
      if (error) throw new Error(error);
      return { ok: true };
    },
    'room-command': request => service.rooms.command(request?.op, request?.rules || {}, { user: true }),
    'room-schedule': request => ({ ok: true, rooms: service.rooms.saveSchedule(request || {}) }),
    'room-connect': async () => ({ ok: true, rooms: await service.rooms.ensure({ user: true }) }),
    'room-reconnect': async () => ({ ok: true, rooms: await service.rooms.reconnect() }),
    // 2026-11-27 R51：被别的秘书终结者进程拦下时，「我已退出，重新检测」与「帮我结束它」（页面先二次确认）。
    'room-recheck': async () => ({ ok: true, rooms: await service.rooms.recheck() }),
    'room-stop-external': async () => ({ ok: true, rooms: await service.rooms.stopExternal() }),
    'room-discover': async () => ({ ok: true, rooms: await service.rooms.discover() }),
    'room-install': async () => ({ ok: true, rooms: await service.rooms.install() }),
    'room-pick': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择秘书终结者', properties: ['openFile'], filters: [{ name: '秘书终结者', extensions: ['exe'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, rooms: service.rooms.useExecutable(r.filePaths[0]) };
    },
    'ppt-pick-index': async () => {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ title: '选择 PPT Doctor 文字索引', properties: ['openFile'], filters: [{ name: 'SQLite 索引', extensions: ['db', 'sqlite', 'sqlite3'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      service.setSettings({ ppt: { db: r.filePaths[0] } });
      return { ok: true, ppt: await service.ppt.refresh({ force: true }) };
    },
    // 「打开会话」：助理会话关着就先按原生身份恢复，再交给界面选中。
    'open-session': async () => {
      const id = await service.ensureSession();
      return { ok: true, sessionId: id };
    },
    // 「重开助理会话」（v3.1.1，助理页「会话工具：未接上」旁的按钮）：按原会话重新启动，重新挂上会话工具。
    'reopen-session': () => service.reopenSession(),
  };
  Object.assign(handlers, require('../../core/company-assistant/ppt-ipc').createPptHandlers(service));
  Object.assign(handlers, require('../../core/company-assistant/meeting-ipc').createMeetingHandlers(service));
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('company-assistant:' + name, async (event, request = {}) => {
      // 第二个参数是发起的页面（会议采集要记下是哪个页面在录，页面崩溃时把会议收成「已中断」）。
      try { return await handler(request, event); } catch (error) { return { ok: false, error: error.message }; }
    });
  }
  return service;
}

module.exports = { registerCompanyAssistantIpc };
