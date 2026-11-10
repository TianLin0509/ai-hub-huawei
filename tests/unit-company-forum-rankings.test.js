'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { siteById } = require('../core/company-forum/sites');
const { postsForSite } = require('../core/company-forum/extract');

const site = siteById('xinsheng');
const base = 'https://xinsheng.corp.example';
const posts = (prefix, n = 3) => Array.from({ length: n }, (_, i) => ({
  postId: `${prefix}${i + 1}`, title: `${prefix}榜单里的帖子标题${i + 1}`,
  link: `/next/detail/#/index?uuid=${prefix}${i + 1}`,
}));
const card = (heading, items) => ({ title: heading, cardType: 'HOT_LIST', list: items });
const capture = cards => ({ finalUrl: base + '/next/index/#/home', sections: [], json: [{
  url: base + '/xsrecommend/user/v1/cards/recommends/home/right', json: { data: cards },
}] });
const ids = list => list.posts.map(p => p.id);

test('准确命名的 API 排行优先于包含两张榜单的 DOM 祖先', () => {
  const click = posts('click'), reply = posts('reply');
  const cap = capture([card('24小时点击排行', click), card('24小时回复排行', reply)]);
  const links = [...click, ...reply].map(p => ({ href: base + p.link, text: p.title }));
  cap.sections = site.lists.map(l => ({ heading: l.heading, found: true, links }));
  const lists = postsForSite(site, cap, { base });
  assert.deepEqual(ids(lists[0]), ['click1', 'click2', 'click3']);
  assert.deepEqual(ids(lists[1]), ['reply1', 'reply2', 'reply3']);
});

test('共享接口缺少回复卡片时，不拿点击卡片冒充回复榜', () => {
  const lists = postsForSite(site, capture([card('24小时点击排行', posts('click'))]), { base });
  assert.deepEqual(ids(lists[0]), ['click1', 'click2', 'click3']);
  assert.deepEqual(ids(lists[1]), []);
});

test('专用点击接口不能被回复榜当作兜底来源', () => {
  const lists = postsForSite(site, { json: [{ url: base + '/xsapi/v1/topic/clickRank', json: { data: posts('click') } }] }, { base });
  assert.deepEqual(ids(lists[0]), ['click1', 'click2', 'click3']);
  assert.deepEqual(ids(lists[1]), []);
});

test('普通帖子标题提及榜名时，不当成空卡片覆盖真正的榜单', () => {
  const cap = capture([card('24小时回复排行', posts('reply'))]);
  cap.json.push({ url: base + '/xsapi/user/posts/other1', json: {
    postId: 'other1', title: '24小时回复排行为何不更新', link: '/next/detail/#/index?uuid=other1',
  } });
  assert.deepEqual(ids(postsForSite(site, cap, { base })[1]), ['reply1', 'reply2', 'reply3']);
});

test('普通帖子标题提及榜名且带作者数组时，不把作者当成榜单覆盖真实回复卡片', () => {
  const cap = capture([card('24小时回复排行', posts('reply'))]);
  cap.json.push({ url: base + '/xsapi/user/posts/other1', json: {
    postId: 'other1', title: '24小时回复排行为什么不更新', link: '/next/detail/#/index?uuid=other1',
    submitUsers: [{ id: 'user1', name: '一位发帖作者' }],
  } });
  assert.deepEqual(ids(postsForSite(site, cap, { base })[1]), ['reply1', 'reply2', 'reply3']);
});

test('明确带 postId 的普通帖子即使有空 list，也不能冒充空榜覆盖真实卡片', () => {
  const cap = capture([card('24小时回复排行', posts('reply'))]);
  cap.json.push({ url: base + '/xsapi/user/posts/other1', json: {
    postId: 'other1', title: '24小时回复排行为什么不更新', link: '/next/detail/#/index?uuid=other1', list: [],
  } });
  assert.deepEqual(ids(postsForSite(site, cap, { base })[1]), ['reply1', 'reply2', 'reply3']);
});

test('排行卡片的 list 混有 id/name 辅助对象时，只返回真实帖子', () => {
  const cap = capture([card('24小时回复排行', [posts('reply', 1)[0], { id: 'more', name: '查看全部热帖' }])]);
  const [, reply] = postsForSite(site, cap, { base });
  assert.deepEqual(ids(reply), ['reply1']);
  assert.equal(reply.posts[0].url, base + '/next/detail/#/index?uuid=reply1');
});

test('排行卡片有空 list 和非帖子 tabs 时，保留空榜，不拿辅助对象补齐', () => {
  const cap = capture([{ title: '24小时回复排行', cardType: 'HOT_LIST',
    tabs: [{ id: 'more', name: '查看全部热帖' }], list: [],
  }]);
  const [, reply] = postsForSite(site, cap, { base });
  assert.deepEqual(ids(reply), []);
  assert.equal(reply.from, 'api-card');
});

test('排行标题带装饰和空格时，仍按榜名识别并保留低条数顺序', () => {
  const cap = capture([card('【24 小时回复排行】 TOP 10', posts('reply', 2))]);
  const [, reply] = postsForSite(site, cap, { base });
  assert.deepEqual(ids(reply), ['reply1', 'reply2']);
  assert.equal(reply.from, 'api-card');
});

for (const n of [0, 1, 2]) {
  test(`回复卡片确有 ${n} 条帖子时，保留真实数量和顺序`, () => {
    const lists = postsForSite(site, capture([card('24小时点击排行', posts('click')), card('24小时回复排行', posts('reply', n))]), { base });
    assert.deepEqual(ids(lists[1]), posts('reply', n).map(p => p.postId));
    assert.equal(lists[1].from, 'api-card');
  });
}

test('单榜站点（稼先）：热帖标题带「热点」、下面挂着带编号的发帖人时，不把发帖人当成热榜', () => {
  const jx = siteById('jx'), jxBase = 'https://jx.corp.example';
  const hot = [
    { resourceId: '101', title: '本周热点：基站功耗讨论', browseCount: 4432, submitUsers: [{ id: 'u1', name: '张三 z00123456' }] },
    { resourceId: '102', title: '大模型落地研发流程的三点体会', browseCount: 900 },
    { resourceId: '103', title: '新员工入职第一年的成长复盘', browseCount: 800 },
  ];
  const cap = { finalUrl: jxBase + '/', sections: [{ heading: '热点', found: true, links: [] }], links: [], json: [{
    url: jxBase + '/jxService/v1/jxhome/homeHotResources?type=hotRecommend_1Week', json: { status: 'ok', result: { dataList: hot } },
  }] };
  const [list] = postsForSite(jx, cap, { base: jxBase });
  assert.deepEqual(ids(list), ['101', '102', '103']);
  assert.equal(list.from, 'api');
});

test('首页没有 24 小时榜时，用热门卡片兜底并按卡片名显示，不用最新卡片', () => {
  const { SITES } = require('../core/company-forum/sites');
  const { postsForSite } = require('../core/company-forum/extract');
  const site = SITES.find(s => s.id === 'xinsheng');
  const list = prefix => Array.from({ length: 10 }, (_, i) => ({ postId: `${prefix}${i + 100}`, title: `${prefix}帖子标题 ${i + 1}`, link: `/next/detail/#/index?uuid=${prefix}${i + 100}&uniqueType=homeRanking` }));
  const capture = { finalUrl: 'https://xinsheng.corp.example/next/index/#/home', links: [], sections: site.lists.map(l => ({ heading: l.heading, found: false, links: [], lines: [] })),
    json: [{ url: 'https://xinsheng.corp.example/xsrecommend/user/v1/cards/recommends/home/right', json: { status: 200, data: [
      { id: '1', cardType: 'HOT_LIST', title: '公司人最新文章', list: list('new') }, { id: '2', cardType: 'HOT_LIST', title: '公司人热门文章', list: list('hot') }] } }] };
  const lists = postsForSite(site, capture, { base: 'https://xinsheng.corp.example', limit: 20 });
  assert.equal(lists.length, 1);
  assert.equal(lists[0].label, '公司人热门文章');
  assert.equal(lists[0].posts.length, 10);
  assert.match(lists[0].posts[0].title, /^hot/);
  assert.match(lists[0].posts[0].url, /^https:\/\/xinsheng\.corp\.example\/next\/detail/);
});

test('热门兜底跳过标题属于回复榜的卡片，继续查找普通热门卡片', () => {
  const lists = postsForSite(site, capture([
    card('【24 小时回复排行】（热门讨论）', posts('reply')),
    card('公司人热门文章', posts('hot')),
  ]), { base });
  assert.deepEqual(ids(lists[0]), ['hot1', 'hot2', 'hot3']);
  assert.deepEqual(ids(lists[1]), ['reply1', 'reply2', 'reply3']);
});

test('只有带热门字样的回复卡片时，不复制到点击榜', () => {
  const lists = postsForSite(site, capture([card('24小时回复排行（热门讨论）', posts('reply'))]), { base });
  assert.deepEqual(ids(lists[0]), []);
  assert.deepEqual(ids(lists[1]), ['reply1', 'reply2', 'reply3']);
});

for (const reverse of [false, true]) {
  test(`热门兜底不重复专用回复接口已选中的同组帖子，逆序=${reverse}`, () => {
    const hot = posts('hot');
    const cap = capture([card('公司人热门文章', hot)]);
    cap.json.push({ url: base + '/xsapi/user/replyRank', json: {
      data: [{ items: reverse ? [...hot].reverse() : hot }, { items: posts('realReply') }],
    } });
    const lists = postsForSite(site, cap, { base });
    assert.deepEqual(ids(lists[0]), []);
    assert.deepEqual(ids(lists[1]), reverse ? ['hot3', 'hot2', 'hot1'] : ['hot1', 'hot2', 'hot3']);
  });
}

test('热门兜底被同组帖子挡住后，可以继续用下一张不同的热门卡片', () => {
  const cap = capture([card('公司人热门文章', posts('reply')), card('其他热门文章', posts('hot'))]);
  cap.json.push({ url: base + '/xsapi/user/replyRank', json: { data: posts('reply') } });
  const lists = postsForSite(site, cap, { base });
  assert.deepEqual(ids(lists[0]), ['hot1', 'hot2', 'hot3']);
  assert.deepEqual(ids(lists[1]), ['reply1', 'reply2', 'reply3']);
});

for (const n of [1, 2]) {
  test(`点击榜已有 ${n} 条真实链接时保留，不被热门卡片覆盖`, () => {
    const cap = capture([card('公司人热门文章', posts('hot'))]);
    cap.sections = [{ heading: '24小时点击排行', links: posts('click', n).map(p => ({ href: p.link, text: p.title })) }];
    assert.deepEqual(ids(postsForSite(site, cap, { base })[0]), n === 1 ? ['click1'] : ['click1', 'click2']);
  });
}

test('本榜专用点击接口优先于热门兜底', () => {
  const cap = capture([card('公司人热门文章', posts('hot'))]);
  cap.json.push({ url: base + '/xsapi/user/clickRank', json: { data: posts('click') } });
  assert.deepEqual(ids(postsForSite(site, cap, { base })[0]), ['click1', 'click2', 'click3']);
});

test('本榜板块文字优先于热门兜底', () => {
  const cap = capture([card('公司人热门文章', posts('hot'))]);
  cap.sections = [{ heading: '24小时点击排行', links: [], lines: posts('click').map(p => p.title) }];
  assert.deepEqual(postsForSite(site, cap, { base })[0].posts.map(p => p.title), [
    'click榜单里的帖子标题1', 'click榜单里的帖子标题2', 'click榜单里的帖子标题3',
  ]);
});

test('热门兜底混有 id/name 辅助对象时，只认有真实标题字段的帖子', () => {
  const cap = capture([card('公司人热门文章', [
    { id: 'more', name: '查看全部热帖' }, posts('hot', 1)[0],
  ])]);
  assert.deepEqual(ids(postsForSite(site, cap, { base })[0]), ['hot1']);
});

test('热门卡片只有辅助对象时，保留空榜', () => {
  const cap = capture([card('公司人热门文章', [{ id: 'more', name: '查看全部热帖' }])]);
  assert.deepEqual(postsForSite(site, cap, { base }).map(ids), [[], []]);
});

test('没有热门兜底时，少量 DOM 链接仍按原顺序由本榜专用接口补全', () => {
  const cap = capture([]);
  cap.sections = [{ heading: '24小时点击排行', links: posts('partial', 1).map(p => ({ href: p.link, text: p.title })) }];
  cap.json.push({ url: base + '/xsapi/user/clickRank', json: { data: posts('click') } });
  assert.deepEqual(ids(postsForSite(site, cap, { base })[0]), ['click1', 'click2', 'click3']);
});

for (const mode of ['id-and-link', 'id-only', 'url-only', 'mixed', 'different-ids']) {
  test(`同组帖子跨 id/URL 字段时挡住热门兜底，表示=${mode}`, () => {
    let hot = posts('hot');
    let reply = hot.map(p => ({ title: p.title + '（回复榜显示）', url: p.link }));
    if (mode === 'id-only') hot = hot.map(({ postId, title }) => ({ postId, title }));
    if (mode === 'url-only') {
      reply = hot.map(({ postId, title }) => ({ postId, title: title + '（回复榜显示）' }));
      hot = hot.map(p => ({ title: p.title, url: p.link }));
    }
    if (mode === 'mixed') hot = [
      { postId: hot[0].postId, title: hot[0].title },
      { url: hot[1].link, title: hot[1].title },
      hot[2],
    ];
    if (mode === 'different-ids') reply = reply.map((p, i) => ({ ...p, postId: `display${i}` }));
    const lists = postsForSite(site, capture([
      card('公司人热门文章', hot), card('24小时回复排行', reply.reverse()),
    ]), { base });
    assert.deepEqual(ids(lists[0]), []);
    assert.equal(lists[1].posts.length, 3);
  });
}

test('跨身份字段只部分重合时仍保留两个榜', () => {
  const hot = posts('hot');
  const reply = [hot[0], hot[1], posts('reply')[0]].map(p => ({ title: p.title + '（回复榜显示）', url: p.link }));
  const lists = postsForSite(site, capture([
    card('公司人热门文章', hot), card('24小时回复排行', reply),
  ]), { base });
  assert.deepEqual(lists.map(l => l.posts.length), [3, 3]);
});
