'use strict';
// 会话卡片里的网络图片（renderer/card-media.js）：用户点了「显示网络图片」才由主进程取回，
// 以 data: 地址交给页面。页面的图片安全策略不放开网络地址，其他页面不会因此自动加载网络图片。
// 重定向逐跳自己跟：每一跳都只认 https、不碰本机与内网地址（防回答里的链接借图片探内网）。
const net = require('node:net');
const dnsPromises = require('node:dns').promises;

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;
const TYPES = /^image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;

function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  // URL 会把 [::ffff:127.0.0.1] 规范成十六进制写法 [::ffff:7f00:1]，按 IPv4 再判断一次。
  const hex = ip.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  return false;
}

// 主机名是本机或内网地址就不取（198.18.0.0/15 不算：代理软件的 fake-ip 模式把外网域名都解析到这一段）。解析不了（例如公司网只能经代理出网）时交给代理，不在这里拦。
async function checkHost(url, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return '不加载本机地址上的图片';
  if (net.isIP(host)) return isPrivateAddress(host) ? '不加载本机或内网地址上的图片' : '';
  let addresses = [];
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { return ''; }
  return addresses.some(entry => isPrivateAddress(entry && entry.address)) ? '不加载本机或内网地址上的图片' : '';
}

async function fetchRemoteImage(rawUrl, { fetch: fetchImpl, lookup = dnsPromises.lookup, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return { ok: false, reason: '网址无法解析' }; }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前环境不能取网络图片' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response = null;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:') return { ok: false, reason: hop ? '图片被转到了非 https 地址' : '只加载 https 网络图片' };
      const blocked = await checkHost(url, lookup);
      if (blocked) return { ok: false, reason: blocked };
      response = await fetchImpl(url.href, { signal: controller.signal, redirect: 'manual', credentials: 'omit' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) return { ok: false, reason: '图片网站返回了没有目标的跳转' };
      if (hop >= MAX_REDIRECTS) return { ok: false, reason: '图片网址跳转太多次' };
      try { url = new URL(location, url); } catch { return { ok: false, reason: '跳转地址无法解析' }; }
    }
    if (!response.ok) return { ok: false, reason: '图片网站返回 ' + response.status };
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.test(type)) return { ok: false, reason: '这个网址返回的不是图片' };
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) return { ok: false, reason: '图片超过 10 MB' };
    const chunks = []; let size = 0;
    const reader = response.body?.getReader?.();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { controller.abort(); return { ok: false, reason: '图片超过 10 MB' }; }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) return { ok: false, reason: '图片超过 10 MB' };
      chunks.push(buffer); size = buffer.length;
    }
    return { ok: true, dataUrl: 'data:' + type + ';base64,' + Buffer.concat(chunks, size).toString('base64'), bytes: size };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? '图片加载超时' : '图片加载失败：' + String(error?.message || error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
    // 提前拒收（不是图片、太大、跳转不合规）时底层请求还开着：一律中止。
    controller.abort();
  }
}

// Electron 的 net.fetch 在 redirect:'manual' 下直接报 "Redirect was cancelled"，拿不到跳转目标；
// 这里用 net.request（走系统代理，与 net.fetch 相同）自己做一个「只取一跳」的 fetch：遇到跳转就返回 3xx 与 location。
function createElectronSingleHopFetch(electronNet) {
  return (url, { signal } = {}) => new Promise((resolve, reject) => {
    const request = electronNet.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    let streamBody = null;
    const onAbort = () => {
      try { request.abort(); } catch {}
      const e = new Error('aborted'); e.name = 'AbortError';
      // 已经在读正文时，把读取一并唤醒成失败，免得超时后一直挂着。
      if (streamBody && !streamBody.done) { streamBody.error = e; streamBody.wake(); }
      finish(reject, e);
    };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    request.on('redirect', (status, _method, location) => {
      try { request.abort(); } catch {}
      finish(resolve, { ok: false, status, headers: { get: k => (String(k).toLowerCase() === 'location' ? location : null) } });
    });
    request.on('response', response => {
      const header = k => { const v = response.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : (v ?? null); };
      const chunks = [];
      let pump = null;
      const body = {
        getReader() {
          return { read: () => new Promise((res, rej) => {
            if (body.error) return rej(body.error);
            if (chunks.length) return res({ done: false, value: chunks.shift() });
            if (body.done) return res({ done: true });
            pump = { res, rej };
          }) };
        },
      };
      const wake = () => { if (!pump) return; const p = pump; pump = null; if (body.error) p.rej(body.error); else if (chunks.length) p.res({ done: false, value: chunks.shift() }); else if (body.done) p.res({ done: true }); };
      body.wake = wake; streamBody = body;
      response.on('data', chunk => { chunks.push(new Uint8Array(chunk)); wake(); });
      response.on('end', () => { body.done = true; wake(); });
      response.on('error', error => { body.error = error; wake(); });
      finish(resolve, { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, headers: { get: header }, body });
    });
    request.on('error', error => finish(reject, error));
    request.end();
  });
}

module.exports = { fetchRemoteImage, isPrivateAddress, createElectronSingleHopFetch, MAX_BYTES };
