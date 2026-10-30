'use strict';
// 一键反馈的主进程部分（2026-10-29）：界面点「一键反馈」→ 预览要发哪些内容 → 发送到自家阿里云。
// 被公司网络放行页拦住时，自动在看不见的窗口里放行一次再重发（core/net-unblock.js，只对自家地址）。
// 发不出去就把同一份内容存到「下载」文件夹，界面告诉用户文件在哪，可以手动发给维护人。
const fs = require('node:fs');
const path = require('node:path');
const { collectBundle } = require('../core/hub-feedback');
const { looksLikeWebPage } = require('../core/app-update/downloader');

const SEND_TIMEOUT_MS = 30000;

function createHubFeedbackService({ endpoint, info, logsDir, fetchImpl, unblock = null, downloadsDir, now = () => Date.now(), logger = console }) {
  const fetchFn = fetchImpl || ((...args) => require('electron').net.fetch(...args));

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
      if (looksLikeWebPage(type, Buffer.from(raw.slice(0, 256)))) return { ok: false, blocked: true, reason: '被公司网络的放行页拦住' };
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

  async function send({ description = '', contact = '' } = {}) {
    if (!String(description).trim()) return { ok: false, reason: '请先写一句遇到了什么问题' };
    const i = info();
    const b = collectBundle({ info: i, description, contact, logsDir, now: now() });
    if (!endpoint) return { ok: false, reason: '这个版本没有配置反馈地址', savedTo: saveLocal(b.text) };
    const body = { text: b.text, summary: b.summary, version: String(i.version || ''), edition: String(i.edition || ''), platform: String(i.platform || ''), contact: String(contact || '') };
    let r = await post(body);
    if (!r.ok && r.blocked && unblock) {
      let passed = false;
      try { passed = await unblock(endpoint); } catch (error) { logger.warn?.('[hub-feedback] 自动放行出错：', error.message); }
      if (passed) r = await post(body);
    }
    if (r.ok) return { ok: true, id: r.id, chars: b.chars };
    return { ok: false, reason: r.reason, savedTo: saveLocal(b.text) };
  }

  return { preview, send };
}

function registerHubFeedbackIpc(ipcMain, service) {
  ipcMain.handle('hub-feedback:preview', (_e, payload) => service.preview(payload || {}));
  ipcMain.handle('hub-feedback:send', (_e, payload) => service.send(payload || {}));
}

module.exports = { createHubFeedbackService, registerHubFeedbackIpc };
