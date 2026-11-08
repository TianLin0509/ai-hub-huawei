'use strict';
// 公司域名自动查找（2026-11-08）：用户没在助理设置里存邮箱时，考勤第一步就报「不知道公司域名」，要求不能一出门就错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../core/company-domain');
const { CompanyAttendance } = require('../core/company-attendance/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-domain-'));
const put = (dir, rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };

test('本机文件依次找：助理邮箱、论坛设置；公共邮箱不算', () => {
  const dir = tmp();
  assert.equal(D.knownDomain(dir).domain, '');
  assert.ok(D.PUBLIC_MAIL.test('outlook.com') && D.PUBLIC_MAIL.test('gmail.com'));
  put(dir, 'company-forum/settings.json', { domain: 'corp.example' });
  assert.deepEqual(D.knownDomain(dir), { domain: 'corp.example', from: 'forum-settings' });
  put(dir, 'company-assistant/settings.json', { email: 'me@acme.example' });
  assert.deepEqual(D.knownDomain(dir), { domain: 'acme.example', from: 'assistant-email' });
});

test('本机找不到时问 WeLink，再问 git，找到就记下', async () => {
  const dir = tmp();
  let gitCalls = 0;
  const r = await D.resolveDomain(dir, { lookupEmail: async () => ({ email: '' }), gitEmail: () => { gitCalls++; return 'me@corp.example'; } });
  assert.deepEqual(r, { domain: 'corp.example', from: 'git' });
  assert.equal(gitCalls, 1);
  assert.equal(D.knownDomain(dir).domain, 'corp.example');
  const again = await D.resolveDomain(dir, { gitEmail: () => { gitCalls++; return ''; } });
  assert.equal(again.domain, 'corp.example');
  assert.equal(gitCalls, 1);
});

test('考勤：什么都没配也能自己找到域名并去读', async () => {
  const dir = tmp();
  const urls = [];
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true, lookupEmail: async () => ({ email: 'me@corp.example', from: 'welink' }),
    edgeCapture: async ({ url }) => { urls.push(url); return { ok: true, via: 'edge', records: [] }; } });
  assert.equal(svc.settings().domain, '');
  const e = await svc.sync();
  assert.equal(e.ok, true);
  assert.match(urls[0], /^https:\/\/hr\.corp\.example\//);
  assert.equal(svc.settings().domainFrom, 'welink');
});

test('考勤：实在找不到时给出能直接照做的提示，填邮箱即可', async () => {
  const dir = tmp();
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true, lookupEmail: async () => '', gitEmail: () => '' });
  const e = await svc.sync();
  assert.equal(e.ok, false);
  assert.equal(e.needsDomain, true);
  assert.match(e.error, /公司邮箱/);
  assert.equal(svc.setSettings({ domain: 'Me@Corp.Example' }).domain, 'corp.example');
  assert.equal(svc.shouldRun(), new Date().getHours() >= 6);
});
