'use strict';
// CodeAgent 一键安装 / 升级的主进程入口（2026-11-16，core/codeagent-install.js）。
//   codeagent-install:start          已装→隐藏运行 codeagent update --force；未装→用「下载」里的官方安装器，或提示打开官方页；
//   codeagent-install:state          当前进度；
//   codeagent-install:open-official  在 Hub 自己的窗口里打开官方下载页（登录状态单独保存），用户点下载后由 Hub 接管：
//                                    存进一次性目录 → 核签名 → 静默安装 → 重新查找。
// 进度经 'codeagent-install:state' 推给页面。
const path = require('node:path');
const os = require('node:os');

const PARTITION = 'persist:codeagent-official';

function readDownloadPage() {
  try { return String(require('../../core/codeagent-version-check').DOWNLOAD_PAGE || '') || null; } catch { return null; }
}

function createInstaller({ dataDir, toolDiscovery, send }) {
  const config = require('../../core/codeagent-config');
  const versionProbe = require('../../core/codeagent-version-probe');
  return require('../../core/codeagent-install').createCodeAgentInstaller({
    dataDir,
    downloadPage: readDownloadPage(),
    resolveCommand() {
      try { const { command } = config.resolveCodeAgentConfig(); return command && config.isCodeAgentInstalled() ? command : ''; }
      catch { return ''; }
    },
    async rediscover() {
      versionProbe.forgetCodeAgentVersion();
      if (toolDiscovery) await toolDiscovery.list('codeagent', { force: true });
    },
    probeVersion(command) { versionProbe.forgetCodeAgentVersion(); return versionProbe.codeagentVersion(command); },
    onState: state => send('codeagent-install:state', state),
  });
}

// 官方来源（2026-11-17 r25c 收紧）：只认显式列出的主机，按 hostname 精确比较，不放行整个公司根域和子域；只认 https。
// 名单取自已批准的 core/codeagent-upgrade.json：官方下载页（CSOP）所在主机、黄区官方直链所在主机，外加该文件 officialHosts 字段里
// 经真机走查确认后补登的主机（如 CSOP 登录跳转的 SSO、下载 CDN）。代码里不写内部域名。
function hostOf(url) { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; } }
function readOfficialHosts(downloadPage) {
  let cfg = {};
  try { cfg = require('../../core/codeagent-upgrade.json') || {}; } catch { /* 没有配置就只认下载页本身 */ }
  return buildOfficialHosts({ downloadPage, extraUrls: [cfg.yellowZoneDownload], extraHosts: cfg.officialHosts });
}
function buildOfficialHosts({ downloadPage, extraUrls = [], extraHosts = [] } = {}) {
  const hosts = [hostOf(downloadPage), ...extraUrls.map(hostOf), ...(Array.isArray(extraHosts) ? extraHosts : []).map(h => String(h || '').trim().toLowerCase())];
  return [...new Set(hosts.filter(h => /^[a-z0-9.-]+$/.test(h) && h.includes('.')))];
}
// hosts：主机名数组；传字符串时视为官方下载页地址，只认它自己的主机。
function isOfficialUrl(url, hosts) {
  const list = Array.isArray(hosts) ? hosts : buildOfficialHosts({ downloadPage: hosts });
  if (!list.length) return false;
  let u; try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return list.includes(u.hostname.toLowerCase());
}

function registerCodeAgentInstallIpc(ipcMain, { dataDir, toolDiscovery, send, electron = require('electron'), installer: injected, downloadPage: pageOverride, officialHosts: hostsOverride } = {}) {
  const installer = injected || createInstaller({ dataDir, toolDiscovery, send });
  const pageUrl = () => (pageOverride !== undefined ? pageOverride : readDownloadPage());
  const official = () => (hostsOverride !== undefined ? hostsOverride : (pageOverride !== undefined ? buildOfficialHosts({ downloadPage: pageOverride }) : readOfficialHosts(pageUrl())));
  let officialWindow = null;
  let takingOver = null;   // 正在接管的那个下载；同一时刻只接管一个
  const note = message => installer.report({ ...installer.snapshot(), message });
  const refuse = (what, url) => {
    let host = ''; try { host = new URL(String(url)).hostname; } catch { /* 地址不合法 */ }
    note(`${what}不是 CodeAgent 官方来源（${host || '无效地址'}），已拦下。请只在官方下载页里登录和下载`);
  };

  ipcMain.handle('codeagent-install:state', () => installer.snapshot());
  ipcMain.handle('codeagent-install:start', (_event, options = {}) => installer.start({ forceInstall: options?.forceInstall === true }));
  ipcMain.handle('codeagent-install:open-official', () => {
    const url = pageUrl();
    if (!url) return { ok: false, error: '这个版本没有配置 CodeAgent 官方下载页' };
    if (officialWindow && !officialWindow.isDestroyed()) { officialWindow.show(); officialWindow.focus(); return { ok: true, reused: true }; }
    const { BrowserWindow, session } = electron;
    const ses = session.fromPartition(PARTITION);
    if (!ses.__codeagentInstallHooked) {
      ses.__codeagentInstallHooked = true;
      ses.on('will-download', (_e, item) => {
        const name = path.basename(String(item.getFilename() || ''));
        // 只接管 Windows 安装程序；页面上的其他附件照常让用户自己保存。
        if (!/\.exe$/i.test(name)) return;
        // 下载地址及其整条重定向链都要是官方来源，否则不下、不装。
        const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
        const urls = [...(Array.isArray(chain) ? chain : []), typeof item.getURL === 'function' ? item.getURL() : ''].filter(Boolean);
        const bad = urls.length ? urls.find(u => !isOfficialUrl(u, official())) : '(无地址)';
        if (bad) { item.cancel(); refuse(`安装包 ${name} 的下载地址`, bad); return; }
        if (takingOver) { item.cancel(); note(`已经在接管一个下载（${takingOver}），这次的 ${name} 已取消；等前一个装完，需要时再点下载`); return; }
        takingOver = name;
        const job = path.join(dataDir || os.tmpdir(), 'codeagent-install', 'download-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8));
        require('node:fs').mkdirSync(job, { recursive: true });
        const file = path.join(job, name.replace(/[^\w.() -]/g, '_'));
        item.setSavePath(file);
        installer.report({ phase: 'downloading', received: 0, total: item.getTotalBytes(), message: `正在下载 ${name}…` });
        item.on('updated', (_ev, st) => {
          if (st === 'interrupted') return;
          const total = item.getTotalBytes(), got = item.getReceivedBytes();
          installer.report({ phase: 'downloading', received: got, total, message: `正在下载 ${name}${total ? `（${Math.round(got / total * 100)}%）` : `（已下 ${Math.round(got / 1048576)} MB）`}…` });
        });
        item.once('done', (_ev, st) => {
          takingOver = null;
          const cleanup = () => require('node:fs').rm(job, { recursive: true, force: true }, () => {});
          if (st !== 'completed') {
            cleanup();
            installer.report({ phase: 'error', code: 'CA_DOWNLOAD_' + String(st).toUpperCase(), error: '下载没完成', message: st === 'cancelled' ? '下载被取消了。需要时再点一次官方页里的下载' : '下载中断了，可能是网络不稳定或被公司代理拦截；确认连着公司网络后，在官方页里重新点下载' });
            return;
          }
          if (officialWindow && !officialWindow.isDestroyed()) officialWindow.close();
          // installFile 排队执行，结果只属于这份文件；它自己的安装结束后才删这份下载。
          void installer.installFile(file, { source: 'download' }).finally(cleanup);
        });
      });
    }
    officialWindow = new BrowserWindow({ width: 1200, height: 820, title: 'CodeAgent 官方下载页 — 点页面里的下载，下载完 AI HUB 会自动安装', autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    officialWindow.on('closed', () => { officialWindow = null; });
    const wc = officialWindow.webContents;
    // 主文档跳转、服务端重定向、新开窗口都只允许官方来源；窗口没有地址栏，第三方页面一律不让进来。
    // Electron 41 的事件对象自带 url / isMainFrame；旧签名的第 2、4 个参数兜底。
    const guard = what => (event, next, _inPlace, mainFrame) => {
      const target = event?.url || next;
      if ((event?.isMainFrame ?? mainFrame ?? true) === false) return;
      if (!isOfficialUrl(target, official())) { event.preventDefault(); refuse(what, target); }
    };
    wc.on('will-navigate', guard('要打开的页面'));
    wc.on('will-redirect', guard('页面跳转的目标'));
    // 跳转落定后的最终地址再核一次（重定向链上每一跳已由 will-redirect 检查，这里兜住其他途径落到的页面）：不是官方主机就退回官方下载页。
    wc.on('did-navigate', (_e, landed) => {
      if (isOfficialUrl(landed, official())) return;
      refuse('跳转后的页面', landed);
      try { wc.stop(); } catch { /* 窗口已关 */ }
      void officialWindow?.loadURL(url).catch(() => {});
    });
    wc.setWindowOpenHandler(({ url: next }) => { if (isOfficialUrl(next, official())) officialWindow?.loadURL(next); else refuse('新窗口地址', next); return { action: 'deny' }; });
    void officialWindow.loadURL(url).catch(error => installer.report({ phase: 'error', code: 'CA_OFFICIAL_PAGE', error: error.message, message: '官方下载页打不开，请确认这台电脑连着公司网络' }));
    installer.report({ phase: 'waiting-download', message: '已打开官方下载页：登录后点页面里的下载按钮，下载完成后 AI HUB 会自动核对签名并安装' });
    return { ok: true };
  });
  return installer;
}

module.exports = { registerCodeAgentInstallIpc, isOfficialUrl, buildOfficialHosts, readOfficialHosts, PARTITION };
