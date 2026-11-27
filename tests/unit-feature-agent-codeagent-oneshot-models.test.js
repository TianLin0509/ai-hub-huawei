'use strict';
// 问问 Hub / 进展卡摘要（单次任务）选 CodeAgent 时，模型下拉要和会话里 CodeAgent 能选的一样全（R53）：
// 以前单次任务按模型名并项，同名模型在不同供应商（菜单分组）只剩一项、也不带供应商；也没有手填入口。
// One-shot features (help / progress) must list the same CodeAgent models as sessions, and accept a hand-typed model after a trial run.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const choice = require('../core/feature-agent-choice'), routes = require('../core/codeagent-assistant-route');

// 形状同公司 CodeAgent 1.2615.02.05 的模型清单：Built-in（w3）一组、自配供应商 cannbotprovider 一组，GLM-5.3 两组都有。
const models = [
  { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2-WX-Auto · Built-in', provider: 'w3', providerLabel: 'Built-in', menuLabel: 'GLM-5.2-WX-Auto' },
  { id: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek-V4.1-Flash-1017 · Built-in', provider: 'w3', providerLabel: 'Built-in', menuLabel: 'DeepSeek-V4.1-Flash-1017' },
  { id: 'GLM-5.3', label: 'GLM-5.3 · cannbotprovider', provider: 'cannbotprovider', providerLabel: 'cannbotprovider', menuLabel: 'GLM-5.3' },
  { id: 'GLM-5.3', label: 'GLM-5.3 · Built-in', provider: 'w3', providerLabel: 'Built-in', menuLabel: 'GLM-5.3' },
];
const backends = [{ kind: 'codeagent', label: 'CodeAgent', available: true, defaultModel: '', models },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite', available: true, defaultModel: '', models }];
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r53-oneshot-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const row = (st, id) => st.features.find(f => f.id === id).options.find(o => o.value === 'codeagent');

test('help and progress list every CodeAgent model the session list has, with its provider', t => {
  const st = choice.state(temp(t), { backends });
  const session = row(st, 'avatar').models;
  assert.equal(session.length, 4);
  for (const id of ['help', 'progress']) {
    assert.deepEqual(row(st, id).models, session, `${id} lists the same CodeAgent models as a session`);
  }
  assert.ok(row(st, 'help').models.some(m => /GLM-5\.3 · cannbotprovider/.test(m.label)));
});

test('a provider-specific pick from the one-shot list is saved and resolved with its provider', t => {
  const dir = temp(t);
  const value = row(choice.state(dir, { backends }), 'help').models.find(m => /cannbotprovider/.test(m.label)).value;
  choice.setFromUi(dir, 'help', { backend: 'codeagent', model: value }, { backends });
  const selected = choice.resolve(dir, 'help', { backends }).selected;
  assert.equal(selected.model, 'GLM-5.3');
  assert.equal(selected.codeagentModelProvider, 'cannbotprovider');
});

test('one-shot CodeAgent rows offer a manual entry; session features do not', t => {
  const st = choice.state(temp(t), { backends });
  assert.equal(row(st, 'help').allowCustom, true);
  assert.equal(row(st, 'progress').allowCustom, true);
  assert.equal(row(st, 'avatar').allowCustom, false);
});

test('a hand-typed model is trial-run through the real runner and saved only when it answers', async t => {
  const dir = temp(t), calls = [];
  const run = async (selected, prompt) => { calls.push({ selected, prompt }); return 'OK'; };
  const r = await choice.customCodeAgentModel(dir, 'progress', ' maas-deepseek-v4.1-flash-baidu-codeagent ', { run, backends });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].selected, { kind: 'codeagent', model: 'maas-deepseek-v4.1-flash-baidu-codeagent', custom: true });
  const selected = choice.resolve(dir, 'progress', { backends }).selected;
  assert.equal(selected.model, 'maas-deepseek-v4.1-flash-baidu-codeagent');
  const st = choice.state(dir, { backends });
  const option = row(st, 'progress').models.find(m => m.value === 'maas-deepseek-v4.1-flash-baidu-codeagent');
  assert.match(option.label, /手填/);
  assert.equal(st.features.find(f => f.id === 'progress').current.model, 'maas-deepseek-v4.1-flash-baidu-codeagent');
  // 下拉里选回这个手填项（只带名字），仍是手填选择，不被判「不可用」。
  choice.setFromUi(dir, 'progress', { backend: 'codeagent', model: 'maas-deepseek-v4.1-flash-baidu-codeagent' }, { backends });
  assert.equal(choice.resolve(dir, 'progress', { backends }).selected.custom, true);
});

test('a hand-typed model the account cannot use is reported as such and nothing is saved', async t => {
  const dir = temp(t);
  const run = async () => { throw new Error('所选模型未能回答：model not found: deepseek-x'); };
  const r = await choice.customCodeAgentModel(dir, 'help', 'deepseek-x', { run, backends });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'model-unavailable');
  assert.match(r.error, /账号没有这个模型，或名字写错了/);
  assert.equal(routes.featurePreference(dir, 'help'), null);
  const other = await choice.customCodeAgentModel(dir, 'help', 'deepseek-x', { run: async () => { throw Object.assign(new Error('所选模型回答超时'), { timedOut: true }); }, backends });
  assert.equal(other.code, 'timeout');
});

test('typing a name that is already listed saves the listed entry with its provider', async t => {
  const dir = temp(t);
  const r = await choice.customCodeAgentModel(dir, 'help', 'deepseek-v4.1-flash-1017', { run: async () => 'OK', backends });
  assert.equal(r.already, true);
  const selected = choice.resolve(dir, 'help', { backends }).selected;
  assert.equal(selected.model, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(selected.codeagentModelProvider, 'w3');
  assert.equal(selected.custom, undefined);
});

test('a hand-typed choice is not accepted for session features', async t => {
  const dir = temp(t);
  const r = await choice.customCodeAgentModel(dir, 'avatar', 'maas-x', { run: async () => 'OK', backends });
  assert.equal(r.ok, false);
  assert.throws(() => choice.set(dir, 'avatar', { kind: 'codeagent', model: 'maas-x', custom: true }, { backends }), /不可用/);
});

test('a CodeAgent choice saved before R53 (no provider) shows as the first same-name option, not as unavailable', t => {
  // 升级前单次任务按名字并项，存下的就是裸模型名；GLM-5.3 两个供应商都有时，对齐到第一项（和 resolve() 命中的一致）。
  for (const [model, provider] of [['DeepSeek-V4.1-Flash-1017', 'w3'], ['GLM-5.3', 'cannbotprovider']]) {
    const dir = temp(t);
    routes.setFeaturePreference(dir, 'help', { kind: 'codeagent', model });
    const st = choice.state(dir, { backends }), f = st.features.find(x => x.id === 'help');
    assert.equal(f.selected.model, model);
    const option = row(st, 'help').models.find(m => m.value === f.current.model);
    assert.ok(option, `${model} current value matches a listed option`);
    assert.equal(JSON.parse(option.value)[1], provider);
  }
});

test('opening the Agent popup clears the previous status line', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'feature-agent-settings.js'), 'utf8');
  const open = src.slice(src.indexOf('async function open(ids, anchor)'), src.indexOf('popup = document.createElement'));
  assert.match(open, /presetNote = '';/);
});
