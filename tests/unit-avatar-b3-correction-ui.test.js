'use strict';
// 阶段 2 第 3 批前端：答错一键就地纠偏、新旧稿并排、重答失败不丢卡、「它学到的」撤销 / 恢复、回复对象改配与「不是问我的」、
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAvatarPage, externalRows, markCards, cardNo } = require('../renderer/avatar-page.js');

function fakeDom() {
  const el = tag => {
    const node = { tagName: tag.toUpperCase(), hidden: false, style: {}, dataset: {}, children: [], listeners: {}, html: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, [Symbol.iterator]() { return this.set.values(); } },
      setAttribute() {}, addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); }, querySelectorAll: () => [], querySelector: () => null,
      append(child) { node.children.push(child); }, remove() {}, getBoundingClientRect: () => ({ width: 0, height: 0, right: 0, bottom: 0 }), contains: () => false };
    Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: v => { node.html = v; if (/^<div class="avx-root">/.test(v)) node.firstChild = el('div'); } });
    return node;
  };
  const body = el('body');
  return { document: { body, createElement: el, getElementById: () => null, activeElement: null }, window: { innerHeight: 900, addEventListener() {}, removeEventListener() {} }, body };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
const mk = (id, name, extra = {}) => ({ id, name, tpl: 'qa', kind: 'pick', action: 'draft', targets: [], owners: {}, only: [], skip: [], state: { code: 'on', text: '运行中' }, pending: 1, stats: { model: 0, read: 0, ready: 0, remind: 0, sent: 0 }, enabled: true,
  backend: { account: 'auto', model: '', effort: '' }, prefix: 'p', hideModel: false, persona: '', notes: '', authorities: [], sources: [], examples: 2, memoryLines: 5, session: { alive: false, questions: 0 }, log: [], ...extra });
const item = (avatarId, id, extra = {}) => ({ id, avatarId, avatarName: avatarId, who: '同事A', convName: '项目群', group: true, at: 1, since: 1, text: '小队模式能发图片吗？', state: 'ready', draft: '旧稿：取决于模型', flags: [], replyTarget: { sender: '同事A', at: 1, snippet: '小队模式能发图片吗？' }, ...extra });
function harness(handlers = {}, setup = () => {}) {
  const { document, window, body } = fakeDom();
  const calls = [], fb = [];
  window.__hubFeedback = { open: x => { fb.push(x); return Promise.resolve(); } };
  const st = { avatars: [mk('av1', '甲'), mk('av2', '乙')], items: [item('av1', 'i1'), item('av2', 'i2', { draft: '乙的旧稿' })], externalItems: undefined };
  setup(st);
  const status = () => ({ ok: true, available: true, login: { ok: true }, paused: false, avatars: st.avatars, items: st.items, externalItems: st.externalItems, backends: { rows: [] } });
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async (name, payload) => {
    calls.push([name, payload]);
    if (handlers[name]) return handlers[name](payload, st, status);
    if (name === 'avatar:targets') return { groups: [], people: [], ready: true };
    return status();
  } };
  const page = createAvatarPage({ document, window, ipcRenderer });
  const section = () => body.children[0];
  // inside：被点元素所在的容器（data-tryout / data-fixredo），按真实 DOM 的 closest 语义返回带 dataset 的祖先。
  const click = async (dataset, inside = {}) => { for (const fn of section().listeners.click) fn({ target: { closest: () => ({ dataset, disabled: false, closest: sel => (sel === '[data-fixredo]' && inside.fixredo ? { dataset: { fixredo: inside.fixredo } } : sel === '[data-tryout]' && inside.tryout ? {} : null) }) } }); await settle(); };
  const type = (dataset, value) => { for (const fn of section().listeners.input) fn({ target: { dataset, value } }); };
  const of = name => calls.filter(c => c[0] === name);
  return { page, calls, of, click, type, fb, html: () => section().firstChild.innerHTML, st };
}
const fill = async (h, key, reason, text) => { await h.click({ av: 'fix-open', key }); await h.click({ av: 'fix-reason', key, k: reason }); h.type({ fixText: key }, text); };

test('纯函数：外部转交文件只取 pending、按 ext| 前缀隔离；卡号显示数字；依据里的纠错卡高亮并统一成 #数字', () => {
  const rows = externalRows([{ id: 'q1', status: 'pending', kind: 'draft', confidence: 45, basis: ['卡 C1'], askerName: '同事A', question: 'Q' }, { id: 'q2', status: 'resolved' }, { id: 'q3', kind: 'promise' }, null], [mk('a0', 'x', { tpl: 'draft' }), mk('a9', 'y')]);
  assert.deepEqual(rows.map(r => r._key), ['ext|q1', 'ext|q3']);
  assert.equal(rows[0].avatarId, 'a9', '没写 avatarId 时落到群答疑分身');
  assert.equal(rows[1].kind, 'promise');
  assert.equal(externalRows(undefined, []).length, 0);
  assert.equal(cardNo({ id: 'cor-12' }), '12');
  assert.equal(markCards('按你的纠错卡 #cor-3 v2 改写'), '按<mark class="avx-hit">你的纠错卡 #3 v2</mark> 改写');
});

test('答错了，这样改：错因 + 正确说法 → 调 avatar:correct-item（默认本分身、立即重答）→ 新旧并排 + 纠错卡高亮 → 采用新稿填回草稿框', async () => {
  const h = harness({ 'avatar:correct-item': (p, st, status) => {
    st.items[0] = { ...st.items[0], correctedCardId: 'cor-7', oldDraftSnapshot: '旧稿：取决于模型' };
    return { ok: true, card: { id: 'cor-7', version: 1, active: true }, status: status(), redraftResult: { draft: '新稿：只收文字，截图先转文字', basis: ['[纠错卡 #cor-7 v1]', '群历史问答'], confidence: 86, why: '按你的纠错卡 #cor-7 改写' } };
  } });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' });
  assert.match(h.html(), /data-av="fix-open" data-key="av1\|i1">答错了，这样改</);
  await h.click({ av: 'fix-open', key: 'av1|i1' });
  for (const n of ['事实错', '语气不像', '不该回', '太长', '漏关键点', '回错人']) assert.ok(h.html().includes(`>${n}</button>`), n);
  assert.match(h.html(), /将存为本分身纠错卡（只存公司本机，默认不外发）/);
  assert.match(h.html(), /data-av="fix-save"[^>]*disabled/, '没选错因、没写说法时不能保存');
  await h.click({ av: 'fix-reason', key: 'av1|i1', k: 'missing_point' }); h.type({ fixText: 'av1|i1' }, '只收文字，截图先转文字');
  await h.click({ av: 'fix-save', key: 'av1|i1' });
  const [, p] = h.of('avatar:correct-item')[0];
  assert.deepEqual(p, { avatarId: 'av1', itemId: 'i1', reason: 'missing_point', correctAnswer: '只收文字，截图先转文字', scope: 'this_avatar', redraft: true });
  const html = h.html();
  assert.match(html, /data-cmp="old">旧稿：取决于模型</);
  assert.match(html, /data-cmp="new">新稿：只收文字，截图先转文字</);
  assert.match(html, /<span class="avx-ch hit">你的纠错卡 #7<\/span>/);
  assert.match(html, /<mark class="avx-hit">你的纠错卡 #7<\/mark>/);
  assert.match(html, /已纠错/);
  await h.click({ av: 'fix-adopt', key: 'av1|i1' });
  assert.match(h.html(), /<textarea id="avx-draft"[^>]*>新稿：只收文字，截图先转文字<\/textarea>/);
  assert.equal(h.of('avatar:send').length, 0, '采用新稿只填回，不发送');
  h.page.destroy();
});

test('重答没成功（redraftFailure）：卡已保存的提示 + failureBox；「重试」只重写这一条，绝不调 avatar:recheck，也不再建卡', async () => {
  const h = harness({ 'avatar:correct-item': (p, st, status) => ({ ok: true, card: { id: 'cor-2', version: 1, active: true }, status: status(),
    redraftFailure: { code: 'model_unavailable', severity: 'error', headline: '模型没就绪，没法重答', retryable: true, actions: [{ kind: 'retry_tick', label: '重试', payload: {} }] } }) });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await fill(h, 'av1|i1', 'fact', '正确口径'); await h.click({ av: 'fix-save', key: 'av1|i1' });
  assert.match(h.html(), /纠错卡已保存在本机，重答暂未成功/);
  assert.match(h.html(), /纠错卡 #2 已保存/);
  assert.match(h.html(), /data-fixredo="av1\|i1"/);
  assert.match(h.html(), /模型没就绪，没法重答/);
  const rechecks = h.of('avatar:recheck').length;
  await h.click({ av: 'fix', kind: 'retry_tick', payload: '{}' }, { fixredo: 'av1|i1' });
  assert.equal(h.of('avatar:recheck').length, rechecks, '没走正式巡检');
  assert.deepEqual(h.of('avatar:redraft').map(c => c[1]), [{ avatarId: 'av1', itemId: 'i1' }]);
  assert.equal(h.of('avatar:correct-item').length, 1, '不重复建卡');
  h.page.destroy();
});

test('敏感词等被主进程拒绝：就地显示原因，用户写的正确说法不丢', async () => {
  const h = harness({ 'avatar:correct-item': () => ({ ok: false, error: '正确说法里有敏感词（工号），没有保存' }) });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await fill(h, 'av1|i1', 'fact', '联系 A12345 处理'); await h.click({ av: 'fix-save', key: 'av1|i1' });
  assert.match(h.html(), /正确说法里有敏感词（工号），没有保存/);
  assert.match(h.html(), /data-fix-text="av1\|i1"[^>]*>联系 A12345 处理<\/textarea>/);
  h.page.destroy();
});

test('按分身隔离：甲的纠偏草稿不出现在乙；切回甲仍在', async () => {
  const h = harness();
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await fill(h, 'av1|i1', 'tone', '甲的说法');
  await h.click({ av: 'sel', id: 'av2' });
  assert.doesNotMatch(h.html(), /甲的说法/);
  assert.match(h.html(), /乙的旧稿/);
  await h.click({ av: 'sel', id: 'av1' });
  assert.match(h.html(), /甲的说法/);
  h.page.destroy();
});

test('它学到的：页签顺序 7 个；列出纠错卡与摘要；撤销调 avatar:correction-toggle 并刷新状态；切分身各读各的', async () => {
  const cards = { av1: [{ id: 'cor-1', version: 1, active: true, reason: 'fact', question: '甲的题', correctAnswer: '甲的口径', createdAt: 2 }], av2: [{ id: 'cor-1', version: 3, active: false, revokedAt: 5, reason: 'tone', question: '乙的题', correctAnswer: '乙的口径', createdAt: 1 }] };
  const h = harness({
    'avatar:corrections-list': p => ({ ok: true, cards: cards[p.avatarId], examplesCount: 7, persona: '先给结论', memoryLines: 120 }),
    'avatar:correction-toggle': p => { const c = cards[p.avatarId].find(x => x.id === p.cardId); c.active = p.active; c.revokedAt = p.active ? 0 : 9; return { ok: true, card: c, cards: cards[p.avatarId] }; } });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' });
  const tabs = [...h.html().matchAll(/data-av="tab" data-k="(\w+)">([^<]+)/g)].map(m => m[2]);
  assert.deepEqual(tabs, ['待确认', '试答', '它学到的', '运行记录', '生效范围', '上下文', '后端与前缀']);
  await h.click({ av: 'tab', k: 'learn' });
  let html = h.html();
  assert.match(html, /甲的口径/); assert.match(html, />生效中</); assert.match(html, /7 条/); assert.match(html, /120 条/); assert.match(html, /先给结论/);
  assert.match(html, /纠错卡只存公司本机该分身目录，默认不外发。/);
  await h.click({ av: 'learn-toggle', id: 'cor-1' });
  assert.deepEqual(h.of('avatar:correction-toggle')[0][1], { avatarId: 'av1', cardId: 'cor-1', active: false });
  assert.match(h.html(), />已撤销</); assert.match(h.html(), />恢复</);
  await h.click({ av: 'sel', id: 'av2' }); await h.click({ av: 'tab', k: 'learn' });
  html = h.html();
  assert.match(html, /乙的口径/); assert.doesNotMatch(html, /甲的口径/);
  await h.click({ av: 'learn-toggle', id: 'cor-1' });
  assert.deepEqual(h.of('avatar:correction-toggle')[1][1], { avatarId: 'av2', cardId: 'cor-1', active: true });
  h.page.destroy();
});

test('回复对象：「不是问我的」调 reassign-target not_for_me；没有候选时友好提示不调接口；有候选时点选走 retarget', async () => {
  const h = harness({ 'avatar:reassign-target': (p, st, status) => { if (p.action === 'not_for_me') st.items = st.items.filter(x => x.id !== p.itemId); return status(); } },
    st => { st.items[1].targetCandidates = [{ msgKey: 'k9', sender: '同事E', at: 2, text: '能发 PDF 吗？' }]; });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' });
  assert.match(h.html(), /改成回别的消息/); assert.match(h.html(), /不是问我的，忽略/);
  await h.click({ av: 'retarget-open', key: 'av1|i1' });
  assert.equal(h.of('avatar:reassign-target').length, 0);
  assert.match(h.html(), /同群近期没有别的提问可改选/);
  await h.click({ av: 'not-me', key: 'av1|i1' });
  assert.deepEqual(h.of('avatar:reassign-target')[0][1], { avatarId: 'av1', itemId: 'i1', action: 'not_for_me' });
  assert.match(h.html(), /不会发任何消息/);
  assert.equal(h.of('avatar:send').length, 0);
  await h.click({ av: 'sel', id: 'av2' }); await h.click({ av: 'retarget-open', key: 'av2|i2' });
  assert.match(h.html(), /能发 PDF 吗？/);
  await h.click({ av: 'retarget-pick', key: 'av2|i2', n: '0' });
  assert.deepEqual(h.of('avatar:reassign-target')[1][1], { avatarId: 'av2', itemId: 'i2', action: 'retarget', targetMsgKey: 'k9', targetText: '能发 PDF 吗？', targetSender: '同事E' });
  h.page.destroy();
});

test('群分身转交：有 pending 条目时在「全部待确认」顶部成组、标把握 / 承诺；纠正走本地闭环并注明不自动发群；没有条目时完全隐藏', async () => {
  const ext = [{ id: '20261126-q240', convName: 'AI HUB 用户群', askerName: '同事A', question: '怎么配置自定义模型？', answer: '低把握草稿', status: 'pending', basis: ['标准问答卡 C144'], confidence: 45, kind: 'draft', at: 3 },
    { id: '20261126-q241', convName: 'AI HUB 用户群', askerName: '同事B', question: '团队版什么时候能用？', answer: '', status: 'pending', kind: 'promise', at: 2 }];
  const h = harness({ 'avatar:correct-item': (p, st, status) => { st.externalItems = st.externalItems.filter(x => x.id !== p.itemId); return { ok: true, card: { id: 'cor-5' }, status: status() }; } }, st => { st.externalItems = ext; });
  h.page.open(); await settle();
  let html = h.html();
  assert.ok(html.indexOf('群分身转交<em>2</em>') > -1 && html.indexOf('群分身转交<em>2</em>') < html.indexOf('分身待确认'), '置顶成组');
  assert.match(html, /群分身低把握 · 把握 45/);
  assert.match(html, /承诺待回收/);
  assert.match(html, /不自动替群分身发群/);
  assert.doesNotMatch(html, /data-av="send"[^>]*data-key="ext\|/, '外部条目没有发送按钮');
  await fill(h, 'ext|20261126-q240', 'fact', '在设置 → 模型里新增');
  await h.click({ av: 'fix-save', key: 'ext|20261126-q240' });
  assert.deepEqual(h.of('avatar:correct-item')[0][1], { avatarId: 'av1', itemId: '20261126-q240', reason: 'fact', correctAnswer: '在设置 → 模型里新增', scope: 'this_avatar', redraft: true, external: true });
  assert.match(h.html(), /本地记录已纠正（纠错卡 #5），不自动替群分身发群/);
  h.page.destroy();
  // m4 联调点：外部条目纠正后主进程立即结案移除，新旧对照 / 重答失败面板仍留在原位，点「×」才移出。
  for (const mode of ['result', 'failure']) {
    const g = harness({ 'avatar:correct-item': (p, st, status) => { st.externalItems = st.externalItems.filter(x => x.id !== p.itemId); return { ok: true, card: { id: 'cor-6' }, status: status(),
      ...(mode === 'result' ? { redraftResult: { draft: '新口径：在设置 → 模型里新增', basis: [], confidence: 80 } } : { redraftFailure: { severity: 'error', headline: '模型没就绪', actions: [] } }) }; } },
    st => { st.externalItems = ext.map(x => ({ ...x, avatarId: 'av2' })); });
    g.page.open(); await settle();
    await fill(g, 'ext|20261126-q240', 'fact', '在设置 → 模型里新增'); await g.click({ av: 'fix-save', key: 'ext|20261126-q240' });
    assert.equal(g.of('avatar:correct-item')[0][1].avatarId, 'av2', '用主进程给的 avatarId');
    const html = g.html();
    assert.match(html, mode === 'result' ? /data-cmp="new">新口径：在设置 → 模型里新增</ : /纠错卡已保存在本机，重答暂未成功/);
    assert.match(html, /data-cmp="old">低把握草稿<|模型没就绪/);
    assert.match(html, /已纠错/);
    assert.doesNotMatch(html, /data-av="fix-adopt"/, '外部条目不提供采用新稿');
    await g.click({ av: 'fix-close', key: 'ext|20261126-q240' });
    assert.doesNotMatch(g.html(), /怎么配置自定义模型/);
    g.page.destroy();
  }
  const plain = harness();
  plain.page.open(); await settle();
  assert.doesNotMatch(plain.html(), /群分身转交|avx-grp/);
  plain.page.destroy();
});

test('一键反馈：有选中问答时先取脱敏现场并预填；通道不在时回落原 3 行模板', async () => {
  const h = harness({ 'avatar:feedback-context': () => ({ ok: true, text: '版本 5.6.115 · 当前问答：同事A 问「小队模式」' }) });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'feedback' });
  assert.deepEqual(h.of('avatar:feedback-context')[0][1], { avatarId: 'av1', itemId: 'i1' });
  assert.match(h.fb[0].description, /以下是自动附上的现场（已隐去姓名、工号、手机号和密钥，可删改）/);
  assert.match(h.fb[0].description, /当前问答：同事A 问「小队模式」/);
  h.page.destroy();
  const old = harness({ 'avatar:feedback-context': () => { throw new Error("No handler registered for 'avatar:feedback-context'"); } });
  old.page.open(); await settle();
  await old.click({ av: 'feedback' });
  assert.equal(old.fb[0].description, '【分身 Beta 反馈】\n我在用的模板：\n遇到的问题或建议：');
  old.page.destroy();
});

test('XSS：纠错卡、外部条目、候选消息、重写稿里的标签一律转义', async () => {
  const bad = '<img src=x onerror=alert(1)>';
  const h = harness({
    'avatar:corrections-list': () => ({ ok: true, cards: [{ id: 'cor-1"><b', version: 1, active: true, reason: 'fact', question: bad, correctAnswer: bad, convName: bad, oldAnswer: bad }], persona: bad, examplesCount: 1, memoryLines: 1 }),
    'avatar:correct-item': (p, st, status) => ({ ok: true, card: { id: 'cor-9' }, status: status(), redraftResult: { draft: bad, basis: [bad], why: bad } }) },
  st => { st.externalItems = [{ id: 'x<script>', askerName: bad, question: bad, answer: bad, convName: bad, status: 'pending', kind: 'draft', confidence: 10 }]; st.items[0].targetCandidates = [{ msgKey: 'k', sender: bad, text: bad }]; });
  h.page.open(); await settle();
  assert.doesNotMatch(h.html(), /<img|<script/);
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'retarget-open', key: 'av1|i1' });
  assert.doesNotMatch(h.html(), /<img/);
  await fill(h, 'av1|i1', 'fact', bad);
  assert.doesNotMatch(h.html(), /<img/);
  await h.click({ av: 'fix-save', key: 'av1|i1' });
  assert.doesNotMatch(h.html(), /<img/);
  await h.click({ av: 'tab', k: 'learn' });
  assert.doesNotMatch(h.html(), /<img|cor-1"><b/);
  assert.match(h.html(), /&lt;img src=x onerror=alert\(1\)&gt;/);
  h.page.destroy();
});
