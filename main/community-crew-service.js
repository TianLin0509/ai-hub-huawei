'use strict';
// 社区·我的团队的主进程接线（2026-11-28）：把 core/community-crew/service.js 接到 IPC、界面推送、桌宠提醒和模型。
// 只在公司版、社区开着（没开纯离线模式）时工作；关掉社区时停止读写信箱，页面显示锁定。
const fs = require('node:fs');
const path = require('node:path');
const { createCrewService } = require('../core/community-crew/service');

function createCommunityCrewMain({ dataDir, isEnabled, communityService, sendToRenderer = () => {}, publishNotice = () => {}, logger = console } = {}) {
  const profile = () => {
    let pet = '01-cat', petName = '';
    try { const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub-pet.json'), 'utf8')); pet = String(p.role || pet); petName = String(p.petName || ''); } catch { /* 没设过桌宠 */ }
    let nick = '';
    try { const c = typeof communityService === 'function' ? communityService() : communityService; nick = (c && c.settings().nick) || ''; } catch { /* 社区未就绪 */ }
    return { nick, pet, petName };
  };
  // 回信与草稿：用「设置 › 功能模型」里为本功能选的后端；没选过时用 CodeAgent（有就用），都没有就不调模型（来信只等本人回）。
  const runModel = async prompt => {
    require('../core/company-ai-policy').assertExternalAiAllowed();
    const choice = require('../core/feature-agent-choice');
    let selected = null;
    try { selected = choice.resolve(dataDir, 'crew').selected; } catch { selected = null; }
    if (selected && !['codeagent', 'claude'].includes(selected.kind)) selected = null;
    if (!selected && require('../core/community-setup').findCommand('codeagent')) selected = { kind: 'codeagent', model: '' };
    if (!selected) return '';
    return require('../core/feature-agent-run').run(selected, prompt, { dataDir, timeoutMs: 90000, crew: true });
  };
  // 隔离测试实例：可用本地文件夹假装局域网（见 core/community-crew/fake-net.js），也可关掉模型调用。
  const extra = {};
  if (require('../core/data-dir').isIsolatedHub()) {
    if (process.env.AI_HUB_CREW_FAKE_NET) { const f = require('../core/community-crew/fake-net').fakeNet(process.env.AI_HUB_CREW_FAKE_NET); extra.shareTools = f.shareTools; extra.ipCandidates = () => [f.ip]; }
    if (process.env.AI_HUB_CREW_NO_MODEL === '1') extra.runModel = null;
  }
  const svc = createCrewService({
    dataDir, isEnabled, profile, runModel, logger, ...extra,
    emit: (type, data) => { try { sendToRenderer('community-crew:' + type, data); } catch { /* 窗口没开 */ } },
    notify: n => { try { publishNotice({ id: n.id, kind: 'crew', title: n.title, text: n.text || '' }); } catch { /* 桌宠没开 */ } },
  });
  function registerIpc(ipcMain) {
    for (const [name, fn] of Object.entries(svc.handlers)) {
      ipcMain.handle('community-crew:' + name, async (_e, req = {}) => {
        if (!isEnabled()) return { ok: false, state: 'disabled', error: '已开启纯离线模式' };
        try { return await fn(req || {}); } catch (e) { return { ok: false, error: e.message }; }
      });
    }
    // 打开收到的文件夹、选文件夹：界面按钮直接用。
    ipcMain.handle('community-crew:open-path', async (_e, req = {}) => {
      const p = String(req.path || '');
      if (!p || !fs.existsSync(p)) return { ok: false, error: '文件夹不存在' };
      const err = await require('electron').shell.openPath(p);
      return err ? { ok: false, error: err } : { ok: true };
    });
    ipcMain.handle('community-crew:pick-dir', async () => {
      const { dialog, BrowserWindow } = require('electron');
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { properties: ['openDirectory'] });
      return r.canceled || !r.filePaths[0] ? { ok: false } : { ok: true, path: r.filePaths[0] };
    });
  }
  return { ...svc, registerIpc };
}

module.exports = { createCommunityCrewMain };
