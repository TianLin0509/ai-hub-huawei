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
// 已知模型的白话说明（实测得来）；不认识的模型只显示名字。
const MODEL_NOTES = Object.freeze({
  'deepseek-v4.1-flash': '推荐 · 最快，会调用工具',
  'glm-5.3-flash': '推理模型 · 先思考再回答，较慢',
  'qwen3.8-27b': '通用 · 写作和问答',
  'qwen-aw-35b': '通用 · 写作和问答',
});

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
    model: models.includes(raw.model) ? raw.model : defaultModelOf(models),
    checkedAt: Number(raw.checkedAt) || 0,
    unlimited: raw.unlimited === true,
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
  if (value && (view.models.includes(value) || !view.models.length)) return value;
  return view.model;
}
function modelChoices(dataDir) {
  const view = read(dataDir);
  return view.models.map(id => ({ id, label: id, note: MODEL_NOTES[id] || '' }));
}

// 网关错误 → 用户看得懂的一句话 + 下一步。11-19 实测：坏 key 401「Invalid token」；不存在的模型 503 model_not_found。
function explainHttp(status, body = '') {
  let detail = '';
  try { const e = JSON.parse(body)?.error; detail = String(e?.code || e?.message || ''); } catch { detail = String(body || ''); }
  if (status === 401 || status === 403) return { code: 'bad_key', message: 'key 无效：网关不认这个 key。请检查是否复制完整（通常以 sk- 开头），重新粘贴后再试。' };
  if (/model_not_found/i.test(detail)) return { code: 'model_not_found', message: '网关上没有这个模型，请在模型列表里换一个。' };
  if (status === 429) return { code: 'rate_limited', message: '网关限流了，请稍等一会儿再试。' };
  return { code: 'http_' + status, message: `网关返回 HTTP ${status}，请稍后重试；一直不行请联系网关管理员。` };
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
  } catch {
    return { ok: false, code: 'unreachable', message: `连不上网关：${Math.round(timeoutMs / 1000)} 秒内没有响应。常见原因是电脑不在公司内网（例如在家没连 VPN），或网关地址不对。连上内网后点「重试」。` };
  }
  const { text } = response;
  if (!response.ok) return { ok: false, ...explainHttp(response.status, text) };
  let models = [];
  try { models = cleanModels((JSON.parse(text)?.data || []).map(m => m?.id)); } catch { models = []; }
  if (!models.length) return { ok: false, code: 'no_models', message: '网关连上了，但没有返回任何可用模型。请联系网关管理员确认这个 key 的模型权限。' };
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
  const raw = readRaw(dataDir);
  const chosen = result.models.includes(model) ? model : (result.models.includes(raw.model) ? raw.model : defaultModelOf(result.models));
  const next = { ...raw, baseURL: base, models: result.models, model: chosen, checkedAt: Date.now() };
  if (apiKey) next.encryptedKey = safeStorage.encryptString(key).toString('base64');
  writeRaw(dataDir, next);
  return { ok: true, ...read(dataDir), choices: modelChoices(dataDir) };
}
function setModel(dataDir, model) {
  const raw = readRaw(dataDir);
  const models = cleanModels(raw.models);
  if (models.length && !models.includes(model)) throw new Error('网关上没有这个模型');
  writeRaw(dataDir, { ...raw, model: String(model) });
  return read(dataDir);
}
function clear(dataDir) {
  const raw = readRaw(dataDir);
  delete raw.encryptedKey; delete raw.checkedAt;
  writeRaw(dataDir, raw);
  return read(dataDir);
}

module.exports = { DEFAULT_BASE_URL, PREFERRED_MODEL, MODEL_NOTES, file, read, configured, decryptKey, resolveModel, modelChoices,
  normalizeBaseUrl, normalizeKey, explainHttp, probe, usage, save, setModel, clear };
