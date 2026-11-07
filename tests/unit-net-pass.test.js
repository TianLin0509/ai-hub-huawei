'use strict';
// 高速下载镜像与「放行下载服务器」（2026-11-07）：反馈留在主服务器、放行页按主机、一个按钮放行两台、新用户提醒。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ownHosts = require('../core/own-hosts');
const { createNetPass } = require('../core/net-pass');
const view = require('../renderer/net-pass-view');

const config = { sources: [
  { id: 'aliyun-fast', name: '阿里云高速', mirror: true, manifest: 'https://dl.example.tech/hub-update/company/latest.json', files: 'https://dl.example.tech/hub-update/company/v{version}/' },
  { id: 'github', name: 'GitHub', manifest: 'https://github.com/x/y/releases/latest/download/latest.json', files: 'https://github.com/x/y/releases/download/v{version}/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.example.tech/hub-update/company/latest.json', files: 'https://me.example.tech/hub-update/company/v{version}/' },
] };

test('高速镜像排第一时，一键反馈仍投旧服务器；放行页跟着被拦的主机走', () => {
  assert.equal(ownHosts.feedbackEndpoint(config), 'https://me.example.tech/hub-update/api/feedback/submit');
  assert.equal(ownHosts.ownOrigin(config), 'https://me.example.tech');
  assert.equal(ownHosts.unblockPage(config, 'https://dl.example.tech/hub-update/company/latest.json'), 'https://dl.example.tech/hub-update/api/feedback');
  assert.equal(ownHosts.unblockPage(config, 'https://me.example.tech/x'), 'https://me.example.tech/hub-update/api/feedback');
  assert.equal(ownHosts.unblockPage(config, 'https://github.com/x'), 'https://me.example.tech/hub-update/api/feedback');
  assert.deepEqual(ownHosts.ownHosts(config), ['dl.example.tech', 'me.example.tech']);
  assert.deepEqual(ownHosts.downloadHosts(config).map(h => [h.host, h.name, h.mirror]), [['dl.example.tech', '阿里云高速', true], ['me.example.tech', '阿里云', false]]);
  // 只有镜像源时（不该出现，但别崩）：退回镜像本身
  assert.equal(ownHosts.feedbackEndpoint({ sources: [config.sources[0]] }), 'https://dl.example.tech/hub-update/api/feedback/submit');
});

const OWN = '<!doctype html><html><head><title>AI HUB 服务</title></head><body>ok</body></html>';
const GATE = '<!doctype html><html><head><title>安全提示</title></head><body><button>继续访问</button></body></html>';
const res = (text, status = 200) => ({ status, ok: status < 400, text: async () => text });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'net-pass-'));

test('一个按钮放行两台：拦着的逐台开放行页，放行后都显示可以访问，并记住', async () => {
  const passed = new Set(), opened = [], dataDir = tmp();
  const hosts = ownHosts.downloadHosts(config);
  const np = createNetPass({ hosts, dataDir, fetchImpl: async url => res(passed.has(new URL(url).host) ? OWN : GATE),
    openGate: async page => { opened.push(page); passed.add(new URL(page).host); return { clicked: true }; } });
  assert.equal(np.status().needed, true, '没查过、也从没放行过：提醒');
  await np.refresh();
  assert.deepEqual(np.status().hosts.map(h => h.state), ['blocked', 'blocked']);
  const r = await np.passAll();
  assert.deepEqual(opened, ['https://dl.example.tech/hub-update/api/feedback', 'https://me.example.tech/hub-update/api/feedback']);
  assert.deepEqual(r.results.map(x => x.result), ['ok', 'ok']);
  assert.equal(r.needed, false);
  // 换个进程（重启 Hub）：记得放行过，查之前不再提醒
  const again = createNetPass({ hosts, dataDir, fetchImpl: async () => res(OWN) });
  assert.equal(again.status().needed, false);
  assert.ok(again.status().hosts.every(h => h.okAt));
});

test('后台放行没成功的给出浏览器打开；连不上不是放行能解决的，不催', async () => {
  const hosts = ownHosts.downloadHosts(config);
  const np = createNetPass({ hosts, fetchImpl: async url => { if (url.includes('dl.')) throw new Error('getaddrinfo ENOTFOUND'); return res(GATE); },
    openGate: async () => ({ clicked: false }) });
  const r = await np.passAll();
  assert.deepEqual(r.results.map(x => x.result), ['error', 'blocked']);
  assert.equal(r.needed, true);
  const html = view.boxHtml(r, { last: r });
  assert.match(html, /第一次使用请先放行下载服务器/);
  assert.match(html, /用浏览器打开「阿里云」/);
  assert.doesNotMatch(html, /用浏览器打开「阿里云高速」/);
  assert.match(html, /连不上/);
});

test('都能访问时只显示一行和「重新放行」；没有自家主机时什么都不显示', async () => {
  const np = createNetPass({ hosts: ownHosts.downloadHosts(config), fetchImpl: async () => res(OWN) });
  await np.refresh();
  const html = view.boxHtml(np.status());
  assert.match(html, /np-line/); assert.match(html, /重新放行/); assert.doesNotMatch(html, /第一次使用/);
  assert.equal(view.boxHtml(createNetPass({ hosts: [] }).status()), '');
  assert.equal(view.boxHtml(null), '');
});
