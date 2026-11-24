'use strict';
// 社区统计·发送端（2026-11-24）：每小时一次把匿名心跳投给公司内网的收件机，回复里顺带拿回榜单快照；社区页打开时
// 缓存超过 10 分钟才单独取一次榜单。用户无感：不弹窗、不提示，失败不重试不排队，下一小时再说，原因只给社区页一行灰字。
// 收件地址复用一键反馈的内源发布（core/feedback-receiver-address.js），代码里不写地址；没有地址＝不在公司内网，不发。
// 本机就是收件机时不走网络：心跳直接写本地存储，榜单直接读本地。
// 最近一次榜单另存一份到 <数据目录>/community/board-cache.json：启动时底栏只读它（cachedOnly），不因此触网。
const fs = require('node:fs');
const path = require('node:path');

const PULSE_PATH = '/community/v1/pulse';
const BOARD_PATH = '/community/v1/board';
const REQUEST_TIMEOUT_MS = 3000;
const FIRST_MIN_MS = 2 * 60 * 1000;
const FIRST_SPAN_MS = 4 * 60 * 1000;
const PERIOD_MS = 60 * 60 * 1000;
const JITTER_MS = 5 * 60 * 1000;
const BOARD_TTL_MS = 10 * 60 * 1000;
// 磁盘上的旧榜单超过 2 小时就标 stale（在线数可能已经不准）。
const STALE_MS = 2 * 60 * 60 * 1000;
const MAX_REPLY_BYTES = 64 * 1024;

const STATE_TEXT = {
  outside: '仅在公司内网可用',
  offline: '暂时连不上统计服务，下个小时自动再试',
  disabled: '已关闭社区统计',
  paused: '社区统计暂停中',
};

function createCommunityClient({
  receiverAddress, buildPayload, isEnabled = () => true, host = null,
  fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, random = Math.random,
  timers = { setTimeout, clearTimeout }, timeoutMs = REQUEST_TIMEOUT_MS, logger = console,
  // 最近一次榜单的落盘位置；不传就只记在内存里（单测）。
  cacheFile = '',
  // 每次心跳结果、开关变化后推一次 { state, online, at }（底栏与左栏绿点只靠它更新）。
  onSummary = () => {},
  // 只给隔离测试实例用：首次心跳与之后的间隔改成固定毫秒数（正式运行不传）。
  firstDelayMs = 0, periodMs = 0,
} = {}) {
  let timer = null, running = false, paused = false, inFlight = null;
  // 关开关、收到刹车时 +1：在途的心跳醒来发现代数变了就不再发（审查 P2：地址解析期间关开关仍会发一次）。
  let epoch = 0;
  const controllers = new Set();
  let cached = null;          // { at, board } 最近一次拿到的榜单
  let diskLoaded = false;
  let last = { state: '', note: '', at: 0 };

  function loadDisk() {
    if (diskLoaded || !cacheFile) return;
    diskLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!cached && raw && raw.board && raw.board.boards && Number(raw.at) > 0) cached = { at: Number(raw.at), board: raw.board };
    } catch { /* 还没有缓存 */ }
  }
  function saveDisk() {
    if (!cacheFile || !cached) return;
    const text = JSON.stringify(cached), tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.promises.mkdir(path.dirname(cacheFile), { recursive: true })
      .then(() => fs.promises.writeFile(tmp, text, 'utf8')).then(() => fs.promises.rename(tmp, cacheFile))
      .catch(() => { /* 存不下就下次再存 */ });
  }

  const summary = state => {
    loadDisk();
    try { onSummary({ state, online: state === 'ok' && cached ? Number(cached.board.online) || 0 : 0, at: cached ? cached.at : 0 }); } catch { /* 界面没开 */ }
  };
  function setLast(state, note = '') { last = { state, note, at: now() }; summary(state); }

  async function addressUrls() {
    try { const a = receiverAddress ? await receiverAddress.resolve() : null; return a && Array.isArray(a.urls) ? a.urls : []; }
    catch { return []; }
  }

  async function request(url, init) {
    const ctl = new AbortController();
    controllers.add(ctl);
    const t = timers.setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctl.signal, redirect: 'error', cache: 'no-store' });
      const text = String(await res.text());
      if (text.length > MAX_REPLY_BYTES) return { ok: false, error: '回复过大' };
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      if (res.status === 404) return { ok: false, error: '收件机版本还不支持社区统计' };
      if (!res.ok || !json || typeof json !== 'object') return { ok: false, error: `收件机返回 ${res.status}` };
      return { ok: true, json };
    } catch (e) {
      return { ok: false, error: ctl.signal.aborted ? `${Math.round(timeoutMs / 1000)} 秒内没有回复` : `连不上（${(e.cause && e.cause.code) || e.message}）` };
    } finally { timers.clearTimeout(t); controllers.delete(ctl); }
  }

  function remember(board) {
    if (board && typeof board === 'object' && board.boards) { cached = { at: now(), board }; diskLoaded = true; saveDisk(); }
  }
  // 远程刹车：心跳回复和榜单回复里的 pause:true 一样处理——本次运行内停发、清掉定时器（审查 P2）。
  function brake() {
    paused = true; epoch++;
    if (timer) { timers.clearTimeout(timer); timer = null; }
    setLast('paused');
  }
  const stillWanted = my => my === epoch && isEnabled() && !paused;

  // 发一次心跳。返回 { sent, state }，不抛错。
  async function pulse() {
    const my = epoch;
    if (!isEnabled()) { setLast('disabled'); return { sent: false, state: 'disabled' }; }
    if (paused) return { sent: false, state: 'paused' };
    let payload;
    try { payload = buildPayload(); } catch (e) { logger.warn?.('[community] 心跳内容构建失败：', e.message); return { sent: false, state: 'error' }; }
    if (!payload) return { sent: false, state: 'error' };
    if (host && host.isHost()) {
      host.ingest(payload);
      const b = host.board();
      cached = { at: now(), board: b }; diskLoaded = true;
      setLast('ok');
      return { sent: true, state: 'ok', local: true };
    }
    const urls = await addressUrls();
    // 等地址期间用户关了开关或收到了刹车：不发。
    if (!stillWanted(my)) return { sent: false, state: isEnabled() ? 'paused' : 'disabled' };
    if (!urls.length) { setLast('outside'); return { sent: false, state: 'outside' }; }
    const r = await request(urls[0] + PULSE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (my !== epoch) return { sent: false, state: isEnabled() ? 'paused' : 'disabled' };
    if (!r.ok) { setLast('offline', r.error); return { sent: false, state: 'offline' }; }
    if (r.json.pause === true) { brake(); return { sent: true, state: 'paused' }; }
    remember(r.json.board);
    setLast('ok');
    return { sent: true, state: 'ok' };
  }

  function schedule(delay) {
    if (!running) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(async () => {
      timer = null;
      try { inFlight = pulse(); await inFlight; } catch (e) { logger.warn?.('[community] 心跳出错：', e.message); } finally { inFlight = null; }
      // 远程刹车：收件机说暂停，本次运行内不再发（下次启动再看）。
      if (!paused) schedule(periodMs > 0 ? periodMs : PERIOD_MS + (random() * 2 - 1) * JITTER_MS);
    }, delay);
    timer?.unref?.();
  }

  function start() {
    if (running || paused) return;
    running = true;
    schedule(firstDelayMs > 0 ? firstDelayMs : FIRST_MIN_MS + random() * FIRST_SPAN_MS);
  }
  function stop() {
    running = false; epoch++;
    if (timer) { timers.clearTimeout(timer); timer = null; }
    for (const ctl of controllers) ctl.abort();
  }
  // 用户关开关：立即停发并中止在途请求；重新打开后首次心跳仍随机等 2–6 分钟。
  function setEnabled(on) { if (on) { start(); summary(paused ? 'paused' : cached ? 'ok' : (last.state || 'offline')); } else { stop(); setLast('disabled'); } }

  const empty = state => ({ ok: true, state, note: STATE_TEXT[state] || '', at: 0, isHost: false, online: 0, activeNow: 0, today: 0, week: 0, total: 0,
    todayDelta: 0, weekDelta: 0, versions: [], boards: { level: [], wxp: [], wtok: [], streak: [], ach: [] }, me: null, minK: 5 });
  const fromCache = extra => ({ ...cached.board, state: 'ok', isHost: false, at: cached.at, ...(now() - cached.at > STALE_MS ? { stale: true } : {}), ...extra });

  // 社区页要数据。force=true 时忽略 10 分钟缓存（页面上的「刷新」）；cachedOnly=true 时只读内存或磁盘里的快照，绝不触网。
  async function getBoard({ force = false, cachedOnly = false, iid = '' } = {}) {
    if (!isEnabled()) return empty('disabled');
    if (paused) return empty('paused');
    if (host && host.isHost()) return { ...host.board(), isHost: true };
    loadDisk();
    if (cachedOnly) return cached ? fromCache() : empty('offline');
    if (!force && cached && now() - cached.at < BOARD_TTL_MS) return fromCache();
    const my = epoch;
    const urls = await addressUrls();
    // 等地址期间关了开关或收到刹车：不发榜单请求（复审 P2）。
    if (!stillWanted(my)) return isEnabled() ? empty('paused') : empty('disabled');
    if (!urls.length) return empty('outside');
    const r = await request(urls[0] + BOARD_PATH + (iid ? `?iid=${encodeURIComponent(iid)}` : ''), { method: 'GET' });
    if (r.ok && r.json.pause === true) { brake(); return empty('paused'); }
    if (my !== epoch) return isEnabled() ? empty(paused ? 'paused' : 'offline') : empty('disabled');
    if (r.ok && r.json.boards) { remember(r.json); summary('ok'); return fromCache(); }
    // 取不到：有旧榜单就给旧的并在灰字里说明，没有就给 offline。
    if (cached) return fromCache({ stale: true, note: STATE_TEXT.offline });
    return { ...empty('offline'), note: r.error ? `${STATE_TEXT.offline}（${r.error}）` : STATE_TEXT.offline };
  }

  // 底栏在线数：只读已有的缓存（最近一次心跳回复或榜单），不发网络请求；收件机本机读本地统计（60 秒内复用）。
  function getOnline() {
    if (!isEnabled()) return { ok: true, state: 'disabled', online: null, at: 0 };
    if (paused) return { ok: true, state: 'paused', online: null, at: 0 };
    if (host && host.isHost()) { const b = host.board(); return { ok: true, state: 'ok', online: b.online, activeNow: b.activeNow, at: b.at, isHost: true }; }
    loadDisk();
    if (cached) return { ok: true, state: 'ok', online: Number(cached.board.online) || 0, activeNow: Number(cached.board.activeNow) || 0, at: cached.at, isHost: false, ...(now() - cached.at > STALE_MS ? { stale: true } : {}) };
    return { ok: true, state: last.state || 'pending', online: null, at: 0, isHost: false };
  }

  return { start, stop, pulse, getBoard, getOnline, setEnabled, status: () => ({ ...last, paused, running }), _inFlight: () => inFlight };
}

module.exports = { createCommunityClient, PULSE_PATH, BOARD_PATH, REQUEST_TIMEOUT_MS, PERIOD_MS, JITTER_MS, FIRST_MIN_MS, FIRST_SPAN_MS, BOARD_TTL_MS, STALE_MS, STATE_TEXT };
