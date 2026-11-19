'use strict';
// 包内加密模块（2026-11-19）：部分功能的代码以密文随包发布（core/sealed/bundle.bin），本机有钥匙才解开。
//     解开过一次就把 K 存进本机（Windows 用 DPAPI 绑定当前用户；DPAPI 不可用时退回受限文件——Windows 上先把文件 ACL
//   - 有钥匙：在主进程和界面进程里接管 require 与 file:// 请求，同路径的文件改用密文里的版本；
//     没钥匙或密文被改过：什么都不接管，程序就是不带这些功能的普通版本，不报错。
// 包格式：MAGIC | iv(12) | tag(16) | AES-256-GCM 密文；明文是 gzip 的 JSON {v, files:{相对路径: base64}, features, materialize}。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MAGIC = Buffer.from('AHSEAL1\n');
const APP_ROOT = path.resolve(__dirname, '..');
const BUNDLE_REL = 'core/sealed/bundle.bin';
const PARAMS_REL = 'core/sealed/unlock.json';
const CACHE_FILE = 'sealed-unlock.json';
const IPC_PAYLOAD = 'sealed:payload';

const toPosix = p => String(p).split(path.sep).join('/');
const norm = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };

// ---- 加解密 ----
function deriveKey(code, params, cb) {
  const text = String(code || '').trim().toLowerCase();
  const opts = { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 };
  if (cb) return crypto.scrypt(text, Buffer.from(params.salt, 'hex'), 32, opts, cb);
  return crypto.scryptSync(text, Buffer.from(params.salt, 'hex'), 32, opts);
}
function deriveKeyAsync(code, params) {
  return new Promise((resolve, reject) => deriveKey(code, params, (error, key) => error ? reject(error) : resolve(key)));
}

// 同一份明文 + 同一把钥匙得到同一份密文（iv 取 HMAC），差量更新不会因每次随机 iv 而整块变化。
function seal(payload, key) {
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  const iv = crypto.createHmac('sha256', key).update(plain).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}
// 钥匙不对、文件被改、格式不对：一律返回 null。
function open(buf, key) {
  try {
    if (!Buffer.isBuffer(buf) || !Buffer.isBuffer(key) || key.length !== 32) return null;
    if (buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(buf.subarray(MAGIC.length + 28)), decipher.final()]);
    const payload = JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
    return payload && payload.v === 1 && payload.files && typeof payload.files === 'object' ? payload : null;
  } catch { return null; }
}

// ---- 本机钥匙缓存 ----
const PS_PROTECT = "Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($i),$null,'CurrentUser'))";
const PS_UNPROTECT = PS_PROTECT.replace('::Protect(', '::Unprotect(');
function powershell(script, input, { sync = true } = {}) {
  const { execFileSync, execFile } = require('node:child_process');
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script];
  const opts = { input, encoding: 'utf8', windowsHide: true, timeout: 15000 };
  if (sync) return String(execFileSync('powershell.exe', args, { ...opts, stdio: ['pipe', 'pipe', 'ignore'] })).trim();
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', args, opts, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
    child.stdin.end(input);
  });
}
// 把文件 ACL 收成「只有当前用户、不继承」，并读回核验（审查 P2-1：只设 mode 0600 在 Windows 上不起作用，
// 实测仍继承 Authenticated Users(M)、Users(RX)，同机别的账号能直接读走明文 K）。返回 true 才算收住。
const PS_ME = "$p=[Console]::In.ReadToEnd().Trim();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;";
const PS_CHECK = "$g=[IO.File]::GetAccessControl($p);" +
  "$ids=@($g.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique);" +
  "if($g.AreAccessRulesProtected -and $ids.Count -eq 1 -and $ids[0] -eq $sid.Value){'locked'}else{'open:'+($ids -join ',')}";
const PS_LOCKDOWN = PS_ME +
  "$a=New-Object Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false);" +
  "$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));" +
  "[IO.File]::SetAccessControl($p,$a);" + PS_CHECK;
const PS_VERIFY = PS_ME + PS_CHECK;
async function lockToCurrentUser(file) {
  if (process.platform !== 'win32') return true; // POSIX 上 mode 0600 本身就有效
  try { return (await powershell(PS_LOCKDOWN, file, { sync: false })) === 'locked'; } catch { return false; }
}
// 只读核验：不改 ACL，只看是否「不继承 + 只有当前用户」。写进 K 之后、改名前后各核一次。
async function verifyCurrentUserOnly(file) {
  if (process.platform !== 'win32') { try { return (fs.statSync(file).mode & 0o077) === 0; } catch { return false; } }
  try { return (await powershell(PS_VERIFY, file, { sync: false })) === 'locked'; } catch { return false; }
}
const defaultProtector = {
  available: () => process.platform === 'win32' && process.env.AI_HUB_SEALED_NO_DPAPI !== '1',
  protect: async key => powershell(PS_PROTECT, key.toString('base64'), { sync: false }),
  unprotect: data => Buffer.from(powershell(PS_UNPROTECT, data), 'base64'),
  lockdown: lockToCurrentUser,
};

function cachePath(dataDir) { return path.join(dataDir, CACHE_FILE); }
function readCachedKey(dataDir, protector = defaultProtector) {
  if (!dataDir) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8')); } catch { return null; }
  try {
    const key = raw.store === 'dpapi' ? protector.unprotect(String(raw.data || '')) : raw.store === 'file' ? Buffer.from(String(raw.data || ''), 'base64') : null;
    return key && key.length === 32 ? key : null;
  } catch { return null; }
}
async function writeCachedKey(dataDir, key, protector = defaultProtector) {
  let record = null;
  if (protector.available()) {
    try { record = { v: 1, store: 'dpapi', data: await protector.protect(key) }; } catch { record = null; }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = cachePath(dataDir);
  // 每次保存一个独占新建（wx）、带随机后缀的中间文件（审查 P2-1 并发：原来同进程共用 <pid>.tmp，
  // B 删掉重建 A 已收紧的占位，A 再写 K 并改名，最终文件继承 Users/Authenticated Users 可读）。
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const drop = p => { try { fs.rmSync(p, { force: true }); } catch { /* 尽力清理 */ } };
  if (record) {
    try { fs.writeFileSync(tmp, JSON.stringify({ ...record, at: Date.now() }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); } catch { drop(tmp); return null; }
    if (!(await renameWithRetry(tmp, file))) { drop(tmp); return null; }
    return record.store;
  }
  // 明文后备：先独占建一个不含 K 的占位、收紧 ACL 并核验，过了才往同一个文件里写 K（r+ 打开，文件没了就失败，不会新建）；
  const lockdown = typeof protector.lockdown === 'function' ? protector.lockdown : lockToCurrentUser;
  const verify = typeof protector.verify === 'function' ? protector.verify : verifyCurrentUserOnly;
  try { fs.writeFileSync(tmp, '{}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); } catch { drop(tmp); return null; }
  let locked = false;
  try { locked = await lockdown(tmp); } catch { locked = false; }
  if (!locked) { drop(tmp); return null; }
  try {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify({ v: 1, store: 'file', data: key.toString('base64'), at: Date.now() }) + '\n'); } finally { fs.closeSync(fd); }
  } catch { drop(tmp); return null; }
  let ok = false;
  try { ok = await verify(tmp); } catch { ok = false; }
  if (!ok) { drop(tmp); return null; }
  if (!(await renameWithRetry(tmp, file))) { drop(tmp); return null; }
  try { ok = await verify(file); } catch { ok = false; }
  if (!ok) { drop(file); return null; }
  return 'file';
}
// Windows 上多个保存同时改名到同一目标会偶发 EPERM/EACCES/EBUSY，短暂重试几次。
async function renameWithRetry(from, to) {
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(from, to); return true; } catch (error) {
      if (!error || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return false;
      await new Promise(r => setTimeout(r, 20 + i * 30));
    }
  }
  return false;
}
const STORE_FAILED = { ok: false, reason: 'store-failed', message: '口令正确，但这台电脑没法安全地保存钥匙（系统加密 DPAPI 不可用），这次没存下；请稍后重新输入口令再试' };

// ---- 运行状态 ----
const state = { present: false, loaded: false, reason: 'not-installed', files: null, features: {}, materialize: [], root: APP_ROOT, dataDir: null };

function readParams(root = APP_ROOT) {
  try { const p = JSON.parse(fs.readFileSync(path.join(root, PARAMS_REL), 'utf8')); return p && p.v === 1 && p.salt && p.N ? p : null; } catch { return null; }
}
function readBundle(root = APP_ROOT) { try { return fs.readFileSync(path.join(root, BUNDLE_REL)); } catch { return null; } }
function present(root = APP_ROOT) { return fs.existsSync(path.join(root, BUNDLE_REL)) && !!readParams(root); }

function adopt(payload, root) {
  const files = new Map();
  for (const [rel, b64] of Object.entries(payload.files)) files.set(norm(path.join(root, rel)), Buffer.from(String(b64), 'base64'));
  state.files = files;
  state.features = payload.features && typeof payload.features === 'object' ? payload.features : {};
  state.materialize = Array.isArray(payload.materialize) ? payload.materialize.map(String) : [];
  state.loaded = true;
  state.reason = 'loaded';
}

// ---- 接管 require ----
let hooked = false;
function installRequireHook() {
  if (hooked) return;
  hooked = true;
  const Module = require('node:module');
  const resolve0 = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try { return resolve0.call(this, request, parent, isMain, options); }
    catch (error) {
      if (error && error.code === 'MODULE_NOT_FOUND' && state.files && typeof request === 'string' && (request.startsWith('.') || path.isAbsolute(request))) {
        const base = path.resolve(parent && parent.filename ? path.dirname(parent.filename) : process.cwd(), request);
        for (const candidate of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) if (state.files.has(norm(candidate))) return candidate;
      }
      throw error;
    }
  };
  const js0 = Module._extensions['.js'];
  Module._extensions['.js'] = function (module, filename) {
    const buf = state.files && state.files.get(norm(filename));
    if (buf) return module._compile(buf.toString('utf8').replace(/^﻿/, ''), filename);
    return js0.call(this, module, filename);
  };
  const json0 = Module._extensions['.json'];
  Module._extensions['.json'] = function (module, filename) {
    const buf = state.files && state.files.get(norm(filename));
    if (buf) { module.exports = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); return; }
    return json0.call(this, module, filename);
  };
}

// 主进程启动入口（main-bootstrap.js，在加载 main.js 之前）：有包、有钥匙、能解开才接管。
function installMain({ root = APP_ROOT, dataDir, protector = defaultProtector, ipcMain = null } = {}) {
  state.root = root; state.dataDir = dataDir || null;
  // 界面每次加载都会同步问一次（renderer/sealed-boot.js），没解开也要应答，否则界面会卡住等回答。
  if (ipcMain) registerPayloadIpc(ipcMain);
  state.present = present(root);
  if (!state.present) { state.reason = 'absent'; return status(); }
  const key = readCachedKey(dataDir, protector);
  if (!key) { state.reason = 'no-key'; return status(); }
  const payload = open(readBundle(root), key);
  if (!payload) { state.reason = 'bad-key-or-bundle'; return status(); }
  adopt(payload, root);
  installRequireHook();
  return status();
}

function payloadForRenderer() {
  if (!state.loaded) return null;
  const files = {};
  for (const [abs, buf] of state.files) {
    const rel = toPosix(path.relative(norm(state.root), abs));
    if (/^(?:core|renderer)\//.test(rel)) files[rel] = buf.toString('base64');
  }
  return { files, features: state.features };
}
let ipcRegistered = false;
function registerPayloadIpc(ipcMain) {
  if (ipcRegistered || !ipcMain) return;
  ipcRegistered = true;
  let cached = null;
  ipcMain.on(IPC_PAYLOAD, event => { try { event.returnValue = state.loaded ? cached || (cached = payloadForRenderer()) : null; } catch { event.returnValue = null; } });
}

// 界面进程（renderer/sealed-boot.js，页面里第一个脚本）：从主进程取一次明文，接管本页面的 require。
function installRenderer({ ipcRenderer = require('electron').ipcRenderer, root = APP_ROOT } = {}) {
  state.root = root;
  let payload = null;
  try { payload = ipcRenderer.sendSync(IPC_PAYLOAD); } catch { payload = null; }
  if (!payload || !payload.files) { state.reason = 'no-payload'; return status(); }
  adopt({ v: 1, ...payload }, root);
  installRequireHook();
  return status();
}

// ---- 接管 file:// 请求（页面、样式、<script src>）----
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const attached = new WeakSet();
function attachSession(ses) {
  if (!state.loaded || !ses || attached.has(ses)) return false;
  attached.add(ses);
  const { net } = require('electron');
  const { fileURLToPath } = require('node:url');
  ses.protocol.handle('file', request => {
    let buf = null, file = '';
    try { const u = new URL(request.url); u.search = ''; u.hash = ''; file = fileURLToPath(u.href); buf = state.files.get(norm(file)); } catch { buf = null; }
    if (buf) return new Response(buf, { status: 200, headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  return true;
}

// 读一个文件：解开了就先看密文里有没有（给按文件读的功能用，例如 JSON 配置）。
function readText(file) {
  const buf = state.files && state.files.get(norm(file));
  return buf ? buf.toString('utf8') : null;
}
// 要由独立进程按路径运行的脚本：写到数据目录下的运行副本，返回路径；没解开返回 null。
function materialize(rel) {
  if (!state.loaded || !state.dataDir) return null;
  const buf = state.files.get(norm(path.join(state.root, rel)));
  if (!buf) return null;
  const out = path.join(state.dataDir, 'sealed-runtime', rel);
  try {
    let same = false;
    try { same = fs.readFileSync(out).equals(buf); } catch { same = false; }
    if (!same) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf, { mode: 0o600 }); }
    return out;
  } catch { return null; }
}

function featureOverride(name) {
  return state.loaded && Object.prototype.hasOwnProperty.call(state.features, name) ? state.features[name] : undefined;
}

async function unlockWithCode(code, { root = APP_ROOT, dataDir = state.dataDir, protector = defaultProtector } = {}) {
  const params = readParams(root);
  const bundle = readBundle(root);
  if (!params || !bundle) return { ok: false, reason: 'absent', message: '这个版本没有可解锁的功能' };
  const text = String(code || '').trim();
  if (text.length < 6 || text.length > 64) return { ok: false, reason: 'format', message: '口令长度不对' };
  let key;
  try { key = await deriveKeyAsync(text, params); } catch (error) { return { ok: false, reason: 'error', message: error.message }; }
  if (!open(bundle, key)) return { ok: false, reason: 'wrong', message: '口令不对' };
  const store = await writeCachedKey(dataDir, key, protector);
  return store ? { ok: true, store } : { ...STORE_FAILED };
}

// 已有钥匙（例如旧版迁移时拿到的）：确认能解开本包或格式正确后存下。
async function cacheKey(key, { dataDir = state.dataDir, protector = defaultProtector } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !dataDir) return { ok: false };
  const existing = readCachedKey(dataDir, protector);
  if (existing && existing.equals(key)) return { ok: true, store: 'existing' };
  const store = await writeCachedKey(dataDir, key, protector);
  return store ? { ok: true, store } : { ...STORE_FAILED };
}
function hasCachedKey(dataDir = state.dataDir) { try { return fs.existsSync(cachePath(dataDir)); } catch { return false; } }

function status() { return { present: state.present, loaded: state.loaded, reason: state.reason }; }
function loaded() { return state.loaded; }

module.exports = {
  MAGIC, BUNDLE_REL, PARAMS_REL, CACHE_FILE, IPC_PAYLOAD,
  deriveKey, deriveKeyAsync, seal, open, readParams, present,
  readCachedKey, writeCachedKey, lockToCurrentUser, verifyCurrentUserOnly, cacheKey, hasCachedKey,
  installMain, installRenderer, attachSession, registerPayloadIpc, readText, materialize, featureOverride, unlockWithCode,
  status, loaded,
  _state: state,
};
