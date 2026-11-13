'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const model = require('../core/company-w3/model');
const { collectScript } = require('../core/company-w3/collect-script');
const { CompanyW3, portalUrl, readyUrlOf } = require('../core/company-w3/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { looksLikeLogin } = require('../main/company-edge-capture');

const item = (id, desc, time, extra = {}) => ({ taskUUID: id, taskDesc: desc, time, taskURL: 'http://flow.corp.example/t/' + id, applicant: 'someone 00123456', handler: 'approver 00654321', quickApprove: '0', ...extra });
function raw({ todo = [], apply = [], docs = null, task = 0 } = {}) {
  const group = (list) => Object.entries(list.reduce((m, x) => { (m[x.app] = m[x.app] || []).push(x.it); return m; }, {})).map(([app, items]) => ({ app, count: items.length, listed: items.length, items }));
  return { login: true, me: { uid: 'u1', email: 'someone@corp.example', name: '某人', deptCode: '012345', area: 'Shanghai' },
    todo: { count: todo.length, apps: group(todo) }, apply: { apps: group(apply) }, task: { count: task },
    docs: docs || { policy: [{ documents: [{ title: '讲话一', code: '电邮讲话【2026】001号', deptname: '总裁办', publishdate: '2026-11-12 17:17:52', url: 'http://w3.corp.example/doc?did=1', docAbstract: '摘要' }] }] } };
}
const T = (s) => new Date(s).getTime();

test('整理：待办、申请、文件栏目各归各位，链接与人名收拾干净', () => {
  const n = model.normalize(raw({ todo: [{ app: '考勤', it: item('a1', ' 考勤异常 \n 请确认 ', '2026-11-05 10:05:51') }], apply: [{ app: '工时', it: item('b1', '本周工时', '2026-11-09 16:38:54') }], task: 2 }), '2026-11-13T02:00:00.000Z');
  assert.equal(n.ok, true);
  assert.equal(n.todo[0].title, '考勤异常 请确认');
  assert.equal(n.todo[0].host, 'flow.corp.example');
  assert.equal(n.todo[0].from, 'someone');
  assert.equal(n.apply[0].handler, 'approver');
  assert.deepEqual(n.counts, { todo: 1, apply: 1, task: 2 });
  assert.equal(n.docs.policy[0].url, 'https://w3.corp.example/doc?did=1');
  assert.deepEqual(n.partial, []);
  assert.equal(model.normalize({ login: false }, 'x').ok, false);
});

test('比对：第一次只报总数；之后新来的单独提醒，消失的记为办完', () => {
  const now = T('2026-11-13T09:00:00');
  const first = model.merge(null, model.normalize(raw({ todo: [{ app: '绩效', it: item('p1', '中期辅导', '2026-10-09 11:04:59') }, { app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }), 't1'));
  const n1 = model.noticesFor(first, now);
  assert.equal(n1.length, 1);
  assert.match(n1[0].title, /2 条待办/);
  assert.match(n1[0].text, /已挂 34 天/);
  assert.deepEqual(first.todo.find((x) => x.id === 'p1').told, [7, 30]);
  const second = model.merge(first, model.normalize(raw({ todo: [{ app: '绩效', it: item('p1', '中期辅导', '2026-10-09 11:04:59') }, { app: '采购', it: item('w1', '承诺书签署', '2026-11-12 14:18:17') }] }), 't2'));
  assert.deepEqual(second.added.todo, ['w1']);
  assert.deepEqual(second.done.todo.map((x) => x.id), ['a1']);
  assert.equal(second.todo.find((x) => x.id === 'p1').firstSeen, 't1');
  const n2 = model.noticesFor(second, now);
  assert.equal(n2.length, 1);
  assert.equal(n2[0].title, '新待办：采购');
  assert.equal(n2[0].kind, 'w3');
});

test('久拖提醒：待办第 7 天、第 30 天各说一次；申请卡 5 天带上处理人；同一档不重复', () => {
  const base = model.merge(null, model.normalize(raw({ todo: [{ app: '调研', it: item('s1', '满意度问卷', '2026-11-10 10:00:00') }], apply: [{ app: '便携机', it: item('c1', '便携机使用申请', '2026-11-10 14:47:41') }] }), 't1'));
  model.noticesFor(base, T('2026-11-11T09:00:00'));
  const again = (prev, at) => model.merge(prev, model.normalize(raw({ todo: [{ app: '调研', it: item('s1', '满意度问卷', '2026-11-10 10:00:00') }], apply: [{ app: '便携机', it: item('c1', '便携机使用申请', '2026-11-10 14:47:41') }] }), at));
  const d6 = again(base, 't2');
  const n6 = model.noticesFor(d6, T('2026-11-16T09:00:00'));
  assert.equal(n6.length, 1);
  assert.match(n6[0].title, /申请卡了 5 天：便携机/);
  assert.match(n6[0].text, /approver 手上/);
  const d8 = again(d6, 't3');
  const n8 = model.noticesFor(d8, T('2026-11-18T09:00:00'));
  assert.equal(n8.length, 1);
  assert.match(n8[0].title, /待办挂了 7 天：调研/);
  assert.equal(model.noticesFor(again(d8, 't4'), T('2026-11-19T09:00:00')).length, 0);
});

test('没取全的那一类不当成办完；新文件按链接认', () => {
  const first = model.merge(null, model.normalize(raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }), 't1'));
  const broken = raw({});
  broken.todo = null;
  const second = model.merge(first, model.normalize(broken, 't2'));
  assert.equal(second.todo.length, 1);
  assert.equal(second.done.todo.length, 0);
  const more = raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }], docs: { policy: [{ documents: [
    { title: '讲话二', publishdate: '2026-11-13 08:00:00', url: 'http://w3.corp.example/doc?did=2' }, { title: '讲话一', publishdate: '2026-11-12 17:17:52', url: 'http://w3.corp.example/doc?did=1' }] }] } });
  const third = model.merge(second, model.normalize(more, 't3'));
  assert.deepEqual(third.added.docs.map((d) => d.title), ['讲话二']);
  const lines = model.briefLines(third, T('2026-11-13T09:00:00'));
  assert.match(lines[0], /门户待办 1 条/);
  assert.match(lines[lines.length - 1], /公司新发 2 篇讲话/);
});

test('页面内查询脚本：语法正确，按首页的查询顺序取数（用假 fetch 跑一遍）', async () => {
  const seen = [];
  const reply = (url) => {
    if (url.includes('w3account')) return { uid: 'u1', email: 'someone@corp.example', employeeNumber: '00123456', profile: { lname: '某人', departmentCode: '012345', areaCode: 'Shanghai', isManager: 0 } };
    if (url.includes('getappinfocount')) return { todoCount: 1, serverTime: '2026-11-13 02:23:49', todoData: [{ appName: '考勤(Attendance)', appNum: '1' }] };
    if (url.includes('/task/appinfo')) return [{ appName: 'TIMES', appNum: '1' }];
    if (url.includes('/tasklists/')) return { count: 1, data: [item('a1', '考勤异常', '2026-11-05 10:05:51')] };
    if (url.includes('/applists/')) return { count: 1, data: [item('b1', '本周工时', '2026-11-09 16:38:54')] };
    if (url.includes('tasks/find/count')) return { data: { count: 0 } };
    if (url.includes('common/docs')) return { policy: [{ documents: [{ title: '讲话一', publishdate: '2026-11-12 17:17:52', url: 'http://w3.corp.example/doc?did=1' }] }] };
    return null;
  };
  const ctx = vm.createContext({ performance, encodeURIComponent, Date, Promise, Array, Number, String, Math, Object,
    fetch: async (url, init) => { seen.push(url); assert.equal(init.headers['X-Requested-With'], 'XMLHttpRequest'); const j = reply(url); return { status: j ? 200 : 404, text: async () => JSON.stringify(j) }; } });
  const value = await vm.runInContext(collectScript({ listMax: 20 }), ctx);
  assert.equal(value.login, true);
  assert.equal(value.todo.apps[0].items[0].taskUUID, 'a1');
  assert.equal(value.apply.apps[0].items[0].taskUUID, 'b1');
  assert.ok(seen.some((u) => u.includes('/tasklists/' + encodeURIComponent(encodeURIComponent('考勤(Attendance)')) + '?type=2&curpage=1&num=20')));
  assert.ok(seen.every((u) => u.startsWith('/')), '只发同源查询');
  const n = model.normalize(JSON.parse(JSON.stringify(value)), 't');
  assert.equal(n.todo.length, 1);
  assert.equal(n.apply.length, 1);
  const out = await vm.runInContext(collectScript(), vm.createContext({ performance, encodeURIComponent, Date, Promise, fetch: async () => ({ status: 421, text: async () => 'login' }) }));
  assert.equal(out.login, false);
});

function make({ edge, now = '2026-11-13T09:00:00' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-svc-'));
  let t = new Date(now);
  const bus = new NoticeBus();
  const svc = new CompanyW3({ dataDir, noTimer: true, now: () => t, edgeRun: edge || null, publish: (n) => bus.publish(n) });
  return { svc, bus, dataDir, setNow: (v) => { t = new Date(v); } };
}

test('网址：由公司域名拼出；首页地址判定只认门户本站', () => {
  assert.equal(portalUrl('corp.example', {}), 'https://w3.corp.example/');
  assert.equal(portalUrl('', {}), '');
  const re = readyUrlOf('https://w3.corp.example/');
  assert.ok(re.test('https://w3.corp.example/next/indexa.html'));
  assert.ok(re.test('https://w3.corp.example/next/index.html'));
  assert.ok(!re.test('https://login.corp.example/login1/'));
});

test('服务：同考勤——6 点前不取，6 点后取一次，当天不再自动取，第二天再取；手动刷新随时可取；提醒经总线发出', async () => {
  let calls = 0;
  const { svc, bus, setNow } = make({ now: '2026-11-13T05:30:00', edge: async (req) => {
    calls += 1;
    assert.equal(req.url, 'https://w3.' + svc.settings().domain + '/');
    assert.equal(req.accept({ login: false }), false);
    return { ok: true, tookMs: 9000, value: raw({ todo: calls < 3 ? [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] : [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }, { app: '采购', it: item('w1', '承诺书签署', '2026-11-14 10:00:00') }] }) };
  } });
  assert.equal(svc.shouldRun(), false, '6 点前不取');
  setNow('2026-11-13T06:05:00');
  assert.equal(svc.shouldRun(), true);
  await svc.tick();
  assert.equal(calls, 1);
  setNow('2026-11-13T17:00:00');
  await svc.tick();
  assert.equal(calls, 1, '当天成功后不再自动取');
  await svc.sync({ reason: 'manual' });
  assert.equal(calls, 2, '手动刷新随时可取');
  setNow('2026-11-14T08:00:00');
  await svc.tick();
  assert.equal(calls, 3, '第二天再取');
  const st = svc.status();
  assert.equal(st.todo.length, 2);
  assert.equal(st.todo.find((x) => x.id === 'a1').ageDays, 8);
  assert.equal(st.lastResult.added, 1);
  const titles = bus.latest(5).map((n) => n.title);
  assert.ok(titles.includes('新待办：采购'));
  assert.ok(titles.some((x) => /门户上有 1 条待办/.test(x)));
  assert.match(svc.digestText(), /\[采购\] 承诺书签署/);
  assert.ok(svc.briefLines()[0].startsWith('门户待办 2 条'));
});

test('服务：取数失败记原因、1 小时后再试；关掉自动或提醒后照设置办', async () => {
  let ok = false;
  const { svc, bus, setNow } = make({ now: '2026-11-13T09:00:00', edge: async () => (ok ? { ok: true, value: raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }) } : { ok: false, needsLogin: true, error: '需要登录（停在 login.corp.example）' }) });
  await svc.tick();
  assert.equal(svc.status().lastResult.needsLogin, true);
  assert.equal(svc.shouldRun(), false);
  setNow('2026-11-13T10:01:00');
  assert.equal(svc.shouldRun(), true);
  svc.setSettings({ remind: false });
  ok = true;
  await svc.tick();
  assert.equal(svc.status().todo.length, 1);
  assert.equal(bus.latest(5).length, 0);
  svc.setSettings({ auto: false });
  setNow('2026-11-14T09:00:00');
  assert.equal(svc.shouldRun(), false);
  const none = make({});
  assert.equal((await none.svc.sync()).ok, false);
  assert.match(none.svc.digestText(), /还没有读到/);
});

test('登录页判定：到了目标页，页面上有「二维码」字样也不算登录页（真机误判过）；有密码框一律算', () => {
  assert.equal(looksLikeLogin({ hasQr: true, hasPassword: false }, true), false);
  assert.equal(looksLikeLogin({ hasQr: true, hasPassword: false }, false), true);
  assert.equal(looksLikeLogin({ hasQr: false, hasPassword: true }, true), true);
  assert.equal(looksLikeLogin({}, false), false);
});

test('接入：可选功能默认关；IPC 关着时如实报没开启，开着时能读状态', async () => {
  const { CATALOG, createOptionalFeatures } = require('../core/optional-features');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-opt-'));
  const opt = createOptionalFeatures({ dataDir });
  assert.ok(CATALOG.w3.name && CATALOG.w3.cost);
  assert.equal(opt.get('w3'), false);
  const handlers = {};
  const { svc } = make({ edge: async () => ({ ok: true, value: raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }) }) });
  require('../main/ipc/company-w3-handlers').registerCompanyW3Ipc({ handle: (name, fn) => { handlers[name] = fn; } }, () => (opt.get('w3') ? svc : null));
  assert.deepEqual(await handlers['company-w3:status']({}), { ok: false, error: '门户待办功能没有开启' });
  opt.set('w3', true);
  const st = await handlers['company-w3:sync']({});
  assert.equal(st.todo.length, 1);
  assert.equal((await handlers['company-w3:set-settings']({}, { remind: false })).settings.remind, false);
});

test('接入：助理的 portal_todo 工具只挂在电脑和手机问答上；功能关着时告诉用户去哪开', async () => {
  const { TOOLSETS } = require('../core/company-assistant/mcp');
  assert.ok(TOOLSETS.desk.includes('portal_todo') && TOOLSETS.phone.includes('portal_todo'));
  assert.ok(!TOOLSETS.ppt.includes('portal_todo') && !TOOLSETS.brief.includes('portal_todo'));
  const { HubTools } = require('../core/company-assistant/hub-tools');
  const shared = require('../core/company-w3/shared');
  const a = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'w3-tools-')), toolsetFor: () => 'desk', state: () => ({}), now: () => 0, changed() {} };
  const tools = new HubTools(a, {});
  shared.setPortal(() => null);
  const off = await tools.invoke({ name: 'portal_todo', arguments: {}, callerSessionId: 's1' });
  assert.equal(off.ok, false);
  assert.match(off.text, /可选功能/);
  const { svc } = make({ edge: async () => ({ ok: true, value: raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }) }) });
  await svc.sync();
  shared.setPortal(() => svc);
  const on = await tools.invoke({ name: 'portal_todo', arguments: { limit: 5 }, callerSessionId: 's1' });
  assert.equal(on.ok, true);
  assert.match(on.text, /\[考勤\] 考勤异常/);
  a.toolsetFor = () => 'ppt';
  await assert.rejects(() => tools.invoke({ name: 'portal_todo', arguments: {}, callerSessionId: 's1' }), /没有挂这个工具/);
  shared.setPortal(null);
});

test('晨报：门户开着时在最后追加「门户待办」一栏，重复追加只留一栏；没数据时不加', () => {
  const { withPortal } = require('../core/company-assistant/brief');
  const brief = { day: '2026-11-13', sections: [{ key: 'meetings', title: '今天的会', items: [{ source: 'm1', text: '例会' }] }], total: 1 };
  const once = withPortal(brief, ['门户待办 5 条。最久的一条已挂 100 天', '你提的申请有 1 条卡了 5 天以上']);
  assert.deepEqual(once.sections.map(s => s.key), ['meetings', 'portal']);
  assert.equal(once.sections[1].items.length, 2);
  assert.equal(once.total, 1, '不改变简报条数（桌宠的简报通知照旧）');
  assert.deepEqual(withPortal(once, ['门户待办 4 条']).sections.map(s => s.items.length), [1, 1]);
  assert.deepEqual(withPortal(brief, []).sections.map(s => s.key), ['meetings']);
});

test('审查回归：某系统条目没取全（分页截断）时不把旧条目当成办完', () => {
  const first = model.merge(null, model.normalize(raw({ todo: [{ app: '审批', it: item('o1', '旧单', '2026-11-01 10:00:00') }, { app: '审批', it: item('o2', '旧单2', '2026-11-02 10:00:00') }] }), 't1'));
  const r = raw({ todo: [{ app: '审批', it: item('n1', '新单', '2026-11-13 10:00:00') }] });
  r.todo.apps[0].count = 3; r.todo.apps[0].listed = 3;
  const n = model.normalize(r, 't2');
  assert.ok(n.partial.includes('todo:审批'));
  const second = model.merge(first, n);
  assert.equal(second.done.todo.length, 0);
  assert.deepEqual(second.todo.map(x => x.id).sort(), ['n1', 'o1', 'o2']);
});

test('审查回归：新出现的超期申请照常按天数提醒', () => {
  const first = model.merge(null, model.normalize(raw({}), 't1'));
  const second = model.merge(first, model.normalize(raw({ apply: [{ app: '便携机', it: item('c9', '便携机使用申请', '2026-11-05 10:00:00') }] }), 't2'));
  const n = model.noticesFor(second, T('2026-11-13T09:00:00'));
  assert.equal(n.length, 1);
  assert.match(n[0].title, /申请卡了 7 天/);
});

test('审查回归：待办没取全时快照照并，但不算当天成功，1 小时后再取', async () => {
  const { svc, setNow } = make({ now: '2026-11-13T09:00:00', edge: async () => { const v = raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }); v.todo = null; return { ok: true, value: v }; } });
  const r = await svc.sync({ reason: 'auto' });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.equal(svc.status().lastSuccessAt, null);
  setNow('2026-11-13T10:01:00');
  assert.equal(svc.shouldRun(), true);
});

test('审查回归：取数途中关掉功能——取消取数，结果不写快照、不发提醒', async () => {
  let release, gotSignal;
  const { svc, bus } = make({ edge: (req) => { gotSignal = req.signal; return new Promise(r => { release = r; }); } });
  const p = svc.sync();
  await new Promise(r => setTimeout(r, 20));
  svc.close();
  assert.equal(gotSignal.aborted, true);
  release({ ok: true, value: raw({ todo: [{ app: '考勤', it: item('a1', '考勤异常', '2026-11-05 10:05:51') }] }) });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(svc.snapshot(), null);
  assert.equal(bus.latest(5).length, 0);
});

test('审查回归：Edge 启动失败只报这次失败，不抛出到 Hub', async () => {
  const { runInEdge } = require('../main/company-edge-capture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-fake-edge-'));
  const exe = path.join(root, 'Microsoft', 'Edge', 'Application');
  fs.mkdirSync(exe, { recursive: true });
  fs.writeFileSync(path.join(exe, 'msedge.exe'), 'not a program');
  const r = await runInEdge({ url: 'http://127.0.0.1:9/', readyUrl: /x/, script: '1', timeoutMs: 15000, env: { 'ProgramFiles(x86)': root, LOCALAPPDATA: root }, logger: { warn() {} } });
  assert.equal(r.ok, false);
  assert.match(r.error, /无头 Edge/);
});

test('审查回归：晨报里的门户条目点开的是门户页', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(src, /verb === 'source' && String\(arg\)\.startsWith\('w3:'\)\) \{ document\.getElementById\('btn-company-w3'\)\?\.click\(\)/);
});
