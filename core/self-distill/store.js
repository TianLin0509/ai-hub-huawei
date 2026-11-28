'use strict';
// 画像存取（蒸馏自己）：只存本机 <dataDir>/self-distill/<账号哈希>/portrait.json，同目录 audit.jsonl 记操作（不含原话）。
// 写入一律临时文件 + rename。「全部删除」删掉整个账号目录；删除这件事本身记在上一层的 audit.jsonl（只有账号哈希和时间）。
// current.json 记最近一次写画像的账号哈希：桌宠、社区场景这类拿不到 WeLink 账号的地方据此找到本人的画像。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const h16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const APPLY_KEYS = ['assistant', 'avatar', 'pet', 'community', 'ppt'];

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function createStore({ dataDir, now = Date.now } = {}) {
  if (!dataDir) throw new Error('self-distill store 需要 dataDir');
  const root = path.join(dataDir, 'self-distill');
  const dirOf = owner => path.join(root, h16(owner));
  const fileOf = owner => path.join(dirOf(owner), 'portrait.json');
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  function read(owner) {
    if (!owner) return null;
    const p = readJson(fileOf(owner));
    return p && p.v === 1 ? p : null;
  }
  function write(owner, p) {
    if (!owner) throw new Error('还没确认 WeLink 账号');
    const at = now(), next = { ...p, v: 1, createdAt: p.createdAt || at, updatedAt: at };
    atomicWrite(fileOf(owner), JSON.stringify(next, null, 1));
    try { atomicWrite(path.join(root, 'current.json'), JSON.stringify({ dir: h16(owner), at })); } catch { /* 指针写不进不挡主流程 */ }
    return next;
  }
  function audit(owner, row) {
    try {
      const file = owner ? path.join(dirOf(owner), 'audit.jsonl') : path.join(root, 'audit.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ at: now(), ...row }) + '\n', 'utf8');
    } catch { /* 审计写不进不挡主流程 */ }
  }
  function remove(owner) {
    if (!owner) return false;
    const dir = dirOf(owner);
    // 只删本模块自己的账号目录（路径由哈希拼出，不接受外部路径）。
    fs.rmSync(dir, { recursive: true, force: true });
    const cur = readJson(path.join(root, 'current.json'));
    if (cur && cur.dir === h16(owner)) fs.rmSync(path.join(root, 'current.json'), { force: true });
    audit(null, { op: 'delete', owner: h16(owner) });
    return true;
  }
  // 拿不到账号时（桌宠等）：按 current.json 找最近一次的画像。
  function readCurrent() {
    const cur = readJson(path.join(root, 'current.json'));
    if (!cur || !/^[0-9a-f]{16}$/.test(cur.dir || '')) return null;
    const p = readJson(path.join(root, cur.dir, 'portrait.json'));
    return p && p.v === 1 ? p : null;
  }
  return { read, write, remove, audit, readCurrent, dirOf, fileOf, root };
}

module.exports = { createStore, h16, APPLY_KEYS };
