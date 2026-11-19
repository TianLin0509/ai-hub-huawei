// API 网关上游（OpenAI 兼容网关，例如 New API；2026-11-19 定方案 A）。
// 反代的协议转换层（adapters.mjs）先把 Claude / Codex / DSH 的请求转成 chat 形态，这里把它原样发给网关，
// 再把网关的 SSE 调成转换器认的样子：
//   - 思考内容：网关（vLLM）用 delta.reasoning，转换器认 delta.reasoning_content；
//   - 模型名：网关回的是内部简称（实测 deepseek-v4.1-flash 回 "dsv41"），Codex 转换器要求与请求一致，回写成请求名。
// 11-19 黄区实测：首包前排队 12–31 秒常见，一次工具调用 60 秒无响应、重试后 90 秒成功。所以首包最多等
// headerTimeoutMs（默认 150 秒），没等到就放弃这次、自动重试一次；还不行给出白话错误，不无限等。
// Key 只在内存里，日志只记状态码与耗时。

const STRIP_FIELDS = new Set(['thinking', 'reasoning_effort']); // 公司上游专用的思考开关；网关的推理模型默认就思考
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function gatewayBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) if (!STRIP_FIELDS.has(key)) out[key] = value;
  out.stream = true;
  out.stream_options = { include_usage: true };
  return out;
}

// 一条 SSE data 的 JSON：reasoning → reasoning_content，model → 请求名。其他字段不动。
export function normalizeChunk(chunk, requestedModel) {
  if (!object(chunk)) return chunk;
  if (typeof chunk.model === 'string' && requestedModel) chunk.model = requestedModel;
  for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
    for (const part of [choice?.delta, choice?.message]) {
      if (!object(part)) continue;
      if (typeof part.reasoning === 'string' && part.reasoning && !part.reasoning_content) part.reasoning_content = part.reasoning;
      delete part.reasoning;
    }
  }
  return chunk;
}

// 逐行改写 SSE（按行缓冲，跨块拼接）；解析不了的行原样放过。
export function normalizeStream(body, requestedModel) {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = '';
  const rewrite = line => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return line;
    try { return 'data: ' + JSON.stringify(normalizeChunk(JSON.parse(payload), requestedModel)); } catch { return line; }
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

// 网关错误 → 白话（与 core/api-gateway.js explainHttp 同口径）。状态码按客户端是否该重试来定：
// key 无效 401、模型不存在 400（网关回 503，但重试没用）、限流 429、其余保持原状态。
export function explainGatewayError(status, text = '') {
  let detail = '';
  try { const e = JSON.parse(text)?.error; detail = String(e?.code || e?.message || ''); } catch { detail = String(text || '').slice(0, 200); }
  if (status === 401 || status === 403) return { status: 401, code: 'GATEWAY_BAD_KEY', message: 'API 网关不认这个 key（key 无效或已失效）。请到「设置 → 模型线路 → API 网关」重新粘贴 key。' };
  if (/model_not_found/i.test(detail)) return { status: 400, code: 'GATEWAY_MODEL_NOT_FOUND', message: 'API 网关上没有这个模型。请新建会话换一个模型，或到设置里刷新模型列表。' };
  if (status === 429) return { status: 429, code: 'GATEWAY_RATE_LIMITED', message: 'API 网关限流了，请稍等一会儿再发。' };
  return { status: status >= 400 && status < 600 ? status : 502, code: 'GATEWAY_HTTP_' + status, message: `API 网关返回 HTTP ${status}，请稍后重试；一直不行请联系网关管理员。` };
}

export function createGatewayProvider({ baseURL, apiKey, fetchImpl = globalThis.fetch, headerTimeoutMs = 150_000, retries = 1,
  ownError, onWait = () => {}, log = () => {} } = {}) {
  if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL)) throw new Error('gateway baseURL is required');
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('gateway apiKey is required');
  if (typeof ownError !== 'function') throw new Error('ownError is required');
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: 'text/event-stream' };

  // 一次请求：首包超时由 headerTimer 控制，「首包」指正文的第一块数据——网关可能先回响应头、排队时正文才卡住
  // （11-19 换模型审查发现）。读到第一块就清掉计时，之后由客户端自己的超时管；还没给下游输出任何东西，重试才不会重复。
  async function attempt(serialized, signal) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    const headerTimer = setTimeout(() => { timedOut = true; controller.abort(); }, headerTimeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: serialized, signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body) return { response };
      const reader = response.body.getReader();
      const first = await reader.read();
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
    async complete(body, { signal, sessionTag = 'default', track = true } = {}) {
      const requestedModel = body.model;
      const serialized = JSON.stringify(gatewayBody(body));
      const started = Date.now();
      const request = {}; // 同一会话可能同时有几个请求（Claude Code 主回答 + 后台起标题），按请求记排队，不按会话
      const wait = track ? onWait : () => {};
      wait({ request, sessionTag, waiting: true, since: started, attempt: 1 });
      try {
        let result;
        for (let n = 1; n <= 1 + retries; n++) {
          if (n > 1) { log(`gateway retry ${n - 1} after ${result.failed} (${Date.now() - started}ms)`); wait({ request, sessionTag, waiting: true, since: started, attempt: n }); }
          result = await attempt(serialized, signal);
          if (result.response) break;
        }
        if (!result.response) {
          return result.failed === 'timeout'
            ? ownError(504, `API 网关排队太久：等了 ${Math.round(headerTimeoutMs / 1000)} 秒还没开始回答，已自动重试 ${retries} 次仍未成功。网关可能正忙，请稍后重发，或新建会话换个模型。`)
            : ownError(502, '连不上 API 网关：电脑可能不在公司内网（例如在家没连 VPN），或网关地址不对。连上内网后重发即可。');
        }
        const { response } = result;
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const e = explainGatewayError(response.status, text);
          log(`gateway HTTP ${response.status} -> ${e.code}`);
          return ownError(e.status, e.message, e.status === 429 ? { 'retry-after': response.headers.get('retry-after') || '30' } : {});
        }
        if (!response.body) return response;
        return new Response(normalizeStream(response.body, requestedModel), { status: response.status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      } finally { wait({ request, sessionTag, waiting: false, since: started }); }
    },
  };
}
