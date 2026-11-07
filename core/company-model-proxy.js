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

const MODELS = Object.freeze([
  Object.freeze({ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }),
  Object.freeze({ id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }),
]);
const MODEL_IDS = MODELS.map(m => m.id);
const DEFAULT_MODEL = MODEL_IDS[0];
const DEFAULT_PORT = 18765;
const KEY_ENV = 'AI_HUB_COMPANY_MODEL_KEY';
const PROVIDER_ID = 'company-proxy';
const LABEL = '公司模型（经本机反代，用 CodeAgent 账号）';
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

function readEndpoint(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(endpointFile(dataDir), 'utf8'));
    if (/^[A-Za-z0-9]{32,128}$/.test(value.key) && Number.isSafeInteger(value.port) && value.port >= 0 && value.port <= 65535) return value;
  } catch { /* first use */ }
  return null;
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
function sessionKey(endpoint, sessionId) { return `${endpoint.key}.${sessionTag(sessionId)}`; }
function origin(endpoint) { return endpoint.origin || `http://127.0.0.1:${endpoint.port}`; }
function requireEndpoint(dataDir) {
  const shared = require('./lan-pool').read(dataDir).client;
  if (shared?.enabled) return { origin: require('./lan-pool').address(shared.address), key: shared.key };
  const endpoint = readEndpoint(dataDir);
  if (!endpoint || !endpoint.port) throw new Error('公司模型反代还没准备好，请稍等几秒再新建会话');
  return endpoint;
}

function normalizeModel(model) {
  const value = String(model || '').trim();
  if (!value) return DEFAULT_MODEL;
  if (MODEL_IDS.includes(value)) return value;
  const lower = value.toLowerCase();
  if (lower.includes('glm')) return MODEL_IDS[0];
  if (lower.includes('deepseek')) return MODEL_IDS[1];
  throw new Error(`公司模型只支持 ${MODEL_IDS.join('、')}`);
}

// 会话启动时用：不认识的名字（例如别处带来的默认模型）落到默认的公司模型，不报错。
function launchModel(model) { try { return normalizeModel(model); } catch { return DEFAULT_MODEL; } }

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

function applyClaudeEnv(env, { dataDir, sessionId, model }) {
  const endpoint = requireEndpoint(dataDir);
  const chosen = launchModel(model);
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ANTHROPIC_API_BASE_URL']) delete env[key];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: origin(endpoint),
    ANTHROPIC_AUTH_TOKEN: sessionKey(endpoint, sessionId),
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
function codexCatalog() {
  const entry = slug => ({ slug, display_name: slug, description: 'Company model via local proxy',
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Mapped to upstream thinking (high)' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1, base_instructions: CODEX_INSTRUCTIONS, model_messages: null,
    default_reasoning_summary: 'auto', support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_image_detail_original: false, context_window: 128000, max_context_window: 128000, effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false, supports_reasoning_effort_updates: true,
    node_repl_auto_review_required: false, node_repl_disabled: true, tool_mode: null, multi_agent_version: null, multi_agent_reasoning_effort: null });
  return { models: MODEL_IDS.map(entry) };
}
const tomlString = value => JSON.stringify(String(value || ''));

function codexHome(dataDir) { return path.join(dataDir, 'codex-company-proxy'); }
function ensureCodexHome(dataDir, { model, projectDir }) {
  const endpoint = requireEndpoint(dataDir);
  const home = codexHome(dataDir);
  fs.mkdirSync(home, { recursive: true });
  const catalog = path.join(home, 'company-model-catalog.json');
  fs.writeFileSync(catalog, JSON.stringify(codexCatalog(), null, 2), 'utf8');
  const projectKey = path.resolve(projectDir || require('node:os').homedir());
  require('./codex-managed-config').writeHubManagedCodexConfig(path.join(home, 'config.toml'), [
    'disable_response_storage = true',
    `model = ${tomlString(launchModel(model))}`,
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
    `name = ${tomlString(LABEL)}`,
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
function applyCodexEnv(env, { dataDir, sessionId, model, projectDir }) {
  const endpoint = requireEndpoint(dataDir);
  env.CODEX_HOME = ensureCodexHome(dataDir, { model, projectDir });
  env[KEY_ENV] = sessionKey(endpoint, sessionId);
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY']) delete env[key];
  applyEndpointNoProxy(env, endpoint);
  return env.CODEX_HOME;
}

// DSH：OpenAI chat 形态，挂在独立的 provider 下；联网、遥测和插件市场相关功能关掉（公司模型没有对应能力）。
// 'web' 服务本身保留：终端界面建会话时要等它就绪（关掉它会报 tool-web waiting for web 并退出），
// 它背后的搜索与抓取提供方都关掉，联网工具也关掉。
const DSH_DISABLED = ['deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'web-search-deepseek', 'web-deepseek-api',
  'web-fetch-http', 'tool-web', 'otel', 'session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'plugin-manager', 'tool-plugin-manager'];
function dshRoute({ dataDir, sessionId, model }) {
  const endpoint = requireEndpoint(dataDir);
  return {
    providerId: PROVIDER_ID, keyEnv: KEY_ENV, key: sessionKey(endpoint, sessionId), baseURL: origin(endpoint) + '/v1',
    model: launchModel(model),
    providerConfig: { api: 'openai-completions', baseURL: origin(endpoint) + '/v1', apiKeyEnv: KEY_ENV, retryPolicy: { mode: 'normal', maxRetries: 0 }, reasoning: 'high',
      models: MODEL_IDS.map(id => ({ id, contextWindow: 128000, maxTokens: 16384, reasoningEfforts: { high: 'high' },
        compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek', supportsStore: false, maxTokensField: 'max_tokens' } })) },
    disabledPatches: DSH_DISABLED.map(id => ({ id, disabled: true })),
  };
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
  MODELS, MODEL_IDS, DEFAULT_MODEL, DEFAULT_PORT, KEY_ENV, PROVIDER_ID, LABEL, CODEX_WINDOWS_SANDBOX_DEFAULT, codexWindowsSandbox,
  proxyDir, endpointFile, readEndpoint, ensureEndpoint, setEndpointPort, sessionTag, sessionKey, normalizeModel, launchModel,
  applyNoProxy, applyEndpointNoProxy, usesProxy, applyClaudeEnv, codexCatalog, codexHome, ensureCodexHome, applyCodexEnv, dshRoute, findNodeOnPath,
};
