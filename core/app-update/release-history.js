'use strict';
// 更新日志数据：每个正式发布的版本写了什么。放在程序里一起发，离线也能看，跨好几个版本升级时也能把中间的改动都列出来。
// 文件由发版脚本（scripts/member-release.js）每次追加一条；公开版生成时（tools/public-edition/make-public.js）换成公开说明。
const fs = require('fs');
const path = require('path');
const { compareVersions } = require('./manifest');

const FILE = path.join(__dirname, 'release-history.json');
const MAX_ENTRIES = 60;

function validVersion(value) { return /^\d+\.\d+\.\d+$/.test(String(value || '')); }

function normalizeEntry(raw) {
  if (!raw || !validVersion(raw.version)) return null;
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(n => String(n || '').trim()).filter(Boolean);
  if (!notes.length) return null;
  return { version: raw.version, date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? raw.date : '', notes };
}

// 读不到、写坏了都只当「没有日志」，更新日志不能影响程序启动。
function loadHistory({ file = FILE, fsModule = fs } = {}) {
  let parsed;
  try { parsed = JSON.parse(fsModule.readFileSync(file, 'utf8')); } catch (_) { return []; }
  const list = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  return list.map(normalizeEntry).filter(Boolean).sort((a, b) => compareVersions(b.version, a.version));
}

// 这次启动相比上次看过的版本多了哪些改动。没有「上次看过的版本」时（新装）不算有更新。
function entriesSince(entries, lastSeen, current) {
  if (!validVersion(lastSeen) || !validVersion(current)) return [];
  if (compareVersions(lastSeen, current) >= 0) return [];
  return entries.filter(e => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0);
}

// 发版脚本用：新版本放最前；同版本号覆盖（重试发版不留两条）。
function appendRelease(history, { version, date, notes, publicNotes }) {
  const entry = { version, date, notes: notes.filter(Boolean) };
  if (Array.isArray(publicNotes) && publicNotes.length) entry.publicNotes = publicNotes.filter(Boolean);
  const entries = [entry, ...((history && history.entries) || []).filter(e => e.version !== version)]
    .sort((a, b) => compareVersions(b.version, a.version)).slice(0, MAX_ENTRIES);
  return { schema: 1, entries };
}

// 公开版：有公开说明的用公开说明；没有的按泄露规则滤掉不能公开的行，滤空了整条不留。
function toPublicHistory(history, isAllowed) {
  const entries = [];
  for (const raw of (history && history.entries) || []) {
    const notes = Array.isArray(raw.publicNotes) ? raw.publicNotes : (raw.notes || []).filter(isAllowed);
    if (notes.length) entries.push({ version: raw.version, date: raw.date, notes });
  }
  return { schema: 1, entries };
}

module.exports = { FILE, MAX_ENTRIES, loadHistory, entriesSince, appendRelease, toPublicHistory };
