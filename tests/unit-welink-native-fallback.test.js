'use strict';
// WeLink 回落间隔：私聊助理未启用照旧 6 秒（安静放慢 15/30 秒）、在线停轮询、离线 60 秒兜底。
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../core/welink-native/fallback');

const MIN = 60000;
test('三种间隔：未启用照旧 6 秒（安静放慢 15/30 秒）、在线停轮询、离线 60 秒兜底', () => {
  assert.equal(F.pollGapMs({ native: 'off', quietMs: 0 }), 0);
  assert.equal(F.pollGapMs({ native: 'off', quietMs: 11 * MIN }), 15000);
  assert.equal(F.pollGapMs({ native: 'off', quietMs: 31 * MIN }), 30000);
  assert.equal(F.pollGapMs({ native: 'online' }), Infinity);
  assert.equal(F.pollGapMs({ native: 'offline', quietMs: 0 }), 60000);
  assert.equal(F.transitionText('online', 'offline'), F.OFFLINE_TEXT);
  assert.equal(F.transitionText('offline', 'online'), F.RECOVERED_TEXT);
  assert.equal(F.transitionText('off', 'online'), '');
  assert.equal(F.transitionText('online', 'online'), '');
});

