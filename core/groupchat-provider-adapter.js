'use strict';

const {
  ACP_FINAL_SOURCES,
  attemptEventMatches,
  classifyProviderFailure,
  isAuthoritativeFinalSignal,
  normalizeProviderFamily,
} = require('./groupchat-attempt-protocol.js');

class GroupChatProviderAdapter {
  constructor(kind, options = {}) {
    this.kind = kind || 'unknown';
    this.nativeOnly = options.nativeOnly === true;
    this.family = normalizeProviderFamily(kind);
    this.nativeSource = require('./acp-profiles').isAcpKind(kind) ? 'acp' : 'codex-app-server';
    // ACP 类 kind 跑在终端里（DSH CLI、千问 CLI 等）时，回合事件来源是 provider-cli / qwen-cli，同样是权威信号。
    this.nativeSources = this.nativeSource === 'acp' ? ACP_FINAL_SOURCES : new Set([this.nativeSource]);
  }

  match(attempt, event, options = {}) {
    if (this.nativeOnly && !this.nativeSources.has(event?.signalSource)) {
      return {ok:false,reason:'native_lifecycle_required'};
    }
    return attemptEventMatches(attempt, event, {
      kind: this.kind,
      // Codex exposes a real turn id. Once an attempt has bound one, refusing
      // an unscoped completion is safer than attaching it to the wrong turn.
      requireProviderTurn: this.family === 'codex' || this.family === 'claude' || this.nativeSource === 'acp',
      ...options,
    });
  }

  completion(attempt, event = {}) {
    const identity = this.match(attempt, event);
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    const source = event.signalSource || '';
    if (attempt && !isAuthoritativeFinalSignal(this.kind, source)) {
      return { accepted: false, reason: 'non_final_signal', identity };
    }
    const text = String(event.text || '').trim();
    if (this.nativeSources.has(event.signalSource)) {
      return {accepted:true,status:'completed',text,identity,emptyResult:!text};
    }
    // Only error/system envelopes are failure evidence. An assistant can
    // legitimately explain HTTP 429, authentication, or service outages.
    const failure = event.errorInfo || event.error || event.type === 'system'
      ? classifyProviderFailure({ message:event.error || text, errorInfo:event.errorInfo, force:true }) : null;
    if (failure) {
      return {
        accepted: true,
        status: 'errored',
        text,
        failure,
        reason: failure.code,
        identity,
      };
    }
    if (!text || (event.extractMode && event.extractMode !== 'final_answer')) {
      return {
        accepted: false,
        reason: 'terminal_without_final_text',
        awaitingFinalText: true,
        identity,
      };
    }
    return { accepted: true, status: 'completed', text, identity };
  }

  error(attempt, event = {}) {
    const identity = this.match(attempt, event, { requireProviderTurn: false });
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    const failure = classifyProviderFailure({
      reason: event.reason,
      message: event.message,
      errorInfo: event.errorInfo,
      force: true,
    });
    return {
      accepted: true,
      status: 'errored',
      text: String(event.text || ''),
      reason: failure.code,
      failure,
      identity,
    };
  }

  aborted(attempt, event = {}) {
    const identity = this.match(attempt, event, { requireProviderTurn: false });
    if (!identity.ok) return { accepted: false, reason: identity.reason, identity };
    return {
      accepted: true,
      status: 'interrupted',
      text: String(event.text || ''),
      reason: 'provider_aborted',
      identity,
    };
  }
}

function createGroupChatProviderAdapter(kind, options) {
  return new GroupChatProviderAdapter(kind, options);
}

module.exports = {
  GroupChatProviderAdapter,
  createGroupChatProviderAdapter,
};
