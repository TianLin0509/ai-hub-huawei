'use strict';

const { randomUUID } = require('node:crypto');
const models = require('../core/codeagent-models');
const pins = require('../core/session-model-pin');

// Main keeps the original creation call suspended. Renderer receives only the
// model choices/context, never the account options or the creation callback.
function createModelCreationConfirmation({ sendToRenderer, onWait = () => {} }) {
  const pending = new Map();
  const notifyWait = event => { try { onWait(event); } catch (error) { console.warn('[model-confirmation] status notification failed:', error.message); } };
  let rendererReady = true;
  function finish(requestId, selected, cancelReason = null) {
    const item = pending.get(requestId);
    if (!item) return false;
    pending.delete(requestId);
    item.signal?.removeEventListener('abort', item.abort);
    if (item.wait) notifyWait({ ...item.wait, active: false, selectedModel: selected, cancelReason });
    item.resolve(selected);
    if (selected === null) {
      try { sendToRenderer('session-model-confirmation-dismissed', { requestId }); } catch { /* renderer already gone */ }
    }
    return true;
  }
  function request(payload, { signal, onWaitRegistered } = {}) {
    if (!rendererReady) return Promise.reject(new Error('确认界面正在重载或不可用，本次操作已停下；请稍后重试'));
    if (signal?.aborted) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => finish(requestId, null, 'submission-aborted');
      const wait = payload.sessionId ? { sessionId: payload.sessionId, key: requestId, originalModel: payload.originalModel,
        suggestedModel: payload.suggestedModel || null, operation: payload.operation || 'selection', clientSubmissionIds: payload.clientSubmissionIds || [], workflowMessageIds: payload.workflowMessageIds || [],
        reason: `等待模型确认（原模型 ${payload.originalModel}，建议 ${payload.suggestedModel || '请手动选择'}），原任务尚未发送。` } : null;
      const item = { resolve, availableModels: payload.availableModels, sessionId: payload.sessionId, signal, abort, wait };
      pending.set(requestId, item);
      const refreshWait = () => {
        if (!wait || pending.get(requestId) !== item) return;
        item.wait = { ...wait, clientSubmissionIds: [...(payload.clientSubmissionIds || [])], workflowMessageIds: [...(payload.workflowMessageIds || [])] };
        notifyWait({ ...item.wait, active: true });
      };
      signal?.addEventListener('abort', abort, { once: true });
      try { onWaitRegistered?.(refreshWait); refreshWait(); sendToRenderer('session-model-create-confirm', { ...payload, requestId }); }
      catch (error) { pending.delete(requestId); signal?.removeEventListener('abort', abort); if (wait) notifyWait({ ...wait, active: false }); reject(error); }
    });
  }
  function respond({ requestId, modelId, cancel = false } = {}) {
    const item = pending.get(requestId);
    if (!item) return { ok: false, message: '这次模型确认已结束，请重新发起操作' };
    if (!cancel && (!models.isSafeModelId(modelId) || !item.availableModels.includes(modelId))) {
      return { ok: false, message: '请选择本次确认中的可用模型' };
    }
    finish(requestId, cancel ? null : modelId, cancel ? 'user' : null);
    return { ok: true };
  }
  function cancelAll() { for (const requestId of [...pending.keys()]) finish(requestId, null, 'context-lost'); }
  function cancelSession(sessionId) {
    for (const [requestId, item] of pending) if (item.sessionId === sessionId) finish(requestId, null, 'session-closed');
  }
  function attachRenderer(contents) {
    rendererReady = false;
    const lost = () => { rendererReady = false; cancelAll(); };
    contents.on('did-finish-load', () => { rendererReady = true; });
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) lost(); });
    contents.on('render-process-gone', lost);
    contents.on('destroyed', lost);
  }
  return { request, respond, cancelAll, cancelSession, attachRenderer };
}

function createSessionWithModelPolicy({ kind, opts, create, requestConfirmation, sendToRenderer, contextLabel = '新建会话', operation = 'create', canCreate = () => true }) {
  if (!/^codeagent(?:-resume)?$/.test(kind)) return create(kind, opts);
  const launchOpts = { ...opts, modelCreationContext: contextLabel };
  if (!launchOpts.fixedModel && launchOpts.codeagentModelPick === true && models.isSafeModelId(launchOpts.model)) {
    launchOpts.fixedModel = launchOpts.model;
    launchOpts.modelPinSource = 'user';
  }
  const notice = message => sendToRenderer?.('session-notice', { level: 'warning', persistent: true, message: `${contextLabel}：${message}` });
  const created = session => {
    if (session?.modelChange && ['from', 'to', 'reason', 'at'].some(key => session.modelChange[key] !== launchOpts.modelChange?.[key])) {
      notice(pins.modelChangeMessage(session.modelChange));
    }
    return session;
  };
  const failed = error => {
    if (error.code !== 'SESSION_MODEL_UNAVAILABLE') throw error;
    const availableModels = [...new Set([...(error.availableModels || []), error.suggestedModel])].filter(models.isSafeModelId);
    if (error.canChooseAlternative === false) {
      notice(`${error.message} 当前问题不能通过换模型解决，请升级 CLI 或修复会话设置文件后重试。未创建会话。`);
      throw Object.assign(error, operation === 'resume' ? { stopped: true, notSent: true } : {});
    }
    if (!availableModels.length || typeof requestConfirmation !== 'function') {
      notice(`${error.message} ${operation === 'resume' ? '恢复保持停止。' : '未创建会话。'}`);
      throw Object.assign(error, operation === 'resume' ? { stopped: true, notSent: true } : {});
    }
    return Promise.resolve(requestConfirmation({ originalModel: error.model, reason: error.reason || '', suggestedModel: error.suggestedModel,
      availableModels, contextLabel, operation, sessionId: operation === 'resume' ? launchOpts.id : undefined, creation: operation !== 'resume',
      message: `${contextLabel}：${error.message}` })).then(selected => {
      if (!selected) {
        const message = operation === 'resume' ? '已取消恢复，原会话与待发任务保持停止。' : '已取消，未创建会话；需要时可重新发起创建。';
        notice(message);
        throw Object.assign(new Error(message), { code: operation === 'resume' ? 'SESSION_MODEL_CONFIRMATION_CANCELLED' : 'SESSION_CREATION_CANCELLED', notCreated: true, notSent: true, stopped: true });
      }
      if (!availableModels.includes(selected)) throw new Error('所选模型不在本次可用清单内，未创建会话');
      try { require('../core/codeagent-model-replacements').recordReplacement(require('../core/data-dir').getHubDataDir(), error.model, selected); }
      catch (failure) { console.warn('[model-confirmation] 记住替代模型失败：', failure.message); }
      const retryOpts = { ...launchOpts, model: selected, fixedModel: selected, codeagentUserModel: selected,
        modelPinSource: 'user', modelChange: null, codeagentModelPick: false, modelConfirmationRequired: false, modelUnavailableReason: '' };
      // A failed create released its lease; the retry must acquire a fresh one.
      delete retryOpts._openLeaseNonce;
      return createSessionWithModelPolicy({ kind, opts: retryOpts,
        create, requestConfirmation, sendToRenderer, contextLabel, operation, canCreate });
    }).catch(failure => { throw Object.assign(failure, operation === 'resume' ? { stopped: true, notSent: true } : {}); });
  };
  try {
    if (!canCreate()) throw Object.assign(new Error('原会话已被删除或历史身份已变化，本次操作保持停止。'), { notSent: true, stopped: true });
    const result = create(kind, launchOpts);
    return result?.then ? result.then(created, failed) : created(result);
  } catch (error) { return failed(error); }
}

module.exports = { createModelCreationConfirmation, createSessionWithModelPolicy };
