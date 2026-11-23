'use strict';
// 开场动画（2026-11-22）：启动时在界面最上层盖一块 Canvas 播 2.5–3 秒，Hub 在下面照常加载；点画面或 Esc 跳过。
// 右下角提示「点这里更换开场动画」，点开是选择面板：群星 / Claude / Codex / DeepSeek 各一页，内置的直接用，其余一键下载并使用。
// 三种动画：柔光登场（笑容组）、冲击登场（坚毅组）、群星登场（Hub 白方块）。画完立即停掉绘制循环并移除这一层。
(function bootSplash() {
  const { ipcRenderer } = require('electron');
  let distribution = {};
  try { distribution = require('../core/distribution'); } catch (_) {}
  let version = '';
  try { version = require('../package.json').version; } catch (_) {}
  const PRODUCT = distribution.productName || 'AI Hub';
  const TONE = { claude: ['rgba(255,150,70,.9)', '#ffb27a'], codex: ['rgba(90,220,240,.9)', '#8be9f5'], deepseek: ['rgba(110,150,255,.9)', '#9db4ff'], hub: ['rgba(200,210,255,.9)', '#cfd8ff'] };

  /* ---------------- 绘制工具 ---------------- */
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  const eOut = p => 1 - Math.pow(1 - p, 3);
  const eIO = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sprites = new Map();
  function sprite(rgba) {
    if (sprites.has(rgba)) return sprites.get(rgba);
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, rgba); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(rgba, c); return c;
  }
  function cover(ctx, im, W, H, z, ox = 0, oy = 0) {
    const sc = Math.max(W / im.naturalWidth, H / im.naturalHeight) * z, dw = im.naturalWidth * sc, dh = im.naturalHeight * sc;
    ctx.drawImage(im, (W - dw) / 2 + ox, (H - dh) / 2 + oy, dw, dh);
  }
  class Weather {
    constructor(type, W, H, S) {
      Object.assign(this, { type, W, H, S, p: [] });
      const n = { snow: 90, rain: 120, bokeh: 16, dust: 40, petals: 34, sparks: 46, stars: 70, fireflies: 28, embers: 50 }[type] || 40;
      for (let i = 0; i < n; i++) this.p.push(this.spawn(true));
    }
    spawn(init) {
      const { W, H, S, type: t } = this, q = { x: rnd(0, W), y: init ? rnd(0, H) : -20, ph: rnd(0, 6.28), a: rnd(0.4, 1) };
      if (t === 'snow') { q.vy = rnd(25, 70) * S; q.sz = rnd(2, 5) * S; }
      else if (t === 'rain') { q.vy = rnd(700, 1000) * S; q.len = rnd(14, 26) * S; q.a = rnd(0.15, 0.4); }
      else if (t === 'petals') { q.vy = rnd(30, 60) * S; q.vx = rnd(10, 40) * S; q.sz = rnd(4, 7) * S; q.rot = rnd(0, 6.28); }
      else if (t === 'sparks' || t === 'embers') { if (!init) q.y = H + 20; q.vy = -rnd(25, 80) * S; q.sz = rnd(4, 11) * S; }
      else if (t === 'fireflies') { q.vx = rnd(-15, 15) * S; q.vy = rnd(-15, 15) * S; q.sz = rnd(6, 12) * S; }
      else if (t === 'stars') { q.sz = rnd(1, 2.6) * S; }
      else if (t === 'bokeh') { q.sz = rnd(18, 46) * S; q.vy = -rnd(4, 12) * S; q.a = rnd(0.08, 0.2); }
      else { q.vy = -rnd(4, 14) * S; q.sz = rnd(2, 4) * S; }
      return q;
    }
    step(dt, t) {
      const { W, H, S, type: ty } = this;
      if (ty === 'stars') return;
      for (let i = 0; i < this.p.length; i++) {
        const q = this.p[i];
        if (ty === 'fireflies') {
          q.x += (q.vx + Math.sin(t * 1.3 + q.ph) * 12 * S) * dt; q.y += (q.vy + Math.cos(t * 1.1 + q.ph) * 10 * S) * dt;
          if (q.x < -20 || q.x > W + 20 || q.y < -20 || q.y > H + 20) this.p[i] = this.spawn(true);
          continue;
        }
        q.y += (q.vy || 0) * dt;
        q.x += ((q.vx || 0) + (ty === 'snow' || ty === 'petals' ? Math.sin(t * 1.2 + q.ph) * 14 * S : 0)) * dt - (ty === 'rain' ? 180 * S * dt : 0);
        if (q.rot != null) q.rot += dt * 2;
        if (q.y > H + 30 || q.y < -40 || q.x < -60) this.p[i] = this.spawn(false);
      }
    }
    draw(ctx, alpha, t, tint) {
      if (alpha <= 0) return;
      const { type: ty, S } = this;
      ctx.save();
      if (ty === 'rain') {
        ctx.strokeStyle = 'rgba(220,230,255,1)'; ctx.lineWidth = S;
        for (const q of this.p) { ctx.globalAlpha = alpha * q.a; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.len * 0.18, q.y - q.len); ctx.stroke(); }
      } else if (ty === 'petals') {
        ctx.fillStyle = 'rgba(255,190,205,1)';
        for (const r of this.p) { ctx.globalAlpha = alpha * r.a * 0.85; ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.rot); ctx.beginPath(); ctx.ellipse(0, 0, r.sz, r.sz * 0.55, 0, 0, 6.283); ctx.fill(); ctx.restore(); }
      } else {
        ctx.globalCompositeOperation = 'lighter';
        const col = { snow: 'rgba(255,255,255,.9)', sparks: 'rgba(255,180,90,.9)', embers: tint || 'rgba(255,150,60,.9)', fireflies: 'rgba(220,255,140,.9)', stars: 'rgba(255,255,255,.95)', bokeh: 'rgba(255,210,160,.9)', dust: 'rgba(255,240,220,.8)' }[ty];
        const sp = sprite(col);
        for (const s of this.p) {
          const tw = ty === 'stars' || ty === 'fireflies' ? 0.35 + 0.65 * Math.abs(Math.sin(t * 2 + s.ph)) : 1;
          ctx.globalAlpha = alpha * s.a * tw; const z = s.sz * (ty === 'bokeh' ? 1 : 2); ctx.drawImage(sp, s.x - z, s.y - z, 2 * z, 2 * z);
        }
      }
      ctx.restore();
    }
  }
  class Sparks {
    constructor() { this.p = []; }
    burst(x, y, n, spd, S, col) { for (let i = 0; i < n; i++) { const a = rnd(0, 6.283), v = rnd(0.35, 1) * spd * S; this.p.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: rnd(0.6, 1.2), sz: rnd(5, 11) * S, col }); } }
    step(dt) { for (let i = this.p.length - 1; i >= 0; i--) { const q = this.p[i]; q.life += dt; if (q.life > q.max) { this.p.splice(i, 1); continue; } q.vx *= Math.pow(0.18, dt); q.vy *= Math.pow(0.18, dt); q.x += q.vx * dt; q.y += q.vy * dt; } }
    draw(ctx) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; for (const q of this.p) { const k = 1 - q.life / q.max, z = q.sz * (0.5 + 0.5 * k); ctx.globalAlpha = k; ctx.drawImage(sprite(q.col), q.x - z, q.y - z, 2 * z, 2 * z); } ctx.restore(); }
  }
  function title(ctx, W, y, S, p, col, slam) {
    if (p <= 0) return;
    const e = eOut(p), sc = slam ? 1 + 0.7 * (1 - eOut(Math.min(1, p * 1.6))) : 1;
    ctx.save(); ctx.translate(W / 2, y + (slam ? 0 : 12 * S * (1 - e))); ctx.scale(sc, sc);
    ctx.globalAlpha = slam ? Math.min(1, p * 2.2) : e; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${slam ? 800 : 700} ${Math.round(38 * S)}px 'Microsoft YaHei UI','Microsoft YaHei',sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(slam ? 6 : 4 + 10 * (1 - e)) * S}px`;
    ctx.shadowColor = col; ctx.shadowBlur = 22 * S; ctx.fillStyle = '#fff'; ctx.fillText(PRODUCT, 0, 0);
    ctx.shadowBlur = 0; ctx.font = `${Math.round(13 * S)}px 'Microsoft YaHei UI','Microsoft YaHei',sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${3 * S}px`;
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(`多 AI 协作工作台${version ? '  ·  v' + version : ''}`, 0, 36 * S); ctx.restore();
    if (slam) {
      const lp = seg(p, 0.15, 0.7);
      if (lp > 0 && lp < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - lp; const L = 320 * S * eOut(lp), g = ctx.createLinearGradient(W / 2 - L, 0, W / 2 + L, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, col); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(W / 2 - L, y + 20 * S, 2 * L, 2.2 * S); ctx.restore(); }
    }
  }
  function shade(ctx, W, H, a) {
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a; const g = ctx.createLinearGradient(0, H * 0.62, 0, H); g.addColorStop(0, 'rgba(3,3,5,0)'); g.addColorStop(1, 'rgba(3,3,5,.9)'); ctx.fillStyle = g; ctx.fillRect(0, H * 0.62, W, H * 0.38); ctx.restore();
  }
  function flash(ctx, W, H, a) { if (a > 0) { ctx.save(); ctx.globalAlpha = a * a; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); } }
  function speedLines(ctx, W, H, S, a, col, t) {
    if (a <= 0) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = col;
    for (let j = 0; j < 26; j++) {
      const an = (j / 26) * 6.283, r0 = Math.max(W, H) * (0.32 + 0.1 * Math.sin(j * 3.1 + t * 9)), r1 = Math.max(W, H) * 0.75;
      ctx.globalAlpha = a * (0.25 + (0.35 * ((j * 37) % 10)) / 10); ctx.lineWidth = (1 + (j % 3)) * S;
      ctx.beginPath(); ctx.moveTo(W / 2 + Math.cos(an) * r0, H / 2 + Math.sin(an) * r0); ctx.lineTo(W / 2 + Math.cos(an) * r1, H / 2 + Math.sin(an) * r1); ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 三种动画 ---------------- */
  const ANIMS = {
    // 柔光登场：主题色柔光从中心晕开 → 画面由虚到清、缓缓推近 → 柔和光带扫过 → 标题浮现
    soft: { dur: 3.0, fade: 0.5, draw(c, t, dt) {
      const { ctx, W, H, S } = c, [col, hex] = c.tone;
      ctx.fillStyle = '#040405'; ctx.fillRect(0, 0, W, H);
      const bloom = seg(t, 0, 0.7), ia = eOut(seg(t, 0.25, 1.15)), blur = 14 * (1 - eOut(seg(t, 0.25, 1.2)));
      if (ia > 0) { ctx.save(); ctx.globalAlpha = ia; if (blur > 0.3 && 'filter' in ctx) ctx.filter = `blur(${(blur * S).toFixed(1)}px)`; cover(ctx, c.img, W, H, 1.1 - 0.08 * eOut(seg(t, 0.25, 3.0))); ctx.restore(); }
      const ba = Math.sin(Math.PI * bloom) * 0.8 + 0.15 * (1 - seg(t, 0.7, 1.4));
      if (ba > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const g = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * (0.2 + 0.5 * eOut(bloom))); g.addColorStop(0, col.replace('.9)', `${(0.55 * ba).toFixed(2)})`)); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      const sw = seg(t, 1.0, 2.0);
      if (sw > 0 && sw < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const x = -W * 0.4 + W * 1.8 * eIO(sw), g2 = ctx.createLinearGradient(x - 220 * S, 0, x + 220 * S, H * 0.25); g2.addColorStop(0, 'rgba(255,255,255,0)'); g2.addColorStop(0.5, 'rgba(255,245,230,.16)'); g2.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      c.wx.step(dt, t); c.wx.draw(ctx, seg(t, 0.4, 1.2), t, col);
      shade(ctx, W, H, seg(t, 1.3, 1.9));
      title(ctx, W, H - 92 * S, S, seg(t, 1.45, 2.15), hex, false);
    } },
    // 冲击登场：蓄力流光 → 闪白冲击 → 画面砸入 + 震屏 → 强光斜扫 → 标题砸下
    rush: { dur: 2.8, fade: 0.45, draw(c, t, dt) {
      const { ctx, W, H, S } = c, [col, hex] = c.tone, hit = 0.38;
      ctx.fillStyle = '#030305'; ctx.fillRect(0, 0, W, H);
      if (t < hit) {
        const p = t / hit; ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
        for (let i = 0; i < 14; i++) {
          const ang = (i / 14) * 6.283 + 0.4, R = Math.max(W, H) * 0.75 * (1 - eIO(p)) + 20 * S, L = 160 * S * (0.4 + p);
          ctx.strokeStyle = col; ctx.globalAlpha = 0.35 + 0.65 * p; ctx.lineWidth = (1.5 + (i % 3)) * S;
          ctx.beginPath(); ctx.moveTo(W / 2 + Math.cos(ang) * R, H / 2 + Math.sin(ang) * R); ctx.lineTo(W / 2 + Math.cos(ang) * (R + L), H / 2 + Math.sin(ang) * (R + L)); ctx.stroke();
        }
        const z = (30 + 120 * p * p) * S; ctx.globalAlpha = 0.5 + 0.5 * p; ctx.drawImage(sprite(col), W / 2 - z, H / 2 - z, 2 * z, 2 * z); ctx.restore();
        return;
      }
      const u = t - hit, sh = 16 * S * Math.exp(-u * 7) * Math.sin(u * 70);
      cover(ctx, c.img, W, H, 1.28 - 0.25 * eOut(seg(u, 0, 0.6)) - 0.02 * seg(u, 0.6, 2.4), sh, -sh * 0.5);
      speedLines(ctx, W, H, S, 1 - seg(u, 0, 0.55), col, t);
      const sw = seg(u, 0.25, 0.85);
      if (sw > 0 && sw < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const x = -W * 0.3 + W * 1.6 * eIO(sw), g = ctx.createLinearGradient(x - 140 * S, 0, x + 140 * S, H * 0.35); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,.34)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore(); }
      if (!c.hit) { c.hit = true; c.sp.burst(W / 2, H / 2, 46, 900, S, col); c.sp.burst(W / 2, H / 2, 16, 500, S, 'rgba(255,245,230,.9)'); }
      c.wx.step(dt, t); c.wx.draw(ctx, seg(u, 0.1, 0.6), t, col);
      c.sp.step(dt); c.sp.draw(ctx);
      shade(ctx, W, H, seg(t, 1.15, 1.7));
      title(ctx, W, H - 92 * S, S, seg(t, 1.2, 1.75), hex, true);
      flash(ctx, W, H, 1 - seg(u, 0, 0.28));
    } },
    // 群星登场：五色星点盘旋汇聚、彼此连线 → 闪白 → Hub 白方块画面砸入 + 震屏 → 五色烟花 → 标题砸下
    galaxy: { dur: 3.0, fade: 0.45, draw(c, t, dt) {
      const { ctx, W, H, S } = c, cx = W / 2, cy = H / 2 - 30 * S, R = Math.min(W, H) * 0.62, hit = 1.05;
      const STARS = ['rgba(255,140,100,.9)', 'rgba(255,245,230,.9)', 'rgba(110,150,255,.9)', 'rgba(90,220,240,.9)', 'rgba(170,130,255,.9)'];
      ctx.fillStyle = '#04050c'; ctx.fillRect(0, 0, W, H);
      if (t < hit + 0.3) {
        c.wx.step(dt, t); c.wx.draw(ctx, 0.6, t);
        const p = eIO(seg(t, 0, hit)), pts = [];
        STARS.forEach((col, k) => {
          const th0 = (k / 5) * 6.283 - 1.57, pos = pp => { const th = th0 + (1 - pp) * 2.1, r = R * (1 - pp); return [cx + Math.cos(th) * r, cy + Math.sin(th) * r * 0.78]; };
          pts.push(pos(p));
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          for (let j = 7; j >= 0; j--) { const q = pos(Math.max(0, p - j * 0.025)); ctx.globalAlpha = (1 - j / 8) * 0.85; const z = (16 - j * 1.3) * S; ctx.drawImage(sprite(col), q[0] - z, q[1] - z, z * 2, z * 2); }
          ctx.restore();
        });
        const la = seg(t, 0.4, 0.9) * (1 - seg(t, 0.95, 1.1));
        if (la > 0) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(255,240,220,${0.5 * la})`; ctx.lineWidth = 1.2 * S; ctx.beginPath(); for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) { ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[j][0], pts[j][1]); } ctx.stroke(); ctx.restore(); }
      }
      if (t >= hit) {
        const u = t - hit, sh = 12 * S * Math.exp(-u * 7) * Math.sin(u * 70);
        ctx.save(); ctx.globalAlpha = Math.min(1, u / 0.12); cover(ctx, c.img, W, H, 1.22 - 0.2 * eOut(seg(u, 0, 0.55)), sh, -sh * 0.5); ctx.restore();
        speedLines(ctx, W, H, S, 1 - seg(u, 0, 0.5), 'rgba(255,255,255,.9)', t);
        if (!c.boom) { c.boom = true; STARS.forEach(col => c.sp.burst(cx, cy, 12, 820, S, col)); }
        [[0.55, 0.22, 0.28, 0], [0.8, 0.78, 0.25, 3], [1.0, 0.5, 0.16, 4]].forEach(([at, fx, fy, ci], i) => { if (u >= at && !c['fw' + i]) { c['fw' + i] = true; c.sp.burst(W * fx, H * fy, 40, 420, S, STARS[ci]); } });
        c.sp.step(dt); c.sp.draw(ctx);
        shade(ctx, W, H, seg(t, 1.55, 2.05));
        title(ctx, W, H - 90 * S, S, seg(t, 1.55, 2.1), c.tone[1], true);
        flash(ctx, W, H, 1 - seg(u, 0, 0.25));
      }
    } },
  };

  /* ---------------- 播放层 ---------------- */
  let layer = null;
  // 右上角三个窗口按钮是 Windows 画的，盖不住：播放时把它们的底色和符号都调成动画底色（看不见），播完按当前主题还原。
  const SPLASH_BG = '#040405';
  function windowButtons(hidden) {
    try {
      const css = getComputedStyle(document.documentElement);
      const pick = (...names) => names.map(n => String(css.getPropertyValue(n) || '').trim()).find(v => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) || '';
      ipcRenderer.send('hub:titlebar-overlay', hidden ? { color: SPLASH_BG, symbolColor: SPLASH_BG }
        : { color: pick('--surface-raised', '--bg-secondary'), symbolColor: pick('--fg-muted', '--text-secondary') });
    } catch (_) {}
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('开场图片读取失败')); im.src = src; });
  }
  // spec：{ id, name, who, anim, weather, src }；opts.hint 显示「更换开场动画」，opts.firstHint 播完后多留几秒提示。
  async function play(spec, opts = {}) {
    stop();
    if (spec.anim === 'video') return playVideo(spec, opts);
    const A = ANIMS[spec.anim] || ANIMS.soft;
    let img;
    try { img = await loadImage(spec.src); } catch (error) { console.warn('[boot-splash]', error.message); if (typeof opts.onDone === 'function') opts.onDone(); return; }
    const el = document.createElement('div');
    el.className = 'boot-splash-layer'; el.id = 'boot-splash-layer';
    el.innerHTML = `<canvas></canvas><button type="button" class="boot-splash-skip">跳过 ›</button>${opts.hint ? '<button type="button" class="boot-splash-hint">✨ 点这里更换开场动画</button>' : ''}`;
    document.body.appendChild(el);
    windowButtons(true);
    const cv = el.querySelector('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1), W = window.innerWidth, H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = Math.min(W / 960, H / 600);
    const c = { ctx, W, H, S, img, tone: TONE[spec.who] || TONE.hub, wx: new Weather(spec.weather, W, H, S), sp: new Sparks() };
    let t0 = performance.now() - (opts.startAt || 0) * 1000, last = performance.now(), raf = 0, skipAt = -1, dead = false;
    const finish = () => {
      if (dead) return; dead = true; cancelAnimationFrame(raf); el.remove(); windowButtons(false); document.removeEventListener('keydown', onKey, true);
      if (layer && layer.el === el) layer = null;
      if (opts.firstHint) afterHint();
      if (typeof opts.onDone === 'function') opts.onDone();
    };
    const skip = () => { if (skipAt < 0) skipAt = (performance.now() - t0) / 1000; };
    const onKey = e => { if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); skip(); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', e => {
      if (e.target.closest('.boot-splash-hint')) { finish(); void markHintSeen(); void openPicker(); return; }
      skip();
    });
    const frame = now => {
      if (dead) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H); A.draw(c, Math.min(t, A.dur), dt);
      let op = 1 - seg(t, A.dur - A.fade, A.dur);
      if (skipAt >= 0) op = Math.min(op, 1 - seg(t, skipAt, skipAt + 0.25));
      el.style.opacity = op;
      if (op <= 0) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    layer = { el, stop: finish };
    raf = requestAnimationFrame(frame);
  }
  // AI HUB 品牌角标（叠在原作画面上，播放时显示，视频文件不动）：Hub 白方块 + 产品名 + 副标题，按角色配光晕色。
  function brandMark(who) {
    const glow = (TONE[who] || TONE.hub)[1];
    const logo = '<svg viewBox="0 0 64 56" aria-hidden="true"><rect x="4" y="2" width="56" height="40" rx="12" fill="#fff"/><rect x="12" y="38" width="10" height="14" rx="3" fill="#fff"/><rect x="27" y="38" width="10" height="14" rx="3" fill="#fff"/><rect x="42" y="38" width="10" height="14" rx="3" fill="#fff"/><path d="M17 15l7 7-7 7M47 15l-7 7 7 7" fill="none" stroke="#1d1f26" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `<div class="boot-splash-brand" style="--glow:${glow}">${logo}<div><b>${PRODUCT}</b><small>多 AI 协作工作台${version ? ' · v' + version : ''}</small></div></div>`;
  }
  // 原作视频（CC BY-NC-ND 4.0，原样播放不加字）：带原声整段放完淡出；点画面、Esc 跳过时声音和画面一起 0.4 秒淡出。
  // 放不出来（个别电脑缺 HEVC 硬解）就改播内置群星，不让开场卡住。
  function playVideo(spec, opts) {
    const el = document.createElement('div');
    el.className = 'boot-splash-layer is-video'; el.id = 'boot-splash-layer';
    el.innerHTML = `<video playsinline preload="auto"></video><div class="boot-splash-sub" aria-live="off"></div>${brandMark(spec.who)}<button type="button" class="boot-splash-skip">跳过 ›</button>${opts.hint ? '<button type="button" class="boot-splash-hint">✨ 点这里更换开场动画</button>' : ''}`;
    const video = el.querySelector('video'), sub = el.querySelector('.boot-splash-sub');
    // 片段与字幕（index.json 的 clip）：从 start 起播、到 fadeAt 开始淡出；字幕照原作小程序——白色斜体衬线字、黑描边，
    // 中线在离底边 15% 处，字号按窗口宽度算，进出各 0.5 秒渐变。
    const clip = spec.clip || { start: 0, fadeAt: Infinity, end: Infinity, subs: [] };
    sub.style.fontSize = Math.max(18, Math.min(window.innerWidth * 0.6 / 17, window.innerHeight * 0.09)) + 'px';
    let shown = -1;
    const tick = setInterval(() => {
      const t = video.currentTime;
      if (!fading && t >= clip.start && t < clip.start + 0.3) video.volume = Math.min(1, (t - clip.start) / 0.3);
      else if (!fading) video.volume = 1;
      const i = (clip.subs || []).findIndex(([, a, b]) => t >= a && t <= b);
      if (i < 0) { sub.style.opacity = '0'; } else {
        const [text, a, b] = clip.subs[i];
        if (i !== shown) { shown = i; sub.textContent = text; }
        sub.style.opacity = String(Math.max(0, Math.min(1, (t - a) / 0.5, (b - t) / 0.5)));
      }
      if (t >= clip.start + 0.25) el.classList.add('brand-on');
      if (t >= clip.fadeAt && !fading) { fadeOut(Math.max(200, (clip.end - clip.fadeAt) * 1000)); }
    }, 40);
    document.body.appendChild(el);
    windowButtons(true);
    let dead = false, fading = false;
    const finish = () => {
      if (dead) return;
      dead = true; clearInterval(tick); video.pause(); video.removeAttribute('src'); video.load(); el.remove();
      document.removeEventListener('keydown', onKey, true); windowButtons(false);
      if (layer && layer.el === el) layer = null;
      if (opts.firstHint) afterHint();
      if (typeof opts.onDone === 'function') opts.onDone();
    };
    const fadeOut = ms => {
      if (fading || dead) return; fading = true;
      // 用定时器不用 rAF：窗口在后台或被挡住时 rAF 会停，淡出就卡住了。
      const t0 = Date.now(), v0 = video.volume;
      const target = el;
      const timer = setInterval(() => { const k = Math.min(1, (Date.now() - t0) / ms); target.style.opacity = String(1 - k); video.volume = v0 * (1 - k); if (k >= 1) { clearInterval(timer); finish(); } }, 30);
    };
    const onKey = e => { if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fadeOut(400); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', e => {
      if (e.target.closest('.boot-splash-hint')) { finish(); void markHintSeen(); void openPicker(); return; }
      fadeOut(400);
    });
    const fallback = () => {
      if (dead) return;
      console.warn('[boot-splash] 开场视频放不出来，改播群星', video.error && video.error.code);
      dead = true; clearInterval(tick); el.remove(); document.removeEventListener('keydown', onKey, true); windowButtons(false);
      if (layer && layer.el === el) layer = null;
      void play({ id: 'galaxy-constellation', who: 'hub', anim: 'galaxy', weather: 'stars', src: 'assets/boot-splash/galaxy-constellation.webp' }, opts);
    };
    video.addEventListener('error', fallback);
    video.addEventListener('timeupdate', () => { if (video.duration && video.duration - video.currentTime < 0.6) fadeOut(500); });
    video.addEventListener('ended', () => fadeOut(200));
    layer = { el, stop: finish };
    video.volume = clip.start > 0 ? 0 : 1;
    video.src = clip.start > 0 ? `${spec.src}#t=${clip.start}` : spec.src;
    video.play().catch(() => { video.muted = true; video.play().catch(fallback); });
  }
  function stop() { if (layer) layer.stop(); }
  async function markHintSeen() { try { await ipcRenderer.invoke('boot-splash:save', { hintSeen: true }); } catch (_) {} }
  // 第一次看到开场动画：播完在右下角多留一会儿「可以更换」的提示，点了直接打开面板。
  function afterHint() {
    if (document.getElementById('boot-splash-toast')) return;
    const tip = document.createElement('button');
    tip.type = 'button'; tip.id = 'boot-splash-toast'; tip.className = 'boot-splash-toast';
    tip.innerHTML = '<b>开场动画可以换</b><span>Claude、Codex、DeepSeek 等 60 多套可选，点这里挑一套 ›</span>';
    tip.addEventListener('click', () => { tip.remove(); void openPicker(); });
    document.body.appendChild(tip);
    void markHintSeen();
    setTimeout(() => tip.remove(), 12000);
  }

  /* ---------------- 选择面板 ---------------- */
  // 第一个页签「已下载」：本机已有的（内置的群星 + 三套掌心魔法阵，以及下载过的），打开面板默认停在这里。
  const TABS = [['mine', '已下载'], ['picks', '作者推荐'], ['hub', '群星'], ['claude', 'Claude'], ['codex', 'Codex'], ['deepseek', 'DeepSeek'], ['settings', '播放设置']];
  const ANIM_NAME = { soft: '柔光登场', rush: '冲击登场', galaxy: '群星登场', video: '有声视频' };
  const FREQ = [['daily', '每天第一次启动时播放', '默认。一天看一次，之后重启直接进入'], ['always', '每次启动都播放', '约 3 秒，点画面或按 Esc 随时跳过'], ['off', '不播放', '直接进入 Hub']];
  const WHO_ORDER = { hub: 0, claude: 1, codex: 2, deepseek: 3 };
  const inTab = id => (id === 'picks' ? data.items.filter(i => i.recommend).sort((a, b) => WHO_ORDER[a.who] - WHO_ORDER[b.who])
    : id === 'mine' ? data.items.filter(i => i.installed).sort((a, b) => WHO_ORDER[a.who] - WHO_ORDER[b.who]) : data.items.filter(i => i.who === id).sort((a, b) => (!!b.recommend - !!a.recommend) || ((b.anim === 'video') - (a.anim === 'video'))));
  let dialog = null, data = null, tab = 'mine', message = '', busy = false;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const kb = n => (!n ? '' : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  function card(it, full) {
    const current = data.preferences.selected === it.id, st = data.state || {}, active = st.activeId === it.id;
    const tag = current ? '<i class="bsp-tag on">正在使用</i>' : it.installed ? `<i class="bsp-tag">${it.bundled ? '内置' : '已下载'}</i>` : `<i class="bsp-tag dl">可下载${it.bytes ? ' ' + kb(it.bytes) : ''}</i>`;
    const action = current ? `<button class="appearance-btn" data-preview="${it.id}">预览</button>`
      : it.installed ? `<button class="appearance-btn primary" data-use="${it.id}">使用</button>`
        : `<button class="appearance-btn" data-get="${it.id}" ${st.activeId ? 'disabled' : ''}>${active ? '下载中…' : '下载并使用'}</button>`;
    return `<div class="bsp-card${current ? ' current' : ''}${it.anim === 'video' ? ' orig' : ''}"><button class="bsp-thumb" data-${it.installed ? 'preview' : 'get'}="${it.id}" title="${it.installed ? '点击预览' : '点击下载并使用'}"><img src="${esc(it.thumb)}" alt="">${it.recommend ? '<em class="bsp-pick">★ 推荐</em>' : ''}${tag}<span${it.credit ? ` title="原作：${esc(it.credit)}，${esc(it.creditUrl || '')}"` : ''}>${it.credit ? '原作 · ' + esc(it.credit.split(' · ')[0]) + ' · 有声' : ANIM_NAME[it.anim] || ''}</span></button><div class="bsp-meta"><strong title="${esc(it.name)}">${esc(full ? it.name : it.name.replace(/^.+? · /, ''))}</strong>${action}</div></div>`;
  }
  function settings() {
    const f = data.preferences.frequency;
    return `<div class="bsp-settings"><h3>什么时候播放</h3>${FREQ.map(([id, name, note]) => `<label class="bsp-radio"><input type="radio" name="bsp-freq" value="${id}" ${f === id ? 'checked' : ''}><span><b>${name}</b><small>${note}</small></span></label>`).join('')}
      <h3>下载来源</h3><p>按需下载的开场动画优先从公司内源取，取不到再走阿里云；每套 50–150 KB。</p>${require('./download-source-view').slotHtml('boot-splash', 'div')}
      <h3>关于「原作」开场</h3><p>Claude、Codex 页签里带「原作」的两套，来自 wynneceles 的开源项目 ai-boot-animations（github.com/wynneceles/ai-boot-animations），按 CC BY-NC-ND 4.0 原样收录、带原声，仅供非商业的个人使用；人物为网络流传的同人形象，著作权归原设计者。</p>
      <div class="bsp-row"><button class="appearance-btn" data-action="check">检查新的开场动画</button><button class="appearance-btn" data-preview="${esc(data.preferences.selected)}">预览当前开场动画</button></div></div>`;
  }
  function render() {
    if (!dialog || !data) return;
    const st = data.state || {}, cur = data.items.find(i => i.id === data.preferences.selected);
    const mine = tab === 'mine' || tab === 'picks';
    const list = tab === 'settings' ? settings()
      : `${tab === 'picks' ? '<p class="bsp-lead">三家的有声开场，带台词和字幕。每家第一个「掌心法阵·有声」约 3 秒，是 Hub 自制；Claude、Codex 的「原作」来自 wynneceles 的 ai-boot-animations（按 CC BY-NC-ND 4.0 原样收录），DeepSeek「深海魔法阵」也是 Hub 自制。</p>' : ''}${tab === 'mine' ? '<p class="bsp-lead">本机已有的开场动画，点图片全屏预览，点「使用」下次启动就播它。更多款式在右边的群星、Claude、Codex、DeepSeek 页签里，一键下载。</p>' : ''}<div class="bsp-grid${mine ? ' mine' : ''}${tab === 'picks' ? ' picks' : ''}">${inTab(tab).map(it => card(it, mine)).join('')}</div>`;
    const progress = st.activeId ? `<div class="appearance-download">${require('./download-progress-view').html({ ...(st.progress || {}), phase: st.progress && st.progress.total ? 'downloading' : 'connecting' }, { title: '下载开场动画' })}<button class="appearance-btn" data-action="cancel">取消</button></div>` : '';
    const status = st.error ? `<span class="bsp-error" role="alert">${esc(st.error)}</span>` : esc(message);
    dialog.innerHTML = `<div class="appearance-head"><div><strong>开场动画</strong><span>当前：${esc(cur ? cur.name : '群星')} · ${esc((FREQ.find(x => x[0] === data.preferences.frequency) || FREQ[0])[1])}</span></div><button class="appearance-close" data-action="close" aria-label="关闭">×</button></div>
      <div class="appearance-tabs" role="tablist">${TABS.map(([id, name]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}"${id === 'mine' ? ' class="bsp-tab-mine"' : ''}>${id === 'mine' ? '★ ' : ''}${name}${id === 'settings' ? '' : `<small>${inTab(id).length}</small>`}</button>`).join('')}</div>
      <section class="bsp-content">${list}</section>
      <div class="appearance-foot">${progress}<span class="appearance-feedback" role="status">${status}</span><button class="appearance-btn primary" data-action="close">完成</button></div>`;
    if (dialog.querySelector('[data-dl-source]')) void require('./download-source-view').fill(dialog).catch(() => {});
  }
  async function refresh() { data = await ipcRenderer.invoke('boot-splash:get'); syncSettings(); render(); }
  async function openPicker() {
    data = await ipcRenderer.invoke('boot-splash:get');
    syncSettings();
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'appearance-dialog boot-splash-dialog'; dialog.id = 'boot-splash-dialog';
      dialog.setAttribute('aria-label', '开场动画');
      document.body.appendChild(dialog);
      dialog.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tab) { tab = b.dataset.tab; message = ''; render(); return; }
        if (b.dataset.action === 'close') { dialog.close(); return; }
        if (b.dataset.action === 'cancel') { void ipcRenderer.invoke('boot-splash:cancel'); return; }
        if (b.dataset.preview) {
          const it = data.items.find(i => i.id === b.dataset.preview); if (!it || !it.src) return;
          // 预览时先收起面板（模态框在最顶层，会挡住动画），播完或跳过后原样回来。
          dialog.close();
          void play(it, { onDone: () => { if (!dialog.open) { render(); dialog.showModal(); } } });
          return;
        }
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            if (b.dataset.use) { data = await ipcRenderer.invoke('boot-splash:save', { selected: b.dataset.use }); message = '已换好，下次启动就播这一套。'; }
            else if (b.dataset.get) {
              const id = b.dataset.get; message = '';
              data = await ipcRenderer.invoke('boot-splash:download', id);
              const it = data.items.find(i => i.id === id);
              if (it && it.installed) { data = await ipcRenderer.invoke('boot-splash:save', { selected: id }); message = `「${it.name}」已下载并设为开场动画。`; }
            } else if (b.dataset.action === 'check') { data = await ipcRenderer.invoke('boot-splash:check'); message = data.state.error ? '' : '已是最新的开场动画目录。'; }
          } catch (error) { message = error.message || String(error); }
          finally { busy = false; render(); }
        })();
      });
      dialog.addEventListener('change', e => {
        const r = e.target.closest('input[name="bsp-freq"]'); if (!r) return;
        void ipcRenderer.invoke('boot-splash:save', { frequency: r.value }).then(next => { data = next; message = '已保存。'; render(); }).catch(error => { message = error.message; render(); });
      });
    }
    tab = 'mine'; message = ''; render();
    if (!dialog.open) dialog.showModal();
  }
  ipcRenderer.on('boot-splash:state', (_e, state) => { if (data) { data.state = state; if (dialog?.open) render(); } });
  ipcRenderer.on('boot-splash:changed', (_e, next) => { data = next; syncSettings(); if (dialog?.open) render(); });

  // 复用同一份播放偏好与播放器；手动重播不调用 startup，不消耗「每天第一次」或改动频率。
  const frequency = document.getElementById('cfg-boot-splash-frequency');
  const replay = document.getElementById('cfg-boot-splash-play');
  const settingsStatus = document.getElementById('cfg-boot-splash-status');
  function settingsError(error) {
    if (!settingsStatus) return;
    settingsStatus.textContent = error ? `启动动画：${error.message || error}，请重试。` : '';
    settingsStatus.hidden = !error;
  }
  function syncSettings() {
    if (frequency && data) { frequency.value = data.preferences.frequency; frequency.disabled = false; }
    if (replay && data) replay.disabled = false;
  }
  require('./launch-field-hint').setIconHint(document.getElementById('cfg-boot-splash-label'),
    '默认每天第一次启动时播放，修改后立即保存。现在播放一次只重播当前动画，不改变启动频率；点击画面或按 Esc 可跳过。更换动画可选其他款式。');
  frequency?.addEventListener('change', async () => {
    frequency.disabled = true; settingsError(null);
    try { data = await ipcRenderer.invoke('boot-splash:save', { frequency: frequency.value }); }
    catch (error) { settingsError(error); }
    finally { syncSettings(); render(); }
  });
  replay?.addEventListener('click', async () => {
    replay.disabled = true; settingsError(null);
    try {
      data = await ipcRenderer.invoke('boot-splash:get');
      const current = data.items.find(it => it.id === data.preferences.selected);
      if (!current?.src) throw new Error('当前动画不可用，请更换动画');
      await play(current);
    } catch (error) { settingsError(error); }
    finally { syncSettings(); }
  });
  document.getElementById('cfg-boot-splash-picker')?.addEventListener('click', () => {
    settingsError(null);
    void openPicker().catch(settingsError);
  });
  void refresh().catch(settingsError);

  document.getElementById('options-boot-splash')?.addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('theme-menu'); if (menu) menu.style.display = 'none';
    document.getElementById('btn-theme')?.setAttribute('aria-expanded', 'false');
    void openPicker().catch(error => console.error('[boot-splash]', error));
  });

  window.hubBootSplash = { play, stop, openPicker, refresh };
  ipcRenderer.invoke('boot-splash:startup').then(spec => { if (spec) void play(spec, { hint: spec.showHint, firstHint: spec.firstHint }); })
    .catch(error => console.warn('[boot-splash]', error));
})();
