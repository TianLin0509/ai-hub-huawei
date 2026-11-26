'use strict';
// PPT Doctor 完整包地址解析（archiveUrl）：一键安装按清单里的 full 字段定位完整包。浏览器手动下载入口（镜像 / GitHub）已随下载源废弃删除（R35）。
const test = require('node:test'), assert = require('node:assert/strict');
const { archiveUrl } = require('../core/company-assistant/ppt-doctor-download');
const BASE = 'https://dl.example.invalid/pptutor/manifest.json';

test('没有 full 字段时按版本号拼完整包名', () => {
  assert.equal(archiveUrl({ version: '2.0.6' }, BASE), 'https://dl.example.invalid/pptutor/PPT-Doctor-v2.0.6.zip');
});

test('full字段可指定现存最新或基线整包，不把增量版本当成整包版本', () => {
  for (const version of ['2.0.6', '2.0.5']) {
    assert.equal(archiveUrl({ version: '2.0.6', full: { version, path: `PPT-Doctor-v${version}.zip` } }, BASE), `https://dl.example.invalid/pptutor/PPT-Doctor-v${version}.zip`);
  }
});

test('full字段拒绝坏版本、外域与目录穿越', () => {
  const fulls = [null, 'PPT-Doctor.zip', {}, { version: '../2', path: 'PPT-Doctor.zip' },
    ...['https://example.com/PPT.zip', '//example.com/PPT.zip', '../PPT.zip', '%2e%2e/PPT.zip', 'nested/../../PPT.zip', 'PPT.zip?x=1', 'PPT.html', '/pptutor/PPT.zip', `PPT${String.fromCharCode(92)}other.zip`, 'PPT.zip#x'].map(path => ({ version: '2.0.5', path }))];
  for (const full of fulls) assert.throws(() => archiveUrl({ version: '2.0.6', full }, BASE));
});
