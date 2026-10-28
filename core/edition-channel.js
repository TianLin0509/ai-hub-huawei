'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { scryptSync } = require('node:crypto');

const CHANNEL_FILE = 'edition-channel.json';
const SALT = '7d1f0c9a4be25e83a6f4c10d92b7e5a1';
const BASE = 'https://me.lt-stockpartner.tech/hub-update/';

function channelId(code) {
  const text = String(code || '').trim().toLowerCase();
  if (text.length < 6 || text.length > 64) return '';
  return scryptSync(text, SALT, 16).toString('hex');
}

function channelSources(id) {
  return [{ id: 'aliyun', name: '阿里云', manifest: `${BASE}m-${id}/latest.json`, files: `${BASE}m-${id}/v{version}/` }];
}

// 本机开通过扩展功能：只读，打不开或没有记录都当没开通。
function wasUnlocked(dataDir, { readMeta } = {}) {
  if (!dataDir) return false;
  let entries = [];
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return false; }
  const read = readMeta || ((file, key) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
    finally { db.close(); }
  });
  for (const name of entries) {
    const file = path.join(dataDir, name, 'assistant.sqlite');
    if (!fs.existsSync(file)) continue;
    try { if (read(file, 'featureUnlock')) return true; } catch { /* 读不了的库跳过 */ }
  }
  return false;
}

function readChannel(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, CHANNEL_FILE), 'utf8'));
    return raw && /^[0-9a-f]{32}$/.test(String(raw.id || '')) ? { id: raw.id, at: Number(raw.at) || 0 } : null;
  } catch { return null; }
}

function writeChannel(dataDir, id, now = Date.now()) {
  const file = path.join(dataDir, CHANNEL_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id, at: now }, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function updateConfig(base, dataDir) {
  const channel = readChannel(dataDir);
  if (!channel) return base;
  return { ...(base || {}), sources: channelSources(channel.id), switchEdition: true };
}

async function verify(code, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const id = channelId(code);
  if (!id) return { ok: false, reason: 'format', message: '口令长度不对' };
  const url = channelSources(id)[0].manifest;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, cache: 'no-store' });
    if (res.status === 404) return { ok: false, reason: 'wrong', message: '口令不对' };
    if (!res.ok) return { ok: false, reason: 'network', message: `更新地址暂时连不上（HTTP ${res.status}）` };
    const text = await res.text();
    let manifest = null; try { manifest = JSON.parse(text); } catch { manifest = null; }
    if (!manifest || typeof manifest.version !== 'string') return { ok: false, reason: 'blocked', message: '读到的不是更新清单，可能被公司网络拦截，请先在浏览器里打开一次该地址放行', url };
    return { ok: true, id, version: manifest.version };
  } catch (error) {
    return { ok: false, reason: 'network', message: `更新地址暂时连不上：${error.name === 'AbortError' ? '15 秒没响应' : error.message}` };
  } finally { clearTimeout(timer); }
}

module.exports = { CHANNEL_FILE, channelId, channelSources, wasUnlocked, readChannel, writeChannel, updateConfig, verify };
