'use strict';

// 搜索移植回归：用隔离记录和真实 SQLite 验证换号续接、无头过滤及旧索引清理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectSourceDescriptors, parseSourceDescriptor, createMetadataMaps } = require('../core/session-search-sources');
const { AppendScanCache } = require('../core/search-append-scan-cache');
const { SessionSearchEngine } = require('../core/session-search-engine');

test('搜索 IPC 传递实时快照入口，热查询无需预先组装全部会话', async () => {
  const handlers = new Map();
  const snapshot = { sessions: [{ hubId: 'h1' }], meetings: [] };
  let built = 0;
  const getter = () => { built++; return snapshot; };
  require('../main/ipc/archive-handlers').registerArchiveIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    getSearchSnapshot: getter,
    searchService: { search: async (request, getSnapshot) => {
      assert.equal(built, 0);
      assert.equal(getSnapshot, getter);
      assert.equal(getSnapshot(), snapshot);
      return { results: [], query: request.query };
    } },
  });
  assert.deepEqual(await handlers.get('search-past-sessions')(null, { query: '测试' }), { results: [], query: '测试' });
  assert.equal(built, 1);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const entry = (uuid, role, text, minute = 0, extra = {}) => ({
  type: role, uuid, sessionId: 'sid', timestamp: new Date(Date.now() - 3600000 + minute * 60000).toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }, ...extra,
});
function write(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('换号前旧段并入当前会话、去重并跟踪变化，无关对话不并入', t => {
  const root = fixture(t);
  const dir = path.join(root, 'claude-account-runtimes', 'hub-1', 'projects', 'proj');
  let clock = Math.floor(Date.now() / 1000) - 600;
  const save = (name, rows) => {
    const file = write(path.join(dir, `${name}.jsonl`), rows);
    clock += 60; fs.utimesSync(file, clock, clock);
    return file;
  };
  save('cleared', [entry('c1', 'user', '无关的另一段对话')]);
  const first = [entry('a1', 'user', '最早提到的LINEAGEMARK', 1), entry('a2', 'assistant', '早先的回答', 2)];
  const old = save('old', first);
  save('middle', [...first, entry('b1', 'user', '中段的话', 3)]);
  const current = save('now', [entry('n1', 'user', '压缩后的新问题', 4, { logicalParentUuid: 'b1' })]);
  const snapshot = { sessions: [{ hubId: 'hub-1', kind: 'claude', title: '当前标题', ccSessionId: 'now', transcriptPath: current, cwd: root }] };
  const collect = () => collectSourceDescriptors({ claudeRoots: [] }, snapshot);
  const { descriptors, maps } = collect();
  assert.equal(descriptors.length, 1, '旧段不单独成为搜索结果');
  const descriptor = descriptors[0];
  assert.deepEqual(descriptor.ancestorFiles.map(file => path.basename(file)), ['old.jsonl', 'middle.jsonl']);
  for (const options of [{}, { scanCache: new AppendScanCache({ minFileBytes: 0 }) }]) {
    const parsed = parseSourceDescriptor(descriptor, maps, options);
    assert.deepEqual(parsed.docs.filter(doc => doc.scope === 'user').map(doc => doc.text), ['最早提到的LINEAGEMARK', '中段的话', '压缩后的新问题']);
    assert.equal(new Set(parsed.docs.map(doc => doc.eventId)).size, parsed.docs.length);
  }
  fs.appendFileSync(old, JSON.stringify(entry('a3', 'user', '后补', 5)) + '\n');
  assert.notEqual(collect().descriptors[0].signature, descriptor.signature, '旧段变化触发重新索引');
});

test('只过滤明确的无头标记，Claude/CodeAgent 的交互记录和 Hub 绑定记录保留', t => {
  const root = fixture(t);
  for (const provider of ['claude', 'codeagent']) {
    for (const mode of ['sdk-cli', 'cli', undefined]) {
      const filePath = write(path.join(root, `${provider}-${mode}.jsonl`), [entry('u1', 'user', 'SCRIPTEDMARK 提示词', 0, { entrypoint: mode })]);
      const descriptor = { type: 'claude', key: `${provider}:${mode}`, provider, nativeSessionId: 'sid', filePath, signature: 's', mtime: 1 };
      for (const scanCache of [undefined, new AppendScanCache({ minFileBytes: 0 })]) {
        const parsed = parseSourceDescriptor(descriptor, createMetadataMaps({}), { scanCache });
        assert.equal(parsed.searchable, mode !== 'sdk-cli', `${provider}/${mode}`);
        const bound = { ...descriptor, hubSession: { hubId: 'h1', kind: provider, title: '真实会话' } };
        assert.equal(parseSourceDescriptor(bound, createMetadataMaps({}), { scanCache }).searchable, true);
      }
    }
  }
});

test('投影版本升级后已入库的无头记录退出搜索，绑定回 Hub 后仍可找回', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-port-upgrade-'));
  const projects = path.join(root, 'codeagent', 'projects');
  const file = write(path.join(projects, 'proj', 'sid.jsonl'), [entry('u1', 'user', 'SCRIPTEDMARK 后台调用', 0, { entrypoint: 'sdk-cli' })]);
  const engine = new SessionSearchEngine({ databasePath: path.join(root, 's.sqlite'), claudeRoots: [projects], codeagentRoots: [projects], prewarmOnOpen: false });
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const collected = collectSourceDescriptors(engine.options, {});
  const descriptor = collected.descriptors[0];
  assert.match(descriptor.signature, /:utext-v4$/);
  const parsed = parseSourceDescriptor(descriptor, collected.maps);
  engine.index.replaceSource({ ...parsed, searchable: true, signature: descriptor.signature.replace(':utext-v4', ':utext-v3') });
  const search = () => engine.index.search({ query: 'SCRIPTEDMARK', scopes: ['user'], timeRange: '7d' });
  assert.equal(search().totalSessions, 1, '模拟升级前已存在的记录');
  await engine.refresh({});
  assert.equal(search().totalSessions, 0, '不要求用户手动重建索引');
  await engine.refresh({ sessions: [{ hubId: 'bound', kind: 'codeagent', ccSessionId: 'sid', transcriptPath: file, cwd: root, title: '已绑定' }] }, { immediate: true });
  const result = search();
  assert.equal(result.totalSessions, 1);
  assert.equal(result.results[0].provider, 'codeagent');
  assert.equal(result.results[0].hubSessionId, 'bound');
});

test('长会话超过原单文件上限后只扫描追加字节，成员版仍守住 64MB 总量', t => {
  const root = fixture(t);
  const cache = new AppendScanCache();
  const file = path.join(root, 'long.jsonl');
  const content = 'x'.repeat(1024 * 1024);
  const lines = Array.from({ length: 17 }, (_, n) => JSON.stringify({ n, content }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  cache.readRecords(file, 'test');
  cache.readRecords(file, 'test');
  const before = cache.stats.scannedBytes;
  const tail = JSON.stringify({ n: 17, content: '追加' }) + '\n';
  fs.appendFileSync(file, tail);
  assert.equal(cache.readRecords(file, 'test').length, 18);
  assert.equal(cache.stats.scannedBytes - before, Buffer.byteLength(tail));
  assert.ok(cache.keptBytes > 16 * 1024 * 1024);
  assert.equal(cache.maxTotalKeptBytes, 64 * 1024 * 1024);
  // 用较小总量触发同一淘汰逻辑，避免测试自身保留几十份大记录。
  cache.maxTotalKeptBytes = 20 * 1024 * 1024;
  const other = write(path.join(root, 'other.jsonl'), [{ content: 'y'.repeat(5 * 1024 * 1024) }]);
  cache.readRecords(other, 'test');
  cache.readRecords(other, 'test');
  assert.ok(cache.keptBytes <= cache.maxTotalKeptBytes);
  assert.equal(cache.entries.size, 1);
});
