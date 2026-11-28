'use strict';
// 相邻连续的程序消息合并成一组（来源 3dea7fba、bd8ba8a0）：团队消息、组队开工、返工叫回这些折叠卡片
// 连续出现时只显示一行「N 条 · 最新一句结论」，点开后每条原文按原顺序完整展开。
// - 中间夹着用户的话或 Agent 的正常回复就断开；「无新进展」回复（no-update）和被「简洁」藏掉的卡片不算对话，不打断。
// - 不改卡片本身：卡片仍是容器的直接子节点，只在组首卡里插一条组摘要、给组员加隐藏标记，
//   这样按编号查卡、原位更新、问题目录、跟随滚动、远处卡片跳过布局（card-content-skip）都不受影响。每次重算前先清掉旧标记，可重复执行。
// - 组的展开状态按「会话 + 组首卡编号」记在内存里，整张重画后照旧；重算前后按视口里第一张可见卡片校正滚动，位置不跳。
// 种类只认本仓库 team-notice-identity 已有的 notice / kickoff；新增种类时在 LABELS 里补名字。
const LABELS = { notice: '团队消息', kickoff: '组队消息' };
const MIXED_LABEL = '团队消息';
const expanded = new Map();
function disclosureChoice(details) { try { return require('./message-disclosure-state').choice(details); } catch { return undefined; } }
const HEAD = 'notice-group-head', MEMBER = 'notice-group-member', BAR = 'notice-group-bar';

function groupKey(card) { return JSON.stringify([card.dataset.sessionId || '', card.dataset.turnId || '']); }
// 「简洁」藏哪些卡片，写在它那张规则表第一条的选择器里（renderer/concise-view.js）。
// 用 matches 判断：只读 class，不写页面、不触发样式计算，流式输出时每个增量都重算也不卡。
function conciseHiddenSelector(doc) {
  try { return doc?.getElementById?.('concise-view-rules')?.sheet?.cssRules?.[0]?.selectorText || ''; } catch { return ''; }
}
// 卡片在分组里的角色：'fold'（可合并的折叠卡）、'skip'（不打断）、'break'（正常对话，断开）。
function roleOf(card, hiddenSel) {
  if (card.classList.contains('no-update')) return 'skip';
  if (card.dataset.noticeKind) { try { if (hiddenSel && card.matches(hiddenSel)) return 'skip'; } catch {} return 'fold'; }
  return 'break';
}
// 摘要里去掉 📌 和加粗记号（团队消息的一行摘要直接取正文首行，可能带 Markdown）。
function clip(s, n) { const v = String(s || '').replace(/📌\s*/gu, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n) + '…' : v; }

// 一句话概括：「N 条会话消息 · 「A」×2、「B」 · 最新：<最后一条的一句话>」。
function summarize(cards) {
  // 组里只有一种时用它自己的名字；混着几种时统称「团队消息」。
  const kinds = new Set(cards.map(c => c.dataset.noticeKind));
  const kind = cards[0].dataset.noticeKind;
  const label = kinds.size === 1 ? (LABELS[kind] || '程序消息') : MIXED_LABEL;
  const counts = new Map();
  for (const card of cards) { const from = card.dataset.noticeFrom || ''; if (from) counts.set(from, (counts.get(from) || 0) + 1); }
  // 名字截短时保留书名号：「很长的会话标题…」×2。
  const short = from => { const m = from.match(/^「([\s\S]*)」$/); return m ? '「' + clip(m[1], 10) + '」' : clip(from, 12); };
  const senders = [...counts].map(([from, n]) => short(from) + (n > 1 ? '×' + n : '')).join('、');
  const prefix = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*·\\s*');
  // 混合组里保留最新一条自带的「组队开工：」这类前缀，读得出它是哪种。
  const lastLine = String(cards[cards.length - 1].dataset.noticeLine || '');
  const last = kinds.size === 1 ? lastLine.replace(prefix, '') : lastLine;
  const showSenders = !!senders && [...counts.keys()].some(from => from !== 'Hub');
  // 一行里先放「最新那条说了什么」：发送方多时只写几方，完整名单放悬停提示，免得把结论挤到省略号后面。
  const lastFrom = cards[cards.length - 1].dataset.noticeFrom || '';
  const who = !showSenders ? '' : counts.size === 1 ? `（${short([...counts.keys()][0])}）` : `（${counts.size} 方）`;
  const lastWho = showSenders && counts.size > 1 && lastFrom && lastFrom !== 'Hub' ? ' ' + short(lastFrom) : '';
  return { count: cards.length, label, senders: showSenders ? senders : '',
    text: `${cards.length} 条${/^[A-Za-z]/.test(label) ? ' ' : ''}${label}${who}` + (last ? ` · 最新${lastWho}：` + clip(last, 120) : '') };
}

function clear(container) {
  for (const el of container.querySelectorAll(':scope > .turn-card .' + BAR)) el.remove();
  for (const el of container.querySelectorAll(':scope > .' + HEAD + ', :scope > .' + MEMBER)) {
    el.classList.remove(HEAD, MEMBER, 'notice-group-open', 'notice-group-skip');
    delete el.dataset.noticeGroup;
  }
}

function collectRuns(container, hiddenSel) {
  const runs = [];
  let run = null;
  const close = () => { if (run && run.folds.length > 1) runs.push(run); run = null; };
  for (const card of container.querySelectorAll(':scope > .turn-card')) {
    const role = roleOf(card, hiddenSel);
    if (role === 'break') { close(); continue; }
    if (role === 'skip') { if (run) run.between.push(card); continue; }
    // 同类 = 所有程序发来的折叠消息（团队消息、组队开工、返工叫回），不再按细分种类切开，只看是否相邻。
    const same = run && run.sid === (card.dataset.sessionId || '');
    if (!same) { close(); run = { kind: card.dataset.noticeKind, sid: card.dataset.sessionId || '', folds: [], between: [] }; }
    // 组内夹着的「无新进展」等卡片只有落在两条组员之间才归组；组尾之后的留在原处。
    run.folds.push(card);
    run.skips = (run.skips || []).concat(run.between); run.between = [];
  }
  close();
  return runs;
}

// 锚点 = 视口里第一张「分组后仍然可见」的卡片（会被收进组里的卡片不能当锚点，它马上就消失了）。
function firstVisibleAnchor(container, willHide = new Set()) {
  const top = container.getBoundingClientRect ? container.getBoundingClientRect().top : 0;
  for (const card of container.querySelectorAll(':scope > .turn-card')) {
    if (willHide.has(card)) continue;
    const r = card.getBoundingClientRect();
    if (r.height > 0 && r.bottom > top) return { card, offset: r.top - top };
  }
  return null;
}

function apply(container, { doc = container.ownerDocument, win = doc?.defaultView || globalThis, escapeHtml = s => String(s) } = {}) {
  if (!container || !container.querySelectorAll) return 0;
  // 先只读不写：分组结果和展开状态都没变、标记也都还在，就什么都不动（流式输出每个增量都会走到这里）。
  const hiddenSel = conciseHiddenSelector(doc);
  const planned = collectRuns(container, hiddenSel);
  // 签名覆盖每个组员的编号、发送方和摘要：任何一条更新了，组摘要（几方、名单、最新一句）都会重算。
  const sig = planned.map(run => [groupKey(run.folds[0]), expanded.get(groupKey(run.folds[0])) === true, (run.skips || []).length,
    ...run.folds.map(c => [c.dataset.turnId, c.dataset.noticeFrom, c.dataset.noticeLine].join('\u0001'))].join('\u0002')).join('\n');
  const intact = planned.every(run => run.folds[0].classList.contains(HEAD) && run.folds[0].querySelector('.' + BAR)
    && run.folds.slice(1).concat(run.skips || []).every(card => card.classList.contains(MEMBER)));
  if (sig === container.__noticeGroupSig && intact && container.querySelectorAll(':scope > .' + HEAD).length === planned.length) return planned.length;
  container.__noticeGroupSig = sig;
  const willHide = new Set();
  for (const run of planned) if (expanded.get(groupKey(run.folds[0])) !== true) for (const card of run.folds.slice(1).concat(run.skips || [])) willHide.add(card);
  const anchor = firstVisibleAnchor(container, willHide);
  clear(container);
  const runs = collectRuns(container, hiddenSel);
  for (const run of runs) {
    const head = run.folds[0], key = groupKey(head), open = expanded.get(key) === true;
    const { count, text, senders } = summarize(run.folds);
    head.classList.add(HEAD); head.dataset.noticeGroup = String(count);
    head.classList.toggle('notice-group-open', open);
    const bar = doc.createElement('div');
    bar.className = BAR; bar.setAttribute('role', 'button'); bar.tabIndex = 0;
    bar.title = (senders ? `来自：${senders}\n` : '') + (open ? '点击收起这一组' : `点击展开这 ${count} 条原文`);
    // 组摘要里是消息原文的一句话，和卡片正文一样不进英文翻译（data-i18n-skip）。
    bar.innerHTML = `<span class="notice-group-caret">${open ? '▾' : '▸'}</span><span class="notice-group-text" data-i18n-skip>${escapeHtml(text)}</span>`;
    // 组摘要紧跟在卡片头（头像、发送方 → 接收方、时间）后面，收起时顶替这张卡自己的一行摘要。
    const headLine = head.querySelector('.turn-content > .turn-head');
    if (headLine) headLine.after(bar); else (head.querySelector('.turn-content') || head).prepend(bar);
    for (const card of run.folds.slice(1).concat(run.skips || [])) {
      card.classList.add(MEMBER); card.dataset.noticeGroup = key;
      if (run.skips && run.skips.includes(card)) card.classList.add('notice-group-skip');
    }
    // 展开组：每条原文默认摊开，但手动收起过的那条保持收起（单条选择由 message-disclosure-state 记着）。
    // 收起组时不动单条状态；组首这一行的排版由 CSS 固定成一行。
    if (open) for (const card of run.folds) {
      const d = card.querySelector('details.team-notice-fold');
      if (d) { const chosen = disclosureChoice(d); d.open = chosen === undefined ? true : chosen; }
    }
    for (const card of [head, ...run.folds.slice(1), ...(run.skips || [])]) card.classList.toggle('notice-group-open', open);
  }
  if (anchor && anchor.card.isConnected) {
    const delta = anchor.card.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) container.scrollTop += delta;
  }
  return runs.length;
}

function toggle(bar, opts = {}) {
  const head = bar.closest('.' + HEAD);
  const container = head?.parentElement;
  if (!head || !container) return;
  const key = groupKey(head);
  expanded.set(key, !(expanded.get(key) === true));
  const top = bar.getBoundingClientRect().top;
  apply(container, opts);
  // 点的是组摘要这一行：展开/收起后这一行留在原位，下面的内容往下长，不把视线带走。
  // 按摘要行本身校正（展开时组首卡改成上下排列，摘要行在卡内会下移一行，只按卡片顶部校正不够）。
  const nextBar = head.querySelector('.' + BAR) || head;
  const shift = nextBar.getBoundingClientRect().top - top;
  if (Math.abs(shift) > 1) container.scrollTop += shift;
}

function createNoticeGrouper({ doc, win = doc?.defaultView || globalThis, escapeHtml = s => String(s) } = {}) {
  const pending = new Set();
  let queued = false;
  function flush() {
    queued = false;
    const list = [...pending]; pending.clear();
    for (const c of list) if (c.isConnected !== false) { try { apply(c, { doc, win, escapeHtml }); } catch (error) { console.warn('[notice-groups] apply failed:', error && error.message); } }
    // 「简洁」按钮只在有团队消息的会话里出现：卡片挂完后让它再判断一次（renderer/concise-view.js）。
    try { win.__conciseView?.refresh?.(); } catch {}
  }
  // 微任务里批量重算：同一轮里挂上的几十张卡只算一次，且在浏览器绘制前完成，不闪。
  function schedule(container) {
    if (!container) return;
    pending.add(container);
    if (!queued) { queued = true; (win.queueMicrotask || (fn => Promise.resolve().then(fn)))(flush); }
  }
  if (doc && !doc.__noticeGroupsBound) {
    doc.__noticeGroupsBound = true;
    const onActivate = event => {
      const bar = event.target.closest?.('.' + BAR);
      if (!bar) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      // 不拦截冒泡：跟随滚动控制器要靠这次点击暂停「自动跟到底部」。
      event.preventDefault();
      toggle(bar, { doc, win, escapeHtml });
    };
    doc.addEventListener('click', onActivate, true);
    doc.addEventListener('keydown', onActivate, true);
    // 「简洁」开关切换后，哪些卡片可见变了，重算一遍分组。
    doc.addEventListener('hub:concise-changed', () => { for (const c of doc.querySelectorAll('.msg-overlay')) schedule(c); });
  }
  return { schedule, apply: container => apply(container, { doc, win, escapeHtml }) };
}

module.exports = { createNoticeGrouper, apply, summarize, LABELS, _expanded: expanded };
