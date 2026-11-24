'use strict';
// 公司域名（2026-11-08）：考勤、论坛等功能拼内网地址都要它。用户不该为此手动填写，按下面顺序自动找，找到一处就记下，
// 之后各功能共用（数据目录 company-domain.json）：
//   1. 之前自动找到并记下的；
//   2. 助理页设置里的本人邮箱；
//   3. 论坛设置里填过的域名；
//   4. 内置的默认公司域名（同一家公司大家都一样，开箱即用）；
//   5. 没有默认值的版本，现场问 WeLink 账号信息（助理服务的 accountEmail）。
// 不用 git 邮箱：很多人的 git 邮箱是学校或个人邮箱，会推错。
// 公共邮箱（gmail、outlook、qq 等）的域名不算公司域名。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { domainFromEmail, normalizeDomain } = require('./company-forum/sites');

const PUBLIC_MAIL = /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|msn\.com|icloud\.com|me\.com|yahoo\.com|qq\.com|foxmail\.com|163\.com|126\.com|yeah\.net|sina\.com|sina\.cn|sohu\.com|aliyun\.com|139\.com|proton\.me|protonmail\.com|users\.noreply\.github\.com)$/i;
const CACHE = 'company-domain.json';
// 和 AgentCenter 技能安装用的同一个内网地址取域名（这个地址已在成员版放行清单里）。
const DEFAULT_DOMAIN = new URL('https://agent.huawei.com/').hostname.split('.').slice(-2).join('.');

// 合作方员工的邮箱域名（2026-11-20 反馈：5.6.65 两个考勤页都报 ERR_NAME_NOT_RESOLVED）：邮箱挂在合作方域名下，
// 但考勤、论坛、门户这些内网站点只在公司主域名下。公司电脑实测：hr.<合作方域名> 解析不到，hr.<主域名> 正常。
// 按邮箱推出这类域名时一律换成主域名；用户手填的也照此纠正（以前存下的错值不用再去设置里改）。
// 2026-11-24 反馈：子公司员工邮箱在 hisilicon.com 下，门户被拼成 w3.hisilicon.com 打不开；同样换成主域名。
const PARTNER_MAIL = new Set(['h-partners.com', 'hisilicon.com']);
function siteDomain(d) { const n = normalizeDomain(d); return n && DEFAULT_DOMAIN && PARTNER_MAIL.has(n) ? DEFAULT_DOMAIN : n; }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function companyDomainOf(email) { const d = domainFromEmail(email); return d && !PUBLIC_MAIL.test(d) ? siteDomain(d) : ''; }

// 只读本机文件，不起进程，可在界面刷新时随便调。
function knownDomain(dataDir) {
  const cached = readJson(path.join(dataDir, CACHE), {});
  // 5.5.44 曾按 git 邮箱推过域名，可能推错，不再采信。
  if (siteDomain(cached.domain) && cached.from !== 'git') return { domain: siteDomain(cached.domain), from: cached.from || 'cache' };
  const email = readJson(path.join(dataDir, 'company-assistant', 'settings.json'), {}).email;
  if (companyDomainOf(email)) return { domain: companyDomainOf(email), from: 'assistant-email' };
  const forum = siteDomain(readJson(path.join(dataDir, 'company-forum', 'settings.json'), {}).domain);
  if (forum) return { domain: forum, from: 'forum-settings' };
  if (DEFAULT_DOMAIN) return { domain: DEFAULT_DOMAIN, from: 'default' };
  return { domain: '', from: '' };
}

function gitGlobalEmail() {
  try {
    const r = spawnSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch { return ''; }
}

let pending = null;
// 本机文件找不到时再问 WeLink、git；找到就记下。同一时间只跑一次。
function resolveDomain(dataDir, { lookupEmail, gitEmail = null } = {}) {
  const known = knownDomain(dataDir);
  if (known.domain) return Promise.resolve(known);
  if (pending) return pending;
  pending = (async () => {
    const sources = [['welink', lookupEmail], ['git', gitEmail]];
    for (const [from, fn] of sources) {
      if (typeof fn !== 'function') continue;
      let email = '';
      try { const r = await fn(); email = typeof r === 'string' ? r : r?.email || ''; } catch { email = ''; }
      const domain = companyDomainOf(email);
      if (domain) {
        try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, CACHE), JSON.stringify({ domain, from, at: new Date().toISOString() }, null, 1)); } catch { /* 下次再找 */ }
        return { domain, from };
      }
    }
    return { domain: '', from: '' };
  })().finally(() => { pending = null; });
  return pending;
}

module.exports = { knownDomain, resolveDomain, companyDomainOf, siteDomain, gitGlobalEmail, PUBLIC_MAIL, PARTNER_MAIL, DEFAULT_DOMAIN };
