'use strict';

// 公司模型的 Claude Code / Codex / DSH 会话选账号（2026-11-07 用户：启动中心和 CodeAgent 一致，自动挑号 / 个人账号 / 号 N）：
// 启动中心的选项与取值、主进程核对、Key 编码、恢复与分支沿用、卡片上的号。反代侧的固定号语义在 unit-company-model-proxy.test.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const view = require('../renderer/company-proxy-account-view');
const { resolveCompanyProxyAccount, accountHasModel } = require('../core/company-proxy-account');
const hubProxy = require('../core/company-model-proxy');

test('proxy reassigns deleted or login-missing sticky accounts; unreadable logins retry before returning 401', async () => {
  const load = name => import(require('node:url').pathToFileURL(path.join(__dirname, '../core/company-proxy', name)).href);
  const { createAccountRouter } = await load('account-router.mjs'), { poolAccounts, accountAlias } = await load('server.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-deleted-')), root = path.join(dataDir, 'codeagent-pool');
  const credential = id => path.join(root, 'accounts', id, '.credentials.json');
  try {
    for (const mode of ['missing', 'deleted', 'unregistered', 'unreadable']) for (const target of ['bbbbbb2', 'personal']) {
      for (const id of ['aaaaaa1', 'bbbbbb2', 'personal']) { fs.mkdirSync(path.dirname(credential(id)), { recursive: true }); fs.writeFileSync(credential(id), '{}'); }
      fs.writeFileSync(path.join(root, 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1' }, { id: 'bbbbbb2' }] }));
      fs.writeFileSync(path.join(root, 'quota-aliases.json'), JSON.stringify({ map: { aaaaaa1: 1 } }));
      let broken = false, allBroken = false; const used = [];
      const router = createAccountRouter({ statSync: fs.statSync, listAccounts: () => poolAccounts(dataDir, Date.now(), credential('personal')),
        makeProvider: (account, { onCredentialFailure }) => ({ complete: async () => {
          used.push(account.id);
          if (allBroken || broken && account.id === 'aaaaaa1') { onCredentialFailure(); throw new Error('unreadable'); }
          return new Response(null, { status: 200 });
        } }) });
      assert.equal(router.pick('q1').id, 'aaaaaa1');
      if (mode === 'deleted') require('../core/codeagent-pool').removeAccount(dataDir, 'aaaaaa1');
      if (mode === 'unregistered') fs.writeFileSync(path.join(root, 'pool.json'), JSON.stringify({ accounts: [{ id: 'bbbbbb2' }] }));
      if (mode === 'missing') fs.rmSync(credential('aaaaaa1'));
      if (mode === 'unreadable') broken = true;
      if (target === 'personal') fs.rmSync(credential('bbbbbb2'));
      assert.equal(accountAlias(dataDir, 'aaaaaa1'), '号 1', 'retained alias does not register an account');
      assert.equal((await router.complete({}, { sessionTag: 'q1' })).status, 200, mode + ':' + target);
      assert.deepEqual(used, mode === 'unreadable' ? ['aaaaaa1', target] : [target]);
      assert.equal(router.accountFor('q1'), target);
      allBroken = true;
      await assert.rejects(router.complete({}, { sessionTag: 'q1' }), e => e.code === 'COMPANY_LOGIN_NEEDED' && e.status === 401);
      for (const id of ['aaaaaa1', 'bbbbbb2', 'personal']) fs.rmSync(credential(id), { force: true });
      await assert.rejects(router.complete({}, { sessionTag: 'q1' }), e => e.code === 'COMPANY_LOGIN_NEEDED' && e.status === 401);
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
const ready = (id, extra = {}) => ({ id, state: 'ready', note: '备注' + id.slice(-1), accountLabel: 'x***' + id.slice(-1), activeSessions: 0, ...extra });
const pool = {
  ok: true,
  personal: { state: 'ready', present: true, accountLabel: 'p***1' },
  accounts: [
    ready('aaaaaa1', { models: ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017'], modelsAuthoritative: true }),
    ready('bbbbbb2', { models: ['deepseek-v4.1-flash-1017'], modelsAuthoritative: true }),
    ready('cccccc3', { avoid: { source: 'manual', until: null } }),
    ready('dddddd4', { models: [], modelsAuthoritative: false }),
  ],
};
const optionsOf = html => [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)].map(m => ({ value: m[1].replace(/&amp;/g, '&'), disabled: /\sdisabled/.test(m[2]), text: m[3] }));

test('launch center: same choices as CodeAgent - auto, personal, each pool account; model permission disables an account', () => {
  const glm = view.describe({ pool, model: 'GLM-5.2-WX', choice: 'auto' });
  const rows = optionsOf(glm.html);
  assert.deepEqual(rows.map(r => r.value), ['pool', 'personal', 'account:aaaaaa1', 'account:bbbbbb2', 'account:cccccc3', 'account:dddddd4', 'manage-accounts']);
  const byValue = Object.fromEntries(rows.map(r => [r.value, r]));
  assert.equal(byValue['account:aaaaaa1'].disabled, false);
  assert.equal(byValue['account:bbbbbb2'].disabled, true, 'authoritative list without GLM');
  assert.match(byValue['account:bbbbbb2'].text, /没有 GLM-5\.2-WX 的权限/);
  assert.equal(byValue['account:cccccc3'].disabled, true, 'paused');
  assert.equal(byValue['account:dddddd4'].disabled, false, 'unknown list refuses nothing, like the router');
  assert.equal(glm.value, 'pool');
  assert.equal(glm.control.type, 'auto');
  assert.equal(glm.control.available, 3, 'aaaaaa1 + dddddd4 + personal');
  assert.equal(glm.unavailable, false);
  // 换成 DeepSeek：号 2 能选了。
  const ds = view.describe({ pool, model: 'deepseek-v4.1-flash-1017', choice: 'bbbbbb2' });
  assert.equal(optionsOf(ds.html).find(r => r.value === 'account:bbbbbb2').disabled, false);
  assert.equal(ds.value, 'account:bbbbbb2');
  assert.equal(ds.unavailable, false);
  assert.match(ds.note, /整段会话固定用这个号/);
  // 选了号 2 再换回 GLM：不能建，说清原因。
  const blocked = view.describe({ pool, model: 'GLM-5.2-WX', choice: 'bbbbbb2' });
  assert.equal(blocked.unavailable, true);
  assert.match(blocked.note, /没有 GLM-5\.2-WX 的权限/);
  // 原来选的号已移出号池。
  const gone = view.describe({ pool, model: 'GLM-5.2-WX', choice: 'zzzzzz9' });
  assert.equal(gone.unavailable, true);
  assert.ok(optionsOf(gone.html).some(r => r.value === 'account:zzzzzz9' && r.disabled));
  assert.equal(view.describe({ pool, model: 'GLM-5.2-WX', choice: 'personal' }).control.type, 'personal');
});

test('launch center: select values map to the launch option; auto sends nothing', () => {
  assert.equal(view.choiceFromSelect('pool'), 'auto');
  assert.equal(view.choiceFromSelect('personal'), 'personal');
  assert.equal(view.choiceFromSelect('account:aaaaaa1'), 'aaaaaa1');
  assert.equal(view.choiceFromSelect('account:BAD id'), 'auto');
  assert.equal(view.normalizeChoice(null), 'auto');
  assert.deepEqual(view.launchOpts('auto'), {});
  assert.deepEqual(view.launchOpts('personal'), { companyProxyPick: 'personal' });
  assert.deepEqual(view.launchOpts('aaaaaa1'), { companyProxyPick: 'aaaaaa1' });
  assert.notEqual(view.STORAGE_KEY, 'hub.codeagent.account', 'kept apart from the CodeAgent choice');
});

test('launch center wiring: account field for company kinds on the company card, hidden for a shared pool, opts sent', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-controller.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /const companyAccountShown = \(kind = selectedKind\) => companyApiKind\(kind\) && !companyProxyStatus\?\.shared\n\s+&& \(companyPick\[kind\] \? companyPick\[kind\]\.source === 'company'/);
  assert.match(source, /if \(companyAccountShown\(\)\) Object\.assign\(opts, companyProxyAccountView\.launchOpts\(companyProxyChoice\)\);/);
  assert.match(source, /if \(companyAccountShown\(\) && companyAccountState\(\)\.unavailable\) throw new Error/);
  assert.match(source, /paintCodeagentAccount\(\);\n\s+paintCompanyAccount\(\);/);
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /id="new-session-company-account-field"/);
  assert.match(html, /data-select-for="new-session-company-account"/);
  const { KINDS } = require('../core/company-api-config');
  for (const kind of ['claude', 'codex', 'deepseek-acp']) assert.ok(KINDS.includes(kind), kind + ' is a company-model kind');
});

test('main: a fresh pick is checked like CodeAgent; stored pins are carried; shared pool never pins', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-'));
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: ['aaaaaa1', 'bbbbbb2', 'cccccc3', 'eeeeee5', 'ffffff6'].map(id => ({ id })) }));
  const list = () => [
    ready('aaaaaa1', { models: ['GLM-5.2-WX'], modelsAuthoritative: true }),
    ready('bbbbbb2', { models: ['deepseek-v4.1-flash-1017'], modelsAuthoritative: true }),
    ready('cccccc3', { avoid: { source: 'manual' } }),
    { id: 'eeeeee5', state: 'expired' },
    ready('ffffff6', { duplicateOf: 'aaaaaa1' }),
  ];
  const resolve = (args) => resolveCompanyProxyAccount({ dataDir, shared: false, listAccounts: list, model: 'GLM-5.2-WX', ...args });
  try {
    assert.equal(resolve({ pick: 'auto' }), null);
    assert.equal(resolve({}), null);
    assert.deepEqual(resolve({ pick: 'personal' }), { id: 'personal', label: '个人' });
    assert.deepEqual(resolve({ pick: 'aaaaaa1' }), { id: 'aaaaaa1', label: '号 1' });
    assert.throws(() => resolve({ pick: 'bbbbbb2' }), /号 2 没有 GLM-5\.2-WX 的权限/);
    assert.deepEqual(resolve({ pick: 'bbbbbb2', model: 'deepseek-v4.1-flash-1017' }), { id: 'bbbbbb2', label: '号 2' });
    assert.throws(() => resolve({ pick: 'cccccc3' }), /号 3 已暂停使用/);
    assert.throws(() => resolve({ pick: 'eeeeee5' }), /号 4 需要号主重新登录/);
    assert.throws(() => resolve({ pick: 'ffffff6' }), /重复/);
    assert.throws(() => resolve({ pick: 'gggggg7' }), /不在号池里/);
    assert.throws(() => resolve({ pick: 'Bad Id' }), /不认识/);
    // 恢复 / 分支：沿用记下的号，不再核对（号后来暂停也能打开会话，发消息时反代说明）。
    assert.deepEqual(resolve({ stored: 'cccccc3', pick: 'aaaaaa1' }), { id: 'cccccc3', label: '号 3' });
    assert.deepEqual(resolve({ stored: 'personal' }), { id: 'personal', label: '个人' });
    // 团队共享主机：号由主机分配。
    assert.equal(resolveCompanyProxyAccount({ dataDir, shared: true, pick: 'aaaaaa1', listAccounts: list }), null);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(accountHasModel({ id: 'x', models: ['GLM-5.2-WX-Auto'], modelsAuthoritative: true }, 'glm-5.2-wx'), true, 'same rule as the router');
});

test('session key carries the pin for Claude, Codex and DSH; never on a shared host', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-key-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 18998 });
  const { key } = hubProxy.readEndpoint(dataDir);
  try {
    const claude = {};
    hubProxy.applyClaudeEnv(claude, { dataDir, sessionId: 'sess-1', model: 'GLM-5.2-WX', account: 'aaaaaa1' });
    assert.equal(claude.ANTHROPIC_AUTH_TOKEN, key + '.sess-1__pin_aaaaaa1');
    const codex = {};
    hubProxy.applyCodexEnv(codex, { dataDir, sessionId: 'sess-2', model: 'GLM-5.2-WX', projectDir: dataDir, account: 'personal' });
    assert.equal(codex[hubProxy.KEY_ENV], key + '.sess-2__pin_personal');
    assert.equal(hubProxy.dshRoute({ dataDir, sessionId: 'sess-3', model: 'GLM-5.2-WX', account: 'bbbbbb2' }).key, key + '.sess-3__pin_bbbbbb2');
    assert.equal(hubProxy.dshRoute({ dataDir, sessionId: 'sess-4', model: 'GLM-5.2-WX' }).key, key + '.sess-4', 'auto: unchanged key');
    assert.equal(hubProxy.sessionKey({ key: 'k' }, 's', 'Bad Id'), 'k.s', 'malformed pin ignored');
    assert.equal(hubProxy.sessionKey({ key: 'k', origin: 'http://10.0.0.2:1' }, 's', 'aaaaaa1'), 'k.s', 'shared host assigns accounts itself');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('resume and branches keep the pinned account for claude, codex and deepseek-acp', () => {
  const { planSessionFork } = require('../core/session-fork-plan');
  const claude = planSessionFork({ source: { id: 's-c', kind: 'claude', companyRoute: 'proxy', companyProxyAccount: 'aaaaaa1',
    ccSessionId: '8fc2f692-84b3-48fe-883e-d6cf86435feb', currentModel: { id: 'GLM-5.2-WX' } } });
  assert.equal(claude.ok, true);
  assert.equal(claude.opts.companyProxyAccount, 'aaaaaa1');
  const codex = planSessionFork({ source: { id: 's-x', kind: 'codex', companyRoute: 'proxy', companyProxyAccount: 'personal',
    codexSid: '01a1b44c-e8d4-7672-a1c1-ccea74438db7', currentModel: { id: 'GLM-5.2-WX' } } });
  assert.equal(codex.opts.companyProxyAccount, 'personal');
  const dsh = planSessionFork({ source: { id: 's-d', kind: 'deepseek-acp', agentRuntime: 'pty', companyRoute: 'proxy', companyProxyAccount: 'bbbbbb2',
    acpSid: '8fc2f692-84b3-48fe-883e-d6cf86435feb', currentModel: { id: 'GLM-5.2-WX' } } });
  assert.equal(dsh.opts.companyProxyAccount, 'bbbbbb2');
  const auto = planSessionFork({ source: { id: 's-a', kind: 'claude', companyRoute: 'proxy', ccSessionId: '8fc2f692-84b3-48fe-883e-d6cf86435feb' } });
  assert.equal(auto.opts.companyProxyAccount, undefined);

  // 公开形态和恢复用的元数据都带上它；恢复入口把它传回 session-manager。
  const { SessionManager } = require('../core/session-manager');
  const pub = SessionManager.prototype._toPublic.call({}, { id: 'p-1', kind: 'claude', companyRoute: 'proxy', companyProxyAccount: 'aaaaaa1', companyProxyLabel: '号 1' });
  assert.equal(pub.companyProxyAccount, 'aaaaaa1');
  assert.equal(pub.companyProxyLabel, '号 1');
  const meta = require('../core/session-capabilities').buildSessionResumeMeta({ id: 'p-1', kind: 'codex', companyProxyAccount: 'aaaaaa1', companyProxyLabel: '号 1' });
  assert.equal(meta.companyProxyAccount, 'aaaaaa1');
  const resume = fs.readFileSync(path.join(__dirname, '../main/ipc/resume-session-handlers.js'), 'utf8');
  assert.match(resume, /meta\.companyProxyAccount && \/\^\(\?:claude\|codex\|deepseek-acp\)\(\?:-resume\)\?\$\/\.test\(meta\.kind\) \? \{ companyProxyAccount: meta\.companyProxyAccount \}/);
  const persisted = fs.readFileSync(path.join(__dirname, '../main/ipc/persistence-handlers.js'), 'utf8');
  assert.match(persisted, /'companyProxyAccount',\n?\s*'companyProxyLabel'/);
});

test('session card shows the pinned account at once, before the first answer', () => {
  const route = require('../renderer/company-route-view.js');
  route.updateStatus({ sessionAccounts: {} });
  const s = { id: 'pin-1', kind: 'claude', companyRoute: 'proxy', currentModel: { id: 'GLM-5.2-WX' }, companyProxyAccount: 'aaaaaa1', companyProxyLabel: '号 3' };
  assert.equal(route.routeInfo(s).chip, 'GLM · 号 3');
  assert.equal(route.routeInfo(s).pinned, true);
  assert.match(route.routeInfo(s).title, /整段会话固定用它/);
  assert.equal(route.routeInfo({ ...s, companyProxyAccount: 'personal', companyProxyLabel: '' }).text, 'GLM-5.2-WX · 公司模型 · 个人号');
  route.updateStatus({ shared: true, sessionAccounts: {} });
  assert.equal(route.routeInfo(s).alias, '', 'shared host: the host assigns accounts');
  route.updateStatus({ shared: false, sessionAccounts: {} });
});
