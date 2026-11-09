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
