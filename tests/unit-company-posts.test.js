'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CompanyForum } = require('../core/company-forum/service');
const S = require('../core/company-forum/sites');
const X = require('../core/company-forum/extract');

const W3 = 'https://w3.corp.example';
const doc = (did, title, extra = {}) => ({ title, url: `http://w3.corp.example/info/cn/doc/viewDoc.do?did=${did}&cata=9`, code: '', deptname: '示例技术/示例部门', publishdate: '2026-11-12 10:00:00', docAbstract: '', ...extra });
const docsJson = (policy, corporate = [], bulletins = []) => ({ policy: [{ documents: policy }], corporate: [{ documents: corporate }], bulletins: [{ documents: bulletins }], xinsheng: [{ documents: [doc(900, '转到社区的一栏不收')] }] });
const landed = args => { try { return new URL(args.url).searchParams.get('redirect') || args.url; } catch { return args.url; } };
// 假浏览器：发文站返回 docs 接口，另外两站各返回一个三条帖子的排行。
const three = tag => [1, 2, 3].map(i => ({ postId: `${tag}${i}`, title: `示例热帖 ${tag} 第 ${i} 条`, link: `/next/detail/#/index?uuid=${tag}${i}` }));
function fakeBrowser(getDocs, log = []) {
  return {
    capture: async args => {
      log.push(args.url);
      const json = args.base === W3 ? [{ url: W3 + '/service/rest/info/common/docs?lan=cn', status: 200, json: getDocs() }]
        : /jx\./.test(args.base) ? [{ url: args.base + '/jxService/v1/jxhome/homeHotResources', status: 200, json: { result: { dataList: three('a').map(p => ({ resourceId: p.postId, title: p.title })) } } }]
          : [{ url: args.base + '/xsrecommend/user/v1/cards/recommends/home/right', status: 200, json: { data: [{ cardType: 'HOT_LIST', title: '24小时点击排行', list: three('b') }, { cardType: 'HOT_LIST', title: '24小时回复排行', list: three('c') }] } }];
      return { finalUrl: landed(args), text: '正常内容 '.repeat(30), textLength: 150, needsLogin: false, json, sections: [], links: [] };
    },
  };
}
function service(t, deps) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posts-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const forum = new CompanyForum({ dataDir, accountEmail: () => 'user@corp.example', noTimer: true, noCollect: true, env: {}, ...deps });
  forum.setSettings({ summarize: 0 });
  return forum;
}
const w3Of = snap => snap.sites.find(s => s.id === 'w3');

test('公司发文：按栏目取，带文号、部门、摘要，链接改成 https，不收转到社区的栏目', () => {
  const site = S.siteById('w3');
  const cap = { finalUrl: W3 + '/next/indexa.html', json: [{ url: W3 + '/service/rest/info/common/docs?lan=cn&version=1', json: docsJson(
    [doc(101, '关于示例工作的讲话', { code: '电邮讲话【2026】001号', deptname: '示例技术/总裁办', docAbstract: '一、示例要点' }), doc(101, '关于示例工作的讲话')],
    [doc(201, '任免通知（示例）', { code: '示例任命【2026】1号' })], [doc(301, '示例变更公告')]) }] };
  const lists = X.postsForSite(site, cap, { base: W3 });
  assert.deepEqual(lists.map(l => [l.key, l.label, l.posts.length]), [['policy', '政策讲话', 1], ['corporate', '公司文件', 1], ['bulletins', '公告', 1]]);
  const p = lists[0].posts[0];
  assert.equal(p.id, '101');
  assert.equal(p.url, W3 + '/info/cn/doc/viewDoc.do?did=101&cata=9');
  assert.deepEqual([p.code, p.board, p.abstract, p.rank], ['电邮讲话【2026】001号', '总裁办', '一、示例要点', 1]);
  assert.ok(p.time > 0);
});

test('公司发文：接口没截到时退到页面板块里的链接', () => {
  const site = S.siteById('w3');
  const links = [1, 2, 3].map(i => ({ href: `${W3}/info/cn/doc/viewDoc.do?did=40${i}&cata=9`, text: `示例公司文件第 ${i} 号` }));
  const lists = X.postsForSite(site, { finalUrl: W3 + '/next/indexa.html', json: [], links, sections: [{ heading: '公司文件', links, lines: [] }] }, { base: W3 });
  assert.deepEqual(lists.find(l => l.key === 'corporate').posts.map(p => p.id), ['401', '402', '403']);
});

test('进站先过统一登录入口；测试假站点直接开首页', () => {
  const site = S.siteById('xinsheng'), base = 'https://xinsheng.corp.example';
  assert.equal(S.entryUrl(site, base, 'corp.example', {}), 'https://login.corp.example/login1/?redirect=' + encodeURIComponent(base + '/next/index/#/home'));
  assert.equal(S.entryUrl(site, 'http://127.0.0.1:9', 'corp.example', { CLAUDE_HUB_FORUM_SITES: '{}', CLAUDE_HUB_DATA_DIR: 'x' }), 'http://127.0.0.1:9/next/index/#/home');
});

test('通道：先走 Edge 登录状态，通了就记住', async t => {
  const edgeLog = [], hubLog = [];
  const forum = service(t, { edgeBrowser: fakeBrowser(() => docsJson([doc(1, '示例讲话一')]), edgeLog), browser: fakeBrowser(() => docsJson([]), hubLog) });
  const snap = await forum.sync();
  assert.equal(edgeLog.length, S.SITES.length);
  assert.equal(hubLog.length, 0);
  assert.ok(edgeLog.every(u => u.startsWith('https://login.corp.example/login1/?redirect=')));
  assert.equal(w3Of(snap).via, 'edge');
  assert.equal(forum.status().route, 'edge');
});

test('通道：Edge 停在登录页或报错时改走 Hub 窗口，下次先走 Hub 窗口', async t => {
  let edgeCalls = 0, mode = 'login';
  const edgeBrowser = { capture: async args => { edgeCalls += 1; if (mode === 'throw') throw new Error('本机没有找到 Edge'); return { finalUrl: args.url, text: '账号登录', textLength: 4, needsLogin: true, json: [] }; } };
  const forum = service(t, { edgeBrowser, browser: fakeBrowser(() => docsJson([doc(1, '示例讲话一')])) });
  let snap = await forum.sync();
  assert.equal(w3Of(snap).ok, true);
  assert.equal(w3Of(snap).via, 'hub');
  assert.equal(forum.status().route, 'hub');
  assert.equal(edgeCalls, 1, '第一站试过 Edge 后，后面的站直接走记住的 Hub 窗口');
  forum.saveState({ route: '' }); mode = 'throw';
  snap = await forum.sync();
  assert.equal(w3Of(snap).via, 'hub');
});

test('通道：两条都停在登录页才提示登录', async t => {
  const login = async args => ({ finalUrl: args.url, text: '账号登录', textLength: 4, needsLogin: true, json: [] });
  const forum = service(t, { edgeBrowser: { capture: login }, browser: { capture: login } });
  const snap = await forum.sync();
  assert.ok(snap.sites.every(s => s.needsLogin && /没能自动登录/.test(s.error)));
});

test('发文上新：第一次只打底不提醒；之后新出现的才提醒并带「新」标，重看不动同步时间和 AI 看点', async t => {
  let docs = [doc(1, '示例讲话一'), doc(2, '示例讲话二')], now = Date.parse('2026-11-12T09:00:00+08:00');
  const notices = [], log = [];
  const forum = service(t, { browser: fakeBrowser(() => docsJson(docs), log), publish: n => notices.push(n), now: () => now });
  const first = await forum.sync();
  assert.equal(notices.length, 0);
  assert.ok(w3Of(first).lists[0].posts.every(p => !p.firstSeen));
  // 当天快照上已有 AI 看点和一句话摘要
  const seeded = forum.snapshot();
  seeded.overview = [{ text: '示例看点', refs: [] }]; seeded.summaryAt = now; w3Of(seeded).lists[0].posts[0].summary = '示例摘要';
  forum.write(`forum-${seeded.day}.json`, seeded);

  now += 3600000; docs = [doc(3, '示例讲话三（新）'), ...docs]; log.length = 0;
  const second = await forum.sync({ sites: ['w3'], reason: 'docs' });
  assert.equal(log.length, 1, '只重看发文一站');
  assert.equal(second.at, first.at);
  assert.equal(second.attempts, first.attempts);
  assert.deepEqual(second.overview, seeded.overview);
  assert.equal(second.summaryAt, seeded.summaryAt);
  const posts = w3Of(second).lists[0].posts;
  assert.deepEqual(posts.map(p => [p.id, !!p.firstSeen]), [['3', true], ['1', false], ['2', false]]);
  assert.equal(posts[1].summary, '示例摘要');
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0].kind, notices[0].page, notices[0].title], ['docs', 'forum', '公司发文上新 1 条']);
  assert.match(notices[0].text, /政策讲话.*示例讲话三/);

  now += 3600000;
  await forum.sync({ sites: ['w3'], reason: 'docs' });
  assert.equal(notices.length, 1, '没有新的不重复提醒');
  forum.setSettings({ docsNotify: false }); docs = [doc(4, '示例讲话四'), ...docs];
  await forum.sync({ sites: ['w3'], reason: 'docs' });
  assert.equal(notices.length, 1, '关掉提醒后不发');
});

test('定时：当天同步过之后，隔 docsEveryMin 分钟只重看发文；设 0 不重看', async t => {
  let now = new Date(2026, 10, 12, 9, 0).getTime();
  const log = [];
  const forum = service(t, { browser: fakeBrowser(() => docsJson([doc(1, '示例讲话一')]), log), now: () => now });
  await forum.tick();
  assert.equal(log.length, S.SITES.length);
  now += 30 * 60000; await forum.tick();
  assert.equal(log.length, S.SITES.length, '没到间隔不看');
  now += 31 * 60000; await forum.tick();
  assert.equal(log.length, S.SITES.length + 1);
  assert.match(log.at(-1), /w3/);
  forum.setSettings({ docsEveryMin: 0 }); now += 120 * 60000; await forum.tick();
  assert.equal(log.length, S.SITES.length + 1);
});
