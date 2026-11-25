'use strict';
// 助理扫码登录连不上公司代理（code=7，v5.6.103 反馈）：提示说清是代理不通、下一步做什么，旁边给「打开代理设置」。全部为合成输出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const { matchKnownIssue } = require('../core/known-issues');

const PROXY_LINE = 'HTTP request failed: Could not connect to server (code=7) | detail: Failed to connect to proxy.corp.example port 8080 after 2034 ms: Could not connect to server';

test('连不上公司代理（code=7）认成 proxy 原因，算失败，并带「打开代理设置」', () => {
  const out = 'Obtaining QR code...\n' + PROXY_LINE + '\n';
  const d = W.loginDiagnosis(out);
  assert.equal(d.id, 'proxy');
  assert.equal(d.proxySettings, true);
  assert.match(d.title, /连不上公司代理/);
  assert.match(d.next, /VPN/);
  assert.match(d.next, /重新获取二维码/);
  assert.equal(W.loginProgress(out).phase, 'failed');
});

test('「QR code request failed」同一行带代理 code=7 时按代理说；不带代理的 code=7 归网络', () => {
  assert.equal(W.loginDiagnosis('QR code request failed: ' + PROXY_LINE).id, 'proxy');
  assert.equal(W.loginDiagnosis('HTTP request failed: Could not connect to server (code=7) | detail: Failed to connect to 10.1.2.3 port 443').id, 'network');
});

test('只出现在 Telemetry 上报行里的代理 code=7 不算登录失败原因', () => {
  const out = '[WARN] Telemetry: report error: HTTP request failed: Could not connect to server (code=7) | detail: Failed to connect to proxyhk.corp.example port 8080\nWaiting for scan... (elapsed 3 seconds)\n';
  assert.equal(W.loginDiagnosis(out), null);
  assert.equal(W.loginProgress(out).phase, 'waiting');
});

test('「问问 Hub」已知解法认得这条，并给一键打开代理设置', () => {
  const k = matchKnownIssue({ area: 'welink', title: 'WeLink 扫码登录没成功', symptom: '', details: '连不上公司代理，二维码请求发不出去 · ' + PROXY_LINE });
  assert.equal(k.id, 'welink-proxy-unreachable');
  assert.equal(k.action.act, 'known:open-proxy-settings');
  const card = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-error-card.js'), 'utf8');
  assert.match(card, /known:open-proxy-settings'\) \{ await require\('electron'\)\.shell\.openExternal\('ms-settings:network-proxy'\)/);
  const manual = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TROUBLESHOOT-AGENT.md'), 'utf8');
  assert.match(manual, /welink-proxy-unreachable/);
});

test('扫码面板：代理原因时「打开代理设置」按钮与下一步提示同一行', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(page, /cause\?\.proxySettings \? ' <button type="button" class="ca-link" data-ca="open-proxy-settings">打开代理设置<\/button>'/);
  assert.match(page, /<p class="ca-login-next"><span>\$\{esc\(cause\.next\)\}<\/span>\$\{proxyBtn\}<\/p>/);
  assert.match(page, /verb === 'open-proxy-settings'\) \{ await require\('electron'\)\.shell\.openExternal\('ms-settings:network-proxy'\)/);
});

test('新增提示有英文译文', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'core', 'i18n', 'locales', 'en', 'residual.json'), 'utf8'));
  const d = W.loginDiagnosis(PROXY_LINE);
  const k = matchKnownIssue({ area: 'welink', details: PROXY_LINE });
  for (const zh of [d.title, d.next, '打开代理设置', k.title, k.fix]) assert.ok(en[zh], zh);
});

test('自动续期因连不上代理失败：给打开代理设置，不当成普通登录过期', () => {
  const { matchKnownIssue } = require('../core/known-issues');
  const hit = matchKnownIssue({ area: 'welink', title: '自动续期没成功，点这里扫码登录', details: '连不上公司代理，二维码请求发不出去' });
  assert.equal(hit && hit.id, 'welink-proxy-unreachable');
  const plain = matchKnownIssue({ area: 'welink', title: 'WeLink 登录已过期，Hub 正在自动续期' });
  assert.equal(plain && plain.id, 'welink-login-expired');
  const raw = matchKnownIssue({ area: 'welink', details: 'Could not connect to server (code=7) | detail: proxy.corp.example' });
  assert.equal(raw && raw.id, 'welink-proxy-unreachable');
});
