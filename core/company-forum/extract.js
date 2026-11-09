'use strict';
// 从论坛首页的抓取结果里认出热帖（core/company-forum/sites.js 说明了两个站点）。
// 抓取结果来自 Hub 的隐藏浏览器窗口（main/company-forum-browser.js）：页面取数据时截下来的 JSON 响应，加上页面里的链接和板块文字。
// 认帖子的顺序：（多榜站点）准确命名的 API 卡片 → 对应板块里的帖子链接 →（单榜站点）链接不足 3 条时找卡片 → 归属明确的接口数组 → 板块文字行。
// JSON 补阅读、回复、时间这些数字。字段名以公司真机回执 Q-1018-01 第 2 轮为准（稼先 browseCount / commentCount / favoriteCount /
// upvoteCount / submitUsers / resourceId，心声排行卡片里的 postId / title / link），其余按常见写法多认几种。
// 心声的两个排行在同一个「卡片」接口里：数组的每个元素是一张卡片（有自己的标题和 list），按榜名找卡片，不把卡片当帖子。

const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return undefined;
  const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
  for (const k of keys) { const real = lower.get(k.toLowerCase()); if (real !== undefined && o[real] !== null && o[real] !== '') return o[real]; }
  return undefined;
};
const TITLE = ['title', 'postTitle', 'topicTitle', 'subject', 'resourceName', 'resourceTitle', 'articleTitle', 'headline', 'name'];
const ID = ['postId', 'topicId', 'tid', 'articleId', 'resourceId', 'infoId', 'contentId', 'id', 'uuid'];
const VIEWS = ['browseCount', 'viewCount', 'readCount', 'views', 'readNum', 'clickCount', 'clickNum', 'browseCount', 'visitCount', 'pv', 'hits', 'readTimes'];
const REPLIES = ['replyCount', 'commentCount', 'replyNum', 'commentNum', 'replies', 'comments', 'commentTotal'];
const LIKES = ['upvoteCount', 'likeCount', 'praiseCount', 'likeNum', 'praiseNum', 'likes', 'upCount', 'thumbsUpCount', 'agreeCount'];
const FAVS = ['collectCount', 'favoriteCount', 'favCount', 'collectNum', 'favorites'];
const TIME = ['publishTime', 'createTime', 'postTime', 'releaseTime', 'createdAt', 'gmtCreate', 'createDate', 'publishDate', 'time'];
const AUTHOR = ['authorName', 'submitUsers', 'author', 'userName', 'nickName', 'nickname', 'creatorName', 'createUserName', 'publisher', 'createBy'];
const BOARD = ['boardName', 'forumName', 'sectionName', 'plateName', 'groupName', 'channelName', 'categoryName', 'columnName'];
const URL_KEYS = ['detailUrl', 'url', 'link', 'href', 'jumpUrl', 'linkUrl'];

const clean = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const titleKey = s => clean(s).replace(/[\s，。、！？!?·:：「」“”"'【】[\]()（）-]/g, '').toLowerCase();
// 「1.2万」「3k」「4,432」都认成数字。
function count(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^([\d.,]+)\s*([万wWkK千]?)\+?$/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ 万: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3 }[m[2]] || 1));
}
function timeOf(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(String(v).replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return Number.isFinite(t) ? t : null;
}
const authorOf = v => Array.isArray(v) ? v.map(authorOf).filter(Boolean).slice(0, 3).join('、')
  : typeof v === 'object' && v ? clean(pick(v, ['name', 'userName', 'nickName', 'displayName', 'cnName', 'userNameCn']) || '') : clean(v || '');
// 对象里有没有「至少 3 个对象」的数组：有就是卡片 / 分组这类容器，不是帖子。
const isContainer = o => Object.values(o).some(v => Array.isArray(v) && v.filter(x => x && typeof x === 'object').length >= 3);

// 一个 JSON 对象像不像一条帖子：有像样的标题和编号。
function postFromObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || isContainer(o)) return null;
  const title = clean(pick(o, TITLE));
  if (title.length < 4 || title.length > 200) return null;
  const idRaw = pick(o, ID);
  const id = idRaw === undefined ? '' : String(idRaw);
  const url = pick(o, URL_KEYS);
  if (!id && !url) return null;
  return {
    id, title, url: typeof url === 'string' ? url : '',
    views: count(pick(o, VIEWS)), replies: count(pick(o, REPLIES)), likes: count(pick(o, LIKES)), favs: count(pick(o, FAVS)),
    time: timeOf(pick(o, TIME)), author: authorOf(pick(o, AUTHOR)), board: clean(pick(o, BOARD) || ''),
  };
}
// JSON 里所有「多数元素像帖子」的数组（至少 3 条），按出现顺序。
function postArrays(json, out = [], depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return out;
  if (Array.isArray(json)) {
    const objs = json.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 3) {
      const posts = objs.map(postFromObject);
      const good = posts.filter(Boolean);
      if (good.length >= 3 && good.length / objs.length >= 0.6) { out.push(good); return out; }
    }
    for (const x of json) postArrays(x, out, depth + 1);
    return out;
  }
  for (const v of Object.values(json)) postArrays(v, out, depth + 1);
  return out;
}

// 标题等于（或包含）榜名的卡片里的帖子列表，例如心声的「24小时点击排行」卡片。
const headingKey = s => clean(s).replace(/\s+/g, '');
const LIST_KEY = /^(?:list|posts|items|dataList|postList|resourceList)$/i;
const CARD_POST_TITLE = TITLE.filter(k => k !== 'name');
const POST_ID = ID.filter(k => k !== 'id' && k !== 'uuid');
// min：卡片里至少几条帖子才算数。min 为 1 时，确有空的榜单数组也算（返回 []）。
function namedList(json, heading, min = 1, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return null;
  if (!Array.isArray(json)) {
    const t = headingKey(pick(json, ['title', 'name', 'cardName', 'cardTitle']) || '');
    // postId 等明确属于帖子；卡片自身的通用 id/uuid 不受此限制。
    if (t && (t === headingKey(heading) || t.includes(headingKey(heading))) && (min > 1 || pick(json, POST_ID) === undefined)) {
      let emptyList = false;
      for (const [key, v] of Object.entries(json)) {
        // 低门槛卡片只认榜单字段和帖子标题：作者、tabs 等 id/name 对象不能冒充一条热帖。
        if (!Array.isArray(v) || (min <= 1 && !LIST_KEY.test(key))) continue;
        const posts = v.filter(o => min > 1 || pick(o, CARD_POST_TITLE)).map(postFromObject).filter(Boolean);
        if (posts.length && posts.length >= min) return posts;
        if (min <= 1 && !v.length && LIST_KEY.test(key)) emptyList = true;
      }
      if (emptyList) return []; // 确有榜单数组但为空；仅在帖子标题里提到榜名不算卡片。
    }
  }
  for (const v of Object.values(json)) { const hit = namedList(v, heading, min, depth + 1); if (hit) return hit; }
  return null;
}
// HOT_LIST 类型、名字匹配 re 的卡片。
function hotCard(json, re, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return null;
  if (!Array.isArray(json) && json.cardType === 'HOT_LIST' && re.test(String(json.title || '')) && Array.isArray(json.list)) {
    const posts = json.list.map(postFromObject).filter(Boolean);
    if (posts.length) return { title: clean(json.title), posts };
  }
  for (const v of Object.values(json)) { const hit = hotCard(v, re, depth + 1); if (hit) return hit; }
  return null;
}
// 帖子详情页截到的接口数据里补阅读、回复、点赞、收藏、时间（心声的排行只有标题和链接）。
function countsFromJson(list) {
  const out = {};
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 6) return;
    if (!Array.isArray(o)) {
      for (const [k, keys] of [['views', VIEWS], ['replies', REPLIES], ['likes', LIKES], ['favs', FAVS]]) if (out[k] == null) { const n = count(pick(o, keys)); if (n != null) out[k] = n; }
      if (out.time == null) { const t = timeOf(pick(o, ['publishTime', 'createTime', 'postTime', 'releaseTime', 'createdAt', 'gmtCreate'])); if (t) out.time = t; }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, d + 1);
  };
  for (const json of list || []) walk(json, 0);
  return out;
}

function absolute(href, base) { try { return new URL(href, base).href; } catch { return ''; } }
function linkPosts(links, site, base) {
  const seen = new Set(), out = [];
  for (const l of links || []) {
    const href = absolute(l.href, base || 'http://localhost/');
    const m = site.postLink.exec(href);
    const title = clean(l.text);
    if (!m || title.length < 4 || title.length > 200) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title, url: href, views: null, replies: null, likes: null, favs: null, time: null, author: '', board: '' });
  }
  return out;
}
// 链接里拿不到帖子时退到板块里的文字行：去掉序号和末尾的数字，剩下像标题的留下（没有链接，点开到站点首页）。
function linePosts(lines) {
  const out = [], seen = new Set();
  for (const raw of lines || []) {
    const title = clean(raw).replace(/^(?:TOP\s*)?\d{1,2}[.、\s]+/i, '').replace(/\s+[\d.,]+[万wk]?$/i, '').trim();
    if (title.length < 6 || title.length > 120 || /排行|更多|查看全部|^\d+$/.test(title)) continue;
    const key = titleKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: '', title, url: '', views: null, replies: null, likes: null, favs: null, time: null, author: '', board: '' });
  }
  return out;
}
// 用 JSON 里的同一帖子（编号或标题对上）补数字。
function enrich(posts, pool) {
  const byId = new Map(), byTitle = new Map();
  for (const p of pool) { if (p.id) byId.set(p.id, p); byTitle.set(titleKey(p.title), p); }
  return posts.map(p => {
    const m = (p.id && byId.get(p.id)) || byTitle.get(titleKey(p.title));
    if (!m) return p;
    const out = { ...p };
    for (const k of ['views', 'replies', 'likes', 'favs', 'time']) if (out[k] == null && m[k] != null) out[k] = m[k];
    for (const k of ['author', 'board']) if (!out[k] && m[k]) out[k] = m[k];
    if (!out.id && m.id) out.id = m.id;
    if (!out.url && m.url) out.url = m.url;
    return out;
  });
}

// 一个站点首页的抓取结果 → 各排行榜的帖子。
//   capture: { finalUrl, sections: [{ heading, links, lines }], links, json: [{ url, json }] }
function postsForSite(site, capture, { base = '', limit = 20 } = {}) {
  const arrays = (capture.json || []).map(r => ({ url: String(r.url || ''), arrays: postArrays(r.json) })).filter(r => r.arrays.length);
  const pool = arrays.flatMap(r => r.arrays.flat());
  const lists = [];
  for (const list of site.lists) {
    const section = (capture.sections || []).find(s => s.heading === list.heading);
    let posts = [], from = '';
    const multi = site.lists.length > 1;
    const card = min => { for (const r of [...(capture.json || [])].reverse()) { const hit = namedList(r.json, list.heading, min); if (hit !== null) return hit; } return null; };
    // 1. 多榜站点（心声）：准确命名的卡片优先，0–2 条也照实保留——DOM 的共同祖先可能把两个榜的链接一起收进来。
    if (multi) { const hit = card(1); if (hit !== null) { posts = hit; from = 'api-card'; } }
    // 2. 没有对应卡片时，再看这个板块的链接和能确定归属的接口。
    if (from !== 'api-card' && section) { posts = linkPosts(section.links, site, capture.finalUrl || base); from = 'links'; }
    // 首页没有这个榜（现网部分视图只给「热门文章」卡片）：用榜单配置的备用卡片，标签写卡片自己的名字，不冒充原榜。
    let label = list.label;
    if (multi && from !== 'api-card' && posts.length < 3 && list.fallbackCard) {
      for (const r of [...(capture.json || [])].reverse()) { const hit = hotCard(r.json, list.fallbackCard); if (hit) { posts = hit.posts; label = hit.title; from = 'api-card-fallback'; break; } }
    }
    // 单榜站点（稼先）沿用原顺序和门槛：链接不足 3 条才找卡片、卡片至少 3 条。榜名「热点」太短，热帖标题常带这两个字。
    if (!multi && posts.length < 3) { const hit = card(3); if (hit) { posts = hit; from = 'api-card'; } }
    if (!/^api-card/.test(from) && posts.length < 3 && arrays.length) {
      // 同分时取后截到的（稼先点「热点」后才取热榜，先截到的是首页推荐）。
      // 多榜站点必须命中本榜的接口；共享接口或另一榜不能作为通用兜底。
      const ranked = arrays.map((r, i) => ({ ...r, i })).filter(r => site.lists.length === 1 || list.api?.test(r.url))
        .sort((a, b) => score(b.url, list, site) - score(a.url, list, site) || b.i - a.i);
      const best = ranked[0];
      if (best && score(best.url, list, site) > 0) { posts = best.arrays[0]; from = 'api'; }
    }
    // 3. 板块里的文字行
    if (!/^api-card/.test(from) && posts.length < 3 && section) { const lines = linePosts(section.lines); if (lines.length >= 3) { posts = lines; from = 'text'; } }
    // 稼先的「热点」是首页主列表：板块没认出来时，用整页的帖子链接
    if (from !== 'api-card' && posts.length < 3 && site.lists.length === 1) { const all = linkPosts(capture.links, site, capture.finalUrl || base); if (all.length >= 3) { posts = all; from = 'page-links'; } }
    // 接口数据常只有编号：按站点的详情页格式补链接（稼先）。
    const link = p => p.url ? absolute(p.url, capture.finalUrl || base) : (base && site.detailPath && p.id ? base + site.detailPath(p.id) : '');
    posts = enrich(posts, pool).slice(0, limit).map((p, i) => ({ ...p, rank: i + 1, url: link(p) }));
    lists.push({ key: list.key, label, from, posts });
  }
  // 用了备用卡片时，原榜里取不到的空榜不显示。
  return lists.some(l => l.from === 'api-card-fallback') ? lists.filter(l => l.posts.length) : lists;
}
function score(url, list, site) {
  let n = 0;
  if (site.api.test(url)) n += 1;
  if (site.hotApi.test(url)) n += 2;
  if (list.api && list.api.test(url)) n += 4;
  return n;
}

// 判断是不是停在登录页：回到别的域名，或页面里是登录表单的字样。
const LOGIN_WORDS = /账号登录|扫码登录|密码登录|统一身份认证|统一认证|请输入(?:账号|密码|工号)|忘记密码|Sign in|Log in/i;
function looksLikeLogin({ finalUrl = '', text = '', textLength = 0 } = {}, base = '') {
  let host = '', want = '';
  try { host = new URL(finalUrl).host; } catch { /* 没有地址 */ }
  try { want = new URL(base).host; } catch { /* 测试里可能没给 */ }
  if (want && host && host !== want) return true;
  return LOGIN_WORDS.test(String(text).slice(0, 3000)) && textLength < 4000;
}

module.exports = { postsForSite, postArrays, postFromObject, namedList, countsFromJson, linkPosts, linePosts, looksLikeLogin, count, timeOf, titleKey, clean };
