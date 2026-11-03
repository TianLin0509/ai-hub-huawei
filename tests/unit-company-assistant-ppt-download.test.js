'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { downloadDoctor } = require('../core/company-assistant/ppt-doctor-download');
const response = (body, status = 200, type = 'application/json') => ({ ok: status === 200, status, headers: { get: key => key === 'content-type' ? type : null }, text: async () => JSON.stringify(body) });
test('下载默认解析镜像清单并核对同源整包，GitHub只在用户选择备用时打开', async () => {
  const fetched = [], opened = [], deps = { pptDownloadFetch: async (url, options) => { fetched.push({ url, method: options.method }); return response({ version: '2.0.6' }); }, pptOpenExternal: async url => opened.push(url) };
  const result = await downloadDoctor(undefined, deps);
  assert.equal(fetched[0].url, 'https://me.lt-stockpartner.tech/pptutor/manifest.json'); assert.equal(fetched[1].method, 'HEAD');
  assert.equal(result.url, 'https://me.lt-stockpartner.tech/pptutor/PPT-Doctor-v2.0.6.zip'); assert.deepEqual(opened, [result.url]);
  await downloadDoctor('github', deps); assert.equal(fetched.length, 2); assert.equal(opened[1], 'https://github.com/TianLin0509/PPTutor/releases/latest');
});

test('full字段可指定现存最新或基线整包，不把增量版本当成整包版本', async () => {
  for (const version of ['2.0.6', '2.0.5']) {
    const opened = [], fetched = [];
    const result = await downloadDoctor('mirror', { pptOpenExternal: async url => opened.push(url), pptDownloadFetch: async (url, options) => {
      fetched.push(url); return options.method === 'HEAD' ? response({}, 200, 'application/zip') : response({ version: '2.0.6', full: { version, path: `PPT-Doctor-v${version}.zip` } });
    } });
    assert.equal(result.url, `https://me.lt-stockpartner.tech/pptutor/PPT-Doctor-v${version}.zip`);
    assert.deepEqual(opened, [result.url]); assert.equal(fetched.length, 2);
  }
});

test('full字段拒绝坏版本、外域与目录穿越，不静默下载其他包', async () => {
  const fulls = [null, 'PPT-Doctor.zip', {}, { version: '../2', path: 'PPT-Doctor.zip' },
    ...['https://example.com/PPT.zip', '//example.com/PPT.zip', '../PPT.zip', '%2e%2e/PPT.zip', 'nested/../../PPT.zip', 'PPT.zip?x=1', 'PPT.html', '/pptutor/PPT.zip', 'PPT\\other.zip', 'PPT.zip#x'].map(path => ({ version: '2.0.5', path }))];
  let opened = 0;
  for (const full of fulls) await assert.rejects(downloadDoctor('mirror', { pptOpenExternal: async () => { opened++; }, pptDownloadFetch: async () => response({ version: '2.0.6', full }) }), /GitHub 备用/);
  assert.equal(opened, 0);
});
test('镜像清单异常、安装包缺失或代理拦截页均不打开错误地址', async () => {
  let opened = 0;
  for (const mode of ['bad-version', 'no-archive', 'html']) {
    await assert.rejects(downloadDoctor('mirror', { pptOpenExternal: async () => { opened++; }, pptDownloadFetch: async (_url, options) => options.method === 'HEAD'
      ? response({}, mode === 'no-archive' ? 404 : 200, mode === 'html' ? 'text/html' : 'application/zip')
      : response({ version: mode === 'bad-version' ? '../../other' : '2.0.6' }) }), /GitHub 备用/);
  }
  assert.equal(opened, 0);
});
