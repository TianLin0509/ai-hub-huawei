'use strict';
// 新建会话时账号默认模型已下线：有明确推荐（同版本对照命中，或账号给出且在清单里的推荐）就直接换成它创建，
// 只给一次性一行提示；没有明确推荐、或这次明确选了模型时照旧确认；没有可用模型时保留原报错。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pins = require('../core/session-model-pin');
const replacements = require('../core/codeagent-model-replacements');
const { createSessionWithModelPolicy } = require('../main/session-model-creation');

const DEAD = 'deepseek-v4.1-flash-1017';
const GLM = 'GLM-5.2';
const OTHER = 'Qwen3-Coder';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-auto-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(t, { available = [GLM, OTHER], policy = 'auto-switch-notify', suggested = GLM } = {}) {
  const dataDir = tempDir(t);
  const notices = [], toasts = [], confirmations = [], attempts = [];
  let seq = 0;
  // 和启动前固定模型同一口径：没指定模型时按账号默认（已下线）起，先看有没有记住的替代。
  const create = (_kind, opts) => {
    attempts.push(opts.fixedModel || '');
    const model = opts.fixedModel || replacements.replacementFor(dataDir, DEAD, { models: available, authoritative: true }) || DEAD;
    if (!available.includes(model)) throw pins.unavailableError(model, '账号的权威模型清单已不包含它', available, suggested);
    return { id: `s${++seq}`, fixedModel: model, modelPinSource: opts.modelPinSource || 'created' };
  };
  const run = (opts = {}, extra = {}) => createSessionWithModelPolicy({ kind: 'codeagent', opts, create, dataDir, getPolicy: () => policy,
    sendToRenderer: (name, payload) => {
      if (name === 'session-notice') notices.push(payload);
      if (name === 'session-create-followup') toasts.push(payload);
    },
    requestConfirmation: async payload => { confirmations.push(payload); return payload.suggestedModel || available[0]; }, ...extra });
  return { run, notices, toasts, confirmations, attempts, dataDir };
}

test('default model gone with an explicit recommendation: creates with it and shows a one-off one-line toast', async t => {
  const h = harness(t);
  const session = await h.run({});
  assert.equal(session.fixedModel, GLM);
  assert.equal(session.modelPinSource, 'auto-switch');
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.notices.length, 0, 'no persistent notice block');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, `默认模型 ${DEAD} 已不可用，已改用 ${GLM}`);
  assert.deepEqual(h.toasts[0].actions, ['pick-model']);
  assert.equal(h.toasts[0].sessionId, 's1');
  assert.ok(!/[\r\n]/.test(h.toasts[0].message));
  assert.equal(replacements.replacementFor(h.dataDir, DEAD), GLM);
});

test('forks name the source model in the toast', async t => {
  const h = harness(t);
  await h.run({}, { modelLabel: '原会话的模型' });
  assert.equal(h.toasts[0].message, `原会话的模型 ${DEAD} 已不可用，已改用 ${GLM}`);
});

test('the remembered replacement is used silently by later creations', async t => {
  const h = harness(t);
  await h.run({});
  const second = await h.run({});
  assert.equal(second.fixedModel, GLM);
  assert.equal(h.toasts.length, 1, 'only the first replacement is announced');
  assert.equal(h.confirmations.length, 0);
});

test('a creation path that still hits the dead default after it was remembered stays quiet', async t => {
  const dataDir = tempDir(t), toasts = [];
  replacements.recordReplacement(dataDir, DEAD, GLM);
  const session = await createSessionWithModelPolicy({ kind: 'codeagent', opts: {}, dataDir, getPolicy: () => 'auto-switch-notify',
    create: (_kind, opts) => { if (!opts.fixedModel) throw pins.unavailableError(DEAD, 'x', [GLM], GLM); return { id: 'b1', fixedModel: opts.fixedModel }; },
    sendToRenderer: (name, payload) => { if (name === 'session-create-followup') toasts.push(payload); },
    requestConfirmation: async () => { throw Error('should not confirm'); } });
  assert.equal(session.fixedModel, GLM);
  assert.equal(toasts.length, 0);
});

test('without an explicit recommendation the first listed model is not taken: the confirmation stays', async t => {
  const h = harness(t, { suggested: '' });
  const session = await h.run({});
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].originalModel, DEAD);
  assert.equal(h.toasts.length, 0);
  assert.equal(session.fixedModel, GLM, 'the user picked it in the confirmation');
});

test('an explicitly chosen unavailable model still asks for confirmation', async t => {
  const h = harness(t);
  const session = await h.run({ model: DEAD, codeagentModelPick: true });
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].originalModel, DEAD);
  assert.equal(h.confirmations[0].suggestedModel, GLM);
  assert.equal(session.fixedModel, GLM);
  assert.equal(h.toasts.length, 0);
});

test('a caller-pinned model and the stop-and-ask setting keep the confirmation', async t => {
  const pinned = harness(t);
  await pinned.run({ fixedModel: DEAD });
  assert.equal(pinned.confirmations.length, 1);
  const ask = harness(t, { policy: 'stop-and-ask' });
  await ask.run({});
  assert.equal(ask.confirmations.length, 1);
  assert.equal(ask.toasts.length, 0);
});

test('no available model keeps the original error and creates nothing', async t => {
  const h = harness(t, { available: [], suggested: '' });
  await assert.rejects(async () => h.run({}), { code: 'SESSION_MODEL_UNAVAILABLE' });
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].message, /未创建会话/);
  assert.deepEqual(h.attempts, ['']);
});

test('if the recommended model also fails, the next round asks instead of switching again', async t => {
  const confirmations = [];
  const session = await createSessionWithModelPolicy({ kind: 'codeagent', opts: {}, dataDir: tempDir(t),
    getPolicy: () => 'auto-switch-notify', sendToRenderer() {},
    create: (_kind, opts) => {
      if (opts.fixedModel === OTHER) return { id: 'ok', fixedModel: OTHER };
      throw pins.unavailableError(opts.fixedModel || DEAD, 'x', [GLM, OTHER], GLM);
    },
    requestConfirmation: async payload => { confirmations.push(payload); return OTHER; } });
  assert.equal(session.fixedModel, OTHER);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].originalModel, GLM);
});

test('recommendation: same-version match first, then an explicit recommendation in the list, never the first listed model', () => {
  assert.equal(pins.recommendedReplacement('GLM-5.2-WX-Auto', ['Qwen3-Coder', 'GLM-5.3-WX-Auto', 'GLM-5.2-Auto']), 'GLM-5.2-Auto');
  assert.equal(pins.recommendedReplacement('GLM-5.2-WX-Auto', ['Qwen3-Coder', 'GLM-5.3-WX-Auto']), '', 'other versions are not a recommendation');
  assert.equal(pins.recommendedReplacement('GLM-5.2-WX-Auto', ['Qwen3-Coder', 'GLM-5.3-WX-Auto'], 'GLM-5.3-WX-Auto'), 'GLM-5.3-WX-Auto');
  assert.equal(pins.recommendedReplacement(DEAD, [GLM, OTHER]), '');
  assert.equal(pins.recommendedReplacement(DEAD, [GLM, OTHER], OTHER), OTHER);
  assert.equal(pins.recommendedReplacement(DEAD, [GLM, OTHER], 'not-listed'), '');
  assert.equal(pins.recommendedReplacement(DEAD, [DEAD], DEAD), '');
  assert.equal(pins.recommendedReplacement(DEAD, []), '');
});

test('the create toast offers 换一个 and the renderer opens that session\'s own model menu', () => {
  const toast = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-create-toast.js'), 'utf8');
  assert.match(toast, /'pick-model': '换一个'/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const branch = renderer.slice(renderer.indexOf("action === 'pick-model'"), renderer.indexOf("action === 'proxy-restart'"));
  assert.match(branch, /\.floating-input-bar\[data-session-id="\$\{CSS\.escape\(sessionId\)\}"\] \.composer-model/);
});
