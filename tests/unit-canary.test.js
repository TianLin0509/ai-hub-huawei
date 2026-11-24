const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// R35：抢先版与金丝雀体检随下载源精简删掉；这里只留体检与考勤共用的页面探测（core/app-update/canary-network.js）。
const { probePage, attendanceFetch } = require('../core/app-update/canary-network');

test('登录跳转与 HIS 拦截标为失败，正常页面通过，URL 查询凭据不入指纹', async () => {
  for (const [html, url, status] of [['ok', 'https://example.invalid/page?token=secret', 'ok'], ['Sign in', 'https://example.invalid/login?code=secret', 'bad'], ['<title>HIS Proxy Notification</title>', 'https://example.invalid/blocked', 'bad']]) {
    const response = new Response(html); Object.defineProperty(response, 'url', { value: url });
    const r = await probePage('https://example.invalid/', { fetchImpl: async () => response });
    assert.equal(r.status, status); assert.equal(JSON.stringify(r.fingerprint).includes('secret'), false);
  }
});
test('P1-1 普通 this/history 与小写 his 不会误认成代理拦截页', async () => {
  for (const html of ['this.history.pushState();', '<h1>History</h1>', '<title>his proxy notification</title>']) {
    const response = new Response(html);
    const r = await probePage('https://example.invalid/attendance', { fetchImpl: async () => response });
    assert.equal(r.status, 'ok'); assert.equal(r.fingerprint.blocked, false);
  }
});
test('P1-1 正文登录提示不算跳转，只按最终登录地址判断', async () => {
  for (const [url, login] of [['https://example.invalid/attendance?next=/login', false], ['https://example.invalid/sso/login?code=secret', true], ['https://login.example.invalid/start', true]]) {
    const response = new Response('最近登录记录，登录状态正常，sign in history'); Object.defineProperty(response, 'url', { value: url });
    const r = await probePage('https://example.invalid/attendance', { fetchImpl: async () => response });
    assert.equal(r.fingerprint.login, login); assert.equal(r.status, login ? 'bad' : 'ok');
  }
});
test('P1-1 考勤页面使用持久论坛分区的 fetch 与登录态', async () => {
  const calls = [], authenticated = { marker: 'logged-in', async fetch(url, options) { assert.equal(this.marker, 'logged-in'); calls.push({ url, redirect: options.redirect }); return new Response('attendance'); } };
  const fetchImpl = attendanceFetch({ fromPartition(partition) { assert.equal(partition, 'persist:company-forum'); return authenticated; } });
  assert.equal((await probePage('https://example.invalid/attendance', { fetchImpl })).status, 'ok');
  assert.equal(calls.length, 1); assert.equal(calls[0].redirect, 'follow');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /return probePage\(url, \{ fetchImpl: attendanceFetch\(require\('electron'\)\.session\) \}\)/, '主进程必须接入该分区适配器');
});
