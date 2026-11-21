'use strict';
// 公司模型目录：反代能用的模型跟 CodeAgent 自己的模型目录保持一致（2026-11-20 同事反馈：CodeAgent 里能选 GLM-5.3，
// 经反代的 Claude Code / Codex 只能选写死的 GLM-5.2）。
//
// 来源：CodeAgent 用的同一个目录接口 GET <身份服务域>/codeAgentPro/chat/modles（接口名就是这么拼的），按账号返回该号能用的模型。
// 黄区真机实测（2026-11-20，个人号 + 号池 4 个号）：
// - 每项有 modelId、name、context / input / output、modalities；「…-Auto」项自己不能直接调用（上游回 404「Route missed for model」），
//   它的 routModels 里 modelLevel=large 的那个才是 CodeAgent 实际发给上游的主模型（GLM-5.2-WX-Auto → GLM-5.2-WX）；small 是它自动分流用的小模型。
// - 目录里出现、但从没写进代码的模型（Qwen3.6-27B-CodeAgent-VL）按目录给的 id 走签名链路，直接 200，说明签名不挑模型。
// 所以反代给客户端看的模型 = 各账号目录的并集，每项 id 用「实际发给上游的模型名」，显示名用 CodeAgent 菜单里的名字。
//
// 这个文件同时给反代（server.mjs，ESM）和 Hub 主进程（company-model-proxy.js）用，所以写成 CommonJS、不依赖 Electron。

const fs = require('node:fs');
const path = require('node:path');

const CATALOG_PATH = '/codeAgentPro/chat/modles';
const CACHE_FILE = 'model-catalog.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// 目录拉不到、也没有缓存时（新装、断网）用的兜底：2026-11-06 起一直在用、真机验证过的两个模型。
const BUILTIN = Object.freeze([
  Object.freeze({ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX', menuId: 'GLM-5.2-WX-Auto', input: 169984, output: 32768 }),
  Object.freeze({ id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', menuId: 'deepseek-v4.1-flash-1017', input: 344064, output: 65536 }),
]);
// 按模型维护的能力表。目录里没有「是否支持思考」这一项，只能按家族定：
// GLM-5.2-WX、deepseek-v4.1-flash-1017 的 thinking + reasoning_effort=high 已在黄区实测（11-06）；同家族的新版本沿用同一协议。
// 其他家族（Qwen 等）不发思考参数，避免上游因为不认识这两个字段报错——思考关掉，回答照常。
const FAMILIES = Object.freeze([
  { family: 'glm', test: /glm/i, thinking: true },
  { family: 'deepseek', test: /deepseek|(^|[^a-z])ds([^a-z]|$)/i, thinking: true },
  { family: 'qwen', test: /qwen/i, thinking: false },
  { family: 'kimi', test: /kimi/i, thinking: false },
  { family: 'minimax', test: /minimax/i, thinking: false },
]);
const text = v => (typeof v === 'string' ? v.trim() : '');
const num = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
function familyOf(name) { const hit = FAMILIES.find(f => f.test.test(String(name || ''))); return hit ? hit.family : ''; }
// 5.3、5-3、v4.1 都认；没有版本号返回 ''。
function versionOf(name) {
  const m = /(?:^|[^0-9])(\d+)[.-](\d+)(?=$|[^0-9])/.exec(String(name || '').replace(/^.*?(glm|deepseek|qwen|kimi|minimax)[-_ ]?v?/i, ' '));
  return m ? `${Number(m[1])}.${Number(m[2])}` : '';
}
const cmpVersion = (a, b) => { const [a1, a2] = a.split('.').map(Number), [b1, b2] = b.split('.').map(Number); return a1 - b1 || a2 - b2; };
function capabilities(id) {
  const family = familyOf(id), hit = FAMILIES.find(f => f.family === family);
  return { family, thinking: hit ? hit.thinking : false };
}
// 菜单名去掉 -Auto 和括号里的线路名，当显示名：GLM-5.2-WX-Auto → GLM-5.2-WX；GLM-5.3-Auto(Volcano-MaaS) → GLM-5.3（Volcano-MaaS）。
function labelOf(menuName) {
  const raw = text(menuName); const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw);
  const base = (m ? m[1] : raw).replace(/-auto$/i, '');
  return m && m[2] ? `${base}（${m[2]}）` : base;
}

/** 目录接口的原始回答 → [{ id, label, menuId, input, output, family, thinking }]，按目录顺序、id 去重。 */
function parseCatalog(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : null;
  if (!list) throw Object.assign(new Error('CATALOG_SHAPE_INVALID'), { code: 'CATALOG_SHAPE_INVALID' });
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const menuId = text(entry.modelId);
    if (!menuId || /^\d+$/.test(menuId)) continue;
    const children = Array.isArray(entry.routModels) ? entry.routModels.filter(c => c && SAFE_ID.test(text(c.modelId))) : [];
    const main = children.find(c => text(c.modelLevel).toLowerCase() === 'large') || children[0] || null;
    // -Auto 项没有 routModels：它本身上游调不了，不列。
    if (!main && /-auto(\(|$)/i.test(menuId)) continue;
    const id = main ? text(main.modelId) : menuId;
    if (!SAFE_ID.test(id) || out.some(m => m.id.toLowerCase() === id.toLowerCase())) continue;
    const src = main || entry;
    let input = num(src.input) || num(entry.input), output = num(src.output) || num(entry.output);
    let textOnly = true;
    try { const mod = typeof src.modalities === 'string' ? JSON.parse(src.modalities) : src.modalities; textOnly = !mod || !Array.isArray(mod.input) || mod.input.every(x => x === 'text'); } catch { textOnly = true; }
    // 目录的总窗口是显示元数据；input/output 继续供原有请求路径使用。
    const contextWindow = num(src.context) || num(entry.context);
    out.push({ id, label: labelOf(text(entry.name) || menuId), menuId, input, output, contextWindow, textOnly, ...capabilities(id) });
  }
  return out;
}

// ---------------------------------------------------------------- 缓存文件（反代写、Hub 读）
// <数据目录>/company-model-proxy/model-catalog.json：{ schema, at, accounts: { <账号 id>: { at, models: [...] } } }
// 账号 id 是号池的内部编号（或 personal），不含工号、名字。
function cacheFile(dataDir) { return path.join(dataDir, 'company-model-proxy', CACHE_FILE); }
function readCache(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
    if (!raw || raw.schema !== 1 || !raw.accounts || typeof raw.accounts !== 'object') return null;
    return raw;
  } catch { return null; }
}
function writeCache(dataDir, cache) {
  const file = cacheFile(dataDir); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf8');
  try { fs.renameSync(tmp, file); } catch (error) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw error; }
}
// 目录里的菜单名就是上游名（如 deepseek-v4.1-flash-1017）时，沿用以前界面上的好读名字（DeepSeek V4.1 Flash）。
function friendlyLabel(m) {
  const known = BUILTIN.find(b => b.id === m.id);
  return known && (!m.label || m.label === m.id) ? known.label : (m.label || m.id);
}
/** 各账号目录的并集（个人号在前）；一个都没有时用兜底。 */
function unionModels(cache) {
  const out = [];
  const ids = cache && cache.accounts ? Object.keys(cache.accounts).sort((a, b) => (a === 'personal' ? -1 : b === 'personal' ? 1 : 0)) : [];
  for (const id of ids) for (const m of (cache.accounts[id] && cache.accounts[id].models) || []) {
    if (m && SAFE_ID.test(m.id) && !out.some(x => x.id.toLowerCase() === m.id.toLowerCase())) out.push({ ...m, label: friendlyLabel(m), ...capabilities(m.id) });
  }
  return out.length ? out : BUILTIN.map(m => ({ ...m, textOnly: true, ...capabilities(m.id) }));
}
function modelsFor(dataDir) { return unionModels(readCache(dataDir)); }

// ---------------------------------------------------------------- 客户端给的名字 → 上游模型
// 顺序：精确 id → 菜单名 / 显示名 → 同家族同版本 → 同家族（只往新版本换，且要求的版本比目录里最新的还新时报错）→ 默认模型。
// 不认识的名字（如 Claude Code 后台用的 claude-haiku-*）落到默认模型，和以前一样。
// 以前任何带 glm 的名字都落到 GLM-5.2-WX：用户要 5.3 也悄悄给 5.2。现在要的版本没有就明说（error.code = MODEL_NOT_IN_CATALOG）。
function resolveModel(name, models, defaultId) {
  const want = text(name), lower = want.toLowerCase();
  const list = Array.isArray(models) && models.length ? models : unionModels(null);
  const fallback = (defaultId && list.find(m => m.id === defaultId)) || defaultModel(list);
  if (!want) return { id: fallback.id, how: 'default' };
  const exact = list.find(m => m.id.toLowerCase() === lower);
  if (exact) return { id: exact.id, how: 'exact' };
  const strip = v => String(v || '').toLowerCase().replace(/\s*[(（].*$/, '').replace(/-auto$/, '');
  const byMenu = list.find(m => [m.menuId, m.label].some(v => v && (String(v).toLowerCase() === lower || strip(v) === strip(want))));
  if (byMenu) return { id: byMenu.id, how: 'menu' };
  const family = familyOf(want);
  if (!family) return { id: fallback.id, how: 'default' };
  const same = list.filter(m => familyOf(m.id) === family || familyOf(m.menuId) === family);
  const version = versionOf(want);
  if (!same.length) {
    const error = new Error(`公司模型里没有 ${want}（当前可用：${list.map(m => m.id).join('、')}）`);
    throw Object.assign(error, { code: 'MODEL_NOT_IN_CATALOG', status: 422 });
  }
  if (!version) return { id: same[0].id, how: 'family' };
  const withVersion = same.map(m => ({ m, v: versionOf(m.id) || versionOf(m.menuId) })).filter(x => x.v);
  if (!withVersion.length) return { id: same[0].id, how: 'family' }; // 目录里这一家都不带版本号：认不出新旧，用这一家
  // 同版本有几个变体（flash / pro…）时，挑和要的名字共用词最多的那个，不默认第一个。
  const words = v => new Set(String(v || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1 && !familyOf(w)));
  const wanted = words(want);
  const score = m => [...words(m.id + ' ' + (m.menuId || ''))].filter(w => wanted.has(w)).length;
  const best = xs => xs.reduce((a, b) => (score(b.m) > score(a.m) ? b : a));
  const sameVersion = withVersion.filter(x => x.v === version);
  if (sameVersion.length) return { id: best(sameVersion).m.id, how: 'version' };
  const newer = withVersion.filter(x => cmpVersion(x.v, version) > 0).sort((a, b) => cmpVersion(a.v, b.v));
  if (newer.length) { const next = newer.filter(x => x.v === newer[0].v); return { id: best(next).m.id, how: 'retired-upgrade' }; }
  const error = new Error(`公司模型里没有 ${want}（当前可用：${list.map(m => m.id).join('、')}）`);
  throw Object.assign(error, { code: 'MODEL_NOT_IN_CATALOG', status: 422 });
}
// 默认模型（不认识的名字、Claude Code 后台小请求都落到它）：目录里有 GLM-5.2-WX 就一直是它（11-06 起验证过、以前的默认），
// 不因为目录顺序变了就悄悄换；没有就取版本最高的 GLM，再没有取目录第一个。
function defaultModel(models) {
  const list = Array.isArray(models) && models.length ? models : unionModels(null);
  const keep = list.find(m => m.id === BUILTIN[0].id);
  if (keep) return keep;
  const glm = list.filter(m => familyOf(m.id) === 'glm' || familyOf(m.menuId) === 'glm')
    .map(m => ({ m, v: versionOf(m.id) || versionOf(m.menuId) || '0.0' })).sort((a, b) => cmpVersion(b.v, a.v));
  return glm.length ? glm[0].m : list[0];
}

module.exports = { CATALOG_PATH, CACHE_FILE, BUILTIN, SAFE_ID, parseCatalog, capabilities, familyOf, versionOf, labelOf,
  cacheFile, readCache, writeCache, unionModels, modelsFor, resolveModel, defaultModel };
