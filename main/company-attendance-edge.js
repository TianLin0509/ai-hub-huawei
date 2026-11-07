'use strict';
// 把本机 Edge 默认用户的登录状态（Local State + Cookies + Preferences）复制到一个临时目录，用无头 Edge 打开考勤页，
// 点「打卡记录」，经调试协议截下 queryCardRecord 的 JSON 响应（最近 8 天，一天一条）。
//   - 不改用户自己的 Edge 资料，不弹窗（--headless=new + windowsHide），结束即删临时目录；
//   - 打卡明细接口的请求体是加密串，所以不自己拼请求，只让页面自己取、旁路接住。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_API = /queryCardRecord/;
const HOLIDAY_API = /queryHolidayCalendarDetails/;
const KEEP_API = /attendanceCompanion|attendanceDocument/;

function findEdge(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:/Program Files (x86)', 'C:/Program Files'].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

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

async function getJson(url) { const r = await fetch(url); return r.json(); }

const PAGE_STATE = `(() => { const t = document.body ? document.body.innerText : '';
  return { textLength: t.length, hasPassword: !!document.querySelector('input[type=password]'), hasQr: /扫码登录|二维码/.test(t.slice(0, 3000)), hasCardTab: t.includes('打卡记录') }; })()`;
const CLICK_CARD = `(() => { const els = [...document.querySelectorAll('a,button,span,div,li')].filter(e => e.childElementCount === 0 && (e.innerText || '').trim() === '打卡记录');
  if (!els.length) return false; els[0].click(); return true; })()`;

/* 返回 { ok, records, holidays, needsLogin, error, via:'edge' } */
async function captureWithEdge({ url, timeoutMs = 90000, logger = console, env = process.env } = {}) {
  const edge = findEdge(env);
  if (!edge) return { ok: false, via: 'edge', error: '本机没有找到 Edge' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-attendance-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const prof = copyProfile(tmp, env);
  let proc = null, ws = null;
  const result = { ok: false, via: 'edge', records: null, holidays: null, needsLogin: false, error: '' };
  const deadline = Date.now() + timeoutMs;
  try {
    if (!prof.copied) throw new Error(prof.error || '复制 Edge 登录状态失败');
    proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let page = null;
    for (let i = 0; i < 40 && !page; i += 1) {
      await delay(500);
      try { page = (await getJson(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === 'page'); } catch { /* 还没起来 */ }
    }
    if (!page) throw new Error('无头 Edge 没有启动');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('连接无头 Edge 失败')); });
    let id = 0;
    const pending = new Map();
    const watch = new Map();
    const send = (method, params = {}) => new Promise((resolve) => { id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
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
    };
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });
    const evalState = async () => (await send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }))?.result?.result?.value || {};
    let st = {}, clicked = false;
    while (Date.now() < deadline) {
      await delay(2000);
      st = await evalState();
      if (st.hasPassword || st.hasQr) { result.needsLogin = true; break; }
      if (!clicked && st.hasCardTab) {
        clicked = !!(await send('Runtime.evaluate', { expression: CLICK_CARD, returnByValue: true }))?.result?.result?.value;
      }
      if (result.records) { await delay(800); break; }
    }
    if (result.records) result.ok = true;
    else if (!result.needsLogin) result.error = clicked ? '打开了打卡记录，但没收到数据' : '考勤页没有出现「打卡记录」';
  } catch (e) {
    result.error = e.message;
  } finally {
    try { ws?.close(); } catch { /* 已关 */ }
    try { proc?.kill(); } catch { /* 已退 */ }
    await delay(1200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { logger.warn?.('[company-attendance] 临时目录未删净', e.code || e.message); }
  }
  return result;
}

module.exports = { captureWithEdge, findEdge, CARD_API, HOLIDAY_API, KEEP_API };
