'use strict';
// 三套 Canvas 开场的绘制内核：在 Worker 内运行，只接收画布和已解码的图片，不读取 DOM。
(function drawingModule() {
function canvasSize(width, height, dpr = 1) {
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
  // 高 DPI / 4K 下最多约 4 百万像素，避免软件合成和贴图占满显存；普通窗口保持原有分辨率。
  const scale = Math.min(2, Math.max(0.25, dpr || 1), Math.sqrt(4000000 / (W * H)));
  return { width: W, height: H, scale, pixelWidth: Math.max(1, Math.floor(W * scale)), pixelHeight: Math.max(1, Math.floor(H * scale)) };
}
function createScene({ canvas, image, width: W, height: H, scale, anim, weather, tone, product: PRODUCT, version = '', makeCanvas }) {
  /* ---------------- 绘制工具 ---------------- */
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  const eOut = p => 1 - Math.pow(1 - p, 3);
  const eIO = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sprites = new Map();
  function sprite(rgba) {
    if (sprites.has(rgba)) return sprites.get(rgba);
    const c = makeCanvas(); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, rgba); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(rgba, c); return c;
  }
  function cover(ctx, im, W, H, z, ox = 0, oy = 0) {
    const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
    const sc = Math.max(W / iw, H / ih) * z, dw = iw * sc, dh = ih * sc;
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


  canvas.width = Math.max(1, Math.floor(W * scale)); canvas.height = Math.max(1, Math.floor(H * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('开场绘制上下文不可用');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const A = ANIMS[anim] || ANIMS.soft, S = Math.min(W / 960, H / 600);
  const c = { ctx, W, H, S, img: image, tone, wx: new Weather(weather, W, H, S), sp: new Sparks() };
  return { duration: A.dur, fade: A.fade, draw(t, dt) { ctx.clearRect(0, 0, W, H); A.draw(c, Math.min(t, A.dur), dt); } };
}
const api = { canvasSize, createScene };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.HubBootSplashDrawing = api;
})();
