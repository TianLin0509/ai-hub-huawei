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
function connection(raw, kind) {
  if (kind === 'deepseek-acp') return raw.acp?.companyApi || {};
  const p = raw.providers?.[kind] || {};
  if (p.backend !== 'api') return {};
  return { baseURL: p.base_url || '', apiKey: p.api_key || '', model: p.model || '', wireApi: p.wire_api || 'responses' };
}
function settings(raw = {}) {
  return Object.fromEntries(KINDS.map(kind => {
    const p = connection(raw, kind);
    return [kind, { baseURL: p.baseURL || '', apiKeySet: !!p.apiKey, model: p.model || '',
      ...(kind === 'codex' ? { wireApi: p.wireApi || 'responses' } : {}) }];
  }));
}
function withSettings(raw, request = {}) {
  const kind = baseKind(request.kind);
  if (!KINDS.includes(kind)) throw new Error('不支持的 API 类型');
  const previous = request.useLocal ? {} : connection(raw, kind);
  if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
  const p = request.useLocal ? { baseURL: '', apiKey: '', model: '' } : {
    baseURL: request.baseURL?.trim() ? baseUrl(request.baseURL) : '',
    apiKey: optionalText(request.apiKey?.trim() || previous.apiKey, 'API Key'),
    model: optionalText(request.model, '模型名称') };
  if (kind === 'codex' && (p.apiKey || p.model) && !p.baseURL) throw new Error('Codex 自有 API 请填写接口地址；或选择沿用本机配置');
  if (kind === 'deepseek-acp') return { ...raw, acp: { ...raw.acp, companyApi: p } };
  return { ...raw, providers: { ...raw.providers, [kind]: { ...raw.providers?.[kind], backend: 'api',
    base_url: p.baseURL, api_key: p.apiKey, model: p.model,
    ...(kind === 'codex' ? { wire_api: wireApi(request.wireApi || previous.wireApi || 'responses') } : {}) } } };
}
function applyCompanyConfig(config, raw) {
  if (!isCompany()) return config;
  config.companyCli = true;
  for (const kind of ['claude', 'codex']) {
    const p = connection(raw, kind);
    config[kind + 'Backend'] = (p.baseURL || p.apiKey || p.model) ? 'api' : 'local';
    config[kind + 'ApiKey'] = p.apiKey || '';
    config[kind + 'ApiBaseUrl'] = p.baseURL || '';
    config[kind + 'ApiModel'] = p.model || '';
    config[kind + 'SubscriptionProfiles'] = [];
  }
  config.codexApiWireApi = connection(raw, 'codex').wireApi || 'responses';
  config.proxy = '';
  return config;
}
function assertLaunchConfigured(kind, config) {
  kind = baseKind(kind);
  if (!isCompany() || !KINDS.includes(kind)) return;
  if (kind === 'deepseek-acp') {
    throw new Error('DSH 公司自有接口尚未完成接入，请先使用 Claude Code 或 Codex。');
  }
  if (config[kind + 'ApiBaseUrl']) baseUrl(config[kind + 'ApiBaseUrl']);
  optionalText(config[kind + 'ApiKey'], 'API Key');
  optionalText(config[kind + 'ApiModel'], '模型名称');
  if (kind === 'codex' && (config.codexApiKey || config.codexApiModel) && !config.codexApiBaseUrl) throw new Error('Codex 自有 API 请填写接口地址');
  if (kind === 'codex') wireApi(config.codexApiWireApi || 'responses');
}

module.exports = { KINDS, LABELS, baseKind, isCompany, wireApi, baseUrl, optionalText, settings, withSettings, applyCompanyConfig, assertLaunchConfigured };
