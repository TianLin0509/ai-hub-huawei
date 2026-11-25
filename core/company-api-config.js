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
const secrets = require('./own-api-secrets');
// 一个自有接口可配多个模型（R45，11-24 反馈「自有接口的模型只能选一个」）：model 是默认模型，模型表（model_list）是启动中心可选的全部。
// 老配置没有模型表时等于只有默认模型这一个，照常能用。模型名口径与网关一致，再放宽括号（公司模型名里有）。
const MODEL_LIST_MAX = 50;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/()+@-]{0,127}$/;
function modelList(value, first = '') {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，;；]+/) : [];
  const out = [];
  for (const raw of [first, ...items]) {
    const id = String(raw || '').trim();
    if (!id || out.includes(id)) continue;
    if (!MODEL_NAME.test(id)) throw new Error(`模型名「${id.slice(0, 40)}」格式不对：只能用字母、数字和 . _ : / - ( ) + @，不能有空格`);
    out.push(id);
  }
  return out.slice(0, MODEL_LIST_MAX);
}
const listOf = (value, first = '') => { try { return modelList(value, first); } catch { return first ? [first] : []; } };
const withList = (list, model) => (list.length > 1 || (list.length === 1 && list[0] !== model) ? list : null);
const keyState = (p, key = 'apiKey', cipher = 'encryptedApiKey') => p[key + 'NeedsInput']
  ? { apiKeyNeedsInput: true, encryptedApiKey: p[cipher] } : {};
function connection(raw, kind) {
  if (kind === 'deepseek-acp') {
    const c = raw.acp?.companyApi || {};
    if (c.backend === 'proxy') return { backend: 'proxy', model: c.model || '', upstream: upstreamOf(c) };
    return c.baseURL || c.apiKey || c.model ? { baseURL: c.baseURL || '', apiKey: c.apiKey || '', model: c.model || '', modelList: listOf(c.modelList, c.model), ...keyState(c) } : {};
  }
  const p = raw.providers?.[kind] || {};
  if (p.backend === 'proxy') return { backend: 'proxy', model: p.model || '', upstream: upstreamOf(p) };
  if (p.backend !== 'api') return {};
  return { baseURL: p.base_url || '', apiKey: p.api_key || '', model: p.model || '', modelList: listOf(p.model_list, p.model), wireApi: p.wire_api || 'responses', ...keyState(p, 'api_key', 'encrypted_api_key') };
}
function backendOf(p) { return p.backend === 'proxy' ? 'proxy' : (p.baseURL || p.apiKey || p.model) ? 'api' : 'local'; }
// The tool's own source while company models are chosen (kept so the launch center can switch back in one click).
function ownStash(raw, kind) {
  const o = kind === 'deepseek-acp' ? raw.acp?.companyApi?.own_api : raw.providers?.[kind]?.own_api;
  return o && typeof o === 'object' ? { baseURL: o.base_url || '', apiKey: o.api_key || '', model: o.model || '', modelList: listOf(o.model_list, o.model), wireApi: o.wire_api || 'responses', ...keyState(o, 'api_key', 'encrypted_api_key') } : null;
}
// own: what the launch center's own-source card starts (Claude/Codex): 自有接口 (api) with its model, or CLI 默认 (local).
// DSH（2026-11-20）：公司版 DSH 没有「CLI 本机配置」可沿用，自有来源只有自有接口；没填过就是 local（启动中心不显示自有卡）。
function ownSource(raw, kind) {
  const p = connection(raw, kind);
  const o = p.backend === 'proxy' ? ownStash(raw, kind) || {} : p;
  return { backend: (o.baseURL || o.apiKey || o.model) ? 'api' : 'local', model: o.model || '', ...(o.modelList?.length > 1 ? { models: o.modelList } : {}) };
}
// 网关的界面视图（不含 Key）：各工具共用一份地址、Key 和模型表。
function gatewayView() {
  // 手填测通的模型（11-24 起可加）也进可选表，启动中心和设置里都能选到（R45，11-23 反馈「只会检测搜索到的，不能完全自定义」）。
  try {
    const dir = dataDir(), view = gatewayStore().read(dir);
    return { ...view, choices: [...gatewayStore().modelChoices(dir), ...(view.customModels || []).map(id => ({ id, label: id, note: '手填 · 已测通' }))] };
  }
  catch { return { baseURL: gatewayStore().DEFAULT_BASE_URL, keySet: false, models: [], model: gatewayStore().PREFERRED_MODEL, choices: [] }; }
}
function settings(raw = {}) {
  const sessions = isCompany() ? require('./state-store').load().sessions : [];
  return Object.fromEntries(KINDS.map(kind => {
    const p = connection(raw, kind);
    const gw = gatewayView();
    const own = p.backend === 'proxy' ? ownStash(raw, kind) : p;
    const common = { ...(own?.apiKeyNeedsInput ? { apiKeyNeedsInput: true,
      ownConnection: { baseURL: own.baseURL, model: own.model, wireApi: own.wireApi, apiKeyNeedsInput: true, ...(own.modelList?.length > 1 ? { ownModels: own.modelList } : {}) } } : {}), companyModels: proxyModels().MODELS.map(m => ({ ...m })), own: ownSource(raw, kind),
      // 网关配好了才带：启动中心据此显示「API 网关」模型卡（2026-11-19）。
      ...(gw.keySet ? { gatewayModels: gw.choices.map(c => ({ id: c.id, label: c.label, note: c.note })) } : {}),
      ...(raw.providers?.[kind]?.api_profiles?.length ? { apiProfiles: require('./cli-api-profiles').publicProfiles(raw, kind),
        selectedProfileId: raw.providers[kind].selected_api_profile || '' } : {}),
      companyDefault: isCompany() && !raw.providers?.[kind]?.backend && !sessions.some(session => baseKind(session.kind) === kind) };
    if (p.backend === 'proxy') return [kind, { backend: 'proxy', upstream: p.upstream, baseURL: '', apiKeySet: false,
      model: p.model || (p.upstream === 'gateway' ? gatewayStore().read(dataDir()).model : proxyModels().DEFAULT_MODEL),
      models: proxyModels().MODELS.map(m => ({ ...m })), ...common, ...(kind === 'codex' ? { wireApi: 'responses' } : {}) }];
    return [kind, { backend: backendOf(p), baseURL: p.baseURL || '', apiKeySet: !!p.apiKey, model: p.model || '', ...(p.modelList?.length > 1 ? { ownModels: p.modelList } : {}), ...common,
      ...(kind === 'codex' ? { wireApi: p.wireApi || 'responses' } : {}) }];
  }));
}
function anyProxy(raw = {}) { return KINDS.some(kind => connection(raw, kind).backend === 'proxy'); }
function anyGateway(raw = {}) { return KINDS.some(kind => { const c = connection(raw, kind); return c.backend === 'proxy' && c.upstream === 'gateway'; }); }
function withSettings(raw, request = {}) {
  const kind = baseKind(request.kind);
  if (!KINDS.includes(kind)) throw new Error('不支持的 API 类型');
  if (request.profileAction) return require('./cli-api-profiles').withProfile(raw, request);
  const currentOwn = connection(raw, kind).backend === 'proxy' ? ownStash(raw, kind) : connection(raw, kind);
  if (request.backend === 'own' || (!request.useLocal && !['proxy', 'gateway'].includes(request.backend) && !request.apiKey?.trim())) secrets.assertReadable(currentOwn);
  if (request.backend === 'proxy' || request.backend === 'gateway') {
    // 「API 网关」也是经本机反代，只是上游换成网关；模型名按网关模型表解析，不套公司模型的名字。
    const gateway = request.backend === 'gateway';
    if (gateway && !gatewayStore().configured(dataDir())) throw new Error('请先在「API 网关」里粘贴 API key 并保存');
    const model = gateway ? gatewayStore().resolveModel(dataDir(), request.model) : proxyModels().normalizeModel(request.model);
    const upstream = gateway ? { upstream: 'gateway' } : {};
    if (kind === 'deepseek-acp') {
      // 切到公司模型或 API 网关时留住 DSH 的自有接口，启动中心一键切回（2026-11-20）。
      const cur = raw.acp?.companyApi || {};
      const keep = cur.backend === 'proxy' ? cur.own_api : (cur.baseURL || cur.apiKey || cur.model) ? { base_url: cur.baseURL || '', api_key: cur.apiKey || '', model: cur.model || '', ...(Array.isArray(cur.modelList) && cur.modelList.length ? { model_list: cur.modelList } : {}), ...(cur.apiKeyNeedsInput ? { encrypted_api_key: cur.encryptedApiKey, api_keyNeedsInput: true } : {}) } : null;
      return { ...raw, acp: { ...raw.acp, companyApi: { backend: 'proxy', model, ...upstream, ...(keep ? { own_api: keep } : {}) } } };
    }
    const { base_url, api_key, encrypted_api_key, api_keyNeedsInput, wire_api, own_api, upstream: _upstream, ...rest } = raw.providers?.[kind] || {};
    // Keep the tool's own interface (address, Key, model) to switch back to it later from the launch center.
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? own_api : (current.baseURL || current.apiKey || current.model)
      ? { base_url: current.baseURL, api_key: current.apiKey, model: current.model, ...(withList(current.modelList || [], current.model) ? { model_list: current.modelList } : {}), ...(current.apiKeyNeedsInput ? { encrypted_api_key: current.encryptedApiKey, api_keyNeedsInput: true } : {}), ...(kind === 'codex' ? { wire_api: current.wireApi } : {}) } : null;
    return { ...raw, providers: { ...raw.providers, [kind]: { ...rest, backend: 'proxy', model, ...upstream, ...(own ? { own_api: own } : {}) } } };
  }
  // Launch center "own source" card: back to the kept own interface, or to the CLI's own configuration.
  if (request.backend === 'own') {
    const current = connection(raw, kind);
    const own = current.backend === 'proxy' ? ownStash(raw, kind) : current;
    if (kind === 'deepseek-acp') {
      if (!own?.baseURL) throw new Error('DSH 还没有保存过自有接口：请到「设置 → 自有 API → DSH → 自有接口」填写地址和模型');
      const next = { ...raw, acp: { ...raw.acp, companyApi: { baseURL: own.baseURL, apiKey: own.apiKey || '', model: own.model || '', ...(withList(own.modelList || [], own.model) ? { modelList: own.modelList } : {}) } } };
      return request.ownModel ? withOwnModel(next, kind, request.ownModel) : next;
    }
    const { own_api, upstream: _up, model_list: _list, ...rest } = raw.providers?.[kind] || {};
    const p = own && (own.baseURL || own.apiKey || own.model) ? own : { baseURL: '', apiKey: '', model: '', wireApi: 'responses' };
    const next = { ...raw, providers: { ...raw.providers, [kind]: { ...rest, backend: 'api', base_url: p.baseURL, api_key: p.apiKey, model: p.model,
      ...(withList(p.modelList || [], p.model) ? { model_list: p.modelList } : {}),
      ...(kind === 'codex' ? { wire_api: wireApi(p.wireApi || 'responses') } : {}) } } };
    return request.ownModel ? withOwnModel(next, kind, request.ownModel) : next;
  }
  // 只记住启动中心上次选的子模型（R45-3：和网关卡、公司模型卡一样，下次打开默认选它）。
  if (request.ownModel !== undefined && !request.backend) return withOwnModel(raw, kind, request.ownModel);
  const previous = request.useLocal || connection(raw, kind).backend === 'proxy' ? {} : connection(raw, kind);
  if (request.apiKey != null && typeof request.apiKey !== 'string') throw new Error('Key 格式无效');
  const p = request.useLocal ? { baseURL: '', apiKey: '', model: '' } : {
    baseURL: request.baseURL?.trim() ? baseUrl(request.baseURL) : '',
    apiKey: optionalText(request.apiKey?.trim() || previous.apiKey, 'API Key'),
    model: optionalText(request.model, '模型名称') };
  // 模型表：没传就沿用原来的（只改地址或 Key 时不丢）；默认模型没填时取模型表第一个。
  // 走公司模型 / 网关时补填自有接口（previous 为空）：模型表回退读留着的那份，不被清掉（R45-3 审查 P2-3）。
  const list = request.useLocal ? [] : modelList(request.models !== undefined ? request.models : (previous.modelList || currentOwn?.modelList || []), p.model);
  if (!p.model && list.length) p.model = list[0];
  const listField = withList(list, p.model);
  if (kind === 'codex' && (p.apiKey || p.model) && !p.baseURL) throw new Error('Codex 自有 API 请填写接口地址；或选择沿用本机配置');
  if (kind === 'deepseek-acp') return { ...raw, acp: { ...raw.acp, companyApi: { ...p, ...(listField ? { modelList: listField } : {}) } } };
  // 切回自有接口或本机配置时，不留 proxy 标记。
  const { own_api: _ownApi, upstream: _upstream, encrypted_api_key: _cipher, api_keyNeedsInput: _needsKey, model_list: _oldList, ...kept } = raw.providers?.[kind] || {};
  return { ...raw, providers: { ...raw.providers, [kind]: { ...kept, backend: 'api',
    base_url: p.baseURL, api_key: p.apiKey, model: p.model, ...(listField ? { model_list: listField } : {}), ...(kept.selected_api_profile ? { selected_api_profile: '' } : {}),
    ...(kind === 'codex' ? { wire_api: wireApi(request.wireApi || previous.wireApi || 'responses') } : {}) } } };
}
// 把自有接口的默认模型改成 model（必须在它的模型表里，否则原样返回）：走自有接口时改当前设置，走公司模型 / 网关时改留着的那份。
function withOwnModel(raw, kind, model) {
  const id = String(model || '').trim();
  if (!id) return raw;
  if (kind === 'deepseek-acp') {
    const c = raw.acp?.companyApi || {};
    if (c.backend === 'proxy') {
      const o = c.own_api || {};
      return listOf(o.model_list, o.model).includes(id) ? { ...raw, acp: { ...raw.acp, companyApi: { ...c, own_api: { ...o, model: id } } } } : raw;
    }
    return listOf(c.modelList, c.model).includes(id) ? { ...raw, acp: { ...raw.acp, companyApi: { ...c, model: id } } } : raw;
  }
  const p = raw.providers?.[kind] || {};
  if (p.backend === 'proxy') {
    const o = p.own_api || {};
    return listOf(o.model_list, o.model).includes(id) ? { ...raw, providers: { ...raw.providers, [kind]: { ...p, own_api: { ...o, model: id } } } } : raw;
  }
  return p.backend === 'api' && listOf(p.model_list, p.model).includes(id) ? { ...raw, providers: { ...raw.providers, [kind]: { ...p, model: id } } } : raw;
}
function applyCompanyConfig(config, raw) {
  if (!isCompany()) return config;
  config.companyCli = true;
  for (const kind of ['claude', 'codex']) {
    const p = connection(raw, kind);
    config[kind + 'Backend'] = backendOf(p);
    config[kind + 'Upstream'] = p.backend === 'proxy' ? p.upstream : '';
    config[kind + 'ApiKey'] = p.apiKey || '';
    config[kind + 'ApiKeyNeedsInput'] = !!p.apiKeyNeedsInput;
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
  config.dshApiKeyNeedsInput = !!dsh.apiKeyNeedsInput;
  config.companyProxyEnabled = anyProxy(raw);
  config.proxy = '';
  return config;
}
function assertLaunchConfigured(kind, config, opts = {}) {
  // 功能会话走部门 API key（core/assistant-gateway-route.js）：启动值由 launchValues() 固定指向本机反代的网关上游，
  // 与全局 Claude「自有 API」设置无关，不拿那边的残缺配置误杀；只要部门 key 还在。
  if (opts && opts.apiGatewayRoute === true && require('./assistant-gateway-route').allowedSession(kind, opts)) {
    if (!gatewayStore().configured(dataDir())) throw Object.assign(new Error('部门 API key 已不在了：请先在「设置 → API 网关」保存部门 key，再重开这个功能。'), { code: 'API_GATEWAY_KEY_MISSING', notSent: true });
    return;
  }
  kind = baseKind(kind);
  if (!isCompany() || !KINDS.includes(kind)) return;
  const gatewayReady = () => { if (!gatewayStore().configured(dataDir())) throw new Error('API 网关还没配置好：请到「设置 → 自有 API → API 网关」粘贴 key 并保存。'); };
  if (kind === 'deepseek-acp') {
    if (config.dshBackend === 'proxy') { if (config.dshUpstream === 'gateway') gatewayReady(); return; }
    if (config.dshBackend === 'api') {
      if (config.dshApiKeyNeedsInput) throw new Error(secrets.KEY_NEEDED);
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
  if (config[kind + 'ApiKeyNeedsInput']) throw new Error(secrets.KEY_NEEDED);
  if (config[kind + 'ApiBaseUrl']) baseUrl(config[kind + 'ApiBaseUrl']);
  optionalText(config[kind + 'ApiKey'], 'API Key');
  optionalText(config[kind + 'ApiModel'], '模型名称');
  if (kind === 'codex' && (config.codexApiKey || config.codexApiModel) && !config.codexApiBaseUrl) throw new Error('Codex 自有 API 请填写接口地址');
  if (kind === 'codex') wireApi(config.codexApiWireApi || 'responses');
}

module.exports = { KINDS, LABELS, baseKind, isCompany, wireApi, baseUrl, optionalText, modelList, settings, withSettings, applyCompanyConfig, assertLaunchConfigured, anyProxy, anyGateway, connection, gatewayView };
