'use strict';
// 统一放行入口（core/own-gate.js，5.6.2）：下载失败时被拦才放行并重试；没被拦、没登记都不改变原来的失败。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const gate = require('../core/own-gate');
const { createNetPass, OWN_TITLE } = require('../core/net-pass');
const { downloadWithFallback, checkManifests } = require('../core/app-update/downloader');

const OWN = 'https://dl.example.test/', PAGE = `<html><title>${OWN_TITLE}</title></html>`, WALL = '<html>HIS Proxy Notification</html>';
const html = (text, url) => ({ ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => text, body: null });

test('放行模块 passUrl：被拦的主机放行后回 passed，没被拦或不认识的主机回 false，放行不成回 blocked', async () => {
  let open = false, visible = 0;
  const pass = createNetPass({ hosts: [{ host: 'dl.example.test', name: '镜像', page: OWN }], fetchImpl: async url => html(open ? PAGE : WALL, url),
    openGate: null, openVisible: async () => { visible += 1; open = true; } });
  assert.equal(await pass.passUrl('https://other.example.test/a.zip'), false);
  assert.equal(await pass.passUrl(OWN + 'pack/a.zip', { interactive: false }), 'blocked', '不弹窗时放行不了');
  assert.equal(visible, 0);
  assert.equal(await pass.passUrl(OWN + 'pack/a.zip'), 'passed');
  assert.equal(visible, 1);
  assert.equal(await pass.passUrl(OWN + 'pack/a.zip'), false, '已经通了：这次失败不是放行的事');
});

test('withGate 与 gatedFetch：放行成功重试一次；被拦没放行成换成人话；没登记时原样抛错', async t => {
  t.after(() => gate.setHandler(null));
  await assert.rejects(gate.withGate(OWN, async () => { throw new Error('原错误'); }), /原错误/);
  let state = 'passed', calls = 0;
  gate.setHandler(async () => state);
  assert.equal(await gate.withGate(OWN, async () => { calls += 1; if (calls === 1) throw new Error('第一次失败'); return 'ok'; }), 'ok');
  state = 'blocked';
  await assert.rejects(gate.withGate(OWN, async () => { throw new Error("Unexpected token '<'"); }), error => error.blocked && error.message === gate.BLOCKED_TEXT);
  await assert.rejects(gate.withGate(OWN, async () => { throw new Error('x'); }, { interactive: false }), error => error.message === gate.BLOCKED_QUIET_TEXT);
  state = 'passed';
  await assert.rejects(gate.withGate(OWN, async () => { throw new Error('超时'); }), error => error.passed && error.message === gate.PASSED_TEXT);
  // 确认页冒充文件（HTTP 200 + 网页）：放行后拿到真文件
  let walled = true;
  gate.setHandler(async () => { walled = false; return 'passed'; });
  const fetch = gate.gatedFetch(async url => walled ? html(WALL, url) : { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"v":1}' });
  assert.equal(await (await fetch(OWN + 'component.json')).text(), '{"v":1}');
});

test('下载器 gate：全部源失败且自家主机被拦时放行后再下一遍；不传 gate 时行为不变', async t => {
  t.after(() => gate.setHandler(null));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = Buffer.from('pack-bytes'), expect = { file: 'a.bin', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  let open = false, asked = [];
  gate.setHandler(async url => { asked.push(url); open = true; return 'passed'; });
  const fetchImpl = async () => open
    ? { ok: true, status: 200, headers: { get: k => k === 'content-length' ? String(data.length) : 'application/octet-stream' }, body: new Blob([data]).stream() }
    : { ok: true, status: 200, headers: { get: k => k === 'content-length' ? '30' : 'text/html' }, arrayBuffer: async () => Buffer.from(WALL), body: null };
  const sources = [{ id: 'dl', name: '镜像', files: OWN + '{version}/' }];
  const plain = await downloadWithFallback({ sources, version: '1.0.0', expect, dest: path.join(dir, 'a.bin'), fetchImpl });
  assert.equal(plain.ok, false);
  assert.equal(plain.attempts[0].blocked, true);
  assert.deepEqual(asked, []);
  const gated = await downloadWithFallback({ gate: true, sources, version: '1.0.0', expect, dest: path.join(dir, 'a.bin'), fetchImpl });
  assert.equal(gated.ok, true);
  assert.deepEqual(asked, [OWN + '1.0.0/a.bin']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a.bin')), data);
  // 清单同理
  open = false; asked = [];
  const manifestFetch = async url => open ? { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"version":"1.0.0"}' } : html(WALL, url);
  const results = await checkManifests({ gate: true, sources: [{ id: 'dl', name: '镜像', manifest: OWN + 'latest.json' }], fetchImpl: manifestFetch, validate: m => m });
  assert.equal(results[0].ok, true);
  assert.deepEqual(asked, [OWN + 'latest.json']);
});

test('gatedFetch：拦截网页带 4xx 状态码也会去问放行（2026-11-12 审计）', async () => {
  const ownGate = require('../core/own-gate');
  const asked = [];
  ownGate.setHandler(async url => { asked.push(url); return false; });
  try {
    const fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => 'text/html; charset=utf-8' }, body: null });
    await assert.rejects(ownGate.gatedFetch(fetchImpl)('https://own.example.cn/f.zip'), /网页/);
    assert.deepEqual(asked, ['https://own.example.cn/f.zip']);
  } finally { ownGate.setHandler(null); }
});
