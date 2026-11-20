'use strict';

// 公司模型（经本机反代，用 CodeAgent 账号）：Hub 这一侧的配置与会话环境。
// 反代进程本体在 core/company-proxy/server.mjs，由 main/company-proxy-service.js 起停。
//
// 每个会话拿到的 Key 是「反代主 Key + . + 会话标识」，反代按会话标识把这个会话固定在同一个账号上
// （号池调度见 core/company-proxy/account-router.mjs）。端口与主 Key 存在数据目录，
// Hub 重启后恢复的会话也能同步拿到，不用等反代起好才算环境。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 公司模型清单跟 CodeAgent 自己的模型目录走（2026-11-20）：反代按账号拉目录、存到 <数据目录>/company-model-proxy/model-catalog.json，
// 这里现读那份文件（读不到用内置的 GLM-5.2-WX、DeepSeek V4.1 Flash）。MODELS / MODEL_IDS / DEFAULT_MODEL 是现取的 getter，
// 启动中心、设置页、会话切模型、Codex 目录、DSH 模型表都读这同一份，CodeAgent 里新出的模型不用发版就能选。
const modelCatalog = require('./company-proxy/model-catalog.cjs');
const hubDataDir = () => { try { return require('./data-dir').getHubDataDir(); } catch { return ''; } };
function companyModels(dataDir = hubDataDir()) {
  const list = dataDir ? modelCatalog.modelsFor(dataDir) : modelCatalog.unionModels(null);
  return list.map(m => Object.freeze({ id: m.id, label: m.label || m.id, ...(m.input ? { input: m.input } : {}), ...(m.output ? { output: m.output } : {}), thinking: !!m.thinking }));
}
const companyModelIds = dataDir => companyModels(dataDir).map(m => m.id);
const companyDefaultModel = dataDir => modelCatalog.defaultModel(companyModels(dataDir)).id;
const DEFAULT_PORT = 18765;
const KEY_ENV = 'AI_HUB_COMPANY_MODEL_KEY';
const PROVIDER_ID = 'company-proxy';
const LABEL = '公司模型（经本机反代，用 CodeAgent 账号）';
const GATEWAY_LABEL = 'API 网关（经本机反代）';
const GATEWAY_SUFFIX = '__gw';
const gatewayConfig = () => require('./api-gateway');
// Codex 在 Windows 上的沙箱，必须和下面的 sandbox_mode = "danger-full-access" 成对使用。
// 公司电脑实测（Q-1106-04 r7，2026-11-06）：默认的 mxc 沙箱会让 apply_patch / exec_command 实际执行失败；
// unelevated + workspace-write 不可用（Codex 报 unelevated restricted-token sandbox cannot enforce split
// writable root sets）；unelevated + danger-full-access 可用，即 Hub 现有 Codex 会话的同一组配置。
// 要改只改这一处（或用环境变量 AI_HUB_COMPANY_CODEX_SANDBOX 临时覆盖）。
const CODEX_WINDOWS_SANDBOX_DEFAULT = 'unelevated';
function codexWindowsSandbox(env = process.env) {
  const value = String(env.AI_HUB_COMPANY_CODEX_SANDBOX || '').trim();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : CODEX_WINDOWS_SANDBOX_DEFAULT;
}

function proxyDir(dataDir) { return path.join(dataDir, 'company-model-proxy'); }
function endpointFile(dataDir) { return path.join(proxyDir(dataDir), 'endpoint.json'); }

// 本进程自己起的反代实际在听的端口（反馈 38a58107，2026-11-19）：同一数据目录开着两个 Hub 时，endpoint.json 只有一份，
// 后开的那个因默认端口被占换了新端口并写进文件，关掉后先开的 Hub 再新建会话就读到已关的端口，报 ECONNREFUSED。
// 本进程的反代在跑时一律用它自己的端口和 Key（成对存：两个 Hub 同时首次启动时，文件里的 Key 可能是另一个生成的，
// Codex 复核 P2）；没在跑（已停、启动中）才读文件。
const liveEndpoints = new Map();
const liveKey = dataDir => path.resolve(String(dataDir || '')).toLowerCase();
const validKey = key => /^[A-Za-z0-9]{32,128}$/.test(String(key || ''));
function noteLiveEndpoint(dataDir, endpoint) {
  const port = endpoint && endpoint.port, key = endpoint && endpoint.key;
  if (Number.isSafeInteger(port) && port > 0 && port <= 65535 && validKey(key)) liveEndpoints.set(liveKey(dataDir), { port, key });
  else liveEndpoints.delete(liveKey(dataDir));
}
function readEndpoint(dataDir) {
  const live = liveEndpoints.get(liveKey(dataDir));
  let value = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointFile(dataDir), 'utf8'));
    if (validKey(parsed.key) && Number.isSafeInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535) value = parsed;
  } catch { /* first use */ }
  return live ? { ...(value || {}), port: live.port, key: live.key } : value;
}
function writeEndpoint(dataDir, value) {
  fs.mkdirSync(proxyDir(dataDir), { recursive: true });
  const file = endpointFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return value;
}
// 主 Key 只在本机：反代只听 127.0.0.1，Key 防的是本机其他程序冒用。
function ensureEndpoint(dataDir, { preferredPort = DEFAULT_PORT } = {}) {
  const current = readEndpoint(dataDir);
  if (current) return current;
  return writeEndpoint(dataDir, { port: preferredPort, key: crypto.randomBytes(24).toString('hex') });
}
function setEndpointPort(dataDir, port) {
  const current = ensureEndpoint(dataDir);
  if (current.port === port) return current;
  return writeEndpoint(dataDir, { ...current, port });
}

function sessionTag(sessionId) {
  const tag = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return tag || 'default';
}
// 启动中心给公司模型会话选的号（2026-11-07 用户：和 CodeAgent 一致）：'personal' 个人账号、号池账号 id；
// 其他值（'auto'、空、格式不对）都是自动分配。
const PIN_ID = /^(?:[a-z0-9]{6,16}|personal)$/;
function normalizePin(account) { const value = String(account || '').trim(); return PIN_ID.test(value) ? value : ''; }
// 固定了号的会话，Key 的会话标识后面带「__pin_<号>」，反代只用这个号（core/company-proxy/server.mjs parseTag）；
// 粘号和卡片上的号仍按不带后缀的会话标识记。走团队共享主机时号由主机分配，不带后缀。
// API 网关会话（部门 API key，2026-11-19）：会话标识后面带「__gw」，反代把它转给网关、不经 CodeAgent 账号，也不固定号。
function sessionKey(endpoint, sessionId, account = '', { gateway = false } = {}) {
  if (gateway) return `${endpoint.key}.${sessionTag(sessionId)}${GATEWAY_SUFFIX}`;
  const pin = endpoint.origin ? '' : normalizePin(account);
  return `${endpoint.key}.${sessionTag(sessionId)}${pin ? '__pin_' + pin : ''}`;
}
function origin(endpoint) { return endpoint.origin || `http://127.0.0.1:${endpoint.port}`; }
function requireEndpoint(dataDir, { gateway = false } = {}) {
  // 网关会话只走本机反代（团队共享主机没有这个人的 key）。
  const shared = gateway ? null : require('./lan-pool').read(dataDir).client;
  if (shared?.enabled) return { origin: require('./lan-pool').address(shared.address), key: shared.key };
  const endpoint = readEndpoint(dataDir);
  if (!endpoint || !endpoint.port) throw new Error('公司模型反代还没准备好，请稍等几秒再新建会话');
  return endpoint;
}

// 名字 → 公司模型（规则同反代，model-catalog.cjs resolveModel）：以前带 glm 的一律落到 GLM-5.2-WX，要 5.3 也给 5.2；
// 现在目录里有就用它，要的版本没有就报错说明可选项。
function normalizeModel(model, dataDir) {
  const value = String(model || '').trim();
  const models = companyModels(dataDir);
  if (!value) return modelCatalog.defaultModel(models).id;
  const hit = modelCatalog.resolveModel(value, models);
  if (hit.how === 'default') throw new Error(`公司模型只支持 ${models.map(m => m.id).join('、')}`);
  return hit.id;
}

// 会话启动时用：不认识的名字（例如别处带来的默认模型）落到默认的公司模型，不报错。
// 网关会话：网关模型表里有就原样用，没有落到网关的默认模型（core/api-gateway.js）。
function launchModel(model, { gateway = false, dataDir = '' } = {}) {
  if (gateway) return gatewayConfig().resolveModel(dataDir, model);
  try { return normalizeModel(model, dataDir || undefined); } catch { return companyDefaultModel(dataDir || undefined); }
}
function gatewayModelIds(dataDir) {
  const view = gatewayConfig().read(dataDir);
  return view.models.length ? view.models : [view.model];
}
// 网关模型的上下文上限：网关目录里的真实值（如 256K），取不到用保守默认 128000（core/api-gateway-catalog.js）。
function gatewayModels(dataDir) { return gatewayModelIds(dataDir).map(id => ({ id, input: gatewayConfig().contextOf(dataDir, id) })); }

// 发往 127.0.0.1 的请求不能被系统代理或代理环境变量带走（公司电脑实测：Codex 因此一次请求都没发出去）。
function applyNoProxy(env) {
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const parts = String(env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const host of ['127.0.0.1', 'localhost']) if (!parts.some(p => p.toLowerCase() === host)) parts.push(host);
    env[name] = parts.join(',');
  }
  return env;
}

function applyEndpointNoProxy(env, endpoint) {
  applyNoProxy(env);
  if (!endpoint.origin) return;
  const host = new URL(endpoint.origin).hostname;
  for (const name of ['NO_PROXY', 'no_proxy']) if (!env[name].split(',').includes(host)) env[name] += ',' + host;
}

function applyClaudeEnv(env, { dataDir, sessionId, model, account, gateway = false }) {
  const endpoint = requireEndpoint(dataDir, { gateway });
  const chosen = launchModel(model, { gateway, dataDir });
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ANTHROPIC_API_BASE_URL']) delete env[key];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: origin(endpoint),
    ANTHROPIC_AUTH_TOKEN: sessionKey(endpoint, sessionId, account, { gateway }),
    ANTHROPIC_MODEL: chosen,
    ANTHROPIC_DEFAULT_OPUS_MODEL: chosen, ANTHROPIC_DEFAULT_SONNET_MODEL: chosen, ANTHROPIC_DEFAULT_HAIKU_MODEL: chosen,
    ANTHROPIC_SMALL_FAST_MODEL: chosen, CLAUDE_CODE_SUBAGENT_MODEL: chosen,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', API_TIMEOUT_MS: '900000',
  });
  applyEndpointNoProxy(env, endpoint);
  return chosen;
}

const CODEX_INSTRUCTIONS = `You are a coding agent running in the Codex CLI on the user's Windows computer. Work inside the current workspace.
- Use the provided tools to inspect files and run commands; prefer reading code before changing it.
- Make code changes with the apply_patch tool. Keep changes focused and consistent with the existing style.
- Shell commands run in PowerShell. Verify your work (build, tests) when practical.
- Reply to the user in the language they use (usually Chinese). Be concise and state what you changed and how you verified it.`;
// Codex 不认识公司模型的名字时会按通用默认值跑；给它一份目录，说明只收文字、不用联网搜索。
function codexCatalog(ids = companyModelIds(), description = 'Company model via local proxy', known = companyModels(), { cap = 128000 } = {}) {
  // 上下文按公司目录给的输入上限，不超过以前一直用的 128000（目录里更小的模型按它自己的）。
  // 网关模型（cap: Infinity）按网关目录的真实值。
  const windowOf = slug => { const m = known.find(x => x.id === slug); return m && m.input ? Math.min(m.input, cap) : 128000; };
  const entry = slug => ({ slug, display_name: slug, description,
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Mapped to upstream thinking (high)' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1, base_instructions: CODEX_INSTRUCTIONS, model_messages: null,
    default_reasoning_summary: 'auto', support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_image_detail_original: false, context_window: windowOf(slug), max_context_window: windowOf(slug), effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false, supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: false, node_repl_disabled: true, tool_mode: null, multi_agent_version: null, multi_agent_reasoning_effort: null });
  return { models: ids.map(entry) };
}
const tomlString = value => JSON.stringify(String(value || ''));

// 网关会话用独立的 Codex home，免得和同时开着的公司模型会话互相改写 config.toml。
function codexHome(dataDir, { gateway = false } = {}) { return path.join(dataDir, gateway ? 'codex-api-gateway' : 'codex-company-proxy'); }
function ensureCodexHome(dataDir, { model, projectDir, gateway = false }) {
  const endpoint = requireEndpoint(dataDir, { gateway });
  const home = codexHome(dataDir, { gateway });
  fs.mkdirSync(home, { recursive: true });
  const catalog = path.join(home, 'company-model-catalog.json');
  fs.writeFileSync(catalog, JSON.stringify(gateway ? codexCatalog(gatewayModelIds(dataDir), 'API gateway model via local proxy', gatewayModels(dataDir), { cap: Infinity }) : codexCatalog(companyModelIds(dataDir), undefined, companyModels(dataDir)), null, 2), 'utf8');
  const projectKey = path.resolve(projectDir || require('node:os').homedir());
  require('./codex-managed-config').writeHubManagedCodexConfig(path.join(home, 'config.toml'), [
    'disable_response_storage = true',
    `model = ${tomlString(launchModel(model, { gateway, dataDir }))}`,
    `model_provider = ${tomlString(PROVIDER_ID)}`,
    `model_catalog_json = ${tomlString(catalog.replace(/\\/g, '/'))}`,
    'model_reasoning_effort = "medium"',
    'model_reasoning_summary = "auto"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    `sandbox = ${tomlString(codexWindowsSandbox())}`,
    '',
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${tomlString(gateway ? GATEWAY_LABEL : LABEL)}`,
    `base_url = ${tomlString(origin(endpoint) + '/v1')}`,
    `env_key = ${tomlString(KEY_ENV)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'stream_idle_timeout_ms = 600000',
    '',
    `[projects.${tomlString(projectKey)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  return home;
}
function applyCodexEnv(env, { dataDir, sessionId, model, projectDir, account, gateway = false }) {
  const endpoint = requireEndpoint(dataDir, { gateway });
  env.CODEX_HOME = ensureCodexHome(dataDir, { model, projectDir, gateway });
  env[KEY_ENV] = sessionKey(endpoint, sessionId, account, { gateway });
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']) delete env[key];
  applyEndpointNoProxy(env, endpoint);
  return env.CODEX_HOME;
}

// DSH：OpenAI chat 形态，挂在独立的 provider 下；联网、遥测和插件市场相关功能关掉（公司模型没有对应能力）。
// 'web' 服务本身保留：终端界面建会话时要等它就绪（关掉它会报 tool-web waiting for web 并退出），
// 它背后的搜索与抓取提供方都关掉，联网工具也关掉。
// 不再关 plugin-manager（2026-11-20）：新版 DSH（0.2.2）的标准智能体预设里自带 tool-plugin-manager，它等 pluginManager 服务；
// 关掉服务后建智能体失败（「failed to create agent … tool-plugin-manager: waiting for pluginManager」），DSH 直接退出。
const DSH_DISABLED = ['deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'web-search-deepseek', 'web-deepseek-api',
  'web-fetch-http', 'tool-web', 'otel', 'session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'tool-plugin-manager'];
function dshRoute({ dataDir, sessionId, model, account, gateway = false }) {
  const endpoint = requireEndpoint(dataDir, { gateway });
  const ids = gateway ? gatewayModelIds(dataDir) : companyModelIds(dataDir);
  const contextOf = id => (gateway ? gatewayConfig().contextOf(dataDir, id) : 128000);
  return {
    providerId: PROVIDER_ID, keyEnv: KEY_ENV, key: sessionKey(endpoint, sessionId, account, { gateway }), baseURL: origin(endpoint) + '/v1',
    model: launchModel(model, { gateway, dataDir }),
    providerConfig: { api: 'openai-completions', baseURL: origin(endpoint) + '/v1', apiKeyEnv: KEY_ENV, retryPolicy: { mode: 'normal', maxRetries: 0 }, reasoning: 'high',
      models: ids.map(id => ({ id, contextWindow: contextOf(id), maxTokens: 16384, reasoningEfforts: { high: 'high' },
        compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek', supportsStore: false, maxTokensField: 'max_tokens' } })) },
    disabledPatches: DSH_DISABLED.map(id => ({ id, disabled: true })),
  };
}

// DSH 的「自有接口」（2026-11-20，群诉求：部门自有模型 DSH 下接不上）：用户在「自有 API → DSH → 自有接口」填的
// OpenAI 兼容地址、Key、模型直连，不经本机反代、不用 CodeAgent 账号。和公司模型一样关掉 DeepSeek 自家账号、联网等插件。
const OWN_PROVIDER_ID = 'hub-own-api';
const OWN_KEY_ENV = 'AI_HUB_DSH_OWN_KEY';
function dshOwnRoute({ baseURL, apiKey, model }) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('DSH 自有接口还没填接口地址：请到「设置 → 自有 API → DSH → 自有接口」填写 OpenAI 兼容地址（通常以 /v1 结尾），或改选「API 网关」。');
  const id = String(model || '').trim();
  if (!id) throw new Error('DSH 自有接口还没填模型名：请到「设置 → 自有 API → DSH → 自有接口」点「测试连接」选一个模型后保存。');
  return {
    providerId: OWN_PROVIDER_ID, keyEnv: OWN_KEY_ENV, key: String(apiKey || '').trim() || 'none', baseURL: base, model: id, own: true,
    providerConfig: { api: 'openai-completions', baseURL: base, apiKeyEnv: OWN_KEY_ENV, retryPolicy: { mode: 'normal', maxRetries: 1 }, reasoning: 'high',
      models: [{ id, contextWindow: 128000, maxTokens: 16384, reasoningEfforts: { high: 'high' },
        compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek', supportsStore: false, maxTokensField: 'max_tokens' } }] },
    disabledPatches: DSH_DISABLED.map(name => ({ id: name, disabled: true })),
  };
}

// 这次启动的会话是否走 API 网关（反代里的网关上游；仍算「走反代」，usesProxy 也为真）。
function usesGateway(kind, config = {}) {
  if (!usesProxy(kind, config)) return false;
  const base = String(kind || '').replace(/-resume$/, '');
  return (base === 'claude' ? config.claudeUpstream : base === 'codex' ? config.codexUpstream : config.dshUpstream) === 'gateway';
}

// 这次启动的会话是否走公司模型反代（config 为 hub-config 的合成配置）。
function usesProxy(kind, config = {}) {
  if (!config.companyCli) return false;
  const base = String(kind || '').replace(/-resume$/, '');
  return base === 'claude' ? config.claudeBackend === 'proxy'
    : base === 'codex' ? config.codexBackend === 'proxy'
      : base === 'deepseek-acp' ? config.dshBackend === 'proxy' : false;
}

// Node for DSH when the DSH runtime did not record one: first node.exe on PATH.
function findNodeOnPath(env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return '';
}

// 所在区域（蓝/绿/黄）：「自有 API → 公司模型」的下拉框写进 upstream.json 的 zone，并记 zoneChosenBy=settings；
// 选「自动识别」就删掉这两项，由反代从 CodeAgent 的配置里识别（见 core/company-proxy/upstream-profile.mjs）。
const ZONE_CHOICES = Object.freeze(['blue', 'green', 'yellow']);
function upstreamFile(dataDir) { return path.join(proxyDir(dataDir), 'upstream.json'); }
function readUpstreamConfig(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(upstreamFile(dataDir), 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('上游配置文件 upstream.json 格式不对，没有改动它：' + upstreamFile(dataDir));
  }
}
function setUpstreamZone(dataDir, zone) {
  const value = String(zone || '');
  if (value && !ZONE_CHOICES.includes(value)) throw new Error('区域只能是蓝区、绿区、黄区或自动识别');
  const next = { ...readUpstreamConfig(dataDir) };
  if (value) { next.zone = value; next.zoneChosenBy = 'settings'; } else { delete next.zone; delete next.zoneChosenBy; }
  fs.mkdirSync(proxyDir(dataDir), { recursive: true });
  const file = upstreamFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { zone: value, chosen: !!value };
}
function chosenZone(dataDir) {
  try { const v = readUpstreamConfig(dataDir); return ZONE_CHOICES.includes(v.zone) ? { zone: v.zone, chosenBy: v.zoneChosenBy === 'settings' ? 'settings' : 'config' } : { zone: '', chosenBy: '' }; }
  catch { return { zone: '', chosenBy: '' }; }
}

module.exports = {
  ZONE_CHOICES, upstreamFile, readUpstreamConfig, setUpstreamZone, chosenZone,
  companyModels, companyModelIds, companyDefaultModel, DEFAULT_PORT, KEY_ENV, PROVIDER_ID, LABEL, GATEWAY_LABEL, GATEWAY_SUFFIX, usesGateway, gatewayModelIds, CODEX_WINDOWS_SANDBOX_DEFAULT, codexWindowsSandbox,
  proxyDir, endpointFile, readEndpoint, noteLiveEndpoint, ensureEndpoint, setEndpointPort, sessionTag, sessionKey, normalizePin, normalizeModel, launchModel,
  applyNoProxy, applyEndpointNoProxy, usesProxy, applyClaudeEnv, codexCatalog, codexHome, ensureCodexHome, applyCodexEnv, dshRoute, dshOwnRoute, findNodeOnPath,
};
// 现取的清单（旧代码按常量读，名字保留）。
Object.defineProperty(module.exports, 'MODELS', { enumerable: true, get: () => companyModels() });
Object.defineProperty(module.exports, 'MODEL_IDS', { enumerable: true, get: () => companyModelIds() });
Object.defineProperty(module.exports, 'DEFAULT_MODEL', { enumerable: true, get: () => companyDefaultModel() });
