'use strict';
// 启动中心每个 AI 工具的「默认权限模式」（2026-11-26 起：设为默认 + 本次启动覆盖，取代 11-20 的「自动记住上次」）。
// - 记录沿用旧键 hub.launch.lastPermissionMode.v1：旧版自动记下的「上次所选」升级后就是这个工具的默认，用户手上的选择不变。
// - 新用户（没有任何启动记录）默认用这个工具最保守的一档（core/permission-modes.js launchDefault），不默认完全放开。
// - 老用户（升级前用启动中心建过会话）升级时一次性迁移：没记录的工具补写「完全放开」，保持他们原来的行为；
//   同时记下「完全放开的风险已确认过」，不再弹确认框。
// 记录里的值不在这个工具的白名单里就当没记过。
const modes = require('../core/permission-modes');

const STORAGE_KEY = 'hub.launch.lastPermissionMode.v1';
const MIGRATION_KEY = 'hub.launch.permissionDefaults.v2';
const BYPASS_ACK_KEY = 'hub.launch.permissionBypassAck.v1';
// 升级前就有的启动中心记录：任何一项在，就说明这是用过启动中心的老用户。
const LEGACY_SIGNAL_KEYS = Object.freeze([STORAGE_KEY, 'hub.launch.lastWorkspace.v1', 'hub:lastSessionKind']);

function get(storage, key) { try { return storage?.getItem(key) ?? null; } catch { return null; } }
function set(storage, key, value) { try { storage?.setItem(key, value); } catch { /* 存不了就下次再来 */ } }

function readAll(storage) {
  try {
    const record = JSON.parse(get(storage, STORAGE_KEY) || 'null');
    return record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch { return {}; }
}

function writeAll(storage, record) {
  try {
    if (Object.keys(record).length) storage?.setItem(STORAGE_KEY, JSON.stringify(record));
    else storage?.removeItem(STORAGE_KEY);
  } catch { /* 存不了就下次用默认 */ }
}

// 一次性迁移；返回 'legacy' | 'fresh'。只看升级前留下的键，所以必须在本次第一次建会话之前调用（recall 里自动调）。
function migrate(storage) {
  const done = get(storage, MIGRATION_KEY);
  if (done) return done;
  const legacy = LEGACY_SIGNAL_KEYS.some(key => get(storage, key) !== null);
  if (legacy) {
    const record = readAll(storage);
    for (const kind of modes.SWITCHABLE_KINDS) {
      if (!modes.normalize(kind, record[kind])) record[kind] = modes.DEFAULT_MODE;
    }
    writeAll(storage, record);
    set(storage, BYPASS_ACK_KEY, '1');
  }
  set(storage, MIGRATION_KEY, legacy ? 'legacy' : 'fresh');
  return legacy ? 'legacy' : 'fresh';
}

// 这个工具当前的默认档：用户设过的 → 否则产品默认（最保守的一档）。
function recall(storage, kind) {
  migrate(storage);
  return modes.normalize(kind, readAll(storage)[modes.baseKind(kind)]) || modes.launchDefault(kind);
}

// 用户有没有给这个工具单独设过默认（决定「恢复默认」按钮要不要出现）。
function hasCustomDefault(storage, kind) {
  migrate(storage);
  const value = modes.normalize(kind, readAll(storage)[modes.baseKind(kind)]);
  return !!value && value !== modes.launchDefault(kind);
}

// 「设为默认」：只认白名单值；等于产品默认时不留记录（之后产品默认怎么变都跟着走）。
function setDefault(storage, kind, mode) {
  migrate(storage);
  const value = modes.normalize(kind, mode);
  if (!value) return null;
  const record = readAll(storage);
  if (value === modes.launchDefault(kind)) delete record[modes.baseKind(kind)];
  else record[modes.baseKind(kind)] = value;
  writeAll(storage, record);
  return value;
}

// 「恢复默认」：清掉当前工具的记录，回到产品默认（最保守的一档）。
function forget(storage, kind) {
  migrate(storage);
  const record = readAll(storage);
  delete record[modes.baseKind(kind)];
  writeAll(storage, record);
}

function bypassAcknowledged(storage) { return get(storage, BYPASS_ACK_KEY) === '1'; }
function acknowledgeBypass(storage) { set(storage, BYPASS_ACK_KEY, '1'); }

module.exports = { STORAGE_KEY, MIGRATION_KEY, BYPASS_ACK_KEY, LEGACY_SIGNAL_KEYS, migrate, recall, hasCustomDefault, setDefault, forget,
  bypassAcknowledged, acknowledgeBypass };
