'use strict';
// 公司域名自动查找（2026-11-08）：考勤第一步不能报「不知道公司域名」。成员版内置默认域名，公开版没有默认、靠设置和 WeLink。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../core/company-domain');
const { CompanyAttendance } = require('../core/company-attendance/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-domain-'));
const put = (dir, rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };

test('什么都没配：有内置默认就直接用默认', () => {
  const dir = tmp();
  assert.equal(D.knownDomain(dir).domain, D.DEFAULT_DOMAIN);
  if (D.DEFAULT_DOMAIN) assert.equal(D.knownDomain(dir).from, 'default');
});

test('本机设置优先于默认：助理邮箱 > 论坛设置；公共邮箱不算', () => {
  const dir = tmp();
  assert.ok(D.PUBLIC_MAIL.test('outlook.com') && D.PUBLIC_MAIL.test('gmail.com'));
  put(dir, 'company-forum/settings.json', { domain: 'corp.example' });
  assert.deepEqual(D.knownDomain(dir), { domain: 'corp.example', from: 'forum-settings' });
  put(dir, 'company-assistant/settings.json', { email: 'me@acme.example' });
  assert.deepEqual(D.knownDomain(dir), { domain: 'acme.example', from: 'assistant-email' });
});

test('旧版按 git 邮箱记下的域名不再采信', () => {
  const dir = tmp();
  put(dir, 'company-domain.json', { domain: 'school.example', from: 'git' });
  assert.notEqual(D.knownDomain(dir).domain, 'school.example');
});

test('考勤：什么都没配也能直接去读', async () => {
  const dir = tmp();
  const urls = [];
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true, lookupEmail: async () => ({ email: 'me@corp.example', from: 'welink' }),
    edgeCapture: async ({ url }) => { urls.push(url); return { ok: true, via: 'edge', records: [] }; } });
  const e = await svc.sync();
  assert.equal(e.ok, true);
  assert.match(urls[0], new RegExp('^https://hr\.' + (D.DEFAULT_DOMAIN || 'corp.example').replace(/\./g, '\.') + '/'));
});

test('考勤：填邮箱或域名都能存成域名；旧版域名失败记录打开即重试', () => {
  const dir = tmp();
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true });
  assert.equal(svc.setSettings({ domain: 'Me@Corp.Example' }).domain, 'corp.example');
  put(dir, 'company-attendance/state.json', { lastAttemptAt: new Date().toISOString(), lastResult: { ok: false, error: '还不知道公司域名：请在考勤设置里填写' } });
  assert.equal(svc.shouldRun(), new Date().getHours() >= 6);
});
