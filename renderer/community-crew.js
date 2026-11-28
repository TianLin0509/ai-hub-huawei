'use strict';
// 社区 › 我的团队（2026-11-28）：团队小屋。黄区局域网里按 IP 组队，成员的桌宠住在同一间小屋里。
// 底部「对桌宠说」一句话：分享文件夹（先确认，再加密送到对方）、问同事的 agent、告诉大家一件事。
// 右侧：动态 / 来信 / 分享 / 成员 / 规则。所有交流双方完全可见；通信与加密都在主进程（community-crew:*）。
const { createScene, petSrc, esc } = require('./community-scene');
const { hasPendingEdits } = require('./community-editing');

const SPOTS = [[38, 70], [22, 62], [62, 64], [78, 74], [54, 84], [30, 86], [70, 86], [46, 60], [86, 62], [14, 80], [60, 76], [26, 74]];
const INTENT = { ask: '查口径', progress: '问进度', review: '请评审', task: '委托跑活', person: '人员评价' };
const RULE = { auto: '自动答（需配资料）', draft: '起草等我确认', reject: '拒绝' };
const ST = { on: '在线', busy: '专注中', away: '离开' };
const size = n => { n = Number(n) || 0; return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
const clock = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const daysLeft = (exp, now = Date.now()) => Math.max(0, Math.ceil((exp - now) / 86400000));

function statusPill(i) {
  const s = i.status;
  if (s === 'queued') return '<span class="cc-pill wait">排队处理中</span>';
  if (s === 'auto') return '<span class="cc-pill auto">已自动答</span>';
  if (s === 'sent') return i.mine ? (i.answer ? '<span class="cc-pill auto">已回信</span>' : '<span class="cc-pill in">等对方回</span>') : '<span class="cc-pill done">你已回复</span>';
  if (s === 'wait' || s === 'answering') return '<span class="cc-pill wait">等你确认</span>';
  if (s === 'rejected') return '<span class="cc-pill no">已拒绝</span>';
  if (s === 'ignored') return '<span class="cc-pill done">已忽略</span>';
  if (s === 'expired') return '<span class="cc-pill done">已过期</span>';
  return '';
}

function createCrew({ host, ipcRenderer, toast, onSnapshot = () => {} }) {
  const invoke = (name, req) => ipcRenderer.invoke('community-crew:' + name, req || {}).catch(e => ({ ok: false, error: e.message }));
  const root = document.createElement('div');
  root.className = 'cmy-sub'; root.dataset.sub = 'crew';
  root.innerHTML = `<div class="cc-crews" data-slot="crews"></div>
    <div class="cc-mid">
      <div class="cc-scene" data-slot="scene"><img class="bg" src="assets/community/room.svg" alt="">
        <div class="cc-board" data-slot="board"></div>
        <div class="cc-hud" style="left:14px;top:12px"><span class="cc-chip" data-slot="title"></span></div>
        <div class="cc-hud" style="right:14px;top:12px"><span class="cc-chip"><span>团队内可以聊进展和卡点</span> <span class="cc-vis">双方完全可见</span></span></div>
        <div class="cc-confirm" data-slot="confirm"></div>
        <div class="cc-setup" data-slot="setup" hidden></div>
      </div>
      <div class="cc-cmd"><div class="av"><img data-slot="cmdav" alt=""></div><input data-slot="cmd" maxlength="600"><button class="cc-btn pri" data-cc="run">交给它</button></div>
      <div class="cc-sugg" data-slot="sugg"></div>
    </div>
    <aside class="cc-panel"><div class="cc-tabs" data-slot="tabs"></div><div class="cc-pb" data-slot="body"></div></aside>`;
  host.append(root);
  const $ = s => root.querySelector(`[data-slot="${s}"]`);
  const sceneEl = $('scene');
  const scene = createScene(sceneEl, { depth: [55, 92], minS: 1.0, maxS: 1.22, onPick: o => pickPet(o) });
  let snap = null, cur = '', tab = 'feed', openMail = '', setupMode = '', inviteOut = null, flowBusy = false, visible = false, busyConfirm = false, shareErr = '', triedDetect = false;
  const crew = () => (snap && snap.crews.find(c => c.id === cur)) || (snap && snap.crews[0]) || null;
  const meM = () => { const c = crew(); return c ? c.members.find(m => m.me) : null; };
  const member = id => { const c = crew(); return c ? c.members.find(m => m.id === id) : null; };
  const nickOf = id => { const m = member(id); return m ? m.nick : '同事'; };

  async function load(force = false) {
    const r = await invoke('snapshot');
    if (!r || r.ok === false) { snap = null; if (r && r.state === 'disabled') setupMode = 'disabled'; paint(force || setupMode === 'disabled'); return; }
    snap = r;
    if (!crew() || !snap.crews.some(c => c.id === cur)) cur = snap.crews[0] ? snap.crews[0].id : '';
    onSnapshot(snap);
    paint(force);
  }
  let reloadTimer = null;
  const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { void load(); }, 250); };

  // ---------- 绘制 ----------
  function paint(force = false) {
    if (!force && hasPendingEdits(root)) return;
    paintCrews(); paintScene(); paintSetup(); paintTabs(); paintBody();
    const me = meM();
    $('cmdav').src = petSrc(me ? me.pet : '01-cat', 'happy').src;
    const pn = (me && me.petName) || '桌宠';
    $('cmd').placeholder = `对${pn}说：把哪个文件夹分享给谁、怎么用；或者让它去问谁什么；或者告诉大家一件事`;
    const c = crew(), other = c ? c.members.find(m => !m.me) : null, who = other ? other.nick : '同事';
    $('sugg').innerHTML = [`把 D:\\我的脚本 分享给${who}，用法是 python run.py`, `问问${who} 这个参数现网用多少`, '告诉大家我今晚挂仿真，明早出结果']
      .map(s => `<button type="button" data-sugg="${esc(s)}" data-i18n-skip>${esc(s)}</button>`).join('');
  }
  function paintCrews() {
    const crews = (snap && snap.crews) || [];
    $('crews').innerHTML = `<div class="cc-note">我的团队</div>` + crews.map(c => `<div class="cc-crew${c.id === cur ? ' on' : ''}" data-crew="${esc(c.id)}"><div class="tn" data-i18n-skip>${esc(c.name)}</div>
        <div class="tm">${c.members.slice(0, 8).map(m => `<img src="${esc(petSrc(m.pet).src)}" alt="">`).join('')}</div>
        <div class="ts"><span>${c.members.length} 人</span> · <span>${c.members.filter(m => m.online).length} 人在线</span></div></div>`).join('') +
      `<button class="cc-btn" data-cc="new" style="border-style:dashed">＋ 建一个团队</button><button class="cc-btn" data-cc="join">加入团队</button>
      <p class="cc-note" style="margin-top:auto">成员靠 IP 互连，信只在公司内网的电脑之间传，团队内容全程加密。</p>`;
  }
  function boardBox() {
    const r = sceneEl.getBoundingClientRect();
    const k = Math.max(r.width / 1000, r.height / 560), ox = (r.width - 1000 * k) / 2, oy = (r.height - 560 * k) / 2;
    return { left: 390 * k + ox, top: 40 * k + oy, width: 260 * k, height: 150 * k, k };
  }
  function paintScene() {
    const c = crew();
    $('title').innerHTML = c ? `🏠 <b data-i18n-skip>${esc(c.name)}</b> <span>的小屋</span> · <span>${c.members.length} 人</span>` : '🏠 <span>团队小屋</span>';
    const b = boardBox(), board = $('board');
    Object.assign(board.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px', fontSize: Math.max(10, 13 * b.k) + 'px' });
    const says = c ? c.items.filter(i => i.type === 'say').slice(-3).reverse() : [];
    board.innerHTML = c ? `<h4>团队公告</h4>${says.length ? says.map(i => `<p data-i18n-skip>${esc(nickOf(i.from))}：${esc(i.text)}</p>`).join('') : '<p>对桌宠说「告诉大家…」，就会写在这里</p>'}` : '';
    const list = c ? c.members.map((m, i) => {
      const [x, y] = SPOTS[i % SPOTS.length];
      const status = m.me ? m.status : (m.online ? m.status : 'off');
      return { id: m.id, me: !!m.me, pet: m.pet, name: m.petName || m.nick, tag: m.me ? '我' : m.nick, line: m.doing || (m.me ? '' : m.online ? '' : '不在线'), status, x, y };
    }) : [];
    scene.sync(list);
  }
  function paintSetup() {
    const el = $('setup');
    let mode = setupMode;
    if (!mode && snap && !snap.share) mode = 'share';
    if (!mode && snap && !snap.crews.length) mode = 'start';
    if (!mode && !snap) mode = 'loading';
    el.hidden = !mode;
    if (!mode) { el.innerHTML = ''; return; }
    if (mode === 'disabled') { el.innerHTML = `<div class="box"><h3>团队不可用</h3><p>已开启纯离线模式。可在 设置 › 高级 中关闭。</p></div>`; return; }
    if (mode === 'loading') { el.innerHTML = `<div class="box"><h3>正在准备团队小屋…</h3></div>`; return; }
    if (mode === 'share') {
      el.innerHTML = `<div class="box"><h3>开启团队信箱</h3>
        <p>团队之间的信和文件放在你共享给同事的文件夹里（下面建一个 ai-hub-community 子目录，内容全程加密）。正在自动找本机已经共享的文件夹…</p>
        <div data-slot="sharemsg" class="cc-note">${shareErr ? `<span class="cc-err">${esc(shareErr)}</span>` : ''}</div>
        <div class="cc-ops"><button class="cc-btn pri" data-cc="detect">重新检测</button><button class="cc-btn" data-cc="mkshare"${shareErr ? '' : ' hidden'}>一键新建共享（需要管理员确认一次）</button></div></div>`;
      if (!triedDetect) { triedDetect = true; void detect(false); }
      return;
    }
    const canClose = snap && snap.crews.length;
    el.innerHTML = `<div class="box" style="width:560px"><h3>${mode === 'join' ? '加入团队' : mode === 'new' ? '建一个团队' : '组建你的第一个团队'}</h3>
      <p>团队里的桌宠可以聊进展、互相分享文件，同事的 agent 也能来问你的 agent。所有交流双方完全可见。</p>
      <div class="two">
        ${mode !== 'join' ? `<div><b>建一个团队</b><input class="cc-in" data-slot="newname" maxlength="30" placeholder="团队名，例如 调度算法小组" style="width:100%"><div class="cc-ops"><button class="cc-btn pri" data-cc="create">建立</button></div></div>` : ''}
        ${mode !== 'new' ? `<div${mode === 'join' ? ' style="grid-column:1/-1"' : ''}><b>加入同事的团队</b><textarea class="cc-in" data-slot="joinText" placeholder="把同事发来的整段邀请（含 \\\\IP\\共享名 和邀请码）粘贴到这里"></textarea><div class="cc-ops"><button class="cc-btn pri" data-cc="dojoin">加入</button></div></div>` : ''}
      </div>
      <div class="cc-ops" style="justify-content:space-between"><span class="cc-err" data-slot="setuperr"></span>${canClose ? '<button class="cc-btn ghost" data-cc="closesetup">取消</button>' : ''}</div></div>`;
  }
  async function detect(force) {
    const msg = root.querySelector('[data-slot="sharemsg"]');
    if (!msg) return;
    if (detect.running && !force) return;
    detect.running = true;
    const r = await invoke('detect-share');
    detect.running = false;
    if (r && r.ok) { shareErr = ''; toast(`已用共享文件夹「${r.share.name}」作团队信箱`); await load(); return; }
    shareErr = (r && r.error) || '没找到可用的共享文件夹';
    if (!root.querySelector('[data-slot="sharemsg"]')) return;
    root.querySelector('[data-slot="sharemsg"]').innerHTML = `<span class="cc-err">${esc((r && r.error) || '没找到可用的共享文件夹')}</span>`;
    const mk = root.querySelector('[data-cc="mkshare"]'); if (mk) mk.hidden = false;
  }
  function paintTabs() {
    const c = crew();
    const wait = c ? c.items.filter(i => i.type === 'ask' && !i.mine && (i.status === 'wait' || i.status === 'answering')).length : 0;
    const T = [['feed', '动态'], ['mail', '来信'], ['share', '分享'], ['mem', '成员'], ['set', '规则']];
    $('tabs').innerHTML = T.map(([k, n]) => `<button type="button" data-tab="${k}" class="${k === tab ? 'on' : ''}">${n}${k === 'mail' && wait ? `<span class="n">${wait}</span>` : ''}</button>`).join('');
  }
  function paintBody() {
    const B = $('body'), c = crew();
    if (!c) { B.innerHTML = '<p class="cc-note">建好或加入一个团队后，这里显示团队动态、来信和分享。</p>'; return; }
    const meId = (meM() || {}).id;
    const pet = id => esc(petSrc((member(id) || {}).pet).src);
    if (tab === 'feed') {
      const evs = c.items.slice(-40).reverse().map(i => {
        let h = '';
        if (i.type === 'say') h = `<b data-i18n-skip>${esc(nickOf(i.from))}</b>：<span data-i18n-skip>${esc(i.text)}</span>`;
        else if (i.type === 'ask') h = `<b data-i18n-skip>${esc(nickOf(i.from))}</b> <span>的 agent 问</span> <b data-i18n-skip>${esc(nickOf(i.to))}</b> <span>（${INTENT[i.intent] || '查口径'}）</span> ${statusPill(i)}`;
        else if (i.type === 'answer') h = `<b data-i18n-skip>${esc(nickOf(i.from))}</b> <span>回了信</span>`;
        else if (i.type === 'share') h = `<b data-i18n-skip>${esc(nickOf(i.from))}</b> <span>分享了</span>「<span data-i18n-skip>${esc(i.share.name)}</span>」<span>给</span> <b data-i18n-skip>${i.to === '*' ? '大家' : esc(nickOf(i.to))}</b> 📁`;
        else if (i.type === 'unshare') h = `<b data-i18n-skip>${esc(nickOf(i.from))}</b> <span>撤回了一个分享</span>`;
        return `<div class="ev"><span class="t">${clock(i.at)}</span><img src="${pet(i.from)}" alt=""><div>${h}</div></div>`;
      }).join('');
      B.innerHTML = `<div class="cc-sec" style="margin-top:0"><span>团队动态</span> <span class="cc-vis">双方完全可见</span></div><div class="cc-feed">${evs || '<p class="cc-note">还没有动态。试试对桌宠说「告诉大家…」。</p>'}</div>`;
      return;
    }
    if (tab === 'mail') {
      const asks = c.items.filter(i => i.type === 'ask').slice().reverse();
      const it = asks.find(i => i.id === openMail);
      if (it) {
        const ans = it.mine ? it.answer : it.reply;
        B.innerHTML = `<button class="cc-btn ghost" data-cc="mailback">‹ 来信列表</button>
          <div class="cc-thread">
            <div class="ln${it.mine ? ' mine' : ''}"><span class="s"><span data-i18n-skip>${esc(nickOf(it.from))}</span> <span>的 agent</span> · ${clock(it.at)} · ${INTENT[it.intent] || ''}</span><span class="tx" data-i18n-skip>${esc(it.text)}</span></div>
            ${ans ? `<div class="ln${it.mine ? '' : ' mine'}"><span class="s"><span data-i18n-skip>${esc(it.mine ? nickOf(it.to) : nickOf(meId))}</span> <span>的接待 agent</span> · ${clock(ans.at)}</span><span class="tx" data-i18n-skip>${esc(ans.text)}</span></div>` : ''}
          </div>
          ${!it.mine && (it.status === 'wait' || it.status === 'answering') ? `<div class="cc-draft"><div class="cc-note">${it.draft ? '接待 agent 起草了一份，改好再寄出：' : '还没有草稿（没有可用模型时只能你来写）：'}</div>
            <textarea class="cc-in" data-slot="draft" data-i18n-skip>${esc(it.draft || '')}</textarea>
            <div class="cc-ops"><button class="cc-btn pri" data-cc="sendreply" data-id="${esc(it.id)}">寄出</button><button class="cc-btn" data-cc="ignore" data-id="${esc(it.id)}">忽略</button></div></div>` : ''}
          ${it.mine && ans ? `<div class="cc-ops"><button class="cc-btn" data-cc="copy" data-text="${esc(ans.text)}">复制回信</button></div>` : ''}
          <p class="cc-note">${esc(nickOf(it.mine ? it.to : it.from))} <span>那边看到的是同一份记录。</span></p>`;
        return;
      }
      B.innerHTML = `<div class="cc-sec" style="margin-top:0"><span>agent 来信</span> <span class="cc-vis">双方完全可见</span></div>` + (asks.map(i => `<div class="cc-row click" data-mail="${esc(i.id)}"><div class="ic in"><img src="${pet(i.mine ? i.to : i.from)}" alt=""></div>
          <div class="grow"><div><b data-i18n-skip>${esc(i.mine ? '我 → ' + nickOf(i.to) : nickOf(i.from))}</b> · <span>${INTENT[i.intent] || '查口径'}</span> ${statusPill(i)}</div><div class="sm" data-i18n-skip>${clock(i.at)} · ${esc(i.text.slice(0, 60))}</div></div></div>`).join('') ||
        '<p class="cc-note">还没有来信。对桌宠说「问问某某 …」就能让你的 agent 去问同事的 agent。</p>') +
        `<p class="cc-note" style="margin-top:10px">由程序按「谁 × 问什么」决定：查口径、问进度在配了可外答资料时自动答；请评审、委托跑活起草后等你确认；问人的评价直接拒绝。</p>`;
      return;
    }
    if (tab === 'share') {
      const sh = c.items.filter(i => i.type === 'share').slice().reverse();
      const row = i => {
        const s = i.share, out = i.mine;
        let act = '';
        if (out) act = i.revoked ? `<span class="cc-pill done">${i.expired ? '已过期' : '已撤回'}</span>` : `<button class="cc-btn ghost" data-cc="revoke" data-id="${esc(i.id)}">撤回</button>`;
        else if (i.local && i.local.state === 'done') act = `<button class="cc-btn" data-cc="openpath" data-path="${esc(i.local.path)}">打开</button>`;
        else if (i.local && i.local.state === 'fetching') act = '<span class="cc-pill in">取回中</span>';
        else if (i.revoked) act = '<span class="cc-pill done">已撤回</span>';
        else act = `<button class="cc-btn" data-cc="fetch" data-id="${esc(i.id)}">取回</button>`;
        return `<div class="cc-row"><div class="ic${out ? '' : ' in'}">${out ? '📤' : '📥'}</div><div class="grow">
          <div><b data-i18n-skip>${esc(s.name)}</b> <span class="cc-pill ${out ? 'auto' : 'in'}" data-i18n-skip>${out ? '给 ' + (i.to === '*' ? '大家' : esc(nickOf(i.to))) : esc(nickOf(i.from)) + ' 给我'}</span></div>
          <div class="sm"><span>${size(s.size)} · ${s.count} 个文件 · 只读</span>${s.exp ? ` · <span>还有 ${daysLeft(s.exp)} 天</span>` : ''}</div>
          ${s.use ? `<div class="sm"><span>用法：</span><span data-i18n-skip>${esc(s.use)}</span></div>` : ''}
          ${i.local && i.local.state === 'done' ? `<div class="sm" data-i18n-skip>${esc(i.local.path)}</div>` : ''}
          ${i.local && i.local.state === 'error' ? `<div class="cc-err">${esc(i.local.error)}</div>` : ''}</div>${act}</div>`;
      };
      const tr = (snap.transfers || []).map(t => `<div class="cc-row"><div class="ic">⏳</div><div class="grow"><b data-i18n-skip>${esc(t.name)}</b><div class="cc-prog"><i style="width:${Math.round(t.done / Math.max(1, t.total) * 100)}%"></i></div></div></div>`).join('');
      B.innerHTML = `${tr}<div class="cc-sec" style="margin-top:0">分享</div>${sh.map(row).join('') || '<p class="cc-note">还没有分享。对桌宠说「把 D:\\某个文件夹 分享给某某，用法是 …」。</p>'}
        <p class="cc-note" style="margin-top:10px">分享是复制一份快照、加密放进你的共享文件夹，只有团队成员能解开；到期自动删除。收到的文件放在本机：<span data-i18n-skip>${esc(snap.receivedRoot || '')}</span></p>`;
      return;
    }
    if (tab === 'mem') {
      B.innerHTML = `<div class="cc-sec" style="margin-top:0">成员与 IP</div>` + c.members.map(m => `<div class="cc-row"><div class="ic in"><img src="${esc(petSrc(m.pet).src)}" alt=""></div>
          <div class="grow"><div><b data-i18n-skip>${esc(m.nick)}</b>${m.me ? ' <span class="cc-pill done">我</span>' : ''}</div>
          <div class="sm"><i class="cc-dot ${m.me ? m.status : m.online ? m.status : 'off'}"></i>${m.me ? ST[m.status] || '在线' : m.online ? ST[m.status] || '在线' : '不在线'}${m.error ? ` · <span class="cc-err">${esc(m.error)}</span>` : ''}</div>
          <div class="sm" data-i18n-skip>\\\\${esc(m.ip)}\\${esc(m.share)}</div></div>
          ${m.me ? `<select class="cc-in" data-cc-ip="me" style="width:118px">${[...new Set([snap.me.ip, ...(snap.me.ipCandidates || [])].filter(Boolean))].map(ip => `<option${ip === snap.me.ip ? ' selected' : ''}>${esc(ip)}</option>`).join('')}</select>`
            : `<input class="cc-in" data-cc-ip="${esc(m.id)}" value="${esc(m.ip)}" style="width:108px;font-family:Consolas,monospace"><button class="cc-btn" data-cc="test" data-id="${esc(m.id)}">测</button>`}</div>`).join('') +
        `<div class="cc-sec">邀请同事</div>
        <div style="display:flex;gap:6px"><input class="cc-in" data-slot="invname" placeholder="名字" maxlength="24" style="width:90px"><input class="cc-in" data-slot="invip" placeholder="对方 IP（建议填）" style="flex:1;font-family:Consolas,monospace"><button class="cc-btn pri" data-cc="invite">生成邀请</button></div>
        ${inviteOut ? `<div class="cc-recv"><div class="cc-note">把这段话用 WeLink 发给对方（7 天内有效）：</div><div data-i18n-skip style="white-space:pre-wrap">${esc(inviteOut.message)}</div><div class="cc-ops"><button class="cc-btn" data-cc="copy" data-text="${esc(inviteOut.message)}">复制</button></div></div>` : ''}
        ${c.invites.length ? `<div class="cc-note" style="margin-top:6px"><span>有效邀请（7 天内可多人用）：</span>${c.invites.map(v => `<span data-i18n-skip>${esc(v.forName || v.ip || '同事')}</span>${v.joined ? `<span>（已加入 ${v.joined} 人）</span>` : ''}`).join('、')}</div><div class="cc-note">同事加入后约半分钟出现在这里；久等不到时填上对方 IP 再生成一次邀请。</div>` : ''}
        <div class="cc-ops" style="margin-top:16px"><button class="cc-btn ghost" data-cc="leave">离开这个团队</button></div>
        <p class="cc-note">IP 直接改就生效，改完会自动去敲一下门确认连通。</p>`;
      return;
    }
    if (tab === 'set') {
      const r = snap.rules || {};
      B.innerHTML = `<div class="cc-sec" style="margin-top:0">来信怎么处理（程序按这张表判，不由模型判）</div>` +
        ['ask', 'progress', 'review', 'task', 'person'].map(k => `<div class="cc-row"><span class="grow">${INTENT[k]}</span><select class="cc-in" data-rule="${k}">${(k === 'person' ? ['draft', 'reject'] : ['auto', 'draft', 'reject']).map(v => `<option value="${v}"${r[k] === v ? ' selected' : ''}>${RULE[v]}</option>`).join('')}</select></div>`).join('') +
        `<div class="cc-row"><span class="grow">每个成员每天最多自动作答</span><input class="cc-in" type="number" min="0" max="200" data-cc-limit value="${esc(snap.limits.perMemberDay)}" style="width:64px"> <span>次</span></div>
        <div class="cc-sec">可外答资料</div>
        <div class="cc-row"><div class="grow"><div class="sm" data-i18n-skip>${esc(snap.answerDir || '（未设置：所有来信都先起草，等你确认）')}</div></div><button class="cc-btn" data-cc="pickdir">选择文件夹</button>${snap.answerDir ? '<button class="cc-btn ghost" data-cc="cleardir">清除</button>' : ''}</div>
        <p class="cc-note">放进去的 .md / .txt 是「可以直接告诉同事」的口径和说明。自动作答只读这些，不读你的会话、文件和聊天。</p>
        <div class="cc-sec">团队信箱</div>
        <div class="cc-row"><div class="grow"><div><span>共享文件夹</span> <b data-i18n-skip>${esc(snap.share ? snap.share.name : '未设置')}</b></div><div class="sm" data-i18n-skip>${esc(snap.share ? snap.share.path : '')}</div>${shareScopeLine(snap)}</div><button class="cc-btn" data-cc="redetect">重新检测</button></div>`;
    }
  }

  // 团队信箱所在共享给了谁（R66-5）：所有人能打开时标出来并说明怎么收窄；内容本来就加密，看得到的只是文件名和大小。
  function shareScopeLine(snap) {
    const sc = snap && snap.share && snap.shareScope;
    if (!sc) return snap && snap.share ? '<div class="sm">谁能打开：查询中…</div>' : '';
    if (sc.level === 'everyone') return `<div class="sm"><span class="cc-err">谁能打开：${esc(sc.label)}</span>。信件和文件都加密，别人只看得到文件名和大小；想收窄可在资源管理器里右键该文件夹 → 属性 → 共享 → 高级共享 → 权限，把 Everyone 换成 Authenticated Users，或改用一个只给同事的共享后点「重新检测」</div>`;
    return `<div class="sm">谁能打开：${esc(sc.label)}（信件和文件都加密）</div>`;
  }

  // ---------- 小屋里的桌宠 ----------
  function pickPet(o) {
    scene.select(o.id);
    const m = member(o.id); if (!m) return;
    if (m.me) { scene.say(o, '今天也一起加油！', 2200); return; }
    if (!m.online) { scene.say(o, `${m.nick}现在不在线 zZ`, 2600); return; }
    scene.say(o, m.doing ? `${m.nick}在忙：${m.doing}` : (m.sig || `${m.nick}${ST[m.status] || '在线'}`), 3200);
  }
  function onEvent(ev) {
    if (!visible || !ev || ev.crewId !== (crew() || {}).id) { reload(); return; }
    const from = scene.get(ev.from), me = scene.get((meM() || {}).id);
    if (ev.kind === 'say') scene.say(from, ev.text, 4000);
    else if (ev.kind === 'answer') scene.say(from, '回信：' + String(ev.text || '').slice(0, 60), 5000);
    else if (ev.kind === 'ask' && from && me) scene.visit(from, me, { glyph: '✉', lines: [String(ev.text || '').slice(0, 50), ev.status === 'auto' ? '我按资料答复了' : ev.status === 'rejected' ? '这类问题按规则不回答哦' : '收到，等主人确认'] });
    else if (ev.kind === 'share' && from && me) scene.visit(from, me, { glyph: '📁', deliver: true, lines: [`给你带来了「${ev.text}」`, '收到！'] });
    reload();
  }

  // ---------- 对桌宠说 ----------
  async function runCmd() {
    const input = $('cmd'), text = input.value.trim();
    if (!text) return;
    const c = crew(); if (!c) { toast('先建一个团队'); return; }
    if (flowBusy) { toast('桌宠还在办上一件事'); return; }
    const me = scene.get((meM() || {}).id);
    const r = await invoke('parse', { crewId: c.id, text });
    if (!r || r.ok === false) { toast((r && r.error) || '没听懂'); return; }
    if (r.kind === 'share') {
      const pv = await invoke('share-preview', { dir: r.dir });
      if (!pv || pv.ok === false) { scene.say(me, (pv && pv.error) || '找不到这个文件夹', 3200); return; }
      scene.say(me, '收到！我先跟你确认一下～', 2200);
      showConfirm(pv, r.to, r.use);
      input.value = '';
      return;
    }
    if (r.kind === 'ask') {
      if (!r.to) {
        const choices = c.members.filter(m => !m.me);
        $('confirm').innerHTML = `<div class="cc-ph"><b>问谁？</b></div><div class="cc-pb"><select class="cc-in" data-slot="askto">${choices.map(m => `<option value="${esc(m.id)}" data-i18n-skip>${esc(m.nick)}</option>`).join('')}</select><div class="cc-ops"><button class="cc-btn pri" data-cc="pickask">寄出提问</button><button class="cc-btn" data-cc="cfclose">取消</button></div></div>`;
        $('confirm').dataset.question = r.text; $('confirm').classList.add('show');
        return;
      }
      const a = await invoke('ask', { crewId: c.id, to: r.to, text: r.text });
      if (!a || a.ok === false) { toast((a && a.error) || '没寄出去'); return; }
      input.value = '';
      flowBusy = true;
      const target = scene.get(r.to);
      if (!target || !scene.visit(me, target, { glyph: '✉', lines: [`帮主人问一下：${r.text.slice(0, 40)}`, '收到，我让主人的接待 agent 看看'], onDone: () => { flowBusy = false; } })) flowBusy = false;
      toast(`已寄给${nickOf(r.to)}的 agent，回信到了会告诉你`);
      tab = 'mail'; reload();
      return;
    }
    if (r.kind === 'say') {
      if (!r.text) return;
      const a = await invoke('say', { crewId: c.id, text: r.text });
      if (!a || a.ok === false) { toast((a && a.error) || '没发出去'); return; }
      input.value = '';
      scene.setPose(me, 'happy'); scene.say(me, r.text, 3000);
      setTimeout(() => scene.setPose(me, 'idle'), 3000);
      for (const m of c.members.filter(x => !x.me && x.online)) { const o = scene.get(m.id); setTimeout(() => scene.say(o, '收到～', 1800), 700 + Math.random() * 900); }
      reload();
    }
  }
  function showConfirm(pv, to, use) {
    const c = crew(), el = $('confirm');
    const others = c.members.filter(m => !m.me);
    el.innerHTML = `<h4><img src="${esc(petSrc((meM() || {}).pet, 'happy').src)}" alt=""><span>要帮你分享这个文件夹，对吗？</span></h4>
      <div class="cc-kv"><span class="k">文件夹</span><span><code data-i18n-skip>${esc(pv.dir)}</code> · <span>${pv.count} 个文件 · ${size(pv.size)}</span>${pv.skipped ? ` · <span>跳过 ${pv.skipped} 项（.git、node_modules 等）</span>` : ''}</span>
        <span class="k">给谁</span><span><select class="cc-in" data-slot="cfto">${others.map(m => `<option value="${esc(m.id)}"${m.id === to ? ' selected' : ''} data-i18n-skip>${esc(m.nick)}</option>`).join('')}<option value="*"${!to ? ' selected' : ''}>团队所有人</option></select> <span class="cc-note">只有团队成员能解开</span></span>
        <span class="k">方式</span><span>复制一份快照到你的共享文件夹，加密、只读</span>
        <span class="k">有效期</span><span><select class="cc-in" data-slot="cfdays"><option value="7">7 天</option><option value="1">1 天</option><option value="30">30 天</option></select> <span>到期自动删除</span></span>
        <span class="k">用法</span><span><input class="cc-in" data-slot="cfuse" value="${esc(use || '')}" placeholder="例如 python run.py --cfg 六小区" style="width:100%"></span></div>
      <div class="cc-prog" data-slot="cfprog" hidden><i></i></div>
      <div class="row"><span class="msg cc-err" data-slot="cfmsg"></span><button class="cc-btn" data-cc="cfno">算了</button><button class="cc-btn pri" data-cc="cfok">确认分享</button></div>`;
    el.dataset.dir = pv.dir;
    el.classList.add('show');
  }
  async function confirmShare() {
    if (busyConfirm) return;
    const el = $('confirm'), c = crew();
    const to = el.querySelector('[data-slot="cfto"]').value, days = Number(el.querySelector('[data-slot="cfdays"]').value), use = el.querySelector('[data-slot="cfuse"]').value;
    busyConfirm = true;
    el.querySelector('[data-slot="cfprog"]').hidden = false;
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
    el.querySelector('[data-cc="cfok"]').textContent = '加密打包中…';
    const r = await invoke('share-send', { crewId: c.id, dir: el.dataset.dir, to, use, days });
    busyConfirm = false;
    if (!r || r.ok === false) {
      el.querySelector('[data-slot="cfmsg"]').textContent = (r && r.error) || '没分享成功';
      el.querySelectorAll('button').forEach(b => { b.disabled = false; });
      el.querySelector('[data-cc="cfok"]').textContent = '再试一次';
      return;
    }
    closeConfirm();
    const me = scene.get((meM() || {}).id);
    const target = to === '*' ? null : scene.get(to);
    const name = r.share ? r.share.name : '';
    if (target) { flowBusy = true; scene.visit(me, target, { glyph: '📁', deliver: true, lines: [`${nickOf(to)}，主人给你的「${name}」，用法也写好了！`, '收到！我马上告诉主人的 Claude 🎉'], onDone: () => { flowBusy = false; } }); }
    else { scene.setPose(me, 'happy'); scene.say(me, `「${name}」已经放进团队共享箱啦`, 3000); scene.sparks(me.x, me.y); }
    toast(`已分享「${name}」：只读，${days} 天后自动删除`);
    tab = 'share'; reload();
  }

  // ---------- 交互 ----------
  function closeConfirm() { $('confirm').classList.remove('show'); $('confirm').replaceChildren(); }
  root.addEventListener('click', async e => {
    const sg = e.target.closest('[data-sugg]'); if (sg) { $('cmd').value = sg.dataset.sugg; $('cmd').focus(); return; }
    const cr = e.target.closest('[data-crew]'); if (cr) { cur = cr.dataset.crew; openMail = ''; inviteOut = null; paint(true); return; }
    const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; openMail = ''; paintTabs(); paintBody(); return; }
    const ml = e.target.closest('[data-mail]'); if (ml) { openMail = ml.dataset.mail; paintBody(); return; }
    const b = e.target.closest('[data-cc]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const act = b.dataset.cc, c = crew();
    const err = m => { const s = root.querySelector('[data-slot="setuperr"]'); if (s) s.textContent = m; else toast(m); };
    if (act === 'run') return runCmd();
    if (act === 'cfclose') { closeConfirm(); return; }
    if (act === 'pickask') {
      const to = root.querySelector('[data-slot="askto"]')?.value;
      if (!to) return toast('先选一位团队成员');
      const r = await invoke('ask', { crewId: c.id, to, text: $('confirm').dataset.question });
      if (!r || r.ok === false) return toast((r && r.error) || '没寄出去');
      $('cmd').value = ''; closeConfirm(); toast('提问已寄出'); tab = 'mail'; reload(); return;
    }
    if (act === 'new') { setupMode = 'new'; paintSetup(); return; }
    if (act === 'join') { setupMode = 'join'; paintSetup(); return; }
    if (act === 'closesetup') { setupMode = ''; paintSetup(); return; }
    if (act === 'detect') { const m = root.querySelector('[data-slot="sharemsg"]'); if (m) m.textContent = '正在检测…'; return detect(true); }
    if (act === 'mkshare') { b.disabled = true; b.textContent = '请在 Windows 弹窗里确认…'; const r = await invoke('create-share'); b.disabled = false; b.textContent = '一键新建共享（需要管理员确认一次）'; if (r && r.ok) { toast('共享已建好'); setupMode = ''; await load(true); } else { const m = root.querySelector('[data-slot="sharemsg"]'); if (m) m.innerHTML = `<span class="cc-err">${esc((r && r.error) || '没建成')}</span>`; } return; }
    if (act === 'create') { const n = root.querySelector('[data-slot="newname"]').value; const r = await invoke('new-crew', { name: n }); if (!r || r.ok === false) return err((r && r.error) || '没建成'); cur = r.crew.id; setupMode = ''; tab = 'mem'; toast('团队建好了，去「成员」里邀请同事吧'); await load(true); return; }
    if (act === 'dojoin') { b.disabled = true; b.textContent = '正在连接对方…'; const r = await invoke('join', { text: root.querySelector('[data-slot="joinText"]').value }); b.disabled = false; b.textContent = '加入'; if (!r || r.ok === false) return err((r && r.error) || '没加入成功'); cur = r.crewId; setupMode = ''; toast(`已加入「${r.name}」`); await load(true); return; }
    if (act === 'cfno') { closeConfirm(); scene.say(scene.get((meM() || {}).id), '好的，不分享啦', 1800); return; }
    if (act === 'cfok') return confirmShare();
    if (!c) return;
    if (act === 'mailback') { openMail = ''; paintBody(); return; }
    if (act === 'sendreply') { const draft = root.querySelector('[data-slot="draft"]'), t = draft.value; const r = await invoke('answer-draft', { crewId: c.id, id: b.dataset.id, text: t }); if (!r || r.ok === false) return toast((r && r.error) || '没寄出'); draft.value = draft.defaultValue = ''; toast('已寄出'); reload(); return; }
    if (act === 'ignore') { const r = await invoke('answer-draft', { crewId: c.id, id: b.dataset.id, action: 'ignore' }); if (r && r.ok === false) return toast(r.error); const draft = root.querySelector('[data-slot="draft"]'); if (draft) draft.value = draft.defaultValue = ''; reload(); return; }
    if (act === 'copy') { try { require('electron').clipboard.writeText(b.dataset.text || ''); toast('已复制'); } catch { toast('复制失败'); } return; }
    if (act === 'revoke') { const r = await invoke('share-revoke', { crewId: c.id, id: b.dataset.id }); toast(r && r.ok ? '已撤回，对方那边立刻取不到了' : (r && r.error) || '没撤回'); reload(); return; }
    if (act === 'fetch') { b.disabled = true; b.textContent = '取回中…'; const r = await invoke('share-fetch', { crewId: c.id, id: b.dataset.id }); toast(r && r.ok ? '已取回' : (r && r.error) || '没取回'); reload(); return; }
    if (act === 'openpath') { const r = await invoke('open-path', { path: b.dataset.path }); if (r && r.ok === false) toast(r.error); return; }
    if (act === 'test') { b.disabled = true; const r = await invoke('test-member', { crewId: c.id, memberId: b.dataset.id }); b.disabled = false; toast(r && r.ok ? `✓ 连通 · ${r.ms} ms` : `✗ ${(r && r.error) || '连不上'}`); reload(); return; }
    if (act === 'invite') {
      const name = root.querySelector('[data-slot="invname"]').value.trim(), ip = root.querySelector('[data-slot="invip"]').value.trim();
      const r = await invoke('invite', { crewId: c.id, forName: name, ip });
      if (!r || r.ok === false) return toast((r && r.error) || '没生成邀请');
      inviteOut = r; paintBody(); return;
    }
    if (act === 'leave') { if (!window.confirm(`离开「${c.name}」？你的信箱里这个团队的内容会删掉，其他成员那边也会把你移出名单。`)) return; await invoke('leave', { crewId: c.id }); cur = ''; await load(true); return; }
    if (act === 'pickdir') { const r = await invoke('pick-dir'); if (r && r.ok) { const s = await invoke('set-settings', { answerDir: r.path }); if (s && s.ok === false) toast(s.error); reload(); } return; }
    if (act === 'cleardir') { await invoke('set-settings', { answerDir: '' }); reload(); return; }
    if (act === 'redetect') { const r = await invoke('detect-share'); toast(r && r.ok ? `信箱：${r.share.name}` : (r && r.error) || '没找到'); reload(); }
  });
  root.addEventListener('change', async e => {
    const t = e.target;
    const c = crew(); if (!c) return;
    if (t.dataset.ccIp === 'me') { const value = t.value, r = await invoke('set-me', { ipOverride: value }); if (r && r.ok === false) toast(r.error); else t.defaultValue = value; reload(); return; }
    if (t.dataset.ccIp) { const value = t.value, r = await invoke('set-member', { crewId: c.id, memberId: t.dataset.ccIp, ip: value.trim() }); if (r && r.ok) t.defaultValue = value; toast(r && r.ok ? '已改，正在去敲门确认连通' : (r && r.error) || '没改成'); reload(); return; }
    if (t.dataset.rule) { await invoke('set-settings', { rules: { [t.dataset.rule]: t.value } }); reload(); return; }
    if ('ccLimit' in t.dataset) { await invoke('set-settings', { perMemberDay: t.value }); reload(); }
  });
  $('cmd').addEventListener('keydown', e => { if (e.key === 'Enter') void runCmd(); });
  ipcRenderer.on?.('community-crew:event', (_e, ev) => onEvent(ev));
  ipcRenderer.on?.('community-crew:update', () => reload());
  ipcRenderer.on?.('community-crew:progress', (_e, p) => {
    const bar = root.querySelector('[data-slot="cfprog"] i');
    if (bar && p && p.total) bar.style.width = Math.round(p.done / p.total * 100) + '%';
  });
  window.addEventListener('resize', () => { if (visible) paintScene(); });

  return {
    el: root,
    async show(mode) { visible = true; if (mode === 'invite') tab = 'mem'; await load(); if (mode === 'invite' && crew()) setTimeout(() => root.querySelector('[data-slot="invname"]')?.focus(), 50); },
    hide() { visible = false; },
    load,
    snapshot: () => snap,
  };
}

module.exports = { createCrew, statusPill, size };
