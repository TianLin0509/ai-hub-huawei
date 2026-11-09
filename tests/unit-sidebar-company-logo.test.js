'use strict';
// 2026-11-08 用户：会话栏不挂「GLM · 号 2」文字标签，模型靠 logo 区分，号标在 logo 右下角，标题让出空间。
const test = require('node:test'), assert = require('node:assert/strict');
const { createSessionListRenderer } = require('../renderer/session-list-renderer');
const routeView = require('../renderer/company-route-view');

function makeEl() {
  return {
    children: [], _attrs: {}, style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    addEventListener() {}, appendChild(child) { this.children.push(child); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ''; },
    set scrollTop(v) { this._scrollTop = v; }, get scrollTop() { return this._scrollTop || 0; },
  };
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(sessions, extra = {}) {
  const sessionListEl = makeEl();
  const r = createSessionListRenderer({
    document: { createElement: makeEl, getElementById: () => null, head: makeEl(), documentElement: makeEl() },
    localStorage: { getItem: () => '[]', setItem: () => {} }, sessionListEl,
    getSessions: () => new Map(sessions.map(s => [s.id, s])), getMeetings: () => ({}),
    getActiveSessionId: () => null, getActiveMeetingId: () => null,
    isAiKind: k => ['claude', 'codex', 'codeagent'].includes(k), modelShort: m => (m && (m.displayName || m.id)) || '',
    modelClass: () => '', escapeHtml: esc, formatTime: () => '00:00', pctClass: () => 'ok', sessionBurnRate: () => null,
    selectSession() {}, selectMeeting() {}, openContextMenu() {}, accountBadge: () => null, ...extra,
  });
  r.renderSessionList();
  const rows = [];
  (function walk(el) { if (el.dataset?.sessionId) rows.push(el); (el.children || []).forEach(walk); })(sessionListEl);
  return Object.fromEntries(rows.map(el => [el.dataset.sessionId, el.innerHTML]));
}

test('公司模型会话：logo 换成模型那家，号池号标在角标，标题后不再挂文字标签', t => {
  routeView.updateStatus({ sessionAccounts: { glm1: '号 2', ds1: '个人' } });
  t.after(() => routeView.updateStatus({}));
  const now = Date.now();
  const html = render([
    { id: 'glm1', kind: 'claude', title: '无线调度算法周报整理', status: 'idle', lastMessageTime: now, companyRoute: 'proxy', currentModel: { id: 'GLM-5.2-WX' } },
    { id: 'ds1', kind: 'codex', title: 'PPT 素材检索优化方案', status: 'idle', lastMessageTime: now - 1000, companyRoute: 'proxy', currentModel: { id: 'deepseek-v4.1-flash-1017' } },
    { id: 'local1', kind: 'claude', title: '本机配置会话', status: 'idle', lastMessageTime: now - 2000, companyRoute: 'local', currentModel: { id: 'claude-sonnet' } },
  ]);
  assert.match(html.glm1, /class="sl-kind ai-logo logo-glm"/);
  assert.match(html.glm1, /data-account="2"/);
  assert.match(html.glm1, /title="[^"]*Claude[^"]*GLM-5\.2-WX[^"]*号池 号 2/, '悬停仍能看到 CLI、完整模型名和号');
  assert.doesNotMatch(html.glm1, /sl-route|GLM · 号 2/);
  assert.match(html.ds1, /logo-deepseek/);
  assert.doesNotMatch(html.ds1, /data-account=/, '个人号不标角标');
  assert.match(html.ds1, /个人号/);
  assert.match(html.local1, /logo-claude/, 'CLI 默认线路沿用 CLI 自己的 logo');
});

test('CodeAgent 账号字母挪到 logo 角标，标题格只放会话名', () => {
  const html = render([{ id: 'ca1', kind: 'codeagent', title: '公司代码走读', status: 'idle', lastMessageTime: Date.now() }],
    { accountBadge: () => ({ letter: 'w', title: '号池 · 号 1' }) });
  assert.match(html.ca1, /data-account="w"/);
  assert.match(html.ca1, /号池 · 号 1/);
  assert.doesNotMatch(html.ca1, /sl-acct/);
  assert.match(html.ca1, /<span class="sl-title"[^>]*>公司代码走读<\/span>/);
});

test('公司模型会话的角标只认号池的号，不被本机订阅账号序号顶掉', t => {
  routeView.updateStatus({ sessionAccounts: { g3: '号 3' } });
  t.after(() => routeView.updateStatus({}));
  const html = render([{ id: 'g3', kind: 'claude', title: 'AirView 配置对齐', status: 'idle', lastMessageTime: Date.now(), companyRoute: 'proxy', currentModel: { id: 'GLM-5.2-WX' } }],
    { subscriptionAccount: () => ({ no: 1, label: 'default' }) });
  assert.match(html.g3, /data-account="3"/);
  assert.doesNotMatch(html.g3, /账号 1/);
});

test('订阅账号序号照旧优先显示', () => {
  const html = render([{ id: 'c2', kind: 'claude', title: 'Claude 第二个号的会话', status: 'idle', lastMessageTime: Date.now() }],
    { subscriptionAccount: () => ({ no: 2, label: 'work' }) });
  assert.match(html.c2, /data-account="2"/);
  assert.match(html.c2, /账号 2（work）/);
});
