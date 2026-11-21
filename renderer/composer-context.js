'use strict';

// Ordinary and group composers share the same remaining/used presentation.
// The ring continues to show usage; its adjacent number shows the space left.
function createComposerContext(document) {
  const element = document.createElement('span');
  element.className = 'composer-context-budget';
  element.hidden = true;
  const value = document.createElement('span');
  value.className = 'composer-context-value';
  const ring = document.createElement('span');
  ring.className = 'composer-ctx';
  ring.setAttribute('aria-hidden', 'true');
  ring.appendChild(document.createElement('i'));
  element.append(value, ring);
  return {
    element,
    update(context, label = '') {
      element.hidden = !context?.visible;
      if (element.hidden) {
        value.textContent = '';
        element.removeAttribute('title');
        element.removeAttribute('aria-label');
        return;
      }
      if (!Number.isFinite(context.percent)) {
        value.textContent = '未知';
        ring.hidden = true;
        element.title = context.title || '上下文窗口未知';
        element.setAttribute('aria-label', context.ariaLabel || '上下文窗口未知');
        return;
      }
      ring.hidden = false;
      const remaining = 100 - context.percent;
      value.textContent = `${remaining}%`;
      ring.dataset.level = context.level;
      ring.style.setProperty('--composer-ctx-pct', `${context.percent}%`);
      element.title = `${label ? label + ' · ' : ''}上下文剩余 ${remaining}%；${context.title}`;
      element.setAttribute('aria-label', `${label ? label + '，' : ''}上下文剩余 ${remaining}%`);
    },
  };
}

module.exports = { createComposerContext };
