'use strict';
// 「首次签名初始化没完成 / 模型清单为空」（反馈 2026-11-24/25，3 人 + 1 条日志，v5.6.94–105）：
// CodeAgent 账号没开通任何内置模型权限时，签名探测被拒、serve 清单为空、读屏超时。Hub 代办不了权限，
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const loadProfile = () => import(pathToFileURL(path.join(root, 'core', 'company-proxy', 'upstream-profile.mjs')).href);

test('签名探测：两个候选模型都被拒时，写出真实试过的两个模型，并把原因说到账号权限和自有 API 上', async () => {
  const { signerInitFailureMessage } = await loadProfile();
  const msg = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_MODEL_REJECTED', report: {
    model: 'Model-B', retried: true, attempts: [{ model: 'Model-A', error: 'CLI_MODEL_REJECTED' }, { model: 'Model-B', error: 'CLI_MODEL_REJECTED' }] } });
  assert.match(msg, /CodeAgent 认为没有可用的模型/);
  assert.match(msg, /先后指定了模型 Model-A、Model-B，都被拒绝/);
  assert.match(msg, /没开通内置模型权限/);
  assert.match(msg, /找本部门负责人申请/);
  assert.match(msg, /「设置 → 自有 API」接部门 API 网关/);
});

test('签名探测：候选只有一个、重试用的是同一个模型时，不说「换了一个模型」', async () => {
  const { signerInitFailureMessage } = await loadProfile();
  const msg = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_MODEL_REJECTED', report: {
    model: 'Model-A', retried: true, attempts: [{ model: 'Model-A' }, { model: 'Model-A' }] } });
  assert.doesNotMatch(msg, /换了一个模型/);
  assert.match(msg, /已指定模型 Model-A，又重试了一次，仍被拒绝/);
  const once = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_MODEL_REJECTED', report: { model: 'Model-A' } });
  assert.match(once, /已指定模型 Model-A，仍被拒绝/);
});

test('错误卡：没有可用模型的报错认成 codeagent-no-model，主按钮打开自有 API，而不是「公司模型反代没能启动」', async () => {
  const { signerInitFailureMessage } = await loadProfile();
  const { matchKnownIssue } = require('../core/known-issues');
  const details = '创建失败：' + signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_MODEL_REJECTED', report: { model: 'Model-A' } });
  for (const area of ['session-create', 'company-proxy', 'hub-alert']) {
    const m = matchKnownIssue({ area, details });
    assert.equal(m?.id, 'codeagent-no-model', area);
    assert.equal(m.action.act, 'known:open-company-api');
  }
  const { humanizeError } = require('../core/error-humanize');
  assert.equal(humanizeError(details)?.kind, 'codeagent-no-model');
  // 其他签名失败仍走原来的分类，不被新条目抢走。
  const other = '公司模型暂时用不了：首次签名初始化没完成（CodeAgent 命令行在 60 秒内没有结束）。';
  assert.notEqual(matchKnownIssue({ area: 'session-create', details: other })?.id, 'codeagent-no-model');
  const src = fs.readFileSync(path.join(root, 'renderer', 'hub-error-card.js'), 'utf8');
  assert.ok(src.includes("'known:open-company-api'"), '渲染层实现了打开自有 API 的动作');
  assert.match(src, /win\.__companyApiOpen\('claude'\)/);
  assert.match(fs.readFileSync(path.join(root, 'renderer', 'company-api-settings.js'), 'utf8'), /window\.__companyApiOpen = open;/);
});

test('读模型清单：serve 给空清单、读屏也失败时，换成说清原因与下一步的一句话；要重新登录时登录优先', () => {
  const probe = require('../core/codeagent-model-probe');
  const { SERVE_EMPTY_MODELS } = require('../core/codeagent-serve');
  const msg = probe.describeModelReadFailure(SERVE_EMPTY_MODELS, 'CodeAgent 输入框没有出现（超时）');
  assert.equal(msg, probe.EMPTY_MODELS_HINT);
  assert.match(msg, /CodeAgent 账号读不到任何可用模型/);
  assert.ok(msg.length <= 200, '目录里的失败原因只留 200 字，提示要完整放得下');
  const { matchKnownIssue } = require('../core/known-issues');
  assert.equal(matchKnownIssue({ area: 'codeagent', details: msg })?.id, 'codeagent-no-model');
  assert.equal(probe.describeModelReadFailure(SERVE_EMPTY_MODELS, '这个号需要重新登录'), `${SERVE_EMPTY_MODELS}；这个号需要重新登录`);
  assert.equal(probe.describeModelReadFailure('读模型清单失败：timeout', '模型探测超时'), '读模型清单失败：timeout；模型探测超时');
  assert.equal(probe.describeModelReadFailure('', '模型探测超时'), '模型探测超时');
});

test('读模型清单：主进程用 describeModelReadFailure 拼失败原因', () => {
  const src = fs.readFileSync(path.join(root, 'main', 'ipc', 'session-handlers.js'), 'utf8');
  assert.match(src, /throw new Error\(probe\.describeModelReadFailure\(serveError, result\.error\)\)/);
});
