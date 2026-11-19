'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CompanyAttendance, attendanceUrl, holidaysFrom } = require('../core/company-attendance/service');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'att-svc-')); }
const card = (d, a, b) => ({ attendanceDate: d, earlyClockInTime: a, lateClockInTime: b, earlyClockTag: '智,S', lateClockTag: '智,S' });

function make({ hub, edge, now = '2026-11-07T09:00:00', email = 'someone@corp.example' } = {}) {
  const dataDir = tmpDir();
  let t = new Date(now);
  const svc = new CompanyAttendance({
    dataDir, noTimer: true, now: () => t, accountEmail: () => email,
    browser: hub ? { capture: async (req) => hub(req), login: async () => ({ ok: true }) } : null,
    edgeCapture: edge || null,
  });
  return { svc, dataDir, setNow: (v) => { t = new Date(v); } };
}

test('网址由公司邮箱域名拼出，不写死', () => {
  assert.equal(attendanceUrl('corp.example', {}), 'https://hr.corp.example/apps/attendanceflow/#/myAttendance');
  assert.equal(attendanceUrl('', {}), '');
});

test('Hub 窗口截到打卡记录：写入记录与假期，当天不再访问', async () => {
  let calls = 0;
  const { svc } = make({ hub: async (req) => {
    calls += 1;
    assert.equal(req.clickText, '打卡记录');
    return { json: [
      { url: 'https://x/attendanceCompanion/services/attendance/card/queryCardRecord', json: [card('2026-11-06', '08:53', '19:36'), card('2026-11-07', '08:40', '08:40')] },
      { url: 'https://x/attendanceDocument/homePage/queryHolidayCalendarDetails', json: [{ holidayDate: '2026-10-01', holidayName: '法定假 国庆' }] },
    ] };
  } });
  assert.equal(svc.shouldRun(), true);
  const r = await svc.sync({ reason: 'daily' });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'hub');
  assert.equal(r.added, 2);
  const st = svc.status();
  assert.equal(st.records.length, 2);
  assert.equal(st.holidays['2026-10-01'], '法定假 国庆');
  assert.equal(svc.shouldRun(), false);
  await svc.tick();
  assert.equal(calls, 1);
});

test('Hub 窗口要登录时改用 Edge；两条都要登录时报需要登录', async () => {
  const a = make({ hub: async () => ({ needsLogin: true, json: [] }), edge: async () => ({ ok: true, via: 'edge', records: [card('2026-11-06', '08:53', '19:36')] }) });
  const r = await a.svc.sync();
  assert.equal(r.ok, true);
  assert.equal(r.via, 'edge');
  const b = make({ hub: async () => ({ needsLogin: true, json: [] }), edge: async () => ({ ok: false, needsLogin: true }) });
  const r2 = await b.svc.sync();
  assert.equal(r2.ok, false);
  assert.equal(r2.needsLogin, true);
  assert.equal(b.svc.status().records.length, 0);
});

test('失败后 1 小时内不重试，0–6 点不访问', async () => {
  const { svc, setNow } = make({ hub: async () => ({ json: [] }) });
  await svc.sync();
  assert.equal(svc.shouldRun(), false);
  setNow('2026-11-07T10:01:00');
  assert.equal(svc.shouldRun(), true);
  setNow('2026-11-08T03:00:00');
  assert.equal(svc.shouldRun(), false);
});

// 成员版内置默认域名，这条只在没有默认值的公开版里成立。
test('不知道域名时不访问，给出可操作的提示', { skip: !!require('../core/company-domain').DEFAULT_DOMAIN }, async () => {
  let called = false;
  const { svc } = make({ email: '', hub: async () => { called = true; return { json: [] }; } });
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.match(r.error, /域名/);
  assert.equal(called, false);
  svc.setSettings({ domain: 'https://corp.example/' });
  assert.equal(svc.settings().domain, 'corp.example');
});

test('漏抓几天：后一次的 8 天把早上只有上班卡的那天补全', async () => {
  let n = 0;
  const { svc, setNow } = make({ hub: async () => {
    n += 1;
    return { json: [{ url: '/queryCardRecord', json: n === 1 ? [card('2026-11-03', '09:00', '09:00')] : [card('2026-11-03', '09:00', '21:00'), card('2026-11-06', '08:50', '20:00')] }] };
  } });
  await svc.sync();
  setNow('2026-11-07T09:00:00');
  await svc.sync();
  const recs = svc.status().records;
  assert.equal(recs.find((x) => x.date === '2026-11-03').last, '21:00');
  assert.equal(recs.length, 2);
});

test('假期列表解析', () => {
  assert.deepEqual(holidaysFrom([{ holidayDate: '2026-10-02 00:00:00', holidayType: '法定假期' }, { x: 1 }]), { '2026-10-02': '法定假期' });
});

test('夜里打开考勤页可以读取，后台定时仍避开 0–6 点', () => {
  const { svc } = make({ now: '2026-11-09T02:55:00' });
  assert.equal(svc.shouldRun(), false);
  assert.equal(svc.shouldRun({ allowNight: true }), true);
});

test('考勤设置：核心工作时间可保存、可恢复默认，不合理时拒绝并说明', () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'att-wt-'));
  const svc = new (require('../core/company-attendance/service').CompanyAttendance)({ dataDir: dir, noTimer: true });
  assert.equal(svc.status().rules.owePerWorkday, 30);
  svc.setSettings({ workTime: { amStart: '08:30', amEnd: '12:00', pmStart: '13:00', pmEnd: '17:30' } });
  assert.equal(svc.settings().workTime.amStart, '08:30');
  assert.equal(svc.status().rules.owePerWorkday, 0);
  assert.throws(() => svc.setSettings({ workTime: { amStart: '13:00', amEnd: '12:00' } }), /核心工作时间不对/);
  svc.setSettings({ workTime: null });
  assert.equal(svc.settings().workTime.amStart, '09:00');
});

test('考勤设置：弹性工作制默认关，可开启、部分更新、关回默认，不合理时拒绝', () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'att-flex-'));
  const svc = new (require('../core/company-attendance/service').CompanyAttendance)({ dataDir: dir, noTimer: true });
  assert.equal(svc.settings().flex.on, false);
  assert.equal(svc.status().rules.flex, undefined);
  svc.setSettings({ flex: { on: true, coreStart: '09:30', coreEnd: '15:30' } });
  assert.equal(svc.status().rules.flex, true);
  assert.equal(svc.status().rules.coreStart, 570);
  svc.setSettings({ flex: { dailyHours: 7.5 } });
  assert.equal(svc.settings().flex.coreStart, '09:30');
  assert.equal(svc.status().rules.dailyRequired, 450);
  assert.throws(() => svc.setSettings({ flex: { coreStart: '17:00' } }), /弹性工作制设置不对/);
  svc.setSettings({ flex: null });
  assert.equal(svc.settings().flex.on, false);
});

test('OD 考勤页：正式员工页读不到时自动换 OD 页，按内容认出记录并记住', async () => {
  const urls = [];
  const { svc } = make({ hub: async (req) => {
    urls.push(req.url);
    if (/attendanceflow/.test(req.url)) return { json: [] };
    assert.equal(req.api, null);
    return { json: [
      { url: 'https://hr.corp.example/servicetime/v1/menu', json: { menus: [{ name: '我的工时' }] } },
      { url: 'https://hr.corp.example/servicetime/v1/queryMyServiceTime', json: { data: { list: [
        { workDate: '2026-11-06', firstCardTime: '2026-11-06 08:51:00', lastCardTime: '2026-11-06 20:12:00' },
        { workDate: '2026/11/7', firstCardTime: '09:02' },
      ] } } },
    ] };
  } });
  const r = await svc.sync();
  assert.equal(r.ok, true);
  assert.equal(r.page, 'servicetime');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /servicetimeflow\/#\/myServicetime$/);
  const recs = svc.status().records;
  assert.deepEqual(recs.map((x) => [x.date, x.first, x.last]), [['2026-11-06', '08:51', '20:12'], ['2026-11-07', '09:02', '09:02']]);
  assert.equal(svc.settings().lastPage, 'servicetime');
  assert.match(svc.status().url, /servicetimeflow/);
  // 第二天先试上次成功的 OD 页，一次就读到。
  urls.length = 0;
  await svc.sync();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /servicetimeflow/);
});

test('正式员工默认行为不变：第一页读到就不碰 OD 页；要登录时也不换页', async () => {
  const urls = [];
  const a = make({ hub: async (req) => { urls.push(req.url); return { json: [{ url: '/queryCardRecord', json: [card('2026-11-06', '08:53', '19:36')] }] }; } });
  assert.equal((await a.svc.sync()).page, 'attendance');
  assert.equal(urls.length, 1);
  urls.length = 0;
  const b = make({ hub: async (req) => { urls.push(req.url); return { needsLogin: true, json: [] }; } });
  const r = await b.svc.sync();
  assert.equal(r.needsLogin, true);
  assert.equal(urls.length, 1);
});

test('两页都没读到：错误写清各页结果，并列出 OD 页调过的接口路径；可在设置里指定只用某一页', async () => {
  const urls = [];
  const { svc } = make({ hub: async (req) => { urls.push(req.url); return { json: /servicetimeflow/.test(req.url) ? [{ url: 'https://hr.corp.example/ess/servicetime/getFlowData?id=1', json: { x: 1 } }] : [] }; } });
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.equal(r.triedPages, true);
  assert.match(r.error, /正式员工考勤页：.*；OD 考勤页：.*没截到打卡记录（页面接口：servicetime\/getFlowData）/);
  assert.doesNotMatch(r.error, /id=1/);
  svc.setSettings({ page: 'servicetime' });
  urls.length = 0;
  await svc.sync();
  assert.deepEqual(urls.map((u) => /servicetimeflow/.test(u)), [true]);
  svc.setSettings({ page: 'bogus' });
  assert.equal(svc.settings().page, 'auto');
});

test('OD 页地址按域名拼出', () => {
  assert.equal(attendanceUrl('corp.example', {}, 'servicetime'), 'https://hr.corp.example/apps/servicetimeflow/#/myServicetime');
});

// 2026-11-18 审查返工（r38d 审 发现 1）：排班时段不能当成打卡写进考勤，也不能因此停掉当天的抓取。
const odOnly = (captured) => make({ now: '2026-11-18T12:00:00', hub: async (req) => ({ json: /servicetimeflow/.test(req.url) ? captured : [] }) });
test('OD：只返回排班（startTime/endTime）时报读不到，不写记录、不记 OD 页、当天还会再试', async () => {
  const { svc, setNow } = odOnly([{ url: 'https://hr.corp.example/api/shift-calendar', json: { shifts: [{ workDate: '2026-11-18', startTime: '09:00', endTime: '18:00' }] } }]);
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.deepEqual(svc.status().records, []);
  assert.equal(svc.settings().lastPage, '');
  setNow('2026-11-18T13:30:00');
  assert.equal(svc.shouldRun(), true);
  // 接口名看不出是排班、字段也只有通用的 startTime/endTime、onDutyTime/offDutyTime：同样不认。
  for (const rec of [{ workDate: '2026-11-18', startTime: '09:00', endTime: '18:00' }, { date: '2026-11-18', onDutyTime: '09:00', offDutyTime: '18:00' }]) {
    const b = odOnly([{ url: 'https://hr.corp.example/servicetime/v1/queryList', json: { data: [rec] } }]);
    assert.equal((await b.svc.sync()).ok, false);
    assert.deepEqual(b.svc.status().records, []);
  }
});

test('OD：排班和打卡同时返回时只取打卡；排班字段夹在打卡接口里也不混入', async () => {
  const { svc } = odOnly([
    { url: 'https://hr.corp.example/api/shift-calendar', json: { shifts: [{ workDate: '2026-11-17', firstCardTime: '09:00', lastCardTime: '18:00' }, { workDate: '2026-11-18', firstCardTime: '09:00', lastCardTime: '18:00' }] } },
    { url: 'https://hr.corp.example/servicetime/v1/queryMyServiceTime', json: { data: {
      schedule: [{ workDate: '2026-11-16', clockInTime: '09:00', clockOutTime: '18:00' }, { workDate: '2026-11-17', clockInTime: '09:00', clockOutTime: '18:00' }, { workDate: '2026-11-18', clockInTime: '09:00', clockOutTime: '18:00' }],
      list: [{ workDate: '2026-11-17', startTime: '09:00', endTime: '18:00', clockInTime: '08:47', clockOutTime: '20:05' }],
    } } },
  ]);
  const r = await svc.sync();
  assert.equal(r.ok, true);
  assert.deepEqual(svc.status().records.map((x) => [x.date, x.first, x.last]), [['2026-11-17', '08:47', '20:05']]);
});

test('OD：认出两组互相矛盾的打卡数据时拿不准，报读不到而不是挑多的那组', async () => {
  const { svc } = odOnly([
    { url: 'https://hr.corp.example/servicetime/v1/a', json: { data: [{ workDate: '2026-11-17', firstCardTime: '08:47' }] } },
    { url: 'https://hr.corp.example/servicetime/v1/b', json: { data: [{ workDate: '2026-11-16', firstCardTime: '09:10' }, { workDate: '2026-11-17', firstCardTime: '09:30' }] } },
  ]);
  assert.equal((await svc.sync()).ok, false);
  assert.deepEqual(svc.status().records, []);
});

// 审查发现 2：路径里的工号、邮箱、令牌不能进错误信息和本机日志。
test('OD 读不到：错误和日志里不带路径中的工号、邮箱、令牌，也不带查询参数', async () => {
  const { svc } = odOnly([
    { url: 'https://hr.corp.example/api/profile/TEST-EMPLOYEE-0001?token=TEST-QUERY-SECRET', json: { ok: false } },
    { url: 'https://hr.corp.example/api/user/test.person@corp.example', json: { ok: false } },
    { url: 'https://hr.corp.example/api/session/eyJTESTTOKENabc123', json: { ok: false } },
  ]);
  const r = await svc.sync();
  assert.equal(r.ok, false);
  const persisted = JSON.stringify(svc.status().log) + fs.readFileSync(path.join(svc.dir, 'state.json'), 'utf8');
  for (const leak of ['TEST-EMPLOYEE-0001', 'TEST-QUERY-SECRET', 'test.person', 'eyJTESTTOKEN']) {
    assert.doesNotMatch(r.error, new RegExp(leak));
    assert.doesNotMatch(persisted, new RegExp(leak));
  }
  assert.match(r.error, /页面接口：profile\/\*/);
  // 取数方式自己报的错里带了完整网址或邮箱，同样只留主机名、邮箱打码。
  const b = make({ hub: async () => { throw new Error('打不开 https://hr.corp.example/u/TEST-EMPLOYEE-0002/x?sid=1，账号 test.person@corp.example'); } });
  const r2 = await b.svc.sync();
  assert.doesNotMatch(r2.error + JSON.stringify(b.svc.status().log), /TEST-EMPLOYEE-0002|sid=1|test\.person/);
  assert.match(r2.error, /hr\.corp\.example/);
});

// 二次返工：纯字母的工号、会话号、令牌也不能进错误和本机日志；按路径结构遮，不靠「含数字」判断。
test('OD 读不到：纯字母的身份、会话值同样不进错误、日志和 state.json，已知接口名照常保留', async () => {
  const { svc } = odOnly([
    { url: 'https://hr.corp.example/api/profile/TEST-EMPLOYEE-ALPHA', json: { ok: false } },
    { url: 'https://hr.corp.example/api/session/FAKE-SESSION-SECRET', json: { ok: false } },
    { url: 'https://hr.corp.example/api/zhangsanfeng/records', json: { ok: false } },
    { url: 'https://hr.corp.example/api/token/abcdefghijklmnop', json: { ok: false } },
    { url: 'https://hr.corp.example/ess/attendance/queryAttendList', json: { ok: false } },
  ]);
  const r = await svc.sync();
  assert.equal(r.ok, false);
  const persisted = JSON.stringify(svc.status().log) + fs.readFileSync(path.join(svc.dir, 'state.json'), 'utf8');
  for (const leak of ['TEST-EMPLOYEE-ALPHA', 'FAKE-SESSION-SECRET', 'zhangsanfeng', 'abcdefghijklmnop']) {
    assert.ok(!r.error.includes(leak), leak);
    assert.ok(!persisted.includes(leak), leak);
  }
  assert.match(r.error, /profile\/\*/);
  assert.match(r.error, /session\/\*/);
  assert.match(r.error, /attendance\/queryAttendList/);
});

test('apiPaths：身份名词后的段一律遮；其余段能拆成接口用词才保留', () => {
  const { apiPaths } = require('../core/company-attendance/service');
  const got = apiPaths([
    'https://h/servicetime/v1/servicetimeflow', 'https://h/api/attendanceCompanion', 'https://h/api/shift-calendar',
    'https://h/api/user/tom/records', 'https://h/x/AbCdEfGhToken', 'https://h/api/employee/queryAttendList',
  ].map((url) => ({ url })));
  assert.deepEqual(got, ['v1/servicetimeflow', 'api/attendanceCompanion', 'api/shift-calendar', '*/records', 'employee/*']);
});
