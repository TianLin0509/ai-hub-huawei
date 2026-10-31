'use strict';
// 一键反馈的主进程部分（2026-10-29）：界面点「一键反馈」→ 预览要发哪些内容 → 发送到自家阿里云。
// 被公司网络放行页拦住时，自动在看不见的窗口里放行一次再重发（core/net-unblock.js，只对自家地址）。
// 发不出去就把同一份内容存到「下载」文件夹，界面告诉用户文件在哪，可以手动发给维护人。
const fs = require('node:fs');
const path = require('node:path');
const { collectBundle } = require('../core/hub-feedback');
const { looksLikeWebPage } = require('../core/app-update/downloader');

const SEND_TIMEOUT_MS = 30000;

// 同一张页常要点 2–3 次、隔 20–30 秒才通过。所以点一次后按这个间隔重发，还被拦就再点，最多点 3 次（约 2 分钟）。
const RETRY_AFTER_CLICK_MS = [2000, 6000, 15000];
const MAX_CLICKS = 3;

function createHubFeedbackService({ endpoint, info, logsDir, fetchImpl, unblock = null, onPassed = () => {}, downloadsDir, now = () => Date.now(), logger = console,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {}, windowPost = null }) {
  const fetchFn = fetchImpl || ((...args) => require('electron').net.fetch(...args));

  // 发送过程记在 logs/hub-feedback.log，被拦时的页面存成 hub-feedback-<途径>-sample.html（只留前 200 KB），下次一键反馈会随诊断包带上。
  function logEvent(entry) {
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(path.join(logsDir, 'hub-feedback.log'), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n'); } catch {}
  }
  function saveSample(via, html) {
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.writeFileSync(path.join(logsDir, `hub-feedback-${via}-sample.html`), Buffer.from(String(html), 'utf8').subarray(0, 200 * 1024)); } catch {}
  }

  function preview({ description = '', contact = '' } = {}) {
    const b = collectBundle({ info: info(), description, contact, logsDir, now: now() });
    return { ok: true, available: !!endpoint, items: b.items, chars: b.chars };
  }

  async function post(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetchFn(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const type = res.headers && res.headers.get ? res.headers.get('content-type') : '';
      const raw = await res.text();
      if (looksLikeWebPage(type, Buffer.from(raw.slice(0, 256)))) {
        // 被拦时返回的是什么页，存一份样本、记一行日志（之前只知道「是网页」，查不出是放行页还是别的拦截）。
        const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1];
        logEvent({ via: 'fetch', status: res.status, type: String(type || ''), bytes: raw.length, title: title ? title.trim().slice(0, 120) : null, sent: JSON.stringify(body).length });
        saveSample('fetch', raw);
        return { ok: false, blocked: true, reason: '被公司网络的放行页拦住' };
      }
      let json = null; try { json = JSON.parse(raw); } catch {}
      if (res.ok && json && json.ok) return { ok: true, id: json.id };
      return { ok: false, reason: (json && json.error && json.error.message) || `服务器返回 ${res.status}` };
    } catch (error) {
      return { ok: false, reason: ctl.signal.aborted ? `${SEND_TIMEOUT_MS / 1000} 秒内没发出去` : error.message };
    } finally { clearTimeout(timer); }
  }

  function saveLocal(text) {
    try {
      const dir = downloadsDir();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15);
      const file = path.join(dir, `AIHub-反馈-${stamp}.txt`);
      fs.writeFileSync(file, text, 'utf8');
      return file;
    } catch (error) { logger.warn?.('[hub-feedback] 本地保存失败：', error.message); return null; }
  }

  async function send({ description = '', contact = '', onProgress: progress = onProgress } = {}) {
    if (!String(description).trim()) return { ok: false, reason: '请先写一句遇到了什么问题' };
    const i = info();
    const b = collectBundle({ info: i, description, contact, logsDir, now: now() });
    if (!endpoint) return { ok: false, reason: '这个版本没有配置反馈地址', savedTo: saveLocal(b.text) };
    const body = { text: b.text, summary: b.summary, version: String(i.version || ''), edition: String(i.edition || ''), platform: String(i.platform || ''), contact: String(contact || '') };
    let r = await post(body);
    for (let click = 1; !r.ok && r.blocked && unblock && click <= MAX_CLICKS; click++) {
      progress({ phase: 'unblocking', click, maxClicks: MAX_CLICKS });
      let passed = false;
      try { passed = await unblock(endpoint); } catch (error) { logger.warn?.('[hub-feedback] 自动放行出错：', error.message); }
      if (!passed) break; // 没点到按钮（或放行器在冷却）：再点也没用
      for (const wait of RETRY_AFTER_CLICK_MS) {
        await sleep(wait);
        progress({ phase: 'retrying', click, maxClicks: MAX_CLICKS });
        r = await post(body);
        if (r.ok || !r.blocked) break;
      }
    }
    // 还被拦：改在看不见的窗口里直接提交（2026-10-30 公司真机：放行页的 GET 已放行、只拿到自家页面，提交的 POST 仍被拦成网页）。
    // 拦截页就出现在这个窗口里：点了放行就隔一会儿再交，最多点 MAX_CLICKS 次。
    for (let click = 1; !r.ok && r.blocked && windowPost && click <= MAX_CLICKS + 1; click++) {
      progress({ phase: 'window', click, maxClicks: MAX_CLICKS });
      let w;
      try { w = await windowPost(endpoint, body); } catch (error) { w = { error: error.message }; }
      logEvent({ via: 'window', try: click, status: w?.status ?? null, title: w?.title || null, clicked: !!w?.clicked, button: w?.text || null,
        ok: !!(w?.json && w.json.ok), error: w?.error || (w?.json && !w.json.ok ? (w.json.error && w.json.error.message) || 'not-ok' : null),
        candidates: w?.json || w?.clicked ? undefined : (w?.candidates || []).slice(0, 10) });
      if (w?.json) {
        r = w.json.ok ? { ok: true, id: w.json.id } : { ok: false, reason: (w.json.error && w.json.error.message) || '服务器没收下' };
        break;
      }
      if (w?.html) saveSample('window', w.html);
      if (!w?.clicked) break; // 窗口里也没有放行按钮：再试没用
      if (click <= MAX_CLICKS) await sleep(RETRY_AFTER_CLICK_MS[Math.min(click, RETRY_AFTER_CLICK_MS.length) - 1]);
    }
    if (r.ok) { try { onPassed(); } catch {} }
    if (r.ok) return { ok: true, id: r.id, chars: b.chars };
    return { ok: false, reason: r.reason, savedTo: saveLocal(b.text) };
  }

  return { preview, send };
}

function registerHubFeedbackIpc(ipcMain, service) {
  ipcMain.handle('hub-feedback:preview', (_e, payload) => service.preview(payload || {}));
  ipcMain.handle('hub-feedback:send', (e, payload) => service.send({ ...(payload || {}), onProgress: p => { try { e.sender.send('hub-feedback:progress', p); } catch {} } }));
}

module.exports = { createHubFeedbackService, registerHubFeedbackIpc };
