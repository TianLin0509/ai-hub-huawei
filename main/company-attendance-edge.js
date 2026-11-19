'use strict';
// 把本机 Edge 默认用户的登录状态（Local State + Cookies + Preferences）复制到一个临时目录，用无头 Edge 打开考勤页，
// 点「打卡记录」，经调试协议截下 queryCardRecord 的 JSON 响应（最近 8 天，一天一条）。
//   - 不改用户自己的 Edge 资料，不弹窗（--headless=new + windowsHide），结束即删临时目录；
//   - 打卡明细接口的请求体是加密串，所以不自己拼请求，只让页面自己取、旁路接住。
const fs = require('fs');
const path = require('path');
const { launchHeadlessEdge, connectCdp, findEdge, markOwner, OWNER_FILE } = require('./edge-headless');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_API = /queryCardRecord/;
const HOLIDAY_API = /queryHolidayCalendarDetails/;
const KEEP_API = /attendanceCompanion|attendanceDocument/;

// findEdge / markOwner 统一放在 edge-headless.js（2026-11-19 生命周期层），这里转出给老调用方。
function copyProfile(tmp, env = process.env) {
  const src = path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  if (!fs.existsSync(src)) return { copied: 0, error: '本机没有 Edge 用户资料' };
  let copied = 0;
  const failed = [];
  for (const f of ['Local State', 'Default/Network/Cookies', 'Default/Preferences']) {
    try {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(src, f), path.join(tmp, f));
      copied += 1;
    } catch (e) { failed.push(`${f}:${e.code || e.message}`); }
  }
  return { copied, failed };
}

async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.json(); }

// 公司单点登录常先闪一下登录页再自动跳回（11-08 公司真机：一见密码框就判「需要登录」是误判），
// 所以登录页要连续停留这么久才算真的要登录。
const LOGIN_GRACE_MS = 25000;
const PAGE_STATE = `(() => { const t = document.body ? document.body.innerText : '';
  return { host: location.host, title: document.title.slice(0, 40), textLength: t.length, hasPassword: !!document.querySelector('input[type=password]'), hasQr: /扫码登录|二维码/.test(t.slice(0, 3000)), hasCardTab: t.includes('打卡记录') }; })()`;
const CLICK_CARD = `(() => { const els = [...document.querySelectorAll('a,button,span,div,li')].filter(e => e.childElementCount === 0 && (e.innerText || '').trim() === '打卡记录');
  if (!els.length) return false; els[0].click(); return true; })()`;

/* 返回 { ok, records, holidays, needsLogin, error, via:'edge' } */
async function captureWithEdge({ url, timeoutMs = 90000, loginGraceMs = LOGIN_GRACE_MS, pollMs = 2000, logger = console, env = process.env, signal = null } = {}) {
  const result = { ok: false, via: 'edge', records: null, holidays: null, needsLogin: false, error: '' };
  if (!findEdge(env)) { result.error = '本机没有找到 Edge'; return result; }
  let edge = null, cdp = null;
  try {
    // 最长运行时间 = 取数期限 + 1 分钟余量：页面卡死、调试协议没回应时由登记层按 PID 收掉整棵 Edge（2026-11-19 压测：以前会一直挂到 Hub 退出）。
    edge = await launchHeadlessEdge({ purpose: '考勤取数', tag: 'hub-attendance', env, logger, signal, maxLifeMs: timeoutMs + 60000,
      prepare: tmp => { const prof = copyProfile(tmp, env); if (!prof.copied) throw new Error(prof.error || '复制 Edge 登录状态失败'); } });
    const deadline = Date.now() + timeoutMs;
    let page = null;
    for (let i = 0; i < 20 && !page; i += 1) {
      try { page = (await getJson(`http://127.0.0.1:${edge.port}/json/list`)).find((t) => t.type === 'page'); } catch { /* 还没起来 */ }
      if (!page) await delay(300);
    }
    if (!page) throw new Error('无头 Edge 没有启动');
    const watch = new Map();
    let send = null;
    cdp = await connectCdp(page.webSocketDebuggerUrl, { onEvent: async (m) => {
      if (m.method === 'Network.responseReceived') {
        const u = String(m.params.response?.url || '');
        if (KEEP_API.test(u) && /json/i.test(m.params.response?.mimeType || '')) watch.set(m.params.requestId, u);
      } else if (m.method === 'Network.loadingFinished' && watch.has(m.params.requestId)) {
        const u = watch.get(m.params.requestId); watch.delete(m.params.requestId);
        const b = await send('Network.getResponseBody', { requestId: m.params.requestId });
        try {
          const text = b.result.base64Encoded ? Buffer.from(b.result.body, 'base64').toString('utf8') : b.result.body;
          const json = JSON.parse(text);
          if (CARD_API.test(u)) result.records = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : null);
          if (HOLIDAY_API.test(u)) result.holidays = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : null);
        } catch { /* 不是 JSON */ }
      }
    } });
    send = cdp.send;
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    let st = {}, clicked = false, loginSince = 0, stuck = 0;
    while (Date.now() < deadline) {
      await delay(pollMs);
      if (signal?.aborted) { result.error = '已取消'; break; }
      if (cdp.closed || edge.closed) { result.error = '和无头 Edge 的连接断了'; break; }
      const raw = await send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true });
      if (raw?.timeout) { stuck += 1; if (stuck >= 3) { result.error = '考勤页没有响应（页面卡住）'; break; } continue; }
      stuck = 0;
      st = raw?.result?.result?.value || {};
      if (st.hasPassword || st.hasQr) {
        loginSince = loginSince || Date.now();
        if (Date.now() - loginSince >= loginGraceMs) { result.needsLogin = true; result.error = `需要登录（停在 ${st.host || '登录页'}）`; break; }
        continue;
      }
      loginSince = 0;
      if (!clicked && st.hasCardTab) {
        clicked = !!(await send('Runtime.evaluate', { expression: CLICK_CARD, returnByValue: true }))?.result?.result?.value;
      }
      if (result.records) { await delay(800); break; }
    }
    if (result.records) { result.ok = true; result.error = ''; }
    else if (result.error) { /* 已写明原因 */ }
    else if (!result.needsLogin && loginSince) { result.needsLogin = true; result.error = `需要登录（停在 ${st.host || '登录页'}）`; }
    else if (!result.needsLogin) result.error = clicked ? '打开了打卡记录，但没收到数据' : '考勤页没有出现「打卡记录」';
  } catch (e) {
    result.error = e.message;
  } finally {
    // 按进程号结束整棵 Edge 进程树（只动自己启动的这一个）并删临时目录（登录状态副本）。
    cdp?.close();
    if (edge) await edge.close();
  }
  return result;
}

module.exports = { captureWithEdge, findEdge, copyProfile, markOwner, OWNER_FILE, CARD_API, HOLIDAY_API, KEEP_API, LOGIN_GRACE_MS };
