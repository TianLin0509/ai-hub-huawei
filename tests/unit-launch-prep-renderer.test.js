'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 仅模拟页面用到的 DOM 接口，执行完整渲染脚本和实际按钮回调，不启动 Electron。
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.className = ''; this.listeners = {};
    this.classList = { add() {}, toggle() {}, contains: name => this.className.split(' ').includes(name) };
  }
  append(...nodes) { nodes.forEach(node => { if (typeof node === 'string') return; node.parent = this; this.children.push(node); }); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  showModal() { this.open = true; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  set innerHTML(html) {
    this.html = html; this.children = [];
    // 静态骨架中的 id/class 足够定位；动态行由真实脚本 append 生成。
    for (const match of html.matchAll(/<([a-z][\w-]*)([^>]*)>/g)) {
      const node = new Element(match[1]), attrs = match[2];
      node.id = /\bid="([^"]+)"/.exec(attrs)?.[1];
      node.className = /\bclass="([^"]+)"/.exec(attrs)?.[1] || '';
      this.append(node);
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelectorAll(selector) {
    const match = node => {
      if (selector.startsWith('#')) return node.id === selector.slice(1);
      if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
      const attr = /^\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);
      if (attr) return node.dataset[attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === attr[2];
      return node.tagName === selector;
    };
    return this.children.flatMap(node => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    const split = selector.indexOf(' ');
    if (split > 0) {
      const first = this.querySelector(selector.slice(0, split));
      // 测试骨架的进度条 i 与父节点并列保存。
      return first?.querySelector(selector.slice(split + 1)) || (selector === '.fr-bar i' ? this.querySelector('i') : null);
    }
    return this.querySelectorAll(selector)[0] || null;
  }
}
function page(file, invoke, distribution = {}) {
  const head = new Element(), body = new Element(), events = {}, focus = {};
  const host = new Element(); host.className = 'home-welcome-body'; body.append(host);
  const document = { head, body, readyState: 'complete', createElement: tag => new Element(tag),
    getElementById: id => head.querySelector('#' + id) || body.querySelector('#' + id), querySelector: s => body.querySelector(s) };
  const calls = [], opened = [];
  const ipcRenderer = { on: (name, callback) => { events[name] = callback; }, invoke: async (name, args) => { calls.push([name, args]); return invoke(name, args); } };
  const window = { addEventListener: (name, callback) => { focus[name] = callback; } };
  const localRequire = name => {
    if (name === 'electron') return { ipcRenderer, shell: { openExternal: url => opened.push(url) } };
    if (name === '../core/distribution') return { community: true, target: 'company', featureEnabled: () => true, ...distribution };
    if (name === './codeagent-setup') return { createCodeAgentSetup: () => ({ accept() {}, subscribe() {}, showGuide() { opened.push('bundled-guide'); } }) };
    if (name === './net-pass-view') return { ensureCss() {}, boxHtml: () => '', bind() {} };
    if (name === '../core/app-update/downloader') return require('../core/app-update/downloader');
    throw new Error('Unexpected require: ' + name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8'), {
    document, window, require: localRequire, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  }, { filename: '../renderer/' + file });
  return { document, body, host, events, focus, window, calls, opened };
}
const settled = () => new Promise(resolve => setImmediate(resolve));
async function prepPage(invoke = () => ({ ok: true })) {
  const f = page('first-run-prep.js', (name, args) => name === 'first-run:state'
    ? { mode: 'full', layout: [{ name: '准备', rows: [{ id: 'login', label: '登录' }] }] }
    : name === 'first-run:start' ? { ok: true } : invoke(name, args));
  await settled();
  f.row = f.body.querySelector('[data-fr="login"]');
  f.button = fix => {
    f.events['first-run:event']({}, { type: 'row', row: { id: 'login', status: 'bad', detail: '未就绪', fixes: [fix] } });
    return f.row.querySelector('.fr-fix');
  };
  return f;
}

test('准备页 Git 安装走组件安装接口，成功后重查，不落到未知操作', async () => {
  const f = await prepPage();
  await f.button({ act: 'git-install', label: '安装 Git' }).onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(([name]) => name === 'cli-tools:install'))), ['cli-tools:install', { id: 'git' }]);
  assert.equal(f.calls.some(([name]) => name === 'env-check:fix'), false);
  assert.equal(f.calls.filter(([name]) => name === 'first-run:start').length, 2);
});

test('准备页更新按钮打开现有更新页面', async () => {
  const f = await prepPage(); let opens = 0;
  f.window.__appUpdate = { open: () => { opens++; } };
  await f.button({ act: 'open-update', label: '检查更新' }).onclick();
  assert.equal(opens, 1); assert.equal(f.calls.some(([name]) => name === 'env-check:fix'), false);
});

test('准备页登录走个人登录接口，回到窗口自动重查且仅重查一次', async () => {
  const f = await prepPage();
  await f.button({ act: 'codeagent-login', label: '一键登录' }).onclick();
  assert.equal(f.calls.some(([name]) => name === 'codeagent-pool:personal-login'), true);
  assert.equal(f.calls.filter(([name]) => name === 'first-run:start').length, 1);
  f.focus.focus(); f.focus.focus();
  assert.equal(f.calls.filter(([name]) => name === 'first-run:start').length, 2);
});

test('安装失败或 IPC 抛错都在原行显示原因，按钮可以重试', async () => {
  for (const invoke of [() => ({ ok: false, error: '下载失败' }), () => { throw new Error('下载失败'); }]) {
    const f = await prepPage(invoke), button = f.button({ act: 'git-install', label: '安装 Git' });
    await button.onclick();
    assert.match(f.row.querySelector('.fr-d').textContent, /下载失败/);
    assert.equal(button.disabled, false);
    assert.equal(f.calls.filter(([name]) => name === 'first-run:start').length, 1);
  }
});

async function welcome({ target = 'company', available = true, fail = false } = {}) {
  let installed = false;
  const f = page('community-welcome.js', name => {
    if (name === 'community:setup') return { providers: ['claude', 'codex', 'dsh', 'gemini', 'codeagent'].map(id => ({ id, name: id, installed, docs: `https://example.invalid/${id}` })) };
    if (name === 'cli-tools:state') return { available };
    if (name === 'cli-tools:install') { if (fail) return { ok: false, error: '网络暂时连不上' }; installed = true; return { ok: true }; }
    throw new Error(name);
  }, { target });
  await settled();
  f.install = id => f.body.querySelector(`[data-provider="${id}"]`).querySelector('button');
  return f;
}
test('公司首页的一键安装 CLI 装完会刷新安装状态', async () => {
  for (const id of ['claude', 'codex', 'dsh']) {
    const f = await welcome(); await f.install(id).onclick();
    assert.equal(f.calls.some(([name, args]) => name === 'cli-tools:install' && args.id === id), true);
    assert.equal(f.opened.length, 0);
    assert.equal(f.body.querySelector(`[data-provider="${id}"]`).dataset.installed, '1');
  }
});
test('无一键安装能力的 CLI 保留文档，公开版和 CodeAgent 原入口可用', async () => {
  for (const [options, id, url] of [[{}, 'gemini', 'https://example.invalid/gemini'], [{ available: false }, 'claude', 'https://example.invalid/claude'],
    [{ target: 'public' }, 'codex', 'https://example.invalid/codex'], [{}, 'codeagent', 'bundled-guide']]) {
    const f = await welcome(options); await f.install(id).onclick();
    assert.deepEqual(f.opened, [url]); assert.equal(f.calls.some(([name]) => name === 'cli-tools:install'), false);
  }
});
test('首页安装失败就地提示，仍可重试', async () => {
  const f = await welcome({ fail: true }), button = f.install('claude'); await button.onclick();
  const note = f.body.querySelector('#community-advisory');
  assert.match(note.textContent, /网络暂时连不上/); assert.equal(note.hidden, false); assert.equal(button.disabled, false);
});

test('增量更新失败且没有发布页时，使用完整安装包清单生成直链', async () => {
  const f = await updatePage({ plan: { kind: 'incremental', file: 'Hub-update.gz' },
    latest: { version: '1.0.1', sourceName: '源B', installer: { file: 'Hub-Setup-1.0.1.exe', bytes: 50000, sha256: 'a'.repeat(64) } } });
  assert.match(f.dialog.innerHTML, /下载完整安装包/);
  assert.doesNotMatch(f.dialog.innerHTML, /发布页/);
  await f.clickManual();
  assert.deepEqual(f.opened, ['https://b.example.invalid/v1.0.1/Hub-Setup-1.0.1.exe']);
});

async function updatePage(over = {}, config = {}) {
  const state = { phase: 'error', current: '1.0.0', releasePage: '', latest: { version: '1.0.1', sourceName: '源B' },
    plan: { kind: 'full', file: 'Hub-Setup-1.0.1.exe' }, error: '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。', ...over };
  const f = page('app-update.js', name => name === 'app-update:get-state' ? state : null, {
    updateConfig: { sources: [{ id: 'a', name: '源A', files: 'https://a.example.invalid/v{version}/' },
      { id: 'b', name: '源B', files: 'https://b.example.invalid/v{version}/' }], ...config },
  });
  await settled(); f.window.__appUpdate.open();
  f.dialog = f.body.querySelector('dialog');
  f.clickManual = () => f.dialog.listeners.click({ target: { closest: () => ({ dataset: { au: 'manual' } }) } });
  return f;
}
test('更新没有发布页时，完整安装计划使用清单文件名和实际源生成直链', async () => {
  const f = await updatePage();
  assert.match(f.dialog.innerHTML, /下载完整安装包/);
  assert.doesNotMatch(f.dialog.innerHTML, /发布页/);
  await f.clickManual();
  assert.deepEqual(f.opened, ['https://b.example.invalid/v1.0.1/Hub-Setup-1.0.1.exe']);
});
test('更新保留已有发布页入口', async () => {
  const f = await updatePage({ releasePage: 'https://example.invalid/releases' });
  assert.match(f.dialog.innerHTML, /打开发布页手动下载/);
  await f.clickManual(); assert.deepEqual(f.opened, ['https://example.invalid/releases']);
});
test('缺清单、缺下载源或仅有增量文件时，不显示无效下载按钮或发布页提示', async () => {
  for (const [state, config] of [[{ latest: null }, {}], [{ plan: { kind: 'incremental', file: 'Hub-update.gz' } }, {}], [{}, { sources: [] }]]) {
    const f = await updatePage(state, config);
    assert.doesNotMatch(f.dialog.innerHTML, /data-au="manual"|发布页/);
    assert.match(f.dialog.innerHTML, /重试/);
    await f.clickManual(); assert.deepEqual(f.opened, []);
  }
});
