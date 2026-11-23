'use strict';

const systemOs = require('os');
const { registerPreviewImmersiveIpc } = require('./preview-immersive-handlers.js');
const { createSystemTelemetry } = require('../../core/system-telemetry.js');
const { createLiveResourceTelemetry } = require('../../core/live-resource-telemetry.js');
const { createClashVergeDelayReader } = require('../../core/clash-verge-delay.js');
const { createVpnTrafficRecorder } = require('../../core/vpn-traffic-recorder.js');

function readCpuTotals(osApi) {
  const cpus = osApi.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!times) continue;
    const values = Object.values(times).filter(Number.isFinite);
    idle += Number.isFinite(times.idle) ? times.idle : 0;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return total > 0 ? { idle, total } : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createSystemResourceSampler(osApi = systemOs) {
  let previousCpu = readCpuTotals(osApi);

  return function sampleSystemResourceUsage() {
    const currentCpu = readCpuTotals(osApi);
    let cpuPct = null;
    if (previousCpu && currentCpu) {
      const totalDelta = currentCpu.total - previousCpu.total;
      const idleDelta = currentCpu.idle - previousCpu.idle;
      if (totalDelta > 0) cpuPct = clampPercent((1 - Math.max(0, idleDelta) / totalDelta) * 100);
    }
    previousCpu = currentCpu;

    const totalMemory = osApi.totalmem();
    const freeMemory = osApi.freemem();
    const memoryPct = totalMemory > 0
      ? clampPercent((1 - freeMemory / totalMemory) * 100)
      : null;

    return { cpuPct, memoryPct, sampledAt: Date.now() };
  };
}

// 粘进会话的图片长边上限（2026-11-22）：Claude 接口在一轮里图多时要求每张 ≤2000×2000，超了 CLI 自己缩，
// 缩不动就整轮报「dimensions exceed the 2000x2000px limit」（同事 v5.6.76 实遇，全屏截图 2560/3840 宽必中）。
// 保存时就按比例缩到长边 2000，模型端本来也会降到约 1568，看图效果不变。
const PASTE_IMAGE_MAX_EDGE = 2000;
function fitImageToMaxEdge(image, maxEdge = PASTE_IMAGE_MAX_EDGE) {
  const from = image.getSize();
  const edge = Math.max(from.width, from.height);
  if (!(edge > maxEdge)) return { image, resized: false, from, to: from };
  const ratio = maxEdge / edge;
  const target = { width: Math.max(1, Math.round(from.width * ratio)), height: Math.max(1, Math.round(from.height * ratio)) };
  const scaled = image.resize({ ...target, quality: 'best' });
  return { image: scaled, resized: true, from, to: scaled.getSize() };
}

// withInfo=true 时返回 { path, resized, from, to }（输入框据此提示「已缩小」）；不带参数仍只返回路径，兼容旧调用。
function saveClipboardImage(deps, { withInfo = false } = {}) {
  const {
    clipboard,
    crypto,
    fs,
    imageDir,
    logger = console,
    path,
  } = deps;

  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = crypto.randomBytes(3).toString('hex');
    const filename = `${timestamp}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    const fitted = fitImageToMaxEdge(image);
    fs.writeFileSync(filePath, fitted.image.toPNG());
    if (fitted.resized) logger.info?.(`[paste-image] 图片 ${fitted.from.width}×${fitted.from.height} 超过 ${PASTE_IMAGE_MAX_EDGE}px，已缩到 ${fitted.to.width}×${fitted.to.height}`);
    return withInfo ? { path: filePath, resized: fitted.resized, from: fitted.from, to: fitted.to, maxEdge: PASTE_IMAGE_MAX_EDGE } : filePath;
  } catch (err) {
    logger.warn('[群聊] save-clipboard-image failed:', err.message);
    return null;
  }
}

// 文件入口只读原图；超限时沿用位图保存流程，在 Hub 图片目录写缩小副本。
function prepareImageFile(deps, filePath) {
  if (typeof filePath !== 'string' || !deps.path.isAbsolute(filePath)) throw new Error('Invalid attachment path');
  // 只缩放能可靠解码的静态图；GIF 动图、WebP/BMP/TIFF 等解不出来的照原样附上（以前就能附，不能因缩放变成附不上）。
  if (!/\.(png|jpe?g)$/i.test(filePath)) return { path: filePath, resized: false };
  let image;
  try {
    // Buffer decoding fixes the representation at 1 pixel per DIP; @2x names
    // must not halve the dimensions used by the attachment limit.
    image = require('../../core/image-file-orientation').decodeImageFile(
      deps.nativeImage || require('electron').nativeImage, deps.fs.readFileSync(filePath));
  } catch { return { path: filePath, resized: false }; }
  if (!image || image.isEmpty()) return { path: filePath, resized: false };
  if (Math.max(...Object.values(image.getSize())) <= PASTE_IMAGE_MAX_EDGE) return { path: filePath, resized: false };
  const saved = saveClipboardImage({ ...deps, clipboard: { readImage: () => image } }, { withInfo: true });
  if (!saved) throw new Error('Cannot prepare image: ' + deps.path.basename(filePath));
  return { ...saved, originalPath: filePath };
}

function registerAppUtilityIpc(ipcMain, deps) {
  const writeClipboardText = require('../../core/verified-clipboard.js').createVerifiedClipboardWriter({ clipboard: deps.clipboard,
    onRevertRepaired: info => console.info('[clipboard] 复制后被其他程序改回旧内容，已写回', info) });
  ipcMain.handle('clipboard:write-text', (_event, text, formats) => writeClipboardText(text, formats));
  ipcMain.handle('touch-tools:paste', event => { event.sender.paste(); return { ok: true }; });
  ipcMain.handle('touch-tools:screenshot', async event => {
    const isCurrent = writeClipboardText.beginExternalWrite();
    try {
      const { desktopCapturer, screen, BrowserWindow } = require('electron');
      const owner = BrowserWindow.fromWebContents(event.sender);
      const display = owner ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      } });
      const source = sources.find(item => item.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('未能截取当前屏幕，请重试');
      if (!isCurrent()) throw new Error('期间有新的复制操作，已保留新内容，请重新截图');
      const expected = source.thumbnail.toPNG();
      let copied = null;
      // 剪贴板被占用时与文字复制同样持续重试；期间有新复制就让位。
      const written = await writeClipboardText.retry(() => {
        deps.clipboard.writeImage(source.thumbnail);
        copied = deps.clipboard.readImage();
        return !copied.isEmpty() && copied.toPNG().equals(expected);
      }, isCurrent);
      if (written.reason === 'superseded') throw new Error('期间有新的复制操作，已保留新内容，请重新截图');
      if (!written.ok) throw new Error('截图写入剪贴板失败，请重试');
      return { ok: true, size: copied.getSize() };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  registerPreviewImmersiveIpc(ipcMain, deps);
  const sampleSystemResourceUsage = createSystemResourceSampler(deps.os || systemOs);
  const systemTelemetry = deps.systemTelemetry || createSystemTelemetry();
  const clashDelay = deps.clashDelay || createClashVergeDelayReader();
  const liveTelemetry = deps.liveTelemetry || createLiveResourceTelemetry();
  ipcMain.handle('get-network-transfer-usage', () => liveTelemetry.sampleNetwork());
  ipcMain.handle('get-resource-top-processes', () => liveTelemetry.sampleProcesses());

  ipcMain.handle('is-window-focused', () => {
    const mainWindow = deps.getMainWindow();
    return mainWindow ? mainWindow.isFocused() : false;
  });

  // 会话卡片里用户点了「显示网络图片」：主进程取回图片转 data: 地址（core/remote-image-fetch.js）。
  ipcMain.handle('card-media:fetch-remote-image', (_event, url) => {
    const remote = require('../../core/remote-image-fetch.js');
    return remote.fetchRemoteImage(url, { fetch: remote.createElectronSingleHopFetch(require('electron').net) });
  });

  ipcMain.handle('save-clipboard-image', (_event, options) => {
    return saveClipboardImage(deps, { withInfo: !!(options && options.withInfo) });
  });
  ipcMain.handle('prepare-image-file', (_event, filePath) => prepareImageFile(deps, filePath));

  ipcMain.handle('get-hook-status', () => ({
    up: deps.getHookPort() !== null,
    port: deps.getHookPort(),
    message: deps.portDiagnosis?.() || '',
  }));

  ipcMain.handle('get-system-resource-usage', async (_event, options = {}) => {
    const coreUsage = sampleSystemResourceUsage();
    // Reuse the bounded GPU (10 s) and disk (60 s) caches for the compact footer.
    if (options.extended === false) {
      const [gpu, disk] = await Promise.allSettled([
        systemTelemetry.sampleGpu?.(), systemTelemetry.sampleDisk?.(),
      ]);
      return { ...coreUsage, gpu: gpu.status === 'fulfilled' ? gpu.value || null : null,
        disk: disk.status === 'fulfilled' ? disk.value || null : null };
    }
    try {
      const extended = await systemTelemetry.sample({ force: options && options.force === true });
      return { ...coreUsage, ...extended };
    } catch {
      return coreUsage;
    }
  });

  ipcMain.handle('get-clash-proxy-delay', () => clashDelay.sample());

  // VPN 流量账本：只有传入数据目录时才启动（单测注册 IPC 时不起后台轮询）。
  const vpnTraffic = deps.vpnTraffic
    || (deps.vpnTrafficDir ? createVpnTrafficRecorder({ dir: deps.vpnTrafficDir }) : null);
  if (vpnTraffic && !deps.vpnTraffic) {
    vpnTraffic.start();
    deps.app?.on?.('will-quit', () => vpnTraffic.stop());
  }
  ipcMain.handle('get-vpn-traffic-report', (_event, options = {}) => {
    if (!vpnTraffic) return { status: { recording: false, holder: 'none', error: 'recorder-disabled' } };
    return vpnTraffic.report(options && options.range);
  });

  ipcMain.handle('get-network-egress-status', (_event, options = {}) => {
    if (typeof deps.getNetworkEgressStatus !== 'function') {
      return {
        checkedAt: Date.now(),
        foreign: { ok: false, route: 'proxy', errorCode: 'monitor_unavailable', error: '出口监测未启用' },
        domestic: { ok: false, route: 'direct', errorCode: 'monitor_unavailable', error: '出口监测未启用' },
        alert: { type: 'monitor_unavailable', severity: 'critical', title: '出口监测未启用' },
      };
    }
    return deps.getNetworkEgressStatus({ force: options && options.force === true });
  });

  ipcMain.handle('acknowledge-network-egress-change', () => {
    if (typeof deps.acknowledgeNetworkEgressChange !== 'function') {
      return { ok: false, error: 'monitor_unavailable' };
    }
    return deps.acknowledgeNetworkEgressChange();
  });
}

module.exports = {
  createSystemResourceSampler,
  registerAppUtilityIpc,
  saveClipboardImage,
  prepareImageFile,
  fitImageToMaxEdge,
  PASTE_IMAGE_MAX_EDGE,
};
