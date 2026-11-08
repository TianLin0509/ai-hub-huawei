'use strict';
// 排查会话的「把排查结果反馈给维护人」（5.5.31）。
// 「问问 Agent」开的排查会话都在 <数据目录>/troubleshoot/<时间-随机> 这个专属目录里（renderer/hub-error-card.js troubleshootDir），
// 开会话时把原始报错写进同目录的 .hub-troubleshoot.json。所以认会话只看工作目录，重启 Hub 后照样认得出，
// 不用往会话记录里加新字段。
// 点按钮：取这个会话最后一条带「【排查结论】」的回答，截出结论块，连同原始报错拼成描述，打开一键反馈弹窗预填，用户看一眼再发。
// 没有一键反馈入口（window.__hubFeedback）的发行版不显示按钮。

const path = require('node:path');

const CONTEXT_FILE = '.hub-troubleshoot.json';
const BEGIN = '【排查结论】';
const END = '【排查结论完】';
const MAX_BLOCK = 4000;
const FALLBACK_TAIL = 3000;
const MAX_DETAILS = 4000;

const clip = (value, max) => { const s = String(value == null ? '' : value).trim(); return s.length > max ? s.slice(0, max) + '…（已截断）' : s; };
const norm = p => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();

// 工作目录正好是 <数据目录>/troubleshoot/ 下的一层子目录，才算排查会话。
function isTroubleshootCwd(cwd, dataDir) {
  if (!cwd || !dataDir) return false;
  const root = norm(path.join(dataDir, 'troubleshoot'));
  const dir = norm(cwd);
  return dir.startsWith(root + path.sep.toLowerCase()) && !dir.slice(root.length + 1).includes(path.sep) && dir.length > root.length + 1;
}

// 只截最后一个结论块：从最后一个「【排查结论】」到其后的「【排查结论完】」（没有结束标记就到末尾）。
// 去掉 Agent 自己包的代码围栏，首尾标记原样保留。
function extractConclusion(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const at = s.lastIndexOf(BEGIN); // 结束标记是「【排查结论完】」，不会被当成开头
  if (at < 0) return null;
  const endAt = s.indexOf(END, at + BEGIN.length);
  const body = s.slice(at + BEGIN.length, endAt >= 0 ? endAt : s.length)
    .split('\n').filter(line => !/^\s*```/.test(line)).join('\n').trim();
  return { text: `${BEGIN}\n${clip(body, MAX_BLOCK)}\n${END}`, complete: endAt >= 0 };
}

// turns：[{role, text}]（时间正序）。返回 { text, found, complete }；一个结论块都没有时取最后一条回答末尾约 3000 字。
function pickConclusion(turns, fallbackText = '') {
  const answers = (Array.isArray(turns) ? turns : []).filter(t => t && t.role === 'assistant' && typeof t.text === 'string' && t.text.trim());
  for (let i = answers.length - 1; i >= 0; i--) {
    const block = extractConclusion(answers[i].text);
    if (block) return { text: block.text, found: true, complete: block.complete };
  }
  const fromFallback = extractConclusion(fallbackText);
  if (fromFallback) return { text: fromFallback.text, found: true, complete: fromFallback.complete };
  const last = String((answers.length ? answers[answers.length - 1].text : fallbackText) || '').trim();
  if (!last) return { text: '', found: false, complete: false };
  return { text: last.length > FALLBACK_TAIL ? '…' + last.slice(-FALLBACK_TAIL) : last, found: false, complete: false };
}

// 拼一键反馈的描述：排查结论在前，原始报错上下文在后，最后留一行给用户补充。
function feedbackDescription({ conclusion, ctx = {}, sessionTitle = '', kindLabel = '' } = {}) {
  const c = conclusion || { text: '', found: false };
  const from = [sessionTitle && `「${sessionTitle}」`, kindLabel].filter(Boolean).join('，');
  const head = c.found
    ? `【Agent 排查结果】${from ? `（来自排查会话${from}）` : ''}${c.complete === false ? '（结论块没有结束标记，可能没写完）' : ''}`
    : `【Agent 排查结果】${from ? `（来自排查会话${from}）` : ''}（Agent 没有按格式输出【排查结论】，下面是它最后一条回答的末尾）`;
  const area = ctx.areaLabel || ctx.area || '';
  const context = [
    area ? `- 出错的功能区：${area}` : '',
    ctx.symptom || ctx.title ? `- 现象：${clip(ctx.symptom || ctx.title, 600)}` : '',
    ctx.title && ctx.symptom && ctx.symptom !== ctx.title ? `- 界面提示：${clip(ctx.title, 200)}` : '',
    ctx.details ? `- 原始报错：\n${clip(ctx.details, MAX_DETAILS)}` : '',
  ].filter(Boolean);
  return [
    head,
    c.text || '（这个会话里还没有 Agent 的回答）',
    '',
    '【原始报错上下文】',
    ...(context.length ? context : ['（没有找到开会话时保存的报错上下文）']),
    '',
    '【补充】（可以在这里补一句你当时在做什么）',
  ].join('\n');
}

function readContext(cwd, fsModule = require('node:fs')) {
  try { const data = JSON.parse(fsModule.readFileSync(path.join(cwd, CONTEXT_FILE), 'utf8')); return data && typeof data === 'object' ? data : null; }
  catch { return null; }
}

function writeContext(cwd, data, fsModule = require('node:fs')) {
  fsModule.writeFileSync(path.join(cwd, CONTEXT_FILE), JSON.stringify(data, null, 2), 'utf8');
}

// ---- 界面：会话顶栏操作区里一个按钮，样式沿用「问一下」(.ask-entry) ----
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/></svg>';

function createTroubleshootFeedbackUi({ document: doc, ipcRenderer, getSession, getDataDir, openFeedback, kindLabel = k => k || '', notify = () => {} }) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'ask-entry hub-troubleshoot-feedback';
  button.hidden = true;
  button.title = '取这个排查会话里 Agent 最后给出的【排查结论】，连同原始报错预填到一键反馈，看一眼再发';
  button.innerHTML = ICON;
  button.append(doc.createTextNode('把排查结果反馈给维护人'));
  let busy = false;

  async function collect(session) {
    let turns = [];
    try {
      const result = await ipcRenderer.invoke('parse-session-transcript', {
        hubSessionId: session.id, ccSessionId: session.ccSessionId || null, transcriptPath: session.transcriptPath || null,
        kind: session.kind || null, opts: { limit: 30, fromTail: true },
      });
      turns = Array.isArray(result?.turns) ? result.turns : [];
    } catch { /* 退回只取最后一条回答 */ }
    let last = '';
    if (!turns.some(t => t && t.role === 'assistant' && String(t.text || '').includes(BEGIN))) {
      try { const text = await ipcRenderer.invoke('get-last-assistant-text', session.id); last = typeof text === 'string' ? text : ''; } catch {}
    }
    return pickConclusion(turns, last);
  }

  async function run() {
    const session = getSession();
    const open = openFeedback();
    if (!session || !open || busy) return { ok: false };
    busy = true;
    const label = button.lastChild.textContent;
    button.lastChild.textContent = '正在整理…';
    try {
      const conclusion = await collect(session);
      const saved = readContext(session.cwd) || {};
      const description = feedbackDescription({ conclusion, ctx: saved.ctx || {}, sessionTitle: session.title || '', kindLabel: kindLabel(session.kind) });
      void open({ description });
      return { ok: true, found: conclusion.found };
    } catch (error) {
      notify('没能整理排查结果：' + (error && error.message ? error.message : error), 'error');
      return { ok: false };
    } finally {
      busy = false;
      button.lastChild.textContent = label;
    }
  }
  button.addEventListener('click', event => { event.preventDefault(); void run(); });

  return {
    button, run,
    sync(visible) {
      const session = getSession();
      const area = doc.getElementById('toolbar-actions');
      const show = !!visible && !!session && !!openFeedback() && isTroubleshootCwd(session.cwd, getDataDir());
      button.hidden = !show;
      if (!area) return;
      // 放在「文件管理」之前（「问一下」自己占最前一格，两边都抢第一格会互相挤个没完）；顶栏重绘后补回来。
      if (show && button.parentNode !== area) area.insertBefore(button, area.querySelector('.btn-file-manager-toggle'));
      if (!show && button.isConnected) button.remove();
    },
  };
}

function mountTroubleshootFeedback(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__troubleshootFeedbackUi) return win && win.__troubleshootFeedbackUi;
  const doc = win.document, area = doc && doc.getElementById && doc.getElementById('toolbar-actions');
  if (!area || typeof win.MutationObserver !== 'function') return null;
  /* global sessions, sessionSplit, activeSessionId, currentAppToolbarView */
  const current = () => { try { return sessions.get((typeof sessionSplit !== 'undefined' && sessionSplit?.focusedId()) || activeSessionId) || null; } catch { return null; } };
  const visible = () => { try { return !!activeSessionId && !(typeof currentAppToolbarView === 'function' && currentAppToolbarView()); } catch { return false; } };
  const ui = createTroubleshootFeedbackUi({
    document: doc, ipcRenderer: require('electron').ipcRenderer, getSession: current,
    getDataDir: () => require('../core/data-dir').getHubDataDir(),
    openFeedback: () => (win.__hubFeedback?.open ? prefill => win.__hubFeedback.open(prefill) : null),
    kindLabel: kind => { try { return require('../core/ai-kinds').getKindLabel(kind); } catch { return kind || ''; } },
    notify: (message, level) => { if (typeof win.showToast === 'function') win.showToast(message, level); },
  });
  let queued = false;
  new win.MutationObserver(() => {
    if (queued) return; queued = true;
    win.requestAnimationFrame(() => { queued = false; ui.sync(visible()); });
  }).observe(area, { childList: true });
  ui.sync(visible());
  win.__troubleshootFeedbackUi = ui;
  return ui;
}

module.exports = {
  CONTEXT_FILE, BEGIN, END, isTroubleshootCwd, extractConclusion, pickConclusion, feedbackDescription, readContext, writeContext,
  createTroubleshootFeedbackUi, mountTroubleshootFeedback,
};
