'use strict';
// 一键反馈精简版（2026-11-26）：只留版本系统、描述、当时状态、近期关键错误、CLI 结论；长度、脱敏自查。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { slimFeedback, leakCheck, parseLine, cliSummary, lifecycleSummary } = require('../core/hub-feedback-slim');
const { collectBundle } = require('../core/hub-feedback');

const HOME = 'C:\\Users\\zhangsan01';
const OPTS = { home: HOME, user: 'zhangsan01' };
// 别人的用户目录：拼出来，免得公开版扫描把测试数据当成本机路径。
const OTHER_SLASH = ['C:', 'Users', 'lisi99', 'x'].join('/');
const OTHER_BACK = ['C:', 'Users', 'wangwu', 'a'].join(String.fromCharCode(92));
const NOW = Date.parse('2026-11-26T12:00:00Z');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slim-'));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  fs.mkdirSync(path.join(dir, 'diagnostics'));
  const t = m => new Date(NOW - m * 60000).toISOString();
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(`${t(300 - i)} page-backstage {"view":"pty","sessions":${i},"window":{"bounds":{"x":0,"y":0}},"cwd":"${HOME.replace(/\\/g, '\\\\')}\\\\work"}`);
  rows.push(`${t(5)} error {"message":"spawn codeagent ENOENT at ${HOME.replace(/\\/g, '\\\\')}\\\\AppData\\\\npm\\\\codeagent.cmd","token":"abcdef1234567890"}`);
  rows.push(`${t(4)} error {"message":"spawn codeagent ENOENT at ${HOME.replace(/\\/g, '\\\\')}\\\\AppData\\\\npm\\\\codeagent.cmd"}`);
  rows.push(`${t(3)} info request ok errors=0 Authorization: Bearer abcdefghijklmnopqrstuvwxyz`);
  rows.push(`${t(60 * 24 * 10)} error very old failure should be skipped`);
  fs.writeFileSync(path.join(logs, 'codeagent-startup.log'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(logs, 'window-events.log'), rows.slice(0, 250).join('\n') + '\n');
  const life = (pid, events) => fs.writeFileSync(path.join(dir, 'diagnostics', `process-lifecycle-${pid}.jsonl`), events.map(e => JSON.stringify({ ts: t(30), pid, cwd: HOME, ...e })).join('\n') + '\n');
  life(1, [{ event: 'process-start' }, { event: 'process-exit', cleanExit: true, code: 0 }]);
  life(2, [{ event: 'process-start' }, { event: 'render-process-gone', reason: 'crashed', exitCode: -1073741819 }, { event: 'process-exit', cleanExit: true, code: 0 }]);
  return { dir, logs };
}

test('精简版长度不到旧诊断包的 1/4，且是分节 Markdown', () => {
  const { dir, logs } = fixture();
  const info = { productName: 'AI HUB-H', edition: '成员版', version: '5.6.124', electron: '38.2.0', platform: 'win32 10.0.26200', runtime: '会话 3 个' };
  const description = `CodeAgent 会话起不来，路径 ${HOME}\\work\\a.txt`;
  const old = collectBundle({ info, description, logsDir: logs, dataDir: dir, now: NOW, redactOpts: OPTS });
  const r = slimFeedback({ info, description, logsDir: logs, dataDir: dir, now: NOW, redactOpts: OPTS, ctx: { kind: 'codeagent' }, wantGroup: true });
  assert.ok(r.chars * 4 < old.chars, `精简 ${r.chars} 字 vs 旧 ${old.chars} 字`);
  for (const h of ['## 环境', '## 问题描述', '## 当时的状态', '## 近期关键错误']) assert.ok(r.text.includes(h), h);
  assert.match(r.text, /希望进群交流：是/);
  assert.match(r.text, /×2 \[codeagent-startup\] error · spawn codeagent ENOENT/);
  assert.doesNotMatch(r.text, /very old failure/);
  assert.doesNotMatch(r.text, /page-backstage|bounds/);
  assert.match(r.text, /异常 1 次/);
  assert.deepEqual(r.leaks, []);
});

test('脱敏：不带用户目录、用户名、令牌', () => {
  const { dir, logs } = fixture();
  const r = slimFeedback({ info: {}, description: `我的目录 ${OTHER_SLASH} 和 ${HOME}\\y，token=sk-abcdefghijklmnop1234`, logsDir: logs, dataDir: dir, now: NOW, redactOpts: OPTS });
  assert.deepEqual(leakCheck(r.text, OPTS), []);
  assert.doesNotMatch(r.text, /zhangsan01|lisi99|abcdefghijklmnop|abcdef1234567890/i);
  assert.match(r.text, /~\\y|~\/x/);
});

test('leakCheck 能查出残留', () => {
  assert.deepEqual(leakCheck('ok 文本', OPTS), []);
  assert.ok(leakCheck('at ' + OTHER_BACK, OPTS).includes('用户目录路径'));
  assert.ok(leakCheck('Bearer abcdefghijkl123', OPTS).includes('Bearer 令牌'));
  assert.ok(leakCheck('password=hunter2abc', OPTS).includes('口令或令牌字段'));
});

test('JSON 日志行只取时间和说明字段', () => {
  const p = parseLine('2026-11-26T10:00:00Z warn {"message":"boom","detail":{"huge":1},"code":"E1"}');
  assert.equal(p.at, Date.parse('2026-11-26T10:00:00Z'));
  assert.equal(p.text, 'warn · boom · code=E1');
});

test('CLI 诊断每个 CLI 只留一行', () => {
  const diag = ['## 本机 CLI 识别诊断（已打码）', 'AI Hub CLI 定位诊断 · 2026-11-26 10:00', '进程 PATH（30 个目录）：a ; b', '',
    '■ Codex：能用 · 版本 0.60', '  用的是：~\\npm\\codex.cmd（npm 全局 · v0.60）', '  查过的位置：', '    [找到] npm：~\\npm',
    '■ CodeAgent：没找到 · 没装'].join('\n');
  assert.deepEqual(cliSummary(diag), ['- Codex：能用 · 版本 0.60｜~\\npm\\codex.cmd', '- CodeAgent：没找到 · 没装']);
});

test('没有生命周期记录时不写这一行', () => {
  assert.equal(lifecycleSummary({ dataDir: path.join(os.tmpdir(), 'no-such-dir-xyz') }), '');
});

// ---- 2026-11-26 Codex 审查补的用例 ----
const { keyErrors, updateSummary } = require('../core/hub-feedback-slim');
function logsWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slim-r-'));
  const logs = path.join(dir, 'logs'); fs.mkdirSync(logs);
  for (const [name, rows] of Object.entries(files)) fs.writeFileSync(path.join(logs, name), rows.join('\n') + '\n');
  return { dir, logs };
}
const iso = m => new Date(NOW - m * 60000).toISOString();

test('审查 #2：结构上的故障不靠关键词也收；Error 对象取 name/message/位置；正常 error:false 不收', () => {
  const { dir, logs } = logsWith({ 'app.log': [
    `${iso(5)} {"ok":false,"error":"Cannot read properties of undefined (reading title)"}`,
    `${iso(4)} {"err":"bad gateway"}`,
    `${iso(3)} {"event":"uncaught-exception-monitor","error":{"name":"TypeError","message":"x is undefined","stack":"TypeError: x\\n    at app.js:42:7"}}`,
    `${iso(2)} {"ok":true,"error":false,"errorCount":0}`,
    `${iso(1)} {"event":"window-created","error":null}`,
  ] });
  const texts = keyErrors({ logsDir: logs, dataDir: dir, now: NOW, redactOpts: OPTS }).map(e => e.text).join('\n');
  assert.match(texts, /reading title/);
  assert.match(texts, /bad gateway/);
  assert.match(texts, /TypeError: x is undefined @ app\.js:42:7/);
  assert.doesNotMatch(texts, /window-created|errorCount/);
});

test('审查 #4：点名日志的报错不会被别的日志的十类新报错挤掉', () => {
  const noise = Array.from({ length: 12 }, (_, i) => `${iso(1)} error noise kind ${'abcdefghijkl'[i]} failed`);
  const { dir, logs } = logsWith({ 'company-w3.log': [`${iso(60)} W3 error: page missing`], 'noise.log': noise });
  const errs = keyErrors({ logsDir: logs, dataDir: dir, mention: '看 company-w3.log', now: NOW, redactOpts: OPTS });
  assert.equal(errs.length, 10);
  assert.match(errs[0].text, /page missing/);
});

test('审查 #3：更新结果读 .seen、去 BOM，只读不改名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slim-u-'));
  fs.mkdirSync(path.join(dir, 'app-update'));
  const file = path.join(dir, 'app-update', 'last-result.json.seen');
  fs.writeFileSync(file, '﻿' + JSON.stringify({ ok: false, version: '5.6.124', error: 'rollback fixture', rolledBack: true }));
  assert.match(updateSummary({ dataDir: dir }), /未成功 v5\.6\.124，已回滚：rollback fixture/);
  assert.ok(fs.existsSync(file));
});

test('审查 #1：外发的一行摘要也脱敏，查到残留就不带', () => {
  const { dir, logs } = fixture();
  const r = slimFeedback({ info: {}, description: `token=reviewOnlySecret1126 ${OTHER_BACK}\n第二行`, logsDir: logs, dataDir: dir, now: NOW, redactOpts: OPTS });
  assert.doesNotMatch(r.summary, /reviewOnlySecret1126|wangwu/);
  assert.deepEqual(leakCheck(r.summary, OPTS), []);
});
