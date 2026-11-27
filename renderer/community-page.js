'use strict';
// 「社区」页（2026-11-24，按确认过的 mock 1:1 实现）：左栏「帖子」下方的入口。
// 布局：标题与上榜昵称 → 四格数字 → 收件机本机的 30 天趋势与在线版本 → 五榜切换（前三名领奖台 + 4–20 名）→ 右侧我的位置。
// 底栏右侧显示「社区 ● 在线 N」，左栏入口在线时带绿点；这两处只读主进程推来的摘要，不为它们发网络请求。
// 无感约束：这一页之外不弹任何提示；取不到数据只在页内显示一行灰字。数据只读主进程快照（IPC community:*）。
// Beta（2026-11-24）：左栏入口与页标题各带一个 Beta 标。纯离线模式（设置 › 高级 › 隐私）开启时不发任何社区请求，
// 页面只显示锁定的一行字，不给数字和榜单，也不提供一键重新加入——只能回设置里关掉纯离线。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-US');
const NICK_MAX = 12;
let R = null;
const rules = () => { if (!R) { try { R = require('../core/profile/rules'); } catch { R = { RANKS: [], ACHIEVEMENTS: [] }; } } return R; };
const rankOf = lv => { const list = rules().RANKS || []; return list.reduce((hit, r) => (lv >= r.from ? r : hit), list[0] || { n: 1, name: '' }); };
const achTotal = () => (rules().ACHIEVEMENTS || []).length || 32;

function tokenText(v) {
  v = Number(v || 0);
  return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K';
}
const BOARDS = [
  { id: 'level', name: '等级榜', hint: '平局比本周活力 · 右列为本周活力', fmt: v => num(v) },
  { id: 'wxp', name: '本周活力', hint: '每天封顶、取最好 5 天，刷量和周末加班都不加分', fmt: v => num(v) },
  { id: 'wtok', name: '本周 Token', hint: '只算合计，不分工具和模型', fmt: tokenText },
  { id: 'streak', name: '工作日连胜', hint: '只算工作日，周末不用也不断签', fmt: v => `${num(v)} 天` },
  { id: 'ach', name: '成就', hint: '已点亮的成就枚数', fmt: v => `${num(v)} / ${achTotal()}` },
];
const LINE = {
  offline: '暂时连不上社区，显示的是上次取到的数据，下一小时自动再试',
  paused: '社区收集已暂停',
  error: '暂时取不到社区数据，稍后再看',
};

// 心跳里的桌宠是短名（shiba），图片按完整编号存（07-shiba）。
let petRoles = null;
function petThumb(pet) {
  if (!pet) return '';
  if (!petRoles) { try { petRoles = require('../core/hub-pet/state').ROLES.map(r => r.id); } catch { petRoles = []; } }
  const id = petRoles.find(r => r === pet || r.replace(/^\d+-/, '') === pet);
  return id ? `assets/hub-pet/thumbs/${id}.webp` : '';
}
const clock = at => { if (!at) return ''; const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mmdd = d => String(d || '').slice(5, 10);

// 条目在当前榜的右列数值：等级榜显示本周活力（Lv 已在左边一列），其余显示该榜的值。
function entryValue(board, e) {
  const b = BOARDS.find(x => x.id === board) || BOARDS[0];
  const v = board === 'level' ? e.wxp : e.value;
  return v == null ? '' : b.fmt(v);
}

// 把快照整理成页面要显示的内容（纯函数，单测用）。
function viewModel(data, board = 'level') {
  const d = data || {};
  const state = d.state || 'error';
  const cur = BOARDS.find(b => b.id === board) || BOARDS[0];
  const boards = d.boards || {};
  const list = (boards[cur.id] || []).slice(0, 20);
  const hasBoards = BOARDS.some(b => Array.isArray(boards[b.id]) && boards[b.id].length);
  const showData = state === 'ok' || state === 'paused' || (state === 'offline' && !!d.at);
  const deco = e => { const r = rankOf(Number(e.lv) || 1); return { ...e, thumb: petThumb(e.pet), text: entryValue(cur.id, e), big: cur.id === 'level' ? 'Lv.' + num(e.lv) : entryValue(cur.id, e), rankN: r.n, rankShort: String(r.name || '').replace(/驾驭者$/, ''), rankName: r.name || '' }; };
  const meRanks = (d.me && d.me.ranks) || {};
  const vals = (d.me && d.me.values) || {};
  const me = d.me ? deco({ ...d.me, wxp: vals.wxp, value: cur.id === 'level' ? vals.lv : vals[cur.id], me: true }) : null;
  const meRank = meRanks[cur.id];
  const total = Number(d.total) || 0;
  const meRow = me && meRank > 20 && !list.some(e => e.me) ? { ...me, rank: meRank } : null;
  const versions = (d.versions || []).map(v => ({ v: v.v === 'other' ? '其他' : v.v, n: Number(v.n) || 0 }));
  const vMax = Math.max(1, ...versions.map(v => v.n));
  const delta = v => (v == null ? '' : (v >= 0 ? '+' : '') + num(v));
  const host = d.host || null;
  return {
    state, showData, isHost: !!d.isHost, hasBoards, board: cur.id, hint: cur.hint, total, minK: Number(d.minK) || 5,
    line: LINE[state] || '', updated: clock(d.at),
    nick: (d.me && d.me.nick) || '', nickThumb: me ? me.thumb : '',
    stats: { online: num(d.online), activeNow: num(d.activeNow), today: num(d.today), week: num(d.week), todayDelta: delta(d.todayDelta), weekDelta: delta(d.weekDelta) },
    podium: list.slice(0, 3).map(deco), rows: list.slice(3).map(deco), meRow,
    me, ranks: BOARDS.map(b => ({ id: b.id, name: b.name, rank: meRanks[b.id] || null })),
    beat: total && meRanks.level ? total - meRanks.level : null,
    versions: versions.map(v => ({ ...v, pct: Math.round(v.n / vMax * 100) })),
    daily: (d.daily || []).slice(-30),
    host: host ? { paused: !!host.paused, pulsesToday: host.pulsesToday, stored: host.stored } : null,
  };
}

function petImg(thumb, nick, cls) {
  return thumb ? `<img class="${cls}" src="${esc(thumb)}" alt="" draggable="false">` : `<span class="${cls} cmy-noimg">${esc(String(nick || '·').trim().slice(0, 1).toUpperCase())}</span>`;
}
const badge = n => `<img src="assets/profile/rank-${Number(n) || 1}.webp" alt="" draggable="false">`;

function trendSvg(daily) {
  const W = 560, H = 150, P = 24, n = daily.length;
  if (n < 2) return '<p class="cmy-empty">还没有数据</p>';
  const d1 = daily.map(x => Number(x.dau) || 0), d2 = daily.map(x => Number(x.act) || 0);
  const max = Math.max(1, ...d1) * 1.1, x = i => P + i * (W - 2 * P) / (n - 1), y = v => H - P - (v / max) * (H - 2 * P);
  const path = a => a.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const area = path(d1) + ` L${x(n - 1)} ${H - P} L${x(0)} ${H - P} Z`;
  return `<svg class="cmy-trend-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <defs><linearGradient id="cmy-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cmy-g0"/><stop offset="1" class="cmy-g1"/></linearGradient></defs>
    ${[0, 0.5, 1].map(t => `<line class="cmy-grid" x1="${P}" x2="${W - P}" y1="${y(max * t / 1.1)}" y2="${y(max * t / 1.1)}"/>`).join('')}
    <path d="${area}" fill="url(#cmy-g)"/><path class="cmy-l1" d="${path(d1)}"/><path class="cmy-l2" d="${path(d2)}"/>
    <text class="cmy-ax" x="${P}" y="${H - 6}">${esc(mmdd(daily[0].d))}</text><text class="cmy-ax" x="${W - P - 28}" y="${H - 6}">今天</text>
    <text class="cmy-last" x="${x(n - 1) - 4}" y="${y(d1[n - 1]) - 8}">${num(d1[n - 1])}</text></svg>`;
}

const OFFLINE_LINE = '已开启纯离线模式，社区页不可用。可在 设置 › 高级 中关闭';

function headHtml(vm) {
  const title = '<h1>AI HUB 社区<span class="cmy-beta">Beta</span></h1>';
  if (vm.state === 'disabled') return `<div class="cmy-head"><div>${title}</div></div>`;
  const meta = ['匿名统计', '每小时更新', vm.updated ? `更新于 ${vm.updated}` : ''].filter(Boolean).map(t => `<span>${esc(t)}</span>`).join(' · ');
  const nick = vm.nick ? `<div class="cmy-nickpill">${petImg(vm.nickThumb, vm.nick, 'cmy-nickpet')}<span><span>上榜昵称</span> <b data-slot="nick" data-i18n-skip>${esc(vm.nick)}</b></span><button type="button" class="cmy-edit" data-cmy="rename" title="榜单上显示的匿名昵称，最多 12 个字">改名</button></div>` : '';
  return `<div class="cmy-head"><div>${title}<div class="cmy-meta">${meta}<span class="cmy-line" data-slot="line">${esc(vm.line)}</span></div></div>${nick}</div>`;
}

function statsHtml(vm) {
  const s = vm.stats;
  return `<div class="cmy-stats">
    <div class="cmy-stat"><div class="cmy-k"><i></i>当前在线</div><div class="cmy-v">${s.online}</div><div class="cmy-d">近 1 小时打开过 Hub</div></div>
    <div class="cmy-stat"><div class="cmy-k">正在用</div><div class="cmy-v">${s.activeNow}</div><div class="cmy-d">近 1 小时亲自发过消息</div></div>
    <div class="cmy-stat"><div class="cmy-k">今日</div><div class="cmy-v">${s.today}</div><div class="cmy-d">${s.todayDelta ? `<span>比上周同日</span> <b>${s.todayDelta}</b>` : ''}</div></div>
    <div class="cmy-stat"><div class="cmy-k">本周</div><div class="cmy-v">${s.week}</div><div class="cmy-d">${s.weekDelta ? `<span>比上周</span> <b>${s.weekDelta}</b>` : ''}</div></div></div>`;
}

function hostHtml(vm) {
  if (!vm.isHost) return '';
  const h = vm.host;
  const status = h ? `<div class="cmy-priv cmy-hoststat"><span>收件机状态：${h.paused ? '已暂停' : '正常'}</span>${h.pulsesToday != null ? ` · <span>今日收到心跳 ${num(h.pulsesToday)} 次</span>` : ''}${h.stored != null ? ` · <span>存储 ${num(h.stored)} 台</span>` : ''} · <button type="button" class="cmy-edit" data-cmy="host-pause">${h.paused ? '恢复收集' : '暂停收集'}</button></div>` : '';
  return `<div class="cmy-host">
    <div class="cmy-card"><h3><span>近 30 天</span> <span class="cmy-tag">仅收件机本机可见</span><span class="cmy-legend"><span class="l1">日活</span><span class="l2">当天真正在用</span></span></h3>${trendSvg(vm.daily)}</div>
    <div class="cmy-card"><h3><span>当前在线的版本</span> <span class="cmy-tag">仅收件机本机可见</span></h3>${vm.versions.map(v => `<div class="cmy-vbar"><span class="n">${esc(v.v)}</span><span class="b"><i style="width:${v.pct}%"></i></span><span class="c">${num(v.n)}</span></div>`).join('')}
      ${status}</div></div>`;
}

function rowHtml(p) {
  return `<div class="cmy-row${p.me ? ' me' : ''}"${p.me ? ' aria-current="true"' : ''}><span class="r">${num(p.rank)}</span>${petImg(p.thumb, p.nick, 'pet')}<span class="nm"><span data-i18n-skip>${esc(p.nick)}</span>${p.me ? ' <b class="cmy-me-tag">（我）</b>' : ''}</span><span class="lv">${badge(p.rankN)}Lv.${num(p.lv)}</span><span class="v">${esc(p.text)}</span></div>`;
}

function boardHtml(vm) {
  const order = [1, 0, 2], medal = ['🥇', '🥈', '🥉'];
  const podium = `<div class="cmy-podium">${order.filter(i => vm.podium[i]).map(i => { const p = vm.podium[i]; return `<div class="pd p${i + 1}${p.me ? ' me' : ''}"><span class="medal">${medal[i]}</span>${petImg(p.thumb, p.nick, 'pet')}<div class="nm"><span data-i18n-skip>${esc(p.nick)}</span>${p.me ? '<span>（我）</span>' : ''}</div><div class="val">${esc(p.big)}</div><div class="lv">${badge(p.rankN)}<span>Lv.${num(p.lv)}</span> <span>${esc(p.rankShort)}</span></div></div>`; }).join('')}</div>`;
  let rows = vm.rows.map(rowHtml).join('');
  if (vm.meRow) rows += '<div class="cmy-gap">· · ·</div>' + rowHtml(vm.meRow);
  const count = vm.total ? ` · <span>共 ${num(vm.total)} 人参与</span>` : '';
  return `<div class="cmy-card cmy-boardcard"><div class="cmy-tabs" role="tablist">${BOARDS.map(b => `<button type="button" role="tab" aria-selected="${b.id === vm.board}" data-cmy-board="${b.id}" class="${b.id === vm.board ? 'on' : ''}">${esc(b.name)}</button>`).join('')}</div>
      <div class="cmy-hint"><span>${esc(vm.hint)}</span>${count}</div>${podium}<div class="cmy-rows">${rows}</div></div>`;
}

function meHtml(vm) {
  const me = vm.me;
  const top = me ? `<div class="cmy-mctop">${petImg(me.thumb, me.nick, 'pet')}<div><div class="nm" data-i18n-skip>${esc(me.nick)}</div><div class="lv">${badge(me.rankN)}<span>Lv.${num(me.lv)}</span> · <span>${esc(me.rankName)}</span></div></div></div>` : '<p class="cmy-empty">第一次同步后显示</p>';
  return `<div class="cmy-card cmy-mecard"><h3>我的位置</h3>${top}
      <div class="cmy-ranks">${vm.ranks.map(r => `<div data-cmy-board="${r.id}"><span>${esc(r.name)}</span><b>${r.rank ? `第 ${num(r.rank)} 名` : '未上榜'}</b></div>`).join('')}</div>
      ${vm.beat != null ? `<div class="cmy-beat"><span>等级超过了</span> <b>${num(vm.beat)}</b> <span>位同事（共 ${num(vm.total)} 人）</span></div>` : ''}
      <div class="cmy-priv"><span>上榜只用昵称和桌宠，不显示真名、工号、部门。</span><br><span>每小时匿名同步一次，不含任何对话和文件。</span><br><span>不想参与：设置 › 高级 › 隐私 › 纯离线模式。</span></div></div>`;
}

function pageHtml(vm) {
  const head = headHtml(vm);
  if (vm.state === 'outside') return `${head}<div class="cmy-emptybox"><b>社区仅在公司内网可用</b><span>连上公司网络后自动恢复，不影响其他功能。</span></div>`;
  if (vm.state === 'disabled') return `${head}<div class="cmy-emptybox cmy-locked"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span>${esc(OFFLINE_LINE)}</span></div>`;
  if (!vm.showData) return `${head}<div class="cmy-emptybox"><b>暂时没有数据</b><span>${esc(vm.line)}</span></div>`;
  if (!vm.hasBoards) return `${head}${statsHtml(vm)}${hostHtml(vm)}<div class="cmy-emptybox"><b>参与人数不足 ${vm.minK} 人，暂不显示排行榜</b><span>人数够了会自动出现。</span></div>`;
  return `${head}${statsHtml(vm)}${hostHtml(vm)}<div class="cmy-lb">${boardHtml(vm)}${meHtml(vm)}</div>`;
}

// 子页（2026-11-28）：广场（所有人的桌宠，只带公开名片）、我的团队（按 IP 组队的小屋）、排行榜（原来的整页）。
const SUBS = [{ id: 'square', name: '广场' }, { id: 'crew', name: '我的团队' }, { id: 'board', name: '排行榜' }];

function createCommunityPage({ document, window, ipcRenderer, closeOtherPanels = () => {} }) {
  let page = null, data = null, board = 'level', summary = null, square = null, crew = null, myPet = null;
  let sub = (() => { try { return window.localStorage.getItem('community.sub') || 'square'; } catch { return 'square'; } })();
  if (!SUBS.some(x => x.id === sub)) sub = 'square';
  const invoke = async (channel, payload) => ipcRenderer.invoke('community:' + channel, payload);

  function nav() {
    let btn = document.getElementById('btn-community');
    if (btn) return btn;
    const anchor = document.getElementById('btn-company-forum');
    const list = document.querySelector('#scene-rail .rail-navigation');
    if (!anchor && !list) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-community';
    btn.title = '社区 Beta · 广场、我的团队与排行榜'; btn.setAttribute('aria-label', '社区 Beta'); btn.setAttribute('aria-controls', 'community-page');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V11M12 21V5M17 21v-7"/><path d="M4 21h16"/></svg></span><span class="btn-label">社区</span><em class="cmy-live" hidden></em>';
    btn.insertAdjacentHTML('afterbegin', '<i class="rail-beta" aria-hidden="true">Beta</i>');
    if (anchor) anchor.after(btn); else list.append(btn);
    btn.addEventListener('click', () => { if (page && !page.hidden) close(); else void open(); });
    return btn;
  }
  // 底栏右侧「社区 ● 在线 N」与左栏绿点：只在社区可用（state=ok）时出现。
  function paintSummary(s) {
    if (!s || typeof s !== 'object') return;
    summary = s;
    const live = s.state === 'ok' && s.online != null;
    const dot = nav()?.querySelector('.cmy-live');
    if (dot) dot.hidden = !live;
    const footer = document.getElementById('hub-system-footer');
    if (!footer) return;
    let el = document.getElementById('community-foot');
    if (!el) {
      el = document.createElement('button'); el.type = 'button'; el.id = 'community-foot'; el.className = 'cmy-foot';
      el.title = '打开社区'; footer.append(el);
      el.addEventListener('click', event => { event.stopPropagation(); void open(); });
    }
    el.hidden = !live;
    if (live) el.innerHTML = `<span>社区</span> <i aria-hidden="true">●</i> <span>在线</span> <b>${num(s.online)}</b>`;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'community-page'; page.id = 'community-page'; page.hidden = true; page.setAttribute('aria-label', '社区');
    page.innerHTML = `<div class="cmy-shell"><div class="cmy-subbar"><h1>AI HUB 社区<span class="cmy-beta">Beta</span></h1>
        <div class="cmy-subtabs" role="tablist">${SUBS.map(x => `<button type="button" role="tab" data-cmy-sub="${x.id}">${esc(x.name)}</button>`).join('')}</div>
        <span class="sp"></span><span class="lan">🔒 <span>团队之间只在公司内网直连，内容加密</span></span></div>
      <div class="cmy-sub" data-sub="board"><div class="cmy-page"></div></div></div>`;
    document.body.append(page);
    const shell = page.querySelector('.cmy-shell');
    const toastEl = document.createElement('div'); toastEl.className = 'cc-toast'; page.append(toastEl);
    const toast = text => { if (!text) return; toastEl.textContent = text; toastEl.classList.add('show'); clearTimeout(toastEl.t); toastEl.t = setTimeout(() => toastEl.classList.remove('show'), 2600); };
    try {
      const { createCrew } = require('./community-crew');
      const { createSquare } = require('./community-square');
      crew = createCrew({ host: shell, ipcRenderer, toast, onSnapshot: () => { if (sub === 'square' && square) square.refresh(); } });
      const getCrew = () => {
        const s = crew.snapshot();
        const m = s && s.crews[0] ? s.crews[0].members.find(x => x.me) : null;
        return { me: s ? s.me : null, nick: (m && m.nick) || '', pet: (myPet && myPet.role) || (m && m.pet) || '' };
      };
      square = createSquare({ host: shell, ipcRenderer, toast, getBoard: () => data, getCrew, reloadCrew: () => crew.load(),
        goCrew: mode => { setSub('crew', mode); } });
      shell.querySelector('[data-sub="crew"]')?.before(shell.querySelector('[data-sub="square"]'));
    } catch (e) { console.warn('[community] 广场/团队加载失败：', e && e.message); }
    page.addEventListener('click', event => {
      const st = event.target.closest('[data-cmy-sub]');
      if (st) { setSub(st.dataset.cmySub); return; }
      const t = event.target.closest('[data-cmy-board]');
      if (t) { board = t.dataset.cmyBoard; render(); return; }
      const b = event.target.closest('[data-cmy]');
      if (b) { event.preventDefault(); void action(b.dataset.cmy, b).catch(e => setLine(e.message)); }
    });
  }
  function setSub(next, mode) {
    if (!SUBS.some(x => x.id === next)) next = 'board';
    // 纯离线：广场和团队都不可用，只显示锁定的一行字（排行榜子页里）。
    if (data && data.state === 'disabled') next = 'board';
    sub = next;
    try { window.localStorage.setItem('community.sub', sub); } catch { /* 不记也行 */ }
    if (!page) return;
    page.querySelectorAll('[data-cmy-sub]').forEach(b => { b.classList.toggle('on', b.dataset.cmySub === sub); b.setAttribute('aria-selected', String(b.dataset.cmySub === sub)); });
    page.querySelectorAll('.cmy-sub').forEach(el => el.classList.toggle('on', el.dataset.sub === sub));
    if (sub === 'square') square?.show(); else square?.hide();
    if (sub === 'crew') void crew?.show(mode); else crew?.hide();
  }
  const setLine = text => { const el = page && page.querySelector('[data-slot="line"]'); if (el) el.textContent = text || ''; };
  async function action(name, button) {
    if (name === 'host-pause') {
      button.disabled = true;
      try { await invoke('set-host-paused', { paused: !(data && data.host && data.host.paused) }); await load(); } finally { button.disabled = false; }
    } else if (name === 'rename') {
      const slot = page.querySelector('[data-slot="nick"]'), old = (data && data.me && data.me.nick) || '';
      if (!slot) return;
      const input = document.createElement('input'); input.className = 'cmy-nick-input'; input.maxLength = NICK_MAX; input.value = old; input.placeholder = '留空就用自动生成的昵称';
      slot.replaceWith(input); input.focus(); input.select();
      let done = false;
      const commit = async save => {
        if (done) return; done = true;
        const next = input.value.trim().slice(0, NICK_MAX);
        if (save && next !== old) {
          const r = await invoke('set-nickname', { name: next }).catch(e => ({ ok: false, error: e.message }));
          input.remove();
          if (r && r.ok === false) { render(); setLine('昵称没保存：' + (r.error || '操作未完成')); return; }
          if (data && data.me) data.me = { ...data.me, nick: (r && r.nick) || next || old };
          render(); setLine('新昵称下一次同步后出现在榜单上'); return;
        }
        input.remove(); render();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') void commit(true); else if (e.key === 'Escape') { e.stopPropagation(); void commit(false); } });
      input.addEventListener('blur', () => { void commit(true); });
    }
  }
  function render() {
    if (!page) return;
    const disabled = data && data.state === 'disabled';
    if (disabled) {
      setSub('board');
      // 锁定时从页面移走交互区，保留原节点以便重新参与时恢复。
      if (!page.offlineParts) page.offlineParts = [];
      page.querySelectorAll('.cmy-subbar, .cmy-sub:not([data-sub="board"])').forEach(el => {
        const marker = document.createComment('');
        el.hidden = true; el.replaceWith(marker); page.offlineParts.push({ el, marker });
      });
    } else if (page.offlineParts?.length) {
      for (const { el, marker } of page.offlineParts) { el.hidden = false; marker.replaceWith(el); }
      page.offlineParts = []; setSub(sub);
    }
    if (!disabled && page.querySelector('.cmy-nick-input')) return; // 正在改昵称时不重画
    const host = page.querySelector('.cmy-sub[data-sub="board"] .cmy-page');
    if (host) host.innerHTML = pageHtml(viewModel(data, board));
    if (sub === 'square' && square && !page.hidden) square.refresh();
  }
  async function load() {
    try {
      const r = await invoke('get-board');
      data = r && typeof r === 'object' ? r : { state: 'error' };
      if (data.ok === false && !data.state) data = { ...data, state: 'error' };
    } catch {
      data = data && data.at ? { ...data, state: 'offline' } : { state: 'error' };
    }
    render();
    paintSummary({ state: data.state, online: data.online, at: data.at });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }
  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels();
    for (const name of ['__profileHide', '__companyRoomsHide', '__companyMeetingHide', '__assistantHide', '__wirelessHide', '__companyAssistantHide', '__companyForumHide', '__companyPptHide', '__companyAttendanceHide', '__companyW3Hide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    page.hidden = false; document.body.classList.add('community-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    if (!data) render();
    if (!myPet) { try { const r = await ipcRenderer.invoke('hub-pet:get-settings'); myPet = (r && r.settings) || {}; } catch { myPet = {}; } }
    if (crew && !crew.snapshot()) await crew.load();
    setSub(sub);
    await load();
    setSub(sub);
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('community-page-open');
    square?.hide(); crew?.hide();
    document.getElementById('btn-community')?.classList.remove('active');
    window.removeEventListener('resize', onResize);
  }

  // 设置 › 高级 › 隐私 里的「纯离线模式」：勾上＝不参与（community:set-enabled false）。只有带社区的版本才显示这一项。
  function bindOfflineSetting() {
    const field = document.getElementById('cfg-community-offline-field'), box = document.getElementById('cfg-community-offline');
    if (!field || !box || box.dataset.bound) return;
    box.dataset.bound = '1';
    const sync = () => invoke('get-settings').then(s => { field.hidden = !(s && s.available); box.checked = !!(s && s.available && s.enabled === false); }).catch(() => { field.hidden = true; });
    void sync();
    field.addEventListener('toggle', () => { if (field.open) void sync(); });
    box.addEventListener('change', async () => {
      const offline = box.checked;
      box.disabled = true;
      try {
        const s = await invoke('set-enabled', { enabled: !offline });
        box.checked = !!(s && s.enabled === false);
        if (box.checked) { data = { state: 'disabled' }; setSub('board'); render(); paintSummary({ state: 'disabled', online: null, at: 0 }); }
        else { data = null; const r = await invoke('get-board', { cachedOnly: true }).catch(() => null); if (r && r.state) paintSummary({ state: r.state, online: r.online, at: r.at }); }
        if (page && !page.hidden) { if (box.checked) render(); else await load(); }
      } catch { box.checked = !offline; } finally { box.disabled = false; }
    });
  }

  nav();
  // renderer.js 在 index.html 里排在设置弹窗之前加载，弹窗节点要等文档解析完才有。
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindOfflineSetting, { once: true });
  else bindOfflineSetting();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-community):not(#btn-theme):not(#btn-options)')) close(); });
  // 主进程每次心跳回包后推一份摘要；启动时只读缓存（cachedOnly），不发网络请求。
  ipcRenderer.on?.('community:summary', (_e, s) => paintSummary(s));
  void Promise.resolve().then(() => invoke('get-board', { cachedOnly: true })).then(r => { if (r && r.state) paintSummary({ state: r.state, online: r.online, at: r.at }); }).catch(() => {});
  return { open, close, isOpen: () => !!page && !page.hidden, _summary: () => summary };
}

module.exports = { createCommunityPage, viewModel, pageHtml, BOARDS, SUBS, entryValue, tokenText, petThumb, NICK_MAX };
