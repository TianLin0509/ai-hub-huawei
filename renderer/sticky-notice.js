'use strict';

// 常驻提示条：要用户手动关的提示（公司模型换号、退回个人号、反代没就绪的原因和处理办法）。
// 2.6 秒的轻提示（groupchat-fork-ui showForkToast）来不及读完这类较长的说明，2026-11-06 改为常驻、手动关。
// 同样的文字已经在显示就不再叠一条；多条按到达顺序叠放在右上角。

const STACK_ID = 'hub-sticky-notices';

function stack(document) {
  let el = document.getElementById(STACK_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = STACK_ID;
    Object.assign(el.style, {
      // 右上角：右下角会挡住输入框和发送按钮（2026-11-06 1440 宽截图自查）。
      position: 'fixed', right: '20px', top: '64px', zIndex: '100001', display: 'flex', flexDirection: 'column', gap: '8px',
      maxWidth: 'min(460px, calc(100vw - 40px))',
    });
    document.body.appendChild(el);
  }
  return el;
}

function showStickyNotice(document, message, level = 'warning', options = {}) {
  const text = String(message || '').trim();
  if (!text) return null;
  const root = stack(document);
  const key = options.key || text;
  for (const item of root.children) if ((item.dataset.noticeKey || item.dataset.text) === key) return item;
  const item = document.createElement('div');
  item.className = 'hub-sticky-notice';
  item.dataset.text = text;
  item.dataset.noticeKey = key;
  item.dataset.level = level === 'error' ? 'error' : 'warning';
  item.setAttribute('role', level === 'error' ? 'alert' : 'status');
  Object.assign(item.style, {
    display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 12px 12px 14px', borderRadius: '10px',
    background: 'var(--hw-surface-1, #ffffff)', color: 'var(--hw-text-1, #182431)',
    borderLeft: `4px solid ${level === 'error' ? 'var(--hw-red, #d63b3b)' : 'var(--hw-amber, #e8780c)'}`,
    boxShadow: '0 8px 28px rgba(0,0,0,.18)', font: '13px/1.55 "Microsoft YaHei", "Segoe UI", sans-serif',
  });
  const body = document.createElement('div');
  body.className = 'hub-sticky-notice-text';
  Object.assign(body.style, { flex: '1', whiteSpace: 'pre-line', overflowWrap: 'anywhere', maxHeight: '40vh', overflowY: 'auto' });
  body.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hub-sticky-notice-close';
  close.textContent = '知道了';
  close.title = '关闭这条提示';
  Object.assign(close.style, {
    flex: 'none', border: '1px solid var(--hw-border, #d5dae0)', borderRadius: '6px', background: 'transparent',
    color: 'var(--hw-text-2, #58626d)', font: 'inherit', fontSize: '12px', padding: '2px 8px', cursor: 'pointer',
  });
  close.addEventListener('click', () => {
    if (close.disabled) return;
    item.remove();
    if (options.onClose) Promise.resolve(options.onClose()).catch(error => console.warn('[model-confirmation] 取消失败：', error.message));
  });
  // 错误类（5.5.24）：命中已知问题时在原文下直接给解法；悬停这条提示时出现「问问 Agent」「一键反馈」。
  if (level === 'error') {
    try {
      const card = require('./hub-error-card');
      const ctx = { area: 'notice', title: text.split(/\r?\n/)[0].slice(0, 120), symptom: text, details: text };
      const extra = document.createElement('div');
      extra.innerHTML = card.knownHtml(ctx) + card.assistHtml(ctx);
      body.append(...extra.childNodes);
    } catch (error) { console.warn('[sticky-notice] 求助按钮没挂上：', error && error.message); }
  }
  item.append(body, close);
  root.appendChild(item);
  return item;
}

function showUnavailableModelNotice(document, payload, onSelect, onCancel) {
  const creating = payload.creation === true;
  const models = [...new Set([...(payload.availableModels || []), payload.suggestedModel])].filter(id => require('../core/codeagent-models').isSafeModelId(id));
  const suggested = models.includes(payload.suggestedModel) ? payload.suggestedModel : models[0];
  const message = [payload.message, payload.originalModel && !String(payload.message).includes(payload.originalModel) ? `原模型 ${payload.originalModel} 不可用。` : '',
    suggested ? `建议换成 ${suggested}（可改选其他模型）。${creating ? '确认后创建，取消则不创建会话。' : '确认后切换并继续，取消保持暂停。'}` : (creating ? '暂无可用替代模型，未创建会话。' : '暂无可用替代模型，会话保持暂停。')].filter(Boolean).join('\n');
  const notice = showStickyNotice(document, message, 'warning', { key: payload.requestId || (payload.sessionId ? `model:${payload.sessionId}:${message}` : undefined), onClose: onCancel });
  if (!notice || notice.dataset.modelAction) return notice;
  notice.children[1].textContent = creating ? '取消，不创建' : '取消，保持暂停';
  notice.children[1].title = creating ? '取消这次创建，不启动会话' : '关闭确认提示，会话继续暂停';
  if (!models.length) return notice;
  notice.dataset.modelAction = payload.sessionId;
  notice.dataset.modelRequestId = payload.requestId || '';
  const controls = document.createElement('div');
  Object.assign(controls.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' });
  const select = document.createElement('select');
  select.setAttribute('aria-label', '选择可用模型');
  select.style.maxWidth = '100%';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model; option.textContent = model; select.appendChild(option);
  }
  select.value = suggested;
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = creating ? '确认并创建' : '确认切换并继续';
  button.addEventListener('click', async () => {
    button.disabled = true;
    select.disabled = true;
    notice.children[1].disabled = true;
    try {
      const result = await onSelect(select.value);
      if (!result?.ok) throw new Error(result?.message || '模型未能切换');
      notice.remove();
    } catch (error) { button.textContent = error.message; }
    finally { button.disabled = false; select.disabled = false; notice.children[1].disabled = false; }
  });
  controls.append(select, button);
  notice.children[0].appendChild(controls);
  return notice;
}

function registerModelCreationConfirmation(ipcRenderer, document) {
  ipcRenderer.on('session-model-confirmation-dismissed', (_event, payload) => {
    const root = document.getElementById(STACK_ID);
    if (root) for (const item of [...root.children]) if (item.dataset.noticeKey === payload.requestId) item.remove();
  });
  ipcRenderer.on('session-model-create-confirm', (_event, payload) => {
    if (payload.creation === false && payload.sessionId) {
      const root = document.getElementById(STACK_ID);
      if (root) for (const item of [...root.children]) {
        if (item.dataset.modelAction === payload.sessionId && !item.dataset.modelRequestId) item.remove();
      }
    }
    showUnavailableModelNotice(document, { ...payload, creation: payload.creation !== false },
      modelId => ipcRenderer.invoke('session:model-create-decision', { requestId: payload.requestId, modelId }),
      () => ipcRenderer.invoke('session:model-create-decision', { requestId: payload.requestId, cancel: true }));
  });
}

module.exports = { showStickyNotice, showUnavailableModelNotice, registerModelCreationConfirmation, STACK_ID };
