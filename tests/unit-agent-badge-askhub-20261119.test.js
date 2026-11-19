'use strict';
// J 席（2026-11-19，体验 3、10）：会话顶栏和回答旁标出 Agent 程序；报错卡旁的「问问 Hub」带上报错文字打开问问 Hub 面板。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAgentLabel } = require('../core/ai-kinds');
const card = require('../renderer/hub-error-card');
const { errorQuestion, attachHelpAsk } = require('../renderer/help-ask-ui');
const turnErrorHelp = require('../renderer/turn-error-help');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');

test('Agent 标识：按会话背后的程序标，同一家模型跑在不同程序上标法不同', () => {
  assert.equal(getAgentLabel('claude'), 'Claude Code');
  assert.equal(getAgentLabel('claude-resume'), 'Claude Code');
  assert.equal(getAgentLabel('deepseek-claude'), 'Claude Code');
  assert.equal(getAgentLabel('codex'), 'Codex');
  assert.equal(getAgentLabel('deepseek'), 'Codex');
  assert.equal(getAgentLabel('codeagent-resume'), 'CodeAgent');
  assert.equal(getAgentLabel('deepseek-acp'), 'DSH');
  assert.equal(getAgentLabel('powershell'), '');
  assert.equal(getAgentLabel(undefined), '');
});

function renderer() {
  const node = () => ({ addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {}, setAttribute() {}, classList: { add() {}, remove() {} }, style: {}, dataset: {} });
  const document = { addEventListener() {}, removeEventListener() {}, createElement: node, body: node() };
  const root = node();
  return createTurnCardRenderer({ document, window: {}, root, container: root, bridgeIpc: null, getSessionContext: () => null,
    formatAbsoluteTime: () => 't', escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    normalizeMarkdownPathBreaks: v => v, marked: { parse: v => v }, DOMPurify: { sanitize: v => v } });
}

test('回答旁：模型名后面挂程序标识；用户消息、名字里已写了程序名的不挂', () => {
  const r = renderer();
  const a = r.renderTurnCard({ id: 'a1', role: 'assistant', text: 'hi', kind: 'deepseek-claude', model: 'deepseek-v4-pro' });
  assert.match(a, /<span class="turn-who">deepseek-v4-pro<\/span><span class="turn-agent-badge" data-agent="deepseek-claude" title="由 Claude Code 回答">Claude Code<\/span>/);
  const c = r.renderTurnCard({ id: 'a2', role: 'assistant', text: 'hi', kind: 'codeagent-resume', model: 'GLM-5.2' });
  assert.match(c, /turn-agent-badge" data-agent="codeagent"[^>]*>CodeAgent</);
  const u = r.renderTurnCard({ id: 'u1', role: 'user', text: 'hi', kind: 'claude' });
  assert.ok(!u.includes('turn-agent-badge'));
  const noModel = r.renderTurnCard({ id: 'a3', role: 'assistant', text: 'hi', kind: 'codex' });
  assert.ok(!noModel.includes('turn-agent-badge'), '名字已经是 Codex 就不再挂一枚 Codex');
  r.dispose();
});

test('报错卡：有问问 Hub 时动作区常显「问问 Hub」；没有时位置留空，悬停求助区也不重复', () => {
  const env = { feedback: true, ask: { ok: true }, askHub: true };
  const html = card.html({ area: 'session-create', title: '创建失败', cause: '目录不存在', steps: ['换目录'], details: 'ENOENT' }, env);
  assert.match(html, /data-hub-err-slot="ask-hub"><button type="button" class="hub-err-btn hub-err-ask-hub" data-hub-err-assist="ask-hub"[^>]*>问问 Hub<\/button><\/span>/);
  assert.equal((html.match(/data-hub-err-assist="ask-hub"/g) || []).length, 1);
  const off = card.html({ title: '创建失败' }, { ...env, askHub: false });
  assert.ok(!off.includes('data-hub-err-assist="ask-hub"'), off);
  assert.match(off, /data-hub-err-slot="ask-hub"><\/span>/);
});

test('嵌进别的提示的求助区（assistHtml）：带「问问 Hub」，调用方可关掉', () => {
  const env = { feedback: true, ask: { ok: true }, askHub: true };
  assert.match(card.assistHtml({ area: 'welink', title: '扫码失败' }, env), /data-hub-err-assist="ask-hub"[^>]*>问问 Hub</);
  assert.ok(!card.assistHtml({ area: 'welink', title: '扫码失败' }, { askHub: false }).includes('ask-hub'));
});

test('提问文字：带功能区、提示、原始报错，长报错截短，总长不超过 2000 字', () => {
  const q = card.askHubQuestion({ area: 'session-create', title: '创建失败', symptom: '工作目录不存在', details: 'ENOENT: no such file' });
  assert.match(q, /^我在 Hub 里遇到一个报错/);
  assert.match(q, /出错的地方：新建会话/);
  assert.match(q, /界面提示：创建失败/);
  assert.match(q, /说明：工作目录不存在/);
  assert.match(q, /原始报错：\nENOENT: no such file$/);
  const long = errorQuestion({ title: 'x', details: 'E'.repeat(9000) });
  assert.ok(long.length <= 2000, String(long.length));
  assert.ok(long.endsWith('…'));
  assert.ok(!errorQuestion({ title: '同一句', details: '同一句' }).includes('原始报错'), '原文和提示一样时不重复贴');
});

test('模型服务报错（回答里的 API Error）：对症按钮后面常显「问问 Hub」，点了带报错提问', () => {
  const info = turnErrorHelp.classifyError('API Error: 429 rate limit');
  const esc = s => String(s);
  assert.match(turnErrorHelp.renderHelp(info, esc, { askHub: true }), /data-teh="retry"[^]*data-teh="ask-hub"[^>]*>问问 Hub</);
  assert.ok(!turnErrorHelp.renderHelp(info, esc, { askHub: false }).includes('ask-hub'));
  const asked = [];
  const win = { __hubHelpAsk: { ask: q => { asked.push(q); return { ok: true }; } } };
  const q = sel => ({ '.turn-error-help': { querySelector: s => ({ '.teh-title': { textContent: info.title }, '.teh-detail': { textContent: info.detail } }[s]) },
    '.teh-raw': { textContent: '原始报错API Error: 429 rate limit' } }[sel]);
  assert.equal(turnErrorHelp.runAction('ask-hub', { card: { querySelector: q, closest: () => null }, document: {}, window: win }), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /出错的地方：对话里的模型服务/);
  assert.match(asked[0], /原始报错：\nAPI Error: 429 rate limit/);
  assert.equal(turnErrorHelp.runAction('ask-hub', { card: { querySelector: q, closest: () => null }, document: {}, window: {} }), false, '没有问问 Hub 时不做事');
});

// 面板接口：ask() 打开面板并直接提问；正在答上一题时只填进输入框，不打断、不并发。
function fakeDom() {
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.attrs = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.textContent = ''; this.classList = { add() {}, remove() {} }; }
    append(...n) { this.children.push(...n); } appendChild(n) { this.children.push(n); return n; }
    replaceChildren(...n) { this.children = n; }
    setAttribute(k, v) { this.attrs[k] = v; } addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    focus() {} contains() { return false; } get firstChild() { return new El('svg'); }
    set innerHTML(_v) {}
  }
  const doc = { head: new El('head'), body: new El('body'), defaultView: { addEventListener() {}, innerHeight: 900 },
    createElement: t => new El(t), createTextNode: t => ({ text: t }), getElementById: () => null, querySelector: () => null, addEventListener() {} };
  return doc;
}

test('问问 Hub 面板 ask()：打开面板并提问；上一题还在答时只填进输入框', async () => {
  const calls = [];
  let release;
  const ipcRenderer = { invoke: (ch, payload) => {
    calls.push([ch, payload]);
    if (ch === 'help-ask:state') return Promise.resolve({ engine: 'claude', engineLabel: 'Claude Code' });
    if (ch === 'help-ask:ask') return new Promise(res => { release = () => res({ ok: true, answer: '先重启会话', engineLabel: 'Claude Code', ms: 900 }); });
    return Promise.resolve({});
  } };
  const api = attachHelpAsk({ document: fakeDom(), ipcRenderer });
  assert.equal(api.isOpen(), false);
  assert.equal(api.ask('报错 A').ok, true);
  assert.equal(api.isOpen(), true);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
  const asks = calls.filter(c => c[0] === 'help-ask:ask');
  assert.equal(asks.length, 1);
  assert.equal(asks[0][1].question, '报错 A');
  const second = api.ask('报错 B');
  assert.equal(second.queued, true, '正在答时不并发第二题');
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.filter(c => c[0] === 'help-ask:ask').length, 1);
  api.close();
});

// Codex 审查（2026-11-20）补的三种情况：检测引擎期间关面板、检测期间连点两个报错、没有可用引擎。
function harness({ engine = 'claude' } = {}) {
  const calls = [];
  let releaseState;
  const ipcRenderer = { invoke: (ch, payload) => {
    calls.push([ch, payload]);
    if (ch === 'help-ask:state') return new Promise(res => { releaseState = () => res(engine ? { engine, engineLabel: 'Claude Code' } : { engine: null }); });
    if (ch === 'help-ask:ask') return new Promise(() => {});
    return Promise.resolve({});
  } };
  const doc = fakeDom();
  const api = attachHelpAsk({ document: doc, ipcRenderer });
  const textarea = () => doc.body.children[0].children.find(n => n.tagName === 'footer').children[0].children[0];
  const flush = async () => { for (let i = 0; i < 3; i++) { releaseState?.(); await new Promise(r => setTimeout(r, 0)); } };
  return { api, calls, flush, textarea, asks: () => calls.filter(c => c[0] === 'help-ask:ask') };
}

test('问问 Hub ask()：检测引擎期间关掉面板，不在后台发问', async () => {
  const h = harness();
  h.api.ask('报错 A');
  h.api.close();
  await h.flush();
  assert.equal(h.asks().length, 0);
});

test('问问 Hub ask()：检测期间连点两个报错，以后一个为准，只发一次', async () => {
  const h = harness();
  h.api.ask('报错 A');
  h.api.ask('报错 B');
  await h.flush();
  assert.equal(h.asks().length, 1);
  assert.equal(h.asks()[0][1].question, '报错 B');
  assert.equal(h.textarea().value, '', '发出去后清空输入框');
  h.api.close();
});

test('问问 Hub ask()：没有可用引擎时不发问，报错文字留在输入框等装好后再问', async () => {
  const h = harness({ engine: null });
  h.api.ask('报错 C');
  await h.flush();
  assert.equal(h.asks().length, 0);
  assert.equal(h.textarea().value, '报错 C');
  h.api.close();
});

test('复审补点：报错文字交给问问 Hub 前脱敏（令牌、本机用户目录不进模型提示和记录）', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-ask-redact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let seen = '';
  const { createHelpAskService } = require('../main/help-ask-service');
  const svc = createHelpAskService({ getHubDataDir: () => dir, distribution: { edition: 'public' }, getConfig: () => ({}),
    createEngine: () => ({ ask: async ({ question }) => { seen = question; return { ok: true, answer: 'x' }; }, state: () => ({}), cancel() {} }), logger: { warn() {} } });
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
  await svc.ask({ question: '报错：' + secret + ' 在 ' + path.join(os.homedir(), 'x.log') });
  assert.ok(!seen.includes('abcdefghijklmnopqrstuvwxyz0123456789'), '令牌不进模型提示');
  assert.ok(!seen.includes(os.homedir()), '本机用户目录不进模型提示');
  const hist = fs.readFileSync(path.join(dir, 'help-ask', 'history.jsonl'), 'utf8');
  assert.ok(!hist.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('复审补点：2026-08 迁移前的 DeepSeek 会话（实际跑 Claude Code）标成 Claude Code', () => {
  const { runtimeKindForSession } = require('../core/session-capabilities');
  const legacy = { kind: 'deepseek', ccSessionId: 'abc' };
  assert.equal(getAgentLabel(runtimeKindForSession(legacy) || legacy.kind), 'Claude Code');
  assert.equal(getAgentLabel('deepseek-legacy'), 'Claude Code');
});
