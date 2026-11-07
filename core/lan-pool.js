'use strict';

// LAN sharing has its own credentials and exposes only model calls and a curated quota snapshot.
// It never exposes Hub IPC, a terminal, upstream logins, prompts, or the local proxy admin API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const VERSION = '1.0.0';
const DEFAULT_PORT = 18766;
const MODEL_IDS = ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017'];
const file = dataDir => path.join(dataDir, 'lan-pool', 'settings.json');
const empty = () => ({ host: { enabled: false, port: DEFAULT_PORT, members: [] }, client: null });
function read(dataDir) {
  let text;
  try { text = fs.readFileSync(file(dataDir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return empty(); throw new Error('共享配置读取失败：' + e.message); }
  try { const v = JSON.parse(text); if (v && typeof v === 'object') return v; throw new Error('not an object'); }
  catch {
    // A damaged settings file must not block the host's own company-model sessions.
    // Keep the bytes for inspection and continue with sharing switched off.
    const backup = file(dataDir) + '.corrupt-' + Date.now();
    try { fs.renameSync(file(dataDir), backup); } catch { /* another reader already moved it */ }
    console.warn('[lan-pool] settings.json was unreadable; moved to ' + path.basename(backup) + ' and sharing reset to off');
    return empty();
  }
}
function write(dataDir, next) {
  fs.mkdirSync(path.dirname(file(dataDir)), { recursive: true });
  const tmp = file(dataDir) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file(dataDir)); return next;
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function isPrivateAddress(value) {
  const ip = String(value || '').replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31));
}
function address(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { throw new Error('请填写主机提供的完整内网地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || !isPrivateAddress(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    throw new Error('共享地址需使用内网 IPv4 地址，且不含路径、口令或查询参数');
  }
  return u.origin;
}
function port(value) { const n = Number(value); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('端口需在 1024–65535 之间'); return n; }
function bound(value, fallback, max) { const n = value == null ? fallback : Number(value); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('并发或限速超出允许范围'); return n; }
function addMember(dataDir, request = {}) {
  const name = String(request.name || '').trim();
  if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('请填写 1–40 字的同事备注');
  const current = read(dataDir);
  if ((current.host?.members || []).filter(m => !m.revokedAt).length >= 100) throw new Error('最多添加 100 位同事');
  const secret = crypto.randomBytes(24).toString('hex');
  const member = { id: crypto.randomBytes(8).toString('hex'), name, secretHash: hash(secret), createdAt: Date.now(),
    maxConcurrent: bound(request.maxConcurrent, 2, 16), rpm: bound(request.rpm, 60, 600) };
  write(dataDir, { ...current, host: { ...current.host, members: [...(current.host?.members || []), member] } });
  return { member: publicMember(member), secret };
}
function publicMember(m) { return { id: m.id, name: m.name, createdAt: m.createdAt, revokedAt: m.revokedAt || null, maxConcurrent: m.maxConcurrent, rpm: m.rpm }; }
function revoke(dataDir, id) {
  const current = read(dataDir); if (!(current.host?.members || []).some(m => m.id === id)) throw new Error('找不到该同事');
  write(dataDir, { ...current, host: { ...current.host, members: current.host.members.map(m => m.id === id ? { ...m, revokedAt: Date.now() } : m) } });
}
function authenticate(dataDir, raw) {
  if (typeof raw !== 'string' || raw.length > 120) return null;
  const [secret, tag = 'default', extra] = raw.split('.');
  if (extra !== undefined || !/^[a-f0-9]{48}$/.test(secret) || !/^[A-Za-z0-9_-]{1,64}$/.test(tag)) return null;
  const digest = Buffer.from(hash(secret), 'hex');
  const member = (read(dataDir).host?.members || []).find(m => !m.revokedAt && /^[a-f0-9]{64}$/.test(m.secretHash)
    && crypto.timingSafeEqual(digest, Buffer.from(m.secretHash, 'hex')));
  return member ? { member, tag: hash(member.id + ':' + tag).slice(0, 48) } : null;
}
function publicSettings(dataDir) {
  const v = read(dataDir), host = v.host || {};
  const interfaces = localAddresses();
  const bindAddress = host.bindAddress || interfaces[0] || '127.0.0.1';
  const addresses = [`http://${bindAddress}:${host.port || DEFAULT_PORT}`];
  return { version: VERSION, host: { enabled: !!host.enabled, port: host.port || DEFAULT_PORT, bindAddress, localOnly: bindAddress === '127.0.0.1', interfaces, addresses, members: (host.members || []).map(publicMember) },
    client: v.client ? { address: v.client.address, connected: !!v.client.enabled, keySet: !!v.client.key } : null };
}
// One line a host can paste into chat; the colleague pastes it back into the address field.
function formatInvite(address, secret) { return `AI Hub 号池共享 地址 ${address} 口令 ${secret}`; }
function parseInvite(addressText, keyText) {
  const text = String(addressText || '') + ' ' + String(keyText || '');
  const url = (text.match(/https?:\/\/[^\s，,；;]+/i) || [])[0] || String(addressText || '').trim();
  const typed = String(keyText || '').trim().toLowerCase();
  const key = /^[a-f0-9]{48}$/.test(typed) ? typed : ((text.match(/(?:^|[^a-f0-9])([a-f0-9]{48})(?![a-f0-9])/i) || [])[1] || typed).toLowerCase();
  return { address: url.replace(/\/+$/, ''), key };
}
function localAddresses() { return [...new Set(Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)).map(i => i.address))]; }
function bindAddress(value) {
  if (value === '127.0.0.1' || localAddresses().includes(value)) return value;
  throw new Error('请选择本机当前可用的内网网卡地址');
}
const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const quantity = v => numeric(v) ?? (typeof v === 'string' && /^[\d,.]+\s*[KMBT]?$/i.test(v) && v.length <= 32 ? v : null);
const modelName = v => MODEL_IDS.find(id => id.toLowerCase() === String(v || '').replace(/-auto$/i, '').toLowerCase()) || '';
function bucket(v) { return v ? { pct: numeric(v.pct), used: quantity(v.used), total: quantity(v.total) } : null; }
function usage(entry) {
  if (!entry) return null;
  const credit = entry.credit ? { ...Object.fromEntries(['busyDay', 'idleDay', 'monthly'].map(k => [k, bucket(entry.credit[k])])),
    idleDiscountActive: entry.credit.idleDiscountActive === true, idleDiscountUntil: numeric(entry.credit.idleDiscountUntil),
    idleDiscount: typeof entry.credit.idleDiscount === 'string' && /^[\d.]+\s*折?$/.test(entry.credit.idleDiscount) ? entry.credit.idleDiscount : '',
    idleDiscountIn: typeof entry.credit.idleDiscountIn === 'string' && /^[\d\s:.小时分钟天]+$/.test(entry.credit.idleDiscountIn) ? entry.credit.idleDiscountIn : '' } : null;
  return { at: numeric(entry.at), modelsAt: numeric(entry.modelsAt), creditAt: numeric(entry.creditAt), credit,
    models: (Array.isArray(entry.models) ? entry.models : []).filter(m => modelName(m.name)).map(m => ({ name: modelName(m.name), day: bucket(m.day), hour: bucket(m.hour), min: bucket(m.min) })) };
}
function quotaSnapshot(snapshot, router = {}, now = Date.now()) {
  const accountState = new Map((router.accounts || []).map(a => [a.id, a]));
  // Explicit allowlist: account IDs, notes, login identity, error strings and filesystem paths never leave the host.
  const rows = (snapshot?.rows || []).filter(r => !r.sameAsPersonal && !r.duplicateOf && r.present !== false)
    .map((r, i) => {
      const a = accountState.get(r.id), u = usage(r.usage);
      const loginFailed = a?.coolingReason === 'credential' && a?.coolingUntil > now;
      const paused = !!r.avoid || !!a?.paused;
      return { id: 'shared-' + hash(r.id).slice(0, 12), label: `共享号 ${i + 1}`, personal: false, present: true,
        state: !loginFailed && r.state === 'ready' ? 'ready' : 'login-required', activeSessions: numeric(a?.sessions) || 0,
        avoid: loginFailed ? null : paused ? { source: 'manual', until: numeric(r.avoid?.until), reason: '主机已暂停此账号' }
          : a?.coolingUntil > now ? { source: 'error', until: a.coolingUntil, kind: 'rate-limit' } : null,
        usage: u, credit: u?.credit || null, creditAt: numeric(r.creditAt), usageAt: numeric(r.usageAt),
        creditReading: r.creditReading && ['busyDay', 'idleDay', 'monthly', '今日忙时', '忙时', '闲时', '月度'].includes(r.creditReading.bucket)
          ? { bucket: r.creditReading.bucket, pct: numeric(r.creditReading.pct), remaining: quantity(r.creditReading.remaining), total: quantity(r.creditReading.total) } : null,
        creditReadingAt: numeric(r.creditReadingAt), defaultModel: modelName(r.defaultModel), refresh: { status: 'idle' },
        models: Array.isArray(a?.models) ? [...new Set(a.models.map(modelName).filter(Boolean))] : [], modelsAuthoritative: a?.modelsAuthoritative === true };
    });
  return { ok: true, shared: true, version: VERSION, checkedAt: now, serveEnabled: true, rows, models: MODEL_IDS,
    message: '共享主机最近一次额度读数；所有同事共同消耗，刷新只同步读数' };
}
// Shown to the host in the pool view so they know which Hub version a colleague runs.
function hubVersion() { try { return require('../package.json').version; } catch { return ''; } }
async function fetchSnapshot(client, { timeoutMs = 5000 } = {}) {
  const u = new URL('/pool/v1/snapshot', address(client.address));
  // Use node:http directly: LAN requests must bypass Windows/system proxy configuration.
  const transport = require(u.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise((resolve, reject) => {
    const req = transport.get(u, { headers: { authorization: 'Bearer ' + client.key, accept: 'application/json', 'x-ai-hub-client': 'AI Hub ' + hubVersion() } }, res => {
      let n = 0, chunks = [];
      res.on('data', c => { n += c.length; if (n > 512 * 1024) res.destroy(new Error('共享状态响应过大')); else chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(Object.assign(new Error('共享口令无效或已被主机撤销，请联系主机管理员'), { code: 'REVOKED' }));
        if (res.statusCode !== 200) return reject(new Error(res.statusCode === 503 ? '主机已关闭共享或模型服务未就绪' : '共享主机暂不可用（HTTP ' + res.statusCode + '）'));
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (v.shared !== true || !Array.isArray(v.rows) || !Array.isArray(v.models)) throw new Error(); resolve(v); }
        catch { reject(new Error('该地址未返回有效的号池状态')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('连接共享主机超时，请检查主机在线和内网连通性')), timeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.on('error', e => reject(new Error(e.message?.includes('共享') ? e.message
      : e.code === 'ECONNREFUSED' ? '主机在线但没有开启共享（或 Hub 未运行）' : '无法连接共享主机，请确认主机开机、Hub 在运行，以及主机地址没有变化')));
  });
}
module.exports = { VERSION, DEFAULT_PORT, MODEL_IDS, read, write, address, port, bindAddress, addMember, revoke, authenticate, publicSettings, quotaSnapshot, fetchSnapshot, isPrivateAddress, localAddresses, formatInvite, parseInvite };
