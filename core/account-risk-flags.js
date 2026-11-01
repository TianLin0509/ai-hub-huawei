'use strict';
// 账号风控标记（2026-10-31）：人工记下某个账号被平台风控的时间与观察期。
// 观察期内仍可手动使用，只是不再被推荐、不再被自动换号选中。到期或解除后留作历史。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'account-risk-flags.json';
const DAY_MS = 24 * 3600 * 1000;
const KINDS = new Set(['claude', 'codex', 'gemini']);
const NOTE_MAX = 200;

const keyOf = (kind, profileId) => kind + ':' + (profileId || 'default');
const inForce = (flag, now) => !!flag && (flag.until == null || flag.until > now);

function createAccountRiskStore({ dataDir, now = Date.now, logger = console }) {
  const file = path.join(dataDir, FILE_NAME);

  // 文件损坏时抛错而不是当成「没有标记」，否则一次写入就会把记录冲掉。
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, accounts: {} }; throw error; }
    const data = JSON.parse(text);
    return { version: 1, accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {} };
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function validate(kind, profileId) {
    if (!KINDS.has(kind) || !/^[\w-]{1,64}$/.test(profileId || '')) throw new Error('账号信息不完整，未保存风控标记');
  }

  // 界面只需要：现在是否在观察期，以及最近一次结束的记录。
  function snapshot() {
    const at = now(), result = {};
    for (const [key, row] of Object.entries(read().accounts)) {
      const active = inForce(row.active, at) ? row.active : null;
      const expired = row.active && !active ? { ...row.active, endedAt: row.active.until } : null;
      const last = expired || (row.history || []).at(-1) || null;
      if (active || last) result[key] = { active, last };
    }
    return result;
  }
  function flag({ kind, profileId, note = '', at, days }) {
    validate(kind, profileId);
    const flaggedAt = Number(at) || now();
    if (flaggedAt > now() + 60000) throw new Error('发生时间不能晚于现在');
    if (days !== null && !(Number.isInteger(days) && days > 0)) throw new Error('观察期需要是正整数天，或选择手动解除');
    const until = days === null ? null : flaggedAt + days * DAY_MS;
    if (until !== null && until <= now()) throw new Error('按这个发生时间，观察期已经结束，请延长观察期');
    const data = read(), key = keyOf(kind, profileId), row = data.accounts[key] || { history: [] };
    if (row.active && !inForce(row.active, now())) row.history = [...(row.history || []), { ...row.active, endedAt: row.active.until }];
    row.active = { flaggedAt, until, note: String(note).trim().slice(0, NOTE_MAX) };
    data.accounts[key] = row;
    write(data);
    return snapshot();
  }
  function clear({ kind, profileId }) {
    validate(kind, profileId);
    const data = read(), key = keyOf(kind, profileId), row = data.accounts[key];
    if (row?.active) {
      const endedAt = inForce(row.active, now()) ? now() : row.active.until;
      row.history = [...(row.history || []), { ...row.active, endedAt }];
      row.active = null;
      write(data);
    }
    return snapshot();
  }
  // 自动换号的候选过滤：读不出记录时记日志，按没有标记处理，不让换号流程卡死。
  function isFlagged(kind, profileId) {
    try { return inForce(read().accounts[keyOf(kind, profileId)]?.active, now()); }
    catch (error) { logger.warn?.('[account-risk] 风控记录读取失败：' + error.message); return false; }
  }
  return { file, snapshot, flag, clear, isFlagged };
}

module.exports = { DAY_MS, FILE_NAME, createAccountRiskStore, inForce, keyOf };
