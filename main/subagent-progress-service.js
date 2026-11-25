'use strict';
// 子 Agent 进度一行字的主进程部分（2026-10-29）：只盯渲染进程正在卡片视图里看的那一个会话，
// 每 2 秒按 core/subagent-progress.js 异步读一次（文件没变就复用缓存，只读尾部），结果有变化才推给界面。
// 只做 Claude 家族（CodeAgent 是重点，Claude 记录格式相同顺带支持）；没有记录路径的 CodeAgent 会话
// 按 receipt-reader 的办法到号的配置目录里找：原生 id 对应的文件优先，否则取最近改过的一份。
const fs = require('node:fs');
const path = require('node:path');
const { createSubagentProgressReader } = require('../core/subagent-progress');
const { isClaudeFamily, isCodeAgentKind } = require('../core/ai-kinds');

const POLL_MS = 2000;
const safe = fn => { try { return fn(); } catch { return false; } };
const LOCATE_RETRY_MS = 15000;   // 找不到记录时，过一会儿再到配置目录里找，不每轮都列目录

function createSubagentProgressService({ getSession, isCliGone = () => false, isTurnActive = null, sendToRenderer = () => {}, pollMs = POLL_MS, fsImpl = fs, now = () => Date.now(), logger = console } = {}) {
  const reader = createSubagentProgressReader({ fsImpl, now });
  let watched = null, timer = null, lastKey = '', located = { sessionId: null, file: null, at: 0 };

  function transcriptOf(session) {
    if (session.transcriptPath) return session.transcriptPath;
    if (!isCodeAgentKind(session.kind)) return null;
    if (located.sessionId === session.id && (located.file || now() - located.at < LOCATE_RETRY_MS)) return located.file;
    let file = null;
    try {
      const { transcriptDirs, candidateTranscripts } = require('../core/codeagent-transcript-dirs');
      if (session.ccSessionId) {
        for (const dir of transcriptDirs(session, fsImpl)) {
          const p = path.join(dir, `${session.ccSessionId}.jsonl`);
          if (fsImpl.existsSync(p)) { file = p; break; }
        }
      }
      if (!file) file = (candidateTranscripts(session, Number(session.createdAt) || 0, fsImpl)[0] || {}).file || null;
    } catch { file = null; }
    located = { sessionId: session.id, file, at: now() };
    return file;
  }

  function publish(sessionId, progress) {
    const key = JSON.stringify([sessionId, progress && progress.text]);
    if (key === lastKey) return;
    lastKey = key;
    sendToRenderer('subagent-progress:changed', { sessionId, progress: progress || null });
  }

  // 读记录是异步的（core/subagent-progress.js）；上一轮没读完就跳过这一轮，读完时用户已换了会话就不推。
  let reading = false;
  async function tick() {
    const id = watched;
    if (!id || reading) return;
    reading = true;
    try {
      const session = getSession(id);
      if (!session || !isClaudeFamily(session.kind)) { publish(id, null); return; }
      const file = transcriptOf(session);
      // 当前 CLI 进程的启动时刻、是否已退回系统终端、本轮是否还在跑：用来把 CLI 退出时没跑完的子任务标成「已中断」（R46）。
      // Process start time, shell takeover and turn state let the reader mark subagents orphaned by a CLI exit as interrupted (R46).
      const startedAt = Number(session.spawnedAt ?? session.createdAt);
      const live = {
        processStartedAt: Number.isFinite(startedAt) ? startedAt : null,
        cliGone: !!safe(() => isCliGone(id)),
        turnActive: typeof isTurnActive === 'function' ? !!safe(() => isTurnActive(id)) : null,
      };
      const progress = file ? await reader.read(file, live) : null;
      if (watched === id) publish(id, progress);
    } catch (e) {
      logger.warn?.('[subagent-progress] 读取失败：', e && e.message);
    } finally { reading = false; }
  }

  function watch(sessionId) {
    const next = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (next === watched) return;
    watched = next; lastKey = '';
    if (!next) { if (timer) clearInterval(timer); timer = null; return; }
    void tick();
    if (!timer) { timer = setInterval(() => void tick(), pollMs); timer.unref?.(); }
  }
  function stop() { watch(null); }
  function registerIpc(ipcMain) {
    ipcMain.on('subagent-progress:watch', (_e, sessionId) => watch(sessionId));
  }
  return { watch, stop, tick, registerIpc };
}

module.exports = { createSubagentProgressService };
