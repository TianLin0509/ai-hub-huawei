'use strict';
// DSH 走 API 网关时模型名放宽（2026-11-24）：部门网关的模型名常带 / 或 :，以前只有「自有接口」放宽，
// 网关路线选了 Qwen/Qwen3-235B 这类模型会报「请填写套餐模型 ID」、会话起不来。撤掉 core/acp-profiles.js 的修复，用例 1 就失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acp = require('../core/acp-profiles');
const proxy = require('../core/company-model-proxy');

function sandbox(t, { models, upstream = 'gateway' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(proxy.proxyDir(data), { recursive: true });
  fs.writeFileSync(proxy.endpointFile(data), JSON.stringify({ port: 18080, key: 'a'.repeat(40) }));
  fs.mkdirSync(path.join(data, 'api-gateway'), { recursive: true });
  fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ encryptedKey: 'x', models, model: models[0] }));
  const entry = path.join(root, 'dsh.js'); fs.writeFileSync(entry, '');
  const node = path.join(root, 'node.exe'); fs.writeFileSync(node, '');
  const bridge = path.join(root, 'bridge'); fs.mkdirSync(bridge); fs.writeFileSync(path.join(bridge, 'package.json'), '{}');
  const config = { companyCli: true, dshBackend: 'proxy', dshUpstream: upstream,
    acp: { nodePath: node, providers: { 'deepseek-acp': { entryPath: entry, bridgePath: bridge } } } };
  const build = model => acp.buildAcpOptions('deepseek-acp', { id: 's1', cwd: root, model }, config, data, { ...process.env });
  return { build };
}

test('用例 1：网关路线选带 / 和 : 的模型 → 会话参数里就是这个模型，不再报错', t => {
  const sb = sandbox(t, { models: ['Qwen/Qwen3-235B-A22B', 'deepseek-v4:pro'] });
  assert.equal(sb.build('Qwen/Qwen3-235B-A22B').model, 'Qwen/Qwen3-235B-A22B');
  assert.equal(sb.build('deepseek-v4:pro').model, 'deepseek-v4:pro');
});

test('用例 2：网关表里没有的名字 → 仍落到网关默认模型（安全边界不变）', t => {
  const sb = sandbox(t, { models: ['Qwen/Qwen3-235B-A22B', 'glm-5'] });
  assert.equal(sb.build('evil/other-vendor').model, 'Qwen/Qwen3-235B-A22B');
});

test('用例 3：校验函数——套餐口径仍拒绝 / 和 :，放宽口径接受，任何口径都拒绝空白与开头符号', () => {
  assert.equal(acp.dshModelNameOk('qwen3-max', false), true);
  assert.equal(acp.dshModelNameOk('Qwen/Qwen3', false), false);
  assert.equal(acp.dshModelNameOk('deepseek-v4:pro', false), false);
  assert.equal(acp.dshModelNameOk('Qwen/Qwen3', true), true);
  assert.equal(acp.dshModelNameOk('deepseek-v4:pro', true), true);
  for (const bad of ['', '/abs', ':x', 'a b', 'a\nb', 'x'.repeat(129), 'a/../../evil']) assert.equal(acp.dshModelNameOk(bad, true), false, bad);
});
