'use strict';
// 社区场景引擎（2026-11-28）：广场与团队小屋共用——桌宠的摆放、走动（近大远小）、气泡、搬东西、送达火花。
// 只动 transform / left / top / opacity；页面隐藏时由调用方停掉自己的定时器。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 姿态图：包里自带四个姿态的形象（小猫、企鹅）用姿态图；其余形象在别人电脑上只有缩略图。
const POSED = new Set(['01-cat', '03-penguin']);
let roleIds = null;
function roleId(pet) {
  if (!roleIds) { try { roleIds = require('../core/hub-pet/state').ROLES.map(r => r.id); } catch { roleIds = ['01-cat', '03-penguin']; } }
  const p = String(pet || '');
  return roleIds.find(r => r === p || r.replace(/^\d+-/, '') === p) || '01-cat';
}
function petSrc(pet, pose = 'idle') {
  const id = roleId(pet);
  return POSED.has(id) ? { src: `assets/hub-pet/${id}/${pose}.webp`, thumb: false } : { src: `assets/hub-pet/thumbs/${id}.webp`, thumb: true };
}
const poseOf = status => (status === 'away' || status === 'off' ? 'sleep' : status === 'busy' ? 'typing' : 'idle');
const CUE = { typing: '⌨', sleep: '💤' };

function createScene(el, { depth = [40, 92], minS = 0.8, maxS = 1.1, onPick = () => {} } = {}) {
  const pets = new Map();
  function setPose(o, pose) {
    o.pose = pose;
    const s = petSrc(o.pet, pose);
    const img = o.el.querySelector('.fig img');
    if (img.getAttribute('src') !== s.src) img.src = s.src;
    o.el.classList.toggle('thumb', s.thumb);
    const cue = o.el.querySelector('.cue');
    cue.textContent = s.thumb ? (CUE[pose] || '') : '';
  }
  function place(o, x, y, instant) {
    if (instant) o.el.style.transition = 'none';
    if (!instant && Math.abs(x - o.x) > 0.3) o.el.classList.toggle('flip', x < o.x);
    o.x = x; o.y = y;
    o.el.style.left = x + '%'; o.el.style.top = y + '%';
    const t = Math.max(0, Math.min(1, (y - depth[0]) / (depth[1] - depth[0])));
    o.el.querySelector('.wrap').style.setProperty('--s', (minS + (maxS - minS) * t).toFixed(3));
    o.el.style.zIndex = String(Math.round(y * 10));
    if (instant) { void o.el.offsetHeight; o.el.style.transition = ''; }
  }
  function add(p) {
    const pe = document.createElement('div');
    pe.className = 'cc-pet';
    pe.innerHTML = `<div class="wrap"><div class="cc-bub"></div><div class="ring"></div><div class="shadow"></div>
      <div class="fig"><div class="cc-carry"></div><img alt="" draggable="false"><span class="cue"></span></div>
      <div class="nm"><i class="cc-dot"></i><span class="pn" data-i18n-skip></span><small data-i18n-skip></small></div><div class="st" data-i18n-skip></div></div>`;
    const o = { id: p.id, el: pe, x: p.x, y: p.y, pet: p.pet, busy: false };
    pe.addEventListener('click', e => { e.stopPropagation(); onPick(o); });
    pe.querySelector('.fig img').addEventListener('error', function onErr() { this.removeEventListener('error', onErr); this.src = 'assets/hub-pet/thumbs/01-cat.webp'; });
    pe.dataset.id = p.id;
    pets.set(p.id, o);
    el.append(pe);
    update(o, p);
    place(o, p.x, p.y, true);
    return o;
  }
  function update(o, p) {
    Object.assign(o, { data: p, pet: p.pet || o.pet });
    o.el.classList.toggle('me', !!p.me);
    o.el.classList.toggle('off', p.status === 'off');
    o.el.querySelector('.cc-dot').className = 'cc-dot ' + (p.status || 'on');
    o.el.querySelector('.pn').textContent = p.name || '';
    o.el.querySelector('small').textContent = p.tag || '';
    o.el.querySelector('.st').textContent = p.line || '';
    if (!o.busy) setPose(o, poseOf(p.status));
  }
  function sync(list) {
    const keep = new Set();
    for (const p of list) { keep.add(p.id); const o = pets.get(p.id); if (o) update(o, p); else add(p); }
    for (const [id, o] of pets) if (!keep.has(id)) { o.el.remove(); pets.delete(id); }
  }
  function walkTo(o, x, y, cb) {
    const d = Math.hypot((x - o.x) * 1.4, y - o.y);
    const ms = Math.max(700, d * 95);
    o.el.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
    o.el.classList.add('walk');
    place(o, x, y);
    clearTimeout(o.walkTimer);
    o.walkTimer = setTimeout(() => { o.el.classList.remove('walk'); if (cb) cb(); }, ms);
  }
  function say(o, text, ms = 3000, cls = '') {
    if (!o) return;
    const b = o.el.querySelector('.cc-bub');
    b.className = 'cc-bub show' + (cls ? ' ' + cls : '');
    b.textContent = String(text || '').slice(0, 140);
    clearTimeout(b.hideTimer);
    b.hideTimer = setTimeout(() => b.classList.remove('show'), ms);
  }
  function carry(o, glyph) { o.el.querySelector('.cc-carry').textContent = glyph || ''; o.el.classList.toggle('carrying', !!glyph); }
  function face(a, b) { a.el.classList.toggle('flip', b.x < a.x); b.el.classList.toggle('flip', a.x < b.x); }
  function sparks(x, y) {
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 14; i++) {
      const s = document.createElement('div');
      s.className = 'cc-spark c' + (i % 4);
      s.style.left = (x / 100 * r.width) + 'px'; s.style.top = (y / 100 * r.height - 60) + 'px';
      const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 40;
      s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', Math.sin(a) * d + 'px');
      el.append(s); setTimeout(() => s.remove(), 900);
    }
  }
  function fly(from, to, glyph) {
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'cc-fly'; f.textContent = glyph;
    f.style.left = (from.x / 100 * r.width - 14) + 'px'; f.style.top = (from.y / 100 * r.height - 120) + 'px';
    el.append(f);
    requestAnimationFrame(() => { f.style.left = (to.x / 100 * r.width - 14) + 'px'; f.style.top = (to.y / 100 * r.height - 130) + 'px'; f.style.transform = 'scale(.6)'; f.style.opacity = '.2'; });
    setTimeout(() => f.remove(), 950);
  }
  // 走到对方身边，做一件事，再走回原位。
  function visit(a, b, { glyph = '', lines = [], gap = 2800, deliver = false, onArrive, onDone } = {}) {
    if (!a || !b || a.busy) return false;
    a.busy = true; const home = [a.x, a.y];
    if (glyph) carry(a, glyph);
    const tx = b.x + (b.x > a.x ? -8 : 8);
    walkTo(a, tx, b.y + 0.5, () => {
      face(a, b);
      setPose(a, 'happy'); if (b.data && b.data.status !== 'away' && b.data.status !== 'off') setPose(b, 'happy');
      if (onArrive) onArrive();
      lines.forEach((t, i) => setTimeout(() => say(i % 2 ? b : a, t.text || t, i === lines.length - 1 ? 4200 : gap + 100, t.cls || ''), i * gap));
      if (deliver) setTimeout(() => { carry(a, ''); fly(a, b, glyph); setTimeout(() => sparks(b.x, b.y), 850); }, 900);
      setTimeout(() => {
        setPose(b, poseOf(b.data && b.data.status));
        carry(a, '');
        walkTo(a, home[0], home[1], () => { a.el.classList.remove('flip'); a.busy = false; setPose(a, poseOf(a.data && a.data.status)); if (onDone) onDone(); });
      }, Math.max(lines.length * gap + 1200, deliver ? 2600 : 0));
    });
    return true;
  }
  function select(id) { for (const [k, o] of pets) o.el.classList.toggle('sel', k === id); }
  return { pets, get: id => pets.get(id), sync, walkTo, say, setPose, carry, visit, sparks, select, place };
}

module.exports = { createScene, petSrc, roleId, poseOf, esc };
