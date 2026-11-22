'use strict';

// 昨日之我「我的提问 + 最近 7 天」常驻内存路径（2026-11-05）。
// 守住三件事：结果与原 SQL 路径逐条一致；库有增删改后内存目录跟上；超出窗口的请求回到 SQL 路径。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index.js');
const { QuerySnapshot, normalizeRequest } = require('../core/session-search-query.js');
const { SessionSearchService } = require('../core/session-search-service.js');

const DAY = 24 * 60 * 60 * 1000;

function source(key, title, docs, updatedAt) {
  return {
    key, signature: `sig-${key}-${docs.length}`, searchable: true,
    session: {
      key, provider: 'codex', nativeFamily: 'codex', kind: 'codex', title,
      cwd: 'C:\\repo', projectLabel: 'repo', model: 'm', updatedAt,
      hubSessionId: `hub-${key}`, nativeSessionId: `native-${key}`, meetingId: null,
      transcriptPath: `C:\\t\\${key}.jsonl`, turnCount: docs.length,
    },
    docs: docs.map((doc, index) => ({
      id: doc.id, eventId: doc.id, scope: doc.scope, role: doc.scope, speaker: 'codex',
      text: doc.text, ordinal: index, timestamp: doc.at,
    })),
  };
}

function openIndex(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-recent-'));
  const index = new SqliteSessionSearchIndex(path.join(root, 'search.sqlite'));
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return index;
}

function seed(index, now) {
  index.replaceSource(source('s-new', '仿真配置讨论', [
    { id: 'u1', scope: 'user', text: '📌 帮我看下仿真配置为什么跑不动', at: now - 2 * DAY },
    { id: 'a1', scope: 'assistant', text: '仿真配置里的带宽写错了', at: now - 2 * DAY + 10 },
    { id: 'u2', scope: 'user', text: '那 Alpha 的信道仿真呢', at: now - 1 * DAY },
    { id: 'a2', scope: 'assistant', text: '信道模型需要换成 CDL', at: now - 1 * DAY + 10 },
  ], now - DAY));
  index.replaceSource(source('s-mid', '搜索提速', [
    { id: 'u1', scope: 'user', text: '昨日之我的搜索速度太慢', at: now - 5 * DAY },
    { id: 'a1', scope: 'assistant', text: '慢在冷启动', at: now - 5 * DAY + 10 },
  ], now - 5 * DAY));
  index.replaceSource(source('s-old', '老会话', [
    { id: 'u1', scope: 'user', text: '一个月前的仿真问题', at: now - 20 * DAY },
    { id: 'a1', scope: 'assistant', text: '老回答', at: now - 20 * DAY + 10 },
  ], now - 20 * DAY));
}

function runSnapshot(index, request, catalog) {
  const snap = new QuerySnapshot(index, request, catalog);
  while (!snap.done) snap.step(6000);
  return { path: snap.path, results: snap.response(0).results };
}

test('memory path returns exactly what the SQL path returns for my questions within 7 days', (t) => {
  const index = openIndex(t);
  const now = Date.now();
  seed(index, now);
  const store = index.queryStore;
  assert.equal(store.syncCatalog(), true);
  for (const [query, range] of [['仿真', '7d'], ['仿真', '3d'], ['alpha', '7d'], ['仿真 配置', '7d'], ['不存在', '7d'], ['', '7d'], ['搜索速度', '24h']]) {
    const request = normalizeRequest({ query, scopes: ['user'], timeRange: range, limit: 50 }, now);
    const sql = runSnapshot(index, request, null);
    const memory = runSnapshot(index, request, store.catalog);
    assert.equal(sql.path, 'sqlite');
    assert.equal(memory.path, 'memory', `${query}/${range} should use memory`);
    assert.deepEqual(memory.results, sql.results, `${query}/${range} results differ`);
  }
  // 含 emoji 的提问：摘要起点按字符而不是 UTF-16 计算，与 SQLite substr 一致。
  const emoji = index.search({ query: '仿真配置', scopes: ['user'], timeRange: '7d' });
  assert.equal(emoji.searchPath, 'memory');
  assert.match(emoji.results[0].bestMatch.text, /^📌 帮我看下仿真配置/);
});

test('requests outside the in-memory window or scope fall back to SQLite', (t) => {
  const index = openIndex(t);
  const now = Date.now();
  seed(index, now);
  assert.equal(index.search({ query: '仿真', scopes: ['user'], timeRange: '30d' }).searchPath, 'sqlite+catalog');
  assert.equal(index.search({ query: '仿真', scopes: ['user', 'assistant'], timeRange: '7d' }).searchPath, 'sqlite+catalog');
  assert.equal(index.search({ query: '仿真', scopes: ['user'], timeRange: 'all' }).searchPath, 'sqlite+catalog');
  const month = index.search({ query: '仿真', scopes: ['user'], timeRange: '30d' });
  assert.deepEqual(month.results.map(r => r.sessionKey).sort(), ['s-new', 's-old']);
});

test('catalog follows inserts, edits and deletions between searches', (t) => {
  const index = openIndex(t);
  const now = Date.now();
  seed(index, now);
  const search = query => index.search({ query, scopes: ['user'], timeRange: '7d' });
  assert.equal(search('冷启动修好了吗').totalSessions, 0);

  // 新会话、新提问
  index.replaceSource(source('s-fresh', '新会话', [
    { id: 'u1', scope: 'user', text: '冷启动修好了吗', at: now - 1000 },
  ], now - 1000));
  let res = search('冷启动修好了吗');
  assert.equal(res.searchPath, 'memory');
  assert.deepEqual(res.results.map(r => r.sessionKey), ['s-fresh']);
  assert.equal(res.results[0].title, '新会话');

  // 原地改写一条提问（旧行删除、新行插入）
  index.replaceSource(source('s-fresh', '新会话改名', [
    { id: 'u1', scope: 'user', text: '冷启动现在很快', at: now - 1000 },
  ], now - 900));
  assert.equal(search('冷启动修好了吗').totalSessions, 0);
  res = search('冷启动现在很快');
  assert.equal(res.results[0].title, '新会话改名');

  // 删除整个来源
  index.pruneSources(new Set(['s-new', 's-mid', 's-old']));
  assert.equal(search('冷启动现在很快').totalSessions, 0);
  assert.equal(search('仿真').totalSessions, 1);
});

test('the search child stays resident by default; an explicit idle timeout still works', () => {
  const previous = process.env.HUB_SESSION_SEARCH_IDLE_MS;
  delete process.env.HUB_SESSION_SEARCH_IDLE_MS;
  try {
    const resident = new SessionSearchService({ fork: () => { throw new Error('not started'); } });
    assert.equal(resident._idleMs, 0);
    resident._child = {};
    resident._armIdleTimer();
    assert.equal(resident._idleTimer, null);
    const idle = new SessionSearchService({ idleMs: 5000, fork: () => { throw new Error('not started'); } });
    assert.equal(idle._idleMs, 5000);
  } finally {
    if (previous !== undefined) process.env.HUB_SESSION_SEARCH_IDLE_MS = previous;
  }
});

test('empty query over title+user+assistant equals the full docs scan', (t) => {
  const index = openIndex(t);
  const now = Date.now();
  seed(index, now);
  // 只有 AI 回答落在范围内的会话、只有标题的会话、范围外的会话
  index.replaceSource(source('s-answer', '只有回答在近期', [
    { id: 'u1', scope: 'user', text: '很早的提问', at: now - 30 * DAY },
    { id: 'a1', scope: 'assistant', text: '最近才补的回答', at: now - 2 * DAY },
  ], now - 2 * DAY));
  index.replaceSource(source('s-title', '只有标题', [], now - DAY));
  const store = index.queryStore;
  assert.equal(store.syncCatalog(), true);
  for (const range of ['24h', '3d', '7d', '30d']) {
    for (const scopes of [['title', 'user', 'assistant'], ['user', 'assistant']]) {
      const request = normalizeRequest({ query: '', scopes, timeRange: range, limit: 50 }, now);
      const { from, to } = request.time;
      const expected = new Set(index.db.prepare(`SELECT DISTINCT session_key FROM docs WHERE scope IN (${scopes.map(() => '?')})
        AND ((scope<>'title' AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?)
          OR (scope='title' AND session_key IN (SELECT DISTINCT session_key FROM docs WHERE scope IN ('user','assistant') AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?)))`)
        .all(...scopes, from ?? 0, to ?? Number.MAX_SAFE_INTEGER, from ?? 0, to ?? Number.MAX_SAFE_INTEGER).map(r => r.session_key));
      for (const catalog of [null, store.catalog]) {
        const got = runSnapshot(index, request, catalog).results.map(r => r.sessionKey);
        assert.deepEqual(new Set(got), expected, `${range}/${scopes.join('+')}/${catalog ? 'catalog' : 'sql'}`);
      }
    }
  }
});

// 会话快照只在搜索进程可能顺带刷新时才组装和发送；其余搜索传 null（2026-11-19）。
test('search sends the session snapshot only when a refresh may follow', async () => {
  const sent = [];
  const { EventEmitter } = require('node:events');
  const fakeFork = () => {
    const child = new EventEmitter();
    child.pid = undefined; child.connected = true; child.exitCode = null;
    child.kill = () => {};
    child.send = (message, callback) => {
      sent.push(message);
      callback && callback();
      if (message.id) setImmediate(() => child.emit('message', { id: message.id, result: { results: [] } }));
      if (message.type === 'close') setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); });
    };
    return child;
  };
  const service = new SessionSearchService({ fork: fakeFork, refreshTtlMs: 60_000 });
  let built = 0;
  const getter = () => { built += 1; return { sessions: [{ hubId: 'h1' }], meetings: [] }; };
  await service.search({ query: 'a' }, getter); // 未就绪：带快照
  service._status = { ...service._status, ready: true };
  service._searchSnapshotSentAt = Date.now();
  await service.search({ query: 'b' }, getter);
  await service.search({ query: 'c' }, getter);
  service._searchSnapshotSentAt = Date.now() - 61_000;
  await service.search({ query: 'd' }, getter);
  const searches = sent.filter(m => m.type === 'search');
  assert.deepEqual(searches.map(m => !!m.snapshot), [true, false, false, true]);
  assert.equal(built, 2);
  await service.close();
});

test('engine search never refreshes from a missing snapshot', async (t) => {
  const { SessionSearchEngine } = require('../core/session-search-engine.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-nosnap-'));
  const engine = new SessionSearchEngine({ databasePath: path.join(root, 's.sqlite'), backgroundWriter: false, claudeRoots: [], codexRoots: [] }, () => {});
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let refreshes = 0;
  engine.refresh = async () => { refreshes += 1; return {}; };
  await engine.search({ query: 'x' }, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 0);
  await engine.search({ query: 'x' }, { sessions: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  engine.statusValue.ready = true;
  engine.lastRefreshAt = 0;
  await engine.search({ query: 'x' }, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1, '已就绪但 TTL 过期也不能从缺失快照刷新');
});
