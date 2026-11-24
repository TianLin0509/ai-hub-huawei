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

// 2026-11-20 反馈：合作方邮箱的同事在 5.6.65 上两个考勤页都报 ERR_NAME_NOT_RESOLVED。
// 公司电脑实测 hr.<合作方域名> 解析不到、hr.<主域名> 正常：按邮箱推出的合作方域名要换成主域名。
test('合作方邮箱：考勤、门户等内网地址用公司主域名，不用邮箱域名', { skip: !D.DEFAULT_DOMAIN }, async () => {
  const partner = [...D.PARTNER_MAIL][0];
  assert.equal(D.companyDomainOf(`someone@${partner}`), D.DEFAULT_DOMAIN);
  assert.equal(D.siteDomain(partner.toUpperCase()), D.DEFAULT_DOMAIN);
  assert.equal(D.siteDomain('acme.example'), 'acme.example');
  const dir = tmp();
  put(dir, 'company-domain.json', { domain: partner, from: 'welink' });          // 旧版本按 WeLink 邮箱记下的
  assert.equal(D.knownDomain(dir).domain, D.DEFAULT_DOMAIN);
  // 考勤：助理邮箱、手填的旧值都纠正，读取地址拼在主域名上
  const urls = [];
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true, accountEmail: () => `someone@${partner}`,
    edgeCapture: async ({ url }) => { urls.push(url); return { ok: true, via: 'edge', records: [] }; } });
  assert.equal(svc.settings().domain, D.DEFAULT_DOMAIN);
  svc.setSettings({ domain: `someone@${partner}` });
  assert.equal(svc.settings().domain, D.DEFAULT_DOMAIN);
  await svc.sync();
  assert.equal(new URL(urls[0]).hostname, `hr.${D.DEFAULT_DOMAIN}`);
});

test('考勤地址解析不到：不来回换页，说清是没连内网还是域名不对，并标出要就地改域名', async () => {
  const dir = tmp();
  const urls = [];
  const svc = new CompanyAttendance({ dataDir: dir, noTimer: true, accountEmail: () => 'someone@corp.example',
    browser: { capture: async ({ url }) => { urls.push(url); throw new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${url}'`); } } });
  const e = await svc.sync();
  assert.equal(e.ok, false);
  assert.equal(e.dnsFail, true);
  assert.equal(e.triedPages, false);
  assert.equal(e.needsDomain, undefined);                 // 不触发「找到域名就立刻重试」，免得每次定时都去撞
  assert.match(e.error, /hr\.corp\.example.*解析不到.*内网.*域名不对/);
  assert.doesNotMatch(e.error, /ERR_NAME|loading|https?:/);
  assert.equal(urls.length, 2);                           // 两个考勤页各试一次
});

test('子公司邮箱域名（hisilicon.com）也换成主域名，旧缓存与手填值一并纠正', () => {
  assert.ok(D.PARTNER_MAIL.has('hisilicon.com'));
  const sub = 'hisilicon.com';
  assert.equal(D.companyDomainOf(['someone', sub].join('@')), D.DEFAULT_DOMAIN);
  assert.equal(D.siteDomain('HiSilicon.com'), D.DEFAULT_DOMAIN);
});
