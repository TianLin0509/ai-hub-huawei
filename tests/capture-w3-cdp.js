'use strict';
//   1) 左侧有「门户」，点开是可选功能的开启提示；2) 页面上点「开启」→ 无头 Edge 取假门户（真实取数链路）；
//   3) 截待办、申请、公司要闻三个页签和详情抽屉；量 1440×900 下页面有没有纵向溢出。
// 用法：node tests/capture-w3-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

const ago = (days, hh = '10:05:51') => { const d = new Date(Date.now() - days * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}`; };
const T = (id, desc, days, from, handler) => ({ taskUUID: id, taskDesc: desc, time: ago(days), taskURL: 'https://flow.corp.example/t/' + id, applicant: from + ' 00123456', handler: handler + ' 00654321', quickApprove: '0' });
const TODO = { '技能提升': [T('s1', '角色学考：请及时完成「通往 AGI 之路 · AI 基础知识（2026 增量版）」', 100, '学习发展', '某人')], '绩效': [T('p1', '请完成中期辅导与反馈（Mid-term coaching and feedback）', 34, '绩效系统', '某人')],
  '满意度调研': [T('q1', 'IPD 流程与研发能力用户满意度调查问卷', 24, 'IRB Office', '某人')], '考勤': [T('a1', '考勤异常，请确认（Attendance Exception）', 7, '考勤系统', '某人')],
  'WIN 平台': [T('w1', '采购岗位行为承诺书签署状态异常提醒：当前无签署记录，请点击完成签署', 0, '无线风控', '某人')] };
const APPLY = { 'CDMS': [T('c1', '便携机使用申请，等待您的处理', 10, '某人', '审批人甲')], 'TIMES': [T('t1', '本周工时', 3, '某人', '审批人乙')],
  'IT 现场服务': [T('i1', '工程师处理', 3, '某人', '工程师丙'), T('i2', '工程师处理', 2, '某人', '工程师丙'), T('i3', '工程师处理', 2, '某人', '工程师丁')] };
const doc = (t, d, extra = {}) => ({ title: t, publishdate: ago(d, '17:17:52'), url: 'http://w3.corp.example/doc?did=' + encodeURIComponent(t), deptname: '总裁办', code: '', ...extra });
const DOCS = { policy: [{ documents: ['战略聚焦，争强格局，全面质量管理，组织充满活力——在年度商业计划工作会议上的讲话', '让想干事、能干成事的人在公司有干事的机会——在四季度工作会议上的讲话', '热工连的建设是公司一项重大决策', '经营规则总纲', '《无线专家与领袖训练营咖啡会》会议纪要', '勇立潮头，持续改进，在 AI 时代浪潮中有策略有节奏地前行'].map((t, i) => doc(t, i * 3)) }],
  corporate: [{ documents: ['任免通知（某某、某某）', '任免通知（某地区部部分行政管理团队）', '任命通知（某某）', '任命通知（某某）'].map((t, i) => doc(t, i)) }],
  bulletins: [{ documents: ['变更公告：某专属云域控服务器下线', '某代表处行政管理团队成员任前公示', '某代表处业务管理小组成员任前公示'].map((t, i) => doc(t, i)) }] };

function fakePortal() {
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' }); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(decodeURIComponent(req.url));
    if (u.startsWith('/next/service/rest/my/w3account')) return json(res, { uid: 'u1', email: 'someone@corp.example', employeeNumber: '00123456', profile: { lname: '某人', departmentCode: '012345', areaCode: 'Shanghai' } });
    if (u.startsWith('/service/rest/task/getappinfocount')) return json(res, { todoCount: 5, todoData: Object.keys(TODO).map(k => ({ appName: k, appNum: '1' })) });
    if (u.startsWith('/service/rest/task/appinfo')) return json(res, Object.keys(APPLY).map(k => ({ appName: k, appNum: String(APPLY[k].length) })));
    let m = /^\/service\/rest\/task\/(tasklists|applists)\/([^?]+)/.exec(u);
    if (m) { const src = (m[1] === 'tasklists' ? TODO : APPLY)[m[2]] || []; return json(res, { count: src.length, data: src }); }
    if (u.startsWith('/next/proxyw3/p/plinkunitask/w3/tasks/find/count')) return json(res, { data: { count: 0 } });
    if (u.startsWith('/service/rest/info/common/docs')) return json(res, DOCS);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (u.startsWith('/next/indexa.html')) return res.end('<!doctype html><meta charset="utf-8"><body>设为首页 | WeLink二维码 | 待办</body>');
    res.end('<!doctype html><meta charset="utf-8"><body>账号登录 <input type="password"><script>setTimeout(()=>location.replace("/next/indexa.html"),3000)</script></body>');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), 'w3-capture-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-w3cap-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false, w3: false }));
  const srv = await fakePortal();
  const evidence = { steps: [], rendererErrors: [], overflow: {} };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'w3-capture', extraEnv: {
      CLAUDE_HUB_COMPANY_W3: '1', CLAUDE_HUB_W3_TIMER: '0', CLAUDE_HUB_W3_URL: `http://127.0.0.1:${srv.address().port}/`,
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(250); } throw Error('Timeout: ' + label); };
    const shot = async name => { await sleep(700); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + name); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const overflow = name => c.eval(`(()=>{const p=document.getElementById('company-w3-page');const b=p.querySelector('.w3p-body');const r=b.getBoundingClientRect();return {bodyOverflow:b.scrollHeight>b.clientHeight+1,pageOverflow:p.scrollHeight>p.clientHeight+1,bottom:Math.round(r.bottom),pageBottom:Math.round(p.getBoundingClientRect().bottom)}})()`).then(v => { evidence.overflow[name] = v; });

    await wait(`!!document.getElementById('btn-company-w3')`, 'nav button', 60000);
    await click('#btn-company-w3');
    await wait(`(()=>{const p=document.getElementById('company-w3-page');return p&&!p.hidden&&!p.querySelector('.of-gate').hidden})()`, 'gate shown');
    await shot('01-未开启');
    await click('#company-w3-page [data-of-gate="on"]');
    evidence.steps.push('enabled from page');
    await wait(`(()=>{const p=document.getElementById('company-w3-page');return p.querySelector('.w3p-row')})()`, 'rows after sync', 90000);
    await shot('02-待办'); await overflow('todo');
    await click('#company-w3-page .w3p-row');
    await wait(`!document.querySelector('#company-w3-page [data-slot="drawer"]').hidden`, 'drawer');
    await shot('03-待办详情');
    await click('#company-w3-page [data-w3="close"]');
    await click('#company-w3-page [data-tab="apply"]'); await wait(`document.querySelector('#company-w3-page [data-tab="apply"][aria-selected="true"]')`, 'apply tab');
    await shot('04-申请'); await overflow('apply');
    await click('#company-w3-page [data-tab="news"]'); await wait(`document.querySelector('#company-w3-page .w3p-news')`, 'news');
    await shot('05-公司要闻'); await overflow('news');
    evidence.texts = await c.eval(`(()=>{const p=document.getElementById('company-w3-page');return {tabs:p.querySelector('[data-slot="tabs"]').innerText.replace(/\\s+/g,' '),status:p.querySelector('[data-slot="status"]').innerText}})()`);
    // 点侧栏别的按钮，门户页应当关掉
    await click('#btn-home'); await sleep(400);
    evidence.closedByOtherNav = await c.eval(`document.getElementById('company-w3-page').hidden`);
  } catch (error) { evidence.error = error.message; }
  finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* */ }
  }
  console.log(JSON.stringify({ out, error: evidence.error || null, rendererErrors: evidence.rendererErrors, overflow: evidence.overflow, texts: evidence.texts, closedByOtherNav: evidence.closedByOtherNav }));
  if (evidence.error) process.exitCode = 1;
}
run();
