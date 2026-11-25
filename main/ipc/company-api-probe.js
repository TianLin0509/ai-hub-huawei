'use strict';

// 自有接口「测试连接」（2026-11-20 起；R45 拆出成独立函数，便于单测串起「补 /v1 → 选模型 → 对话测试」整条路径）。
// 第一步请求一次 /models（不发对话、不耗额度）；Key 留空时用已保存的那份；地址少了 /v1 时自动补上再试。
// 第二步用会话真实会走的协议、同一个地址 / Key / 模型发一句极短的话，「测试通过」才等于「对话能用」。
const companyApi = () => require('../../core/company-api-config');
const PREFERRED = 'deepseek-v4.1-flash';
const pickModel = models => (models.includes(PREFERRED) ? PREFERRED : models[0]);

async function probeOwnApi(request = {}, { raw, fetchImpl = globalThis.fetch, chatTimeoutMs } = {}) {
  const api = companyApi();
  const kind = api.baseKind(request.kind);
  require('../../core/company-ai-policy').assertKind(kind);
  const profile = request.profileId ? require('../../core/cli-api-profiles').profiles(raw, kind).find(p => p.id === request.profileId) : null;
  if (request.profileId && !profile) return { ok: false, error: '这个 API 账号已不存在，请重新打开设置再试。' };
  const stored = profile || api.connection(raw, kind);
  if (!String(request.apiKey || '').trim()) require('../../core/own-api-secrets').assertReadable(stored);
  const base = api.baseUrl(request.baseURL);
  // 已保存的 Key 只发往它保存时的地址（Codex 审查 P1）：地址改了就要重新粘贴 Key，免得把 Key 发到别处。
  const same = (a, b) => String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();
  const savedFits = stored.apiKey && stored.baseURL && (same(stored.baseURL, base) || same(stored.baseURL, base + '/v1'));
  if (!String(request.apiKey || '').trim() && stored.apiKey && !savedFits) return { ok: false, code: 'key_needed', error: '接口地址和保存时不一样了：已保存的 Key 只会发往原来的地址。请在「API Key」里重新粘贴 Key 再测试。' };
  const apiKey = String(request.apiKey || '').trim() || (savedFits ? stored.apiKey : '');
  // 自有接口不是网关：网关口径的人话里「网关」换成「接口」。
  const own = text => String(text || '').replace(/API 网关|网关/g, '接口');
  const gateway = require('../../core/api-gateway');
  let result = await gateway.probe({ baseURL: base, apiKey: apiKey || 'none', fetchImpl });
  let listBase = base;
  if (!result.ok && ['http_404', 'no_models'].includes(result.code) && !/\/v\d+$/.test(base)) {
    const retry = await gateway.probe({ baseURL: base + '/v1', apiKey: apiKey || 'none', fetchImpl });
    if (retry.ok) { result = retry; listBase = base + '/v1'; }
  }
  if (!result.ok) return { ok: false, code: result.code, error: own(result.message) };
  // 协议：表单里选的优先，没传就用保存过的（审查 P2）。
  const wireApi = (request.wireApi || stored.wireApi) === 'chat' ? 'chat' : 'responses';
  const chatProbe = model => require('../../core/own-api-chat-probe').probeChat({ kind, baseURL: listBase, apiKey, model, wireApi, fetchImpl,
    ...(chatTimeoutMs ? { timeoutMs: chatTimeoutMs } : {}) });
  // 模型框留空：自动填接口上的推荐模型并测对话（开箱即用）。
  const wanted = String(request.model || '').trim();
  let model = wanted || pickModel(result.models);
  let chat = await chatProbe(model);
  // 换了接口地址、框里还是旧接口的模型（新接口列表里没有）且测不通：改选新接口的模型重测（审查 P1-2）。
  // 手填的隐藏模型能测通就照用，不改。
  let replaced = '';
  if (wanted && !result.models.includes(wanted) && !chat.ok && chat.code !== 'protocol_mismatch') {
    replaced = wanted;
    model = pickModel(result.models);
    chat = await chatProbe(model);
  }
  // 最终地址：对话测试给出的（Claude 去掉多余 /v1）优先，其次是列模型时补的 /v1；和用户填的一样就不回传。
  const finalBase = chat.baseURL || listBase;
  const baseChange = finalBase === base ? '' : finalBase === base + '/v1' ? 'added-v1' : 'removed-v1';
  const { baseURL: _chatBase, ...chatView } = chat;
  return { ok: true, models: result.models, model, chat: chatView, ...(replaced ? { replacedModel: replaced } : {}),
    ...(baseChange ? { baseURL: finalBase, baseChange } : {}), keyUsed: apiKey ? (request.apiKey ? 'typed' : 'saved') : 'none' };
}

module.exports = { probeOwnApi };
