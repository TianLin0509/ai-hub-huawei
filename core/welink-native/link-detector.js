'use strict';
// F1 自动保护：认出「用户在 CodeAgent 终端里手动 /welink 连上了 WeLink 个人助手」的会话。
//
// 规则（契约 §2 F1）：
// - 只看 CodeAgent 终端会话；用户（或 Hub 的手机助手）往终端敲过 `/wel…` 之后才开始读屏，平时零开销；
// - 屏幕出现「已连接」标记 → welinkLinked=true：进休眠保护名单（闲置巡检、内存压力档、低开销软上限都跳过），卡片显示「WeLink」小标；
// - 出现断开标记、进程退出或会话休眠 → 清除。
// 认命令（审查 2026-11-27）：回车提交了 /welink 只算「待确认」；屏幕上真的出现 WeLink 连接页（菜单、二维码、
//       填 AppKey、选已有助手）才算进了连接流程，之后才认连接状态。敲了又删、Esc 清掉、2 分钟没进连接页都不算。
// 读屏：输出停下约 1.5 秒后渲染一次当前整屏再判断（CodeAgent 整屏重绘，字节流里的文字会错位）；
//       没有渲染器时（单测）退化为读去转义后的最近输出。认不出文案时只是不保护，不会动终端。
// 隐私：认出命令后不再记按键；整屏文字只在判断时用、不保存（填 AppKey 页上显示着用户输入的凭据）。
const { stripAnsi } = require('../ansi-utils');
const { loadMarkers, pageOf, linkOf, WELINK_PAGES } = require('./markers');

const INPUT_LINE_MAX = 64;      // 只记当前这一行的前几十个字，够认出 /welink 就行
const TAIL_MAX = 4096;          // 没有渲染器时的退路：最近 4 KB 去转义文字
const SETTLE_MS = 2000;         // 输出停下多久再读屏
const MIN_GAP_MS = 2000;        // 两次读屏至少隔这么久（审查：别让主进程反复回放）
const MAX_WAIT_MS = 10000;      // 输出一直不停时，最多顺延这么久
const CONFIRM_MS = 2 * 60000;   // 提交 /welink 后这么久没看到 WeLink 连接页，就当没进连接流程

// 纯函数：一屏文字现在是哪一页、连接状态如何。认不出返回 'unknown'。
function classifyScreen(text, markers) {
  const m = markers || loadMarkers();
  const plain = Array.isArray(text) ? text.join('\n') : String(text || '');
  return { page: pageOf(plain, m), link: linkOf(plain, m) };
}

function createWelinkLinkDetector(options = {}) {
  const isEligible = typeof options.isEligible === 'function' ? options.isEligible : () => true;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const onScreen = typeof options.onScreen === 'function' ? options.onScreen : null;
  const readScreen = typeof options.readScreen === 'function' ? options.readScreen : null; // async id -> string[]
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : SETTLE_MS;
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true;
  let markers = options.markers || loadMarkers({ dataDir: options.dataDir });
  const sessions = new Map(); // sessionId -> { line, armed, armedAt, linked, linkedAt, tail, page, link, timer, reading, again }

  function entry(sessionId) {
    let e = sessions.get(sessionId);
    if (!e) { e = { line: '', armed: false, armedAt: 0, confirmed: false, linked: false, linkedAt: 0, tail: '', page: 'unknown', link: 'unknown', timer: null, reading: false, again: false }; sessions.set(sessionId, e); }
    return e;
  }

  function setLinked(sessionId, e, linked, reason) {
    if (e.linked === linked) return;
    e.linked = linked;
    e.linkedAt = linked ? now() : 0;
    try { onChange({ sessionId, linked, reason, at: now() }); } catch { /* 通知失败不影响判定 */ }
  }

  function apply(sessionId, e, lines) {
    const { page, link } = classifyScreen(lines, markers);
    e.page = page; e.link = link;
    if (!e.confirmed) {
      // 进了 WeLink 连接页、或窗口期内直接看到 WeLink 已连接状态行（选已有助手很快连上，菜单一闪而过）都算进了连接流程。
      // 状态行本身只认带 WeLink 字样的那一行，所以这里不会被「Database connected」之类带偏。
      if (WELINK_PAGES.includes(page) || (link === 'connected' && now() - e.armedAt <= CONFIRM_MS)) e.confirmed = true;
      else {
        if (now() - e.armedAt > CONFIRM_MS) sessions.delete(sessionId); // 没进连接流程：不再读这个会话的屏
        return { page, link };
      }
    }
    if (link === 'connected') setLinked(sessionId, e, true, 'marker');
    else if (link === 'disconnected') setLinked(sessionId, e, false, 'marker');
    if (onScreen) { try { onScreen({ sessionId, page, link, lines }); } catch { /* 观察方出错不影响判定 */ } }
    return { page, link };
  }

  // 用户往终端敲的字：维护「当前这一行」，看是不是 /wel 开头。粘贴、Hub 自己送的 /welink 也经过这里。
  function noteInput(sessionId, data) {
    if (!sessionId || typeof data !== 'string' || !data) return;
    const existing = sessions.get(sessionId);
    // 认出命令之后就不再记用户敲的字：首次连接时用户会在终端里输入 APPID/APPKEY，Hub 一个字都不留。
    if (existing && existing.armed) return;
    if (!enabled() || !isEligible(sessionId)) return;
    const e = entry(sessionId);
    if (data === '\x1b') e.line = ''; // 单按 Esc：CodeAgent 输入框清空
    // 去掉方向键、功能键、粘贴括号等转义序列（CSI / SS3），只留真正敲进框里的字
    const text = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1bO[@-~]/g, '');
    for (const ch of text) {
      if (e.armed) break;
      if (ch === '\r' || ch === '\n' || ch === '\t') { checkLine(e); e.line = ''; continue; } // 只有回车或 Tab 提交完整命令才算
      if (ch === '\x7f' || ch === '\b') { e.line = e.line.slice(0, -1); continue; }
      if (ch === '\x03' || ch === '\x15') { e.line = ''; continue; }
      if (ch < ' ' || ch === '\x1b') continue;
      if (e.line.length < INPUT_LINE_MAX) e.line += ch;
    }
    if (!e.armed && !e.linked && !e.line) sessions.delete(sessionId); // 没敲过 /welink 的会话不留状态
  }

  function checkLine(e) {
    if (e.armed || !e.line) return;
    if ((markers.command || []).some(r => r.test(e.line))) { e.armed = true; e.armedAt = now(); e.line = ''; }
  }

  async function evaluate(sessionId) {
    const e = sessions.get(sessionId);
    if (!e || !e.armed) return null;
    if (!enabled()) { setLinked(sessionId, e, false, 'disabled'); return null; }
    if (!readScreen) return apply(sessionId, e, e.tail);
    if (e.reading) { e.again = true; return null; }
    e.reading = true;
    try {
      let lines = null;
      try { lines = await readScreen(sessionId); } catch { lines = null; }
      if (sessions.get(sessionId) !== e) return null; // 读屏期间会话没了
      return Array.isArray(lines) ? apply(sessionId, e, lines) : null;
    } finally {
      e.reading = false;
      if (e.again && sessions.get(sessionId) === e) { e.again = false; schedule(sessionId, e); }
    }
  }

  // 输出一直不停（界面在刷新）时也不能一直拖：距第一次待读超过 10 秒就不再顺延。
  function schedule(sessionId, e) {
    const t = now();
    if (!e.pendingSince) e.pendingSince = t;
    if (e.timer) { if (t - e.pendingSince >= MAX_WAIT_MS) return; clearTimer(e.timer); }
    const gap = e.lastEvalAt ? Math.max(0, MIN_GAP_MS - (t - e.lastEvalAt)) : 0;
    e.timer = setTimer(() => { e.timer = null; e.pendingSince = 0; e.lastEvalAt = now(); void evaluate(sessionId); }, Math.max(settleMs, gap));
    if (e.timer && typeof e.timer.unref === 'function') e.timer.unref();
  }

  // 终端输出：只有敲过 /welink 的会话才读屏；有渲染器时等输出停下再读一次整屏。
  function noteOutput(sessionId, data) {
    const e = sessionId && sessions.get(sessionId);
    if (!e || !e.armed || typeof data !== 'string' || !data) return;
    if (readScreen) { schedule(sessionId, e); return; }
    let plain;
    try { plain = stripAnsi(data); } catch { return; }
    e.tail = (e.tail + plain).slice(-TAIL_MAX);
    void evaluate(sessionId);
  }

  // 进程退出、会话关闭或休眠：连接随进程一起没了。
  function noteExit(sessionId, reason = 'exit') {
    const e = sessionId && sessions.get(sessionId);
    if (!e) return;
    if (e.timer) clearTimer(e.timer);
    sessions.delete(sessionId);
    if (e.linked) { e.linked = false; try { onChange({ sessionId, linked: false, reason, at: now() }); } catch {} }
  }

  // Hub 自己（手机助手会话）要读屏时，先把它标为已敲过命令。
  function arm(sessionId) {
    if (!sessionId) return;
    const e = entry(sessionId);
    if (!e.armed) { e.armed = true; e.armedAt = now(); e.line = ''; }
  }

  function linkedIds() {
    const ids = new Set();
    if (!enabled()) return ids;
    for (const [id, e] of sessions) if (e.linked) ids.add(id);
    return ids;
  }

  return {
    noteInput,
    noteOutput,
    noteExit,
    arm,
    evaluate,
    linkedIds,
    isLinked: sessionId => enabled() && !!sessions.get(sessionId)?.linked,
    status: sessionId => {
      const e = sessions.get(sessionId);
      return e ? { armed: e.armed, confirmed: e.confirmed, linked: e.linked, linkedAt: e.linkedAt, page: e.page, link: e.link } : null;
    },
    reloadMarkers: next => { markers = next || loadMarkers({ dataDir: options.dataDir }); },
    _sessions: sessions,
  };
}

module.exports = { createWelinkLinkDetector, classifyScreen, INPUT_LINE_MAX, TAIL_MAX, SETTLE_MS };
