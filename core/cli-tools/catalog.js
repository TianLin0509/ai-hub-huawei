'use strict';
// CLI 组件目录 components.json（2026-11-07，一键安装 Claude Code / Codex / DSH）。
// 放在自家下载源上，和一键更新的 latest.json 同一台主机：<主机>/hub-update/components/components.json。
// 由发布机上的 scripts/build-cli-components.js 生成并签名，客户端只信签名通过的目录里写的大小和 sha256。
//
// {
//   "schema": 1, "publishedAt": "2026-11-07T00:00:00Z",
//   "components": [{
//     "id": "codex", "name": "Codex", "version": "0.167.0", "kind": "tgz", "license": "Apache-2.0",
//     "preferOfficial": false,                       // true：先走官方地址，自家源只当后备
//     "files": [{ "name": "codex-0.167.0-win32-x64.tgz", "bytes": 181015521, "sha256": "…",
//                 "url": "codex/0.167.0/codex-0.167.0-win32-x64.tgz",   // 相对目录地址；没有就表示自家源不放
//                 "official": ["https://registry.npmmirror.com/…tgz"] }],  // 官方原始地址（可多个）
//     "install": { "strip": "package/vendor/x86_64-pc-windows-msvc", "bin": "bin/codex.exe",
//                  "pathDirs": ["bin", "codex-path"], "versionArgs": ["--version"] }
//   }],
//   "signature": "<ed25519，对去掉 signature 后按键排序的 JSON 签名>"
// }
//
// 签名和会议室组件同一种做法（core/company-assistant/room-component.js）：键排序后的 JSON 用 ed25519 验签，
// 公钥写在程序里，私钥只在发布机上。地址只是取件地点，换了文件或改了目录都装不进去。
const crypto = require('crypto');
const { cleanRel } = require('./tar');

// 发布机生成的组件目录签名公钥（私钥不进仓库）。
const PUBLIC_KEY_HEX = '302a300506032b65700321000f541a07f44bc3f490da52763debe083aff0b0ff2477d729638984c81540535e';
const IDS = Object.freeze(['claude', 'codex', 'dsh', 'node', 'git']);
const KINDS = Object.freeze(['exe', 'tgz']);
const SHA = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9._+-]{1,120}$/;
const REL_URL = /^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+){0,6}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const FOREIGN = /(^|\.)(github\.com|githubusercontent\.com|github\.io)$/i;

const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
function canonical(body) { return Buffer.from(JSON.stringify(ordered(body)), 'utf8'); }
function publicKey(hex = PUBLIC_KEY_HEX) { return crypto.createPublicKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'spki' }); }

function sign(catalog, privateKey) {
  const { signature, ...body } = catalog;
  return { ...body, signature: crypto.sign(null, canonical(body), privateKey).toString('hex') };
}
function verifySignature(catalog, key = publicKey()) {
  const { signature, ...body } = catalog || {};
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/.test(signature)) return false;
  try { return crypto.verify(null, canonical(body), key, Buffer.from(signature, 'hex')); } catch { return false; }
}

const relPath = (value, label) => {
  const rel = cleanRel(value);
  if (!rel || rel !== String(value)) throw new Error(`${label}路径不合规`);
  return rel;
};
const httpsUrl = value => {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error('官方下载地址无效'); }
  if (u.protocol !== 'https:') throw new Error('官方下载地址必须是 https');
  return u.href;
};

function checkFile(f, label) {
  if (!f || typeof f !== 'object') throw new Error(`${label}缺少文件`);
  if (!FILE.test(String(f.name || ''))) throw new Error(`${label}的文件名不合规`);
  if (!Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_BYTES) throw new Error(`${label}的大小不在允许范围`);
  if (!SHA.test(String(f.sha256 || ''))) throw new Error(`${label}的校验值无效`);
  if (f.url !== undefined && (!REL_URL.test(String(f.url)) || String(f.url).split('/').some(p => p === '..' || p === '.'))) throw new Error(`${label}的自家地址不合规`);
  const official = f.official === undefined ? [] : f.official;
  if (!Array.isArray(official) || official.length > 4) throw new Error(`${label}的官方地址不合规`);
  const urls = official.map(httpsUrl);
  if (!f.url && !urls.length) throw new Error(`${label}没有任何下载地址`);
  return { name: f.name, bytes: f.bytes, sha256: f.sha256, ...(f.url ? { url: f.url } : {}), official: urls };
}

function checkInstall(raw, kind, label) {
  const i = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (i.strip !== undefined && i.strip !== '') { if (kind !== 'tgz') throw new Error(`${label}：只有压缩包能指定解压前缀`); out.strip = relPath(i.strip, `${label}的解压前缀`); }
  if (i.bin !== undefined) out.bin = relPath(i.bin, `${label}的程序`);
  const list = (value, max, check, name) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label}的${name}不合规`);
    return value.map(check);
  };
  const check = list(i.check, 10, v => relPath(v, `${label}的核对文件`), '核对文件');
  if (check) out.check = check;
  const pathDirs = list(i.pathDirs, 4, v => v === '.' ? '.' : relPath(v, `${label}的程序目录`), '程序目录');
  if (pathDirs) out.pathDirs = pathDirs;
  const versionArgs = list(i.versionArgs, 2, v => { if (!/^--?[a-z][a-z-]{0,20}$/.test(String(v))) throw new Error(`${label}的版本参数不合规`); return v; }, '版本参数');
  if (versionArgs) out.versionArgs = versionArgs;
  const requires = list(i.requires, 2, v => { if (!IDS.includes(v)) throw new Error(`${label}依赖的组件不认识`); return v; }, '依赖');
  if (requires) out.requires = requires;
  if (i.minNode !== undefined) { if (!Number.isInteger(i.minNode) || i.minNode < 18 || i.minNode > 99) throw new Error(`${label}的 Node 版本要求不合规`); out.minNode = i.minNode; }
  if (kind === 'exe' && !out.bin) throw new Error(`${label}缺少程序文件名`);
  return out;
}

// 校验整份目录。publicKey 传 null 只在单测里用（测试自己生成钥匙对时传它自己的公钥）。
function validateCatalog(raw, { key = publicKey() } = {}) {
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!m || m.schema !== 1 || !Array.isArray(m.components) || m.components.length > 20) throw new Error('组件目录的格式不认识');
  if (key && !verifySignature(m, key)) throw new Error('组件目录签名不正确');
  const seen = new Set();
  const components = [];
  for (const c of m.components) {
    // 以后的新组件老版本不认识：跳过，不让整份目录作废。
    if (!c || !IDS.includes(c.id)) continue;
    if (seen.has(c.id)) throw new Error('组件目录里有重复的组件');
    seen.add(c.id);
    const label = `组件 ${c.id}`;
    if (!VERSION.test(String(c.version || ''))) throw new Error(`${label}的版本号无效`);
    if (!KINDS.includes(c.kind)) throw new Error(`${label}的包类型不认识`);
    // 第一版每个组件只有一个文件；数组留给以后分卷。
    if (!Array.isArray(c.files) || c.files.length !== 1) throw new Error(`${label}的文件清单不合规`);
    components.push({ id: c.id, name: String(c.name || c.id).slice(0, 40), version: c.version, kind: c.kind,
      license: String(c.license || '').slice(0, 60), preferOfficial: c.preferOfficial === true,
      files: c.files.map(f => checkFile(f, label)), install: checkInstall(c.install, c.kind, label) });
  }
  return { schema: 1, publishedAt: String(m.publishedAt || ''), components };
}

// 目录地址：测试用 AI_HUB_CLI_COMPONENTS_SOURCES（JSON 数组 [{ id, name, manifest }]）；
// 否则从一键更新的下载源推出来：每个自家主机（不是 GitHub 的）放一份 /hub-update/components/components.json。
function catalogSources({ config = null, env = process.env } = {}) {
  if (env.AI_HUB_CLI_COMPONENTS_SOURCES) {
    const list = JSON.parse(env.AI_HUB_CLI_COMPONENTS_SOURCES);
    if (!Array.isArray(list) || !list.length) throw new Error('AI_HUB_CLI_COMPONENTS_SOURCES 必须是非空数组');
    return list.map((s, i) => ({ id: String(s.id || 'source-' + i), name: String(s.name || s.id || '下载源'), manifest: String(s.manifest) }));
  }
  let sources = [];
  const testing = !!env.AI_HUB_UPDATE_SOURCES;
  if (testing) { try { sources = JSON.parse(env.AI_HUB_UPDATE_SOURCES); } catch { sources = []; } }
  else sources = config && Array.isArray(config.sources) ? config.sources : [];
  const out = [], seen = new Set();
  for (const s of sources) {
    let u;
    try { u = new URL(String(s && s.manifest)); } catch { continue; }
    if (FOREIGN.test(u.hostname) || (u.protocol !== 'https:' && !testing)) continue;
    const manifest = u.origin + '/hub-update/components/components.json';
    if (seen.has(manifest)) continue;
    seen.add(manifest);
    out.push({ id: String(s.id || u.hostname), name: String(s.name || u.hostname), manifest });
  }
  return out;
}

function officialName(url) {
  const host = new URL(url).hostname;
  if (host === 'registry.npmmirror.com' || host.endsWith('.npmmirror.com')) return 'npm 国内镜像';
  if (host === 'registry.npmjs.org') return 'npm 官方源';
  return `官方下载（${host}）`;
}

// 一个文件的下载顺序：自家源（目录从哪个源读到的就排在前面）+ 官方地址；preferOfficial 时官方在前。
function fileSources(component, file, catalogList) {
  const mirror = file.url ? catalogList.map(s => ({ id: s.id, name: s.name, url: new URL(file.url, s.manifest).href })) : [];
  const official = file.official.map((url, i) => ({ id: 'official-' + i, name: officialName(url), url }));
  return component.preferOfficial ? [...official, ...mirror] : [...mirror, ...official];
}

module.exports = { IDS, PUBLIC_KEY_HEX, VERSION, canonical, publicKey, sign, verifySignature, validateCatalog, catalogSources, fileSources, officialName };
