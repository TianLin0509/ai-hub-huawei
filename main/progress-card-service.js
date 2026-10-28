'use strict';
// 「进展」视图的主进程部分（2026-10-27）：找出每个会话自己在维护的进展卡，读它的「## 给用户看」白话块，
// 推给界面（会话行状态点、会话顶部进展条、左侧栏「进展」页）。
//
// 认卡：只认会话自己写过、改过的卡（原生记录里 Write / Edit / apply_patch 等写操作带着这个路径）。
//   只读过的卡不算——引用别的会话时常会读别人的卡，按「提到过」认会把别人的进展挂到自己身上。
//   同一会话写过多张时取最近修改的一张。Claude 和 Codex 都有原生记录，两边同样适用。
// 读取：每 15 秒轮询一次。原生记录只读新增部分，卡只在修改时间变化时重读；没有卡的会话什么都不做。
// 代写：会话在跑、卡超过 40 分钟没更新（或卡里还没有白话块）时，用低档模型读卡和最近的对话写一句白话，
//   标明「系统代写」。同一会话 30 分钟最多代写一次，全局同时只跑一个；Agent 一更新卡就换回它写的版本。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseProgressCard, classifyCard, STALE_MS } = require('../core/progress-card');
const { getSessionRuntimeTruth } = require('../core/session-runtime-truth');

const POLL_MS = 15000;
const CHUNK_BYTES = 1024 * 1024;          // 每次轮询每个会话最多读这么多新记录，长记录分几轮读完
const TICK_BUDGET = 4 * 1024 * 1024;      // 每轮所有会话合计最多读这么多，避免同步读卡住主进程
const FIRST_READ_TAIL = 16 * 1024 * 1024; // 第一次见到一份记录只从末尾这么多开始读：在维护的卡最近一定写过
const MAX_CARDS = 20;
const CARD_MAX_BYTES = 64 * 1024;
const GHOST_COOLDOWN_MS = 30 * 60 * 1000;
// Codex 的工具参数是 JSON 里再套一层 JSON，反斜杠会变成 4 个，所以分隔符认 1–4 个（同 core/dsh-card-reminder.mjs）。
const CARD_PATH = /[A-Za-z]:(?:[\\/]{1,4}[^\\/\n"'`<>|*?:]+)*?[\\/]{1,4}[^\\/\n"'`<>|*?:]*(?:进展卡|状态卡)[^\\/\n"'`<>|*?:]*\.md/g;
// 写操作的「目标路径」紧跟在这些标记后面，只认紧跟着的那个路径。
// 不能按「一行里既有写操作又有卡路径」来认：Codex 常在一条命令里先读几张别人的卡、再写别的文件
// （2026-10-27 用 10-22 的真实记录实测，那样会把 claude1 的卡算到 codex 会话头上）。
const WRITE_TARGET = /"name"\s*:\s*\\{0,2}"(?:Write|Edit|MultiEdit)\\{0,2}"\s*,\s*\\{0,2}"input\\{0,2}"\s*:\s*\{\s*\\{0,2}"file_path\\{0,2}"\s*:\s*\\{0,2}"|\*\*\* (?:Add|Update) File:\s*|(?:Set-Content|Add-Content|Out-File)(?:\s+-(?:LiteralPath|Path|FilePath|Encoding\s+\S+|NoNewline|Force))*\s+['"\\]{0,3}|WriteAllText\(\s*['"\\]{0,3}|open\(\s*r?['"\\]{1,3}(?=[^'"]*['"\\]{1,3}\s*,\s*['"\\]{1,3}[wa])|Path\(\s*r?['"\\]{1,3}(?=[^)]*\)\.write_text)/g;
const RELATIVE_CARD = /^[^\\/\n"'`<>|*?:]*(?:[\\/]{1,4}[^\\/\n"'`<>|*?:]+)*?(?:进展卡|状态卡)[^\\/\n"'`<>|*?:]*\.md/;

function normalizePath(p) { return p.replace(/[\\/]{1,4}/g, '\\'); }

/** 从一段原生记录里找出这个会话写过的进展卡路径；相对路径按会话工作目录补全。 */
function writtenCardPaths(text, cwd = '') {
  const s = String(text || ''), out = new Set();
  if (!s.includes('卡')) return [];
  for (const m of s.matchAll(WRITE_TARGET)) {
    const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const abs = /^[A-Za-z]:/.test(rest) && new RegExp(CARD_PATH.source).exec(rest);
    if (abs && abs.index === 0) { out.add(normalizePath(abs[0])); continue; }
    const rel = cwd && !/^[A-Za-z]:/.test(rest) && RELATIVE_CARD.exec(rest);
    if (rel) out.add(normalizePath(path.win32.resolve(cwd, normalizePath(rel[0]))));
  }
  return [...out];
}

/** 会话自己工作目录里提到过的卡（工作目录不是 D:\AIWork 这类共用根目录时才算），作为认卡的补充。 */
function cardsInOwnDirectory(text, cwd = '') {
  const dir = normalizePath(String(cwd || '')).replace(/\\$/, '').toLowerCase();
  if (!dir || /^[a-z]:(\\aiwork|\\vibe\\_scratch|\\users\\[^\\]+)?$/.test(dir)) return [];
  const out = new Set();
  for (const m of String(text || '').matchAll(CARD_PATH)) {
    const p = normalizePath(m[0]);
    if (p.toLowerCase().startsWith(dir + '\\')) out.add(p);
  }
  return [...out];
}

/** 从原生记录末尾取最近的对话正文（Claude 与 Codex 的格式都认），给代写用。 */
function recentDialogue(text, { maxItems = 30, maxChars = 500 } = {}) {
  const items = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const msg = rec.message || rec.payload || rec;
    // Codex 的 event_msg 靠 payload.type 区分 user_message / agent_message。
    const role = msg.role || (rec.payload && rec.payload.type) || rec.type || '';
    const parts = [];
    const content = msg.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) for (const c of content) if (c && typeof c.text === 'string' && /text/.test(c.type || 'text')) parts.push(c.text);
    if (typeof msg.message === 'string') parts.push(msg.message);
    const t = parts.join('\n').replace(/\s+/g, ' ').trim();
    if (!t || /^<(?:system-reminder|command-|local-command)/.test(t)) continue;
    const who = /user/.test(role) ? '用户' : /assistant|agent/.test(role) ? 'AI' : null;
    if (who) items.push(`${who}：${t.slice(0, maxChars)}`);
  }
  return items.slice(-maxItems).join('\n');
}

const GHOST_PROMPT = (card, dialogue) => `你在帮一位不看代码的负责人了解一个正在运行的 AI 长任务。下面是任务的进展卡（可能过期）和最近的对话。
用中文写一句话（不超过 60 个字）说明这个任务现在在做什么、有没有卡住；只输出这一句，不加标题、符号、引号或前缀。

【进展卡】
${String(card || '（没有）').slice(0, 6000)}

【最近的对话】
${String(dialogue || '（没有）').slice(-8000)}`;

// 嵌套在 Hub 里启动 CLI 时，去掉会让它误以为是子会话、或把 hook 投回 Hub 的变量（同 core/hub-assistant/podcast/script.js）。
const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID', 'CODEAGENT_HUB_PORT', 'CODEAGENT_HUB_TOKEN', 'CODEAGENT_HUB_SESSION_ID'];
function haikuSummarizer({ model = 'haiku', timeoutMs = 90000, spawnImpl = spawn } = {}) {
  return prompt => new Promise((resolve, reject) => {
    require('../core/company-ai-policy').assertExternalAiAllowed();
    const env = { ...process.env }; for (const k of STRIP) delete env[k];
    const bin = require('../core/account-adapters').resolveClaudeExe(env);
    const cwd = path.join(os.tmpdir(), 'ai-hub-progress-ghost');
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawnImpl(bin, ['-p', '--model', model, '--tools', '', '--no-session-persistence'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    // 超时连子进程树一起结束：Windows 上 claude 常经 .cmd 再起一层，只杀外层会留下孤儿进程。
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {}
      } else child.kill();
      reject(new Error('代写超时'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {});                                 // 进程提前退出时写 stdin 会 EPIPE，结果以 close 为准
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out) : reject(new Error('代写失败：' + (err || out).slice(0, 200))); });
    child.stdin.end(prompt, 'utf8');
  });
}
// 模型偶尔会带上回复格式里的标记，只留第一句正文。
function tidyGhost(text) {
  const line = String(text || '').split(/\r?\n/).map(l => l.replace(/^[\s>#*\-📌]+|\*\*/g, '').trim()).find(Boolean) || '';
  return line.replace(/^(白话解读|一句话|总结)[:：]\s*/, '').slice(0, 120);
}

function createProgressCardService({
  getSessions, sendToRenderer = () => {}, summarize = haikuSummarizer(), now = () => Date.now(),
  pollMs = POLL_MS, staleMs = STALE_MS, ghostCooldownMs = GHOST_COOLDOWN_MS, fsImpl = fs, logger = console,
} = {}) {
  const tracked = new Map();   // sessionId → { transcriptPath, offset, cards:Set, cardPath, mtimeMs, text, parsed, ghost, ghostAt }
  let timer = null, busy = false, ghostRunning = false, lastSent = '';
  // 「在跑」以界面上的判断为准：Claude / Codex 走终端时运行状态由渲染进程按 CLI 钩子算出（会话列表的绿圈），
  // 主进程的会话信息里没有。渲染进程每几秒报一次正在跑的会话；超过 30 秒没报才退回主进程自己的判断。
  let runningReport = null, runningReportAt = 0;
  function isRunning(session) {
    if (runningReport && now() - runningReportAt < 30000) return runningReport.has(session.id);
    return getSessionRuntimeTruth(session).state === 'running';
  }
  function setRunning(ids) {
    const next = new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string'));
    const changed = !runningReport || next.size !== runningReport.size || [...next].some(id => !runningReport.has(id));
    runningReport = next; runningReportAt = now();
    if (changed) publish();
  }

  // 只读到最后一个完整行为止：换行是单字节，切点不会落在汉字中间，路径也不会被切成两半。
  // 返回 [文本, 读了多少字节]。
  function readNew(t, budget) {
    let st; try { st = fsImpl.statSync(t.transcriptPath); } catch { return ['', 0]; }
    if (t.offset == null || st.size < t.offset) {                      // 第一次见到，或记录被重写变短：已认出的卡保留
      t.offset = Math.max(0, st.size - FIRST_READ_TAIL); t.aligned = t.offset === 0;
    }
    if (st.size <= t.offset || budget <= 0) return ['', 0];
    const len = Math.min(st.size - t.offset, CHUNK_BYTES, budget);
    const buf = Buffer.alloc(len); const fd = fsImpl.openSync(t.transcriptPath, 'r');
    try { fsImpl.readSync(fd, buf, 0, len, t.offset); } finally { fsImpl.closeSync(fd); }
    let end = buf.lastIndexOf(0x0a) + 1;
    if (end === 0) end = len === CHUNK_BYTES ? len : 0;              // 一行比一块还长：整块跳过；不满一块说明行还没写完，下轮再读
    t.offset += end;
    let text = buf.subarray(0, end).toString('utf8');
    if (!t.aligned) { text = text.slice(text.indexOf('\n') + 1); t.aligned = true; }   // 从记录中间开始读时，丢掉半行
    return [text, end];
  }

  function newestCard(t) {
    let best = null;
    for (const p of [...t.cards]) {
      try { const st = fsImpl.statSync(p); if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, mtimeMs: st.mtimeMs }; }
      catch { t.cards.delete(p); }                                    // 卡已被删掉或挪走，不再每轮去查
    }
    return best;
  }
  function addCard(t, p) {
    t.cards.delete(p); t.cards.add(p);                                 // 最近写过的排到最后
    while (t.cards.size > MAX_CARDS) t.cards.delete(t.cards.values().next().value);
  }

  function entryFor(session, t) {
    if (!t.cardPath || !t.parsed) return null;
    const running = isRunning(session);
    const { group, stale } = classifyCard({ plain: t.parsed.plain, mtimeMs: t.mtimeMs, running, now: now(), staleMs });
    const ghost = t.ghost && t.ghost.forMtime === t.mtimeMs ? t.ghost : null;
    return { sessionId: session.id, title: session.title || '', kind: session.kind || '', cardPath: t.cardPath, mtimeMs: t.mtimeMs,
      running, group: group === 'unknown' && ghost ? (stale ? 'risk' : 'ok') : group, stale,
      cardTitle: t.parsed.title, goal: t.parsed.goal, done: t.parsed.done, total: t.parsed.total, plain: t.parsed.plain,
      ghost: ghost ? { line: ghost.line, at: ghost.at } : null };
  }

  function needsGhost(entry, t) {
    if (!entry || !entry.running || ghostRunning || !summarize) return false;
    if (!(entry.stale || !entry.plain)) return false;
    if (t.ghost && t.ghost.forMtime === t.mtimeMs) return false;                 // 这一版卡已经代写过
    return !t.ghostAt || now() - t.ghostAt >= ghostCooldownMs;
  }

  async function ghostWrite(session, t) {
    const sessionId = session.id;
    ghostRunning = true; t.ghostAt = now();
    logger.info?.(`[progress-card] 开始代写：${sessionId}（卡 ${Math.round((now() - t.mtimeMs) / 60000)} 分钟没更新）`);
    const forMtime = t.mtimeMs;
    try {
      let tail = '';
      try {
        const st = fsImpl.statSync(t.transcriptPath), len = Math.min(st.size, 1024 * 1024), buf = Buffer.alloc(len);
        const fd = fsImpl.openSync(t.transcriptPath, 'r'); try { fsImpl.readSync(fd, buf, 0, len, st.size - len); } finally { fsImpl.closeSync(fd); }
        tail = buf.toString('utf8');
      } catch {}
      const line = tidyGhost(await summarize(GHOST_PROMPT(t.text, recentDialogue(tail))));
      // 代写期间会话可能已关闭、换了记录或卡被更新：只有还是同一张卡的同一版才采用。
      if (line && tracked.get(sessionId) === t && t.mtimeMs === forMtime) { t.ghost = { line, at: now(), forMtime }; publish(true); }
      else logger.info?.(`[progress-card] 代写结果未采用：${sessionId}（会话已关闭或卡已更新）`);
    } catch (e) {
      logger.warn?.('[progress-card] 代写失败：', e && e.message);
    } finally { ghostRunning = false; }
  }

  function snapshot() {
    const out = [];
    for (const s of getSessions() || []) {
      const t = tracked.get(s.id); const e = t && entryFor(s, t); if (e) out.push(e);
    }
    return out;
  }

  function publish(force = false) {
    const cards = snapshot();
    const key = JSON.stringify(cards.map(c => [c.sessionId, c.cardPath, c.mtimeMs, c.group, c.stale, c.running, c.title, c.ghost && c.ghost.at]));
    if (!force && key === lastSent) return cards;
    lastSent = key;
    sendToRenderer('progress-cards:changed', { cards, at: now() });
    return cards;
  }

  function tick() {
    if (busy) return; busy = true;
    try {
      const sessions = getSessions() || [], alive = new Set();
      let budget = TICK_BUDGET;
      for (const s of sessions) {
        if (!s || !s.id || !s.transcriptPath) continue;
        alive.add(s.id);
        let t = tracked.get(s.id);
        if (!t || t.transcriptPath !== s.transcriptPath) {
          // 换了原生记录（压缩、续接、换号）：已认出的卡保留，新记录从末尾一段开始读。
          t = { ...(t || {}), cards: t ? t.cards : new Set(), transcriptPath: s.transcriptPath, offset: null, aligned: false };
          tracked.set(s.id, t);
        }
        const [chunk, used] = readNew(t, budget);
        budget -= used;
        if (chunk) for (const p of [...writtenCardPaths(chunk, s.cwd), ...cardsInOwnDirectory(chunk, s.cwd)]) addCard(t, p);
        const card = newestCard(t);
        if (!card) { t.cardPath = null; t.parsed = null; continue; }
        if (card.path !== t.cardPath || card.mtimeMs !== t.mtimeMs) {
          try {
            const text = fsImpl.readFileSync(card.path, 'utf8').slice(0, CARD_MAX_BYTES);
            Object.assign(t, { cardPath: card.path, mtimeMs: card.mtimeMs, text, parsed: parseProgressCard(text) });
          } catch { continue; }
        }
        const entry = entryFor(s, t);
        if (needsGhost(entry, t)) void ghostWrite(s, t);
      }
      for (const id of tracked.keys()) if (!alive.has(id)) tracked.delete(id);
      publish();
    } catch (e) {
      logger.warn?.('[progress-card] 轮询失败：', e && e.message);
    } finally { busy = false; }
  }

  function start() { if (!timer) { tick(); timer = setInterval(tick, pollMs); timer.unref?.(); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function registerIpc(ipcMain) {
    ipcMain.handle('progress-cards:get', () => ({ ok: true, cards: snapshot(), at: now() }));
    ipcMain.on('progress-cards:running', (_e, ids) => setRunning(ids));
  }
  return { start, stop, tick, snapshot, registerIpc, setRunning, _tracked: tracked };
}

module.exports = { createProgressCardService, writtenCardPaths, cardsInOwnDirectory, recentDialogue, tidyGhost, haikuSummarizer, GHOST_PROMPT };
