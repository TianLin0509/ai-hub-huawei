'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WeclawFetch, captureFromHtml, attendanceSummary } = require('../core/weclaw-fetch');
const { CompanyForum } = require('../core/company-forum/service');
const { CompanyAttendance } = require('../core/company-attendance/service');
const { AuthKeeper } = require('../core/company-assistant/auth-keeper');
const S = require('../core/company-forum/sites');
const X = require('../core/company-forum/extract');

// ---------------------------------------------------------------- 假的员工助手本机服务
function fakeAgent(t, { health = { status: 'ok', userId: 'u1' }, page = () => ({ ok: true, content: 'x', finalUrl: '', title: '' }), delayMs = 0, login = { ok: true, status: 'success' } } = {}) {
  const log = [];
  let active = 0, maxActive = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      log.push(req.method + ' ' + req.url);
      active += 1; maxActive = Math.max(maxActive, active);
      const send = obj => { active -= 1; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/v1/health') return send(typeof health === 'function' ? health() : health);
      if (req.url === '/v1/welinkcli/login') return send(login);
      if (req.url === '/opencode/fetchWebPageContent') {
        const b = JSON.parse(body || '{}');
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        return send(page(b));
      }
      active -= 1; res.writeHead(404); res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    resolve({ base: `http://127.0.0.1:${server.address().port}`, log, maxActive: () => maxActive });
  }));
}

test('没装员工助手：一个请求都不发，usable 为 false', async () => {
  let calls = 0;
  const wf = new WeclawFetch({ installed: () => false, fetchImpl: async () => { calls += 1; throw new Error('不该调用'); } });
  assert.equal(await wf.online(), false);
  assert.equal(await wf.usable('forum'), false);
  assert.equal(calls, 0);
  assert.equal(wf.status().reason, 'not-installed');
  assert.equal(wf.isInstalled(), false);
});

test('装了但没开（服务连不上）：自检不超过 1.5 秒预算，结果缓存', async () => {
  let calls = 0;
  const wf = new WeclawFetch({ installed: () => true, healthTimeoutMs: 300,
    fetchImpl: (_u, { signal }) => { calls += 1; return new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })); } });
  const t0 = Date.now();
  assert.equal(await wf.online(), false);
  assert.ok(Date.now() - t0 < 1000, '挂起的服务按超时放弃');
  assert.equal(await wf.online(), false);
  assert.equal(calls, 1, '60 秒内不重复自检');
  assert.equal(wf.status().reason, 'offline');
});

test('在线但没登录（userId 为空）不算可用', async t => {
  const a = await fakeAgent(t, { health: { status: 'ok', userId: '' } });
  const wf = new WeclawFetch({ installed: () => true, bases: [a.base] });
  assert.equal(await wf.online(), false);
  assert.equal(wf.status().reason, 'not-logged-in');
});

test('取页面：排队一次一个；超时按预算放弃并返回 TIMEOUT', async t => {
  const a = await fakeAgent(t, { delayMs: 150, page: b => ({ ok: true, content: 'page ' + b.url, finalUrl: b.url, title: 't' }) });
  const wf = new WeclawFetch({ installed: () => true, bases: [a.base] });
  assert.equal(await wf.online(), true);
  const rs = await Promise.all([1, 2, 3].map(i => wf.fetchPage('https://site.example/' + i, { format: 'html' })));
  assert.deepEqual(rs.map(r => r.ok), [true, true, true]);
  assert.equal(a.maxActive(), 1, '员工助手一次只处理一个，这里也一次只发一个');
  const slow = new WeclawFetch({ installed: () => true, bases: [a.base], budgetMs: 1200 });
  const a2 = await fakeAgent(t, { delayMs: 3000 });
  slow.bases = [a2.base];
  const t0 = Date.now();
  const r = await slow.fetchPage('https://site.example/slow');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2500);
});

test('熔断：连续 2 次失败停用 30 分钟，到点恢复；成功清零', async () => {
  let now = 1_000_000;
  const wf = new WeclawFetch({ installed: () => true, now: () => now, fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ status: 'ok', userId: 'u' }) }) });
  assert.equal(await wf.usable('forum'), true);
  wf.fail('forum', 'parse');
  assert.equal(await wf.usable('forum'), true, '一次失败不熔断');
  wf.fail('forum', 'parse');
  assert.equal(await wf.usable('forum'), false, '两次熔断');
  assert.equal(await wf.usable('attendance'), true, '按功能分别熔断');
  now += 30 * 60 * 1000 + 1;
  assert.equal(await wf.usable('forum'), true, '30 分钟后恢复');
  wf.fail('forum', 'x'); wf.succeed('forum'); wf.fail('forum', 'x');
  assert.equal(await wf.usable('forum'), true, '成功会清零');
});

test('代办 WeLink 登录：30 分钟最多一次；不在线不发', async t => {
  const a = await fakeAgent(t);
  let now = 5_000_000;
  const wf = new WeclawFetch({ installed: () => true, bases: [a.base], now: () => now });
  assert.deepEqual(await wf.welinkLogin(), { ok: true, status: 'success', reason: '' });
  assert.equal((await wf.welinkLogin()).status, 'throttled');
  now += 31 * 60 * 1000;
  assert.equal((await wf.welinkLogin()).ok, true);
  const off = new WeclawFetch({ installed: () => false });
  assert.equal((await off.welinkLogin()).status, 'unavailable');
});

// ---------------------------------------------------------------- 渲染后 HTML 的解析（合成样例，结构仿 probe 34）
const XS = 'https://xinsheng.corp.example';
const rankHtml = (heading, tag, n = 10) => `<div><span title="${heading}">${heading}</span></div><div class="list">`
  + Array.from({ length: n }, (_, k) => k + 1).map(i => `<div class="item"><svg></svg><a class="txt" target="_blank" href="${XS}/next/detail/#/index?uuid=${tag}00${i}&amp;uniqueType=homeRanking" title="示例排行帖子 ${tag}${i}">示例排行帖子 ${tag}${i}</a></div>`).join('') + '</div>';
const xsHtml = (n = 10) => `<html><body><nav>${[1, 2, 3, 4].map(i => `<a href="${XS}/next/index/#/list?id=10${i}">分类${i}</a>`).join('')}</nav>`
  + rankHtml('24小时点击排行', 'c', n) + rankHtml('24小时回复排行', 'r', n) + `<a href="https://www.corp.example">官网</a></body></html>`;

test('心声渲染页：按排行标题切板块，只认详情页链接（不把分类链接当帖子）', () => {
  const site = S.siteById('xinsheng');
  const cap = captureFromHtml(xsHtml(5), { finalUrl: XS + '/next/index/#/home', headings: site.lists.map(l => l.heading) });
  const lists = X.postsForSite({ ...site, postLink: site.weclaw.postLink }, cap, { base: XS, limit: 20 });
  assert.deepEqual(lists.map(l => [l.key, l.posts.map(p => p.id)]), [['click', ['c001', 'c002', 'c003', 'c004', 'c005']], ['reply', ['r001', 'r002', 'r003', 'r004', 'r005']]]);
  assert.ok(lists.every(l => l.posts.every(p => p.url.startsWith(XS + '/next/detail/'))));
});

test('考勤首页文字：认出待处理异常数和月结截止提示；认不出返回 null', () => {
  const s = attendanceSummary('我的审批 0 我的申请 12 待处理考勤异常 3 休假配额(小时) 0 2026年11月考勤数据处理将于北京时间2026年12月4日23:59截止，请您及时核对');
  assert.deepEqual(s, { anomalies: 3, deadline: '2026年11月考勤数据处理将于北京时间2026年12月4日23:59截止' });
  assert.equal(attendanceSummary('登录 请输入账号'), null);
});

// ---------------------------------------------------------------- 帖子服务：有无员工助手的对照
const three = tag => [1, 2, 3].map(i => ({ postId: `${tag}${i}`, title: `示例热帖 ${tag} 第 ${i} 条`, link: `/next/detail/#/index?uuid=${tag}${i}` }));
const docs = n => [1, 2, 3].map(i => ({ title: `示例发文 ${n}${i}`, url: `http://w3.corp.example/info/cn/doc/viewDoc.do?did=${n}${i}&cata=9`, deptname: '示例/部门', publishdate: '2026-11-12 10:00:00' }));
function oldBrowser(log = [], mode = 'ok') {
  return {
    capture: async args => {
      log.push(args.base);
      if (mode === 'login') return { finalUrl: 'https://login.corp.example/x', text: '账号登录', textLength: 4, needsLogin: true, json: [] };
      const json = /w3\./.test(args.base) ? [{ url: args.base + '/service/rest/info/common/docs', json: { policy: [{ documents: docs(1) }], corporate: [{ documents: docs(2) }], bulletins: [{ documents: docs(3) }] } }]
        : /jx\./.test(args.base) ? [{ url: args.base + '/jxService/v1/jxhome/homeHotResources', json: { result: { dataList: three('a').map(p => ({ resourceId: p.postId, title: p.title })) } } }]
          : [{ url: args.base + '/xsrecommend/user/v1/cards/recommends/home/right', json: { data: [{ cardType: 'HOT_LIST', title: '24小时点击排行', list: three('b') }, { cardType: 'HOT_LIST', title: '24小时回复排行', list: three('c') }] } }];
      return { finalUrl: args.base + '/', text: '正常内容 '.repeat(30), textLength: 150, needsLogin: false, json, sections: [], links: [] };
    },
  };
}
function forum(t, deps) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcf-forum-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const f = new CompanyForum({ dataDir, accountEmail: () => 'user@corp.example', noTimer: true, noCollect: true, env: {}, ...deps });
  f.setSettings({ summarize: 0 });
  return f;
}
const content = snap => snap.sites.map(s => ({ id: s.id, ok: s.ok, needsLogin: s.needsLogin, lists: s.lists.map(l => [l.key, l.posts.map(p => [p.title, p.url])]) }));
function fakeWeclaw({ installed = true, online = true, page = null, delayMs = 0 } = {}) {
  const calls = [];
  const wf = new WeclawFetch({ installed: () => installed, budgetMs: 400,
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url.endsWith('/v1/health')) return { ok: true, text: async () => JSON.stringify(online ? { status: 'ok', userId: 'u' } : { status: 'down' }) };
      const b = JSON.parse(opts.body);
      if (delayMs) await new Promise((res, rej) => { const tm = setTimeout(res, delayMs); opts.signal.addEventListener('abort', () => { clearTimeout(tm); const e = new Error('a'); e.name = 'AbortError'; rej(e); }); });
      return { ok: true, text: async () => JSON.stringify(page ? page(b) : { ok: false, code: 'EXTRACT_FAILED', message: 'empty' }) };
    } });
  return { wf, calls };
}

test('没装员工助手：帖子结果与不接员工助手时完全一样，且不发请求', async t => {
  const base = await forum(t, { browser: oldBrowser() }).sync();
  const { wf, calls } = fakeWeclaw({ installed: false });
  const withWf = await forum(t, { browser: oldBrowser(), weclaw: wf }).sync();
  assert.deepEqual(content(withWf), content(base));
  assert.equal(calls.length, 0);
  assert.ok(withWf.sites.every(s => !s.weclawHint));
});

test('员工助手在线：心声走员工助手，稼先和公司发文仍走原通道；结果一样完整', async t => {
  const log = [];
  const { wf } = fakeWeclaw({ page: b => /xinsheng/.test(b.url) ? { ok: true, content: xsHtml(), finalUrl: XS + '/next/index/#/home', title: '心声' } : { ok: false, code: 'EXTRACT_FAILED' } });
  const snap = await forum(t, { browser: oldBrowser(log), weclaw: wf }).sync();
  const xs = snap.sites.find(s => s.id === 'xinsheng');
  assert.equal(xs.via, 'weclaw');
  assert.deepEqual(xs.lists.map(l => l.posts.length), [10, 10]);
  assert.ok(!log.some(b => /xinsheng/.test(b)), '心声不再开浏览器');
  assert.ok(snap.sites.filter(s => s.id !== 'xinsheng').every(s => s.ok && s.via !== 'weclaw'));
});

test('在线但取数失败 / 解析不出 / 太慢：回到原通道，结果与原来一样', async t => {
  const base = content(await forum(t, { browser: oldBrowser() }).sync());
  for (const opts of [
    { page: () => ({ ok: false, code: 'EXTRACT_FAILED', message: 'empty' }) },
    { page: () => ({ ok: true, content: '<html><body>改版了，没有排行</body></html>', finalUrl: XS + '/', title: '' }) },
    { page: () => ({ ok: true, content: xsHtml(2), finalUrl: XS + '/next/index/#/home', title: '' }) }, // 每榜只有 2 条：不完整，不用
    { page: () => ({ ok: true, content: '<html>账号登录</html>', finalUrl: 'https://login.corp.example/login1/', title: '登录' }) },
    { delayMs: 2000, page: () => ({ ok: true, content: xsHtml(), finalUrl: XS + '/', title: '' }) },
  ]) {
    const { wf } = fakeWeclaw(opts);
    const t0 = Date.now();
    const snap = await forum(t, { browser: oldBrowser(), weclaw: wf }).sync();
    assert.deepEqual(content(snap), base);
    assert.ok(Date.now() - t0 < 1500, '员工助手这一步受预算约束，不拖住原通道');
  }
});

test('原通道卡在登录：装了员工助手才提示「打开员工助手」，没装的不提', async t => {
  const { wf } = fakeWeclaw({ online: false });
  const snap = await forum(t, { browser: oldBrowser([], 'login'), weclaw: wf }).sync();
  assert.ok(snap.sites.filter(s => s.needsLogin).length > 0);
  assert.ok(snap.sites.filter(s => s.needsLogin).every(s => s.weclawHint === 'open'));
  const { wf: none } = fakeWeclaw({ installed: false });
  const snap2 = await forum(t, { browser: oldBrowser([], 'login'), weclaw: none }).sync();
  assert.ok(snap2.sites.every(s => !s.weclawHint));
  const ok = await forum(t, { browser: oldBrowser(), weclaw: fakeWeclaw({ online: false }).wf }).sync();
  assert.ok(ok.sites.every(s => !s.weclawHint), '原路径好用的人看不到提示');
});

test('原通道失败时公司发文由员工助手兜底（只有标题和链接）', async t => {
  const W3 = 'https://w3.corp.example';
  const w3Html = ['政策•讲话', '公司文件', '\u534e\u4e3a公告'].map((h, k) => `<div class="title">${h}</div><ul>`
    + [1, 2].map(i => `<li><a href="${W3}/info/cn/doc/viewDoc.do?did=${k}${i}&amp;cata=9" title="示例发文标题 ${k}${i}"><span>示例发文标题 ${k}${i}</span></a></li>`).join('') + '</ul>').join('');
  const { wf } = fakeWeclaw({ page: b => /w3\./.test(b.url) ? { ok: true, content: `<html>${w3Html}</html>`, finalUrl: W3 + '/next/indexa.html', title: 'w3' } : { ok: false, code: 'EXTRACT_FAILED' } });
  const snap = await forum(t, { browser: oldBrowser([], 'login'), weclaw: wf }).sync();
  const w3 = snap.sites.find(s => s.id === 'w3');
  assert.equal(w3.ok, true);
  assert.equal(w3.via, 'weclaw');
  assert.deepEqual(w3.lists.map(l => l.posts.length), [2, 2, 2]);
});

test('熔断后帖子只走原通道，不再请求员工助手', async t => {
  const { wf, calls } = fakeWeclaw({ page: () => ({ ok: false, code: 'EXTRACT_FAILED' }) });
  await forum(t, { browser: oldBrowser(), weclaw: wf }).sync();
  await forum(t, { browser: oldBrowser(), weclaw: wf }).sync();
  const n = calls.filter(u => u.includes('fetchWebPageContent')).length;
  await forum(t, { browser: oldBrowser(), weclaw: wf }).sync();
  assert.equal(calls.filter(u => u.includes('fetchWebPageContent')).length, n, '熔断期间不再请求');
  assert.ok(wf.status().features.forum.pausedUntil > 0);
});

// ---------------------------------------------------------------- 考勤
const card = (d, a, b) => ({ attendanceDate: d, earlyClockInTime: a, lateClockInTime: b });
function attendance(t, { hub, weclaw }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcf-att-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new CompanyAttendance({ dataDir, noTimer: true, now: () => new Date('2026-11-27T09:00:00'), accountEmail: () => 'u@corp.example',
    browser: { capture: async r => hub(r), login: async () => ({ ok: true }) }, edgeCapture: null, ...(weclaw ? { weclaw } : {}) });
}
const okHub = async () => ({ json: [{ url: 'https://x/attendanceCompanion/card/queryCardRecord', json: [card('2026-11-26', '08:50', '20:10')] }] });
const loginHub = async () => ({ needsLogin: true, finalUrl: 'https://login.corp.example/', json: [] });

test('考勤：打卡记录仍走原通道；员工助手在线时顺带记下首页摘要', async t => {
  const { wf } = fakeWeclaw({ page: () => ({ ok: true, content: '待处理考勤异常 2 2026年11月考勤数据处理将于北京时间2026年12月4日23:59截止，请您', finalUrl: 'https://hr.corp.example/apps/attendanceflow/#/myAttendance', title: '考勤' }) });
  const svc = attendance(t, { hub: okHub, weclaw: wf });
  const r = await svc.sync();
  assert.equal(r.ok, true);
  assert.equal(r.via, 'hub');
  await svc.summaryPending; // 摘要不拖住同步，之后单独补写
  const st = svc.status();
  assert.equal(st.records.length, 1);
  assert.equal(st.weclawSummary.anomalies, 2);
  assert.match(st.weclawSummary.deadline, /12月4日/);
});

test('考勤：没装员工助手时结果与原来一致、不发请求、没有提示', async t => {
  const plain = await attendance(t, { hub: loginHub }).sync();
  const { wf, calls } = fakeWeclaw({ installed: false });
  const withWf = await attendance(t, { hub: loginHub, weclaw: wf }).sync();
  const strip = e => ({ ok: e.ok, needsLogin: e.needsLogin, error: e.error });
  assert.deepEqual(strip(withWf), strip(plain));
  assert.equal(calls.length, 0);
  assert.equal(withWf.weclawHint, undefined);
});

test('考勤：原通道要登录、装了员工助手但没开 → 提示打开员工助手；员工助手摘要认不出也不影响记录', async t => {
  const { wf } = fakeWeclaw({ online: false });
  const r = await attendance(t, { hub: loginHub, weclaw: wf }).sync();
  assert.equal(r.needsLogin, true);
  assert.equal(r.weclawHint, 'open');
  const { wf: bad } = fakeWeclaw({ page: () => ({ ok: true, content: '改版了', finalUrl: '', title: '' }) });
  const svc = attendance(t, { hub: okHub, weclaw: bad });
  assert.equal((await svc.sync()).ok, true);
  await svc.summaryPending;
  assert.equal(svc.status().weclawSummary, null);
});

// ---------------------------------------------------------------- WeLink 命令行续期
function keeper(weclaw, { loginWorks = true } = {}) {
  const calls = { login: 0, status: 0 };
  let store = {}, renewed = false;
  const a = {
    read: (_n, d) => store.auth || d, write: (_n, v) => { store.auth = v; }, changed() {}, now: () => 9_000_000,
    publish: () => true, loginFlow: null, refresh: async () => ({}), accountMismatch: () => null,
    ...(weclaw === undefined ? {} : { weclaw }),
    rawWelink: async args => {
      if (args[1] === 'login') { calls.login += 1; return { code: 0, stdout: 'Please scan the QR code', stderr: '' }; }
      calls.status += 1;
      return renewed ? { code: 0, stdout: 'UID: u1\nUser Token: VALID (expires in 20h)', stderr: '' } : { code: 0, stdout: 'UID: u1\nUser Token: EXPIRED', stderr: '' };
    },
  };
  if (weclaw && loginWorks) { const orig = weclaw.welinkLogin.bind(weclaw); weclaw.welinkLogin = async () => { const r = await orig(); if (r.ok) renewed = true; return r; }; }
  return { k: new AuthKeeper(a), calls };
}

test('WeLink 续期：员工助手在线时先代办免密登录，续上就不跑扫码登录', async t => {
  const a = await fakeAgent(t);
  const wf = new WeclawFetch({ installed: () => true, bases: [a.base] });
  const { k, calls } = keeper(wf);
  const st = await k.check({ force: true, refresh: false });
  assert.equal(st.state, 'online');
  assert.equal(st.renewedVia, 'weclaw');
  assert.equal(calls.login, 0, '没出二维码');
  assert.ok(a.log.includes('GET /v1/welinkcli/login'));
});

test('WeLink 续期：没挂员工助手 / 没装 / 代办失败 → 和原来一样走 auth login', async t => {
  for (const wf of [undefined, null, new WeclawFetch({ installed: () => false })]) {
    const { k, calls } = keeper(wf);
    await k.check({ force: true, refresh: false });
    assert.equal(calls.login, 1);
  }
  const a = await fakeAgent(t, { login: { ok: false, status: 'failed', reason: 'identification_unavailable' } });
  const failing = new WeclawFetch({ installed: () => true, bases: [a.base] });
  const { k, calls } = keeper(failing, { loginWorks: false });
  await k.check({ force: true, refresh: false });
  assert.equal(calls.login, 1, '代办没成功就照原样续期');
});

test('同时来的几个调用共用一次自检', async () => {
  let health = 0;
  const wf = new WeclawFetch({ installed: () => true, fetchImpl: async url => { if (url.endsWith('/v1/health')) { health += 1; await new Promise(r => setTimeout(r, 50)); } return { ok: true, text: async () => JSON.stringify({ status: 'ok', userId: 'u' }) }; } });
  const rs = await Promise.all([wf.online(), wf.usable('forum'), wf.usable('attendance')]);
  assert.deepEqual(rs, [true, true, true]);
  assert.equal(health, 1);
});

test('自检加取数整条路径不超过总预算', async () => {
  const hang = (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); }));
  const wf = new WeclawFetch({ installed: () => true, budgetMs: 1500, healthTimeoutMs: 500,
    fetchImpl: async (url, { signal }) => { if (url.endsWith('/v1/health')) { await new Promise(r => setTimeout(r, 450)); return { ok: true, text: async () => JSON.stringify({ status: 'ok', userId: 'u' }) }; } return hang(signal); } });
  const t0 = Date.now();
  assert.equal(await wf.usable('forum'), true);
  const r = await wf.fetchPage('https://site.example/x');
  assert.equal(r.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 <= 1500 + 150, `用时 ${Date.now() - t0} ms`);
});

test('WeLink 续期：等员工助手时本人点了退出，回来不再跑 auth login', async t => {
  const a = await fakeAgent(t, { login: { ok: false, status: 'failed' } });
  const wf = new WeclawFetch({ installed: () => true, bases: [a.base] });
  const { k, calls } = keeper(wf, { loginWorks: false });
  const orig = wf.welinkLogin.bind(wf);
  wf.welinkLogin = async () => { const r = await orig(); k.signedOut(); return r; };
  await k.check({ force: true, refresh: false });
  assert.equal(calls.login, 0);
  assert.equal(k.status().state, 'signed-out');
});
