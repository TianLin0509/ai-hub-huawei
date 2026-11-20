'use strict';
// 定位中心的 IPC（接口合同 v1 第 3 节）。界面（体检结论卡、启动中心徽标、手动选路径）都经这里取同一份结论。
//   harness:peek-all     → Record<id, LocateResult|null>（只读缓存，立即返回）
//   harness:locate       { id, fresh } → LocateResult
//   harness:locate-all   { fresh } → Record<id, LocateResult>
//   harness:pick-path    { id } → 弹选文件框；取消返回 null，否则返回试跑后的 LocateResult（试跑通过才保存）
//   harness:set-path     { id, path } → 不弹框，按手动路径试跑（CodeAgent 切版本：界面从已发现的版本列表里选一份）；ok 才保存，失败如实返回 LocateResult
//   harness:clear-path   { id } → LocateResult
//   harness:apply-fix    { id, act, ...payload } → LocateResult
//   harness:diagnosis    { ids? } → { text }（已打码）
//   事件 harness:changed  main → 所有窗口 { id, result }
const locatorApi = require('../../core/harness-locator');

const PICK_EXT = ['exe', 'cmd', 'bat', 'ps1', 'js', 'cjs', 'mjs'];

function checkedId(request) {
  const id = String(request && request.id || '');
  if (!locatorApi.IDS.includes(id)) throw new Error('不认识的 CLI：' + id);
  return id;
}

// 弹系统选文件框，选了就试跑；试跑通过才保存为手动路径。
function makePick(locator, showOpenDialog) {
  return async id => {
    const dialogFn = showOpenDialog || (async opts => {
      const { dialog, BrowserWindow } = require('electron');
      return dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, opts);
    });
    const label = require('../../core/harness-locator/specs').spec(id).label;
    const r = await dialogFn({ title: `选择 ${label} 程序`, properties: ['openFile'], filters: [{ name: label, extensions: PICK_EXT }, { name: '所有文件', extensions: ['*'] }] });
    if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return locator.setManualPath(id, r.filePaths[0]);
  };
}

function registerHarnessLocatorIpc(ipcMain, { locator = locatorApi.get(), send = () => {}, showOpenDialog, installTool } = {}) {
  locator.onChange((id, result) => send('harness:changed', { id, result }));
  const pick = makePick(locator, showOpenDialog);
  const wrap = fn => async (_event, request = {}) => {
    try { return await fn(request || {}); }
    catch (error) { return { ok: false, error: error.message }; }
  };
  ipcMain.handle('harness:peek-all', wrap(() => locator.peekAll()));
  ipcMain.handle('harness:locate', wrap(r => locator.locate(checkedId(r), { fresh: r.fresh === true, reason: 'open' })));
  ipcMain.handle('harness:locate-all', wrap(r => locator.locateAll({ fresh: r.fresh === true, reason: 'open' })));
  ipcMain.handle('harness:pick-path', wrap(r => pick(checkedId(r))));
  ipcMain.handle('harness:set-path', wrap(r => locator.setManualPath(checkedId(r), String(r.path || ''))));
  ipcMain.handle('harness:clear-path', wrap(r => locator.clearManualPath(checkedId(r))));
  ipcMain.handle('harness:diagnosis', wrap(r => ({ text: locator.diagnosisText(Array.isArray(r.ids) ? r.ids : undefined, { sanitize: true }) })));
  ipcMain.handle('harness:apply-fix', wrap(r => applyFix(locator, { ...r, id: checkedId(r) }, { pick, installTool })));
}

// 安装失败的原话翻成人话。黄区实测：npm 默认源走公司代理返回 407（代理要认证），同事终端里 npm 正常是因为终端配了代理账号。
function humanInstallError(text) {
  const raw = String(text || '安装未完成');
  if (/(?:^|\D)407(?!\d)|Proxy Authentication/i.test(raw)) return '公司代理要求登录（407），Hub 连不上 npm 默认源；稍后再试，或联系管理员放行这台电脑的代理。原话：' + raw.slice(0, 160);
  if (/(?:^|\D)404(?!\d)|Not Found/i.test(raw)) return '下载源上没有这个包（404），公司内部 npm 源常缺 DSH 界面包和 pi。原话：' + raw.slice(0, 160);
  return raw;
}

// 新增的修复动作（合同第 2 节 Fix）。也被 env-check:fix 转调。
async function applyFix(locator, request, { pick, installTool } = {}) {
  const id = request.id, act = String(request.act || '');
  if (act === 'harness-pick') { const r = pick ? await pick(id) : null; return r || locator.peek(id); }
  if (act === 'harness-clear-manual') return locator.clearManualPath(id);
  if (act === 'harness-borrow-node') return locator.setNodePin(id, String(request.node || ''));
  if (act === 'recheck') return locator.locate(id, { fresh: true, reason: 'fix' });
  if (act === 'harness-repair') {
    // 一键补齐：DSH 包不全时由 Hub 装一份配套的自管运行环境（不动用户自己的安装），装完立即重查。
    if (!installTool) throw new Error('这个版本暂不支持一键补齐');
    const tool = id === 'dsh' || id === 'pi' ? id : null;
    if (!tool) throw new Error('这个 CLI 没有一键补齐');
    const r = await installTool({ id: tool });
    const result = await locator.locate(id, { fresh: true, reason: 'install' });
    return r && r.ok === false ? { ...result, repairError: humanInstallError(r.error) } : result;
  }
  throw new Error('不认识的操作：' + act);
}

module.exports = { registerHarnessLocatorIpc, applyFix, makePick, humanInstallError, PICK_EXT };
