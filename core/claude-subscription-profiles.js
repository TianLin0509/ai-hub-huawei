'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizeProfiles(profiles, home = process.env.CLAUDE_HUB_HOME_DIR || os.homedir()) {
  const rows = new Map([
    ['default', { id: 'default', label: '主账号', home: '' }],
    ['second', { id: 'second', label: '第二账号', home: path.join(home, '.claude-profiles', 'second') }],
  ]);
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (!p || !/^[\w-]{1,64}$/.test(p.id || '')) continue;
    rows.set(p.id, { id: p.id, label: String(p.label || p.id), home: String(p.home || ''), ...(p.network ? { network: { ...p.network } } : {}),
      // VPS 登录环境（core/vps-login-env.js）：账号的网页登录与官方授权都在这个远程浏览器里完成。
      ...(/^(?:[abcd]|u[0-9a-f]{8})$/.test(p.loginEnv || '') ? { loginEnv: p.loginEnv } : {}) });
  }
  return [...rows.values()];
}

function resolveProfile(config, id, env = process.env, home = env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir()) {
  id = id || config.claudeSubscriptionProfile || 'default';
  const row = normalizeProfiles(config.claudeSubscriptionProfiles, home).find(p => p.id === id);
  if (!row) throw new Error('Claude 账号配置不存在，未切换到主账号');
  const dir = row.home || (id === 'default' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : '');
  if (!dir) throw new Error('Claude 独立账号目录未配置');
  const resolved = path.resolve(require('./codex-usage-scope').expandHomePath(dir, home));
  if (env.CLAUDE_HUB_HOME_DIR) {
    const boundary = env.CLAUDE_HUB_DATA_DIR ? path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)) : path.resolve(home);
    const rel = path.relative(boundary, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Claude 账号目录超出隔离测试 home');
  }
  const otherHomes = normalizeProfiles(config.claudeSubscriptionProfiles, home).filter(p => p.id !== id)
    .map(p => p.home || (p.id === 'default' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : ''));
  if (otherHomes.some(h => h && path.resolve(require('./codex-usage-scope').expandHomePath(h, home)).toLowerCase() === resolved.toLowerCase())) {
    throw new Error('两个 Claude 账号不能共用登录目录');
  }
  return { ...row, home: resolved, configDir: row.home || env.CLAUDE_CONFIG_DIR || (id !== 'default' ? resolved : '') };
}

function connectionId(id) { return !id || id === 'default' ? 'claude' : 'claude-' + id; }

function profileForSession(opts, config, env = process.env) {
  // Old histories belong to the original account even after the launch default changes.
  const history = opts.useResume || opts.resumeCCSessionId || opts.forkCCSessionId || opts.ccSessionId;
  let id = opts.claudeProfile || (history ? 'default' : config.claudeSubscriptionProfile);
  const transcriptPath = opts.transcriptPath || opts.resumeTranscriptPath;
  if (!opts.claudeProfile && transcriptPath) {
    for (const p of normalizeProfiles(config.claudeSubscriptionProfiles)) {
      const profile = resolveProfile(config, p.id, env);
      const rel = path.relative(path.join(profile.home, 'projects'), path.resolve(transcriptPath));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { id = p.id; break; }
    }
  }
  const profile = resolveProfile(config, id, env);
  if (opts.claudeConfigDir && path.resolve(opts.claudeConfigDir).toLowerCase() !== profile.home.toLowerCase()) {
    throw new Error('此会话原来的 Claude 账号目录已改变，请先恢复账号配置');
  }
  return profile;
}

function readOauthAccount(home) {
  try {
    // The default CLI stores identity beside .claude, not inside it. A stale
    // nested file from an old explicit CLAUDE_CONFIG_DIR must never shadow it.
    const file = path.basename(home) === '.claude'
      ? path.join(path.dirname(home), '.claude.json') : path.join(home, '.claude.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || {};
  } catch { return {}; }
}

function accountLabel(home) {
  return String(readOauthAccount(home).emailAddress || '');
}

// 看板悬停用：邮箱、套餐、订阅起始日。官方 CLI 本地不记到期日，只有起始日。
function accountInfo(home) {
  const o = readOauthAccount(home);
  const str = v => (typeof v === 'string' ? v : '');
  return { email: str(o.emailAddress), plan: str(o.organizationType), billing: str(o.billingType),
    subscribedAt: Date.parse(o.subscriptionCreatedAt) || 0 };
}

function usageScope(config, id, env = process.env) {
  const p = resolveProfile(config, id, env);
  const identity = accountLabel(p.home);
  return p.id + ':' + require('crypto').createHash('sha256').update(p.home.toLowerCase()+'\0'+identity).digest('hex').slice(0,20);
}

function applyNetworkEnv(target, config, env = process.env, profileId = target.CLAUDE_HUB_CLAUDE_PROFILE || 'default') {
  const profile = resolveProfile(config, profileId, env);
  const strict = require('./claude-account-network').environment(profile);
  if (strict) { Object.assign(target, strict); return; }
  Object.assign(target, sharedNetworkEnv(config, env));
}

// Reuse the user's established Claude egress policy for both logins. Copy
// only transport settings, never credentials, cookies, hooks or account data.
function sharedNetworkEnv(config, env = process.env) {
  const primary=resolveProfile(config,'default',env);
  const file=path.join(primary.home,'settings.json');
  if (!fs.existsSync(file)) return {};
  const settings=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const out = {};
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING']) {
    if (typeof settings.env?.[key] === 'string') out[key]=settings.env[key];
  }
  return out;
}

// 这台电脑上还没有任何 Claude 账号登录过（各账号目录都没有 .credentials.json）：新装用户的第一个会话。
// 这时没有可换的号、也没有可核对的凭据，按普通 Claude 启动，让 CLI 自己走登录流程（2026-10-28）。
// 只要有一个账号登录过、或者有账号目录解析不了（拿不准就当登录过），就照旧走账号管理与严格核对。
// CLAUDE_CONFIG_DIR 指到别处时，标准位置 ~/.claude 里的旧登录也要算（Codex 复审）。
function noClaudeLoginYet(config, env = process.env) {
  const userHome = env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME || os.homedir();
  if (fs.existsSync(path.join(userHome, '.claude', '.credentials.json'))) return false;
  for (const p of normalizeProfiles(config && config.claudeSubscriptionProfiles)) {
    let home = '';
    try { home = resolveProfile(config || {}, p.id, env).home; } catch { return false; }
    if (!home || fs.existsSync(path.join(home, '.credentials.json'))) return false;
  }
  return true;
}

const samePath = (a, b) => {
  const x = path.resolve(a).replace(/[\\/]+$/, ''), y = path.resolve(b).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const insideDir = (dir, file) => {
  const rel = path.relative(process.platform === 'win32' ? dir.toLowerCase() : dir, process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// 首次使用豁免（2026-10-28，两轮 Codex 审核后收紧）：用默认账号、没有运行目录、这台电脑上还没有任何 Claude 账号登录过。
// 接历史（恢复、分支、继续、选历史）时必须有证据表明历史在默认账号目录里：带了原账号目录就必须是默认账号目录，
// 带了会话记录路径就必须都在默认账号的 projects 下，两样都没带就不豁免。主进程登录检查和会话管理器用同一条判断。
function firstLoginExempt(opts = {}, config = {}, env = process.env) {
  if (opts.claudeRuntimeHome) return false;
  if ((opts.claudeProfile || config.claudeSubscriptionProfile || 'default') !== 'default') return false;
  if (!noClaudeLoginYet(config, env)) return false;
  let home = '';
  try { home = resolveProfile(config, 'default', env).home; } catch { return false; }
  if (opts.claudeConfigDir && !samePath(opts.claudeConfigDir, home)) return false;
  const transcripts = [opts.transcriptPath, opts.resumeTranscriptPath].filter(Boolean);
  if (transcripts.some(t => !insideDir(path.join(home, 'projects'), t))) return false;
  const history = opts.useResume || opts.resumeCCSessionId || opts.forkCCSessionId || opts.ccSessionId || opts.useContinue || opts.resumePicker;
  if (history && !opts.claudeConfigDir && !transcripts.length) return false;
  return true;
}

module.exports = { noClaudeLoginYet, firstLoginExempt, normalizeProfiles, resolveProfile, connectionId, profileForSession, accountLabel, accountInfo, usageScope, applyNetworkEnv, sharedNetworkEnv };
