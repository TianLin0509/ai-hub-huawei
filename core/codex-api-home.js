'use strict';
// Codex「自有接口 / 自有 API 账号」的 CODEX_HOME：写 config.toml（模型、供应商、wire_api）和 auth.json（Key）。
// 启动中心会话（core/session-manager.js ensureCodexApiProfile）和后台功能单次任务（core/harness-route.js）共用这一份写法。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tomlString = value => JSON.stringify(String(value || ''));
function writeCodexApiHome(codexHome, { provider = 'openai-api', baseUrl, model = '', apiKey = '', wireApi = 'responses', projectDir, requiresAuth = true, reasoningEffort = 'max' }) {
  if (!baseUrl) throw new Error('Codex 自有 API 请填写接口地址');
  const projectKey = path.resolve(projectDir || os.homedir());
  fs.mkdirSync(codexHome, { recursive: true });
  // 只接管 Hub 生成的顶层键，Codex 写下的 [hooks.state.*]、[tui] 等保留（同 DeepSeek profile）。
  require('./codex-managed-config').writeHubManagedCodexConfig(path.join(codexHome, 'config.toml'), [
    'disable_response_storage = true',
    ...(model ? [`model = ${tomlString(model)}`] : []),
    `model_provider = ${tomlString(provider)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
    `[model_providers.${provider}]`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(provider)}`,
    `requires_openai_auth = ${requiresAuth ? 'true' : 'false'}`,
    `wire_api = ${tomlString(require('./company-api-config').wireApi(wireApi || 'responses'))}`,
    '',
    `[projects.${tomlString(projectKey)}]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: apiKey || '' }), 'utf8');
  return codexHome;
}
module.exports = { writeCodexApiHome };
