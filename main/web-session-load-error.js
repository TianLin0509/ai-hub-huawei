'use strict';

// 只识别顶层页面的访问异常，不把登录跳转或验证页当成公司拦截。
const SITE_DOMAINS = {
  chatgpt: ['chatgpt.com', 'openai.com'], gemini: ['google.com', 'gstatic.com', 'youtube.com'],
  // 国内站别名沿用 hub-browser-routing.js / web-sessions.js 已记录的官方域名。
  deepseek: ['deepseek.com'], kimi: ['kimi.com', 'kimi.ai', 'moonshot.cn', 'moonshot.ai'],
  qwen: ['qianwen.com', 'tongyi.com', 'aliyun.com', 'taobao.com'], doubao: ['doubao.com', 'bytedance.com'],
  glm: ['chatglm.cn', 'zhipuai.cn', 'bigmodel.cn'], minimax: ['minimaxi.com', 'minimax.io', 'minimax.chat', 'minimax.cn'],
};
// 与 web-sessions.js 的 AUTH_HOST 同一口径：passport.* / login.* / auth.* 这类第三方登录（抖音、支付宝、企业 SSO）都不算跳走。
const LOGIN_HOST = /(^|\.)(accounts\.google\.com|auth\.openai\.com|auth0\.openai\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com|open\.weixin\.qq\.com|graph\.qq\.com|passport\.[\w.-]+|login\.[\w.-]+|auth\.[\w.-]+|[\w-]+\.okta\.com|[\w.-]*alipay\.com|[\w.-]*douyin\.com)$/i;
const VERIFY_HOST = /^(challenges\.cloudflare\.com|(?:[\w-]+\.)?hcaptcha\.com|(?:[\w-]+\.)?recaptcha\.net)$/i;
const within = (host, domain) => host === domain || host.endsWith('.' + domain);

function destinationError(site, target, url) {
  let current, expected;
  try { current = new URL(url); expected = new URL(target); } catch { return ''; }
  if (!['http:', 'https:'].includes(current.protocol)) return '';
  if (/\/proxycontrolwarn\//i.test(current.pathname)) {
    return `公司网络拦截了 ${expected.hostname}，换绿区电脑或稍后重试。`;
  }
  if (current.origin === expected.origin || (current.protocol === 'https:' &&
      ((SITE_DOMAINS[site] || []).some(domain => within(current.hostname, domain)) ||
       LOGIN_HOST.test(current.hostname) || VERIFY_HOST.test(current.hostname)))) return '';
  return `${expected.hostname} 跳到了其他网站，可能被网络拦截；换绿区电脑或稍后重试。`;
}

function loadError(target, code, description = '') {
  if (code === -3 || code === 'ERR_ABORTED') return '';
  const host = new URL(target).hostname;
  // net 错误只能说明连接在哪一步失败，不凭代理失败断言公司封禁。
  const raw = `${code} ${description}`;
  if (code === -111 || code === -130 || /ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)/.test(raw))
    return `代理连接失败，无法打开 ${host}；检查网络或换绿区电脑重试。`;
  if (code === -105 || /ERR_NAME_NOT_RESOLVED/.test(raw))
    return `找不到 ${host} 的地址，请检查网络后重试。`;
  if (code === -7 || code === -118 || /ERR_(CONNECTION_)?TIMED_OUT/.test(raw))
    return `${host} 连接超时，请检查网络或稍后重试。`;
  if ((typeof code === 'number' && code <= -200 && code > -300) || /ERR_(CERT_|SSL_)/.test(raw))
    return `${host} 的安全连接未通过，请联系网络管理员或换绿区电脑重试。`;
  return `无法连接 ${host}，请检查网络或稍后重试。`;
}

module.exports = { destinationError, loadError };
