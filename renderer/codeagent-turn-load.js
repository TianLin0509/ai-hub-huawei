'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');
const { sessionRuntimeIsActive } = require('../core/session-runtime-truth');
const { modelUsage } = require('../core/codeagent-usage-menu');
const MODEL_LOAD_MAX_AGE_MS = 15 * 60 * 1000;

function currentTurnModelLoad({ session, turn, isLatest, entry, now = Date.now() }) {
  if (!isLatest || !isCodeAgentKind(session?.kind) || turn?.role !== 'assistant'
      || turn.inherited || turn.searchReadonly || !turn.model) return null;
  const at = entry?.modelsAt ?? entry?.at;
  if (!Number.isFinite(at) || at > now || now - at > MODEL_LOAD_MAX_AGE_MS) return null;
  const active = sessionRuntimeIsActive(session, { now });
  const turnAt = turn.tsEnd || turn.ts;
  const startedAt = session.runStartedAt || session.runtimeTruth?.startedAt;
  if (active && Number.isFinite(startedAt) && (!Number.isFinite(turn.ts) || turn.ts < startedAt)) return null;
  // 重开旧会话的最后一张卡也是历史；只给正在进行或刚结束的最新回复标当前读数。
  if (!active && (!Number.isFinite(turnAt) || turnAt > now || now - turnAt > MODEL_LOAD_MAX_AGE_MS)) return null;
  const model = modelUsage(entry, turn.model);
  if (!['低负载', '中负载', '高负载'].includes(model?.load)) return null;
  return { text: model.load, at, expiresAt: Math.min(at + MODEL_LOAD_MAX_AGE_MS, active ? Infinity : turnAt + MODEL_LOAD_MAX_AGE_MS) };
}

// 只改负载节点，不改回答正文、卡片根节点或内容签名。
function patchTurnModelLoad(card, hint, document) {
  let badge = card?.querySelector('.turn-model-load');
  if (!hint) { badge?.remove(); return; }
  const who = card.querySelector('.turn-who');
  if (!who) return;
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'turn-model-load';
    badge.setAttribute('data-copy-exclude', '');
    who.insertAdjacentElement('afterend', badge);
  }
  const title = `当前模型负载快照 · 读取时间：${new Date(hint.at).toLocaleString('zh-CN', { hour12: false })}`;
  if (badge.textContent !== hint.text) badge.textContent = hint.text;
  if (badge.title !== title) badge.title = title;
}

module.exports = { currentTurnModelLoad, patchTurnModelLoad, MODEL_LOAD_MAX_AGE_MS };
