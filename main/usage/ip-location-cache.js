'use strict';

// 出口 IP 的地点（账号看板显示「104.x.x.x 美国 洛杉矶」）：每个 IP 只查一次，结果存在数据目录，30 天后再核对。
// 查询先直连再走 Hub 代理，复用底栏出口探测的解析（core/network-egress-monitor.js）。2026-10-29 实测直连 1–6 秒可查到。
const fs = require('fs');
const path = require('path');
const net = require('net');
const { createCurlGeoProbe } = require('../../core/network-egress-monitor');

const KEEP_MS = 30 * 24 * 3600_000;
const RETRY_MS = 10 * 60_000;

function createIpLocationCache({ dataDir, getProxy = () => '', probeFactory = createCurlGeoProbe, now = Date.now } = {}) {
  const file = path.join(dataDir, 'ip-location-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  const failedAt = new Map();
  const flights = new Map();
  const persist = () => { try { fs.writeFileSync(file, JSON.stringify(cache, null, 2)); } catch {} };
  const proxyText = () => { const p = getProxy(); return typeof p === 'string' ? p : (p?.https || p?.http || ''); };

  async function lookupOne(ip) {
    const probe = probeFactory({ endpoints: [{ name: 'ipwhois', url: 'https://ipwho.is/' + ip }, { name: 'ipinfo', url: 'https://ipinfo.io/' + ip + '/json' }], timeoutMs: 8000 });
    for (const route of ['direct', 'proxy']) {
      const r = await probe({ route, proxy: proxyText() });
      if (r?.ok && (r.countryZh || r.cityZh)) return { countryZh: r.countryZh || '', cityZh: r.cityZh || '', at: now() };
    }
    return null;
  }

  async function get(ips) {
    const out = {};
    const list = [...new Set((Array.isArray(ips) ? ips : []).filter(ip => net.isIP(String(ip || ''))))].slice(0, 16);
    await Promise.all(list.map(async ip => {
      const hit = cache[ip];
      if (hit && now() - (hit.at || 0) < KEEP_MS) { out[ip] = hit; return; }
      if (failedAt.has(ip) && now() - failedAt.get(ip) < RETRY_MS) { if (hit) out[ip] = hit; return; }
      if (!flights.has(ip)) flights.set(ip, lookupOne(ip).catch(() => null).finally(() => flights.delete(ip)));
      const found = await flights.get(ip);
      if (found) { cache[ip] = found; persist(); out[ip] = found; }
      else { failedAt.set(ip, now()); if (hit) out[ip] = hit; }
    }));
    return out;
  }
  return { get };
}

module.exports = { createIpLocationCache };
