'use strict';
// 社区 › 广场（2026-11-28）：所有参与社区的同事以桌宠形象出现在一个小镇广场上。
// 广场只用「公开名片」：昵称、桌宠、等级、连胜、成就这些排行榜上本来就公开的数字，加上你自己写的签名和在线状态。
// 广场上的串门和问候是本机小动画，不发出任何消息；WeLink、会话、文件、项目进展都不交给广场——不是叮嘱桌宠别说，而是它根本拿不到。
// 想聊工作，把人拉进「我的团队」。
const { createScene, petSrc, esc } = require('./community-scene');
const { hasPendingEdits } = require('./community-editing');

const num = n => Number(n || 0).toLocaleString('en-US');
const GREET = ['下午好呀～', '今天也加油！', '一起去喷泉边坐坐？', '你的签名好有意思', '刚泡了杯咖啡', '这里比群聊热闹多了', '周末有什么安排？', '晒会儿太阳～'];
const REPLY = ['好呀！', '嘿嘿，你也是', '走，一起逛逛', '谢谢夸奖～', '同感！', '你好你好'];

// 把排行榜各榜的条目按昵称合成一张公开名片（纯函数，单测用）。
function people(board, crew, { limit = 15 } = {}) {
  const boards = (board && board.boards) || {};
  // 连不上收件机时客户端给的是带 stale 的旧榜单：名片照用，在线与否不再可信，一律按「不知道」处理。
  const fresh = !(board && board.stale);
  const byNick = new Map();
  const put = (e, k, v) => {
    if (!e || !e.nick) return;
    const p = byNick.get(e.nick) || { id: 'b:' + e.nick, nick: e.nick, pet: e.pet || '', me: !!e.me };
    if (e.pet && !p.pet) p.pet = e.pet;
    if (e.me) p.me = true;
    if (k) p[k] = v;
    if (e.lv != null && p.lv == null) p.lv = Number(e.lv) || 0;
    // on 是收件机按「75 分钟内有心跳」给的；旧收件机不带这个字段，就不画在线点（不冒充在线）。
    if (fresh && typeof e.on === 'boolean') p.on = p.on || e.on;
    byNick.set(e.nick, p);
  };
  for (const e of boards.level || []) { put(e, 'wxp', e.wxp); }
  for (const e of boards.wxp || []) put(e, 'wxp', e.value);
  for (const e of boards.streak || []) put(e, 'streak', e.value);
  for (const e of boards.ach || []) put(e, 'ach', e.value);
  for (const e of boards.wtok || []) put(e, 'wtok', e.value);
  const me = crew && crew.me ? crew.me : null;
  const out = [];
  const meNick = (board && board.me && board.me.nick) || (crew && crew.nick) || '我';
  out.push({ id: 'me', me: true, nick: meNick, pet: (crew && crew.pet) || (board && board.me && board.me.pet) || '01-cat', status: me ? me.status : 'on', sig: me ? me.sig : '',
    lv: board && board.me && board.me.values ? board.me.values.lv : null });
  // 在线的排前面，其余保持榜单顺序；超过上限的只是不画，人数照实统计。
  const rest = [...byNick.values()].filter(p => !p.me);
  rest.sort((a, b) => (b.on === true) - (a.on === true));
  for (const p of rest.slice(0, Math.max(0, limit - 1))) out.push({ ...p, status: p.on === true ? 'on' : p.on === false ? 'off' : 'unknown' });
  return out;
}

// 顶部人数：画出来的桌宠数、其中在线数（含自己），以及榜上一共多少人。known＝收件机给了在线标记。
function headcount(list, board) {
  const boards = (board && board.boards) || {}, nicks = new Set();
  for (const k of Object.keys(boards)) for (const e of boards[k] || []) if (e && e.nick && !e.me) nicks.add(e.nick);
  const known = list.some(p => !p.me && typeof p.on === 'boolean');
  return { shown: list.length, online: list.filter(p => p.me || p.on === true).length, listed: nicks.size + 1, known };
}

function facts(p) {
  const f = [];
  if (p.lv) f.push(`Lv.${num(p.lv)} 啦`);
  if (p.wxp) f.push(`本周活力 ${num(p.wxp)}`);
  if (p.streak) f.push(`工作日连胜 ${num(p.streak)} 天！`);
  if (p.ach) f.push(`点亮了 ${num(p.ach)} 枚成就`);
  return f;
}

function createSquare({ host, ipcRenderer, getBoard, getCrew, toast, goCrew, reloadCrew = async () => {} }) {
  const root = document.createElement('div');
  root.className = 'cmy-sub'; root.dataset.sub = 'square';
  root.innerHTML = `<div class="cc-scene" data-slot="scene"><img class="bg" src="assets/community/plaza.svg" alt="">
      <div class="cc-hud" style="left:14px;top:12px"><span class="cc-chip" data-slot="count"></span></div>
      <div class="cc-hud" style="right:14px;top:12px"><span class="cc-chip">🔒 <span>广场里，桌宠只带「公开名片」出门</span></span></div>
      <div class="cc-hud" style="left:14px;bottom:12px"><span class="cc-chip"><span>串门是本机小动画，不发出任何消息</span></span></div></div>
    <aside class="cc-panel" data-slot="panel"></aside>`;
  host.append(root);
  const sceneEl = root.querySelector('[data-slot="scene"]'), panel = root.querySelector('[data-slot="panel"]');
  let list = [], sel = null, timer = null, feed = [];
  const scene = createScene(sceneEl, { depth: [48, 95], minS: 0.8, maxS: 1.1, onPick: o => pick(o.id) });
  sceneEl.addEventListener('click', () => { sel = null; scene.select(''); paint(); });

  const inFountain = (x, y) => ((x - 50) / 12) ** 2 + ((y - 58) / 9) ** 2 < 1;
  function rawSpot() { let x, y, n = 0; do { x = 8 + Math.random() * 84; y = 50 + Math.random() * 42; n++; } while (n < 50 && (inFountain(x, y) || ((x - 50) / 45) ** 2 + ((y - 69) / 30) ** 2 > 1)); return { x, y }; }
  // taken：本轮刚分好、还没进场景的位置。离线桌宠原地打盹不再走动，初始位置必须一次散开。
  function spot(self, taken = []) {
    let best = null, bd = -1;
    for (let k = 0; k < 16; k++) {
      const c = rawSpot();
      const d = Math.min(99, ...[...[...scene.pets.values()].filter(o => o !== self), ...taken].map(o => Math.hypot((o.x - c.x) * 1.5, o.y - c.y)));
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }
  const label = p => ({ id: p.id, me: p.me, pet: p.pet, name: p.nick, tag: p.me ? '我' : (p.lv ? 'Lv.' + num(p.lv) : ''), line: '', status: p.status || 'on' });
  function refresh() {
    list = people(getBoard(), getCrew());
    const prev = new Set(scene.pets.keys());
    const taken = [];
    scene.sync(list.map(p => { const o = scene.get(p.id); const s = o ? { x: o.x, y: o.y } : spot(null, taken); if (!o) taken.push(s); return { ...label(p), x: s.x, y: s.y }; }));
    for (const p of list) if (!prev.has(p.id)) { const o = scene.get(p.id); if (o) o.el.style.transition = ''; }
    const hc = headcount(list, getBoard());
    root.querySelector('[data-slot="count"]').innerHTML = hc.known
      ? `<span>广场里</span> <b data-i18n-skip>${hc.shown}</b> <span>只桌宠</span> · <i class="cc-dot on"></i><b data-i18n-skip>${hc.online}</b> <span>只在线</span>`
      : `<span>广场里</span> <b data-i18n-skip>${hc.shown}</b> <span>只桌宠</span>`;
    root.querySelector('[data-slot="count"]').title = `榜上共 ${hc.listed} 人，广场最多画 15 只，在线的优先；在线＝75 分钟内打开过 AI HUB`;
    paint();
  }
  function log(html, pet) { feed.push({ at: Date.now(), html, pet }); if (feed.length > 30) feed.shift(); if (!sel) paint(); }
  const clock = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function tick() {
    const free = [...scene.pets.values()].filter(o => !o.busy && !(o.data && o.data.me) && o.id !== sel && o.data.status !== 'away' && o.data.status !== 'off');
    if (!free.length) return;
    const a = free[Math.floor(Math.random() * free.length)];
    if (Math.random() < 0.45) {
      const others = [...scene.pets.values()].filter(o => o !== a && !o.busy && !(o.data && o.data.me) && o.data.status !== 'off');
      if (!others.length) return;
      const b = others[Math.floor(Math.random() * others.length)];
      const pb = list.find(p => p.id === b.id) || {};
      const fb = facts(pb);
      const lines = [GREET[Math.floor(Math.random() * GREET.length)], fb.length && Math.random() < 0.6 ? fb[Math.floor(Math.random() * fb.length)] : REPLY[Math.floor(Math.random() * REPLY.length)]];
      if (scene.visit(a, b, { lines, gap: 3000 })) log(`<b data-i18n-skip>${esc(a.data.name)}</b> <span>和</span> <b data-i18n-skip>${esc(b.data.name)}</b> <span>聊了两句</span>`, a.pet);
    } else { const s = spot(a); a.busy = true; scene.walkTo(a, s.x, s.y, () => { a.busy = false; }); }
  }
  function pick(id) { sel = id; scene.select(id); paint(); }
  const KNOW = `<div class="cc-know"><span class="y">✓ 人设和昵称</span><span class="n">🔒 WeLink 消息</span><span class="y">✓ 在线状态</span><span class="n">🔒 会话内容</span><span class="y">✓ 签名、等级、连胜</span><span class="n">🔒 文件和项目进展</span></div>`;
  function paint() {
    if (hasPendingEdits(panel)) return;
    const crew = getCrew() || {};
    const me = list.find(p => p.me) || {};
    if (!sel || !list.find(p => p.id === sel)) {
      sel = null;
      const mine = petSrc(me.pet, 'happy').src;
      panel.innerHTML = `<div class="cc-ph"><b>我的公开名片</b><span class="sp"></span><span class="cc-lockb">广场只看得到这些</span></div>
        <div class="cc-pb">
          <div class="cc-card"><div class="av"><img src="${esc(mine)}" alt=""></div><div><div class="n" data-i18n-skip>${esc(me.nick || '')}</div>
            <div class="m"><select class="cc-in" data-sq="status"><option value="on">在线</option><option value="busy">专注中</option><option value="away">离开</option></select></div></div></div>
          <div class="cc-sig"><input class="cc-in" data-sq="sig" maxlength="80" placeholder="写一句签名，广场和团队都看得到" value="${esc((crew.me && crew.me.sig) || '')}" style="width:100%;border:0;background:none;height:22px;padding:0"></div>
          <div class="cc-sec">在广场里，我的桌宠知道 / 不知道</div>${KNOW}
          <p class="cc-note">不是叮嘱它「别说」，而是根本不交给它。想聊工作、互相分享文件，就把人拉进「我的团队」。</p>
          <div class="cc-sec">广场小剧场（本机随机演示，不是真实聊天）</div>
          <div class="cc-feed">${feed.slice(-8).reverse().map(e => `<div class="ev"><span class="t">${clock(e.at)}</span><img src="${esc(petSrc(e.pet).src)}" alt=""><div>${e.html}</div></div>`).join('') || '<p class="cc-note">桌宠们刚到广场，马上就热闹起来…</p>'}</div>
        </div>`;
      const st = panel.querySelector('[data-sq="status"]');
      st.value = (crew.me && crew.me.status) || 'on';
      st.addEventListener('change', async () => { const r = await ipcRenderer.invoke('community-crew:set-me', { status: st.value }); if (r && r.ok === false) toast(r.error); else { toast('状态已更新'); await refreshCrew(); } });
      const sig = panel.querySelector('[data-sq="sig"]');
      sig.addEventListener('change', async () => { const value = sig.value; const r = await ipcRenderer.invoke('community-crew:set-me', { sig: value }); if (r && r.ok === false) toast(r.error); else { sig.defaultValue = value; toast('签名已更新'); const o = scene.get('me'); scene.say(o, value, 3000); await refreshCrew(); } });
      return;
    }
    const p = list.find(x => x.id === sel);
    const f = facts(p);
    panel.innerHTML = `<div class="cc-ph"><button class="cc-btn ghost" data-sq="back">‹ 我的名片</button><span class="sp"></span><span class="cc-lockb">公开名片</span></div>
      <div class="cc-pb">
        <div class="cc-card"><div class="av"><img src="${esc(petSrc(p.pet, 'happy').src)}" alt=""></div><div><div class="n" data-i18n-skip>${esc(p.nick)}</div>
          <div class="m">${p.lv ? `Lv.${num(p.lv)}` : ''}${p.me ? ' · <span>我</span>' : ''}</div></div></div>
        ${f.length ? `<div class="cc-sig">${f.map(esc).join(' · ')}</div>` : ''}
        ${p.me ? '<p class="cc-note" style="margin-top:12px">这是你自己的桌宠。</p>' : `
        <div class="cc-ops"><button class="cc-btn pri" data-sq="hi">让我的桌宠去打招呼</button><button class="cc-btn" data-sq="invite">邀请进团队</button></div>
        <div class="cc-ops"><button class="cc-btn" data-sq="probe">🕵 试试向它打听工作</button></div>
        <p class="cc-note" style="margin-top:8px">广场是匿名的：只看得到昵称。想组队，在「我的团队」里生成邀请，用 WeLink 发给对方。</p>`}
        <div class="cc-sec">它在广场里知道 / 不知道</div>${KNOW}
      </div>`;
  }
  const refreshCrew = () => reloadCrew().catch(() => {});
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-sq]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const act = b.dataset.sq;
    if (act === 'back') { sel = null; scene.select(''); paint(); return; }
    const me = scene.get('me'), o = scene.get(sel); if (!o) return;
    const p = list.find(x => x.id === sel) || {};
    if (act === 'hi') {
      if (!scene.visit(me, o, { lines: [`${p.nick}你好呀！`, o.data.status === 'away' || o.data.status === 'off' ? '(打盹中) zZ…' : '你好！很高兴见到你～'] })) toast('桌宠正在忙，等一下');
      else log(`<span>我的桌宠跟</span> <b data-i18n-skip>${esc(p.nick)}</b> <span>打了招呼</span>`, me.pet);
    } else if (act === 'probe') {
      if (!scene.visit(me, o, { lines: ['听说你家主人最近在搞个大项目？WeLink 里怎么说的？', { text: '🔒 广场里我只带了名片，不知道这些哦～想聊工作可以邀请进团队', cls: 'lock' }] })) toast('桌宠正在忙，等一下');
      else log(`<span>我的桌宠向</span> <b data-i18n-skip>${esc(p.nick)}</b> <span>打听工作，被礼貌拒绝</span> 🔒`, me.pet);
    } else if (act === 'invite') goCrew('invite');
  });
  return {
    el: root,
    show() { refresh(); if (!timer) timer = setInterval(tick, 2400); },
    hide() { clearInterval(timer); timer = null; },
    refresh,
  };
}

module.exports = { createSquare, people, facts, headcount };
