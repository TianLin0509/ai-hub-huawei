'use strict';
// 小队里标出谁能看图（用户问「小队模式支持输入图片吗？」）。只给确定能看图的成员打 🖼，公司模型默认不标。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { imageInputSupport } = require('../core/image-input-support');

test('能看图判断：Claude / Codex / Gemini 标，DeepSeek 与已知纯文字模型不标，公司 CodeAgent 不确定', () => {
  assert.equal(imageInputSupport({ kind: 'claude', model: 'opus' }), true);
  assert.equal(imageInputSupport({ kind: 'claude' }), true);
  assert.equal(imageInputSupport({ kind: 'codex', model: 'gpt-5.5' }), true);
  assert.equal(imageInputSupport({ kind: 'gemini', model: 'gemini-3-pro' }), true);
  assert.equal(imageInputSupport({ kind: 'claude', model: 'deepseek-v4-pro' }), false, 'Claude 壳接纯文字模型');
  assert.equal(imageInputSupport({ kind: 'claude', model: 'kimi-k2' }), null, 'Claude 壳接认不出的第三方模型不标');
  assert.equal(imageInputSupport({ kind: 'deepseek-acp' }), false);
  assert.equal(imageInputSupport({ kind: 'codeagent', model: 'glm-5.2' }), false);
  assert.equal(imageInputSupport({ kind: 'codeagent', model: 'some-company-model' }), null);
  assert.equal(imageInputSupport({ kind: 'codeagent' }), null);
  assert.equal(imageInputSupport({}), null);
});

test('负责人提示词里给能看图的成员注明「能看图」，便于把看图的活派给他', () => {
  const { leaderPrompt } = require('../core/squad-protocol');
  const text = leaderPrompt('看看这张图', { leaderMemberId: 'm1', members: [
    { memberId: 'm1', label: '负责人', kind: 'codeagent' },
    { memberId: 'm2', label: 'Claude', kind: 'claude', model: 'sonnet' },
    { memberId: 'm3', label: 'CodeAgent', kind: 'codeagent', model: 'company-x' },
  ] });
  assert.match(text, /@m2：Claude（claude \/ sonnet），能看图/);
  assert.doesNotMatch(text, /@m3[^\n]*能看图/);
});

test('小队发图：不确定能看图的成员给一行提示；不带图或小队没开不提示', async t => {
  const members = [
    { memberId: 'm1', label: '负责人', kind: 'codeagent', model: '' },
    { memberId: 'm2', label: 'Claude', kind: 'claude', model: 'opus' },
  ];
  let enabled = true;
  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcRenderer: {
    on() {}, invoke: async () => ({ ok: true, meetingId: 'g1', config: { enabled }, members }),
  } } };
  const squadPath = require.resolve('../renderer/squad-ui.js');
  delete require.cache[squadPath];
  t.after(() => { if (previous) require.cache[electronPath] = previous; else delete require.cache[electronPath]; delete require.cache[squadPath]; });
  const SquadUI = require('../renderer/squad-ui.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-squad-img-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'shot.png');
  fs.writeFileSync(image, 'png');
  const meeting = { id: 'g1', groupChat: true };
  // 没提前 load：刚打开群就发图，也要先读小队状态再提示。
  assert.equal(SquadUI.view(meeting), null);
  const hint = await SquadUI.imageWarning(meeting, `看看这张 ${image}`);
  assert.match(hint, /负责人 不确定能看图/);
  assert.doesNotMatch(hint, /Claude/);
  assert.equal(await SquadUI.imageWarning(meeting, '没有图片'), '');
  enabled = false;
  await SquadUI.load('g1');
  assert.equal(await SquadUI.imageWarning(meeting, `看看这张 ${image}`), '');
});

test('看图判断与 ACP 发图拦截共用同一个函数：纯文字模型两边都拦', () => {
  const { modelLacksVision } = require('../core/image-input-support');
  const { validateImages } = require('../core/acp-attachments');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acp-img-'));
  const image = path.join(dir, 'a.png');
  fs.writeFileSync(image, 'png');
  try {
    const files = [{ type: 'localImage', path: image }], caps = { promptCapabilities: { image: true } };
    for (const model of ['deepseek-v4-pro', 'glm-5.2', 'qwen3.7-max', 'deepseek-chat']) {
      assert.equal(modelLacksVision(model), true, model);
      assert.equal(imageInputSupport({ kind: 'claude', model }), false, model);
      assert.throws(() => validateImages(files, model, caps), /不支持图片/, model);
    }
    assert.equal(modelLacksVision('claude-opus-5-5'), false);
    assert.doesNotThrow(() => validateImages(files, 'claude-opus-5-5', caps));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
