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

// 自家服务的根地址（https://主机）：一键反馈等「会写数据」的服务只在主服务器上，取第一个不是镜像（mirror: true）的自家源。
// 高速下载镜像（2026-11-07）只放只读的下载文件，排在更新源第一位，但反馈不能投到那里。
function ownOrigin(config) {
  const sources = config && Array.isArray(config.sources) ? config.sources : [];
  const pick = list => list.flatMap(s => [s && s.manifest, s && s.files]).find(u => typeof u === 'string' && /^https?:\/\//i.test(u) && !FOREIGN.test(hostOf(u)));
  const url = pick(sources.filter(s => s && !s.mirror)) || pick(sources);
  return url ? originOf(url) : '';
}

// 放行用的页面：自家服务上一张固定标题的小网页（标题「AI HUB 服务」，见 net-unblock 的 OWN_PAGE_TITLES）。
// 给了被拦的网址就用那台主机自己的放行页（公司代理按主机放行，每台都要点一次）；没给就用主服务器的。
function unblockPage(config, url) {
  const origin = url && isOwnUrl(url, config) ? originOf(url) : ownOrigin(config);
  return origin ? origin + '/hub-update/api/feedback' : '';
}

// 所有自家下载主机：放行按钮逐台放行、逐台显示结果。name 取更新源里的名字。
function downloadHosts(config) {
  const sources = config && Array.isArray(config.sources) ? config.sources : [];
  const out = [];
  for (const s of sources) {
    const url = [s && s.manifest, s && s.files].find(u => typeof u === 'string' && /^https?:\/\//i.test(u));
    const host = hostOf(url);
    if (!host || FOREIGN.test(host) || out.some(h => h.host === host)) continue;
    out.push({ host, name: String(s.name || host), origin: originOf(url), page: originOf(url) + '/hub-update/api/feedback', mirror: !!s.mirror });
  }
  return out;
}

function feedbackEndpoint(config) {
  const origin = ownOrigin(config);
  return origin ? origin + '/hub-update/api/feedback/submit' : '';
}

module.exports = { ownHosts, isOwnUrl, ownOrigin, unblockPage, downloadHosts, feedbackEndpoint, hostOf };
