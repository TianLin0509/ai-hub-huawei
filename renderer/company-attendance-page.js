'use strict';
// 公司版「考勤」页（2026-11-07）：读自己的打卡记录（core/company-attendance/），算加班、80 小时红线和年度统计。
// 首屏只放关键数：本月净加班大数字 + 到 80 小时红线的进度、平均离开时间、折算日均工时、守住红线每天最晚几点走、本月每天的小卡片，
// 下面是年度统计；明细（时间轴 / 账本）点卡片或「查看打卡明细」从右侧抽屉打开。
// 写法同论坛页：盖在主区域上的一层，点左侧其他按钮自动关闭；默认关闭，由可选功能开关（optional-feature-gate）开启。
const A = require('../core/attendance-calc');

const KIND = { workday: '', lastSaturday: '月末周六 · 正常上班', weekend: '周末 · 全天算加班', holiday: '节假日 · 全天算加班' };

function viewModel(status, now = new Date()) {
  const holidays = {};
  for (const k of Object.keys(status?.holidays || {})) holidays[k] = true;
  const r = status?.rules || A.rulesFromWorkTime({});
  const opts = { holidays, rules: { amEnd: r.amEnd, pmStart: r.pmStart, owePerWorkday: r.owePerWorkday } };
  const days = A.buildDays(status?.records || [], opts);
  const today = status?.today || A.dateKey(now);
  const ym = today.slice(0, 7);
  const month = A.monthReport(days, ym, today, opts);
  const year = A.yearReport(days, Number(today.slice(0, 4)), today, opts);
  return { days, today, ym, month, year, opts, work: r };
}

function createCompanyAttendancePage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page = null, status = null, vm = null, timer = null, gate = null, panelOpen = false;
  let drawer = { open: false, ym: '', view: 'time', focus: '' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h1 = m => A.fmtHours(m);
  const hm = m => A.fmtHm(m);
  const clk = m => (m == null ? '—' : A.fmtClock(m) + (m >= 1440 ? '<sup class="att-next">+1</sup>' : ''));
  const md = k => `${Number(k.slice(5, 7))}/${k.slice(8, 10)}`;
  const when = at => { if (!at) return '—'; const d = new Date(at), t = new Date(); const c = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; return d.toDateString() === t.toDateString() ? '今天 ' + c : `${d.getMonth() + 1}/${d.getDate()} ${c}`; };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-attendance:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const badge = t => `<i class="att-bd${t === '手' ? ' m' : ''}">${esc(t || '·')}</i>`;

  function nav() {
    let btn = document.getElementById('btn-company-attendance');
    if (btn) return btn;
    const anchor = document.getElementById('btn-company-forum') || document.getElementById('btn-company-meeting') || document.getElementById('btn-company-assistant') || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-attendance';
    btn.title = '考勤 · 打卡记录、加班统计与 80 小时红线（数据只留本机）'; btn.setAttribute('aria-label', '考勤');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9.5 2.5h5M12 2.5V5"/></svg></span><span class="btn-label">考勤</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-attendance-page'; page.id = 'company-attendance-page'; page.hidden = true; page.setAttribute('aria-label', '考勤');
    page.innerHTML = `<header class="att-head">
        <div class="att-title"><h1>考勤</h1><span class="att-sub">加班统计 · 数据只留在这台电脑</span></div>
        <div class="att-status" data-slot="status"></div>
        <button type="button" class="att-btn primary" data-att="drawer">查看打卡明细</button>
        <button type="button" class="att-btn" data-att="sync" title="现在打开考勤页读一次最近 8 天">刷新</button>
        <button type="button" class="att-btn" data-att="settings">设置</button>
      </header>
      <div class="att-panel" data-slot="panel" hidden></div>
      <div class="att-scroll"><div class="att-body" data-slot="body"></div></div>
      <div class="att-drawer" data-slot="drawer" hidden></div>`;
    document.body.append(page);
    gate = require('./optional-feature-gate').createFeatureGate({ document, window, id: 'attendance', page, showMessage,
      badgeSlot: b => page.querySelector('[data-att="sync"]').before(b), onEnabled: () => { void startData(); } });
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-att]');
      if (b) { event.preventDefault(); void action(b.dataset.att, b).catch(e => showMessage?.(e.message)); }
    });
    page.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.open) { drawer.open = false; renderDrawer(); } });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function statusHtml() {
    const s = status, chips = [];
    if (s.syncing) chips.push('<span class="att-chip run">正在读取考勤…</span>');
    else if (s.lastResult && !s.lastResult.ok) chips.push(`<span class="att-chip bad" title="${esc(s.lastResult.error)}">${s.lastResult.needsLogin ? '需要登录' : '上次读取失败'} · ${when(s.lastResult.at)}</span>`);
    else if (s.lastSuccessAt) chips.push(`<span class="att-chip ok">${when(s.lastSuccessAt)} 读取成功</span>`);
    else chips.push('<span class="att-chip">还没读取过</span>');
    if (s.records.length) chips.push(`<span class="att-chip plain">已累计 ${s.records.length} 天</span>`);
    return chips.join('');
  }
  function capBar() {
    const m = vm.month, pct = Math.max(0, Math.min(100, m.net / m.cap * 100)), pp = Math.max(0, Math.min(100, m.projected / m.cap * 100));
    return `<div class="att-cap"><div class="att-cap-proj" style="width:${pp}%"></div><div class="att-cap-now" style="width:${pct}%"></div><div class="att-cap-line"></div></div>
      <div class="att-cap-legend"><span>已净加班 <b>${h1(m.net)}h</b></span>${m.leftWorkdays ? `<span>按当前节奏月底 <b class="${m.willExceed ? 'red' : ''}">≈${Math.round(m.projected / 60)}h</b></span>` : ''}<span class="red">红线 ${Math.round(m.cap / 60)}h</span></div>`;
  }
  function alerts() {
    const m = vm.month, out = [];
    if (m.over) out.push(`<div class="att-alert">本月净加班已到 <b>${h1(m.net)}</b> 小时，超过 80 小时红线 <b>${h1(m.net - m.cap)}</b> 小时，可能会被提示加班过长。</div>`);
    else if (m.willExceed && m.workdays >= 2) out.push(`<div class="att-alert"><b>加班过长预警</b>按当前节奏，本月净加班约 <b>${Math.round(m.projected / 60)}</b> 小时，会超过 80 小时红线。想守住：剩下 ${m.leftWorkdays} 个工作日，每天净加班不超过 <b>${h1(Math.max(0, m.perDayAllowance))}</b> 小时${m.leaveBy != null ? `，约 <b>${A.fmtClock(m.leaveBy)}</b> 前离开` : ''}，周末不来。</div>`);
    if (status.gapRisk) out.push(`<div class="att-alert warn">已经 ${status.staleDays} 天没读到考勤了。考勤页只保留最近 8 天，再过 ${Math.max(0, 8 - status.staleDays)} 天会出现记录缺口，请点「刷新」或检查登录。</div>`);
    return out.join('');
  }
  function kpi(label, value, unit, note, cls = '') { return `<div class="att-card att-kpi"><div class="l">${label}</div><div class="v ${cls}">${value}<small>${unit}</small></div><div class="n">${note}</div></div>`; }
  function strip(list) {
    return `<div class="att-strip">${list.slice().reverse().map(x => `<button type="button" class="att-day${A.isWorkKind(x.kind) ? '' : ' rest'}" data-att="day" data-date="${x.date}">
      <span class="t">${md(x.date)} 周${x.weekdayName}</span><span class="v">+${hm(x.ot)}</span><span class="m">${clk(x.arrive)}–${clk(x.leave)}</span>${x.leave >= 1320 ? '<i class="dot"></i>' : ''}</button>`).join('')}</div>`;
  }
  function yearHtml() {
    const y = vm.year, cap = 80 * 60, max = Math.max(cap * 1.25, ...y.months.filter(m => m.hasData).map(m => m.net));
    const W = 720, H = 200, T = 18, B = 26, bw = W / 12;
    const Y = v => T + (1 - Math.max(0, v) / max) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${y.year} 年逐月净加班"><line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" class="ax"/>`;
    svg += `<line x1="0" x2="${W}" y1="${Y(cap)}" y2="${Y(cap)}" class="capline"/><text x="${W - 4}" y="${Y(cap) - 5}" text-anchor="end" class="captext">80 小时</text>`;
    y.months.forEach((m, i) => {
      const x = i * bw + bw * 0.24, w = bw * 0.52;
      if (m.hasData) {
        const hgt = H - B - Y(m.net);
        svg += `<g class="bar${m.over ? ' over' : ''}${m.ym === vm.ym ? ' cur' : ''}" data-att="month" data-ym="${m.ym}"><rect x="${x}" y="${Y(m.net)}" width="${w}" height="${Math.max(hgt, 1)}" rx="5"/><text x="${x + w / 2}" y="${Y(m.net) - 5}" text-anchor="middle" class="val">${h1(m.net)}</text></g>`;
      }
      svg += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle" class="lab">${m.month} 月</text>`;
    });
    svg += '</svg>';
    const facts = [];
    if (y.peakMonth) facts.push(`<div><span>加班最多的月份</span><b>${y.peakMonth.month} 月 · ${h1(y.peakMonth.net)}h</b></div>`);
    facts.push(`<div><span>超过 80 小时的月份</span><b class="${y.overMonths ? 'red' : ''}">${y.overMonths} 个</b></div>`);
    if (y.avgLeave != null) facts.push(`<div><span>工作日平均离开</span><b>${clk(y.avgLeave)}</b></div>`);
    if (y.busiestWeekday) facts.push(`<div><span>走得最晚的是</span><b>周${y.busiestWeekday.name} · 平均 ${clk(y.busiestWeekday.avgLeave)}</b></div>`);
    if (y.latestLeave) facts.push(`<div><span>最晚一次离开</span><b>${md(y.latestLeave.date)} · ${clk(y.latestLeave.leave)}</b></div>`);
    facts.push(`<div><span>周末 / 节假日到岗</span><b>${y.restDays} 天</b></div>`);
    return `<section class="att-card att-year"><h2>${y.year} 年<small>从 ${y.firstDate ? md(y.firstDate) : '—'} 开始记录 · 点柱子看当月明细</small></h2>
      <div class="att-year-top"><div class="att-year-big"><div class="l">全年净加班</div><div class="v">${h1(y.net)}<small>小时</small></div><div class="n">≈ 多上了 ${y.equivalentDays.toFixed(1)} 天班 · 在岗 ${h1(y.span)} 小时</div></div><div class="att-year-chart">${svg}</div></div>
      <div class="att-facts">${facts.join('')}</div></section>`;
  }
  function rulesHtml() {
    const w = vm.work, t = w.workTime;
    const owe = w.owePerWorkday ? `规定每天 8 小时，每个出勤工作日扣 ${h1(w.owePerWorkday)} 小时，按月统计` : '已满 8 小时，工作日不扣';
    return `<details class="att-rules"><summary>加班怎么算</summary><ul>
      <li>核心工作时间 ${t.amStart}–${t.amEnd}、${t.pmStart}–${t.pmEnd}，共 ${h1(w.ratedMinutes)} 小时；${owe}。可在「考勤设置」里改成你自己的时间。</li>
      <li>工作日 ${t.amStart} 前和 ${t.eveningFrom} 后算加班；一天从 05:00 算起，凌晨 05:00 前的打卡算前一天。</li>
      <li>周末、节假日整段在岗都算加班；月末周六是正常上班日，和工作日一样算。节假日以考勤系统的假期日历为准。</li>
      <li>只算有打卡的时段：同一天离开后又回来，中间不算。考勤页只给最近 8 天，Hub 每天读一次并按日期拼起来。</li></ul></details>`;
  }
  function bodyHtml() {
    if (!status.records.length) {
      return `<div class="att-empty"><h2>还没有考勤数据</h2><p>${status.syncing ? '正在打开考勤页读取最近 8 天，通常半分钟，最长约 3 分钟。' : esc(status.lastResult?.error || '开启后每天会在后台读一次；也可以现在就读。')}</p>
        ${status.lastResult?.needsDomain && !status.settings?.domain ? '<div class="att-row"><input class="att-input" data-f="quickDomain" placeholder="你的公司邮箱，例如 name@corp.example"><button type="button" class="att-btn primary" data-att="quick-domain">保存并读取</button></div>' : ''}
        <div class="att-row">${status.lastResult?.needsLogin ? '<button type="button" class="att-btn primary" data-att="login">登录考勤</button>' : ''}<button type="button" class="att-btn${status.lastResult?.needsLogin ? '' : ' primary'}" data-att="sync">现在读取</button></div></div>`;
    }
    const m = vm.month;
    const hero = `<section class="att-card att-hero"><div class="att-hero-num"><div class="l">${Number(vm.ym.slice(5))} 月净加班 · 截至 ${md(vm.today)}</div>
        <div class="v">${h1(m.net)}<small>小时</small></div><div class="n">相当于多上了 <b>${m.equivalentDays.toFixed(1)}</b> 天班（每天 8 小时）</div></div>
        <div class="att-hero-cap">${capBar()}<div class="att-hero-sub">加班 ${h1(m.gross)} − 扣除 ${h1(m.owe)}（${m.workdays} 个工作日 × ${h1(vm.work.owePerWorkday)}）· 本月 ${m.monthWorkdays} 个工作日</div></div></section>`;
    const k = `<div class="att-kpis">${
      kpi('工作日平均离开', m.avgLeave != null ? A.fmtClock(m.avgLeave) : '—', '', m.avgLeave != null ? `比 ${vm.work.workTime.eveningFrom} 晚 ${hm(Math.max(0, m.avgLeave - vm.work.pmStart))} · ${m.workdays} 天里 ${m.late22} 天过了 22 点` : '本月还没有工作日记录')}${
      kpi('折算日均工时', h1(m.convertedDaily), '小时', `规定 8 小时 + 日均净加班 ${h1(m.avgNetPerWorkday)}`)}${
      m.leftWorkdays && m.leaveBy != null && m.perDayAllowance >= 0
        ? kpi('守住 80 小时', A.fmtClock(m.leaveBy), '前离开', `剩 ${m.leftWorkdays} 个工作日 · 每天净加班 ≤ ${h1(m.perDayAllowance)}h`, m.willExceed ? 'red' : '')
        : kpi('离红线还剩', h1(Math.max(0, m.budget)), '小时', m.over ? '本月已超过红线' : '本月工作日已过完', m.over ? 'red' : '')}</div>`;
    const days = m.days.length ? `<section class="att-card"><h2>本月每天<small>点一天看明细 · 橙点 = 22 点后离开 · 橙字 = 周末或节假日</small></h2>${strip(m.days)}</section>` : '';
    return alerts() + hero + k + days + yearHtml() + rulesHtml();
  }

  function timelineHtml(list) {
    const X = v => ((v - 300) / 1440 * 100).toFixed(2) + '%', W = v => (v / 1440 * 100).toFixed(2) + '%';
    let h = `<div class="att-tl"><div></div><div class="ax">${[[5, 300], [9, 540], [13, 780], [18, 1080], [22, 1320], ['次日 2', 1560]].map(([t, v]) => `<span style="left:${X(v)}">${t}</span>`).join('')}</div><div class="r">加班</div><div></div>`;
    for (const x of list) {
      let tr = `<div class="tr">${A.isWorkKind(x.kind) ? `<div class="std" style="left:${X(540)};width:${W(210)}"></div><div class="std" style="left:${X(810)};width:${W(240)}"></div>` : ''}`;
      for (const s of x.segs) {
        const AM = vm.opts.rules.amEnd, PM = vm.opts.rules.pmStart;
        const parts = A.isWorkKind(x.kind) ? [[s.a, Math.min(s.b, AM), 1], [Math.max(s.a, AM), Math.min(s.b, PM), 0], [Math.max(s.a, PM), s.b, 1]] : [[s.a, s.b, 1]];
        for (const p of parts) if (p[1] > p[0]) tr += `<div class="br${p[2] ? ' ot' : ''}" style="left:${X(p[0])};width:${W(p[1] - p[0])}"></div>`;
        tr += `<span class="pt" style="left:${X(s.a)}">${badge(s.ta)}</span><span class="pt" style="left:${X(s.b)}">${badge(s.tb)}</span>`;
        tr += s.b - s.a < 90 ? `<span class="tx" style="left:${X((s.a + s.b) / 2)}">${clk(s.a)}–${clk(s.b)}</span>` : `<span class="tx" style="left:${X(s.a)}">${clk(s.a)}</span><span class="tx" style="left:${X(s.b)}">${clk(s.b)}</span>`;
      }
      const tags = [KIND[x.kind] ? `<span class="att-tag ${A.isWorkKind(x.kind) ? 'mute' : 'blue'}">${KIND[x.kind]}</span>` : '', x.leave >= 1320 ? '<span class="att-tag amber">22 点后离开</span>' : '', x.nightReturn ? '<span class="att-tag amber">凌晨回来过</span>' : '', x.manual ? '<span class="att-tag mute">有手动卡</span>' : ''].join('');
      h += `<div class="dd${x.date === drawer.focus ? ' hl' : ''}">${md(x.date)}<small>周${x.weekdayName}</small></div>${tr}</div><div class="hh">+${hm(x.ot)}</div><div class="tg">${tags}</div>`;
    }
    return h + '</div>';
  }
  function ledgerHtml(list, sum) {
    const row = x => `<tr class="${x.date === drawer.focus ? 'hl' : ''}${A.isWorkKind(x.kind) ? '' : ' rest'}"><td>${md(x.date)}</td><td>周${x.weekdayName}</td><td>${clk(x.arrive)} ${badge(x.arriveTag)}</td><td>${clk(x.leave)} ${badge(x.leaveTag)}</td><td class="r">${hm(x.span)}</td><td class="r">${x.otAm ? x.otAm + '′' : '—'}</td><td class="r">${x.otPm ? hm(x.otPm) : '—'}</td><td class="r">${x.otRest ? hm(x.otRest) : '—'}</td><td class="r">${x.owe ? '−0h30' : '—'}</td><td class="r"><b>${x.net < 0 ? '' : '+'}${hm(x.net)}</b></td></tr>`;
    return `<table class="att-ledger"><thead><tr><th>日期</th><th>星期</th><th>首次</th><th>末次</th><th class="r">在岗</th><th class="r">早上</th><th class="r">晚上</th><th class="r">周末/假日</th><th class="r">扣除</th><th class="r">净加班</th></tr></thead><tbody>
      <tr class="sum"><td colspan="4">合计 · 工作日 ${sum.workdays} 天 · 周末/假日 ${sum.restDays} 天</td><td class="r">${h1(sum.span)}</td><td class="r">${h1(sum.am)}</td><td class="r">${h1(sum.pm)}</td><td class="r">${h1(sum.rest)}</td><td class="r">−${h1(sum.owe)}</td><td class="r">${h1(sum.net)}h</td></tr>
      ${list.map(row).join('')}</tbody></table>`;
  }
  function monthsWithData() { return [...new Set(vm.days.map(x => x.date.slice(0, 7)))].sort(); }
  function renderDrawer() {
    const el = page?.querySelector('[data-slot="drawer"]');
    if (!el) return;
    if (!drawer.open || !vm) { el.hidden = true; el.innerHTML = ''; return; }
    const months = monthsWithData();
    if (!months.includes(drawer.ym)) drawer.ym = months[months.length - 1] || vm.ym;
    const list = vm.days.filter(x => x.date.slice(0, 7) === drawer.ym);
    const sum = A.summarize(list);
    const i = months.indexOf(drawer.ym);
    el.hidden = false;
    el.innerHTML = `<div class="att-mask" data-att="close"></div><aside class="att-dpanel" role="dialog" aria-label="打卡明细">
      <div class="att-dhead"><b>打卡明细</b>
        <span class="att-month"><button type="button" data-att="prev" ${i <= 0 ? 'disabled' : ''} aria-label="上个月">‹</button><span>${drawer.ym.slice(0, 4)} 年 ${Number(drawer.ym.slice(5))} 月</span><button type="button" data-att="next" ${i >= months.length - 1 ? 'disabled' : ''} aria-label="下个月">›</button></span>
        <span class="att-seg"><button type="button" data-att="view" data-v="time" class="${drawer.view === 'time' ? 'on' : ''}">时间轴</button><button type="button" data-att="view" data-v="ledger" class="${drawer.view === 'ledger' ? 'on' : ''}">账本</button></span>
        <span class="att-dsum">净加班 <b>${h1(sum.net)}</b> 小时</span>
        <button type="button" class="att-x" data-att="close" aria-label="关闭">×</button></div>
      <div class="att-dnote">浅蓝块 = 额定上班 · 橙线 = 算加班 · 智 / 手 = 智能 / 手动打卡</div>
      <div class="att-dbody">${list.length ? (drawer.view === 'time' ? timelineHtml(list) : ledgerHtml(list, sum)) : '<div class="att-empty"><p>这个月没有记录</p></div>'}</div></aside>`;
    // 只滚抽屉自己的列表：scrollIntoView 会连带滚动整页外框，把页头推出视口。
    const body = el.querySelector('.att-dbody'), hl = drawer.focus && el.querySelector('.hl');
    if (body && hl) body.scrollTop = Math.max(0, hl.offsetTop - body.clientHeight / 2);
  }

  function renderPanel() {
    const el = page.querySelector('[data-slot="panel"]');
    el.hidden = !panelOpen;
    if (!panelOpen) { el.innerHTML = ''; return; }
    const s = status.settings || {};
    const wt = s.workTime || A.DEFAULT_WORK_TIME;
    el.innerHTML = `<div class="att-card att-settings"><h2>考勤设置</h2>
      <label class="att-field"><span>公司域名（考勤地址用它拼出）</span><input data-f="domain" value="${esc(s.domain || '')}" placeholder="自动找到；也可填公司邮箱或域名"></label>
      <div class="att-field"><span>核心工作时间（加班按它算）</span>
        <div class="att-time-row">上午 <input type="time" data-w="amStart" value="${esc(wt.amStart)}"> – <input type="time" data-w="amEnd" value="${esc(wt.amEnd)}">
        下午 <input type="time" data-w="pmStart" value="${esc(wt.pmStart)}"> – <input type="time" data-w="pmEnd" value="${esc(wt.pmEnd)}"></div>
        <div class="att-time-row">晚上 <input type="time" data-w="eveningFrom" value="${esc(wt.eveningFrom)}"> 之后算加班（默认下班后 30 分钟）<button type="button" class="att-btn" data-att="worktime-reset">恢复默认</button></div></div>
      <label class="att-check"><input type="checkbox" data-f="autoDaily" ${s.autoDaily !== false ? 'checked' : ''}> 每天自动读取一次（当天读到就不再访问）</label>
      <p class="att-note">读取地址：${esc(status.url || '正在自动查找公司域名…')}${s.domainFrom && s.domainFrom !== 'settings' ? '（域名是自动找到的）' : ''}</p>
      <div class="att-row"><button type="button" class="att-btn" data-att="login">在 Hub 里登录考勤</button><span class="att-sp"></span><button type="button" class="att-btn" data-att="settings">取消</button><button type="button" class="att-btn primary" data-att="save">保存</button></div>
      ${status.log?.length ? `<h3>最近读取</h3><ul class="att-log">${status.log.slice(0, 6).map(e => `<li><span>${when(e.at)}</span><span class="${e.ok ? 'ok' : 'bad'}">${e.ok ? '成功' : '失败'}</span><span>${e.ok ? `拿到 ${e.got} 天，新增 ${e.added}，更新 ${e.updated}${e.via === 'edge' ? '（无头 Edge）' : ''}` : esc(e.error)}</span></li>`).join('')}</ul>` : ''}</div>`;
  }

  function render() {
    if (!page || !status) return;
    vm = viewModel(status);
    page.querySelector('[data-slot="status"]').innerHTML = statusHtml();
    page.querySelector('[data-slot="body"]').innerHTML = bodyHtml();
    page.querySelector('[data-att="drawer"]').hidden = !status.records.length;
    // 设置面板开着时不重画：定时刷新会冲掉用户正在填的内容。
    if (!panelOpen || !page.querySelector('[data-slot="panel"] .att-settings')) renderPanel();
    renderDrawer();
  }
  async function load() { status = await call('status'); render(); }

  async function action(name, el) {
    if (name === 'sync') { el.disabled = true; showMessage?.('正在读取考勤，通常半分钟，最长约 3 分钟'); try { status = await call('sync'); render(); const r = status.lastResult; showMessage?.(r?.ok ? `读到 ${r.got} 天，新增 ${r.added}、更新 ${r.updated}` : '读取失败：' + (r?.error || '')); } finally { el.disabled = false; } return; }
    if (name === 'quick-domain') {
      const v = page.querySelector('[data-f="quickDomain"]').value.trim();
      if (!v) { showMessage?.('填一下公司邮箱或域名'); return; }
      const saved = await call('set-settings', { domain: v });
      if (!(saved?.settings?.domain || saved?.domain)) { showMessage?.('没认出公司域名，请填完整的公司邮箱，例如 name@corp.example'); return; }
      return action('sync', el);
    }
    if (name === 'worktime-reset') {
      for (const [k, val] of Object.entries(A.DEFAULT_WORK_TIME)) { const i = page.querySelector(`[data-w="${k}"]`); if (i) i.value = val; }
      return;
    }
    if (name === 'settings') { panelOpen = !panelOpen; renderPanel(); return; }
    if (name === 'save') {
      const v = f => page.querySelector(`[data-f="${f}"]`);
      const workTime = {};
      for (const i of page.querySelectorAll('[data-w]')) workTime[i.dataset.w] = i.value;
      const check = A.normalizeWorkTime(workTime);
      if (!check.ok) { showMessage?.('核心工作时间不对：' + check.error); return; }
      await call('set-settings', { domain: v('domain').value, autoDaily: v('autoDaily').checked, workTime });
      panelOpen = false; await load(); showMessage?.('考勤设置已保存'); return;
    }
    if (name === 'login') { el.disabled = true; try { const r = await call('login'); showMessage?.(r?.ok ? '已登录，正在读取考勤' : (r?.error || '登录窗口已关闭')); } finally { el.disabled = false; await load(); } return; }
    if (name === 'drawer') { drawer = { open: true, ym: vm.ym, view: drawer.view, focus: '' }; renderDrawer(); return; }
    if (name === 'day') { drawer = { open: true, ym: el.dataset.date.slice(0, 7), view: drawer.view, focus: el.dataset.date }; renderDrawer(); return; }
    if (name === 'month') { drawer = { open: true, ym: el.dataset.ym, view: drawer.view, focus: '' }; renderDrawer(); return; }
    if (name === 'close') { drawer.open = false; renderDrawer(); return; }
    if (name === 'view') { drawer.view = el.dataset.v; renderDrawer(); return; }
    if (name === 'prev' || name === 'next') {
      const months = monthsWithData(), i = months.indexOf(drawer.ym) + (name === 'next' ? 1 : -1);
      if (months[i]) { drawer.ym = months[i]; drawer.focus = ''; renderDrawer(); }
    }
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels();
    window.__companyRoomsHide?.();
    window.__companyMeetingHide?.(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyAssistantHide?.(); window.__companyForumHide?.(); window.__companyPptHide?.();
    for (const name of ['__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    window.setShellNavActive?.('company-attendance');
    page.hidden = false; document.body.classList.add('company-attendance-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = null;
    if (await gate.check()) await startData();
  }
  async function startData() {
    if (!page || page.hidden) return;
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 30000);
    try { status = await call('ensure-today'); render(); } catch (error) { showMessage?.('考勤状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-attendance-page-open');
    document.getElementById('btn-company-attendance')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
    drawer.open = false; renderDrawer();
  }
  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-attendance)')) close(); });
  ipcRenderer.on('company-attendance:changed', () => { if (page && !page.hidden && status) void load().catch(() => {}); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}

module.exports = { createCompanyAttendancePage, viewModel };
