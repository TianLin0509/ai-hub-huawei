'use strict';
// 查到新版后发布源又发了一版：点下载遇到全部 404 时，自动重查清单并换到新版本。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: { 'node-pty': '1.1.0' } });
const { createAppUpdateController } = require('../main/app-update-controller.js');

const manifest = version => ({ schema: 1, product: 'x', version, notes: [], runtime: { electron: '41.2.0', native: { 'node-pty': '1.1.0' } },
  incremental: { file: `AIHubX-${version}-update.gz`, bytes: 14000, sha256: 'a'.repeat(64) },
  installer: { file: `AIHubX-Setup-${version}.exe`, bytes: 50000, sha256: 'b'.repeat(64) } });
const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' };
const resp404 = () => ({ ok: false, status: 404, headers: { get: () => '' }, text: async () => 'not found', body: { cancel: async () => {} } });
const respJson = obj => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj) });
function make(fetchImpl) {
  return createAppUpdateController({ app: { quit() {} }, config: { sources: [SRC], releasePage: '' }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'upd-stale-')),
    currentVersion: '5.5.0', fetchImpl, isPackaged: false, env: { AI_HUB_UPDATE_RESOURCES: os.tmpdir(), AI_HUB_UPDATE_FORCE_APPLY: '1' }, logger: { warn() {} } });
}

test('旧清单下载全部 404：自动重查并改下新版本', async () => {
  let latest = '5.5.13'; const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); if (url.endsWith('latest.json')) return respJson(manifest(latest)); return resp404(); });
  await c.check({ silent: true, quietAllowed: false });
  assert.equal(c.getState().latest.version, '5.5.13');
  assert.equal(c.view().plan.kind, 'incremental');
  assert.deepEqual(c.view().latest.installer, manifest('5.5.13').installer);
  latest = '5.5.14'; urls.length = 0;
  await c.download();
  const s = c.getState();
  assert.ok(urls.some(u => u.endsWith('latest.json')), '重新取了清单');
  assert.equal(s.latest.version, '5.5.14');
  assert.ok(urls.some(u => u.includes('5.5.14')), '改下新版本');
  assert.equal(s.phase, 'error'); // 替身源上新版文件也是 404，只重试一次，不循环
  assert.deepEqual(c.view().latest.installer, manifest('5.5.14').installer);
  assert.equal(urls.filter(u => u.endsWith('latest.json')).length, 1);
});

test('重查后版本没变：照旧报错，不循环', async () => {
  const urls = [];
  const c = make(async url => { url = String(url); urls.push(url); if (url.endsWith('latest.json')) return respJson(manifest('5.5.13')); return resp404(); });
  await c.check({ silent: true, quietAllowed: false });
  await c.download();
  assert.equal(c.getState().phase, 'error');
  assert.match(c.getState().error, /所有下载源都失败了/);
  assert.equal(urls.filter(u => u.endsWith('latest.json')).length, 2); // 首次检查 + 一次重查
});
