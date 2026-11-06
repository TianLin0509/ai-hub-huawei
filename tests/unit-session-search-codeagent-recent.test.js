'use strict';

// 公司版会话以 CodeAgent 为主：昨日之我默认「我的提问 + 最近 7 天」走常驻内存，
// 这里守住 CodeAgent 记录走的是同一条快路径，并且「我的提问」只认用户真正说的话：
// 普通提问、技能命令（/技能 + 参数）算；注入的 <system-reminder>、技能正文（isMeta）不算。
// 用真实的记录目录 → 来源解析 → SQLite 索引 → 查询，不走模拟数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectSourceDescriptors, parseSourceDescriptor } = require('../core/session-search-sources.js');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');
const { QuerySnapshot, normalizeRequest } = require('../core/session-search-query.js');

const DAY = 24 * 60 * 60 * 1000;

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-codeagent-'));
  const claudeRoot = path.join(temp, 'claude', 'projects');
  const codeagentRoot = path.join(temp, 'codeagent', 'projects');
  const now = Date.now();
  const iso = at => new Date(at).toISOString();
  const sid = '11111111-2222-4333-8444-555555555555';
  const row = (uuid, type, at, content, extra = {}) => ({ type, uuid, sessionId: sid, cwd: temp, timestamp: iso(at), message: { role: type, content }, ...extra });
  writeJsonl(path.join(codeagentRoot, 'proj', `${sid}.jsonl`), [
    row('u0', 'user', now - 2 * DAY - 1000, '<system-reminder>REMINDERONLY 注入的提示</system-reminder>'),
    row('u1', 'user', now - 2 * DAY, 'CAMARK 帮我查一下调度日志'),
    row('a1', 'assistant', now - 2 * DAY + 10, [{ type: 'text', text: 'CAANSWER 调度日志里有超时' }]),
    row('u2', 'user', now - 1 * DAY, '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>SKILLARG 看看这次改动</command-args>'),
    row('u3', 'user', now - 1 * DAY + 5, [{ type: 'text', text: 'SKILLBODY 技能正文，不是用户说的话' }], { isMeta: true }),
    row('a2', 'assistant', now - 1 * DAY + 10, [{ type: 'text', text: '改动没问题' }]),
  ]);
  const claudeSid = '99999999-2222-4333-8444-555555555555';
  writeJsonl(path.join(claudeRoot, 'proj', `${claudeSid}.jsonl`), [
    { type: 'user', uuid: 'c1', sessionId: claudeSid, cwd: temp, timestamp: iso(now - DAY), message: { role: 'user', content: 'CAMARK 另一个 Claude 会话' } },
    { type: 'assistant', uuid: 'c2', sessionId: claudeSid, cwd: temp, timestamp: iso(now - DAY + 10), message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
  ]);
  const index = new SqliteSessionSearchIndex(path.join(temp, 'search.sqlite'));
  // 先关库再删目录：Windows 上库文件仍打开时删不掉。
  t.after(() => { index.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const { descriptors, maps } = collectSourceDescriptors({ claudeRoots: [claudeRoot, codeagentRoot], codeagentRoots: [codeagentRoot] });
  assert.equal(descriptors.length, 2);
  for (const descriptor of descriptors) index.replaceSource(parseSourceDescriptor(descriptor, maps));
  return { index, now };
}

const search = (index, query, extra = {}) => index.search({ query, scopes: ['user'], timeRange: '7d', ...extra });

test('CodeAgent questions are answered from the resident in-memory path and labelled CodeAgent', (t) => {
  const { index } = fixture(t);
  const all = search(index, 'CAMARK');
  assert.equal(all.searchPath, 'memory');
  assert.deepEqual(all.results.map(r => r.provider).sort(), ['claude', 'codeagent']);
  const only = search(index, 'CAMARK', { providers: ['codeagent'] });
  assert.equal(only.searchPath, 'memory');
  assert.equal(only.results.length, 1);
  assert.equal(only.results[0].provider, 'codeagent');
  assert.match(only.results[0].bestMatch.text, /CAMARK 帮我查一下调度日志/);
});

test('「我的提问」 on CodeAgent keeps skill commands but not injected reminders or skill bodies', (t) => {
  const { index } = fixture(t);
  assert.equal(search(index, 'SKILLARG').totalSessions, 1, 'skill command arguments are what the user typed');
  assert.equal(search(index, 'REMINDERONLY').totalSessions, 0, 'injected <system-reminder> is not a question');
  assert.equal(search(index, 'SKILLBODY').totalSessions, 0, 'isMeta skill body is not a question');
  assert.equal(search(index, 'CAANSWER').totalSessions, 0, 'AI answers are outside the default scope');
  assert.equal(index.search({ query: 'CAANSWER', scopes: ['user', 'assistant'], timeRange: 'all' }).totalSessions, 1);
});

test('CodeAgent memory results equal the SQLite path result for result', (t) => {
  const { index, now } = fixture(t);
  const store = index.queryStore;
  assert.equal(store.syncCatalog(), true);
  for (const [query, providers] of [['CAMARK', []], ['CAMARK', ['codeagent']], ['SKILLARG', ['codeagent']], ['', ['codeagent']]]) {
    const request = normalizeRequest({ query, scopes: ['user'], timeRange: '7d', providers, limit: 50 }, now);
    const run = catalog => { const snap = new QuerySnapshot(index, request, catalog); while (!snap.done) snap.step(6000); return snap; };
    const sql = run(null), memory = run(store.catalog);
    assert.equal(memory.path, 'memory');
    assert.deepEqual(memory.response(0).results, sql.response(0).results, `${query}/${providers} differs`);
  }
});
