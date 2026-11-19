'use strict';

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Card bodies show image destinations as links. Keep this per parse so file
// previews and other Markdown surfaces still use the normal image renderer.
function parseCardMarkdown(marked, text) {
  return marked.parse(text, {
    breaks: true,
    gfm: true,
    walkTokens(token) {
      // An image inside an existing link must not create nested anchors.
      if (token.type === 'link') {
        marked.walkTokens(token.tokens || [], child => {
          if (child.type !== 'image') return;
          child.type = 'text';
          child.text = /^data:/i.test(child.href || '') ? child.text || '查看图片' : child.href || child.text;
          delete child.tokens;
        });
      }
      if (token.type !== 'image') return;
      // 图片先输出成占位：文字仍是原来的地址（没经过 card-media 时照旧可读、可点路径），
      // 卡片挂上后由 renderer/card-media.js 按安全规则换成真图片。
      const href = token.href || '';
      const label = /^data:/i.test(href) ? token.text || '查看图片' : href || token.text || '查看图片';
      token.type = 'text';
      token.text = '<span class="card-md-image" data-md-image-src="' + escapeHtml(href) + '"'
        + ' data-md-image-alt="' + escapeHtml(token.text || '') + '">'
        + (/^data:/i.test(href) ? escapeHtml(label) : '<a href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a>') + '</span>';
      token.escaped = true;
      delete token.tokens;
    },
  });
}

// 没接图片处理的页面（如群聊会议室）用：data: 内嵌图片恢复成原来那个「可点开的缩略图按钮」，
// 点击由 card-detail-controls 的 card-open-image 处理；其余图片保持占位里的原地址链接。
function restoreDataImageThumbs(root) {
  if (!root?.querySelectorAll) return root;
  const doc = root.ownerDocument || root;
  for (const holder of root.querySelectorAll('.card-md-image[data-md-image-src]')) {
    const src = holder.getAttribute('data-md-image-src') || '';
    if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i.test(src)) continue;
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'conversation-image-thumb';
    button.setAttribute('data-action', 'card-open-image'); button.setAttribute('data-image-src', src);
    button.textContent = holder.getAttribute('data-md-image-alt') || '查看图片';
    holder.replaceWith(button);
  }
  return root;
}

module.exports = { parseCardMarkdown, restoreDataImageThumbs };
