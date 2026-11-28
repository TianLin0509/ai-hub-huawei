'use strict';
// 蒸馏自己 · 接入回归：助理、分身、PPT 做页。「应用到」关着时提示与现在逐字一致，开着时含画像内容。
// 社区团队代答的回归在 tests/unit-community-crew.test.js 末尾。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SD = require('../core/self-distill');

const at = (day, hour, min = 0) => Date.UTC(2026, 10, day, hour - 8, min);
async function portrait(dataDir, apply = {}) {
  const rows = [];
  const mine = ['行', '好嘞', '我看下', '仿真结果出来了吗', '这个调度方案再对一下'];
  for (let i = 0; i < 40; i += 1) rows.push({ at: at(2 + Math.floor(i / 10), 9 + (i % 10)), c: 'u', m: 1, t: mine[i % mine.length] });
  const r = await SD.distill({ rows, runModel: async () => JSON.stringify({ tone: ['先给判断再说理由'], examples: [{ cat: 'chat', text: '周末去哪玩' }, { cat: 'chase', text: '那个进度咋样了' }] }), backend: { kind: 'codeagent' } });
  SD.createStore({ dataDir }).write('me', { ...r.portrait, apply: { ...SD.emptyApply(), ...apply } });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-apply-'));

// ---- 助理 ----
const { CompanyAssistant } = require('../core/company-assistant/service');
function fakeAssistant(dataDir) {
  const a = Object.create(CompanyAssistant.prototype);
  Object.assign(a, {
    deps: { dataDir }, now: () => at(28, 10), guided: () => false, instructions: () => 'INSTRUCTIONS', workDirLine: () => '',
    memory: { seedDefaults() {}, context: () => '记忆：MEMORY', active: () => [] }, todayDigest: () => ({ text: '今日摘要', coverage: {} }),
    recentHistory: () => '', snapshot: () => ({ login: { ok: true, uid: 'me' } }), archive: null, sessionsBlock: () => '', state: () => ({}), judgeSettings: () => ({}), settings: () => ({}),
  });
  return a;
}
test('助理：没画像 / 画像关着时提示逐字一致；打开后「说话风格」在记忆之前', async () => {
  const dataDir = tmp(), a = fakeAssistant(dataDir), job = { prompt: '帮我回一下这条消息' };
  const none = a.composePrompt({ ...job }, 'desk');
  await portrait(dataDir);
  const off = a.composePrompt({ ...job }, 'desk');
  assert.equal(off, none);
  assert.ok(!/说话风格/.test(off));
  await portrait(dataDir, { assistant: true });
  const on = a.composePrompt({ ...job }, 'desk');
  assert.match(on, /说话风格/);
  assert.ok(on.indexOf('说话风格') < on.indexOf('记忆：MEMORY'));
  assert.equal(on.replace(/\n\n说话风格[\s\S]*?(?=\n\n记忆：)/, ''), none, '只多出这一段');
  assert.ok(!/说话风格/.test(a.composePrompt({ ...job, teamOwner: 'x' }, 'desk')), '团队成员借用助理时不带本人口吻');
  assert.equal(a.selfStyle('ppt'), '', 'PPT 没打开就是空');
});

// ---- 分身 ----
const F = require('../core/avatar/fleet-rules');
const { FleetService } = require('../core/avatar/fleet');
const { AvatarService } = require('../core/avatar/service');
test('分身：规则文件关着时逐字一致；打开后多出画像与口吻样本两节；起草材料人设空时用画像、样本不够时补例句', async () => {
  const av = F.newAvatar({ id: 'a1', tpl: 'draft', now: 1, persona: '我的人设' });
  const base = F.rulesMarkdown(av, { memoryLines: 3, sources: [] });
  const dataDir = tmp(), fleet = { d: { dataDir } };
  assert.equal(FleetService.prototype.selfPortrait.call(fleet, 'me'), null);
  await portrait(dataDir);
  const self0 = FleetService.prototype.selfPortrait.call(fleet, 'me');
  assert.equal(self0, null, '关着');
  assert.equal(F.rulesMarkdown(av, { memoryLines: 3, sources: [], ...(self0 ? { self: self0 } : {}) }), base);
  await portrait(dataDir, { avatar: true });
  const self = FleetService.prototype.selfPortrait.call(fleet, 'me');
  const on = F.rulesMarkdown(av, { memoryLines: 3, sources: [], self });
  assert.match(on, /## 本人口吻画像（来自「蒸馏自己」）/);
  assert.match(on, /## 口吻样本[\s\S]*- 周末去哪玩/);
  assert.match(on, /## 人设\n我的人设/, '本人写的人设保留');

  // 旧版起草材料（AvatarService.material）
  const dir2 = tmp();
  const svc = new AvatarService({ dataDir: dir2, getAssistant: () => ({ snapshot: () => ({ messages: {} }), archive: null }), noTimer: true });
  const item = { id: 'x', account: 'u', conv: 'u', group: false, who: '同事', convName: '同事', text: '在吗' };
  const s = svc.settings('me');
  const before = JSON.stringify(svc.material('me', s, [item]));
  await portrait(dir2);
  assert.equal(JSON.stringify(svc.material('me', s, [item])), before, '关着时一致');
  await portrait(dir2, { avatar: true });
  const m = svc.material('me', s, [item]);
  assert.match(m.persona, /先给判断再说理由/);
  assert.deepEqual(m.items[0].samples.slice(0, 2), ['周末去哪玩', '那个进度咋样了']);
});

// ---- PPT 做页 ----
const { PptMake, listSkeletons } = require('../core/company-assistant/ppt-make');
function makeFixture(dir, selfStyle) {
  const asks = [];
  const a = { dir, now: () => Date.now(), changed() {}, chat: () => [], ask(text) { asks.push(text); return { id: 'c' + asks.length, sessionId: 's' }; }, ...(selfStyle ? { selfStyle } : {}) };
  const make = new PptMake({ a, deps: {}, materials: { teamPackFile: () => path.join(dir, 'none.pptx') } });
  return { make, asks };
}
test('PPT 做页：关着时提示逐字一致；打开后加一段本人用词习惯（不带口头禅）', async () => {
  const dir = tmp(), sk = listSkeletons()[0].id;
  const strip = t => t.replace(/jobId=[0-9a-f-]+/g, 'jobId=ID');
  const plain = makeFixture(dir); plain.make.start({ skeletonId: sk, brief: '讲一下调度增益' }); plain.make.startAuto({ brief: '讲一下调度增益' });
  const off = makeFixture(dir, () => ''); off.make.start({ skeletonId: sk, brief: '讲一下调度增益' }); off.make.startAuto({ brief: '讲一下调度增益' });
  assert.deepEqual(off.asks.map(strip), plain.asks.map(strip));
  const dataDir = tmp(); await portrait(dataDir, { ppt: true });
  const text = SD.forTarget({ dataDir, owner: 'me', target: 'ppt' });
  const on = makeFixture(dir, target => (target === 'ppt' ? text : '')); on.make.start({ skeletonId: sk, brief: '讲一下调度增益' }); on.make.startAuto({ brief: '讲一下调度增益' });
  for (const t of on.asks) { assert.ok(t.includes(text)); assert.ok(!/「行」/.test(t)); }
  assert.equal(strip(on.asks[0]).replace(text + '\n', ''), strip(plain.asks[0]));
});
