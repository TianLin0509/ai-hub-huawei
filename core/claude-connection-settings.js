'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// --settings env overrides user/project env; inherited shell env alone does not.
// Keep this limited to connections explicitly selected in Hub. Local CLI logins
// and subscription sessions keep their existing configuration behavior.
const PROVIDER_KEYS = Object.freeze(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD']);
const CONNECTION_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  ...PROVIDER_KEYS,
]);

function connectionEnv(values = {}, env = {}, model = '') {
  const explicit = values.COMPANY_CLI
    ? values.CLAUDE_BACKEND === 'proxy' || values.CLAUDE_API_BASE_URL || values.CLAUDE_API_KEY || values.CLAUDE_API_MODEL
    : values.CLAUDE_BACKEND === 'api' && values.CLAUDE_API_KEY;
  if (!explicit) return null;
  // A local company CLI may be configured with only an endpoint or model.
  // Missing fields still belong to that CLI, including credentials in its
  // user settings. Only Hub proxy/full API connections own every auth field.
  if (values.COMPANY_CLI && values.CLAUDE_BACKEND !== 'proxy') {
    const selected = {};
    if (values.CLAUDE_API_BASE_URL) Object.assign(selected, {
      ANTHROPIC_BASE_URL: String(env.ANTHROPIC_BASE_URL || values.CLAUDE_API_BASE_URL), ANTHROPIC_API_BASE_URL: '',
      ...Object.fromEntries(PROVIDER_KEYS.map(key => [key, ''])),
    });
    if (values.CLAUDE_API_KEY) Object.assign(selected, { ANTHROPIC_AUTH_TOKEN: String(env.ANTHROPIC_AUTH_TOKEN || values.CLAUDE_API_KEY),
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_SESSION_ACCESS_TOKEN: '' });
    if (model || values.CLAUDE_API_MODEL) selected.ANTHROPIC_MODEL = String(model || env.ANTHROPIC_MODEL || values.CLAUDE_API_MODEL);
    return selected;
  }
  const result = Object.fromEntries(CONNECTION_KEYS.map(key => [key, String(env[key] || '')]));
  for (const key of PROVIDER_KEYS) result[key] = '';
  if (model) result.ANTHROPIC_MODEL = String(model);
  return result;
}

function settingsFiles(env, cwd) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
  const files = [path.join(home, 'settings.json')];
  // Claude also loads project settings above cwd. Inspect only the two known
  // settings files at each level; never walk directory contents or user history.
  for (let dir = cwd && path.resolve(cwd); dir;) {
    files.push(path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'));
    const parent = path.dirname(dir);
    dir = parent === dir ? null : parent;
  }
  return [...new Set(files)];
}

function connectionSettings({ values, env = {}, model = '', cwd, fsModule = fs } = {}) {
  const overlay = connectionEnv(values, env, model);
  if (!overlay) return { env: null, notice: '' };
  const conflicts = new Set();
  for (const file of settingsFiles(env, cwd)) {
    try {
      if (fsModule.statSync(file).size > 1024 * 1024) continue;
      const settings = JSON.parse(String(fsModule.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
      for (const key of CONNECTION_KEYS) {
        if (Object.hasOwn(overlay, key) && settings.env && Object.hasOwn(settings.env, key) && String(settings.env[key]) !== overlay[key]) conflicts.add(key);
      }
    } catch { /* Missing/invalid settings remain the CLI's own diagnostic. */ }
  }
  return { env: overlay, notice: conflicts.size
    ? `检测到 Claude 配置中的连接设置与 Hub 冲突（${[...conflicts].join('、')}），本会话优先使用 Hub 选择的连接设置；原配置文件未修改。`
    : '' };
}

function assertSettingsSupport(connection, args) {
  if (connection.env && !args.includes('--settings')) throw Object.assign(
    new Error('当前 Claude CLI 不支持会话连接设置，请在安装中心升级 Claude 后重试。原配置文件未修改。'),
    { code: 'CLAUDE_CONNECTION_SETTINGS_UNSUPPORTED' });
}

module.exports = { CONNECTION_KEYS, PROVIDER_KEYS, connectionEnv, connectionSettings, assertSettingsSupport };
