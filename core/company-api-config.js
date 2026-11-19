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
// 后端三种：local（沿用 CLI 本机配置）、api（自有接口）、proxy（经本机反代，见 core/company-model-proxy.js）。
// proxy 下的上游两种（2026-11-19）：company（公司模型，用 CodeAgent 账号，默认）、gateway（API 网关，用部门 API key，
// 见 core/api-gateway.js）。proxy 只存模型名和上游，地址和 Key 由 Hub 在启动会话时给。
const proxyModels = () => require('./company-model-proxy');
const gatewayStore = () => require('./api-gateway');
const dataDir = () => require('./data-dir').getHubDataDir();
const upstreamOf = c => (c?.upstream === 'gateway' ? 'gateway' : 'company');
function connection(raw, kind) {
  if (kind === 'deepseek-acp') {
    const c = raw.acp?.companyApi || {};
    if (c.backend === 'proxy') return { backend: 'proxy', model: c.model || '', upstream: upstreamOf(c) };
    return c.baseURL || c.apiKey || c.model ? { baseURL: c.baseURL || '', apiKey: c.apiKey || '', model: c.model || '' } : {};
  }
  const p = raw.providers?.[kind] || {};
  if (p.backend === 'proxy') return { backend: 'proxy', model: p.model || '', upstream: upstreamOf(p) };
  if (p.backend !== 'api') return {};
  return { baseURL: p.base_url || '', apiKey: p.api_key || '', model: p.model || '', wireApi: p.wire_api || 'responses' };
}
function backendOf(p) { return p.backend === 'proxy' ? 'proxy' : (p.baseURL || p.apiKey || p.model) ? 'api' : 'local'; }
// The tool's own source while company models are chosen (kept so the launch center can switch back in one click).
function ownStash(raw, kind) {
  const o = kind === 'deepseek-acp' ? raw.acp?.companyApi?.own_api : raw.providers?.[kind]?.own_api;
  return o && typeof o === 'object' ? { baseURL: o.base_url || '', apiKey: o.api_key || '', model: o.model || '', wireApi: o.wire_api || 'responses' } : null;
}
// own: what the launch center's own-source card starts (Claude/Codex): 自有接口 (api) with its model, or CLI 默认 (local).
// DSH（2026-11-20）：公司版 DSH 没有「CLI 本机配置」可沿用，自有来源只有自有接口；没填过就是 local（启动中心不显示自有卡）。
function ownSource(raw, kind) {
  const p = connection(raw, kind);
  const o = p.backend === 'proxy' ? ownStash(raw, kind) || {} : p;
  return { backend: (o.baseURL || o.apiKey || o.model) ? 'api' : 'local', model: o.model || '' };
}
// 网关的界面视图（不含 Key）：各工具共用一份地址、Key 和模型表。
function gatewayView() {
  try { const dir = dataDir(); return { ...gatewayStore().read(dir), choices: gatewayStore().modelChoices(dir) }; }
  catch { return { baseURL: gatewayStore().DEFAULT_BASE_URL, keySet: false, models: [], model: gatewayStore().PREFERRED_MODEL, choices: [] }; }
}
function settings(raw = {}) {
  const sessions = isCompany() ? require('./state-store').load().sessions : [];
  return Object.fromEntries(KINDS.map(kind => {
    const p = connection(raw, kind);
    const gw = gatewayView();
    const common = { companyModels: proxyModels().MODELS.map(m => ({ ...m })), own: ownSource(raw, kind),
      // 网关配好了才带：启动中心据此显示「API 网关」模型卡（2026-11-19）。
      ...(gw.keySet ? { gatewayModels: gw.choices.map(c => ({ id: c.id, label: c.label, note: c.note })) } : {}),
      ...(raw.providers?.[kind]?.api_profiles?.length ? { apiProfiles: require('./cli-api-profiles').publicProfiles(raw, kind),
        selectedProfileId: raw.providers[kind].selected_api_profile || '' } : {}),
      companyDefault: isCompany() && !raw.providers?.[kind]?.backend && !sessions.some(session => baseKind(session.kind) === kind) };
    if (p.backend === 'proxy') return [kind, { backend: 'proxy', upstream: p.upstream, baseURL: '', apiKeySet: false,
      model: p.model || (p.upstream === 'gateway' ? gatewayStore().read(dataDir()).model : proxyModels().DEFAULT_MODEL),
      models: proxyModels().MODELS.map(m => ({ ...m })), ...common, ...(kind === 'codex' ? { wireApi: 'responses' } : {}) }];
    return [kind, { backend: backendOf(p), baseURL: p.baseURL || '', apiKeySet: !!p.apiKey, model: p.model || '', ...common,
      ...(kind === 'codex' ? { wireApi: p.wireApi || 'responses' } : {}) }];
  }));
}
function anyProxy(raw = {}) { return KINDS.some(kind => connection(raw, kind).backend === 'proxy'); }
function anyGateway(raw = {}) { return KINDS.some(kind => { const c = connection(raw, kind); return c.backend === 'proxy' && c.upstream === 'gateway'; }); }
function withSettings(raw, request = {}) {
  const kind = baseKind(request.kind);
  if (!KINDS.includes(kind)) throw new Error('不支持的 API 类型');
  if (request.profileAction) return require('./cli-api-profiles').withProfile(raw, request);
  if (request.backend === 'proxy' || request.backend === 'gateway') {
    // 「API 网关」也是经本机反代，只是上游换成网关；模型名按网关模型表解析，不套公司模型的名字。
    const gateway = request.backend === 'gateway';
    if (gateway && !gatewayStore().configured(dataDir())) throw new Error('请先在「API 网关」里粘贴 API key 并保存');
    const model = gateway ? gatewayStore().resolveModel(dataDir(), request.model) : proxyModels().normalizeModel(request.model);
    const upstream = gateway ? { upstream: 'gateway' } : {};
    if (kind === 'deepseek-acp') {
      // 切到公司模型或 API 网关时留住 DSH 的自有接口，启动中心一键切回（2026-11-20）。
      const cur = raw.acp?.companyApi || {};
      const keep = cur.backend === 'proxy' ? cur.own_api : (cur.baseURL || cur.apiKey || cur.model) ? { base_url: cur.baseURL || '', api_key: cur.apiKey || '', model: cur.model || '' } : null;
      return { ...raw, acp: { ...raw.acp, companyApi: { backend: 'proxy', model, ...upstream, ...(keep ? { own_api: keep } : {}) } } };
    }
    const { base_url, api_key, wire_api, own_api, upstream: _upstream, ...rest } = raw.providers?.[kind] || {};
    // Keep the tool's own interface (address, Key, model) to switch back to it later from the launch center.
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? own_api : (current.baseURL || current.apiKey || current.model)
      ? { base_url: current.baseURL, api_key: current.apiKey, model: current.model, ...(kind === 'codex' ? { wire_api: current.wireApi } : {}) } : null;
    return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, backend: 'proxy', model, ...upstream, ...(own ? { own_api: own } : {}) } } };
  }
  // Launch center "own source" card: back to the kept own interface, or to the CLI's own configuration.
  if (request.backend === 'own') {
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? ownStash(raw, kind) : current;
    if (kind === 'deepseek-acp') {
      if (!own?.baseURL) throw new Error('DSH 还没有保存过自有接口：请到「设置 → 自有 API → DSH → 自有接口」填写地址和模型');
      return { ...raw, acp: { ...raw.acp, companyApi: { baseURL: own.baseURL, apiKey: own.apiKey || '', model: own.model || '' } } };
    }
    const { own_api, upstream: _up, ...rest } = raw.providers?.[kind] || {};
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
  const { own_api: _ownApi, upstream: _upstream, ...kept } = raw.providers?.[kind] || {};
  return { ...raw, providers: { ...raw.providers, [kind]: { ...kept, backend: 'api',
    base_url: p.baseURL, api_key: p.apiKey, model: p.model, ...(kept.selected_api_profile ? { selected_api_profile: '' } : {}),
    ...(kind === 'codex' ? { wire_api: wireApi(request.wireApi || previous.wireApi || 'responses') } : {}) } } };
}
function applyCompanyConfig(config, raw) {
  if (!isCompany()) return config;
  config.companyCli = true;
  for (const kind of ['claude', 'codex']) {
    const p = connection(raw, kind);
    config[kind + 'Backend'] = backendOf(p);
    config[kind + 'Upstream'] = p.backend === 'proxy' ? p.upstream : '';
    config[kind + 'ApiKey'] = p.apiKey || '';
    config[kind + 'ApiBaseUrl'] = p.baseURL || '';
    config[kind + 'ApiModel'] = p.model || '';
    config[kind + 'SubscriptionProfiles'] = [];
  }
  config.codexApiWireApi = connection(raw, 'codex').wireApi || 'responses';
  const dsh = connection(raw, 'deepseek-acp');
  // DSH 自有接口（2026-11-20）：填了接口地址就直连（core/company-model-proxy.js dshOwnRoute），不再一律当「没配」。
  config.dshBackend = dsh.backend === 'proxy' ? 'proxy' : dsh.baseURL ? 'api' : 'local';
  config.dshUpstream = dsh.backend === 'proxy' ? dsh.upstream : '';
  config.dshApiModel = dsh.backend === 'proxy' ? (dsh.model || (dsh.upstream === 'gateway' ? gatewayStore().PREFERRED_MODEL : proxyModels().DEFAULT_MODEL)) : dsh.model || '';
  config.dshApiBaseUrl = config.dshBackend === 'api' ? dsh.baseURL : '';
  config.dshApiKey = config.dshBackend === 'api' ? dsh.apiKey || '' : '';
  config.companyProxyEnabled = anyProxy(raw);
  config.proxy = '';
  return config;
}
function assertLaunchConfigured(kind, config) {
  kind = baseKind(kind);
  if (!isCompany() || !KINDS.includes(kind)) return;
  const gatewayReady = () => { if (!gatewayStore().configured(dataDir())) throw new Error('API 网关还没配置好：请到「设置 → 模型线路 → API 网关」粘贴 key 并保存。'); };
  if (kind === 'deepseek-acp') {
    if (config.dshBackend === 'proxy') { if (config.dshUpstream === 'gateway') gatewayReady(); return; }
    if (config.dshBackend === 'api') {
      baseUrl(config.dshApiBaseUrl);
      if (!config.dshApiModel) throw new Error('DSH 自有接口还没填模型名：请到「设置 → 自有 API → DSH → 自有接口」点「测试连接」选一个模型后保存。');
      return;
    }
    throw new Error('DSH 还没选模型来源：请到「设置 → 自有 API → DSH」选「API 网关」（部门发的 key）、「公司模型」（CodeAgent 账号）或「自有接口」（自己的 OpenAI 兼容地址）。');
  }
  if (config[kind + 'Backend'] === 'proxy') {
    if (config[kind + 'Upstream'] === 'gateway') { gatewayReady(); return; }
    if (config[kind + 'ApiModel']) proxyModels().normalizeModel(config[kind + 'ApiModel']);
    return;
  }
  if (config[kind + 'ApiBaseUrl']) baseUrl(config[kind + 'ApiBaseUrl']);
  optionalText(config[kind + 'ApiKey'], 'API Key');
  optionalText(config[kind + 'ApiModel'], '模型名称');
  if (kind === 'codex' && (config.codexApiKey || config.codexApiModel) && !config.codexApiBaseUrl) throw new Error('Codex 自有 API 请填写接口地址');
  if (kind === 'codex') wireApi(config.codexApiWireApi || 'responses');
}

module.exports = { KINDS, LABELS, baseKind, isCompany, wireApi, baseUrl, optionalText, settings, withSettings, applyCompanyConfig, assertLaunchConfigured, anyProxy, anyGateway, connection, gatewayView };
