'use strict';
//   1) 默认关：可选功能里有「门户待办」且是关的，状态接口如实报没开启；
//   2) 打开开关 → Hub 用无头 Edge 打开假门户（先停 4 秒登录页再自动跳回首页，首页顶栏带「二维码」字样）
//      → 页面内查询 → 待办、申请、文件写进本机快照（真实取数链路，只是站点是假的）；
//   3) 第二次取数时假门户多了一条待办：应判为新增 1 条。
// 用法：node tests/e2e-company-w3-cdp.js [--electron <electron.exe>]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

const task = (id, desc, time) => ({ taskUUID: id, taskDesc: desc, time, taskURL: 'http://flow.corp.example/t/' + id, applicant: 'someone 00123456', handler: 'approver 00654321', quickApprove: '0' });

function fakePortal() {
  const state = { extra: false, hits: [] };
  const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json;charset=UTF-8' }); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(decodeURIComponent(req.url));
    state.hits.push(req.url.split('?')[0]);
    if (u.startsWith('/next/service/rest/my/w3account')) return json(res, { uid: 'u1', email: 'someone@corp.example', employeeNumber: '00123456', profile: { lname: '某人', userName: 'Some One', departmentCode: '012345', areaCode: 'Shanghai', isManager: 0 } });
    if (u.startsWith('/service/rest/task/getappinfocount')) return json(res, { todoCount: state.extra ? 3 : 2, serverTime: '2026-11-13 09:00:00', todoData: [{ appName: '考勤(Attendance)', appNum: '1' }, { appName: '绩效', appNum: state.extra ? '2' : '1' }] });
    if (u.startsWith('/service/rest/task/appinfo')) return json(res, [{ appName: '工时', appNum: '1' }]);
    if (u.startsWith('/service/rest/task/tasklists/考勤(Attendance)')) return json(res, { count: 1, data: [task('a1', '考勤异常，请确认', '2026-11-05 10:05:51')] });
    if (u.startsWith('/service/rest/task/tasklists/绩效')) return json(res, { count: state.extra ? 2 : 1, data: [task('p1', '请完成中期辅导', '2026-10-09 11:04:59'), ...(state.extra ? [task('p2', '年度目标确认', '2026-11-13 08:50:00')] : [])] });
    if (u.startsWith('/service/rest/task/applists/工时')) return json(res, { count: 1, data: [task('b1', '本周工时', '2026-11-09 16:38:54')] });
    if (u.startsWith('/next/proxyw3/p/plinkunitask/w3/tasks/find/count')) return json(res, { data: { count: 0 } });
    if (u.startsWith('/service/rest/info/common/docs')) return json(res, { policy: [{ documents: [{ title: '讲话一', code: '电邮讲话【2026】001号', deptname: '总裁办', publishdate: '2026-11-12 17:17:52', url: 'http://w3.corp.example/doc?did=1', docAbstract: '摘要' }] }] });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (u.startsWith('/next/indexa.html')) return res.end('<!doctype html><meta charset="utf-8"><title>Workplace</title><body><div>设为首页 | 我的收藏 | WeLink二维码 | 找人</div><h1>待办</h1></body>');
    // 根地址：像单点登录那样先显示 4 秒登录页，再自动跳到首页。
    res.end('<!doctype html><meta charset="utf-8"><title>登录</title><body><div>账号登录 <input type="password"> 扫码登录</div><script>setTimeout(()=>location.replace("/next/indexa.html"),4000)</script></body>');
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, state })));
}

async function run() {
  const ei = process.argv.indexOf('--electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-w3-e2e-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false, w3: false }));
  const { srv, state } = await fakePortal();
  const evidence = { steps: [], rendererErrors: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'w3-e2e', ...(ei > 0 ? { executablePath: process.argv[ei + 1] } : {}), extraEnv: {
      CLAUDE_HUB_COMPANY_W3: '1', CLAUDE_HUB_W3_TIMER: '0', CLAUDE_HUB_W3_URL: `http://127.0.0.1:${srv.address().port}/`,
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(300); } throw Error('Timeout: ' + label); };
    await wait(`typeof ipcRenderer !== 'undefined' && !!document.body`, 'renderer ready', 60000);

    const item = await wait(`ipcRenderer.invoke('optional-features:list').then(l=>l.find(x=>x.id==='w3'))`, 'w3 in optional features');
    evidence.listed = { name: item.name, on: item.on };
    if (item.on !== false) throw Error('默认应当是关的');
    evidence.offStatus = await c.eval(`ipcRenderer.invoke('company-w3:status')`);
    if (evidence.offStatus.ok !== false) throw Error('关着时状态接口应报没开启');
    if (state.hits.length) throw Error('关着时不应访问门户：' + state.hits.join(','));
    evidence.steps.push('off: listed, status refused, portal untouched');

    await c.eval(`ipcRenderer.invoke('optional-features:set',{id:'w3',on:true})`);
    const first = await wait(`ipcRenderer.invoke('company-w3:status').then(s=>s.ok&&s.lastResult&&!s.syncing?s:null)`, 'first sync', 120000);
    evidence.first = { result: first.lastResult, todo: first.todo.map(x => [x.app, x.title, x.ageDays != null]), apply: first.apply.map(x => [x.app, x.handler]), docs: Object.keys(first.docs), me: first.me };
    if (!first.lastResult.ok) throw Error('真实取数链路失败：' + JSON.stringify(first.lastResult));
    if (first.todo.length !== 2 || first.apply.length !== 1 || !first.docs.policy) throw Error('读到的条数不对');
    evidence.steps.push('on: first sync via headless Edge ok');

    state.extra = true;
    const second = await c.eval(`ipcRenderer.invoke('company-w3:sync')`);
    evidence.second = { result: second.lastResult, added: second.added };
    if (!second.lastResult.ok || second.lastResult.added !== 1 || second.todo.length !== 3) throw Error('第二次应新增 1 条：' + JSON.stringify(second.lastResult));
    evidence.steps.push('second sync: 1 added');

    await c.eval(`ipcRenderer.invoke('optional-features:set',{id:'w3',on:false})`);
    evidence.offAgain = await c.eval(`ipcRenderer.invoke('company-w3:status')`);
    evidence.files = fs.readdirSync(path.join(data, 'company-w3'));
    evidence.leftoverEdgeDirs = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('hub-w3-') && !f.startsWith('hub-w3-e2e-')).length;
  } catch (error) { evidence.error = error.message; }
  finally {
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* 留给系统清理 */ }
  }
  console.log(JSON.stringify(evidence, null, 1));
  if (evidence.error) process.exitCode = 1;
}
run();
