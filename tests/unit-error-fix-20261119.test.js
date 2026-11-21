'use strict';
// 「出错就地一键修」（2026-11-19 负责人勾选体验第 5 项）：CLI 已退出、签名没完成、模型不存在、登录失效等报错卡
// 统一成「原因一句话 + 一个对症按钮」；认不出时主按钮是「一键反馈（带日志）」；给「问问 Hub」留插槽。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const card = require('../renderer/hub-error-card');
const { humanizeError } = require('../core/error-humanize');

const ENV = { feedback: true, ask: { ok: true } };
const primary = html => (/<button type="button" class="hub-err-btn primary" data-hub-err-act="([^"]+)">([^<]+)<\/button>/.exec(html) || []).slice(1);
const buttons = html => [...html.matchAll(/class="hub-err-btn[^"]*" data-hub-err-act="([^"]+)"/g)].map(m => m[1]);

test('报错翻译表：三类会话报错各有对症动作', () => {
  const cases = [
    ['CLI 已退出到系统终端，消息未发送；请先重启会话', 'cli-exited', 'known:session-restart', '重启会话'],
    ['CLI 已退出到命令行，消息可能没有被接收，未补回车', 'cli-exited', 'known:session-restart', '重启会话'],
    ['公司模型暂时用不了：首次签名初始化没完成（CodeAgent 命令行在 60 秒内没有结束）。', 'signer-init', 'known:proxy-restart', '重新启动模型通道'],
    ['API Error: 400 模型不存在或配置有误', 'model-missing', 'known:switch-model', '换模型'],
    ['API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}', 'model-missing', 'known:switch-model', '换模型'],
    ['The model `gpt-9` does not exist or you do not have access to it.', 'model-missing', 'known:switch-model', '换模型'],
    ['Request failed with status 401 Unauthorized', 'auth', 'known:open-accounts', '重新登录'],
  ];
  for (const [raw, kind, act, label] of cases) {
    const info = humanizeError(raw);
    assert.equal(info && info.kind, kind, raw);
    assert.deepEqual(info.action, { label, act }, raw);
    assert.ok(info.cause && !/\n/.test(info.cause), '原因一句话：' + raw);
  }
  assert.equal(humanizeError('connect ETIMEDOUT 10.0.0.1:443').action, null, '没有对症动作的照旧');
});

test('错误卡：对症按钮当主按钮，原因一句话，不再叠步骤', () => {
  const html = card.html({ area: 'session', details: 'CLI 已退出到系统终端，消息未发送；请先重启会话' }, ENV);
  assert.deepEqual(primary(html), ['known:session-restart', '重启会话']);
  assert.match(html, /<div class="hub-err-title">CLI 已经退出了<\/div>/);
  assert.match(html, /hub-err-cause">这个会话里的 Agent 命令行程序已经结束/);
  assert.doesNotMatch(html, /hub-err-steps/);
  const model = card.html({ area: 'model-service', details: 'API Error: 400 模型不存在或配置有误' }, ENV);
  assert.deepEqual(primary(model), ['known:switch-model', '换模型']);
});

test('错误卡：已知问题优先（解法即原因，不叠笼统翻译）；调用方自己的按钮排在后面', () => {
  const html = card.html({ area: 'session-create', details: '创建失败：公司模型暂时用不了：首次签名初始化没完成（CodeAgent 命令行跑完了，但没有留下签名信息：签名日志没有生成）。\n本次探测约 10.2 秒后 CodeAgent 就退出了（退出码 1），未生成签名日志。',
    actions: [{ label: '关闭', act: 'close' }] }, ENV);
  assert.deepEqual(buttons(html), ['known:codeagent-personal-login', 'known:proxy-restart', 'close']);
  assert.match(html, /data-known-issue="codeagent-account-unusable"/);
  assert.doesNotMatch(html, /hub-err-cause/, '已知解法那句就是原因');
});

test('错误卡：认不出的报错主按钮是「一键反馈（带日志）」；有调用方按钮或没有反馈入口时不加', () => {
  const html = card.html({ area: 'session', details: '完全看不懂的错误 0xdeadbeef' }, ENV);
  assert.deepEqual(primary(html), ['known:feedback', '一键反馈（带日志）']);
  assert.deepEqual(buttons(card.html({ area: 'session', details: '完全看不懂的错误', actions: [{ label: '重试', act: 'retry' }] }, ENV)), ['retry']);
  assert.deepEqual(buttons(card.html({ area: 'session', details: '完全看不懂的错误' }, { feedback: false, ask: { ok: true } })), []);
  assert.deepEqual(buttons(card.html({ area: 'session', details: '完全看不懂的错误', severity: 'warning' }, ENV)), [], '提醒类不加');
});

test('错误卡：每张都给「问问 Hub」留插槽；动作在渲染层有实现', () => {
  for (const details of ['CLI 已退出到系统终端', '完全看不懂的错误', '']) {
    assert.match(card.html({ area: 'session', title: 't', details }, ENV), /<span class="hub-err-slot" data-hub-err-slot="ask-hub"><\/span>/);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-error-card.js'), 'utf8');
  for (const act of ['known:session-restart', 'known:switch-model', 'known:feedback', 'known:proxy-restart', 'known:open-accounts', 'known:codeagent-personal-login']) {
    assert.ok(src.includes(`'${act}'`), act);
  }
  assert.match(src, /await win\.__hubRestartSessionInPlace\(sessionId\)/, '和右键「重启」同一条路，聊天框不消失');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8'), /window\.__hubRestartSessionInPlace = restartSessionInPlace;/);
  assert.match(src, /\.composer-model`\)/);
});

test('错误卡：认不出的报错也有一句原因，告诉用户点一键反馈', () => {
  const html = card.html({ area: 'session', details: 'API Error: something odd happened (code 0x5e)' }, ENV);
  assert.match(html, /hub-err-cause">Hub 认不出这个报错的具体原因。点「一键反馈（带日志）」/);
});

test('Codex 复审 P2：签名失败但 Hub 已停止重试时不给「重新启动模型通道」，主按钮是一键反馈', () => {
  for (const tail of ['后台进程还没确认结束，Hub 已停止重试；请点「一键反馈」附带诊断。', 'Hub 已尝试通过命令行参数补发输入，仍然没有送达；请直接点「一键反馈」附带诊断。']) {
    const raw = '公司模型暂时用不了：首次签名初始化没完成（CodeAgent 命令行跑完了，但没有留下签名信息）。\n' + tail;
    assert.equal(humanizeError(raw), null);
    assert.deepEqual(buttons(card.html({ area: 'session-create', details: raw }, ENV)), ['known:feedback']);
  }
});

test('Codex 复审 P2：一键动作只作用在报错所属的会话，轻提示带上来源会话，没有归属时不猜', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-error-card.js'), 'utf8');
  assert.match(src, /function errorSessionId\(button\) \{\r?\n  return button\.closest\?\.\('\[data-session-id\]'\)\?\.dataset\.sessionId \|\| '';/);
  assert.match(src, /if \(sessionId\) el\.dataset\.sessionId = String\(sessionId\);/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok((renderer.match(/'error', \{ sessionId \}\);/g) || []).length >= 4, '发送失败的提示都带会话');
});
