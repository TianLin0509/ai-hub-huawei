'use strict';
// 2026-11-06 用户定：Hub 输入框按发送的这一刻就起名，不等 CLI 收下消息、hook 转发回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function harness() {
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js');
  const localRequire = createRequire(file);
  const events = [];
  let releaseSend;
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async () => ({ ok: true }),
      // 模拟 CLI 还在启动：发送迟迟不返回
      sendToPty: (_sid, text) => { events.push(['pty', text]); return new Promise(resolve => { releaseSend = () => resolve({ ok: true }); }); },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const manager = new EventEmitter();
  manager.getSession = id => id === 's1' ? { kind: 'codeagent' } : null;
  const handlers = new Map();
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    sessionManager: manager, sendToRenderer() {}, logger: { warn() {} },
    commandTranscriptStore: { begin: () => ({ duplicate: false }), finish() {} },
    onUserPrompt: ev => events.push(['title', ev.sessionId, ev.text]),
    preparePrompt: request => ({ ...request, text: '[附带规则]\n' + request.text }),
  });
  return { events, send: req => handlers.get('session:send-prompt')(null, req), release: () => releaseSend?.(), registration };
}

test('用户亲手发送时，起名先于写入 CLI，且用的是用户原话', async () => {
  const h = harness();
  try {
    const pending = h.send({ sessionId: 's1', text: '查一下 PfScheduler 的权重更新', memoryIndex: true, clientSubmissionId: 'c1' });
    assert.deepEqual(h.events[0], ['title', 's1', '查一下 PfScheduler 的权重更新']);
    await new Promise(r => setImmediate(r));
    h.release();
    await pending;
    assert.equal(h.events.findIndex(e => e[0] === 'title'), 0);
    assert.ok(h.events.some(e => e[0] === 'pty'));
  } finally { h.registration.dispose(); }
});

test('斜杠命令和程序自动发出的消息不触发提前起名', async () => {
  const h = harness();
  try {
    for (const req of [
      { sessionId: 's1', text: '/compact', memoryIndex: true, clientSubmissionId: 'c2' },
      { sessionId: 's1', text: '群聊派发的内容', clientSubmissionId: 'c3' },
    ]) {
      const pending = h.send(req);
      await new Promise(r => setImmediate(r));
      h.release();
      await pending;
    }
    assert.equal(h.events.filter(e => e[0] === 'title').length, 0);
  } finally { h.registration.dispose(); }
});

test('起名回调出错不影响发送', async () => {
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js');
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /try \{ deps\.onUserPrompt\?\.\(/);
});
