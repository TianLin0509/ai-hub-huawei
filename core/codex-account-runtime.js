'use strict';
// A stopped PTY can change its access credential without changing its context
// home. The canonical account remains the sole refresh-token owner. Callers
// must stop and await the old native writer before preparing this home.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { scanTomlStatements, simpleStringValue, tomlKey } = require('./toml-statements');

const MARKER = '.hub-codex-account-runtime.json';
const ROOT_FILES = ['AGENTS.md', 'AGENTS.override.md', 'hooks.json', 'models_cache.json', 'version.json'];
const RESOURCE_DIRS = ['skills', 'plugins', 'memories', 'rules', 'agents'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => normalized(a) === normalized(b);
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw fail('CODEX_RUNTIME_IO', 'Codex 运行目录无法读取'); } }
function plain(file, kind, required = true) {
  const info = stat(file);
  if (!info && !required) return false;
  if (!info || info.isSymbolicLink() || !(kind === 'dir' ? info.isDirectory() : info.isFile())) {
    throw fail('CODEX_RUNTIME_PATH', 'Codex 运行目录包含未知链接或不匹配的文件类型');
  }
  return true;
}
function json(file) {
  plain(file, 'file');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw fail('CODEX_RUNTIME_JSON', 'Codex 账号或运行目录记录无法读取'); }
}
function profileInfo(profile) {
  if (!profile || typeof profile.id !== 'string' || !profile.id || typeof profile.home !== 'string' || !path.isAbsolute(profile.home)) {
    throw fail('CODEX_RUNTIME_PROFILE', 'Codex 账号归属不完整');
  }
  const home = path.resolve(profile.home);
  plain(home, 'dir');
  // A canonical home may not secretly redirect a runtime back onto an account.
  if (!same(fs.realpathSync(home), home)) throw fail('CODEX_RUNTIME_PATH', 'Codex 账号目录不是独立真实目录');
  return { id: profile.id, home, homeHash: hash(normalized(home)) };
}
function fingerprint(profile, auth) {
  return hash(JSON.stringify([profile.id, profile.homeHash, auth.tokens.account_id, auth.tokens.access_token, auth.tokens.id_token]));
}
function readCredential(profile) {
  const auth = json(path.join(profile.home, 'auth.json'));
  if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || !auth.tokens
      || ['access_token', 'id_token', 'account_id'].some(key => typeof auth.tokens[key] !== 'string' || !auth.tokens[key])) {
    throw fail('CODEX_RUNTIME_AUTH', '所选 Codex 账号不是有效的订阅登录');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw fail('CODEX_RUNTIME_AUTH', 'Codex 访问凭据格式无法验证'); }
  const expiresAt = Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw fail('CODEX_RUNTIME_EXPIRED', 'Codex 访问凭据已到期，请先刷新原账号登录');
  const copy = { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: auth.tokens.access_token, id_token: auth.tokens.id_token, account_id: auth.tokens.account_id, refresh_token: '' },
    last_refresh: new Date().toISOString() };
  return { auth: copy, expiresAt, credentialFingerprint: fingerprint(profile, copy) };
}

// Reject API/provider/auth routing overrides instead of silently changing their
// meaning. MCP configuration is preserved; launcher environment and per-project
// config layers still need the caller's corresponding namespace validation.
function checkedConfig(text) {
  let statements;
  try { statements = scanTomlStatements(text).statements; }
  catch { throw fail('CODEX_RUNTIME_CONFIG', 'Codex 配置无法安全解析，未创建切号运行目录'); }
  const forbidden = new Set(['model_providers', 'openai_base_url', 'chatgpt_base_url', 'chatgpt_ws_base_url', 'openai_api_key',
    'api_key', 'auth_mode', 'auth', 'credentials', 'experimental_bearer_token', 'cloud_api', 'forced_chatgpt_workspace_id']);
  for (const item of statements) {
    // MCP servers may legitimately have their own credentials. Their namespace
    // does not choose the Codex model account and is deliberately left intact.
    const keys = item.path;
    if (keys[0] === 'mcp_servers') continue;
    // The scanner deliberately does not evaluate inline tables. Do not let a
    // profile hide account routing inside one and escape the path checks below.
    if (item.kind === 'kv' && keys[0] === 'profiles' && keys.length <= 2) {
      throw fail('CODEX_RUNTIME_NAMESPACE', 'Codex 内联配置档无法安全核对账号命名空间');
    }
    if (keys.some(key => forbidden.has(key.toLowerCase()))) throw fail('CODEX_RUNTIME_NAMESPACE', 'Codex 配置包含 API 或认证覆盖，不能使用订阅切号');
    const key = keys[keys.length - 1];
    if (item.kind === 'kv' && key === 'model_provider' && simpleStringValue(item.valueText) !== 'openai') {
      throw fail('CODEX_RUNTIME_NAMESPACE', 'Codex 自定义模型提供方不能使用订阅切号');
    }
    if (item.kind === 'kv' && key === 'forced_login_method' && simpleStringValue(item.valueText) !== 'chatgpt') {
      throw fail('CODEX_RUNTIME_NAMESPACE', 'Codex 配置强制使用其他认证方式');
    }
    if (item.kind === 'kv' && key === 'cli_auth_credentials_store' && keys.length > 1 && simpleStringValue(item.valueText) !== 'file') {
      throw fail('CODEX_RUNTIME_NAMESPACE', 'Codex 配置覆盖了独立文件凭据存储');
    }
  }
  return statements;
}
function absoluteConfigPath(valueText, contextHome) {
  let value = simpleStringValue(valueText);
  if (value === null) {
    try { value = JSON.parse(valueText); } catch { /* Unsupported TOML string syntax blocks relocation. */ }
  }
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw fail('CODEX_RUNTIME_CONFIG_PATH', 'Codex 配置路径无法安全保留其原始位置');
  const resolved = /^~[\\/]/.test(value) ? path.resolve(os.homedir(), value.slice(2)) : path.resolve(contextHome, value);
  return JSON.stringify(resolved.replace(/\\/g, '/'));
}
// Split already syntax-checked TOML array/inline-table members, respecting
// quoted commas and nested structures. Never search/replace arbitrary text:
// prompt bodies and MCP command arguments may contain path-looking strings.
function compoundMembers(value, open, close) {
  const text = value.trim();
  if (!text.startsWith(open) || !text.endsWith(close)) throw fail('CODEX_RUNTIME_CONFIG_PATH', 'Codex 复合路径配置无法安全迁移');
  const inner = text.slice(1, -1), result = [];
  let buffer = '', quote = '', triple = false, depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buffer += ch;
      if (quote === '"' && ch === '\\') { buffer += inner[++i] || ''; continue; }
      if (ch === quote && (!triple || inner.slice(i, i + 3) === quote.repeat(3))) {
        if (triple) { buffer += quote.repeat(2); i += 2; }
        quote = ''; triple = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch; triple = inner.slice(i, i + 3) === ch.repeat(3);
      buffer += triple ? ch.repeat(3) : ch; if (triple) i += 2;
    } else if (ch === '#') {
      while (i < inner.length && inner[i] !== '\n') i++;
      buffer += ' ';
    } else if (ch === ',' && depth === 0) { if (buffer.trim()) result.push(buffer.trim()); buffer = ''; }
    else { if (ch === '[' || ch === '{') depth++; if (ch === ']' || ch === '}') depth--; buffer += ch; }
  }
  if (buffer.trim()) result.push(buffer.trim());
  return result;
}
function relocateSkillArray(value, contextHome) {
  return '[' + compoundMembers(value, '[', ']').map(entry => '{ ' + compoundMembers(entry, '{', '}').map(member => {
    const statements = scanTomlStatements(member).statements;
    if (statements.length !== 1 || statements[0].kind !== 'kv') throw fail('CODEX_RUNTIME_CONFIG_PATH', 'Codex 技能路径配置无法安全迁移');
    const item = statements[0];
    return item.path.length === 1 && item.path[0] === 'path' ? 'path = ' + absoluteConfigPath(item.valueText, contextHome) : member;
  }).join(', ') + ' }').join(', ') + ']';
}
function relocatedValue(item, contextHome) {
  const p = item.path, key = p[p.length - 1];
  const rootOrProfile = p.length === 1 || (p.length === 3 && p[0] === 'profiles');
  if ((rootOrProfile && ['model_instructions_file', 'model_catalog_json', 'experimental_compact_prompt_file', 'log_dir', 'js_repl_node_path'].includes(key))
    || (p.length === 3 && p[0] === 'agents' && key === 'config_file')
    || (p.join('.') === 'skills.config.path')) return absoluteConfigPath(item.valueText, contextHome);
  if (p.join('.') === 'skills.config') return relocateSkillArray(item.valueText, contextHome);
  if ((rootOrProfile && key === 'js_repl_node_module_dirs') || p.join('.') === 'sandbox_workspace_write.writable_roots') {
    return '[' + compoundMembers(item.valueText, '[', ']').map(value => absoluteConfigPath(value, contextHome)).join(', ') + ']';
  }
  // These inline containers can hide config-relative paths from the statement
  // scanner. Refuse ambiguity rather than point a role/skill at the new home.
  if ((p[0] === 'agents' && p.length <= 2) || p.join('.') === 'skills' || p.join('.') === 'sandbox_workspace_write') {
    if (item.valueText.trim().startsWith('{')) throw fail('CODEX_RUNTIME_CONFIG_PATH', 'Codex 内联资源配置需要先展开后才能保留相对路径');
  }
  return null;
}
function runtimeConfig(text, sqliteHome, contextHome) {
  const statements = checkedConfig(text);
  const lines = text.split(/\r?\n/);
  for (const item of [...statements].reverse()) {
    if (item.kind === 'kv' && item.path.length === 1
      && ['cli_auth_credentials_store', 'forced_login_method', 'sqlite_home'].includes(item.path[0])) {
      lines.splice(item.startLine, item.endLine - item.startLine + 1);
    } else if (item.kind === 'kv') {
      const value = relocatedValue(item, contextHome);
      if (value !== null) lines.splice(item.startLine, item.endLine - item.startLine + 1, item.key.map(tomlKey).join('.') + ' = ' + value);
    }
  }
  return 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\nsqlite_home = '
    + JSON.stringify(sqliteHome.replace(/\\/g, '/')) + '\n' + lines.join('\n');
}
function atomicJson(file, value) {
  if (stat(file)) plain(file, 'file');
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (stat(temp)) fs.unlinkSync(temp); }
}
function validateRuntime(home, expected = {}) {
  plain(home, 'dir');
  if (!same(fs.realpathSync(home), home)) throw fail('CODEX_RUNTIME_PATH', 'Codex 运行目录被重定向');
  const marker = json(path.join(home, MARKER));
  if (marker.version !== 1 || !Number.isSafeInteger(marker.generation) || marker.generation < 1
      || typeof marker.sessionId !== 'string' || !marker.sessionId || typeof marker.home !== 'string' || !same(marker.home, home)
      || ['profile', 'contextProfile', 'canonicalHomeHash', 'contextHomeHash', 'historyHome', 'sqliteHome'].some(key => typeof marker[key] !== 'string' || !marker[key])
      || !marker.resources || typeof marker.resources !== 'object' || Array.isArray(marker.resources)
      || (expected.sessionId && marker.sessionId !== expected.sessionId)
      || (expected.context && (marker.contextProfile !== expected.context.id || marker.contextHomeHash !== expected.context.homeHash))
      || (expected.historyHome && !same(marker.historyHome, expected.historyHome))
      || (expected.sqliteHome && !same(marker.sqliteHome, expected.sqliteHome))) {
    throw fail('CODEX_RUNTIME_IDENTITY', 'Codex 运行目录归属与会话不一致');
  }
  const installed = json(path.join(home, 'auth.json'));
  if (installed.auth_mode !== 'chatgpt' || installed.OPENAI_API_KEY !== null || !installed.tokens
      || installed.tokens.refresh_token !== '' || fingerprint({ id: marker.profile, homeHash: marker.canonicalHomeHash }, installed) !== marker.credentialFingerprint) {
    throw fail('CODEX_RUNTIME_IDENTITY', 'Codex 运行目录凭据与归属记录不一致');
  }
  for (const file of ROOT_FILES) if (stat(path.join(home, file))) plain(path.join(home, file), 'file');
  plain(path.join(home, 'config.toml'), 'file');
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  const statements = checkedConfig(config);
  for (const [key, value] of [['cli_auth_credentials_store', 'file'], ['forced_login_method', 'chatgpt'], ['sqlite_home', marker.sqliteHome.replace(/\\/g, '/')]]) {
    const item = statements.find(s => s.kind === 'kv' && s.path.length === 1 && s.path[0] === key);
    if (!item || simpleStringValue(item.valueText) !== value) throw fail('CODEX_RUNTIME_CONFIG', 'Codex 独立运行目录配置已改变');
  }
  for (const name of [...RESOURCE_DIRS, 'thread-writer-locks']) {
    const target = marker.resources[name], current = path.join(home, name), info = stat(current);
    if (target) {
      if (!info || !info.isSymbolicLink() || !same(fs.realpathSync(current), target)) throw fail('CODEX_RUNTIME_PATH', 'Codex 共享资源目录已改变');
    } else if (info && (info.isSymbolicLink() || !info.isDirectory())) throw fail('CODEX_RUNTIME_PATH', 'Codex 资源目录包含未知链接');
  }
  return marker;
}
function runtimePath(dataDir, sessionId, supplied) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId || '')) {
    throw fail('CODEX_RUNTIME_PATH', 'Codex 会话运行目录参数无效');
  }
  const root = path.join(path.resolve(dataDir), 'codex-account-runtime'), home = path.join(root, sessionId);
  if (supplied && !same(supplied, home)) throw fail('CODEX_RUNTIME_PATH', 'Codex 会话运行目录不在其独立位置');
  for (let cursor = path.resolve(dataDir); ; cursor = path.dirname(cursor)) {
    if (stat(cursor)) plain(cursor, 'dir');
    if (path.dirname(cursor) === cursor) break;
  }
  fs.mkdirSync(root, { recursive: true }); plain(root, 'dir');
  return home;
}
function summary(home, marker, credential) {
  return { home, contextProfile: marker.contextProfile, profile: marker.profile,
    generation: marker.generation, credentialFingerprint: marker.credentialFingerprint, expiresAt: credential.expiresAt };
}
function cleanStaging(stage) {
  // Only this function's fresh flat files and directory links can be here. Never
  // recurse through a junction into canonical skills or writer-lock directories.
  for (const name of fs.readdirSync(stage)) {
    const file = path.join(stage, name), info = fs.lstatSync(file);
    if (info.isFile() || info.isSymbolicLink()) fs.unlinkSync(file);
    else throw fail('CODEX_RUNTIME_CLEANUP', 'Codex 临时运行目录包含意外子目录');
  }
  fs.rmdirSync(stage);
}
function prepareRuntime(options) {
  const { dataDir, sessionId } = options;
  const profile = profileInfo(options.profile), context = profileInfo(options.contextProfile || options.profile);
  const home = runtimePath(dataDir, sessionId, options.runtimeHome);
  if (same(home, profile.home) || same(home, context.home)) throw fail('CODEX_RUNTIME_PATH', 'Codex 运行目录不能覆盖原账号');
  const historyHome = path.resolve(options.historyHome || home), sqliteHome = path.resolve(options.sqliteHome || historyHome);
  const credential = readCredential(profile);
  if (stat(home)) {
    const marker = validateRuntime(home, { sessionId, context, historyHome, sqliteHome });
    if (marker.profile === profile.id && marker.canonicalHomeHash === profile.homeHash
        && marker.credentialFingerprint === credential.credentialFingerprint) return summary(home, marker, credential);
    const previousAuth = json(path.join(home, 'auth.json'));
    const next = { ...marker, profile: profile.id, canonicalHomeHash: profile.homeHash,
      generation: marker.generation + 1, credentialFingerprint: credential.credentialFingerprint };
    atomicJson(path.join(home, 'auth.json'), credential.auth);
    try { atomicJson(path.join(home, MARKER), next); }
    catch (error) {
      try { atomicJson(path.join(home, 'auth.json'), previousAuth); }
      catch { throw fail('CODEX_RUNTIME_ROLLBACK', 'Codex 运行凭据写入未完成，需要核对后再启动'); }
      throw fail('CODEX_RUNTIME_WRITE', 'Codex 运行目录归属写入失败，已恢复原账号');
    }
    return summary(home, next, credential);
  }
  // Validate every source before creating a credential copy.
  const files = ROOT_FILES.filter(name => plain(path.join(context.home, name), 'file', false));
  const sourceConfig = path.join(context.home, 'config.toml');
  const text = plain(sourceConfig, 'file', false) ? fs.readFileSync(sourceConfig, 'utf8') : '';
  const config = runtimeConfig(text, sqliteHome, context.home), resources = {};
  for (const name of RESOURCE_DIRS) {
    const source = path.join(context.home, name);
    if (plain(source, 'dir', false)) resources[name] = fs.realpathSync(source);
  }
  if (!same(historyHome, home)) {
    plain(historyHome, 'dir');
    if (!same(fs.realpathSync(historyHome), historyHome)) throw fail('CODEX_RUNTIME_PATH', 'Codex 历史目录不是独立真实目录');
    const locks = path.join(historyHome, 'thread-writer-locks');
    if (!stat(locks)) fs.mkdirSync(locks);
    plain(locks, 'dir'); resources['thread-writer-locks'] = fs.realpathSync(locks);
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(home), '.prepare-'));
  try {
    for (const name of files) fs.copyFileSync(path.join(context.home, name), path.join(stage, name), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(stage, 'config.toml'), config, { flag: 'wx', mode: 0o600 });
    for (const [name, source] of Object.entries(resources)) fs.symlinkSync(source, path.join(stage, name), process.platform === 'win32' ? 'junction' : 'dir');
    const marker = { version: 1, sessionId, home, contextProfile: context.id, contextHomeHash: context.homeHash,
      profile: profile.id, canonicalHomeHash: profile.homeHash, historyHome, sqliteHome,
      generation: 1, credentialFingerprint: credential.credentialFingerprint, resources };
    atomicJson(path.join(stage, 'auth.json'), credential.auth);
    atomicJson(path.join(stage, MARKER), marker);
    fs.renameSync(stage, home);
    return summary(home, marker, credential);
  } catch (error) {
    try { if (stat(stage)) cleanStaging(stage); } catch { /* Preserve the original error; no recursive deletion. */ }
    if (error.code?.startsWith('CODEX_RUNTIME_')) throw error;
    throw fail('CODEX_RUNTIME_WRITE', 'Codex 独立运行目录准备失败，未改变原账号');
  }
}
function getCredentialState(profile, runtimeHome) {
  const canonical = profileInfo(profile), credential = readCredential(canonical);
  const marker = validateRuntime(path.resolve(runtimeHome));
  return { needsUpdate: marker.profile !== canonical.id || marker.canonicalHomeHash !== canonical.homeHash
      || marker.credentialFingerprint !== credential.credentialFingerprint,
    expiresAt: credential.expiresAt, generation: marker.generation, credentialFingerprint: credential.credentialFingerprint };
}
module.exports = { MARKER, prepareRuntime, getCredentialState };
