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

function showStickyNotice(document, message, level = 'warning') {
  const text = String(message || '').trim();
  if (!text) return null;
  const root = stack(document);
  for (const item of root.children) if (item.dataset.text === text) return item;
  const item = document.createElement('div');
  item.className = 'hub-sticky-notice';
  item.dataset.text = text;
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
  close.addEventListener('click', () => item.remove());
  item.append(body, close);
  root.appendChild(item);
  return item;
}

module.exports = { showStickyNotice, STACK_ID };
