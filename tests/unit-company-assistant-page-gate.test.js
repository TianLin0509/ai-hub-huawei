'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanyAssistantPage } = require('../renderer/company-assistant-page');

// 执行真实入口与可选功能提示层；只替换 DOM 和 IPC，不启动 Electron。
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.className = '';
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
      remove: name => { this.className = this.className.split(' ').filter(n => n !== name).join(' '); }, contains: name => this.className.split(' ').includes(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  after(node) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) await fn({ target: this }); }
  matches(selector) {
    const data = /^\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);
    if (data) return this.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === data[2];
    return selector[0] === '#' ? this.id === selector.slice(1) : selector[0] === '.' ? this.classList.contains(selector.slice(1)) : this.tagName === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  querySelector(selector) { for (const node of this.children) { if (node.matches(selector)) return node; const found = node.querySelector(selector); if (found) return found; } return null; }
  set innerHTML(html) {
    this.html = html; this.children = []; const stack = [this];
    for (const m of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const node = new Element(m[2]);
      for (const attr of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (attr[1].startsWith('data-')) node.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attr[2];
        else node[attr[1] === 'class' ? 'className' : attr[1]] = attr[2];
      }
      stack.at(-1).append(node);
      if (!['img', 'input', 'br', 'link', 'hr'].includes(m[2]) && !m[3].endsWith('/')) stack.push(node);
    }
  }
  get innerHTML() { return this.html || ''; }
}

test('全新用户点击公司助理入口：展示现成未开启提示层，不读取助理数据', async () => {
  const root = new Element(), head = new Element('head'), body = new Element('body'), home = new Element('button');
  home.id = 'btn-home'; root.append(head, body); body.append(home);
  const document = { head, body, createElement: tag => new Element(tag), getElementById: id => root.querySelector('#' + id), addEventListener() {} };
  const entry = { id: 'assistant', name: '助理', on: false, desc: '工作与对话', cost: '按需读取' };
  let refreshes = 0;
  const window = { addEventListener() {}, removeEventListener() {}, __optionalFeatures: { get: () => entry, refresh: async () => { refreshes++; } } };
  const calls = [];
  const controller = createCompanyAssistantPage({ document, window, ipcRenderer: { on() {}, invoke: async channel => { calls.push(channel); } } });
  const nav = document.getElementById('btn-company-assistant');
  assert.ok(nav);
  await nav.click(); await new Promise(resolve => setImmediate(resolve));
  const page = document.getElementById('company-assistant-page'), gate = page.querySelector('.of-gate');
  assert.equal(controller.isOpen(), true); assert.equal(page.hidden, false); assert.equal(gate.hidden, false);
  assert.match(gate.innerHTML, /可选功能 · 未开启/); assert.match(gate.innerHTML, /开启助理/);
  assert.equal(gate.dataset.feature, 'assistant'); assert.equal(refreshes, 1); assert.deepEqual(calls, []);
  controller.close(); assert.equal(page.hidden, true);
});
