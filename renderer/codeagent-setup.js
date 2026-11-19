'use strict';

// Share the latest display state, but always recheck before starting an action.
const instances = new WeakMap();
const OFFICIAL_INSTALL_URL = 'https://agent.huawei.com/';
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
  // scan：先让 Hub 重新扫一遍常见安装位置（2026-11-07，core/tool-discovery：PATH、npm 全局目录、注册表里最新的 PATH、常用安装目录），再判断装没装。
  let lastScan = null;
  function refresh({ scan = false } = {}) {
    if (pending && !scan) return pending;
    pending = Promise.resolve()
      .then(() => scan ? ipcRenderer.invoke('tool-discovery:list', { tool: 'codeagent', force: true }).then(r => { lastScan = r?.ok === false ? null : r; }, () => { lastScan = null; }) : null)
      .then(() => ipcRenderer.invoke('community:setup')).then(accept).finally(() => { pending = null; });
    return pending;
  }
  // 找到时的说明：带版本号；本机有多个版本时附上「点此切换」。
  function foundText(target) {
    const version = lastScan?.current?.version;
    const picker = require('./tool-version-picker');
    const hint = picker.hintHtml(lastScan) || picker.switchHtml(lastScan);
    const status = target.querySelector('[role="status"]');
    status.textContent = `已自动找到 CodeAgent${version ? ' v' + version : ''}，可以关闭说明，到账号页登录或直接新建会话。`;
    target.querySelector('[data-setup-hint]')?.remove();
    if (hint) { picker.createToolVersionPicker({ document, ipcRenderer }); status.insertAdjacentHTML('afterend', `<div data-setup-hint>${hint}</div>`); }
  }
  function showGuide() {
    if (dialog?.isConnected) { if (!dialog.open) dialog.showModal(); return; }
    dialog = document.createElement('dialog');
    dialog.className = 'company-api-dialog'; dialog.id = 'codeagent-install-guide';
    dialog.setAttribute('aria-label', 'CodeAgent 安装说明');
    dialog.innerHTML = '<header><div><h2>安装 CodeAgent</h2><p>说明已随 Hub 安装，无需访问代码仓库。</p></div><button type="button" class="company-api-close" aria-label="关闭">×</button></header>'
      + '<div class="company-api-install"><ol><li>连接公司网络，点「一键安装」：Hub 会用「下载」文件夹里的官方安装包，或打开官方下载页让你点一下下载，然后自动核对签名、静默安装（Windows 会弹一次管理员确认）。也可以打开官方入口自己装。</li><li>安装完成后，点击下面的「重新检测」，不用重启 Hub。</li><li>检测为已安装后，到「账号」页登录，再创建会话。</li></ol><p>Hub 会自动在系统路径、npm 全局目录和常用安装目录里查找；装在别处时，点「手动选择…」指定 codeagent 程序。</p></div>'
      + '<p class="company-api-message" role="status">正在自动查找本机已安装的 CodeAgent…</p><footer style="flex-wrap:wrap"><button type="button" data-setup="official" style="white-space:nowrap">官方安装入口</button><button type="button" data-setup="csop" style="white-space:nowrap" hidden>打开官方下载页</button><button type="button" data-setup="pick" style="white-space:nowrap">手动选择…</button><button type="button" data-setup="refresh" style="white-space:nowrap">重新检测</button><button type="button" class="primary" data-setup="install" style="white-space:nowrap">一键安装</button></footer>';
    document.body.append(dialog); dialog.showModal();
    // 打开说明时先自动找一遍：装在常见位置、只是 Hub 启动后才装的，这里就能直接找到，不用用户做任何事。
    const opened = dialog;
    void refresh({ scan: true }).then(() => {
      if (!opened?.isConnected) return;
      if (current?.installed) foundText(opened);
      else if (!opened.dataset.installTouched) opened.querySelector('[role="status"]').textContent = '常见位置都没找到 CodeAgent。点「一键安装」，或按上面的步骤安装，装好后点「重新检测」。';
    }, error => { if (opened?.isConnected) opened.querySelector('[role="status"]').textContent = '自动查找没完成：' + error.message; });
    dialog.querySelector('.company-api-close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; }, { once: true });
    dialog.querySelector('[data-setup="official"]').hidden = !OFFICIAL_INSTALL_URL;
    dialog.querySelector('[data-setup="official"]').onclick = () => { if (OFFICIAL_INSTALL_URL) void require('electron').shell.openExternal(OFFICIAL_INSTALL_URL); };
    // 一键安装（2026-11-16）：已有安装包就核签名后静默安装；没有就亮出「打开官方下载页」，下载完 Hub 自动接手。
    const installClient = require('./codeagent-install-client').sharedClient(ipcRenderer);
    const say = state => {
      const target = dialog; if (!target?.isConnected || !state?.message) return;
      target.dataset.installTouched = '1';
      // r59：安装进行中显示统一进度条（官方安装程序不报字节，用动态条 + 当前步骤 + 来源）。
      const active = installClient.active(state);
      let host = target.querySelector('[data-setup-dlp]');
      if (!host) { target.querySelector('[role="status"]').insertAdjacentHTML('afterend', '<div data-setup-dlp></div>'); host = target.querySelector('[data-setup-dlp]'); }
      host.innerHTML = active ? require('./download-progress-view').html({ phase: state.phase === 'verifying' ? 'verifying' : 'installing', message: state.message, sourceName: 'CodeAgent 官方渠道' }, { title: '安装 CodeAgent' }) : '';
      target.querySelector('[role="status"]').textContent = active ? '' : state.message;
      target.querySelector('[data-setup="csop"]').hidden = !(state.downloadPage && /need-download|error/.test(state.phase));
      target.querySelector('[data-setup="install"]').disabled = installClient.active(state);
    };
    const unsubscribe = installClient.subscribe(state => {
      say(state);
      if (state.phase === 'done') void refresh().then(() => { if (dialog?.isConnected && current?.installed) dialog.querySelector('[role="status"]').textContent = state.message + '。可以关闭说明，到账号页登录或直接新建会话。'; });
    });
    dialog.addEventListener('close', unsubscribe, { once: true });
    if (installClient.active(installClient.last)) say(installClient.last);
    dialog.querySelector('[data-setup="install"]').onclick = async () => { say({ phase: 'verifying', message: '正在准备一键安装…' }); say(await installClient.start()); };
    dialog.querySelector('[data-setup="csop"]').onclick = async () => {
      const r = await installClient.openOfficial();
      if (!r?.ok && dialog?.isConnected) dialog.querySelector('[role="status"]').textContent = '官方下载页没能打开：' + (r?.error || '未知原因');
    };
    dialog.querySelector('[data-setup="pick"]').onclick = async () => {
      const target = dialog;
      try {
        const r = await ipcRenderer.invoke('tool-discovery:pick', { tool: 'codeagent' });
        if (!r || r.canceled || !target?.isConnected) return;
        if (r.ok === false) throw new Error(r.error || '没能使用这个程序');
        lastScan = r; await refresh();
        if (target.isConnected) foundText(target);
      } catch (error) { if (target?.isConnected) target.querySelector('[role="status"]').textContent = '手动选择没成功：' + error.message; }
    };
    dialog.querySelector('[data-setup="refresh"]').onclick = async event => {
      const target = dialog; event.currentTarget.disabled = true;
      target.querySelector('[role="status"]').textContent = '正在重新查找…';
      try { await refresh({ scan: true }); if (target?.isConnected) { if (current?.installed) foundText(target); else target.querySelector('[role="status"]').textContent = '还是没找到 CodeAgent。请确认安装已完成；装在不常见的目录时，点「手动选择…」。'; } }
      catch (error) { if (target?.isConnected) target.querySelector('[role="status"]').textContent = '检测失败：' + error.message; }
      finally { target?.querySelector('[data-setup="refresh"]')?.removeAttribute('disabled'); }
    };
  }
  const api = { refresh, accept, showGuide, get current() { return current; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  instances.set(document, api); return api;
}
module.exports = { createCodeAgentSetup };
