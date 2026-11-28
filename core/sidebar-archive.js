'use strict';

// 侧栏归档（2026-11-28）：不再按「24 小时 / 3 天没动」自动归档。
// - 归档 = 用户亲手点的：records[key] 记下归档时刻；之后这个会话再有来往（latestActivityTime 晚于归档时刻）就自动回到侧栏。
// - 自动归档默认关闭；用户可在一键归档弹窗里勾选「以后按此规则自动归档」，按所选时长和准则自动归。
// - 老用户升级：第一次读取时，把升级前已在归档里的（未置顶、闲置超过原来所选的 1 或 3 天）记成已归档，侧栏不突然冒出一堆旧会话。
// - 运行中、等回复、出错、未读、置顶的条目任何时候都留在侧栏（规则判断在 isItemArchived）。

const fs = require('node:fs');
const path = require('node:path');
const { acquireLockAsync, releaseLockAsync } = require('./file-lock');
const { writeFileAtomic } = require('./atomic-write');
const { latestActivityTime } = require('./session-recency');

const HOUR = 3600000;
const ENTITY_KEY = /^(?:session|meeting):[\w-]{1,128}$/;
const MAX_HOURS = 24 * 365;
const DEFAULT_RULE = Object.freeze({ hours: 24, keepGroups: false, keepFoldered: false });
const emptyState = () => ({ version: 1, migratedAt: 0, auto: { enabled: false, ...DEFAULT_RULE }, records: {} });

function cleanRule(rule = {}) {
  const hours = Math.round(Number(rule.hours));
  if (!Number.isFinite(hours) || hours < 1 || hours > MAX_HOURS) throw new Error('归档时长须在 1 小时到 365 天之间');
  return { hours, keepGroups: rule.keepGroups === true, keepFoldered: rule.keepFoldered === true };
}

function validateState(state) {
  if (!state || state.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)
      || !state.auto || typeof state.auto !== 'object') throw new Error('归档数据格式或版本无效；原文件已保留');
  for (const [key, at] of Object.entries(state.records)) if (!ENTITY_KEY.test(key) || !(Number(at) > 0)) throw new Error('归档数据包含无效条目；原文件已保留');
  state.auto = { enabled: state.auto.enabled === true, ...cleanRule(state.auto) };
  state.migratedAt = Number(state.migratedAt) || 0;
  return state;
}

const entityKey = item => (item && item._isMeeting ? 'meeting:' : 'session:') + (item && (item.id || item.hubId));

// 一个侧栏条目当前是否在归档里。state 是侧栏分类（run/wait/error/unread/…），folder 是它所在目录的 id（未分类为 null）。
// 团队负责人：调用方把成员的状态并进 state/unread、把成员最近活动并进 activity，并以 group=true 标明是团队。
function isItemArchived(item, { state, unread = false, now = Date.now(), archive = emptyState(), folder = null, activity = null, group = null } = {}) {
  if (!item || item.pinned || unread || state === 'run' || state === 'wait' || state === 'error') return false;
  const last = activity ?? latestActivityTime(item);
  const at = Number(archive.records?.[entityKey(item)]) || 0;
  if (at && last <= at) return true;
  const auto = archive.auto;
  return !!(auto?.enabled && matchesRule(item, { now, rule: auto, folder, activity: last, group }));
}

// 一键归档与自动归档共用的「时长 + 准则」。不看运行状态和未读——调用方已排除。group：群聊或团队（默认按 _isMeeting 判断）。
function matchesRule(item, { now = Date.now(), rule = DEFAULT_RULE, folder = null, activity = null, group = null } = {}) {
  activity = activity ?? latestActivityTime(item);
  if (rule.keepGroups && (group ?? !!item._isMeeting)) return false;
  if (rule.keepFoldered && folder) return false;
  return now - activity >= Number(rule.hours) * HOUR;
}

// 升级前的规则（buildSidebarView 的旧逻辑）：未置顶、闲置达到所选天数即在归档。主进程拿不到运行与未读状态，
// 这两类在 isItemArchived 里本来就不会被归档，所以这里只按时间和置顶判断。
function legacyArchivedKeys(items, { now = Date.now(), days = 1 } = {}) {
  const limit = (Number(days) === 3 ? 3 : 1) * 24 * HOUR;
  return items.filter(item => item && !item.pinned && now - latestActivityTime(item) >= limit).map(entityKey).filter(key => ENTITY_KEY.test(key));
}

function createSidebarArchiveStore({ dataDir = require('./data-dir').getHubDataDir(), fsModule = fs, legacyItems = () => [], now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'sidebar-archive.json'), lock = file + '.lock';
  function read() {
    let text;
    try { text = fsModule.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error(`归档数据无法读取：${error.message}`); }
    try { return validateState(JSON.parse(text)); }
    catch (error) { throw new Error(`归档数据无法读取，原文件已保留：${error.message}`); }
  }
  async function mutate(change) {
    fsModule.mkdirSync(dataDir, { recursive: true });
    const handle = await acquireLockAsync(lock);
    if (!handle) throw new Error('归档正在由其他窗口保存或存储不可写，请稍后重试');
    try {
      const state = read();
      const changed = change(state);
      if (changed === false) return state;
      validateState(state);
      writeFileAtomic(fsModule, file, JSON.stringify(state));
      return state;
    } finally { await releaseLockAsync(handle, lock); }
  }
  const keysOf = keys => (Array.isArray(keys) ? keys : []).filter(key => typeof key === 'string' && ENTITY_KEY.test(key));
  return {
    // 第一次读取顺带做老用户迁移；legacyDays 是渲染端存的旧「今天 / 3 天」选择。
    async list({ legacyDays = 1 } = {}) {
      const state = read();
      if (state.migratedAt) return state;
      return mutate(next => {
        if (next.migratedAt) return false;
        const at = now();
        for (const key of legacyArchivedKeys(legacyItems(), { now: at, days: legacyDays })) next.records[key] ||= at;
        next.migratedAt = at;
      });
    },
    archive: keys => mutate(state => { const at = now(); for (const key of keysOf(keys)) state.records[key] = at; }),
    restore: keys => mutate(state => { let hit = false; for (const key of keysOf(keys)) if (state.records[key]) { delete state.records[key]; hit = true; } return hit; }),
    setAuto: (enabled, rule) => mutate(state => { state.auto = { enabled: enabled === true, ...cleanRule(rule || state.auto) }; }),
    prune: exists => mutate(state => {
      let hit = false;
      for (const key of Object.keys(state.records)) if (!exists(key)) { delete state.records[key]; hit = true; }
      return hit;
    }),
  };
}

module.exports = { createSidebarArchiveStore, emptyState, isItemArchived, matchesRule, legacyArchivedKeys, entityKey, cleanRule, DEFAULT_RULE, HOUR };
