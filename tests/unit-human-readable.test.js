'use strict';
// 2026-11-20 用户反馈：卡片、报错、授权卡里不让人读 JSON；原文都留折叠入口。样本取自助理前台真实转录。
const { test } = require('node:test'), assert = require('node:assert/strict');
const h = require('../core/human-readable');
const { normalizeToolActivity } = require('../core/turn-presentation');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const renderer = () => createTurnCardRenderer({ document: { addEventListener() {} }, window: {}, navigator: {}, escapeHtml: esc,
  marked: { parse: s => '<p>' + esc(s) + '</p>' }, DOMPurify: { sanitize: s => s }, formatAbsoluteTime: () => '', normalizeMarkdownPathBreaks: s => s });
const mcpWrap = obj => JSON.stringify([{ type: 'text', text: JSON.stringify(obj) }]);

const STUCK = { ok: false, state: 'unknown', sessionId: '1840b722', receipt: { ok: true, kind: 'codex', sendStatus: 'stuck', mode: 'closed-loop', enterAttempts: 2,
  receipt: { status: 'unconfirmed' } }, route: { tier: 'deep', kind: 'codex', model: 'gpt-6.1-sol', effort: 'high' } };

test('助理开会话没确认送达：标题说动作，状态是警示，不是「完成」', () => {
  const s = h.toolHumanSummary({ name: 'mcp__hub_assistant__create_session', input: { title: '助理页体验复盘' }, result: mcpWrap(STUCK) });
  assert.equal(s.title, '开新会话');
  assert.equal(s.subject, '助理页体验复盘');
  assert.equal(s.tone, 'warn');
  assert.equal(s.statusText, '没确认送达');
  assert.deepEqual(s.lines, ['会话已建好（Codex · gpt-6.1-sol · 高强度）', '任务已发出但没确认收到，可能卡在输入框（补按 2 次回车）']);
});

test('成功、失败、超长结果、工具名写错都给一句人话', () => {
  const ok = h.toolHumanSummary({ name: 'mcp__hub_assistant__claim_session', input: { session: '04c9', title: '智虎 LTG 作业取回' },
    result: JSON.stringify({ ok: true, title: '负责人·智虎', claim: { role: 'lead' }, note: '已登记为负责人：此后它的卡住、失败直接送它自己' }) });
  assert.equal(ok.tone, 'ok'); assert.deepEqual(ok.lines, ['已登记为负责人：此后它的卡住、失败直接送它自己']);
  const bad = h.toolHumanSummary({ name: 'mcp__hub_assistant__update_memory', input: { file: 'user', text: '仿真优先派远端' },
    result: '{"error":"USER.md 将超过 3000 字上限，请先用 rewrite 合并精简"}' });
  assert.equal(bad.tone, 'bad'); assert.equal(bad.subject, '仿真优先派远端'); assert.match(bad.lines[0], /3000 字上限/);
  const long = h.toolHumanSummary({ name: 'mcp__hub_assistant__list_sessions', input: {}, result: 'Error: result (916,284 characters across 1 line) exceeds maximum allowed tokens.' });
  assert.match(long.lines[0], /916,284 字/);
  const tasks = h.toolHumanSummary({ name: 'mcp__hub_assistant__list_tasks', input: { limit: 12 }, result: JSON.stringify({ ok: true, tasks: [1, 2, 3] }) });
  assert.deepEqual(tasks.lines, ['共 3 条任务']);
  const other = h.toolHumanSummary({ name: 'mcp__context7__query_docs', input: { query: 'react' }, result: '{"ok":true}' });
  assert.equal(other.title, 'context7 · query docs');
});

test('非 MCP 工具（Bash、Read）原样显示，不做投影', () => {
  assert.equal(h.toolHumanSummary({ name: 'Bash', input: { command: 'ls' }, result: '{"a":1}' }), null);
});

test('卡片工具行：人话在上，原始 JSON 收进「查看原始数据」，预览与复制按钮仍在', () => {
  const a = normalizeToolActivity({ id: 't1', name: 'mcp__hub_assistant__create_session', input: { title: '助理页体验复盘' }, result: mcpWrap(STUCK), status: 'completed' });
  const html = renderer().renderToolCluster('t', [a]);
  assert.match(html, /<span class="tc-row-name" title="mcp__hub_assistant__create_session">开新会话<\/span>/);
  assert.match(html, /没确认送达/);
  assert.match(html, /<ul class="tc-human"><li>会话已建好/);
  assert.match(html, /<details class="tc-raw"><summary>查看原始数据<\/summary>[\s\S]*data-result-raw/);
  assert.ok(html.indexOf('tc-human') < html.indexOf('data-result-raw'));
  assert.ok(html.includes('tc-copy-result') && html.includes('tc-toggle-preview'));
  const bash = renderer().renderToolCluster('t', [normalizeToolActivity({ id: 'b', name: 'Bash', input: { command: 'ls' }, result: 'a.txt', status: 'completed' })]);
  assert.ok(!bash.includes('tc-raw') && bash.includes('>Bash<'));
});

test('报错去掉英文前缀、把错误对象换成原因，原文留给技术详情', () => {
  const ipc = h.humanError(new Error("Error invoking remote method 'company-files:sync': Error: 同步失败：{\"code\":\"ENOENT\",\"path\":\"D:/a.pptx\"}"));
  assert.equal(ipc.text, '同步失败：找不到文件或目录，可能已被移动或删除');
  assert.match(ipc.detail, /ENOENT/);
  assert.equal(h.humanError("换场景失败：Error invoking remote method 'a:b': Error: 磁盘满了").text, '换场景失败：磁盘满了');
  assert.equal(h.humanError({ error: { message: 'Insufficient Balance' } }).text, '余额不足（Insufficient Balance）');
  assert.deepEqual(h.humanError('普通的中文报错'), { text: '普通的中文报错', detail: '' });
  const { noticeContent } = require('../renderer/ui-feedback');
  const n = noticeContent("保存失败：Error invoking remote method 'x:y': Error: EBUSY: resource busy or locked");
  assert.equal(n.body, '保存失败：文件正被别的程序占用（EBUSY: resource busy or locked）');
  assert.match(n.detail, /Error invoking remote method/);
  assert.equal(noticeContent('原始错误 <script>不可丢失</script>').body, '原始错误 <script>不可丢失</script>');
});

test('原生授权与 Codex 命令：字段换成中文名和人话取值，内部编号不显示', () => {
  assert.deepEqual(h.humanFields({ command: 'git push origin master', description: '推送主干', timeout: 120000 }),
    [['命令', 'git push origin master'], ['说明', '推送主干'], ['最长等待', '2 分钟']]);
  const status = h.humanCommandOutput({ model: 'gpt-6.1-sol', effort: 'high', approvalPolicy: 'on-request', sandbox: 'workspace-write', threadId: '019a' });
  assert.match(status, /^模型：gpt-6.1-sol\n思考强度：高\n授权方式：需要时问你\n沙箱：只能写工作目录\n/);
  assert.ok(!/^.*threadId.*$/m.test(status.split('原始数据')[0]));
  assert.match(status, /原始数据（排错用）：\n```json\n\{/);
  const mcp = h.humanCommandOutput({ profile: 'default', servers: [{ name: 'hub_assistant', status: 'ready' }, { name: 'context7', status: 'failed', error: 'spawn ENOENT' }] });
  assert.match(mcp, /共 2 项\n- hub_assistant · 就绪\n- context7 · 失败 · spawn ENOENT/);
});

test('卡片只带结果开头一段（半截 JSON）时也摘要点，不露半截 JSON', () => {
  const full = JSON.stringify({ ok: true, tasks: [{ id: 'T-1', title: '评估新仿真通道' }, { id: 'T-2', title: '二' }] });
  const s = h.toolHumanSummary({ name: 'mcp__hub_assistant__list_tasks', input: { limit: 12 }, result: full.slice(0, 60) });
  assert.equal(s.tone, 'ok');
  assert.match(s.lines[0], /第一项：评估新仿真通道/);
  assert.match(s.lines.at(-1), /全文见原始数据/);
  const wrapped = JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: false, error: '目标会话未打开' }) }]).slice(0, 70);
  const bad = h.toolHumanSummary({ name: 'mcp__hub_assistant__send_session', input: {}, result: wrapped });
  assert.equal(bad.tone, 'bad'); assert.equal(bad.lines[0], '目标会话未打开');
});
