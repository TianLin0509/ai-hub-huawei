'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accountState, accountOptionLabel, usableAccounts, canStartAccount, pauseReason, accountChoiceValue, accountChoiceSelection } = require('../renderer/codeagent-account-state');
const { renderAccounts } = require('../renderer/codeagent-accounts-view');
const { accountCommand } = require('../renderer/codeagent-accounts-page');
const { renderAccountOption } = require('../renderer/codeagent-accounts-view');

test('未检测到 CodeAgent 时保留已有号池与管理，安装后恢复登录和新建', () => {
  const pool = { personal: { state: 'login-required' }, accounts: [{ id: 'saved-account', note: '已有账号甲', state: 'ready', models: ['model-one'], activeSessions: 2 }] };
  const missing = renderAccounts(pool, { installed: false });
  assert.match(missing, /未检测到 CodeAgent/);
  const personalRow = missing.match(/<section class="caa-me-card"[\s\S]*?<\/section>/)[0];
  assert.match(personalRow, /未检测到 CodeAgent/);
  assert.doesNotMatch(personalRow, /需登录|个人账号尚未登录|还没登录/);
  assert.match(missing, /已有账号甲/); assert.match(missing, /data-ca-account="saved-account"/);
  assert.match(missing, /model-one/); assert.match(missing, /共 1 个/);
  assert.match(missing, /data-ca="install-guide"/); assert.match(missing, /data-ca="check-install"/);
  const controls = missing.match(/<button\b[^>]*>/g);
  assert.ok(controls.filter(tag => /data-ca="(?:login|session|add|probe|probe-all|drawer)"/.test(tag)).every(tag => /\bdisabled\b/.test(tag)));
  assert.ok(controls.some(tag => /data-ca="menu"/.test(tag) && !/\bdisabled\b/.test(tag)));
  const menu = renderAccounts(pool, { installed: false, menu: 'saved-account' });
  assert.match(menu, /data-ca="remove"[^>]*>/);
  const installed = renderAccounts(pool, { installed: true });
  assert.ok(installed.match(/<button\b[^>]*>/g).some(tag => /data-ca="session"/.test(tag) && !/\bdisabled\b/.test(tag)));
  assert.doesNotMatch(installed, /未检测到 CodeAgent/);
  assert.match(installed, /个人账号尚未登录/);
});
const { accountExpiry } = require('../renderer/codeagent-account-state');

test('到期信息区分跨日日期、自动续期和24小时内提醒', () => {
  const now = new Date(2026, 10, 5, 10, 0).getTime();
  const later = now + 72 * 3600000;
  assert.deepEqual(accountExpiry({ expiresAt: later }, now), { text: '11-08 10:00 到期', warning: false });
  assert.deepEqual(accountExpiry({ expiresAt: later, renewable: true }, now), { text: '会自动续期', warning: false });
  assert.deepEqual(accountExpiry({ expiresAt: now + 3600000 }, now), { text: '11:00 到期', warning: true });
  assert.deepEqual(accountExpiry({ expiresAt: now - 3600000, renewable: true }, now), { text: '会自动续期', warning: false });
  assert.deepEqual(accountExpiry({ expiresAt: now - 3600000, method: 'devuc' }, now), { text: '会自动续期', warning: false });
  assert.deepEqual(accountExpiry({ expiresAt: 'invalid' }, now), { text: '', warning: false });
});

test('个人与号池账号都显示可续期信息，暂停原因优先保留', () => {
  const html = renderAccounts({ personal: { state: 'ready', renewable: true }, accounts: [{ id: 'pool-renew', state: 'ready', renewable: true }] });
  assert.equal((html.match(/>会自动续期</g) || []).length, 2);
  const paused = renderAccounts({ personal: { state: 'ready' }, accounts: [{ id: 'paused', state: 'ready', renewable: true, avoid: { source: 'manual', until: null } }] });
  assert.match(paused, /手动暂停 · 直到手动恢复/);
});

test('CodeAgent账号：凭证可用且未暂停的独立账号可选号', () => {
  assert.equal(accountState({ state: 'ready' }).usable, true);
  assert.equal(accountState({ state: 'ready', sameAsPersonal: true }).usable, false);
  assert.equal(accountState({ state: 'ready', duplicateOf: 'other' }).usable, false);
});
for (const [source, label] of [['manual', '暂停中（手动）'], ['quota', '暂停中（额度）']]) {
  test(`CodeAgent账号：${label}不计入可用账号`, () => {
    const a = { id: 'paused', state: 'ready', avoid: { source, label: '2小时后恢复' } };
    assert.deepEqual(accountState(a), { usable: false, tone: 'warn', label, detail: '2小时后恢复' });
    assert.deepEqual(usableAccounts([a, { id: 'ok', state: 'ready' }]).map(x => x.id), ['ok']);
  });
}
for (const state of ['expired', 'login-required', 'unreadable']) {
  test(`CodeAgent账号：${state}显示需登录，不参与选号`, () => {
    assert.equal(accountState({ state }).usable, false);
    assert.equal(accountState({ state }).label, '需登录');
  });
}
test('CodeAgent个人账号未登录与旧格式凭证存在状态兼容', () => {
  assert.equal(accountState({}, { personal: true }).usable, false);
  assert.equal(accountState({ present: true }, { personal: true }).usable, true);
  assert.equal(accountState({ present: true, state: 'expired' }, { personal: true }).usable, false);
});
test('CodeAgent选号标签包含备注、状态与进行中会话数，空池可枚举', () => {
  assert.equal(accountOptionLabel({ state: 'ready', note: '研发号', accountLabel: 'a***b', activeSessions: 2 }), '研发号 · a***b · 可用 · 2 个进行中会话');
  assert.match(accountOptionLabel({ state: 'expired', note: '测试号' }), /测试号 · 需登录 · 0 个进行中会话/);
  assert.deepEqual(usableAccounts([]), []);
});

test('空池保留个人账号、添加和本机导入入口', () => {
  const html = renderAccounts({ personal: { present: true }, accounts: [] });
  assert.match(html, /号池里还没有账号/);
  assert.match(html, /data-ca-account="personal"/);
  assert.match(html, /data-ca="drawer"/);
  assert.match(html, /导入本机已登录的号/);
});
test('个人账号未登录时提示但允许建会话，重新登录仍在更多菜单', () => {
  const html = renderAccounts({ personal: {}, accounts: [] }, { menu: 'personal' });
  assert.match(html, /个人账号尚未登录/);
  assert.match(html, /data-ca="login" data-id="personal"/);
  assert.match(html, /data-ca="session" data-id="personal"/);
});
test('个人暂停只提示，保留新会话主按钮和菜单里的恢复使用', () => {
  const html = renderAccounts({ personal: { state: 'ready', avoid: { source: 'manual', until: null } }, accounts: [] }, { menu: 'personal' });
  assert.match(html, /data-ca="session" data-id="personal"/);
  assert.match(html, /data-ca="resume" data-id="personal"/);
  assert.match(html, /暂停中（手动）/);
});
for (const [label, personal] of [
  ['列表未读到', undefined], ['凭证无法读取', { state: 'unreadable' }], ['未登录', { state: 'login-required' }],
  ['登录过期', { state: 'expired' }], ['额度暂停', { state: 'ready', avoid: { source: 'credit', until: null } }],
]) test(`个人账号${label}只警告，号池仍拒绝同状态`, () => {
  assert.equal(accountState(personal, { personal: true }).usable, false);
  assert.equal(canStartAccount(personal, { personal: true }), true);
  assert.equal(canStartAccount(personal), false);
  assert.match(renderAccounts({ personal, accounts: [] }), /data-ca="session" data-id="personal"/);
});
test('有号页面显示备注、会话数和原样模型权限，转义账号文本', () => {
  const html = renderAccounts({ personal: {}, accounts: [{ id: 'a', note: '<img onerror=1>', accountLabel: 'a***b', state: 'ready', models: ['model-a', 'model-b', 'model-c'], activeSessions: 3 }] });
  assert.match(html, /&lt;img onerror=1&gt;/);
  assert.doesNotMatch(html, /<img onerror/);
  assert.match(html, /data-ca="session" data-id="a"/);
  assert.match(html, /model-a、model-b、model-c/);
  assert.match(html, /caa-sessions">3/);
});
for (const source of ['manual', 'quota']) test(`暂停账号${source}只允许恢复，不提供新会话操作`, () => {
  const html = renderAccounts({ personal: {}, accounts: [{ id: 'paused', state: 'ready', avoid: { source, label: '稍后恢复' } }] });
  assert.match(html, new RegExp(source === 'manual' ? '暂停中（手动）' : '暂停中（额度）'));
  assert.match(html, /data-ca="resume" data-id="paused"/);
  assert.doesNotMatch(html, /data-ca="session" data-id="paused"/);
});
test('过期账号显示需登录；重复账号不参与新会话', () => {
  const html = renderAccounts({ personal: {}, accounts: [{ id: 'expired', state: 'expired' }, { id: 'dup', state: 'ready', sameAsPersonal: true }] });
  assert.match(html, /登录已过期/);
  assert.match(html, /data-ca="login" data-id="expired"/);
  assert.match(html, /data-ca="session" data-id="dup" disabled/);
});
test('添加抽屉区分可导入、已有、个人和过期目录', () => {
  const html = renderAccounts({ personal: {}, accounts: [] }, { drawer: true, local: [
    { name: '.cac-test', dir: 'D:\\fixtures\\a', state: 'ready' },
    { name: '.cac-own', state: 'ready', isPersonal: true },
    { name: '.cac-pool', state: 'ready', alreadyInPool: true },
    { name: '.cac-old', state: 'expired' },
  ] });
  assert.equal((html.match(/data-ca="import"/g) || []).length, 1);
  assert.match(html, /个人账号，不放进号池/);
  assert.match(html, /已在号池里/);
  assert.match(html, /需重新登录/);
});
test('获取权限排队、错误提示和暂停时长均可渲染', () => {
  const data = { personal: {}, accounts: [{ id: 'a', state: 'ready', note: '研发' }] };
  const html = renderAccounts(data, { menu: 'a', sub: true, message: '网络暂不可用', probing: new Set(['a']), total: 2 });
  assert.match(html, /正在读取模型菜单/);
  assert.match(html, /网络暂不可用/);
  assert.match(html, /data-hours="24"/);
  assert.match(html, /直到手动恢复/);
  assert.doesNotMatch(html, /派活|避让中/);
});
for (const [action, args, channel, payload] of [
  ['refresh', {}, 'list', {}], ['add', { note: '研发' }, 'add', { note: '研发' }],
  ['import', { dir: 'D:/fixtures/a' }, 'import', { dir: 'D:/fixtures/a' }],
  ['login', { id: 'personal' }, 'personal-login', { id: 'personal' }],
  ['login', { id: 'a' }, 'login', { id: 'a' }], ['probe', { id: 'a' }, 'probe', { id: 'a' }],
  ['pause', { id: 'a', hours: '2' }, 'pause', { id: 'a', hours: 2 }],
  ['pause', { id: 'a' }, 'pause', { id: 'a', hours: null }],
  ['resume', { id: 'a' }, 'resume', { id: 'a' }], ['remove', { id: 'a' }, 'remove', { id: 'a' }],
]) test(`账号按钮${action}/${args.id || ''}/${args.hours || ''}复用原IPC`, async () => {
  let received;
  const result = await accountCommand({ invoke: async (...call) => { received = call; return { ok: true, accounts: [] }; } }, action, args);
  assert.deepEqual(received, ['codeagent-pool:' + channel, { ...(action === 'refresh' ? { id: undefined } : payload) }]);
  assert.equal(result.ok, true);
});
test('IPC明确错误透传到页面；未知操作不会调用主进程', async () => {
  await assert.rejects(accountCommand({ invoke: async () => ({ ok: false, error: '仍有2个会话' }) }, 'remove', { id: 'a' }), /仍有2个会话/);
  await assert.rejects(accountCommand({ invoke: () => { throw Error('不得到达'); } }, 'unknown'), /未知账号操作/);
});

test('启动中心富选号行显示备注、状态与会话数，文本转义', () => {
  const html = renderAccountOption({ type: 'account', account: { note: '<研发>', state: 'ready', activeSessions: 2, avoid: { source: 'manual' } } });
  assert.match(html, /&lt;研发&gt;/);
  assert.match(html, /暂停中（手动）/);
  assert.match(html, /2 个会话/);
  assert.doesNotMatch(html, /<研发>/);
});
test('真实注册表的额度/手动暂停和当前模型配置暂停均不能被自动选号', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const pool = require('../core/codeagent-pool'), quota = require('../core/codeagent-quota');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-pause-unit-'));
  const ids = ['manual', 'credit', 'ready'].map(note => pool.addAccount(root, { note }));
  const accounts = ids.map((id, i) => ({ id, dir: pool.accountDir(root, id), state: 'ready', models: [], modelsAuthoritative: false, activeSessions: i, lastAssignedAt: 0 }));
  quota.markAvoid(root, ids[0], { source: 'manual', until: null });
  quota.markAvoid(root, ids[1], { source: 'credit', until: Date.now() + 3600000 });
  let choices = pool.withPauseStatus(root, accounts);
  assert.equal(pool.pickAccount(choices).id, ids[2], '可用号会话数较多也不能改选暂停号');
  quota.clearAvoid(root, ids[0], { by: 'local' });
  choices = pool.withPauseStatus(root, accounts);
  assert.equal(pool.pickAccount(choices).id, ids[0], '恢复后可正常进入轮转');
  quota.markAvoid(root, ids[0], { source: 'manual', until: null });
  quota.markAvoid(root, ids[2], { source: 'manual', until: null });
  assert.equal(pool.pickAccount(pool.withPauseStatus(root, accounts)), null, '全暂停时无可用账号');
  quota.clearAvoid(root, ids[2], { by: 'local' });
  fs.writeFileSync(path.join(accounts[2].dir, 'settings.json'), JSON.stringify({ model: 'model-a' }));
  quota.markModelAvoid(root, ids[2], { model: 'model-a' });
  assert.equal(pool.pickAccount(pool.withPauseStatus(root, accounts)), null, '当前模型配置暂停与账号页保持一致');
  fs.writeFileSync(path.join(accounts[2].dir, 'settings.json'), JSON.stringify({ model: 'model-b' }));
  assert.equal(pool.pickAccount(pool.withPauseStatus(root, accounts)).id, ids[2], '修正模型后旧模型记录不会误挡账号');
});

test('长模型名仅显示首个chip与其余数量，title保留全部名称', () => {
  const models = ['GLM-5.2-WX-Auto-long-model-name', 'deepseek-v4-flash', 'another-model'];
  const html = renderAccounts({ personal: {}, accounts: [{ id: 'model-test', state: 'ready', models }] });
  assert.equal((html.match(/class="caa-chip"/g) || []).length, 1);
  assert.match(html, /class="caa-chip" title="GLM-5\.2-WX-Auto-long-model-name"/);
  assert.match(html, /class="caa-chip caa-more"[^>]*>\+2<\/span>/);
  assert.match(html, /title="GLM-5\.2-WX-Auto-long-model-name、deepseek-v4-flash、another-model"/);
});

test('暂停原因在概览、状态、额度和富下拉一致，旧原始串不泄漏', t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 3, 17));
  const avoid = { source: 'quota', kind: 'quota', until: Date.UTC(2026, 10, 3, 19, 5), label: '额度上限（quota） ，预计 11-04 03:05 恢复' };
  const wanted = '额度用完 · 约 03:05 恢复';
  const account = { id: 'quota-test', state: 'ready', note: '测试号', avoid };
  assert.equal(pauseReason(avoid), wanted);
  assert.equal(accountState(account).detail, wanted);
  const html = renderAccounts({ personal: {}, accounts: [account] });
  assert((html.match(/额度用完 · 约 03:05 恢复/g) || []).length >= 3);
  assert.doesNotMatch(html, /（quota）|预计|额度上限/);
  assert.match(renderAccountOption({ type: 'account', account }), /额度用完 · 约 03:05 恢复/);
  assert.equal(pauseReason({ label: avoid.label }), wanted, '旧label也归一化');
});

test('当天恢复只写时间，跨天保留日期，判定与既有东八区显示一致', () => {
  const now = Date.UTC(2026, 10, 3, 16, 30); // 11-04 00:30 in the displayed time zone.
  assert.equal(pauseReason({ until: Date.UTC(2026, 10, 4, 2, 14) }, now), '额度用完 · 约 10:14 恢复');
  assert.equal(pauseReason({ until: Date.UTC(2026, 10, 4, 16, 14) }, now), '额度用完 · 约 11-05 00:14 恢复');
  assert.equal(pauseReason({ label: '额度上限（quota） ，预计 11-05 00:14 恢复' }, now), '额度用完 · 约 11-05 00:14 恢复');
});

test('跨年和跨月午夜不会被当作当天省略日期', () => {
  const now = Date.UTC(2026, 11, 31, 15, 59);
  assert.equal(pauseReason({ until: Date.UTC(2026, 11, 31, 16, 1) }, now), '额度用完 · 约 01-01 00:01 恢复');
  assert.equal(pauseReason({ source: 'manual', until: Date.UTC(2026, 11, 31, 16, 14) }, Date.UTC(2026, 11, 31, 16, 2)), '手动暂停 · 约 00:14 恢复');
});

test('暂停说明保留手动、限流和模型配置三种不同处理含义', () => {
  assert.equal(pauseReason({ source: 'manual', until: null }), '手动暂停 · 直到手动恢复');
  assert.match(pauseReason({ source: 'error', kind: 'rate-limit', until: Date.UTC(2026, 10, 3, 19, 5) }), /^请求过于频繁 · 约/);
  assert.equal(pauseReason({ kind: 'model-config', label: '模型配置有误：请核对model-a' }), '模型配置有误：请核对model-a');
});

test('统一账号选项保留个人、自动与指定账号的三种内部映射', () => {
  for (const [mode, pick, value] of [['personal', '', 'personal'], ['pool', '', 'pool'], ['pool-manual', 'account-id', 'account:account-id']]) {
    assert.equal(accountChoiceValue(mode, pick), value);
    assert.deepEqual(accountChoiceSelection(value), { mode, pick });
  }
  assert.equal(accountChoiceValue('pool-manual', 'removed-id'), 'account:removed-id', '移出账号的预选不退回个人');
  assert.match(renderAccountOption({ type: 'manage' }), /管理账号…/);
});


test('号池快照透传可续期标记，不返回续期材料', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const pool = require('../core/codeagent-pool');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-renewal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const renewable = pool.addAccount(root, { note: '可续期' });
  const fixed = pool.addAccount(root, { note: '固定到期' });
  for (const [id, canRenew] of [[renewable, true], [fixed, false]]) {
    fs.writeFileSync(path.join(pool.accountDir(root, id), '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'fixture-token', accountId: id, expiresAt: Date.now() + 72 * 3600000, ...(canRenew ? { mtoken: 'fixture-renewal-secret' } : {}) } }));
  }
  const rows = pool.listAccounts(root);
  assert.equal(rows.find(a => a.id === renewable).renewable, true);
  assert.equal(rows.find(a => a.id === fixed).renewable, false);
  assert.doesNotMatch(JSON.stringify(rows), /fixture-token|fixture-renewal-secret|mtoken/);
});
