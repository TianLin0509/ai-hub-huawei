'use strict';

// API 网关（部门 API key 用户，2026-11-19 定方案 A）：OpenAI 兼容网关的地址、Key 与模型表。
// 会话仍走本机反代（core/company-proxy/server.mjs），只是反代把这类会话转给网关，不经 CodeAgent 账号。
// Key 只以 Electron safeStorage（Windows 下即 DPAPI，绑定当前 Windows 用户）密文落盘；明文只在主进程内存里，
// 启动反代时经环境变量交给反代进程（main/company-proxy-service.js）。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'http://models.ascend.huawei.com/v1';
// 11-19 黄区实测最快、会调用工具；网关上没有它时退到列表第一个。
const PREFERRED_MODEL = 'deepseek-v4.1-flash';
const PROBE_TIMEOUT_MS = 10_000;
// 模型说明不再写死（2026-11-20）：能力以一键体检结果为准（core/api-gateway-healthcheck.js），
// 上下文取网关公开目录的真实值（core/api-gateway-catalog.js），报错口径见 core/api-gateway-errors.js。
const catalogStore = () => require('./api-gateway-catalog');
const healthStore = () => require('./api-gateway-healthcheck');
const errors = () => require('./api-gateway-errors');

function dir(dataDir) { return path.join(dataDir, 'api-gateway'); }
function file(dataDir) { return path.join(dir(dataDir), 'gateway.json'); }

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return DEFAULT_BASE_URL;
  let url;
  try { url = new URL(text); } catch { throw new Error('网关地址必须是完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) {
    throw new Error('网关地址必须是 http:// 或 https:// 地址，且不能带账号、密码或参数');
  }
  return text;
}
function normalizeKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('请粘贴 API key');
  if (key.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('API key 格式不对：不能包含空格或换行，请重新复制');
  return key;
}
function cleanModels(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)))];
}
function defaultModelOf(models) { return models.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : (models[0] || PREFERRED_MODEL); }

function readRaw(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(file(dataDir), 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeRaw(dataDir, value) {
  fs.mkdirSync(dir(dataDir), { recursive: true });
  const target = file(dataDir), tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

// 给界面和启动用的视图：不含 Key。
function read(dataDir) {
  const raw = readRaw(dataDir);
  const models = cleanModels(raw.models);
  return {
    baseURL: raw.baseURL ? normalizeBaseUrlSafe(raw.baseURL) : DEFAULT_BASE_URL,
    keySet: typeof raw.encryptedKey === 'string' && raw.encryptedKey.length > 0,
    models,
    // 默认模型可以是手填测通的（R45）；都不在时退回推荐模型。
    model: models.includes(raw.model) || (cleanModels(raw.customModels).includes(raw.model) && models.length > 0) ? raw.model : defaultModelOf(models),
    checkedAt: Number(raw.checkedAt) || 0,
    unlimited: raw.unlimited === true,
    // 网关目录推出来的分组（free / max / default / vip），保存 key 与一键体检时更新。
    group: typeof raw.group === 'string' ? raw.group : '',
    groupExact: raw.groupExact === true,
    // 用户「对这个模型关闭思考」的模型（本机代理给它们的请求注入 chat_template_kwargs.enable_thinking=false）。
    noThinking: cleanModels(raw.noThinking),
    // 用户手填、连通检测通过的模型（key 的模型表里没列、网关实际能用，例如带日期后缀的版本）。
    customModels: cleanModels(raw.customModels).filter(id => !models.includes(id)),
  };
}
function normalizeBaseUrlSafe(value) { try { return normalizeBaseUrl(value); } catch { return DEFAULT_BASE_URL; } }
function configured(dataDir) { return read(dataDir).keySet; }

function decryptKey(dataDir, safeStorage) {
  const raw = readRaw(dataDir);
  if (!raw.encryptedKey || !safeStorage) return '';
  try { return safeStorage.decryptString(Buffer.from(raw.encryptedKey, 'base64')); } catch { return ''; }
}

// 模型名：网关表里有就原样用；没有（例如别处带来的公司模型名、Claude Code 后台用的 haiku 名）落到默认模型。
function resolveModel(dataDir, model) {
  const view = read(dataDir);
  const value = String(model || '').trim();
  if (value && (view.models.includes(value) || view.customModels.includes(value) || !view.models.length)) return value;
  return view.model;
}
// 本机代理认的模型：key 的模型表 + 手填检测通过的。
function allModels(dataDir) { const view = read(dataDir); return [...view.models, ...view.customModels]; }

// 手填模型（2026-11-24）：先用一键体检同一套单模型试跑（一句话、带一个工具）测通，通过才记下。
// 不通时返回网关口径的一句人话（core/api-gateway-errors.js），不记。
const CUSTOM_LIMIT = 20;
// 首字等待不低于 150 秒：网关排队时首字可到十几秒以上（实测 0.9–11.3 秒，排队 12–31 秒），等短了会把能用的模型误判成不通。
// 只验连通、不验工具能力（同一模型调不调工具一次测不准）。
async function addCustomModel(dataDir, model, { safeStorage, fetchImpl = globalThis.fetch, firstTimeoutMs = 150_000, totalTimeoutMs = 180_000 } = {}) {
  const id = String(model || '').trim();
  if (!cleanModels([id]).length) return { ok: false, code: 'bad_name', actions: [], message: '模型名格式不对：只能用字母、数字和 . _ : / -，不能有空格。' };
  const view = read(dataDir);
  if (view.models.includes(id) || view.customModels.includes(id)) return { ok: true, model: id, already: true };
  const key = decryptKey(dataDir, safeStorage);
  if (!key) return { ok: false, code: 'no_key', actions: ['rekey'], message: '还没保存部门 API key：先到设置里粘贴 key 并保存。' };
  const r = await healthStore().probeModel({ baseURL: view.baseURL, apiKey: key, model: id, fetchImpl, firstTimeoutMs, totalTimeoutMs,
    ctx: { usable: view.models, group: view.group }, noThinking: view.noThinking.includes(id) });
  if (!r.ok) return { ok: false, code: r.error?.code || 'unknown', actions: r.error?.actions || [], message: r.error?.message || '这个模型没有连通。' };
  const raw = readRaw(dataDir);
  writeRaw(dataDir, { ...raw, customModels: cleanModels([...cleanModels(raw.customModels).filter(x => x !== id), id]).slice(-CUSTOM_LIMIT) });
  return { ok: true, model: id, firstMs: r.firstMs };
}
function removeCustomModel(dataDir, model) {
  const raw = readRaw(dataDir);
  writeRaw(dataDir, { ...raw, customModels: cleanModels(raw.customModels).filter(x => x !== String(model || '')) });
  return read(dataDir);
}
// 下拉框说明：能力以一键体检结果为准（首字、工具、思考、上下文），没体检过只写目录里的上下文。
function modelChoices(dataDir) {
  const view = read(dataDir);
  const health = healthStore().read(dataDir)?.results || {};
  const catalog = catalogStore().cached(dataDir, view.baseURL);
  return view.models.map(id => {
    const r = health[id];
    const known = catalog?.models?.find(m => m.id === id);
    const ctx = known?.context || 0;
    const note = r ? healthStore().note({ ...r, context: r.context || ctx }) : ctx ? `上下文 ${Math.round(ctx / 1000)}K · 还没体检` : '';
    return { id, label: id, note, ...(r ? { ok: r.ok, firstMs: r.firstMs, tools: r.tools, thinking: r.thinking } : {}) };
  });
}
// 给本机代理和会话配置用：各模型的上下文上限（目录真实值，取不到用保守默认）与最近体检的首字时间。
function contextOf(dataDir, id) {
  const catalog = catalogStore().cached(dataDir, read(dataDir).baseURL);
  return catalog ? catalogStore().contextOf(catalog, id) : catalogStore().DEFAULT_CONTEXT;
}
function firstTokenMs(dataDir) {
  const results = healthStore().read(dataDir)?.results || {};
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r?.ok && Number(r.firstMs) > 0).map(([id, r]) => [id, Number(r.firstMs)]));
}
// 对话模型过滤：目录里标成生图 / 视频 / 语音的去掉；目录拿不到时只按名字判断。
function chatOnly(ids, catalog) {
  const byId = new Map((catalog?.models || []).map(m => [m.id, m]));
  return ids.filter(id => (byId.has(id) ? byId.get(id).chat : catalogStore().isChatModel({ id, endpoints: [], tags: [] })));
}

// 网关错误 → 一句人话 + 修复按钮（口径在 core/api-gateway-errors.js，本机代理共用）。
function explainHttp(status, body = '', ctx = {}) {
  const e = errors().classify({ status, body, ...ctx });
  return { code: e.code, message: e.message, title: e.title, actions: e.actions, detail: e.detail };
}

// 超时覆盖到读完正文：网关先回响应头、正文卡住时，「正在验证」也会在 timeoutMs 内结束（11-19 换模型审查发现）。
async function fetchText(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } finally { clearTimeout(timer); }
}

// 验证地址与 Key：请求一次模型列表（11-19 实测约 0.1 秒）。不发对话、不耗额度。
async function probe({ baseURL, apiKey, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseURL);
  let response;
  try {
    response = await fetchText(fetchImpl, base + '/models', { headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' } }, timeoutMs);
  } catch (error) {
    // 超时与连接被拒分开说：被拒是立刻失败，不能写成「N 秒内没有响应」。
    const timedOut = error?.name === 'AbortError';
    return { ok: false, code: 'unreachable', title: '连不上网关', actions: ['retry', 'tutorial'], detail: '', message: `连不上网关：${timedOut ? `${Math.round(timeoutMs / 1000)} 秒内没有响应` : '连接被拒绝或找不到地址'}。常见原因是电脑不在公司内网（例如在家没连 VPN），或网关地址不对。连上内网后点「重试」。` };
  }
  const { text } = response;
  if (!response.ok) return { ok: false, ...explainHttp(response.status, text) };
  let models = [];
  try { models = cleanModels((JSON.parse(text)?.data || []).map(m => m?.id)); } catch { models = []; }
  if (!models.length) return { ok: false, code: 'no_models', title: '没有可用模型', actions: ['group-help', 'rekey'], detail: '', message: '网关连上了，但没有返回任何可用模型。请联系网关管理员确认这个 key 的模型权限。' };
  return { ok: true, models };
}

// 用量（New API 的 /api/usage/token/，11-19 实测可用）。拿不到不算错，界面显示「暂时读不到」。
async function usage({ baseURL, apiKey, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const origin = new URL(normalizeBaseUrl(baseURL)).origin;
  try {
    const response = await fetchText(fetchImpl, origin + '/api/usage/token/', { headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' } }, timeoutMs);
    if (!response.ok) return { ok: false, ...explainHttp(response.status, response.text) };
    const data = JSON.parse(response.text)?.data || {};
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    return { ok: true, used: num(data.total_used), granted: num(data.total_granted), available: num(data.total_available),
      unlimited: data.unlimited_quota === true, expiresAt: num(data.expires_at) || 0 };
  } catch { return { ok: false, code: 'unreachable', message: '暂时读不到用量（网关没响应）。' }; }
}

// 保存：先验证，通过才加密落盘（「保存并继续」一步完成）。apiKey 为空时沿用已存的 key（只改地址或默认模型）。
async function save(dataDir, { baseURL, apiKey, model } = {}, { safeStorage, fetchImpl = globalThis.fetch } = {}) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable?.()) throw new Error('系统密钥加密不可用，无法保存 API key');
  const base = normalizeBaseUrl(baseURL);
  const key = apiKey ? normalizeKey(apiKey) : decryptKey(dataDir, safeStorage);
  if (!key) throw new Error('请粘贴 API key');
  const result = await probe({ baseURL: base, apiKey: key, fetchImpl });
  if (!result.ok) return result;
  // 同时读一次网关公开目录：去掉生图 / 语音等非对话模型、推出 key 所在分组。目录拿不到不影响保存。
  const { catalog } = await catalogStore().refresh(dataDir, { baseURL: base, fetchImpl });
  const raw = readRaw(dataDir);
  const next = { ...raw, baseURL: base, ...modelFields(result.models, catalog, raw, model), checkedAt: Date.now() };
  if (apiKey) next.encryptedKey = safeStorage.encryptString(key).toString('base64');
  writeRaw(dataDir, next);
  return { ok: true, ...read(dataDir), choices: modelChoices(dataDir), catalog: catalogSummary(dataDir) };
}
// key 能用的模型（/v1/models）+ 目录 → 存盘字段：对话模型表、默认模型、分组。对话模型一个都没有时保留全部，免得表变空。
function modelFields(keyModels, catalog, raw, wanted) {
  const chat = chatOnly(keyModels, catalog);
  const models = chat.length ? chat : keyModels;
  const custom = cleanModels(raw.customModels);
  const chosen = models.includes(wanted) || custom.includes(wanted) ? wanted : (models.includes(raw.model) || custom.includes(raw.model) ? raw.model : defaultModelOf(models));
  const inferred = catalog ? catalogStore().inferGroup(catalog, keyModels) : { group: raw.group || '', exact: raw.groupExact === true };
  return { models, keyModels, model: chosen, group: inferred.group || '', groupExact: !!inferred.exact };
}
const keyModelsOf = raw => (cleanModels(raw.keyModels).length ? cleanModels(raw.keyModels) : cleanModels(raw.models));
// 界面「分组说明」用：分组、各分组白话、key 看不到的对话模型开给哪些分组、被排除的非对话模型。
function catalogSummary(dataDir) {
  const catalog = catalogStore().cached(dataDir, read(dataDir).baseURL);
  if (!catalog) return null;
  return { ...catalogStore().summarize(catalog, keyModelsOf(readRaw(dataDir))), at: catalog.at || 0 };
}
// 打开设置时：只刷新公开目录（不用 key、不耗额度）；拿不到保留上一版。
async function refreshCatalog(dataDir, { fetchImpl } = {}) {
  const view = read(dataDir);
  const r = await catalogStore().refresh(dataDir, { baseURL: view.baseURL, fetchImpl });
  if (r.ok && view.keySet) {
    const raw = readRaw(dataDir);
    const keyModels = keyModelsOf(raw);
    if (keyModels.length) writeRaw(dataDir, { ...raw, ...modelFields(keyModels, r.catalog, raw, raw.model) });
  }
  return { ok: r.ok, stale: r.stale, code: r.code || '', catalog: catalogSummary(dataDir) };
}

// 一键体检：刷新目录 → 用 key 读模型表 → 逐个对话模型流式试跑一句 → 存能力表。
// 模型表拉取失败不覆盖旧表；单个模型失败只记在它那一行。
async function healthcheck(dataDir, { safeStorage, fetchImpl = globalThis.fetch, onProgress, concurrency, firstTimeoutMs, totalTimeoutMs } = {}) {
  const view = read(dataDir);
  const key = decryptKey(dataDir, safeStorage);
  if (!key) return { ok: false, code: 'no_key', title: '还没填 key', actions: ['rekey'], detail: '', message: '还没保存 API key：先粘贴 key 并保存，保存后会自动体检一次。' };
  const started = Date.now();
  const { catalog } = await catalogStore().refresh(dataDir, { baseURL: view.baseURL, fetchImpl });
  const listed = await probe({ baseURL: view.baseURL, apiKey: key, fetchImpl });
  if (!listed.ok) return listed;
  const raw = readRaw(dataDir);
  const fields = modelFields(listed.models, catalog, raw, raw.model);
  writeRaw(dataDir, { ...raw, ...fields, checkedAt: Date.now() });
  const results = await healthStore().run({ baseURL: view.baseURL, apiKey: key, models: fields.models, catalog, group: fields.group,
    fetchImpl, onProgress, concurrency, firstTimeoutMs, totalTimeoutMs, noThinking: read(dataDir).noThinking });
  const record = { schema: 1, at: Date.now(), ms: Date.now() - started, group: fields.group, results: Object.fromEntries(results.map(r => [r.id, r])) };
  try { healthStore().write(dataDir, record); } catch { /* 写不进缓存时这次结果照样返回 */ }
  return { ok: true, health: healthView(dataDir) || { at: record.at, ms: record.ms, group: record.group, rows: results }, ...read(dataDir),
    choices: modelChoices(dataDir), catalog: catalogSummary(dataDir) };
}
// 能力表：按当前模型表排，没体检过的模型标 pending。
function healthView(dataDir) {
  const h = healthStore().read(dataDir);
  if (!h) return null;
  const rows = read(dataDir).models.map(id => ({ ...(h.results[id] || { id, pending: true }), context: h.results[id]?.context || contextOf(dataDir, id) }));
  return { at: h.at, ms: h.ms, group: h.group, rows };
}
// 对某个模型关闭 / 恢复思考（按模型存，各工具共用）。
function setThinking(dataDir, model, enabled) {
  const raw = readRaw(dataDir);
  const id = String(model || '');
  if (!cleanModels([id]).length) throw new Error('模型名不对');
  const list = cleanModels(raw.noThinking).filter(x => x !== id);
  if (!enabled) list.push(id);
  writeRaw(dataDir, { ...raw, noThinking: list });
  return read(dataDir);
}
function setModel(dataDir, model) {
  const raw = readRaw(dataDir);
  const models = cleanModels(raw.models);
  // 手填测通的模型也能设成默认（R45）。
  if (models.length && !models.includes(model) && !cleanModels(raw.customModels).includes(model)) throw new Error('网关上没有这个模型');
  writeRaw(dataDir, { ...raw, model: String(model) });
  return read(dataDir);
}
function clear(dataDir) {
  const raw = readRaw(dataDir);
  delete raw.encryptedKey; delete raw.checkedAt;
  writeRaw(dataDir, raw);
  return read(dataDir);
}

module.exports = { DEFAULT_BASE_URL, PREFERRED_MODEL, file, read, configured, decryptKey, resolveModel, modelChoices,
  normalizeBaseUrl, normalizeKey, explainHttp, probe, usage, save, setModel, setThinking, clear, allModels, addCustomModel, removeCustomModel,
  contextOf, firstTokenMs, chatOnly, catalogSummary, refreshCatalog, healthcheck, healthView };
