'use strict';
// 「分身」页（Beta，接替原「替身」页）：左边分身列表，右边待确认、运行记录、生效范围、上下文、后端与前缀，每个页签一屏。
// 页面只经 avatar:* 接口读状态和发操作；发送只有「本人点发送」这一条路，收信方由主进程从事项记录里取。

const TEMPLATES = [
  ['watch', '帮我盯消息', '谁在等你、哪条重要，及时提醒。不替你发任何消息。', '全部会话 · 只提醒'],
  ['draft', '帮我起草回复', '私聊和群里 @我 的消息先写好草稿，你点了才发。', '私聊和 @我 · 起草'],
  ['qa', '群答疑助手', '学习群里的历史问答，帮你答重复的问题，你确认后发出。', '选定的群 · 起草'],
  ['blank', '空白分身', '从零开始，每一项都由你来定。', '全部自选'],
];
const ACT = { watch: '只看', remind: '提醒', draft: '起草' };
const KINDS = [['all', '全部会话'], ['groups', '全部群'], ['dm', '全部私聊'], ['pick', '指定群或人']];
const LOG = { draft: ['起草', 'w'], remind: ['提醒', 'b'], skip: ['跳过', ''], sent: ['已发送', 'g'], answered: ['已有人回', ''], dropped: ['已丢弃', ''], done: ['已处理', ''], recalled: ['已撤回', ''], moved: ['已转走', ''] };
const LOG_FILTER = { all: () => true, you: r => ['draft', 'remind'].includes(r.act), sent: r => ['sent', 'recalled'].includes(r.act), skip: r => ['skip', 'answered', 'dropped', 'done', 'moved'].includes(r.act) };
const EFFORT = [['', '默认'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高']];
const COMMIT_HINT = /今天|明天|今晚|马上|我来|没问题|保证|一定/;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function when(at) {
  if (!at) return '';
  const d = new Date(at), now = new Date(), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
function waited(since, now = Date.now()) {
  const m = Math.max(0, Math.round((now - since) / 60000));
  return m < 60 ? `等了 ${m} 分钟` : m < 1440 ? `等了 ${Math.floor(m / 60)} 小时` : `等了 ${Math.floor(m / 1440)} 天`;
}
// 一页放不下就翻页，不出滚动条。
function paginate(list, page, size) {
  const pages = Math.max(1, Math.ceil(list.length / size)), at = Math.min(Math.max(0, page), pages - 1);
  return { rows: list.slice(at * size, at * size + size), at, pages };
}
function scopeText(a) {
  if (a.kind === 'all') return a.atOnly ? '私聊和群里 @我' : '全部会话';
  if (a.kind === 'groups') return a.atOnly ? '群里 @我' : '全部群';
  if (a.kind === 'dm') return '全部私聊';
  const names = (a.targets || []).map(t => t.name);
  return names.length ? names.slice(0, 2).join('、') + (names.length > 2 ? ` 等 ${names.length} 个` : '') : '还没选目标';
}
function modeText(a) {
  if (a.kind !== 'pick') return ACT[a.action] || '提醒';
  return ACT[['draft', 'remind', 'watch'].find(k => (a.targets || []).some(t => t.action === k))] || ACT[a.action];
}
function scopeSummary(a) {
  if (a.kind !== 'pick') {
    const who = a.only?.length ? `只听 ${a.only.map(x => x.name).join('、')}` : '听所有人';
    const what = { watch: '只记录不打扰', remind: '重要的消息提醒你', draft: '写好草稿等你确认' }[a.action];
    return `在${scopeText(a)}里，${who}，${what}。${a.skip?.length ? `不看：${a.skip.map(x => x.name).join('、')}。` : ''}`;
  }
  if (!a.targets?.length) return '还没有选择目标，这个分身暂时不处理任何消息。';
  return `${a.targets.map(t => `${t.name}（${ACT[t.action]}）`).join('、')}。上级的消息最多起草，所有消息都由你点了才发。`;
}

function createAvatarPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage = () => {}, selectSession = () => {} }) {
  let page, root, data = null, targets = null, sel = 'all', tab = 'inbox', error = '', busy = '', wiz = null, confirmBox = null, notice = null, logFilter = 'all', logPage = 0, logPick = -1, noticeTimer = null;
  const itemSel = {}, edits = {}, ack = {};
  const isOpen = () => !!page && !page.hidden;
  const avatar = id => data?.avatars?.find(a => a.id === id);
  const cur = () => avatar(sel);
  const keyOf = it => `${it.avatarId}|${it.id}`;
  async function call(op, payload = {}) {
    const result = await ipcRenderer.invoke('avatar:' + op, payload);
    if (!result || (result.ok === false && !result.needAck)) throw new Error(result?.error || '没有收到结果，请重试');
    return result;
  }
  const accept = next => { if (next && next.available !== undefined) { data = next; if (sel !== 'all' && !avatar(sel)) { sel = 'all'; tab = 'inbox'; } } };
  const typing = () => { const el = document.activeElement; return !!el && page?.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox'; };
  // 后台刷新不清掉操作报错（发送失败的提示要留到下一次操作）。
  async function load({ soft = false } = {}) { try { accept(await call('status')); if (!soft) error = ''; } catch (e) { error = e.message; } if (!(soft && typing())) render(); }
  // 群/人名单：读不到时带原因（没登录、助理还没取到会话、取数出错）；向导或「范围」页开着且还没读到时每 5 秒再读一次，最多 3 分钟。
  // R34（2026-11-24）：读过的名单先显示（主进程按账号缓存，stale = 当天快照还没出来、显示的是上次的），后台继续刷新；
  // 正在读时写「正在读取…」，超时或出错写原因并给「重试」。
  // targetsSeq：每次读取自增，过期的返回（切页签、点重试后旧请求才回来）直接丢掉，不覆盖新状态。
  let targetsTimer = null, targetsTries = 0, targetsLoading = false, targetsFailed = '', targetsSeq = 0;
  const stopTargets = () => { clearTimeout(targetsTimer); targetsTimer = null; targetsSeq++; targetsLoading = false; };
  const TARGETS_TIMEOUT_MS = 20000;
  async function loadTargets(retry = false) {
    clearTimeout(targetsTimer); targetsTimer = null;
    const seq = ++targetsSeq;
    if (!retry) targetsTries = 0;
    targetsLoading = true;
    if (!retry) render();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`读取超时（${TARGETS_TIMEOUT_MS / 1000} 秒没有结果）`)), TARGETS_TIMEOUT_MS); });
      const next = await Promise.race([call('targets'), timeout]);
      if (seq !== targetsSeq) return;
      targets = next; targetsFailed = '';
    } catch (e) {
      if (seq !== targetsSeq) return;
      targetsFailed = e.message || '读群列表出错';
      targets = { groups: targets?.groups || [], people: targets?.people || [], ready: !!(targets?.groups?.length || targets?.people?.length), stale: !!targets?.groups?.length || !!targets?.people?.length, at: targets?.at || 0, reason: targetsFailed };
    } finally { clearTimeout(timer); if (seq === targetsSeq) targetsLoading = false; }
    if (!page || page.hidden) return;
    render();
    const waiting = !!page && !page.hidden && (wiz?.step === 2 || ['scope', 'ctx'].includes(tab)) && (!(targets?.groups || []).length || targets?.stale);
    if (waiting && targetsTries < 36) { targetsTries++; targetsTimer = setTimeout(() => void loadTargets(true), 5000); }
  }
  const noGroupsText = () => (targetsFailed ? `没读到群：${targetsFailed}` : targets?.reason ? targets.reason : targets ? '还没读到群，正在自动刷新' : '正在读取…') + (targetsTries >= 36 ? '（3 分钟还没读到：到左侧「助理」页看 WeLink 是否在更新）' : '');
  const hhmm = at => { const d = new Date(at); return Number.isFinite(d.getTime()) && at ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '上次'; };
  // 名单上方的一行状态：正在读取 / 先显示上次的、后台刷新中 / 没读到的原因 + 重试。
  function targetsBar() {
    const retry = targetsLoading ? '' : '<button class="avx-btn s" data-av="targets-retry">重试</button>';
    if (!targets && targetsLoading) return '<p class="avx-m">正在读取…</p>';
    // 主进程带回的原因只要不是「还在等助理取数」（没登录、读出错）就照实写；轮询 3 分钟停了也说清楚，不再一直写「正在后台刷新」。
    const failed = targetsFailed || (targets?.stale && targets.reasonKind && targets.reasonKind !== 'waiting' ? targets.reason : '');
    if (targets?.stale) return `<p class="avx-m">先显示 ${esc(hhmm(targets.at))} 读到的名单，${failed ? `刷新没成功：${esc(failed)}` : !targetsLoading && !targetsTimer && targetsTries >= 36 ? '3 分钟还没刷新出来：到左侧「助理」页看 WeLink 是否在更新' : '正在后台刷新'}${targetsLoading ? '…' : ''} ${retry}</p>`;
    if (!(targets?.groups || []).length && !(targets?.people || []).length && (targetsFailed || targets?.reason)) return `<p class="avx-m">${esc(noGroupsText())} ${retry}</p>`;
    return '';
  }
  async function run(label, op, payload) {
    busy = label; error = ''; render();
    try { const r = await call(op, payload); accept(r); return r; } catch (e) { error = e.message; return null; } finally { busy = ''; render(); }
  }
  const save = patch => run('正在保存', 'update', { avatarId: sel, patch });
  async function setGateway(choice, done = '') {
    busy = '正在保存'; error = ''; render();
    try {
      const r = await ipcRenderer.invoke('feature-agents:set', { feature: 'avatar', choice });
      if (!r || r.ok === false) throw new Error(r?.error || '没有保存成功');
      accept(await call('status'));
      if (done) flash(done);
      return true;
    } catch (e) { error = e.message; return false; } finally { busy = ''; render(); }
  }
  const flash = (text, action = null) => { notice = { text, action }; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = null; if (isOpen() && !typing()) render(); }, action ? 12000 : 4000); noticeTimer.unref?.(); };

  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'avatar-page'; page.className = 'avatar-page'; page.hidden = true; page.setAttribute('aria-label', '分身');
    page.innerHTML = '<div class="avx-root"></div>'; root = page.firstChild; document.body.append(page);
    page.addEventListener('click', event => { const b = event.target.closest('[data-av]'); if (b && !b.disabled) void act(b, event).catch(e => { error = e.message; render(); }); });
    page.addEventListener('input', onInput);
    page.addEventListener('change', event => { void onChange(event).catch(e => { error = e.message; render(); }); });
    window.addEventListener('resize', place);
    // 其他全屏页各有各的打开路径，不一定都会来关这一页：看到别的页打开就自己让开。
    if (window.MutationObserver) new window.MutationObserver(() => {
      if (isOpen() && [...document.body.classList].some(c => c !== 'avatar-page-open' && /-page-open$/.test(c))) close();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  function place() {
    if (!isOpen()) return;
    const rail = document.getElementById('scene-rail'), toolbar = document.getElementById('app-toolbar');
    const left = rail && rail.getBoundingClientRect().width > 0 ? rail.getBoundingClientRect().right : 0;
    const top = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const bodyRect = document.getElementById('app-body')?.getBoundingClientRect();
    const bottom = bodyRect?.height > 0 ? Math.max(0, window.innerHeight - bodyRect.bottom) : 0;
    Object.assign(page.style, { left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`, bottom: `${bottom}px` });
  }

  // ---- 画面 ----
  function render() {
    if (!root) return;
    const keep = {}; root.querySelectorAll('[data-sc]').forEach(e => { keep[e.dataset.sc] = e.scrollTop; });
    root.innerHTML = head() + banners() + main() + (wiz ? wizard() : '') + (confirmBox ? confirmDialog() : '');
    root.querySelectorAll('[data-sc]').forEach(e => { if (keep[e.dataset.sc]) e.scrollTop = keep[e.dataset.sc]; });
  }
  function head() {
    const on = data?.avatars?.filter(a => a.state.code === 'on').length || 0, ready = data?.available;
    return `<header class="avx-head"><div><h1>分身<span class="avx-beta">Beta</span></h1><p>替你盯消息、写回复，所有消息都由你点了才发</p></div><div class="avx-right">
      ${ready ? (data.login.ok ? '<span class="avx-ch g"><i class="avx-dot g"></i>WeLink 在线</span>' : '<span class="avx-ch w"><i class="avx-dot w"></i>WeLink 未连接</span>') : ''}
      ${data?.avatars?.length ? `<span class="avx-ch">${on} 个运行中${data.snapAt ? ` · 消息 ${when(data.snapAt)} 更新` : ''}</span>` : ''}
      <button class="avx-btn" data-av="feedback">反馈意见</button>
      ${data?.avatars?.length ? `<button class="avx-btn ${data.paused ? 'p' : 'd'}" data-av="pause-all">${data.paused ? '恢复全部' : '全部暂停'}</button>` : ''}
      ${ready ? '<button class="avx-btn p" data-av="new">新建分身</button>' : ''}</div></header>`;
  }
  function banners() {
    const out = [];
    if (error) out.push(`<div class="avx-bn r">${esc(error)}</div>`);
    if (notice) out.push(`<div class="avx-bn b">${esc(notice.text)}${notice.action ? `<button class="avx-btn s" data-av="${notice.action.op}" data-a="${esc(notice.action.a)}" data-i="${esc(notice.action.i)}">${esc(notice.action.label)}</button>` : ''}</div>`);
    if (!data?.available) return out.join('');
    if (data.paused) out.push('<div class="avx-bn r"><b>全部分身已暂停。</b>不读取新消息，不起草，也不能发送。已写好的草稿还在。</div>');
    else if (!data.login.ok) out.push(`<div class="avx-bn w"><b>WeLink 没有连接。</b>${esc(data.login.reason)}。重新登录后分身自动接上。<button class="avx-btn s" data-av="relogin">重新检查</button></div>`);
    else if (data.readError) out.push(`<div class="avx-bn w">${esc(data.readError)}</div>`);
    return out.join('');
  }
  function main() {
    if (!data) return '<div class="avx-empty"><p>正在读取…</p></div>';
    if (!data.available) return `<div class="avx-empty"><h2>分身暂时用不了</h2><p>${esc(data.reason)}</p><button class="avx-btn" data-av="relogin">重新检查</button></div>`;
    if (!data.avatars.length) return `<div class="avx-empty"><h2>让第一个分身替你盯消息</h2><p>WeLink 账号和 CodeAgent 账号都已自动找到，不用填任何东西。</p><div class="avx-tpls">${TEMPLATES.map(tplCard).join('')}</div></div>`;
    return `<div class="avx-main">${list()}${detail()}</div>`;
  }
  const tplCard = ([k, n, d, m]) => `<button class="avx-tpl" data-av="tpl" data-t="${k}"><b>${n}</b><span>${d}</span><small>${m}</small></button>`;
  function list() {
    const total = data.items.length;
    return `<aside class="avx-list" aria-label="分身列表"><button class="avx-row ${sel === 'all' ? 'on' : ''}" data-av="sel" data-id="all"><div class="n"><span>全部待确认</span>${total ? `<b>${total}</b>` : ''}</div><small>所有分身交给你的事</small></button><hr>
      <div class="avx-rows" data-sc="av">${data.avatars.map(a => `<button class="avx-row ${sel === a.id ? 'on' : ''}" data-av="sel" data-id="${esc(a.id)}"><div class="n"><i class="avx-dot ${dotOf(a)}" title="${esc(a.state.text)}"></i><span>${esc(a.name)}</span>${a.pending ? `<b>${a.pending}</b>` : ''}</div><small>${esc(scopeText(a))}</small><small>${esc(modeText(a))} · 今日处理 ${a.stats.model} 条</small></button>`).join('')}</div>
      <p class="avx-foot">每个分身是一个独立会话，在左侧「后台任务」里也能看到。</p></aside>`;
  }
  const dotOf = a => ({ on: 'g', waiting: 'w', error: 'r', paused: 'r' }[a.state.code] || '');
  function detail() {
    if (sel === 'all') return `<section class="avx-detail"><div class="avx-dh line"><h2>全部待确认</h2><span class="avx-ch">${data.items.length} 条</span></div><div class="avx-body">${inbox(null)}</div></section>`;
    const a = cur(), tabs = [['inbox', '待确认'], ['log', '运行记录'], ['scope', '生效范围'], ['ctx', '上下文'], ['back', '后端与前缀']];
    const body = { inbox: () => inbox(a), log: () => logs(a), scope: () => scope(a), ctx: () => context(a), back: () => backend(a) }[tab]();
    return `<section class="avx-detail"><div class="avx-dh"><h2>${esc(a.name)}</h2><span class="avx-ch ${{ on: 'g', error: 'r', paused: 'r', waiting: 'w' }[a.state.code] || ''}">${esc(a.state.text)}</span><span class="avx-ch b">${esc(modeText(a))}</span>
      <div class="avx-right"><button class="avx-btn s" data-av="open-session">打开会话</button><button class="avx-btn s" data-av="toggle">${a.enabled ? '暂停这个分身' : '恢复'}</button><button class="avx-btn s d" data-av="remove">删除</button></div></div>
      ${a.state.error ? `<div class="avx-bn r slim">${esc(a.state.error)}${a.state.providerRepair ? a.state.providerRepair.canUseManual ? `<button class="avx-btn s" data-av="repair-provider" data-account="${esc(a.state.providerRepair.account)}">改用手动会话在用的供应商</button>` : '<button class="avx-btn s" data-av="provider-settings">选择模型与供应商</button>' : ''}</div>` : ''}
      <nav class="avx-tabs">${tabs.map(([k, n]) => `<button class="${tab === k ? 'on' : ''}" data-av="tab" data-k="${k}">${n}${k === 'inbox' && a.pending ? `<em>${a.pending}</em>` : ''}</button>`).join('')}</nav><div class="avx-body ${tab === 'log' ? 'col' : ''}">${body}</div></section>`;
  }
  function inbox(a) {
    const rows = data.items.filter(i => !a || i.avatarId === a.id), scopeKey = a?.id || 'all';
    if (!rows.length) return `<div class="avx-empty"><h2>没有待确认的消息</h2><p>${a?.working ? `分身正在处理 ${a.working} 条，好了会出现在这里。` : '新的草稿和提醒会出现在这里。'}</p></div>`;
    const it = rows.find(r => keyOf(r) === itemSel[scopeKey]) || rows[0]; itemSel[scopeKey] = keyOf(it);
    const key = keyOf(it), text = edits[key] ?? it.draft ?? '', leader = (it.flags || []).some(f => f === 'leader' || f === 'leader-present'), remind = it.state === 'remind';
    return `<div class="avx-split"><div class="avx-card ls" data-sc="il">${rows.map(r => `<button class="avx-it ${keyOf(r) === key ? 'on' : ''}" data-av="item" data-k="${esc(scopeKey)}" data-id="${esc(keyOf(r))}"><b>${esc(r.who)}${(r.flags || []).includes('leader') ? '<span class="avx-ch r">上级</span>' : ''}<em>${when(r.at)}</em></b><span>${esc(r.text)}</span><small>${esc(r.avatarName)} · ${r.state === 'remind' ? '提醒' : '起草'} · ${waited(r.since || r.at)}</small></button>`).join('')}</div>
      <div class="avx-card scroll"><div class="avx-line"><h3>${esc(it.who)}</h3><span class="avx-m">${esc(it.group ? it.convName : '私聊')} · ${when(it.at)} · 来自「${esc(it.avatarName)}」</span>${(it.flags || []).includes('leader') ? '<span class="avx-ch r">回上级</span>' : (it.flags || []).includes('leader-present') ? '<span class="avx-ch r">群里有上级</span>' : ''}${it.confidence ? `<span class="avx-ch">把握 ${it.confidence}</span>` : ''}</div>
      <div class="avx-q">${esc(it.text)}</div>${it.why ? `<p class="avx-m"><b>为什么交给你：</b>${esc(it.why)}</p>` : ''}${it.basis ? `<p class="avx-m"><b>依据：</b>${esc(it.basis)}</p>` : ''}
      ${remind ? `<div class="avx-line act"><button class="avx-btn p" data-av="done" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">知道了</button><button class="avx-btn" data-av="redraft" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">让分身起草一条</button><button class="avx-btn" data-av="drop" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">不用管</button></div>` : `
      <label class="avx-lb" for="avx-draft">草稿，可以直接改</label><textarea id="avx-draft" class="avx-ta" rows="5" data-edit="${esc(key)}">${esc(text)}</textarea>
      <p class="avx-m r" id="avx-risk">${leader && COMMIT_HINT.test(text) ? '这句话可能在向上级应承一件事，请确认后再发。' : ''}</p>
      <div class="avx-line act"><button class="avx-btn ${ack[key] ? 'dd' : 'p'}" data-av="send" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}" data-key="${esc(key)}" ${busy ? 'disabled' : ''}>${ack[key] ? '确认发送' : busy === '正在发送' ? '正在发送…' : '发送'}</button><button class="avx-btn" data-av="redraft" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">让分身重写</button><button class="avx-btn" data-av="remind-only" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">改成只提醒</button><button class="avx-btn" data-av="drop" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">丢弃</button><span class="avx-m">${it.prefixed ? `发出时带「🤖【${esc(it.prefix)}】」` : '以你本人名义发出，不带前缀'}</span></div>`}</div></div>`;
  }
  function logs(a) {
    const rows = a.log.filter(LOG_FILTER[logFilter]), { rows: view, at, pages } = paginate(rows, logPage, 9), s = a.stats, picked = a.log[logPick];
    return `<div class="avx-mt"><div><b>${s.read.toLocaleString()}</b><span>今日归它的消息</span></div><div><b>${s.model}</b><span>交给模型判断</span></div><div><b>${s.ready + s.remind}</b><span>转给你</span></div><div><b>${s.sent}</b><span>你已发送</span></div></div>
      <div class="avx-line"><div class="avx-seg">${[['all', '全部'], ['you', '转给你'], ['sent', '已发送'], ['skip', '跳过']].map(([k, n]) => `<button class="${logFilter === k ? 'on' : ''}" data-av="log-filter" data-k="${k}">${n}</button>`).join('')}</div><span class="avx-m">${picked ? `<b>${esc(picked.who)}：</b>${esc(picked.why || picked.result)}` : '点一行看分身为什么这样处理'}</span></div>
      <div class="avx-card fill flat"><table class="avx-t"><colgroup><col style="width:92px"><col style="width:130px"><col style="width:84px"><col><col style="width:88px"><col style="width:52px"><col style="width:120px"></colgroup><tr><th>时间</th><th>在哪</th><th>谁</th><th>消息</th><th>处理</th><th>把握</th><th>结果</th></tr>
      ${view.length ? view.map(r => { const i = a.log.indexOf(r), n = LOG[r.act] || [r.act, '']; return `<tr class="ck ${i === logPick ? 'on' : ''}" data-av="log-pick" data-i="${i}"><td>${when(r.at)}</td><td title="${esc(r.where)}">${esc(r.where)}</td><td title="${esc(r.who)}">${esc(r.who)}</td><td title="${esc(r.text)}">${esc(r.text)}</td><td><span class="avx-ch ${n[1]}">${n[0]}</span></td><td>${r.confidence || '—'}</td><td>${r.act === 'sent' && r.canRecall ? `已发送 <button class="avx-btn s" data-av="recall" data-a="${esc(a.id)}" data-i="${esc(r.itemId)}">撤回</button>` : esc(r.result)}</td></tr>`; }).join('') : '<tr><td colspan="7">还没有记录</td></tr>'}</table></div>
      <div class="avx-line"><span class="avx-m">第 ${at + 1} / ${pages} 页，共 ${rows.length} 条</span><button class="avx-btn s" data-av="log-page" data-d="-1" ${at ? '' : 'disabled'}>上一页</button><button class="avx-btn s" data-av="log-page" data-d="1" ${at < pages - 1 ? '' : 'disabled'}>下一页</button></div>`;
  }
  const actionSelect = (value, attrs) => `<select class="avx-in" ${attrs}>${Object.entries(ACT).map(([k, n]) => `<option value="${k}" ${value === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  function chips(a, field, title, options) {
    return `<label class="avx-lb">${title}</label><div class="avx-chips">${a[field].map(x => `<span class="avx-pk on">${esc(x.name)}<button class="avx-x" data-av="chip-del" data-f="${field}" data-id="${esc(x.id)}" aria-label="移除">×</button></span>`).join('')}<select class="avx-in sm" data-chg="chip-add" data-f="${field}"><option value="">添加…</option>${options.filter(o => !a[field].some(x => x.id === o.id)).map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></div>`;
  }
  function scope(a) {
    const groups = targets?.groups || [], people = targets?.people || [], picked = id => a.targets.some(t => t.id === id), all = [...groups, ...people];
    const pick = (rows, title) => `<h3>${title}</h3>${rows.length ? rows.map(x => `<label class="avx-li ck"><span><input type="checkbox" data-chg="target" data-id="${esc(x.id)}" ${picked(x.id) ? 'checked' : ''}> ${esc(x.name)}</span>${x.leader ? '<span class="avx-ch r">上级</span>' : ''}<small>${esc(x.title || (x.count ? `最近 ${x.count} 条` : ''))}</small></label>`).join('') : `<p class="avx-m">${targetsLoading && !targets ? '正在读取…' : '还没有读到，稍后再看。'}</p>`}`;
    return `<div class="avx-c2"><div class="avx-stack"><div class="avx-card"><h3>在哪里生效</h3><div class="avx-seg">${KINDS.map(([k, n]) => `<button class="${a.kind === k ? 'on' : ''}" data-av="kind" data-k="${k}">${n}</button>`).join('')}</div>
      ${a.kind === 'pick' ? `<table class="avx-t mt"><colgroup><col><col style="width:172px"><col style="width:104px"></colgroup><tr><th>目标</th><th>归属</th><th>动作</th></tr>${a.targets.length ? a.targets.map(t => `<tr><td title="${esc(t.name)}">${esc(t.name)}</td><td title="${esc(a.owners[t.id]?.text)}">${esc(a.owners[t.id]?.text)}</td><td class="vis">${actionSelect(t.action, `data-chg="target-action" data-id="${esc(t.id)}"`)}</td></tr>`).join('') : '<tr><td colspan="3">在右侧勾选群或人</td></tr>'}</table>` : `<div class="avx-line mt"><span class="avx-m">这个范围里的动作</span><div class="w120">${actionSelect(a.action, 'data-chg="action"')}</div></div>`}</div>
      <div class="avx-card"><h3>听谁的</h3><label class="avx-line"><input type="checkbox" data-chg="at" ${a.atOnly ? 'checked' : ''}> 群里只响应 @我</label>${chips(a, 'only', '只听这些人（不选就是所有人）', people)}${chips(a, 'skip', '不看这些群或人', all)}</div>
      <div class="avx-card grow tint"><h3>这样设置后</h3><p>${esc(scopeSummary(a))}</p><p class="avx-m">Beta 阶段不会自动发言。人事、密码、审批类消息只提醒，不交给模型。</p></div></div>
      <div class="avx-card scroll" data-sc="pk">${a.kind === 'pick' ? targetsBar() + pick(groups, '最近的群') + '<div class="gap"></div>' + pick(people, '最近联系的人') : '<h3>范围说明</h3><p class="avx-m">新建的群和新联系人会自动进入这个范围。</p><p class="avx-m">全部类范围跟随助理的消息刷新；想要更快响应，改成指定群或人，会每 30 秒读取一次。</p><p class="avx-m">一条消息只归一个分身：指定的人优先于指定的群，指定的优先于全部。</p>'}</div></div>`;
  }
  function context(a) {
    const people = targets?.people || [];
    return `<div class="avx-c3"><div class="avx-stack"><div class="avx-card grow col"><h3>人设<small>它以什么身份、怎么说话</small></h3><textarea class="avx-ta grow" data-save="persona" placeholder="留空时使用默认说法">${esc(a.persona)}</textarea><div class="avx-line mt"><button class="avx-btn s" data-av="persona">从我的发言重新生成</button></div></div>
      <div class="avx-card"><h3>权威答疑人<small>他们的原话优先</small></h3>${a.authorities.map(x => `<div class="avx-li"><span>${esc(x.name)}</span><button class="avx-x" data-av="chip-del" data-f="authorities" data-id="${esc(x.id)}" aria-label="移除">×</button></div>`).join('') || '<p class="avx-m">没有设置。群答疑模板会自动找出常答疑的人。</p>'}<select class="avx-in sm mt" data-chg="chip-add" data-f="authorities"><option value="">添加人…</option>${people.filter(p => !a.authorities.some(x => x.id === p.id)).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div></div>
      <div class="avx-stack"><div class="avx-card grow scroll" data-sc="kn"><h3>知识来源</h3>${a.memoryLines ? `<div class="avx-li"><span>群历史问答</span><small>自动 · ${a.memoryLines} 条</small></div>` : ''}${a.sources.map((s, i) => `<div class="avx-li"><span title="${esc(s.path)}">${esc(s.name)}</span><small>${s.type === 'dir' ? '文件夹' : '文件'}</small><button class="avx-x" data-av="source-del" data-i="${i}" aria-label="移除">×</button></div>`).join('')}${!a.memoryLines && !a.sources.length ? '<p class="avx-m">还没有资料。</p>' : ''}<div class="avx-line mt"><button class="avx-btn s" data-av="source" data-t="file">添加文件</button><button class="avx-btn s" data-av="source" data-t="dir">添加文件夹</button></div></div>
      <div class="avx-card"><h3>范例<small>你改过的稿自动进来</small></h3><p class="avx-m">已有 <b>${a.examples}</b> 条，分身写新草稿时会参考。</p></div></div>
      <div class="avx-stack"><div class="avx-card grow col"><h3>补充要求<small>随时告诉它怎么做</small></h3><textarea class="avx-ta grow" data-save="notes" placeholder="比如：涉及排期的问题都转给我">${esc(a.notes)}</textarea></div>
      <div class="avx-card"><h3>当前会话</h3><p class="avx-m">${a.session.alive ? `运行中，已处理 ${a.session.questions} 条，到 80 条自动换新。` : '闲置时自动休眠，有新消息时启动。'}记忆都在文件里，换新不丢。</p></div></div></div>`;
  }
  // 部门 API key（网关）行选中时（所有分身共用，R45）：账号卡亮它，模型卡列网关模型。
  const gatewayOn = () => data?.backends?.rows?.find(r => r.gateway && r.selected) || null;
  // 存过「分身用部门 key」（不管此刻是否生效）：点回 CodeAgent 账号时连失效的残留一起清掉。
  const gatewayStored = () => !!data?.backends?.rows?.some(r => r.gateway && (r.selected || r.configured));
  function backend(a) {
    const rows = data.backends.rows, gw = gatewayOn(), chosen = gw || rows.find(r => r.id === a.backend.account && !r.gateway) || rows[0], models = chosen?.models || [];
    const model = gw ? gw.model : a.backend.model;
    const sub = r => (r.id === 'auto' ? '挑当前最空闲的账号' : !r.usable ? esc(r.reason || '不可用') : r.gateway ? `${r.models.length} 个模型 · 所有分身共用；切回 CodeAgent 账号即撤销` : `${r.models.length} 个模型`);
    return `<div class="avx-c3"><div class="avx-card scroll" data-sc="ac"><h3>账号<small>和启动中心同一份</small></h3>${rows.map(r => `<button class="avx-ac ${r.id === (chosen?.id) ? 'on' : ''}" data-av="account" data-id="${esc(r.id)}" ${r.usable ? '' : 'disabled'}><b><i class="avx-dot ${r.usable ? 'g' : ''}"></i>${esc(r.label)}</b><small>${sub(r)}</small></button>`).join('')}</div>
      <div class="avx-card scroll" data-sc="md"><h3>模型</h3><button class="avx-ac ${model ? '' : 'on'}" data-av="model" data-id=""><b>${gw ? '网关默认模型' : '账号默认模型'}</b><small>${esc(chosen?.defaultModel || '由账号决定')}</small></button>${models.map(m => `<button class="avx-ac ${model === m ? 'on' : ''}" data-av="model" data-id="${esc(m)}"><b>${esc(m)}</b></button>`).join('')}<label class="avx-lb">思考档位</label><div class="avx-seg">${EFFORT.map(([k, n]) => `<button class="${(a.backend.effort || '') === k ? 'on' : ''}" data-av="effort" data-k="${k}">${n}</button>`).join('')}</div><p class="avx-m">${gw ? '部门 API key 由 Claude Code 经本机转发作答，所有分身共用这一项；点左边任一 CodeAgent 账号就换回。' : ''}换账号或模型后，下一条消息会用新的会话处理。</p></div>
      <div class="avx-stack"><div class="avx-card"><h3>发言前缀</h3><div class="avx-pfx"><span>🤖</span><input class="avx-in" maxlength="20" data-save="prefix" value="${esc(a.prefix)}"></div><p class="avx-m">🤖 不能去掉：同事能看出是 AI，其他分身也靠它避免对聊。群答疑和空白分身发送时带前缀。</p><label class="avx-lb">群里看到的样子</label><div class="avx-bub" id="avx-preview">🤖【${esc(a.prefix)}】张三 关于『导出纪要』：在纪要页右上角选导出，格式选 Word。</div></div>
      <div class="avx-card grow"><h3>名字与身份</h3><label class="avx-lb">分身名字</label><input class="avx-in" maxlength="30" data-save="name" value="${esc(a.name)}"><label class="avx-line mt"><input type="checkbox" data-chg="hide" ${a.hideModel ? 'checked' : ''}> 不透露底层用的是哪个模型</label></div></div></div>`;
  }
  function confirmDialog() { return `<div class="avx-ov"><div class="avx-md sm"><div class="avx-mh"><h2>${esc(confirmBox.title)}</h2></div><div class="avx-mb">${esc(confirmBox.body)}</div><div class="avx-mf"><button class="avx-btn" data-av="confirm-no">取消</button><button class="avx-btn dd" data-av="confirm-yes">${esc(confirmBox.yes)}</button></div></div></div>`; }
  function wizard() {
    if (wiz.step === 'run') {
      const p = data?.prep, steps = p?.steps || ['准备中'], at = p?.at ?? 0;
      return `<div class="avx-ov"><div class="avx-md sm"><div class="avx-mh"><h2>正在创建「${esc(wiz.name)}」</h2></div><div class="avx-mb">${steps.map((s, i) => `<div class="avx-st ${i < at ? 'ok' : i === at ? 'now' : ''}"><i>${i < at ? '✓' : i + 1}</i>${esc(s)}</div>`).join('')}</div><div class="avx-mf"><p>第一次需要读取历史消息，通常几秒钟。</p></div></div></div>`;
    }
    const title = `<div class="avx-mh"><h2>新建分身</h2><span class="avx-ch">第 ${wiz.step} 步，共 2 步</span><button class="avx-x big" data-av="wiz-close" aria-label="关闭">×</button></div>`;
    if (wiz.step === 1) return `<div class="avx-ov"><div class="avx-md">${title}<div class="avx-mb"><p class="avx-m">选一个最接近的用途，之后什么都能改。</p><div class="avx-tpls wide">${TEMPLATES.map(tplCard).join('')}</div></div></div></div>`;
    const need = wiz.tpl === 'qa' || wiz.tpl === 'blank', groups = targets?.groups || [], people = targets?.people || [], ready = !need || wiz.targets.length > 0, rows = data.backends.rows;
    const pill = (x, list, op) => `<button class="avx-pk ${list.some(t => t.id === x.id) ? 'on' : ''}" data-av="${op}" data-id="${esc(x.id)}" data-n="${esc(x.name)}" data-ty="${x.type}">${esc(x.name)}</button>`;
    const scopeHtml = need ? `<h3>它管哪些群或人？</h3>${targets?.stale || targetsFailed ? targetsBar() : ''}<label class="avx-lb">群</label><div class="avx-chips">${groups.map(x => pill(x, wiz.targets, 'wiz-target')).join('') || `<span class="avx-m">${esc(noGroupsText())}</span>${!targetsLoading && (targetsFailed || targets?.reason) ? ' <button class="avx-btn s" data-av="targets-retry">重试</button>' : ''}`}</div>${wiz.tpl === 'blank' ? `<label class="avx-lb">人</label><div class="avx-chips">${people.map(x => pill(x, wiz.targets, 'wiz-target')).join('')}</div>` : ''}`
      : `<h3>它会管这些</h3><div class="avx-q">${wiz.tpl === 'watch' ? '全部会话。新建的群和新联系人自动包含。' : '所有私聊，以及群里 @我 的消息。'}</div><label class="avx-lb">不想让它看的群（可选）</label><div class="avx-chips">${groups.map(x => pill(x, wiz.skip, 'wiz-skip')).join('')}</div>`;
    return `<div class="avx-ov"><div class="avx-md">${title}<div class="avx-mb"><div class="avx-w2"><div>${scopeHtml}<p class="avx-m mt">${wiz.tpl === 'watch' ? '只提醒，不会替你发任何消息。' : '写好草稿后由你点发送，不会自动发言。'}</p></div>
      <div class="avx-card tint"><h3>已经替你配好</h3><div class="avx-li"><span>名字</span><small>${esc(wiz.name)}</small></div><div class="avx-li"><span>人设</span><small>${wiz.persona ? '你写的' : '从近期发言生成'}</small></div><div class="avx-li"><span>知识</span><small>${wiz.tpl === 'qa' ? '所选群的历史问答' : '最近的对话'}</small></div><div class="avx-li"><span>后端</span><small>${esc(gatewayOn()?.label || rows.find(r => r.id === wiz.account)?.label || '自动选择')}</small></div><button class="avx-btn s mt" data-av="wiz-adv">${wiz.adv ? '收起高级设置' : '高级设置'}</button>
      ${wiz.adv ? `<label class="avx-lb">名字</label><input class="avx-in" maxlength="30" data-wiz="name" value="${esc(wiz.name)}"><label class="avx-lb">前缀（🤖 保留，留空用默认）</label><input class="avx-in" maxlength="20" data-wiz="prefix" value="${esc(wiz.prefix)}"><label class="avx-lb">人设（留空自动生成）</label><textarea class="avx-ta" rows="2" data-wiz="persona">${esc(wiz.persona)}</textarea><label class="avx-lb">账号</label><select class="avx-in" data-chg="wiz-account">${rows.filter(r => r.usable && !r.gateway).map(r => `<option value="${esc(r.id)}" ${wiz.account === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>` : ''}</div></div></div>
      <div class="avx-mf"><p>${ready ? '创建后马上开始工作，随时可以改或暂停。' : '至少选一个群或人。'}</p><button class="avx-btn" data-av="wiz-back">上一步</button><button class="avx-btn p" data-av="wiz-go" ${ready ? '' : 'disabled'}>创建分身</button></div></div></div>`;
  }

  // ---- 操作 ----
  const toggleIn = (list, entry) => (list.some(x => x.id === entry.id) ? list.filter(x => x.id !== entry.id) : [...list, entry]);
  function startWizard(tpl) {
    const t = TEMPLATES.find(x => x[0] === tpl);
    wiz = { step: t ? 2 : 1, tpl: tpl || '', name: t && tpl !== 'blank' ? t[1] : '我的分身', targets: [], skip: [], adv: false, prefix: '', persona: '', account: 'auto' };
    void loadTargets(); render();
  }
  async function act(b) {
    const op = b.dataset.av, a = b.dataset.a, i = b.dataset.i, payload = { avatarId: a, itemId: i };
    if (op === 'provider-settings') { close(); window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { settingsTab: 'model' } })); return; }
    if (op === 'repair-provider') {
      b.disabled = true;
      const r = await ipcRenderer.invoke('company-assistant:set-model-choice', { account: b.dataset.account || 'personal', useManual: true });
      if (!r?.ok) { b.disabled = false; throw new Error(r?.error || '供应商没有切换'); }
      if (cur()?.backend?.model && !(await save({ backend: { ...cur().backend, model: '' } }))) return;
      flash('已改用手动会话成功使用的供应商，下次任务起生效'); return;
    }
    if (op === 'sel') { sel = b.dataset.id; tab = 'inbox'; logPage = 0; logPick = -1; render(); return; }
    if (op === 'tab') { tab = b.dataset.k; logPage = 0; logPick = -1; if (['scope', 'ctx'].includes(tab)) void loadTargets(); render(); return; }
    if (op === 'item') { itemSel[b.dataset.k] = b.dataset.id; render(); return; }
    if (op === 'targets-retry') { void loadTargets(); return; }
    if (op === 'new') { startWizard(); return; }
    if (op === 'tpl') { if (wiz) { const keep = wiz; startWizard(b.dataset.t); wiz.account = keep.account; } else startWizard(b.dataset.t); return; }
    if (op === 'wiz-close') { wiz = null; if (!['scope', 'ctx'].includes(tab)) stopTargets(); render(); return; }
    if (op === 'wiz-back') { wiz.step = 1; render(); return; }
    if (op === 'wiz-adv') { wiz.adv = !wiz.adv; render(); return; }
    if (op === 'wiz-target' || op === 'wiz-skip') {
      const entry = { id: b.dataset.id, name: b.dataset.n, type: b.dataset.ty }, field = op === 'wiz-target' ? 'targets' : 'skip';
      wiz[field] = toggleIn(wiz[field], entry);
      if (op === 'wiz-target' && wiz.tpl === 'qa' && wiz.targets.length === 1) wiz.name = `${wiz.targets[0].name}答疑`.slice(0, 30);
      render(); return;
    }
    if (op === 'wiz-go') {
      const w = wiz; w.step = 'run'; error = ''; render();
      try {
        const r = await call('create', { tpl: w.tpl, name: w.name, targets: w.targets, skip: w.skip, ...(w.prefix.trim() ? { prefix: w.prefix } : {}), ...(w.persona.trim() ? { persona: w.persona } : {}), backend: { account: w.account, model: '' } });
        accept(r); sel = r.createdId; tab = 'inbox'; wiz = null; flash('分身已开始工作');
      } catch (e) { w.step = 2; error = e.message; }
      render(); return;
    }
    if (op === 'feedback') { const open = window.__hubFeedback?.open; if (open) void open({ description: '【分身 Beta 反馈】\n我在用的模板：\n遇到的问题或建议：' }); else showMessage('这个版本没有一键反馈入口'); return; }
    if (op === 'pause-all') { await run('正在处理', 'pause-all', { paused: !data.paused }); return; }
    if (op === 'relogin') { await run('正在检查', 'relogin'); return; }
    if (op === 'toggle') { await save({ enabled: !cur().enabled }); return; }
    if (op === 'remove') { confirmBox = { title: `删除「${cur().name}」？`, body: '它的配置、记忆和待确认事项都会删除，已发出的消息不受影响。', yes: '删除', run: async id => { await run('正在删除', 'remove', { avatarId: id }); }, id: sel }; render(); return; }
    if (op === 'confirm-no') { confirmBox = null; render(); return; }
    if (op === 'confirm-yes') { const c = confirmBox; confirmBox = null; render(); await c.run(c.id); return; }
    if (op === 'open-session') { const r = await call('session', { avatarId: sel }); if (!r.sessionId) { flash('分身会话还没启动，有新消息时会自动启动'); render(); return; } close(); await selectSession(r.sessionId); return; }
    if (op === 'send') {
      const key = b.dataset.key, text = (edits[key] ?? data.items.find(x => keyOf(x) === key)?.draft ?? '').trim();
      if (!text) { error = '草稿是空的'; render(); return; }
      const r = await run('正在发送', 'send', { ...payload, text, ackRisk: !!ack[key] });
      if (r?.needAck) { ack[key] = true; error = r.error; render(); return; }
      if (r?.ok) { delete edits[key]; delete ack[key]; flash(r.edited ? '已发送，你的改稿已存为范例' : '已发送', r.canRecall ? { op: 'recall', a, i, label: '撤回' } : null); render(); }
      return;
    }
    if (op === 'recall') { if (await run('正在撤回', 'recall', payload)) { notice = null; flash('已撤回'); render(); } return; }
    if (['done', 'drop', 'remind-only', 'redraft'].includes(op)) { const r = await run('正在处理', op, payload); if (r) { delete edits[`${a}|${i}`]; delete ack[`${a}|${i}`]; if (op === 'redraft') flash(r.queued ? '分身正在处理别的消息，这条排在后面；写好会回到「待确认」，写不出也会说明原因' : '已交给分身起草，写好会回到「待确认」，写不出也会说明原因'); render(); } return; }
    if (op === 'log-filter') { logFilter = b.dataset.k; logPage = 0; logPick = -1; render(); return; }
    if (op === 'log-page') { logPage = Math.max(0, logPage + Number(b.dataset.d)); render(); return; }
    if (op === 'log-pick') { logPick = Number(b.dataset.i); render(); return; }
    const av = cur(); if (!av) return;
    if (op === 'kind') { await save({ kind: b.dataset.k }); return; }
    if (op === 'chip-del') { const f = b.dataset.f; await save({ [f]: av[f].filter(x => x.id !== b.dataset.id) }); return; }
    if (op === 'persona') { if (await run('正在生成', 'persona', { avatarId: sel })) flash('已根据你的发言重新生成'); render(); return; }
    if (op === 'source') { const r = await call('pick-source', { type: b.dataset.t }); if (r.source) { await save({ sources: [...av.sources, r.source] }); flash('已添加，下一条消息开始使用'); render(); } return; }
    if (op === 'source-del') { await save({ sources: av.sources.filter((_, n) => n !== Number(b.dataset.i)) }); return; }
    // 部门 API key（网关）：写「功能使用的 Agent → 分身」那一项（所有分身共用）；点回 CodeAgent 账号时撤掉它。
    if (op === 'account' && b.dataset.id === 'api-gateway') { await setGateway({ kind: 'api-gateway', model: '' }, '已改用部门 API key，下一条消息起生效'); return; }
    if (op === 'account') { if (gatewayStored() && !(await setGateway(null))) return; await save({ backend: { ...av.backend, account: b.dataset.id, model: '' } }); return; }
    if (op === 'model' && gatewayOn()) { await setGateway({ kind: 'api-gateway', model: b.dataset.id }, '已换模型，下一条消息起生效'); return; }
    if (op === 'model') { await save({ backend: { ...av.backend, model: b.dataset.id } }); return; }
    if (op === 'effort') { await save({ backend: { ...av.backend, effort: b.dataset.k } }); }
  }
  function onInput(event) {
    const t = event.target;
    if (t.dataset.edit) {
      edits[t.dataset.edit] = t.value; delete ack[t.dataset.edit];
      const it = data.items.find(x => keyOf(x) === t.dataset.edit), risk = document.getElementById('avx-risk');
      if (risk && it) risk.textContent = (it.flags || []).some(f => f === 'leader' || f === 'leader-present') && COMMIT_HINT.test(t.value) ? '这句话可能在向上级应承一件事，请确认后再发。' : '';
    }
    if (t.dataset.wiz) wiz[t.dataset.wiz] = t.value;
    if (t.dataset.save === 'prefix') { const p = document.getElementById('avx-preview'); if (p) p.textContent = `🤖【${t.value.trim()}】张三 关于『导出纪要』：在纪要页右上角选导出，格式选 Word。`; }
  }
  async function onChange(event) {
    const t = event.target, c = t.dataset.chg, av = cur();
    if (t.dataset.save && av) { if (t.value !== av[t.dataset.save]) { t.blur(); await save({ [t.dataset.save]: t.value }); flash('已保存'); render(); } return; }
    if (!c) return;
    if (c === 'wiz-account') { wiz.account = t.value; render(); return; }
    if (!av) return;
    const nameOf = id => [...(targets?.groups || []), ...(targets?.people || [])].find(x => x.id === id);
    if (c === 'target') {
      const x = nameOf(t.dataset.id), kept = av.targets.filter(y => y.id !== t.dataset.id);
      await save({ targets: t.checked && x ? [...kept, { id: x.id, name: x.name, type: x.type, action: x.leader ? 'draft' : av.action === 'watch' ? 'remind' : av.action }] : kept }); return;
    }
    if (c === 'target-action') { await save({ targets: av.targets.map(y => (y.id === t.dataset.id ? { ...y, action: t.value } : y)) }); return; }
    if (c === 'action') { await save({ action: t.value }); return; }
    if (c === 'at') { await save({ atOnly: t.checked }); return; }
    if (c === 'hide') { await save({ hideModel: t.checked }); return; }
    if (c === 'chip-add' && t.value) { const x = nameOf(t.value), f = t.dataset.f; if (x) await save({ [f]: [...av[f], { id: x.id, name: x.name, type: x.type }] }); }
  }

  function open() {
    build(); closeOtherPanels(); page.hidden = false; document.body.classList.add('avatar-page-open');
    window.setShellNavActive?.('avatar'); place(); render(); void load(); void loadTargets();
  }
  function close() { stopTargets(); if (!page || page.hidden) return; page.hidden = true; document.body.classList.remove('avatar-page-open'); }
  const onChanged = () => { if (isOpen() && !busy) void load({ soft: true }); };
  ipcRenderer.on?.('avatar:changed', onChanged);
  // 同页「⚙ Agent」或设置里改了功能 Agent（含分身用部门 key、手填模型）：后端卡跟着刷新（审查 P2）。
  ipcRenderer.on?.('feature-agents:changed', onChanged);
  return { open, close, isOpen, destroy() { close(); window.removeEventListener('resize', place); ipcRenderer.removeListener?.('avatar:changed', onChanged); ipcRenderer.removeListener?.('feature-agents:changed', onChanged); page?.remove(); page = null; } };
}

module.exports = { createAvatarPage, paginate, waited, scopeText, modeText, scopeSummary };
