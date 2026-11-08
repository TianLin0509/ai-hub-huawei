'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanAll } = require('../core/token-usage/scanner');
const { TokenUsageService, mergeDays, lastSlot, nextSlot } = require('../core/token-usage/service');
const { aggregate, formatTokens, tokenPageHtml } = require('../renderer/account-token-view');

const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const T = '2026-11-08T04:00:00.000Z', AT = Date.parse(T);
const put = (p, lines) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, lines.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n') + '\n'); };
const total = (days, provider) => Object.values(days).flat().filter(r => r[0] === provider).reduce((s, r) => s + r[3] + r[4] + r[5] + r[6], 0);

test('CodeAgent 个人号和号池分账号统计；同一回复只算一次；Claude、Codex、DSH 各归各的', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-test-'));
  const homeDir = path.join(root, 'home'), dataDir = path.join(root, 'hub'), codeAgentDir = path.join(root, 'custom-cac');
  const msg = (id, output, model = 'GLM-5.2') => ({ type: 'assistant', timestamp: T, message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: output } } });
  put(path.join(codeAgentDir, 'projects', 'p', 'a.jsonl'), [msg('m1', 5), msg('m1', 20), 'not json', { type: 'assistant', timestamp: T, message: { id: 'x', model: '<synthetic>', usage: { output_tokens: 999 } } }]);
  put(path.join(dataDir, 'codeagent-pool', 'accounts', 'p1', 'projects', 'p', 'b.jsonl'), [msg('m2', 9)]);
  put(path.join(homeDir, '.claude', 'projects', 'p', 'c.jsonl'), [msg('m3', 7, 'internal-model')]);
  const tc = (sum, input, cached, output) => ({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: sum }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } });
  put(path.join(homeDir, '.codex', 'sessions', 'a.jsonl'), [{ type: 'turn_context', payload: { model: 'm' } }, tc(110, 100, 60, 10), tc(110, 100, 60, 10)]);
  put(path.join(dataDir, 'acp', 'h1', 'home', '.dsh', 'hub-events', 'e.jsonl'), [{ model: 'deepseek-flash', events: [{ seq: 1, time: AT, data: { usage: { inputTokens: 5, cacheReadTokens: 6, outputTokens: 1 } } }, { seq: 1, time: AT, data: { usage: { inputTokens: 5, cacheReadTokens: 6, outputTokens: 1 } } }] }]);
  try {
    const r = await scanAll({ homeDir, dataDir, codeAgentDir, sinceMs: AT - 86400000 });
    const rows = Object.values(r.days).flat();
    assert.deepEqual(rows.find(x => x[2] === 'personal').slice(0, 7), ['codeagent', 'GLM-5.2', 'personal', 1, 100, 10, 20], 'm1 只算一次且取最大输出');
    assert.equal(rows.find(x => x[2] === 'p1')[0], 'codeagent');
    assert.equal(total(r.days, 'codeagent'), 131 + 120);
    assert.equal(total(r.days, 'claude'), 118, '按启动的工具归类，不看模型名');
    assert.equal(total(r.days, 'codex'), 110);
    assert.equal(total(r.days, 'dsh'), 12);
    assert.equal(r.errors, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('账本：重算变少时不倒退；每天 12:30、23:30 补一次；失败不丢结果', async () => {
  assert.deepEqual(mergeDays({ a: [['x', 'm', '', 10, 0, 0, 0]] }, { a: [['x', 'm', '', 3, 0, 0, 0]], b: [['x', 'm', '', 1, 0, 0, 0]] }), { a: [['x', 'm', '', 10, 0, 0, 0]], b: [['x', 'm', '', 1, 0, 0, 0]] });
  const at = (h, m) => new Date(2026, 10, 8, h, m).getTime();
  assert.equal(lastSlot(at(13, 0)), at(12, 30));
  assert.equal(nextSlot(at(13, 0)), at(23, 30));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-'));
  try {
    let now = at(13, 0); const scans = [];
    const service = new TokenUsageService({ dataDir: dir, homeDir: dir, codeAgentDir: () => 'X', now: () => now, runScan: async o => { scans.push(o); return { days: { '2026-11-08': [['codeagent', 'm', 'a', 1, 2, 3, 4]] }, files: 1, errors: 0 }; }, logger: { warn() {} } });
    service.tick(); await service.running;
    assert.equal(scans[0].codeAgentDir, 'X');
    service.tick(); assert.equal(service.running, null, '这个时段已统计过，不重复跑');
    assert.ok(scans[0].sinceMs < at(0, 0) - 80 * 86400000, '第一次回溯约 90 天');
    now = at(23, 40); service.tick(); await service.running;
    assert.ok(scans[1].sinceMs > at(0, 0) - 5 * 86400000, '之后只重算最近几天');
    const reloaded = new TokenUsageService({ dataDir: dir, homeDir: dir, now: () => now, runScan: async () => { throw Error('磁盘读不了'); }, logger: { warn() {} } });
    await reloaded.sync('manual');
    assert.match(reloaded.state().error, /磁盘读不了/);
    assert.equal(reloaded.state().days['2026-11-08'].length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('页面：两种口径、时间窗、账号显示名、空账本提示', () => {
  const now = new Date(2026, 10, 8, 13).getTime();
  const data = { now, syncedAt: now, days: { '2026-11-08': [['codeagent', 'GLM', 'personal', 1, 1e8, 0, 9], ['dsh', 'flash', '', 10, 0, 0, 0]], '2026-10-01': [['codex', 'gpt', 'x', 9999, 0, 0, 0]] } };
  assert.equal(aggregate(data, 'total', now).totals.today, 1e8 + 20);
  assert.equal(aggregate(data, 'net', now).totals.today, 20);
  assert.equal(aggregate(data, 'total', now).providers.codex.month, 0, '30 天窗外不算');
  assert.equal(formatTokens(31e6), '3,100 万');
  const html = tokenPageHtml(data, { accountName: (_p, id) => id === 'personal' ? '我的账号' : id }, esc);
  for (const text of ['CodeAgent', 'DSH', '我的账号', '立即统计', '不含缓存读取', '不上传']) assert.ok(html.includes(text), text);
  assert.match(tokenPageHtml({ now, days: {}, syncedAt: 0, running: true, stage: 'Codex' }, {}, esc), /正在后台统计 Codex/);
});
