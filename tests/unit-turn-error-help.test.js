'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyError } = require('../renderer/turn-error-help');

const kind = text => classifyError(text)?.kind || null;

test('公司 CodeAgent 真实样本归到正确的类', () => {
  assert.equal(kind('API Error token消耗过快， 已达到4亿上限'), 'quota');
  assert.equal(kind('API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置'), 'model');
  assert.equal(kind('Error: 模型 "codeagent-mainmodel-4-5-20250929" 不存在或配置有误，请检查模型配置'), 'model');
});

test('常见英文报错归类', () => {
  assert.equal(kind('API Error: 401 {"error":{"type":"authentication_error","message":"OAuth token has expired. Please run /login"}}'), 'auth');
  assert.equal(kind('API Error: 429 {"error":{"type":"rate_limit_error","message":"Your credit balance is too low."}}'), 'quota');
  assert.equal(kind('API Error: 429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}'), 'rate');
  assert.equal(kind('API Error: 500 {"error":{"type":"api_error","message":"upstream connect error"}}'), 'service');
  assert.equal(kind('API Error: 400 {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), 'context');
  assert.equal(kind('API Error: 418 teapot'), 'other');
});

test('普通回答不算报错：只有以报错开头的段落才处理', () => {
  assert.equal(kind('这是因为 API Error: 429 表示限流'), null);
  assert.equal(kind('API Error: 401 表示登录过期，重新登录即可。'), null);
  assert.equal(kind('API Error: 429 ' + '解释'.repeat(500)), null);
  assert.equal(kind('Error handling 这段代码要改'), null);
  assert.equal(kind('模型不存在的时候怎么办？'), null);
  assert.equal(kind(''), null);
  assert.equal(kind(null), null);
});

test('每一类都给出标题、说明和至少一个能点的动作', () => {
  for (const sample of ['API Error: 401', 'API Error: 模型 "x" 不存在', 'API Error 额度', 'API Error prompt is too long', 'API Error 429', 'API Error 503', 'API Error ?']) {
    const info = classifyError(sample);
    assert.ok(info.title && info.detail && info.actions.length >= 1, sample);
  }
});

// 2026-11-21 审查：deepseek-v4.1-flash 的 403 原来落到「登录过期 → 打开账号页」——「没有…使用权限」中间限 20 字，
// 而「「deepseek-v4.1-flash」」就有 21 字。这里用代理真正会写出的句子（core/api-gateway-errors.js 同一份口径）回归。
test('API 网关：长模型名的 403 / 分组无渠道 / 下线都认成「模型用不了」，不再引去账号页', () => {
  const gatewayErrors = require('../core/api-gateway-errors');
  const FREE = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
  const body = message => JSON.stringify({ error: { message, type: 'new_api_error' } });
  const line = (status, raw, ctx) => {
    const sentence = gatewayErrors.sentence(gatewayErrors.classify({ status, body: raw, ...ctx }));
    return `API Error: ${status} ${JSON.stringify({ type: 'error', error: { type: 'permission_error', message: sentence } })}`;
  };
  for (const model of ['deepseek-v4.1-flash', 'qwen3.8-27b', 'some-very-long-model-name-2026-preview-instruct']) {
    for (const usable of [FREE, []]) {
      const ctx = { model, usable, group: 'free' };
      for (const raw of [body(`该令牌无权使用模型：${model}（模型不在白名单中）`), body('forbidden'), '']) {
        const text = line(403, raw, ctx);
        assert.equal(kind(text), 'gateway-model', text);
        assert.ok(!classifyError(text).actions.includes('accounts'), '不引去账号页');
      }
      assert.equal(kind(line(503, body(`No available channel for model ${model} under group free`), ctx)), 'gateway-model');
      assert.equal(kind(line(404, body(`model ${model} not found`), ctx)), 'gateway-model');
    }
  }
  assert.equal(kind(line(401, body('Invalid token'), {})), 'gateway-key');
  assert.equal(kind(line(403, body('用户额度不足，剩余额度：0'), { model: 'deepseek-v4.1-flash' })), 'gateway-quota');
  assert.equal(kind('API Error: 403 {"error":{"type":"permission_error","message":"Forbidden"}}'), 'auth', '非网关的 403 仍按登录失效');
});

// 2026-11-23 WeLink 反馈（v5.6.91，Codex 走公司模型）：413 原来落到兜底「可以先重试；还不行就换个模型」，上下文太长时重试没用。
test('413 / Payload Too Large / 请求太大：一行「上下文太长，公司模型拒收」，只给压缩和新开会话，不建议重试', () => {
  const { renderHelp, supportsCompact } = require('../renderer/turn-error-help');
  const samples = [
    'API Error（这一轮没有完成）: unexpected status 413 Payload Too Large: 公司模型上游返回 HTTP 413（请求太大，上下文太长，公司模型拒收）：压缩上下文后继续，或新开会话接着聊。',
    'API Error（这一轮没有完成）: unexpected status 413 Payload Too Large: 公司模型上游返回 HTTP 413（请求太大）。',
    'API Error: 413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    'API Error: Request Entity Too Large',
  ];
  for (const text of samples) {
    const info = classifyError(text);
    assert.equal(info?.kind, 'too-large', text);
    assert.equal(info.title, '上下文太长，公司模型拒收');
    assert.deepEqual(info.actions, ['compact', 'new-session']);
  }
  const info = classifyError(samples[0]);
  const esc = s => String(s);
  const codex = renderHelp(info, esc, { askHub: false, session: { kind: 'codex' } });
  assert.match(codex, /class="teh-row"/, '标题和按钮一行');
  assert.doesNotMatch(codex, /teh-detail|重试|换个模型/);
  assert.match(codex, /data-teh="compact">压缩后继续</);
  assert.match(codex, /data-teh="new-session">新开会话接着聊</);
  // 支持 /compact 的后端给压缩；不支持的（Gemini、Kimi）只给新开会话；认不出会话时保持两个按钮。
  for (const kind of ['codex', 'claude', 'codeagent']) assert.equal(supportsCompact({ kind }), true, kind);
  for (const kind of ['gemini', 'kimi']) {
    assert.equal(supportsCompact({ kind }), false, kind);
    const html = renderHelp(info, esc, { askHub: false, session: { kind } });
    assert.doesNotMatch(html, /data-teh="compact"/, kind);
    assert.match(html, /data-teh="new-session"/, kind);
  }
  assert.match(renderHelp(info, esc, { askHub: false }), /data-teh="compact"/);
});

test('其他状态码不受 413 规则影响', () => {
  assert.equal(kind('API Error: 429 {"error":{"message":"Too many requests"}}'), 'rate');
  assert.equal(kind('API Error: 500 upstream connect error'), 'service');
  assert.equal(kind('API Error: 4130 something'), 'other');
  assert.equal(kind('API Error: 400 {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), 'context');
  const other = classifyError('API Error: 418 teapot');
  assert.deepEqual(other.actions, ['retry', 'model', 'feedback']);
  // 有说明段的类也压成一行：说明进标题后的 ⓘ 悬停（隐藏的 .teh-detail 仍给求助按钮取文字），按钮文字不变。
  const html = require('../renderer/turn-error-help').renderHelp(classifyError('API Error prompt is too long'), String, { askHub: false });
  assert.match(html, /class="teh-row"/);
  assert.match(html, /class="teh-info" title="[^"]+"/);
  assert.match(html, /class="teh-detail" hidden/);
  assert.match(html, /data-teh="compact">压缩上下文</);
});

test('「新开会话接着聊」沿用报错会话的类型和目录', () => {
  const { runAction } = require('../renderer/turn-error-help');
  const card = { dataset: { sessionId: 's1' }, closest: () => null };
  let opened = null;
  const win = { __hubSessionBasics: id => (id === 's1' ? { kind: 'codex-resume', cwd: 'D:/proj', title: 'T' } : null), LaunchCenter: { open: (intent, options) => { opened = { intent, options }; } } };
  const ipcRenderer = { invoke: () => null };
  assert.equal(runAction('new-session', { card, document: {}, window: win, ipcRenderer }), true);
  assert.deepEqual(opened, { intent: 'session', options: { kind: 'codex', workspace: { path: 'D:/proj', label: 'T' } } });
  runAction('new-session', { card: { dataset: {}, closest: () => null }, document: {}, window: { LaunchCenter: win.LaunchCenter }, ipcRenderer });
  assert.deepEqual(opened.options, { kind: 'codeagent' }, '认不出会话时照旧');
});

// Codex 审查 P1/P2：压缩的发送结果不能吞掉——等 CLI 就绪、成功不打扰；失败、reject、CLI 未就绪都用错误轻提示说一行。
test('「压缩后继续」等发送结果：成功不提示；{ok:false}、reject、CLI 未就绪都给一行错误提示', async () => {
  const { runAction } = require('../renderer/turn-error-help');
  const card = { dataset: { sessionId: 's1' }, closest: () => null };
  const run = async invoke => {
    const toasts = []; const calls = [];
    const win = { HubErrorCard: { showErrorToast: (message, options) => toasts.push([message, options.sessionId]) } };
    const ok = await runAction('compact', { card, document: {}, window: win, ipcRenderer: { invoke: async (channel, args) => { calls.push([channel, args]); return invoke(); } } });
    return { ok, toasts, calls };
  };
  const good = await run(() => ({ ok: true }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.toasts, []);
  assert.equal(good.calls[0][0], 'session:send-prompt');
  assert.equal(good.calls[0][1].text, '/compact');
  assert.equal(good.calls[0][1].sessionId, 's1');
  assert.equal(good.calls[0][1].waitForCliReady, true, 'CLI 没就绪时等它');
  assert.equal((await run(() => ({ ok: false, unconfirmed: true }))).toasts.length, 0, '送达待确认不算失败');
  const failed = await run(() => ({ ok: false, message: 'CLI 还没准备好' }));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.toasts, [['压缩没有发出去：CLI 还没准备好。可以点「新开会话接着聊」', 's1']]);
  const rejected = await run(() => { throw new Error('session unavailable'); });
  assert.equal(rejected.ok, false);
  assert.match(rejected.toasts[0][0], /^压缩没有发出去：session unavailable。/);
  assert.match((await run(() => undefined)).toasts[0][0], /原因不明/);
  // 认不出会话：不发送，直接提示。
  const toasts = [];
  const none = await runAction('compact', { card: { dataset: {}, closest: () => null }, document: {}, window: { HubErrorCard: { showErrorToast: m => toasts.push(m) } }, ipcRenderer: { invoke: () => { throw new Error('不该发送'); } } });
  assert.equal(none, false);
  assert.match(toasts[0], /认不出是哪个会话/);
});
