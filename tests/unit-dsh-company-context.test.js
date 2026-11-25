'use strict';
// DSH 走公司模型时的上下文上限按公司模型目录定（2026-11-25，WeLink：Hub 给 DSH 一律 128K，模型实际约 400K）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proxy = require('../core/company-model-proxy');

test('目录有值：按该模型的输入上限，不再封顶 128K；没有输入上限时不拿总窗口', () => {
  const models = [{ id: 'flash', input: 344064, contextWindow: 409600 }, { id: 'big', input: 1048576 }, { id: 'ctx-only', contextWindow: 262144 }];
  assert.equal(proxy.dshContextOf(models, 'flash'), 344064);
  assert.equal(proxy.dshContextOf(models, 'big'), 1048576);
  assert.equal(proxy.dshContextOf(models, 'ctx-only'), 128000);
});

test('目录里没有：回退到 128000', () => {
  assert.equal(proxy.dshContextOf([{ id: 'other', input: 344064 }], 'missing'), 128000);
  assert.equal(proxy.dshContextOf([{ id: 'bare' }], 'bare'), 128000);
  assert.equal(proxy.dshContextOf(null, 'x'), 128000);
});

test('值异常或小于 128000：回退到 128000，即使目录给了更大的总窗口', () => {
  for (const input of [0, -1, 4096, 8191, 65536, 127999, 1.5, '344064', NaN, Infinity, null, undefined]) {
    assert.equal(proxy.dshContextOf([{ id: 'm', input, contextWindow: 409600 }], 'm'), 128000, String(input));
  }
  assert.equal(proxy.dshContextOf([{ id: 'm', input: 128001 }], 'm'), 128001);
});

test('dshRoute 实际交给 DSH 的模型表：公司路线用目录值，网关路线不变', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctx-'));
  try {
    proxy.ensureEndpoint(dataDir, { preferredPort: 18998 });
    const route = proxy.dshRoute({ dataDir, sessionId: 's1', model: '' });
    const known = proxy.companyModels(dataDir);
    for (const m of route.providerConfig.models) {
      const entry = known.find(k => k.id === m.id);
      assert.equal(m.contextWindow, proxy.dshContextOf(known, m.id), m.id);
      if (entry && entry.input > 128000) assert.equal(m.contextWindow, entry.input, m.id);
    }
    // 内置目录里的 DeepSeek V4.1 Flash：输入上限 344064，以前给的是 128000。
    const flash = route.providerConfig.models.find(m => m.id === 'deepseek-v4.1-flash-1017');
    assert.ok(flash, '内置目录里应有 DeepSeek V4.1 Flash');
    assert.equal(flash.contextWindow, 344064);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
