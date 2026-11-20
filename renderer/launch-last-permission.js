'use strict';
// 启动中心按 AI 工具分别记住上次选的权限模式（照 launch-last-workspace.js）：只在会话真建成后才记；
// 「恢复默认」清掉当前工具的记录，回到完全放开。记录里的值不在这个工具的白名单里就当没记过。
const modes = require('../core/permission-modes');

const STORAGE_KEY = 'hub.launch.lastPermissionMode.v1';

function readAll(storage) {
  try {
    const record = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch { return {}; }
}

function writeAll(storage, record) {
  try {
    if (Object.keys(record).length) storage?.setItem(STORAGE_KEY, JSON.stringify(record));
    else storage?.removeItem(STORAGE_KEY);
  } catch { /* 存不了就下次用默认 */ }
}

function recall(storage, kind) {
  return modes.normalize(kind, readAll(storage)[modes.baseKind(kind)]) || modes.DEFAULT_MODE;
}

function remember(storage, kind, mode) {
  const value = modes.normalize(kind, mode);
  if (!value) return null;
  const record = readAll(storage);
  if (value === modes.DEFAULT_MODE) delete record[modes.baseKind(kind)];
  else record[modes.baseKind(kind)] = value;
  writeAll(storage, record);
  return value;
}

function forget(storage, kind) {
  const record = readAll(storage);
  delete record[modes.baseKind(kind)];
  writeAll(storage, record);
}

module.exports = { STORAGE_KEY, recall, remember, forget };
