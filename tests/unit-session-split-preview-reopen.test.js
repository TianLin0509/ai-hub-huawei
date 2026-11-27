'use strict';
// 全屏文件预览期间会话区被同步成 hidden，关掉预览后必须跟着恢复，
// 否则对话区一片空白、文件链接再点不到（R54：打开一个文件再关闭，再点同一文件打不开）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSplit } = require('../renderer/session-split.js');

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parent = null; this.dataset = {}; this.attrs = {}; this.hidden = false;
    this.className = ''; this.textContent = ''; this.clientWidth = 1200; this.listeners = {};
    const props = {}; this.style = { setProperty: (k, v) => { props[k] = v; }, display: '' };
    const self = this;
    this.classList = {
      toggle(name, on) { const set = new Set(self.className.split(/\s+/).filter(Boolean)); const want = on === undefined ? !set.has(name) : !!on; if (want) set.add(name); else set.delete(name); self.className = [...set].join(' '); return want; },
      contains(name) { return self.className.split(/\s+/).includes(name); },
    };
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  prepend(...kids) { for (const k of kids) k.parent = this; this.children.unshift(...kids); }
  before(node) { if (this.parent) { const i = this.parent.children.indexOf(this); this.parent.children.splice(i, 0, node); node.parent = this.parent; } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return { left: 0, width: this.clientWidth }; }
  querySelector(sel) {
    const match = el => sel.startsWith('.') ? el.classList.contains(sel.slice(1))
      : (/^\[data-session-layout="(\w+)"\]$/.exec(sel) || [])[1] === el.dataset.sessionLayout;
    for (const k of this.children) { if (match(k)) return k; const d = k.querySelector(sel); if (d) return d; }
    return null;
  }
}

function setup({ withObserver = true } = {}) {
  const observers = [];
  const win = {
    ResizeObserver: class { observe() {} },
    queueMicrotask: fn => fn(),
  };
  if (withObserver) win.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } };
  const doc = { createElement: tag => new El(tag) };
  const host = new El('div');
  const primary = new El('div'); primary.className = 'terminal-panel'; host.append(primary);
  const buttons = new El('div');
  for (const mode of ['single', 'two']) { const b = new El('button'); b.dataset.sessionLayout = mode; buttons.append(b); }
  const split = createSessionSplit({ document: doc, window: win, primary, buttons, services: {
    primaryId: () => 's1', otherView: () => null, sessions: () => [], onFocus() {}, resize() {}, alert() {},
  } });
  const workspace = host.children.find(k => k.className === 'session-workspace');
  // 模拟浏览器：style 变化后通知观察 primary 的 MutationObserver
  const setDisplay = value => { primary.style.display = value; for (const o of observers) if (o.target === primary) o.cb([{ type: 'attributes', attributeName: 'style' }]); };
  return { split, workspace, setDisplay };
}

test('全屏预览期间同步过的会话区，关掉预览后自动恢复可见', () => {
  const { split, workspace, setDisplay } = setup();
  assert.equal(workspace.hidden, false);
  setDisplay('none');          // 打开全屏预览：预览面板把会话面板藏起来
  split.sync();                // 预览开着时会话状态刷新触发了一次同步
  assert.equal(workspace.hidden, true);
  setDisplay('');              // 关掉预览：预览面板把会话面板恢复显示
  assert.equal(workspace.hidden, false, '会话区仍是 hidden：对话区空白，文件链接点不到');
});

test('环境没有 MutationObserver 时不报错，下一次同步照常恢复', () => {
  const { split, workspace, setDisplay } = setup({ withObserver: false });
  setDisplay('none'); split.sync(); setDisplay(''); split.sync();
  assert.equal(workspace.hidden, false);
});
