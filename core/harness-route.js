'use strict';
// 公司版「外壳 + 模型来源」落地成具体连接（2026-11-27 宗旨：部门 API / 自有 API 用户和 CodeAgent 用户同样的体验）。
// 后台功能（单次任务、会话功能）和启动中心用同一套字段：Claude Code 的 CLAUDE_BACKEND / CLAUDE_API_*，Codex 的 CODEX_HOME，
// 本机反代的 applyClaudeEnv / applyCodexEnv。来源：
//   gateway 部门 API key（本机反代的网关上游）  company 公司模型（本机反代，CodeAgent 账号）
//   own     自有接口（「设置 → 自有 API → 工具 → 自有接口」）  api 自有 API 账号（同页的账号表）  local 本机 CLI 自己的配置
const crypto = require('node:crypto'), path = require('node:path');
const SOURCES = ['gateway', 'company', 'own', 'api', 'local'];
const LABELS = { gateway: '部门 API key', company: '公司模型（CodeAgent 账号）', own: '自有接口', api: '自有 API', local: '本机 CLI 配置' };
const TOOLS = { claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' };
const PROXY = new Set(['gateway', 'company']);
const viaProxy = source => PROXY.has(source);
const rawConfig = () => require('./hub-config').readConfigJsonForUpdate();

// 自有接口 / 自有 API 账号的地址、Key、模型；Key 解不开时报和启动中心同一句话。
function connectionFor(sel, raw = rawConfig()) {
  const tool = TOOLS[sel.kind] || sel.kind;
  if (sel.source === 'own') {
    const c = require('./company-api-config').ownConnection(raw, sel.kind);
    if (!c) throw new Error(`${tool} 还没填自有接口：请到「设置 → 自有 API → ${tool} → 自有接口」填写地址、Key 和模型`);
    if (c.apiKeyNeedsInput) throw new Error(require('./own-api-secrets').KEY_NEEDED);
    return { baseURL: c.baseURL, apiKey: c.apiKey || '', model: sel.model || c.model || '', wireApi: c.wireApi || 'responses' };
  }
  if (sel.source === 'api') {
    const p = require('./cli-api-profiles').profiles(raw, sel.kind).find(x => x.id === sel.profileId);
    if (!p) throw new Error('这个自有 API 账号已经不在了，请在「功能使用的 Agent」里重新选择');
    require('./own-api-secrets').assertReadable(p);
    return { baseURL: p.baseURL || '', apiKey: p.apiKey || '', model: sel.model || p.model || '', wireApi: p.wireApi || 'responses', label: p.label || '' };
  }
  return null;
}

// Claude Code 会话的启动值（session-manager 的 cv 形状）：只改这一个会话的连接，不动全局「自有 API」设置。
function claudeValues(values, sel, raw) {
  const v = { ...values, COMPANY_CLI: true };
  if (viaProxy(sel.source)) return { ...v, CLAUDE_BACKEND: 'proxy', CLAUDE_UPSTREAM: sel.source === 'gateway' ? 'gateway' : 'company', ...(sel.model ? { CLAUDE_API_MODEL: sel.model } : {}) };
  if (sel.source === 'own' || sel.source === 'api') {
    const c = connectionFor(sel, raw || rawConfig());
    return { ...v, CLAUDE_BACKEND: 'api', CLAUDE_UPSTREAM: '', CLAUDE_API_BASE_URL: c.baseURL, CLAUDE_API_KEY: c.apiKey, CLAUDE_API_MODEL: c.model };
  }
  return { ...v, CLAUDE_BACKEND: 'local', CLAUDE_UPSTREAM: '', CLAUDE_API_BASE_URL: '', CLAUDE_API_KEY: '', CLAUDE_API_MODEL: '' };
}

// 单次任务（claude -p）：把连接写进子进程环境；返回 --settings 用的 env 覆盖（盖住用户 settings.json 里的连接），本机 CLI 配置返回 null。
function applyClaudeOnce(env, sel, { dataDir, tag, raw } = {}) {
  if (sel.source === 'local' || !sel.source) return null;
  const values = claudeValues({}, sel, raw);
  if (viaProxy(sel.source)) require('./company-model-proxy').applyClaudeEnv(env, { dataDir, sessionId: tag, model: sel.model, gateway: sel.source === 'gateway' });
  else {
    env.ANTHROPIC_BASE_URL = values.CLAUDE_API_BASE_URL;
    if (values.CLAUDE_API_MODEL) env.ANTHROPIC_MODEL = values.CLAUDE_API_MODEL;
    if (values.CLAUDE_API_KEY) {
      env.ANTHROPIC_AUTH_TOKEN = values.CLAUDE_API_KEY;
      for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN']) delete env[key];
    }
  }
  return require('./claude-connection-settings').connectionEnv(values, env, sel.model || values.CLAUDE_API_MODEL || '');
}

// 单次任务（codex exec）：经反代的用反代的 CODEX_HOME；自有接口 / 账号按连接内容建一个专用 CODEX_HOME（和启动中心同一份写法）。
function applyCodexOnce(env, sel, { dataDir, tag, cwd, raw } = {}) {
  if (sel.source === 'local' || !sel.source) return;
  if (viaProxy(sel.source)) {
    require('./company-model-proxy').applyCodexEnv(env, { dataDir, sessionId: tag, model: sel.model, projectDir: cwd, gateway: sel.source === 'gateway' });
    return;
  }
  const c = connectionFor(sel, raw || rawConfig());
  const id = crypto.createHash('sha256').update(JSON.stringify([sel.source, sel.profileId || '', c.baseURL, c.model, c.wireApi])).digest('hex').slice(0, 16);
  env.CODEX_HOME = require('./codex-api-home').writeCodexApiHome(path.join(dataDir, 'feature-agent-codex', id), {
    baseUrl: c.baseURL, model: c.model, apiKey: c.apiKey, wireApi: c.wireApi, projectDir: cwd, requiresAuth: !!c.apiKey });
  for (const key of Object.keys(env)) if (/^OPENAI_/.test(key)) delete env[key];
}

module.exports = { SOURCES, LABELS, TOOLS, viaProxy, connectionFor, claudeValues, applyClaudeOnce, applyCodexOnce };
