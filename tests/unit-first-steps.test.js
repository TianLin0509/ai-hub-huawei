'use strict';
// 新同事首次引导（core/first-steps.js）：只给新用户、三步各自怎么算过、没过时就地给什么按钮、第一句话只记一次。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const steps = require('../core/first-steps');

const NOW = 1_800_000_000_000;
const providers = installed => ['claude', 'codex', 'codeagent'].map(id => ({ id, name: id, installed: installed.includes(id) }));
const ready = { state: 'ready', modelOptions: [{ id: 'GLM-5.2' }, { id: 'DeepSeek-V4' }, { id: 'Old', unavailable: true, unavailableReason: '没权限' }] };
const byId = (view, id) => view.steps.find(s => s.id === id);

test('只给新用户：老用户（有会话或首次准备做过一天以上）第一次判断就记完成，以后都不显示', () => {
  const fresh = steps.decide({ state: null, sessionsCount: 0, prepState: { at: NOW - 60000 }, now: NOW });
  assert.equal(fresh.show, true);
  assert.deepEqual(fresh.write, { startedAt: NOW });
  const old = steps.decide({ state: null, sessionsCount: 3, now: NOW });
  assert.equal(old.show, false);
  assert.equal(old.write.completedBy, 'existing-user');
  assert.equal(steps.decide({ state: null, sessionsCount: 0, prepState: { at: NOW - steps.EXISTING_PREP_AGE_MS - 1 }, now: NOW }).show, false);
  assert.equal(steps.decide({ state: old.write, sessionsCount: 0, now: NOW }).show, false, '记过完成就不再重判');
  // 已经开始的引导：后来建了会话也继续显示，直到发出第一句话
  assert.equal(steps.decide({ state: { startedAt: NOW - 1000 }, sessionsCount: 2, now: NOW }).show, true);
  assert.equal(steps.decide({ state: { startedAt: 1, dismissedAt: 2 }, now: NOW }).show, false);
});

test('发过第一句话后，下次打开就记完成不再出现；同一次打开里保留「三步都完成了」', () => {
  const same = steps.decide({ state: { startedAt: NOW - 5000, firstPromptAt: NOW - 1000 }, now: NOW });
  assert.equal(same.show, true);
  const next = steps.decide({ state: { startedAt: NOW - 9e6, firstPromptAt: NOW - 8e6 }, now: NOW });
  assert.equal(next.show, false);
  assert.equal(next.write.completedBy, 'first-prompt');
});

test('隔离测试实例默认不显示，设开关才显示（不改变其他界面测试的首页）', () => {
  assert.equal(steps.decide({ state: null, isolated: true, now: NOW }).show, false);
  assert.equal(steps.decide({ state: null, isolated: true, forced: true, now: NOW }).show, true);
});

test('全新电脑什么都没装：第一步标红并就地给安装与重新检测，第二步可先填 API key，第三步等着', () => {
  const view = steps.computeSteps({ providers: providers([]), isCompany: true });
  assert.equal(view.current, 'tool');
  const tool = byId(view, 'tool');
  assert.equal(tool.status, 'bad');
  assert.deepEqual(tool.fixes.map(f => f.act), ['install', 'recheck']);
  assert.equal(tool.fixes[0].tool, 'codeagent');
  const model = byId(view, 'model');
  assert.equal(model.status, 'wait');
  assert.ok(model.fixes.some(f => f.act === 'api-key'));
  assert.equal(byId(view, 'prompt').status, 'wait');
});

test('装了 CodeAgent 但没登录：第二步给一键登录，也能改用 API key', () => {
  const view = steps.computeSteps({ providers: providers(['codeagent']), personal: { state: 'login-required' }, isCompany: true });
  assert.equal(byId(view, 'tool').status, 'ok');
  const model = byId(view, 'model');
  assert.equal(model.status, 'bad');
  assert.equal(model.fixes[0].act, 'codeagent-login');
  assert.ok(model.fixes.some(f => f.act === 'api-key'));
  assert.match(steps.computeSteps({ providers: providers(['codeagent']), personal: { state: 'expired' } }).steps[1].detail, /过期/);
});

test('CodeAgent 已登录：只列能用的模型（暂不可用的不列），默认第一个，用户点选的优先，第三步给「开始第一个会话」', () => {
  const view = steps.computeSteps({ providers: providers(['codeagent']), personal: ready, isCompany: true });
  const model = byId(view, 'model');
  assert.equal(model.status, 'ok');
  assert.deepEqual(model.options.map(o => o.model), ['GLM-5.2', 'DeepSeek-V4']);
  assert.equal(model.chosen.model, 'GLM-5.2');
  assert.match(model.detail, /另有 1 个可选/);
  const picked = steps.computeSteps({ providers: providers(['codeagent']), personal: ready, pick: { kind: 'codeagent', model: 'DeepSeek-V4' } });
  assert.equal(byId(picked, 'model').chosen.model, 'DeepSeek-V4');
  assert.equal(view.current, 'prompt');
  assert.deepEqual(byId(view, 'prompt').fixes.map(f => f.act), ['start']);
  const done = steps.computeSteps({ providers: providers(['codeagent']), personal: ready, firstPromptAt: NOW });
  assert.equal(done.done, true);
});

test('只有部门 API key：key 存好但没装 Claude Code 时第二步给安装；装好后用网关模型，默认模型排第一', () => {
  const gateway = { keySet: true, model: 'glm-5', choices: [{ id: 'deepseek-v4' }, { id: 'glm-5' }] };
  const noTool = steps.computeSteps({ providers: providers([]), gateway, isCompany: true });
  const model = byId(noTool, 'model');
  assert.equal(model.status, 'wait');
  const view = steps.computeSteps({ providers: providers(['claude']), gateway, isCompany: true });
  assert.equal(byId(view, 'model').chosen.kind, 'claude');
  assert.equal(byId(view, 'model').chosen.model, 'glm-5');
  const onlyKey = steps.computeSteps({ providers: providers(['codeagent']), personal: { state: 'login-required' }, gateway, isCompany: true });
  assert.ok(!byId(onlyKey, 'model').fixes.some(f => f.act === 'api-key'), 'key 已存就不再催填 key');
});

test('第一句话：引导进行中才记，只写一次；老用户、没开始、已完成都不碰文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-steps-'));
  try {
    steps.resetForTests();
    assert.equal(steps.notePromptSent(dir, NOW), false, '没有状态文件（老用户 / 没开始）不写');
    assert.equal(fs.existsSync(path.join(dir, steps.STATE_FILE)), false);
    steps.resetForTests();
    steps.writeState(dir, { startedAt: NOW - 1000 });
    assert.equal(steps.notePromptSent(dir, NOW), true);
    assert.equal(steps.readState(dir).firstPromptAt, NOW);
    assert.equal(steps.notePromptSent(dir, NOW + 5), false, '同一进程不再写');
    steps.resetForTests();
    assert.equal(steps.notePromptSent(dir, NOW + 9), false, '已记过不覆盖');
    assert.equal(steps.readState(dir).firstPromptAt, NOW);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); steps.resetForTests(); }
});

test('CodeAgent 清单读到了但全都暂不可用：不退回没筛过的模型名，第二步标红并给 API key 出路（Codex 审查 P1）', () => {
  const personal = { state: 'ready', modelOptions: [{ id: 'A', unavailable: true }], models: ['A', 'B'] };
  const model = byId(steps.computeSteps({ providers: providers(['codeagent']), personal, isCompany: true }), 'model');
  assert.equal(model.status, 'bad');
  assert.deepEqual(model.options, []);
  assert.match(model.detail, /都用不了/);
  assert.ok(model.fixes.some(f => f.act === 'api-key'));
  // 还没读过清单（没有 modelOptions）：按 CodeAgent 默认模型算能用
  const unread = byId(steps.computeSteps({ providers: providers(['codeagent']), personal: { state: 'ready' } }), 'model');
  assert.equal(unread.status, 'ok');
});

test('Hub 里设过默认的 CodeAgent 模型排第一，和启动中心预选一致（Codex 审查 P2）', () => {
  const model = byId(steps.computeSteps({ providers: providers(['codeagent']), personal: ready, hubDefault: 'deepseek-v4' }), 'model');
  assert.equal(model.chosen.model, 'DeepSeek-V4');
});
