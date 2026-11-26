'use strict';
// 扩展功能的本机记录（2026-10-28 起；统一包时代只读本机文件、不联网）：
const fs = require('node:fs');
const path = require('node:path');
const { scryptSync } = require('node:crypto');

const CHANNEL_FILE = 'edition-channel.json';
const SALT = '7d1f0c9a4be25e83a6f4c10d92b7e5a1';

function channelId(code) {
  const text = String(code || '').trim().toLowerCase();
  if (text.length < 6 || text.length > 64) return '';
  return scryptSync(text, SALT, 16).toString('hex');
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

module.exports = { CHANNEL_FILE, channelId, wasUnlocked, readChannel, writeChannel };
