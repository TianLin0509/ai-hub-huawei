// API 网关上游（OpenAI 兼容网关，例如 New API；2026-11-19 定方案 A）。
// 反代的协议转换层（adapters.mjs）先把 Claude / Codex / DSH 的请求转成 chat 形态，这里把它原样发给网关，
// 再把网关的 SSE 调成转换器认的样子：
//   - 思考内容：网关（vLLM）用 delta.reasoning，转换器认 delta.reasoning_content；
//   - 模型名：网关回的是内部简称（实测 deepseek-v4.1-flash 回 "dsv41"），Codex 转换器要求与请求一致，回写成请求名。
//   - 空的 tool_calls（每段都带 `tool_calls: []`）删掉：部分转换器见到这个字段就按工具调用处理，把同一段的正文吞掉；
//   - `data:` 后没空格的行补上空格（只改能解析成 JSON 的行，其余原样透传）。
// 11-19 黄区实测：首包前排队 12–31 秒常见，一次工具调用 60 秒无响应、重试后 90 秒成功。首包等待上限按模型自适应
// （2026-11-21 口径）：至少 150 秒（原来的固定值），体检或最近真实请求测到首字很慢的模型按 首字 × 6 放宽，最多 300 秒
// （算法与依据见 core/api-gateway-healthcheck.js）；没等到就放弃这次、自动重试一次；还不行给出白话错误，不无限等。
// 报错口径与设置页共用 core/api-gateway-errors.js：key 无效、无权限、额度、白名单、分组下没有渠道这几类不重试。
// Key 只在内存里，日志只记状态码、错误类别与耗时。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// 安装版从 app.asar.unpacked 起这个文件，而 core/api-gateway-*.js 留在 app.asar 里（asarUnpack 只解 core/company-proxy/**）：
// 同 server.mjs 的 accountModelsReader，先试本目录旁边，再试 asar 内（Electron 的 Node 能读 asar）。
function hubModule(name) {
  const here = fileURLToPath(import.meta.url);
  let lastError;
  for (const file of [here, here.replace(/app\.asar\.unpacked([\\/])/, 'app.asar$1')]) {
    try { return createRequire(file)(name); } catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error; lastError = error; }
  }
  throw lastError;
}
const gatewayErrors = hubModule('../api-gateway-errors.js');
const { firstTokenTimeoutMs } = hubModule('../api-gateway-healthcheck.js');

const STRIP_FIELDS = new Set(['thinking', 'reasoning_effort']); // 公司上游专用的思考开关；网关的推理模型默认就思考
// Claude 请求原样直通网关 /v1/messages（server.mjs 给请求体打这个标记；只对网关目录里声明支持 anthropic 接口的模型）。
// 2026-11-27 黄区实测 glm-5.3-flash：同一时段同 5 个真实任务，直通比转 chat 快约 25%，提示缓存命中 98%（chat 接口命中 0），
// 计费输入 token 中位从 10.4 万降到 4.3 万；新 key 所在分组的 chat 接口每轮要等约 52 秒才出第一块，直通边想边推不再卡。
export const NATIVE_MESSAGES = Symbol('gateway-native-messages');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 所有 system 合并成一条放最前面（R49，11-26 反馈「网关原话：System message must be at the beginning.」）。
// Qwen 等模型的对话模板只认开头那一条 system，第二条 system（哪怕紧挨着）就报这个 400。实测会出现多条 / 中间 system 的：
// Claude Code 2.1.32x 把环境说明作为对话中间的一条 system 发出（system, user, system）；Codex 的 instructions 加 developer
// 消息转成两条 system（system, system, user…）；DSH 的 developer 消息同理。合并时按原顺序用空行拼接，正文一字不丢。
const systemText = content => (typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
  : content == null ? '' : String(content));
const SERVER_RETRIES = 3; // 网关偶发 5xx / 429 的自动重试次数

export function systemFirst(messages) {
  const system = [], rest = [];
  for (const m of messages) (object(m) && (m.role === 'system' || m.role === 'developer') ? system : rest).push(m);
  if (!system.length || (system.length === 1 && messages[0] === system[0] && system[0].role === 'system')) return messages;
  const text = system.map(m => systemText(m.content)).filter(t => t.trim()).join('\n\n');
  return text ? [{ role: 'system', content: text }, ...rest] : rest;
}
// noThinking：用户对这个模型关了思考，注入 chat_template_kwargs.enable_thinking=false（网关透传给 vLLM；11-20 黄区实测
// qwen-aw-35b 关思考后首正文从 9.5 秒 / 不出正文变成 0.23 秒）。
export function gatewayBody(body, { noThinking = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(body)) if (!STRIP_FIELDS.has(key)) out[key] = value;
  if (Array.isArray(out.messages)) out.messages = systemFirst(out.messages);
  out.stream = true;
  out.stream_options = { include_usage: true };
  if (noThinking) out.chat_template_kwargs = { ...(object(out.chat_template_kwargs) ? out.chat_template_kwargs : {}), enable_thinking: false };
  return out;
}
// 只出了思考、到输出上限也没正文：在结束帧前补一句人话正文，告诉用户怎么办（否则界面上就是「没反应」）。
export function thinkOnlyHint(model) {
  return `（网关：「${model}」想了太久，到输出上限还没开始回答。可以重发，或到「设置 → 自有 API → API 网关」的能力表里对这个模型点「关闭思考」，它就会直接回答。）`;
}

// 一条 SSE data 的 JSON：reasoning → reasoning_content，model → 请求名，空 tool_calls 删掉。其他字段不动。
export function normalizeChunk(chunk, requestedModel) {
  if (!object(chunk)) return chunk;
  if (typeof chunk.model === 'string' && requestedModel) chunk.model = requestedModel;
  for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
    for (const part of [choice?.delta, choice?.message]) {
      if (!object(part)) continue;
      if (typeof part.reasoning === 'string' && part.reasoning && !part.reasoning_content) part.reasoning_content = part.reasoning;
      delete part.reasoning;
      if (Array.isArray(part.tool_calls) && !part.tool_calls.length) delete part.tool_calls;
    }
  }
  return chunk;
}

// 逐行改写 SSE（按行缓冲，跨块拼接）；解析不了的行原样放过。
// thinkHint：只对用户看得见的对话回合补「想太久」那句；Claude Code 后台起标题、摘要这类请求的输出会被当成标题写进界面，不能注入。
export function normalizeStream(body, requestedModel, { thinkHint = true } = {}) {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = '';
  let thought = false, answered = false;
  const rewrite = line => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return line;
    let chunk;
    try { chunk = normalizeChunk(JSON.parse(payload), requestedModel); } catch { return line; }
    let hint = '';
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      const d = choice?.delta || {};
      if (d.reasoning_content) thought = true;
      if ((typeof d.content === 'string' && d.content) || (Array.isArray(d.tool_calls) && d.tool_calls.length)) answered = true;
      if (thinkHint && choice?.finish_reason === 'length' && thought && !answered) {
        answered = true;
        hint = 'data: ' + JSON.stringify({ id: chunk.id, object: chunk.object, model: chunk.model, choices: [{ index: choice.index ?? 0, delta: { content: thinkOnlyHint(requestedModel) }, finish_reason: null }] }) + '\n\n';
      }
    }
    return hint + 'data: ' + JSON.stringify(chunk);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.length) controller.enqueue(encoder.encode(lines.map(l => rewrite(l.replace(/\r$/, ''))).join('\n') + '\n'));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  }));
}

// 网关错误 → 白话（与设置页同一份口径：core/api-gateway-errors.js）。给客户端的状态码按「该不该重试」定：
// 不该重试的几类给 4xx（key 无效 401、无权限 403、额度 / 分组无渠道 / 模型下线 / 超上下文 400）——Claude Code、Codex 的 SDK
// 只对 408/409/429/5xx 自动重试，4xx 不会白重试几轮；网关回 503「分组下没有渠道」就是这样改成 400 的。
export function explainGatewayError(status, text = '', ctx = {}) {
  const e = gatewayErrors.classify({ status, body: text, ...ctx });
  return { status: e.status, code: 'GATEWAY_' + e.code.toUpperCase(), kind: e.code, retry: e.retry, message: gatewayErrors.sentence(e) };
}

// headerTimeoutMs：给了就固定用它（测试、或 Hub 用环境变量强制）；不给按模型自适应。
// firstTokenMs：{ 模型名: 体检测到的首字毫秒 }；models / group：这把 key 能用的模型和所在分组，报错时说具体。
export function createGatewayProvider({ baseURL, apiKey, fetchImpl = globalThis.fetch, headerTimeoutMs = 0, retries = 1,
  firstTokenMs = {}, models = [], group = '', noThinking = [], ownError, onWait = () => {}, log = () => {} } = {}) {
  if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL)) throw new Error('gateway baseURL is required');
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('gateway apiKey is required');
  if (typeof ownError !== 'function') throw new Error('ownError is required');
  const base = baseURL.replace(/\/+$/, '');
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: 'text/event-stream' };
  const chatTarget = { url: base + '/chat/completions', headers };
  const messagesTarget = { url: base + '/messages', headers: { ...headers, 'anthropic-version': '2023-06-01' } };
  // 最近真实请求的首字时间（按模型，指数平均）：比体检那一刻更贴近当下的排队情况。
  const live = new Map();
  const observe = (model, ms) => { const prev = live.get(model); live.set(model, prev ? Math.round(prev * 0.7 + ms * 0.3) : ms); };
  const timeoutFor = model => (headerTimeoutMs > 0 ? headerTimeoutMs : firstTokenTimeoutMs(live.get(model) ?? firstTokenMs?.[model]));

  // 一次请求：首包超时由 headerTimer 控制，「首包」指正文的第一块数据——网关可能先回响应头、排队时正文才卡住
  // （11-19 换模型审查发现）。读到第一块就清掉计时，之后由客户端自己的超时管；还没给下游输出任何东西，重试才不会重复。
  async function attempt(serialized, signal, waitMs, model, { url, headers }) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    const headerTimer = setTimeout(() => { timedOut = true; controller.abort(); }, waitMs);
    const sent = Date.now();
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: serialized, signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body) return { response };
      const reader = response.body.getReader();
      const first = await reader.read();
      if (!first.done) observe(model, Date.now() - sent);
      const body = new ReadableStream({
        start(c) { if (first.done) c.close(); else c.enqueue(first.value); },
        async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
        cancel(reason) { return reader.cancel(reason); },
      });
      return { response: new Response(body, { status: response.status, headers: response.headers }) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { failed: timedOut ? 'timeout' : 'unreachable' };
    } finally { clearTimeout(headerTimer); signal?.removeEventListener('abort', relay); }
  }

  return {
    async listModels() { return []; },
    // track=false：后台请求（Claude Code 起标题等，server.mjs 按「Claude 请求不带工具」判断）——不计入排队提示，也不补「想太久」那句。
    async complete(body, { signal, sessionTag = 'default', track = true } = {}) {
      const requestedModel = body.model;
      const native = body[NATIVE_MESSAGES] === true;
      const target = native ? messagesTarget : chatTarget;
      const serialized = JSON.stringify(native ? body : gatewayBody(body, { noThinking: noThinking.includes(requestedModel) }));
      const started = Date.now();
      const waitMs = timeoutFor(requestedModel);
      const request = {}; // 同一会话可能同时有几个请求（Claude Code 主回答 + 后台起标题），按请求记排队，不按会话
      const wait = track ? onWait : () => {};
      wait({ request, sessionTag, waiting: true, since: started, attempt: 1 });
      try {
        let result, serverRetries = 0;
        for (let n = 1; n <= 1 + retries; n++) {
          if (n > 1 && result.failed) { log(`gateway retry ${n - 1} after ${result.failed} (${Date.now() - started}ms)`); wait({ request, sessionTag, waiting: true, since: started, attempt: n }); }
          result = await attempt(serialized, signal, waitMs, requestedModel, target);
          // 网关偶发 5xx / 限流 429（还没给客户端输出任何东西）：自动重试。Codex、DSH 的网关路线客户端重试是 0 次，
          // 2026-11-27 黄区实测网关 GLM 渠道间歇 500，一次抖动就让整轮任务失败；Claude Code 自己会重试，这里先挡一次。
          // 只重试网关自己说「可重试」的（分类见 core/api-gateway-errors.js：服务端错误、限流）；key、额度、模型不存在这类不重试。
          // 11-28 夜里实测 GLM 渠道约 3 成请求 500：一轮任务约 15 次请求，只重试 1 次整轮仍多半失败，所以单独给 3 次、退避 1.5/3/6 秒（不占排队超时的重试次数）。
          const status = result.response && !result.response.ok ? result.response.status : 0;
          if (status && serverRetries < SERVER_RETRIES && (status >= 500 || status === 429)) {
            const ra = String(result.response.headers.get('retry-after') || '').trim();
            const raSec = /^\d+$/.test(ra) ? Number(ra) : (Date.parse(ra) - Date.now()) / 1000;
            const retryAfter = Math.min(30, Math.ceil(raSec > 0 ? raSec : 0));
            const text = await result.response.text().catch(() => '');
            const e = explainGatewayError(status, text, { model: requestedModel, usable: models, group });
            if (!e.retry || !['server', 'rate_limited'].includes(e.kind)) {
              log(`gateway HTTP ${status} -> ${e.code}`);
              return ownError(e.status, e.message, e.status === 429 ? { 'retry-after': String(retryAfter || 30) } : {});
            }
            serverRetries++;
            log(`gateway retry ${serverRetries}/${SERVER_RETRIES} after HTTP ${status} (${Date.now() - started}ms)`);
            n--; // 服务端错误的重试单独计数，不占排队超时的次数
            if (signal?.aborted) throw signal.reason || new Error('aborted');
            await new Promise((resolve, reject) => {
              const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
              const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, status === 429 ? Math.max(2, retryAfter) * 1000 : 1500 * 2 ** (serverRetries - 1));
              signal?.addEventListener?.('abort', onAbort, { once: true });
            });
            continue;
          }
          if (result.response) break;
        }
        if (!result.response) {
          return result.failed === 'timeout'
            ? ownError(504, `网关排队太久：「${requestedModel}」每次等 ${Math.round(waitMs / 1000)} 秒还没开始回答，已自动重试 ${retries} 次仍未成功。网关可能正忙，请稍后重发，或新建会话换个首字更快的模型（设置 → 自有 API → API 网关 → 一键体检 可以看各模型首字时间）。`)
            : ownError(502, '连不上网关：电脑可能不在公司内网（例如在家没连 VPN），或网关地址不对。连上内网后重发即可。');
        }
        const { response } = result;
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const e = explainGatewayError(response.status, text, { model: requestedModel, usable: models, group });
          log(`gateway HTTP ${response.status} -> ${e.code}`);
          return ownError(e.status, e.message, e.status === 429 ? { 'retry-after': String(Math.min(30, Number(response.headers.get('retry-after')) || 30)) } : {});
        }
        if (!response.body) return response;
        // 直通：网关回的就是 Anthropic 流，原样交回（模型名、思考块 Claude Code 自己认）。
        // 回包类型照网关原样：不是 SSE（例如 200 的 HTML 拦截页）时交给 transport.mjs 报「上游没给流」。
        if (native) return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' } });
        return new Response(normalizeStream(response.body, requestedModel, { thinkHint: track }), { status: response.status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      } finally { wait({ request, sessionTag, waiting: false, since: started }); }
    },
  };
}
