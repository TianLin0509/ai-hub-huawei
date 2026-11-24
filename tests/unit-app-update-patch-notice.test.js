'use strict';
// 小版本更新体验（第三批 K）+ 升级不顺（第四批 O，2026-11-20）的界面部分：
//   - 小版本后台下好：设置挂小点、底栏一行「新版本已就绪，重启生效」，不弹窗；
//   - 后台送不到的小版本（受保护目录、关了自动更新）也挂点，不再整版隐藏；
//   - 同一版本再次没升成：弹窗只补一次，但每次都重新挂红点；
//   - 失败提示里就地给「去内源下载完整包」按钮和原因；受保护目录 / 免安装版在更新窗里说明并给按钮。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(initial, storage = new Map(), { invokes = [] } = {}) {
  const file = path.join(__dirname, '..', 'renderer', 'app-update.js');
  const handlers = new Map();
  let prompts = 0;
  const byId = new Map();
  class El {
    constructor(tag) {
      this.tag = tag; this.open = false; this.dataset = {}; this.style = {}; this.title = ''; this.listeners = {}; this.children = []; this.parent = null; this._html = ''; this.textContent = '';
      const set = new Set();
      this.classList = { toggle: (k, on) => { if (on === undefined ? !set.has(k) : on) set.add(k); else set.delete(k); }, contains: k => set.has(k), add: k => set.add(k), remove: k => set.delete(k) };
    }
    set id(v) { this._id = v; byId.set(v, this); }
    get id() { return this._id; }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    setAttribute(k, v) { this[k] = v; } removeAttribute() {}
    addEventListener(k, f) { this.listeners[k] = f; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    after() {}
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); if (this._id && byId.get(this._id) === this) byId.delete(this._id); this.parent = null; }
    querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; }
    showModal() { this.open = true; prompts++; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  const document = { head: new El('head'), body: new El('body'), getElementById: id => byId.get(id) || null, createElement: tag => new El(tag) };
  const options = new El('button'); options.id = 'btn-options';
  const sidebar = new El('div'); sidebar.id = 'session-sidebar';
  const ipcRenderer = { on(k, f) { handlers.set(k, f); }, async invoke(k, arg) { invokes.push([k, arg]); return k === 'app-update:get-state' ? initial : null; } };
  const context = { console: { ...console, warn() {} }, window: {}, document, setTimeout() {}, setInterval() {}, clearTimeout() {},
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    require(k) {
      if (k === '../core/distribution') return { updateConfig: { sources: [{ id: 'a', name: '源A', files: 'https://example.invalid/v{version}/' }] }, productName: 'test' };
      if (k === '../core/app-update/source-view' || k === '../core/app-update/openx-config' || k === '../core/app-update/downloader') return require(k.replace('..', path.join(__dirname, '..')));
      if (k === 'electron') return { ipcRenderer, shell: { openExternal() {} } };
      if (k === './download-progress-view') return { html() { return ''; } };
      throw new Error(k);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return {
    storage, invokes, send(st) { handlers.get('app-update:state')(null, st); }, prompts: () => prompts,
    dot: () => options.classList.contains('update-has-unread'),
    readyLine: () => byId.get('hub-update-ready') || null,
    toasts: () => document.body.children.filter(c => c.className === 'au-toast'),
    dialogs: () => document.body.children.filter(c => c.tag === 'dialog'),
  };
}
const tick = () => new Promise(r => setImmediate(r));
const base = { current: '5.6.63', sources: [], quietEnabled: true, quietFeature: true };
const minor = (phase, extra = {}) => ({ ...base, phase, latest: { version: '5.6.64', notify: false, notes: [], installer: { file: 'AIHubHuawei-Setup-5.6.64.exe' }, sourceName: '源A' },
  plan: { kind: 'incremental', ...(extra.plan || {}) }, ...extra.state });

test('K：小版本后台下好 → 设置挂小点、底栏一行「已就绪，重启生效」，不弹窗', async () => {
  const d = boot({ ...base, phase: 'idle' });
  await tick();
  d.send({ ...minor('downloading'), quiet: true });
  assert.equal(d.dot(), false, '后台下载中不打扰');
  assert.equal(d.readyLine(), null);
  d.send({ ...minor('ready'), quiet: true, readySource: '源A' });
  assert.equal(d.prompts(), 0, '不弹窗');
  assert.equal(d.dot(), true, '设置挂小点');
  assert.ok(d.readyLine(), '底栏一行');
  assert.match(d.readyLine().innerHTML, /新版本 v5\.6\.64 已就绪，重启生效/);
  assert.equal(d.readyLine().parent?.id, 'session-sidebar', '放在左侧会话栏底部');
  d.send({ ...base, phase: 'none' });
  assert.equal(d.readyLine(), null, '换上后（或丢弃）底栏消失');
  assert.equal(d.dot(), false);
});

test('K：后台送得到的小版本在「有新版本」阶段不挂点；送不到的（受保护目录 / 关了自动更新）挂点不弹窗', async () => {
  const d = boot({ ...base, phase: 'idle' });
  await tick();
  d.send(minor('available'));
  assert.equal(d.dot(), false, '马上会后台下载，先不挂点');
  d.send(minor('available', { plan: { protectedDir: true } }));
  assert.equal(d.dot(), true, '受保护目录：后台换不了，挂点让用户知道');
  assert.equal(d.prompts(), 0);
  const off = boot({ ...base, phase: 'idle', quietEnabled: false });
  await tick();
  off.send({ ...minor('available'), quietEnabled: false });
  assert.equal(off.dot(), true, '用户关了自动更新：挂点，不再整版隐藏');
  assert.equal(off.prompts(), 0);
});

test('O①：同一版本再次没升成——弹窗只补一次，但每次都重新挂红点', async () => {
  const storage = new Map();
  const failed = { ok: false, quiet: false, version: '5.6.64', reason: '窗口被关掉', rolledBack: true };
  const a = boot({ ...base, phase: 'idle', lastResult: failed }, storage);
  await tick();
  a.send(minor('available', { state: { quietEnabled: true } }));
  assert.equal(a.prompts(), 1, '第一次失败：补弹一次');
  assert.equal(a.dot(), true);
  storage.set('hub:appUpdate:seenVersion', '5.6.64');   // 用户点开过、红点消了
  const b = boot({ ...base, phase: 'idle', lastResult: failed }, storage);
  await tick();
  b.send(minor('available'));
  assert.equal(b.prompts(), 0, '同一失败版本不再弹');
  assert.equal(b.dot(), true, '但重新挂红点，不再彻底沉默');
});

test('O：关 Hub 时顺手替换没成——不弹提示，设置挂点', async () => {
  const d = boot({ ...base, phase: 'idle', lastResult: { ok: false, quiet: true, version: '5.6.64', reason: '文件被占用', rolledBack: true } });
  await tick();
  d.send(minor('available'));
  assert.equal(d.prompts(), 0);
  assert.equal(d.toasts().length, 0);
  assert.equal(d.dot(), true);
});

test('O④：失败提示里给原因和「去内源下载完整包」；没有管理员权限时说明「仅为我安装」', async () => {
  const d = boot({ ...base, phase: 'idle', lastResult: { ok: false, quiet: false, version: '5.6.64', rolledBack: false,
    reason: '程序装在受保护目录（C:\\Program Files\\AI Hub），替换文件需要管理员授权；这次没有授权，没有替换任何文件' } });
  await tick();
  const [t] = d.toasts();
  assert.ok(t, '有失败提示');
  assert.match(t.innerHTML, /管理员授权/);
  assert.match(t.innerHTML, /data-au-t="manual"[^>]*>去内源下载完整包/);
  assert.match(t.innerHTML, /仅为我安装/);
  t.listeners.click({ target: { closest: () => ({ dataset: { auT: 'manual' } }) } });
  await tick();
  assert.ok(d.invokes.some(([k, a]) => k === 'download-source:open' && a && a.point === 'app-installer'), '点按钮先找内源上的完整包');
  assert.equal(d.toasts().length, 0, '点了就收起');
});

test('审查 P2-4：主进程说这一版送不到（quietPending=false，如后台下载失败、远程停更）就挂点', async () => {
  const d = boot({ ...base, phase: 'idle' });
  await tick();
  d.send({ ...minor('available'), quietPending: true });
  assert.equal(d.dot(), false, '会后台送达：先不打扰');
  d.send({ ...minor('available'), quietPending: false });
  assert.equal(d.dot(), true, '送不到：挂点');
  assert.equal(d.prompts(), 0, '小版本仍不弹窗');
});
