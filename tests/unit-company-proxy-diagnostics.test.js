'use strict';
// 公司模型反代的诊断文字（2026-11-17 反馈）：403 讲清常见原因、不让人去 Claude Code 里 /login；
// 上游错误体多认几种写法；流式回包记下分块数和时间，好判断上游是不是一次性吐出。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = name => import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', name)).href);

test('401 / 403 分开讲，都提示不用在 Claude Code 里 /login', async () => {
  const { upstreamHttpMessage } = await load('failure-text.mjs');
  const m403 = upstreamHttpMessage(403, '错误码 40301');
  assert.match(m403, /^公司模型上游返回 HTTP 403（公司服务拒绝了这次调用，常见是登录已在别处失效、账号没有这个模型的权限或额度用完）：错误码 40301。/);
  assert.match(m403, /先在 CodeAgent 里用同一个模型发一句试试.*不用在 Claude Code 里运行 \/login/);
  assert.match(upstreamHttpMessage(401), /公司服务不认这次登录.*重新登录.*不用在 Claude Code 里运行 \/login/);
  assert.equal(upstreamHttpMessage(500), '公司模型上游返回 HTTP 500（公司服务端出错）。');
  assert.equal(upstreamHttpMessage(429), '公司模型上游返回 HTTP 429（限流）。');
});

// 2026-11-23 WeLink 反馈：413 是上下文太长，原样重发还是 413，所以说清原因、给压缩和新开会话两个出口，不提重试。
test('413 讲成上下文太长，给压缩 / 新开会话，不建议重试', async () => {
  const { upstreamHttpMessage } = await load('failure-text.mjs');
  const m = upstreamHttpMessage(413);
  assert.equal(m, '公司模型上游返回 HTTP 413（请求太大，上下文太长，公司模型拒收）。压缩上下文后继续，或新开会话接着聊。');
  assert.doesNotMatch(m, /重试|换模型/);
});

test('上游错误体：多种字段、只有错误码、网页回包都能说出一句；地址与主机名照旧去掉', async () => {
  const { safeUpstreamDetail: d } = await load('failure-text.mjs');
  assert.equal(d('{"errorMessage":"token invalid"}'), 'token invalid');
  assert.equal(d('{"error_msg":"no permission for model"}'), 'no permission for model');
  assert.equal(d('{"data":{"msg":"额度已用完"}}'), '额度已用完');
  assert.equal(d('{"code":"QUOTA_EXCEEDED"}'), '错误码 QUOTA_EXCEEDED');
  assert.equal(d('{"code":40301}'), '错误码 40301');
  assert.match(d('<!DOCTYPE html><html><body>blocked</body></html>'), /网关或防火墙/);
  assert.equal(d('{"message":"see https://inner.example.com/x at node-1.a.b"}'), 'see at');
  assert.equal(d('plain text'), '');
});

test('流式回包结束时报告分块数与首末块时间', async () => {
  const { releaseOnEnd } = await load('server.mjs');
  const enc = new TextEncoder();
  const upstream = new Response(new ReadableStream({ async start(c) {
    for (const t of ['a', 'b', 'c']) { c.enqueue(enc.encode(t)); await new Promise(r => setTimeout(r, 30)); } c.close(); } }));
  let timing = null;
  assert.equal(await releaseOnEnd(upstream, t => { timing = t; }).text(), 'abc');
  assert.equal(timing.chunks, 3);
  assert.ok(timing.firstMs >= 0 && timing.lastMs >= timing.firstMs + 40, JSON.stringify(timing));
});

// r38b 审查 P1：上游错误原因会写进 diagnostics/company-model-proxy.log，回显的凭据和个人字段先脱敏。
const FAKE = 'Authorization: Bearer AUDIT_FAKE_SECRET; api_key=AUDIT_FAKE_KEY; employee=12345678';
const LEAKS = /AUDIT_FAKE_SECRET|AUDIT_FAKE_KEY|12345678|AUDITFAKEKEY9f8e7d6c5b4a39281706|zhang\.san@corp|a00123456|eyJhbGciOiJIUzI1NiJ9/;

test('上游错误原因里的凭据、账号字段先脱敏，原因本身保留', async () => {
  const { safeUpstreamDetail: d } = await load('failure-text.mjs');
  const fake = d(JSON.stringify({ errorMessage: FAKE }));
  assert.doesNotMatch(fake, LEAKS);
  assert.equal(fake, "Authorization: <已隐去>; api_key=<已隐去>; employee=<已隐去>");
  for (const body of [
    { message: 'invalid x-api-key: AUDITFAKEKEY9f8e7d6c5b4a39281706' },
    { msg: '用户 zhang.san@corp.example 工号：a00123456 无权限' },
    { error: { message: 'token "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl" expired' } },
    { errorMessage: 'cookie=SESSION=abcdEFGH1234; password: hunter2pass' },
  ]) assert.doesNotMatch(d(JSON.stringify(body)), /AUDITFAKEKEY|zhang\.san|a00123456|eyJ|abcdEFGH1234|hunter2pass/, JSON.stringify(body));
  assert.equal(d('{"message":"model glm-5 quota exceeded, retry after 60s"}'), 'model glm-5 quota exceeded, retry after 60s');
  assert.equal(d('{"code":40301}'), '错误码 40301');
});

// r38b 复审 P1（二次返工）：多项 Cookie 的后续会话值、引号里带空格的密码、各种 token / session 名都要遮住。
const COOKIE = 'Cookie: theme=light; SESSION=AUDIT_FAKE_COOKIE; JSESSIONID=AUDIT_FAKE_SESSION';
const LEAKS2 = /AUDIT_FAKE|hunter|AUDIT_\w/;
test('Cookie / Set-Cookie 每一项、Authorization 各种方案、token / session 类字段都遮住，普通原因保留', async () => {
  const { safeUpstreamDetail: d, redactSecrets: r } = await load('failure-text.mjs');
  assert.equal(d(JSON.stringify({ errorMessage: COOKIE })), 'Cookie: <已隐去>');
  for (const text of [
    COOKIE,
    'Set-Cookie: SESSION=AUDIT_A; Path=/; HttpOnly',
    '{"Cookie":"a=AUDIT_B; b=AUDIT_C"}',
    'theme=light; SESSION=AUDIT_D; JSESSIONID=AUDIT_E; PHPSESSID=AUDIT_F; sid=AUDIT_G',
    'password: "hunter two pass" rejected',
    '{"password":"hunter two pass","x-csrf-token":"AUDIT_H"}',
    'Authorization: Digest username="AUDIT_I", realm="r", response="AUDIT_J"',
    'Proxy-Authorization: Basic AUDIT_K',
    'access_token=AUDIT_L&refresh_token=AUDIT_M',
    'x-auth-token: AUDIT_N; ticket=AUDIT_O; jwt=AUDIT_P',
  ]) {
    assert.doesNotMatch(r(text), LEAKS2, text);
    assert.doesNotMatch(d(JSON.stringify({ errorMessage: text })), LEAKS2, text);
  }
  assert.equal(r('password: "hunter two pass" rejected'), 'password: "<已隐去>" rejected');
  for (const plain of ['token invalid', 'session expired, please login', 'max_tokens: 200000 exceeds limit'])
    assert.equal(d(JSON.stringify({ errorMessage: plain })), plain);
});

test('经真实本地 HTTP 反代：多项 Cookie 不进日志也不回给界面', async () => {
  const { createProxy } = await load('transport.mjs');
  const logged = [];
  const proxy = createProxy({ accessKey: 'audit-local-key-for-unit-test',
    provider: { listModels: async () => ['audit'], complete: async () => new Response(JSON.stringify({ errorMessage: COOKIE }), { status: 403 }) },
    onEvent: e => { if (e.type === 'request_finished' && e.detail) logged.push(`upstream HTTP ${e.status} reason: ${e.detail}`); } });
  const addr = await proxy.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: 'Bearer audit-local-key-for-unit-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'audit', stream: true, messages: [] }) });
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.deepEqual(logged, ['upstream HTTP 403 reason: Cookie: <已隐去>']);
    assert.doesNotMatch(body, /AUDIT_FAKE/);
    assert.match(body, /Cookie: <已隐去>/);
  } finally { await proxy.close(); }
});

test('经真实本地 HTTP 反代：回给界面的报错和写日志的原因都没有假凭据', async () => {
  const { createProxy } = await load('transport.mjs');
  const logged = [];
  const proxy = createProxy({ accessKey: 'audit-local-key-for-unit-test',
    provider: { listModels: async () => ['audit'], complete: async () => new Response(JSON.stringify({ errorMessage: FAKE }), { status: 403 }) },
    onEvent: e => { if (e.type === 'request_finished' && e.detail) logged.push(`upstream HTTP ${e.status} reason: ${e.detail}`); } });
  const addr = await proxy.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: 'Bearer audit-local-key-for-unit-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'audit', stream: true, messages: [] }) });
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^upstream HTTP 403 reason: Authorization: /);
    assert.doesNotMatch(logged[0], LEAKS);
    assert.doesNotMatch(body, LEAKS);
  } finally { await proxy.close(); }
});
