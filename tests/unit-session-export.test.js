'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionExporter, exportFileName, formatSessionMarkdown } = require('../renderer/session-export');
const { defaultDirectory, saveSessionExport } = require('../main/ipc/session-export-handlers');

const NOW = new Date(2026, 10, 6, 15, 40);

test('文件名去掉 Windows 不允许的字符，带上时间，太长就截断', () => {
  assert.equal(exportFileName('改 a/b:c*d?', NOW), '改 a b c d-20261106-1540.md');
  assert.equal(exportFileName('', NOW), '对话-20261106-1540.md');
  assert.equal(exportFileName('CON', NOW), '对话-20261106-1540.md');
  assert.equal(exportFileName('结尾有点...', NOW), '结尾有点-20261106-1540.md');
  assert.ok(exportFileName('长'.repeat(200), NOW).length <= 40 + '-20261106-1540.md'.length);
});

test('正文保留代码缩进，按「我 / AI」排，轮数只数用户提问', () => {
  const { text, rounds } = formatSessionMarkdown({ title: '修复 bug', kind: 'codeagent', now: NOW, turns: [
    { role: 'user', text: '看下这段\r\n```\n    缩进保留\n```' },
    { role: 'assistant', text: '好的\n\n    四格缩进', model: 'GLM-5.2-WX-Auto' },
    { role: 'user', text: '再看下' },
    { role: 'assistant', text: '继续', model: 'GLM-5.2-WX-Auto' },
  ] });
  assert.equal(rounds, 2);
  assert.match(text, /^# 修复 bug\n/);
  assert.match(text, /共 2 轮问答/);
  assert.match(text, /## 我\n\n看下这段\n```\n {4}缩进保留\n```/);
  assert.match(text, /## AI（CodeAgent · GLM-5.2-WX-Auto）\n\n好的\n\n {4}四格缩进/);
});

test('CodeAgent 会话不显示解析器标的 claude，其他会话沿用回合自己的来源', () => {
  const turns = [{ role: 'user', text: '问' }, { role: 'assistant', kind: 'claude', text: '答' }];
  assert.match(formatSessionMarkdown({ title: 't', kind: 'codeagent', now: NOW, turns }).text, /## AI（CodeAgent）/);
  assert.match(formatSessionMarkdown({ title: 't', kind: 'claude', now: NOW, turns }).text, /## AI（Claude）/);
});

test('助理注入的上下文不导出，只留用户原话；命令记录和空回合跳过，重复的回答只留一份', () => {
  const { text, rounds } = formatSessionMarkdown({ title: 't', now: NOW, turns: [
    { role: 'user', text: '系统注入的一大段上下文', assistantContext: { userText: '我的原话' } },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: '回答' },
    { role: 'assistant', text: '回答' },
    { role: 'user', text: '/compact', source: 'hub-command' },
    { role: 'tool', text: '工具输出' },
  ] });
  assert.equal(rounds, 1);
  assert.ok(text.includes('我的原话'));
  assert.ok(!text.includes('系统注入'));
  assert.ok(!text.includes('/compact'));
  assert.ok(!text.includes('工具输出'));
  assert.equal(text.match(/回答/g).length, 1);
});

function exporter(answers) {
  const calls = [], toasts = [];
  const instance = createSessionExporter({
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(payload) : answer;
    },
    getSession: id => (id === 's1' ? { id, title: '标题', kind: 'codeagent', cwd: 'D:/w', transcriptPath: 'x.jsonl' } : null),
    toast: (message, level) => toasts.push({ message, level }),
    now: () => NOW,
  });
  return { instance, calls, toasts };
}
const TURNS = { turns: [{ role: 'user', text: '问' }, { role: 'assistant', text: '答' }] };

test('取全量记录后保存，提示里带轮数和路径', async () => {
  const { instance, calls, toasts } = exporter({ 'parse-session-transcript': TURNS, 'session-export:save': { ok: true, filePath: 'D:/w/x.md' } });
  const result = await instance.run('s1');
  assert.deepEqual(result, { ok: true, filePath: 'D:/w/x.md', rounds: 1 });
  assert.equal(calls[0].payload.opts.limit, Infinity);
  assert.equal(calls[0].payload.opts.includeBranchHistory, true);
  assert.equal(calls[1].payload.suggestedName, '标题-20261106-1540.md');
  assert.equal(calls[1].payload.cwd, 'D:/w');
  assert.match(toasts[0].message, /已导出 1 轮问答：D:\/w\/x\.md/);
});

test('用户在对话框点取消时安静结束', async () => {
  const { instance, toasts } = exporter({ 'parse-session-transcript': TURNS, 'session-export:save': { ok: true, canceled: true } });
  assert.deepEqual(await instance.run('s1'), { ok: true, canceled: true });
  assert.equal(toasts.length, 0);
});

test('读记录失败、记录是空的、写文件失败都有人话提示', async () => {
  let t = exporter({ 'parse-session-transcript': new Error('文件被占用') });
  assert.equal((await t.instance.run('s1')).reason, 'read-failed');
  assert.match(t.toasts[0].message, /文件被占用/);
  assert.equal(t.toasts[0].level, 'error');

  t = exporter({ 'parse-session-transcript': { error: '找不到' } });
  assert.equal((await t.instance.run('s1')).reason, 'read-failed');

  t = exporter({ 'parse-session-transcript': { turns: [] } });
  assert.equal((await t.instance.run('s1')).reason, 'empty');
  assert.equal(t.calls.length, 1);

  t = exporter({ 'parse-session-transcript': TURNS, 'session-export:save': { ok: false, error: '磁盘满了' } });
  assert.equal((await t.instance.run('s1')).reason, 'save-failed');
  assert.match(t.toasts[0].message, /磁盘满了/);

  t = exporter({ 'parse-session-transcript': TURNS, 'session-export:save': new Error('通道断了') });
  assert.equal((await t.instance.run('s1')).reason, 'save-failed');

  t = exporter({});
  assert.equal((await t.instance.run('不存在')).reason, 'no-session');
});

test('保存：默认放工作目录，目录没了退回文档；取消不写文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-export-'));
  try {
    assert.equal(await defaultDirectory(dir, 'FALLBACK'), dir);
    assert.equal(await defaultDirectory(path.join(dir, '没有这个目录'), 'FALLBACK'), 'FALLBACK');
    assert.equal(await defaultDirectory(null, 'FALLBACK'), 'FALLBACK');

    const target = path.join(dir, '导出.md');
    let seen = null;
    const saved = await saveSessionExport({ content: '内容', suggestedName: '../逃出去.md', cwd: dir }, {
      env: {}, documentsDir: 'FALLBACK', showSaveDialog: async options => { seen = options; return { canceled: false, filePath: target }; },
    });
    assert.deepEqual(saved, { ok: true, filePath: target });
    assert.equal(fs.readFileSync(target, 'utf8'), '内容');
    assert.equal(seen.defaultPath, path.join(dir, '逃出去.md'), '建议文件名不能带目录');
    assert.match(seen.title, /敏感内容/);

    const canceled = await saveSessionExport({ content: '内容2', cwd: dir }, {
      env: {}, documentsDir: 'FALLBACK', showSaveDialog: async () => ({ canceled: true }),
    });
    assert.deepEqual(canceled, { ok: true, canceled: true });
    assert.equal(fs.readFileSync(target, 'utf8'), '内容');

    assert.equal((await saveSessionExport({ content: '' }, { env: {}, showSaveDialog: async () => assert.fail('不该弹框') })).ok, false);
    const noDir = await saveSessionExport({ content: 'x' }, { env: {}, documentsDir: dir,
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, '没有这个目录', 'a.md') }) });
    assert.equal(noDir.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('只有隔离实例才能跳过对话框', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-export-'));
  try {
    const target = path.join(dir, 'scripted.md');
    let dialogs = 0;
    const showSaveDialog = async () => { dialogs += 1; return { canceled: true }; };
    await saveSessionExport({ content: 'x' }, { env: { AI_HUB_SESSION_EXPORT_PATH: target }, documentsDir: dir, showSaveDialog });
    assert.equal(dialogs, 1);
    assert.equal(fs.existsSync(target), false);
    const saved = await saveSessionExport({ content: 'x' }, { env: { AI_HUB_SESSION_EXPORT_PATH: target, CLAUDE_HUB_E2E_WINDOW_MODE: 'hidden' }, documentsDir: dir, showSaveDialog });
    assert.equal(saved.filePath, target);
    assert.equal(dialogs, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
