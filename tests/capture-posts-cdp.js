'use strict';
//   1) 全新用户：左侧有「帖子」，点开是可选功能的开启提示；点「开启」后自动同步；
//   2) 取数走真实链路：默认经无头 Edge（借本机 Edge 登录状态，--route hub 时只用 Hub 窗口），假发文站先显示 6 秒登录页再跳回；
//   3) 截「发文 / 心声 / 稼先 / AI 看点 / 设置」各一屏，核对 1440×900 下没有纵向滚动、翻页可用；
//   4) 假发文站多出一条后只重看发文：出现「新」标和页签上的新条数，并发出一条提醒。
// 用法：node tests/capture-posts-cdp.js --out <新目录> [--route hub]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

// 固定样例（虚构）：只给界面验收用。
const TOPICS = ['算力底座', '项目经营', '质量管理', '人才培养', '流程简化', '客户界面', '研发效率', '组织活力', '合规运营', '数字化转型', '供应连续', '开源协作', '绿色节能', '体验设计'];
const docs = extra => {
  const d = (did, title, o = {}) => ({ title, url: `/info/cn/doc/viewDoc.do?did=${did}&cata=9`, code: '', deptname: '示例技术/示例部门', publishdate: `2026-11-${String(12 - (did % 9)).padStart(2, '0')} 1${did % 10}:2${did % 6}:00`, docAbstract: '', ...o });
  return {
    policy: [{ documents: [...extra, ...TOPICS.map((t, i) => d(1000 + i, `把${t}做扎实，把确定性的事情做到位——在示例工作会议上的讲话（${i + 1}）`, { code: `电邮讲话【2026】0${70 - i}号`, deptname: '示例技术/总裁办', docAbstract: `一、${t}是今年的主线；二、明年按项目逐个闭环；三、让一线听得见炮声的人来决策。` }))] }],
    corporate: [{ documents: TOPICS.slice(0, 12).map((t, i) => d(2000 + i, i % 3 ? `任免通知（${t}部分管理团队）` : `关于${t}管理规定的通知`, { code: `示例任命【2026】${160 - i}号`, deptname: '示例技术/干部部' })) }],
    bulletins: [{ documents: TOPICS.slice(0, 12).map((t, i) => d(3000 + i, `${t}系统升级公告：本周六 22:00–24:00 暂停服务`, { deptname: i % 2 ? '示例技术/流程IT' : '' })) }],
    xinsheng: [{ documents: [d(9000, '这一栏转到社区，不在发文里显示')] }],
  };
};
const hot = (tag, n) => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i + 1}`, title: `${TOPICS[i % TOPICS.length]}的一线实践：我们踩过的 ${i + 3} 个坑和最后留下的做法（${tag}${i + 1}）` }));

function site(kind, state) {
  const pages = {
    // 先像公司单点登录那样显示 6 秒登录页，再换成门户首页并取发文接口。
    w3: `<div id="sso">账号登录 <input type="password"> 忘记密码</div><div id="app" style="display:none"><h1>门户首页</h1><p>${'待办 申请 任务 常用场景 '.repeat(12)}</p></div><script>
      setTimeout(()=>{document.getElementById('sso').remove();document.getElementById('app').style.display='';fetch('/service/rest/info/common/docs?lan=cn').then(r=>r.json())},6000);</script>`,
    jx: `<h1>稼先社区</h1><p>${'关注 推荐 热点 稼问 直播 '.repeat(12)}</p><script>fetch('/jxService/v1/jxhome/homeHotResources?type=hotRecommend_1Week').then(r=>r.json())</script>`,
    xinsheng: `<h1>心声社区</h1><p>${'首页 家事 七彩生活 视频 图库 '.repeat(12)}</p><script>fetch('/xsrecommend/user/v1/cards/recommends/home/right').then(r=>r.json())</script>`,
  };
  const srv = http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.includes('/info/common/docs')) return json(docs(state.extraDocs));
    if (req.url.includes('homeHotResources')) return json({ result: { dataList: hot('稼', 20).map((p, i) => ({ resourceId: p.id, title: p.title, browseCount: 9000 - i * 311, commentCount: 80 - i * 3, upvoteCount: 40 - i, createTime: '2026-11-12 09:00:00' })) } });
    if (req.url.includes('recommends/home/right')) return json({ data: [{ cardType: 'HOT_LIST', title: '24小时点击排行', list: hot('点', 10).map(p => ({ postId: p.id, title: p.title, link: `/next/detail/#/index?uuid=${p.id}` })) }, { cardType: 'HOT_LIST', title: '24小时回复排行', list: hot('回', 10).map(p => ({ postId: p.id, title: p.title, link: `/next/detail/#/index?uuid=${p.id}` })) }] });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${kind}</title><body>${req.url === '/' || /indexa|menuKey|next\/index/.test(req.url) ? pages[kind] : `<article>${'这是一段虚构的正文，用来给摘要提供依据。'.repeat(20)}</article>`}</body>`);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run() {
  const out = path.resolve(arg('--out', path.join(REPO, 'artifacts', 'posts-' + Date.now()))), route = arg('--route', 'edge');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-posts-ui-')), data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'company-forum'), { recursive: true });
  // 全新用户：可选功能全关；只把 AI 摘要条数设成 0（验收不起 CodeAgent 会话）。
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false }));
  fs.writeFileSync(path.join(data, 'company-forum', 'settings.json'), JSON.stringify({ summarize: 0 }));
  const state = { extraDocs: [] };
  const servers = { w3: await site('w3', state), jx: await site('jx', state), xinsheng: await site('xinsheng', state) };
  const bases = Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, `http://127.0.0.1:${s.address().port}`]));
  const evidence = { route, steps: [], rendererErrors: [], screens: {} };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'posts-capture', extraEnv: {
      CLAUDE_HUB_COMPANY_FORUM: '1', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_FORUM_SITES: JSON.stringify(bases), CLAUDE_HUB_FORUM_EDGE: route === 'edge' ? '1' : '0',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(250); } throw Error('Timeout ' + label); };
    // 每屏都量一遍：页面内有没有出现纵向滚动、内容有没有被裁掉。
    const P = '#company-forum-page';
    const shot = async name => {
      await sleep(700);
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      evidence.screens[name] = await c.eval(`(()=>{const p=document.querySelector('${P}');const pane=p.querySelector('.cf-pane');const scrollers=[...p.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)).map(e=>e.className);
        const rows=[...p.querySelectorAll('.cf-post')];const last=rows.at(-1)?.getBoundingClientRect();const pb=pane?.getBoundingClientRect();
        return {scrollers,rows:rows.length,cols:p.querySelectorAll('.cf-col').length,clipped:!!(last&&pb&&last.bottom>pb.bottom+1),paneOverflow:pane?pane.scrollHeight-pane.clientHeight:0,docOverflow:document.documentElement.scrollHeight-innerHeight}})()`);
      evidence.steps.push('shot ' + name);
    };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const status = () => c.eval(`ipcRenderer.invoke('company-forum:status')`);

    await wait(`!!document.getElementById('btn-company-forum')`, 'nav button');
    evidence.navLabel = await c.eval(`document.querySelector('#btn-company-forum .btn-label').textContent`);
    await click('#btn-company-forum');
    await wait(`(()=>{const p=document.querySelector('${P}');return p&&!p.hidden})()`, 'page open');
    await shot('01-未开启');
    evidence.steps.push('enable: ' + await c.eval(`(()=>{const b=document.querySelector('${P} [data-of-gate="on"]');if(!b)return false;b.click();return b.textContent.trim()})()`));
    await wait(`ipcRenderer.invoke('optional-features:list').then(l=>l.find(x=>x.id==='forum')?.on)`, 'feature on');
    // 开启后页面自己开始同步（ensure-today），不用再点刷新。
    await wait(`ipcRenderer.invoke('company-forum:status').then(s=>s.syncing)`, 'auto sync started', 15000);
    await shot('02-同步中');
    const t0 = Date.now();
    await wait(`ipcRenderer.invoke('company-forum:status').then(s=>!s.syncing&&s.today)`, 'sync done', 180000);
    const st = await status();
    evidence.sync = { seconds: Math.round((Date.now() - t0) / 1000), route: st.route, sites: st.snapshot.sites.map(s => ({ id: s.id, ok: s.ok, via: s.via, needsLogin: s.needsLogin, error: s.error, lists: s.lists.map(l => `${l.label}×${l.posts.length}(${l.from})`) })) };
    if (!st.snapshot.sites.every(s => s.ok)) throw Error('有站点没取到：' + JSON.stringify(evidence.sync.sites));
    if (route === 'edge' && !st.snapshot.sites.every(s => s.via === 'edge')) throw Error('没有走 Edge 通道：' + JSON.stringify(evidence.sync.sites));
    await wait(`document.querySelectorAll('${P} .cf-col').length===3`, 'docs columns');
    await shot('03-发文');
    evidence.pager = { before: await c.eval(`document.querySelector('${P} .cf-pager span')?.textContent`) };
    await click(`${P} .cf-pg[aria-label="下一页"]`);
    evidence.pager.after = await c.eval(`document.querySelector('${P} .cf-pager span')?.textContent`);
    await shot('04-发文-第二页');
    await click(`${P} [data-source="xinsheng"]`); await shot('05-心声');
    await click(`${P} [data-source="jx"]`); await shot('06-稼先');

    // AI 看点：写入固定样例（验收不起 CodeAgent），核对出处标签能跳回对应来源并翻到那一页。
    const file = path.join(data, 'company-forum', `forum-${st.day}.json`), snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pick = (id, li, i) => { const p = snap.sites.find(s => s.id === id).lists[li].posts[i]; p.summary = '示例摘要：讲清了做法、代价和适用范围，评论区主要在争论是否值得推广。'; return { site: id, title: p.title }; };
    snap.overview = [{ text: '今天的发文集中在明年工作部署，强调按项目逐个闭环。', refs: [pick('w3', 0, 0), pick('w3', 0, 12)] }, { text: '社区里讨论最多的是一线实践复盘，几篇高回复帖都在谈怎么少走弯路。', refs: [pick('jx', 0, 14), pick('xinsheng', 1, 2)] }, { text: '系统升级公告较多，周六晚间多个服务暂停。', refs: [pick('w3', 2, 0)] }];
    snap.summaryAt = Date.now(); snap.picked = snap.overview.flatMap(o => o.refs).map((r, i) => ({ source: 'P' + (i + 1), ...r }));
    fs.writeFileSync(file, JSON.stringify(snap));
    await click(`${P} [data-source="overview"]`);
    await wait(`document.querySelectorAll('${P} .cf-overview li').length===3`, 'overview', 20000);
    await shot('07-AI看点');
    await c.eval(`document.querySelectorAll('${P} .cf-ref')[2].click()`); await sleep(300);
    evidence.jump = await c.eval(`(()=>{const p=document.querySelector('${P}');return {source:p.querySelector('.cf-source.on')?.textContent,flash:p.querySelector('.cf-post.flash .cf-post-title')?.textContent?.slice(0,30)||''}})()`);
    await shot('08-看点跳回稼先');
    await click(`${P} [data-cf="settings"]`); await shot('09-设置'); await click(`${P} [data-cf="close-panel"]`);

    // 发文上新：假站点多出一条，只重看发文。
    state.extraDocs = [{ title: '关于明年重点工作部署的讲话（刚发布）', url: '/info/cn/doc/viewDoc.do?did=5001&cata=9', code: '电邮讲话【2026】071号', deptname: '示例技术/总裁办', publishdate: '2026-11-12 18:30:00', docAbstract: '明年聚焦三件事。' }];
    evidence.docsCheck = await c.eval(`ipcRenderer.invoke('company-forum:check-docs').then(s=>({ok:s.ok,firstTitle:s.snapshot.sites.find(x=>x.id==='w3').lists[0].posts[0].title,fresh:s.snapshot.sites.find(x=>x.id==='w3').lists[0].posts.filter(p=>p.firstSeen).length}))`);
    await click(`${P} [data-source="w3"]`);
    await click(`${P} .cf-pg[aria-label="上一页"]`); // 前面翻到过第二页，新发文排在第一页最前
    await wait(`!!document.querySelector('${P} .cf-new')`, 'new badge', 15000);
    evidence.newBadge = await c.eval(`document.querySelector('${P} .cf-source.on')?.textContent`);
    await shot('10-发文上新');
    evidence.fonts = await c.eval(`(()=>{const s={};for(const e of document.querySelectorAll('${P} *')){if(!e.offsetParent)continue;const own=[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());if(!own)continue;const f=parseFloat(getComputedStyle(e).fontSize);s[f]=(s[f]||0)+1}return s})()`);
    const bad = Object.entries(evidence.screens).filter(([, v]) => v.scrollers.length || v.clipped || v.paneOverflow > 1 || v.docOverflow > 1);
    if (bad.length) throw Error('有页面超出一屏：' + JSON.stringify(bad));
  } catch (error) { evidence.error = error.message; }
  finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    for (const s of Object.values(servers)) s.close();
  }
  console.log(JSON.stringify({ out, error: evidence.error || null, sync: evidence.sync, pager: evidence.pager, jump: evidence.jump, docsCheck: evidence.docsCheck, newBadge: evidence.newBadge, rendererErrors: evidence.rendererErrors.length }));
  if (evidence.error) process.exitCode = 1;
}
run();
