'use strict';
// 英文界面的整页翻译层（2026-11-20）。只在用户把语言选成 English 时启用；中文模式不装观察器、不碰任何节点。
// 做法：扫描界面里的文字节点和提示类属性，按 core/i18n 词典把中文原文换成英文；
// 之后界面脚本再写进来的中文，由 MutationObserver 在同一帧绘制前换掉，用户看不到闪烁。
// 会话正文、终端、输入框、代码与公式等「用户或 AI 的内容」不翻（SKIP_SELECTOR），
// 也可在任意元素上加 data-i18n-skip 排除整棵子树。切回中文时按记下的原文逐个还原。

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-hub-tip', 'data-tooltip', 'data-tip'];
const SKIP_SELECTOR = [
  '[data-i18n-skip]', '.xterm', 'textarea', '[contenteditable=""]', '[contenteditable="true"]',
  'pre', 'code', '.katex', 'webview', 'script', 'style',
  // 会话卡片只跳过用户/AI 的内容：正文（.turn-body）、思考正文与摘要里的预览、工具命令与工具结果摘要、原生提交原文、
  // 简洁样式的进展时间线、附件文件名、交付结果里的命令与路径；卡片头部、操作按钮、工具状态是界面文字照常翻（session 组 2026-11-20）
  '.turn-body', '.tc-row-cmd', '.tc-human', '.assistant-turn-context', '.turn-thinking-body', '.turn-thinking-preview',
  '.turn-active-output', '.chat-message-bubble', '.chat-progress-timeline', '.conversation-image-name',
  '.rt-file-link', '.turn-delivery-check > span:not(.turn-delivery-icon)',
  '.conversation-long-message', '.preview-markdown', '.markdown-body',
  // 原生提问的 label/直属按钮是 AI 提供的正文与选项；操作按钮在 .codex-native-actions 内，仍翻译。
  '.codex-native-request > label', '.codex-native-request > button',
  '.sl-title', '.terminal-title', '#mr-title', '#session-title',
].join(',');
const CJK = /[㐀-鿿豈-﫿]/;

function createDomTranslator({ document, i18n, skipSelector = SKIP_SELECTOR }) {
  const win = document.defaultView;
  const textOriginals = new Map();   // 文字节点 → 中文原文
  const attrOriginals = new Map();   // 元素 → { 属性: 中文原文 }
  let observer = null;
  let writing = false;
  let titleOriginal = null;

  function skipped(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return true;
    if (el.closest(skipSelector)) return true;
    if (el.tagName === 'INPUT' && !/^(button|submit|reset)$/i.test(el.type || '')) return true;
    return false;
  }

  function translateText(node) {
    const value = node.nodeValue;
    if (!value || !CJK.test(value) || skipped(node)) return;
    const next = i18n.translate(value);
    if (next === value) return;
    if (!textOriginals.has(node)) textOriginals.set(node, value);
    node.nodeValue = next;
  }

  // 输入框本身不翻内容（value），但它的 placeholder / title / aria-label 是界面文字：
  // 只要外层不在不翻区域（终端、会话正文等）就照常翻。
  function isEditable(el) {
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|submit|reset)$/i.test(el.type || ''));
  }
  function attrsSkipped(el) {
    if (isEditable(el)) return el.hasAttribute('data-i18n-skip') || !!(el.parentElement && el.parentElement.closest(skipSelector));
    return skipped(el);
  }

  function translateAttrs(el) {
    if (attrsSkipped(el)) return;
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (!value || !CJK.test(value)) continue;
      const next = i18n.translate(value);
      if (next === value) continue;
      const saved = attrOriginals.get(el) || {};
      if (!(name in saved)) saved[name] = value;
      attrOriginals.set(el, saved);
      el.setAttribute(name, next);
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type || '') && CJK.test(el.value)) {
      const next = i18n.translate(el.value);
      if (next !== el.value) {
        const saved = attrOriginals.get(el) || {};
        if (!('value' in saved)) saved.value = el.value;
        attrOriginals.set(el, saved);
        el.value = next;
      }
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root.closest(skipSelector)) { if (root.tagName === 'TEXTAREA') translateAttrs(root); return; }
      translateAttrs(root);
    }
    const tw = document.createTreeWalker(root, 1 | 4, {
      acceptNode(n) {
        if (n.nodeType === 1 && n.matches(skipSelector)) {
          if (n.tagName === 'TEXTAREA') translateAttrs(n); // 文本框只翻提示属性，内容不碰
          return 2; // 跳过整棵子树
        }
        return 1;
      },
    });
    let n = tw.nextNode();
    while (n) {
      if (n.nodeType === 3) translateText(n); else translateAttrs(n);
      n = tw.nextNode();
    }
  }

  function translateTitle() {
    if (!document.title || !CJK.test(document.title)) return;
    const next = i18n.translate(document.title);
    if (next !== document.title) { if (titleOriginal === null) titleOriginal = document.title; document.title = next; }
  }

  function onMutations(list) {
    if (writing) return;
    writing = true;
    try {
      const texts = new Set();
      const attrs = new Map();
      const added = new Set();
      let removed = false;
      for (const m of list) {
        if (m.type === 'characterData') {
          texts.add(m.target);
        } else if (m.type === 'attributes') {
          if (!attrs.has(m.target)) attrs.set(m.target, new Set());
          attrs.get(m.target).add(m.attributeName);
        } else {
          for (const n of m.addedNodes) added.add(n);
          if (m.removedNodes.length) removed = true;
        }
      }
      // 先统一作废旧原文，再翻译：重复记录、父子扫描和属性扫描交叠都不能删掉本批刚保存的原文。
      for (const node of texts) textOriginals.delete(node);
      for (const [el, names] of attrs) {
        const saved = attrOriginals.get(el);
        if (saved) for (const name of names) delete saved[name];
      }
      for (const node of texts) translateText(node);
      for (const el of attrs.keys()) translateAttrs(el);
      for (const node of added) walk(node);
      if (removed) pruneDetached();
      translateTitle();
    } finally {
      // 自己写入触发的记录在下一轮回调里到达，这里清空队列避免反复处理
      if (observer) observer.takeRecords();
      writing = false;
    }
  }

  function restoreAttrs(el, saved) {
    for (const [name, value] of Object.entries(saved)) {
      if (name === 'value') el.value = value; else el.setAttribute(name, value);
    }
  }

  function pruneDetached() {
    // 移除批次后释放强引用；先还原离树节点，之后若重新插回也能重新保存中文原文。
    for (const [node, value] of textOriginals) {
      if (node.isConnected) continue;
      node.nodeValue = value;
      textOriginals.delete(node);
    }
    for (const [el, saved] of attrOriginals) {
      if (el.isConnected) continue;
      restoreAttrs(el, saved);
      attrOriginals.delete(el);
    }
  }

  function start() {
    if (observer) return;
    writing = true;
    try { walk(document.body || document.documentElement); translateTitle(); } finally { writing = false; }
    observer = new win.MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']),
    });
    document.documentElement.setAttribute('lang', 'en');
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    for (const [node, value] of textOriginals) { if (node.isConnected) node.nodeValue = value; }
    for (const [el, saved] of attrOriginals) {
      if (!el.isConnected) continue;
      restoreAttrs(el, saved);
    }
    textOriginals.clear();
    attrOriginals.clear();
    if (titleOriginal !== null) { document.title = titleOriginal; titleOriginal = null; }
    document.documentElement.setAttribute('lang', 'zh-CN');
  }

  function apply(language) { if (language === 'en') start(); else stop(); }

  return { start, stop, apply, isActive: () => !!observer, walk };
}

// 系统弹框（alert/confirm/prompt）里的中文也按词典翻译。
function patchDialogs(win, i18n) {
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = win[name];
    if (typeof original !== 'function' || original.__i18n) continue;
    const wrapped = function (message, ...rest) { return original.call(win, i18n.translate(message), ...rest); };
    wrapped.__i18n = true;
    win[name] = wrapped;
  }
}

// 界面进程入口：读一次当前语言，装好翻译层，并跟随设置里的切换。
function installI18n({ window: win = typeof window !== 'undefined' ? window : null, ipcRenderer } = {}) {
  if (!win) return null;
  const i18n = require('../core/i18n');
  let language = 'zh-CN';
  try { language = ipcRenderer ? ipcRenderer.sendSync('i18n:get-language') : 'zh-CN'; } catch { language = 'zh-CN'; }
  i18n.setLanguage(language);
  patchDialogs(win, i18n);
  const translator = createDomTranslator({ document: win.document, i18n });
  if (process.env.HUB_I18N_MISS_LOG) {
    const seen = new Set();
    i18n.setMissHook(text => { if (!seen.has(text)) { seen.add(text); console.warn('[i18n-miss]', JSON.stringify(text)); } });
  }
  const run = () => translator.apply(i18n.getLanguage());
  if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
  i18n.onLanguageChange(lang => translator.apply(lang));
  if (ipcRenderer) ipcRenderer.on('i18n:language-changed', (_e, lang) => i18n.setLanguage(lang));
  win.__hubI18n = { i18n, translator };
  return { i18n, translator };
}

module.exports = { createDomTranslator, patchDialogs, installI18n, SKIP_SELECTOR, ATTRS };
