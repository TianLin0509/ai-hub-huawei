'use strict';
//   - 先向 core/child-lifecycle.js 申请 edge 名额（默认同时 1 个，CLAUDE_HUB_EDGE_MAX 可调），多出的排队；内存紧张时先等、等不到这次不开；
//   - 起来就登记 PID、启动时间、用途和临时目录，带最长运行时间：超时由登记层按 PID 结束整棵树并删目录，调用方卡住也收得掉；
//   - 调试端口用 --remote-debugging-port=0 + DevToolsActivePort 文件，不再随机挑端口撞车；
//   - 不弹窗（--headless=new + windowsHide），不改用户自己的 Edge 资料。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getChildLifecycle } = require('../core/child-lifecycle');

const delay = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const OWNER_FILE = 'hub-owner.json';

function findEdge(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:/Program Files (x86)', 'C:/Program Files'].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(p)) return p;
  }
  return '';
}
function markOwner(tmp, pid = process.pid) {
  try { fs.writeFileSync(path.join(tmp, OWNER_FILE), JSON.stringify({ pid, at: Date.now() })); } catch { /* 少一层保护：回收前还有改名探测 */ }
}

async function readPort(tmp, proc, waitMs) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (proc.exitCode !== null || proc.spawnError) return 0;
    try {
      const port = Number(fs.readFileSync(path.join(tmp, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (port > 0) { await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); return port; }
    } catch { /* 还没起来 */ }
    await delay(300);
  }
  return 0;
}

// 返回 { proc, port, tmp, close(), closeSync() }；失败抛错（名额、内存、启动失败）。
// prepare(tmp) 在启动前调用（复制登录状态等），抛错即放弃且已收尾。
async function launchHeadlessEdge({ purpose, owner = '', tag = 'hub-edge', env = process.env, prepare = null, extraArgs = [], maxLifeMs = 10 * 60000,
  startWaitMs = 20000, waitMs, signal = null, logger = console, lifecycle = getChildLifecycle() } = {}) {
  const edge = findEdge(env);
  if (!edge) throw new Error('本机没有找到 Edge');
  const release = await lifecycle.acquire('edge', { purpose, waitMs, signal });
  let tmp = '', proc = null, regId = '', closed = false;
  const cleanupDir = () => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (e) { logger.warn?.(`[${tag}] Edge 临时目录未删净，下次启动时再清`, e.code || e.message); } } };
  function closeSync() {
    if (closed) return; closed = true;
    // 按 PID 结束整棵树 + 删目录 + 注销；进程已自己退出并注销过时只删目录。
    if (!regId || !lifecycle.reclaim(regId, '用完已关')) cleanupDir();
    release();
  }
  async function close() {
    if (closed) return;
    closeSync();
    await delay(300);
    if (tmp && fs.existsSync(tmp)) { await delay(800); cleanupDir(); }
  }
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), tag + '-'));
    markOwner(tmp);
    if (prepare) await prepare(tmp);
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORT_ERR' });
    const startedAt = Date.now();
    proc = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${tmp}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-mode', ...extraArgs, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    proc.on('error', e => { proc.spawnError = e; });
    if (proc.pid) regId = lifecycle.register({ pid: proc.pid, kind: 'edge', purpose, owner, userDataDir: tmp, maxLifeMs, startedAt });
    // Edge 自己退出就立刻注销：之后这个 PID 被别的进程复用，也不会再按它去结束（审查 #1）。
    proc.once('exit', () => { if (regId) lifecycle.unregister(regId, '进程已退出'); });
    const port = await readPort(tmp, proc, startWaitMs);
    if (!port) throw new Error(proc.spawnError ? `无头 Edge 启动失败（${proc.spawnError.code || proc.spawnError.message}）` : '无头 Edge 没有启动');
    return { proc, port, tmp, close, closeSync, get closed() { return closed || !regId || proc.exitCode !== null; } };
  } catch (error) {
    await close();
    throw error;
  }
}

// 连上一个页面的调试协议：带打开超时；send 每个请求都有上限，连接断了在等的请求立刻收尾。
async function connectCdp(wsUrl, { openMs = 10000, sendMs = 15000, onEvent = null } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { try { ws.close(); } catch { /* 已关 */ } reject(new Error('连接无头 Edge 超时')); }, openMs);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('连接无头 Edge 失败')); };
  });
  let id = 0, closed = false;
  const pending = new Map();
  ws.onclose = () => { closed = true; for (const r of pending.values()) r({ closed: true }); pending.clear(); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); return; }
    if (onEvent) { try { onEvent(m); } catch { /* 事件处理出错不影响连接 */ } }
  };
  function send(method, params = {}, ms = sendMs) {
    if (closed) return Promise.resolve({ closed: true });
    id += 1; const n = id;
    return new Promise(resolve => {
      const t = setTimeout(() => { pending.delete(n); resolve({ timeout: true }); }, ms);
      pending.set(n, m => { clearTimeout(t); resolve(m); });
      try { ws.send(JSON.stringify({ id: n, method, params })); } catch { clearTimeout(t); pending.delete(n); resolve({ closed: true }); }
    });
  }
  return { ws, send, get closed() { return closed; }, close() { try { ws.close(); } catch { /* 已关 */ } } };
}

module.exports = { launchHeadlessEdge, connectCdp, findEdge, markOwner, OWNER_FILE };
