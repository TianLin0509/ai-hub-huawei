'use strict';
// 2026-11-28 黄区真机一键反馈压测发现的两处：
// ① WeLink 送达的反馈收件编号是占位「WeLink」，「我的反馈」拿它去更新日志里找，凡提到 WeLink 的版本都会命中，刚发的就被标「已修于 v5.6.104」；
// ② welink-cli 失败但输出 JSON 回执时，界面原样显示 {"code":500,"message":"server busy"}。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubFeedbackService } = require('../main/hub-feedback-service');
const { sendReceiptError } = require('../core/hub-feedback-welink');

function svc(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-rt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createHubFeedbackService({ edition: 'member', info: () => ({ version: '5.6.140' }), logsDir: path.join(root, 'logs'),
    downloadsDir: () => path.join(root, 'downloads'), logger: { warn() {} }, receiverAddress: { resolve: async () => ({ urls: [] }) },
    intranetFetch: async () => { throw new Error('unused'); } });
}

test('placeholder receipt ids (WeLink delivery, copied text) never match release notes', t => {
  const s = svc(t);
  const history = [{ version: '5.6.104', notes: ['一键反馈改走 WeLink：已复制，待本人在 WeLink 发送'] }];
  assert.equal(s.fixedInFor('WeLink', history), '');
  assert.equal(s.fixedInFor('已复制，待本人在 WeLink 发送', history), '');
  assert.equal(s.fixedInFor('20261128T064320Z-1a2b3c4d', [{ version: '5.6.141', notes: ['修复 1a2b3c4d'] }]), '5.6.141');
});

test('a failed welink-cli with a JSON receipt is described in words, not raw JSON', () => {
  const parseJson = text => JSON.parse(text);
  const reason = sendReceiptError({ code: 1, stdout: '{"code":500,"message":"server busy"}' }, parseJson);
  assert.equal(reason, 'WeLink 返回错误（500）：server busy');
  assert.doesNotMatch(reason, /[{}"]/);
  // 非 JSON 输出照旧原样（截断到 200 字）
  assert.equal(sendReceiptError({ code: 1, stderr: 'welink-cli: not logged in' }, parseJson), 'welink-cli: not logged in');
  // proxy failed 仍能被后面的友好提示认出
  assert.match(sendReceiptError({ code: 1, stdout: '{"code":502,"message":"proxy failed"}' }, parseJson), /proxy failed/);
});
