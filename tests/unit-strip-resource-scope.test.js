'use strict';

const assert = require('assert');
const { createSessionListRenderer } = require('../renderer/session-list-renderer.js');

function makeEl() {
  return {
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(value) { this._html = value; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set scrollTop(value) { this._scrollTop = value; },
    get scrollTop() { return this._scrollTop || 0; },
  };
}

const stripEl = makeEl();
const sessionListEl = makeEl();
const sessions = new Map([
  ['live-idle', { id: 'live-idle', status: 'idle' }],
  ['live-running', { id: 'live-running', status: 'running' }],
  ['hidden-meeting-child', { id: 'hidden-meeting-child', status: 'idle', meetingId: 'm1' }],
  ['history', { id: 'history', status: 'dormant' }],
]);
let resourceUsage = { cpuPct: 23.4, gpu: { name:'RTX 3080',usagePct:37 }, memoryPct: 67.8, disk: { root: 'C:\\', usagePct: 89, totalBytes: 1000 * 1024 ** 3 } };
let proxyInfo = null;

const document = {
  createElement: () => makeEl(),
  getElementById: id => id === 'sidebar-strip' ? stripEl : null,
  head: makeEl(),
  documentElement: makeEl(),
};

const renderer = createSessionListRenderer({
  document,
  localStorage: { getItem: () => '[]', setItem() {} },
  sessionListEl,
  getSessions: () => sessions,
  getMeetings: () => ({}),
  getActiveSessionId: () => null,
  getActiveMeetingId: () => null,
  isAiKind: () => true,
  modelShort: () => '',
  modelClass: () => '',
  escapeHtml: value => String(value || ''),
  formatTime: () => '',
  pctClass: () => '',
  getResourceUsage: () => resourceUsage,
  getProxyInfo: () => proxyInfo,
  selectSession() {},
  selectMeeting() {},
  openContextMenu() {},
});


// 底栏悬停写明口径（2026-11-28）：整机读数；CPU 与任务管理器同计数器时标「同口径」，读不到时写明是估算。
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /title="CPU 23%\n整机 CPU，按忙碌时间计（读不到处理器利用率计数器/);
assert.match(stripEl.innerHTML, /title="内存 68%\n整机物理内存，与任务管理器同口径/);
resourceUsage = { cpuPct: 31, cpuSource: 'processor-time-taskmgr', cpuWindowMs: 5000, memoryPct: 70 };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /title="CPU 31%\n整机 CPU，与任务管理器同口径（忙碌时间占比） · 最近 5 秒均值（任务管理器是每秒瞬时值）"/);
resourceUsage = { cpuPct: 47, cpuSource: 'processor-utility', cpuWindowMs: 5000, memoryPct: 70, memoryTotalBytes: 64 * 1024 ** 3, memoryAvailableBytes: 19.2 * 1024 ** 3 };
renderer.renderSidebarStrip();
assert.match(stripEl.innerHTML, /title="CPU 47%\n整机 CPU，与任务管理器同口径（处理器利用率，含睿频折算） · 最近 5 秒均值（任务管理器是每秒瞬时值）"/);
assert.match(stripEl.innerHTML, /已用 44\.8 GB \/ 共 64\.0 GB/);
assert.match(stripEl.innerHTML, /CPU<b>47%<\/b>/);
console.log('unit-strip-resource-scope OK');
