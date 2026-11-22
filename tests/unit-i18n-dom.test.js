'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDomTranslator } = require('../renderer/i18n-dom');

// 最小 DOM：保留 MutationObserver 的批量队列、属性过滤和 TreeWalker 的子树排除语义。
function fakeDom() {
  let observer;
  const record = mutation => {
    if (!observer?.active || !mutation.target.isConnected) return;
    if (mutation.type === 'attributes' && !observer.options.attributeFilter.includes(mutation.attributeName)) return;
    observer.records.push(mutation);
  };
  class Node {
    constructor(tag, value = '') {
      this.nodeType = tag === '#text' ? 3 : tag === '#document' ? 9 : 1;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attrs = {};
      this.dataset = {};
      this.listeners = {};
      this._value = value;
    }
    get isConnected() { return this.nodeType === 9 || !!this.parentElement?.isConnected; }
    get nodeValue() { return this._value; }
    set nodeValue(value) { this._value = value; record({ type: 'characterData', target: this }); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name in this.attrs; }
    setAttribute(name, value) {
      this.attrs[name] = value;
      record({ type: 'attributes', target: this, attributeName: name });
    }
    append(child) {
      this.children.push(child); child.parentElement = this;
      record({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    removeChild(child) {
      this.children.splice(this.children.indexOf(child), 1); child.parentElement = null;
      record({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    }
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const parts = selector.trim().split(/\s*>\s*/);
        const simple = parts.pop();
        if (!simple || simple.includes(':')) return false;
        let matches;
        if (simple.startsWith('.')) matches = (this.attrs.class || '').split(' ').includes(simple.slice(1));
        else if (simple.startsWith('#')) matches = this.attrs.id === simple.slice(1);
        else if (simple.startsWith('[')) {
          const [, name, value] = simple.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
          matches = name && this.hasAttribute(name) && (value === undefined || this.attrs[name] === value);
        } else matches = this.tagName === simple.toUpperCase();
        return matches && (!parts.length || !!this.parentElement?.matches(parts.join(' > ')));
      });
    }
    closest(selector) {
      for (let el = this; el?.nodeType === 1; el = el.parentElement) if (el.matches(selector)) return el;
      return null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const document = new Node('#document');
  document.documentElement = document.append(new Node('html'));
  document.body = document.documentElement.append(new Node('body'));
  document.title = '';
  document.getElementById = id => document.querySelectorAll('#' + id)[0];
  document.createTreeWalker = (root, _what, filter) => {
    const nodes = [];
    const visit = parent => {
      for (const child of parent.children) {
        if (filter.acceptNode(child) === 2) continue;
        nodes.push(child); visit(child);
      }
    };
    visit(root);
    return { nextNode: () => nodes.shift() || null };
  };
  document.defaultView = {
    addEventListener: (name, fn) => { document.listeners[name] = fn; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; observer = this; }
      observe(_root, options) { this.active = true; this.options = options; }
      disconnect() { this.active = false; this.records = []; }
      takeRecords() { const records = this.records; this.records = []; return records; }
    },
  };
  return {
    document,
    el: (tag, attrs = {}) => { const el = new Node(tag); Object.assign(el.attrs, attrs); return el; },
    text: value => new Node('#text', value),
    flush: () => { if (observer?.records.length) observer.callback(observer.takeRecords()); },
  };
}

const translations = { '启动中心': 'Launch Center', '准备恢复': 'Preparing to restore' };
const i18n = { translate: value => translations[value] || value };

test('会议室地域：英文翻译可见文字及 placeholder/title/aria-label，切回中文还原', () => {
  const realI18n = require('../core/i18n');
  realI18n.loadDictionaries();
  realI18n.setLanguage('en');
  const dom = fakeDom();
  const dict = require('../core/i18n/locales/en/rooms-area.json');
  for (const source of ['所在地域', '国家/地区', '城市，如 北京', '楼宇，如 练秋湖F12栋',
    '会议室所在国家/地区', '会议室所在城市', '会议室所在楼宇']) assert.ok(dict[source], source);
  const pageSource = fs.readFileSync(path.join(__dirname, '../renderer/company-rooms-page.js'), 'utf8');
  const messages = pageSource.match(/(?:按从上到下的顺序尝试[^<]+|抢别的城市或楼宇时填，写法[^"\n]+|当前会议室组件还不支持切换地域[^<'\n]+)/g) || [];
  assert.equal(messages.length, 4);
  for (const source of messages) {
    assert.ok(dict[source], source);
  }
  const nodes = Object.keys(dict).map(source => {
    const input = dom.document.body.append(dom.el('input', { placeholder: source, title: source, 'aria-label': source }));
    const text = dom.document.body.append(dom.text(source));
    return { source, input, text };
  });
  const translator = createDomTranslator({ document: dom.document, i18n: realI18n });
  try {
    translator.start();
    for (const { source, input, text } of nodes) {
      assert.equal(text.nodeValue, dict[source]);
      for (const attr of ['placeholder', 'title', 'aria-label']) assert.equal(input.getAttribute(attr), dict[source]);
    }
    translator.stop();
    for (const { source, input, text } of nodes) {
      assert.equal(text.nodeValue, source);
      assert.equal(input.getAttribute('placeholder'), source);
    }
  } finally {
    translator.stop(); realI18n.setLanguage('zh-CN');
  }
});

test('DOM：同批重复文本/属性与父子扫描交叠，切回中文保留最新原文', () => {
  const dom = fakeDom();
  const parent = dom.document.body.append(dom.el('div', { title: '启动中心', 'aria-label': '启动中心' }));
  const text = parent.append(dom.text('启动中心'));
  const translator = createDomTranslator({ document: dom.document, i18n });
  translator.start();
  assert.equal(text.nodeValue, 'Launch Center');
  for (let i = 0; i < 2; i++) {
    text.nodeValue = '准备恢复';
    parent.setAttribute('title', '准备恢复');
    parent.setAttribute('aria-label', '准备恢复');
  }
  // childList 在 characterData/attributes 之前到达，仍须先统一清除旧原文。
  const added = dom.el('span', { title: '启动中心' });
  parent.append(added);
  const addedText = added.append(dom.text('启动中心'));
  added.setAttribute('title', '准备恢复');
  addedText.nodeValue = '准备恢复';
  dom.flush();
  assert.equal(text.nodeValue, 'Preparing to restore');
  assert.equal(parent.getAttribute('title'), 'Preparing to restore');
  assert.equal(parent.getAttribute('aria-label'), 'Preparing to restore');
  assert.equal(addedText.nodeValue, 'Preparing to restore');
  assert.equal(added.getAttribute('title'), 'Preparing to restore');
  translator.stop();
  assert.equal(text.nodeValue, '准备恢复');
  assert.equal(parent.getAttribute('title'), '准备恢复');
  assert.equal(parent.getAttribute('aria-label'), '准备恢复');
  assert.equal(addedText.nodeValue, '准备恢复');
  assert.equal(added.getAttribute('title'), '准备恢复');
});

test('DOM：只排除原生问题、选项、会话标题，操作按钮与输入提示仍翻译', () => {
  const dom = fakeDom();
  const form = dom.document.body.append(dom.el('form', { class: 'codex-native-request' }));
  const question = form.append(dom.el('label'));
  const protectedText = [question.append(dom.text('启动中心'))];
  const input = question.append(dom.el('textarea', { 'aria-label': '启动中心' }));
  const option = form.append(dom.el('button', { title: '启动中心' }));
  protectedText.push(option.append(dom.text('启动中心')));
  for (const attrs of [{ class: 'sl-title' }, { class: 'terminal-title' }, { id: 'mr-title' }, { id: 'session-title' }]) {
    const title = dom.document.body.append(dom.el('span', { ...attrs, title: '启动中心' }));
    protectedText.push(title.append(dom.text('启动中心')));
  }
  const actions = form.append(dom.el('div', { class: 'codex-native-actions' }));
  const actionText = actions.append(dom.el('button')).append(dom.text('启动中心'));
  const composer = dom.document.body.append(dom.el('textarea', { placeholder: '启动中心' }));
  const translator = createDomTranslator({ document: dom.document, i18n });
  translator.start();
  for (const text of protectedText) assert.equal(text.nodeValue, '启动中心');
  assert.equal(option.getAttribute('title'), '启动中心');
  assert.equal(input.getAttribute('aria-label'), '启动中心');
  assert.equal(actionText.nodeValue, 'Launch Center');
  assert.equal(composer.getAttribute('placeholder'), 'Launch Center');
  translator.stop();
  assert.equal(actionText.nodeValue, '启动中心');
  assert.equal(composer.getAttribute('placeholder'), '启动中心');
});

test('DOM：长期移除节点后存储不增长，离树后再插入及在树节点均可还原', () => {
  const stores = [];
  class TrackedMap extends Map { constructor() { super(); stores.push(this); } }
  const filename = path.resolve(__dirname, '../renderer/i18n-dom.js');
  const context = { module: { exports: {} }, Map: TrackedMap };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const dom = fakeDom();
  const fixed = dom.document.body.append(dom.el('div', { title: '启动中心' }));
  const fixedText = fixed.append(dom.text('启动中心'));
  const translator = context.module.exports.createDomTranslator({ document: dom.document, i18n });
  const [texts, attrs] = stores;
  translator.start();
  for (let i = 0; i < 100; i++) {
    const row = dom.document.body.append(dom.el('div', { title: '准备恢复' }));
    const text = row.append(dom.text('准备恢复'));
    dom.flush();
    assert.equal(text.nodeValue, 'Preparing to restore');
    assert.equal(texts.size, 2);
    assert.equal(attrs.size, 2);
    dom.document.body.removeChild(row);
    dom.flush();
    assert.equal(texts.size, 1);
    assert.equal(attrs.size, 1);
    assert.equal(text.nodeValue, '准备恢复');
    assert.equal(row.getAttribute('title'), '准备恢复');
    if (i === 99) {
      dom.document.body.append(row); dom.flush();
      assert.equal(text.nodeValue, 'Preparing to restore');
      translator.stop();
      assert.equal(text.nodeValue, '准备恢复');
      assert.equal(row.getAttribute('title'), '准备恢复');
    }
  }
  assert.equal(fixedText.nodeValue, '启动中心');
  assert.equal(fixed.getAttribute('title'), '启动中心');
  assert.equal(texts.size, 0);
  assert.equal(attrs.size, 0);
});

test('DOM：默认中文不启用观察器、不改文字或属性', () => {
  const dom = fakeDom();
  const el = dom.document.body.append(dom.el('span', { title: '启动中心' }));
  const text = el.append(dom.text('启动中心'));
  const translator = createDomTranslator({ document: dom.document, i18n });
  assert.equal(translator.isActive(), false);
  assert.equal(text.nodeValue, '启动中心');
  assert.deepEqual(el.attrs, { title: '启动中心' });
});

test('输入框：语言切换更新已打开的提示，并沿用回车设置和自定义基句', () => {
  const i18n = require('../core/i18n');
  i18n.setLanguage('zh-CN');
  const enterKey = require('../renderer/composer-enter-key');
  const dom = fakeDom();
  const select = dom.document.body.append(dom.el('select', { id: 'cfg-composer-enter' }));
  const normal = dom.document.body.append(dom.el('div', { class: 'floating-input-box', 'data-placeholder': '原始提示' }));
  const custom = dom.document.body.append(dom.el('div', { id: 'mr-input-box', 'data-placeholder': '原始群聊提示' }));
  custom.dataset.placeholderBase = '输入消息，/ 查看命令和技能…';
  let mode = 'send';
  const storage = { getItem: () => mode, setItem: (_key, value) => { mode = value; } };
  try {
    enterKey.bindSetting({ document: dom.document, storage });
    assert.equal(normal.getAttribute('data-placeholder'), '原始提示', '中文初始化不写 DOM');
    assert.equal(custom.getAttribute('data-placeholder'), '原始群聊提示');
    i18n.setLanguage('en');
    assert.equal(normal.getAttribute('data-placeholder'), enterKey.placeholderFor('send'));
    assert.doesNotMatch(normal.getAttribute('data-placeholder'), /[㐀-鿿]/);
    assert.equal(custom.getAttribute('data-placeholder'), enterKey.placeholderFor('send', custom.dataset.placeholderBase));
    select.value = 'newline'; select.listeners.change();
    assert.equal(mode, 'newline');
    assert.equal(normal.getAttribute('data-placeholder'), enterKey.placeholderFor('newline'));
    i18n.setLanguage('zh-CN');
    assert.equal(normal.getAttribute('data-placeholder'), '输入消息…（Enter 换行，Ctrl+Enter 发送）');
    assert.equal(custom.getAttribute('data-placeholder'), '输入消息，/ 查看命令和技能…（Enter 换行，Ctrl+Enter 发送）');
  } finally {
    dom.document.listeners.unload();
    i18n.setLanguage('zh-CN');
  }
});
