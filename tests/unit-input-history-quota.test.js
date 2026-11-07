'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFloatingInputHistory, ENTRY_MAX_CHARS } = require('../renderer/floating-input-history.js');

function quotaStorage(limitChars) {
  const m = new Map();
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      const before = m.get(k);
      m.set(k, String(v));
      if (used() > limitChars) {
        if (before == null) m.delete(k); else m.set(k, before);
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
    },
    removeItem: k => m.delete(k), used,
  };
}

test('A2-16 单条超过上限不进历史，且不挤占配额', () => {
  const storage = quotaStorage(5_000_000);
  const h = createFloatingInputHistory({ storage });
  h.push('s1', '短消息');
  h.push('s1', 'x'.repeat(ENTRY_MAX_CHARS + 1));
  assert.deepEqual(h.list('s1'), ['短消息']);
  assert.ok(storage.used() < 10_000);
});

test('A2-16 写入时当前会话移到末尾（按最近使用淘汰）', () => {
  const h = createFloatingInputHistory({ storage: quotaStorage(1e6), sessionLimit: 3 });
  h.push('old', 'a'); h.push('b', 'b'); h.push('c', 'c');
  h.push('old', 'a2');           // 老会话再次使用
  h.push('d', 'd');              // 超过 3 个：应淘汰 b，而不是刚用过的 old
  assert.deepEqual(h.list('old'), ['a2', 'a']);
  assert.deepEqual(h.list('b'), []);
});

test('A2-16 配额错误时淘汰最旧的再试，新消息不丢', () => {
  const big = 'y'.repeat(ENTRY_MAX_CHARS);
  const storage = quotaStorage(ENTRY_MAX_CHARS * 2 + 2000);
  const h = createFloatingInputHistory({ storage });
  h.push('s1', big); h.push('s2', big);
  h.push('s3', big.slice(0, 40000) + 'z');
  assert.equal(h.list('s3').length, 1);
  assert.deepEqual(h.list('s1'), []);
});
