'use strict';
// 外部工具自动发现与多版本选择的主进程入口（2026-11-07，5.5.24）。
// 页面里的版本选择器（renderer/tool-version-picker.js）经这两个 IPC 列出候选、切换版本：
//   tool-discovery:list { tool, force } → 摘要（当前用哪份、所有可用版本、是否需要用户选）；
//   tool-discovery:use  { tool, path }  → 写回设置后的摘要。
// tool 是 welink / ppt-doctor / codeagent；公司助理没开时 welink、ppt-doctor 不可用，返回 ok:false。
const TOOLS = new Set(['welink', 'ppt-doctor', 'codeagent']);

function registerToolDiscoveryIpc(ipcMain, discovery) {
  const checked = request => {
    const tool = String(request?.tool || '');
    if (!TOOLS.has(tool)) throw new Error('不认识的工具');
    if (!discovery.has(tool)) throw new Error('这个工具在本机版本里不可用');
    return tool;
  };
  ipcMain.handle('tool-discovery:list', async (_event, request = {}) => {
    try { return await discovery.list(checked(request), { force: request.force === true }); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('tool-discovery:use', async (_event, request = {}) => {
    try { return await discovery.use(checked(request), String(request.path || '')); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // 兜底：自动发现都没找到时，弹系统选择框让用户指定程序（选完同样要能跑起来、校验通过才用）。
  ipcMain.handle('tool-discovery:pick', async (_event, request = {}) => {
    try {
      const tool = checked(request);
      const { dialog, BrowserWindow } = require('electron');
      const ext = PICK_EXT[tool];
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: `选择 ${ext.name} 程序`, properties: ['openFile'], filters: [{ name: ext.name, extensions: ext.list }] });
      if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
      return await discovery.use(tool, r.filePaths[0]);
    } catch (error) { return { ok: false, error: error.message }; }
  });
}
const PICK_EXT = { welink: { name: 'welink-cli', list: ['exe'] }, 'ppt-doctor': { name: 'PPT Doctor', list: ['exe'] }, codeagent: { name: 'CodeAgent', list: ['exe', 'cmd', 'bat'] } };

// Hub 启动时建一个共享实例：CodeAgent 总是注册（建会话、账号页都要用）；welink / PPT Doctor 由公司助理注册。
// 启动后在后台扫一次 CodeAgent（只查常见目录，读版本时隐藏窗口），不拖慢启动。
function createHubToolDiscovery({ dataDir, onChanged = () => {}, platform = process.platform, delayMs = 8000 } = {}) {
  const { ToolDiscovery } = require('../../core/tool-discovery');
  const discovery = new ToolDiscovery({ dataDir, onChanged });
  discovery.register('codeagent', require('../../core/tool-discovery/tools').codeagentAdapter(discovery.store));
  if (platform === 'win32') {
    const timer = setTimeout(() => { void discovery.list('codeagent').catch(error => console.warn('[tool-discovery] CodeAgent 扫描失败：' + error.message)); }, delayMs);
    timer.unref?.();
  }
  return discovery;
}

module.exports = { registerToolDiscoveryIpc, createHubToolDiscovery, TOOLS };
