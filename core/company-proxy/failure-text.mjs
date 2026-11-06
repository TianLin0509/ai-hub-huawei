// Plain-words failure reasons for the company-model proxy, and the protocol-defined way to report a failure
// after a streaming response has already started (headers sent):
//   Anthropic Messages  -> event: error         data: { type: 'error', error: { type, message } }
//   OpenAI Responses    -> event: response.failed data: { type, response: { status: 'failed', error: { code, message } } }
//   Chat Completions    -> data: { error: { type, message } }   (what OpenAI-compatible SDKs read as a stream error)
// Messages name the step that failed (login, identity, signature, network to the upstream, upstream HTTP status,
// timeout, broken stream); they never carry upstream bodies, URLs, tokens or prompts.

const STEPS = [
  [/ACCESS_TOKEN|CREDENTIAL|LOGIN/, '读取登录信息（CodeAgent 登录可能过期，打开 CodeAgent 登录一下）'],
  [/IDENTITY/, '身份校验（向公司服务确认登录身份）'],
  [/SIGNATURE|SIGNER|KERNEL/, '请求签名（CodeAgent 签名模块）'],
  [/TIMEOUT|DEADLINE/, '等待公司上游超时'],
  [/GENERATION_REQUEST_FAILED|L1_REQUEST_FAILED|DISPATCH/, '连接公司模型服务（网络或代理不通）'],
  [/MODEL_NOT_ALLOWED|MODEL_UNVERIFIED|MODEL_MAPPING/, '选择模型（这个模型不在公司可用清单里）'],
  [/^L1_(MESSAGE|TOOL|REQUEST|STOP|TEMPERATURE|MAX_TOKENS|THINKING|STREAM|INCLUDE|CODEX|REASONING)/, '整理请求（请求里有公司接口不支持的内容）'],
];

export function failureStep(code = '') {
  const text = String(code || '');
  for (const [pattern, step] of STEPS) if (pattern.test(text)) return step;
  return '';
}

const HTTP_MEANING = status => status === 400 ? '请求格式不被接受' : status === 401 || status === 403 ? '登录或权限被拒绝（打开 CodeAgent 重新登录一下）'
  : status === 404 ? '接口地址不对' : status === 413 ? '请求太大' : status === 429 ? '限流' : status >= 500 ? '公司服务端出错' : '请求被拒绝';

/** Before the stream: the provider threw. -> plain words with the step and a short code. */
export function preStreamMessage(error, { timedOut = false } = {}) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code) ? error.code : '';
  if (timedOut) return '公司模型这次没有回复：等待公司上游超时（请求超过了反代的等待时间）。可以直接重试。';
  const step = failureStep(code);
  return `公司模型这次没有回复：卡在「${step || '调用公司上游'}」这一步${code ? `（${code}）` : ''}。可以直接重试；反复出现请到「设置 → 自有 API」看公司模型反代的状态。`;
}

// Only short plain text from an upstream error body, with anything URL- or host-like removed.
export function safeUpstreamDetail(text) {
  let message = '';
  try {
    const json = JSON.parse(text);
    const m = json?.error?.message ?? json?.message ?? json?.msg ?? json?.error;
    if (typeof m === 'string') message = m;
  } catch { /* not JSON: no detail */ }
  message = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').replace(/\b[\w-]+(?:\.[\w-]+){2,}\b/g, '').replace(/\s+/g, ' ').trim();
  return message.slice(0, 160);
}

/** Before the stream: the upstream answered with an HTTP error. */
export function upstreamHttpMessage(status, detail = '') {
  return `公司模型上游返回 HTTP ${status}（${HTTP_MEANING(status)}）${detail ? '：' + detail : ''}。`;
}

/** After the stream started: why it broke, in plain words. */
export function midStreamMessage(error, { timedOut = false } = {}) {
  if (timedOut) return '公司模型的回复中途超时断开（超过了反代的等待时间），这一轮没有完成，请重试。';
  const raw = String(error?.message || error?.code || '');
  const why = /DONE|finish_reason|Truncated|ended/i.test(raw) ? '上游的流没有正常结束'
    : /JSON/i.test(raw) ? '上游发来了无法解析的内容'
      : /tool/i.test(raw) ? '上游返回的工具调用不完整'
        : /stream error|Upstream stream error/i.test(raw) ? '上游在流里报了错'
          : '和公司上游的连接中途断开';
  return `公司模型的回复中途失败：${why}，这一轮没有完成，请重试。`;
}

export function anthropicErrorEvent(message, type = 'api_error') {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;
}
export function chatErrorFrame(message, type = 'upstream_error') {
  return `data: ${JSON.stringify({ error: { type, message } })}\n\n`;
}
export function responsesFailedEvent(message, response = {}, sequence = undefined) {
  const body = { type: 'response.failed', ...(sequence === undefined ? {} : { sequence_number: sequence }),
    response: { ...response, status: 'failed', error: { code: 'server_error', message } } };
  return `event: response.failed\ndata: ${JSON.stringify(body)}\n\n`;
}
/** The protocol-defined error frame for a path, used once the response has started. */
export function errorFrameFor(pathname, message) {
  if (pathname === '/v1/messages') return anthropicErrorEvent(message);
  if (pathname === '/v1/responses') return responsesFailedEvent(message, { object: 'response' });
  return chatErrorFrame(message);
}
