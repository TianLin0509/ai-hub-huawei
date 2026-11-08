'use strict';
// 手动新建的 CodeAgent 会话启动时用哪个模型（2026-10-28 用户选 A）：
//   - 这个号的模型清单来自可靠后台探测，且只有 1 个：
//     不开 /model 菜单，直接用（开菜单会让第一条消息卡住约 1 分钟，多数同事一个号一个模型）；
//   - 有多个模型：选这个号上次在 Hub 里手动切到的模型（还在清单里才算），没有就选菜单第一个；
//   - 清单未知：照旧选菜单第一个（2026-10-25 的做法）。
// 2026-10-28 用户补充「第一次先选默认的，之后记住最新的选择」：多个模型时，CodeAgent 自己记着的默认模型（配置目录 settings.json 的 model，
// 用户在后台 /model、或 Hub 替手动会话选过的都会留在这里）在清单里，就不开菜单直接用；不在清单里（或没写）才开菜单，选上次的或第一个。
// 两边都记着、又不一样时按时间先后：配置文件比 Hub 记的「上次」新（用户后台 /model 过）听 CodeAgent 的，否则（老版本 Hub 切过、事后改回了）开菜单选上次的。
// 「上次选的」按号记在 Hub 数据目录 codeagent-last-model.json：{ "<号 id 或 personal>": { model, at } }。
const fs = require('fs');
const path = require('path');

const FILE = 'codeagent-last-model.json';
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function readAll(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function lastEntry(dataDir, account) {
  const row = dataDir ? readAll(dataDir)[String(account || 'personal')] : null;
  if (!row || typeof row.model !== 'string') return { model: '', at: 0 };
  const at = Date.parse(row.at);
  return { model: row.model, at: Number.isFinite(at) ? at : 0 };
}
function lastModel(dataDir, account) { return lastEntry(dataDir, account).model; }

function rememberModel(dataDir, account, model, now = Date.now()) {
  if (!dataDir || !model) return false;
  const all = readAll(dataDir);
  all[String(account || 'personal')] = { model: String(model), at: new Date(now).toISOString() };
  const file = path.join(dataDir, FILE), tmp = file + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

// 返回 { open: false, reason } 表示不开菜单；{ open: true, model, reason } 表示开菜单选 model（first 为菜单第一个的占位）。
// current：CodeAgent 这次启动会用的模型；currentNewer：它的配置文件比 Hub 记的「上次」改得晚。
function chooseLaunchModel({ models, authoritative, singleModelReliable = false, last, first, current = '', currentNewer = false }) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  if (authoritative && singleModelReliable && list.length === 1) return { open: false, reason: 'single-model', model: list[0] };
  if (authoritative && list.length > 1) {
    const remembered = current && list.find(m => eq(m, current));
    const hit = last && list.find(m => eq(m, last));
    if (remembered && (!hit || eq(remembered, hit) || currentNewer)) return { open: false, reason: 'cli-remembered', model: remembered };
    if (hit) return { open: true, model: hit, reason: 'last-choice' };
    return { open: true, model: first, reason: 'first-of-many' };
  }
  return { open: true, model: first, reason: 'unknown-list' };
}

// 首次会话（2026-11-07 用户：第一次会话要丝滑）：启动时清单未知，等后台 serve 读完清单后按同一口径再判断一次。
// 读到的清单里有 CodeAgent 记着的模型、或只有一个模型，就不用再往终端里敲 /model。
function recheckLaunchChoice({ dataDir, configDir, accountKey = 'personal', first, pool = require('./codeagent-pool') }) {
  const known = pool.accountModels(configDir, undefined, accountKey === 'personal' ? pool.personalModelsFile(dataDir) : null);
  const current = pool.readSettingsModel(configDir);
  const last = lastEntry(dataDir, accountKey);
  let settingsAt = 0;
  try { settingsAt = fs.statSync(path.join(configDir, 'settings.json')).mtimeMs; } catch { settingsAt = 0; }
  return chooseLaunchModel({ models: known.models, authoritative: known.authoritative, singleModelReliable: known.probeReliable,
    current, currentNewer: settingsAt > last.at, last: last.model, first });
}

module.exports = { FILE, lastModel, lastEntry, rememberModel, chooseLaunchModel, recheckLaunchChoice };
