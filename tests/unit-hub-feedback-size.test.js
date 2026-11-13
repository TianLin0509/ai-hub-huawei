'use strict';
// 一键反馈整包必须不超过约 80 KB（公司代理单次 POST 超过约 100 KB 会 403），并带上生命周期记录与更新结果。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectBundle, MAX_TOTAL_BYTES } = require('../core/hub-feedback');

test('反馈遮住CodeAgent两种OAuth令牌字段及转义JSON中的Base64值', () => {
  const { redact } = require('../core/hub-feedback');
  const token = 'ab+/cd'.repeat(8);
  for (const key of ['xAuthToken', 'mtoken', 'accessToken', 'refreshToken']) {
    let input = JSON.stringify({ [key]: token });
    for (let layer = 0; layer < 3; layer++) {
      assert.equal(redact(input).includes(token), false, key + ' layer ' + layer);
      input = JSON.stringify(input);
    }
  }
});

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-size-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diagnostics'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app-update'), { recursive: true });
  return dir;
}

test('大量中文日志也把整包压到 80 KB 以内，保留描述和最新行，并说明裁掉多少', () => {
  const dir = mk();
  for (let f = 0; f < 6; f++) {
    const rows = [];
    for (let i = 0; i < 150; i++) rows.push(`第${f}份 第${i}行 ` + '汉字内容'.repeat(60));
    fs.writeFileSync(path.join(dir, 'logs', `big${f}.log`), rows.join('\n') + '\n');
  }
  const b = collectBundle({ logsDir: path.join(dir, 'logs'), dataDir: dir, description: '点保存没反应', contact: 'x' });
  assert.ok(Buffer.byteLength(JSON.stringify({ text: b.text }), 'utf8') <= 82 * 1024, 'bytes=' + b.bytes);
  assert.ok(b.bytes <= MAX_TOTAL_BYTES);
  assert.match(b.text, /点保存没反应/);
  assert.match(b.text, /第\d份 第149行/); // 每份保留最新的行
  assert.match(b.text, /## 已裁剪/);
  assert.ok(b.trimmedLines > 0);
  assert.ok(b.items.some(i => i.name === '已按大小上限裁剪' && /裁掉较早的 \d+ 行/.test(i.detail)));
});

test('描述过长时先保住环境信息，描述按字节裁并说明', () => {
  const dir = mk();
  const b = collectBundle({ logsDir: path.join(dir, 'logs'), dataDir: dir, description: '长'.repeat(60000), info: { version: '9.9.9' } });
  assert.ok(b.bytes <= MAX_TOTAL_BYTES);
  assert.match(b.text, /v9\.9\.9/);
  assert.ok(b.items.some(i => i.name === '问题描述过长'));
});

test('诊断包带上最近 3 份生命周期记录和上次更新结果', () => {
  const dir = mk();
  for (let i = 1; i <= 5; i++) {
    const f = path.join(dir, 'diagnostics', `process-lifecycle-${i}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ event: 'uncaught', n: i }) + '\n');
    fs.utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i));
  }
  fs.writeFileSync(path.join(dir, 'diagnostics', 'process-lifecycle-9.heartbeat.json'), '{}');
  fs.writeFileSync(path.join(dir, 'app-update', 'last-result.json.seen'), JSON.stringify({ ok: false, reason: '替换失败' }));
  const b = collectBundle({ logsDir: path.join(dir, 'logs'), dataDir: dir, description: 'd' });
  const names = b.items.map(i => i.name);
  assert.equal(names.filter(n => n.startsWith('生命周期记录')).length, 3);
  assert.ok(names.includes('生命周期记录 diagnostics/process-lifecycle-5.jsonl'));
  assert.ok(!names.includes('生命周期记录 diagnostics/process-lifecycle-1.jsonl'));
  assert.ok(names.includes('更新结果 app-update/last-result.json.seen'));
  assert.match(b.text, /替换失败/);
});

test('没有 dataDir 时行为与旧版一致', () => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'logs', 'a.log'), 'one\ntwo\n');
  const b = collectBundle({ logsDir: path.join(dir, 'logs'), description: 'd' });
  assert.ok(b.items.some(i => i.name === '日志 a.log'));
  assert.doesNotMatch(b.text, /已裁剪/);
});

test('反馈显式附带公司模型的签名初始化诊断，不读取其他诊断文件', t => {
  const dir = mk(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = { cliStarted: true, cliExitCode: 7, stoppedBy: 'exit', consoleMode: 'private-desktop',
    logExists: false, logBytes: 0, elapsedMs: 2000, error: 'LOG_MISSING', stderrPreview: ['startup failed <已隐去>'] };
  fs.writeFileSync(path.join(dir, 'diagnostics/company-model-proxy.log'), 'upstream not ready: first-init=' + JSON.stringify({ probe: report }) + '\n');
  fs.writeFileSync(path.join(dir, 'diagnostics/unrelated-private.log'), 'not-for-feedback');
  const bundle = collectBundle({ logsDir: path.join(dir, 'logs'), dataDir: dir, description: '公司模型不能用' });
  assert.ok(bundle.items.some(item => item.name === '公司模型诊断 diagnostics/company-model-proxy.log'));
  for (const field of ['cliStarted', 'cliExitCode', 'stoppedBy', 'consoleMode', 'logExists', 'logBytes', 'elapsedMs', 'error', 'stderrPreview']) assert.ok(bundle.text.includes(field), field);
  assert.match(bundle.text, /LOG_MISSING/);
  assert.equal(bundle.text.includes('not-for-feedback'), false);
  assert.ok(bundle.bytes <= MAX_TOTAL_BYTES);
});

test('两次探测的长单行诊断超过8KB时仍完整带入反馈，且整包保持80KB上限', t => {
  const dir = mk(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const attempt = { cliStarted: true, cliExitCode: 7, stoppedBy: 'exit', consoleMode: 'private-desktop',
    logExists: false, logBytes: 0, elapsedMs: 1000, error: 'LOG_MISSING',
    stderrPreview: Array.from({ length: 20 }, (_, index) => 'safe detail ' + index + ' ' + 'x'.repeat(150)) };
  const probe = { ...attempt, attempts: [attempt, { ...attempt, consoleMode: 'private-desktop-hidden-console' }] };
  const row = 'upstream not ready: first-init=' + JSON.stringify({ probe }) + '\n';
  assert.ok(Buffer.byteLength(row) > 8 * 1024);
  fs.writeFileSync(path.join(dir, 'diagnostics/company-model-proxy.log'), row);
  const bundle = collectBundle({ logsDir: path.join(dir, 'logs'), dataDir: dir, description: '签名初始化失败' });
  assert.ok(bundle.text.includes('first-init=' + JSON.stringify({ probe })), 'the complete diagnostic JSON row must survive tail reading');
  assert.match(bundle.text, /private-desktop-hidden-console/);
  assert.ok(bundle.bytes <= MAX_TOTAL_BYTES);
});
