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
//   8. CodeAgent（2026-10-29）：没有提醒钩子、也不留标记，Stop 时直接读屏幕右侧 Stats 面板的
//      「Context 32.7k (16%)」（core/codeagent-screen-stats.js），占用到同一条 60% 软线（Claude 是 60 万 / 100 万窗口）
//      且会话空闲就发 /compact。参考公司 CodeAgentWeb：只在空闲时触发、两次之间冷却 60 秒、压完复查。
//      CodeAgent 的 /compact 回显未经真机取证：有 PreCompact / SessionStart(compact) 确认就用，
//      否则看 Stats 面板百分比明显下降（降到发前的七成以内）或屏幕新出现压缩提示；占用读不到又没有任何确认就记
//      「结果未知」，不重复发。复查没降下来算失败，冷却后再试；同一会话连续失败 2 次停手并提示一次。
//      占用回落到软线以下（用户手动压过等）就恢复自动压缩。群聊成员与 Claude 一样不自动压缩。
const { readLastTerminalAssistantTextFromClaudeTranscript } = require('../core/transcript-tap');
const { observeClaudeLocalCommand } = require('../core/claude-identity-switch');
const { parseCodeAgentContext } = require('../core/codeagent-screen-stats');
const fs = require('fs');

const MARKER_RE = /\[\[hub:compact(-continue)?\]\]/;
const CONTINUE_PROMPT = '（Hub 提示：上下文已自动压缩。先读本任务的进展卡，确认当前步骤和下一步，再接着做。）';
const SKIP_CONTINUE_PROMPT = '（Hub 提示：额度情况已变化，这次不压缩也不换号。先读本任务的进展卡，确认当前步骤和下一步，再接着做。）';
// 与提醒钩子同一条软线；端到端测试经同名环境变量压低。
const SOFT_TOKENS = Number(process.env.SOFT_COMPACT_SOFT_TOKENS) || 600_000;
const TAIL_BYTES = 4 * 1024 * 1024;
// CodeAgent 用同一条软线，换算成百分比（Stats 面板只给百分比，窗口大小随后端变）。
const CODEAGENT_SOFT_PCT = Math.round(SOFT_TOKENS / 1_000_000 * 100);
// 压缩完成的屏幕提示：Claude Code 是「Conversation compacted」，CodeAgent 衍生自它，另认中文写法。
const CODEAGENT_COMPACT_HINT_RE = /Conversation compacted|Compacted conversation|上下文已压缩|已压缩上下文|压缩完成/gi;
const CODEAGENT_MAX_FAILURES = 2;

// 屏幕上压缩提示出现的次数；发前发后对比，只认新出现的。
function countCompactHints(rows) {
  const text = (Array.isArray(rows) ? rows : [String(rows || '')]).join('\n');
  return (text.match(CODEAGENT_COMPACT_HINT_RE) || []).length;
}

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
    // CodeAgent：读当前屏幕行（main.js 用 PTY 缓冲经无界面 xterm 回放）；读不到返回 null。
    readCodeAgentRows = async () => null,
    codeagentPct = CODEAGENT_SOFT_PCT,
    codeagentCooldownMs = 60 * 1000,
    codeagentAckMs = 3000,
    codeagentPollMs = 10 * 1000,
    codeagentVerifyMs = 5 * 60 * 1000,
    codeagentDropRatio = 0.7,
    sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); }),
  } = deps;
  if (!sessionManager) throw new Error('soft-compact-controller 缺少 sessionManager');
  const compacting = new Map();
  const lastDone = new Map();
  // CodeAgent 每个会话：{ failures 连续失败次数, lastEnd 上次尝试结束时间, halted 已停手, meetingNoticed }
  const codeagentState = new Map();
  const caState = id => {
    if (!codeagentState.has(id)) codeagentState.set(id, { failures: 0, lastEnd: -Infinity, halted: false, meetingNoticed: false });
    return codeagentState.get(id);
  };
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
    if (session && /^codeagent/.test(String(session.kind || '')) && session.agentRuntime === 'pty') return onCodeAgentStop(sessionId, session);
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

  async function readCodeAgentScreen(sessionId) {
    let rows = null;
    try { rows = await readCodeAgentRows(sessionId); } catch {}
    if (!Array.isArray(rows)) return { rows: null, context: null, hints: 0 };
    return { rows, context: parseCodeAgentContext(rows), hints: countCompactHints(rows) };
  }

  // CodeAgent：Stop 时看 Stats 面板占用，到软线且空闲就压；返回 'success' | 'failed' | 'unknown' | null（没发）。
  async function onCodeAgentStop(sessionId, session) {
    const state = caState(sessionId);
    const before = await readCodeAgentScreen(sessionId);
    const pct = before.context?.contextPct;
    if (pct == null) return null;
    if (pct < codeagentPct) {
      // 占用已在软线以下（压缩生效或用户手动压过）：失败计数清零，停手的会话恢复自动压缩。
      if (state.halted || state.failures) logger.log(`[soft-compact] ${short(sessionId)} codeagent re-armed at ${pct}%`);
      state.halted = false; state.failures = 0;
      return null;
    }
    if (state.halted) return null;
    if (now() - state.lastEnd < codeagentCooldownMs) return null;
    if (session.meetingId) {
      if (!state.meetingNoticed) notice(sessionId, '群聊成员不自动压缩上下文，需要时手动输入 /compact。');
      state.meetingNoticed = true;
      return null;
    }
    const entry = { mode: 'wait', codeagent: true, startedAt: now(), timer: null, hookStarted: false, hookEnded: false };
    compacting.set(sessionId, entry);
    // 等 TUI 收完这一轮；期间用户发了新消息就不压，留给下一次空闲。
    await sleep(settleMs);
    if (isBusy(sessionId)) {
      finish(sessionId, entry);
      logger.log(`[soft-compact] ${short(sessionId)} codeagent skipped: new turn already running`);
      return null;
    }
    logger.log(`[soft-compact] ${short(sessionId)} codeagent context ${pct}% >= ${codeagentPct}%; sending /compact`);
    notice(sessionId, `CodeAgent 上下文占用 ${pct}%，已到 ${codeagentPct}% 软线，正在自动压缩。`);
    // PreCompact 确认只短等一下：CodeAgent 有没有这个钩子没取证，没确认不算失败，交给下面的复查判定；
    // 同时让 sendToPty 按「本地命令」收尾，不会因为没开工而补发回车。
    let ticket = null;
    try { ticket = observeCompact(sessionId); } catch {}
    const observer = {
      async wait() {
        let confirmed = false;
        try { confirmed = !!ticket && (await ticket.wait(codeagentAckMs)).ok; } catch {}
        entry.hookStarted = confirmed;
        return { ok: true, message: confirmed ? null : 'CodeAgent 未回压缩开始确认，改看 Stats 面板' };
      },
    };
    let sendError = null;
    try {
      const receipt = await sendToPty(sessionId, '/compact', session.kind, {
        requireReady: false, localCommandObserver: observer,
        clientSubmissionId: `soft-compact-${entry.startedAt}`,
      });
      if (!receipt || receipt.ok === false) sendError = receipt?.message || '未知原因';
    } catch (error) { sendError = error.message; }
    let result = null;
    let after = null;
    if (sendError) {
      result = 'failed';
    } else {
      // 复查：压缩结束钩子、屏幕新出现压缩提示、或占用明显下降，任一出现即成功。
      const rounds = Math.max(1, Math.ceil(codeagentVerifyMs / codeagentPollMs));
      for (let i = 0; i < rounds && !result; i++) {
        await sleep(codeagentPollMs);
        if (entry.hookEnded) { result = 'success'; break; }
        const screen = await readCodeAgentScreen(sessionId);
        if (screen.context) after = screen.context.contextPct;
        if (after != null && after <= pct * codeagentDropRatio) result = 'success';
        else if (screen.rows && screen.hints > before.hints) result = 'success';
      }
      if (!result) result = entry.hookEnded ? 'success' : after == null && !entry.hookStarted ? 'unknown' : 'failed';
    }
    try { ticket?.dispose?.(); } catch {}
    finish(sessionId, entry);
    state.lastEnd = now();
    const seconds = Math.round((now() - entry.startedAt) / 1000);
    const change = `${pct}%${after != null ? ` → ${after}%` : ''}`;
    logger.log(`[soft-compact] ${short(sessionId)} codeagent compact ${result} in ${seconds}s (${change})${sendError ? ' error=' + sendError : ''}`);
    if (result === 'success') {
      state.failures = 0;
      notice(sessionId, `上下文已自动压缩（${change}，用时 ${seconds} 秒）。`);
    } else if (result === 'unknown') {
      // 判断不了是否压成：不重复发，等占用回落到软线以下再恢复。
      state.halted = true;
      notice(sessionId, '已发送 /compact，但读不到 Stats 面板的占用，无法确认是否压缩成功；本会话暂停自动压缩，请看一下终端。', 'warning');
    } else {
      state.failures += 1;
      const why = sendError ? `发送失败：${sendError}` : `占用没有明显下降（${change}）`;
      if (state.failures >= CODEAGENT_MAX_FAILURES) {
        state.halted = true;
        notice(sessionId, `自动压缩连续 ${state.failures} 次没有生效（${why}），本会话不再自动压缩；需要时手动输入 /compact。`, 'warning');
      } else {
        notice(sessionId, `自动压缩没有生效（${why}），${Math.round(codeagentCooldownMs / 1000)} 秒后会话空闲时再试一次。`, 'warning');
      }
    }
    return result;
  }

  async function onCompactEnd(sessionId) {
    const entry = compacting.get(sessionId);
    if (!entry) return;
    // CodeAgent 由 onCodeAgentStop 的复查收尾，这里只记下「收到压缩结束」。
    if (entry.codeagent) { entry.hookEnded = true; return; }
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
    codeagentState.delete(sessionId);
  }

  return { start, onStop, onCompactEnd, forget, isCompacting: id => compacting.has(id) };
}

module.exports = { createSoftCompactController, findMarker, readClaudeContextTokens, countCompactHints, CONTINUE_PROMPT, SKIP_CONTINUE_PROMPT, CODEAGENT_SOFT_PCT };
