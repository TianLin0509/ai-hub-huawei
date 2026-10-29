'use strict';

// Adds, renames and removes Claude / Codex subscription accounts in the raw
// config (providers.<kind>.subscription_profiles). Pure: the caller reads the
// config for update, saves it, and creates nothing but the empty account folder.
//
// - New ids are random (acct-xxxxxx) and never reused, so an old session that
//   still names a removed account can never land on a different new one.
// - Renaming changes only the label: sessions keep their id and folder.
// - Removing drops the row only. The folder, its login and history stay on
//   disk, and nothing is logged out, so the server-side login stays valid.
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  claude: { folder: '.claude-profiles', name: 'Claude' },
  codex: { folder: '.codex-profiles', name: 'Codex' },
};
const BUILT_IN = new Set(['default', 'second']);
const LABEL_MAX = 40;

function kindOf(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('只支持 Claude 和 Codex 账号');
  return KINDS[kind];
}
function cleanLabel(label) {
  const value = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('请填写账号名称');
  if (value.length > LABEL_MAX) throw new Error(`账号名称最多 ${LABEL_MAX} 个字`);
  return value;
}
function rowsOf(raw, kind) {
  const rows = raw.providers?.[kind]?.subscription_profiles;
  return Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
}
function withRows(raw, kind, rows) {
  return { ...raw, providers: { ...raw.providers, [kind]: { ...raw.providers?.[kind], subscription_profiles: rows } } };
}
function newId(taken, random = () => crypto.randomBytes(3).toString('hex')) {
  for (let i = 0; i < 20; i++) {
    const id = 'acct-' + random();
    if (!taken.has(id)) return id;
  }
  throw new Error('未能生成账号标识，请重试');
}

// `normalized` is the list the Hub actually shows (built-in rows included), used
// to refuse duplicates against rows that are not written in the raw file.
function addAccount(raw, kind, label, { homeDir, normalized = [], now = () => new Date().toISOString(), random, network, loginEnv } = {}) {
  const meta = kindOf(kind);
  const name = cleanLabel(label);
  const rows = rowsOf(raw, kind);
  const all = [...normalized, ...rows];
  if (all.some(r => String(r.label || '').trim() === name)) throw new Error(`已有名为「${name}」的${meta.name}账号`);
  const id = newId(new Set(all.map(r => r.id)), random);
  const profile = { id, label: name, home: path.join(homeDir, meta.folder, id), createdAt: now() };
  // A Codex login opens in its own Chrome profile, so this account's ChatGPT
  // cookies never mix with the main or second account's.
  if (kind === 'codex') profile.browserIdentity = 'codex-' + id;
  // A Claude account may be born on a dedicated exit and with its VPS login environment, so its
  // first sign-in already leaves from the IP it will use every day (2026-10-28).
  if (kind === 'claude' && network) profile.network = { ...network };
  if (kind === 'claude' && loginEnv) profile.loginEnv = loginEnv;
  return { raw: withRows(raw, kind, [...rows, profile]), profile };
}

function renameAccount(raw, kind, id, label, { normalized = [] } = {}) {
  const meta = kindOf(kind);
  const name = cleanLabel(label);
  const shown = normalized.find(r => r.id === id);
  const rows = rowsOf(raw, kind);
  const index = rows.findIndex(r => r.id === id);
  if (index < 0 && !shown) throw new Error(`${meta.name}账号不存在，请刷新账号页`);
  if ([...normalized, ...rows].some(r => r.id !== id && String(r.label || '').trim() === name)) throw new Error(`已有名为「${name}」的${meta.name}账号`);
  const next = rows.slice();
  // A built-in row that was never written to the file is written now, with the
  // folder the Hub already resolves for it, so only its label changes.
  if (index < 0) next.push({ id, label: name, home: shown.home || '' });
  else next[index] = { ...rows[index], label: name };
  return { raw: withRows(raw, kind, next), profile: next.find(r => r.id === id) };
}

// Binds a Claude account to its VPS login environment. The exit itself is not changed here.
function bindLoginEnv(raw, id, loginEnv, { normalized = [] } = {}) {
  if (!/^(?:[abcd]|u[0-9a-f]{8})$/.test(loginEnv || '')) throw new Error('登录环境标识无效');
  const shown = normalized.find(r => r.id === id);
  const rows = rowsOf(raw, 'claude');
  const index = rows.findIndex(r => r.id === id);
  if (index < 0 && !shown) throw new Error('Claude账号不存在，请刷新账号页');
  const next = rows.slice();
  if (index < 0) next.push({ id, label: shown.label, home: shown.home || '', loginEnv });
  else next[index] = { ...rows[index], loginEnv };
  return { raw: withRows(raw, 'claude', next), profile: next.find(r => r.id === id) };
}

function removeAccount(raw, kind, id, { selectedId = 'default', sessionsUsing = 0 } = {}) {
  const meta = kindOf(kind);
  if (BUILT_IN.has(id)) throw new Error('主账号和第二账号是内置账号，只能改名，不能移除');
  if (id === selectedId) throw new Error('这是当前用量账号，请先把用量切到别的账号再移除');
  if (sessionsUsing > 0) throw new Error(`还有 ${sessionsUsing} 个会话属于这个账号；关闭或删除这些会话后再移除`);
  const rows = rowsOf(raw, kind);
  const removed = rows.find(r => r.id === id);
  if (!removed) throw new Error(`${meta.name}账号不存在，请刷新账号页`);
  return { raw: withRows(raw, kind, rows.filter(r => r.id !== id)), profile: removed };
}

// Sessions (open or saved) that still belong to an account.
function countSessionsUsing(sessions, kind, id) {
  const seen = new Set();
  let count = 0;
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object' || seen.has(s.id)) continue;
    seen.add(s.id);
    const owners = kind === 'claude' ? [s.claudeProfile, s.claudeContextProfile] : [s.codexProfile, s.codexContextProfile];
    if (owners.includes(id)) count++;
  }
  return count;
}

module.exports = { KINDS, BUILT_IN, addAccount, renameAccount, removeAccount, bindLoginEnv, countSessionsUsing, cleanLabel };
