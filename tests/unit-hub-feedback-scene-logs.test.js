'use strict';
// 一键反馈按出问题的场景挑日志（2026-11-24 WeLink 4 份反馈的日志摘录全被助理消息轮询日志占满，DSH、门户、桌宠日志一行没有）：
//   - 当前会话 / 页面 / 描述 → 场景；相关日志排在最前（logs/ 和 diagnostics/ 都找）；
//   - 轮询类日志每份最多 2 行；整包 44 KB 上限与脱敏不变；WeLink 精简版每份日志限行，相关日志没有报错行时也带最后 2 行。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { collectBundle, feedbackScenes, feedbackContext, recentLogs, sceneLogs, MAX_TOTAL_BYTES } = require('../core/hub-feedback');
const { compactFeedback } = require('../core/hub-feedback-welink');

const FAKE_KEY = ['sk', 'abcdefghijklmnop' + 'qrstuvwxyz123456'].join('-');
const ROUND = 'company-assistant-message-round.log';
function make(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-scene-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logsDir = path.join(dataDir, 'logs'), diag = path.join(dataDir, 'diagnostics');
  fs.mkdirSync(logsDir, { recursive: true }); fs.mkdirSync(diag, { recursive: true });
  const write = (dir, name, lines, ageMs) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const at = new Date(Date.now() - ageMs); fs.utimesSync(f, at, at);
  };
  // 刷得最勤的轮询日志：最新、满是 timeout/fail 字样。
  write(logsDir, ROUND, Array.from({ length: 3000 }, (_, i) => `{"round":${i},"error":"poll timeout fail ${'x'.repeat(120)}"}`), 0);
  for (let i = 0; i < 9; i++) write(logsDir, `noise-${i}.log`, Array.from({ length: 400 }, (_, k) => `noise ${i}-${k} failed ${'y'.repeat(150)}`), 1000 + i);
  write(logsDir, 'company-w3.log', ['{"ok":true,"kind":"todo"}', '{"ok":false,"error":"W3-OLDEST"}', '{"ok":false,"error":"W3-NEWEST 页面没有打开"}'], 86400e3);
  write(logsDir, 'acp-dsh-session.log', ['dsh start', 'DSH-NEWEST stream closed'], 86400e3);
  write(logsDir, 'codex-session.log', ['codex up', 'CODEX-NEWEST launch failed token=' + FAKE_KEY], 86400e3);
  write(diag, 'company-model-proxy.log', Array.from({ length: 80 }, (_, i) => `proxy ${i} ${'z'.repeat(400)}`).concat('PROXY-NEWEST upstream 502'), 86400e3);
  for (const [name, lines] of Object.entries(extra)) write(logsDir, name, lines, 86400e3);
  return { dataDir, logsDir, diag, write };
}

test('场景识别：页面优先，其次描述里提到的功能，再看会话类型', () => {
  assert.deepEqual(feedbackScenes({ kind: 'deepseek-acp', view: '门户' }), ['w3', 'dsh']);
  assert.deepEqual(feedbackScenes({ kind: 'codex-resume' }), ['codex']);
  assert.deepEqual(feedbackScenes({ kind: 'claude', description: '桌宠不说话了' }), ['pet']);
  assert.deepEqual(feedbackScenes({ kind: 'dsh' }), ['dsh']);
  assert.deepEqual(feedbackScenes({}), []);
});

test('DSH 会话：整包带 DSH 与公司模型诊断日志、排在最前；轮询日志只 2 行；不超 44 KB、照常脱敏', t => {
  const { dataDir, logsDir } = make(t);
  const b = collectBundle({ info: { version: '5.6.100' }, description: '回复卡住了', logsDir, dataDir, scenes: feedbackScenes({ kind: 'deepseek-acp' }) });
  assert.ok(b.bytes <= MAX_TOTAL_BYTES, String(b.bytes));
  const dsh = b.text.indexOf('## 日志 acp-dsh-session.log'), proxy = b.text.indexOf('diagnostics/company-model-proxy.log');
  assert.ok(dsh > 0 && proxy > 0, b.items.map(i => i.name).join(' | '));
  assert.ok(b.text.includes('DSH-NEWEST') && b.text.includes('PROXY-NEWEST'));
  assert.equal(b.text.split('diagnostics/company-model-proxy.log').length - 1, 1, '同一份只带一次');
  const round = b.text.indexOf(`## 日志 ${ROUND}`);
  assert.ok(round < 0 || round > dsh, '轮询日志排在相关日志之后');
  if (round > 0) assert.match(b.text.slice(round), /^## 日志 company-assistant-message-round\.log（最后 2 行/);
});

test('Codex 会话：带 codex 日志并打码；门户页：带 company-w3.log 最新一行', t => {
  const { dataDir, logsDir } = make(t);
  const c = collectBundle({ description: '开不了会话', logsDir, dataDir, scenes: feedbackScenes({ kind: 'codex' }) });
  assert.ok(c.text.includes('CODEX-NEWEST'));
  assert.ok(!c.text.includes(FAKE_KEY), '令牌已打码');
  const w = collectBundle({ description: '读不到', logsDir, dataDir, scenes: feedbackScenes({ view: '门户' }) });
  assert.ok(w.text.includes('W3-NEWEST') && w.bytes <= MAX_TOTAL_BYTES);
  // 不给场景时行为同旧版：company-w3.log 太旧，挤不进前 8 份。
  assert.ok(!recentLogs(logsDir).some(l => l.name === 'company-w3.log'));
  assert.ok(recentLogs(logsDir, fs, { scenes: ['w3'] }).some(l => l.name === 'company-w3.log'));
});

test('WeLink 精简版：相关日志在前，轮询日志最多 2 行，没有报错行的相关日志也带最后 2 行', t => {
  const { dataDir, logsDir } = make(t, { 'hub-pet-talk.log': ['pet idle', 'PET-NEWEST bubble shown'] });
  const text = compactFeedback({ description: '桌宠不说话了', logsDir, dataDir, scenes: feedbackScenes({ kind: 'deepseek-acp', description: '桌宠不说话了' }) });
  const lines = text.split('\n').filter(l => /^\[/.test(l));
  assert.ok(lines.length > 0, text);
  assert.ok(lines.some(l => l.includes('PET-NEWEST')), text);
  assert.ok(lines.some(l => l.includes('DSH-NEWEST')), text);
  assert.ok(lines.filter(l => l.startsWith(`[${ROUND}]`)).length <= 2, text);
  const first = lines.findIndex(l => l.startsWith(`[${ROUND}]`) || l.startsWith('[noise-'));
  const pet = lines.findIndex(l => l.includes('PET-NEWEST'));
  assert.ok(first < 0 || pet < first, '相关日志排在其他日志之前');
  assert.ok(text.length <= 3000);
});

// 审查修正（2026-11-24 Antigravity 审）：
test('外发边界：CodeAgent 切模型的整屏画面一律不带；diagnostics/ 只取白名单那一份', t => {
  const { dataDir, logsDir, diag, write } = make(t);
  write(logsDir, 'codeagent-model-picker-last.txt', ['SCREEN-SECRET 用户对话正文'], 0);
  write(logsDir, 'codeagent-model-picker-search.txt', ['SCREEN-SECRET2'], 0);
  write(logsDir, 'codeagent-model.log', ['CA-MODEL event=launch'], 0);
  write(diag, 'codeagent-prefix-fork.jsonl', ['DIAG-NOT-ALLOWED'], 0);
  const scenes = feedbackScenes({ kind: 'codeagent' });
  const names = sceneLogs({ logsDir, dataDir, scenes }).map(l => l.name);
  assert.ok(names.includes('codeagent-model.log'), names.join());
  assert.ok(!names.some(n => /model-picker|prefix-fork/.test(n)), names.join());
  for (const sc of [scenes, []]) {
    const b = collectBundle({ description: 'x', logsDir, dataDir, scenes: sc });
    assert.ok(!/SCREEN-SECRET|DIAG-NOT-ALLOWED/.test(b.text));
    assert.ok(!/SCREEN-SECRET|DIAG-NOT-ALLOWED/.test(compactFeedback({ description: 'error', logsDir, dataDir, scenes: sc })));
  }
});

test('DSH 场景的公司模型诊断保留 32 KB 窗口和原标题：10 KB 的单行探测记录不被当半行丢掉', t => {
  const { dataDir, logsDir, diag, write } = make(t);
  write(diag, 'company-model-proxy.log', Array.from({ length: 30 }, (_, i) => `proxy ${i} ${'z'.repeat(300)}`).concat(`first-init=${'p'.repeat(10 * 1024)} PROBE-END`, 'PROXY-TAIL'), 0);
  const b = collectBundle({ description: '卡住', logsDir, dataDir, scenes: feedbackScenes({ kind: 'dsh' }) });
  assert.match(b.text, /## 公司模型诊断 diagnostics\/company-model-proxy\.log/);
  assert.ok(b.text.includes('PROBE-END') && b.text.includes('PROXY-TAIL'));
  assert.ok(b.bytes <= MAX_TOTAL_BYTES);
});

test('开着页面时不带后台会话类型；场景日志按「页面 > 描述 > 会话」排，不按新旧', t => {
  assert.deepEqual(feedbackContext({ view: '门户', kind: 'deepseek-acp' }), { view: '门户', kind: '' });
  assert.deepEqual(feedbackContext({ view: '', kind: 'codex' }), { view: '', kind: 'codex' });
  const { dataDir, logsDir } = make(t);
  // DSH 日志更新（make 里门户日志是一天前的），场景顺序仍让门户排第一。
  fs.utimesSync(path.join(logsDir, 'acp-dsh-session.log'), new Date(), new Date());
  const names = sceneLogs({ logsDir, dataDir, scenes: ['w3', 'dsh'] }).map(l => l.name);
  assert.equal(names[0], 'company-w3.log', names.join());
});

test('WeLink 精简版：描述点名的日志排在场景日志之前（和整包一致）', t => {
  const { dataDir, logsDir } = make(t, { 'hub-feedback.log': ['{"via":"welink","error":"NAMED-NEWEST send failed"}'] });
  const text = compactFeedback({ description: '日志在 hub-feedback.log 里', logsDir, dataDir, scenes: ['dsh'] });
  const lines = text.split('\n').filter(l => /^\[/.test(l));
  assert.ok(lines[0] && lines[0].startsWith('[hub-feedback.log]'), text);
  assert.ok(lines.some(l => l.includes('DSH-NEWEST')), text);
});

// R37（2026-11-24 v5.6.102 反馈仍是助理轮询日志打头：用户一般不点名日志，停在 Claude 会话或分身/助理页时认不出场景）。
test('R37 场景表：分身、助理、PPT、更新、会议室、群聊、CodeAgent 页面与描述都能认出', () => {
  assert.deepEqual(feedbackScenes({ view: '分身' }), ['avatar']);
  assert.deepEqual(feedbackScenes({ view: '助理' }), ['assistant']);
  assert.deepEqual(feedbackScenes({ view: '会议室' }), ['meeting']);
  assert.deepEqual(feedbackScenes({ view: '群聊' }), ['group']);
  assert.deepEqual(feedbackScenes({ kind: 'meeting' }), ['meeting']);
  assert.deepEqual(feedbackScenes({ description: '- 出错的功能区：一键更新' }), ['update']);
  assert.deepEqual(feedbackScenes({ description: '- 出错的功能区：PPT 助手（PPT Doctor）' }), ['ppt']);
  assert.deepEqual(feedbackScenes({ description: '- 出错的功能区：公司模型反代' }), ['dsh']);
  assert.deepEqual(feedbackScenes({ view: '助理', description: 'CodeAgent 起不来' }), ['assistant', 'codeagent']);
  assert.deepEqual(feedbackScenes({ kind: 'claude' }), []);
});

test('R37 认不出场景（Claude 会话、没点名）：轮询日志不再打头，排在其余日志之后', t => {
  const { dataDir, logsDir } = make(t);
  const scenes = feedbackScenes({ kind: 'claude' });
  const order = recentLogs(logsDir, fs, { scenes }).map(l => l.name);
  assert.notEqual(order[0], ROUND, order.join());
  assert.ok(!order.includes(ROUND) || order.indexOf(ROUND) === order.length - 1, order.join());
  const b = collectBundle({ description: '回复卡住了', logsDir, dataDir, scenes });
  const first = /## 日志 (\S+?)（/.exec(b.text);
  assert.ok(first && first[1] !== ROUND, first && first[1]);
  const text = compactFeedback({ description: '回复卡住了', logsDir, dataDir, scenes });
  const lines = text.split('\n').filter(l => /^\[/.test(l));
  assert.ok(lines.length && !lines[0].startsWith(`[${ROUND}]`), text);
});

test('R37 助理页：助理的查询/执行日志在前，轮询日志即使是场景内也排最后、只 2 行', t => {
  const { dataDir, logsDir } = make(t, { 'company-assistant-query.log': ['q ok', 'QUERY-NEWEST welink query failed'], 'company-act.log': ['ACT-NEWEST ok'] });
  const scenes = feedbackScenes({ view: '助理' });
  const names = sceneLogs({ logsDir, dataDir, scenes }).map(l => l.name);
  assert.ok(names.includes('company-assistant-query.log') && names.includes('company-act.log'), names.join());
  assert.ok(!names.includes(ROUND), '轮询日志不算场景相关');
  const b = collectBundle({ description: '收不到消息', logsDir, dataDir, scenes });
  const q = b.text.indexOf('## 日志 company-assistant-query.log'), round = b.text.indexOf(`## 日志 ${ROUND}`);
  assert.ok(q > 0 && b.text.includes('QUERY-NEWEST'));
  assert.ok(round < 0 || round > q);
  if (round > 0) assert.match(b.text.slice(round), /^## 日志 company-assistant-message-round\.log（最后 2 行/);
  const text = compactFeedback({ description: '收不到消息', logsDir, dataDir, scenes });
  const tagged = text.split('\n').filter(l => /^\[/.test(l));
  assert.ok(/^\[company-(assistant-query|act)\.log\]/.test(tagged[0]) && tagged.some(l => l.includes('QUERY-NEWEST')), text);
});

test('R37 更新出问题：上次更新结果排在最前（保留原标题），不重复带', t => {
  const { dataDir, logsDir } = make(t);
  fs.mkdirSync(path.join(dataDir, 'app-update'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'app-update', 'last-result.json'), JSON.stringify({ ok: false, error: 'UPDATE-NEWEST 内源连不上' }));
  const b = collectBundle({ description: '- 出错的功能区：一键更新', logsDir, dataDir, scenes: feedbackScenes({ description: '- 出错的功能区：一键更新' }) });
  const upd = b.text.indexOf('## 更新结果 app-update/last-result.json');
  const firstLog = b.text.indexOf('## 日志 ');
  assert.ok(upd > 0 && (firstLog < 0 || upd < firstLog), b.items.map(i => i.name).join(' | '));
  assert.equal(b.text.split('## 更新结果 app-update/last-result.json').length - 1, 1);
  assert.ok(b.text.includes('UPDATE-NEWEST') && b.bytes <= MAX_TOTAL_BYTES);
});

// R37 审查（Antigravity）#1 #3 #5 #6
test('R37 审查 #1：追加的 CLI 识别诊断和排查会话头不参与场景识别，「出错的功能区」那一行优先', () => {
  const diag = '\n\n## 本机 CLI 识别诊断（已打码）\n■ Claude Code …\n■ Codex …\n■ CodeAgent …\n■ DSH …';
  assert.deepEqual(feedbackScenes({ description: '一键更新卡在 90%' + diag }), ['update']);
  assert.deepEqual(feedbackScenes({ description: '【Agent 排查结果】（来自排查会话「排查」，CodeAgent）\n- 出错的功能区：一键更新\n- 现象：下载失败，提到 CodeAgent 也要' }), ['update', 'codeagent']);
  assert.deepEqual(feedbackScenes({ description: '【Agent 排查结果】（来自排查会话「排查」，CodeAgent）\n- 出错的功能区：PPT 助手（PPT Doctor）' + diag }), ['ppt']);
});

test('R37 审查 #3：打开反馈时预览把预填的描述一起传过去（预览清单和实际发送按同一场景挑日志）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/hub-feedback.js'), 'utf8');
  assert.match(src, /invoke\('hub-feedback:preview', \{[^}]*description: desc\.value/);
});

test('R37 审查 #5：AI 群聊（kind=meeting / 群聊页）带 codeagent-startup-blocks.log', t => {
  const { dataDir, logsDir } = make(t, { 'codeagent-startup-blocks.log': ['GROUP-BLOCK startup blocked'] });
  for (const scenes of [feedbackScenes({ kind: 'meeting' }), feedbackScenes({ view: '群聊' })]) {
    assert.ok(sceneLogs({ logsDir, dataDir, scenes }).some(l => l.name === 'codeagent-startup-blocks.log'), scenes.join());
  }
});

test('R37 审查 #6：日志不多时轮询日志确实带上，但排在场景日志和其余日志之后、只 2 行', t => {
  const { dataDir, logsDir } = make(t, { 'company-assistant-query.log': ['QUERY-NEWEST welink query failed'] });
  for (const f of fs.readdirSync(logsDir)) if (f.startsWith('noise-')) fs.rmSync(path.join(logsDir, f));
  assert.ok(fs.readdirSync(logsDir).length <= 8, '总数不超过 MAX_LOG_FILES，轮询日志不会被截掉');
  const b = collectBundle({ description: '收不到消息', logsDir, dataDir, scenes: feedbackScenes({ view: '助理' }) });
  const q = b.text.indexOf('## 日志 company-assistant-query.log'), round = b.text.indexOf(`## 日志 ${ROUND}`);
  assert.ok(q > 0 && round > q, `query=${q} round=${round}`);
  const blocks = [...b.text.matchAll(/## 日志 (\S+?)（/g)].map(m => m[1]);
  assert.equal(blocks.at(-1), ROUND, blocks.join());
  assert.match(b.text.slice(round), /^## 日志 company-assistant-message-round\.log（最后 2 行/);
});
