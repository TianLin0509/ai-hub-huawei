'use strict';

const models = require('./codeagent-models');

function transcriptKind(session) {
  const kind = String(session?.kind || '').replace(/-resume$/, '');
  if (['claude', 'codeagent', 'deepseek-claude', 'deepseek-legacy'].includes(kind)) return 'claude';
  if (['codex', 'deepseek'].includes(kind)) return 'codex';
  return null;
}

// Only read the session's own bound file. Never use terminal text, another
// session's settings, or an event's cached model as evidence of a new choice.
async function readActualModel(session, { file = session?.transcriptPath, parserService } = {}) {
  const kind = transcriptKind(session);
  if (!file || !kind) return null;
  if (kind === 'claude') {
    const last = await require('./read-last-assistant').readLastAssistantMessage(file);
    return last && models.isSafeModelId(last.model) ? last : null;
  }
  const parser = require('./codex-transcript-parser');
  if (!session.codexSid || !parser.isUsableCodexRolloutPath(file, session.codexSid)) return null;
  const opts = { limit: 2, fromTail: true };
  const turns = parserService ? (await parserService.parse('codex', file, opts)).turns
    : parser.parseCodexRolloutToTurns(file, opts);
  const last = turns.filter(turn => turn.role === 'assistant').at(-1);
  return last && models.isSafeModelId(last.model) ? last : null;
}

function actualModelFields(session, id, target = id) {
  const fields = {};
  const previous = session.actualModel;
  const launchModel = previous?.launchModel || session.fixedModel || session.currentModel?.id || id;
  const terminalSwitch = !!target && target !== launchModel;
  if (previous?.id !== id || previous?.launchModel !== launchModel || !!previous?.terminalSwitch !== terminalSwitch) {
    fields.actualModel = { id, launchModel, ...(terminalSwitch ? { terminalSwitch: true } : {}) };
  }
  if (target && target !== session.fixedModel) {
    fields.fixedModel = target;
    fields.modelPinSource = 'cli';
    fields.modelChange = null;
  }
  if (target && target !== session.currentModel?.id) fields.currentModel = { id: target, displayName: models.modelLabel(target) };
  return fields;
}

function actualModelStatus(session) {
  const actual = session?.actualModel;
  if (!models.isSafeModelId(actual?.id)) return '';
  return actual.terminalSwitch ? `实际在用：${actual.id} · 终端里已切到 ${actual.id}` : `实际在用：${actual.id}`;
}

module.exports = { transcriptKind, readActualModel, actualModelFields, actualModelStatus };
