'use strict';
// session 组（会话页常驻按钮与状态）的英文截图界面：卡片头部与操作按钮、输入框及工具菜单、命令面板、
// 原生控件、等待进度、会话详情。会话正文不翻，只看按钮与状态。
// 隔离 Hub 里没有真会话：在界面进程本地派发一次 session-created（不经主进程、不启动 CLI），
// 并只对这个假会话把「读取会话记录」的调用换成本地样例数据，让卡片有东西可截；其他会话照常走主进程。
const SID = 'i18n-session-fake';
const NOW = Date.now();
const TURNS = [
  { id: 'u1', role: 'user', text: 'sample question', ts: NOW - 120000, kind: 'claude' },
  {
    id: 'a1', role: 'assistant', kind: 'claude', model: 'claude-opus-4', ts: NOW - 60000, phase: 'final_answer',
    text: 'sample answer', thinking: 'sample thinking text',
    toolCalls: [
      { id: 't1', name: 'Bash', input: { command: 'dir' }, result: 'a.txt\nb.txt', status: 'completed' },
      { id: 't2', name: 'Read', input: { file_path: 'D:/sample/a.txt' }, result: 'x'.repeat(60000), status: 'completed' },
      { id: 't3', name: 'Grep', input: { pattern: 'foo' }, result: 'not found', status: 'failed', isError: true },
    ],
  },
  { id: 'u2', role: 'user', text: 'second question', ts: NOW - 30000, kind: 'claude' },
  { id: 'a2', role: 'assistant', kind: 'claude', model: 'claude-opus-4', ts: NOW - 20000, text: 'second answer', phase: 'final_answer' },
];
const FAKE = {
  id: SID, kind: 'claude', title: 'i18n session sample', status: 'idle', cwd: 'D:\\AIWork\\sample',
  createdAt: NOW, lastMessageTime: NOW, unreadCount: 0, ccSessionId: '00000000-0000-4000-8000-000000000001',
  usage: { total: 123456, output: 2345, input: 121111, cached: 100000, cacheWrite: 2000, reasoning: 0, source: 'claude', observedAt: NOW },
  lastTurnSpeed: { tokensPerSecond: 30, outputTokens: 1200, elapsedMs: 40000, speedTier: 'fast', includesReasoning: true,
    generation: { tokensPerSecond: 42, outputTokens: 1200, activeMs: 28500, calls: 3, method: 'per-call' } },
};

const setup = `(() => {
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__i18nSessionPatched) {
    const orig = ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke = (ch, ...args) => (ch === 'parse-session-transcript' && args[0] && args[0].hubSessionId === ${JSON.stringify(SID)})
      ? Promise.resolve({ turns: ${JSON.stringify(TURNS)} }) : orig(ch, ...args);
    ipcRenderer.__i18nSessionPatched = true;
  }
  ipcRenderer.emit('session-created', {}, { session: ${JSON.stringify(FAKE)} });
  setTimeout(() => document.querySelector('.session-item[data-session-id=${JSON.stringify(SID)}], .session-item[data-id=${JSON.stringify(SID)}]')?.click(), 600);
  return 'ok';
})()`;
const click = sel => `document.querySelector(${JSON.stringify(sel)})?.click()`;
const esc = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;

// 等待进度、终端等待提示、重发提示条、Claude 原生审批与计划模式：这些要真实运行状态才出现，截图时直接用模块本身挂到浮层里。
const gallery = `(() => {
  document.getElementById('i18n-session-gallery')?.remove();
  const g = document.createElement('div'); g.id = 'i18n-session-gallery';
  g.style.cssText = 'position:fixed;left:320px;top:70px;width:1000px;max-height:760px;overflow:auto;z-index:99999;background:var(--bg-primary,#fff);border:1px solid #888;padding:12px;display:flex;flex-direction:column;gap:10px';
  document.body.appendChild(g);
  const T = require('..' + '/core/session-runtime-truth.js');
  const pty = require('..' + '/renderer/pty-attention-controls.js').createPtyAttentionControls({ invoke: async () => ({ ok: true, menu: { kind: 'permission', question: 'Do you want to proceed?', signature: 'g1', options: [{ key: '1', label: 'Yes', short: '允许', tone: 'allow', selected: true }, { key: '2', label: "Yes, and don't ask again", short: '允许且不再询问', tone: 'always' }, { key: '3', label: 'No', short: '拒绝', tone: 'deny' }] } }) });
  pty.element.classList.add('card-view-active'); pty.element.style.display = 'flex';
  g.appendChild(pty.element); pty.update({ id: 'g1', agentRuntime: 'pty' }, { state: T.RUNTIME_WAITING, detail: '' });
  const rs = require('..' + '/renderer/composer-resend-strip.js');
  const a = rs.createResendStrip(document, g, {}); if (!a.element.isConnected) g.appendChild(a.element); a.show({ text: 'x', reason: '', uncertain: true });
  const b = rs.createResendStrip(document, g, {}); if (!b.element.isConnected) g.appendChild(b.element); b.show({ text: 'x', reason: '', uncertain: false });
  const wp = require('..' + '/renderer/wait-progress.js'); const now = Date.now();
  for (const c of [{ state: 'queued', askedAt: now - 8000 }, { state: 'running', askedAt: now - 15000, startedAt: now - 12000 }, { state: 'running', askedAt: now - 15000, startedAt: now - 12000, notReadySince: now - 9000 }, { state: 'running', askedAt: now - 95000, startedAt: now - 90000, answeringAt: now - 70000 }]) {
    const d = document.createElement('div'); d.innerHTML = wp.waitHtml(wp.assistantChatPhase(c)); g.appendChild(d);
    const t = document.createElement('div'); t.textContent = wp.waitText(wp.assistantChatPhase(c)); g.appendChild(t);
  }
  const cn = require('..' + '/renderer/claude-native-controls.js').createClaudeNativeControls({ sessionId: 'g2', ipcRenderer: { invoke: async () => ({ ok: true }) } });
  g.prepend(cn.element); // 原生审批卡放最上面，免得被浮层滚动裁掉
  cn.update({ id: 'g2', runtimeBackend: 'claude-stream-json', nativeRuntime: { permissionMode: 'plan', connection: 'unstarted', epoch: 1,
    requests: [{ id: 'r1', method: 'claude/permission', params: { toolName: 'Bash' }, raw: { input: { command: 'dir' } } }] } });
  return 'ok';
})()`;

module.exports = {
  'session-cards': { open: setup, wait: 5000 },
  'session-card-more': {
    open: `(() => { const d = [...document.querySelectorAll('.card-actions-menu')].pop(); if (d) d.open = true;
      document.querySelectorAll('details.tc-cluster, details.chat-process').forEach(x => { x.open = true; }); })()`,
    wait: 900,
    close: `document.querySelectorAll('details[open]').forEach(x => { x.open = false; })`,
  },
  'session-slash': {
    open: `(() => { const box = document.querySelector('.composer .floating-input-box'); if (!box) return 'none'; box.focus(); box.textContent = '/';
      const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: '/', inputType: 'insertText' })); return 'ok'; })()`,
    wait: 2000,
    close: `(() => { const box = document.querySelector('.composer .floating-input-box'); if (box) { box.textContent = ''; box.dispatchEvent(new InputEvent('input', { bubbles: true })); } ${esc}; })()`,
  },
  'session-tools': { open: click('.composer-tools-toggle'), wait: 800, close: click('.composer-tools-toggle') },
  'session-collapsed': { open: click('.composer-collapse'), wait: 800, close: click('.composer-expand') },
  'session-gallery': { open: gallery, wait: 1200, close: `document.getElementById('i18n-session-gallery')?.remove()` },
  'session-details': { open: click('#btn-session-details'), wait: 1200, close: click('#btn-session-details') },
};
