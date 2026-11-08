'use strict';
// 「问问 Agent」闭环（5.5.31）：排查会话识别、【排查结论】块提取、反馈文本拼接、顶栏按钮的显示与预填。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tf = require('../renderer/troubleshoot-feedback');

const DATA = path.join('D:', 'hub-data');
const BLOCK = ['【排查结论】', '状态：未解决', '原因：welink-cli 不在 PATH 上', '证据：logs/company-assistant-welink.log 10:02 spawn ENOENT', '已做的修改：无',
  '建议用户做的：重装 welink-cli', '给维护人的说明：复现：打开助理页；怀疑 core/company-assistant/welink.js', '【排查结论完】'].join('\n');

test('排查会话识别：只认 <数据目录>/troubleshoot/ 下的一层子目录，大小写和斜杠不敏感', () => {
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot', '20261108101500-ab12'), DATA), true);
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot', '20261108101500-ab12') + path.sep, DATA), true);
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'TROUBLESHOOT', 'x').toUpperCase(), DATA), process.platform === 'win32');
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot'), DATA), false);
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot', 'a', 'b'), DATA), false);
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot-old', 'a'), DATA), false);
  assert.equal(tf.isTroubleshootCwd(path.join('D:', 'work', 'troubleshoot', 'a'), DATA), false);
  assert.equal(tf.isTroubleshootCwd('', DATA), false);
  assert.equal(tf.isTroubleshootCwd(path.join(DATA, 'troubleshoot', 'a'), ''), false);
});

test('结论块提取：截出首尾标记之间的内容；多块取最后一个；去掉代码围栏；没有结束标记照取并标出', () => {
  const one = tf.extractConclusion('先说判断……\n\n' + BLOCK + '\n\n有问题再叫我。');
  assert.equal(one.text, BLOCK);
  assert.equal(one.complete, true);
  const two = tf.extractConclusion(BLOCK.replace('未解决', '已解决') + '\n后来又查了一下：\n' + BLOCK);
  assert.match(two.text, /状态：未解决/);
  assert.doesNotMatch(two.text, /已解决/);
  const fenced = tf.extractConclusion('```\n' + BLOCK + '\n```');
  assert.equal(fenced.text, BLOCK);
  const open = tf.extractConclusion('【排查结论】\n状态：需要用户操作\n原因：还在查');
  assert.equal(open.complete, false);
  assert.match(open.text, /^【排查结论】\n状态：需要用户操作\n原因：还在查\n【排查结论完】$/);
  assert.equal(tf.extractConclusion('没有结论'), null);
  assert.equal(tf.extractConclusion(null), null);
});

test('选结论：取最后一个带结论块的回答（之后的闲聊不影响）；都没有时取最后一条回答末尾约 3000 字', () => {
  const turns = [
    { role: 'user', text: '首句里有格式说明：\n' + BLOCK.replace('未解决', '用户首句') },
    { role: 'assistant', text: '初步判断……' },
    { role: 'assistant', text: '查完了。\n' + BLOCK },
    { role: 'user', text: '好的谢谢' },
    { role: 'assistant', text: '不客气。' },
  ];
  const hit = tf.pickConclusion(turns);
  assert.equal(hit.found, true);
  assert.equal(hit.text, BLOCK);
  const long = '甲'.repeat(5000) + '最后一句';
  const miss = tf.pickConclusion([{ role: 'user', text: BLOCK }, { role: 'assistant', text: long }]);
  assert.equal(miss.found, false, '用户首句里的格式说明不算 Agent 的结论');
  assert.ok(miss.text.endsWith('最后一句'));
  assert.ok(miss.text.length <= 3001);
  assert.equal(tf.pickConclusion([], '回退文本\n' + BLOCK).found, true, '读不到记录时用最后一条回答兜底');
  assert.deepEqual(tf.pickConclusion([]), { text: '', found: false, complete: false });
});

test('反馈文本：结论在前，原始报错上下文在后，留一行补充；没有结论块时注明', () => {
  const ctx = { area: 'welink', areaLabel: 'WeLink 助理', title: 'WeLink 工具查找未完成', symptom: '找不到 welink-cli', details: 'spawn welink-cli ENOENT' };
  const text = tf.feedbackDescription({ conclusion: { text: BLOCK, found: true, complete: true }, ctx, sessionTitle: '排查：WeLink 工具查找未完成', kindLabel: 'CodeAgent' });
  assert.ok(text.startsWith('【Agent 排查结果】（来自排查会话「排查：WeLink 工具查找未完成」，CodeAgent）\n【排查结论】'));
  for (const part of ['【原始报错上下文】', '- 出错的功能区：WeLink 助理', '- 现象：找不到 welink-cli', '- 界面提示：WeLink 工具查找未完成', 'spawn welink-cli ENOENT', '【补充】（可以在这里补一句']) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf('【排查结论完】') < text.indexOf('【原始报错上下文】'));
  const fallback = tf.feedbackDescription({ conclusion: { text: '最后的回答', found: false }, ctx: {} });
  assert.match(fallback, /没有按格式输出【排查结论】/);
  assert.match(fallback, /没有找到开会话时保存的报错上下文/);
});

test('上下文文件：写进排查目录、读回来；目录里没有时返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ctx-'));
  try {
    assert.equal(tf.readContext(dir), null);
    tf.writeContext(dir, { sessionId: 's1', ctx: { title: '中文标题' } });
    assert.deepEqual(tf.readContext(dir), { sessionId: 's1', ctx: { title: '中文标题' } });
    assert.ok(fs.existsSync(path.join(dir, tf.CONTEXT_FILE)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 极简 DOM：只够按钮挂载、文字替换和 querySelector('.btn-file-manager-toggle')。
function fakeDom() {
  const mk = (tag) => {
    const node = { tagName: tag, children: [], parentNode: null, hidden: false, className: '', listeners: {}, textContent: '',
      get firstChild() { return this.children[0] || null; }, get lastChild() { return this.children[this.children.length - 1] || null; },
      get isConnected() { return !!this.parentNode; },
      set innerHTML(v) { this.children = [{ textContent: '', parentNode: this }]; },
      append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } },
      insertBefore(n, ref) { if (n.parentNode) n.remove(); n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); },
      remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; } },
      querySelector(sel) { return this.children.find(c => String(c.className || '').split(' ').includes(sel.replace(/^\./, ''))) || null; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
    };
    return node;
  };
  const area = mk('div');
  const files = mk('button'); files.className = 'btn-zoom btn-file-manager-toggle';
  area.append(files);
  const doc = { createElement: mk, createTextNode: text => ({ textContent: text }), getElementById: id => (id === 'toolbar-actions' ? area : null) };
  return { doc, area, files };
}

test('顶栏按钮：只在排查会话且有一键反馈入口时出现，放在「文件管理」前；点了预填结论和原始报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ui-'));
  const cwd = path.join(dir, 'troubleshoot', '20261108101500-ab12');
  fs.mkdirSync(cwd, { recursive: true });
  tf.writeContext(cwd, { sessionId: 's1', ctx: { areaLabel: '一键更新', title: '更新没完成', details: 'sha256 mismatch' } });
  try {
    const { doc, area, files } = fakeDom();
    let session = { id: 's1', kind: 'codeagent', title: '排查：更新没完成', cwd };
    let feedbackOn = true;
    const opened = [];
    const invoked = [];
    const ipcRenderer = { invoke: async (channel, payload) => {
      invoked.push(channel);
      if (channel === 'parse-session-transcript') { assert.equal(payload.hubSessionId, 's1'); return { turns: [{ role: 'assistant', text: '结论：\n' + BLOCK }, { role: 'assistant', text: '还有别的吗？' }] }; }
      return null;
    } };
    const ui = tf.createTroubleshootFeedbackUi({ document: doc, ipcRenderer, getSession: () => session, getDataDir: () => dir,
      openFeedback: () => (feedbackOn ? prefill => opened.push(prefill) : null), kindLabel: () => 'CodeAgent' });
    ui.sync(true);
    assert.equal(ui.button.hidden, false);
    assert.deepEqual(area.children, [ui.button, files]);
    assert.equal(ui.button.lastChild.textContent, '把排查结果反馈给维护人');
    ui.sync(true);
    assert.equal(area.children.length, 2, '重复同步不重复插入');
    const r = await ui.run();
    assert.deepEqual(r, { ok: true, found: true });
    assert.deepEqual(invoked, ['parse-session-transcript'], '记录里有结论时不再多读最后一条回答');
    assert.equal(opened.length, 1);
    for (const part of [BLOCK, '- 出错的功能区：一键更新', 'sha256 mismatch', '「排查：更新没完成」']) assert.ok(opened[0].description.includes(part), part);
    assert.equal(ui.button.lastChild.textContent, '把排查结果反馈给维护人');
    session = { ...session, id: 's2', cwd: path.join(dir, 'work') };
    ui.sync(true);
    assert.equal(ui.button.hidden, true);
    assert.deepEqual(area.children, [files], '普通会话不显示');
    session = { ...session, cwd };
    feedbackOn = false;
    ui.sync(true);
    assert.equal(ui.button.hidden, true, '没有一键反馈入口的发行版不显示');
    feedbackOn = true;
    ui.sync(false);
    assert.equal(ui.button.hidden, true, '不在会话视图时不显示');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
