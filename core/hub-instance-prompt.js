'use strict';

// 多开 Hub 提示（体验 7，2026-11-20）。
// 多开是产品约定（main-bootstrap.js 顶部注释：不加单实例锁），这里不禁止，只在「已经有一个 Hub 在跑」时
// 问一句「已在运行，切过去？」：点「切过去」就让那个 Hub 把窗口拉到最前，本实例退出；点「再开一个」照常用。
//
// 怎么知道有别的 Hub 在跑：每个 Hub 启动后都在 <dataDir>/control/<pid>.json 写自己的 hookPort 和令牌
// （core/hub-control.js，救援脚本也靠它）。进程还活着只是第一关——更新重启、远程重启时老进程可能还在收尾，
// 所以再经它的本机 hook 端口问一声（/api/instance-focus，带它自己的令牌）：答得上、且没在退出，才算「在运行」。
// 任何一步出错都按「没有别的 Hub」处理：这个提示是锦上添花，不能挡住 Hub 打开。

const fs = require('fs');
const path = require('path');
const http = require('http');
const hubControl = require('./hub-control');

const ROUTE = '/api/instance-focus';

// 只列比自己先启动的实例：两个 Hub 几乎同时打开时不会互相弹窗、两边都点「切过去」后都退出（复审补点）。
function listOtherInstances({ dataDir, selfPid = process.pid, isAlive = hubControl._isPidAlive, selfStartedAt = Date.now() - process.uptime() * 1000 } = {}) {
  const dir = hubControl.controlDir(dataDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const pid = Number(info.pid);
      if (!pid || pid === selfPid || !info.hookPort || !info.token) continue;
      if (!isAlive(pid)) continue;
      const startedAt = Number(info.startedAt) || 0;
      if (startedAt && selfStartedAt && startedAt >= selfStartedAt) continue;
      out.push({ pid, hookPort: Number(info.hookPort), token: String(info.token), startedAt });
    } catch (_) { /* 半写或坏文件：跳过 */ }
  }
  // 先开的排前面：用户说的「已经在运行的那个」通常是最早打开的。
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function callInstance(instance, action, { timeoutMs = 1500, request = http.request } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const body = JSON.stringify({ token: instance.token, action });
    let req;
    try {
      req = request({ host: '127.0.0.1', port: instance.hookPort, path: ROUTE, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (text.length < 4096) text += c; });
        // 对方回到一半断开（进程正好在退出）：按没回应处理，不让启动时的检查一直挂着。
        res.on('aborted', () => finish({ ok: false, error: 'aborted' }));
        res.on('error', (error) => finish({ ok: false, error: error.message }));
        res.on('close', () => finish({ ok: false, error: 'closed' }));
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(text || '{}'); } catch (_) { parsed = {}; }
          finish({ ok: res.statusCode === 200 && parsed.ok === true, status: res.statusCode, ...parsed });
        });
      });
    } catch (error) { finish({ ok: false, error: error.message }); return; }
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => finish({ ok: false, error: error.message }));
    req.end(body);
  });
}

// 找一个「真在运行、没在退出」的别的 Hub；没有返回 null。
async function findRunningOther({ dataDir, selfPid = process.pid, isAlive, request, timeoutMs } = {}) {
  for (const instance of listOtherInstances({ dataDir, selfPid, isAlive })) {
    const reply = await callInstance(instance, 'ping', { request, timeoutMs });
    if (reply.ok && reply.shuttingDown !== true) return { ...instance, startedAt: Number(reply.startedAt) || instance.startedAt };
  }
  return null;
}

function describeAge(startedAt, now = Date.now()) {
  const min = Math.floor((now - Number(startedAt || 0)) / 60000);
  if (!startedAt || !Number.isFinite(min) || min < 0) return '';
  if (min < 1) return '刚刚打开';
  if (min < 60) return `${min} 分钟前打开`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} 小时前打开`;
  return `${Math.floor(hours / 24)} 天前打开`;
}

function dialogOptions(other, { now = Date.now() } = {}) {
  const age = describeAge(other && other.startedAt, now);
  return {
    type: 'question',
    title: 'AI Hub 已在运行',
    message: 'AI Hub 已在运行，切过去？',
    detail: `这台电脑上已经开着一个 AI Hub${age ? `（${age}）` : ''}。\n`
      + '「切过去」：把已开的窗口拉到最前，关掉这个刚打开的。\n'
      + '「再开一个」：两个窗口都能用，共用同一份会话记录和设置。',
    buttons: ['切过去', '再开一个'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    checkboxLabel: '以后不再提示（可在「可选功能」里打开）',
    checkboxChecked: false,
  };
}

// 主流程：找 → 问 → 切。依赖全部注入，方便单测；main.js 只负责传 Electron 的 dialog 和退出动作。
// 返回 { action: 'none' | 'stay' | 'switched' | 'switch-failed', suppress }。
async function promptIfAnotherHubRunning({ dataDir, enabled = () => true, showMessageBox, quit, setSuppressed,
  selfPid = process.pid, isAlive, request, timeoutMs, logger = console, now } = {}) {
  try {
    if (!enabled()) return { action: 'none' };
    const other = await findRunningOther({ dataDir, selfPid, isAlive, request, timeoutMs });
    if (!other) return { action: 'none' };
    const { response, checkboxChecked } = await showMessageBox(dialogOptions(other, { now }));
    if (checkboxChecked && typeof setSuppressed === 'function') {
      try { setSuppressed(); } catch (error) { logger.warn?.('[multi-open] 记住「不再提示」失败：' + error.message); }
    }
    if (response !== 0) return { action: 'stay', suppress: !!checkboxChecked };
    const reply = await callInstance(other, 'focus', { request, timeoutMs });
    if (!reply.ok) {
      logger.warn?.(`[multi-open] 已开的 Hub（pid ${other.pid}）没能切到前台：${reply.error || reply.status || '无回应'}，保留本窗口`);
      return { action: 'switch-failed', suppress: !!checkboxChecked, error: reply.error || String(reply.status || '') };
    }
    logger.log?.(`[multi-open] 已切到先开的 Hub（pid ${other.pid}），本实例退出`);
    if (typeof quit === 'function') quit();
    return { action: 'switched', suppress: !!checkboxChecked };
  } catch (error) {
    logger.warn?.('[multi-open] 检查别的 Hub 出错，照常打开：' + (error && error.message));
    return { action: 'none', error: error && error.message };
  }
}

module.exports = { ROUTE, listOtherInstances, callInstance, findRunningOther, describeAge, dialogOptions, promptIfAnotherHubRunning };
