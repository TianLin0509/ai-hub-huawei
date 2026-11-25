'use strict';
// 会议 AI 的来源优先级（2026-11-24 lead 定）：本场手选 > 全局默认（设置页「功能使用的 Agent」）> 自动推荐；status 带 engineSource 与实际引擎。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const choice = require('../core/feature-agent-choice');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

const GLM = { id: 'glm-5', label: 'GLM 5' }, DS = { id: 'deepseek-v4.1-flash', label: 'DeepSeek Flash' };
function fixture(t, terminals = { codeagent: true, claude: [GLM] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-engine-src-')), created = [], sessions = new Map();
  const deps = { dataDir: root, powerSaveBlocker: false, meetingModels: () => [GLM, DS], meetingTerminals: () => terminals, meetingDefaultEngine: () => `codeagent|${DS.id}`,
    meetingAsr: { status: () => ({ ready: false }), close() {} }, getSession: id => sessions.get(id),
    createSession: async (kind, opts) => { created.push({ kind, ...opts }); sessions.set(opts.id, opts); }, closeSession: async id => sessions.delete(id) };
  const c = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, deps: { dataDir: root } }, deps);
  c.tools = { start: async () => {}, bind() {}, close() {} };
  t.after(() => { c.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const m = c.create({ audio: [] }); clearInterval(c.timer); c.timer = 1;
  return { c, m, created };
}

test('没手选、没全局默认：自动推荐，来源 auto', async t => {
  const { c, m, created } = fixture(t);
  t.mock.method(choice, 'resolve', () => ({ choice: null, selected: null, warning: '' }));
  const st = c.status(m.id); assert.equal(st.engineSource, 'auto'); assert.equal(st.engineCurrent, `CodeAgent · ${DS.label}`);
  await c.ensureLane(m.id, 'job'); assert.equal(created.at(-1).kind, 'codeagent'); assert.equal(created.at(-1).model, DS.id);
  assert.equal(c.load(m.id).engineSource, 'auto');
});

test('设置页选了全局默认：胜过自动推荐，来源 global；全局默认不可用时退回自动并说明', async t => {
  const { c, m, created } = fixture(t);
  const resolve = t.mock.method(choice, 'resolve', () => ({ choice: { kind: 'api-gateway', model: 'gw-model' }, selected: { kind: 'api-gateway', model: 'gw-model' }, warning: '' }));
  let st = c.status(m.id); assert.equal(st.engineSource, 'global'); assert.match(st.engineCurrent, /部门 API key.*gw-model/);
  t.mock.method(choice, 'session', (_d, _f, kind, opts) => ({ kind, opts }));
  await c.ensureLane(m.id, 'job'); assert.equal(created.at(-1).kind, 'api-gateway');
  resolve.mock.mockImplementation(() => ({ choice: { kind: 'codeagent', model: 'gone' }, selected: null, warning: '所选后端或模型当前不可用，本次沿用默认。' }));
  st = c.status(m.id); assert.equal(st.engineSource, 'auto'); assert.match(st.engineNote, /设置里选的会议 AI 所选后端或模型当前不可用/);
});

test('本场手选胜过全局默认，来源 meeting；快速档手选模型也算本场手选', async t => {
  const { c, m, created } = fixture(t);
  t.mock.method(choice, 'resolve', () => ({ choice: { kind: 'api-gateway', model: 'gw-model' }, selected: { kind: 'api-gateway', model: 'gw-model' }, warning: '' }));
  const saved = c.load(m.id); saved.engine = `claude|${GLM.id}`; c.save(saved);
  const st = c.status(m.id); assert.equal(st.engineSource, 'meeting'); assert.equal(st.engineCurrent, `Claude Code · ${GLM.label}`);
  await c.ensureLane(m.id, 'job'); assert.equal(created.at(-1).kind, 'claude'); assert.equal(created.at(-1).model, GLM.id);
  const fast = c.load(m.id); fast.engine = ''; fast.speed = 'fast'; fast.fastModel = GLM.id; c.save(fast);
  assert.deepEqual([c.status(m.id).engineSource, c.status(m.id).engineCurrent], ['meeting', `CodeAgent · ${GLM.id}`]);
});

test('本场手选已不可用：明确报错，不悄悄换成全局或自动', async t => {
  const { c, m, created } = fixture(t, { codeagent: true, claude: null });
  t.mock.method(choice, 'resolve', () => ({ choice: null, selected: null, warning: '' }));
  const saved = c.load(m.id); saved.engine = `claude|${GLM.id}`; c.save(saved);
  const st = c.status(m.id); assert.equal(st.engineSource, 'meeting'); assert.equal(st.engineCurrent, '');
  assert.equal(st.engineError, '所选的会议 AI 已不可用（终端没装或模型已下线），请在「更多」里重新选择');
  await assert.rejects(c.ensureLane(m.id, 'job'), /所选的会议 AI 已不可用/); assert.equal(created.length, 0);
});
