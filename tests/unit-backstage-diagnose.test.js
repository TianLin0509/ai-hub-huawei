'use strict';
// 跳转后台 · 先诊断（renderer/backstage-diagnose.js，2026-11-26）：原因分类、一键动作、诊断信息脱敏、本机匿名计数。
const assert = require('node:assert/strict');
const test = require('node:test');
const D = require('../renderer/backstage-diagnose');

const NOW = 1_800_000_000_000;
const run = (over = {}) => D.diagnoseBackstage({ sessionId: 's1', runtime: { state: 'idle' }, now: NOW, ...over });
const acts = r => r.actions.map(a => a.act);

test('没有这个能力：没装 CodeAgent 也没接 API → 需要先配置（不是故障）', () => {
  const r = run({ entry: { capability: { codeagent: false, api: false } } });
  assert.equal(r.cause, 'no-engine'); assert.equal(r.capability, true); assert.equal(r.level, 'warn');
  assert.deepEqual(acts(r), ['known:codeagent-oneclick', 'known:open-company-api']);
  // 接了 API 就不算缺能力
  assert.equal(run({ entry: { capability: { codeagent: false, api: true } } }).cause, 'ok');
  // 没检测过（null）不下结论
  assert.equal(run({ entry: { capability: { codeagent: null, api: false } } }).cause, 'ok');
});

test('入口报错先过已知问题表：额度、没模型权限、WeLink 过期、反代、版本旧', () => {
  const cases = [
    ['API Error token消耗过快， 已达到4亿上限', 'quota', 'known:open-accounts'],
    ['CodeAgent 账号读不到任何可用模型', 'no-permission', 'known:open-company-api'],
    ['WeLink 登录已过期，Hub 正在自动续期', 'auth-expired', 'known:welink-login'],
    ['公司模型反代没能启动', 'network', 'known:proxy-restart'],
    ['CodeAgent 版本较旧，卡片视图可能显示不出回答', 'outdated', 'known:codeagent-upgrade'],
    ['未找到 CodeAgent CLI', 'no-engine', 'known:codeagent-oneclick'],
  ];
  for (const [error, cause, act] of cases) {
    const r = run({ entry: { error, area: 'codeagent' } });
    assert.equal(r.cause, cause, error); assert.ok(acts(r).includes(act), `${error} → ${acts(r)}`);
    assert.ok(r.todo, 'has todo');
  }
});

test('已知问题表认不出的按关键词归类，并给对应一键动作', () => {
  const cases = [
    ['Request failed with status 429 Too Many Requests', 'quota', 'known:open-accounts'],
    ['HTTP 403 Forbidden', 'no-permission', 'known:open-accounts'],
    ['401 Unauthorized: token expired', 'auth-expired', 'known:codeagent-personal-login'],
    ['connect ETIMEDOUT 10.1.2.3:443', 'network', 'known:proxy-restart'],
    ['会话启动失败：CLI 退出码 3', 'session-failed', 'known:session-restart'],
  ];
  for (const [error, cause, act] of cases) {
    const r = run({ entry: { error } });
    assert.equal(r.cause, cause, error); assert.ok(acts(r).includes(act), `${error} → ${acts(r)}`);
  }
  const other = run({ entry: { error: '奇怪的错误 xyz' } });
  assert.equal(other.cause, 'other'); assert.ok(acts(other).includes('known:session-restart'));
});

test('按后台会话状态：没有会话、已关闭、报错、卡住、等待、休眠、待确认、正常', () => {
  assert.equal(run({ sessionId: '', runtime: null }).cause, 'not-started');
  assert.equal(run({ sessionId: '', runtime: null }).canEnter, false);
  assert.equal(run({ runtime: null }).cause, 'session-gone');
  assert.match(run({ runtime: null, canRecreate: true }).todo, /重新打开/);
  assert.equal(run({ runtime: { state: 'failed' } }).cause, 'session-failed');
  const stuck = run({ runtime: { state: 'running', lastOutputAt: NOW - 125000 } });
  assert.equal(stuck.cause, 'stuck'); assert.match(stuck.text, /2 分 5 秒没有新输出/); assert.ok(acts(stuck).includes('known:session-restart'));
  assert.equal(run({ runtime: { state: 'running', lastOutputAt: NOW - 3000 } }).cause, 'ok');
  assert.equal(run({ runtime: { state: 'waiting' } }).cause, 'waiting-input');
  assert.equal(run({ runtime: { state: 'dormant' } }).cause, 'dormant');
  assert.equal(run({ runtime: { state: 'unknown' } }).cause, 'unknown');
  const ok = run({ env: { update: { version: '5.6.120' } } });
  assert.equal(ok.cause, 'ok'); assert.ok(acts(ok).includes('known:update-check')); assert.match(ok.todo, /5\.6\.120.*内源/);
});

test('脱敏：用户名、邮箱、密钥、凭据、工号、链接参数、长串', () => {
  // 样本按片段拼出来，免得仓库里出现完整的用户目录和邮箱（公开版审计会拦）。
  const USERS = ['C:', 'Users', ''].join('\\'), AT = '@';
  const raw = 'open ' + USERS + 'zhangsan\\AppData\\x.json failed for zhang.san' + AT + 'example.com key=sk-abcdefgh12345678 Authorization: Bearer abcdefghijklmnop token=xyz w00123456 https://api.example.com/v1?ak=1&sig=2 id ' + 'A'.repeat(40);
  const out = D.redact(raw, 1000);
  for (const bad of ['zhangsan', 'zhang.san@', 'sk-abcdefgh', 'abcdefghijklmnop', 'token=xyz', 'w00123456', 'sig=2', 'A'.repeat(40)]) assert.ok(!out.includes(bad), `${bad} leaked: ${out}`);
  assert.match(out, /C:\\Users\\<用户>/); assert.match(out, /<邮箱>/); assert.match(out, /<工号>/);
  assert.ok(D.redact('x'.repeat(500)).length <= 160);
});

test('诊断信息：版本、入口、后台状态、结论、脱敏错误、能力；不带会话完整编号', () => {
  const result = run({ runtime: { state: 'running', lastOutputAt: NOW - 125000 } });
  const text = D.diagnosticText({ version: '5.6.117', label: '助理', sessionId: '6e612e8e-2f96-48fa-9bc6-b6d7b221abd1', kind: 'codeagent', runtime: { state: 'running', lastOutputAt: NOW - 125000 },
    entry: { error: ['C:', 'Users', 'lisi', 'a.log'].join('\\') + ' ETIMEDOUT', capability: { codeagent: true, api: false } }, result, now: NOW });
  assert.match(text, /版本：v5\.6\.117/); assert.match(text, /入口：助理/); assert.match(text, /运行中，已 2 分 5 秒没有新输出 · codeagent · 编号 6e612e8e/);
  assert.match(text, /自检结论：后台可能卡住了（stuck）/); assert.match(text, /CodeAgent：已检测到；部门 API：未接/);
  assert.ok(!text.includes('lisi')); assert.ok(!text.includes('b6d7b221abd1'));
});

test('本机匿名计数：按日期 × 入口:原因累加，只留 14 天，不含编号和原文', () => {
  const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  D.recordDiagnosis(storage, { cause: 'quota', from: 'assistant', now: NOW });
  const data = D.recordDiagnosis(storage, { cause: 'quota', from: 'assistant', now: NOW });
  const day = new Date(NOW).toISOString().slice(0, 10);
  assert.deepEqual(data.days[day], { 'assistant:quota': 2 });
  for (let i = 1; i <= 20; i++) D.recordDiagnosis(storage, { cause: 'ok', from: 'avatar', now: NOW + i * 86400000 });
  assert.equal(Object.keys(JSON.parse(mem.get(D.STATS_KEY)).days).length, 14);
  assert.doesNotMatch(mem.get(D.STATS_KEY), /s1|Users/);
});

test('已保存部门 key：「打开自有 API」换成「改用部门 key」并排第一（m3/R45 口径）', () => {
  const r = run({ entry: { error: 'CodeAgent 账号读不到任何可用模型' }, env: { gatewayKey: true } });
  assert.equal(r.cause, 'no-permission');
  assert.equal(r.actions[0].act, 'hub-bs:use-gateway'); assert.equal(r.actions[0].label, '改用部门 key');
  assert.ok(!acts(r).includes('known:open-company-api'));
  assert.ok(acts(run({ entry: { error: 'CodeAgent 账号读不到任何可用模型' } })).includes('known:open-company-api'), '没存 key 时仍给打开自有 API');
});

test('脱敏补充：内网 IP、共享路径、JWT', () => {
  const out = D.redact('connect 10.12.34.56:8443 failed, file \\\\fs01\\share\\a.txt, jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 1000);
  for (const bad of ['10.12.34.56', 'fs01', 'eyJhbGciOiJIUzI1NiJ9']) assert.ok(!out.includes(bad), `${bad} leaked: ${out}`);
});

test('分身已归类的失败直接用：网关 401 归网关设置、WeLink 过期归登录、只指路不另给按钮', () => {
  const r = run({ entry: { failure: { code: 'gateway_401', headline: '网关不认这个 key', actions: [{ label: '重新填 key' }] }, error: 'HTTP 401 Invalid token' } });
  assert.equal(r.cause, 'gateway-config'); assert.equal(r.text, '网关不认这个 key'); assert.match(r.todo, /重新填 key/); assert.deepEqual(r.actions, []);
  assert.equal(run({ entry: { failure: { code: 'welink_expired', headline: 'WeLink 登录过期' } } }).cause, 'auth-expired');
  assert.equal(run({ entry: { failure: { code: 'model_rate_limit', headline: '模型限流' } } }).cause, 'quota');
});

test('会议口径：只给 CodeAgent 安装、不给通用重启、在录不给更新、带会议自己的修复路径', () => {
  const meet = { codeagentOnly: true, noSessionRestart: true, hint: '会议自己的修复在会议页' };
  const none = run({ entry: { ...meet, capability: { codeagent: false, api: false } } });
  assert.equal(none.cause, 'no-engine'); assert.deepEqual(acts(none), ['known:codeagent-oneclick']); assert.doesNotMatch(none.text, /API/);
  const failed = run({ runtime: { state: 'failed' }, entry: meet });
  assert.ok(!acts(failed).includes('known:session-restart')); assert.match(failed.todo, /会议自己的修复在会议页/);
  const rec = run({ env: { update: { version: '5.6.120' } }, entry: { ...meet, recording: true } });
  assert.ok(!acts(rec).some(a => a.startsWith('known:update-'))); assert.match(rec.todo, /会后再更新/);
});

test('复审 P1：JSON 凭据、整段 Cookie、带空格用户名、纯数字工号、短段 JWT 都隐去', () => {
  const U = ['C:', 'Users', ''].join('\\');
  const cases = [
    ['{"api_key":"sampleShortSecret","token":"fakeShortToken"}', ['sampleShortSecret', 'fakeShortToken']],
    ['Cookie: sid=fakeSidValue; session=fakeSessionValue; csrf=fakeCsrfValue', ['fakeSidValue', 'fakeSessionValue', 'fakeCsrfValue']],
    [U + 'Alice Smith\\report.txt', ['Alice', 'Smith']],
    ['staff 00123456 and WX123456', ['00123456', 'WX123456']],
    ['jwt eyJhbGci.eyJzdWIi.sig', ['eyJhbGci']],
  ];
  for (const [raw, bads] of cases) { const out = D.redact(raw, 1000); for (const bad of bads) assert.ok(!out.includes(bad), `${bad} leaked: ${out}`); }
});

test('复审 P1：诊断信息不带报错原文（可能夹着模型输出），只给类别和错误码', () => {
  const entry = { error: `Unexpected token 'B', "[BIZTEXT] 客户合同金额" is not valid JSON; HTTP 429 Too Many Requests; connect ETIMEDOUT`, capability: { codeagent: true } };
  const result = run({ entry });
  const text = D.diagnosticText({ version: '5.6.117', label: '分身', sessionId: 's1', runtime: { state: 'idle' }, entry, result, now: NOW });
  assert.ok(!text.includes('BIZTEXT') && !text.includes('合同'), text);
  assert.match(text, /最近错误：有（类别 quota；错误码 429\/ETIMEDOUT）；原文留在本机，未复制/);
  const f = D.diagnosticText({ label: '分身', entry: { failure: { code: 'gateway_401', headline: 'x' } }, result: run({ entry: { failure: { code: 'gateway_401', headline: 'x' } } }), now: NOW });
  assert.match(f, /失败码 gateway_401/);
});

test('复审 P2：回答通道是部门 API 网关时，401/超时指向网关设置，不给 CodeAgent 个人登录或反代重启', () => {
  const r = run({ runtime: { state: 'failed' }, entry: { error: 'HTTP 401 Unauthorized: token expired', channel: 'gateway', capability: { codeagent: false, api: true } } });
  assert.equal(r.cause, 'auth-expired');
  assert.equal(r.actions[0].act, 'hub-bs:gateway-settings');
  assert.ok(!acts(r).includes('known:codeagent-personal-login'));
  const n = run({ entry: { error: 'connect ETIMEDOUT', channel: 'gateway' } });
  assert.ok(!acts(n).includes('known:proxy-restart')); assert.ok(acts(n).includes('hub-bs:gateway-settings'));
  // 助理已按网关口径归好类的，直接用它的标题
  const g = run({ entry: { error: 'x', gatewayError: { code: 'bad_key', title: 'key 无效', message: '网关不认这个 key' } } });
  assert.equal(g.cause, 'gateway-config'); assert.equal(g.text, 'key 无效'); assert.deepEqual(acts(g), ['hub-bs:gateway-settings']);
});
