'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createScreenErrorWatch, findScreenErrors, describeScreenError } = require('../core/codeagent-screen-error');
const { classifyModelRevocation, classifyCodeAgentError } = require('../core/codeagent-model-revoked');

// 2026-11-17 反馈里的真实屏幕（CodeAgent 1.2615.02.03），节选。
const SAMPLE = [
  ' ┃  、bot测试群 的群 ID 是多少',
  ' ┃  1分钟前',
  '',
  '  ✗ SessionRequestError',
  '  部门已启用外部模型管控，外部模型不可用。请联系部门管理员关闭管控，或申请开通内部模型。 [SessionRequestError_002]',
  '',
  '   Select model',
];

test('finds the session-level error and its message', () => {
  const found = findScreenErrors(SAMPLE);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'SessionRequestError');
  assert.match(found[0].message, /外部模型管控.*\[SessionRequestError_002\]$/);
  assert.match(describeScreenError(found[0]), /公司侧的模型管控/);
});

test('ordinary output is not an error', () => {
  assert.deepStrictEqual(findScreenErrors(['✗ 1 test failed', 'Error: boom', '  ✗ SessionRequestError']), []);
});

function fake(screen) {
  const entry = { info: { id: 's1', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' }, agentTurnActive: false, lastOutputAt: 1 };
  const state = { rows: screen, text: 'x' };
  const finished = [], errors = [];
  const manager = {
    sessions: new Map([['s1', entry]]),
    noteAgentTurnFinished: (id, ev) => { if (!entry.agentTurnActive) return false; entry.agentTurnActive = false; finished.push([id, ev]); return true; },
  };
  const watch = createScreenErrorWatch({ manager, readScreen: () => ({ text: state.text }), renderRows: async () => state.rows,
    onError: e => errors.push(e), now: () => 7000 });
  return { entry, state, watch, finished, errors };
}

test('a new error during a turn ends it with the original text', async () => {
  const { entry, state, watch, finished, errors } = fake(SAMPLE.slice(0, 2));
  await watch.tick(); // baseline, no error yet
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  state.rows = SAMPLE; state.text = 'raw SessionRequestError raw';
  await watch.tick();
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /SessionRequestError_002/);
  assert.strictEqual(errors[0].failedAt, 7000);
});

test('an old error still on screen does not end the next turn', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE);
  state.text = 'SessionRequestError';
  await watch.tick(); // baseline already contains the error
  entry.agentTurnActive = true; entry.lastOutputAt = 2; // redraw, same error
  await watch.tick();
  assert.strictEqual(finished.length, 0);
  // the same error shows up a second time: that is new
  state.rows = [...SAMPLE, ...SAMPLE]; entry.lastOutputAt = 3;
  await watch.tick();
  assert.strictEqual(finished.length, 1);
});

test('raw output without the error word is not replayed', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE.slice(0, 2));
  await watch.tick();
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  state.rows = SAMPLE; state.text = 'nothing relevant';
  await watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('main and renderer route the screen error like a CLI exit', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8'), /payload\.signalSource === 'codeagent-screen-error'/);
  assert.match(fs.readFileSync(require.resolve('../main.js'), 'utf8'), /signalSource: 'codeagent-screen-error'/);
});

// r38b 审查 P1：新会话发出去 10 秒内就报错，第一次读屏已经带着这条错（之前没有「空屏」那次读屏）。
test('first read of an active new session already shows the error: it ends the turn', async () => {
  const { entry, state, watch, finished, errors } = fake(SAMPLE);
  entry.agentTurnActive = true; entry.info.status = 'running';
  state.text = '✗ SessionRequestError';
  await watch.tick();
  assert.strictEqual(finished.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /SessionRequestError_002/);
  // 之后的读屏和重绘不重复报
  await watch.tick(); entry.lastOutputAt = 2; entry.agentTurnActive = true; await watch.tick();
  assert.strictEqual(finished.length, 1);
});

test('an error first seen while idle stays baseline for the next turn', async () => {
  const { entry, state, watch, finished } = fake(SAMPLE);
  state.text = 'SessionRequestError';
  await watch.tick(); // idle first read
  entry.agentTurnActive = true; entry.lastOutputAt = 2;
  await watch.tick();
  assert.strictEqual(finished.length, 0);
});

test('model permission revocation rules cover Chinese and English CLI wording', () => {
  const samples = [
    'SessionRequestError 当前模型 GLM-5.2-WX-Auto 可能已经升级或被调整了权限，请更换模型',
    'SessionRequestError model GLM-5.2-WX-Auto is no longer available for this account: permission denied',
    'SessionRequestError 模型 GLM-5.2-WX-Auto 已下线，请选择可用模型',
  ];
  for (const text of samples) assert.equal(classifyModelRevocation(text, { source: 'codeagent-screen-error' })?.kind, 'model-revoked');
});

test('ordinary assistant text quoting the warning cannot trigger model recovery', () => {
  assert.equal(classifyModelRevocation('用户粘贴：当前模型可能已经升级或被调整了权限。', { source: 'assistant', role: 'assistant' }), null);
  assert.equal(classifyModelRevocation('当前模型可能已经升级或被调整了权限。', { source: 'transcript', role: 'assistant' }), null);
  assert.equal(classifyModelRevocation('SessionRequestError 工具配置失败，请检查工作区。', { source: 'codeagent-screen-error' }), null);
});

// 反馈只有现象、没有 CLI 截图文字；以下均为关键词兜底的模拟样本，待公司真机校准。
const TRUSTED_REPO_SAMPLES = [
  '当前目录不在公司可信仓，CodeAgent 被风控',
  '当前模型无权限：非可信仓目录禁止使用',
  '当前目录未被信任，请选择可信仓',
  '当前目录触发风控拦截',
  'Not in a trusted repository. Request blocked.',
  'Working directory is not trusted',
  'Untrusted repository: permission denied for model GLM',
  'Request denied: a trusted repo is required',
];

test('可信仓规则优先于模型权限，不引导换模型', () => {
  for (const message of TRUSTED_REPO_SAMPLES) {
    assert.equal(classifyCodeAgentError(message)?.kind, 'trusted-repo-required', message);
    assert.equal(classifyModelRevocation(message), null, message);
    const found = findScreenErrors(['✗ SessionRequestError', message, '']);
    assert.equal(found.length, 1);
    assert.ok(found[0].trustedRepoRequired);
    assert.equal(found[0].modelRevoked, undefined);
    assert.equal(describeScreenError(found[0]), '当前目录不在公司可信仓，CodeAgent 被风控');
  }
});

test('可信仓独立报错、窄屏折行和 ANSI 输出可以识别', async () => {
  for (const message of TRUSTED_REPO_SAMPLES) {
    assert.ok(findScreenErrors([`Error: ${message}`, ''])[0]?.trustedRepoRequired, message);
    assert.ok(findScreenErrors([`✗ ${message}`, ''])[0]?.trustedRepoRequired, message);
  }
  assert.ok(findScreenErrors(['✗ RiskControlError', 'Not in a trusted repository', ''])[0]?.trustedRepoRequired);
  const { entry, state, watch, errors, finished } = fake(['✗ SessionRequestError', '当前目录不在', '公司可信仓，CodeAgent 被风控', '']);
  entry.agentTurnActive = true;
  state.text = '\x1b[31m✗ SessionRequestError\x1b[0m 当前目录不在公司可信仓';
  await watch.tick();
  assert.equal(errors.length, 1);
  assert.equal(finished.length, 1);
  assert.ok(errors[0].trustedRepoRequired);
  assert.equal(errors[0].modelRevoked, null);
  entry.agentTurnActive = true; entry.lastOutputAt++;
  await watch.tick();
  assert.equal(errors.length, 1, '旧屏幕重绘不重复报错');
});

test('普通回答提及可信仓、讲解风控及引用错误均不触发', () => {
  const ordinary = [
    '这个项目是可信仓，可以工作。',
    'Use a trusted repo for company development.',
    '我们要分析风控的实现方案。',
    '✗ 1 test failed',
  ];
  assert.deepEqual(findScreenErrors(ordinary), []);
  for (const text of ordinary) assert.equal(classifyCodeAgentError(text), null);
  assert.deepEqual(findScreenErrors(TRUSTED_REPO_SAMPLES), [], '没有报错标题的回答不能被当作 CLI 报错');
  assert.deepEqual(findScreenErrors(['```text', '✗ 当前目录不在公司可信仓', '```', '> Error: untrusted repository']), [], '回答中的代码块和引用不触发');
  assert.deepEqual(findScreenErrors(['✗ 1 test failed', '这里演示非可信仓的处理方法', '']), [], '测试清单不能吸入普通讲解');
  for (const text of TRUSTED_REPO_SAMPLES) {
    for (const options of [{ role: 'assistant' }, { role: 'user' }, { error: false }, { source: 'transcript' }]) {
      assert.equal(classifyCodeAgentError(text, options), null);
    }
  }
});

test('可信仓独立错误在首次读屏结束本轮，空闲期旧报错只作基线', async () => {
  const { entry, state, watch, errors } = fake(['Error: Not in a trusted repository', '']);
  state.text = 'Error: Not in a trusted repository';
  await watch.tick();
  entry.agentTurnActive = true; entry.lastOutputAt++;
  await watch.tick();
  assert.equal(errors.length, 0);
  state.rows.push('✗ 当前目录触发风控拦截', ''); state.text += ' 当前目录触发风控拦截'; entry.lastOutputAt++;
  await watch.tick();
  assert.equal(errors.length, 1);
  assert.ok(errors[0].trustedRepoRequired);
});

test('群聊成员的可信仓错误可持久化，禁止原样重试及换模型', async () => {
  const { EventEmitter } = require('node:events');
  const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');
  const tap = new EventEmitter();
  const watcher = createTurnCompletionWatcher({ transcriptTap: tap, hubSessionId: 's1', kind: 'codeagent',
    attempt: { sid: 's1', kind: 'codeagent' } });
  const pending = watcher.wait();
  watcher.markErrored('trusted_repo_required');
  const result = await pending;
  assert.equal(result.status, 'errored');
  assert.equal(result.failure.code, 'trusted_repo_required');
  assert.equal(result.failure.retryable, false);
  const Card = require('../renderer/groupchat-answer-card-state');
  const p = Card.plan({ message: { sid: 's1', status: 'errored', content: '' },
    failureText: '当前目录不在公司可信仓，CodeAgent 被风控', trustedRepoRequired: true, modelRevoked: true });
  assert.equal(p.running, false);
  assert.equal(p.body, 'failure');
  assert.equal(p.exposed[0], 'trustedRepo');
  assert.ok(!p.exposed.includes('modelChange'));
  assert.ok(!p.exposed.includes('retryFailed'));
  assert.equal(p.retry, '');
});

function fakeNoticeDom() {
  const make = () => ({ children: [], dataset: {}, listeners: {},
    append(...children) { children.forEach(child => { this.children.push(child); child.parent = this; }); },
    appendChild(child) { this.append(child); }, setAttribute() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector() { return this.children.find(child => child.className === 'codeagent-trusted-repo-notice') || null; },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
  });
  return { document: { createElement: make }, overlay: make() };
}

test('单会话就地提示可点选可信目录进入启动中心，取消不建会话', async () => {
  const UI = require('../renderer/codeagent-trusted-repo');
  const { document, overlay } = fakeNoticeDom();
  const opened = [];
  let workspace = { path: 'D:\\trusted-project', tier: 'project' };
  const windowRef = { WorkspaceController: { pickWorkspace: async () => workspace },
    LaunchCenter: { open: (...args) => opened.push(args) } };
  const session = { id: 's1', kind: 'codeagent', codeagentTrustedRepoRequired: true };
  const notice = UI.renderNotice(document, overlay, session, () => UI.openSession(windowRef));
  assert.equal(notice.children[0].textContent, UI.MESSAGE);
  assert.equal(notice.children[1].textContent, UI.ACTION);
  assert.equal(UI.renderNotice(document, overlay, session, () => {}), notice, '更新不重复插入');
  await notice.children[1].listeners.click();
  assert.deepEqual(opened, [['session', { kind: 'codeagent', workspace }]]);
  workspace = null;
  await notice.children[1].listeners.click();
  assert.equal(opened.length, 1);
  windowRef.WorkspaceController.pickWorkspace = async () => { throw new Error('选择器不可用'); };
  await notice.children[1].listeners.click();
  assert.match(notice.children[0].textContent, /选择目录失败：选择器不可用/);
  assert.equal(notice.children[1].disabled, false);
  assert.equal(session.cwd, undefined, '保留原会话目录');
  UI.renderNotice(document, overlay, { id: 's2', kind: 'codeagent' }, () => {});
  assert.equal(overlay.children.length, 0, '正常会话不留提示');
  assert.equal(UI.isBlocked(session, { status: 'completed' }), false, '旧回答不受当前报错影响');
});

test('群聊实际回答卡片同时呈现原因和目录按钮，保留已有正文', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../renderer/meeting-room'), 'utf8');
  const start = source.indexOf('  function _renderAnswerCard(');
  const end = source.indexOf('  function _renderGroupChatMessage(', start);
  const session = { id: 's1', kind: 'codeagent', codeagentTrustedRepoRequired: true, modelConfirmationRequired: true };
  const render = vm.runInNewContext(`(${source.slice(start, end)})`, {
    require: id => require('../renderer/' + id),
    sessions: new Map([['s1', session]]), _gcPanelState: {},
    AnswerCardState: require('../renderer/groupchat-answer-card-state'),
    escapeHtml: text => String(text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _renderMarkdown: text => text, _activeMeetingCwd: () => '',
    _gcFailReasonLabel: () => '', _renderGroupAvatar: () => '', _formatGroupChatTime: () => '',
    OrchUI: { defaultMinimized: () => false, roleBadge: () => '', peek: () => '' },
  });
  for (const content of ['', '已有的部分回答']) {
    const html = render({ id: 'a1', sid: 's1', status: 'errored', content, turnNum: 1 }, { id: 'g1' }, {});
    assert.match(html, /当前目录不在公司可信仓，CodeAgent 被风控/);
    assert.match(html, /data-gc-trusted-repo="s1">换到可信仓目录新建会话/);
    assert.doesNotMatch(html, /data-gc-model-revoked|data-gc-resend-member/);
    if (content) assert.ok(html.includes(content));
  }
});
