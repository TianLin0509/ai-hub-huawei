'use strict';
async function probePage(url, { fetchImpl, timeoutMs = 6500 } = {}) {
  if (!url) return { status: 'bad', detail: '没有可检测的考勤地址' };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    let text = '', bytes = 0;
    if (r.body) {
      const reader = r.body.getReader();
      try {
        while (bytes < 8192) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; text += Buffer.from(chunk.value).toString('utf8'); }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const final = new URL(r.url || url);
    const blocked = /\bHIS Proxy Notification\b/.test(text);
    const login = /(?:^|[.-])(?:sso|login|signin|idp|auth)(?:[.-]|$)/i.test(final.hostname)
      || /(?:^|\/)(?:sso|login|signin|oauth2?|authorize|cas\/login|auth)(?:[/.;]|$)/i.test(final.pathname);
    return { status: blocked || !r.ok || login ? 'bad' : 'ok', detail: blocked ? '考勤页面被网络策略拦截' : login ? '考勤页面跳转到登录，需要完成登录后重试' : `考勤页面 HTTP ${r.status}`,
      fingerprint: { host: final.hostname, path: final.pathname, status: r.status, blocked, login,
        feature: blocked ? '网络拦截页' : login ? '登录页' : '业务页' } };
  } finally { clearTimeout(timer); ac.abort(); }
}
function attendanceFetch(session) {
  const authenticated = session.fromPartition('persist:company-forum');
  return (...args) => authenticated.fetch(...args);
}
module.exports = { probePage, attendanceFetch };
