'use strict';
// 门户读不到时的原因归类、诊断日志与 Edge 登录状态复制（2026-11-19 反馈 3b80a678）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyW3, failureKind } = require('../core/company-w3/service');
const { copyLogin, edgeProfileOf } = require('../main/company-edge-capture');

test('失败原因归类：登录、网络、超时、Edge、域名各归各的', () => {
  assert.equal(failureKind({ needsDomain: true }), 'domain');
  assert.equal(failureKind({ needsLogin: true, error: '需要登录（停在 login.x）' }), 'login');
  assert.equal(failureKind({ error: '页面还没登录好' }), 'login');
  assert.equal(failureKind({ error: '本机没有找到 Edge' }), 'no-edge');
  assert.equal(failureKind({ error: '无头 Edge 启动失败（ENOENT）' }), 'edge');
  assert.equal(failureKind({ error: '和无头 Edge 的连接断了' }), 'edge');
  assert.equal(failureKind({ error: '页面里的查询超时' }), 'timeout');
  assert.equal(failureKind({ error: '页面没有打开（停在 空白页）' }), 'unreachable');
  assert.equal(failureKind({ error: '页面里的查询出错：TypeError' }), 'query');
  assert.equal(failureKind({ error: '奇怪的错' }), 'other');
});

test('取数失败写进 lastResult.kind 和 logs/company-w3.log，不记待办内容', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-fail-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'company-domain.json'), JSON.stringify({ domain: 'example.com', from: 'assistant-email' }));
  const svc = new CompanyW3({ dataDir, noTimer: true, edgeRun: async () => ({ ok: false, needsLogin: true, error: '需要登录（停在 login.example.com）', finalHost: 'login.example.com', tookMs: 46000, loginCopy: { profile: 'Profile 1', copied: 2, cookies: false } }) });
  svc.setSettings({ domain: 'example.com' });
  const entry = await svc.sync({ reason: 'manual' });
  assert.equal(entry.ok, false); assert.equal(entry.kind, 'login');
  assert.equal(svc.status().lastResult.kind, 'login');
  const lines = fs.readFileSync(path.join(dataDir, 'logs', 'company-w3.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'login'); assert.equal(lines[0].finalHost, 'login.example.com');
  assert.deepEqual(lines[0].loginCopy, { profile: 'Profile 1', copied: 2, cookies: false });
  assert.ok(!('todo' in lines[0]));
});

test('复制 Edge 登录状态用最近用的资料，没有就退回 Default', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-edge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'Microsoft', 'Edge', 'User Data');
  for (const prof of ['Default', 'Profile 1']) {
    fs.mkdirSync(path.join(src, prof, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(src, prof, 'Network', 'Cookies'), prof);
    fs.writeFileSync(path.join(src, prof, 'Preferences'), '{}');
  }
  fs.writeFileSync(path.join(src, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }));
  assert.equal(edgeProfileOf(src), 'Profile 1');
  const tmp = path.join(root, 'tmp');
  const info = copyLogin(tmp, { LOCALAPPDATA: root });
  assert.deepEqual(info, { profile: 'Profile 1', copied: 3, cookies: true });
  assert.equal(fs.readFileSync(path.join(tmp, 'Default', 'Network', 'Cookies'), 'utf8'), 'Profile 1');
  fs.writeFileSync(path.join(src, 'Local State'), JSON.stringify({ profile: { last_used: '../evil' } }));
  assert.equal(edgeProfileOf(src), 'Default', '资料名不合规就不用');
  fs.mkdirSync(path.join(src, '..', 'Network'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Local State'), JSON.stringify({ profile: { last_used: '..' } }));
  assert.equal(edgeProfileOf(src), 'Default', '.. 不能穿到资料根目录外');
  fs.writeFileSync(path.join(src, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 9' } }));
  assert.equal(edgeProfileOf(src), 'Default', '资料目录不存在就退回 Default');
  assert.deepEqual(copyLogin(tmp, { LOCALAPPDATA: path.join(root, 'none') }), { profile: '', copied: 0, cookies: false });
});

test('诊断日志里的本机路径换成占位，资料名只认 Default / Profile N', () => {
  const { scrubPaths } = require('../core/company-w3/service');
  const bs = String.fromCharCode(92);
  const raw = 'EPERM: mkdtemp ' + ['C:', 'Users', '张三', 'AppData', 'x'].join(bs) + ' failed；' + bs + bs + ['srv', 'share', 'a'].join(bs) + ' ok D:/a/b c';
  const out = scrubPaths(raw);
  assert.ok(!/张三|srv|D:\/a/.test(out), out);
  assert.match(out, /<路径> failed；<路径> ok <路径> c/);
  const spaced = scrubPaths('open ' + ['C:', 'Users', 'John Smith', 'AppData', 'y'].join(bs) + ' failed');
  assert.ok(!/John|Smith/.test(spaced), spaced);
});
