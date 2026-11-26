'use strict';
// 「分身」页（Beta）：左边分身列表，右边待确认、试答、它学到的、运行记录、生效范围、上下文、后端与前缀，每个页签一屏。
// 2026-11-25 阶段 2 第 1 批：首屏自检与就地扫码、5 段状态流水与巡检健康、结构化报错就地修、待确认里的进度与「可能已回答」。
// 2026-11-26 阶段 2 第 3 批：草稿「答错了，这样改」就地纠偏（存本机纠错卡 + 同题重答 + 新旧并排）、回复对象改配 / 不是问我的、群分身转交、「它学到的」页签、反馈附脱敏现场。
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
// 扫码失败的报错：不含中文、或像命令行崩溃输出（Node.js 版本行、调用栈、多行日志）时，主提示换成人话，原文放进折叠的「原始报错」。
const SCAN_HUMAN = '扫码登录没成功，请重新获取二维码或到助理页扫码';
const CRASH_LIKE = /Node\.js v\d|node:internal|^\s*at\s|\bat\s.+:\d+:\d+|Error:|Traceback|\bERR_[A-Z_]+|exit code|[\r\n]/m;
function humanScanError(message) {
  const s = String(message ?? '').trim();
  if (!s) return { head: '', raw: '' };
  if (!/[一-鿿]/.test(s) || CRASH_LIKE.test(s)) return { head: SCAN_HUMAN, raw: s };
  return { head: s, raw: '' };
}
// 试答：题目来源的标签、处理方式的名字、评价三选一。
const TRY_TAG = { group: ['群真实题', 'b'], example: ['示例题', ''], dm: ['私聊 · 需你同意', 'w'] };
const TRY_ACT = { draft: '会起草', remind: '只提醒你', skip: '不用回' };
const VERDICTS = [['like', '像我'], ['unlike', '不像'], ['issue', '有问题']];
const TRY_CONSENT_HINT = '这是私聊消息：先在左边勾选「同意送模型试答」，再点试答。';
// 依据不足：后端标了 lowConfidenceFallback，或把握为 0 且一条依据都没有（与第 1 批待确认同一口径）。
const tryoutLow = r => !!r && (!!r.lowConfidenceFallback || (!(Number(r.confidence) > 0) && !(r.basis || []).length));
// 第 3 批：答错一键就地纠偏。错因六选一；纠错卡只存公司本机该分身目录，默认不外发。
const FIX_REASONS = [['fact', '事实错'], ['tone', '语气不像'], ['should_not_reply', '不该回'], ['too_long', '太长'], ['missing_point', '漏关键点'], ['wrong_target', '回错人']];
const FIX_PH = { should_not_reply: '比如：这类催进度的消息不用回，提醒我就行', wrong_target: '比如：这条是问别人的，我不用回', tone: '比如：说短一点，用「我这边」开头', too_long: '比如：一句话说清结论，细节让他私聊问' };
const FIX_LOCAL = '只存公司本机，默认不外发';
const reasonName = k => (FIX_REASONS.find(r => r[0] === k) || [])[1] || '其他';
// 卡号对用户只显示数字部分（cor-3 → #3）；依据里写到「纠错卡 #…」的地方高亮。
const cardNo = c => String(c?.id ?? '').replace(/^cor-/, '');
const markCards = html => String(html).replace(/(你的)?纠错卡\s*#[\w-]+(\s*v\d+)?/g, m => `<mark class="avx-hit">${m.replace('#cor-', '#')}</mark>`);
// 群分身转交（外部只读转交文件）：只取待处理的，统一成待确认事项的形状；key 前缀 ext| 与本人分身的事项分开。
function externalRows(list, avatars) {
  const fallback = (avatars || []).find(a => a.tpl === 'qa') || (avatars || [])[0];
  return (Array.isArray(list) ? list : []).filter(x => x && x.id && (x.status || 'pending') === 'pending').map(x => ({
    _key: `ext|${x.id}`, id: x.id, external: true, kind: x.kind === 'promise' ? 'promise' : 'draft', avatarId: x.avatarId || fallback?.id || '', avatarName: '群分身',
    who: x.askerName || '群成员', convName: x.convName || '群', group: true, at: Number(x.at) || 0, since: Number(x.at) || 0, text: x.question || '', draft: x.answer || '',
    confidence: Number(x.confidence) || 0, basis: Array.isArray(x.basis) ? x.basis.join('、') : String(x.basis || ''), flags: [], state: 'ready' }));
}
const extTag = r => (r.kind === 'promise' ? '承诺待回收' : `群分身低把握 · 把握 ${r.confidence || 0}`);

const backstage = require('./backstage-jump');
function createAvatarPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage = () => {}, selectSession = () => {} }) {
  let page, root, data = null, targets = null, sel = 'all', tab = 'inbox', error = '', busy = '', wiz = null, confirmBox = null, notice = null, logFilter = 'all', logPage = 0, logPick = -1, noticeTimer = null;
  const itemSel = {}, edits = {}, ack = {}, ackNote = {}, rawOpen = {};
  // 第 3 批：fixes 按「分身|事项」存就地纠偏的进度（切分身、切页签不丢、不串）；retargetOpen：改配消息的候选列表是否展开；learned：每个分身「它学到的」。
  const fixes = {}, retargetOpen = {}, learned = {};
  const learnOf = id => (learned[id] ||= { loaded: false, loading: false, error: '', cards: [], examplesCount: null, persona: '', memoryLines: null, page: 0, pick: '', busy: '' });
  // 试答（第 2 批）：每个分身各一份，切分身、切页签不丢；personaNote：「从我的发言重新生成」没归纳出来时的说明。
  const tryouts = {}, personaNotes = {};
  const tryOf = id => (tryouts[id] ||= { loaded: false, loading: false, error: '', samples: [], history: [], consent: {}, ask: '', pick: null, running: null, failure: null, lastQ: null, hint: '', verdict: '', note: '', rating: false, rateMsg: '', rateErr: '', seq: 0 });
  // checking：打开页面后的首次自检（含一次自动「重新检查」）还没结束，期间只显示一行平静的「正在检查」，不先报「用不了」。
  // scan：就地扫码弹层；focus：报错条「去账号卡」后要高亮的那一项（几秒后自动淡掉）。
  let checking = false, autoRechecked = false, scan = null, scanTimer = null, clockTimer = null, scopePage = 0, focus = null;
  const isOpen = () => !!page && !page.hidden;
  const avatar = id => data?.avatars?.find(a => a.id === id);
  const cur = () => avatar(sel);
  const keyOf = it => it._key || `${it.avatarId}|${it.id}`;
  const extList = () => externalRows(data?.externalItems, data?.avatars);
  // 外部条目纠正后主进程立刻结案、从 externalItems 移除；新旧对照或重答失败面板还要给用户看，就用发起时的快照留在原位，点「×」才移出。
  const extKept = () => { const live = new Set(extList().map(keyOf)); return Object.entries(fixes).filter(([k, f]) => f.snap?.external && f.mode && f.mode !== 'edit' && !live.has(k)).map(([, f]) => ({ ...f.snap, resolved: true })); };
  const rowOf = key => [...extList(), ...(data?.items || [])].find(r => keyOf(r) === key) || (fixes[key]?.snap?.external ? fixes[key].snap : null);
  async function call(op, payload = {}) {
    const result = await ipcRenderer.invoke('avatar:' + op, payload);
    if (!result || (result.ok === false && !result.needAck)) throw new Error(result?.error || '没有收到结果，请重试');
    return result;
  }
  async function callAny(ops, payload = {}) {
    let last = null;
    for (const op of ops) {
      try { return await call(op, payload); } catch (e) { last = e; if (!/No handler registered/i.test(e?.message || '')) throw e; }
    }
    throw last || new Error('没有收到结果，请重试');
  }
  const RECHECK = ['recheck', 'relogin'];
  const accept = next => { if (next && next.available !== undefined) { data = next; if (sel !== 'all' && !avatar(sel)) { sel = 'all'; tab = 'inbox'; } } };
  const typing = () => { const el = document.activeElement; return !!el && page?.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox'; };
  const pf = () => data?.preflight || null;
  // WeLink 需要人去登录：自检明说过期 / 未连接，或当前失败就是 WeLink 登录过期；旧主进程没有自检时按原因文字判断。
  const welinkNeedsLogin = () => {
    const w = pf()?.welink;
    // 只要自检没说在线、也不是正在检查，就稳定给扫码入口（过期 / 未连接 / 续期没成功的未知状态都算）。
    if (w) return w.ok !== true && w.state !== 'online' && w.state !== 'checking';
    if (data?.activeFailure?.code === 'welink_expired') return true;
    return !!data && !data.missing && (!data.available ? /登录|WeLink/.test(data.reason || '') : data.login && !data.login.ok);
  };
  // 后台刷新不清掉操作报错（发送失败的提示要留到下一次操作）。
  // 首次打开带 autoCheck（主进程会顺手查一次登录）；若仍显示「没确认登录」，前端再自动点一次「重新检查」，
  // 已登录的新用户不会先看到「分身暂时用不了」（B1：登录恢复时分身页收不到通知，以前只能手点「重新检查」才好）。
  async function load({ soft = false, first = false } = {}) {
    try {
      accept(await call('status', first ? { autoCheck: true } : {}));
      if (!soft) error = '';
      if (first && !autoRechecked && data && !data.missing && (!data.available || data.login?.ok === false || pf()?.welink?.state === 'checking')) {
        autoRechecked = true; checking = true; render();
        try { accept(await callAny(RECHECK)); } catch (e) { error = e.message; }
      }
    } catch (e) { error = e.message; } finally { if (first) checking = false; }
    if (!(soft && typing())) render();
  }
  async function runAny(label, ops, payload) {
    busy = label; error = ''; render();
    try { const r = await callAny(ops, payload); accept(r); return r; } catch (e) { error = e.message; return null; } finally { busy = ''; render(); }
  }
  // 失败动作带 avatarId / itemId 时一并传给主进程，只重排那一条失败任务。
  const retryTick = async (extra = {}) => { if (await runAny('正在重试', RECHECK, { retryTick: true, ...extra })) flash('已重新检查并重试巡检'); };
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
    // 「自己问一句」回车直接试答（输入法选词时的回车不算）。
    page.addEventListener('keydown', event => { const t = event.target; if (event.key === 'Enter' && !event.isComposing && t?.dataset && 'tryAsk' in t.dataset) { event.preventDefault(); void tryAct('try-ask', t).catch(e => { error = e.message; render(); }); } });
    // 「原始报错」展开后，后台刷新重画时保持展开。
    page.addEventListener('toggle', event => { const d = event.target; if (d?.dataset?.raw) rawOpen[d.dataset.raw] = d.open; }, true);
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
    root.innerHTML = head() + banners() + health() + main() + (wiz ? wizard() : '') + (confirmBox ? confirmDialog() : '') + (scan ? scanDialog() : '');
    root.querySelectorAll('[data-sc]').forEach(e => { if (keep[e.dataset.sc]) e.scrollTop = keep[e.dataset.sc]; });
    applyFocus();
  }
  // 顶栏的模型徽标只认自检里「实际生效」的那一项（和 R45 账号卡的 selected 同源）：不可用时写「模型不可用」，不亮绿灯。
  function modelChip() {
    const g = pf()?.agent;
    if (!g) return '';
    if (!g.ok) return `<span class="avx-ch r" title="${esc(g.label)}"><i class="avx-dot r"></i>模型不可用</span>`;
    return `<span class="avx-ch" title="${esc(g.label)}"><i class="avx-dot g"></i>${esc(String(g.label || '模型就绪').slice(0, 28))}</span>`;
  }
  function welinkChip() {
    const w = pf()?.welink;
    if (checking || w?.state === 'checking') return '<span class="avx-ch"><i class="avx-dot"></i>正在检查 WeLink</span>';
    if (!data?.available) return '';
    const ok = w ? w.state === 'online' : data.login.ok;
    return ok ? '<span class="avx-ch g"><i class="avx-dot g"></i>WeLink 在线</span>' : `<span class="avx-ch w"><i class="avx-dot w"></i>${w?.state === 'expired' ? 'WeLink 登录过期' : 'WeLink 未连接'}</span>`;
  }
  function head() {
    const on = data?.avatars?.filter(a => a.state.code === 'on').length || 0, ready = data?.available;
    return `<header class="avx-head"><div><h1>分身<span class="avx-beta">Beta</span></h1><p>替你盯消息、写回复，所有消息都由你点了才发</p></div><div class="avx-right">
      ${welinkChip()}${ready ? modelChip() : ''}
      ${data?.avatars?.length ? `<span class="avx-ch">${on} 个运行中${data.snapAt ? ` · 消息 ${when(data.snapAt)} 更新` : ''}</span>` : ''}
      <button class="avx-btn" data-av="feedback">反馈意见</button>
      ${data?.avatars?.length ? `<button class="avx-btn ${data.paused ? 'p' : 'd'}" data-av="pause-all">${data.paused ? '恢复全部' : '全部暂停'}</button>` : ''}
      ${ready ? '<button class="avx-btn p" data-av="new">新建分身</button>' : ''}</div></header>`;
  }
  // 结构化报错：一句人话 + 紧挨着的修复按钮 + 折叠的原始报错。整页（activeFailure）和单条事项（item.failure）共用。
  const FIX_LABEL = { provider_repair: '改用手动会话在用的供应商', open_account_card: '去账号卡换', open_model_settings: '选择模型与供应商', welink_login: '就地扫码登录', retry_tick: '重试巡检', open_account_page: '去账号页登录' };
  function failureBox(f, key, slim = false, sessionId = '') {
    if (!f) return '';
    const sev = f.severity === 'warn' ? 'w' : 'r';
    const auto = f.retryable && f.retryAfterMs ? `${Math.max(1, Math.round(f.retryAfterMs / 1000))} 秒后自动重试${f.retryMax ? `（第 ${f.retryAttempt || 1} 次，最多 ${f.retryMax} 次）` : ''}，不用你做什么。` : '';
    const acts = (f.actions || []).map((x, i) => `<button class="avx-btn s ${i ? '' : sev === 'r' ? 'p' : ''}" data-av="fix" data-kind="${esc(x.kind)}" data-hl="${esc(x.highlight || '')}" data-account="${esc(x.payload?.account || '')}" data-payload="${esc(JSON.stringify(x.payload || {}))}">${esc(x.label || FIX_LABEL[x.kind] || '去处理')}</button>`).join('');
    const raw = f.raw ? `<details class="avx-raw" data-raw="${esc(key)}"${rawOpen[key] ? ' open' : ''}><summary>原始报错</summary><pre>${esc(f.raw)}</pre></details>` : '';
    return `<div class="avx-fx ${sev}${slim ? ' slim' : ''}"><div class="avx-line"><span class="avx-fx-t">${esc(f.headline || '遇到问题')}${auto ? ` <small>${esc(auto)}</small>` : ''}</span><span class="avx-fx-a">${acts}${backstage.backstageLinkHtml({ sessionId, from: 'avatar' })}</span></div>${raw}</div>`;
  }
  function banners() {
    const out = [];
    if (error) out.push(`<div class="avx-bn r">${esc(error)}</div>`);
    if (notice) out.push(`<div class="avx-bn b">${esc(notice.text)}${notice.action ? `<button class="avx-btn s" data-av="${notice.action.op}" data-a="${esc(notice.action.a)}" data-i="${esc(notice.action.i)}" data-k="${esc(notice.action.k)}">${esc(notice.action.label)}</button>` : ''}</div>`);
    if (!data?.available) return out.join('');
    if (data.paused) out.push('<div class="avx-bn r"><b>全部分身已暂停。</b>不读取新消息，不起草，也不能发送。已写好的草稿还在。</div>');
    else if (data.activeFailure) out.push(failureBox(data.activeFailure, 'page'));
    else if (welinkNeedsLogin()) out.push(`<div class="avx-bn w"><b>WeLink 没有连接。</b>${esc(pf()?.welink?.detail || data.login?.reason || '')}。Hub 会先自动续期，续不上再扫码；已写好的草稿还在。<button class="avx-btn s p" data-av="scan">就地扫码登录</button><button class="avx-btn s" data-av="relogin">重新检查</button></div>`);
    else if (data.readError && !data.health) out.push(`<div class="avx-bn w">${esc(data.readError)}</div>`);
    return out.join('');
  }
  // ---- 巡检健康与 5 段流水 ----
  const STAGES = [['read', '读消息'], ['route', '判断归属'], ['context', '找依据'], ['draft', '生成'], ['confirm', '等你确认']];
  const HEALTH = { ok: ['运行正常', 'g'], degraded: ['部分没读成', 'w'], error: ['巡检出错', 'r'], waiting: ['等 WeLink', 'w'], paused: ['已暂停', ''], off: ['未运行', ''] };
  const span = ms => (!ms ? '' : ms < 1000 ? `${ms} 毫秒` : ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`);
  function untilText(at) {
    if (!at) return '';
    const s = Math.round((at - Date.now()) / 1000);
    return s <= 0 ? '马上' : s < 60 ? `${s} 秒后` : `${Math.round(s / 60)} 分钟后`;
  }
  function health() {
    if (!data?.available || !data.avatars?.length || data.paused) return '';
    const h = data.health;
    // 旧主进程只有顶层 lastError：至少不再假亮绿灯，把它显示出来并给「重试巡检」。
    if (!h) return data.lastError ? `<div class="avx-bn w"><b>后台巡检出错，新消息可能没人看。</b>${esc(data.lastError)}<button class="avx-btn s" data-av="retry-tick">重试巡检</button></div>` : '';
    const st = HEALTH[h.state] || HEALTH.ok, stages = data.stages || [];
    const pipe = STAGES.map(([k, n]) => {
      const s = stages.find(x => x.key === k) || {}, cls = { ok: 'ok', running: 'run', warn: 'w', error: 'r' }[s.state] || '';
      const sub = s.state === 'running' ? `进行中${s.at ? ` · <span data-since="${s.at}">${span(Date.now() - s.at)}</span>` : ''}` : s.at ? `${when(s.at)}${s.durationMs ? ` · ${span(s.durationMs)}` : ''}` : '—';
      return `<li class="${cls}" title="${esc(s.detail || '')}"><b>${esc(s.label || n)}</b><small>${sub}</small></li>`;
    }).join('');
    const mode = `${h.pollMode === 'lowOverhead' ? '低开销模式' : '正常模式'}：指定群每 ${span(h.hotIntervalMs) || '—'}、全部会话每 ${span(h.wideIntervalMs) || '—'}`;
    const bad = h.state === 'error' || h.state === 'degraded' || h.readFailStreak > 0 || !!h.lastError;
    const dup = ['tick_error', 'read_failed'].includes(data.activeFailure?.code);
    // 有具体原因（报错文字或连续失败次数）才单列一条；整页已有结构化报错时不重复。
    const why = (h.lastError || h.readError || h.readFailStreak > 0) && !dup && !data.activeFailure ? `<div class="avx-bn ${h.state === 'error' ? 'r' : 'w'} slim"><b>${h.readFailStreak ? `巡检连续 ${h.readFailStreak} 次没读成` : '后台巡检出错'}，新消息可能没人看。</b>${esc(h.lastError || h.readError || '')}<button class="avx-btn s" data-av="retry-tick">重试巡检</button></div>` : '';
    const retry = h.retryAfterAt ? ` · ${esc(h.retryReason || '等待重试')}：${untilText(h.retryAfterAt)}` : '';
    return `<div class="avx-hb"><span class="avx-ch ${bad ? (h.state === 'error' ? 'r' : 'w') : st[1]}"><i class="avx-dot ${bad ? (h.state === 'error' ? 'r' : 'w') : st[1]}"></i>${bad && h.state === 'ok' ? '巡检有问题' : st[0]}</span><ol class="avx-pipe">${pipe}</ol>
      <span class="avx-m">最后成功读到消息 ${h.lastReadSuccessAt ? when(h.lastReadSuccessAt) : '还没有'}${h.nextReadAt ? ` · 下次读 ${untilText(h.nextReadAt)}` : ''}${retry}</span><span class="avx-m" title="${esc(mode)}">${esc(mode)}</span></div>${why}`;
  }
  // ---- 首屏自检 ----
  function preflightList() {
    const p = pf();
    if (!p) return '';
    const w = p.welink || {}, g = p.agent || {};
    const wl = { online: ['已登录', 'g'], checking: ['正在检查…', ''], expired: ['登录已过期', 'w'], offline: ['未连接', 'w'] }[w.state] || ['未连接', 'w'];
    const rows = [['WeLink', wl[0] + (w.detail && w.state !== 'online' && w.detail !== wl[0] ? `：${w.detail}` : ''), wl[1]],
      ['模型账号', g.ok ? g.label || '已就绪' : `未就绪${g.label ? `：${g.label}` : ''}`, g.ok ? 'g' : 'r'],
      ['群名单', Number.isFinite(p.groupsCount) ? (p.groupsCount ? `已读到 ${p.groupsCount} 个群` : '还没读到群') : '还没读到', p.groupsCount ? 'g' : 'w']];
    // 模型没就绪时，修复按钮就放在这一行旁边（开箱即用：不让用户自己去找设置）。
    const fix = { 模型账号: g.ok ? '' : '<button class="avx-btn s" data-av="fix" data-kind="open_model_settings">去配置模型</button>' };
    return `<div class="avx-pf">${rows.map(([k, v, c]) => `<div><i class="avx-dot ${c}"></i><b>${k}</b><span title="${esc(v)}">${esc(v)}</span>${fix[k] || ''}</div>`).join('')}${p.checkedAt ? `<small>${when(p.checkedAt)} 自检</small>` : ''}</div>`;
  }
  const CAN = '这里创建你自己的提醒 / 起草分身，你点了才发，不会自动发言；群里运营的答疑分身是另一套服务。';
  function main() {
    if (!data || (checking && !data.avatars?.length)) return '<div class="avx-empty"><p class="avx-m">正在检查 WeLink 与模型环境…</p></div>';
    if (!data.available) {
      if (data.missing) return `<div class="avx-empty"><h2>分身暂时用不了</h2><p>${esc(data.reason)}</p></div>`;
      const login = welinkNeedsLogin();
      return `<div class="avx-empty"><h2>${login ? 'WeLink 需要登录，扫一下码就能用' : '分身还没准备好'}</h2><p>${esc(data.reason)}</p>${preflightList()}<div class="avx-line">${login ? '<button class="avx-btn p" data-av="scan">就地扫码登录</button>' : ''}<button class="avx-btn" data-av="relogin">重新检查</button></div><p class="avx-m">${CAN}</p></div>`;
    }
    if (!data.avatars.length) return `<div class="avx-empty"><h2>让第一个分身替你盯消息</h2><p>${pf() ? '下面是刚刚自检的结果；选一个最接近的用途，之后什么都能改。' : '选一个最接近的用途，之后什么都能改。'}</p>${preflightList()}<div class="avx-tpls">${TEMPLATES.map(tplCard).join('')}</div><p class="avx-m">${CAN}</p></div>`;
    return `<div class="avx-main">${list()}${detail()}</div>`;
  }
  const tplCard = ([k, n, d, m]) => `<button class="avx-tpl" data-av="tpl" data-t="${k}"><b>${n}</b><span>${d}</span><small>${m}</small></button>`;
  function list() {
    const total = data.items.length + extList().length;
    return `<aside class="avx-list" aria-label="分身列表"><button class="avx-row ${sel === 'all' ? 'on' : ''}" data-av="sel" data-id="all"><div class="n"><span>全部待确认</span>${total ? `<b>${total}</b>` : ''}</div><small>所有分身交给你的事</small></button><hr>
      <div class="avx-rows" data-sc="av">${data.avatars.map(a => `<button class="avx-row ${sel === a.id ? 'on' : ''}" data-av="sel" data-id="${esc(a.id)}"><div class="n"><i class="avx-dot ${dotOf(a)}" title="${esc(a.state.text)}"></i><span>${esc(a.name)}</span>${a.pending ? `<b>${a.pending}</b>` : ''}</div><small>${esc(scopeText(a))}</small><small>${esc(modeText(a))} · 今日处理 ${a.stats.model} 条</small></button>`).join('')}</div>
      <p class="avx-foot">每个分身是一个独立会话，在左侧「后台任务」里也能看到。</p></aside>`;
  }
  const dotOf = a => ({ on: 'g', waiting: 'w', error: 'r', paused: 'r' }[a.state.code] || '');
  function detail() {
    if (sel === 'all') return `<section class="avx-detail"><div class="avx-dh line"><h2>全部待确认</h2><span class="avx-ch">${data.items.length + extList().length} 条</span></div><div class="avx-body">${inbox(null)}</div></section>`;
    const a = cur(), tabs = [['inbox', '待确认'], ['try', '试答'], ['learn', '它学到的'], ['log', '运行记录'], ['scope', '生效范围'], ['ctx', '上下文'], ['back', '后端与前缀']];
    const body = { inbox: () => inbox(a), try: () => tryTab(a), learn: () => learnTab(a), log: () => logs(a), scope: () => scope(a), ctx: () => context(a), back: () => backend(a) }[tab]();
    return `<section class="avx-detail"><div class="avx-dh"><h2>${esc(a.name)}</h2><span class="avx-ch ${{ on: 'g', error: 'r', paused: 'r', waiting: 'w' }[a.state.code] || ''}">${esc(a.state.text)}</span><span class="avx-ch b">${esc(modeText(a))}</span>
      <div class="avx-right">${backstage.backstageButtonHtml({ sessionId: a.session?.id || '', from: 'avatar' })}<button class="avx-btn s" data-av="toggle">${a.enabled ? '暂停这个分身' : '恢复'}</button><button class="avx-btn s d" data-av="remove">删除</button></div></div>
      ${a.state.failure ? failureBox(a.state.failure, 'av:' + a.id, true, a.session?.id || '') : a.state.error && !data.activeFailure ? `<div class="avx-bn r slim">${esc(a.state.error)}${backstage.backstageLinkHtml({ sessionId: a.session?.id || '', from: 'avatar' })}${a.state.providerRepair ? a.state.providerRepair.canUseManual ? `<button class="avx-btn s" data-av="repair-provider" data-account="${esc(a.state.providerRepair.account)}">改用手动会话在用的供应商</button>` : '<button class="avx-btn s" data-av="provider-settings">选择模型与供应商</button>' : ''}</div>` : ''}
      <nav class="avx-tabs">${tabs.map(([k, n]) => `<button class="${tab === k ? 'on' : ''}" data-av="tab" data-k="${k}">${n}${k === 'inbox' && a.pending ? `<em>${a.pending}</em>` : ''}</button>`).join('')}</nav><div class="avx-body ${tab === 'log' ? 'col' : ''}">${body}</div></section>`;
  }
  // 正在排队 / 生成 / 重写的事项：点了「让分身重写」以后这里一直有进度，不再闪一句话就没影。
  const STAGE_NAME = { queued: '排队中', read: '读消息', route: '判断归属', context: '找依据', draft: '生成中' };
  function progress(a) {
    const rows = (data.inProgress || []).filter(p => !a || p.avatarId === a.id);
    return rows.map(p => `<div class="avx-it prog"><b><i class="avx-dot b"></i>${esc(p.convName || '处理中')}<em>已用 <span data-since="${Number(p.since) || 0}">${span(Date.now() - (Number(p.since) || Date.now())) || '0 秒'}</span></em></b><span>${esc(p.question || '')}</span><small>${STAGE_NAME[p.stage] || '处理中'}${p.queuePos ? ` · 前面还有 ${p.queuePos} 条` : ''}</small></div>`).join('');
  }
  function inbox(a) {
    // 群分身转交只在「全部待确认」顶部出现；没有外部条目时这一组完全不画。
    const ext = a ? [] : [...extList(), ...extKept()], own = data.items.filter(i => !a || i.avatarId === a.id), rows = [...ext, ...own], scopeKey = a?.id || 'all', prog = progress(a);
    // 空态给一个醒目的试答入口：新建完不用干等真实消息，先挑几道题看看分身怎么答。「全部」视图只有一个分身时直达它。
    const tryTo = a ? `<button class="avx-btn p" data-av="tab" data-k="try">先试答几道题看看效果</button>` : data.avatars.length === 1 ? `<button class="avx-btn p" data-av="try-go" data-id="${esc(data.avatars[0].id)}">先试答几道题看看效果</button>` : '';
    if (!rows.length) return `<div class="avx-empty"><h2>没有待确认的消息</h2><p>${prog ? '下面这些正在处理，好了会出现在这里；写不出也会说明原因。' : a?.working ? `分身正在处理 ${a.working} 条，好了会出现在这里。` : '新的草稿和提醒会出现在这里。'}</p>${prog ? `<div class="avx-card ls avx-progbox">${prog}</div>` : ''}${tryTo ? `<div class="avx-try-cta">${tryTo}<span class="avx-m">挑近期真实问题或示例题，看分身会怎么答；试答不会发到群里。</span></div>` : ''}</div>`;
    const it = rows.find(r => keyOf(r) === itemSel[scopeKey]) || rows[0]; itemSel[scopeKey] = keyOf(it);
    const key = keyOf(it), text = edits[key] ?? it.draft ?? '', leader = (it.flags || []).some(f => f === 'leader' || f === 'leader-present'), remind = it.state === 'remind', fx = fixes[key];
    const rowBtn = r => `<button class="avx-it ${keyOf(r) === key ? 'on' : ''}${r.external ? ' ext' : ''}" data-av="item" data-k="${esc(scopeKey)}" data-id="${esc(keyOf(r))}"><b>${esc(r.who)}${(r.flags || []).includes('leader') ? '<span class="avx-ch r">上级</span>' : ''}${r.external ? `<span class="avx-ch w">${esc(r.kind === 'promise' ? '承诺待回收' : `把握 ${r.confidence || 0}`)}</span>` : r.failure ? '<span class="avx-ch w">没写成</span>' : r.lowConfidenceFallback ? '<span class="avx-ch w">依据不足</span>' : ''}${r.correctedCardId || r.resolved ? '<span class="avx-ch b">已纠错</span>' : ''}<em>${when(r.at)}</em></b><span>${esc(r.text)}</span><small>${r.external ? esc(r.convName) + ' · 群分身转交' : `${esc(r.avatarName)} · ${r.state === 'remind' ? '提醒' : '起草'}`} · ${waited(r.since || r.at)}</small></button>`;
    const listHtml = ext.length ? `<div class="avx-grp">群分身转交<em>${ext.length}</em></div>${ext.map(rowBtn).join('')}${own.length || prog ? '<div class="avx-grp">分身待确认</div>' : ''}${prog}${own.map(rowBtn).join('')}` : prog + own.map(rowBtn).join('');
    const head = `<div class="avx-line"><h3>${esc(it.who)}</h3><span class="avx-m">${esc(it.group ? it.convName : '私聊')} · ${when(it.at)} · ${it.external ? '群分身转交' : `来自「${esc(it.avatarName)}」`}</span>${it.external ? `<span class="avx-ch w">${esc(extTag(it))}</span>` : ''}${(it.flags || []).includes('leader') ? '<span class="avx-ch r">回上级</span>' : (it.flags || []).includes('leader-present') ? '<span class="avx-ch r">群里有上级</span>' : ''}${it.external ? '' : it.lowConfidenceFallback ? '<span class="avx-ch w">依据不足，转你处理</span>' : it.confidence ? `<span class="avx-ch">把握 ${it.confidence}</span>` : ''}</div>`;
    const extra = it.external ? '' : `${reassignLine(it, key)}${maybeLine(it)}${failureBox(it.failure, 'it:' + key, true)}`;
    const why = it.why ? `<p class="avx-m"><b>为什么交给你：</b>${esc(it.why)}</p>` : '';
    const basis = it.basis ? `<p class="avx-m"><b>依据：</b>${markCards(esc(it.basis))}</p>` : '';
    let foot;
    if (fx) foot = fixPanel(it, key, fx, text);
    else if (it.external) foot = `${it.draft ? `<label class="avx-lb">群分身在群里的草稿</label><div class="avx-q dim">${esc(it.draft)}</div>` : `<div class="avx-note"><span>${it.kind === 'promise' ? '群分身在群里答应了「确认后再回」，等你给出正确说法。' : '群分身没写出草稿。'}</span></div>`}
      <div class="avx-line act"><button class="avx-btn p" data-av="fix-open" data-key="${esc(key)}">答错了，这样改</button><span class="avx-m">纠正只记在本地，不自动替群分身发群。</span></div>`;
    else if (remind) foot = `<div class="avx-line act"><button class="avx-btn p" data-av="done" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">知道了</button><button class="avx-btn" data-av="redraft" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">让分身起草一条</button><button class="avx-btn" data-av="drop" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">不用管</button></div>`;
    else foot = `<label class="avx-lb" for="avx-draft">草稿，可以直接改</label><textarea id="avx-draft" class="avx-ta" rows="5" data-edit="${esc(key)}">${esc(text)}</textarea>
      <p class="avx-hint" id="avx-risk">${ack[key] ? esc(ackNote[key] || '这句话在向上级应承一件事。确认无误就点「确认发送」。') : leader && COMMIT_HINT.test(text) ? '这句话可能在向上级应承一件事，请确认后再发。' : ''}</p>
      <div class="avx-line act"><button class="avx-btn p" data-av="send" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}" data-key="${esc(key)}" ${busy ? 'disabled' : ''}>${ack[key] ? '确认发送' : busy === '正在发送' ? '正在发送…' : '发送'}</button><button class="avx-btn fixb" data-av="fix-open" data-key="${esc(key)}">答错了，这样改</button><button class="avx-btn" data-av="redraft" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">让分身重写</button><button class="avx-btn" data-av="remind-only" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">改成只提醒</button><button class="avx-btn" data-av="drop" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">丢弃</button><span class="avx-m">${it.prefixed ? `发出时带「🤖【${esc(it.prefix)}】」` : '以你本人名义发出，不带前缀'}</span></div>`;
    return `<div class="avx-split"><div class="avx-card ls" data-sc="il">${listHtml}</div>
      <div class="avx-card scroll" data-sc="id">${head}<div class="avx-q">${esc(it.text)}</div>${extra}${fx ? '' : why + basis}${foot}</div></div>`;
  }
  // 回复对象：「回的是哪条」+「改成回别的消息」「不是问我的，忽略」。候选是同群近期别的提问（主进程给就列，没给就友好说明）。
  const candOf = it => (Array.isArray(it.targetCandidates) ? it.targetCandidates : Array.isArray(it.candidates) ? it.candidates : []).filter(c => c && (c.msgKey || c.key));
  function reassignLine(it, key) {
    const rt = it.replyTarget;
    if (!rt && !it.group) return '';
    const who = rt ? `${esc(rt.sender || it.who)} ${rt.at ? when(rt.at) : ''} 这条「${esc(String(rt.snippet || '').slice(0, 60))}」` : '上面这条提问';
    const open = retargetOpen[key], cands = candOf(it);
    const pick = open ? `<div class="avx-cands">${cands.map((c, n) => `<button class="avx-it" data-av="retarget-pick" data-key="${esc(key)}" data-n="${n}"><b>${esc(c.sender || '同事')}<em>${c.at ? when(c.at) : ''}</em></b><span>${esc(c.text || c.snippet || '')}</span></button>`).join('')}<div class="avx-line"><span class="avx-m">点一条，分身改回那条并重新起草</span><button class="avx-btn s avx-push" data-av="retarget-close" data-key="${esc(key)}">收起</button></div></div>` : '';
    return `<div class="avx-tgt"><span class="avx-m"><b>回的是：</b>${who}</span><span class="avx-tgt-a"><button class="avx-lk" data-av="retarget-open" data-key="${esc(key)}">改成回别的消息</button><button class="avx-lk" data-av="not-me" data-key="${esc(key)}">不是问我的，忽略</button></span></div>${pick}`;
  }
  function maybeLine(it) {
    const ma = it.maybeAnswered;
    return ma ? `<div class="avx-note"><span>你可能已经回过：${esc(ma.by || '你')} ${ma.at ? when(ma.at) : ''} 说「${esc(String(ma.snippet || '').slice(0, 60))}」，但没有引用这条提问，所以没有自动结案。</span><button class="avx-btn s" data-av="answered" data-a="${esc(it.avatarId)}" data-i="${esc(it.id)}">确实已回答，结案</button></div>` : '';
  }
  // 就地纠偏三段：填写（错因 + 正确说法 + 保存前预览）→ 保存并重答中 → 结果（新旧并排 / 卡已存但重答没成功 / 卡已存、重写排队中）。
  const fixPreview = fx => `将存为本分身纠错卡（${FIX_LOCAL}）：${fx.reason ? `错因「${reasonName(fx.reason)}」` : '先选错在哪'}${String(fx.text || '').trim() ? `，以后这类问题按「${String(fx.text).trim().slice(0, 80)}」答` : '，再写正确说法'}。`;
  function fixPanel(it, key, fx, text) {
    const k = esc(key), card = fx.card, no = card ? esc(cardNo(card)) : '';
    const close = `<button class="avx-x big" data-av="fix-close" data-key="${k}" aria-label="收起" ${fx.saving ? 'disabled' : ''}>×</button>`;
    if (fx.mode === 'compare') {
      const r = fx.result || {}, b = (Array.isArray(r.basis) ? r.basis : r.basis ? [r.basis] : []).filter(Boolean);
      const chips = [`<span class="avx-ch hit">你的纠错卡 #${no}</span>`, ...b.filter(x => !(card && String(x).includes(card.id))).map(x => `<span class="avx-ch ${/纠错卡/.test(x) ? 'hit' : 'b'}" title="${esc(x)}">${esc(String(x).slice(0, 24))}</span>`)].join('');
      const adopt = it.external ? `<span class="avx-m">本地记录已纠正（纠错卡 #${no}），不自动替群分身发群。</span>` : `<button class="avx-btn p" data-av="fix-adopt" data-key="${k}">采用新稿</button><button class="avx-btn" data-av="fix-keep" data-key="${k}">保留原稿</button><span class="avx-m">采用后填回草稿框，仍由你点发送。</span>`;
      return `<div class="avx-fix"><div class="avx-line"><h3>按纠错卡重写好了</h3><span class="avx-ch g">纠错卡 #${no} 已保存</span>${r.confidence ? `<span class="avx-ch">把握 ${Number(r.confidence) || 0}</span>` : ''}${close}</div>
        <div class="avx-cmp"><div><label class="avx-lb">原来的稿</label><div class="avx-q dim" data-cmp="old">${esc(fx.oldText || '（原来没有草稿）')}</div></div><div><label class="avx-lb">按你的纠正重写</label><div class="avx-q new" data-cmp="new">${esc(r.draft || '')}</div></div></div>
        <div class="avx-line"><span class="avx-m">新依据</span>${chips}</div>${r.why ? `<p class="avx-m">${markCards(esc(r.why))}</p>` : ''}<div class="avx-line act">${adopt}</div></div>`;
    }
    if (fx.mode === 'failed') return `<div class="avx-fix"><div class="avx-line"><h3>纠错卡已保存在本机，重答暂未成功</h3><span class="avx-ch g">纠错卡 #${no} 已保存</span>${close}</div>
      <p class="avx-m">你的纠正没有丢：下次分身遇到这类问题会按它答。修好下面的问题后可以只重答这一条。</p><div data-fixredo="${k}">${failureBox({ ...fx.failure, retryAfterMs: 0 }, 'fix:' + key, true)}</div>
      <div class="avx-line act">${it.external || (fx.failure?.actions || []).some(x => x.kind === 'retry_tick') ? '' : `<button class="avx-btn" data-av="fix-redo" data-key="${k}">只重答这一条</button>`}<span class="avx-m">${it.external ? '本地记录已纠正，不自动替群分身发群。' : '重答不会重新跑整轮巡检。'}</span></div></div>`;
    if (fx.mode === 'saved') return `<div class="avx-fix"><div class="avx-line"><h3>纠错卡 #${no} 已保存</h3>${close}</div><p class="avx-m">${it.external ? '本地记录已纠正，不自动替群分身发群。' : '分身正在按新纠错卡重写这条，写好会回到草稿框；写不出也会说明原因。'}</p></div>`;
    const ph = FIX_PH[fx.reason] || '写出你认为正确的说法或标准口径，比如：在纪要页右上角选导出，格式选 Word';
    return `<div class="avx-fix"><div class="avx-line"><h3>答错了，这样改</h3><span class="avx-m">只纠这个分身，存成纠错卡后以后同类问题优先按它答</span>${close}</div>
      ${String(text || '').trim() ? `<label class="avx-lb">它原来这样答</label><div class="avx-q dim clamp">${esc(text)}</div>` : ''}
      <label class="avx-lb">错在哪</label><div class="avx-chips">${FIX_REASONS.map(([r, n]) => `<button class="avx-pk ${fx.reason === r ? 'on' : ''}" data-av="fix-reason" data-key="${k}" data-k="${r}" ${fx.saving ? 'disabled' : ''}>${n}</button>`).join('')}</div>
      <label class="avx-lb" for="avx-fix-text">正确说法</label><textarea id="avx-fix-text" class="avx-ta" rows="3" maxlength="1000" data-fix-text="${k}" placeholder="${esc(ph)}" ${fx.saving ? 'disabled' : ''}>${esc(fx.text || '')}</textarea>
      <p class="avx-fix-pv" id="avx-fix-pv">${esc(fixPreview(fx))}</p>
      ${fx.saving ? `<div class="avx-bar" role="progressbar" aria-label="正在保存并重答"><i></i></div><p class="avx-m">正在保存纠错卡并按它重答 · 已用 <span data-since="${fx.saving}">${span(Date.now() - fx.saving) || '0 秒'}</span>，一般十几秒到半分钟。</p>` : ''}
      ${fx.err ? `<p class="avx-m r">${esc(fx.err)}</p>` : ''}
      <div class="avx-line act"><button class="avx-btn p" data-av="fix-save" data-key="${k}" ${fx.saving || !fx.reason || !String(fx.text || '').trim() ? 'disabled' : ''}>${fx.saving ? '正在保存…' : '保存并重答'}</button><button class="avx-btn" data-av="fix-close" data-key="${k}" ${fx.saving ? 'disabled' : ''}>取消</button></div></div>`;
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
    // 指定目标多了翻页，不靠卡片裁切把后面的目标藏掉。
    const tpage = paginate(a.targets, scopePage, 4);
    const groups = targets?.groups || [], people = targets?.people || [], picked = id => a.targets.some(t => t.id === id), all = [...groups, ...people];
    const pick = (rows, title) => `<h3>${title}</h3>${rows.length ? rows.map(x => `<label class="avx-li ck"><span><input type="checkbox" data-chg="target" data-id="${esc(x.id)}" ${picked(x.id) ? 'checked' : ''}> ${esc(x.name)}</span>${x.leader ? '<span class="avx-ch r">上级</span>' : ''}<small>${esc(x.title || (x.count ? `最近 ${x.count} 条` : ''))}</small></label>`).join('') : `<p class="avx-m">${targetsLoading && !targets ? '正在读取…' : '还没有读到，稍后再看。'}</p>`}`;
    return `<div class="avx-c2"><div class="avx-stack"><div class="avx-card"><h3>在哪里生效</h3><div class="avx-seg">${KINDS.map(([k, n]) => `<button class="${a.kind === k ? 'on' : ''}" data-av="kind" data-k="${k}">${n}</button>`).join('')}</div>
      ${a.kind === 'pick' ? `<table class="avx-t mt"><colgroup><col><col style="width:172px"><col style="width:104px"></colgroup><tr><th>目标</th><th>归属</th><th>动作</th></tr>${a.targets.length ? tpage.rows.map(t => `<tr><td title="${esc(t.name)}">${esc(t.name)}</td><td title="${esc(a.owners[t.id]?.text)}">${esc(a.owners[t.id]?.text)}</td><td class="vis">${actionSelect(t.action, `data-chg="target-action" data-id="${esc(t.id)}"`)}</td></tr>`).join('') : '<tr><td colspan="3">在右侧勾选群或人</td></tr>'}</table>${tpage.pages > 1 ? `<div class="avx-line mt"><span class="avx-m">第 ${tpage.at + 1} / ${tpage.pages} 页，共 ${a.targets.length} 个</span><button class="avx-btn s" data-av="scope-page" data-d="-1" ${tpage.at ? '' : 'disabled'}>上一页</button><button class="avx-btn s" data-av="scope-page" data-d="1" ${tpage.at < tpage.pages - 1 ? '' : 'disabled'}>下一页</button></div>` : ''}` : `<div class="avx-line mt"><span class="avx-m">这个范围里的动作</span><div class="w120">${actionSelect(a.action, 'data-chg="action"')}</div></div>`}</div>
      <div class="avx-card"><h3>听谁的</h3><label class="avx-line"><input type="checkbox" data-chg="at" ${a.atOnly ? 'checked' : ''}> 群里只响应 @我</label>${chips(a, 'only', '只听这些人（不选就是所有人）', people)}${chips(a, 'skip', '不看这些群或人', all)}</div>
      <div class="avx-card grow tint scroll"><h3>这样设置后</h3><p>${esc(scopeSummary(a))}</p><p class="avx-m">Beta 阶段不会自动发言。人事、密码、审批类消息只提醒，不交给模型。</p></div></div>
      <div class="avx-card scroll" data-sc="pk">${a.kind === 'pick' ? targetsBar() + pick(groups, '最近的群') + '<div class="gap"></div>' + pick(people, '最近联系的人') : '<h3>范围说明</h3><p class="avx-m">新建的群和新联系人会自动进入这个范围。</p><p class="avx-m">全部类范围跟随助理的消息刷新；想要更快响应，改成指定群或人，会每 ' + (span(data?.health?.hotIntervalMs) || '30 秒') + ' 读取一次。</p><p class="avx-m">一条消息只归一个分身：指定的人优先于指定的群，指定的优先于全部。</p>'}</div></div>`;
  }
  function context(a) {
    const people = targets?.people || [];
    return `<div class="avx-c3"><div class="avx-stack"><div class="avx-card grow col"><h3>人设<small>它以什么身份、怎么说话</small></h3><textarea class="avx-ta grow" data-save="persona" placeholder="留空时使用默认说法">${esc(a.persona)}</textarea><div class="avx-line mt"><button class="avx-btn s" data-av="persona">从我的发言重新生成</button>${personaNotes[a.id] ? `<span class="avx-m" id="avx-persona-note">${esc(personaNotes[a.id])}</span>` : ''}</div></div>
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
  // ---- 试答（第 2 批）：只读近期问题、调模型生成一条模拟答复，不写待确认、不改游标、不进发送队列 ----
  async function loadTryout(id, force = false) {
    const t = tryOf(id);
    if (t.loading || (t.loaded && !force)) return;
    t.loading = true; t.error = ''; if (isOpen()) render();
    try {
      const r = await call('tryout-samples', { avatarId: id });
      t.samples = Array.isArray(r.samples) ? r.samples : [];
      const fresh = Array.isArray(r.history) ? r.history : [];
      // 刚试答完、后端历史还没带上的那条不丢。
      t.history = [...t.history.filter(h => !fresh.some(x => x.id === h.id)), ...fresh].sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 30);
      t.loaded = true;
    } catch (e) {
      t.error = /No handler registered/i.test(e?.message || '') ? '这个版本的 Hub 还不支持试答，升级到新版本后就能用。' : (e?.message || '没读到近期问题');
    } finally { t.loading = false; if (isOpen() && !typing()) render(); }
  }
  async function runTryout(id, q) {
    const t = tryOf(id);
    if (t.running) return;
    const question = String(q.question || '').trim();
    if (!question) { t.hint = '先在下面写一句想问的话，再点试答。'; render(); return; }
    if (q.kind === 'dm' && !t.consent[q.sampleId]) { t.hint = TRY_CONSENT_HINT; render(); return; }
    const seq = ++t.seq;
    Object.assign(t, { hint: '', failure: null, pick: null, verdict: '', note: '', rateMsg: '', rateErr: '', lastQ: { ...q, question }, running: { question, kind: q.kind, convName: q.convName || '', since: Date.now() } });
    render();
    let r = null;
    try {
      r = await ipcRenderer.invoke('avatar:tryout-run', { avatarId: id, question, sampleId: q.sampleId || undefined, kind: q.kind, convName: q.convName || undefined, explicitPrivateConsent: q.kind === 'dm' && !!t.consent[q.sampleId] });
    } catch (e) {
      r = { ok: false, error: /No handler registered/i.test(e?.message || '') ? '这个版本的 Hub 还不支持试答，升级到新版本后就能用。' : (e?.message || '试答没成功，请重试') };
    }
    if (seq !== t.seq) return; // 期间又点了别的试答：旧结果丢掉
    t.running = null;
    if (!r || r.ok === false || !r.result) {
      // 模型没就绪、私聊没同意等：直接用第 1 批的结构化报错渲染人话 + 就地修复按钮，不伪造答案。
      t.failure = r?.failure || { severity: 'error', headline: r?.error || '试答没成功，请重试', retryable: true, actions: [] };
    } else {
      const res = { ...r.result, question: r.result.question || question };
      t.history = [res, ...t.history.filter(h => h.id !== res.id)].slice(0, 30);
      t.pick = res.id; t.verdict = res.verdict || '';
      if (q.kind === 'own') t.ask = '';
    }
    if (isOpen()) render();
  }
  async function rateTryout(id) {
    const t = tryOf(id), entry = t.history.find(h => h.id === t.pick);
    if (!entry || !t.verdict || t.rating) return;
    const note = t.note.trim(), before = Number(avatar(id)?.examples) || 0;
    t.rating = true; t.rateMsg = ''; t.rateErr = ''; render();
    try {
      const r = await call('tryout-rate', { avatarId: id, tryoutId: entry.id, verdict: t.verdict, ...(note ? { note } : {}) });
      const next = { ...entry, ...(r.entry || {}), verdict: r.entry?.verdict || t.verdict, note: r.entry?.note ?? note };
      t.history = t.history.map(h => (h.id === next.id ? next : h));
      const n = Number(r.examples), av = avatar(id);
      if (av && Number.isFinite(n)) av.examples = n;
      // 只有范例数真的变多才说「已存入」；短备注、敏感词被过滤等没新增时如实说明。
      const now = Number.isFinite(n) ? n : before;
      t.rateMsg = now > before ? `已存入分身本地范例（现有 ${now} 条）` : `已记录这次评价（参考范例仍为 ${now} 条，补充一句具体改法后会记进范例）`;
      t.note = '';
    } catch (e) { t.rateErr = e.message || '评价没存上，请重试'; } finally { t.rating = false; if (isOpen()) render(); }
  }
  async function tryAct(op, b) {
    const a = cur(); if (!a) return;
    const t = tryOf(a.id);
    if (op === 'try-reload') { await loadTryout(a.id, true); return; }
    if (op === 'try-run') { const s = t.samples.find(x => x.id === b.dataset.id); if (s) await runTryout(a.id, { question: s.question, sampleId: s.id, kind: s.kind, convName: s.convName }); return; }
    if (op === 'try-ask') { const el = root.querySelector('[data-try-ask]'); if (el) t.ask = el.value; await runTryout(a.id, { question: t.ask, kind: 'own' }); return; }
    if (op === 'try-again') { if (t.lastQ) await runTryout(a.id, t.lastQ); return; }
    if (op === 'try-pick') { const h = t.history.find(x => x.id === b.dataset.id); if (h && !t.running) Object.assign(t, { pick: h.id, failure: null, hint: '', verdict: h.verdict || '', note: '', rateMsg: '', rateErr: '' }); render(); return; }
    if (op === 'try-verdict') { t.verdict = b.dataset.k; t.rateMsg = ''; t.rateErr = ''; render(); return; }
    if (op === 'try-rate') { await rateTryout(a.id); }
  }
  function tryTab(a) {
    const t = tryOf(a.id), off = t.running ? 'disabled' : '';
    const triedQ = new Set(t.history.map(h => String(h.question || '').trim()));
    const sample = s => {
      const [tag, cls] = TRY_TAG[s.kind] || TRY_TAG.example, dm = s.kind === 'dm', ok = !!t.consent[s.id];
      return `<div class="avx-it ts${t.running?.question === s.question ? ' on' : ''}"><b><span class="avx-ch ${cls}">${tag}</span>${s.convName ? `<small title="${esc(s.convName)}">${esc(s.convName)}</small>` : ''}${triedQ.has(String(s.question || '').trim()) ? '<span class="avx-ch g">已试答</span>' : ''}<em>${s.at ? when(s.at) : ''}</em></b><p title="${esc(s.question)}">${esc(s.question)}</p>
        <div class="avx-line">${dm ? `<label class="avx-ck"><input type="checkbox" data-chg="try-consent" data-id="${esc(s.id)}" ${ok ? 'checked' : ''}> 同意送模型试答</label>` : ''}<button class="avx-btn s${dm && !ok ? '' : ' p'}" data-av="try-run" data-id="${esc(s.id)}" ${off}>试答</button></div></div>`;
    };
    const listBody = t.loading && !t.samples.length ? '<p class="avx-m avx-pad">正在读取近期问题…</p>'
      : t.error ? `<div class="avx-pad"><p class="avx-m">${esc(t.error)}</p><button class="avx-btn s" data-av="try-reload">重试</button></div>`
      : t.samples.length ? t.samples.map(sample).join('') : '<p class="avx-m avx-pad">还没有可用的问题，在下面自己问一句。</p>';
    const vName = k => (VERDICTS.find(v => v[0] === k) || [])[1] || '已评';
    const his = t.history.length ? `<h3 class="mt">最近试答<small>${t.history.length} 条，点开看结果</small></h3><div class="avx-try-his" data-sc="th">${t.history.map(h => `<button class="avx-it ${h.id === t.pick ? 'on' : ''}" data-av="try-pick" data-id="${esc(h.id)}" ${off}><b>${h.verdict ? `<span class="avx-ch ${h.verdict === 'like' ? 'g' : 'w'}">${esc(vName(h.verdict))}</span>` : ''}<span>${esc(h.question)}</span><em>${when(h.at)}</em></b></button>`).join('')}</div>` : '';
    const left = `<div class="avx-card col"><h3>选一道题试答<small>近期问题，不够时补示例题</small></h3><div class="avx-try-list" data-sc="ts">${listBody}</div>${his}
      <label class="avx-lb" for="avx-try-ask">自己问一句</label><div class="avx-try-ask"><input id="avx-try-ask" class="avx-in" maxlength="300" data-try-ask placeholder="比如：会议纪要怎么导出成 Word？" value="${esc(t.ask)}"><button class="avx-btn p" data-av="try-ask" ${off}>试答</button></div></div>`;
    const shown = t.history.find(h => h.id === t.pick), q = t.running || t.lastQ;
    const qline = x => `<div class="avx-line"><h3>试答</h3>${x.kind && TRY_TAG[x.kind] ? `<span class="avx-ch ${TRY_TAG[x.kind][1]}">${TRY_TAG[x.kind][0]}</span>` : x.kind === 'own' ? '<span class="avx-ch">自己问的</span>' : ''}${x.convName ? `<span class="avx-m">${esc(x.convName)}</span>` : ''}</div><div class="avx-q">${esc(x.question)}</div>`;
    let body, foot = '';
    if (t.running) body = `${qline(t.running)}<div class="avx-bar" role="progressbar" aria-label="正在试答"><i></i></div><p class="avx-m">分身正在找依据、写答复 · 已用 <span data-since="${t.running.since}">${span(Date.now() - t.running.since) || '0 秒'}</span>，一般十几秒到半分钟。</p>`;
    else if (t.failure) body = `${q ? qline(q) : ''}<div data-tryout="1">${failureBox({ ...t.failure, retryAfterMs: 0 }, 'try:' + a.id, true)}</div><div class="avx-line act"><button class="avx-btn" data-av="try-again">再试一次</button></div>`;
    else if (shown) {
      const low = tryoutLow(shown), conf = Number(shown.confidence) || 0, basis = (shown.basis || []).filter(Boolean);
      const answer = String(shown.answer || '').trim();
      body = `<div class="avx-line"><h3>试答结果</h3>${shown.action && TRY_ACT[shown.action] ? `<span class="avx-ch b">真实运行时${TRY_ACT[shown.action]}</span>` : ''}${low ? '<span class="avx-ch w">依据不足，转你处理</span>' : `<span class="avx-ch ${conf >= 70 ? 'g' : conf >= 40 ? '' : 'w'}">把握 ${conf}</span>`}<span class="avx-m avx-push">耗时 ${span(Number(shown.durationMs) || 0) || '不到 1 秒'}${shown.modelLabel ? ` · ${esc(shown.modelLabel)}` : ''}${shown.at ? ` · ${when(shown.at)}` : ''}</span></div>
        <div class="avx-q">${esc(shown.question)}</div>
        ${answer ? `<label class="avx-lb">分身会这样答（只是试答，不会发出）</label><div class="avx-try-ans">${esc(answer)}</div>` : `<div class="avx-note"><span>${low ? '没有找到可靠依据：真实运行时这类问题会转给你处理，分身不会硬答。' : shown.action === 'skip' ? '分身判断这条不需要回复。' : '这次没有写出答复。'}</span></div>`}
        <div class="avx-line mt"><span class="avx-m">命中依据</span>${basis.length ? basis.map(x => `<span class="avx-ch b" title="${esc(x)}">${esc(String(x).slice(0, 24))}</span>`).join('') : '<span class="avx-m">没有命中</span>'}</div>
        ${basis.length || shown.why ? `<details class="avx-raw" data-raw="tw:${esc(shown.id)}"${rawOpen['tw:' + shown.id] ? ' open' : ''}><summary>展开依据详情与理由</summary><pre>${esc([...basis.map((x, i) => `${i + 1}. ${x}`), shown.why ? `理由：${shown.why}` : ''].filter(Boolean).join('\n'))}</pre></details>` : ''}`;
      const done = shown.verdict ? `已评价：${esc(vName(shown.verdict))}${shown.note ? `，备注「${esc(shown.note)}」` : ''}。可以改评。` : '';
      foot = `<div class="avx-try-rate"><span>这个回答</span><div class="avx-seg">${VERDICTS.map(([k, n]) => `<button class="${t.verdict === k ? 'on' : ''}" data-av="try-verdict" data-k="${k}">${n}</button>`).join('')}</div><input class="avx-in" maxlength="200" data-try-note placeholder="可选：哪里不像、应该怎么答" value="${esc(t.note)}"><button class="avx-btn p" data-av="try-rate" ${!t.verdict || t.rating ? 'disabled' : ''}>${t.rating ? '正在提交…' : '提交评价'}</button></div>
        ${t.rateErr ? `<p class="avx-m r">${esc(t.rateErr)}</p>` : t.rateMsg ? `<p class="avx-m ok" id="avx-rate-msg">${esc(t.rateMsg)}</p>` : done ? `<p class="avx-m">${done}</p>` : '<p class="avx-m">点「像我」或写一句纠偏，会存进分身本地范例，之后真实起草时参考。</p>'}`;
    } else body = `<div class="avx-try-empty"><h3>看看分身会怎么答</h3><p>从左边挑一道近期问题，或自己问一句。</p><p class="avx-m">结果会显示答复、把握和命中的依据，你可以评价「像我」「不像」「有问题」。</p></div>`;
    const right = `<div class="avx-card col"><div class="avx-try-main" data-sc="tr">${t.hint ? `<div class="avx-note w"><span>${esc(t.hint)}</span></div>` : ''}${body}</div>${foot}<p class="avx-try-edge">试答会调用所选模型推理，但绝不发到群、不改游标、不进发送队列。</p></div>`;
    return `<div class="avx-try">${left}${right}</div>`;
  }
  // ---- 就地纠偏（第 3 批）：保存纠错卡 + 同题重答；回包只写回发起的那条事项（按「分身|事项」隔离） ----
  async function saveFix(key) {
    const fx = fixes[key], it = rowOf(key);
    if (!fx || fx.saving || !it) return;
    const correctAnswer = String(fx.text || '').trim();
    if (!fx.reason || !correctAnswer) { fx.err = '先选错在哪，再写正确说法'; render(); return; }
    // 原稿以发起时草稿框里的字为准（含本人没发的改动）；主进程回了 oldDraftSnapshot 就用它。
    const oldText = edits[key] ?? it.draft ?? '';
    Object.assign(fx, { saving: Date.now(), err: '', snap: { ...it } }); render();
    let r = null;
    try {
      r = await call('correct-item', { avatarId: it.avatarId, itemId: it.id, reason: fx.reason, correctAnswer, scope: 'this_avatar', redraft: true, ...(it.external ? { external: true } : {}) });
    } catch (e) {
      fx.saving = 0;
      fx.err = /No handler registered/i.test(e?.message || '') ? '这个版本的 Hub 还不支持纠错卡，升级到新版本后就能用。' : (e?.message || '纠错卡没存上，请重试');
      render(); return;
    }
    if (fixes[key] !== fx) return; // 期间收起了：回包丢掉，但卡已存在后端
    if (r.status) accept(r.status); else accept(r);
    if (it.avatarId && learned[it.avatarId]) learned[it.avatarId].loaded = false;
    const after = [...extList(), ...(data?.items || [])].find(r => keyOf(r) === key);
    Object.assign(fx, { saving: 0, card: r.card || { id: '' }, oldText: after?.oldDraftSnapshot ?? it.oldDraftSnapshot ?? oldText });
    if (r.redraftResult) { fx.mode = 'compare'; fx.result = r.redraftResult; }
    else if (r.redraftFailure) { fx.mode = 'failed'; fx.failure = r.redraftFailure; }
    else fx.mode = 'saved';
    if (it.external) flash(`本地记录已纠正（纠错卡 #${cardNo(fx.card)}），不自动替群分身发群`);
    else if (!after) { delete fixes[key]; flash(`纠错卡 #${cardNo(fx.card)} 已保存（${FIX_LOCAL}）`); }
    render();
  }
  // 重答失败后的「重试」：只重写这一条（avatar:redraft），绝不走正式巡检 avatar:recheck，也不再新建一张纠错卡。
  async function redoFix(key) {
    const it = rowOf(key);
    if (!it || it.external) return;
    if (await run('正在重写', 'redraft', { avatarId: it.avatarId, itemId: it.id })) { if (fixes[key]) fixes[key].mode = 'saved'; delete edits[key]; flash('已交给分身按新纠错卡重写这一条'); render(); }
  }
  async function reassign(key, action, cand) {
    const it = rowOf(key);
    if (!it) return;
    const payload = { avatarId: it.avatarId, itemId: it.id, action, ...(cand ? { targetMsgKey: cand.msgKey || cand.key, targetText: cand.text || cand.snippet || '', targetSender: cand.sender || '' } : {}) };
    const r = await runAny('正在处理', ['reassign-target'], payload).catch(() => null);
    if (!r) { if (/No handler registered/i.test(error)) { error = ''; flash('这个版本的 Hub 还不支持改配回复对象，可以先「丢弃」这条'); render(); } return; }
    delete retargetOpen[key]; delete fixes[key];
    if (action === 'not_for_me') { delete edits[key]; flash('已标记「不是问我的」，这条已从待确认拿掉，不会发任何消息'); }
    else { delete edits[key]; flash(`已改成回 ${cand?.sender || '同事'} 的那条，分身正在重新起草`); }
    render();
  }
  // ---- 「它学到的」页签：纠错卡列表（撤销 / 恢复）+ 它还参考了什么 ----
  async function loadLearned(id, force = false) {
    const l = learnOf(id);
    if (l.loading || (l.loaded && !force)) return;
    l.loading = true; l.error = ''; if (isOpen()) render();
    try {
      const r = await call('corrections-list', { avatarId: id });
      Object.assign(l, { cards: Array.isArray(r.cards) ? r.cards : [], examplesCount: Number.isFinite(Number(r.examplesCount)) ? Number(r.examplesCount) : null, persona: String(r.persona || ''), memoryLines: Number.isFinite(Number(r.memoryLines)) ? Number(r.memoryLines) : null, loaded: true });
    } catch (e) {
      l.error = /No handler registered/i.test(e?.message || '') ? '这个版本的 Hub 还不支持纠错卡，升级到新版本后就能用。' : (e?.message || '没读到纠错卡');
    } finally { l.loading = false; if (isOpen() && !typing()) render(); }
  }
  async function toggleCard(id, cardId) {
    const l = learnOf(id), c = l.cards.find(x => x.id === cardId);
    if (!c || l.busy) return;
    l.busy = cardId; render();
    try {
      const r = await call('correction-toggle', { avatarId: id, cardId, active: !c.active });
      if (Array.isArray(r.cards)) l.cards = r.cards; else if (r.card) l.cards = l.cards.map(x => (x.id === cardId ? r.card : x));
      const now = l.cards.find(x => x.id === cardId);
      flash(now?.active ? `已恢复纠错卡 #${cardNo(c)}，下一条消息起重新参考` : `已撤销纠错卡 #${cardNo(c)}，下一条消息起不再参考；记录保留可恢复`);
    } catch (e) { error = e.message; } finally { l.busy = ''; render(); }
  }
  const LEARN_SIZE = 9;
  function learnTab(a) {
    const l = learnOf(a.id);
    if (l.loading && !l.loaded) return '<div class="avx-try-empty"><p class="avx-m">正在读取纠错卡…</p></div>';
    if (l.error && !l.loaded) return `<div class="avx-try-empty"><p class="avx-m">${esc(l.error)}</p><button class="avx-btn s" data-av="learn-reload">重试</button></div>`;
    const cards = [...l.cards].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)), { rows, at, pages } = paginate(cards, l.page, LEARN_SIZE), on = cards.filter(c => c.active).length;
    const pick = cards.find(c => c.id === l.pick) || rows[0];
    const table = cards.length ? `<div class="avx-card fill flat"><table class="avx-t"><colgroup><col style="width:74px"><col style="width:84px"><col style="width:26%"><col><col style="width:84px"><col style="width:64px"></colgroup><tr><th>卡号</th><th>错因</th><th>原题</th><th>正确说法</th><th>状态</th><th></th></tr>
      ${rows.map(c => `<tr class="ck ${c.id === pick?.id ? 'on' : ''}${c.active ? '' : ' off'}" data-av="learn-pick" data-id="${esc(c.id)}"><td>#${esc(cardNo(c))} <small>v${Number(c.version) || 1}</small></td><td>${esc(reasonName(c.reason))}</td><td title="${esc(c.question)}">${esc(c.question)}</td><td title="${esc(c.correctAnswer)}">${esc(c.correctAnswer)}</td><td><span class="avx-ch ${c.active ? 'g' : ''}">${c.active ? '生效中' : '已撤销'}</span></td><td><button class="avx-btn s${c.active ? ' d' : ''}" data-av="learn-toggle" data-id="${esc(c.id)}" ${l.busy ? 'disabled' : ''}>${l.busy === c.id ? '…' : c.active ? '撤销' : '恢复'}</button></td></tr>`).join('')}</table></div>
      <div class="avx-line"><span class="avx-m">第 ${at + 1} / ${pages} 页，共 ${cards.length} 张</span><button class="avx-btn s" data-av="learn-page" data-d="-1" ${at ? '' : 'disabled'}>上一页</button><button class="avx-btn s" data-av="learn-page" data-d="1" ${at < pages - 1 ? '' : 'disabled'}>下一页</button></div>`
      : '<div class="avx-card fill avx-try-empty"><h3>还没有纠错卡</h3><p>在「待确认」里点草稿下面的「答错了，这样改」，写一句正确说法，它就记住了。</p><p class="avx-m">以后同类问题，纠错卡排在范例和群历史问答前面，优先按它答。</p></div>';
    const detailCard = pick ? `<div class="avx-card grow scroll" data-sc="lc"><div class="avx-line"><h3>纠错卡 #${esc(cardNo(pick))}</h3><span class="avx-m">v${Number(pick.version) || 1}${pick.createdAt ? ` · ${when(pick.createdAt)} 记下` : ''}${!pick.active && pick.revokedAt ? ` · ${when(pick.revokedAt)} 撤销` : ''}</span></div>
      <label class="avx-lb">原题${pick.convName ? ` · ${esc(pick.convName)}` : ''}</label><div class="avx-q">${esc(pick.question || '—')}</div>${pick.oldAnswer ? `<label class="avx-lb">原来答错的稿</label><div class="avx-q dim clamp">${esc(pick.oldAnswer)}</div>` : ''}
      <label class="avx-lb">正确说法 · 错因「${esc(reasonName(pick.reason))}」</label><div class="avx-q new">${esc(pick.correctAnswer || '')}</div></div>` : '';
    const num = n => (n === null ? '—' : String(n));
    const persona = String(l.persona || a.persona || '').trim();
    const summary = `<div class="avx-card"><h3>它还参考了<small>纠错卡优先于这些</small></h3><div class="avx-li"><span>你改过的范例</span><small>${num(l.examplesCount ?? (Number.isFinite(Number(a.examples)) ? Number(a.examples) : null))} 条</small></div><div class="avx-li"><span>群历史问答</span><small>${num(l.memoryLines ?? (Number.isFinite(Number(a.memoryLines)) ? Number(a.memoryLines) : null))} 条</small></div>
      <label class="avx-lb">人设摘要</label><p class="avx-clamp" title="${esc(persona)}">${persona ? esc(persona) : '<span class="avx-m">还没有人设，使用默认说法</span>'}</p></div>`;
    return `<div class="avx-learn"><div class="avx-stack"><div class="avx-line"><h3>纠错卡</h3><span class="avx-m">${cards.length ? `${cards.length} 张，生效中 ${on} 张；点一行看全文` : ''}</span>${l.loading ? '<span class="avx-m">正在刷新…</span>' : ''}</div>${table}</div>
      <div class="avx-stack">${detailCard || '<div class="avx-card grow tint"><h3>纠错卡怎么用</h3><p class="avx-m">每张卡带卡号和版本号；分身起草时引用它，会在依据里写「你的纠错卡 #卡号」。撤销后立刻不再参考，记录保留，可以再恢复。</p></div>'}${summary}<p class="avx-learn-foot">纠错卡只存公司本机该分身目录，默认不外发。</p></div></div>`;
  }
  // ---- 报错条上的修复动作 ----
  async function repairProvider(account, btn) {
    if (btn) btn.disabled = true;
    const r = await ipcRenderer.invoke('company-assistant:set-model-choice', { account: account || 'personal', useManual: true });
    if (!r?.ok) { if (btn) btn.disabled = false; throw new Error(r?.error || '供应商没有切换'); }
    if (cur()?.backend?.model && !(await save({ backend: { ...cur().backend, model: '' } }))) return;
    flash('已改用手动会话成功使用的供应商，下次任务起生效');
  }
  async function fixAction(kind, b) {
    // 试答区的报错：「重试」只重跑这次试答（原问题、样本、同意态都沿用），绝不走正式巡检 avatar:recheck。
    if (kind === 'retry_tick' && b.closest('[data-tryout]')) { await tryAct('try-again', b); return; }
    // 纠错后重答失败的报错：「重试」只重写这一条，也不走正式巡检。
    const redo = b.closest('[data-fixredo]');
    if (kind === 'retry_tick' && redo) { await redoFix(redo.dataset?.fixredo || ''); return; }
    if (kind === 'provider_repair') { await repairProvider(b.dataset.account, b); return; }
    if (kind === 'open_account_card') {
      if (!cur() && data?.avatars?.[0]) sel = data.avatars[0].id;
      if (!cur()) { flash('先建一个分身，账号卡在分身的「后端与前缀」页签里'); render(); return; }
      tab = 'back'; focus = { hl: b.dataset.hl || 'gateway', until: Date.now() + 6000 }; render(); return;
    }
    if (kind === 'open_model_settings') { close(); window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { settingsTab: 'model' } })); return; }
    if (kind === 'welink_login') { void openScan(); return; }
    if (kind === 'retry_tick') { let p = {}; try { p = JSON.parse(b.dataset.payload || '{}') || {}; } catch {} await retryTick(p); return; }
    if (kind === 'open_account_page') { close(); document.getElementById('btn-rail-accounts')?.click(); return; }
    flash('这个修复动作这一版还不支持，请到设置里处理'); render();
  }
  // 「去账号卡换」：切到「后端与前缀」后把对应那一项（部门 API key 行 / 当前 CodeAgent 账号 / 当前模型）滚到眼前并描边，几秒后淡掉。
  function applyFocus() {
    if (!focus || !root) return;
    if (Date.now() > focus.until) { focus = null; return; }
    const pick = focus.hl === 'model' ? '[data-sc="md"] .avx-ac.on' : focus.hl === 'codeagent' ? '[data-sc="ac"] .avx-ac.on:not([data-id="api-gateway"]), [data-sc="ac"] [data-id="auto"]' : '[data-sc="ac"] [data-id="api-gateway"]';
    const el = root.querySelector(pick);
    if (!el) return;
    el.classList.add('avx-focus');
    try { el.scrollIntoView({ block: 'nearest' }); } catch { /* 旧环境没有 scrollIntoView 选项 */ }
  }
  async function openScan(restart = false) {
    scan = { phase: 'starting', flow: null, error: '' }; render();
    try {
      const r = await ipcRenderer.invoke('company-assistant:login', restart ? { restart: true } : {});
      if (!r || r.ok === false) throw new Error(r?.error || '没能开始扫码登录');
      if (!scan) return;
      scan.flow = r.flow || null; scan.phase = 'qr';
      if (scan.flow?.state === 'ok') { await scanDone(); return; }
      clearInterval(scanTimer); scanTimer = setInterval(() => void refreshScan(), 3000); scanTimer.unref?.();
    } catch (e) {
      if (!scan) return;
      scan.phase = 'failed';
      scan.error = /No handler registered/i.test(e?.message || '') ? '这台电脑的助理还没启动，扫码要到助理页做' : (e?.message || '没能开始扫码登录');
    }
    render();
  }
  async function refreshScan() {
    if (!scan || scan.phase === 'failed') return;
    try {
      const s = await ipcRenderer.invoke('company-assistant:status');
      if (!scan) return;
      if (s?.loginFlow) scan.flow = s.loginFlow;
      if (scan.flow?.state === 'ok' || (!s?.loginFlow && s?.login?.ok)) { await scanDone(); return; }
    } catch { /* 下一轮再看 */ }
    if (isOpen()) render();
  }
  async function scanDone() {
    closeScan();
    flash('WeLink 已登录，分身自动接上');
    await runAny('正在检查', RECHECK);
  }
  function closeScan() { clearInterval(scanTimer); scanTimer = null; scan = null; }
  function scanDialog() {
    const f = scan.flow || {}, p = f.progress || {}, failed = scan.phase === 'failed' || f.state === 'failed' || p.phase === 'failed', scanned = !failed && p.phase === 'scanned';
    let qr = '';
    if (!failed && !scanned && f.qr?.kind === 'blocks') qr = `<img class="avx-qr" src="${esc(f.qr.value)}" width="${Number(f.qr.px) || ''}" height="${Number(f.qr.px) || ''}" alt="WeLink 登录二维码">`;
    else if (!failed && !scanned && f.qr?.kind === 'data') qr = `<img class="avx-qr" src="${esc(f.qr.value)}" alt="WeLink 登录二维码">`;
    else if (!failed && !scanned && f.qr?.kind === 'file') qr = `<img class="avx-qr" src="${esc('file:///' + String(f.qr.value).replace(/\\/g, '/'))}" alt="WeLink 登录二维码">`;
    const he = failed ? humanScanError(scan.error || f.error || '') : { head: '', raw: '' };
    const state = failed ? (he.raw ? esc(he.head) : `登录没成功：${esc(he.head || '原因没认出来')}`) : scanned ? '已扫码，正在登录…' : scan.phase === 'starting' || !f.qr ? '正在向 WeLink 要二维码，一般几秒就出来…' : '用手机 WeLink 扫下面的二维码，扫完这里自动接着用。';
    const tick = !failed && !scanned && p.phase === 'waiting' ? `<p class="avx-m">等待扫码 · ${Number(p.elapsed) || 0} 秒</p>` : '';
    return `<div class="avx-ov"><div class="avx-md sm"><div class="avx-mh"><h2>扫码登录 WeLink</h2><button class="avx-x big" data-av="scan-close" aria-label="关闭">×</button></div><div class="avx-mb avx-scan"><p>${state}</p>${qr}${tick}${he.raw ? `<details class="avx-raw" data-raw="scan"${rawOpen.scan ? ' open' : ''}><summary>原始报错</summary><pre>${esc(he.raw)}</pre></details>` : ''}<p class="avx-m">扫码授权的是这台电脑上的 WeLink 命令行，用你本人的身份读消息；不会替你发消息。</p></div>
      <div class="avx-mf"><button class="avx-btn" data-av="scan-assistant">到助理页扫码</button>${failed || f.state === 'finished' ? '<button class="avx-btn p" data-av="scan-restart">重新获取二维码</button>' : '<button class="avx-btn" data-av="scan-restart">换一张码</button>'}</div></div></div>`;
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
    if (op === 'repair-provider') { await repairProvider(b.dataset.account, b); return; }
    if (op === 'sel') { sel = b.dataset.id; tab = 'inbox'; logPage = 0; logPick = -1; scopePage = 0; render(); return; }
    if (op === 'tab') { tab = b.dataset.k; logPage = 0; logPick = -1; scopePage = 0; if (['scope', 'ctx'].includes(tab)) void loadTargets(); if (tab === 'try' && cur()) void loadTryout(sel); if (tab === 'learn' && cur()) void loadLearned(sel, true); render(); return; }
    if (op === 'try-go') { sel = b.dataset.id; tab = 'try'; logPage = 0; logPick = -1; scopePage = 0; void loadTryout(sel); render(); return; }
    if (op.startsWith('try-')) { await tryAct(op, b); return; }
    if (op === 'item') { itemSel[b.dataset.k] = b.dataset.id; render(); return; }
    if (op.startsWith('fix-') || op.startsWith('retarget-') || op === 'not-me' || op.startsWith('learn-')) { await fixAct(op, b); return; }
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
        accept(r); sel = r.createdId; tab = 'inbox'; wiz = null; flash('分身已开始工作。想先看看效果，可以挑几道题试答，不会发到群里。', { op: 'tab', k: 'try', label: '先试答几道题看看效果' });
      } catch (e) { w.step = 2; error = e.message; }
      render(); return;
    }
    if (op === 'feedback') { await openFeedback(); return; }
    if (op === 'pause-all') { await run('正在处理', 'pause-all', { paused: !data.paused }); return; }
    if (op === 'relogin') { await runAny('正在检查', RECHECK); return; }
    if (op === 'retry-tick') { await retryTick(); return; }
    if (op === 'scan') { void openScan(); return; }
    if (op === 'scan-restart') { void openScan(true); return; }
    if (op === 'scan-close') { closeScan(); render(); return; }
    if (op === 'scan-assistant') { closeScan(); close(); window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { loginPanel: true } })); return; }
    if (op === 'fix') { await fixAction(b.dataset.kind, b); return; }
    if (op === 'scope-page') { scopePage = Math.max(0, scopePage + Number(b.dataset.d)); render(); return; }
    // 「你可能已经回过」：本人确认后才结案。统一走 avatar:done 并带 action 标记；旧主进程忽略该字段，效果同样是从待确认里拿掉。
    if (op === 'answered') { if (await runAny('正在处理', ['done'], { ...payload, action: 'confirm-answered' })) { delete edits[`${a}|${i}`]; flash('已按你的确认结案'); } return; }
    if (op === 'toggle') { await save({ enabled: !cur().enabled }); return; }
    if (op === 'remove') { confirmBox = { title: `删除「${cur().name}」？`, body: '它的配置、记忆和待确认事项都会删除，已发出的消息不受影响。', yes: '删除', run: async id => { await run('正在删除', 'remove', { avatarId: id }); }, id: sel }; render(); return; }
    if (op === 'confirm-no') { confirmBox = null; render(); return; }
    if (op === 'confirm-yes') { const c = confirmBox; confirmBox = null; render(); await c.run(c.id); return; }
    if (op === 'open-session') { const r = await call('session', { avatarId: sel }); if (!r.sessionId) { flash('分身会话还没启动，有新消息时会自动启动'); render(); return; } close(); await selectSession(r.sessionId); return; }
    if (op === 'send') {
      const key = b.dataset.key, text = (edits[key] ?? data.items.find(x => keyOf(x) === key)?.draft ?? '').trim();
      if (!text) { error = '草稿是空的'; render(); return; }
      const r = await run('正在发送', 'send', { ...payload, text, ackRisk: !!ack[key] });
      // 回上级应承的二次确认是正常流程：中性提示写在草稿下面，按钮原地变「确认发送」，不用红色报错条。
      if (r?.needAck) { ack[key] = true; ackNote[key] = r.error || ''; error = ''; render(); return; }
      if (r?.ok) { delete edits[key]; delete ack[key]; delete ackNote[key]; flash(r.edited ? '已发送，你的改稿已存为范例' : '已发送', r.canRecall ? { op: 'recall', a, i, label: '撤回' } : null); render(); }
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
    if (op === 'persona') {
      // 记下发起时的分身：生成途中切到别的分身，回包也只写回原来那个（不串分身）。
      const id = sel, r = await run('正在生成', 'persona', { avatarId: id });
      // 后端给了 personaNote 或生成完人设仍是空的：按钮旁留一句灰色说明，不再静默留空。
      if (r) { if (r.personaNote || !String(avatar(id)?.persona || '').trim()) personaNotes[id] = String(r.personaNote || '近期发言较少，暂未能自动归纳，可直接手写'); else { delete personaNotes[id]; if (sel === id) flash('已根据你的发言重新生成'); } }
      render(); return;
    }
    if (op === 'source') { const r = await call('pick-source', { type: b.dataset.t }); if (r.source) { await save({ sources: [...av.sources, r.source] }); flash('已添加，下一条消息开始使用'); render(); } return; }
    if (op === 'source-del') { await save({ sources: av.sources.filter((_, n) => n !== Number(b.dataset.i)) }); return; }
    // 部门 API key（网关）：写「功能使用的 Agent → 分身」那一项（所有分身共用）；点回 CodeAgent 账号时撤掉它。
    if (op === 'account' && b.dataset.id === 'api-gateway') { await setGateway({ kind: 'api-gateway', model: '' }, '已改用部门 API key，下一条消息起生效'); return; }
    if (op === 'account') { if (gatewayStored() && !(await setGateway(null))) return; await save({ backend: { ...av.backend, account: b.dataset.id, model: '' } }); return; }
    if (op === 'model' && gatewayOn()) { await setGateway({ kind: 'api-gateway', model: b.dataset.id }, '已换模型，下一条消息起生效'); return; }
    if (op === 'model') { await save({ backend: { ...av.backend, model: b.dataset.id } }); return; }
    if (op === 'effort') { await save({ backend: { ...av.backend, effort: b.dataset.k } }); }
  }
  async function fixAct(op, b) {
    const key = b.dataset.key || '', fx = fixes[key];
    if (op === 'fix-open') { fixes[key] = { reason: '', text: '', saving: 0, err: '', mode: 'edit' }; delete retargetOpen[key]; render(); return; }
    if (op === 'fix-close') { if (!fx?.saving) delete fixes[key]; render(); return; }
    if (op === 'fix-reason' && fx) { fx.reason = b.dataset.k; fx.err = ''; render(); return; }
    if (op === 'fix-save') { await saveFix(key); return; }
    if (op === 'fix-redo') { await redoFix(key); return; }
    if (op === 'fix-adopt' && fx) { edits[key] = String(fx.result?.draft || ''); delete ack[key]; delete fixes[key]; flash('新稿已填回草稿框，确认后点「发送」'); render(); return; }
    if (op === 'fix-keep' && fx) { edits[key] = String(fx.oldText || ''); delete ack[key]; delete fixes[key]; flash(`已保留原稿；纠错卡 #${cardNo(fx.card)} 仍会用在以后的同类问题`); render(); return; }
    if (op === 'not-me') { await reassign(key, 'not_for_me'); return; }
    if (op === 'retarget-open') {
      const it = rowOf(key);
      if (!it || !candOf(it).length) { flash('同群近期没有别的提问可改选；如果整条都不用回，点「不是问我的，忽略」'); render(); return; }
      retargetOpen[key] = true; render(); return;
    }
    if (op === 'retarget-close') { delete retargetOpen[key]; render(); return; }
    if (op === 'retarget-pick') { const it = rowOf(key), c = it && candOf(it)[Number(b.dataset.n)]; if (c) await reassign(key, 'retarget', c); return; }
    const av = cur(); if (!av) return;
    const l = learnOf(av.id);
    if (op === 'learn-reload') { await loadLearned(av.id, true); return; }
    if (op === 'learn-page') { l.page = Math.max(0, l.page + Number(b.dataset.d)); l.pick = ''; render(); return; }
    if (op === 'learn-pick') { l.pick = b.dataset.id; render(); return; }
    if (op === 'learn-toggle') { await toggleCard(av.id, b.dataset.id); }
  }
  // 「反馈意见」：有选中的分身或问答时，先向主进程要一段脱敏后的现场（版本、分身配置、当前问答摘要、最近报错），预填进通用反馈弹窗，
  const FEEDBACK_BASE = '【分身 Beta 反馈】\n我在用的模板：\n遇到的问题或建议：';
  function feedbackTarget() {
    const scopeKey = sel === 'all' ? 'all' : sel, it = itemSel[scopeKey] ? rowOf(itemSel[scopeKey]) : null;
    if (it && (sel === 'all' || it.avatarId === sel)) return { avatarId: it.avatarId, itemId: it.id, ...(it.external ? { external: true } : {}) };
    return sel !== 'all' && cur() ? { avatarId: sel } : null;
  }
  async function openFeedback() {
    const open = window.__hubFeedback?.open;
    if (!open) { showMessage('这个版本没有一键反馈入口'); return; }
    const target = feedbackTarget();
    let ctx = '';
    if (target?.avatarId) {
      let timer = null;
      try {
        const r = await Promise.race([ipcRenderer.invoke('avatar:feedback-context', target), new Promise(res => { timer = setTimeout(() => res(null), 4000); })]);
        if (r && r.ok !== false) ctx = String(r.text || r.context || r.description || '').trim();
      } catch { /* 旧主进程没有这个通道：用原模板 */ } finally { clearTimeout(timer); }
    }
    void open({ description: ctx ? `【分身 Beta 反馈】\n遇到的问题或建议：\n\n—— 以下是自动附上的现场（已隐去姓名、工号、手机号和密钥，可删改）——\n${ctx.slice(0, 4000)}` : FEEDBACK_BASE });
  }
  function onInput(event) {
    const t = event.target;
    if (t.dataset.fixText !== undefined && fixes[t.dataset.fixText]) { const fx = fixes[t.dataset.fixText]; fx.text = t.value; const pv = document.getElementById('avx-fix-pv'); if (pv) pv.textContent = fixPreview(fx); const sv = root?.querySelector('[data-av="fix-save"]'); if (sv) sv.disabled = !!fx.saving || !fx.reason || !t.value.trim(); }
    if (t.dataset.edit) {
      edits[t.dataset.edit] = t.value; delete ack[t.dataset.edit];
      const it = data.items.find(x => keyOf(x) === t.dataset.edit), risk = document.getElementById('avx-risk');
      if (risk && it) risk.textContent = (it.flags || []).some(f => f === 'leader' || f === 'leader-present') && COMMIT_HINT.test(t.value) ? '这句话可能在向上级应承一件事，请确认后再发。' : '';
    }
    if (t.dataset.wiz) wiz[t.dataset.wiz] = t.value;
    if ('tryAsk' in t.dataset && cur()) tryOf(sel).ask = t.value;
    if ('tryNote' in t.dataset && cur()) tryOf(sel).note = t.value;
    if (t.dataset.save === 'prefix') { const p = document.getElementById('avx-preview'); if (p) p.textContent = `🤖【${t.value.trim()}】张三 关于『导出纪要』：在纪要页右上角选导出，格式选 Word。`; }
  }
  async function onChange(event) {
    const t = event.target, c = t.dataset.chg, av = cur();
    if (t.dataset.save && av) { if (t.dataset.save === 'persona' && t.value.trim()) delete personaNotes[av.id]; if (t.value !== av[t.dataset.save]) { t.blur(); await save({ [t.dataset.save]: t.value }); flash('已保存'); render(); } return; }
    if (!c) return;
    if (c === 'wiz-account') { wiz.account = t.value; render(); return; }
    if (c === 'try-consent' && av) { const x = tryOf(av.id); x.consent[t.dataset.id] = t.checked; if (t.checked && x.hint === TRY_CONSENT_HINT) x.hint = ''; render(); return; }
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

  // 「已用 N 秒」每秒走一格：只改这几个数字，不整页重画（不打断正在编辑的草稿）。
  function tickClock() {
    if (!isOpen()) return;
    root?.querySelectorAll('[data-since]').forEach(e => { const at = Number(e.dataset.since); if (at) e.textContent = span(Math.max(0, Date.now() - at)) || '0 秒'; });
  }
  function open() {
    build(); closeOtherPanels(); page.hidden = false; document.body.classList.add('avatar-page-open');
    window.setShellNavActive?.('avatar'); place();
    checking = true; autoRechecked = false; render(); void load({ first: true }); void loadTargets();
    clearInterval(clockTimer); clockTimer = setInterval(tickClock, 1000); clockTimer.unref?.();
  }
  function close() { stopTargets(); clearInterval(clockTimer); clockTimer = null; closeScan(); if (!page || page.hidden) return; page.hidden = true; document.body.classList.remove('avatar-page-open'); }
  const onChanged = () => { if (isOpen() && !busy) void load({ soft: true }); };
  // 助理那边登录状态变了（扫码成功、自动续期恢复）：分身页以前收不到这条通知，登录早好了页面还挂着「用不了」（B1）。
  // 现在跟着刷新：扫码弹层开着就更新二维码；登录状态不对的时候自动重新检查一次。
  const onAssistantChanged = () => {
    if (!isOpen()) return;
    if (scan) { void refreshScan(); return; }
    if (!busy && data && !data.missing && (!data.available || welinkNeedsLogin())) void runAny('', RECHECK).catch(() => {});
  };
  // 跳转后台（renderer/backstage-jump.js）：右上角「后台」看这个分身的答题会话；返回时回到分身页，原来选中的分身和页签不变。
  backstage.registerBackstageSource('avatar', {
    label: '分身',
    // 自检用：当前选中分身的报错（第 1 批的失败归类 failure 优先，其次 state.error）。
    // 优先用第 1 批已归类好的 failure（全局 activeFailure 或这个分身的）；没有才把 state.error 交给通用分类。
    diagnose: () => {
      const a = sel !== 'all' ? cur() : null, f = a?.state?.failure || data?.activeFailure || null, agent = data?.preflight?.agent;
      const none = agent && agent.ok === false && agent.source === 'none';
      return { failure: f, error: f ? (f.raw || f.headline || '') : (a?.state?.error || ''), area: 'codeagent', capability: none ? { codeagent: false, api: false } : {} };
    },
    emptyText: '这个分身还没有后台会话：有新消息要它处理时会自动起会话，到时就能跳过去看。',
    reopen: () => open(),
  });
  ipcRenderer.on?.('avatar:changed', onChanged);
  ipcRenderer.on?.('company-assistant:changed', onAssistantChanged);
  // 同页「⚙ Agent」或设置里改了功能 Agent（含分身用部门 key、手填模型）：后端卡跟着刷新（审查 P2）。
  ipcRenderer.on?.('feature-agents:changed', onChanged);
  return { open, close, isOpen, destroy() { close(); window.removeEventListener('resize', place); ipcRenderer.removeListener?.('avatar:changed', onChanged); ipcRenderer.removeListener?.('company-assistant:changed', onAssistantChanged); ipcRenderer.removeListener?.('feature-agents:changed', onChanged); page?.remove(); page = null; } };
}

module.exports = { createAvatarPage, paginate, waited, scopeText, modeText, scopeSummary, humanScanError, tryoutLow, externalRows, markCards, cardNo };
