'use strict';
//   版本列表 GET {api}by_project_id → { code:"0", data:{ records:[{ id, version, releaseTime }] } }
//   单个版本 GET {api}by_id?id=<id> → { code:"0", data:{ binaryPackages:[{ originalFileName, url }] } }
//   附件 GET <fileSite>files/<id>/<文件名>：latest.json、latest.json.sig（用测试私钥签）、完整更新包。
// 每个版本可单独设：sig 'ok' | 'none' | 'bad'；manifestVersion（清单里写的版本，测「对不上」）；noPackage（缺完整更新包）；
// payload（这一版下载到的字节，默认用传入的 payload；给别的字节就能测「哈希对不上」）。
const crypto = require('node:crypto');
const openxConfig = require('../../core/app-update/openx-config');
const openxSource = require('../../core/app-update/openx-source');
const signing = require('../../core/app-update/manifest-signing');

const API = openxSource.DEFAULT_API;
const FILE_HOST = new URL('files/', openxConfig.fileSite).href;

function testKeys() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return { pub: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const packageName = v => `AIHubHuawei-${v}-update.gz`;

// releases: [{ version:'5.6.30', name?:'v5.6.30', runtime, notes, sig?, manifestVersion?, noPackage?, payload?, member? }]
function createOpenxReleaseMock({ releases, payload, keys = testKeys(), down = false } = {}) {
  const requests = [];
  const recs = releases.map((r, i) => {
    const id = 1000 + i;
    const body = r.payload || payload;
    const manifest = { schema: 1, product: 'AI HUB-Huawei', version: r.manifestVersion || r.version, publishedAt: r.publishedAt || `2026-11-${String(10 + i).padStart(2, '0')}T08:00:00Z`,
      notes: r.notes || [`v${r.version} 的改动`], runtime: r.runtime,
      // 清单里的大小与 sha256 永远按「正确的包」写；r.payload 给的是被换掉的字节，用来测核对失败。
      incremental: { file: packageName(r.version), bytes: payload.length, sha256: sha256(payload) },
      installer: { file: `AIHubHuawei-Setup-${r.version}.exe`, bytes: 4096, sha256: 'b'.repeat(64) } };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const sig = r.sig === 'bad' ? signing.signManifest(Buffer.from(raw.toString('utf8').replace(r.version, '9.9.9')), keys.pem) : signing.signManifest(raw, keys.pem);
    const files = { 'latest.json': raw, ...(r.sig === 'none' ? {} : { 'latest.json.sig': Buffer.from(sig, 'utf8') }), ...(r.noPackage ? {} : { [packageName(r.version)]: body }) };
    return { id, version: r.name || (r.member ? `member-v${r.version}` : `v${r.version}`), releaseTime: manifest.publishedAt.replace('T', ' ').slice(0, 19), files };
  });
  const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    url = String(url); requests.push(url);
    if (down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (url.startsWith(API + 'by_project_id')) return json({ code: '0', data: { records: recs.map(({ id, version, releaseTime }) => ({ id, version, releaseTime })) } });
    if (url.startsWith(API + 'by_id')) {
      const id = Number(new URL(url).searchParams.get('id'));
      const rec = recs.find(r => r.id === id);
      if (!rec) return json({ code: '1', data: null });
      return json({ code: '0', data: { binaryPackages: Object.keys(rec.files).map(name => ({ originalFileName: name, url: `${FILE_HOST}${id}/${encodeURIComponent(name)}` })) } });
    }
    if (url.startsWith(FILE_HOST)) {
      const [id, name] = url.slice(FILE_HOST.length).split('/');
      const rec = recs.find(r => String(r.id) === id);
      const buf = rec && rec.files[decodeURIComponent(name || '')];
      if (!buf) return new Response('nope', { status: 404 });
      const head = { 'content-length': String(buf.length), 'content-type': 'application/octet-stream' };
      if (opts.method === 'HEAD') return new Response(null, { status: 200, headers: head });
      return new Response(buf, { status: 200, headers: head });
    }
    throw new Error('模拟内源之外的地址不应被访问：' + url);
  };
  return { fetchImpl, requests, keys, API, FILE_HOST, packageName, records: recs };
}

module.exports = { createOpenxReleaseMock, testKeys, packageName, sha256, API, FILE_HOST };
