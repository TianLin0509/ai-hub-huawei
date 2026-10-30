'use strict';
// 子 Agent 进度一行字的主进程部分（2026-10-29）：只盯渲染进程正在卡片视图里看的那一个会话，
// 每 2 秒按 core/subagent-progress.js 读一次（文件没变就复用缓存，只读尾部），结果有变化才推给界面。
// 只做 Claude 家族（CodeAgent 是重点，Claude 记录格式相同顺带支持）；没有记录路径的 CodeAgent 会话
// 按 receipt-reader 的办法到号的配置目录里找：原生 id 对应的文件优先，否则取最近改过的一份。
const fs = require('node:fs');
const path = require('node:path');
const { createSubagentProgressReader } = require('../core/subagent-progress');
const { isClaudeFamily, isCodeAgentKind } = require('../core/ai-kinds');

const POLL_MS = 2000;
const LOCATE_RETRY_MS = 15000;   // 找不到记录时，过一会儿再到配置目录里找，不每轮都列目录

function createSubagentProgressService({ getSession, sendToRenderer = () => {}, pollMs = POLL_MS, fsImpl = fs, now = () => Date.now(), logger = console } = {}) {
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

  function tick() {
    const id = watched;
    if (!id) return;
    try {
      const session = getSession(id);
      if (!session || !isClaudeFamily(session.kind)) { publish(id, null); return; }
      const file = transcriptOf(session);
      publish(id, file ? reader.read(file) : null);
    } catch (e) {
      logger.warn?.('[subagent-progress] 读取失败：', e && e.message);
    }
  }

  function watch(sessionId) {
    const next = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (next === watched) return;
    watched = next; lastKey = '';
    if (!next) { if (timer) clearInterval(timer); timer = null; return; }
    tick();
    if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); }
  }
  function stop() { watch(null); }
  function registerIpc(ipcMain) {
    ipcMain.on('subagent-progress:watch', (_e, sessionId) => watch(sessionId));
  }
  return { watch, stop, tick, registerIpc };
}

module.exports = { createSubagentProgressService };
