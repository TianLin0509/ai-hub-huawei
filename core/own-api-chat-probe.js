'use strict';

// 自有接口「测试连接」第二步（2026-11-25 R45）：按会话真实会走的那条路发一句极短的话。
// 以前只请求 GET /models：部门这类 OpenAI 兼容接口能列出模型，测试就算通过；
// 可 Claude Code 真对话发的是 POST {地址}/v1/messages（Anthropic 格式），Codex 默认发 POST {地址}/responses，
// 这类接口不认，对话时 404 / 405——「连上了却不生效」。这里和会话用同一个地址、同一个 Key、同一个模型、同一种协议。
// 对不上时再试一次 OpenAI chat 格式，能通就告诉界面该怎么改（Claude Code → 改用 API 网关接入；Codex → 改用 chat 协议）。
// Key 只放在请求头里，不写日志、不回给界面。

const TIMEOUT_MS = 30_000;
const errors = () => require('./api-gateway-errors');

// 会话实际请求的地址（与 CLI 拼地址的方式一致）。
function endpointOf(kind, baseURL, wireApi = 'responses') {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (kind === 'claude') return { protocol: 'anthropic', url: base + '/v1/messages' };
  if (kind === 'codex' && wireApi !== 'chat') return { protocol: 'responses', url: base + '/responses' };
  return { protocol: 'chat', url: base + '/chat/completions' };
}

function requestOf(protocol, apiKey, model) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + (apiKey || 'none') };
  if (protocol === 'anthropic') {
    return { headers: { ...headers, 'x-api-key': apiKey || 'none', 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } };
  }
  if (protocol === 'responses') return { headers, body: { model, input: 'ping', max_output_tokens: 16 } };
  return { headers, body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } };
}

async function send({ protocol, url, apiKey, model, fetchImpl, timeoutMs }) {
  const { headers, body } = requestOf(protocol, apiKey, model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, network: error?.name === 'AbortError' ? 'timeout' : 'unreachable', ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

const LABEL = { anthropic: 'Anthropic 格式（/v1/messages）', responses: 'responses 协议（/responses）', chat: 'chat 协议（/chat/completions）' };
const WHO = { claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' };
// 「这条路不存在」：404 不点名模型、405、或 400 里说不认这个路径 / 格式。
const routeMissing = (r, model) => r.status === 405 || (r.status === 404 && !String(r.text || '').toLowerCase().includes(String(model || '').toLowerCase()))
  || (r.status === 400 && /unknown (url|endpoint|path)|not found|unsupported (path|endpoint)|invalid url/i.test(String(r.text || '')));
const own = text => String(text || '').replace(/API 网关|网关/g, '接口');

// 返回 { ok, skipped?, protocol, path, ms, code, message, fix }；fix: 'gateway'（Claude 改走网关）| 'chat'（Codex 改 chat 协议）| ''。
async function probeChat({ kind, baseURL, apiKey = '', model = '', wireApi = 'responses', fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const who = WHO[kind] || kind;
  const { protocol, url } = endpointOf(kind, baseURL, wireApi);
  const path = url.replace(/^https?:\/\/[^/]+/i, '');
  if (!String(model || '').trim()) {
    return { ok: true, skipped: true, protocol, path, code: 'no_model', fix: '', message: `没填模型，没做对话测试：${who} 会用它自己的默认模型发到这个接口。` };
  }
  const passed = (res, extra = {}) => ({ ok: true, protocol, path, ms: res.ms, code: 'ok', fix: '', ...extra,
    message: `对话测试通过：${who} 用 ${LABEL[protocol]} 发一句话，${(res.ms / 1000).toFixed(1)} 秒有回复。` });
  // 原话里出现本次的 Key 时精确抹掉（审查 P2：自定义 Key 不一定长得像 sk-，通用打码认不出）。
  const scrub = text => (String(apiKey || '').length >= 6 ? String(text || '').split(apiKey).join('<已隐去>') : String(text || ''));
  let r = await send({ protocol, url, apiKey, model, fetchImpl, timeoutMs });
  if (r.ok) return passed(r);
  // Claude Code 自己拼 /v1/messages：地址以 /v1 结尾（多半是列模型时补上的）会拼成 /v1/v1/messages。
  // 这条路不存在时去掉末尾 /v1 再测一次；通了就把不带 /v1 的根地址交回去（审查 P1-1）。
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (kind === 'claude' && /\/v1$/i.test(base) && !r.network && routeMissing(r, model)) {
    const root = base.replace(/\/v1$/i, '');
    const again = await send({ protocol, url: endpointOf('claude', root).url, apiKey, model, fetchImpl, timeoutMs });
    const rootPath = endpointOf('claude', root).url.replace(/^https?:\/\/[^/]+/i, '');
    if (again.ok) return passed(again, { baseURL: root, path: rootPath });
    // 根地址这条路是在的，只是回了排队 / 限流 / 模型不对这类业务错：按它说原因，地址仍交回根地址（R45-3 审查 P2-5）。
    if (!again.network && !routeMissing(again, model)) {
      const e = errors().classify({ status: again.status, body: scrub(again.text), model });
      return { ok: false, protocol, path: rootPath, status: again.status, code: e.code, fix: '', baseURL: root,
        message: `对话测试没通过：${own(e.message)}${e.detail && !e.message.includes(e.detail) ? `（接口原话：${own(e.detail)}）` : ''}` };
    }
  }
  if (r.network === 'timeout') {
    return { ok: false, protocol, path, code: 'timeout', fix: '', message: `对话测试 ${Math.round(timeoutMs / 1000)} 秒内没有回复（接口可能在排队）：还不能确认对话可用，稍后再点一次「测试连接」。` };
  }
  if (r.network) return { ok: false, protocol, path, code: 'unreachable', fix: '', message: '对话请求连不上接口：地址不对，或电脑不在能访问它的网络里。' };
  // 路径不存在：再试 OpenAI chat 格式，判断是不是协议对不上。
  if (routeMissing(r, model) && protocol !== 'chat') {
    const alt = await send({ protocol: 'chat', url: endpointOf('deepseek-acp', baseURL).url, apiKey, model, fetchImpl, timeoutMs });
    if (alt.ok) {
      if (kind === 'claude') {
        return { ok: false, protocol, path, status: r.status, code: 'protocol_mismatch', fix: 'gateway',
          message: `这个接口是 OpenAI 格式，不认 Claude Code 用的 ${LABEL.anthropic}（HTTP ${r.status}），直接用会话会报错。点「改用 API 网关接入」，Hub 在本机转格式，地址、Key、模型照用这一份。` };
      }
      return { ok: false, protocol, path, status: r.status, code: 'protocol_mismatch', fix: 'chat',
        message: `这个接口不支持 ${LABEL.responses}（HTTP ${r.status}），只支持 chat 协议，Codex 会话会报错。点「改用 chat 协议」后保存即可。` };
    }
  }
  if (routeMissing(r, model)) {
    return { ok: false, protocol, path, status: r.status, code: 'route_missing', fix: '',
      message: `接口不认 ${who} 的对话请求 ${path}（HTTP ${r.status}）：地址可能多了或少了一级（例如 /v1），请核对接口地址。` };
  }
  const e = errors().classify({ status: r.status, body: scrub(r.text), model });
  return { ok: false, protocol, path, status: r.status, code: e.code, fix: '', message: `对话测试没通过：${own(e.message)}${e.detail && !e.message.includes(e.detail) ? `（接口原话：${own(e.detail)}）` : ''}` };
}

module.exports = { probeChat, endpointOf, TIMEOUT_MS };
