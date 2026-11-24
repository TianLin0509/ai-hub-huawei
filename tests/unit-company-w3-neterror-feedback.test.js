'use strict';
// 门户故障排查（2026-11-24）：
//   1. 停在 Edge 的「无法访问此页面」错误页时，按错误码给人话原因，不再把 chromewebdata 原样显示给用户；
//   2. 门户页发起的一键反馈一定带上 company-w3.log（描述里点名的日志排最前）；诊断日志抹路径不误伤网址。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyW3, failureKind } = require('../core/company-w3/service');
const { failureOf, netWhy } = require('../renderer/company-w3-page');

function make(t, { edge } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-neterr-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = { edge: 0, hubRun: [] };
  const deps = { dataDir, noTimer: true, now: () => new Date('2026-11-24T09:00:00'), hubLogin: async () => ({ ok: true }),
    edgeRun: async (o) => { calls.edge += 1; return edge(o); } };
  const svc = new CompanyW3(deps);
  svc.setSettings({ domain: 'corp.example' });
  const log = () => fs.readFileSync(path.join(dataDir, 'logs', 'company-w3.log'), 'utf8').trim().split('\n').map(JSON.parse);
  return { svc, calls, dataDir, log };
}

test('停在 Edge 错误页：归为「页面没打开」，按错误码说人话，不再显示 chromewebdata', async t => {
  const { svc, log } = make(t, { edge: () => ({ ok: false, error: '页面没有打开（停在 Edge 的错误页，DNS_PROBE_FINISHED_NXDOMAIN）', netError: 'DNS_PROBE_FINISHED_NXDOMAIN', finalHost: 'chromewebdata', tookMs: 21000 }) });
  const e = await svc.sync({ reason: 'manual' });
  assert.equal(e.kind, 'unreachable'); assert.equal(e.netError, 'DNS_PROBE_FINISHED_NXDOMAIN');
  assert.equal(log()[0].netError, 'DNS_PROBE_FINISHED_NXDOMAIN');
  const why = failureOf(e, svc.status()).why(e);
  assert.match(why, /解析不了门户的地址/); assert.ok(!/chromewebdata/.test(why), why);
  assert.equal(failureKind({ error: '页面没有打开（停在 Edge 的错误页）' }), 'unreachable');
  assert.match(netWhy({ netError: 'ERR_PROXY_CONNECTION_FAILED' }), /代理/);
  assert.match(netWhy({ netError: 'ERR_CERT_AUTHORITY_INVALID' }), /证书/);
  assert.match(netWhy({ netError: 'ERR_CONNECTION_TIMED_OUT' }), /无法访问此页面/);
  assert.match(netWhy({ finalHost: 'chromewebdata' }), /无法访问此页面/);
  assert.equal(netWhy({ finalHost: 'w3.corp.example' }), '');
  // 没有错误码的普通「没打开」，文案与改前一样。
  assert.match(failureOf({ kind: 'unreachable', finalHost: 'w3.corp.example' }).why({ kind: 'unreachable', finalHost: 'w3.corp.example' }), /停在 w3\.corp\.example/);
});

test('诊断日志抹路径时不误伤网址', () => {
  const { scrubPaths } = require('../core/company-w3/service');
  const out = scrubPaths("ERR_EMPTY_RESPONSE loading 'http://127.0.0.1:63720/' 于 D:/a/b");
  assert.match(out, /http:\/\/127\.0\.0\.1:63720\//); assert.ok(!/D:\/a/.test(out), out);
});

test('一键反馈：描述里点名的日志排最前，不被刷得勤的日志挤掉', t => {
  const { recentLogs, collectBundle } = require('../core/hub-feedback');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w3 = path.join(dir, 'company-w3.log');
  fs.writeFileSync(w3, '{"ok":false,"kind":"unreachable","error":"页面没有打开（停在 Edge 的错误页，ERR_TUNNEL_CONNECTION_FAILED）"}\n');
  fs.utimesSync(w3, new Date('2026-11-20'), new Date('2026-11-20'));
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(dir, `busy-${i}.log`), ('x'.repeat(200) + '\n').repeat(400));
  assert.ok(!recentLogs(dir).some(l => l.name === 'company-w3.log'), '不点名时它排不进前 8 份（复现原问题）');
  assert.equal(recentLogs(dir, fs, { mention: '日志附在下面的 company-w3.log 里。' })[0].name, 'company-w3.log');
  const b = collectBundle({ description: '门户读取不到\n日志附在下面的 company-w3.log 里。', logsDir: dir });
  assert.match(b.text, /## 日志 company-w3\.log/); assert.match(b.text, /ERR_TUNNEL_CONNECTION_FAILED/);
  const { compactFeedback } = require('../core/hub-feedback-welink');
  assert.match(compactFeedback({ description: '日志附在下面的 company-w3.log 里。', logsDir: dir }), /ERR_TUNNEL_CONNECTION_FAILED/);
});

test('一键反馈：补充证据把预算占满时，点名的门户日志仍然带上，且只取最近一段', t => {
  const { collectBundle, MAX_TOTAL_BYTES } = require('../core/hub-feedback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs'), diag = path.join(root, 'diagnostics');
  fs.mkdirSync(logs); fs.mkdirSync(diag);
  const lines = [];
  for (let i = 0; i < 100; i += 1) lines.push(JSON.stringify({ i, ok: false, kind: 'unreachable', error: '页面没有打开（停在 Edge 的错误页，ERR_TUNNEL_CONNECTION_FAILED）', pad: 'x'.repeat(200) }));
  fs.writeFileSync(path.join(logs, 'company-w3.log'), lines.join('\n') + '\n');
  // 补充证据（公司模型诊断 + 生命周期记录）各自写满，足以吃光 44 KB。
  fs.writeFileSync(path.join(diag, 'company-model-proxy.log'), ('p'.repeat(300) + '\n').repeat(400));
  for (let k = 0; k < 3; k += 1) fs.writeFileSync(path.join(diag, `process-lifecycle-${k}.jsonl`), ('l'.repeat(300) + '\n').repeat(200));
  const b = collectBundle({ description: '门户读取不到\n日志附在下面的 company-w3.log 里。', logsDir: logs, dataDir: root });
  assert.ok(b.bytes <= MAX_TOTAL_BYTES, String(b.bytes));
  assert.match(b.text, /## 日志 company-w3\.log/);
  assert.ok(b.text.indexOf('## 日志 company-w3.log') < b.text.indexOf('## 公司模型诊断'), '点名日志排在补充证据之前');
  assert.match(b.text, /"i":99,/, '带上最新一行');
  assert.ok(!/"i":0,/.test(b.text), '只取最近一段，不整份塞进去');
  assert.match(b.text, /## 公司模型诊断/, '其余证据仍有位置');
});
