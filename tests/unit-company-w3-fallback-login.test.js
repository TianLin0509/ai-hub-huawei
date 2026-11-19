'use strict';
// 门户备用登录（2026-11-20）的两条硬要求：
//   1. 现在能正常读门户的用户不受影响：原路线（无头 Edge）成功时，备用路线的代码一行都不走，传给原路线的参数与改前一样；
//      没在 Hub 里登录过的用户，原路线失败也不会自己走备用路线；备用路线出任何异常都回到原路线。
//   2. 不引发 Edge 风暴：备用路线只用 Hub 自己的窗口，不调原路线之外的浏览器启动；任何时刻最多 1 个登录窗口，
//      隐藏取数窗口每次用完即销毁（成功、停在登录页、出错都一样）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { CompanyW3, LOGIN_DONE_SCRIPT } = require('../core/company-w3/service');
const { createForumBrowser } = require('../main/company-forum-browser');

const raw = () => ({ login: true, me: { uid: 'u1', email: 'someone@corp.example', name: '某人', deptCode: '012345', area: 'Shanghai' },
  todo: { count: 1, apps: [{ app: '绩效', count: 1, listed: 1, items: [{ taskUUID: 'p1', taskDesc: '请完成中期辅导', time: '2026-11-10 11:04:59', taskURL: 'http://flow.corp.example/t/p1', applicant: 'someone 00123456', handler: 'approver 00654321', quickApprove: '0' }] }] },
  apply: { apps: [] }, task: { count: 0 }, docs: { policy: [] } });
const LOGIN_FAIL = { ok: false, needsLogin: true, error: '需要登录（停在 login.corp.example）', finalHost: 'login.corp.example', tookMs: 46000, loginCopy: { profile: 'Default', copied: 2, cookies: false } };

// 会记账的替身：哪个依赖被碰过、拿到什么参数，一目了然。
function make(t, { edge, hubRun, hubLogin } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-fallback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = { edge: [], hubRun: [], hubLogin: [] };
  const svc = new CompanyW3({ dataDir, noTimer: true, now: () => new Date('2026-11-20T09:00:00'),
    edgeRun: async (o) => { calls.edge.push(o); return edge ? edge(o) : { ok: true, value: raw(), tookMs: 8000 }; },
    hubRun: async (o) => { calls.hubRun.push(o); if (!hubRun) throw new Error('不该走到备用路线'); return hubRun(o); },
    hubLogin: async (o) => { calls.hubLogin.push(o); if (!hubLogin) throw new Error('不该弹登录窗口'); return hubLogin(o); },
  });
  svc.setSettings({ domain: 'corp.example' });
  return { svc, calls, dataDir };
}

test('硬要求 1：原路线成功 → 备用路线一行不走，参数与改前一样，记录里没有备用痕迹', async t => {
  const { svc, calls, dataDir } = make(t);
  const e = await svc.sync({ reason: 'auto' });
  assert.equal(e.ok, true);
  assert.equal(calls.edge.length, 1);
  assert.equal(calls.hubRun.length, 0); assert.equal(calls.hubLogin.length, 0);
  // 改前传给原路线的就是这 6 项（tag 仍是 hub-w3，排队、超时、登录等待全用原默认值）。
  assert.deepEqual(Object.keys(calls.edge[0]).sort(), ['accept', 'readyUrl', 'script', 'signal', 'tag', 'url']);
  assert.equal(calls.edge[0].tag, 'hub-w3'); assert.equal(calls.edge[0].url, 'https://w3.corp.example/');
  assert.ok(!('via' in e) && !('hubTried' in e));
  assert.equal(fs.existsSync(path.join(dataDir, 'company-w3', 'hub-login.json')), false);
  const log = JSON.parse(fs.readFileSync(path.join(dataDir, 'logs', 'company-w3.log'), 'utf8').trim());
  assert.equal(log.via, undefined); assert.equal(log.hubTried, undefined);
});

test('硬要求 1：没在 Hub 里登录过，原路线失败也不自己走备用路线，只在页面上给登录按钮', async t => {
  const { svc, calls } = make(t, { edge: () => LOGIN_FAIL });
  const e = await svc.sync({ reason: 'auto' });
  assert.equal(e.ok, false); assert.equal(e.kind, 'login');
  assert.equal(calls.hubRun.length, 0); assert.equal(calls.hubLogin.length, 0);
  assert.deepEqual(svc.status().hubLogin, { available: true, at: null, expiredAt: null });
});

test('用户点登录 → 登好后先用 Hub 窗口读，原路线（无头 Edge）一次都不启动', async t => {
  const { svc, calls } = make(t, { edge: () => LOGIN_FAIL, hubLogin: () => ({ ok: true }), hubRun: () => ({ ok: true, via: 'hub', value: raw(), tookMs: 3000 }) });
  await svc.sync({ reason: 'auto' });
  const r = await svc.login();
  assert.equal(r.ok, true);
  assert.equal(calls.hubLogin[0].doneScript, LOGIN_DONE_SCRIPT);
  assert.equal(calls.hubLogin[0].url, 'https://w3.corp.example/');
  assert.ok(svc.status().hubLogin.at);
  const edgeBefore = calls.edge.length;
  const e = await svc.sync({ reason: 'login' });
  assert.equal(e.ok, true); assert.equal(e.via, 'hub'); assert.equal(e.todo, 1);
  assert.equal(calls.edge.length, edgeBefore, '备用路线读到了就不再拉起无头 Edge');
});

test('硬要求 1：备用路线抛异常或超时 → 照原路线读，原路线成功就成功', async t => {
  const { svc, calls } = make(t, { hubLogin: () => ({ ok: true }), hubRun: () => { throw new Error('窗口崩了'); } });
  await svc.login();
  const e = await svc.sync({ reason: 'auto' });
  assert.equal(e.ok, true); assert.equal(calls.edge.length, 1); assert.equal(calls.hubRun.length, 1);
  assert.ok(svc.status().hubLogin.at, '非登录类失败不作废 Hub 里的登录');
});

test('Hub 里的登录失效 → 作废、回到原路线；原路线也不行就再给登录按钮', async t => {
  const { svc, calls } = make(t, { edge: () => LOGIN_FAIL, hubLogin: () => ({ ok: true }), hubRun: () => ({ ok: false, via: 'hub', needsLogin: true, error: '需要登录（停在 login.corp.example）' }) });
  await svc.login();
  const e = await svc.sync({ reason: 'auto' });
  assert.equal(e.ok, false); assert.equal(e.kind, 'login'); assert.match(e.hubTried, /需要登录/);
  assert.equal(calls.edge.length, 1);
  const h = svc.status().hubLogin;
  assert.equal(h.at, null); assert.ok(h.expiredAt);
  await svc.sync({ reason: 'auto' });
  assert.equal(calls.hubRun.length, 1, '作废后下次不再先走备用路线');
});

test('登录窗口在取数途中登好：登录记录不被取数结束时写回的状态覆盖', async t => {
  let release;
  const { svc } = make(t, { edge: () => new Promise((r) => { release = () => r(LOGIN_FAIL); }), hubLogin: () => ({ ok: true }) });
  const p = svc.sync({ reason: 'auto' });
  await new Promise((r) => setImmediate(r));
  await svc.login();
  release(); await p;
  assert.ok(svc.status().hubLogin.at);
});

test('登录窗口关掉或失败：不记登录，原路线照旧', async t => {
  const { svc, calls } = make(t, { hubLogin: () => ({ ok: false }) });
  assert.equal((await svc.login()).ok, false);
  assert.equal(svc.status().hubLogin.at, null);
  await svc.sync({ reason: 'auto' });
  assert.equal(calls.hubRun.length, 0); assert.equal(calls.edge.length, 1);
});

function fakeWindows(behave) {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.url = '';
      this.webContents = Object.assign(new EventEmitter(), { setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => this.url,
        executeJavaScript: async (script) => behave(this, script) });
      windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
    show() {} focus() {}
  }
  const alive = () => windows.filter((w) => !w.dead).length;
  return { Window, windows, alive };
}
const state = (o) => ({ host: 'w3.corp.example', href: 'https://w3.corp.example/next/indexa.html', ready: 'complete', hasPassword: false, hasQr: false, ...o });
const READY = /^https:\/\/w3\.corp\.example\/(next\/index\w*\.html)?$/;

test('硬要求 2：Hub 窗口取数成功、停在登录页、出错，窗口都当场销毁，同一时刻只有 1 个', async t => {
  let peak = 0;
  const mk = (kind) => fakeWindows((win, script) => {
    peak = Math.max(peak, fw.alive());
    if (script.includes('hasPassword')) return kind === 'login' ? state({ host: 'login.corp.example', href: 'https://login.corp.example/', hasPassword: true }) : state();
    if (kind === 'throw') throw new Error('boom');
    return { login: true, me: {} };
  });
  let fw = mk('ok');
  let b = createForumBrowser({ BrowserWindow: fw.Window });
  const runs = await Promise.all([1, 2, 3].map(() => b.evaluate({ url: 'https://w3.corp.example/', readyUrl: READY, script: 'collect()', accept: (v) => !!v?.login, pollMs: 5, maxMs: 2000 })));
  assert.ok(runs.every((r) => r.ok && r.via === 'hub'));
  assert.equal(fw.windows.length, 3); assert.equal(fw.alive(), 0); assert.equal(peak, 1, '排队执行，同一时刻最多 1 个隐藏窗口');
  fw = mk('login'); b = createForumBrowser({ BrowserWindow: fw.Window });
  const r2 = await b.evaluate({ url: 'https://w3.corp.example/', readyUrl: READY, script: 'collect()', pollMs: 5, loginGraceMs: 30, maxMs: 2000 });
  assert.equal(r2.ok, false); assert.equal(r2.needsLogin, true); assert.equal(fw.alive(), 0);
  fw = mk('throw'); b = createForumBrowser({ BrowserWindow: fw.Window });
  const r3 = await b.evaluate({ url: 'https://w3.corp.example/', readyUrl: READY, script: 'collect()', pollMs: 5, maxMs: 200 });
  assert.equal(r3.ok, false); assert.equal(r3.needsLogin, false); assert.match(r3.error, /查询出错/); assert.equal(fw.alive(), 0);
});

test('硬要求 2：登录窗口最多 1 个（再点只是把已开的那个提到前面），账号查询通过后自动销毁', async t => {
  let loggedIn = false;
  const fw = fakeWindows((_win, script) => (script === 'DONE' ? loggedIn : null));
  const b = createForumBrowser({ BrowserWindow: fw.Window });
  t.after(() => b.close());
  const first = b.login({ url: 'https://w3.corp.example/', base: 'https://w3.corp.example/', doneScript: 'DONE' });
  const second = await b.login({ url: 'https://w3.corp.example/', base: 'https://w3.corp.example/', doneScript: 'DONE' });
  assert.equal(second.reason, 'already-open');
  assert.equal(fw.windows.length, 1);
  loggedIn = true;
  const r = await first;
  assert.equal(r.ok, true); assert.equal(fw.alive(), 0);
  // 用户自己关窗：返回 ok:false，窗口同样不留。
  const third = b.login({ url: 'https://w3.corp.example/', base: 'https://w3.corp.example/', doneScript: 'DONE' });
  fw.windows[1].destroy();
  assert.equal((await third).ok, false); assert.equal(fw.alive(), 0);
});

test('备用路线不碰无头 Edge：Hub 窗口这条路线里没有任何浏览器进程启动点', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'company-forum-browser.js'), 'utf8');
  assert.doesNotMatch(src, /child_process|launchHeadlessEdge|spawn\(|msedge/);
});

test('审查 #1：旧的一次读还没回来时用户重新登录了，旧结果「要登录」不作废新登录', async t => {
  let release;
  const { svc } = make(t, { hubLogin: () => ({ ok: true }), hubRun: () => new Promise((r) => { release = () => r({ ok: false, via: 'hub', needsLogin: true, error: '需要登录' }); }) });
  await svc.login();
  const p = svc.sync({ reason: 'auto' });
  await new Promise((r) => setImmediate(r));
  svc.write('hub-login', { at: '2026-11-20T09:05:00.000Z' }); // 等同于途中又登录了一次
  release(); await p;
  assert.equal(svc.status().hubLogin.at, '2026-11-20T09:05:00.000Z');
});

test('审查 #2：关掉功能会取消正在进行的备用读取；登录途中关掉，不记登录', async t => {
  let seen;
  const { svc, calls } = make(t, { hubLogin: () => ({ ok: true }), hubRun: (o) => new Promise((r) => { seen = o.signal; o.signal.addEventListener('abort', () => r({ ok: false, via: 'hub', error: '已取消' })); }) });
  await svc.login();
  const p = svc.sync({ reason: 'auto' });
  await new Promise((r) => setImmediate(r));
  svc.close();
  const e = await p;
  assert.equal(seen.aborted, true); assert.equal(e.ok, false); assert.equal(calls.edge.length, 0, '关掉后不再走原路线');
  let finish;
  const { svc: svc2 } = make(t, { hubLogin: () => new Promise((r) => { finish = r; }) });
  svc2.start();
  const lp = svc2.login();
  await new Promise((r) => setImmediate(r));
  svc2.close(); finish({ ok: true });
  assert.equal((await lp).ok, false);
  assert.equal(svc2.status().hubLogin.at, null);
});

test('复审 #1/#2：取消能打断正在加载或查询的隐藏窗口，当场销毁，且不当成「要登录」', async t => {
  // 查询永远不返回（模拟页面卡住）：取消后 evaluate 立刻结束、窗口销毁。
  const fw = fakeWindows((_w, script) => (script.includes('hasPassword') ? state() : new Promise(() => {})));
  const b = createForumBrowser({ BrowserWindow: fw.Window });
  const ac = new AbortController();
  const p = b.evaluate({ url: 'https://w3.corp.example/', readyUrl: READY, script: 'collect()', signal: ac.signal, pollMs: 5, maxMs: 60000 });
  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.cancelled, true); assert.equal(r.needsLogin, false); assert.equal(fw.alive(), 0);
  // 停在登录页期间取消：同样不是「要登录」。
  const fw2 = fakeWindows(() => state({ host: 'login.corp.example', href: 'https://login.corp.example/', hasPassword: true }));
  const b2 = createForumBrowser({ BrowserWindow: fw2.Window });
  const ac2 = new AbortController();
  const p2 = b2.evaluate({ url: 'https://w3.corp.example/', readyUrl: READY, script: 'collect()', signal: ac2.signal, pollMs: 5, loginGraceMs: 60000, maxMs: 60000 });
  await new Promise((r) => setTimeout(r, 60));
  ac2.abort();
  const r2 = await p2;
  assert.equal(r2.needsLogin, false); assert.equal(fw2.alive(), 0);
});

test('复审 #2：关功能取消备用读取时，保存的 Hub 登录不被作废', async t => {
  const { svc } = make(t, { hubLogin: () => ({ ok: true }), hubRun: (o) => new Promise((r) => { o.signal.addEventListener('abort', () => r({ ok: false, via: 'hub', needsLogin: true, error: '需要登录' })); }) });
  await svc.login();
  const at = svc.status().hubLogin.at;
  const p = svc.sync({ reason: 'auto' });
  await new Promise((r) => setImmediate(r));
  svc.close(); await p;
  assert.equal(svc.status().hubLogin.at, at);
});
