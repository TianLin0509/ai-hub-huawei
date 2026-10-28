'use strict';
// 软压缩：上下文过 60 万软线后，用户目录下的提醒钩子（soft-compact-reminder，不随 Hub 分发）提醒 AI 收尾，
// AI 到自然断点时在回复末尾留标记结束本轮；Hub 在 Stop 时看到标记就替用户发 /compact，
// 压缩完成（SessionStart source=compact）后按需发一句「继续」。硬线 80 万由 Claude Code 自己兜底。
// 2026-10-21 用户拍板：60% 软线 + 80% 硬线 + Hub 自动压缩（方案 A）。
//
// 规矩：
//   1. 只认本轮最后一条回复末尾的标记；只管 PTY Claude 单聊会话，群聊成员交给硬线。
//   2. 发送只走 groupChatWatcher.sendToPty 闭环；/compact 带 localCommandObserver 等 PreCompact 确认。
//   3. 等待期间用户已经发了新消息（本轮又跑起来了），就不压缩，留给下一次断点。
//   4. 每一步（开始、完成、失败、超时）都在会话卡片上留一条看得见的提示。
//   5. 同一会话压缩完成后 10 分钟内再出现标记不再压，防止 AI 在继续的回复里重复留标记导致连环压缩。
//   6. 标记只说明「这里是断点」，压不压看实际上下文：不到软线九成（默认 54 万）就忽略标记。
//      2026-10-24 实测：提醒被写进压缩摘要，AI 压缩后每条回复都留标记，冷却一过就在 8.5 万时被连压两次。
//   7. 额度预压缩（2026-10-26，main/claude-quota-precompact.js）：账号额度快用完且已找到可换的账号时，
//      门槛改用计划给的「窗口 30%」；压缩完成后先换号，再发「继续」，新账号只需读压缩后的摘要。
const { readLastTerminalAssistantTextFromClaudeTranscript } = require('../core/transcript-tap');
const { observeClaudeLocalCommand } = require('../core/claude-identity-switch');
const fs = require('fs');

const MARKER_RE = /\[\[hub:compact(-continue)?\]\]/;
const CONTINUE_PROMPT = '（Hub 提示：上下文已自动压缩。先读本任务的进展卡，确认当前步骤和下一步，再接着做。）';
const SKIP_CONTINUE_PROMPT = '（Hub 提示：额度情况已变化，这次不压缩也不换号。先读本任务的进展卡，确认当前步骤和下一步，再接着做。）';
// 与提醒钩子同一条软线；端到端测试经同名环境变量压低。
const SOFT_TOKENS = Number(process.env.SOFT_COMPACT_SOFT_TOKENS) || 600_000;
const TAIL_BYTES = 4 * 1024 * 1024;

// 与提醒钩子同一算法：transcript 末尾最后一条主线 assistant 的 usage 合计。读不到返回 null。
async function readClaudeContextTokens(transcriptPath) {
  const handle = await fs.promises.open(transcriptPath, 'r');
  let text;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally { await handle.close(); }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const u = rec.message?.usage || {};
    return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
  }
  return null;
}

function findMarker(text) {
  // 700：个人输出风格要求最后一行是「白话解读」，AI 常把标记写在它前面（2026-10-26 真机 3 次里 1 次）
  const tail = String(text || '').trimEnd().slice(-700);
  const match = tail.match(MARKER_RE);
  if (!match) return null;
  return match[1] ? 'continue' : 'wait';
}

function createSoftCompactController(deps = {}) {
  const {
    sessionManager,
    sendToPty = (...args) => require('../core/group-chat-watcher').sendToPty(...args),
    readFinalText = async transcriptPath => (await readLastTerminalAssistantTextFromClaudeTranscript(transcriptPath))?.text || null,
    observeCompact = sessionId => observeClaudeLocalCommand(sessionManager, sessionId, 'compact', ''),
    readContextTokens = readClaudeContextTokens,
    minTokens = Math.round(SOFT_TOKENS * 0.9),
    isBusy = () => false,
    quotaPlan = () => null,
    afterQuotaCompact = async () => null,
    quotaSkipped = async () => false,
    notify = null,
    logger = console,
    now = Date.now,
    settleMs = 1500,
    timeoutMs = 15 * 60 * 1000,
    cooldownMs = 10 * 60 * 1000,
  } = deps;
  if (!sessionManager) throw new Error('soft-compact-controller 缺少 sessionManager');
  const compacting = new Map();
  const lastDone = new Map();
  const short = id => String(id).slice(0, 8);
  const notice = (sessionId, message, level = 'info') => {
    try { notify?.(sessionId, message, level); } catch {}
  };

  function finish(sessionId, entry) {
    if (compacting.get(sessionId) !== entry) return;
    compacting.delete(sessionId);
    clearTimeout(entry.timer);
  }

  async function onStop(sessionId, { transcriptPath, lastAssistantMessage } = {}) {
    if (!sessionId || compacting.has(sessionId)) return null;
    const session = sessionManager.getSession?.(sessionId);
    if (!session || !/^claude/.test(String(session.kind || '')) || session.agentRuntime !== 'pty') return null;
    let text = null;
    if (transcriptPath) { try { text = await readFinalText(transcriptPath); } catch {} }
    const mode = findMarker(text) || findMarker(lastAssistantMessage);
    if (!mode) return null;
    // AI 按额度提醒留了「压完继续」的标记，但换号计划已撤销（额度重置、Hub 重启等）：不压缩，
    // 补发一次「接着做」，免得长任务停在原地。每个计划最多一次（quotaSkipped 只回一次 true），不会来回循环。
    const skipped = async reason => {
      logger.log(`[soft-compact] ${short(sessionId)} ${reason}`);
      let resume = false;
      if (mode === 'continue') { try { resume = await quotaSkipped(sessionId); } catch {} }
      if (!resume) return null;
      await new Promise(resolve => setTimeout(resolve, settleMs));
      if (isBusy(sessionId)) return null;
      try {
        await sendToPty(sessionId, SKIP_CONTINUE_PROMPT, session.kind, {
          requireReady: false, clientSubmissionId: `soft-compact-skip-${now()}`,
        });
        notice(sessionId, '额度情况已变化，这次不压缩也不换号，已让 AI 读进展卡接着做。');
      } catch (error) { notice(sessionId, `额度情况已变化，自动继续发送失败：${error.message}。请手动发「继续」。`, 'warning'); }
      return null;
    };
    if (now() - (lastDone.get(sessionId) || -Infinity) < cooldownMs) return skipped('skipped: compacted within cooldown');
    let plan = null;
    try { plan = quotaPlan(sessionId); } catch {}
    const threshold = plan ? Math.min(minTokens, plan.minTokens) : minTokens;
    let tokens = null;
    if (transcriptPath) { try { tokens = await readContextTokens(transcriptPath); } catch {} }
    if (tokens == null || tokens < threshold) return skipped(`marker ignored: context ${tokens ?? 'unknown'} < ${threshold}`);
    if (session.meetingId) {
      notice(sessionId, '群聊成员不自动压缩，上下文到 80 万时由 Claude Code 自动压缩。');
      return null;
    }
    const entry = { mode, startedAt: now(), timer: null, quota: plan };
    compacting.set(sessionId, entry);
    // 让 Claude 的 TUI 收完这一轮再输入。
    await new Promise(resolve => setTimeout(resolve, settleMs));
    if (isBusy(sessionId)) {
      finish(sessionId, entry);
      logger.log(`[soft-compact] ${short(sessionId)} skipped: new turn already running`);
      return null;
    }
    logger.log(`[soft-compact] ${short(sessionId)} marker=${mode}; sending /compact`);
    notice(sessionId, plan ? `AI 已到断点（额度快用完），正在压缩上下文，压完换到 ${plan.targetLabel}${mode === 'continue' ? ' 后自动继续' : ''}。`
      : mode === 'continue' ? 'AI 已到断点，正在自动压缩上下文，压完会自动继续。' : 'AI 已到断点，正在自动压缩上下文。');
    entry.timer = setTimeout(() => {
      if (compacting.get(sessionId) !== entry) return;
      finish(sessionId, entry);
      notice(sessionId, '自动压缩 15 分钟没有完成，已放弃等待；请看一下终端，必要时手动输入 /compact。', 'warning');
    }, timeoutMs);
    entry.timer.unref?.();
    try {
      const receipt = await sendToPty(sessionId, '/compact', session.kind, {
        requireReady: false, localCommandObserver: observeCompact(sessionId),
        clientSubmissionId: `soft-compact-${entry.startedAt}`,
      });
      if (!receipt || receipt.ok === false) {
        finish(sessionId, entry);
        notice(sessionId, `自动压缩没有获得确认（${receipt?.message || '未知原因'}），可手动输入 /compact。`, 'warning');
        return null;
      }
    } catch (error) {
      finish(sessionId, entry);
      notice(sessionId, `自动压缩发送失败：${error.message}。可手动输入 /compact。`, 'warning');
      return null;
    }
    return mode;
  }

  async function onCompactEnd(sessionId) {
    const entry = compacting.get(sessionId);
    if (!entry) return;
    finish(sessionId, entry);
    lastDone.set(sessionId, now());
    const seconds = Math.round((now() - entry.startedAt) / 1000);
    logger.log(`[soft-compact] ${short(sessionId)} compact done in ${seconds}s; mode=${entry.mode}${entry.quota ? ' +quota-switch' : ''}`);
    if (entry.quota) {
      // 先换号再继续：继续消息经 beforeSend 会等换号事务完成，这里也显式等一下，保证次序。
      try { await afterQuotaCompact(sessionId); }
      catch (error) { notice(sessionId, `上下文已压缩，换号失败：${error.message}。保持当前账号。`, 'warning'); }
    }
    if (entry.mode !== 'continue') { notice(sessionId, `上下文已自动压缩（用时 ${seconds} 秒）。`); return; }
    const session = sessionManager.getSession?.(sessionId);
    if (!session) return;
    try {
      const receipt = await sendToPty(sessionId, CONTINUE_PROMPT, session.kind, {
        requireReady: false, clientSubmissionId: `soft-compact-continue-${entry.startedAt}`,
      });
      if (!receipt || receipt.ok === false || ['unknown', 'content-mismatch', 'rejected'].includes(receipt.status)) {
        notice(sessionId, '上下文已压缩，但自动继续未获确认；请看一下会话，必要时手动发「继续」。', 'warning');
        return;
      }
      notice(sessionId, `上下文已自动压缩（用时 ${seconds} 秒），已让 AI 读进展卡接着做。`);
    } catch (error) {
      notice(sessionId, `上下文已压缩，自动继续发送失败：${error.message}。请手动发「继续」。`, 'warning');
    }
  }

  function start() {
    sessionManager.on('claude-local-command-ack', event => {
      if (event && event.command === 'compact' && event.phase === 'end') void onCompactEnd(event.sessionId);
    });
  }

  function forget(sessionId) {
    const entry = compacting.get(sessionId);
    if (entry) finish(sessionId, entry);
    lastDone.delete(sessionId);
  }

  return { start, onStop, onCompactEnd, forget, isCompacting: id => compacting.has(id) };
}

module.exports = { createSoftCompactController, findMarker, readClaudeContextTokens, CONTINUE_PROMPT, SKIP_CONTINUE_PROMPT };
