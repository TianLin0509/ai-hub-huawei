'use strict';

// PTY startup output and welcome suggestions are not submitted user prompts.
function hasSubmittedPrompt(session) {
  return [session?.runStartedAt, session?.lastRunStartedAt,
    session?._attentionClock?.lastPromptAt].some(at => Number(at) > 0);
}

// Capture the user's launch intent before provider launchers allocate native IDs.
function isFreshLaunch(kind, opts = {}) {
  return !String(kind || '').endsWith('-resume') && ![
    'useResume', 'useContinue', 'resumePicker', 'codexResumePicker', 'kimiResumePicker',
    'resumeCCSessionId', 'forkCCSessionId', 'codexSid', 'codexForkSid',
    'geminiChatId', 'kimiSid', 'kimiSessionDir', 'acpSid',
    'resumeTranscriptPath', 'transcriptPath', 'branchSourceSessionId',
  ].some(key => opts[key]);
}

function isFreshSession(session, { allowMissingTranscript = false } = {}) {
  if (!session || hasSubmittedPrompt(session) || session.freshLaunch === false
      || session.codexAllowMtimeFallback || String(session.kind || '').endsWith('-resume')
      || session.branchSourceSessionId) return false;
  if (session.transcriptPath && !(allowMissingTranscript && session.freshLaunch === true)) return false;
  // A preallocated identity alone is not conversation history. Older records
  // without explicit launch intent retain the conservative identity check.
  return session.freshLaunch === true || ![
    session.codexSid, session.ccSessionId, session.geminiChatId, session.kimiSid, session.kimiSessionDir, session.acpSid,
  ].some(Boolean);
}

// Claude does not create a fork's own JSONL until its first prompt. A parent
// identity is context, not proof that the child has already produced history.
// Never hide a missing file that was previously bound or a submitted turn.
// allowBoundTranscript: the CLI's SessionStart hook reports the fork's future
// transcript path before the file exists (Claude / CodeAgent `--fork-session`,
// 2026-10-13 company stand-in). Callers pass it only after checking the file is
// really absent; a branch that has run a turn is still never hidden.
function isUnsubmittedBranch(session, { allowBoundTranscript = false } = {}) {
  return !!session?.branchSourceSessionId && (allowBoundTranscript || !session.transcriptPath)
    && !hasSubmittedPrompt(session) && !Number(session.lastCompletedAt);
}

// 启动时能否把 opts.resumeTranscriptPath 直接记成「本会话自己的记录」。
// 这个字段对分支而言是「源会话」的记录，只给账号定位、原生 fork 当参数用：
//   - 终端里的 `codex fork` 会开新线程（2026-09-26 实测，挂源路径会把分支绑到源 rollout）；
//   - Claude 的 `--resume <源> --fork-session --session-id <新>` 同样写一份以新 id 命名的
//     新 JSONL。预先挂上源路径，卡片视图（main/ipc/transcript-handlers.js 优先读
//     session.transcriptPath）就一直读源文件：分支里新一轮的回答永远不出卡片，只要 hook
//     没来改绑（隔离配置目录没装 hook、hook 被改坏）就一直如此（2026-11-07 公司版验收实测）。
// Claude 的记录文件名就是会话 id；启动前已知本会话 id 时，名字对不上的路径一律不认，
// 早先存坏的分支记录恢复时也能自愈。不挂时卡片按 ccSessionId 查本会话自己的文件。
function launchTranscriptPath(opts = {}, { ownClaudeSessionId = null, ptyCodexFork = false } = {}) {
  const file = typeof opts.resumeTranscriptPath === 'string' ? opts.resumeTranscriptPath : '';
  if (!file || ptyCodexFork || opts.forkCCSessionId) return null;
  if (ownClaudeSessionId) {
    const name = String(file).split(/[\\/]/).pop().replace(/\.jsonl$/i, '');
    if (name.toLowerCase() !== String(ownClaudeSessionId).toLowerCase()) return null;
  }
  return file;
}

module.exports = { hasSubmittedPrompt, isFreshSession, isFreshLaunch, isUnsubmittedBranch, launchTranscriptPath };
