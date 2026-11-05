'use strict';

// Share the latest display state, but always recheck before starting an action.
const instances = new WeakMap();
const OFFICIAL_INSTALL_URL = '';
function createCodeAgentSetup({ document, ipcRenderer }) {
  if (instances.has(document)) return instances.get(document);
  let current = null, pending = null, dialog = null;
  const listeners = new Set();
  function accept(result) {
    const provider = result?.providers?.find(p => p.id === 'codeagent');
    if (!provider) return result;
    const changed = current?.installed !== (provider.installed === true);
    current = { installed: provider.installed === true };
    if (changed) for (const listener of listeners) listener(current);
    return result;
  }
  function refresh() {
    if (pending) return pending;
    pending = Promise.resolve().then(() => ipcRenderer.invoke('community:setup')).then(accept).finally(() => { pending = null; });
    return pending;
  }
  function showGuide() {
    if (dialog?.isConnected) { if (!dialog.open) dialog.showModal(); return; }
    dialog = document.createElement('dialog');
    dialog.className = 'company-api-dialog'; dialog.id = 'codeagent-install-guide';
    dialog.setAttribute('aria-label', 'CodeAgent 安装说明');
    dialog.innerHTML = '<header><div><h2>安装 CodeAgent</h2><p>说明已随 Hub 安装，无需访问代码仓库。</p></div><button type="button" class="company-api-close" aria-label="关闭">×</button></header>'
      + '<div class="company-api-install"><ol><li>连接公司网络，打开 CodeAgent 官方入口，按其中的 Windows 安装指引完成安装。</li><li>安装完成后，点击下面的「重新检测」。若仍未检测到，重启 Hub 后再试。</li><li>检测为已安装后，到「账号」页登录，再创建会话。</li></ol><p>自定义安装路径请联系维护者检查。</p></div>'
      + '<p class="company-api-message" role="status">CodeAgent 未安装</p><footer><button type="button" data-setup="official">打开官方安装入口</button><button type="button" class="primary" data-setup="refresh">重新检测</button></footer>';
    document.body.append(dialog); dialog.showModal();
    if (current?.installed) dialog.querySelector('[role="status"]').textContent = 'CodeAgent 已安装，可到账号页检查登录。';
    dialog.querySelector('.company-api-close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; }, { once: true });
    dialog.querySelector('[data-setup="official"]').hidden = !OFFICIAL_INSTALL_URL;
    dialog.querySelector('[data-setup="official"]').onclick = () => { if (OFFICIAL_INSTALL_URL) void require('electron').shell.openExternal(OFFICIAL_INSTALL_URL); };
    dialog.querySelector('[data-setup="refresh"]').onclick = async event => {
      const target = dialog; event.currentTarget.disabled = true;
      try { await refresh(); if (target?.isConnected) target.querySelector('[role="status"]').textContent = current?.installed ? 'CodeAgent 已安装，可以关闭说明并到账号页登录。' : 'CodeAgent 未安装。请完成安装后重试；若刚修改安装路径，请重启 Hub。'; }
      catch (error) { if (target?.isConnected) target.querySelector('[role="status"]').textContent = '检测失败：' + error.message; }
      finally { target?.querySelector('[data-setup="refresh"]')?.removeAttribute('disabled'); }
    };
  }
  const api = { refresh, accept, showGuide, get current() { return current; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  instances.set(document, api); return api;
}
module.exports = { createCodeAgentSetup };
