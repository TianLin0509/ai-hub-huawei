'use strict';
// CodeAgent-Lite（共享 serve）会话中途换模型：按 serve 的模型清单认名字，不再走 /model 读屏
// （2026-11-24 WeLink 2 人反馈：v5.6.94 / 97 日志 pick-menu-failed「当前 CodeAgent 模型菜单的布局无法自动识别」）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { CodeAgentServeClient } = require('../core/codeagent-serve-client');

// /api/v2/config/providers 的回包按公司真机 1.2615.02.03 的结构（providers[].models 是 id → 详情的表，带 status）。
const PROVIDERS = { providers: [
  { id: 'w3', name: 'Built-in', status: 'available', models: {
    'glm-5.3-flash': { id: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash' },
    'deepseek-v4.1-flash-1017': { id: 'deepseek-v4.1-flash-1017', display_name: 'DeepSeek-V4.1-Flash-1017' },
    'qwen3.8-27b': { id: 'qwen3.8-27b', display_name: 'Qwen3.8-27B' },
  } },
  { id: 'team-a', name: 'Team A', status: 'unavailable', models: { 'glm-5.2-wx-auto': { id: 'glm-5.2-wx-auto' } } },
] };

async function fakeServe(t, { status = 200, body = PROVIDERS } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url.startsWith('/api/v2/config/providers')) { res.writeHead(status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(body)); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new CodeAgentServeClient({ host: { port: server.address().port, token: 't' }, cwd: __dirname, model: 'deepseek-v4.1-flash-1017', provider: 'w3' });
  return { client, calls };
}

test('Lite: 菜单显示名或简写都能对到 serve 清单里的 id（统一模型名匹配）', async t => {
  const { client } = await fakeServe(t);
  const hit = await client.switchModel('GLM5.3');
  assert.equal(hit.id, 'glm-5.3-flash');
  assert.equal(client.model, 'glm-5.3-flash');
  assert.equal(client.provider, 'w3');
  assert.equal((await client.switchModel('DeepSeek-V4.1-Flash-1017')).id, 'deepseek-v4.1-flash-1017');
  assert.equal((await client.switchModel('qwen3.8-27b')).kind, 'exact');
});

test('Lite: 清单里没有（本人没权限的模型）时一行人话说明，且不改当前模型', async t => {
  const { client } = await fakeServe(t);
  // 同家族只有别的版本：与 PTY 菜单同一口径，不自动替换、说明一行。
  await assert.rejects(client.switchModel('GLM-5.2-WX-Auto'), error => {
    assert.equal(error.code, 'model-name-fallback');
    assert.match(error.message, /模型清单里没有 GLM-5.2-WX-Auto（同家族只有 glm-5.3-flash.*模型没有切换（仍用 deepseek-v4.1-flash-1017），请直接选具体的一个/);
    assert.doesNotMatch(error.message, /布局|不在模型列表|沿用账号默认模型/);
    return true;
  });
  // 完全没有同家族：列出可选项请换一个。
  await assert.rejects(client.switchModel('kimi-k3'), error => {
    assert.equal(error.code, 'model-not-listed');
    assert.match(error.message, /模型清单里没有 kimi-k3，请换一个（可选：GLM-5.3-Flash、/);
    return true;
  });
  assert.equal(client.model, 'deepseek-v4.1-flash-1017', '失败时保留原模型，不悄悄按服务端默认发');
});

test('Lite: 同版本多条候选分不清时说明是几条线路，不报「清单里没有」', async t => {
  const { client } = await fakeServe(t, { body: { providers: [{ id: 'w3', status: 'available', models: {
    a: { id: 'glm-5.3-flash', display_name: 'GLM-5.3-Flash' }, b: { id: 'glm-5.3-air', display_name: 'GLM-5.3-Air' } } }] } });
  await assert.rejects(client.switchModel('GLM-5.3'), error => {
    assert.equal(error.code, 'model-name-fallback');
    assert.match(error.message, /同版本有多条线路（glm-5.3-flash、glm-5.3-air）/);
    assert.doesNotMatch(error.message, /请换一个（可选/);
    return true;
  });
});

test('Lite: 内部 id 认不出时按显示名再认一次', async t => {
  const { client } = await fakeServe(t, { body: { providers: [{ id: 'w3', status: 'available', models: {
    x: { id: 'maas-glm-5-3-260814', display_name: 'GLM-5.3-Flash' } } }] } });
  assert.equal((await client.switchModel('GLM-5.3')).id, 'maas-glm-5-3-260814');
});

test('Lite: 指定线路只在这条线路里找；线路不在就报错，不换到别的线路', async t => {
  const body = { providers: [
    { id: 'w3', status: 'available', models: { a: { id: 'glm-5.3-flash' } } },
    { id: 'ascend', status: 'available', models: { a: { id: 'glm-5.3-flash' } } },
  ] };
  const { client } = await fakeServe(t, { body });
  assert.equal((await client.switchModel('glm-5.3-flash', 'ascend')).provider, 'ascend');
  assert.equal(client.provider, 'ascend');
  // 没指定线路、同一 id 挂两条线路：取清单里靠前那条，不误报「没有」。
  assert.equal((await client.switchModel('glm-5.3-flash')).provider, 'w3');
  await assert.rejects(client.switchModel('glm-5.3-flash', 'my-provider'), error => error.code === 'model-route-unavailable' && /没有报出线路 my-provider，模型没有切换/.test(error.message));
  assert.equal(client.provider, 'w3');
});

test('Lite: 读不到模型清单时说明原因、不切换', async t => {
  const { client } = await fakeServe(t, { status: 500, body: { error: 'x' } });
  await assert.rejects(client.switchModel('glm-5.3-flash'), /读不到 CodeAgent 的模型清单（HTTP 500），模型没有切换/);
  assert.equal(client.model, 'deepseek-v4.1-flash-1017');
});

test('Lite: serve 会话的 configure 中途换模型走清单校验，返回菜单显示名', async t => {
  const { client } = await fakeServe(t);
  const { CodeAgentServeSession } = require('../core/codeagent-serve-session');
  const session = Object.create(CodeAgentServeSession.prototype);
  Object.assign(session, { client, options: {}, active: null, bootstrapping: true, start: async () => {}, persist() {}, emit() {} });
  const result = await session.configure({ model: 'GLM5.3' });
  assert.equal(result.modelId, 'glm-5.3-flash');
  assert.equal(result.displayName, 'GLM-5.3-Flash');
  assert.equal(result.matchKind, 'similar');
  await assert.rejects(session.configure({ model: 'kimi-k3' }), /模型清单里没有 kimi-k3，请换一个/);
  // 显示名带括号或线路前缀不在前置校验就被拦：交给清单去认，报的是清单结果。
  await assert.rejects(session.configure({ model: 'Kimi-K3(Volcano-MaaS)' }), /模型清单里没有 Kimi-K3\(Volcano-MaaS\)/);
  await assert.rejects(session.configure({ model: 'bad\nname' }), /模型名称无效/);
  assert.equal(session.currentModel, 'glm-5.3-flash');
});

test('Lite: 主进程换模型先分流到 serve，不再打开 /model 菜单读屏', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
  const body = source.slice(source.indexOf('async function switchCodeAgentModel('));
  const serveAt = body.indexOf("session.codeagentRunMode === 'serve' && !!sessionManager.getNativeSession");
  const menuAt = body.indexOf('codeagentPicker.schedulePick(');
  assert.ok(serveAt > 0 && menuAt > serveAt, 'serve 分流在菜单选择之前');
  assert.match(source, /async function switchCodeAgentServeModel\([\s\S]*?native\.configure\(\{ model: modelId, provider \}\)/);
});

test('Lite: qwen 等 serve 清单里的模型不被「别的 CLI 模型」归一拦下；启动不留待选标记；首条消息与通道修复都走 serve', () => {
  const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const handlers = read('main/ipc/session-handlers.js');
  assert.ok(handlers.includes('const modelId = serveRuntime ? requested : models.normalizeModel(requested)'));
  assert.ok(handlers.includes('serveFix ? { ...serveFix, model: serveFix.model?.id || target }'));
  const serveFn = handlers.slice(handlers.indexOf('async function switchCodeAgentServeModel('), handlers.indexOf('async function switchCodeAgentModel('));
  assert.ok(serveFn.includes('recordReplacement(dataDir, pausedFrom, chosen)'), '暂停后选的替代模型要记下');
  const manager = read('core/session-manager.js');
  assert.ok(manager.includes('codeagentModelPick: !isCodeAgentServe && codeagentLaunch.requiresMenu'));
  const ready = manager.slice(manager.indexOf('async ensureSessionModelReady('));
  const serveAt = ready.indexOf("info.codeagentRunMode === 'serve' && this.getNativeSession(sessionId)");
  assert.ok(serveAt > 0 && serveAt < ready.indexOf("this.emit('codeagent-model-pick'"), 'serve 分支在 /model 读屏之前');
});
