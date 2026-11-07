'use strict';

// 把一个会话的完整问答存成 Markdown。排版是纯函数，取记录和保存都由调用方传入。
const { assistantSender } = require('./recent-turn-copy');
const { isCodeAgentKind } = require('../core/ai-kinds');

const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function pad(value) { return String(value).padStart(2, '0'); }

function exportFileName(title, now = new Date()) {
  const clean = String(title || '').replace(FORBIDDEN_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, 40).replace(/[. ]+$/, '');
  const base = !clean || RESERVED_NAME.test(clean) ? '对话' : clean;
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}-${stamp}.md`;
}

// 代码块的缩进要留着，所以只统一换行和去掉首尾空白，不动行内容。
function normalizeBody(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function exportEntries(turns, sessionKind) {
  const entries = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
    if (turn.source === 'hub-command') continue;
    const text = normalizeBody(turn.role === 'user' ? (turn.assistantContext?.userText ?? turn.text) : turn.text);
    if (!text) continue;
    // CodeAgent 的记录格式和 Claude 相同，解析结果标的来源不代表实际用的工具，以会话本身为准。
    const kind = isCodeAgentKind(sessionKind) ? 'codeagent' : (turn.kind || sessionKind);
    const entry = { role: turn.role, text, kind, model: turn.model };
    const previous = entries[entries.length - 1];
    if (previous && previous.role === entry.role && previous.text === entry.text
      && assistantSender(previous) === assistantSender(entry)) continue;
    entries.push(entry);
  }
  return entries;
}

function formatSessionMarkdown({ title, turns, kind, now = new Date() }) {
  const entries = exportEntries(turns, kind);
  const rounds = entries.filter(entry => entry.role === 'user').length;
  if (!entries.length) return { text: '', rounds: 0, entries: 0 };
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const lines = [`# ${String(title || '对话').replace(/\s+/g, ' ').trim()}`, '',
    `导出时间：${stamp} · 共 ${rounds} 轮问答 · 只含问答文字，不含工具调用过程`];
  entries.forEach(entry => {
    if (entry.role === 'user') lines.push('', '---', '', '## 我', '', entry.text);
    else lines.push('', `## ${assistantSender(entry)}`, '', entry.text);
  });
  return { text: lines.join('\n') + '\n', rounds, entries: entries.length };
}

function createSessionExporter({ invoke, getSession, toast, now = () => new Date() }) {
  async function run(sessionId) {
    const session = getSession(sessionId);
    if (!session) return { ok: false, reason: 'no-session' };
    let result;
    try {
      result = await invoke('parse-session-transcript', {
        hubSessionId: sessionId,
        ccSessionId: session.ccSessionId || null,
        transcriptPath: session.transcriptPath || null,
        kind: session.kind || null,
        opts: { limit: Infinity, fromTail: true, includeBranchHistory: true },
      });
    } catch (error) {
      toast(`导出失败：读不到这个会话的记录（${error?.message || error}）`, 'error');
      return { ok: false, reason: 'read-failed' };
    }
    if (result?.error) {
      toast(`导出失败：读不到这个会话的记录（${result.error}）`, 'error');
      return { ok: false, reason: 'read-failed' };
    }
    const at = now();
    const formatted = formatSessionMarkdown({ title: session.title, turns: result?.turns, kind: session.kind, now: at });
    if (!formatted.entries) {
      toast('这个会话还没有可以导出的问答');
      return { ok: false, reason: 'empty' };
    }
    let saved;
    try {
      saved = await invoke('session-export:save', {
        suggestedName: exportFileName(session.title, at), cwd: session.cwd || null, content: formatted.text,
      });
    } catch (error) {
      saved = { ok: false, error: error?.message || String(error) };
    }
    if (saved?.canceled) return { ok: true, canceled: true };
    if (!saved?.ok) {
      toast(`导出失败：${saved?.error || '文件没有写成功'}`, 'error');
      return { ok: false, reason: 'save-failed' };
    }
    toast(`已导出 ${formatted.rounds} 轮问答：${saved.filePath}`);
    return { ok: true, filePath: saved.filePath, rounds: formatted.rounds };
  }
  return { run };
}

module.exports = { createSessionExporter, exportEntries, exportFileName, formatSessionMarkdown };
