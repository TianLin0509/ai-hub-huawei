'use strict';
// 社区统计的匿名安装编号（2026-11-24）：本机第一次用时随机生成 32 位十六进制，存 <数据目录>/community/install-id.json。
// 只是随机数：和硬件、账号、机器名都无关；删掉文件就换一个新编号。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('../atomic-write');

const ID_RE = /^[0-9a-f]{32}$/;

function idFile(dataDir) { return path.join(dataDir, 'community', 'install-id.json'); }

function readInstallId(dataDir) {
  try { const id = String(JSON.parse(fs.readFileSync(idFile(dataDir), 'utf8')).iid || ''); return ID_RE.test(id) ? id : ''; }
  catch { return ''; }
}

// 读不到就生成并存下；存不下（只读目录）也返回这次生成的，本次运行内保持同一个。
function ensureInstallId(dataDir, { randomBytes = crypto.randomBytes } = {}) {
  const existing = readInstallId(dataDir);
  if (existing) return existing;
  const iid = randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(idFile(dataDir)), { recursive: true });
    writeFileAtomic(fs, idFile(dataDir), JSON.stringify({ iid, at: Date.now() }) + '\n');
  } catch { /* 下次启动再存 */ }
  return iid;
}

module.exports = { ensureInstallId, readInstallId, idFile, ID_RE };
