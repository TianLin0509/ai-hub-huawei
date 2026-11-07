'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');

test('a notSent receipt does not steal the confirmation of an identical resend', () => {
  const r = new PromptSubmissionReceipts(() => {});
  const sid = 's1', t0 = Date.now();
  const r1 = r.begin(sid, 'msg-1', '继续', t0);
  r.finish(r1, { ok: false, notSent: true, code: 'codeagent-input-residual' });
  assert.strictEqual(r1.status, 'failed');
  const r2 = r.begin(sid, 'msg-2', '继续', t0 + 1000);
  const hit = r.observe({ sessionId: sid, text: '继续', signalSource: 'claude-user-prompt-submit', observedAt: t0 + 2000, turnId: 'p2' });
  assert.strictEqual(hit, true);
  assert.strictEqual(r1.status, 'failed');
  assert.strictEqual(r2.status, 'confirmed');
});
