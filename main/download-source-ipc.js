'use strict';
// 下载源标识的 IPC（r58，2026-11-19）：download-source:status({ point }) → 这个下载点现在能不能从公司内源下。
// 每个下载点在这里登记「内源上找什么」（文件名 + 内源版本名），和真正下载时传给 downloadWithFallback 的完全一致，
// 所以界面显示「内源可用」时，点下去确实先从内源下。没登记的下载点返回 missing（界面会显示「内源缺包」，不会假装可用）。
const sourceStatus = require('../core/app-update/source-status');

// 各下载点的 spec 由组件模块自己登记到 core/app-update/download-points.js（编号或以「:」结尾的前缀）。
function registerDownloadSourceIpc(ipcMain, { fetchImpl, env = process.env } = {}) {
  const lookup = point => require('../core/app-update/download-points').lookup(point);
  // r59：进度总线 → 所有窗口（界面按 point 认领自己的进度条）。
  require('../core/app-update/progress-bus').on(progress => {
    let windows = [];
    try { windows = require('electron').BrowserWindow.getAllWindows(); } catch (_) { return; }
    for (const w of windows) { try { if (!w.isDestroyed()) w.webContents.send('download-progress:update', progress); } catch (_) {} }
  });
  // 「内源上找什么」按下载点缓存 3 分钟（读失败缓存 1 分钟），同一时刻同一个点只解析一次：
  // 有的点要先读外网清单（PPT Doctor、识别组件、素材包），界面刷新很频繁，不能每次都去读。
  const specs = new Map();   // point → { at, ttl, promise }
  function specOf(point, fresh) {
    const hit = specs.get(point);
    if (!fresh && hit && Date.now() - hit.at < hit.ttl) return hit.promise;
    const resolve = lookup(point);
    if (!resolve) return null;
    const entry = { at: Date.now(), ttl: 3 * 60 * 1000, promise: null };
    entry.promise = Promise.resolve().then(() => resolve(point)).catch(error => { entry.ttl = 60 * 1000; throw error; });
    specs.set(point, entry);
    return entry.promise;
  }
  async function status(point, { fresh = false } = {}) {
    const pending = specOf(String(point || ''), fresh);
    if (!pending) return sourceStatus.view('missing', { reason: '这个下载点还没登记内源' });
    let spec;
    try { spec = await pending; }
    // r60：清单读不到（多半是公司网络拦了阿里云）和内源连不上是两回事，分开显示，免得误以为内源坏了。
    catch (error) { return { ...sourceStatus.view('nolist', { reason: error && error.message ? error.message : String(error) }), point: String(point) }; }
    if (!spec) return sourceStatus.view('missing', { reason: '组件清单里没有这一项' });
    const fetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => require('electron').net.fetch(...args);
    const value = await sourceStatus.check(spec, { fetchImpl: fetch, env, fresh, ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) });
    return { ...value, point: String(point), ...(spec.order ? { order: spec.order } : {}) };
  }
  // 浏览器手动下载（r58）：内源上有这个文件（且不是分片）就在浏览器里打开内源地址，返回 { ok:true, via:'openx' }；
  // 没有就返回 { ok:false }，界面照旧打开阿里云地址。地址只取内源接口给的、白名单域名内的 https 地址。
  async function openInternal(point) {
    const pending = specOf(String(point || ''), true);
    if (!pending) return { ok: false, reason: '这个下载点还没登记内源' };
    let spec;
    try { spec = await pending; } catch (error) { return { ok: false, reason: error.message }; }
    const item = spec && Array.isArray(spec.items) ? spec.items[0] : null;
    if (!item) return { ok: false, reason: '清单里没有安装包' };
    const openxSource = require('../core/app-update/openx-source');
    const fetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => require('electron').net.fetch(...args);
    const hit = await openxSource.find({ file: item.file, version: item.version, release: item.release, strict: !!spec.strict, fetchImpl: fetch, env });
    if (!hit || hit.urls) return { ok: false, reason: hit ? '内源上是分片包，请用一键更新' : openxSource.lastReason() };
    await require('electron').shell.openExternal(hit.url);
    return { ok: true, via: 'openx', url: hit.url };
  }
  // r60：「复制排错信息」——这个下载点的状态、原因、内源最近一次失败的原因和时间。不含地址与凭据。
  async function diagnostics(point) {
    const s = await status(point, { fresh: false });
    const o = require('../core/app-update/openx-source').diagnostics();
    let version = '';
    try { version = require('electron').app.getVersion(); } catch (_) {}
    const at = ms => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');
    return [
      `AI Hub ${version} · 下载点 ${point} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `状态：${s.status} · ${s.text || ''}`,
      s.reason ? `原因：${s.reason}` : '',
      `公司内源：${o.reachability === 'up' ? '连得上' : o.reachability === 'down' ? '连不上' : '还没探测'}${o.listAgeSec != null ? `（${o.listAgeSec} 秒前读到过版本列表）` : ''}`,
      o.down ? `内源最近一次失败：${o.down.reason}（${at(o.down.at)}）` : '',
      o.lastReason ? `内源最近一次查找：${o.lastReason}` : '',
    ].filter(Boolean).join('\n');
  }
  ipcMain.handle('download-source:diagnostics', (_event, request = {}) => diagnostics(String(request.point || '')));
  ipcMain.handle('download-source:open', (_event, request = {}) => openInternal(request.point));
  ipcMain.handle('download-source:status', (_event, request = {}) => status(request.point, { fresh: request.fresh === true }));
  return { status, openInternal, diagnostics };
}

module.exports = { registerDownloadSourceIpc };
