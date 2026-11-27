'use strict';
// 手机上的斜杠命令（/new /model /dir /session /help）、非文字消息一行提示、回答风格（默认简洁，可选完整）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { PhoneChannel, PHONE_NOTE, PHONE_NOTE_FULL, NON_TEXT_HINT } = require('../core/company-assistant/phone');

function fixture({ style } = {}) {
  let now = 1_000_000;
  const files = {}, asked = [], botSent = [], modelSet = [];
  const rows = [{ id: 's-1', title: '无线仿真', state: 'running' }, { id: 's-2', title: '写周报', state: 'idle' }];
  const a = { now: () => now, dir: 'C:/hub/company-assistant', snapshot: () => ({ login: { ok: true, uid: 'me01' } }),
    settings: () => ({ phone: { enabled: true, transport: 'bot', groupId: '', since: 0, ...(style ? { style } : {}) } }),
    read: (n, f) => files[n] ?? f, write: (n, v) => { files[n] = v; }, changed() {},
    ask: (text, opts) => { asked.push({ text, opts }); return { id: 'q' + asked.length }; },
    userWorkDir: () => ({ path: 'D:/work', from: 'manual' }),
    modelSettings: () => ({ choice: { model: 'm-b' }, options: [{ id: 'm-a', label: '模型 A', provider: 'p' }, { id: 'm-b', label: '模型 B', provider: 'p' }] }),
    setModelChoice: x => { modelSet.push(x); },
    tools: { rows: () => rows },
    bot: { gen: 0, hasCred: () => true, status: () => ({ phase: 'ready' }), state: () => ({ routes: { e1: { tsid: 't1', wsid: 'w1' } }, owner: 'me01' }), save() {}, reply: (_e, body) => { botSent.push(body); return true; } } };
  const phone = new PhoneChannel(a, { noTimer: true });
  const say = async text => { await phone.receive({ text, sender: 'me01', entry: 'e1' }); await phone.outbox; };
  return { phone, a, asked, botSent, modelSet, say, tick: ms => { now += ms; } };
}

test('/help 列出命令；不认识的斜杠开头照常当问题', async () => {
  const f = fixture();
  await f.say('/help');
  assert.match(f.botSent.at(-1), /\/new[\s\S]*\/model[\s\S]*\/dir[\s\S]*\/session/);
  assert.equal(f.asked.length, 0);
  await f.say('/foo 是什么');
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].text, '/foo 是什么');
});

test('/new 之后记下时间，助理不再带前面的对话（service.recentHistory 读 resetAt）', async () => {
  const f = fixture();
  await f.say('/new');
  assert.equal(f.phone.state().resetAt, 1_000_000);
  assert.match(f.botSent.at(-1), /新话题/);
  assert.equal(f.asked.length, 0);
});

test('/dir 回助理目录和用户工作目录', async () => {
  const f = fixture();
  await f.say('/dir');
  assert.match(f.botSent.at(-1), /C:\/hub\/company-assistant[\s\S]*D:\/work/);
});

test('/model 列清单标出当前；/model 1 改用第 1 个；编号不对给提示、不改', async () => {
  const f = fixture();
  await f.say('/model');
  assert.match(f.botSent.at(-1), /模型 B（当前）/);
  await f.say('/model 9');
  assert.equal(f.modelSet.length, 0);
  await f.say('/model 1');
  assert.equal(f.modelSet.length, 1);
  assert.equal(f.modelSet[0].account, 'personal');
  assert.match(f.botSent.at(-1), /改用 模型 A/);
});

test('/session 列会话；/session 2 接着做XX 交给助理去推进那个会话，回答回到这次私聊', async () => {
  const f = fixture();
  await f.say('/session');
  assert.match(f.botSent.at(-1), /1\. 无线仿真（在跑）[\s\S]*2\. 写周报（空闲）/);
  await f.say('/session 2 把结论补上');
  assert.equal(f.asked.length, 1);
  assert.match(f.asked[0].text, /写周报[\s\S]*s-2[\s\S]*把结论补上/);
  assert.equal(f.asked[0].opts.via, 'phone');
  const pending = Object.values(f.phone.state().pending)[0];
  assert.deepEqual(pending.entry, { tsid: 't1', wsid: 'w1' });
  await f.say('/session 7 做点事');
  assert.match(f.botSent.at(-1), /没有这个编号/);
});

test('图片、文件等非文字消息：认过本人后回一行提示，不交给助理', async () => {
  const f = fixture();
  await f.phone.receive({ text: '', nonText: true, sender: 'me01', entry: 'e1' });
  await f.phone.outbox;
  assert.equal(f.botSent.at(-1), NON_TEXT_HINT);
  assert.equal(f.asked.length, 0);
  await f.phone.receive({ text: '', nonText: true, sender: 'stranger', entry: 'e1' });
  await f.phone.outbox;
  assert.equal(f.botSent.length, 1, '别人发的不回');
});

test('回答风格：默认简洁（原说明逐字不变），选「完整」才放开', () => {
  assert.equal(fixture().phone.askNote(), PHONE_NOTE);
  assert.match(PHONE_NOTE, /300 字以内/);
  assert.equal(fixture({ style: 'full' }).phone.askNote(), PHONE_NOTE_FULL);
  assert.equal(/300 字/.test(PHONE_NOTE_FULL), false);
});

test('助理侧：手机提问附带的说明跟着风格走；/new 之前的问答不再带进下一问', () => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const now = Date.parse('2026-11-27T15:00:00+08:00');
  const chat = [
    { id: 'c1', q: '旧话题', a: '旧回答', state: 'done', via: 'phone', askedAt: now - 10 * 60000, answeredAt: now - 9 * 60000 },
    { id: 'c2', q: '新话题', a: '新回答', state: 'done', via: 'phone', askedAt: now - 3 * 60000, answeredAt: now - 2 * 60000 },
  ];
  const self = resetAt => ({ now: () => now, chat: () => chat, phone: { state: () => ({ resetAt }) } });
  const before = CompanyAssistant.prototype.recentHistory.call(self(0), { type: 'chat', chatId: 'x', via: 'phone' });
  assert.match(before, /旧话题[\s\S]*新话题/);
  const after = CompanyAssistant.prototype.recentHistory.call(self(now - 5 * 60000), { type: 'chat', chatId: 'x', via: 'phone' });
  assert.equal(after.includes('旧话题'), false);
  assert.match(after, /新话题/);
});

test('回答风格保存往返：存「完整」重开后仍是完整、提问用完整说明；改回简洁删掉字段', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-style-'));
  const make = () => new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null });
  const a = make();
  t.after(() => { a.digest.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const saved = await a.setPhone({ style: 'full', pushStuck: false });
  assert.equal(saved.ok, true);
  assert.equal(saved.phone.settings.style, 'full');
  const b = make(); t.after(() => b.digest.close());
  assert.equal(b.phone.settings().style, 'full');
  assert.equal(b.phone.askNote(), PHONE_NOTE_FULL);
  await b.setPhone({ style: 'brief' });
  const c = make(); t.after(() => c.digest.close());
  assert.equal('style' in c.phone.settings(), false);
  assert.equal(c.phone.askNote(), PHONE_NOTE);
});

test('/session 清单 30 分钟后作废；关掉的会话不列、不认；状态都是中文', async () => {
  const f = fixture();
  f.a.tools.rows = () => [{ id: 's-1', title: '无线仿真', state: 'reply', open: true }, { id: 's-9', title: '旧会话', state: 'closed', open: false }];
  await f.say('/session');
  assert.match(f.botSent.at(-1), /1\. 无线仿真（等你回复）/);
  assert.equal(f.botSent.at(-1).includes('旧会话'), false);
  f.tick(31 * 60000);
  await f.say('/session 1 接着做');
  assert.match(f.botSent.at(-1), /过期/);
  assert.equal(f.asked.length, 0);
});

test('/model：同名模型挂在不同供应商下，只把供应商也对上的那个标「当前」', async () => {
  const f = fixture();
  f.a.modelSettings = () => ({ choice: { model: 'm', codeagentModelProvider: 'p2' }, options: [{ id: 'm', label: '模型 · 甲', provider: 'p1' }, { id: 'm', label: '模型 · 乙', provider: 'p2' }] });
  await f.say('/model');
  assert.equal((f.botSent.at(-1).match(/（当前）/g) || []).length, 1);
  assert.match(f.botSent.at(-1), /模型 · 乙（当前）/);
});
