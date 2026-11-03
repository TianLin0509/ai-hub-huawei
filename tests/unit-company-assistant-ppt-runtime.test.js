'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { createPptHandlers } = require('../core/company-assistant/ppt-ipc');

const until = async predicate => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('PPT 请求未在期限内完成');
};
function rig(t) {
  const sessions = new Map(), finals = new Map(), sent = [], background = [];
  let svc;
  svc = new CompanyAssistant({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-runtime-m1-')), toolsStartDelayMs: 30,
    welinkRun: async () => { background.push('welink'); throw new Error('本测试不能调用 WeLink'); },
    getSession: id => sessions.get(id), getSessionMetadata: id => sessions.get(id),
    readFinals: meta => finals.get(meta.id) || [], isAgentTurnActive: () => false,
    createSession: async (kind, opts) => {
      assert.equal(kind, 'codeagent');
      assert.equal(svc.tools.listening(), true, '发起会话前必须已启动工具接口');
      assert.ok(fs.existsSync(svc.tools.endpointFile));
      sessions.set(opts.id, { ...opts, kind, status: 'idle' }); return { id: opts.id };
    },
    sendPrompt: async (id, prompt) => { sent.push({ id, prompt }); finals.set(id, [{ id: 'final-' + sent.length, text: 'PPT 请求已完成' }]); return { ok: true }; },
  });
  for (const name of ['meetings', 'phone']) svc[name].start = () => background.push(name);
  svc.tick = async () => background.push('tick');
  svc.ppt.citationNote = async () => '';
  t.after(() => svc.close());
  return { svc, sent, background, sessions };
}

test('共享工具入口保留同一启动promise，关闭后明确拒绝再次启动', async t => {
  const { svc, background } = rig(t);
  const first = svc.startTools();
  assert.equal(svc.startTools(), first);
  await first;
  assert.equal(svc.tools.listening(), true);
  svc.close();
  await assert.rejects(svc.startTools(), /正在关闭/);
  assert.equal(svc.tools.listening(), false);
  assert.deepEqual(background, []);
});

test('助理开关关闭：独立PPT请求自行接通MCP并收答，不启动WeLink后台', async t => {
  const { svc, sent, background } = rig(t);
  const response = await createPptHandlers(svc)['ppt-ask']({ question: '找一页 SRS 信道估计原理' });
  await until(() => ['done', 'error'].includes(svc.chat().find(c => c.id === response.item.id)?.state));
  const chat = svc.chat().find(c => c.id === response.item.id);
  assert.equal(chat.state, 'done', chat.error); assert.equal(chat.a, 'PPT 请求已完成');
  assert.equal(sent.length, 1); assert.deepEqual(background, []); assert.equal(svc.timers.length, 0);
  await until(() => !svc.pptCollector); // 本轮结束后不留PPT收答定时器。
});

test('PPT工具启动失败可重试，不把未监听接口当成功，也不启动其他后台', async t => {
  const { svc, background } = rig(t);
  const start = svc.tools.start.bind(svc.tools); let attempts = 0;
  svc.tools.start = async () => { if (++attempts === 1) throw new Error('测试接口启动失败'); return start(); };
  const first = svc.ask('第一轮', { entry: 'ppt' });
  await until(() => svc.chat().find(c => c.id === first.id)?.state === 'error');
  assert.match(svc.chat().find(c => c.id === first.id).error, /测试接口启动失败/);
  const second = svc.retryChat(first.id);
  await until(() => svc.chat().find(c => c.id === second.id)?.state === 'done');
  assert.equal(attempts, 2); assert.deepEqual(background, []);
});

test('关闭发生于工具启动延迟中时，不再创建会话或留下监听端口', async t => {
  const { svc, sent, sessions } = rig(t);
  svc.deps.toolsStartDelayMs = 80;
  const chat = svc.ask('关闭测试', { entry: 'ppt' });
  svc.close();
  await until(() => svc.chat().find(c => c.id === chat.id)?.state === 'error');
  assert.match(svc.chat().find(c => c.id === chat.id).error, /关闭/);
  assert.equal(sent.length, 0); assert.equal(sessions.size, 0);
  assert.equal(svc.tools.listening(), false); assert.equal(!!svc.pptCollector, false);
});

test('PPT请求进行时打开再关闭助理，不误标重启失败，工具只启动一次', async t => {
  const { svc } = rig(t); let starts = 0;
  const start = svc.tools.start.bind(svc.tools); svc.tools.start = async () => { starts++; return start(); };
  svc.ppt.refresh = async () => ({ available: false });
  const chat = svc.ask('PPT 请求', { entry: 'ppt' });
  svc.start(); assert.equal(svc.chat().find(c => c.id === chat.id).state, 'running');
  svc.pause();
  await until(() => svc.chat().find(c => c.id === chat.id)?.state === 'done');
  assert.equal(starts, 1); assert.equal(svc.timers.length, 0);
});
