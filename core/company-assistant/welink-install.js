'use strict';
// welink-cli 一键安装（2026-11-08）：不少公司电脑没有 Node / npm，而 npm 包里已经带着可独立运行的 welink-cli.exe，
// 安装脚本也只是加 PATH。所以这里直接从内部软件源取包、核对 npm 元数据里的 sha512、只把 exe 放进 Hub 数据目录。
// 不需要管理员，不改 .npmrc，不运行包里的任何脚本。公司真机依据：Q-1108-32、Q-1108-33。
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { resolveFetch } = require('./fetch-util');

const DEFAULT_REGISTRY = '';
const PACKAGE_PATH = '@welink%2fwelink-cli';
const PACKAGE_NAME = '@welink/welink-cli';
const MAX_META = 8 * 1024 * 1024;
const MAX_TARBALL = 100 * 1024 * 1024;
const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_USER_PATH = 2047;
const fail = (code, message) => Object.assign(new Error(message), { code });

function npmrcRegistry(file = path.join(os.homedir(), '.npmrc')) {
  try {
    const hit = fsSync.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.match(/^\s*@welink:registry\s*=\s*(\S+)\s*$/i)).find(Boolean);
    return hit ? hit[1] : '';
  } catch { return ''; }
}
function normalizeRegistry(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    url.search = ''; url.hash = '';
    return url.href.endsWith('/') ? url.href : url.href + '/';
  } catch { return ''; }
}
function resolveRegistry({ registry = DEFAULT_REGISTRY, readNpmrc = npmrcRegistry } = {}) {
  return normalizeRegistry(registry) || normalizeRegistry(readNpmrc());
}

function parseMetadata(text, registry) {
  let meta;
  try { meta = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { throw fail('WELINK_INSTALL_META', '内部软件源返回的不是有效的包信息，可能被公司网络确认页挡住了'); }
  const version = meta?.['dist-tags']?.latest;
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(String(version || '')) || version.length > 64) throw fail('WELINK_INSTALL_META', '内部软件源没有给出可用的版本号');
  const dist = meta.versions?.[version]?.dist || {};
  const hash = String(dist.integrity || '').match(/^sha512-([A-Za-z0-9+/]{86}==)$/)?.[1];
  if (!hash) throw fail('WELINK_INSTALL_META', '内部软件源缺少安装包校验值，已停止安装');
  let tarball;
  try { tarball = new URL(dist.tarball); } catch { throw fail('WELINK_INSTALL_META', '内部软件源没有给出安装包地址'); }
  if (tarball.protocol !== 'https:' || tarball.hostname !== new URL(registry).hostname) throw fail('WELINK_INSTALL_META', '安装包地址不在内部软件源上，已停止安装');
  return { version, tarball: tarball.href, sha512: hash };
}

// npm 包是 gzip 过的 tar。只认普通文件；PAX/长文件名扩展头按大小跳过，不写盘，所以包里的路径不可能逃出目标目录。
function readPackage(tgz) {
  let tar;
  try { tar = zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }); } catch { throw fail('WELINK_INSTALL_PACKAGE', '安装包无法解开，已停止安装'); }
  let exe = null, packageJson = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => { const raw = header.subarray(start, start + length), end = raw.indexOf(0); return raw.subarray(0, end < 0 ? length : end).toString('utf8'); };
    const size = parseInt(text(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw fail('WELINK_INSTALL_PACKAGE', '安装包内容不完整，已停止安装');
    const type = String.fromCharCode(header[156] || 48), prefix = text(345, 155), base = text(0, 100), name = prefix ? `${prefix}/${base}` : base;
    if (type === '0') {
      if (/^[^/\\]+\/welink-cli\.exe$/i.test(name)) exe = tar.subarray(offset + 512, offset + 512 + size);
      if (/^[^/\\]+\/package\.json$/i.test(name)) packageJson = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  let info = null;
  try { info = JSON.parse(String(packageJson || '').replace(/^\uFEFF/, '')); } catch { /* 下面按缺失处理 */ }
  if (info?.name !== PACKAGE_NAME) throw fail('WELINK_INSTALL_PACKAGE', '安装包不是 welink-cli，已停止安装');
  if (!exe || exe.length < 2 || exe[0] !== 0x4d || exe[1] !== 0x5a) throw fail('WELINK_INSTALL_PACKAGE', '安装包里没有 Windows 版 welink-cli 程序');
  return { exe: Buffer.from(exe), version: info.version };
}

const runFile = (file, args, options = {}) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024, ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(String(stdout || ''))));

// 官方安装脚本也把程序目录加到用户 PATH，CodeAgent 的 welink 技能靠它调用。reg.exe 读到的是未展开的原值，写回不会把 %VAR% 展开掉。
// 这是附加步骤：失败不影响 Hub 使用已登记的路径。
async function addUserPath(dir, { run = runFile, env = process.env } = {}) {
  const key = 'HKCU\\Environment';
  let value = '', type = 'REG_EXPAND_SZ';
  try {
    const hit = (await run('reg.exe', ['query', key, '/v', 'Path'])).split(/\r?\n/).map(line => line.match(/^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.*?)\s*$/i)).find(Boolean);
    if (!hit) return { added: false, reason: 'unreadable' };
    type = hit[1].toUpperCase(); value = hit[2];
  } catch (error) {
    if (!/unable to find|找不到/i.test(`${error.stderr || ''}${error.message || ''}`)) return { added: false, reason: 'unreadable' };
  }
  const same = item => item.trim().replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase();
  const items = value.split(';').filter(item => item.trim());
  const addProcess = () => { const current = env.Path ?? env.PATH ?? ''; if (!current.split(';').some(same)) { const next = current ? `${current};${dir}` : dir; if ('Path' in env || !('PATH' in env)) env.Path = next; else env.PATH = next; } };
  if (items.some(same)) { addProcess(); return { added: false, reason: 'present' }; }
  const next = [...items, dir].join(';');
  if (next.length > MAX_USER_PATH) return { added: false, reason: 'too-long' };
  await run('reg.exe', ['add', key, '/v', 'Path', '/t', type, '/d', next, '/f']);
  addProcess();
  return { added: true };
}

function createWelinkInstaller({ dir, fetchImpl, registry, readNpmrc, configure, onState = () => {}, verify, updatePath = addUserPath, now = Date.now } = {}) {
  let state = { phase: 'idle' }, pending = null;
  const source = () => resolveRegistry({ ...(registry === undefined ? {} : { registry }), ...(readNpmrc ? { readNpmrc } : {}) });
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch, at: now() }; try { onState(snapshot()); } catch { /* 界面关闭不打断安装 */ } };
  const friendlyHttp = status => (status === 401 || status === 403 ? '内部软件源要求登录或拒绝访问（HTTP ' + status + '）' : '内部软件源暂时不可用（HTTP ' + status + '）');
  async function get(fetch, url, limit, timeoutMs) {
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, application/octet-stream, */*' } }); }
    catch { throw fail('WELINK_INSTALL_NETWORK', '连不上公司内部软件源，请确认这台电脑已连接公司网络后重试'); }
    if (!response.ok) throw fail('WELINK_INSTALL_HTTP', friendlyHttp(response.status));
    if (Number(response.headers.get('content-length')) > limit) throw fail('WELINK_INSTALL_SIZE', '安装包大小超出预期，已停止安装');
    let body;
    try { body = Buffer.from(await response.arrayBuffer()); } catch { throw fail('WELINK_INSTALL_NETWORK', '下载中断了，请重试'); }
    if (body.length > limit) throw fail('WELINK_INSTALL_SIZE', '安装包大小超出预期，已停止安装');
    return body;
  }
  async function perform() {
    const job = path.join(dir, 'install-' + randomUUID());
    set({ phase: 'checking', message: '正在查询最新版本…', error: null, version: '' });
    try {
      const base = source();
      if (!base) throw fail('WELINK_INSTALL_NO_SOURCE', '这个版本没有配置内部软件源，请按安装步骤手动安装');
      const fetch = resolveFetch(fetchImpl);
      const meta = parseMetadata(await get(fetch, new URL(PACKAGE_PATH, base).href, MAX_META, 30000), base);
      set({ phase: 'downloading', message: `正在下载 welink-cli ${meta.version}…`, version: meta.version });
      const tgz = await get(fetch, meta.tarball, MAX_TARBALL, 180000);
      set({ phase: 'verifying', message: '正在校验并验证程序…' });
      if (createHash('sha512').update(tgz).digest('base64') !== meta.sha512) throw fail('WELINK_INSTALL_HASH', '安装包校验不通过，已停止安装，请重试');
      const unpacked = readPackage(tgz);
      await fs.mkdir(job, { recursive: true });
      const trial = path.join(job, 'welink-cli.exe');
      await fs.writeFile(trial, unpacked.exe);
      try { await (verify || (file => runFile(file, ['--version'])))(trial); }
      catch { throw fail('WELINK_INSTALL_RUN', '程序下载好了但运行不起来，可能被安全软件拦截，请重试或手动安装'); }
      const finalDir = path.join(dir, unpacked.version);
      const finalExe = path.join(finalDir, 'welink-cli.exe');
      await fs.mkdir(finalDir, { recursive: true });
      try { await fs.rename(trial, finalExe); }
      catch (error) {
        // 同版本已存在且被占用时沿用；大小不一致才算失败。
        const existing = await fs.stat(finalExe).catch(() => null);
        if (!existing || existing.size !== unpacked.exe.length) throw error;
      }
      await configure(finalExe);
      let pathResult = { added: false, reason: 'failed' };
      try { pathResult = await updatePath(finalDir); } catch (error) { console.warn('[welink-install] 用户 PATH 未更新：', error.message); }
      set({ phase: 'done', message: `welink-cli ${unpacked.version} 已安装`, version: unpacked.version, path: finalExe, pathAdded: pathResult.added });
    } catch (error) {
      set({ phase: 'error', error: error.message, code: error.code || 'WELINK_INSTALL_FAILED', message: '安装未完成：' + error.message });
    } finally {
      // job 是本次新建的 UUID 目录，不是用户已有的安装。
      await fs.rm(job, { recursive: true, force: true }).catch(() => {});
    }
    return snapshot();
  }
  return { available: () => process.platform === 'win32' && !!source(), snapshot, install() { if (!pending) pending = perform().finally(() => { pending = null; }); return pending; } };
}

module.exports = { createWelinkInstaller, addUserPath, parseMetadata, readPackage, resolveRegistry, normalizeRegistry, npmrcRegistry };
