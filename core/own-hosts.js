'use strict';
// 自家服务的地址（2026-10-29）：一键更新配置里不是 GitHub 的那个下载源，就是自家阿里云。
// 公司网络放行页自动点击（core/net-unblock.js）只对这些主机生效；一键反馈也提交到同一台主机。
// 地址全部从发行版的更新配置推出来，不另写网址：没有更新配置的发行版（主仓库）就没有自家服务。
const FOREIGN = /(^|\.)(github\.com|githubusercontent\.com|github\.io)$/i;

function hostOf(url) { try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; } }
function originOf(url) { try { return new URL(String(url)).origin; } catch { return ''; } }

function updateUrls(config) {
  const sources = config && Array.isArray(config.sources) ? config.sources : [];
  return sources.flatMap(s => [s && s.manifest, s && s.files]).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
}

// 自家主机名单（小写 host）。
function ownHosts(config) {
  return [...new Set(updateUrls(config).map(hostOf).filter(h => h && !FOREIGN.test(h)))];
}

function isOwnUrl(url, config) {
  const host = hostOf(url);
  return !!host && ownHosts(config).includes(host);
}

// 自家服务的根地址（https://主机），取第一个自家下载源。
function ownOrigin(config) {
  const url = updateUrls(config).find(u => !FOREIGN.test(hostOf(u)));
  return url ? originOf(url) : '';
}

// 放行用的页面：自家服务上一张固定标题的小网页（标题「AI HUB 服务」，见 net-unblock 的 OWN_PAGE_TITLES）。
function unblockPage(config) {
  const origin = ownOrigin(config);
  return origin ? origin + '/hub-update/api/feedback' : '';
}

function feedbackEndpoint(config) {
  const origin = ownOrigin(config);
  return origin ? origin + '/hub-update/api/feedback/submit' : '';
}

module.exports = { ownHosts, isOwnUrl, ownOrigin, unblockPage, feedbackEndpoint, hostOf };
