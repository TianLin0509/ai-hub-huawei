'use strict';
// CodeAgent 检测（renderer/codeagent-preference.js）：检测出错记为「不知道」而不是「没装」；force 能重测（装好后不再一直显示需配置）。
const assert = require('node:assert/strict');
const test = require('node:test');

test('检测出错 → null；装好后 force 重测 → true', async () => {
  delete require.cache[require.resolve('../renderer/codeagent-preference')];
  const pref = require('../renderer/codeagent-preference');
  let calls = 0, mode = 'error';
  const ipc = { invoke: async () => { calls++; if (mode === 'error') throw new Error('ipc down'); return { installed: mode === 'yes' }; } };
  assert.equal(await pref.refresh(ipc), null); assert.equal(pref.detectedInstalled(), null);
  mode = 'no'; assert.equal(await pref.refresh(ipc), false, '出错后下次会重新测');
  mode = 'yes'; assert.equal(await pref.refresh(ipc), false, '不 force 用缓存');
  assert.equal(await pref.refresh(ipc, { force: true }), true); assert.equal(pref.detectedInstalled(), true);
  assert.equal(calls, 3);
});
