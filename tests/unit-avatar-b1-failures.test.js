'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentSessions, normalizeFailure } = require('../core/avatar/agent-session');

const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

test('裸英文和过短摘要统一中文人话，诊断原文仍留 raw，中文有效摘要保留', () => {
  for (const [message, fields, options] of [
    ['success', {}, { source: 'welink' }], ['405 Method Not Allowed', {}, {}],
    ['429 Too Many Requests', {}, {}], ['401 Unauthorized', {}, {}],
    ['bad key', { apiGatewayRoute: true, status: 401 }, {}], ['失效', {}, {}],
    ['method_not_allowed', { apiGatewayRoute: true, status: 405, line: 'success' }, {}],
  ]) {
    const f = normalizeFailure(failure(message, fields), options);
    assert.match(f.headline, /[\u4e00-\u9fff]/); assert.ok(f.headline.replace(/\s/g, '').length >= 4);
    assert.ok(f.raw.includes(message)); assert.notEqual(f.headline, message);
  }
  assert.equal(normalizeFailure(failure('模型没有访问权限，请检查账号')).headline, '模型没有访问权限，请检查账号');
});

test('分身错误按真实通路分类：八类原因各有有效修复动作', () => {
  const cases = [
    [failure('405 Method Not Allowed', { apiGatewayRoute: true }), {}, 'gateway_405', 'open_model_settings'],
    [failure('405 Method Not Allowed'), {}, 'provider_405', 'open_model_settings'],
    [failure('401 Invalid token', { apiGatewayRoute: true }), {}, 'gateway_401', 'open_model_settings'],
    [failure('Agent 尚未登录或授权已失效'), {}, 'agent_not_logged_in', 'open_account_page'],
    [failure('没有这个模型的权限 403'), {}, 'model_unavailable', 'open_account_card'],
    [failure('WeLink 限流', { code: 'WELINK_RATE_LIMITED' }), { source: 'welink' }, 'welink_rate_limit', 'retry_tick'],
    [failure('Token expired'), { source: 'welink' }, 'welink_expired', 'welink_login'],
    [failure('429 Too Many Requests'), {}, 'model_rate_limit', 'retry_tick'],
  ];
  for (const [error, options, code, kind] of cases) {
    const result = normalizeFailure(error, { ...options, now: 123 });
    assert.equal(result.code, code, code);
    assert.equal(result.at, 123);
    assert.equal(result.actions[0].kind, kind, code);
    assert.ok(result.headline && result.raw);
  }
});

test('只有 WeLink 队列限流有固定30秒和两次预算，模型429没有虚构自动重试', () => {
  const welink = normalizeFailure(failure('429 Too Many Requests'), { source: 'welink' });
  const model = normalizeFailure(failure('429 Too Many Requests'));
  const gateway = normalizeFailure(failure('429 Too Many Requests', { apiGatewayRoute: true }));
  assert.equal(welink.retryAfterMs, 30000); assert.equal(welink.retryMax, 2);
  for (const f of [model, gateway]) {
    assert.equal(f.code, 'model_rate_limit');
    assert.equal(f.retryAfterMs, 0); assert.equal(f.retryMax, 0);
    assert.equal(f.retryable, true);
  }
});

test('读取和巡检异常分开归类，登录过期不被当作模型鉴权', () => {
  assert.equal(normalizeFailure(failure('业务返回失败，无历史消息结构'), { source: 'welink' }).code, 'read_failed');
  assert.equal(normalizeFailure(failure('state write failed'), { source: 'tick' }).code, 'tick_error');
  const r = normalizeFailure(failure('401 Unauthorized'), { source: 'welink' });
  assert.equal(r.code, 'welink_expired');
  assert.equal(r.actions[0].kind, 'welink_login');
});

test('供应商修复只在有手动成功记录时提供，缺记录绝不展示一键改用', () => {
  for (const canUseManual of [true, false, undefined]) {
    const error = failure('供应商接口不接受对话请求 405', { providerRepair: { canUseManual, account: 'synthetic-pool' }, actions: [{ kind: 'provider_repair', label: '不应盲目使用' }] });
    const result = normalizeFailure(error);
    assert.equal(result.actions[0].kind, canUseManual === true ? 'provider_repair' : 'open_model_settings');
    if (canUseManual === true) assert.deepEqual(result.actions[0].payload, { account: 'synthetic-pool' });
  }
});

test('网关原动作完整映射为分身动作并去重，保留重试语义', () => {
  const error = failure('网关不可用', { apiGatewayRoute: true, gatewayFailure: {
    code: 'method_not_allowed', line: '网关地址不接受请求', retryable: false,
    actions: ['gateway-settings', 'model', 'retry', 'gateway-settings'],
  } });
  const result = normalizeFailure(error);
  assert.equal(result.code, 'gateway_405'); assert.equal(result.retryable, false);
  assert.equal(result.headline, '网关地址不接受请求');
  assert.deepEqual(result.actions.map(a => a.kind), ['open_model_settings', 'open_account_card', 'retry_tick']);
});

test('上游已结构化的动作保留聚焦字段与安全payload，错误摘要打码', () => {
  const input = { kind: 'open_account_card', label: '换模型', highlight: 'gateway', payload: { model: 'synthetic-model' } };
  const r = normalizeFailure(failure('API request failed Bearer synthetic-sensitive-value', { actions: [input] }));
  assert.deepEqual(r.actions, [input]);
  assert.ok(!r.raw.includes('synthetic-sensitive-value'));
  assert.ok(!r.headline.includes('synthetic-sensitive-value'));
});

test('ask发送失败保留code、原始修复动作和retryable，不只留message', async () => {
  const error = failure('所选模型不可用', { code: 'MODEL_GONE', retryable: false, actions: ['model'], providerRepair: { canUseManual: false } });
  const sessions = new AgentSessions({ getSession: () => ({}), lastFinal: () => null, sendPrompt: async () => { throw error; } });
  await assert.rejects(() => sessions.ask({ id: 'synthetic-session' }, 'synthetic.json'), e =>
    e.code === 'MODEL_GONE' && e.retryable === false && e.actions[0] === 'model' && e.providerRepair.canUseManual === false && e.restart);
});

test('网关ask失败保留上游code/line/retryable/actions，并能归一到就地修复', async t => {
  const errors = require('../core/company-assistant/turn-api-error');
  const route = require('../core/assistant-gateway-route');
  const upstream = { code: 'method_not_allowed', line: '部门 API key（网关）：接口拒绝 HTTP 405', retryable: false, actions: ['gateway-settings', 'model'] };
  t.mock.method(route, 'gatewayFailure', () => upstream);
  let n = 0, clock = 0;
  t.mock.method(errors, 'lastApiError', () => (n++ === 0 ? null : { id: 'synthetic-error', text: '405 Method Not Allowed' }));
  const sessions = new AgentSessions({ now: () => (clock += 5000), pollMs: 1,
    getSession: () => ({ apiGatewayRoute: true, transcriptPath: 'synthetic-not-a-file' }),
    sendPrompt: async () => ({ ok: true }), lastFinal: () => null, readTurnApiError: () => null });
  await assert.rejects(() => sessions.ask({ id: 'synthetic-session' }, 'synthetic.json', { timeoutMs: 600000 }), e => {
    assert.equal(e.code, upstream.code); assert.equal(e.line, upstream.line); assert.equal(e.retryable, false);
    assert.deepEqual(e.actions, upstream.actions); assert.deepEqual(e.gatewayFailure.actions, upstream.actions);
    assert.equal(normalizeFailure(e).code, 'gateway_405');
    assert.equal(normalizeFailure(e).actions[0].kind, 'open_model_settings');
    return true;
  });
});

test('账号已切换时不发旧任务，等待中切换也不交付迟到结果', async () => {
  let sends = 0;
  const deps = { getSession: () => ({}), sendPrompt: async () => { sends++; return { ok: true }; }, lastFinal: () => null };
  await assert.rejects(() => new AgentSessions(deps).ask({ id: 'synthetic-session' }, 'synthetic.json', { isCurrent: () => false }), e => e.code === 'AVATAR_STALE_OWNER' && e.notSent);
  assert.equal(sends, 0);
  let current = true;
  const session = new AgentSessions({ ...deps, sendPrompt: async () => { sends++; current = false; return { ok: true }; } });
  await assert.rejects(() => session.ask({ id: 'synthetic-session' }, 'synthetic.json', { isCurrent: () => current }), e => e.code === 'AVATAR_STALE_OWNER' && e.notSent === false);
  assert.equal(sends, 1);
});

test('普通成功final仍按同一回执标记返回，未改变现有协议', async () => {
  let final;
  const sessions = new AgentSessions({ getSession: () => ({}), lastFinal: () => final,
    sendPrompt: async (_id, prompt) => { final = { text: '[{"id":"synthetic-item","action":"remind"}]\n' + prompt.match(/\[分身回执:[^\]]+\]/)[0] }; return { ok: true }; } });
  assert.equal(await sessions.ask({ id: 'synthetic-session' }, 'synthetic.json'), '[{"id":"synthetic-item","action":"remind"}]');
});
