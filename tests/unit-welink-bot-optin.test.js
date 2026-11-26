'use strict';
// WeLink 私聊助理（beta）严格可选（2026-11-27 硬要求：普通用户体验不能变差）：
//   没点「绑定到 WeLink」的用户：不发任何网络请求、不连网关、设置内容与上一版一致、专用群方式的收发完全照旧；
//   绑定了的用户网关反复失败也不影响助理问答和专用群。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { PREFIX, WELCOME } = require('../core/company-assistant/phone');

// 上一版（v5.6.126）的手机默认设置，逐字段写死：没绑定的用户设置必须和它一模一样。
const MAIN_DEFAULT_PHONE = { enabled: false, groupId: '', groupName: '', pushWatched: true, pushStuck: true, since: 0, extraIds: [] };

function make(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-optin-'));
  const net = { ws: 0, http: 0 };
  class CountingWS { constructor() { net.ws += 1; throw new Error('不该连网关'); } }
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null,
    welinkBot: { http: async () => { net.http += 1; throw new Error('不该发请求'); }, WebSocket: CountingWS, domain: 'example.com', mac: 'aa' } });
  const calls = [];
  a.welink = async args => { calls.push(args); return { code: 0, stdout: '{"code":"0"}', stderr: '' }; };
  t.after(() => { try { a.close(); } catch { /* */ } fs.rmSync(root, { recursive: true, force: true }); });
  return { a, net, calls, root };
}

test('没绑定：默认设置与上一版逐字段一致，没有 transport 字段，走专用群', t => {
  const { a } = make(t);
  assert.deepEqual(a.phone.settings(), MAIN_DEFAULT_PHONE);
  assert.equal('transport' in a.phone.status().settings, false, '状态里的设置也不多字段');
  assert.equal(a.phone.transport(), 'group');
  assert.equal(a.phone.viaBot(), false);
});

test('没绑定：启动、暂停、恢复、关闭都不发网络请求、不连网关、不写私聊助理文件', t => {
  const { a, net } = make(t);
  a.start(); a.pause?.(); a.resume?.();
  a.setSettings({ phone: { enabled: true, groupId: '123' } });
  a.resume?.();
  assert.deepEqual(net, { ws: 0, http: 0 });
  assert.equal(fs.existsSync(path.join(a.dir, 'welink-bot.bin')), false);
  assert.equal(fs.existsSync(path.join(a.dir, 'welink-bot.json')), false);
  assert.equal(a.bot.status().phase, 'idle');
});

test('没绑定：专用群接通、收发、设置内容与上一版一致', async t => {
  const { a, calls, net } = make(t);
  a.start();
  const r = await a.setPhone({ groupId: '123', enabled: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['im', 'send-to-group', '--group-id', '123', '--text', PREFIX + WELCOME], '欢迎消息照旧发到群');
  const saved = a.settings().phone;
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(MAIN_DEFAULT_PHONE).sort(), '存盘字段与上一版相同');
  assert.equal(saved.enabled, true); assert.equal(saved.groupId, '123');
  assert.equal(a.phone.active(), true);
  // 关闭、换群也一样不出现新字段
  await a.setPhone({ enabled: false }); await a.setPhone({ groupId: '456', enabled: true });
  assert.deepEqual(Object.keys(a.settings().phone).sort(), Object.keys(MAIN_DEFAULT_PHONE).sort());
  // 回答发回群里：一样带【助理】前缀走 send-to-group
  calls.length = 0;
  a.phone.save({ pending: { q1: { at: a.now(), acked: false } } });
  a.phone.settle({ id: 'q1', state: 'done', a: '答案' });
  await a.phone.outbox;
  assert.deepEqual(calls[0], ['im', 'send-to-group', '--group-id', '456', '--text', PREFIX + '答案']);
  assert.deepEqual(net, { ws: 0, http: 0 });
});

test('没绑定：active() 与上一版判定（开启且填了群）逐一相同', t => {
  const { a } = make(t);
  for (const enabled of [false, true]) for (const groupId of ['', '123']) {
    a.setSettings({ phone: { enabled, groupId } });
    assert.equal(a.phone.active(), !!(enabled && groupId), `enabled=${enabled} groupId=${groupId}`);
  }
});

test('绑定后网关反复失败：错误只留在私聊助理自己的状态里、不刷日志、退避有上限，改回专用群照常发送', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-optin-fail-'));
  let tries = 0;
  class BrokenWS { constructor() { tries += 1; throw new Error('网关挂了'); } }
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).slice(4) };
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null, safeStorage,
    welinkBot: { manual: true, WebSocket: BrokenWS, domain: 'example.com', mac: 'aa' } });
  t.after(() => { try { a.close(); } catch { /* */ } fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [];
  a.welink = async args => { calls.push(args); return { code: 0, stdout: '{"code":"0"}', stderr: '' }; };
  a.bot.saveCred({ ak: 'AK', sk: 'SK' });
  a.setSettings({ phone: { enabled: true, transport: 'bot' } });
  const warn = console.warn; let warned = 0; console.warn = () => { warned += 1; };
  try { for (let i = 0; i < 20; i += 1) a.bot.start(); } finally { console.warn = warn; }
  assert.ok(tries >= 1);
  assert.match(a.bot.status().lastError, /网关挂了/);
  assert.equal(warned, 0, '重连失败不刷日志');
  assert.ok(a.bot.backoff <= 60000, '退避有上限');
  // 改回专用群：照常发欢迎消息，私聊助理的失败不串过来
  const r = await a.setPhone({ transport: 'group', groupId: '123', enabled: true });
  assert.equal(r.ok, true);
  assert.equal('transport' in a.settings().phone, false, '改回专用群后设置和从没用过一样');
  assert.deepEqual(calls[0].slice(0, 4), ['im', 'send-to-group', '--group-id', '123']);
});
