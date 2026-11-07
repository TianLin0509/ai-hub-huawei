'use strict';
// 一键反馈整包必须不超过约 80 KB（公司代理单次 POST 超过约 100 KB 会 403），并带上生命周期记录与更新结果。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectBundle, MAX_TOTAL_BYTES } = require('../core/hub-feedback');

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
