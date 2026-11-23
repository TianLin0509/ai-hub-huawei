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

// 401 = the company service did not accept the login; 403 = it knows who you are but refused this call
// (login revoked elsewhere, no permission for this model, or quota used up). Claude Code adds its own
// "Please run /login" to any 401/403; that would start an Anthropic login, which does not help here.
const HTTP_MEANING = status => status === 400 ? '请求格式不被接受' : status === 401 ? '公司服务不认这次登录'
  : status === 403 ? '公司服务拒绝了这次调用，常见是登录已在别处失效、账号没有这个模型的权限或额度用完'
  : status === 404 ? '接口地址不对' : status === 413 ? '请求太大，上下文太长，公司模型拒收' : status === 429 ? '限流' : status >= 500 ? '公司服务端出错' : '请求被拒绝';
// 413: the conversation has grown past what the company gateway accepts; resending the same request fails again,
// so the advice points at shrinking the context instead of retrying.
const HTTP_ADVICE = status => status === 413 ? '压缩上下文后继续，或新开会话接着聊。'
  : status === 401 ? '打开 CodeAgent 重新登录一下；不用在 Claude Code 里运行 /login。'
  : status === 403 ? '先在 CodeAgent 里用同一个模型发一句试试，不行就重新登录 CodeAgent；不用在 Claude Code 里运行 /login。' : '';

/** Before the stream: the provider threw. -> plain words with the step and a short code. */
export function preStreamMessage(error, { timedOut = false } = {}) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code) ? error.code : '';
  if (timedOut) return '公司模型这次没有回复：等待公司上游超时（请求超过了反代的等待时间）。可以直接重试。';
  const step = failureStep(code);
  return `公司模型这次没有回复：卡在「${step || '调用公司上游'}」这一步${code ? `（${code}）` : ''}。可以直接重试；反复出现请到「设置 → 自有 API」看公司模型反代的状态。`;
}

// Credentials and personal fields an upstream error body may echo back. The detail is shown in the UI and also
// written to diagnostics/company-model-proxy.log (r38b review P1), so it is masked here, before either sees it.
// Separator between a field name and its value: `key: v`, `key=v`, JSON `"key":"v"`, escaped `\"key\":\"v\"`.
const SEP = String.raw`((?:\\*["'])?\s*[:=：]\s*(?:\\*["'])?)`;
// Cookie / Set-Cookie carry many name=value pairs (theme=light; SESSION=…; JSESSIONID=…): mask the whole header
// value up to the end of the line or a quote (r38b re-review P1, 2026-11-18). Authorization schemes such as Digest
// carry several comma-separated parts: mask up to the line end, a quote or `;`.
const COOKIE_HEADER = new RegExp(String.raw`(?<![A-Za-z0-9_-])(set-cookie|cookie)${SEP}[^\r\n"'\\]+`, 'gi');
const AUTH_HEADER = new RegExp(String.raw`(?<![A-Za-z0-9_-])(proxy-authorization|authorization)${SEP}[^\r\n;]+`, 'gi');
const FIELD_NAMES = [
  'x-api-key', String.raw`api[-_]?key`, 'apikey', String.raw`access[-_]?key`, String.raw`secret[-_]?key`, String.raw`private[-_]?key`,
  // Any token / session / ticket style name: access_token, x-csrf-token, SESSION, JSESSIONID, PHPSESSID, ticket, jwt.
  String.raw`[A-Za-z0-9_-]*(?:token(?!s)|session|sessid|ticket|csrf|xsrf|jwt|secret|credential|passw(?:or)?d)[A-Za-z0-9_-]*`,
  'pwd', 'sid', 'signature', 'sign', 'ak', 'sk',
  String.raw`employee(?:[-_]?(?:id|no|number))?`, String.raw`emp[-_]?no`, String.raw`staff[-_]?id`, String.raw`user[-_]?(?:id|name)`,
  'username', 'uid', 'account', '工号', '账号', '口令', '密码',
].join('|');
// A value right after an opening quote runs to the closing quote (a quoted password may contain spaces);
// otherwise it runs to the next space or delimiter, skipping a leading scheme word (Bearer / Basic / Token).
const SECRET_FIELDS = new RegExp(String.raw`(?<![A-Za-z0-9_])(${FIELD_NAMES})${SEP}(?:(?<=["'])[^"'\\\r\n]+|(?:(?:bearer|basic|token)\s+)?[^\s"',;&，；]{2,})`, 'gi');
export function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 <已隐去>')
    .replace(COOKIE_HEADER, '$1$2<已隐去>')
    .replace(AUTH_HEADER, '$1$2<已隐去>')
    .replace(SECRET_FIELDS, '$1$2<已隐去>')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{4,}){1,2}/g, '<令牌已隐去>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>')
    // Long opaque strings (keys, tokens, signatures) and long digit runs (employee or phone numbers).
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, m => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<已隐去>' : m))
    .replace(/(?<![A-Za-z0-9_])[A-Za-z]?\d{7,}(?![A-Za-z0-9_])/g, '<编号已隐去>');
}

// Only short plain text from an upstream error body, with credentials masked and anything URL- or host-like removed.
export function safeUpstreamDetail(text) {
  let message = '';
  try {
    const json = JSON.parse(text);
    // Company gateways answer in several shapes; take the first readable reason, then a bare code.
    const pick = [json?.error?.message, json?.message, json?.msg, json?.errorMessage, json?.error_msg, json?.errMsg,
      json?.detail, json?.error_description, json?.error, json?.data?.message, json?.data?.msg]
      .find(v => typeof v === 'string' && v.trim());
    const code = [json?.error?.code, json?.code, json?.errorCode, json?.error_code, json?.error?.type]
      .find(v => (typeof v === 'string' && v.trim()) || Number.isFinite(v));
    message = pick ? String(pick) : code !== undefined ? `错误码 ${code}` : '';
  } catch {
    // Not JSON: an HTML page here means a gateway or firewall answered, not the model service.
    if (/^\s*<(?:!doctype|html|head|body)/i.test(String(text || ''))) message = '上游回的是网页而不是接口错误，多半是网关或防火墙拦下了';
  }
  message = redactSecrets(message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '').replace(/\b[\w-]+(?:\.[\w-]+){2,}\b/g, '').replace(/\s+/g, ' ').trim();
  return message.slice(0, 160);
}

/** Before the stream: the upstream answered with an HTTP error. */
export function upstreamHttpMessage(status, detail = '') {
  const advice = HTTP_ADVICE(status);
  return `公司模型上游返回 HTTP ${status}（${HTTP_MEANING(status)}）${detail ? '：' + detail : ''}。${advice}`;
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
