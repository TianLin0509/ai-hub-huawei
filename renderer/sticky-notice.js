'use strict';

// 常驻提示条：要用户手动关的提示（公司模型换号、退回个人号、反代没就绪的原因和处理办法）。
// 2.6 秒的轻提示（groupchat-fork-ui showForkToast）来不及读完这类较长的说明，2026-11-06 改为常驻、手动关。
// 同样的文字已经在显示就不再叠一条；多条按到达顺序叠放在右上角。

const STACK_ID = 'hub-sticky-notices';

function appendActionButton(document, host, label, run) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'hub-sticky-notice-close'; button.textContent = label;
  Object.assign(button.style, { marginLeft: '8px', cursor: 'pointer', font: 'inherit' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await run(); }
    catch (error) { button.textContent = `${error.message || '操作失败'}，点击重试`; }
    finally { button.disabled = false; }
  });
  host.appendChild(button);
  return button;
}

function appendCodeAgentLoginButton(document, host, ipcRenderer) {
  return appendActionButton(document, host, '登录', async () => {
    const result = await ipcRenderer.invoke('codeagent-pool:personal-login');
    if (result?.ok === false) throw new Error(result.error || '登录窗口未能打开');
  });
}

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

// 「原模型不可用，换一个继续」卡片（2026-11-12 重做版式）：标题一句话说清要做什么，原模型和原因单列，
// 下拉框选替代模型，底部「保持暂停 / 切换并继续」两个胶囊按钮。样式在 styles/model-notice.css，颜色走 --hw-* 主题变量。
function ensureModelNoticeStyle(document) {
  if (!document.head || document.getElementById('hub-model-notice-style')) return;
  const link = document.createElement('link');
  link.id = 'hub-model-notice-style'; link.rel = 'stylesheet'; link.href = 'styles/model-notice.css';
  document.head.appendChild(link);
}

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function modelNoticeReason(payload) {
  if (payload.reason) return String(payload.reason);
  const hit = String(payload.message || '').match(/不可用（([^）]+)）/);
  return hit ? hit[1] : '';
}

function showUnavailableModelNotice(document, payload, onSelect, onCancel) {
  const creating = payload.creation === true;
  const models = [...new Set([...(payload.availableModels || []), payload.suggestedModel])].filter(id => require('../core/codeagent-models').isSafeModelId(id));
  const suggested = models.includes(payload.suggestedModel) ? payload.suggestedModel : models[0];
  const original = payload.originalModel || '';
  const reason = modelNoticeReason(payload);
  const context = String(payload.contextLabel || '').replace(/^会话\s+/, '');
  const outcome = suggested
    ? (creating ? '确认后用新模型创建会话；取消则不创建。' : '确认后用新模型继续发送原消息；取消则会话保持暂停。')
    : (creating ? '暂无可用替代模型，未创建会话。' : '暂无可用替代模型，本条消息未发送。') + '请到「账号」页确认登录，再点击模型重新获取清单；恢复后重新发送。';
  const text = [payload.message, original && !String(payload.message).includes(original) ? `原模型 ${original} 不可用。` : '',
    suggested ? `建议换成 ${suggested}。` : '', outcome].filter(Boolean).join('\n');
  const root = stack(document);
  const key = payload.requestId || (payload.sessionId ? `model:${payload.sessionId}:${text}` : text);
  for (const item of root.children) if ((item.dataset.noticeKey || item.dataset.text) === key) return item;
  ensureModelNoticeStyle(document);

  const title = creating ? '新建会话需要换个模型' : '需要换个模型才能继续';
  const item = el(document, 'div', 'hub-sticky-notice hub-model-notice');
  Object.assign(item.dataset, { text, noticeKey: key, level: 'warning' });
  item.setAttribute('role', 'alertdialog');
  item.setAttribute('aria-label', title);

  const body = el(document, 'div', 'hmn-body');
  const head = el(document, 'div', 'hmn-head');
  const titles = el(document, 'div', 'hmn-titles');
  titles.appendChild(el(document, 'div', 'hmn-title', title));
  if (context) { const sub = el(document, 'div', 'hmn-context', context); sub.title = context; titles.appendChild(sub); }
  head.append(el(document, 'span', 'hmn-icon', '!'), titles);
  body.appendChild(head);

  if (original) {
    const fact = el(document, 'div', 'hmn-fact');
    const line = el(document, 'div', 'hmn-fact-line');
    line.append(el(document, 'span', 'hmn-fact-label', '原模型'), el(document, 'code', 'hmn-model', original), el(document, 'span', 'hmn-badge', '暂时用不了'));
    fact.appendChild(line);
    if (reason) fact.appendChild(el(document, 'div', 'hmn-fact-reason', `原因：${reason}`));
    body.appendChild(fact);
  } else body.appendChild(el(document, 'div', 'hmn-message', String(payload.message || '')));

  const parts = {};
  if (models.length) {
    const field = el(document, 'label', 'hmn-field');
    const select = el(document, 'select', 'hmn-select');
    select.setAttribute('aria-label', '选择可用模型');
    for (const model of models) {
      const option = el(document, 'option', '', model === suggested ? `${model}（推荐）` : model);
      option.value = model; select.appendChild(option);
    }
    select.value = suggested;
    select.title = suggested;
    select.addEventListener('change', () => { select.title = select.value; });
    field.append(el(document, 'div', 'hmn-field-label', '换成'), select);
    body.appendChild(field);
    parts.select = select;
  }
  body.appendChild(el(document, 'div', 'hmn-note', outcome));
  const errorLine = el(document, 'div', 'hmn-error');
  errorLine.setAttribute('role', 'alert');
  body.appendChild(errorLine);

  const actions = el(document, 'div', 'hmn-actions');
  const cancel = el(document, 'button', 'hmn-btn', models.length ? (creating ? '取消，不创建' : '保持暂停') : '知道了');
  cancel.type = 'button';
  cancel.title = creating ? '取消这次创建，不启动会话' : '关闭这张卡片，会话继续暂停';
  cancel.addEventListener('click', () => {
    if (cancel.disabled) return;
    item.remove();
    if (onCancel) Promise.resolve(onCancel()).catch(error => console.warn('[model-confirmation] 取消失败：', error.message));
  });
  actions.appendChild(cancel);
  parts.cancel = cancel;
  if (models.length) {
    const confirm = el(document, 'button', 'hmn-btn hmn-primary', creating ? '换成它并创建' : '切换并继续');
    confirm.type = 'button';
    confirm.addEventListener('click', async () => {
      const label = confirm.textContent;
      confirm.disabled = true; parts.select.disabled = true; cancel.disabled = true;
      confirm.textContent = '正在切换…'; errorLine.textContent = '';
      try {
        const result = await onSelect(parts.select.value);
        if (!result?.ok) throw new Error(result?.message || '模型未能切换');
        item.remove();
      } catch (error) { errorLine.textContent = `${error.message || '模型未能切换'}；可以换一个模型或再试一次。`; }
      finally { confirm.disabled = false; parts.select.disabled = false; cancel.disabled = false; confirm.textContent = label; }
    });
    actions.appendChild(confirm);
    parts.confirm = confirm;
    item.dataset.modelAction = payload.sessionId;
    item.dataset.modelRequestId = payload.requestId || '';
  }
  item.append(body, actions);
  item.modelParts = parts;
  root.appendChild(item);
  return item;
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

module.exports = { appendActionButton, appendCodeAgentLoginButton, showStickyNotice, showUnavailableModelNotice, registerModelCreationConfirmation, STACK_ID };
