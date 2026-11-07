'use strict';
// 统一错误卡与一键求助（5.5.24「不再莫名报错」）。
// 出错时告诉用户：出了什么问题、为什么、怎么办；卡片右上角有两个平时看不见、悬停/聚焦才淡入的次级按钮：
//   「问问 Agent」—— 开一个 Agent 会话，把现象、出错的功能区、原始报错和本机日志所在位置发过去，请它先只读排查；
//   「一键反馈」—— 打开一键反馈并预填好现象（只在带反馈入口的发行版出现）。
// 对外接口（渲染进程全局）：
//   window.HubErrorCard.html({ area, title, cause, steps, actions, details, severity }) → HTML 字符串
//   window.HubErrorCard.assistHtml({ area, title, symptom, details }) → 只有两个求助按钮，嵌进现有提示里用
//   window.HubAssist.askAgent({ area, title, symptom, details }) / window.HubAssist.feedback({ area, title, details })
// 主按钮 data-hub-err-act 由调用方自己处理；求助按钮、复制在这里统一委托处理。

const { humanizeError } = require('../core/error-humanize');
const { matchKnownIssue } = require('../core/known-issues');

const AREA_LABELS = {
  welink: 'WeLink 助理',
  'ppt-doctor': 'PPT 助手（PPT Doctor）',
  codeagent: 'CodeAgent 会话',
  'session-create': '新建会话',
  'app-update': '一键更新',
  'company-proxy': '公司模型反代',
  'model-service': '对话里的模型服务',
  'hub-alert': 'AI HUB 操作提示',
  notice: '会话提示',
  toast: '操作提示',
};
const DEDUPE_MS = 30000;
const SETUP_TTL_MS = 60000;
const MAX_DETAILS = 4000;

const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (value, max) => { const s = String(value == null ? '' : value).trim(); return s.length > max ? s.slice(0, max) + '…（已截断）' : s; };
const areaLabel = area => AREA_LABELS[area] || String(area || '未注明');

// ---- 渲染 ----
function feedbackAvailable(env) {
  if (env && typeof env.feedback === 'boolean') return env.feedback;
  return typeof window !== 'undefined' && !!window.__hubFeedback?.open;
}
function askState(env) {
  if (env && env.ask) return env.ask;
  return (typeof window !== 'undefined' && window.HubAssist?.cachedAvailability?.()) || { ok: true };
}

function ctxAttrs({ area, title, symptom, details } = {}) {
  return `data-hub-err-area="${esc(area || '')}" data-hub-err-title="${esc(clip(title, 200))}"`
    + (symptom ? ` data-hub-err-symptom="${esc(clip(symptom, 600))}"` : '')
    + (details ? ` data-hub-err-details="${esc(clip(details, MAX_DETAILS))}"` : '');
}

function assistButtons(env) {
  const ask = askState(env);
  const askBtn = `<button type="button" class="hub-err-assist-btn" data-hub-err-assist="ask"${ask.ok ? ' title="开一个 Agent 会话，把这个报错发给它帮你排查"' : ` disabled title="${esc(ask.reason || '没有可用的 Agent')}"`}>问问 Agent</button>`;
  const fbBtn = feedbackAvailable(env) ? '<button type="button" class="hub-err-assist-btn" data-hub-err-assist="feedback" title="把这个报错连同日志发给维护人">一键反馈</button>' : '';
  return `<span class="hub-err-assist" role="group" aria-label="求助">${askBtn}${fbBtn}</span>`;
}

// 嵌进现有提示（弹窗、常驻提示条、更新弹窗）：外层带上下文属性，悬停外层时按钮淡入。
function assistHtml(ctx = {}, env) {
  return `<span class="hub-err-assist-host" ${ctxAttrs(ctx)}>${assistButtons(env)}</span>`;
}

// 已知问题（core/known-issues.js）：标题下直接给「已知解法」；能一键做的配主按钮（known: 开头，由本模块处理）。
function knownHtml(ctx = {}, { withAction = true } = {}) {
  const known = matchKnownIssue(ctx);
  if (!known) return '';
  const button = withAction && known.action ? `<button type="button" class="hub-err-btn primary" data-hub-err-act="${esc(known.action.act)}">${esc(known.action.label)}</button>` : '';
  return `<div class="hub-err-known" data-known-issue="${esc(known.id)}"><span class="hub-err-known-tag">已知解法</span><span class="hub-err-known-text">${esc(known.fix)}</span>${button ? `<span class="hub-err-known-actions">${button}</span>` : ''}</div>`;
}

// showDetails=false：原始报错只交给求助按钮带走，卡片上不再重复显示（例如原因一句就是原文时）。
function html({ area = '', title = '', cause = '', steps, actions, details = '', severity = 'error', symptom = '', showDetails = true } = {}, env) {
  const known = matchKnownIssue({ area, title, cause, details });
  const human = (!cause || !(steps && steps.length)) && details ? humanizeError(details) : null;
  const why = cause || human?.cause || '';
  const list = (Array.isArray(steps) && steps.length ? steps : human?.steps || []).filter(Boolean);
  const head = title || known?.title || human?.title || '出了点问题';
  const level = ['error', 'warning', 'info'].includes(severity) ? severity : 'error';
  const all = [known?.action, ...(Array.isArray(actions) ? actions : [])].filter(a => a && a.label && a.act);
  const buttons = all.map((a, i) => `<button type="button" class="hub-err-btn${i === 0 ? ' primary' : ''}" data-hub-err-act="${esc(a.act)}">${esc(a.label)}</button>`).join('');
  return `<div class="hub-err-card" data-severity="${level}" role="${level === 'error' ? 'alert' : 'status'}"${known ? ` data-known-issue="${esc(known.id)}"` : ''} ${ctxAttrs({ area, title: head, symptom: symptom || why, details })}>`
    + assistButtons(env)
    + `<div class="hub-err-title">${esc(head)}</div>`
    + (known ? knownHtml({ area, title, cause, details }, { withAction: false }) : '')
    + (why ? `<div class="hub-err-cause">${esc(why)}</div>` : '')
    + (list.length ? `<ol class="hub-err-steps">${list.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : '')
    + (buttons ? `<div class="hub-err-actions">${buttons}</div>` : '')
    + (details && showDetails ? `<details class="hub-err-details"><summary>技术详情</summary><div class="hub-err-details-body"><button type="button" class="hub-err-copy" data-hub-err-copy>复制</button><pre>${esc(clip(details, MAX_DETAILS))}</pre></div></details>` : '')
    + '</div>';
}

// ---- 求助 ----
function hubInfo() {
  const os = require('node:os'), path = require('node:path');
  let version = '';
  try { const d = require('../core/distribution'); version = d.editionVersion || ''; } catch {}
  if (!version) { try { version = require('../package.json').version; } catch {} }
  let productName = 'AI HUB';
  try { productName = require('../core/distribution').productName || productName; } catch {}
  const dataDir = require('../core/data-dir').getHubDataDir();
  return {
    productName, version, platform: `${process.platform} ${os.release()}`,
    appDir: path.resolve(__dirname, '..'), dataDir,
    files: [
      ['日志目录（按修改时间看最近的几份）', path.join(dataDir, 'logs')],
      ['诊断记录（闪退、启动耗时等）', path.join(dataDir, 'diagnostics')],
      ['上次一键更新的结果', path.join(dataDir, 'app-update', 'last-result.json')],
    ],
  };
}

function buildPrompt({ area, title, symptom, details } = {}, info = {}) {
  const lines = [
    `我在用 ${info.productName || 'AI HUB'} 时遇到了报错，请帮我排查。`,
    '',
    `- 现象：${clip(symptom || title || '（未描述）', 600)}`,
    title && symptom && symptom !== title ? `- 界面上的提示：${clip(title, 200)}` : null,
    `- 出错的功能区：${areaLabel(area)}`,
    `- 版本：${info.version ? 'v' + info.version : '未知'} · 系统：${info.platform || '未知'}`,
    '- 原始报错：',
    details ? '```\n' + clip(details, MAX_DETAILS) + '\n```' : '（界面上没有附带原始报错）',
    '',
    '本机相关文件的位置（请你自己去读，这里没有贴内容）：',
    ...(info.files || []).map(([name, file]) => `- ${name}：${file}`),
    info.appDir ? `- 程序所在目录：${info.appDir}` : null,
    '',
    '请先只读排查：找出和这个报错时间相近的日志记录，讲清楚是什么原因、我可以怎么解决。',
    '需要修改我电脑上的文件、设置，或安装、卸载软件之前，先告诉我要改什么、为什么，等我同意后再动手。',
  ];
  return lines.filter(line => line != null).join('\n');
}

// 每次「问问 Agent」用一个专属的空工作目录（<数据目录>/troubleshoot/<时间>）。
// 11-08 实测：排查会话开在默认工作区时，它自己的记录还没生成，卡片视图会显示同目录里别的会话正在写的记录。
function troubleshootDir(now = Date.now()) {
  const stamp = new Date(now + 8 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(require('../core/data-dir').getHubDataDir(), 'troubleshoot', `${stamp}-${Math.random().toString(36).slice(2, 6)}`);
  require('node:fs').mkdirSync(dir, { recursive: true });
  return dir;
}

function createHubAssist({ invoke, createSession, selectSession = () => {}, closeOverlays = () => {}, openFeedback = null,
  info = hubInfo, now = () => Date.now(), notify = () => {}, workDir = troubleshootDir } = {}) {
  const recent = new Map();
  let setup = null, setupAt = 0, setupPromise = null;

  function availabilityFrom(result) {
    const installed = new Set((result?.providers || []).filter(p => p && p.installed).map(p => p.id));
    return { installed, ok: ['codeagent', 'claude', 'codex'].some(k => installed.has(k)),
      reason: '这台电脑上没有找到 CodeAgent、Claude Code 或 Codex，装好其中一个就能用' };
  }
  function refreshAvailability({ force = false } = {}) {
    if (!force && setup && now() - setupAt < SETUP_TTL_MS) return Promise.resolve(setup);
    if (setupPromise) return setupPromise;
    setupPromise = Promise.resolve().then(() => invoke('community:setup')).then(result => {
      setup = availabilityFrom(result); setupAt = now(); return setup;
    }).catch(() => (setup = { installed: new Set(['codeagent', 'claude', 'codex']), ok: true, unknown: true }))
      .finally(() => { setupPromise = null; });
    return setupPromise;
  }
  // 报错本身就是 CodeAgent 起不来（或出错的就是某个 CodeAgent / Claude 会话）时，先不往同一种 Agent 里送，
  // 按 CodeAgent → Claude Code → Codex 的顺序换一个，出错的那种排最后。
  function candidateKinds({ area, sessionKind } = {}, installed) {
    const avoid = area === 'codeagent' ? 'codeagent' : String(sessionKind || '').replace(/-resume$/, '');
    const order = ['codeagent', 'claude', 'codex'];
    return [...order.filter(kind => kind !== avoid), ...order.filter(kind => kind === avoid)].filter(kind => installed.has(kind));
  }
  const keyOf = ctx => [ctx.area || '', ctx.title || '', String(ctx.details || '').slice(0, 300)].join('\u0001');

  async function askAgent(ctx = {}) {
    const key = keyOf(ctx);
    const hit = recent.get(key);
    if (hit && now() - hit.at < DEDUPE_MS) {
      if (hit.sessionId) { closeOverlays(); selectSession(hit.sessionId); return { ok: true, reused: true, sessionId: hit.sessionId, kind: hit.kind }; }
      if (hit.promise) return hit.promise;
    }
    const entry = { at: now(), sessionId: null, kind: null, promise: null };
    recent.set(key, entry);
    entry.promise = (async () => {
      const avail = await refreshAvailability();
      const kinds = candidateKinds(ctx, avail.installed);
      if (!kinds.length) { recent.delete(key); notify(avail.reason, 'error'); return { ok: false, reason: avail.reason }; }
      closeOverlays();
      const title = clip('排查：' + (ctx.title || areaLabel(ctx.area)), 60).replace('…（已截断）', '…');
      const errors = [];
      let cwd = null;
      try { cwd = workDir(now()); } catch { /* 建不了专属目录就退回默认工作区 */ }
      for (const kind of kinds) {
        let session;
        try { session = await createSession(kind, { workspaceLabel: title, ...(cwd ? { cwd } : {}), opts: { title, userRenamed: true } }); }
        catch (error) { errors.push(`${kind}：${error && error.message ? error.message : error}`); continue; }
        if (!session || !session.id) { errors.push(`${kind}：没有返回会话`); continue; }
        entry.sessionId = session.id; entry.kind = kind; entry.at = now();
        selectSession(session.id);
        const text = buildPrompt(ctx, typeof info === 'function' ? info() : info);
        let sent;
        try {
          sent = await invoke('session:send-prompt', { sessionId: session.id, text, clientSubmissionId: require('node:crypto').randomUUID(), waitForCliReady: true });
        } catch (error) { sent = { ok: false, message: error.message }; }
        if (sent && sent.ok === false) notify(`排查会话已打开，但第一句没发出去：${sent.message || sent.error || '未知原因'}。可以在输入框里直接描述问题。`, 'error');
        return { ok: true, sessionId: session.id, kind, sent: !(sent && sent.ok === false) };
      }
      recent.delete(key);
      const reason = '没能打开排查会话：' + errors.join('；');
      notify(reason, 'error');
      return { ok: false, reason };
    })();
    return entry.promise;
  }

  function feedbackText({ area, title, symptom, details } = {}) {
    return [
      `【出错的功能区】${areaLabel(area)}`,
      `【现象】${clip(symptom || title || '', 600)}`,
      title && symptom && symptom !== title ? `【界面提示】${clip(title, 200)}` : '',
      details ? `【原始报错】\n${clip(details, MAX_DETAILS)}` : '',
      '【补充】（可以在这里补一句你当时在做什么）',
    ].filter(Boolean).join('\n');
  }
  function feedback(ctx = {}) {
    const open = typeof openFeedback === 'function' ? openFeedback() : null;
    if (!open) return { ok: false, reason: '这个版本没有一键反馈入口' };
    void open({ description: feedbackText(ctx) });
    return { ok: true };
  }

  return {
    askAgent, feedback, refreshAvailability, buildPrompt, feedbackText,
    cachedAvailability: () => (setup ? { ok: setup.ok, reason: setup.ok ? '' : setup.reason } : null),
  };
}

// ---- 错误轻提示：停留更久，带「详情」可展开成错误卡 ----
function showErrorToast(doc, message, { area = 'toast', ms = 8000 } = {}) {
  const text = String(message || '').trim();
  if (!text) return null;
  let el = doc.getElementById('hub-err-toast');
  if (el) el.remove();
  el = doc.createElement('div');
  el.id = 'hub-err-toast';
  el.className = 'hub-err-toast';
  el.setAttribute('role', 'alert');
  const known = humanizeError(text);
  el.innerHTML = `<div class="hub-err-toast-row"><span class="hub-err-toast-text">${esc(text)}</span>`
    + '<button type="button" class="hub-err-toast-btn" data-hub-err-toast="detail">详情</button>'
    + '<button type="button" class="hub-err-toast-btn" data-hub-err-toast="close" aria-label="关闭">×</button></div>';
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { if (!el.classList.contains('expanded')) el.remove(); }, ms); };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  el.addEventListener('click', event => {
    const act = event.target.closest?.('[data-hub-err-toast]')?.dataset.hubErrToast;
    if (act === 'close') { clearTimeout(timer); el.remove(); }
    else if (act === 'detail') {
      clearTimeout(timer);
      el.classList.add('expanded');
      event.target.closest('[data-hub-err-toast]').remove();
      el.insertAdjacentHTML('beforeend', html({ area, title: known?.title || text.split(/\r?\n/)[0].slice(0, 80), cause: known ? known.cause : text, steps: known?.steps, details: text }));
    }
  });
  doc.body.appendChild(el);
  arm();
  return el;
}

// ---- 已知问题的一键动作 ----
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}
async function runKnownAction(act, button, { doc, ipcRenderer, closeOverlays }) {
  const label = button.textContent;
  const say = text => { if (button.isConnected) button.textContent = text; };
  const done = (text, ms = 2600) => {
    say(text);
    setTimeout(() => { if (button.isConnected) { button.textContent = label; button.disabled = false; } }, ms);
  };
  button.disabled = true;
  try {
    if (act === 'known:open-accounts') { closeOverlays(); doc.getElementById('btn-rail-accounts')?.click(); return done(label, 0); }
    if (act === 'known:welink-login') {
      closeOverlays();
      if (!doc.body.classList.contains('company-assistant-page-open')) doc.getElementById('btn-company-assistant')?.click();
      const login = await waitFor(() => doc.querySelector('[data-ca="login"]'), 6000);
      if (login) login.click();
      return done(login ? '已打开扫码' : '请在助理页点「扫码登录」', 3000);
    }
    if (act === 'known:codeagent-install') {
      closeOverlays();
      require('./codeagent-setup').createCodeAgentSetup({ document: doc, ipcRenderer }).showGuide();
      return done(label, 0);
    }
    if (act === 'known:codeagent-upgrade') {
      const r = await ipcRenderer.invoke('codeagent:open-upgrade').catch(error => ({ ok: false, message: error.message }));
      return done(r && r.ok ? '已打开升级窗口，完成后重启 AI HUB' : '没能打开升级窗口：' + ((r && r.message) || '未知原因'), 6000);
    }
    if (act === 'known:proxy-restart') {
      say('正在重新启动…');
      const r = await ipcRenderer.invoke('company-proxy:restart').catch(error => ({ ok: false, error: error.message }));
      return done(r && r.ok ? '已重新启动' : '重启失败：' + ((r && r.error) || '未知原因'), 5000);
    }
    if (act === 'known:proxy-wait') {
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        const r = await ipcRenderer.invoke('company-proxy:status').catch(() => null);
        const state = r && r.proxy && r.proxy.state;
        if (state === 'running') {
          const submit = button.closest('#new-session-error') ? doc.getElementById('new-session-submit') : null;
          if (submit && !submit.disabled) { submit.click(); return done('已就绪，正在重试', 2000); }
          return done('已就绪，可以重试了', 5000);
        }
        if (state === 'failed') return done('反代没能启动，点「问问 Agent」看原因', 6000);
        say(`等待反代就绪…（还剩 ${Math.max(0, Math.round((end - Date.now()) / 1000))} 秒）`);
        await sleep(2000);
      }
      return done('等了 90 秒还没就绪', 6000);
    }
    if (act === 'known:update-check' || act === 'known:update-redownload') {
      say('正在检查…');
      await ipcRenderer.invoke('app-update:check');
      if (act === 'known:update-redownload') {
        const state = await ipcRenderer.invoke('app-update:get-state').catch(() => null);
        if (state && state.phase === 'available') { say('正在重新下载…'); await ipcRenderer.invoke('app-update:download'); }
      }
      return done(label, 0);
    }
    return done(label, 0);
  } catch (error) {
    return done('没做成：' + (error && error.message ? error.message : error), 5000);
  }
}

// ---- 安装：全局接口 + 点击委托 ----
function contextOf(button, sessionKind) {
  const host = button.closest('[data-hub-err-area]');
  if (!host) return {};
  const d = host.dataset;
  const sessionId = button.closest('.turn-card')?.dataset.sessionId || '';
  let kind = '';
  try { kind = sessionId && typeof sessionKind === 'function' ? sessionKind(sessionId) || '' : ''; } catch {}
  return { area: d.hubErrArea || '', title: d.hubErrTitle || '', symptom: d.hubErrSymptom || '', details: d.hubErrDetails || '', sessionKind: kind };
}

function paintAvailability(root, state) {
  for (const btn of root.querySelectorAll('[data-hub-err-assist="ask"]')) {
    btn.disabled = !state.ok;
    btn.title = state.ok ? '开一个 Agent 会话，把这个报错发给它帮你排查' : state.reason;
  }
}

function install({ document: doc, window: win, ipcRenderer, sessionKind = null }) {
  if (win.HubErrorCard && win.HubAssist) return win.HubAssist;
  const closeOverlays = () => {
    for (const dialog of doc.querySelectorAll('dialog[open].hub-dialog, dialog[open].app-update-dialog:not(.hub-feedback-dialog)')) { try { dialog.close(); } catch {} }
    // 新建会话面板里的报错：先收起面板，再切到排查会话（launch-center 自己的关闭会同步遮罩等状态）。
    const menu = doc.getElementById('new-session-menu');
    if (menu && menu.style.display !== 'none') { try { (win.LaunchCenter?.close || win.WorkspaceController?.closeNewSessionModal)?.(); } catch {} }
  };
  const assist = createHubAssist({
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    createSession: (kind, options) => win.WorkspaceController.createSession(kind, options),
    selectSession: id => { if (typeof win.selectSession === 'function') void win.selectSession(id); },
    closeOverlays,
    openFeedback: () => (win.__hubFeedback?.open ? prefill => win.__hubFeedback.open(prefill) : null),
    notify: (message, level) => (typeof win.showToast === 'function' ? win.showToast(message, level) : showErrorToast(doc, message)),
  });
  win.HubErrorCard = { html, assistHtml, knownHtml, showErrorToast: (message, options) => showErrorToast(doc, message, options) };
  win.HubAssist = assist;

  doc.addEventListener('click', event => {
    const copy = event.target.closest?.('[data-hub-err-copy]');
    if (copy) {
      const pre = copy.closest('.hub-err-details')?.querySelector('pre');
      try { require('electron').clipboard.writeText(pre ? pre.textContent : ''); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; }
      setTimeout(() => { copy.textContent = '复制'; }, 1600);
      return;
    }
    const knownBtn = event.target.closest?.('[data-hub-err-act^="known:"]');
    if (knownBtn) {
      event.preventDefault(); event.stopPropagation();
      if (!knownBtn.disabled) void runKnownAction(knownBtn.dataset.hubErrAct, knownBtn, { doc, win, ipcRenderer, closeOverlays });
      return;
    }
    const button = event.target.closest?.('[data-hub-err-assist]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const ctx = contextOf(button, sessionKind);
    if (button.dataset.hubErrAssist === 'feedback') { assist.feedback(ctx); return; }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = '正在打开…';
    Promise.resolve(assist.askAgent(ctx)).finally(() => { if (button.isConnected) { button.disabled = false; button.textContent = label; } });
  }, true);
  // 悬停或聚焦到报错时才确认一次哪些 Agent 可用（缓存 1 分钟），没有可用的就把「问问 Agent」置灰并说明原因。
  const onEnter = event => {
    const host = event.target.closest?.('.hub-err-card, .hub-err-assist-host, [data-hub-err-area]');
    if (!host) return;
    void assist.refreshAvailability().then(state => paintAvailability(host, { ok: state.ok, reason: state.reason }));
  };
  doc.addEventListener('pointerover', onEnter, true);
  doc.addEventListener('focusin', onEnter, true);
  return assist;
}

module.exports = { html, assistHtml, knownHtml, createHubAssist, buildPrompt, showErrorToast, install, areaLabel, AREA_LABELS };
