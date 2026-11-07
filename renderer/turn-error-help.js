'use strict';
// 模型服务报错的人话说明：卡片里原来只有一行英文 JSON（API Error: 429 {...}），用户不知道发生了什么、接下来该点哪。
// 这里只负责显示：把报错归到几类，告诉用户这是什么、下一步能做什么，原文折叠保留。不触发任何自动动作
// （自动避让仍只认 core/codeagent-quota.js 里有真实样本的规则），所以归错类的代价只是提示文字不够准。
//
// 真实样本（公司 CodeAgent）：
//   「API Error token消耗过快， 已达到4亿上限」、「API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置」、
//   一键反馈 20261102：「Error: 模型 "…" 不存在或配置有误，请检查模型配置」。
// 其余英文形式来自同内核 CLI 的公开错误文档（401 登录失效、429 限流、5xx 服务异常、prompt is too long），公司真机出现新样本时补进来。
const ERROR_LINE = /^\s*(?:API\s*Error\b|Error:\s*模\s*型\s)/i;

const KINDS = [
  { kind: 'auth', test: /\b401\b|\b403\b|authentication|unauthori[sz]ed|forbidden|token[^\n]{0,40}expired|expired[^\n]{0,40}token|\/login|重新登录|未登录|登录(?:已)?(?:过期|失效)/i,
    title: '登录过期了', detail: '这个账号的登录已经失效，重新登录一次就好，刚才的对话不会丢。', actions: ['accounts', 'retry'] },
  { kind: 'model', test: /模\s*型[^\n]{0,100}(?:不\s*存\s*在|配\s*置\s*有\s*误)|model[^\n]{0,80}(?:not\s*found|does\s*not\s*exist|not\s*available)|无权限使用/i,
    title: '这个号用不了这个模型', detail: '要么是这个号没有这个模型的权限，要么模型名已经换了。换一个模型继续就行，对话不会丢。', actions: ['model', 'accounts'] },
  { kind: 'quota', test: /token\s*消耗\s*过快|已\s*达\s*到[^\n]{0,20}上\s*限|额度|配额|余额|quota|credit|balance|insufficient|billing/i,
    title: '这个账号的额度用完了', detail: '可以换一个模型或账号继续，也可以等额度恢复（一般是第二天 0 点）。对话不会丢。', actions: ['model', 'accounts', 'retry'] },
  { kind: 'context', test: /prompt\s+is\s+too\s+long|context[_\s-]*(?:length|window|limit)|maximum\s+context|too\s+many\s+tokens|上下文[^\n]{0,20}(?:过长|超|太长)/i,
    title: '这个会话太长了', detail: '内容超过了模型一次能读的上限。压缩一下上下文再发，或者开一个新会话接着做。', actions: ['compact', 'new-session'] },
  { kind: 'rate', test: /\b429\b|rate[\s_-]*limit|too\s+many\s+requests|限\s*流|频\s*率|过\s*快/i,
    title: '请求太频繁，被限流了', detail: '一般等一分钟再试就好；着急可以先换个模型。', actions: ['retry', 'model'] },
  { kind: 'service', test: /\b5\d\d\b|overloaded|upstream|connect(?:ion)?\s*(?:error|refused|reset)|ECONN|ETIMEDOUT|ENOTFOUND|timed?\s*out|socket|network|fetch\s+failed|网关|网络|超时/i,
    title: '模型服务暂时连不上', detail: '通常是服务或公司网络波动，稍等再试。连续出现的话，告诉维护人时带上下面的原始报错。', actions: ['retry', 'model', 'feedback'] },
];
const FALLBACK = { kind: 'other', title: '模型服务返回了错误', detail: '可以先重试；还不行就换个模型，或者把原始报错反馈给维护人。', actions: ['retry', 'model', 'feedback'] };

const ACTION_LABELS = { retry: '重试这一条', model: '换个模型', accounts: '打开账号页', compact: '压缩上下文', 'new-session': '开新会话', feedback: '一键反馈' };

function isErrorLine(text) { return ERROR_LINE.test(String(text || '')); }

function classifyError(text) {
  const whole = String(text || '').trim();
  // 真实报错是一行短文字；回答里拿「API Error」开头来解释的，通常很长或是带句号的整句。
  if (whole.length > 800 || /[。！？]$/.test(whole)) return null;
  const value = whole.slice(0, 2000);
  if (!isErrorLine(value)) return null;
  return KINDS.find(rule => rule.test.test(value)) || FALLBACK;
}

function renderHelp(info, escapeHtml) {
  const buttons = info.actions.map(action => `<button type="button" class="teh-btn" data-teh="${action}">${escapeHtml(ACTION_LABELS[action])}</button>`).join('');
  return `<div class="teh-title">${escapeHtml(info.title)}</div><div class="teh-detail">${escapeHtml(info.detail)}</div><div class="teh-actions">${buttons}</div>`;
}

// 正文里最后一段是报错时才处理：回答中间引用报错原文的不算。
function enhanceCard(card) {
  if (!card || !card.classList?.contains('turn-card') || !card.classList.contains('assistant')) return false;
  if (card.querySelector('.turn-error-help')) return true;
  const body = card.querySelector('.turn-body');
  const blocks = body ? [...body.querySelectorAll('p, pre')].filter(el => (el.textContent || '').trim()) : [];
  const last = blocks[blocks.length - 1];
  const info = last ? classifyError(last.textContent) : null;
  if (!info) return false;
  const doc = card.ownerDocument;
  const help = doc.createElement('div');
  help.className = 'turn-error-help';
  help.dataset.errorKind = info.kind;
  help.setAttribute('role', 'status');
  help.dataset.copyExclude = '';
  help.innerHTML = renderHelp(info, s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))
    // 右上角悬停才出现的「问问 Agent」「一键反馈」（5.5.24，renderer/hub-error-card.js）。
    + require('./hub-error-card').assistHtml({ area: 'model-service', title: info.title, symptom: info.detail, details: last.textContent.trim() });
  const raw = doc.createElement('details');
  raw.className = 'teh-raw';
  raw.innerHTML = '<summary>原始报错</summary>';
  last.parentNode.insertBefore(help, last);
  last.parentNode.insertBefore(raw, last);
  raw.append(last);
  return true;
}

function runAction(action, { card, document: doc, window: win, ipcRenderer }) {
  const panel = card.closest('.terminal-panel') || doc;
  if (action === 'retry') { card.querySelector('[data-action="regen"]')?.click(); return true; }
  if (action === 'model') { panel.querySelector('.composer-model')?.click(); return true; }
  if (action === 'accounts') { doc.getElementById('btn-rail-accounts')?.click(); return true; }
  if (action === 'feedback') {
    const help = card.querySelector('.turn-error-help');
    const raw = (card.querySelector('.teh-raw')?.textContent || '').replace(/^原始报错/, '').trim();
    if (win.HubAssist) win.HubAssist.feedback({ area: 'model-service', title: help?.querySelector('.teh-title')?.textContent || '', symptom: help?.querySelector('.teh-detail')?.textContent || '', details: raw });
    else win.__hubFeedback?.open?.();
    return true;
  }
  if (action === 'new-session') { win.LaunchCenter?.open?.('session', { kind: 'codeagent' }); return true; }
  if (action === 'compact') {
    const sessionId = card.dataset.sessionId || win.activeSessionId;
    if (sessionId && ipcRenderer) void ipcRenderer.invoke('session:send-prompt', { sessionId, text: '/compact', clientSubmissionId: require('node:crypto').randomUUID() });
    return true;
  }
  return false;
}

function install({ document: doc, window: win, ipcRenderer }) {
  doc.addEventListener('click', event => {
    const button = event.target.closest?.('[data-teh]');
    if (!button) return;
    const card = button.closest('.turn-card');
    if (card) runAction(button.dataset.teh, { card, document: doc, window: win, ipcRenderer });
  });
}

module.exports = { classifyError, isErrorLine, enhanceCard, runAction, install, ACTION_LABELS };
