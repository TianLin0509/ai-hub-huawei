// Where the company upstream lives and how to sign for it.
//
// Upstream values are taken from explicit configuration, an optional legacy adapter,
// or the product's reviewed native-protocol.json defaults. CodeAgent itself is still required.
//   1. <Hub data>/company-model-proxy/upstream.json (written by the user or an admin);
//   2. the CodeAgent model-adapter package already on this computer (read-only: a few
//      text files are listed out of the archive with tar; package code is not executed
//      except when upstream.json explicitly selects the legacy adapter signer);
//   3. CodeAgent's install registration (version) and the default personal login path.
// By default the Hub-owned native binding signs through the installed CodeAgent runtime;
// the adapter archive is optional. Any missing upstream fact is reported by name.
// Legacy adapters do not always spell their URLs out: the model endpoint host carries the zone
// letter and is assembled from a template or constants. The scan resolves such expressions from same-file string
// literals and the zone, and never guesses between two candidate hosts. The identity endpoint is the URL whose
// path ends with the adapter's identity function name (IDENTITY_FUNCTION); the identity response fields are the
// ones that function reads (scanIdentityFields).
// Zone (blue / green / yellow; each employee belongs to exactly one): the adapter itself never detects it
// (Q-1106-09: index.js zone is a volatile DSH config option, default green). Hub takes, in order:
//   1. upstream.json "zone" (the Settings dropdown writes it, with zoneChosenBy "settings");
//   2. CodeAgent's own cache of it (Q-1106-09 r2: the CLI takes the region letter from the user-detail answer
//      and caches it in <CodeAgent data dir>\.cac.json, copy in <home>\.cac.json): the zone word
//      (ZONE_CACHE_FIELDS.word), then the region letter (ZONE_CACHE_FIELDS.letter, y/g/b). Only these two
//      fields are read from that file; nothing else in it is used or recorded;
//   3. the region letter in the identity answer the proxy itself receives (server.mjs, zoneOverride);
//   4. nothing -> ZONE_UNKNOWN and Settings asks the user to choose. Hub never falls back to a default zone.
// profile.sources names a category and file per value (config:upstream.json, adapter:index.js,
// welink:<file>, registry:Uninstall, codeagent:<file>:<key>...); errors carry .diagnostics { sources, tried,
// personalCredentialFile, codeagentVersion } with no URL or path text.
//
// Signer cache: the file codeagent-version-stamp ("<CodeAgent version>\n<digits>\n"). Existing caches are
// reused read-only; lookup order, the first cache matching the installed CodeAgent version wins:
//   1. <Hub data>/company-model-proxy/signer-cache
//   2. the adapter's own data dir: $<cache variable named in the adapter> if set, else <home>/.dsh/hw-llm-adapter/data
//   3. CodeAgent's own data dir ($CODEAGENT3_CONFIG_DIR, else <home>/.cac), if it holds the same stamp file
//   4. signerCacheDir in upstream.json
//   5. the prototype's cache (%TEMP%/20261106-native-stamp-codex-v1/native-run/signer-cache), last resort
// upstream.json "reuseSignerCaches": false limits the lookup to (1) (an admin or acceptance run that wants Hub's own cache).
// When none matches (first use, or CodeAgent was upgraded), Hub runs the CodeAgent CLI once itself (native-stamp.mjs:
// hidden console, fresh TEMP, signer log on), reads the build stamp from the signer log and writes the cache into (1);
// the signer then only reads that cache (signer-init.mjs blocks any CLI start). Not a login; no token is refreshed by Hub.
import { readFile, readdir, stat, mkdir, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { initializeCacheOnlySigner } from './signer-init.mjs';
import { probeNativeStamp, writeStampCache, configDirOf } from './native-stamp.mjs';
import { createNativeSigner, findNativeRuntime } from './native-signer.mjs';
import { isSignerVersion } from './version-format.mjs';

const exec = promisify(execFile);
// The adapter's identity function name: only a clue to find the identity endpoint and its fields in the source.
export const IDENTITY_FUNCTION = 'getUserDetail';
export const CHAT_PATH = '/api/v2/chat/completions';
const FIELD = /^[A-Za-z_$][\w$]{0,63}$/;
const DEFAULT_CODEAGENT_DIR = 'C:\\Program Files\\CodeAgentCLI';
const STAMP_FILE = 'codeagent-version-stamp';
// The adapter's default data dir under the user's home (its own convention; no user name in it).
const ADAPTER_DATA_SEGMENTS = ['.dsh', 'hw-llm-adapter', 'data'];
// The prototype's cache from the first company run, reused read-only as the last candidate.
const PROTOTYPE_CACHE_SEGMENTS = ['20261106-native-stamp-codex-v1', 'native-run', 'signer-cache'];
const ADAPTER_FILE = /llm-adapter[^\\/]*\.tgz$/i;
const SYSTEM_TAR = 'C:\\Windows\\System32\\tar.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export class ProfileError extends Error {
  constructor(code, message, missing = []) { super(message); this.code = code; this.missing = missing; }
}

const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
// path: exact path required; null: any path below the root.
function httpsUrl(value, path) {
  try {
    const url = new URL(value);
    const pathOk = path === null ? url.pathname.length > 1 : url.pathname === path;
    return url.protocol === 'https:' && pathOk && !url.username && !url.password && !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}

export async function readUserProfile(profileFile) {
  try {
    const parsed = JSON.parse((await readFile(profileFile, 'utf8')).replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new ProfileError('PROFILE_INVALID', `上游配置文件格式不对：${profileFile}`);
  }
}

const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/;
const baseName = member => member.split('/').pop();
export const ZONE_NAMES = Object.freeze({ blue: '蓝区', green: '绿区', yellow: '黄区' });
const ZONES = new Set(Object.keys(ZONE_NAMES));
// CodeAgent's own cache of the zone (Q-1106-09 r2): file and the only two fields read from it.
export const ZONE_CACHE_FILE = '.cac.json';
export const ZONE_CACHE_FIELDS = Object.freeze({ word: 'enterpriseNetworkZoneCache', letter: ['enterpriseUserDetailCache', 'region'] });
export const ZONE_LETTERS = Object.freeze({ y: 'yellow', g: 'green', b: 'blue' });
export const zoneFromLetter = value => { const v = text(value).toLowerCase(); return Object.hasOwn(ZONE_LETTERS, v) ? ZONE_LETTERS[v] : ''; };

// String constants of one file: NAME = 'text' (const/let/var, object fields, exports). Used to
// resolve identifiers inside URL templates. Only plain literals, never evaluated code.
function stringConstants(body) {
  const map = new Map();
  for (const m of body.matchAll(/(?:\b(?:const|let|var)\s+|\b|['"])([A-Za-z_$][\w$]*)['"]?\s*[:=]\s*(['"`])([^'"`\n\$]{0,300})\2/g)) {
    if (!map.has(m[1])) map.set(m[1], m[3]);
  }
  return map;
}
const FIRST_LETTER = /\[\s*0\s*\]|charAt\(\s*0?\s*\)|s(?:lice|ubstring|ubstr)\(\s*0\s*,\s*1\s*\)/;
// Variables computed from the zone, e.g. `const z = (zone || "green")[0].toLowerCase();` -> 'letter'.
function zoneVariables(body) {
  const map = new Map();
  for (const m of body.matchAll(/(?:\b(?:const|let|var)\s+|^|[;{(\s])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]{0,160})/gm)) {
    if (/\bzone\b/i.test(m[2])) map.set(m[1], FIRST_LETTER.test(m[2]) ? 'letter' : 'word');
  }
  return map;
}
const zoneWord = value => { const v = text(value).toLowerCase(); return ZONES.has(v) ? v : ''; };
const codeagentDataDir = (env, home) => text(env.CODEAGENT3_CONFIG_DIR) || (home ? join(home, '.cac') : '');

/**
 * Zone from CodeAgent's own cache (<data dir>\.cac.json, then <home>\.cac.json): the zone word first, then the
 * region letter. Only those two fields are taken from the parsed file. -> { zone, source } or { zone: '', tried }.
 * source: 'codeagent:.cac.json:word' | 'codeagent:.cac.json:letter' (home copy: 'codeagent:home/.cac.json:...').
 */
export async function detectCodeAgentZone({ env = process.env, home = text(env.USERPROFILE) || homedir() } = {}) {
  const dir = codeagentDataDir(env, home), tried = [], caches = [];
  const files = [];
  if (dir && isAbsolute(dir)) files.push({ file: join(dir, ZONE_CACHE_FILE), label: ZONE_CACHE_FILE });
  if (home && isAbsolute(home)) files.push({ file: join(home, ZONE_CACHE_FILE), label: 'home/' + ZONE_CACHE_FILE });
  if (!files.length) return { zone: '', tried: ['codeagent:(no data dir)'] };
  for (const { file, label } of files) {
    tried.push('codeagent:' + label);
    try {
      const s = await lstat(file);
      if (!s.isFile() || s.size > 4 * 1024 * 1024) continue;
      const parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object') continue;
      const [outer, inner] = ZONE_CACHE_FIELDS.letter;
      caches.push({ label, word: parsed[ZONE_CACHE_FIELDS.word], letter: parsed[outer]?.[inner] });
    } catch { /* unreadable: next */ }
  }
  for (const c of caches) { const zone = zoneWord(c.word); if (zone) return { zone, source: `codeagent:${c.label}:word`, tried }; }
  for (const c of caches) { const zone = zoneFromLetter(c.letter); if (zone) return { zone, source: `codeagent:${c.label}:letter`, tried }; }
  for (const c of caches) if (c.word !== undefined || c.letter !== undefined) tried.push(`codeagent:${c.label}:invalid`);
  return { zone: '', tried };
}

/** Plain words for Settings: which zone is used and where that came from. */
export function zoneText(info) {
  const name = ZONE_NAMES[info?.zone];
  if (!name) return '还没识别出你所在的区域（蓝区 / 绿区 / 黄区），请在下面选择。选错了，公司模型的请求会全部失败。';
  const source = String(info.source || '');
  if (source === 'settings') return `用的是${name}（你在这里选的）。`;
  if (source === 'config:upstream.json') return `用的是${name}（来自 Hub 数据目录里的上游配置 upstream.json）。`;
  if (/^codeagent:/.test(source)) return `已从 CodeAgent 识别为${name}（CodeAgent 登录时记下的区域）。`;
  if (source === 'identity:region') return `已从 CodeAgent 识别为${name}（公司身份接口返回的区域）。`;
  return `用的是${name}。`;
}
// Resolves a URL expression piece by piece: string literals stay, ${expr} / + expr + pieces are
// looked up as same-file string constants, and anything computed from the zone becomes its letter or word.
function resolvePieces(pieces, { constants, zoneVars }, zone) {
  let out = '';
  for (const piece of pieces) {
    if (piece.literal !== undefined) { out += piece.literal; continue; }
    const expr = piece.expr.trim();
    if (constants.has(expr)) { out += constants.get(expr); continue; }
    const kind = zoneVars.get(expr) || (/\bzone\b/i.test(expr) ? (FIRST_LETTER.test(expr) ? 'letter' : 'word') : '');
    if (kind) { if (!zone) return ''; out += kind === 'letter' ? zone[0] : zone; continue; }
    return '';
  }
  return out;
}
// Every https URL expression in a file: plain literals, template literals with ${...}, and
// 'a' + b + 'c' chains. Returns resolved text (possibly a bare origin) per expression.
function urlExpressions(body, zone) {
  const scope = { constants: stringConstants(body), zoneVars: zoneVariables(body) };
  const found = [];
  const keep = url => { if (url.startsWith('https://')) found.push(url); };
  for (const m of body.matchAll(/`([^`\n]{1,400})`/g)) {
    const pieces = [];
    let rest = m[1];
    while (rest) {
      const at = rest.indexOf('${');
      if (at < 0) { pieces.push({ literal: rest }); break; }
      pieces.push({ literal: rest.slice(0, at) });
      const end = rest.indexOf('}', at);
      if (end < 0) { pieces.length = 0; break; }
      pieces.push({ expr: rest.slice(at + 2, end) });
      rest = rest.slice(end + 1);
    }
    if (pieces.length) keep(resolvePieces(pieces, scope, zone));
  }
  const token = String.raw`(?:(['"])([^'"\n]{0,300})\1|([A-Za-z_$][\w$]*(?:\.[\w$]+)*(?:\[\s*0\s*\]|\.charAt\(\s*0?\s*\)|\.s(?:lice|ubstring|ubstr)\(\s*0\s*,\s*1\s*\))?))`;
  const piece = t => t[2] !== undefined ? { literal: t[2] } : { expr: t[3] };
  for (const m of body.matchAll(new RegExp(String.raw`${token}(?:\s*\+\s*${token})+`, 'g'))) {
    const pieces = [...m[0].matchAll(new RegExp(token, 'g'))].map(piece);
    keep(resolvePieces(pieces, scope, zone));
  }
  for (const m of body.matchAll(/(['"])(https:\/\/[^'"\s]{1,300})\1/g)) keep(m[2]);
  for (const value of scope.constants.values()) keep(value);
  return found;
}
// Every DNS label must start and end with a letter or digit: a fragment such as "https://chat.prod-z-" (the part
// before the zone letter) is not a host and never becomes a base origin.
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const parseHttps = value => { try { const u = new URL(value); return u.protocol === 'https:' && HOST.test(u.host) && u.hostname.split('.').every(l => LABEL.test(l)) ? u : null; } catch { return null; } };

/**
 * Text-only scan of the adapter sources (nothing is executed). Exported for tests with synthetic sources.
 * -> { found: { field: value }, from: { field: 'adapter:<file>' }, tried: { field: [where looked] } }
 * For each URL: a full https URL with the exact path first; otherwise a base origin in the file that
 * names the path, when that file mentions exactly one candidate origin besides the other endpoint.
 */
export function scanAdapterSources(sources, { zone: configuredZone } = {}) {
  const found = {}, from = {}, tried = {};
  const members = Object.keys(sources);
  // Without a zone, URL pieces computed from it stay unresolved (no host is guessed).
  const zone = zoneWord(configuredZone);
  const perFile = members.map(member => {
    const body = sources[member];
    return { member, body, urls: urlExpressions(body, zone).map(parseHttps).filter(Boolean) };
  });
  // Pass 1: a full https URL with the exact path. Pass 2: a bare origin in a file that names the path,
  // when it is the only candidate there after removing the other endpoint's origin (never guesses between two).
  // identity: a path ending in /<identity function>; chat: the exact chat path.
  const identityPathOk = pathname => pathname.length > IDENTITY_FUNCTION.length + 1 && pathname.endsWith('/' + IDENTITY_FUNCTION);
  const endpoints = [['identityUrl', identityPathOk, IDENTITY_FUNCTION], ['chatUrl', pathname => pathname === CHAT_PATH, 'chat/completions']];
  for (const [field, pathOk] of endpoints) {
    tried[field] = [];
    for (const { member, urls } of perFile) {
      tried[field].push(`adapter:${baseName(member)}:full-url`);
      const hit = urls.find(u => pathOk(u.pathname) && !u.search && !u.hash);
      if (hit) { found[field] = hit.origin + hit.pathname; from[field] = `adapter:${baseName(member)}`; break; }
    }
  }
  for (const [field, pathOk, marker] of endpoints) {
    if (found[field]) continue;
    const other = endpoints.find(e => e[0] !== field)[0];
    const exclude = found[other] ? new URL(found[other]).origin : '';
    for (const { member, body, urls } of perFile) {
      if (!body.includes(marker)) continue;
      // The path as a literal in the same file ('/.../<function>' or the chat path).
      const paths = new Set([...body.matchAll(/(['"`])(\/[A-Za-z0-9_./-]{1,200})\1/g)].map(m => m[2]).filter(pathOk));
      if (field === 'chatUrl') paths.add(CHAT_PATH);
      tried[field].push(`adapter:${baseName(member)}:base-origin`);
      const origins = new Set(urls.filter(u => u.pathname === '/').map(u => u.origin));
      origins.delete(exclude);
      if (origins.size === 1 && paths.size === 1) { found[field] = [...origins][0] + [...paths][0]; from[field] = `adapter:${baseName(member)}:base+path`; break; }
    }
  }
  tried.identityFields = [];
  for (const { member, body } of perFile) {
    if (!body.includes(IDENTITY_FUNCTION)) continue;
    tried.identityFields.push(`adapter:${baseName(member)}`);
    const fields = scanIdentityFields(body);
    if (fields) { found.identityAccountField = fields.account; found.identityDeptField = fields.dept; from.identityFields = `adapter:${baseName(member)}`; break; }
  }
  tried.appId = [];
  for (const { member, body } of perFile) {
    tried.appId.push(`adapter:${baseName(member)}`);
    const app = body.match(/['"]app-id['"]\s*:\s*['"]([A-Za-z0-9._-]{3,200})['"]/);
    if (app) { found.appId = app[1]; from.appId = `adapter:${baseName(member)}`; break; }
  }
  tried.signerCacheEnv = ['adapter:signer.js'];
  const envName = (sources['package/lib/signer.js'] || '').match(/process\.env\.([A-Z][A-Z0-9_]*AUTH_DIR)\b/);
  if (envName) { found.signerCacheEnv = envName[1]; from.signerCacheEnv = 'adapter:signer.js'; }
  return { found, from, tried };
}
/**
 * The identity answer's field names, as the adapter's identity function reads them (text only, near each mention
 * of IDENTITY_FUNCTION): the account field (assigned to `account`, or a data.<x> ending in "account") and the
 * department field (assigned to `deptPath`, or a data.<x> naming the department). -> { account, dept } | null.
 */
export function scanIdentityFields(body) {
  const member = String.raw`\bdata\??\.([A-Za-z_$][\w$]*)`;
  for (let at = body.indexOf(IDENTITY_FUNCTION); at >= 0; at = body.indexOf(IDENTITY_FUNCTION, at + 1)) {
    const near = body.slice(at, at + 4000);
    const assigned = name => near.match(new RegExp(String.raw`\b${name}\s*[:=]\s*[^;,\n}]*?` + member))?.[1];
    const reads = [...near.matchAll(new RegExp(member, 'g'))].map(m => m[1]);
    const destructured = [...near.matchAll(/\{\s*([^{}=]{1,200})\}\s*=\s*[^;\n]*?\.data\b/g)]
      .flatMap(m => m[1].split(',').map(x => x.trim().split(/\s*:\s*/)[0]));
    const all = [...reads, ...destructured];
    const account = assigned('account') || all.find(n => /account$/i.test(n) && n.toLowerCase() !== 'account');
    const dept = assigned('deptPath') || all.find(n => /depart|dept/i.test(n) && n !== 'deptPath');
    if (account && FIELD.test(account) && (!dept || FIELD.test(dept))) return { account, dept: dept || '' };
  }
  return null;
}
/** Compatibility wrapper: discovered values only. */
export function discoverFromSources(sources, options) {
  return scanAdapterSources(sources, options).found;
}

async function findAdapterPackage(env = process.env) {
  const roots = [];
  if (env.APPDATA) roots.push(join(env.APPDATA, 'WeLink_Desktop', 'appdata', 'IM'));
  let best = null;
  for (const root of roots) {
    let users = [];
    try { users = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const user of users) {
      if (!user.isDirectory()) continue;
      const dir = join(root, user.name, 'ReceiveFiles');
      let files = [];
      try { files = await readdir(dir); } catch { continue; }
      for (const name of files) {
        if (!ADAPTER_FILE.test(name)) continue;
        const file = join(dir, name);
        try { const s = await stat(file); if (s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: s.mtimeMs }; } catch { /* skip */ }
      }
    }
  }
  return best?.file || '';
}

async function listArchiveText(archive, member) {
  try {
    const { stdout } = await exec(SYSTEM_TAR, ['-xOf', archive, member], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch { return ''; }
}

async function registryVersion(codeagentDir) {
  const target = codeagentDir.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop';$t='${target}'.TrimEnd('\\');$v=@();foreach($r in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){if(Test-Path -LiteralPath $r){foreach($k in Get-ChildItem -LiteralPath $r){$p=Get-ItemProperty -LiteralPath $k.PSPath;if($p.InstallLocation -is [string] -and $p.InstallLocation.Trim().TrimEnd('\\') -eq $t){$v+=@([string]$p.DisplayVersion)}}}};ConvertTo-Json -InputObject @($v) -Compress`;
  try {
    const { stdout } = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 32768, encoding: 'utf8' });
    return parseRegistryVersions(stdout);
  } catch { return ''; }
}
// Output of "codeagentcli --version" (first line that is only a version, optional product name; update notices are skipped).
export function parseCliVersion(text) {
  for (const line of String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (/new version|update|新版本|升级/i.test(line)) continue;
    const match = /^\s*(?:(?:codeagent(?:cli)?|cac)\s+(?:version\s*:?\s*|v)?|version\s*:?\s*|v)?(\d+(?:\.\d+){1,5}[0-9A-Za-z.+-]*)(?:\s*\([^)]*\))?\s*$/i.exec(line);
    if (match) return match[1];
  }
  return '';
}
async function cliVersion(codeagentDir, run = exec) {
  try {
    const { stdout, stderr } = await run(join(codeagentDir, 'bin', 'codeagentcli.exe'), ['--version'], { windowsHide: true, timeout: 15000, maxBuffer: 32768, encoding: 'utf8' });
    return parseCliVersion(String(stdout || '') + '\n' + String(stderr || ''));
  } catch { return ''; }
}
// Registry first (no process start). No entry, two entries or a portable install: ask the installed program itself.
export async function installedVersion(codeagentDir, { registry = registryVersion, run = exec } = {}) {
  return await registry(codeagentDir) || await cliVersion(codeagentDir, run);
}

/**
 * stdout of the registry query: a JSON array with the DisplayVersion of every Uninstall entry whose
 * InstallLocation is the CodeAgent CLI dir. Exactly one distinct version counts (the same install listed
 * under two roots is one); none or two different versions -> ''. PowerShell prints a one-element array
 * as a bare string on some versions, which is accepted too. Exported for tests.
 */
export function parseRegistryVersions(stdout) {
  let rows;
  try { rows = JSON.parse(String(stdout || '').trim() || '[]'); } catch { return ''; }
  if (typeof rows === 'string') rows = [rows];
  if (!Array.isArray(rows)) return '';
  const versions = [...new Set(rows.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
  return versions.length === 1 && /^\d[0-9A-Za-z.+-]{0,40}$/.test(versions[0]) ? versions[0] : '';
}

// -> { state: 'ok' | 'missing' | 'version' | 'invalid', version? }. The stamp value itself is never returned.
export async function inspectStamp(cacheDir, version) {
  try {
    const file = join(cacheDir, STAMP_FILE);
    const s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 512) return { state: 'invalid' };
    const lines = (await readFile(file, 'utf8')).trimEnd().split(/\r?\n/);
    if (lines.length !== 2 || !/^\d{1,64}$/.test(lines[1]) || !/^\d[0-9A-Za-z.+-]{0,40}$/.test(lines[0])) return { state: 'invalid' };
    return lines[0] === version ? { state: 'ok' } : { state: 'version', version: lines[0] };
  } catch (error) { return { state: error?.code === 'ENOENT' ? 'missing' : 'invalid' }; }
}

/** Signer-cache directories in lookup order (see the header). Exported for tests. */
export const hubSignerCacheDir = dataDir => join(dataDir, 'company-model-proxy', 'signer-cache');
export function signerCacheCandidates({ dataDir, env = process.env, signerCacheEnv = '', configured = '', reuse = true } = {}) {
  const list = [{ source: 'hub', label: 'Hub 数据目录', dir: hubSignerCacheDir(dataDir) }];
  if (!reuse) return list;
  const fromEnv = signerCacheEnv ? text(env[signerCacheEnv]) : '';
  if (fromEnv) list.push({ source: 'adapter-env', label: `CodeAgent 适配器数据目录（环境变量 ${signerCacheEnv}）`, dir: fromEnv });
  const home = text(env.USERPROFILE) || homedir();
  if (home) list.push({ source: 'adapter', label: 'CodeAgent 适配器数据目录', dir: join(home, ...ADAPTER_DATA_SEGMENTS) });
  const codeagent = codeagentDataDir(env, home);
  if (codeagent) list.push({ source: 'codeagent', label: 'CodeAgent 数据目录', dir: codeagent });
  if (configured) list.push({ source: 'config', label: '上游配置 signerCacheDir', dir: configured });
  const temp = text(env.TEMP) || text(env.TMP);
  if (temp) list.push({ source: 'prototype', label: '原型留下的缓存（TEMP）', dir: join(temp, ...PROTOTYPE_CACHE_SEGMENTS) });
  const seen = new Set();
  return list.filter(c => { const k = c.dir.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function findSignerCache({ dataDir, env, signerCacheEnv, configured, version, reuse }) {
  const tried = [];
  for (const candidate of signerCacheCandidates({ dataDir, env, signerCacheEnv, configured, reuse })) {
    const result = isAbsolute(candidate.dir) ? await inspectStamp(candidate.dir, version) : { state: 'invalid' };
    if (result.state === 'ok') return { found: candidate, tried };
    tried.push({ ...candidate, ...result });
  }
  return { found: null, tried };
}

/** Plain words for the first-time initialization that runs when no cache matches. */
export function signerInitReason(tried, version) {
  const stale = tried.find(t => t.state === 'version');
  return stale ? `CodeAgent 升级过（缓存是 ${stale.version} 版的，现装的是 ${version} 版），签名信息要重新取一次`
    : '这台电脑上还没有签名信息，第一次使用要取一次';
}
/** Plain-words reason and fix when the first-time initialization did not produce a cache. */
export function signerInitFailureMessage(code, { version, timeoutMs, detail } = {}) {
  const why = {
    SIGNER_INIT_TIMEOUT: `CodeAgent 命令行在 ${Math.round((timeoutMs || 0) / 1000)} 秒内没有结束`,
    SIGNER_INIT_NO_STAMP: 'CodeAgent 命令行跑完了，但没有留下签名信息',
    SIGNER_INIT_CLI_FAILED: 'CodeAgent 命令行没能启动',
    SIGNER_INIT_SPAWN_BLOCKED: '签名模块想启动 Hub 不认识的程序，Hub 已拦下',
    SIGNER_INIT_CACHE_WRITE: '签名信息取到了，但写不进 Hub 数据目录',
    SIGNER_NATIVE_FILES_MISSING: '签名信息已取得，但未能保留 CodeAgent 的签名运行库',
  }[code] || '签名模块初始化失败';
  const step = { LOG_MISSING: '签名日志没有生成', MARKER_MISSING: '签名日志里没有签名记录', LOG_INCOMPLETE: '签名记录没写完整',
    STAMP_NOT_PARSED: '签名记录格式认不出', STAMP_VERSION_MISMATCH: '签名记录的版本和安装的 CodeAgent 不一致' }[detail];
  return `公司模型暂时用不了：首次签名初始化没完成（${why}${step ? '：' + step : ''}）。\n` +
    `这一步会在后台启动一次 CodeAgent 命令行（不弹窗、不登录、不刷新登录），读取 CodeAgent ${version || ''} 的签名信息。\n` +
    '处理办法：确认 CodeAgent 已安装、已登录，在命令行里能正常对话；然后到「设置 → 自有 API」点「重新启动反代」再试一次。';
}

/**
 * Resolves every value the real upstream needs. Throws ProfileError naming what is missing.
 * options.env / options.versionReader / options.archiveReader exist for tests.
 */
export async function resolveUpstreamProfile({ dataDir, env = process.env, versionReader = installedVersion,
  archiveReader = listArchiveText, packageFinder = findAdapterPackage, zoneDetector = detectCodeAgentZone, zoneOverride = null } = {}) {
  const profileDir = join(dataDir, 'company-model-proxy');
  const user = await readUserProfile(join(profileDir, 'upstream.json'));
  const home = text(env.USERPROFILE) || homedir();
  const profile = {
    codeagentDir: text(user.codeagentDir) || DEFAULT_CODEAGENT_DIR,
    signerMode: text(user.adapterPackage) ? 'adapter' : 'native',
    adapterPackage: text(user.adapterPackage),
    adapterPackageSha256: text(user.adapterPackageSha256).toLowerCase(),
    signerCacheDir: text(user.signerCacheDir),
    signerCacheEnv: text(user.signerCacheEnv),
    codeagentVersion: text(user.codeagentVersion),
    identityUrl: httpsUrl(text(user.identityUrl), null),
    identityAccountField: FIELD.test(text(user.identityAccountField)) ? text(user.identityAccountField) : '',
    identityDeptField: FIELD.test(text(user.identityDeptField)) ? text(user.identityDeptField) : '',
    chatUrl: httpsUrl(text(user.chatUrl), CHAT_PATH),
    appId: text(user.appId),
    telemetryUrl: httpsUrl(text(user.telemetryUrl), null),
    zone: zoneWord(user.zone),
    // Optional model for the one first-time CLI run (default: CodeAgent's own default model).
    stampProbeModel: /^[A-Za-z0-9._-]{1,80}$/.test(text(user.stampProbeModel)) ? text(user.stampProbeModel) : '',
    // CodeAgent's own personal login: <user profile>\.cac\.credentials.json (same place the CLI writes it).
    personalCredential: text(user.personalCredential) || (home ? join(home, '.cac', '.credentials.json') : ''),
    // Where each value came from: a category and at most a file name, never the value itself.
    sources: {},
  };
  // Diagnostics only: every place looked at per field, in order (categories and file names, no values).
  const tried = {};
  const note = (key, where) => { (tried[key] ||= []).push(where); };
  let zoneNeeded = false; // the adapter builds the chat host from the zone (checked by resolvability only)
  if (profile.identityAccountField) { profile.sources.identityFields = 'config:upstream.json'; note('identityFields', 'config:upstream.json'); }
  for (const key of ['codeagentDir', 'adapterPackage', 'signerCacheDir', 'signerCacheEnv', 'codeagentVersion', 'identityUrl', 'chatUrl', 'appId', 'zone', 'personalCredential']) {
    note(key, 'config:upstream.json');
    if (profile[key] && text(user[key])) profile.sources[key] = 'config:upstream.json';
    else if (text(user[key])) note(key, 'config:upstream.json(invalid)');
  }
  if (!profile.sources.codeagentDir) profile.sources.codeagentDir = 'default';
  if (profile.sources.zone && user.zoneChosenBy === 'settings') profile.sources.zone = 'settings';
  if (!profile.zone) {
    const detected = await zoneDetector({ env, home });
    for (const where of detected.tried || []) note('zone', where);
    if (detected.zone && ZONES.has(detected.zone)) { profile.zone = detected.zone; profile.sources.zone = detected.source; note('zone', detected.source); }
  }
  // 3. The region letter in the identity answer the proxy received (server.mjs), only when nothing above named it.
  if (!profile.zone && zoneOverride && ZONES.has(zoneOverride.zone)) {
    note('zone', 'identity:region'); profile.zone = zoneOverride.zone; profile.sources.zone = 'identity:region';
  }
  profile.zoneInfo = { zone: profile.zone, source: profile.sources.zone || '', text: !profile.zone && profile.chatUrl
    ? '模型接口地址已写在上游配置 upstream.json 里，不按区域拼接。' : zoneText({ zone: profile.zone, source: profile.sources.zone }) };
  if (!profile.sources.personalCredential && profile.personalCredential) { profile.sources.personalCredential = 'default:.cac/.credentials.json'; note('personalCredential', 'default:.cac/.credentials.json'); }
  if (!profile.adapterPackage) {
    note('adapterPackage', 'welink:ReceiveFiles');
    profile.adapterPackage = await packageFinder(env);
    if (profile.adapterPackage) profile.sources.adapterPackage = 'welink:' + basename(profile.adapterPackage);
  }
  if (profile.adapterPackage) {
    const sources = {};
    for (const member of ['package/package.json', 'package/lib/index.js', 'package/lib/codeagent.js', 'package/lib/client.js', 'package/lib/signer.js']) {
      const body = await archiveReader(profile.adapterPackage, member);
      if (body) sources[member] = body;
    }
    const scan = scanAdapterSources(sources, { zone: profile.zone });
    if (!profile.zone && !profile.chatUrl && !scan.found.chatUrl) zoneNeeded = !!scanAdapterSources(sources, { zone: 'yellow' }).found.chatUrl;
    for (const key of ['identityUrl', 'chatUrl', 'appId', 'signerCacheEnv']) {
      if (profile[key]) continue;
      for (const where of scan.tried[key] || []) note(key, where);
      if (scan.found[key]) { profile[key] = scan.found[key]; profile.sources[key] = scan.from[key]; }
    }
    if (!profile.identityAccountField) {
      for (const where of scan.tried.identityFields || []) note('identityFields', where);
      if (scan.found.identityAccountField) {
        profile.identityAccountField = scan.found.identityAccountField; profile.identityDeptField = scan.found.identityDeptField || '';
        profile.sources.identityFields = scan.from.identityFields;
      }
    }
    if (!Object.keys(sources).length) for (const key of ['identityUrl', 'chatUrl', 'appId', 'signerCacheEnv']) if (!profile[key]) note(key, 'adapter:(archive unreadable)');
  }
  if (profile.signerMode === 'native') {
    const defaults = JSON.parse(await readFile(new URL('./native-protocol.json', import.meta.url), 'utf8'));
    for (const key of ['identityUrl', 'appId', 'telemetryUrl']) {
      if (!profile[key]) { profile[key] = defaults[key]; profile.sources[key] = 'hub:native-protocol'; note(key, 'hub:native-protocol'); }
    }
    if (!profile.identityAccountField) {
      profile.identityAccountField = defaults.identityAccountField; profile.identityDeptField = defaults.identityDeptField;
      profile.sources.identityFields = 'hub:native-protocol'; note('identityFields', 'hub:native-protocol');
    }
    if (!profile.chatUrl) {
      if (profile.zone) { profile.chatUrl = defaults.chatUrls[profile.zone]; profile.sources.chatUrl = 'hub:native-protocol'; note('chatUrl', 'hub:native-protocol'); }
      else { zoneNeeded = true; note('chatUrl', 'hub:native-protocol:zone-needed'); }
    }
  }
  if (!profile.codeagentVersion) {
    note('codeagentVersion', 'registry:Uninstall, codeagentcli --version');
    profile.codeagentVersion = await versionReader(profile.codeagentDir);
    if (profile.codeagentVersion) profile.sources.codeagentVersion = 'installed';
  }
  if (profile.signerMode === 'native' && !profile.signerCacheEnv) {
    profile.signerCacheEnv = 'HWTRAN_AUTH_DIR'; profile.sources.signerCacheEnv = 'hub:native-signer';
  }
  const diagnostics = () => ({ sources: { ...profile.sources }, tried: JSON.parse(JSON.stringify(tried)),
    personalCredentialFile: !!profile.personalCredential && isAbsolute(profile.personalCredential) && existsSync(profile.personalCredential),
    codeagentVersion: /^\d[0-9A-Za-z.+-]{0,40}$/.test(profile.codeagentVersion) ? profile.codeagentVersion : null,
    zone: profile.zone || null });
  const missing = [];
  const labels = { identityUrl: '身份接口地址', identityFields: '身份字段名', chatUrl: '模型接口地址', appId: '客户端标识',
    codeagentVersion: 'CodeAgent 版本', signerCacheEnv: '签名缓存变量名' };
  for (const key of Object.keys(labels)) if (key === 'identityFields' ? !profile.identityAccountField : !profile[key]) missing.push(key);
  // The model host needs the zone; without it the chat URL cannot be built, and Settings asks for it.
  if (!profile.zone && zoneNeeded && missing.includes('chatUrl')) {
    if (missing.length === 1) {
      const error = new ProfileError('ZONE_UNKNOWN', '公司模型暂时用不了：还没识别出你所在的区域（蓝区 / 绿区 / 黄区）。Hub 在 CodeAgent 的配置里没找到区域；' +
        '模型接口地址按区域不同，不能替你猜。请在「设置 → 自有 API → 公司模型」的「所在区域」里选择，选好后会自动重启反代。', ['zone']);
      error.zone = profile.zoneInfo;
      error.diagnostics = diagnostics();
      // In-process only (never serialized): lets the proxy ask the identity service for the region letter.
      if (profile.identityUrl && profile.personalCredential) error.identityProbe = { identityUrl: profile.identityUrl, credential: profile.personalCredential };
      throw error;
    }
    missing.push('zone'); labels.zone = '所在区域';
  }
  if (missing.length) {
    const error = new ProfileError('PROFILE_INCOMPLETE', '公司上游信息不全：' + missing.map(k => labels[k]).join('、') +
      '\n找过：' + missing.map(k => `${labels[k]}（${(tried[k] || []).join('、') || '无'}）`).join('；'), missing);
    error.diagnostics = diagnostics();
    throw error;
  }
  for (const key of ['adapterPackage', 'personalCredential', 'codeagentDir']) {
    if (key === 'adapterPackage' && !profile[key]) continue;
    if (!isAbsolute(profile[key])) throw new ProfileError('PROFILE_INVALID', `上游配置里的路径必须是绝对路径：${key}`);
  }
  const { found, tried: cacheTried } = await findSignerCache({ dataDir, env, signerCacheEnv: profile.signerCacheEnv,
    configured: profile.signerCacheDir, version: profile.codeagentVersion, reuse: user.reuseSignerCaches !== false });
  for (const t of cacheTried) note('signerCacheDir', `signer-cache:${t.source}:${t.state}`);
  if (found) note('signerCacheDir', `signer-cache:${found.source}:ok`);
  if (found) {
    profile.signerCacheDir = found.dir; // reused read-only: on a hit the signer reads it and writes nothing
    profile.sources.signerCacheDir = found.source; // hub | adapter-env | adapter | codeagent | config | prototype
    profile.signerInit = { needed: false };
  } else {
    // First use or CodeAgent upgraded: the adapter's own first-time initialization fills Hub's cache (loadSigner).
    profile.signerCacheDir = hubSignerCacheDir(dataDir);
    profile.sources.signerCacheDir = 'hub:first-init';
    profile.signerInit = { needed: true, reason: cacheTried.some(t => t.state === 'version') ? 'version' : 'missing',
      text: signerInitReason(cacheTried, profile.codeagentVersion), tried: cacheTried.map(t => ({ source: t.source, state: t.state })) };
  }
  if (profile.signerMode === 'native' && isSignerVersion(profile.codeagentVersion)
      && !await findNativeRuntime({ codeagentDir: profile.codeagentDir,
        runtimeDir: join(profileDir, 'native-runtime', profile.codeagentVersion) })) {
    // Existing adapter/CodeAgent caches are read-only. A native-runtime probe writes only Hub's cache.
    profile.signerCacheDir = hubSignerCacheDir(dataDir);
    profile.sources.signerCacheDir = 'hub:native-runtime-init';
    profile.signerInit = { needed: true, reason: 'native-files', text: 'CodeAgent 签名运行库尚未释放',
      tried: cacheTried.map(t => ({ source: t.source, state: t.state })) };
  }
  profile.diagnostics = diagnostics();
  return profile;
}

// First-time initialization: the signer may start the CodeAgent CLI once (hidden, no shell); the whole
// init is bounded by this timeout. The adapter's own CLI run is limited to 15 s by the signer itself.
export const SIGNER_INIT_TIMEOUT_MS = 60_000;

/**
 * Loads the built-in signer, or an explicitly configured legacy adapter.
 * First use runs one hidden CodeAgent probe; the stamp must match the installed version.
 * -> { signer, adapterSha256, firstInit: { ran, ms, reason, cliRuns } }
 */
export async function loadSigner(profile, { workDir, timeoutMs = SIGNER_INIT_TIMEOUT_MS, testOnlySpawnDelegate, stampProbe = probeNativeStamp } = {}) {
  const native = profile.signerMode === 'native' || !profile.adapterPackage;
  if (native && !isSignerVersion(profile.codeagentVersion)) throw new ProfileError('SIGNER_VERSION', '无法核实 CodeAgent 版本，请检查安装是否完整');
  let sha = 'hub-native', signerFile = '';
  const runtimeDir = join(workDir, 'native-runtime', String(profile.codeagentVersion));
  if (!native) {
    const archive = await readFile(profile.adapterPackage);
    sha = createHash('sha256').update(archive).digest('hex');
    if (profile.adapterPackageSha256 && sha !== profile.adapterPackageSha256) {
      throw new ProfileError('ADAPTER_CHANGED', '模型适配包和登记的不一致（文件被替换过），请核对后更新上游配置');
    }
    const dir = join(workDir, 'adapter-' + sha.slice(0, 16));
    signerFile = join(dir, 'package', 'lib', 'signer.js');
    if (!existsSync(signerFile)) {
      await mkdir(dir, { recursive: true });
      const copy = join(dir, 'adapter.tgz');
      await writeFile(copy, archive);
      await exec(SYSTEM_TAR, ['-xf', copy, '-C', dir, 'package/package.json', 'package/lib/signer.js'],
        { windowsHide: true, timeout: 15000, maxBuffer: 32768, encoding: 'utf8' });
    }
  }
  // Ambient TEMP may hold a DLL from a different CodeAgent release. The default
  // path reuses only our versioned cache or the installation's own runtime pair.
  const nativeMissing = native && !await findNativeRuntime({ codeagentDir: profile.codeagentDir, runtimeDir });
  const firstInit = !!profile.signerInit?.needed || nativeMissing;
  const signerCacheDir = nativeMissing ? join(workDir, 'signer-cache') : profile.signerCacheDir;
  const started = Date.now();
  const probeTimeoutMs = Math.max(1000, timeoutMs - 15_000);
  // Diagnostics of the first-time run (counts, booleans, categories; never the stamp, log or CLI output).
  let probe = null, cacheWrite = null;
  const info = extra => ({ ran: firstInit, ms: Date.now() - started, reason: profile.signerInit?.reason || null,
    cliRuns: probe?.cliStarted ? 1 : 0, method: firstInit ? 'native-cli' : null, probe, cacheWrite, ...extra });
  if (firstInit) {
    const workRoot = join(workDir, 'first-init');
    await mkdir(workRoot, { recursive: true });
    let result;
    try {
      result = await stampProbe({ cliExe: join(profile.codeagentDir, 'bin', 'codeagentcli.exe'), configDir: configDirOf(profile.personalCredential),
        expectedVersion: profile.codeagentVersion, workRoot, timeoutMs: probeTimeoutMs, model: profile.stampProbeModel || '',
        ...(native ? { nativeRuntimeDir: runtimeDir } : {}) });
    } catch (error) {
      result = { ok: false, report: { ran: true, cliStarted: false, error: 'PROBE_FAILED:' + String(error?.code || 'unknown').slice(0, 40) } };
    }
    probe = result.report;
    if (!result.ok) {
      const code = probe.error === 'SIGNER_NATIVE_FILES_MISSING' ? 'SIGNER_NATIVE_FILES_MISSING'
        : probe.error === 'CLI_TIMEOUT' ? 'SIGNER_INIT_TIMEOUT' : probe.cliStarted ? 'SIGNER_INIT_NO_STAMP' : 'SIGNER_INIT_CLI_FAILED';
      const error = new ProfileError(code, signerInitFailureMessage(code, { version: profile.codeagentVersion, timeoutMs: probeTimeoutMs, detail: probe.error }));
      error.firstInit = info(); throw error;
    }
    try { cacheWrite = { ok: true, category: await writeStampCache(signerCacheDir, profile.codeagentVersion, result.stamp) }; }
    catch (error) {
      cacheWrite = { ok: false, category: 'hub-signer-cache', error: String(error?.code || 'unknown').slice(0, 40) };
      const failed = new ProfileError('SIGNER_INIT_CACHE_WRITE', signerInitFailureMessage('SIGNER_INIT_CACHE_WRITE', { version: profile.codeagentVersion }));
      failed.firstInit = info(); throw failed;
    }
  }
  const previous = process.env[profile.signerCacheEnv];
  process.env[profile.signerCacheEnv] = signerCacheDir; // this dedicated proxy process only
  let summary = null;
  try {
    // The stamp cache is in place now, so the signer itself never needs to start the CLI (a CLI spawn is blocked).
    const signer = await initializeCacheOnlySigner({ codeagentDir: profile.codeagentDir,
      loadSigner: () => native ? createNativeSigner({ version: profile.codeagentVersion, cacheDir: signerCacheDir,
        codeagentDir: profile.codeagentDir, runtimeDir, tempDir: '', appId: profile.appId, telemetryUrl: profile.telemetryUrl || '' })
        : import(pathToFileURL(signerFile).href),
      allowStampProbe: false, timeoutMs,
      onSummary: s => { summary = s; },
      ...(testOnlySpawnDelegate ? { testOnly: true, testOnlySpawnDelegate } : {}) });
    if (signer.codeagentVersion() !== profile.codeagentVersion) throw new ProfileError('SIGNER_VERSION', 'CodeAgent 版本和签名模块不一致');
    if (firstInit && (await inspectStamp(signerCacheDir, profile.codeagentVersion)).state !== 'ok') {
      throw new ProfileError('SIGNER_INIT_NO_STAMP', signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { version: profile.codeagentVersion }));
    }
    return { signer, adapterSha256: sha, firstInit: firstInit ? info({ signerCliBlocked: summary?.cliBlocked ?? 0 }) : { ran: false, ms: 0, reason: null, cliRuns: 0 } };
  } catch (error) {
    if (previous === undefined) delete process.env[profile.signerCacheEnv]; else process.env[profile.signerCacheEnv] = previous;
    if (error instanceof ProfileError) { error.firstInit = info(); throw error; }
    const code = String(error?.code || '');
    const wrapped = code === 'SIGNER_INIT_SPAWN_BLOCKED' || code === 'SIGNER_INIT_TIMEOUT'
      ? new ProfileError(code, signerInitFailureMessage(code, { version: profile.codeagentVersion, timeoutMs }))
      : new ProfileError('SIGNER_INIT_FAILED', firstInit ? signerInitFailureMessage(code, { version: profile.codeagentVersion })
        : '签名模块初始化失败（请确认 CodeAgent 已安装并登录过）：' + (code || 'unknown'));
    wrapped.firstInit = info({ signerCliBlocked: error?.spawnSummary?.cliBlocked ?? summary?.cliBlocked ?? 0 });
    throw wrapped;
  }
}
