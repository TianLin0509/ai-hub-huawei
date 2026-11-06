'use strict';

// Company connections are explicit local API settings. Subscription credentials
// and the parent Hub's environment are not a fallback for an incomplete form.
const KINDS = Object.freeze(['claude', 'codex', 'deepseek-acp']);
const LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' });
const baseKind = kind => String(kind || '').replace(/-resume$/, '');
const isCompany = () => require('./distribution').target === 'company';
function wireApi(value = 'responses') {
  if (!['responses', 'chat'].includes(value)) throw new Error('Codex 协议请选择 responses 或 chat');
  return value;
}
function text(value, name) {
  if (typeof value !== 'string') throw new Error(`请填写${name}`);
  const result = value.trim();
  if (!result || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`请填写有效的${name}`);
  return result;
}
function optionalText(value, name) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name}格式无效`);
  return value.trim() ? text(value, name) : '';
}
function baseUrl(value) {
  const result = text(value, '接口地址').replace(/\/+$/, '');
  let url;
  try { url = new URL(result); } catch { throw new Error('接口地址必须是完整的 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('接口地址必须是 HTTP 或 HTTPS 地址，且不能包含账号、密码或片段');
  }
  return result;
}
// 后端三种：local（沿用 CLI 本机配置）、api（自有接口）、proxy（公司模型，经本机反代用 CodeAgent 账号，
// 见 core/company-model-proxy.js）。proxy 只存模型名，地址和 Key 由 Hub 在启动会话时给。
const proxyModels = () => require('./company-model-proxy');
function connection(raw, kind) {
  if (kind === 'deepseek-acp') {
    const c = raw.acp?.companyApi || {};
    return c.backend === 'proxy' ? { backend: 'proxy', model: c.model || '' } : c;
  }
  const p = raw.providers?.[kind] || {};
  if (p.backend === 'proxy') return { backend: 'proxy', model: p.model || '' };
  if (p.backend !== 'api') return {};
  return { baseURL: p.base_url || '', apiKey: p.api_key || '', model: p.model || '', wireApi: p.wire_api || 'responses' };
}
function backendOf(p) { return p.backend === 'proxy' ? 'proxy' : (p.baseURL || p.apiKey || p.model) ? 'api' : 'local'; }
// The tool's own source while company models are chosen (kept so the launch center can switch back in one click).
function ownStash(raw, kind) {
  if (kind === 'deepseek-acp') return null;
  const o = raw.providers?.[kind]?.own_api;
  return o && typeof o === 'object' ? { baseURL: o.base_url || '', apiKey: o.api_key || '', model: o.model || '', wireApi: o.wire_api || 'responses' } : null;
}
// own: what the launch center's own-source card starts (Claude/Codex): 自有接口 (api) with its model, or CLI 默认 (local).
function ownSource(raw, kind) {
  if (kind === 'deepseek-acp') return null;
  const p = connection(raw, kind);
  const o = p.backend === 'proxy' ? ownStash(raw, kind) || {} : p;
  return { backend: (o.baseURL || o.apiKey || o.model) ? 'api' : 'local', model: o.model || '' };
}
function settings(raw = {}) {
  return Object.fromEntries(KINDS.map(kind => {
    const p = connection(raw, kind);
    const common = { companyModels: proxyModels().MODELS.map(m => ({ ...m })), own: ownSource(raw, kind) };
    if (p.backend === 'proxy') return [kind, { backend: 'proxy', baseURL: '', apiKeySet: false, model: p.model || proxyModels().DEFAULT_MODEL,
      models: proxyModels().MODELS.map(m => ({ ...m })), ...common, ...(kind === 'codex' ? { wireApi: 'responses' } : {}) }];
    return [kind, { backend: backendOf(p), baseURL: p.baseURL || '', apiKeySet: !!p.apiKey, model: p.model || '', ...common,
      ...(kind === 'codex' ? { wireApi: p.wireApi || 'responses' } : {}) }];
  }));
}
function anyProxy(raw = {}) { return KINDS.some(kind => connection(raw, kind).backend === 'proxy'); }
function withSettings(raw, request = {}) {
  const kind = baseKind(request.kind);
  if (!KINDS.includes(kind)) throw new Error('不支持的 API 类型');
  if (request.backend === 'proxy') {
    const model = proxyModels().normalizeModel(request.model);
    if (kind === 'deepseek-acp') return { ...raw, acp: { ...raw.acp, companyApi: { backend: 'proxy', model } } };
    const { base_url, api_key, wire_api, own_api, ...rest } = raw.providers?.[kind] || {};
    // Keep the tool's own interface (address, Key, model) to switch back to it later from the launch center.
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? own_api : (current.baseURL || current.apiKey || current.model)
      ? { base_url: current.baseURL, api_key: current.apiKey, model: current.model, ...(kind === 'codex' ? { wire_api: current.wireApi } : {}) } : null;
    return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, backend: 'proxy', model, ...(own ? { own_api: own } : {}) } } };
  }
  // Launch center "own source" card: back to the kept own interface, or to the CLI's own configuration.
  if (request.backend === 'own') {
    if (kind === 'deepseek-acp') throw new Error('DSH 在公司版只能用公司模型');
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? ownStash(raw, kind) : current;
    const { own_api, ...rest } = raw.providers?.[kind] || {};
    const p = own && (own.baseURL || own.apiKey || own.model) ? own : { baseURL: '', apiKey: '', model: '', wireApi: 'responses' };
    return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, backend: 'api', base_url: p.baseURL, api_key: p.apiKey, model: p.model,
      ...(kind === 'codex' ? { wire_api: wireApi(p.wireApi || 'responses') } : {}) } } };
  }
  const previous = request.useLocal || connection(raw, kind).backend === 'proxy' ? {} : connection(raw, kind);
  if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
  const p = request.useLocal ? { baseURL: '', apiKey: '', model: '' } : {
    baseURL: request.baseURL?.trim() ? baseUrl(request.baseURL) : '',
    apiKey: optionalText(request.apiKey?.trim() || previous.apiKey, 'API Key'),
    model: optionalText(request.model, '模型名称') };
  if (kind === 'codex' && (p.apiKey || p.model) && !p.baseURL) throw new Error('Codex 自有 API 请填写接口地址；或选择沿用本机配置');
  if (kind === 'deepseek-acp') return { ...raw, acp: { ...raw.acp, companyApi: p } };
  // 切回自有接口或本机配置时，不留 proxy 标记。
  const { own_api: _ownApi, ...kept } = raw.providers?.[kind] || {};
  return { ...raw, providers: { ...raw.providers, [kind]: { ...kept, backend: 'api',
    base_url: p.baseURL, api_key: p.apiKey, model: p.model,
    ...(kind === 'codex' ? { wire_api: wireApi(request.wireApi || previous.wireApi || 'responses') } : {}) } } };
}
function applyCompanyConfig(config, raw) {
  if (!isCompany()) return config;
  config.companyCli = true;
  for (const kind of ['claude', 'codex']) {
    const p = connection(raw, kind);
    config[kind + 'Backend'] = backendOf(p);
    config[kind + 'ApiKey'] = p.apiKey || '';
    config[kind + 'ApiBaseUrl'] = p.baseURL || '';
    config[kind + 'ApiModel'] = p.model || '';
    config[kind + 'SubscriptionProfiles'] = [];
  }
  config.codexApiWireApi = connection(raw, 'codex').wireApi || 'responses';
  const dsh = connection(raw, 'deepseek-acp');
  config.dshBackend = dsh.backend === 'proxy' ? 'proxy' : 'local';
  config.dshApiModel = dsh.backend === 'proxy' ? (dsh.model || proxyModels().DEFAULT_MODEL) : '';
  config.companyProxyEnabled = anyProxy(raw);
  config.proxy = '';
  return config;
}
function assertLaunchConfigured(kind, config) {
  kind = baseKind(kind);
  if (!isCompany() || !KINDS.includes(kind)) return;
  if (kind === 'deepseek-acp') {
    if (config.dshBackend === 'proxy') return;
    throw new Error('DSH 请先在「自有 API」里选择「公司模型（经本机反代）」，或先使用 Claude Code、Codex。');
  }
  if (config[kind + 'Backend'] === 'proxy') { if (config[kind + 'ApiModel']) proxyModels().normalizeModel(config[kind + 'ApiModel']); return; }
  if (config[kind + 'ApiBaseUrl']) baseUrl(config[kind + 'ApiBaseUrl']);
  optionalText(config[kind + 'ApiKey'], 'API Key');
  optionalText(config[kind + 'ApiModel'], '模型名称');
  if (kind === 'codex' && (config.codexApiKey || config.codexApiModel) && !config.codexApiBaseUrl) throw new Error('Codex 自有 API 请填写接口地址');
  if (kind === 'codex') wireApi(config.codexApiWireApi || 'responses');
}

module.exports = { KINDS, LABELS, baseKind, isCompany, wireApi, baseUrl, optionalText, settings, withSettings, applyCompanyConfig, assertLaunchConfigured, anyProxy, connection };
