'use strict';
// 「个人」页（2026-11-12）：左栏底部「主题」上方的头像入口，点开分四个页签，各自一屏看完——
// 总览（我是谁、等级、成就墙、桌宠伙伴、12 周活跃）、成就（全部成就与进度）、足迹（功能、模型、每日经验、全年活跃）、名片（身份与段位之路）。
// 名字自动认（WeLink 登录账号优先），数据只留本机。页面只读主进程给的快照（main/profile-controller.js）。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-US');
const TIER = { bronze: '铜', silver: '银', gold: '金' };
const TABS = [{ id: 'home', name: '总览' }, { id: 'wall', name: '成就' }, { id: 'trail', name: '足迹' }, { id: 'card', name: '名片' }];
const WELINK = { online: '已登录', 'needs-scan': '需要扫码登录', renewing: '续期中', unknown: '还没核实', none: '这个版本没有 WeLink 联动' };
// 头像上的字：中文名取后两个字，其他取前两个字符。
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '我';
  return /[一-鿿]/.test(s) ? s.slice(-2) : s.slice(0, 2).toUpperCase();
}
function tokenText(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1) + ' 亿';
  if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('en-US') + ' 万';
  return num(n);
}
const dateText = ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const heatLevels = list => { const max = Math.max(1, ...list.map(h => h.xp)); return list.map(h => ({ day: h.day, xp: h.xp, lv: h.xp <= 0 ? 0 : Math.min(4, 1 + Math.floor(h.xp / max * 3.999)) })); };

// 把快照整理成页面要显示的内容（纯函数，单测用）。
function viewModel(snapshot, brief = {}, extra = {}) {
  const s = snapshot, id = s.identity || {};
  const name = id.display || '';
  const span = s.ceil == null ? 1 : Math.max(1, s.ceil - s.floor);
  const pct = s.ceil == null ? 100 : Math.max(0, Math.min(100, Math.round((s.xp - s.floor) / span * 100)));
  const meta = [id.dept, id.title, id.uid || id.workId, `加入第 ${num(s.stats.joinDays)} 天`].filter(Boolean);
  const sorted = [...s.achievements].sort((a, b) => (b.unlockedAt ? 1 : 0) - (a.unlockedAt ? 1 : 0) || (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0) || (a.unlockedAt ? b.unlockedAt - a.unlockedAt : (b.value / b.goal) - (a.value / a.goal)));
  const next = sorted.find(a => !a.unlockedAt);
  const fromText = id.from === 'welink' ? '来自 WeLink 登录账号' : id.nickname ? '自己填的称呼' : '按本机信息识别，登录 WeLink 后自动换成姓名';
  const featMax = Math.max(1, ...s.features.map(f => f.count));
  const dayMax = Math.max(1, ...s.daily.map(d => d.xp));
  const models = (extra.models || []).slice(0, 6), modelMax = Math.max(1, ...models.map(m => m.tokens));
  return {
    name: name || '未识别', initials: initials(name), meta, from: id.from || '', fromText,
    level: s.level, rank: s.rank, pct,
    xpText: s.ceil == null ? `${num(s.xp)} 经验 · 已满级` : `${num(s.xp - s.floor)} / ${num(span)}`,
    etaText: s.ceil == null ? '' : s.etaDays ? `照最近的用法，再用约 ${s.etaDays} 天升到 Lv.${s.level + 1}` : `再拿 ${num(s.ceil - s.xp)} 经验升到 Lv.${s.level + 1}`,
    rankText: s.rank.nextAt ? `Lv.${s.rank.nextAt} 晋升${s.rank.nextName}` : '已是最高段位',
    todayXp: s.today.xp, totalXp: s.xp,
    stats: [
      { k: '累计会话', v: num(s.stats.sessions) }, { k: '发出消息', v: num(s.stats.prompts) },
      { k: '连续使用', v: num(s.stats.streak), u: '天', hint: `最长 ${num(s.stats.bestStreak)} 天` },
      { k: '活跃天数', v: num(s.stats.activeDays), u: '天' },
      { k: '用过的功能', v: `${s.stats.featuresUsed}/${s.stats.featuresAvail}` },
      { k: '累计 Token', v: tokenText(s.stats.tokens) },
    ],
    achievements: sorted, unlocked: s.unlocked, total: s.achievements.length, next,
    groups: (s.groups || []).map(g => ({ ...g, list: s.achievements.filter(a => a.group === g.id) })).filter(g => g.list.length),
    heat: heatLevels(s.heat), year: heatLevels(s.year || []),
    pet: s.pet, petRole: brief.pet && brief.pet.available ? brief.pet.role : '', petAvailable: !!(brief.pet && brief.pet.available), petEnabled: !!(brief.pet && brief.pet.enabled),
    features: [...s.features].sort((a, b) => b.count - a.count).map(f => ({ ...f, pct: f.count ? Math.max(3, Math.round(Math.sqrt(f.count / featMax) * 100)) : 0 })),
    daily: s.daily.map(d => ({ ...d, pct: Math.round(d.xp / dayMax * 100), label: `${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8, 10))}` })),
    models: models.map(m => ({ ...m, text: tokenText(m.tokens), pct: Math.round(m.tokens / modelMax * 100) })),
    ranks: (s.ranks || []).map(r => ({ ...r, state: r.n < s.rank.n ? 'done' : r.n === s.rank.n ? 'now' : 'todo' })),
    rules: s.rules, tierXp: s.tierXp || {}, backfill: s.backfill, firstDay: s.firstDay, bestStreak: s.stats.bestStreak, turns: s.stats.turns,
    fields: [
      ['姓名', id.name], ['英文名', id.englishName], ['称呼', id.nickname], ['WeLink 账号', id.uid], ['工号', id.workId], ['部门', id.dept], ['部门路径', id.deptPath], ['职位', id.title], ['邮箱', id.email],
    ].filter(f => f[1]),
    identityAt: dateText(id.at), version: extra.version || '', welinkText: WELINK[extra.welink] || WELINK.unknown, welinkState: extra.welink || 'unknown',
  };
}

function badgeHtml(a) {
  const done = !!a.unlockedAt, pct = Math.round(a.value / a.goal * 100);
  return `<button type="button" class="pf-badge${done ? ' on' : ''}${a.fresh ? ' fresh' : ''}" data-pf-badge="${esc(a.id)}" title="${esc(a.name)} · ${esc(a.desc)}">
    <span class="pf-badge-art"><img src="assets/profile/badge-${a.icon}.webp" alt="" draggable="false">${done ? '' : `<i class="pf-ring" style="--p:${pct}"></i>`}${a.fresh ? '<em>新</em>' : ''}</span>
    <span class="pf-badge-name">${esc(a.name)}</span></button>`;
}
function detailHtml(a) {
  if (!a) return '';
  const done = !!a.unlockedAt;
  const when = done ? `${dateText(a.unlockedAt)} 解锁` : `${num(a.value)} / ${num(a.goal)}`;
  return `<img src="assets/profile/badge-${a.icon}.webp" alt="" class="${done ? '' : 'off'}"><div class="pf-detail-text"><b>${esc(a.name)}</b><span class="pf-tier ${a.tier}">${TIER[a.tier]}</span><span>${esc(a.desc)}</span></div>
    <div class="pf-detail-side"><span>${esc(when)}</span><span class="pf-plus">+${a.xp} 经验</span></div>`;
}
function heatHtml(heat, cls = '') {
  const cols = [];
  for (let i = 0; i < heat.length; i += 7) cols.push(heat.slice(i, i + 7));
  const month = c => { const d = c[0].day; return Number(d.slice(8, 10)) <= 7 ? `${Number(d.slice(5, 7))}月` : ''; };
  return `<div class="pf-heat-wrap ${cls}"><div class="pf-heat-days"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
    <div class="pf-heat-grid" style="--cols:${cols.length}">${cols.map(c => `<div class="pf-heat-col"><i class="pf-heat-m">${month(c)}</i>${c.map(h => `<span class="l${h.lv}" title="${h.day} · ${h.xp ? '+' + h.xp + ' 经验' : '没用'}"></span>`).join('')}</div>`).join('')}</div></div>`;
}
const legend = '<span class="pf-legend">少<i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</span>';
function avatarHtml(vm, cls = '') {
  // 有桌宠就用桌宠形象当头像，图盖在名字上面；图加载不了时露出名字。
  return `<span class="pf-avatar ${cls}">${esc(vm.initials)}${vm.petRole ? `<img src="assets/hub-pet/thumbs/${esc(vm.petRole)}.webp" alt="" draggable="false" onerror="this.remove()">` : ''}</span>`;
}
function levelHtml(vm) {
  return `<div class="pf-level">
      <img class="pf-rank" src="assets/profile/rank-${vm.rank.n}.webp" alt="${esc(vm.rank.metal)}段位" draggable="false">
      <div class="pf-level-main">
        <div class="pf-level-row"><b class="pf-lv">Lv.${vm.level}</b><span class="pf-rank-name">${esc(vm.rank.name)}</span><span class="pf-today">今天 +${num(vm.todayXp)}</span></div>
        <div class="pf-bar"><i style="width:${vm.pct}%"></i></div>
        <div class="pf-level-foot"><span>${esc(vm.xpText)}</span><span>${esc(vm.etaText)}</span><span class="pf-next-rank">${esc(vm.rankText)}</span></div>
      </div>
    </div>`;
}

// ---------- 总览 ----------
function homeHtml(vm, selected) {
  const pet = vm.pet, bond = pet.bond;
  const bondPct = bond.next == null ? 100 : Math.round((bond.points - bond.floor) / (bond.next - bond.floor) * 100);
  const sel = vm.achievements.find(a => a.id === selected) || vm.achievements.find(a => a.fresh) || vm.next || vm.achievements[0];
  const petLine = !vm.petAvailable ? '' : vm.petEnabled ? (bond.level >= 5 ? '有你在，今天也顺顺利利。' : bond.level >= 3 ? '今天也一起加油。' : '鼠标在我身上蹭一蹭，我们会更熟。') : '我还在休息，点「叫它出来」就到桌面陪你。';
  return `<section class="pf-card pf-hero">
      <div class="pf-me">
        ${avatarHtml(vm, 'big')}
        <div class="pf-me-text">
          <div class="pf-name-row"><b class="pf-name" data-slot="name">${esc(vm.name)}</b>
            <button type="button" class="pf-link" data-pf="rename" title="改一个显示用的称呼">改称呼</button>
            <button type="button" class="pf-link" data-pf="reidentify" title="重新向 WeLink 核对姓名、工号和部门">重新识别</button></div>
          <div class="pf-meta">${vm.meta.map(esc).join('<i>·</i>')}</div>
          <div class="pf-from">${esc(vm.fromText)}</div>
        </div>
      </div>
      ${levelHtml(vm)}
    </section>
    <section class="pf-stats">${vm.stats.map(x => `<div class="pf-stat" ${x.hint ? `title="${esc(x.hint)}"` : ''}><b>${esc(x.v)}${x.u ? `<small>${x.u}</small>` : ''}</b><span>${esc(x.k)}</span></div>`).join('')}</section>
    <div class="pf-mid">
      <section class="pf-card pf-wall">
        <div class="pf-card-head"><h2>成就墙</h2><span class="pf-count">已解锁 <b>${vm.unlocked}</b> / ${vm.total} · <button type="button" class="pf-link" data-pf-tab="wall">看全部进度</button></span></div>
        <div class="pf-detail" data-slot="detail">${detailHtml(sel)}</div>
        <div class="pf-badges">${vm.achievements.map(badgeHtml).join('')}</div>
      </section>
      <div class="pf-side">
        ${vm.petAvailable ? `<section class="pf-card pf-pet">
          <div class="pf-card-head"><h2>桌宠伙伴</h2><span class="pf-bond" title="摸一次 1 点，陪伴一天 5 点">亲密度 <b>${bond.level}</b> 级</span></div>
          <div class="pf-pet-row">
            <span class="pf-pet-art">${vm.petRole ? `<img src="assets/hub-pet/thumbs/${esc(vm.petRole)}.webp" alt="" draggable="false">` : ''}</span>
            <div class="pf-pet-text"><p class="pf-bubble">${esc(petLine)}</p>
              <div class="pf-bar thin"><i style="width:${bondPct}%"></i></div>
              <span class="pf-pet-num">摸了 ${num(pet.pets)} 次 · 陪伴 ${num(pet.days)} 天${vm.petEnabled ? '' : ' · <button type="button" class="pf-link" data-pf="pet-on">叫它出来</button>'}</span></div>
          </div>
          <div class="pf-perks">${pet.perks.map(p => `<div class="pf-perk${p.unlocked ? ' on' : ''}" title="${esc(p.desc)}"><i class="pf-perk-ico ${esc(p.id)}"></i><b>${esc(p.name)}</b><span>${p.unlocked ? '已解锁' : 'Lv.' + p.level + ' 解锁'}</span></div>`).join('')}</div>
        </section>` : ''}
        <section class="pf-card pf-heat">
          <div class="pf-card-head"><h2>近 12 周活跃</h2>${legend}</div>
          ${heatHtml(vm.heat)}
        </section>
      </div>
    </div>`;
}

// ---------- 成就 ----------
function wallHtml(vm) {
  const row = a => {
    const done = !!a.unlockedAt, pct = Math.round(a.value / a.goal * 100);
    return `<div class="pf-ach${done ? ' on' : ''}"><img src="assets/profile/badge-${a.icon}.webp" alt="" draggable="false">
      <div class="pf-ach-text"><div class="pf-ach-top"><b>${esc(a.name)}</b><span class="pf-tier ${a.tier}">${TIER[a.tier]}</span>${a.fresh ? '<em class="pf-new">新</em>' : ''}<span class="pf-ach-xp">+${a.xp}</span></div>
        <span class="pf-ach-desc">${esc(a.desc)}</span>
        ${done ? `<span class="pf-ach-when">${dateText(a.unlockedAt)} 解锁</span>` : `<div class="pf-ach-prog"><div class="pf-bar thin"><i style="width:${pct}%"></i></div><span>${num(a.value)} / ${num(a.goal)}</span></div>`}
      </div></div>`;
  };
  return `<div class="pf-wall-page">${vm.groups.map(g => `<section class="pf-card pf-group">
      <div class="pf-card-head"><h2>${esc(g.name)}</h2><span><b>${g.list.filter(a => a.unlockedAt).length}</b> / ${g.list.length}</span></div>
      <div class="pf-group-list">${g.list.map(row).join('')}</div></section>`).join('')}</div>`;
}

// ---------- 足迹 ----------
function trailHtml(vm) {
  const bars = (list, text) => list.map(x => `<div class="pf-row"><span class="pf-row-k" title="${esc(x.name)}">${esc(x.name)}</span><div class="pf-bar thin"><i style="width:${x.pct}%"></i></div><span class="pf-row-v">${text(x)}</span></div>`).join('');
  return `<div class="pf-trail">
      <section class="pf-card pf-trail-feat">
        <div class="pf-card-head"><h2>功能使用</h2><span>用过 <b>${vm.features.filter(f => f.count).length}</b> / ${vm.features.length} · 条长按次数开方</span></div>
        <div class="pf-rows">${bars(vm.features, f => (f.count ? num(f.count) + ' 次' : '还没用过'))}</div>
      </section>
      <div class="pf-trail-mid">
        <section class="pf-card pf-days">
          <div class="pf-card-head"><h2>近 14 天每日经验</h2><span>今天 <b>+${num(vm.todayXp)}</b></span></div>
          <div class="pf-cols">${vm.daily.map(d => `<div class="pf-col" title="${d.day} · +${d.xp} 经验 · ${d.prompts} 条消息"><em>${d.xp ? d.xp : ''}</em><i style="height:${Math.max(d.xp ? 4 : 0, d.pct)}%"></i><span>${d.label}</span></div>`).join('')}</div>
        </section>
        <section class="pf-card pf-models">
          <div class="pf-card-head"><h2>模型用量</h2><span>按 Token，不含缓存读取</span></div>
          <div class="pf-rows">${vm.models.length ? bars(vm.models, m => m.text) : '<p class="pf-empty">用量每天统计两次，有了就显示在这里。</p>'}</div>
        </section>
      </div>
      <section class="pf-card pf-year">
        <div class="pf-card-head"><h2>全年活跃</h2><span class="pf-year-note">从 ${esc(vm.firstDay || '今天')} 开始 · 最长连续 ${num(vm.bestStreak)} 天 · AI 答完 ${num(vm.turns)} 轮</span>${legend}</div>
        ${heatHtml(vm.year, 'year')}
      </section>
    </div>`;
}

// ---------- 名片 ----------
function cardHtml(vm) {
  return `<div class="pf-cardpage">
      <section class="pf-card pf-idcard">
        <div class="pf-id-top">${avatarHtml(vm, 'big')}<div><b class="pf-name">${esc(vm.name)}</b><div class="pf-from">${esc(vm.fromText)}${vm.identityAt ? ' · ' + esc(vm.identityAt) + ' 更新' : ''}</div></div>
          <button type="button" class="pf-btn" data-pf="reidentify">重新识别</button></div>
        <dl class="pf-fields">${vm.fields.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('')}
          <div><dt>WeLink</dt><dd class="pf-wl ${esc(vm.welinkState)}">${esc(vm.welinkText)}</dd></div>
          <div><dt>开始使用</dt><dd>${esc(vm.firstDay || '今天')}</dd></div>
          ${vm.version ? `<div><dt>当前版本</dt><dd>v${esc(vm.version)}</dd></div>` : ''}
        </dl>
        <p class="pf-privacy">这些信息只用来在这台电脑上显示你的名字，等级和成就也只存在本机，不上传、不做排行。</p>
      </section>
      <div class="pf-card-right">
        <section class="pf-card pf-ladder">
          <div class="pf-card-head"><h2>段位之路</h2><span>现在 <b>Lv.${vm.level}</b> · 累计 ${num(vm.totalXp)} 经验</span></div>
          <div class="pf-ranks">${vm.ranks.map(r => `<div class="pf-rankcell ${r.state}"><img src="assets/profile/rank-${r.n}.webp" alt="" draggable="false"><b>${esc(r.name)}</b><span>Lv.${r.from} 起</span></div>`).join('')}</div>
        </section>
        <section class="pf-card pf-rulecard">
          <div class="pf-card-head"><h2>经验怎么来</h2><span>每项有每日上限，用得多才涨得快</span></div>
          <div class="pf-rulegrid">${vm.rules.map(r => `<div><b>+${r.each}</b><span>${esc(r.label.replace(/（.*$/, ''))}</span><i>${/连续/.test(r.label) ? '每天 5×连续天数，最多 7 天' : r.cap && r.cap > 1 ? '每天最多 ' + r.cap + ' 次' : r.cap === 1 ? '每天一次' : ''}</i></div>`).join('')}
            <div><b>+${vm.tierXp.bronze || 0} / ${vm.tierXp.silver || 0} / ${vm.tierXp.gold || 0}</b><span>解锁铜 / 银 / 金成就</span><i></i></div></div>
        </section>
      </div>
    </div>`;
}

function pageHtml(vm, selected, tab = 'home') {
  const body = tab === 'wall' ? wallHtml(vm) : tab === 'trail' ? trailHtml(vm) : tab === 'card' ? cardHtml(vm) : homeHtml(vm, selected);
  return `<header class="pf-head">
      <div class="pf-title"><h1>个人</h1><span class="pf-sub">每一次使用，都在积累</span></div>
      <div class="pf-tabs" role="tablist">${TABS.map(t => `<button type="button" role="tab" aria-selected="${t.id === tab}" class="${t.id === tab ? 'on' : ''}" data-pf-tab="${t.id}">${t.name}</button>`).join('')}</div>
      <span class="pf-note">数据只留在这台电脑</span>
    </header>
    <div class="pf-body pf-tab-${tab}">${body}</div>`;
}

function createProfilePage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page = null, state = null, selected = '', tab = 'home', toastTimer = null, briefNow = null;
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('profile:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const vmNow = () => viewModel(state.snapshot, state.brief, state.extra);

  function nav() {
    let btn = document.getElementById('btn-profile');
    if (btn) return btn;
    const anchor = document.querySelector('#scene-rail .rail-utilities .rail-theme-wrapper') || document.getElementById('btn-theme');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-profile-entry'; btn.id = 'btn-profile'; btn.setAttribute('aria-label', '个人');
    btn.innerHTML = '<span class="pf-entry-avatar" data-slot="avatar"></span><span class="pf-entry-name" data-slot="name">个人</span><span class="pf-entry-lv" data-slot="lv"></span>';
    anchor.before(btn);
    btn.addEventListener('click', () => { if (page && !page.hidden) close(); else void open(); });
    return btn;
  }
  function paintEntry(brief) {
    const btn = nav(); if (!btn || !brief) return;
    briefNow = brief;
    const name = brief.name || '个人', vm = { initials: initials(brief.name), petRole: brief.pet && brief.pet.available ? brief.pet.role : '' };
    btn.querySelector('[data-slot="avatar"]').innerHTML = avatarHtml(vm) + (brief.fresh ? '<i class="pf-entry-dot"></i>' : '');
    btn.querySelector('[data-slot="name"]').textContent = name;
    btn.querySelector('[data-slot="lv"]').textContent = 'Lv.' + brief.level;
    btn.title = `${name} · Lv.${brief.level} ${brief.rankName}${brief.fresh ? ` · ${brief.fresh} 枚新成就` : ''}\n点开看等级、成就和使用记录`;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'profile-page'; page.id = 'profile-page'; page.hidden = true; page.setAttribute('aria-label', '个人');
    document.body.append(page);
    page.addEventListener('click', event => {
      const t = event.target.closest('[data-pf-tab]');
      if (t) { tab = t.dataset.pfTab; render(); return; }
      const badge = event.target.closest('[data-pf-badge]');
      if (badge) { selected = badge.dataset.pfBadge; page.querySelector('[data-slot="detail"]').innerHTML = detailHtml(vmNow().achievements.find(a => a.id === selected)); for (const b of page.querySelectorAll('.pf-badge.sel')) b.classList.remove('sel'); badge.classList.add('sel'); return; }
      const b = event.target.closest('[data-pf]');
      if (b) { event.preventDefault(); void action(b.dataset.pf, b).catch(e => showMessage?.(e.message)); }
    });
  }
  async function action(name, button) {
    if (name === 'reidentify') {
      button.disabled = true; button.textContent = '识别中…';
      try { const r = await call('refresh-identity'); state = { snapshot: r.snapshot, brief: r.brief, extra: r.extra }; render(); paintEntry(r.brief); } finally { button.disabled = false; }
    } else if (name === 'rename') {
      const slot = page.querySelector('[data-slot="name"]'), old = state.snapshot.identity.nickname || '';
      const input = document.createElement('input'); input.className = 'pf-name-input'; input.maxLength = 20; input.value = old || slot.textContent; input.placeholder = '留空就用自动识别的名字';
      slot.replaceWith(input); input.focus(); input.select();
      let done = false;
      const commit = async save => { if (done) return; done = true; if (save && input.value.trim() !== (old || slot.textContent)) { await call('set-nickname', { name: input.value }); } input.remove(); await load(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') void commit(true); else if (e.key === 'Escape') { e.stopPropagation(); void commit(false); } });
      input.addEventListener('blur', () => { void commit(true); });
    } else if (name === 'pet-on') {
      await ipcRenderer.invoke('hub-pet:set-settings', { enabled: true });
      await load();
    }
  }
  function render() {
    if (!page || !state) return;
    // 正在改称呼时不重画，免得把输入框冲掉
    if (page.querySelector('.pf-name-input')) return;
    page.innerHTML = pageHtml(vmNow(), selected, tab);
  }
  async function load() { const r = await call('state'); state = { snapshot: r.snapshot, brief: r.brief, extra: r.extra }; render(); paintEntry(r.brief); }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }
  const onResize = () => place();
  async function open(openTab) {
    build(); closeOtherPanels();
    for (const name of ['__companyRoomsHide', '__companyMeetingHide', '__assistantHide', '__wirelessHide', '__companyAssistantHide', '__companyForumHide', '__companyPptHide', '__companyAttendanceHide', '__companyW3Hide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    if (TABS.some(t => t.id === openTab)) tab = openTab;
    page.hidden = false; document.body.classList.add('profile-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    try { await load(); } catch (error) { showMessage?.('个人页读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('profile-page-open');
    document.getElementById('btn-profile')?.classList.remove('active');
    window.removeEventListener('resize', onResize);
    // 看过了：新成就的「新」标记和入口上的小红点清掉。
    void call('seen').catch(() => {});
  }

  // 升级、解锁成就时窗口顶部弹一条提示，点一下打开个人页。
  function toast(ev) {
    let el = document.getElementById('profile-toast');
    if (!el) { el = document.createElement('button'); el.type = 'button'; el.id = 'profile-toast'; el.className = 'pf-toast'; document.body.append(el); el.addEventListener('click', () => { el.classList.remove('show'); void open('home'); }); }
    const art = ev.type === 'level-up' ? `assets/profile/rank-${ev.rank}.webp` : `assets/profile/badge-${ev.icon}.webp`;
    el.innerHTML = `<img src="${art}" alt=""><span><b>${esc(ev.title)}</b><i>${esc(ev.text)}</i></span>`;
    el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-profile):not(#btn-theme):not(#btn-options)')) close(); });
  ipcRenderer.on('profile:changed', (_e, brief) => { paintEntry(brief); if (page && !page.hidden) void load().catch(() => {}); });
  ipcRenderer.on('profile:event', (_e, ev) => { if (ev) toast(ev); });
  void call('brief').then(r => paintEntry(r.brief)).catch(() => {});
  return { open, close, isOpen: () => !!page && !page.hidden, _brief: () => briefNow };
}

module.exports = { createProfilePage, viewModel, pageHtml, initials, TABS };
