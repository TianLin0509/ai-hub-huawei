'use strict';
// R40a 开销修复（2026-11-25）：忙时排队看护、CodeAgent 报错读屏、公司版账号/用量定时器。
// 每条既断言开销降下来（不重放、不重读），也断言原本要识别的提示照样识别。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---- 5. busy-queued-watch：转写尾部增量读 ----
const { fileUserPromptCount, clearPromptTailCache } = require('../core/busy-queued-watch');
function countingFs() {
  const real = require('node:fs');
  const stats = { bytes: 0, reads: 0 };
  return { stats, fs: { ...real, readSync: (fd, buf, off, len, pos) => { stats.reads++; const n = real.readSync(fd, buf, off, len, pos); stats.bytes += n; return n; } } };
}

test('忙时排队看护：文件没变只 stat 不重读，追加只读新增，重写整段重读', t => {
  clearPromptTailCache?.();
  const dir = tmp('r40a-bq-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  const since = Date.parse('2026-11-25T01:00:00Z');
  let n = 0;
  const line = (type, text) => JSON.stringify({ type, timestamp: '2026-11-25T01:00:10Z', uuid: 'u' + (n++), message: { role: type, content: text } }) + '\n';
  const filler = line('assistant', 'x'.repeat(500)).repeat(2000);
  fs.writeFileSync(file, filler + line('user', '帮我 跑测试'));
  const { stats, fs: cfs } = countingFs();
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 1);
  const firstBytes = stats.bytes;
  assert.ok(firstBytes > 1_000_000, '第一次读末尾一大段');
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 1);
  assert.equal(fileUserPromptCount(file, '另一条', since, { fs: cfs }), 0);
  assert.ok(stats.bytes - firstBytes < 200, `没变：不再读整段（实际多读 ${stats.bytes - firstBytes} 字节）`);
  const mid = stats.bytes;
  fs.appendFileSync(file, line('assistant', 'ok') + line('user', '帮我跑 测试'));
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 2, '追加的用户消息算进来');
  assert.ok(stats.bytes - mid < 1000, `追加：只读新增部分（实际 ${stats.bytes - mid} 字节）`);
  // 半行：没换行的尾巴这一次也算上，补齐换行后不重复算
  fs.appendFileSync(file, line('user', '帮我跑测试').trimEnd());
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 3);
  fs.appendFileSync(file, '\n');
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 3);
  // 重写成更长的不同内容：末尾指纹对不上，整段重读
  fs.writeFileSync(file, filler + line('assistant', 'y'.repeat(800)) + line('user', '别的'));
  assert.equal(fileUserPromptCount(file, '帮我跑测试', since, { fs: cfs }), 0);
  assert.equal(fileUserPromptCount(file, '别的', since, { fs: cfs }), 1);
});

// ---- 6. codeagent-screen-error：只扫新增输出，关键词只在新增或仍在屏上时才重放 ----
const { createScreenErrorWatch } = require('../core/codeagent-screen-error');
const ERR = ['  ✗ SessionRequestError', '  部门已启用外部模型管控，外部模型不可用。 [SessionRequestError_002]', ''];
function errorHarness() {
  const entry = { info: { id: 's1', kind: 'codeagent', agentRuntime: 'pty', status: 'running' }, agentTurnActive: false, lastOutputAt: 1, outputChars: 0 };
  const state = { text: '', rows: ['$'] };
  let renders = 0;
  const errors = [];
  const manager = { sessions: new Map([['s1', entry]]),
    noteAgentTurnFinished: () => { if (!entry.agentTurnActive) return false; entry.agentTurnActive = false; return true; } };
  const watch = createScreenErrorWatch({ manager, readScreen: () => ({ text: state.text }), renderRows: async () => { renders++; return state.rows; },
    onError: e => errors.push(e), now: () => 1 });
  const out = (chunk, rows) => { state.text += chunk; entry.outputChars += chunk.length; entry.lastOutputAt++; if (rows) state.rows = rows; };
  return { entry, state, watch, errors, out, renders: () => renders };
}

test('报错读屏：缓冲里早先的「信任 / 风控」不再让每次新输出都重放终端', async () => {
  const h = errorHarness();
  h.out('我们讨论一下风控和信任的设计。' + 'a'.repeat(5000), ['普通回答']);
  await h.watch.tick();
  const afterFirst = h.renders();
  assert.ok(afterFirst <= 1, '第一次读屏最多渲染一次');
  for (let i = 0; i < 5; i++) { h.out('more output ' + i, ['普通回答 ' + i]); await h.watch.tick(); }
  assert.equal(h.renders(), afterFirst, '新增输出里没有关键词、上一屏也没有：不重放');
});

test('报错读屏：回合里新出现的 SessionRequestError 照样识别；滚走后再报同样的错也识别', async () => {
  const h = errorHarness();
  h.out('hello', ['hello']);
  await h.watch.tick();
  h.entry.agentTurnActive = true;
  h.out('\x1b[31m✗ SessionRequestError\x1b[0m\r\n部门已启用外部模型管控', ['hello', ...ERR]);
  await h.watch.tick();
  assert.equal(h.errors.length, 1, '新报错结束这一轮');
  const r = h.renders();
  h.out('redraw', ['hello', ...ERR]);
  await h.watch.tick();
  assert.equal(h.renders(), r + 1, '屏上还有报错：有新输出照旧渲染（可能在重绘）');
  h.out('lots of other output ' + 'b'.repeat(300), ['other']);
  await h.watch.tick();
  const r2 = h.renders();
  h.out('more', ['other 2']);
  await h.watch.tick();
  assert.equal(h.renders(), r2, '报错滚出屏幕后回到不重放');
  h.entry.agentTurnActive = true;
  h.out('✗ SessionRequestError\r\n部门已启用外部模型管控', ['other 2', ...ERR]);
  await h.watch.tick();
  assert.equal(h.errors.length, 2, '下一轮又报同样的错照样识别');
});

test('报错读屏：拿不到累计输出字符数时照旧看最近 300 KB（兼容旧调用方）', async () => {
  const h = errorHarness();
  delete h.entry.outputChars;
  h.state.text = '✗ SessionRequestError'; h.state.rows = ERR; h.entry.agentTurnActive = true;
  await h.watch.tick();
  assert.equal(h.errors.length, 1);
});

test('报错读屏：可信目录类报错的关键词在粗筛范围内（以前漏掉「可信目录」）', async () => {
  const h = errorHarness();
  h.out('ok', ['ok']);
  await h.watch.tick();
  h.entry.agentTurnActive = true;
  h.out('✗ 当前目录不在公司可信目录', ['✗ 当前目录不在公司可信目录', '']);
  await h.watch.tick();
  assert.equal(h.errors.length, 1);
  assert.ok(h.errors[0].trustedRepoRequired);
});

test('忙时排队看护：看护全部结束停表、或整体释放时，清掉转写尾部缓存', t => {
  const { createBusyQueuedWatch, promptTailCacheSize } = require('../core/busy-queued-watch');
  clearPromptTailCache();
  const dir = tmp('r40a-bq-clear-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-11-25T01:00:10Z', uuid: 'u1', message: { role: 'user', content: '跑测试' } }) + '\n');
  const make = () => createBusyQueuedWatch({ isSessionAlive: () => true, processToken: () => 'p', isTurnActive: () => true,
    notify() {}, pollMs: 3_600_000, logger: { warn() {} } });
  const w = make();
  w.track({ sessionId: 's1', clientSubmissionId: 'c1', text: '跑测试' });
  fileUserPromptCount(file, '跑测试', 0);
  assert.equal(promptTailCacheSize(), 1, '看护中缓存保留');
  w.resolve('s1', 'c1');
  assert.equal(promptTailCacheSize(), 0, '最后一条核销、停表时缓存一起清');
  const w2 = make();
  w2.track({ sessionId: 's2', clientSubmissionId: 'c2', text: '跑测试' });
  fileUserPromptCount(file, '跑测试', 0);
  assert.equal(promptTailCacheSize(), 1);
  w2.dispose();
  assert.equal(promptTailCacheSize(), 0, '整体释放时缓存一起清');
});

test('报错读屏：会话原地重启（同一会话换了新终端进程）后，新进程再报同样的错照样识别', async () => {
  const h = errorHarness();
  h.entry.pty = { pid: 1 };
  h.out('✗ SessionRequestError\r\n部门已启用外部模型管控', ERR);
  await h.watch.tick();
  assert.equal(h.errors.length, 0, '不在回合中：旧进程屏上的报错只进基线');
  // 两次轮询之间原地重启：新终端进程，缓冲和累计输出字符数从头算
  h.entry.pty = { pid: 2 };
  h.state.text = ''; h.entry.outputChars = 0;
  h.entry.agentTurnActive = true;
  h.out('✗ SessionRequestError\r\n部门已启用外部模型管控', ERR);
  await h.watch.tick();
  assert.equal(h.errors.length, 1, '旧进程的基线作废，新进程这一轮的报错要报');
});

test('报错读屏：窄屏带盒边框折行时，跨行关键词仍认作「屏上还挂着」，下一拍继续读屏', async () => {
  const h = errorHarness();
  h.out('ok', ['ok']);
  await h.watch.tick();
  h.out('SessionRequestError' + ' '.repeat(200), ['│ ✗ Session│', '│RequestError│']);
  await h.watch.tick();
  const r = h.renders();
  h.out('redraw ' + 'x'.repeat(200), ['│ ✗ Session│', '│RequestError│']);
  await h.watch.tick();
  assert.equal(h.renders(), r + 1, '去掉边框拼起来能认出关键词：有新输出就接着渲染');
});

// ---- 8. 公司版账号/用量定时器按 features 开关 ----
test('公司版关掉多账号、额度条时不起出口核对与订阅额度刷新定时器', () => {
  const main = fs.readFileSync(require.resolve('../main.js'), 'utf8').split('\r\n').join('\n');
  assert.match(main, /if \(require\('\.\/core\/distribution'\)\.featureEnabled\('accounts'\)\) \{\n\s*const guardLog/, '出口核对块受 accounts 开关管');
  assert.match(main, /function subscriptionUsageShown\(\)[\s\S]{0,200}featureEnabled\('quotaBar'\) \|\| distribution\.featureEnabled\('accounts'\)/);
  const scanner = main.slice(main.indexOf('function startAgentScanner()'), main.indexOf('app.whenReady()', main.indexOf('function startAgentScanner()')));
  assert.match(scanner, /if \(usageShown\) \{\n\s*void claudeAccountRefresh\.tick\(\);\n\s*const codexRefresh/, '5 秒定时里的 Claude / Codex / Kimi 额度刷新受开关管');
  assert.match(scanner, /usageShown && \(!process\.env\.CLAUDE_HUB_HOME_DIR/, 'Antigravity 额度刷新受开关管');
  assert.match(scanner, /\n {4}refreshDeepSeekBalanceIfDue\(false\);/, 'DeepSeek 余额（首页低余额提醒）照旧');
  assert.match(scanner, /void refreshTokenPlanUsage\(\)/, 'Token Plan 用量（自动改走 DeepSeek API）照旧');
  assert.match(main, /const CLAUDE_QUOTA_HINT_REFRESH_MS = 5 \* 60_000;/, 'Claude 5h 提醒的低频刷新是 5 分钟');
  assert.match(scanner, /if \(!usageShown && !_claudeQuotaHintInterval\) \{\n\s*_claudeQuotaHintInterval = setInterval\(\(\) => \{ void claudeAccountRefresh\.tick\(\); \}, CLAUDE_QUOTA_HINT_REFRESH_MS\);/,
    '公司版保留 Claude 5h 提醒每 5 分钟一次的后台刷新');
  assert.doesNotMatch(scanner.slice(scanner.indexOf('_claudeQuotaHintInterval = setInterval') - 300, scanner.indexOf('_claudeQuotaHintInterval = setInterval')), /lowOverhead/,
    '低开销模式不关这一档');
  assert.match(main, /app\.on\('browser-window-focus', \(\) => \{ void claudeAccountRefresh\.tick\('focus'\); \}\);/, '窗口获焦刷新照旧');
  const edition = JSON.parse(fs.readFileSync(require.resolve('../community-edition.json'), 'utf8'));
  assert.equal(edition.features.accounts, false);
  assert.equal(edition.features.quotaBar, false);
});
