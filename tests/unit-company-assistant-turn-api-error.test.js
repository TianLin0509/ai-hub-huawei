'use strict';
// F7（2026-11-22）「PPT 做页十分钟没结果」隔离 Hub 真实复现的两处空等：
//   1. 这一轮以模型接口报错收场（401 / 402 / 429）：记录里只有一条 isApiErrorMessage 回答、没有正常答完，Hub 以前空等到 25 分钟时限；
//   2. CLI 一启动就退回 PowerShell：以前按「还在启动」白等满 5 分钟。
// 记录行的形状取自复现时 Claude Code 2.1.322 写下的真实记录（文字为合成）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { lastApiError, describe } = require('../core/company-assistant/turn-api-error');

const NOW = Date.parse('2026-11-22T15:05:00+08:00');
const DAY = '2026-11-22';
const iso = t => new Date(t).toISOString();
const userRow = (t, text) => ({ type: 'user', sessionId: 's1', uuid: 'u' + t, timestamp: iso(t), message: { role: 'user', content: text } });
const apiErrorRow = (t, text, status = 401) => ({ type: 'assistant', sessionId: 's1', uuid: 'e' + t, timestamp: iso(t), isApiErrorMessage: true, apiErrorStatus: status, error: 'authentication_failed',
  message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } });
const answerRow = (t, text) => ({ type: 'assistant', sessionId: 's1', uuid: 'a' + t, timestamp: iso(t), message: { role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text }] } });
const write = (file, rows) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-api-error-'));
  const sessions = new Map(), prompts = [];
  let clock = NOW, screen = '';
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: true, bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle', transcriptPath: path.join(root, opts.id + '.jsonl') }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    closeSession: async id => { sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); return { ok: true }; },
    readFinals: () => [],
    isAgentTurnActive: () => false,
    readTerminalScreen: () => ({ text: screen }),
    notReadyRetryMs: 0,
  };
  const a = new CompanyAssistant(deps);
  t.after(() => { a.closed = true; a.welinkGate.flush?.(); fs.rmSync(root, { recursive: true, force: true }); });
  a.cli = () => 'fixture-cli';
  a.auth.status = () => ({ state: 'online', login: { ok: true, uid: 'owner' } });
  a.write(`raw-${DAY}.json`, { at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' }, conversations: [], messages: {}, meetings: [], calendar: [], mails: [], scope: { fetched: 0, known: 0 }, errors: [] });
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)); };
  return { a, root, deps, sessions, prompts, settle, advance: ms => { clock += ms; }, now: () => clock, setScreen: s => { screen = s; } };
}

test('lastApiError：最后一条回答是接口报错才算；后面又有正常回答就不算', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-error-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.jsonl');
  write(file, [userRow(NOW, '做一页'), apiErrorRow(NOW + 3000, 'Please run /login · API Error: 401 Authentication Fails, Your api key is invalid'), { type: 'system', subtype: 'turn_duration', timestamp: iso(NOW + 3100) }]);
  const hit = lastApiError(file);
  assert.equal(hit.id, 'e' + (NOW + 3000));
  assert.deepEqual(describe(hit.text), { kind: '模型账号鉴权失败（登录过期或密钥无效）', detail: 'API Error: 401 Authentication Fails, Your api key is invalid' });
  assert.equal(describe('API Error: 429 Too Many Requests').kind, '模型接口限流');
  assert.equal(describe('API Error: 402 Insufficient Balance').kind, '模型额度不足');
  write(file, [userRow(NOW, '做一页'), apiErrorRow(NOW + 3000, 'API Error: 429 rate limited'), answerRow(NOW + 9000, '重试成功，接着写')]);
  assert.equal(lastApiError(file), null, '报错之后模型又正常回答了');
  assert.equal(lastApiError(path.join(dir, 'missing.jsonl')), null, '记录还没建好：说不准');
});

test('这一轮以接口报错收场：会话空闲稳定 8 秒后立刻报失败、写明原因，不再空等到时限', async t => {
  const f = fixture(t);
  const item = f.a.ask('PPT 做页', { entry: 'ppt' });
  await f.settle();
  assert.equal(f.prompts.length, 1);
  const sid = f.prompts[0].id, file = f.sessions.get(sid).transcriptPath;
  write(file, [userRow(f.now(), '做一页'), apiErrorRow(f.now() + 2000, 'Please run /login · API Error: 401 Authentication Fails (request_id: x)')]);
  // 实测：CLI 以报错收场走 StopFailure，Hub 仍可能把会话当成在忙；报错判定不能被「在忙」挡住。
  f.deps.isAgentTurnActive = () => true;
  await f.a.collectJob('ppt');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running', '第一次看到报错：先等稳定');
  f.advance(9000);
  await f.a.collectJob('ppt');
  const row = f.a.chat().find(c => c.id === item.id);
  assert.equal(row.state, 'error');
  assert.match(row.error, /^模型账号鉴权失败（登录过期或密钥无效），这一问没答完（API Error: 401 Authentication Fails/);
  assert.match(row.error, /打开助理会话处理后重试/);
});

test('发问前会话里已有的旧报错不算这一问的结果', async t => {
  const f = fixture(t);
  // 预先在将要建的会话记录里放一条旧报错：拦截 createSession 写入
  const create = f.deps.createSession;
  f.deps.createSession = async (kind, opts) => { const r = await create(kind, opts); write(f.sessions.get(opts.id).transcriptPath, [apiErrorRow(NOW - 60000, 'API Error: 429 old')]); return r; };
  const item = f.a.ask('PPT 做页', { entry: 'ppt' });
  await f.settle();
  f.advance(20000);
  await f.a.collectJob('ppt');
  f.advance(20000);
  await f.a.collectJob('ppt');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running', '旧报错是基线，继续等这一问的回答');
});

test('CLI 一启动就退回 PowerShell：第一次没就绪就报失败，不白等 5 分钟', async t => {
  const f = fixture(t);
  let sends = 0;
  f.deps.sendPrompt = async () => { sends += 1; f.advance(60000); return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready', terminalLastLine: "error: unknown option '--disable-update'" }; };
  f.setScreen("PS D:\\work\\ppt-workspace>  & 'codeagent' --disable-update --permission-mode bypassPermissions\r\nerror: unknown option '--disable-update'\r\nPS D:\\work\\ppt-workspace> \r\n>> ");
  const item = f.a.ask('PPT 做页', { entry: 'ppt' });
  for (let i = 0; i < 5; i += 1) { await f.settle(); await new Promise(r => setTimeout(r, 5)); }
  const row = f.a.chat().find(c => c.id === item.id);
  assert.equal(sends, 1, '只试了一次');
  assert.equal(row.state, 'error');
  assert.match(row.error, /CodeAgent 启动后就退出了，这一问没有发出；终端最后一行：error: unknown option '--disable-update'；请打开助理会话看终端里的报错/);
});

test('CLI 还在启动（终端停在启动命令上）：照旧隔一会儿再发', async t => {
  const f = fixture(t);
  let sends = 0;
  f.deps.sendPrompt = async () => { sends += 1; f.advance(60000); return sends < 3 ? { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready' } : { ok: true }; };
  f.setScreen("PS D:\\work\\ppt-workspace>  & 'codeagent' --permission-mode bypassPermissions\r\n");
  const item = f.a.ask('PPT 做页', { entry: 'ppt' });
  for (let waited = 0; sends < 3 && waited < 2000; waited += 20) { await f.settle(); await new Promise(r => setTimeout(r, 20)); }
  await f.settle();
  assert.equal(sends, 3);
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running');
});
