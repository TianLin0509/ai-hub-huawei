'use strict';
// r58：下载源标识——每个下载点按「文件名 + 内源版本名」查内源，界面显示 可用 / 部分 / 缺包 / 连不上。
const test = require('node:test');
const assert = require('node:assert/strict');
const openxSource = require('../core/app-update/openx-source');
const sourceStatus = require('../core/app-update/source-status');
const points = require('../core/app-update/download-points');
const view = require('../renderer/download-source-view');

const json = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), headers: { get: () => null } });
function fakeNet({ releases = [], down = false } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (down) throw new Error('getaddrinfo ENOTFOUND');
    if (url.includes('by_project_id')) return json({ code: '0', data: { records: releases.map(({ packages, ...r }) => r) } });
    const id = new URL(url).searchParams.get('id');
    const rel = releases.find(r => String(r.id) === id);
    return json({ code: '0', data: { binaryPackages: rel ? rel.packages : [] } });
  };
  return { fetchImpl, calls };
}
const FILE_SITE = require('../core/app-update/openx-config').fileSite;
const pkg = name => ({ originalFileName: name, url: new URL('x/' + name, FILE_SITE).href });
const env = { AI_HUB_OPENX: '1' };
const fresh = () => { openxSource._reset(); sourceStatus._reset(); };

test('内源有这个组件包：可用；版本名按 cli-<id>-<版本> 精确命中', async () => {
  fresh();
  const net = fakeNet({ releases: [{ id: 1, version: 'cli-codex-0.167.0', releaseTime: '2026-11-17', packages: [pkg('codex-0.167.0-win32-x64.tgz')] }] });
  const s = await sourceStatus.check({ items: [{ file: 'codex-0.167.0-win32-x64.tgz', release: 'cli-codex-0.167.0', version: '0.167.0' }] }, { fetchImpl: net.fetchImpl, env });
  assert.equal(s.status, 'ok');
  assert.match(s.text, /公司内源 · 可用/);
});

test('多文件组件只有一部分在内源：部分；全没有：缺包；连不上：连不上', async () => {
  fresh();
  const net = fakeNet({ releases: [{ id: 2, version: 'pet-role-1.1.0', releaseTime: '2026-11-17', packages: [pkg('05-rabbit-1.1.0.json')] }] });
  const items = ['05-rabbit-1.1.0.json', '07-shiba-1.1.0.json'].map(file => ({ file, release: 'pet-role-1.1.0', version: '1.1.0' }));
  const partial = await sourceStatus.check({ items }, { fetchImpl: net.fetchImpl, env });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.hit, 1);
  assert.equal(partial.total, 2);
  const missing = await sourceStatus.check({ items: [{ file: 'nope.zip', release: 'x-1' }] }, { fetchImpl: net.fetchImpl, env });
  assert.equal(missing.status, 'missing');
  assert.match(missing.text, /本次走阿里云/);
  fresh();
  const down = await sourceStatus.check({ items }, { fetchImpl: fakeNet({ down: true }).fetchImpl, env });
  assert.equal(down.status, 'down');
});

test('内源关掉、公司内部渠道：分别显示「已关闭」「公司官方」', async () => {
  fresh();
  assert.equal((await sourceStatus.check({ files: ['a'] }, { fetchImpl: async () => json({}), env: { AI_HUB_OPENX: '0' } })).status, 'off');
  const internal = await sourceStatus.check({ internal: 'CodeAgent 官方渠道' }, { fetchImpl: null, env });
  assert.equal(internal.status, 'internal');
  assert.ok(internal.ok);
  assert.match(internal.text, /不经阿里云/);
});

test('同一份结果 2 分钟内复用，不重复联网', async () => {
  fresh();
  const net = fakeNet({ releases: [{ id: 3, version: 'ocr-1.2.0', releaseTime: '2026-11-19', packages: [pkg('pptdoctor-ocr-1.2.0.zip')] }] });
  const spec = { items: [{ file: 'pptdoctor-ocr-1.2.0.zip', release: 'ocr-1.2.0', version: '1.2.0' }] };
  await sourceStatus.check(spec, { fetchImpl: net.fetchImpl, env });
  const n = net.calls.length;
  await sourceStatus.check(spec, { fetchImpl: net.fetchImpl, env });
  assert.equal(net.calls.length, n);
});

test('IPC：登记过的下载点按编号查；没登记的显示缺包（不假装可用）；前缀登记能命中', async () => {
  fresh();
  points._reset();
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const net = fakeNet({ releases: [{ id: 4, version: 'room-runtime-2.1.0', releaseTime: '2026-11-16', packages: [pkg('msz.exe')] }] });
  require('../main/download-source-ipc').registerDownloadSourceIpc(ipcMain, { fetchImpl: net.fetchImpl, env });
  points.register('room-runtime', async () => ({ items: [{ file: 'msz.exe', release: 'room-runtime-2.1.0' }] }));
  points.register('cli:', async point => ({ items: [{ file: point.slice(4) + '.tgz', release: 'cli-' + point.slice(4) + '-1' }] }));
  assert.equal((await handlers['download-source:status'](null, { point: 'room-runtime' })).status, 'ok');
  assert.equal((await handlers['download-source:status'](null, { point: 'cli:codex' })).status, 'missing');
  const none = await handlers['download-source:status'](null, { point: 'unknown-point' });
  assert.equal(none.status, 'missing');
  assert.match(none.reason, /还没登记/);
});

test('真实登记：静态下载点（会议室组件、本地转写、PPT 三项、CodeAgent、WeLink）都有登记', () => {
  points._reset();
  require('../main/download-points-register').registerStaticDownloadPoints({});
  for (const p of ['room-runtime', 'meeting-asr', 'ppt-doctor', 'ppt-ocr', 'ppt-materials', 'codeagent', 'welink']) assert.ok(points.lookup(p), p);
});

test('本地转写包按每个分片查内源；会议室组件按签名清单的文件名查', async () => {
  points._reset();
  require('../main/download-points-register').registerStaticDownloadPoints({});
  const asr = await points.lookup('meeting-asr')('meeting-asr');
  const pack = require('../core/company-assistant/meeting-speech-pack.json');
  assert.ok(asr.items.length >= pack.files.length);
  assert.ok(asr.items.every(i => i.release === 'meeting-asr-' + pack.version));
  assert.ok(asr.items.some(i => /\.000$/.test(i.file)));
  const room = await points.lookup('room-runtime')('room-runtime');
  assert.match(room.items[0].release, /^room-runtime-/);
});

test('界面：标识一行带「内源」字样与状态，编号写在 data 属性上', () => {
  view._known.clear();
  const slot = view.slotHtml('cli:codex');
  assert.match(slot, /data-dl-source="cli:codex"/);
  assert.match(slot, /内源 · 检查中/);
  assert.match(view.html({ status: 'ok', text: '公司内源 · 可用（优先从内源下载）' }), /内源 · 可用.*下载源：公司内源 · 可用/);
  assert.match(view.html({ status: 'missing', text: 'x' }), /内源 · 缺包/);
  view._known.set('cli:codex', { status: 'ok', text: '公司内源 · 可用' });
  assert.match(view.slotHtml('cli:codex'), /data-status="ok"/);
});

test('启动中心一键安装区块：点之前就带下载源标识，说明里写明内源优先', () => {
  view._known.clear();
  const cli = require('../renderer/cli-install-view');
  const html = cli.installBlockHtml('codex', { available: true, tools: { codex: { phase: 'idle' } }, catalog: [{ id: 'codex', bytes: 181015521 }] });
  assert.match(html, /data-dl-source="cli:codex"/);
  assert.match(html, /先从公司内源下载/);
});
