'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentTurnModelLoad, patchTurnModelLoad, MODEL_LOAD_MAX_AGE_MS } = require('../renderer/codeagent-turn-load');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');
const NOW = Date.parse('2026-11-02T08:00:00Z');
const turn = { id: 'latest-answer', role: 'assistant', model: 'Example-V4.1-Flash-128K', ts: NOW - 10000, tsEnd: NOW - 1000, stopReason: 'end_turn', text: '测试回答' };
const session = { kind: 'codeagent', status: 'idle' };
const entry = { at: NOW - 30000, models: [{ name: turn.model, load: '低负载' }] };
const hint = changes => currentTurnModelLoad({ session, turn, isLatest: true, entry, now: NOW, ...changes });

test('latest completed CodeAgent answer displays known load from the matching model snapshot', () => {
  for (const load of ['低负载', '中负载', '高负载']) {
    assert.equal(hint({ entry: { ...entry, models: [{ name: turn.model, load }] } }).text, load);
  }
  assert.equal(hint({ session: { ...session, kind: 'codeagent-resume' } }).text, '低负载');
  assert.equal(hint().at, entry.at);
});

test('active CodeAgent latest answer displays fresh load throughout a long-running turn', () => {
  const running = { ...session, status: 'running', runStartedAt: NOW - 3600000 };
  assert.equal(hint({ session: running, turn: { ...turn, ts: NOW - 3500000, tsEnd: null, stopReason: null } }).text, '低负载');
  assert.equal(hint({ session: { ...running, runStartedAt: NOW - 1000 } }), null, 'a new active run cannot lend its load to the previous reply');
});

test('over-fifteen-minute, future, missing or mismatched model readings stay hidden', () => {
  assert.equal(hint({ entry: { ...entry, at: NOW - MODEL_LOAD_MAX_AGE_MS - 1 } }), null);
  assert.ok(hint({ entry: { ...entry, at: NOW - MODEL_LOAD_MAX_AGE_MS } }));
  assert.equal(hint({ entry: { ...entry, at: NOW + 1 } }), null);
  for (const missing of [null, {}, { at: NOW, models: [] }, { at: NOW, models: [{ name: turn.model }] }, { ...entry, models: [{ name: 'Another-Model', load: '高负载' }] }]) {
    assert.equal(hint({ entry: missing }), null);
  }
  assert.equal(hint({ entry: { ...entry, models: [{ name: turn.model, load: '未知' }] } }), null);
});

test('Token model observation time wins over a newer Credit-only update time', () => {
  assert.equal(hint({ entry: { ...entry, at: NOW, modelsAt: NOW - MODEL_LOAD_MAX_AGE_MS - 1 } }), null);
});

test('historical, inherited, read-only, user and non-CodeAgent cards never display current model load', () => {
  assert.equal(hint({ isLatest: false }), null);
  assert.equal(hint({ turn: { ...turn, tsEnd: NOW - MODEL_LOAD_MAX_AGE_MS - 1 } }), null);
  assert.equal(hint({ turn: { ...turn, inherited: true } }), null);
  assert.equal(hint({ turn: { ...turn, searchReadonly: true } }), null);
  assert.equal(hint({ turn: { ...turn, role: 'user' } }), null);
  assert.equal(hint({ turn: { ...turn, model: '' } }), null);
  for (const kind of ['claude', 'codex', 'gemini', 'deepseek']) assert.equal(hint({ session: { ...session, kind } }), null);
});

// Minimal card DOM interfaces execute the real mount/signature path without Electron.
function fixture() {
  let clock = NOW, usage = entry;
  const timers = [];
  class Element {
    constructor(className = '') {
      this.className = className; this.dataset = {}; this.children = []; this.style = {};
      this.scrollTop = 0; this.scrollHeight = this.clientHeight = 100; this.replaceCount = 0;
      this.classList = { contains: name => this.className.split(' ').includes(name), add() {}, remove() {}, toggle() {} };
    }
    addEventListener() {} removeEventListener() {} scrollIntoView() {} setAttribute(name, value) { this[name] = value; }
    appendChild(child) {
      if (child.parentNode) child.remove();
      this.children.push(child); child.parentNode = child.parentElement = this;
    }
    insertAdjacentElement(_where, child) {
      const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
      child.parentNode = child.parentElement = parent;
    }
    remove() { if (!this.parentNode) return; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = this.parentElement = null; }
    replaceChildren(...children) { this.replaceCount += 1; this.children = []; for (const child of children) this.appendChild(child); }
    querySelector(selector) {
      const id = /data-turn-id="([^"]+)"/.exec(selector);
      if (id) return this.children.find(child => child.dataset.turnId === id[1]) || null;
      if (['.turn-model-load', '.turn-who', '.turn-head', '.turn-body'].includes(selector)) {
        for (const child of this.children) {
          if (child.className.split(' ').includes(selector.slice(1))) return child;
          const nested = child.querySelector(selector); if (nested) return nested;
        }
      }
      return null;
    }
    querySelectorAll(selector) {
      if (selector === ':scope > .turn-card') return this.children.filter(child => child.className.split(' ').includes('turn-card'));
      return [];
    }
    set innerHTML(html) {
      const card = new Element(/class="([^"]+)"/.exec(html)?.[1] || '');
      card.dataset.turnId = /data-turn-id="([^"]+)"/.exec(html)?.[1];
      const head = new Element('turn-head'), who = new Element('turn-who'), body = new Element('turn-body');
      head.appendChild(who); card.appendChild(head); card.appendChild(body);
      this.firstElementChild = card;
    }
  }
  const document = { addEventListener() {}, removeEventListener() {}, createElement: () => new Element() };
  const container = new Element();
  const renderer = createTurnCardRenderer({ document, window: {}, root: container, container, bridgeIpc: null,
    getSessionContext: () => session, getCodeAgentUsage: key => key === 'personal' ? usage : null,
    now: () => clock, setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cleared = true; },
    formatAbsoluteTime: () => 'fixture-time', escapeHtml: value => String(value || ''),
    normalizeMarkdownPathBreaks: value => value, marked: { parse: value => value }, DOMPurify: { sanitize: value => value },
  });
  return { renderer, container, timers, document,
    setClock: value => { clock = value; }, setUsage: value => { usage = value; } };
}

test('load changes patch only the badge node and preserve model label and answer body', () => {
  const f = fixture();
  const card = f.document.createElement('div'); card.innerHTML = '<div class="turn-card assistant" data-turn-id="answer"></div>';
  const element = card.firstElementChild, body = element.querySelector('.turn-body'), who = element.querySelector('.turn-who');
  patchTurnModelLoad(element, hint(), f.document);
  const badge = element.querySelector('.turn-model-load');
  assert.equal(who.parentNode.children[1], badge);
  assert.equal(badge.textContent, '低负载');
  assert.match(badge.title, /读取时间/);
  assert.ok(badge.title.includes(new Date(entry.at).toLocaleString('zh-CN', { hour12: false })));
  patchTurnModelLoad(element, { ...hint(), text: '高负载' }, f.document);
  assert.equal(element.querySelector('.turn-model-load'), badge);
  assert.equal(badge.textContent, '高负载');
  assert.equal(element.querySelector('.turn-body'), body);
  assert.equal(element.replaceCount, 0);
  patchTurnModelLoad(element, null, f.document);
  assert.equal(element.querySelector('.turn-model-load'), null);
  f.renderer.dispose();
});

test('identical turnRenderSignature still updates load without replacing card contents', async () => {
  const f = fixture();
  const card = f.renderer.mountSessionTurnCard('test-session', turn, { kind: 'codeagent' });
  await Promise.resolve();
  const body = card.querySelector('.turn-body'), badge = card.querySelector('.turn-model-load');
  assert.equal(badge.textContent, '低负载');
  const signature = f.renderer.turnRenderSignature(turn);
  f.setUsage({ ...entry, models: [{ name: turn.model, load: '高负载' }] });
  assert.equal(f.renderer.turnRenderSignature(turn), signature);
  assert.equal(f.renderer.mountSessionTurnCard('test-session', turn, { kind: 'codeagent' }), card);
  await Promise.resolve();
  assert.equal(badge.textContent, '高负载');
  assert.equal(card.querySelector('.turn-model-load'), badge);
  assert.equal(card.querySelector('.turn-body'), body);
  assert.equal(card.replaceCount, 0);
  f.renderer.dispose();
});

test('only the latest answer has a badge, and a new user prompt removes the previous one', async () => {
  const f = fixture();
  const old = f.renderer.mountSessionTurnCard('test-session', { ...turn, id: 'old-answer' }, { kind: 'codeagent' });
  const latest = f.renderer.mountSessionTurnCard('test-session', turn, { kind: 'codeagent' });
  await Promise.resolve();
  assert.equal(old.querySelector('.turn-model-load'), null);
  assert.equal(latest.querySelector('.turn-model-load').textContent, '低负载');
  f.renderer.mountSessionTurnCard('test-session', { id: 'next-prompt', role: 'user', text: '继续', ts: NOW }, { kind: 'codeagent' });
  await Promise.resolve();
  assert.equal(latest.querySelector('.turn-model-load'), null);
  f.renderer.dispose();
});

test('expiry hides the badge without another history refresh, and disposal cancels its timer', async () => {
  const f = fixture();
  const card = f.renderer.mountSessionTurnCard('test-session', turn, { kind: 'codeagent' });
  await Promise.resolve();
  assert.ok(card.querySelector('.turn-model-load'));
  const expiry = f.timers.at(-1);
  assert.equal(expiry.ms, entry.at + MODEL_LOAD_MAX_AGE_MS - NOW + 1);
  f.setClock(entry.at + MODEL_LOAD_MAX_AGE_MS + 1);
  expiry.callback();
  assert.equal(card.querySelector('.turn-model-load'), null);
  f.setClock(NOW);
  f.renderer.refreshModelLoads();
  const activeTimer = f.timers.at(-1);
  f.renderer.dispose();
  assert.equal(activeTimer.cleared, true);
});
