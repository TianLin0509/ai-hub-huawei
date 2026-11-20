'use strict';

// 部门 API 网关（New API）的公开目录与分组推断（2026-11-20 B 线）。
// 公开接口 GET /api/pricing 不要 key 就给全目录：每个模型的可用分组（enable_groups）、接口类型（supported_endpoint_types）、
// 标签（tags，逗号分隔）、说明（description）；顶层给分组说明（usable_group）和倍率（group_ratio）。
// 字段以 New API 开源实现为准（QuantumNous/new-api controller/pricing.go），11-20 黄区实测 8 个模型、4 个分组。
// 再用 key 读 /v1/models 得到「这把 key 能用的」，两者一比推出 key 所在分组。
// 目录缓存在 <数据目录>/api-gateway/catalog.json；拉取失败或拉到空目录时保留上一版，界面不突然变空。
const fs = require('node:fs');
const path = require('node:path');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY = 4 * 1024 * 1024;
// 取不到上下文时的保守默认：与以前一直写死的值一致，不比现状更激进（黄区 11-19 起 deepseek 在 128000 下工具往返正常）。
const DEFAULT_CONTEXT = 128000;
// 网关没写分组说明时用的白话（11-20 黄区目录原文的意思；vip 在 usable_group 里不列）。
const GROUP_FALLBACK = Object.freeze({
  default: '默认分组，不保障 SLA',
  free: '免费分组，个人资料里签到可无限使用，不保障 SLA',
  max: '响应快，扣费高（倍率 10）',
  vip: 'VIP 分组',
});

// 非对话模型：生图、生视频、语音、向量、重排。按接口类型、标签、名字三路判断，命中任一就不进对话模型表。
const NON_CHAT_ENDPOINTS = /^(image-generation|images?|embeddings?|rerank|audio|speech|tts|video|moderation)/i;
const NON_CHAT_TAGS = /文生图|图生图|文生视频|图生视频|生图|生视频|语音合成|语音识别|配音|向量|嵌入|重排|TTS|ASR|embedding|rerank/i;
const NON_CHAT_NAME = /(^|[-_.])(tts|asr|whisper|speech|audio|image|img|video|embed|embedding|rerank|reranker|dall-?e|sora|flux|sd\d?)([-_.\d]|$)/i;

function asList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，]/).map(v => v.trim()).filter(Boolean);
  return [];
}

// 「256K」「上下文256K」「256k context」「128000 tokens」→ token 数；K 按 1000 算（偏保守，宁可提前压缩也不撞墙）。
function parseContext(text) {
  const s = String(text || '');
  const k = /(\d{1,4}(?:\.\d+)?)\s*[Kk]\s*(?:上下文|context|tokens?\b)|(?:上下文|context(?:\s*window)?|窗口)\s*[:：]?\s*(\d{1,4}(?:\.\d+)?)\s*[Kk]/i.exec(s);
  if (k) return Math.round(Number(k[1] || k[2]) * 1000);
  const m = /(\d{1,4}(?:\.\d+)?)\s*[Mm]\s*(?:上下文|context)|(?:上下文|context)\s*[:：]?\s*(\d{1,4}(?:\.\d+)?)\s*[Mm]\b/i.exec(s);
  if (m) return Math.round(Number(m[1] || m[2]) * 1000 * 1000);
  const n = /(?:上下文|context)[^\d]{0,6}(\d{4,7})\s*(?:tokens?)?/i.exec(s);
  if (n) return Number(n[1]);
  return 0;
}

function isChatModel({ id, endpoints, tags }) {
  if (endpoints.some(e => NON_CHAT_ENDPOINTS.test(e))) return false;
  if (tags.some(t => NON_CHAT_TAGS.test(t))) return false;
  if (NON_CHAT_NAME.test(id)) return false;
  return true;
}

// /api/pricing 的 JSON → { groups: { name: { desc, ratio } }, models: [...] }。不认识的字段忽略，坏条目跳过。
function parsePricing(json) {
  const root = json && typeof json === 'object' ? json : {};
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.data?.data) ? root.data.data : [];
  const ratio = root.group_ratio && typeof root.group_ratio === 'object' ? root.group_ratio : {};
  const usable = root.usable_group && typeof root.usable_group === 'object' ? root.usable_group : {};
  const models = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item?.model_name || item?.id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const tags = asList(item.tags);
    const endpoints = asList(item.supported_endpoint_types);
    const description = String(item.description || '').slice(0, 2000);
    const groups = asList(item.enable_groups);
    const context = parseContext(tags.join(' ')) || parseContext(description);
    models.push({ id, groups, endpoints, tags, description, context, chat: isChatModel({ id, endpoints, tags }) });
  }
  const names = new Set([...Object.keys(usable), ...Object.keys(ratio), ...models.flatMap(m => m.groups)]);
  names.delete(''); names.delete('auto');
  const groups = {};
  for (const name of names) {
    const r = Number(ratio[name]);
    groups[name] = { desc: String(usable[name] || GROUP_FALLBACK[name] || '').trim(), ...(Number.isFinite(r) ? { ratio: r } : {}) };
  }
  return { groups, models };
}

// key 能用的模型 + 目录 → 所在分组。对每个分组算「该分组开放的模型」与「key 能用的模型」是否一致：
// 完全一致就是它（11-20 实测：key 看到 4 个，恰好是 free 分组的 4 个）；不一致取重合最多的，标 exact=false。
function inferGroup(catalog, keyModels) {
  const key = new Set((keyModels || []).filter(Boolean));
  const models = catalog?.models || [];
  if (!key.size || !models.length) return { group: '', exact: false, candidates: [] };
  const scores = Object.keys(catalog.groups || {}).map(group => {
    const open = new Set(models.filter(m => m.groups.includes(group)).map(m => m.id));
    let both = 0; for (const id of key) if (open.has(id)) both++;
    const union = new Set([...open, ...key]).size;
    return { group, exact: both === key.size && both === open.size, jaccard: union ? both / union : 0, open: open.size };
  }).filter(s => s.jaccard > 0);
  if (!scores.length) return { group: '', exact: false, candidates: [] };
  const exact = scores.filter(s => s.exact).map(s => s.group);
  if (exact.length) return { group: exact[0], exact: true, candidates: exact };
  scores.sort((a, b) => b.jaccard - a.jaccard || a.open - b.open);
  return { group: scores[0].group, exact: false, candidates: scores.slice(0, 3).map(s => s.group) };
}

// 一屏能讲清的结论：能用的对话模型、key 看不到的对话模型（各开给哪些分组）、被排除的非对话模型。
function summarize(catalog, keyModels) {
  const key = new Set(keyModels || []);
  const byId = new Map((catalog?.models || []).map(m => [m.id, m]));
  const inferred = inferGroup(catalog, keyModels);
  const usable = [...key].filter(id => !byId.has(id) || byId.get(id).chat);
  const nonChat = [...key].filter(id => byId.has(id) && !byId.get(id).chat);
  const hidden = (catalog?.models || []).filter(m => m.chat && !key.has(m.id)).map(m => ({ id: m.id, groups: m.groups }));
  const info = inferred.group ? catalog.groups[inferred.group] || {} : {};
  return { group: inferred.group, groupExact: inferred.exact, groupDesc: info.desc || '', groupRatio: info.ratio ?? null,
    usable, hidden, nonChat, groups: catalog?.groups || {} };
}

function contextOf(catalog, id) {
  const m = (catalog?.models || []).find(x => x.id === id);
  return m && m.context > 0 ? m.context : DEFAULT_CONTEXT;
}

// ---------- 拉取与缓存 ----------
function cacheFile(dataDir) { return path.join(dataDir, 'api-gateway', 'catalog.json'); }
function readCache(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8').replace(/^\uFEFF/, ''));
    return value && Array.isArray(value.models) && value.models.length ? value : null;
  } catch { return null; }
}
function writeCache(dataDir, value) {
  const target = cacheFile(dataDir), tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, target); }
  catch (error) { try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件清不掉不影响目录 */ } throw error; }
}

function originOf(baseURL) { return new URL(String(baseURL || '')).origin; }

async function fetchPricing({ baseURL, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(originOf(baseURL) + '/api/pricing', { headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    if (!res.ok) return { ok: false, code: 'http_' + res.status };
    if (text.length > MAX_BODY) return { ok: false, code: 'too_large' };
    const catalog = parsePricing(JSON.parse(text));
    return catalog.models.length ? { ok: true, catalog } : { ok: false, code: 'empty' };
  } catch (error) {
    return { ok: false, code: error?.name === 'AbortError' ? 'timeout' : error instanceof SyntaxError ? 'bad_json' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

// 刷新目录：拿到非空目录才覆盖缓存；失败或空目录返回上一版（stale=true），没有上一版返回 null。
async function refresh(dataDir, { baseURL, fetchImpl, timeoutMs } = {}) {
  const previous = readCache(dataDir);
  const origin = (() => { try { return originOf(baseURL); } catch { return ''; } })();
  const result = origin ? await fetchPricing({ baseURL, fetchImpl, timeoutMs }) : { ok: false, code: 'bad_url' };
  if (result.ok) {
    const next = { schema: 1, at: Date.now(), origin, ...result.catalog };
    try { writeCache(dataDir, next); } catch { /* 写不进缓存时这次照样用新目录 */ }
    return { ok: true, catalog: next, stale: false };
  }
  const usable = previous && (!origin || previous.origin === origin) ? previous : null;
  return { ok: false, code: result.code, catalog: usable, stale: !!usable };
}

function cached(dataDir, baseURL) {
  const value = readCache(dataDir);
  if (!value) return null;
  try { return !baseURL || value.origin === originOf(baseURL) ? value : null; } catch { return null; }
}

module.exports = { DEFAULT_CONTEXT, GROUP_FALLBACK, parseContext, parsePricing, isChatModel, inferGroup, summarize, contextOf,
  cacheFile, readCache, writeCache, fetchPricing, refresh, cached };
