'use strict';
// 忙时发出的消息看护（2026-11-21，同事反馈「上一条没跑完时发第二条，第二条没执行」）。
//
// 终端会话（Claude / Codex / CodeAgent 跑在 PTY 里）在回答进行中收到第二条时，Hub 把原文粘进 CLI、
// 由 CLI 自己排队；原文离开输入框、屏幕在跑，Hub 就记成「已送达、未逐字确认」（group-chat-watcher 的
// pty-input-cleared）。之后 CLI 真正执行它时会有 UserPromptSubmit / user_message 回执。
// 以前这一步没人看着：CLI 退出、会话重启、按 Esc 中断后 CLI 把排队的话退回自己的输入框，
// 或者上一轮结束后它就是没开始，这条消息都静默消失，输入框也早清空了。
//
// 这里在主进程按会话看着这类消息，只在有明确反面证据时提醒：
//   - 会话的 CLI 进程换了（重启 / 重连）或退回了命令行：「CLI 在执行这条之前退出了」；
//   - 上一轮已经结束、会话连续空闲 settleMs，回执和 transcript 里都找不到这段原文：「没有开始执行」。
// 回合还在进行时一律不判（Claude 2.1.310 起会把中途补充并进当前这一轮，等这一轮结束再查 transcript）。
// 只提醒、不自动重发：原文交还界面，放回输入框并挂「确认没收到，重发」条，由用户决定。

const SETTLE_MS = 12000;
const POLL_MS = 2000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_PER_SESSION = 20;
// 报告「没执行」之后还盯多久：CLI 迟到执行了就撤下界面上的重发提示（避免用户照提示再发一遍、重复执行）。
const LATE_WINDOW_MS = 2 * 60 * 1000;

const squash = text => String(text || '').replace(/\s+/g, '');

// 回执里的原文可能被 CLI 合并（Claude 把多条排队消息拼成一条）或包上粘贴外壳：按去空白后的包含关系认。
function textConsumed(observed, submitted) {
  const want = squash(submitted);
  if (!want) return false;
  return squash(observed).includes(want);
}

// 没有提交 ID 的 CLI 原文按发送顺序分配证据，再按提交 ID 清理。
// 合并回执可确认多条；每处原文只用一次，同文仅出现一次时保留其余提交。
function consumedItems(prompt, candidates) {
  if (typeof prompt !== 'string') return [];
  const parts = [squash(prompt)];
  const consumed = [];
  for (const item of [...candidates].sort((a, b) => a.dispatchedAt - b.dispatchedAt)) {
    const want = squash(item.text);
    const index = parts.findIndex(part => part.includes(want));
    if (index < 0 || !want) continue;
    const part = parts[index], at = part.indexOf(want);
    parts.splice(index, 1, part.slice(0, at), part.slice(at + want.length));
    consumed.push(item);
  }
  return consumed;
}

function createBusyQueuedWatch({
  isSessionAlive, processToken, isTurnActive, cliExited = () => false,
  transcriptPromptCount = () => 0, notify, notifyExecuted = () => {}, now = Date.now,
  settleMs = SETTLE_MS, pollMs = POLL_MS, maxAgeMs = MAX_AGE_MS, lateWindowMs = LATE_WINDOW_MS, logger = console, autoStart = true,
} = {}) {
  const items = new Map(); // sessionId -> Map(clientSubmissionId -> item)
  const reported = new Map(); // sessionId -> Map(clientSubmissionId -> item)：已报告没执行、仍在迟到窗口里
  // 留住已核销提交，直到同会话同文的剩余提交全部离开看护，防止下一次 tick 重用旧转写。
  const transcriptClaims = new Map(); // sessionId -> Map(clientSubmissionId -> item)
  let timer = null;

  function ensureTimer() {
    if (timer || !autoStart) return;
    timer = setInterval(() => { try { tick(); } catch (error) { logger.warn?.('[busy-queued] tick failed:', error && error.message); } }, pollMs);
    timer.unref?.();
  }
  function stopTimerIfIdle() {
    for (const sessionId of transcriptClaims.keys()) {
      if (!items.has(sessionId) && !reported.has(sessionId)) transcriptClaims.delete(sessionId);
    }
    if (timer && !items.size && !reported.size) { clearInterval(timer); timer = null; promptTailCache.clear(); }
  }
  function dropReported(sessionId, id) {
    const list = reported.get(sessionId);
    if (!list) return;
    list.delete(id);
    if (!list.size) reported.delete(sessionId);
    stopTimerIfIdle();
  }
  // 已报告没执行的那条后来执行了：告诉界面撤下提示。
  function lateExecuted(item, source) {
    rememberExecuted(item);
    dropReported(item.sessionId, item.clientSubmissionId);
    logger.warn?.(`[busy-queued] ${item.sessionId.slice(0, 8)} ${item.clientSubmissionId.slice(0, 8)} executed late (${source})`);
    try { notifyExecuted({ sessionId: item.sessionId, clientSubmissionId: item.clientSubmissionId, text: item.text, source }); }
    catch (error) { logger.warn?.('[busy-queued] notifyExecuted failed:', error && error.message); }
  }
  function rememberExecuted(item) {
    let list = transcriptClaims.get(item.sessionId);
    if (!list) transcriptClaims.set(item.sessionId, list = new Map());
    list.set(item.clientSubmissionId, item);
  }
  function drop(sessionId, id) {
    const list = items.get(sessionId);
    if (!list) return;
    list.delete(id);
    if (!list.size) items.delete(sessionId);
    stopTimerIfIdle();
  }

  function track({ sessionId, clientSubmissionId, text, dispatchedAt = now(), kind = '' }) {
    if (!sessionId || !clientSubmissionId || !squash(text)) return false;
    let list = items.get(sessionId);
    if (!list) items.set(sessionId, list = new Map());
    if (list.size >= MAX_PER_SESSION) list.delete(list.keys().next().value);
    list.set(clientSubmissionId, {
      sessionId, clientSubmissionId, text: String(text), kind, dispatchedAt,
      token: processToken(sessionId), idleSince: null, sawTurnAfter: false,
    });
    ensureTimer();
    return true;
  }

  // 回执确认了这条（逐字或内容一致）：不用再看。
  function resolve(sessionId, clientSubmissionId) {
    const item = items.get(sessionId)?.get(clientSubmissionId);
    if (item) rememberExecuted(item);
    drop(sessionId, clientSubmissionId);
    const late = reported.get(sessionId)?.get(clientSubmissionId);
    if (late) lateExecuted(late, 'receipt');
  }

  // 已报告和仍在看护的提交共用原文证据，不能各自把同一处原文消费一遍。
  function observePrompt(sessionId, prompt) {
    const pending = [...(items.get(sessionId)?.values() || [])];
    for (const item of pending) item.sawTurnAfter = true;
    const late = [...(reported.get(sessionId)?.values() || [])];
    for (const item of consumedItems(prompt, [...late, ...pending])) {
      if (reported.get(sessionId)?.has(item.clientSubmissionId)) lateExecuted(item, 'prompt');
      else { rememberExecuted(item); drop(sessionId, item.clientSubmissionId); }
    }
  }

  function report(item, code, reason) {
    let late = reported.get(item.sessionId);
    if (!late) reported.set(item.sessionId, late = new Map());
    late.set(item.clientSubmissionId, { ...item, reportedAt: now() });
    drop(item.sessionId, item.clientSubmissionId);
    ensureTimer();
    logger.warn?.(`[busy-queued] ${item.sessionId.slice(0, 8)} ${item.clientSubmissionId.slice(0, 8)} ${code}`);
    try { notify({ sessionId: item.sessionId, clientSubmissionId: item.clientSubmissionId, text: item.text, code, reason }); }
    catch (error) { logger.warn?.('[busy-queued] notify failed:', error && error.message); }
  }

  function tick() {
    const at = now();
    const matches = new Map();
    function matchedInTranscript(sessionId) {
      if (matches.has(sessionId)) return matches.get(sessionId);
      const matched = new Set();
      matches.set(sessionId, matched);
      const live = [...(items.get(sessionId)?.values() || []), ...(reported.get(sessionId)?.values() || [])];
      const texts = new Set(live.map(item => squash(item.text)));
      const claims = transcriptClaims.get(sessionId);
      for (const [id, item] of claims || []) {
        if (!texts.has(squash(item.text)) || at - item.dispatchedAt > maxAgeMs) claims.delete(id);
      }
      if (claims && !claims.size) transcriptClaims.delete(sessionId);
      const groups = new Map();
      for (const item of [...(claims?.values() || []), ...live]) {
        const key = squash(item.text);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => a.dispatchedAt - b.dispatchedAt);
        const counts = new Map();
        const count = item => {
          if (!counts.has(item.dispatchedAt)) counts.set(item.dispatchedAt,
            Math.max(0, Math.floor(Number(transcriptPromptCount(sessionId, item.text, item.dispatchedAt)) || 0)));
          return counts.get(item.dispatchedAt);
        };
        const total = count(group[0]);
        let used = 0;
        for (const item of group) {
          // 当前提交之前的转写不能分配给它；已经分配给前面提交的次数也不能再用。
          used = Math.max(used, total - count(item));
          if (used >= total) continue;
          used += 1;
          matched.add(item);
        }
      }
      return matched;
    }
    for (const [sessionId, list] of [...reported]) {
      for (const item of [...list.values()]) {
        if (at - item.reportedAt > lateWindowMs) { dropReported(sessionId, item.clientSubmissionId); continue; }
        if (matchedInTranscript(sessionId).has(item)) lateExecuted(item, 'transcript');
      }
    }
    for (const [sessionId, list] of [...items]) {
      for (const item of [...list.values()]) {
        if (at - item.dispatchedAt > maxAgeMs) { drop(sessionId, item.clientSubmissionId); continue; }
        // 会话的进程没了（退出、休眠、重启中）或换了新进程。用户亲手关掉的会话界面上已不存在，渲染层会忽略这条提醒。
        // 终端尾部像命令行提示符只是弱证据（回答里也可能出现「$」结尾的行）：回合还在进行时不采信，进程令牌变了才是硬证据。
        const active = isTurnActive(sessionId);
        if (!isSessionAlive(sessionId) || processToken(sessionId) !== item.token || (!active && cliExited(sessionId))) {
          if (matchedInTranscript(sessionId).has(item)) { rememberExecuted(item); drop(sessionId, item.clientSubmissionId); continue; }
          report(item, 'cli-restarted', '这条是在上一条还没跑完时发的，排在终端里；终端程序在执行它之前退出或重启了');
          continue;
        }
        if (active) { item.idleSince = null; continue; }
        if (item.idleSince == null) { item.idleSince = at; continue; }
        if (at - item.idleSince < settleMs) continue;
        if (matchedInTranscript(sessionId).has(item)) { rememberExecuted(item); drop(sessionId, item.clientSubmissionId); continue; }
        report(item, 'queued-not-started', '这条是在上一条还没跑完时发的，排在终端里；上一条结束后它没有开始执行（可能被 Esc 中断退回了终端输入框）');
      }
    }
  }

  function pending(sessionId) { return [...(items.get(sessionId)?.values() || [])].map(item => ({ ...item })); }
  // 用户自己又发了同一段原文（点了重发）：之后 transcript 里出现的是这次重发，不能再当成「迟到执行」去撤提示。
  function noteSubmitted(sessionId, text) {
    // 一次用户发送只替代一条旧提交；这不是 CLI 合并执行的回执。
    const item = consumedItems(text, [...(reported.get(sessionId)?.values() || [])])[0];
    if (item) dropReported(sessionId, item.clientSubmissionId);
  }
  function reportedPending(sessionId) { return [...(reported.get(sessionId)?.values() || [])].map(item => ({ ...item })); }
  function dispose() { if (timer) clearInterval(timer); timer = null; items.clear(); reported.clear(); transcriptClaims.clear(); promptTailCache.clear(); }

  return { track, resolve, observePrompt, noteSubmitted, tick, pending, reportedPending, dispose };
}

// 转写尾部的增量缓存（2026-11-25 开销修复）：以前每 2 秒对每组排队消息同步重读末尾 2 MB 并逐行 JSON.parse（约 15 ms/次），
// 文件没写新字节也照读。现在按文件记住读到的字节位置和解析好的用户消息行：
//   - 大小、修改时间都没变：只 stat 一次，直接复用；
//   - 追加了：只读新增字节、只解析新增的完整行（先核对上次末尾 64 字节，对不上说明被重写，整段重读）；
//   - 变短、积压超过 2 MB：整段重读末尾 2 MB（和以前一样）。
// 只留可能是用户消息的行（Claude user / 排队附件，Codex user_message / user 角色消息 / UserMessage），回答和工具输出不进缓存。
const TAIL_BYTES = 2 * 1024 * 1024;
const CHECK_BYTES = 64;
const MAX_CACHED_FILES = 16;
const promptTailCache = new Map(); // file -> { size, mtimeMs, end, check, entries: [{ off, entry }], tail, results }
const maybeUserLine = line => line.includes('"user"') || line.includes('user_message') || line.includes('UserMessage') || line.includes('queued_command');
function parseUserLines(buf, base, skipFirst, into) {
  let pos = 0;
  if (skipFirst) { const nl = buf.indexOf(0x0a); if (nl < 0) return { end: base, tail: null }; pos = nl + 1; }
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const line = buf.toString('utf8', pos, nl);
    if (line.trim() && maybeUserLine(line)) { try { into.push({ off: base + pos, entry: JSON.parse(line) }); } catch { /* 半行 */ } }
    pos = nl + 1;
  }
  // 末尾没换行的一段：能解析就这一次先用上，但不前进读取位置（可能还在写）
  let tail = null;
  if (pos < buf.length) {
    const line = buf.toString('utf8', pos);
    if (line.trim() && maybeUserLine(line)) { try { tail = JSON.parse(line); } catch { tail = null; } }
  }
  return { end: base + pos, tail };
}
function readRange(fs, file, start, length) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(length); const n = fs.readSync(fd, buf, 0, length, start); return buf.subarray(0, n); }
  finally { fs.closeSync(fd); }
}
function userPromptTail(file, fs) {
  const stat = fs.statSync(file);
  const size = stat.size, mtimeMs = Number(stat.mtimeMs) || 0;
  let c = promptTailCache.get(file);
  if (c && c.size === size && c.mtimeMs === mtimeMs) { promptTailCache.delete(file); promptTailCache.set(file, c); return c; }
  let appended = false;
  if (c && size > c.end && size - c.end <= TAIL_BYTES && c.end >= CHECK_BYTES) {
    const buf = readRange(fs, file, c.end - CHECK_BYTES, size - c.end + CHECK_BYTES);
    if (buf.length >= CHECK_BYTES && buf.subarray(0, CHECK_BYTES).equals(c.check)) {
      const entries = c.entries.filter(x => x.off >= size - TAIL_BYTES);
      const r = parseUserLines(buf.subarray(CHECK_BYTES), c.end, false, entries);
      c = { size, mtimeMs, end: r.end, entries, tail: r.tail, results: new Map() };
      appended = true;
    }
  }
  if (!appended) {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = readRange(fs, file, start, size - start);
    const entries = [];
    const r = parseUserLines(buf, start, start > 0, entries);
    c = { size, mtimeMs, end: r.end, entries, tail: r.tail, results: new Map() };
  }
  c.check = c.end >= CHECK_BYTES ? Buffer.from(readRange(fs, file, c.end - CHECK_BYTES, CHECK_BYTES)) : null;
  promptTailCache.delete(file);
  promptTailCache.set(file, c);
  while (promptTailCache.size > MAX_CACHED_FILES) promptTailCache.delete(promptTailCache.keys().next().value);
  return c;
}
function clearPromptTailCache() { promptTailCache.clear(); }

// transcript / rollout 尾部里，发送时刻之后用户原文出现的次数。只看文件末尾 2 MB（增量读，见上）。
function fileUserPromptCount(file, text, since, { kind = 'claude', fs = require('node:fs') } = {}) {
  const want = squash(text);
  if (!file || !want) return 0;
  let cached;
  try { cached = userPromptTail(file, fs); } catch { return 0; }
  const memo = kind + '\0' + Number(since || 0) + '\0' + want;
  if (cached.results.has(memo)) return cached.results.get(memo);
  const floor = Number(since || 0);
  const { withQueuedHumanInputs } = require('./claude-queued-input');
  const textOf = content => typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(block => block?.text || block?.input_text || '').join('\n') : '';
  const entries = cached.entries.map(x => x.entry);
  if (cached.tail) entries.push(cached.tail);
  const counts = new Map();
  const codex = /codex/.test(kind);
  for (const entry of codex ? entries : withQueuedHumanInputs(entries)) {
    const ts = Date.parse(entry?.timestamp || '') || 0;
    if (!ts || ts < floor) continue;
    let observed = null;
    let source = 'claude';
    if (codex) {
      const p = entry?.payload;
      if (entry?.type === 'event_msg' && p?.type === 'user_message') { observed = p.message; source = 'user_message'; }
      else if (entry?.type === 'response_item' && p?.type === 'message' && p.role === 'user') { observed = textOf(p.content); source = 'response_item'; }
      else if (entry?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'UserMessage') { observed = textOf(p.item.content); source = 'item_completed'; }
    } else {
      if (entry?.type === 'user' && !entry.isSidechain) observed = textOf(entry.message?.content);
    }
    if (observed) counts.set(source, (counts.get(source) || 0) + squash(observed).split(want).length - 1);
  }
  // Codex 同一次用户输入常有 event_msg 和 response_item 两份落盘，不能相加。
  const result = Math.max(0, ...counts.values());
  if (cached.results.size > 64) cached.results.clear();
  cached.results.set(memo, result);
  return result;
}

function promptTailCacheSize() { return promptTailCache.size; }

module.exports = { createBusyQueuedWatch, fileUserPromptCount, clearPromptTailCache, promptTailCacheSize, textConsumed, SETTLE_MS, LATE_WINDOW_MS };
