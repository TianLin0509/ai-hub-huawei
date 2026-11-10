'use strict';

// A group wait can end without the native submission having an outcome. Keep
// that distinction in the persisted failure contract, bound to this attempt.
function nativeUnknownOutcome(result, { claude, codex, submissionId, providerTurnId } = {}) {
  if (!submissionId || result.status !== 'errored') return result;
  const record = claude?.records.get(submissionId);
  const runtime = codex?.runtime;
  const submission = runtime?.submission;
  const claudeUnknown = record?.submissionId === submissionId && record.status === 'unknown';
  const codexUnknown = submission?.id === submissionId && (submission.status === 'unknown'
    || (runtime.state === 'unknown' && providerTurnId && runtime.turnId === providerTurnId
      && submission.turnId === providerTurnId));
  const explicitUnknown = result.unconfirmed === true;
  if (!claudeUnknown && !codexUnknown && !explicitUnknown) return result;
  return { ...result, reason: 'submission_unknown', finality: 'unknown',
    ...(explicitUnknown ? { promptDelivered: null } : {}),
    submissionId, userMessageId: record?.userMessageId || result.userMessageId || null,
    providerTurnId: result.providerTurnId || providerTurnId || null,
    signalSource: claudeUnknown ? 'claude-stream-json' : codexUnknown ? 'codex-app-server' : result.signalSource || null,
    failure: { code: 'submission_unknown', category: 'reconciliation', retryable: false, autoRetry: false,
      action: 'reconcile_native_history', summary: '本条提交待核对' } };
}

module.exports = { nativeUnknownOutcome };
