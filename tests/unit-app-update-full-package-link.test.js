'use strict';
// r27（2026-11-24，WeLink 2 人：老版本找不到更新途径）：内源最新版多半只有增量包，检查失败、增量装不上、本机太老时，
// 更新窗要给「下载完整安装包」，地址从内源版本列表里现找（最近一个带完整安装包、且比当前新的版本），不写死。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const openxSource = require('../core/app-update/openx-source.js');
const { createAppUpdateController } = require('../main/app-update-controller.js');

const env = { AI_HUB_OPENX: '1' };
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const SITE = new URL(require('../core/app-update/openx-config.js').fileSite).hostname;
const url = name => `https://file.${SITE}/openx-file/${name}`;
const pkg = name => ({ originalFileName: name, url: url(name) });
// 内源上的版本：最新两版只有增量包，12385 是最近的完整包；还有一个成员版和一个更早的完整包。
const RELEASES = [
  { id: 12401, version: 'v5.6.101', releaseTime: '2026-11-24 10:00:00', packages: [pkg('AIHubHuawei-update-5.6.101.zip'), pkg('latest.json')] },
  { id: 12399, version: 'v5.6.100', releaseTime: '2026-11-23 10:00:00', packages: [pkg('AIHubHuawei-update-5.6.100.zip')] },
  { id: 12390, version: 'member-v5.6.99', releaseTime: '2026-11-22 10:00:00', packages: [pkg('AIHubHuawei-Setup-5.6.99.exe')] },
  { id: 12385, version: 'v5.6.98 完整安装包', releaseTime: '2026-11-21 10:00:00', packages: [pkg('AIHubHuawei-Setup-5.6.98.exe'), pkg('AIHubHuawei-5.6.98-win-x64.zip')] },
  { id: 12001, version: 'v5.6.45 完整安装包', releaseTime: '2026-11-17 10:00:00', packages: [pkg('AIHubHuawei-Setup-5.6.45.exe')] },
];
function fakeOpenx({ releases = RELEASES, down = false } = {}) {
  const calls = [];
  const fetchImpl = async u => {
    u = String(u); calls.push(u);
    if (!u.includes(SITE)) return new Response('nf', { status: 404 });
    if (down) throw new Error(`getaddrinfo ENOTFOUND ${SITE}`);
    if (u.includes('by_project_id')) return json({ code: '0', data: { records: releases.map(({ packages, ...r }) => r) } });
    const m = /by_id\?id=(\w+)/.exec(u);
    if (m) return json({ code: '0', data: { binaryPackages: (releases.find(r => String(r.id) === m[1]) || {}).packages || [] } });
    return new Response('nf', { status: 404 });
  };
  return { fetchImpl, calls };
}

test.beforeEach(() => openxSource._reset());

test('最新几版只有增量包：跳过它们和成员版，找到最近的完整安装包（12385）', async () => {
  const { fetchImpl } = fakeOpenx();
  const r = await openxSource.findLatestFull({ fetchImpl, env, currentVersion: '5.6.20' });
  assert.equal(r.ok, true);
  assert.equal(r.releaseId, 12385);
  assert.equal(r.version, '5.6.98');
  assert.equal(r.file, 'AIHubHuawei-Setup-5.6.98.exe');
  assert.equal(r.url, url('AIHubHuawei-Setup-5.6.98.exe'));
  openxSource._reset();
  const zip = await openxSource.findLatestFull({ fetchImpl, env, currentVersion: '5.6.20', portable: true });
  assert.equal(zip.file, 'AIHubHuawei-5.6.98-win-x64.zip', '免安装版给免安装包');
});

test('不给比当前旧或同版的完整包；连不上、白名单外地址都不给', async () => {
  const { fetchImpl } = fakeOpenx();
  const same = await openxSource.findLatestFull({ fetchImpl, env, currentVersion: '5.6.98' });
  assert.equal(same.ok, false);
  openxSource._reset();
  const evil = fakeOpenx({ releases: [{ id: 1, version: 'v5.7.0', packages: [{ originalFileName: 'AIHubHuawei-Setup-5.7.0.exe', url: 'https://evil.example/AIHubHuawei-Setup-5.7.0.exe' }] }] });
  assert.equal((await openxSource.findLatestFull({ fetchImpl: evil.fetchImpl, env, currentVersion: '5.6.0' })).ok, false);
  openxSource._reset();
  const down = await openxSource.findLatestFull({ fetchImpl: fakeOpenx({ down: true }).fetchImpl, env, currentVersion: '5.6.0' });
  assert.equal(down.ok, false);
  assert.match(down.reason, /内源连不上/);
  assert.equal((await openxSource.findLatestFull({ fetchImpl, env: { AI_HUB_OPENX: '0' } })).ok, false, '内源关闭时不查');
});

test('检查更新失败（所有更新源都连不上）：后台补上内源完整包，界面拿到 fullPackage', async () => {
  const { fetchImpl } = fakeOpenx({ releases: RELEASES.filter(r => r.id !== 12401) });   // 没有 latest.json：内源清单兜底也读不到
  const sent = [];
  const c = createAppUpdateController({ app: { quit() {} }, config: { sources: [{ id: 'gh', name: 'GitHub', manifest: 'https://ext.example.invalid/latest.json', files: 'https://ext.example.invalid/v{version}/' }], releasePage: '' },
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'upd-full-link-')), currentVersion: '5.6.20', fetchImpl, isPackaged: false,
    env: { ...env, AI_HUB_UPDATE_RESOURCES: os.tmpdir() }, logger: { warn() {}, info() {} }, sendToRenderer: (_ch, s) => sent.push(s) });
  const s = await c.check({ silent: false });
  assert.equal(s.phase, 'none');   // 2026-11-25：内源连得上、只是没清单 → 平静显示「暂无可安装的新版本」，仍补完整包
  assert.equal(s.pending, true);
  for (let i = 0; i < 50 && !c.getState().fullPackage; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(c.getState().fullPackage, { url: url('AIHubHuawei-Setup-5.6.98.exe'), file: 'AIHubHuawei-Setup-5.6.98.exe', version: '5.6.98', releaseId: 12385 });
  assert.ok(sent.some(v => v.fullPackage && v.phase === 'none' && v.pending), '推给界面');
  c.dispose();
});

test('界面：没有版本信息时用内源完整包直接开浏览器；失败页有一行说明；要完整包的版本也给手动下载按钮', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');
  assert.match(src, /if \(!state\?\.latest && fullPackageUrl\(\)\) return \{ url: fullPackageUrl\(\)/);
  assert.match(src, /if \(direct && direct\.direct\) \{ shell\.openExternal\(direct\.url\); return true; \}/);
  assert.match(src, /body \+= fullPackageLine\(\);/);
  assert.match(src, /plan\.portable \|\| plan\.protectedDir \|\| plan\.kind === 'full'\)\) \? manualDownload\(\)/);
});
