'use strict';
// R29（2026-11-24 用户定）：AI HUB-H 下载与更新只走公司内源。
// 组件与程序包只从内源下、外网地址一次都不碰；内源连不上 / 没有包时提示写清原因与下一步；界面与英文词典里不再出现阿里云 / GitHub。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } });
const openxConfig = require('../core/app-update/openx-config');
const openxSource = require('../core/app-update/openx-source');
const { downloadWithFallback } = require('../core/app-update/downloader');
const sourceStatus = require('../core/app-update/source-status');
const signing = require('../core/app-update/manifest-signing');
const { createAppUpdateController } = require('../main/app-update-controller');

const ROOT = path.join(__dirname, '..');
const API = openxSource.DEFAULT_API;
const FILE_HOST = new URL('files/', openxConfig.fileSite).href;
const ELECTRON = { electron: '41.2.0' };
const ENV = { AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '1' };
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
// 自家下载服务器的主域名从发行配置里取（不在测试里写死域名）。
const OWN_HOSTS = (() => {
  try { return [...new Set((require('../community-edition.json').update?.sources || []).map(s => new URL(s.manifest).hostname.split('.').slice(-2).join('.')))]; } catch (_) { return []; }
})();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_RE = OWN_HOSTS.length ? new RegExp(OWN_HOSTS.map(escRe).join('|'), 'i') : /$^/;
const EXTERNAL = new RegExp(['github', 'aliyun', 'example\\.invalid', ...OWN_HOSTS.map(escRe)].join('|'), 'i');
// 老用户手上的发行配置：GitHub + 阿里云高速 + 阿里云，外加 GitHub 发布页。
const OLD_SOURCES = [
  { id: 'github', name: 'GitHub', manifest: 'https://github.com/x/y/releases/latest/download/latest.json', files: 'https://github.com/x/y/releases/download/v{version}/' },
  { id: 'aliyun-fast', name: '阿里云高速', mirror: true, manifest: 'https://dl.example.invalid/latest.json', files: 'https://dl.example.invalid/v{version}/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.example.invalid/latest.json', files: 'https://me.example.invalid/v{version}/' }];

test.beforeEach(() => { openxSource._reset(); sourceStatus._reset(); });

test('配置：内源是唯一通道；排查开关、测试注入的本机源、内源关闭时才不生效', () => {
  assert.equal(openxConfig.onlyChannel, true);
  assert.equal(openxSource.onlyChannel({}, ELECTRON), true, 'Hub 程序里默认只走内源');
  assert.equal(openxSource.onlyChannel({}, {}), false, '纯 Node（内源未启用）不生效');
  assert.equal(openxSource.onlyChannel({ AI_HUB_OPENX: '0' }, ELECTRON), false, '内源关掉时不生效');
  assert.equal(openxSource.onlyChannel({ AI_HUB_OPENX_ONLY: '0' }, ELECTRON), false);
  assert.equal(openxSource.onlyChannel({ AI_HUB_UPDATE_SOURCES: '[]' }, ELECTRON), false, '测试把源换成本机服务时按测试给的源');
  assert.equal(openxSource.onlyChannel({ AI_HUB_OPENX: '1', AI_HUB_OPENX_ONLY: '1' }, {}), true);
});

function payload() {
  const body = Buffer.from('r29-component-bytes');
  return { body, expect: { file: 'comp-1.0.0.zip', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') } };
}
function openxNet({ down = false, has = true, body } = {}) {
  const urls = [];
  const fetchImpl = async url => {
    url = String(url); urls.push(url);
    if (EXTERNAL.test(url)) throw new Error('不应访问外网源：' + url);
    if (down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (url.startsWith(API + 'by_project_id')) return json({ code: '0', data: { records: [{ id: 1, version: 'comp-1.0.0', releaseTime: '2026-11-24 09:00:00' }] } });
    if (url.startsWith(API + 'by_id')) return json({ code: '0', data: { binaryPackages: has ? [{ originalFileName: 'comp-1.0.0.zip', url: FILE_HOST + 'comp-1.0.0.zip' }] : [] } });
    if (url === FILE_HOST + 'comp-1.0.0.zip') return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, urls };
}
const tmpDest = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r29-')), name);

test('组件下载：只从内源下，调用方给的阿里云 / GitHub 地址一次都不碰', async () => {
  const { body, expect } = payload();
  const net = openxNet({ body });
  const r = await downloadWithFallback({ sources: OLD_SOURCES, version: '1.0.0', expect, dest: tmpDest(expect.file), fetchImpl: net.fetchImpl, openx: { env: ENV, release: 'comp-1.0.0' } });
  assert.equal(r.ok, true);
  assert.equal(r.source.id, 'openx');
  assert.equal(r.openxOnly, true);
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)));
});

test('内源上没有这个包：不退到外网，唯一一条记录写明「内源上暂时没有」和下一步', async () => {
  const { body, expect } = payload();
  const net = openxNet({ body, has: false });
  const r = await downloadWithFallback({ sources: OLD_SOURCES, version: '1.0.0', expect, dest: tmpDest(expect.file), fetchImpl: net.fetchImpl, openx: { env: ENV } });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].id, 'openx');
  assert.match(r.attempts[0].reason, /公司内源上暂时没有「comp-1\.0\.0\.zip」/);
  assert.match(r.attempts[0].reason, /一键反馈/);
  assert.doesNotMatch(r.attempts[0].reason, /阿里云|GitHub|别处|发布页/);
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)));
});

test('内源连不上：提示检查公司网络；再点一次会真的重连（不吃「5 分钟内不再试」）', async () => {
  const { body, expect } = payload();
  const down = openxNet({ down: true, body });
  const r = await downloadWithFallback({ sources: OLD_SOURCES, version: '1.0.0', expect, dest: tmpDest(expect.file), fetchImpl: down.fetchImpl, openx: { env: ENV } });
  assert.equal(r.ok, false);
  assert.match(r.attempts[0].reason, /连不上公司内源/);
  assert.match(r.attempts[0].reason, /请确认电脑连着公司网络（公司内网或 VPN）后重试/);
  assert.equal(openxSource.reachability(), 'down');
  const up = openxNet({ body });
  const again = await downloadWithFallback({ sources: OLD_SOURCES, version: '1.0.0', expect, dest: tmpDest(expect.file), fetchImpl: up.fetchImpl, openx: { env: ENV } });
  assert.equal(again.ok, true, '网络恢复后重试立刻成功');
});

test('下载源标识：只走内源时只讲内源本身，不出现「本次走某某」', () => {
  for (const status of ['ok', 'partial', 'missing', 'down', 'off', 'internal', 'nolist']) {
    const v = sourceStatus.view(status, { env: ENV, reason: '内源连不上：超时没响应', hit: 1, total: 2, internalName: '公司内部 npm 源' });
    assert.equal(v.env, undefined, '不把环境变量带进界面');
    assert.doesNotMatch(v.text, /阿里云|GitHub|本次走|备用/, `${status}: ${v.text}`);
  }
  assert.match(sourceStatus.view('down', { env: ENV, reason: '超时没响应' }).text, /请确认电脑连着公司网络/);
  assert.equal(sourceStatus.resultText({ ok: false, openxOnly: true }), '');
});

test('失败原因翻成人话：连不上 / 没有包 / 校验没过 / 已关闭', () => {
  assert.match(openxSource.userReason('内源连不上：超时没响应（5 分钟内自动重试）'), /^连不上公司内源（超时没响应）。请确认/);
  assert.match(openxSource.userReason('内源上没有这个文件', { file: 'a.zip' }), /公司内源上暂时没有「a\.zip」/);
  assert.match(openxSource.userReason('内源下载失败：源上没有这个文件（HTTP 404）'), /公司内源上暂时没有这个包/);
  assert.match(openxSource.userReason('内源下载失败：文件校验不一致'), /校验没通过/);
  assert.match(openxSource.userReason('未启用'), /AI_HUB_OPENX=0/);
  assert.equal(openxSource.userReason('已取消'), '已取消');
});

// ---------- 程序更新（控制器） ----------
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const appManifest = version => ({ schema: 1, product: 'x', version, notes: [], runtime: { electron: '41.2.0', native: { 'node-pty': '1.2.0-beta.13' } },
  incremental: { file: `AIHubX-${version}-update.gz`, bytes: 14000, sha256: 'a'.repeat(64) },
  installer: { file: `AIHubX-Setup-${version}.exe`, bytes: 50000, sha256: 'b'.repeat(64) } });
function appNet({ down = false, top = '5.6.80' } = {}) {
  const raw = JSON.stringify(appManifest(top), null, 2) + '\n';
  const urls = [];
  const fetchImpl = async url => {
    url = String(url); urls.push(url);
    if (EXTERNAL.test(url)) throw new Error('不应访问外网源：' + url);
    if (down) throw new Error('fetch failed');
    if (url.startsWith(API + 'by_project_id')) return json({ code: '0', data: { records: [{ id: 2, version: `v${top}`, releaseTime: '2026-11-24 09:00:00' }] } });
    if (url.startsWith(API + 'by_id')) return json({ code: '0', data: { binaryPackages: [
      { originalFileName: 'latest.json', url: FILE_HOST + 'latest.json' }, { originalFileName: 'latest.json.sig', url: FILE_HOST + 'latest.json.sig' },
      { originalFileName: `AIHubX-${top}-update.gz`, url: FILE_HOST + 'u.gz' }] } });
    if (url === FILE_HOST + 'latest.json') return new Response(raw, { status: 200 });
    if (url === FILE_HOST + 'latest.json.sig') return new Response(signing.signManifest(raw, PEM), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, urls };
}
function makeController(fetchImpl, { preview = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r29-update-'));
  // 老用户开过抢先版：本机留着 preview-updates.json。
  if (preview) require('../core/app-update/canary').write(dataDir, { enabled: true });
  return createAppUpdateController({ app: { quit() {} }, config: { sources: OLD_SOURCES, releasePage: 'https://github.com/x/y/releases' }, dataDir,
    currentVersion: '5.6.72', fetchImpl, isPackaged: false, logger: { warn() {}, info() {} }, manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: os.tmpdir(), AI_HUB_UPDATE_FORCE_APPLY: '1' } });
}

test('老配置迁移：外网更新源、GitHub 发布页、抢先版开关都不再使用，界面状态里也没有', () => {
  const c = makeController(appNet().fetchImpl, { preview: true });
  const s = c.getState();
  assert.deepEqual(s.sources, []);
  assert.equal(s.releasePage, '');
  assert.equal(s.openxOnly, true);
  assert.equal(s.previewSupported, false);
  assert.equal(s.previewEnabled, false, '老用户开过的抢先版按关处理，不报错');
  assert.doesNotThrow(() => c.setPreviewEnabled(true));
  assert.equal(c.getState().previewEnabled, false);
  assert.doesNotMatch(JSON.stringify(c.getState()), /阿里云|GitHub|github\.com|example\.invalid/);
});

test('检查更新：只读内源上的签名清单，外网清单一次都不请求', async () => {
  const net = appNet();
  const c = makeController(net.fetchImpl);
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'available', s.error || '');
  assert.equal(s.latest.version, '5.6.80');
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)));
  assert.doesNotMatch(JSON.stringify(s.checks), /阿里云|GitHub/);
});

test('内源连不上：检查更新报「连不上公司内源 + 检查公司网络」，不提发布页或别的源', async () => {
  const c = makeController(appNet({ down: true }).fetchImpl);
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /^查不到新版本：连不上公司内源/);
  assert.match(s.error, /请确认电脑连着公司网络/);
  assert.doesNotMatch(s.error, /阿里云|GitHub|发布页|所有更新源/);
});

test('下载更新包：只走内源；内源没有这个包时报原因，不提发布页', async () => {
  const net = appNet();
  const c = makeController(net.fetchImpl);
  await c.check({ silent: false, quietAllowed: false });
  await c.download();
  const s = c.getState();
  assert.equal(s.phase, 'error');
  assert.match(s.error, /^更新包下载没有完成：/);
  assert.doesNotMatch(s.error, /阿里云|GitHub|发布页|所有下载源/);
  assert.ok(s.attempts.every(a => a.id === 'openx'));
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)));
});

test('版本选择：内源上没有版本列表时说清楚，不去外网读', async () => {
  const net = appNet();
  const c = makeController(net.fetchImpl);
  const r = await c.listVersions();
  assert.equal(r.ok, false);
  assert.match(r.error, /公司内源上还没有版本列表/);
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)));
});

test('PPT Doctor 浏览器下载入口：只走内源时拒绝，指向一键安装', async () => {
  const { downloadDoctor } = require('../core/company-assistant/ppt-doctor-download');
  await assert.rejects(downloadDoctor('mirror', { env: ENV }), /只从公司内源安装/);
  await assert.rejects(downloadDoctor('github', { env: ENV }), /只从公司内源安装/);
});

// ---------- 静态扫描：界面与英文词典 ----------
// 与下载无关、这次不动的（负责人另判）：语音 / 模型套餐（阿里云百炼、Token Plan）、阿里云服务器监控设置、阿里云控制台账号、
// GitHub CLI 账号授权、一键反馈与晴雨表的收件服务器、开源动画的署名、非公司版的安装指南链接、自家主机放行小窗的注释。
const ALLOW = [
  /阿里云百炼|阿里云套餐|阿里云 Token Plan|Token Plan/,
  /阿里云服务器|阿里云 \/ 自建健康端点|cfg-aliyun|aliyunMonitor/,
  /阿里云控制台|aliyunConsole/,
  /GitHub CLI|授权 GitHub|github:\s*'work'|githubDevice/,
  /x\.via === 'aliyun'|（阿里云）|写回阿里云|晴雨表/,
  /github\.com\/wynneceles|ai-boot-animations/,
  /\/blob\/main\/INSTALL\.md'/,
];
function stripComments(src) {
  // 去掉 /* */ 与整行或行尾的 // 注释（不碰字符串里的 https://）。
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}
function renderFiles(dir = path.join(ROOT, 'renderer'), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'assets', 'node_modules'].includes(e.name)) renderFiles(p, out); }
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('静态扫描：界面代码里不再出现阿里云 / GitHub（与下载无关的已登记项除外）', () => {
  const hits = [];
  for (const file of renderFiles()) {
    stripComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if ((/阿里云|GitHub|github\.com/.test(line) || OWN_RE.test(line)) &&!ALLOW.some(re => re.test(line))) hits.push(`${path.relative(ROOT, file)}:${i + 1} ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('静态扫描：英文词典里与下载相关的「Alibaba Cloud / GitHub」译文已去掉', () => {
  const dir = path.join(ROOT, 'core/i18n/locales/en');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    for (const [zh, en] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) {
      if (/阿里云|GitHub/i.test(zh + ' ' + en) || /Alibaba Cloud|GitHub/i.test(en)) {
        if (!ALLOW.some(re => re.test(zh))) hits.push(`${f}: ${zh}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

// ---------- 组件：目录用随程序发布的快照，不去外网读 ----------
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const recorder = () => { const urls = []; return { urls, fetchImpl: async url => { urls.push(String(url)); throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } }; };

test('命令行组件：只走内源时直接用自带的签名目录，一次外网目录都不读', async () => {
  const { createCliInstaller } = require('../core/cli-tools/installer');
  const net = recorder();
  const inst = createCliInstaller({ sources: OLD_SOURCES.slice(1), fetchImpl: net.fetchImpl, env: { ...ENV, LOCALAPPDATA: os.tmpdir() } });
  const cat = await withEnv(ENV, () => inst.loadCatalog());
  assert.ok(cat.components.some(c => c.id === 'codex'));
  assert.equal(inst.snapshot().catalogNote || '', '', '不再写「在线下载源读不到」');
  assert.deepEqual(net.urls, []);
});

test('PPT Doctor：只用自带清单；内源连不上时报「检查公司网络」，不去外网量大小、不从外网下', async () => {
  const { createDoctorInstaller } = require('../core/company-assistant/ppt-doctor-install');
  const net = recorder();
  let downloaded = false;
  const inst = createDoctorInstaller({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r29-doctor-')),
    sources: ['https://dl.example.invalid/pptutor/manifest.json'], fetchImpl: net.fetchImpl,
    download: async () => { downloaded = true; return { ok: false, attempts: [] }; }, configure: async () => {} });
  const thrown = await withEnv(ENV, () => inst.install().then(() => null, e => e));
  const message = thrown ? thrown.message : String(inst.snapshot().error || '');
  assert.equal(thrown ? 'error' : inst.snapshot().phase, 'error');
  assert.match(message, /连不上公司内源/);
  assert.match(message, /公司网络/);
  assert.doesNotMatch(message, /阿里云|GitHub|镜像/);
  assert.equal(downloaded, false);
  assert.ok(!net.urls.some(u => EXTERNAL.test(u)), net.urls.join('\n'));
});

test('团队素材包：只走内源时清单用自带快照，不去外网读', async () => {
  const { teamPackManifest, bundledTeamManifest } = require('../core/company-assistant/ppt-materials');
  const net = recorder();
  const r = await teamPackManifest({ pptDownloadFetch: net.fetchImpl, openx: { env: ENV } });
  assert.equal(r.bundled, true);
  assert.equal(r.manifest.version, bundledTeamManifest().version);
  assert.deepEqual(net.urls, []);
});

// ---------- R29 审查返工（2026-11-24）----------
test('外观包 / 桌宠 / 开场动画：只走内源时读自带目录快照，不读外网目录；下载失败带上内源给的原因', async () => {
  const cases = [
    ['外观包', () => require('../core/appearance-packs').createAppearanceStore, d => ({ dataDir: d })],
    ['桌宠', () => require('../core/hub-pet/role-packs').createRolePackStore, d => ({ dataDir: d, assetsDir: path.join(ROOT, 'renderer/assets/hub-pet'), logger: { warn() {} } })],
    ['开场动画', () => require('../core/boot-splash').createBootSplashStore, d => ({ dataDir: d })],
  ];
  for (const [label, factory, opts] of cases) {
    openxSource._reset();
    const net = recorder();
    const store = factory()({ ...opts(fs.mkdtempSync(path.join(os.tmpdir(), 'r29-cat-'))), fetchImpl: net.fetchImpl, env: ENV });
    await withEnv(ENV, () => store.check());
    const snap = store.snapshot();
    const catalog = snap.catalog || store.catalog;
    assert.ok(catalog && catalog.packs.length > 0, label + '：目录来自自带快照');
    assert.deepEqual(net.urls, [], label + '：没有请求外网目录');
    await withEnv(ENV, () => store.download(catalog.packs[0].id));
    const after = store.snapshot().state || store.snapshot();
    assert.equal(after.phase, 'error', label);
    assert.match(after.error, /连不上公司内源/, label + '：错误里带上内源给的原因');
    assert.match(after.error, /公司网络/, label);
    assert.ok(!net.urls.some(u => EXTERNAL.test(u)), label + '：' + net.urls.join('\n'));
  }
});

test('PPT 识别组件：只走内源时清单用自带快照，不读外网', async () => {
  const ocr = require('../core/company-assistant/ppt-ocr-component');
  const net = recorder();
  const r = await ocr.fetchManifest(net.fetchImpl, { env: ENV });
  assert.equal(r.manifest.version, ocr.bundledManifest().manifest.version);
  assert.ok(Object.keys(r.manifest.files).length > 0, '快照保留逐文件校验值');
  assert.deepEqual(net.urls, []);
});

test('发版脚本会刷新 4 类新快照，且快照文件都在、能通过各自的校验', () => {
  const refresh = require('../scripts/refresh-bundled-manifests');
  const checks = [[refresh.APPEARANCE_FILE, require('../core/appearance-packs').validateCatalog], [refresh.PET_FILE, require('../core/hub-pet/role-packs').validateCatalog],
    [refresh.BOOT_SPLASH_FILE, require('../core/boot-splash').validateCatalog], [refresh.OCR_FILE, require('../core/company-assistant/ppt-ocr-component').validManifest]];
  for (const [file, validate] of checks) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotThrow(() => validate(JSON.parse(raw)), file);
    assert.doesNotMatch(raw, /阿里云|github\.com/i, file);
    if (OWN_HOSTS.length) assert.doesNotMatch(raw, OWN_RE, file);
  }
});

test('清单没签名 / 签名不对 / 版本对不上：提示不叫用户查网络，并说明下一步', () => {
  for (const raw of ['内源 v5.6.80 的版本清单没有签名，不采用', '内源 v5.6.80 的版本清单签名不对，不采用', '内源 v5.6.80 附带的清单写的是 v5.6.99，不采用']) {
    const t = openxSource.userReason(raw);
    assert.doesNotMatch(t, /公司网络|VPN|连不上/, raw);
    assert.match(t, /稍后再试|一键反馈/, raw);
  }
  const { sourceText } = require('../core/app-update/source-view');
  const row = { id: 'openx-manifest', ok: false, reason: '内源 v5.6.80 的版本清单没有签名，不采用' };
  assert.doesNotMatch(sourceText(row), /连不上/, '不和上一行「可用」打架');
  assert.match(sourceText({ ok: false, reason: '内源连不上：fetch failed' }), /^连不上：/);
});

// 内源两版：top（可配置有无签名）和 older（签名有效）。
function twoReleaseNet({ topSigned = false, top = '5.6.80', older = '5.6.78' } = {}) {
  const rawOf = v => JSON.stringify(appManifest(v), null, 2) + '\n';
  const urls = [];
  const fetchImpl = async url => {
    url = String(url); urls.push(url);
    if (EXTERNAL.test(url)) throw new Error('不应访问外网源：' + url);
    if (url.startsWith(API + 'by_project_id')) return json({ code: '0', data: { records: [
      { id: 2, version: `v${top}`, releaseTime: '2026-11-24 09:00:00' }, { id: 1, version: `v${older}`, releaseTime: '2026-11-23 09:00:00' }] } });
    const pk = (id, v, signed) => [{ originalFileName: 'latest.json', url: FILE_HOST + `${id}-latest.json` },
      ...(signed ? [{ originalFileName: 'latest.json.sig', url: FILE_HOST + `${id}-latest.json.sig` }] : []), { originalFileName: `AIHubX-${v}-update.gz`, url: FILE_HOST + `${id}.gz` }];
    if (url.startsWith(API + 'by_id?id=2')) return json({ code: '0', data: { binaryPackages: pk(2, top, topSigned) } });
    if (url.startsWith(API + 'by_id?id=1')) return json({ code: '0', data: { binaryPackages: pk(1, older, true) } });
    for (const [id, v] of [[2, top], [1, older]]) {
      if (url === FILE_HOST + `${id}-latest.json`) return new Response(rawOf(v), { status: 200 });
      if (url === FILE_HOST + `${id}-latest.json.sig`) return new Response(signing.signManifest(rawOf(v), PEM), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, urls };
}

test('最新一版还没传签名（发版中途）：退到上一版有效签名的清单，不报错', async () => {
  const c = makeController(twoReleaseNet().fetchImpl);
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'available', s.error || '');
  assert.equal(s.latest.version, '5.6.78');
});

test('内源上有效清单比本机还旧：显示「已是最新」，不报红字', async () => {
  const c = makeController(twoReleaseNet({ topSigned: true, top: '5.6.71', older: '5.6.70' }).fetchImpl);
  await c.check({ silent: false, quietAllowed: false });
  const s = c.getState();
  assert.equal(s.phase, 'none', s.error || '');
  assert.equal(s.error, null);
  const row = s.checks.find(r => r.id === 'openx-manifest');
  assert.equal(row.ok, true);
  assert.equal(row.version, '5.6.71');
  const probe = await c.probeSources({ timeoutMs: 5000 });
  assert.equal(probe.only, true);
  assert.ok(probe.sources.some(x => x.id === 'openx-manifest' && x.ok));
});

test('放行：只走内源时主进程不再把下载服务器交给放行 / 心跳，首次准备页校时改用内源；界面不再探测', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /hosts: openxOnly \? \[\] : ownHosts\.downloadHosts\(ownConfig\)/);
  assert.match(main, /if \(!openxOnly && autoUnblock && /);
  assert.match(fs.readFileSync(path.join(ROOT, 'main/ipc/first-run-handlers.js'), 'utf8'), /onlyChannel\(\) \? require\('\.\.\/\.\.\/core\/app-update\/openx-config'\)\.fileSite/);
  for (const f of ['renderer/app-update.js', 'renderer/company-api-settings.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const line of src.split(/\r?\n/).filter(l => l.includes("invoke('net-pass:status'"))) assert.match(line, /openxOnly/, f + '：' + line.trim());
  }
  const { createNetPass } = require('../core/net-pass');
  assert.equal(createNetPass({ hosts: [], fetchImpl: recorder().fetchImpl }).status().available, false, '没有下载服务器时底栏不显示放行');
});

test('环境体检：只走内源且内源读不到时，说内源和公司网络，不提「所有下载源」或放行', async () => {
  const { probeList } = require('../core/env-check');
  const c = makeController(appNet({ down: true }).fetchImpl);
  const probe = probeList({ appUpdate: () => c }).find(p => p.id === 'app-update');
  const item = await probe.run();
  assert.equal(item.status, 'bad');
  assert.match(item.detail, /公司内源/);
  assert.match(item.cause || '', /公司网络/);
  assert.doesNotMatch(JSON.stringify({ d: item.detail, c: item.cause, s: item.steps }), /所有下载源|放行/);
});
