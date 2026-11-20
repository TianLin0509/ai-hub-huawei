'use strict';

// API 网关一键体检（2026-11-20 B 线）：对每个对话模型发一句极短的流式请求（带一个简单工具），
// 记首字时间、总时长、会不会真返回 tool_calls、有没有思考内容，出一张能力表。并发 3，单个模型最多等 90 秒。
// 也给出「首字等待上限」的算法：本机代理按体检（和最近真实请求）测到的首字时间自适应，替代原来固定的 150+150 秒。
const fs = require('node:fs');
const path = require('node:path');
const errors = require('./api-gateway-errors');

const CONCURRENCY = 3;
const FIRST_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 90_000;
// 推理模型先想再调工具，太小会在想的途中被截断、测不出工具：11-20 黄区实测 max_tokens=48 时 8 条流里 5 条全是思考、
// 没有正文。给 1024：试跑的提示只有一句，正常模型远用不完；free 分组倍率 0.01，几乎不耗额度。
const PROBE_MAX_TOKENS = 1024;
const PROBE_TOOL = Object.freeze({ type: 'function', function: { name: 'get_time', description: '返回当前时间。', parameters: { type: 'object', properties: {}, required: [] } } });
const PROBE_PROMPT = '请调用 get_time 工具查询现在的时间。只调用工具，不要输出其他内容。';

// ---------- 首字等待上限 ----------
// 依据（11-19/11-20 黄区实测）：正常排队首字 12–31 秒；一次工具调用 60 秒没响应、重试后 90 秒内成功。
// 上限 = 实测首字 × 6，夹在 [150, 300] 秒（2026-11-21 负责人定口径）：下限 150 秒 = 原来的固定值，自适应只往上调、不往下压——
// 长上下文会话 prefill 慢，首字可以远超体检时的一句话提示，压到 60 秒会把正常请求判超时报 504。
// 只有体检或最近真实请求测到首字很慢（> 25 秒）的模型才放宽到 首字 × 6，最多 300 秒。没测过的模型用 150 秒。失败后自动重试 1 次不变。
const FIRST_FACTOR = 6;
const FIRST_MIN_MS = 150_000;
const FIRST_MAX_MS = 300_000;
const FIRST_DEFAULT_MS = 150_000;
function firstTokenTimeoutMs(measuredMs) {
  const v = Number(measuredMs);
  if (!Number.isFinite(v) || v <= 0) return FIRST_DEFAULT_MS;
  return Math.min(FIRST_MAX_MS, Math.max(FIRST_MIN_MS, Math.round(v * FIRST_FACTOR)));
}

// ---------- 读一条流 ----------
// 逐行读 SSE；`data:` 后有没有空格都认。返回统计，不保留正文。
async function readStream(body, { started, onFirst, signal } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // firstMs：首个有内容的帧（思考也算，说明模型在动）；firstThinkMs / firstTextMs 分开记（11-20 黄区实测两者能差 7 秒）。
  const stat = { firstMs: null, firstThinkMs: null, firstTextMs: null, tools: false, toolName: '', thinking: false, text: 0, emptyToolCalls: 0, finish: '', chunks: 0, streamError: '' };
  let buffer = '';
  const take = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk; try { chunk = JSON.parse(payload); } catch { return; }
    stat.chunks++;
    if (chunk?.error) { stat.streamError = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error); return; }
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      const d = choice?.delta || choice?.message || {};
      let meaningful = false;
      if ((typeof d.reasoning === 'string' && d.reasoning) || (typeof d.reasoning_content === 'string' && d.reasoning_content)) {
        stat.thinking = true; meaningful = true;
        if (stat.firstThinkMs === null) stat.firstThinkMs = Date.now() - started;
      }
      if (typeof d.content === 'string' && d.content) {
        stat.text += d.content.length; meaningful = true;
        if (stat.firstTextMs === null) stat.firstTextMs = Date.now() - started;
        if (/<think>/.test(d.content)) stat.thinking = true;
      }
      if (Array.isArray(d.tool_calls)) {
        if (!d.tool_calls.length) stat.emptyToolCalls++;
        for (const call of d.tool_calls) {
          if (call?.function?.name) { stat.tools = true; stat.toolName = call.function.name; if (stat.firstTextMs === null) stat.firstTextMs = Date.now() - started; }
          meaningful = true;
        }
      }
      if (choice?.finish_reason) stat.finish = choice.finish_reason;
      if (meaningful && stat.firstMs === null) { stat.firstMs = Date.now() - started; onFirst?.(); }
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const l of lines) take(l.replace(/\r$/, ''));
    }
    buffer += decoder.decode();
    if (buffer) take(buffer.replace(/\r$/, ''));
  } finally { try { reader.releaseLock(); } catch { /* 已经结束 */ } }
  return stat;
}

// ---------- 单个模型 ----------
// noThinking：用户对这个模型关了思考时，试跑也照样关（网关透传 chat_template_kwargs.enable_thinking，11-20 黄区实测有效）。
async function probeModel({ baseURL, apiKey, model, fetchImpl = globalThis.fetch, firstTimeoutMs = FIRST_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS, ctx = {}, noThinking = false }) {
  const url = String(baseURL).replace(/\/+$/, '') + '/chat/completions';
  const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: PROBE_MAX_TOKENS,
    messages: [{ role: 'user', content: PROBE_PROMPT }], tools: [PROBE_TOOL], tool_choice: 'auto', ...(noThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}) });
  const controller = new AbortController();
  let phase = 'first';
  const firstTimer = setTimeout(() => { if (phase === 'first') controller.abort(new Error('first-timeout')); }, firstTimeoutMs);
  const totalTimer = setTimeout(() => controller.abort(new Error('total-timeout')), totalTimeoutMs);
  const started = Date.now();
  const fail = (e, extra = {}) => ({ id: model, ok: false, firstMs: null, totalMs: Date.now() - started, tools: null, thinking: null, error: e, ...extra });
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: 'text/event-stream' },
        body, signal: controller.signal, redirect: 'error' });
    } catch {
      const timedOut = controller.signal.aborted;
      return fail(pick(errors.classify({ networkCode: timedOut ? 'timeout' : 'unreachable', model, waitedMs: Date.now() - started, ...ctx })));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return fail(pick(errors.classify({ status: res.status, body: text, model, ...ctx })), { status: res.status });
    }
    let stat;
    try { stat = await readStream(res.body, { started, onFirst: () => { phase = 'stream'; }, signal: controller.signal }); }
    catch {
      return fail(pick(errors.classify({ networkCode: controller.signal.aborted ? 'timeout' : 'unreachable', model, waitedMs: Date.now() - started, ...ctx })));
    }
    if (stat.streamError) return fail(pick(errors.classify({ status: 500, body: stat.streamError, model, ...ctx })));
    if (stat.firstMs === null) return fail({ code: 'empty', title: '没有回答', message: `「${model}」回了空的流，没有任何正文、思考或工具调用。`, actions: ['switch-model'], retry: true, detail: '' });
    // 被截断在思考中途、又没调工具：测不出工具能力，记「没测出」而不是「不会」。
    const tools = stat.tools ? true : stat.finish === 'length' ? null : false;
    // 只出了思考、到上限也没正文没工具：模型能连上，但「想太久还没回答」——同事说的「选 Qwen 没反应」就是这个样子。
    const thinkOnly = stat.thinking && !stat.text && !stat.tools;
    return { id: model, ok: true, firstMs: stat.firstMs, firstThinkMs: stat.firstThinkMs, firstTextMs: stat.firstTextMs, thinkOnly, noThinking: !!noThinking,
      totalMs: Date.now() - started, tools, thinking: stat.thinking,
      emptyToolCalls: stat.emptyToolCalls, finish: stat.finish };
  } finally { clearTimeout(firstTimer); clearTimeout(totalTimer); }
}
const pick = e => ({ code: e.code, title: e.title, message: e.message, actions: e.actions, retry: e.retry, detail: e.detail });

// ---------- 全部模型 ----------
// models：要测的对话模型；catalog：目录（取上下文、接口类型）。onProgress(result) 每测完一个回调一次。
async function run({ baseURL, apiKey, models, catalog = null, group = '', fetchImpl, concurrency = CONCURRENCY, firstTimeoutMs, totalTimeoutMs, onProgress, noThinking = [] } = {}) {
  const list = [...new Set(models || [])];
  const known = (catalog?.models || []).map(m => m.id);
  const meta = id => (catalog?.models || []).find(m => m.id === id) || null;
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const id = list[i];
      const r = await probeModel({ baseURL, apiKey, model: id, fetchImpl, firstTimeoutMs, totalTimeoutMs, ctx: { group, usable: list, known }, noThinking: noThinking.includes(id) });
      const m = meta(id);
      results[i] = { ...r, context: m?.context || 0, endpoints: m?.endpoints || [] };
      onProgress?.(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return results;
}

// 能力表一行的白话（模型下拉框的说明、启动中心卡片用）。
function note(r) {
  if (!r) return '';
  if (!r.ok) return `暂不可用 · ${r.error?.title || '体检没通过'}`;
  const s = ms => (ms / 1000).toFixed(1) + ' 秒';
  const parts = [];
  if (r.thinkOnly) parts.push('想太久没回答（可关闭思考）');
  else if (r.firstThinkMs !== null && r.firstThinkMs !== undefined && r.firstTextMs !== null && r.firstTextMs !== undefined) parts.push(`首思考 ${s(r.firstThinkMs)} · 首正文 ${s(r.firstTextMs)}`);
  else parts.push(`首字 ${s(r.firstTextMs ?? r.firstMs)}`);
  parts.push(r.tools === true ? '会用工具' : r.tools === false ? '不调用工具（只适合聊天）' : '工具没测出');
  if (r.noThinking) parts.push('已关闭思考');
  else if (r.thinking) parts.push('会先思考');
  if (r.context) parts.push(`上下文 ${Math.round(r.context / 1000)}K`);
  return parts.join(' · ');
}

// ---------- 缓存 ----------
function file(dataDir) { return path.join(dataDir, 'api-gateway', 'health.json'); }
function read(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(file(dataDir), 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && v.results && typeof v.results === 'object' ? v : null;
  } catch { return null; }
}
function write(dataDir, value) {
  const target = file(dataDir), tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, target); }
  catch (error) { try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉不影响 */ } throw error; }
}

module.exports = { CONCURRENCY, PROBE_MAX_TOKENS, PROBE_TOOL, FIRST_FACTOR, FIRST_MIN_MS, FIRST_MAX_MS, FIRST_DEFAULT_MS,
  firstTokenTimeoutMs, readStream, probeModel, run, note, file, read, write };
