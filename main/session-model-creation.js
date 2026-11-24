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

function readUnavailablePolicy() {
  try { return pins.unavailablePolicy(require('../core/hub-config').getConfig().sessionModelUnavailablePolicy); }
  catch { return pins.unavailablePolicy(); }
}

function createSessionWithModelPolicy({ kind, opts, create, requestConfirmation, sendToRenderer, contextLabel = '新建会话', operation = 'create', canCreate = () => true,
  dataDir = null, getPolicy = readUnavailablePolicy, modelLabel = '默认模型' }) {
  if (!/^codeagent(?:-resume)?$/.test(kind)) return create(kind, opts);
  const launchOpts = { ...opts, modelCreationContext: contextLabel };
  const explicitModel = require('../core/codeagent-launch-model').explicitModel(launchOpts);
  // 这次新建是否带着调用方指定的模型（用户在启动中心点选、复制来源会话的模型、调度方指定）：带着的不自动换，照旧确认。
  const chosenModel = !!(opts.fixedModel || opts.codeagentUserModel || explicitModel);
  const hubDataDir = () => dataDir || require('../core/data-dir').getHubDataDir();
  if (!launchOpts.fixedModel && explicitModel) {
    launchOpts.model = launchOpts.fixedModel = explicitModel;
    launchOpts.codeagentModelPick = true;
    launchOpts.modelPinSource = 'user';
  }
  // 未创建、恢复保持停止、已取消这类提示是这次操作的最终结果，传 'blocking' 让提示闸门（core/notice-gate.js）放行。
  const notice = (message, noticeKind) => sendToRenderer?.('session-notice', { level: 'warning', persistent: true, noticeKind, message: `${contextLabel}：${message}` });
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
      notice(`${error.message} 当前问题不能通过换模型解决，请升级 CLI 或修复会话设置文件后重试。未创建会话。`, 'blocking');
      throw Object.assign(error, operation === 'resume' ? { stopped: true, notSent: true } : {});
    }
    if (!availableModels.length || typeof requestConfirmation !== 'function') {
      notice(`${error.message} ${operation === 'resume' ? '恢复保持停止。' : '未创建会话。'}`, 'blocking');
      throw Object.assign(error, operation === 'resume' ? { stopped: true, notSent: true } : {});
    }
    // 新建会话、模型只是账号默认推出来的（2026-11-24 用户决定）：默认模型下线时直接换成推荐模型创建，只给一行提示，不弹确认卡片。
    // 推荐口径见 core/session-model-pin.js recommendedReplacement；替换记进 codeagent-model-replacements，之后的新建在启动前就直接用它，
    // 同一替换只在第一次提示。设置里选了「停下来问我」（stop-and-ask）时照旧确认。
    const autoModel = operation === 'create' && !chosenModel && getPolicy() !== 'stop-and-ask'
      ? pins.recommendedReplacement(error.model, availableModels, error.suggestedModel) : '';
    if (autoModel) {
      const replacements = require('../core/codeagent-model-replacements');
      let seen = false;
      try { seen = replacements.replacementFor(hubDataDir(), error.model).toLowerCase() === autoModel.toLowerCase(); } catch { seen = false; }
      try { replacements.recordReplacement(hubDataDir(), error.model, autoModel); }
      catch (failure) { console.warn('[model-confirmation] 记住替代模型失败：', failure.message); }
      const retryOpts = { ...launchOpts, model: autoModel, fixedModel: autoModel, modelPinSource: 'auto-switch', modelChange: null,
        codeagentModelPick: false, modelConfirmationRequired: false, modelUnavailableReason: '' };
      delete retryOpts._openLeaseNonce;
      const announce = session => {
        // 一次性一行轻提示（renderer/session-create-toast.js，约 10 秒自动消失），按钮「换一个」打开这个会话的模型菜单。
        if (!seen && session?.id) sendToRenderer?.('session-create-followup', { sessionId: session.id, actions: ['pick-model'],
          message: `${modelLabel} ${error.model} 已不可用，已改用 ${autoModel}` });
        return session;
      };
      // 换上的模型也起不来时，下一轮带着 fixedModel，会走下面的确认卡片，不会反复自动换。
      const retried = createSessionWithModelPolicy({ kind, opts: retryOpts, create, requestConfirmation, sendToRenderer, contextLabel, operation, canCreate, dataDir, getPolicy, modelLabel });
      return retried?.then ? retried.then(announce) : announce(retried);
    }
    return Promise.resolve(requestConfirmation({ originalModel: error.model, reason: error.reason || '', suggestedModel: pins.recommendedReplacement(error.model, availableModels, error.suggestedModel) || error.suggestedModel,
      availableModels, contextLabel, operation, sessionId: operation === 'resume' ? launchOpts.id : undefined, creation: operation !== 'resume',
      message: `${contextLabel}：${error.message}` })).then(selected => {
      if (!selected) {
        const message = operation === 'resume' ? '已取消恢复，原会话与待发任务保持停止。' : '已取消，未创建会话；需要时可重新发起创建。';
        notice(message, 'blocking');
        throw Object.assign(new Error(message), { code: operation === 'resume' ? 'SESSION_MODEL_CONFIRMATION_CANCELLED' : 'SESSION_CREATION_CANCELLED', notCreated: true, notSent: true, stopped: true });
      }
      if (!availableModels.includes(selected)) throw new Error('所选模型不在本次可用清单内，未创建会话');
      try { require('../core/codeagent-model-replacements').recordReplacement(hubDataDir(), error.model, selected); }
      catch (failure) { console.warn('[model-confirmation] 记住替代模型失败：', failure.message); }
      const retryOpts = { ...launchOpts, model: selected, fixedModel: selected, codeagentUserModel: selected,
        modelPinSource: 'user', modelChange: null, codeagentModelPick: false, modelConfirmationRequired: false, modelUnavailableReason: '' };
      // A failed create released its lease; the retry must acquire a fresh one.
      delete retryOpts._openLeaseNonce;
      return createSessionWithModelPolicy({ kind, opts: retryOpts,
        create, requestConfirmation, sendToRenderer, contextLabel, operation, canCreate, dataDir, getPolicy, modelLabel });
    }).catch(failure => { throw Object.assign(failure, operation === 'resume' ? { stopped: true, notSent: true } : {}); });
  };
  try {
    if (!canCreate()) throw Object.assign(new Error('原会话已被删除或历史身份已变化，本次操作保持停止。'), { notSent: true, stopped: true });
    const result = create(kind, launchOpts);
    return result?.then ? result.then(created, failed) : created(result);
  } catch (error) { return failed(error); }
}

module.exports = { createModelCreationConfirmation, createSessionWithModelPolicy };
