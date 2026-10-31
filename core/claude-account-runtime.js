'use strict';

// A session owns a stable runtime directory. Only account authentication changes
// during hot switching; no history is reconstructed or summarised on a switch.
const fs = require('node:fs');
const path = require('node:path');
const { accessOnly, atomicJson, readJson, globalConfigPath, withDirectoryLocks, fail } = require('./claude-account-credentials');
const MARKER = '.hub-account.json';
const SHARED_CONFIG_ITEMS = ['CLAUDE.md', 'settings.json', 'settings.local.json', 'keybindings.json',
  'rules', 'skills', 'agents', 'commands', 'output-styles', 'plans', 'hooks', 'scripts'];
const AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CCR_OAUTH_TOKEN_FILE', 'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY'];
// The device id (userID) travels with every API request next to the account id,
// so it must follow the logged-in account, never the directory it was copied from.
// An account without a stored id drops the copied one; Claude then mints its own.
// machineID is a second per-directory device id (Claude Code error reports and
// remote features); it belongs to the account just like userID.
const DEVICE_KEYS = ['userID', 'machineID'];
const accountIdentity = config => ({ oauthAccount: config.oauthAccount,
  ...Object.fromEntries(DEVICE_KEYS.map(key => [key, config[key] || undefined])) });
const enabledValue = value => value !== undefined && value !== null && !['', '0', 'false', 'no'].includes(String(value).toLowerCase());

function runtimeHome(root, sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId || '')) throw fail('CLAUDE_RUNTIME_ID', 'Claude 会话标识无效');
  return path.join(path.resolve(root), 'claude-account-runtimes', sessionId);
}
function copyIfPresent(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true, errorOnExist: true, force: false });
}
function validateSettings(settings) {
  if (settings?.apiKeyHelper || AUTH_ENV.some(key => enabledValue(settings?.env?.[key]))) {
    throw fail('CLAUDE_AUTH_OVERRIDE', '此 Claude 配置使用其他认证来源，请关闭自动换号或改用订阅登录配置');
  }
}
function prepareRuntime({ root, sessionId, profile, currentProfile = profile, opts = {}, cwd, env }) {
  validateSettings({ env });
  for (const settingsFile of [path.join(profile.home, 'settings.json'), path.join(profile.home, 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    validateSettings(readJson(settingsFile, true));
  }
  const home = runtimeHome(root, sessionId);
  if (opts.claudeRuntimeHome && path.resolve(opts.claudeRuntimeHome).toLowerCase() !== home.toLowerCase()) {
    throw fail('CLAUDE_RUNTIME_PATH', 'Claude 原生运行目录与会话不匹配，未创建空白会话');
  }
  const marker = readJson(path.join(home, MARKER), true);
  if (marker) {
    if (marker.sessionId !== sessionId || marker.contextProfile !== profile.id) throw fail('CLAUDE_RUNTIME_ID', 'Claude 原生运行目录归属不匹配');
    validateSettings(readJson(path.join(home, 'settings.json'), true));
    validateSettings(readJson(path.join(home, 'settings.local.json'), true));
    const nativeId = opts.resumeCCSessionId || opts.ccSessionId;
    if (nativeId && !require('./claude-native-history').findNativeClaudeHistory(nativeId, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: home } })) {
      throw fail('CLAUDE_HISTORY_MISSING', '原生会话记录缺失，未创建新会话替代');
    }
    return { home, marker };
  }
  if (opts.claudeRuntimeHome) throw fail('CLAUDE_RUNTIME_MISSING', 'Claude 原生运行目录缺失，未新建或降级历史');
  if (fs.existsSync(home)) throw fail('CLAUDE_RUNTIME_INCOMPLETE', 'Claude 运行目录准备未完成，请保留现场并重新打开原会话');
  if (opts.useContinue || opts.resumePicker || opts.forkCCSessionId) {
    throw fail('CLAUDE_RUNTIME_EXACT_HISTORY', '自动换号需要明确的原生会话，请从具体历史打开或新建会话');
  }
  const credentials = readJson(path.join(currentProfile.home, '.credentials.json'));
  if (!(Number(credentials.claudeAiOauth?.expiresAt) > Date.now() + 30_000)) {
    throw fail('CLAUDE_RELOGIN_REQUIRED', 'Claude 登录凭据已过期，请先刷新该账号登录再启用自动换号');
  }
  const settings = readJson(path.join(profile.home, 'settings.json'), true);
  validateSettings(settings);
  const global = readJson(globalConfigPath(profile.home), true) || {};
  // Authentication belongs to an account; personal instructions belong to the person.
  // Seed a fresh managed copy (and its receipt), never the account's stale CLAUDE.md.
  // Clean installs without an opted-in person source retain their native configuration.
  const context = require('./agent-user-context');
  const person = !require('./session-scenes').isCleanPurpose(opts.purpose) && context.loadUserContext(env, root);
  const staging = home + '.preparing';
  if (fs.existsSync(staging)) throw fail('CLAUDE_RUNTIME_INCOMPLETE', '上次运行目录准备未完成，已保留现场');
  fs.mkdirSync(staging, { recursive: true });
  for (const item of SHARED_CONFIG_ITEMS) {
    if (person && item === 'CLAUDE.md') continue;
    copyIfPresent(path.join(profile.home, item), path.join(staging, item));
  }
  if (person) context.syncNativeUserContext({kind:'claude',nativeHome:staging,env,dataDir:root});
  for (const item of ['installed_plugins.json', 'known_marketplaces.json', 'config.json', 'blocklist.json']) {
    copyIfPresent(path.join(profile.home, 'plugins', item), path.join(staging, 'plugins', item));
  }
  const currentGlobal = currentProfile.id === profile.id ? global : readJson(globalConfigPath(currentProfile.home));
  atomicJson(path.join(staging, '.claude.json'), { ...global, ...accountIdentity(currentGlobal) });
  atomicJson(path.join(staging, '.credentials.json'), accessOnly(credentials));
  const nativeId = opts.resumeCCSessionId || opts.ccSessionId;
  const projectKey = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  copyIfPresent(path.join(profile.home, 'projects', projectKey, 'memory'), path.join(staging, 'projects', projectKey, 'memory'));
  if (nativeId) {
    const source = require('./claude-native-history').findNativeClaudeHistory(nativeId, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: profile.home } });
    if (!source) throw fail('CLAUDE_HISTORY_MISSING', '原生会话记录缺失，未创建新会话替代');
    const project = path.basename(path.dirname(source));
    copyIfPresent(source, path.join(staging, 'projects', project, nativeId + '.jsonl'));
    copyIfPresent(path.join(path.dirname(source), nativeId), path.join(staging, 'projects', project, nativeId));
    for (const item of ['file-history', 'tasks', 'session-env']) copyIfPresent(path.join(profile.home, item, nativeId), path.join(staging, item, nativeId));
    const todos = path.join(profile.home, 'todos');
    if (fs.existsSync(todos)) for (const name of fs.readdirSync(todos)) {
      if (name.startsWith(nativeId + '-')) copyIfPresent(path.join(todos, name), path.join(staging, 'todos', name));
    }
  }
  const initial = { schemaVersion: 1, sessionId, contextProfile: profile.id, profile: currentProfile.id,
    generation: 0, changedAt: Date.now(), credentialsExpiresAt: credentials.claudeAiOauth.expiresAt };
  atomicJson(path.join(staging, MARKER), initial);
  fs.renameSync(staging, home);
  return { home, marker: initial };
}

function applyRuntimeEnv(env, home) {
  for (const key of AUTH_ENV) delete env[key];
  env.CLAUDE_CONFIG_DIR = home;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = home;
  env.CLAUDE_HUB_ACCOUNT_STATE = path.join(home, MARKER);
}

async function installAccount({ home, profile, credentials, scope, expectedGeneration, shouldInstall = () => true, lockTimeoutMs = 9000 }) {
  return withDirectoryLocks([path.join(home, '.oauth_refresh.lock'), fs.realpathSync(home) + '.lock',
    globalConfigPath(home) + '.lock'], async assertLock => {
  const marker = readJson(path.join(home, MARKER));
  if (marker.generation !== expectedGeneration) throw fail('CLAUDE_ACCOUNT_CHANGED', '当前会话账号已经改变，本次未重复切换');
  const credentialFile = path.join(home, '.credentials.json');
  const configFile = path.join(home, '.claude.json');
  const beforeCredentials = readJson(credentialFile);
  const beforeConfig = readJson(configFile);
  const source = readJson(globalConfigPath(profile.home));
  if (!source.oauthAccount) throw fail('CLAUDE_IDENTITY_MISSING', '目标账号身份信息不完整，未换号');
  // Retain this runtime's MCP OAuth state; do not restore stale machine-wide
  // credentials from the target account, as early cswap versions did.
  const nextCredentials = { ...beforeCredentials, claudeAiOauth: accessOnly(credentials).claudeAiOauth };
  const nextMarker = { ...marker, profile: profile.id, scope, generation: marker.generation + 1,
    changedAt: Date.now(), credentialsExpiresAt: credentials.claudeAiOauth.expiresAt };
  let mutated = false;
  try {
    assertLock();
    if (!shouldInstall()) return null;
    mutated = true;
    atomicJson(configFile, { ...beforeConfig, ...accountIdentity(source) });
    atomicJson(credentialFile, nextCredentials);
    atomicJson(path.join(home, MARKER), nextMarker);
  } catch (error) {
    if (!mutated) throw error;
    try { assertLock(); atomicJson(configFile, beforeConfig); atomicJson(credentialFile, beforeCredentials); atomicJson(path.join(home, MARKER), marker); }
    catch { throw fail('CLAUDE_ACCOUNT_ROLLBACK', '账号切换回退未完成，请先核对会话登录'); }
    throw error;
  }
  return nextMarker;
  }, { timeoutMs: lockTimeoutMs });
}

async function mirrorAccess({ home, profile, credentials, lockTimeoutMs = 9000 }) {
  return withDirectoryLocks([path.join(home, '.oauth_refresh.lock'), fs.realpathSync(home) + '.lock'], async assertLock => {
  const marker = readJson(path.join(home, MARKER));
  if (marker.profile !== profile.id) return false;
  const file = path.join(home, '.credentials.json');
  const before = readJson(file);
  const oauth = accessOnly(credentials).claudeAiOauth;
  if (JSON.stringify(before.claudeAiOauth) === JSON.stringify(oauth)) return false;
  assertLock();
  atomicJson(file, { ...before, claudeAiOauth: oauth });
  return true;
  }, { timeoutMs: lockTimeoutMs });
}

// Guard (2026-10-28): a runtime's .claude.json must always carry the identity —
// account and device id — of the account whose login it currently holds. Old
// switches left one account's device id under another's login; whatever the
// cause (an old runtime, a CLI writing back a stale copy), this restores it
// before a launch and on every background refresh, and records each repair.
function identityDrift(home, profile) {
  const file = path.join(home, '.claude.json');
  const state = readJson(file, true);
  const source = readJson(globalConfigPath(profile.home), true);
  if (!state || typeof state !== 'object' || Array.isArray(state) || !source?.oauthAccount) return null;
  const want = accountIdentity(source);
  const same = state.oauthAccount?.accountUuid === want.oauthAccount.accountUuid
    && DEVICE_KEYS.every(key => (state[key] || undefined) === want[key]);
  return same ? null : { file, state, want };
}
const shortHash = value => value ? require('crypto').createHash('sha256').update(String(value)).digest('hex').slice(0, 8) : '-';
function repairDrift(home, profile, drift, source) {
  atomicJson(drift.file, { ...drift.state, ...drift.want });
  const entry = { at: new Date().toISOString(), source, session: path.basename(home), account: profile.id,
    deviceFrom: shortHash(drift.state.userID), deviceTo: shortHash(drift.want.userID),
    machineChanged: (drift.state.machineID || undefined) !== drift.want.machineID,
    accountChanged: drift.state.oauthAccount?.accountUuid !== drift.want.oauthAccount.accountUuid };
  try {
    const log = path.join(path.dirname(path.dirname(home)), 'diagnostics', 'claude-identity-guard.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
  return entry;
}
// Before the CLI starts: nothing else writes this runtime yet.
function ensureRuntimeIdentitySync(home, profile, source = 'launch') {
  const drift = identityDrift(home, profile);
  return drift ? repairDrift(home, profile, drift, source) : null;
}
// While a session may be running: same locks as an account switch.
async function ensureRuntimeIdentity({ home, profile, lockTimeoutMs = 9000 }) {
  if (!identityDrift(home, profile)) return null;
  return withDirectoryLocks([fs.realpathSync(home) + '.lock', globalConfigPath(home) + '.lock'], async assertLock => {
    const marker = readJson(path.join(home, MARKER), true);
    if (!marker || marker.profile !== profile.id) return null;
    const drift = identityDrift(home, profile);
    if (!drift) return null;
    assertLock();
    return repairDrift(home, profile, drift, 'refresh');
  }, { timeoutMs: lockTimeoutMs });
}

module.exports = { MARKER, runtimeHome, prepareRuntime, applyRuntimeEnv, installAccount, mirrorAccess, validateSettings,
  identityDrift, ensureRuntimeIdentity, ensureRuntimeIdentitySync };
