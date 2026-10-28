'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexAppServerClient } = require('./codex-app-server-client');

// Verified against rust-v0.164.0 login/src/auth/{manager,workload_identity,
// personal_access_token,agent_identity}.rs, protocol/src/shell_environment.rs
// and model-provider-info/src/lib.rs. Base-URL compatibility variables are
// cleared too; arbitrary MCP variables and the user's network proxy survive.
const ACCOUNT_ENV = new Set([
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL',
  'CODEX_OSS_BASE_URL', 'CODEX_OSS_PORT',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID', 'CODEX_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_JWKS_BASE_URL',
]);

function cleanCodexAccountEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !ACCOUNT_ENV.has(key.toUpperCase())));
}

class NamespaceError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'CodexAccountNamespaceError';
    this.code = `CODEX_ACCOUNT_NAMESPACE_${category}`;
    this.notSent = true;
  }
}
const errorFor = (category, message) => new NamespaceError(category, message);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const present = value => value != null && value !== ''
  && !(record(value) && Object.keys(value).length === 0);

function validateConfig(config) {
  if (!record(config)) throw errorFor('CONFIG', 'Codex 有效配置未返回，未启动订阅会话');
  if (config.model_provider != null && config.model_provider !== 'openai')
    throw errorFor('PROVIDER', 'Codex 有效配置选择了其他模型服务，未启动订阅会话');
  if (config.forced_login_method !== 'chatgpt' || config.cli_auth_credentials_store !== 'file')
    throw errorFor('AUTH_STORE', 'Codex 订阅登录方式或凭据存储未确认，未启动会话');
  // config/read materializes this official ChatGPT default even when the user
  // never configured a route. Only trailing slashes are normalized: URL parsing
  // could silently normalize credentials, ports or traversal in custom input.
  const officialChatgptBase = typeof config.chatgpt_base_url === 'string'
    && config.chatgpt_base_url.replace(/\/+$/, '') === 'https://chatgpt.com/backend-api';
  if (present(config.openai_base_url) || (present(config.chatgpt_base_url) && !officialChatgptBase))
    throw errorFor('ENDPOINT', 'Codex 有效配置覆盖了订阅服务地址，未启动会话');
  if (config.model_providers != null && !record(config.model_providers))
    throw errorFor('CONFIG', 'Codex 模型服务配置结构无效，未启动会话');
  const provider = config.model_providers?.openai;
  if (provider == null) return;
  if (!record(provider)) throw errorFor('CONFIG', 'Codex 模型服务配置结构无效，未启动会话');
  const routes = ['base_url', 'model_catalog_url', 'env_key', 'experimental_bearer_token',
    'auth', 'gateway_oauth', 'aws', 'query_params', 'http_headers', 'env_http_headers'];
  if (routes.some(key => present(provider[key])))
    throw errorFor('PROVIDER_ROUTE', 'Codex 有效配置包含自定义认证、请求头或服务路由，未启动订阅会话');
  if (provider.wire_api != null && provider.wire_api !== 'responses')
    throw errorFor('PROTOCOL', 'Codex 有效配置更改了订阅协议，未启动会话');
  // config/read serializes ModelProviderInfo defaults, including
  // requires_openai_auth=false for a timeout-only user entry. In 0.164 the
  // built-in openai provider wins merge_configured_model_providers; that
  // default is not an effective auth override. File + ChatGPT remain forced.
}

function bounded(call, timeoutMs, category) {
  let timer;
  return Promise.race([
    Promise.resolve().then(call),
    new Promise((_, reject) => { timer = setTimeout(() => reject(errorFor(category,
      'Codex 订阅配置检查或探针清理超时，未启动会话')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// 2026-10-27: each probe starts a codex app-server (measured 0.5–1.3 s) before the
// terminal may open. A passed check is reused only while every input that can
// change the effective config is byte-for-byte the same: the account's own TOML
// files, project .codex/config.toml from cwd up to the root, machine-wide
// config, the Codex program and the CODEX_/OPENAI_ environment. Failures are
// never cached, and a pass expires after PASS_REUSE_MS regardless.
const PASS_REUSE_MS = 30 * 60 * 1000;
function statSig(file) {
  try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
}
function tomlSigs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /\.toml$/i.test(name)).sort(); } catch {}
  return names.map(name => name + '=' + statSig(path.join(dir, name)));
}
function namespaceFingerprint({ home, cwd, env, program }) {
  const parts = ['home', path.resolve(home), ...tomlSigs(path.resolve(home)), 'cwd', path.resolve(cwd)];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    parts.push(dir + '=' + statSig(path.join(dir, '.codex', 'config.toml')));
    if (path.dirname(dir) === dir) break;
  }
  for (const root of [env.ProgramData || env.PROGRAMDATA, '/etc/codex'].filter(Boolean)) {
    const dir = root === '/etc/codex' ? root : path.join(root, 'OpenAI', 'Codex');
    parts.push(dir, ...tomlSigs(dir));
  }
  parts.push('program', program || '-', program ? statSig(program) : '-');
  for (const key of Object.keys(env).filter(k => /^(CODEX|OPENAI)_/i.test(k)).sort()) parts.push(key + '=' + env[key]);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}
function codexProgram(env) {
  if (process.platform !== 'win32') return null;
  try {
    const found = require('./codex-windows-command').locateWindowsCodex(env);
    if (!found) return null;
    // An npm upgrade rewrites the package, not necessarily the shim.
    return found.command || path.join(path.dirname(found.shim), 'node_modules', '@openai', 'codex', 'package.json');
  } catch { return null; }
}
const passCache = new Map();

async function assertCodexAccountNamespace({ home, cwd, env = process.env, Client = CodexAppServerClient,
  timeoutMs = 15000, cleanupTimeoutMs = 8000, cache = null, now = Date.now, program = codexProgram } = {}) {
  if (typeof home !== 'string' || !home || typeof cwd !== 'string' || !cwd)
    throw errorFor('INPUT', 'Codex 账号目录或工作目录未指定');
  const probeEnv = cleanCodexAccountEnv(env);
  for (const key of Object.keys(probeEnv)) if (key.toUpperCase() === 'CODEX_HOME') delete probeEnv[key];
  probeEnv.CODEX_HOME = path.resolve(home);
  let fingerprint = null;
  if (cache) {
    try { fingerprint = namespaceFingerprint({ home, cwd, env: probeEnv, program: program(probeEnv) }); } catch { fingerprint = null; }
    const passedAt = fingerprint && cache.get(fingerprint);
    if (passedAt && now() - passedAt >= 0 && now() - passedAt < PASS_REUSE_MS) return { ok: true, cached: true };
  }
  const errors = [];
  let client, phase = 'START';
  try {
    client = new Client({ env: probeEnv, cwd: path.resolve(cwd), timeoutMs,
      args: ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'] });
    await bounded(() => client.start(), timeoutMs, 'START_TIMEOUT');
    phase = 'READ';
    const response = await bounded(() => client.request('config/read', {
      includeLayers: false, cwd: path.resolve(cwd),
    }, timeoutMs), timeoutMs, 'READ_TIMEOUT');
    validateConfig(response?.config);
  } catch (error) {
    // Never attach upstream errors as causes: their messages/data can contain
    // config values, environment values, endpoints or credential commands.
    errors.push(error instanceof NamespaceError ? error : errorFor(phase,
      phase === 'START' ? 'Codex 配置探针启动失败，未启动订阅会话' : 'Codex 有效配置读取失败，未启动订阅会话'));
  } finally {
    if (client) {
      try { await bounded(() => client.close(), cleanupTimeoutMs, 'CLOSE_TIMEOUT'); }
      catch (error) { errors.push(error instanceof NamespaceError ? error : errorFor('CLOSE', 'Codex 配置探针关闭失败，未启动订阅会话')); }
      // Always await exit, even if close itself failed. A successful config
      // read alone is not permission to leave an unconfirmed child running.
      try { await bounded(() => client.waitForExit(), cleanupTimeoutMs, 'EXIT_TIMEOUT'); }
      catch (error) { errors.push(error instanceof NamespaceError ? error : errorFor('EXIT', 'Codex 配置探针退出未确认，未启动订阅会话')); }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw Object.assign(new AggregateError(errors,
    'Codex 订阅配置检查未通过，且探针清理发生异常'), { code: 'CODEX_ACCOUNT_NAMESPACE_MULTIPLE', notSent: true });
  if (cache && fingerprint) {
    if (cache.size > 200) cache.clear();
    cache.set(fingerprint, now());
  }
  return { ok: true };
}

module.exports = { cleanCodexAccountEnv, assertCodexAccountNamespace, namespaceFingerprint, passCache, PASS_REUSE_MS };
