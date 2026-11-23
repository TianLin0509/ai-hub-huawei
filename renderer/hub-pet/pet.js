'use strict';
// 助理桌宠的渲染端：所有动作都是「连续变换 + 逐帧硬切的帧序列」，由一个按需降频的 rAF 循环驱动。
// - 有动作（拖动、跳、回弹、换姿态、播放序列）时每帧刷新；只剩呼吸时降到 20 帧/秒，打盹 12 帧/秒；
//   软件渲染的电脑空闲降到 6 帧/秒、打盹静止；安静档或系统「减少动态效果」时不呼吸、空闲不排帧（见 pet-motion.js calmDelay）；
// - 窗口不可见（最小化、被系统判定遮挡）时整个循环停下；
// - 只写 transform / opacity / background-position，不触发排版。
// 姿态和说话由主进程决定（main/hub-pet-controller.js），这里只负责「怎么演」。
(function () {
  const M = window.HubPetMotion;
  const api = window.hubPet;
  const $ = id => document.getElementById(id);
  const bodyEl = $('body');
  const layersEl = $('layers');
  const shadowEl = $('shadow');
  const bubbleEl = $('bubble');
  const bubbleText = $('bubble-text');
  const dotEl = $('dot');
  const panelEl = $('panel');
  const panelList = $('panel-list');

  const AROUSAL = { idle: 0.25, typing: 0.7, happy: 1, sleep: 0, peek: 0.15, tired: 0.08 };
  const CALM_FPS = { idle: 20, tired: 20, peek: 15, sleep: 12, typing: 30, happy: 30 };
  const POP_MS = 80;

  let state = { pose: 'idle', role: '', sequences: [], clipped: {}, bubble: null, dots: 0, dock: null, peeking: false, edge: { left: 0, right: 0 } };
  let pose = null;
  let phase = 0;
  let arousal = 0.25;
  let lastFrame = 0;
  let raf = 0;
  let timer = 0;
  let lift = 0;
  let lifted = false;
  let drag = { vx: 0, vy: 0 };
  let lean = 0;
  let stretch = 0;
  let squash = null;          // { start, power }
  let hops = [];              // [{ start, dur, height, crouch? }]：crouch 毫秒的下蹲之后才起跳（r27f）
  let script = null;          // 一段编排好的动作：{ start, dur, fn(t) -> { rot, y, sx, sy }, done() }
  let nextGestureAt = 0;
  let nextRareAt = 0;
  let nextYawnAt = 0;
  let nextHappyHopAt = 0;
  let bubbleId = '';
  let lastDots = 0;
  let hitNow = false;
  let pressing = false;
  // r27f：钟摆（拎起来）、甩出去在飞、走路、坐在窗口边、鼠标靠近、抱抱
  let swing = { a: 0, w: 0 }, swingVx = 0, flying = null, swingPeak = 0;   // swingPeak：这次拎起来摆到的最大角度（调试看）
  let walking = null, sitting = false, sitK = 0, sitDir = 0;
  let nearSide = 0, nearTurn = 0, lastNearHop = 0;
  let hugging = false, hugK = 0, hugHearts = 0;

  const now = () => performance.now();
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const has = name => state.sequences.indexOf(name) >= 0;
  // 下载形象带上包版本：同一形象更新后网址变了，旧图的解码缓存和几何缓存自然失效（r27i 审查第 2 项）。
  const asset = name => (state.assetBase || ('../assets/hub-pet/' + state.role + '/')) + name + '.webp' + (state.roleVersion ? '?v=' + encodeURIComponent(state.roleVersion) : '');
  const sheetAsset = name => asset('seq-' + name);

  // ---------- 画面：只有一张图，逐帧硬切 ----------
  // 2026-10-17 用户反馈「有残影、看花眼」：原来换姿态时新旧两层各半透明叠 220ms，帧序列也把相邻两帧按小数部分叠着淡入，
  // 两张不同的画叠在一起就是残影。现在任何时刻只显示一张图：序列逐帧换，换姿态时身体先轻轻压一下（80ms），
  // 在压到最低时换图、再弹起来，用动作把切换遮住（卡通里常用的 squash 换形）。新图先解码好再换，不会闪空白。
  const cel = document.createElement('div');
  cel.className = 'cel';
  layersEl.appendChild(cel);
  const ready = new Set();
  const loading = new Map();
  const frameGeometry = new Map();
  let visual = null;          // { spec, key, role, start, shown, thenFired }
  let pendingSwap = null;     // { start, spec }：压一下再换的那 80ms
  let applyToken = 0;

  function preload(url) {
    if (ready.has(url)) return Promise.resolve(true);
    if (!loading.has(url)) {
      const img = new Image();
      img.src = url;
      loading.set(url, (img.decode ? img.decode() : Promise.resolve()).then(() => {
        cacheFrameGeometry(img, url);
        ready.add(url); return true;
      }, () => false));
    }
    return loading.get(url);
  }
  function preloadRole() {
    for (const p of ['idle', 'typing', 'happy', 'sleep']) preload(asset(p));
    for (const s of state.sequences) preload(sheetAsset(s));
  }
  function urlOf(spec) { return spec.sheet ? sheetAsset(spec.sheet) : asset(spec.img); }
  function specKey(spec) { return (spec.sheet ? 'seq:' + spec.sheet + ':' + spec.list.map(x => x.f).join(',') + (spec.loop ? 'L' : '') : 'img:' + spec.img); }
  const clip = name => (state.clipped && Array.isArray(state.clipped[name]) ? state.clipped[name] : []);

  function applyVisual(spec) {
    const url = urlOf(spec);
    const token = ++applyToken;
    const commit = () => {
      if (token !== applyToken) return;
      cel.style.backgroundImage = 'url("' + url + '")';
      cel.classList.toggle('sheet', !!spec.sheet);
      visual = { spec, key: specKey(spec), role: state.role, url, start: now(), shown: -1, thenFired: false };
      headAnchor = null;
      if (!spec.sheet) cel.style.backgroundPosition = '';
      wake();
    };
    if (ready.has(url)) commit(); else preload(url).then(commit);
  }

  // transition：'cut' 直接换（同一段动作里的帧、外观相近的画面）；'pop' 压一下再换（换姿态）。
  function show(spec, { transition = 'pop' } = {}) {
    if (!spec) return;
    if (!spec.restart && visual && visual.key === specKey(spec) && visual.role === state.role && visual.url === urlOf(spec) && !pendingSwap) return;
    if (pendingSwap && specKey(pendingSwap.spec) === specKey(spec)) return;
    if (transition === 'pop' && visual) { pendingSwap = { start: now(), spec }; preload(urlOf(spec)); wake(); return; }
    pendingSwap = null;
    applyVisual(spec);
  }

  function renderVisual(t) {
    if (!visual || !visual.spec.sheet) return false;
    const spec = visual.spec;
    const at = M.playlistFrame(t - visual.start, spec.list, spec.loop);
    if (at.f !== visual.shown) { visual.shown = at.f; cel.style.backgroundPosition = M.sheetPosition(at.f); }
    if (spec.loop) return false; // 循环（打字）由降频的定时器推着走，不用每帧刷新
    if (!at.done) return true;
    if (spec.then && !visual.thenFired) {
      visual.thenFired = true;
      const next = typeof spec.then === 'function' ? spec.then() : spec.then;
      if (next) show(next, { transition: spec.thenTransition || 'cut' });
      return true;
    }
    return false;
  }

  // ---------- 姿态 → 怎么演 ----------
  const each = (frames, ms) => frames.map(f => ({ f, ms }));
  function baseSpec(p) {
    if (p === 'typing') {
      // 打字只循环第一行 5 帧：这几帧身体不动、只有爪子在动（WorkMate 也是「身体锁定、只动爪子」）。
      const frames = M.frameRange(0, 4, clip('typing'));
      return has('typing') && frames.length >= 3 ? { sheet: 'typing', list: M.pingPong(frames, 110), loop: true, base: true } : { img: 'typing', base: true };
    }
    if (p === 'happy') return { img: 'happy', base: true };
    if (p === 'sleep') return { img: 'sleep', base: true };
    if (p === 'peek') {
      const frames = M.frameRange(20, 24, clip('dock-right'));
      return has('dock-right') && frames.length >= 3 ? { sheet: 'dock-right', list: each(frames, 110), loop: false, base: true } : { img: 'idle', base: true };
    }
    // 待机：有小动作序列的角色就停在序列第 0 帧，小动作从这一帧起、演完回到这一帧，接缝处画面一致。
    return has('idle-life') && clip('idle-life').indexOf(0) < 0 ? { sheet: 'idle-life', list: [{ f: 0, ms: 1 }], loop: false, base: true } : { img: 'idle', base: true };
  }
  const isBase = p => !!(visual && visual.spec.base && visual.key === specKey(baseSpec(p)));

  // 伸懒腰：播到峰值停 420ms 再收势（WorkMate：小猫峰值第 16 帧、17→18 收；企鹅峰值第 8 帧、7→3 收）。
  function stretchSpec() {
    const cat = state.role === '01-cat';
    const peak = cat ? 16 : 8;
    const up = M.frameRange(0, peak, clip('stretch'));
    const down = cat ? M.frameRange(17, 18, clip('stretch')) : M.frameRange(7, 3, clip('stretch'));
    if (!has('stretch') || up.length < 5) return null;
    const list = each(up, 115);
    list[list.length - 1] = { f: up[up.length - 1], ms: 115 + 420 };
    return { sheet: 'stretch', list: list.concat(each(down, 115)), loop: false, restart: true, then: () => baseSpec(pose), thenTransition: 'pop' };
  }

  function wakeUpThen(nextPose) {
    const stretch = stretchSpec();
    if (stretch) { show(stretch); return; }
    show(baseSpec(nextPose));
    script = { start: now(), dur: 1400, fn: t => { const k = Math.sin(Math.PI * t); return { sy: 1 + 0.05 * k, sx: 1 - 0.03 * k, rot: 0, y: -2 * k }; } };
    hops.push({ start: now() + 1250, dur: 380, height: 7 });
  }

  // 犯困 → 惊醒 → 深垂 → 睡着（借鉴 WorkMate 的 NodOffDirector：2.4s / 0.5s / 1.8s）。
  function nodOff() {
    script = {
      start: now(), dur: 4700,
      fn: t => {
        const s = t * 4.7;
        if (s < 2.4) return { rot: 2 + 2 * Math.sin(Math.PI * 2 * s / 1.2), y: 2, sx: 1, sy: 1 };
        if (s < 2.9) { const k = M.easeOutCubic((s - 2.4) / 0.5); return { rot: 4 - 6 * k, y: 2 - 5 * k, sx: 1, sy: 1 + 0.015 * k }; }
        const k = M.easeInOut((s - 2.9) / 1.8);
        return { rot: -2 + 8 * k, y: -3 + 7 * k, sx: 1, sy: 1.015 - 0.035 * k };
      },
      done: () => { if (pose === 'sleep') show({ img: 'sleep', base: true }); },
    };
  }

  function applyPose(next, first) {
    const prev = pose;
    pose = next;
    if (first) { show(baseSpec(next), { transition: 'cut' }); scheduleIdle(); return; }
    if (prev === next) return;
    script = null;
    if (next === 'sleep') { show(baseSpec('idle')); nodOff(); return; }
    if (prev === 'sleep') { wakeUpThen(next); return; }
    if (prev === 'peek' && visual && visual.spec.sheet === 'dock-right') {
      const back = visual.spec.list.map(x => x.f).reverse();
      show({ sheet: 'dock-right', list: each(back, 110), loop: false, restart: true, then: () => baseSpec(pose), thenTransition: 'pop' }, { transition: 'cut' });
      return;
    }
    show(baseSpec(next), { transition: now() < quietEvolutionUntil ? 'cut' : 'pop' });
    // 开口时跳两下就安静下来（原来每 2.6 秒跳一次，看久了晃眼）。
    if (next === 'happy' && now() >= quietEvolutionUntil) hops.push({ start: now() + 80, dur: 420, height: 14 }, { start: now() + 600, dur: 360, height: 8 });
    scheduleIdle();
  }

  function scheduleIdle() {
    const t = now();
    nextGestureAt = t + gestureGap();
    if (!nextRareAt) nextRareAt = t + rand(240000, 420000);
    nextYawnAt = t + rand(9000, 16000);
  }

  // ---------- 待机更活（2026-11-17 r27f） ----------
  // 小动作间隔从 28–45 秒加密到 8–20 秒，新增 6 种不用画图的动作（pet-motion.js 的 IDLE_MOVES）；鼠标靠近时侧身看你、轻跳；
  // 起跳前先下蹲。动得太勤会分心：安静档、开会、躲边、系统「减少动态效果」时一律照旧（28–45 秒、不看鼠标）。
  const lively = () => state.mode !== 'quiet' && !state.peeking && state.meeting !== true && !reducedMotion.matches;
  const gestureGap = () => (lively() ? rand(8000, 20000) : rand(28000, 45000));
  let lastMove = '';
  function playMove(t, move, dir) {
    lastMove = move.name;
    if (move.hops) { for (const h of move.hops) hops.push({ start: t + h.at, dur: h.dur, height: h.height, crouch: 110 }); return; }
    script = { start: t, dur: move.dur, fn: s => move.fn(s, dir) };
  }
  function newMove(t) {
    const pool = M.IDLE_MOVES.filter(m => m.name !== lastMove);
    playMove(t, pool[Math.floor(Math.random() * pool.length)], Math.random() < 0.5 ? -1 : 1);
  }

  // 待机时偶尔换个姿势：猫和企鹅从小动作序列里挑一段没被裁切的 5 帧，演完倒放回来；其他角色用连续变换演。
  function idleGesture(t) {
    if (t >= nextRareAt && nextRareAt) {
      nextRareAt = t + rand(240000, 420000);
      const stretch = stretchSpec();
      if (stretch) { show(stretch, { transition: 'cut' }); return; }
      script = { start: t, dur: 1600, fn: s => { const k = Math.sin(Math.PI * s); return { sy: 1 + 0.05 * k, sx: 1 - 0.03 * k, rot: 0, y: -2 * k }; } };
      return;
    }
    // 活泼时：有小动作序列的形象一半用序列、一半用新动作；只有静态图的下载形象全用新动作。
    if (lively() && (!has('idle-life') || Math.random() < 0.5)) { newMove(t); return; }
    if (has('idle-life')) {
      const options = [0, 5, 10, 15, 20].map(start => M.gesturePlaylist(start, 5, clip('idle-life'))).filter(Boolean);
      if (options.length) {
        const list = options[Math.floor(Math.random() * options.length)];
        show({ sheet: 'idle-life', list: list.concat([{ f: 0, ms: 1 }]), loop: false, restart: true, then: () => baseSpec(pose) }, { transition: 'cut' });
        return;
      }
    }
    const pick = Math.floor(Math.random() * 3);
    if (pick === 0) { const dir = Math.random() < 0.5 ? -1 : 1; script = { start: t, dur: 2400, fn: s => ({ rot: dir * 4 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 }) }; }
    else if (pick === 1) hops.push({ start: t, dur: 360, height: 7 });
    else script = { start: t, dur: 900, fn: s => { const k = Math.sin(Math.PI * 2 * s) * (1 - s); return { rot: 0, y: 0, sx: 1 + 0.03 * k, sy: 1 - 0.03 * k }; } };
  }

  // ---------- 每帧 ----------
  function frame() {
    raf = 0;
    const t = now();
    const dt = Math.min(100, lastFrame ? t - lastFrame : 16);
    lastFrame = t;
    let busy = renderVisual(t);
    busy = renderEvolution(t) || busy;
    renderProps();

    arousal = M.approach(arousal, AROUSAL[pose] ?? 0.25, dt, 500);
    // 安静档、减少动态效果、软件渲染下打盹：身体停在静止帧，不呼吸（呼吸是空闲时唯一持续要重绘的东西）。
    const br = breathStill() ? { phase, sx: 1, sy: 1 } : M.breathStep(phase, dt / 1000, arousal);
    phase = br.phase;
    let sx = br.sx, sy = br.sy, rot = 0, y = 0, x = 0;

    // 换姿态：先压 80ms，压到底时换图，再弹起来
    if (pendingSwap) {
      const k = (t - pendingSwap.start) / POP_MS;
      if (k >= 1) { const spec = pendingSwap.spec; pendingSwap = null; applyVisual(spec); squash = { start: t, power: -0.035 }; }
      else { const e = M.easeInOut(k); sy *= 1 - 0.04 * e; sx *= 1 + 0.025 * e; }
      busy = true;
    }

    // 姿态自带的身形
    if (pose === 'tired') {
      rot += 2.5; y += 2; sy *= 0.98;
      if (t >= nextYawnAt) { script = script || { start: t, dur: 1400, fn: s => ({ rot: -1.5 * Math.sin(Math.PI * s), y: 0, sx: 1, sy: 1 + 0.035 * Math.sin(Math.PI * s) }) }; nextYawnAt = t + rand(12000, 20000); }
    } else if (pose === 'peek' && !(visual && visual.spec.sheet === 'dock-right')) {
      rot -= 6;
    } else if (pose === 'typing' && !(visual && visual.spec.sheet === 'typing')) {
      // 没有打字序列的角色：轻轻点头，1.6 次/秒（原来 3.2 次/秒加左右摆，看久了晃眼）
      y -= 1.2 * Math.abs(Math.sin(Math.PI * 1.6 * t / 1000));
    } else if (pose === 'idle' && !script && !pendingSwap && !walking && !hugging && isBase('idle') && t >= nextGestureAt) {
      nextGestureAt = t + gestureGap();
      idleGesture(t);
    }

    if (script) {
      const s = Math.min(1, (t - script.start) / script.dur);
      const v = script.fn(s);
      rot += v.rot || 0; y += v.y || 0; x += v.x || 0; sx *= v.sx || 1; sy *= v.sy || 1;
      busy = true;
      if (s >= 1) { const done = script.done; script = null; if (done) done(); }
    }

    // 走路（r27f）：主进程在挪窗口，这里一颠一颠地迈步；坐在窗口边上时身子矮一点、往窗口那边靠。
    if (walking) {
      const g = M.walkGait((t - walking.start) / 1000, walking.dir);
      y += g.y; rot += g.rot; sy *= g.sy;
      busy = true;
    }
    sitK = M.approach(sitK, sitting ? 1 : 0, dt, 160);
    if (sitK > 0.002) { sy *= 1 - 0.07 * sitK; sx *= 1 + 0.04 * sitK; y += 2 * sitK; rot += 3 * sitDir * sitK; if (Math.abs(sitK - (sitting ? 1 : 0)) > 0.002) busy = true; }

    // 鼠标靠近（r27f）：侧过身看着鼠标那边——往那边歪一点、身子变窄一点（像转了半个身）。
    nearTurn = M.approach(nearTurn, nearSide && lively() && !lifted && !walking ? nearSide : 0, dt, 140);
    if (Math.abs(nearTurn) > 0.002) {
      rot += 3.5 * nearTurn; x += 3 * nearTurn; sx *= 1 - 0.06 * Math.abs(nearTurn);
      if (Math.abs(nearTurn - (nearSide && lively() && !lifted && !walking ? nearSide : 0)) > 0.002) busy = true;
    }

    // 抱抱（r27f）：按住不放时慢慢压扁、身子变宽，松手弹回。
    hugK = M.approach(hugK, hugging ? 1 : 0, dt, hugging ? 260 : 90);
    if (hugK > 0.002) { sy *= 1 - 0.09 * hugK; sx *= 1 + 0.07 * hugK; if (Math.abs(hugK - (hugging ? 1 : 0)) > 0.002) busy = true; }

    // 跳：起跳前先下蹲（r27f），落地时接一个挤压回弹
    let height = 0, crouch = 0;
    for (let i = hops.length - 1; i >= 0; i--) {
      const h = hops[i];
      const c = h.crouch ?? 90;   // 所有起跳都先蹲一下（r27f）
      const ht = t - h.start;
      if (ht < 0) { busy = true; continue; }
      if (ht < c) { crouch = Math.max(crouch, M.crouchAt(ht / c)); busy = true; continue; }
      if (ht - c > h.dur) { hops.splice(i, 1); squash = { start: t, power: 0.04 + h.height / 260 }; continue; }
      height += M.hopAt((ht - c) / 1000, h.dur / 1000, h.height);
      busy = true;
    }
    if (crouch) { sy *= 1 - 0.08 * crouch; sx *= 1 + 0.05 * crouch; }
    y -= height;

    if (squash) {
      const q = M.squashAt((t - squash.start) / 1000, squash.power);
      if (t - squash.start > 1200) squash = null; else busy = true;
      sy *= 1 + q; sx *= 1 - 0.6 * q;
    }

    // 拖动：被拎起来放大一点，速度越快拉得越长；身子像钟摆一样挂在抓握点下面晃（r27f：横向加速度推着摆，松手后慢慢停）。
    lift = M.approach(lift, lifted ? 1 : 0, dt, 70);
    const speed = Math.hypot(drag.vx, drag.vy);
    if (!lifted && !flying) { drag.vx = M.approach(drag.vx, 0, dt, 50); drag.vy = M.approach(drag.vy, 0, dt, 50); }
    const ax = lifted ? (drag.vx - swingVx) / Math.max(0.008, dt / 1000) : 0;
    swingVx = drag.vx;
    if (lifted || flying || Math.abs(swing.a) > 0.05 || Math.abs(swing.w) > 0.5) swing = M.pendulumStep(swing, reducedMotion.matches ? 0 : ax, dt / 1000);
    else swing = { a: 0, w: 0 };
    stretch = M.approach(stretch, M.clamp(speed / 4000, 0, 0.05), dt, 70);
    if (lift > 0.002 || Math.abs(swing.a) > 0.05 || stretch > 0.002) busy = true;
    lean = swing.a;
    if (Math.abs(swing.a) > swingPeak) swingPeak = Math.abs(swing.a);
    const piv = M.pivotOffset(lean, Math.round(150 * (Number(state.scale) || 1)) * 0.77);
    rot += lean; x += piv.x; y += piv.y;
    sy *= 1 + stretch; sx *= 1 - 0.5 * stretch;
    const ls = 1 + 0.04 * lift;
    sx *= ls; sy *= ls;
    y -= 6 * lift;

    bodyEl.style.transform = 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) rotate(' + rot.toFixed(2) + 'deg) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
    const air = M.clamp((height + 6 * lift) / 24, 0, 1);
    shadowEl.style.transform = 'scale(' + (1 - 0.35 * air).toFixed(3) + ',' + (1 - 0.3 * air).toFixed(3) + ')';
    shadowEl.style.opacity = (pose === 'peek' ? 0 : 1 - 0.5 * air).toFixed(3);

    schedule(busy);
  }

  function schedule(busy) {
    if (raf || timer || document.visibilityState === 'hidden') return;
    if (busy) { raf = requestAnimationFrame(frame); return; }
    const delay = M.calmDelay({ pose, calmFps: CALM_FPS, soft: softGpu(), still: stillMode(), t: now(), nextGestureAt, nextYawnAt });
    if (delay == null) return;   // 静止：等状态、动作或可见性变化时 wake() 再起
    timer = setTimeout(() => { timer = 0; if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame); }, delay);
  }
  // 软件渲染（主进程按兼容渲染开关告知）与「静止档」（安静档或系统减少动态效果）。
  function softGpu() { return state.softGpu === true; }
  // 低开销模式（主进程 state.lowPower）与安静档同样静止：空闲不呼吸、不排帧；气泡、圆点、会话灯照常。
  function lowPower() { return state.lowPower === true; }
  function stillMode() { return state.mode === 'quiet' || reducedMotion.matches || lowPower(); }
  function breathStill() { return stillMode() || (softGpu() && pose === 'sleep'); }

  function wake() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!raf && document.visibilityState !== 'hidden') raf = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      finishEvolution(false);
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = 0; timer = 0;
    } else { lastFrame = 0; wake(); }
  });

  // ---------- 气泡、小圆点、展开面板 ----------
  // 提醒类别的短名（和助理页「今天的提醒」一致），气泡和展开面板里当小标签用，一眼知道是哪类事。
  const { KIND, label: noticeLabel } = window.HubPetNotices;
  const bubbleKind = $('bubble-kind');
  const card = { el: $('ncard'), kind: $('ncard-kind'), time: $('ncard-time'), title: $('ncard-title'), text: $('ncard-text'), cta: $('ncard-cta'), count: $('ncard-count'), bar: $('ncard-bar') };
  let cardId = '';
  const hhmm = ms => { const d = new Date(Number(ms) || Date.now()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  // 通知卡片：标题、两三行内容、「打开会话 →」、另有几个待看；底部细条倒计时，鼠标停上去暂停。
  function showCard(b) {
    if (b && b.id !== cardId) {
      cardId = b.id; holding = false;
      card.kind.textContent = noticeLabel(b);
      card.time.textContent = hhmm(b.at);
      card.title.textContent = b.title || '';
      card.text.textContent = b.text || '';
      card.cta.textContent = (b.cta || '打开') + ' →';
      card.count.textContent = b.count > 1 ? '另有 ' + (b.count - 1) + ' 个待查看' : '';
      card.el.classList.toggle('bad', b.tone === 'bad');
      // 成长卡片（升级、成就）：金色点缀，右侧放段位或成就徽章
      const art = /^(?:(?:rank|badge)-\d{1,2}|evolve-[2-6])$/.test(b.art || '') ? b.art : '';
      card.el.classList.toggle('growth', b.kind === 'growth');
      card.el.classList.toggle('has-art', !!art);
      $('ncard-art').hidden = !art;
      if (art) $('ncard-art').style.backgroundImage = art.startsWith('evolve-') ? 'url("../assets/hub-pet/evolve/head-' + art.slice(7) + '.webp")' : 'url("../assets/profile/' + art + '.webp")';
      card.el.hidden = false;
      card.el.classList.remove('out', 'in', 'held');
      card.bar.classList.remove('run');
      card.bar.style.setProperty('--ms', (Number(b.ms) || 9000) + 'ms');
      void card.el.offsetWidth;
      card.el.classList.add('in');
      card.bar.classList.add('run');
    } else if (!b && cardId) {
      cardId = '';
      card.el.classList.remove('in');
      card.el.classList.add('out');
      setTimeout(() => { if (!cardId) { card.el.hidden = true; card.el.classList.remove('out'); } }, 340);
    }
    if (b && cardId === b.id) card.el.classList.toggle('held', !!b.held);
  }
  // 鼠标停在卡片上：按 mousemove 判断（窗口平时点穿，光标进来时可能收不到 mouseenter）。
  let holding = false;
  function setHold(on) { on = !!(on && (cardId || bubbleChips)); if (on !== holding) { holding = on; api.hold?.(on); } }
  card.el.addEventListener('mouseleave', () => setHold(false));
  $('ncard-close').addEventListener('click', e => { e.stopPropagation(); api.dismiss?.(); });
  const chipsEl = $('bubble-chips');
  let bubbleChips = 0;
  chipsEl.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.chip');
    if (!btn || !bubbleId) return;
    e.stopPropagation();
    chipsEl.querySelectorAll('.chip').forEach(el => { el.disabled = true; });
    btn.classList.add('picked');
    api.reply?.(bubbleId, btn.dataset.choice);
  });
  function showBubble(b) {
    // 通知卡片和普通气泡分开演：同一时刻只有一个在说。
    showCard(b && b.notify ? b : null);
    if (b && b.notify) b = null;
    if (b && b.id !== bubbleId) {
      bubbleId = b.id;
      bubbleText.textContent = b.title + (b.sticky ? '（点击确认）' : '');
      bubbleEl.classList.toggle('sticky', !!b.sticky);
      // 起了名字的闲聊：小标签写名字（2026-11-17 r27g）。
      const tag = KIND[b.kind] || (b.kind === 'chatter' && b.name ? String(b.name).slice(0, 8) : '');
      bubbleKind.textContent = tag;
      bubbleKind.hidden = !tag;
      bubbleKind.classList.toggle('name', !KIND[b.kind] && !!tag);
      // 回应按钮：一两个，点了它记住你的选择；鼠标停在气泡上时不收。
      const chips = Array.isArray(b.chips) ? b.chips.slice(0, 2) : [];
      bubbleChips = chips.length;
      chipsEl.replaceChildren(...chips.map(c => { const el = document.createElement('button'); el.type = 'button'; el.className = 'chip'; el.dataset.hit = 'chip'; el.dataset.choice = String(c.id || ''); el.textContent = String(c.label || ''); return el; }));
      chipsEl.hidden = !chips.length;
      bubbleEl.classList.toggle('has-chips', !!chips.length);
      bubbleEl.hidden = false;
      bubbleEl.classList.remove('out');
      bubbleEl.classList.remove('in');
      void bubbleEl.offsetWidth;
      bubbleEl.classList.add('in');
    } else if (!b && bubbleId) {
      bubbleId = '';
      bubbleChips = 0; setHold(false);
      bubbleEl.classList.remove('in');
      bubbleEl.classList.add('out');
      setTimeout(() => { if (!bubbleId) { bubbleEl.hidden = true; bubbleEl.classList.remove('out'); } }, 340);
    }
  }

  // 小圆点分色计数（2026-11-17 r27c）：绿=答完、橙=出错或要注意、蓝=其他；各色只显示非零的那几种。
  let dotKey = '';
  function showDots(n, tones) {
    dotEl.hidden = !(n > 0);
    const t = tones && typeof tones === 'object' ? tones : null;
    const key = n + ':' + (t ? [t.ok, t.bad, t.info].join(',') : '');
    if (key !== dotKey) {
      dotKey = key;
      dotEl.textContent = '';
      dotEl.classList.toggle('typed', !!t);
      if (!t) dotEl.textContent = n > 9 ? '9+' : String(n || '');
      else for (const tone of ['ok', 'bad', 'info']) {
        const c = Math.max(0, Number(t[tone]) || 0);
        if (!c) continue;
        const span = document.createElement('span'), i = document.createElement('i');
        i.className = 'tone-' + tone; span.appendChild(i); span.appendChild(document.createTextNode(c > 9 ? '9+' : String(c)));
        dotEl.appendChild(span);
      }
      dotEl.setAttribute('aria-label', t ? '未读：答完 ' + (t.ok || 0) + '、要注意 ' + (t.bad || 0) + '、其他 ' + (t.info || 0) : '未读提醒');
    }
    if (n > lastDots) { dotEl.classList.remove('bump'); void dotEl.offsetWidth; dotEl.classList.add('bump'); }
    lastDots = n;
  }

  // 气泡、小圆点、提醒面板只放在窗口里看得见的那一段（2026-10-18 审核）：贴边时窗口有一截伸出屏幕，伸出多少由主进程算好
  // 放在 state.edge（随大小、形象透明边变）。气泡尽量对着看得见的身体居中，放不下就往屏幕里面挪，小尾巴仍指着身体。
  const WIN_W = 280, EDGE_PAD = 6, BUBBLE_MAX = 236;
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 快捷钮落位（r27f 审查第 4 项，r27f3 返工）：先放头顶；和状态灯（展开后可能多列、贴边翻到上方）或小圆点有任何重叠，
  // 就在可见窗口里找离头顶最近、四周都不碰灯和小圆点的位置——横排放不下再试竖排（三颗钮叠成一列，通常落到灯列另一侧）；
  // 实在没有空位就这一次不露面（visibility 隐藏，鼠标点不到它，灯照常点得到），不拿重叠的位置凑合。
  function placeQuick({ H, body, visL, visR, cx, lampBox, dotLeft }) {
    quickEl.classList?.remove('col');   // 先按横排量尺寸，竖排尺寸由它换算
    const RW = quickEl.offsetWidth || 106, RH = quickEl.offsetHeight || 30, GAP = 6;
    let top = H - (6 - box.bottom * body) - body + box.top * body;
    if (!headEl.hidden) { const r = headEl.getBoundingClientRect(); if (r.height > 0) top = Math.min(top, r.top); }
    let bottom = H - top + 6;
    if (!dotEl.hidden) bottom = Math.max(bottom, body * 0.933 - box.bottom * body + 26);
    bottom = Math.min(H - RH - 4, bottom);
    const prefL = clampNum(cx - RW / 2, visL, Math.max(visL, visR - RW)), prefT = H - bottom - RH;
    // 障碍物统一成窗口坐标（左、上、右、下），四周各多让 GAP，连「信」上的角标也不压灯
    const obs = [];
    if (lampBox) { const t = H - lampBox.bottom - lampBox.height; obs.push([lampBox.left - GAP, t - GAP, lampBox.left + lampBox.width + GAP, t + lampBox.height + GAP]); }
    if (!dotEl.hidden) { const dh = dotEl.offsetHeight || 22, db = body * 0.933 - box.bottom * body + 6; obs.push([dotLeft - GAP, H - db - dh - GAP, dotLeft + (dotEl.offsetWidth || 24) + GAP, H - db + GAP]); }
    const free = (l, t, w, h) => obs.every(o => l >= o[2] || l + w <= o[0] || t >= o[3] || t + h <= o[1]);
    const inWin = (l, t, w, h) => l >= visL - 0.01 && l + w <= visR + 0.01 && t >= 3.99 && t + h <= H - 3.99;
    let best = null;
    if (free(prefL, prefT, RW, RH)) best = { l: prefL, t: prefT, col: false };
    // 头顶被灯条挡住：照旧先整体抬到灯条上方（大形象、灯横在头顶时最自然）
    if (!best && lampBox) { const t = obs[0][1] - RH; if (inWin(prefL, t, RW, RH) && free(prefL, t, RW, RH)) best = { l: prefL, t, col: false }; }
    if (!best) {
      // 离头顶最近的空位只会出现在「贴着某个障碍物的边」或「贴着窗口边」或「原来的横/纵坐标」上，只试这些位置，不逐像素扫
      // 竖排：三颗 30px 钮叠起来，宽＝钮高、高＝横排宽；同样远时优先横排
      for (const [col, w, h, cost] of [[false, RW, RH, 0], [true, RH, RW, 24]]) {
        const px = col ? cx - w / 2 : prefL, py = col ? prefT - (h - RH) : prefT;   // 竖排底边对齐原来横排的底边，不压头顶
        const xs = [px, visL, visR - w], ys = [py, 4, H - h - 4];
        for (const o of obs) { xs.push(o[0] - w, o[2]); ys.push(o[1] - h, o[3]); }
        for (const l of xs) for (const t of ys) {
          if (!inWin(l, t, w, h) || !free(l, t, w, h)) continue;
          const d = Math.abs(l - px) + Math.abs(t - py) + cost;
          if (!best || d < best.d) best = { l, t, col, d };
        }
      }
    }
    quickEl.classList?.toggle('col', !!(best && best.col));
    quickEl.style.visibility = best ? '' : 'hidden';
    if (!best) return;
    quickEl.style.left = best.l.toFixed(1) + 'px';
    quickEl.style.bottom = (H - best.t - (best.col ? RW : RH)).toFixed(1) + 'px';
  }
  function layoutOverlays() {
    const edge = state.edge || {};
    const body = Math.round(150 * (Number(state.scale) || 1));
    const side = (WIN_W - body) / 2;
    const visL = (Number(edge.left) || 0) + EDGE_PAD;
    const visR = Math.max(visL + 80, WIN_W - (Number(edge.right) || 0) - EDGE_PAD); // 躲边时几乎全在外面，留个下限免得算出负宽
    const cx = side + body * (1 + box.left - box.right) / 2; // 看得见的身体的水平中心
    // 小圆点：身体右上角，出了可见段就挪回来
    let dotLeft = side + body * 0.807;
    if (!dotEl.hidden) {
      const dw = dotEl.offsetWidth || 24;
      dotLeft = clampNum(dotLeft, visL, visR - dw);
    }
    dotEl.style.left = dotLeft.toFixed(1) + 'px';
    // 气泡
    bubbleEl.style.maxWidth = Math.min(BUBBLE_MAX, visR - visL) + 'px';
    if (!bubbleEl.hidden) {
      bubbleEl.style.left = '0px'; // 先放到最左量宽度：绝对定位的元素量宽时受「left 右边还剩多少」限制
      const w = bubbleEl.offsetWidth;
      const left = clampNum(cx - w / 2, visL, visR - w);
      bubbleEl.style.left = left.toFixed(1) + 'px';
      bubbleEl.style.setProperty('--tail-x', clampNum(cx - left, 16, w - 16).toFixed(1) + 'px');
      bubbleEl.style.setProperty('--to-dot-x', (dotLeft + 10 - (left + w / 2)).toFixed(1) + 'px');
    }
    // 通知卡片：和气泡一样对着身体居中、只放在看得见的那一段
    if (!card.el.hidden) {
      const w = Math.min(260, visR - visL);
      card.el.style.width = w + 'px';
      const left = clampNum(cx - w / 2, visL, visR - w);
      card.el.style.left = left.toFixed(1) + 'px';
      card.el.style.setProperty('--tail-x', clampNum(cx - left, 18, w - 18).toFixed(1) + 'px');
      card.el.style.setProperty('--to-dot-x', (dotLeft + 10 - (left + w / 2)).toFixed(1) + 'px');
    }
    // 标签优先放到可见身体外侧；大形象或贴边时横向空间不足，就放到身体上方的外侧。
    // 不把标签钳回耳朵和头饰上；气泡/卡片的层级更高，说话时可以盖住这条次要状态。
    if (!busyEl.hidden) {
      const w = busyEl.offsetWidth || 80;
      // 用整张身体画布避让，打字时尾巴/键盘可能伸出待机图的透明度轮廓。
      const left = side - w - 8;
      const right = side + body + 8;
      const beside = left >= visL || right + w <= visR;
      busyEl.style.left = (left >= visL ? left : right + w <= visR ? right : visL).toFixed(1) + 'px';
      busyEl.style.bottom = ((beside ? body * 0.42 : body + 12) - body * box.bottom + 6) + 'px';
    }
    // 会话状态灯：和「N 个在跑」一样放在身体外侧；两边都放不下（大形象、贴边）就横过来放到身体上方的外侧。
    // 展开后灯多（r27d）：竖排按窗口剩余高度换列、横排按可见宽度换行，顶边不出窗口，每盏都点得到。
    let lampBox = null;   // 灯条占的矩形（左、宽、离窗口底边、高），给下面的快捷钮避让
    if (!lampsEl.hidden) {
      const CELL = 17, PAD = 10;   // 12px 灯 + 5px 间隔；四周各 5px 内边距
      const n = lampsEl.classList.contains('merged') ? 0 : lampsEl.childElementCount;
      const winH = window.innerHeight || 340;
      const grid = (rows, cols) => { lampsEl.style.gridTemplateRows = rows ? 'repeat(' + rows + ', 12px)' : ''; lampsEl.style.gridTemplateColumns = cols ? 'repeat(' + cols + ', 12px)' : ''; };
      const sideBottom = body * 0.12 - body * box.bottom + 6;
      lampsEl.classList.remove('row');
      grid(n ? clampNum(Math.floor((winH - sideBottom - 4 - PAD + 5) / CELL), 1, n) : 0, 0);
      let w = lampsEl.offsetWidth || 22;
      const left = side - w - 8, right = side + body + 8;
      const beside = left >= visL || right + w <= visR;
      if (!beside) {
        lampsEl.classList.add('row');
        grid(0, n ? clampNum(Math.floor((visR - visL - PAD + 5) / CELL), 1, n) : 0);
        w = lampsEl.offsetWidth || w;
      }
      lampsEl.style.left = (left >= visL ? left : right + w <= visR ? right : clampNum(visL, 0, Math.max(0, WIN_W - w))).toFixed(1) + 'px';
      let bottom = (beside ? body * 0.12 : body + 12) - body * box.bottom + 6;
      const h = lampsEl.offsetHeight || 0;
      if (bottom + h > winH - 4) bottom = Math.max(0, winH - 4 - h);
      lampsEl.style.bottom = bottom.toFixed(1) + 'px';
      lampBox = { left: parseFloat(lampsEl.style.left) || 0, width: lampsEl.offsetWidth || w, bottom, height: h || lampsEl.offsetHeight || 22 };
    }
    // 悬停快捷钮（r27f）：对着看得见的身体居中，放在头顶（含头饰）上方；小圆点亮着时再抬到它上面，不挡住它。
    if (!quickEl.hidden) placeQuick({ H: window.innerHeight || 340, body, visL, visR, cx, lampBox, dotLeft });
    // 提醒面板、问助理：两边各留 10px，伸出屏幕的那边再让出伸出的宽度
    panelEl.style.left = Math.max(10, visL) + 'px';
    panelEl.style.right = Math.max(10, WIN_W - visR) + 'px';
    askEl.style.left = Math.max(10, visL) + 'px';
    askEl.style.right = Math.max(10, WIN_W - visR) + 'px';
    // 贴边时面板变窄、字折行变多：高度用满身体上方的空间（顶上留 4px），一条提醒时「在助理里打开 ›」尽量不用滚动就看得到
    if (!panelEl.hidden) {
      const bottom = parseFloat(getComputedStyle(panelEl).bottom) || 0;
      panelEl.style.maxHeight = Math.max(120, window.innerHeight - bottom - 4) + 'px';
    }
  }

  function showPanel(items) {
    panelList.textContent = '';
    $('panel-count').textContent = (items || []).length > 1 ? (items || []).length + ' 条' : '';
    for (const item of items || []) {
      const row = document.createElement('div');
      row.className = 'panel-item';
      const label = noticeLabel(item, '');
      if (label) { const k = document.createElement('span'); k.className = 'kind'; k.textContent = label; row.appendChild(k); }
      const title = document.createElement('b');
      title.textContent = item.title || '';
      row.appendChild(title);
      if (item.at && item.notify) { const w = document.createElement('span'); w.className = 'when'; w.textContent = hhmm(item.at); row.appendChild(w); }
      if (item.text) { const p = document.createElement('p'); p.textContent = item.text; row.appendChild(p); }
      if (item.kind === 'chatter') { panelList.appendChild(row); continue; }
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.textContent = item.notify ? (item.cta || '打开') + ' ›' : '在助理里打开 ›';
      open.addEventListener('click', () => { api.openNotice(item); hidePanel(); });
      row.appendChild(open);
      panelList.appendChild(row);
    }
    bubbleEl.hidden = true;
    bubbleId = '';
    hideQuick();
    panelEl.hidden = false;
    layoutOverlays();
  }
  function hidePanel() { panelEl.hidden = true; setHit(false); }
  $('panel-close').addEventListener('click', hidePanel);

  // ---------- 正在跑的会话（2026-11-09） ----------
  const busyEl = $('busy');
  function showBusy(n) {
    // 有会话状态灯时由灯代替「N 个在跑」；拿不到会话列表时（旧主进程、测试注入）仍显示这条。
    // 安静档只留小圆点：灯藏起来后也不能退回旋转的「N 个在跑」（r27e）。
    const on = n > 0 && !state.peeking && state.mode !== 'quiet' && !lampList.length;
    busyEl.hidden = !on;
    if (on) $('busy-text').textContent = n + ' 个在跑';
  }

  // ---------- 会话状态灯（2026-11-17 r27c） ----------
  // 每个会话一盏：转圈=在跑、绿=答完、橙=出错；点灯直达那个会话。超过 6 盏合并成「转圈 N · 绿 N · 橙 N」，点一下展开全部。
  const lampsEl = $('lamps');
  const LAMP_MAX = 6, LAMP_TEXT = { run: '在跑', done: '答完了，点开看', err: '出错了，点开看' };
  let lampList = [], lampKey = '', lampExpanded = false, lampCollapseTimer = 0;
  const lampPrev = new Map();
  function lampDot(st) { const el = document.createElement('i'); el.className = 'lamp ' + st; return el; }
  function showLamps(list) {
    lampList = Array.isArray(list) ? list.filter(l => l && l.id && LAMP_TEXT[l.st]) : [];
    const merged = lampList.length > LAMP_MAX && !lampExpanded;
    const key = (merged ? 'M' : 'L') + JSON.stringify(lampList);
    if (key === lampKey) return;
    lampKey = key;
    lampsEl.textContent = '';
    lampsEl.classList.toggle('merged', merged);
    if (merged) {
      const count = { run: 0, done: 0, err: 0 };
      for (const l of lampList) count[l.st]++;
      for (const st of ['run', 'done', 'err']) {
        if (!count[st]) continue;
        const span = document.createElement('span'); span.appendChild(lampDot(st)); span.appendChild(document.createTextNode(String(count[st])));
        lampsEl.appendChild(span);
      }
      lampsEl.title = lampList.length + ' 个会话：在跑 ' + count.run + '，答完 ' + count.done + '，出错 ' + count.err + '。点开看每一个';
    } else {
      lampsEl.title = '';
      for (const l of lampList) {
        const el = lampDot(l.st);
        el.dataset.lamp = l.id;
        el.title = (l.title || '会话') + '（' + LAMP_TEXT[l.st] + '）';
        const prev = lampPrev.get(l.id);
        if (prev && prev !== l.st && !reducedMotion.matches) el.classList.add('lit');
        lampsEl.appendChild(el);
      }
    }
    lampPrev.clear();
    for (const l of lampList) lampPrev.set(l.id, l.st);
    lampsEl.hidden = !lampList.length;
  }
  function clickLamp(target) {
    const lamp = target && target.closest && target.closest('[data-lamp]');
    if (lamp) { lampExpanded = false; api.openSession?.(lamp.dataset.lamp); return; }
    if (lampsEl.classList.contains('merged')) {
      lampExpanded = true; showLamps(lampList); layoutOverlays();
      clearTimeout(lampCollapseTimer);
      lampCollapseTimer = setTimeout(() => { lampExpanded = false; showLamps(lampList); layoutOverlays(); }, 8000);
    }
  }

  // ---------- 事件道具（2026-11-17 r27c） ----------
  // 正在说的这条配一件道具（答完举牌、等回复冒「…」、出错感叹号加汗、新版本礼盒、硬盘容量条），没在说时开会戴耳机、额度低亮低电量。
  // 道具挂在身体里、跟着身体一起动；位置按当前帧的透明度轮廓算，帧变了只在挪动超过 1.5 像素时才重写位置。
  const propsEl = $('props');
  const { prop: propOf, stateProp } = window.HubPetNotices;
  let propKind = '', propBubble = '', propParts = [], propGeom = null, propPos = '', propInputs = '';
  function propAction(kind) {
    if (reducedMotion.matches) return;
    const t = now();
    // 出错：身体一抖；硬盘：轻抖一下；等回复：歪头招手；新版本：轻跳一下。答完的欢呼由「开心」姿态自己跳。
    if (kind === 'err') script = { start: t, dur: 520, fn: s => ({ x: 4 * Math.sin(Math.PI * 8 * s) * (1 - s), rot: 0, y: 0, sx: 1, sy: 1 }) };
    else if (kind === 'disk') script = { start: t, dur: 900, fn: s => ({ x: 3 * Math.sin(Math.PI * 6 * s) * (1 - s), rot: 0, y: 0, sx: 1, sy: 1 }) };
    else if (kind === 'wait') script = { start: t, dur: 1800, fn: s => ({ rot: 5 * Math.sin(Math.PI * 3 * s) * (1 - s * 0.4), y: 0, sx: 1, sy: 1 }) };
    else if (kind === 'gift') hops.push({ start: t + 60, dur: 380, height: 12 });
    wake();
  }
  function updateProp() {
    const kind = stateProp(state);
    const bid = state.bubble && propOf(state.bubble) ? state.bubble.id : '';
    if (kind === propKind && bid === propBubble) return;
    const fresh = kind && (kind !== propKind || bid !== propBubble);
    propKind = kind; propBubble = bid; propGeom = null; propPos = '';
    propsEl.textContent = ''; propParts = [];
    if (fresh) propAction(kind);
  }
  function renderProps() {
    const frames = visual && frameGeometry.get(visual.url);
    const geom = frames && frames[visual.spec.sheet ? Math.max(0, visual.shown) : 0];
    const show = !!(propKind && geom && !state.peeking && pose !== 'peek' && visual.spec.sheet !== 'dock-right');
    propsEl.hidden = !show;
    // 缓存键含帧几何、大小、头饰、有无卡片（r27d）：缩放、换头饰、卡片出现/收起时都要重算，不能只看帧。
    if (!show) return;
    const size = Math.round(150 * (Number(state.scale) || 1));
    const headKey = !headEl.hidden && headEl.naturalWidth ? headEl.currentSrc || headEl.src : '';
    const evo = state.growth && state.growth.evolution;
    const inputKey = size + '|' + headKey + '|' + (evo && evo.width || 0) + '|' + (state.bubble ? 1 : 0);
    if (geom === propGeom && inputKey === propInputs) return;
    propGeom = geom; propInputs = inputKey;
    // 头饰高出头顶的部分：头饰底边压进头部 18%，按图片宽高比算，不读排版。
    let crown = 0;
    if (!headEl.hidden && headEl.naturalWidth) {
      const e = state.growth && state.growth.evolution;
      if (e && e.width) crown = geom.width * e.width * headEl.naturalHeight / headEl.naturalWidth * 0.82;
    }
    const parts = window.HubPetProps.layout(propKind, geom, { crown, bubble: state.bubble });
    // 卡片和气泡的下沿在身体方框上方 6px：头很高的形象（兔子）道具会钻到卡片底下，往下挪到卡片下沿之下。
    if (state.bubble) for (const p of parts) {
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(p.svg);
      const w = p.wf ? p.wf * size : p.w * size / 150, h = vb ? w * Number(vb[2]) / Number(vb[1]) : w;
      const top = p.y * size + p.ty / 100 * h;
      if (top < 6) p.y += (6 - top) / size;   // 留出弹出、招手动画的余量
    }
    const pos = size + ':' + parts.map(p => Math.round(p.x * size / 1.5) + ',' + Math.round(p.y * size / 1.5)).join(';');
    if (pos === propPos && propParts.length === parts.length) return;
    propPos = pos;
    if (propParts.length !== parts.length) {
      propsEl.textContent = '';
      propParts = parts.map(p => { const el = document.createElement('i'); el.innerHTML = p.svg; el.firstChild.setAttribute('class', p.cls); propsEl.appendChild(el); return el; });
    }
    parts.forEach((p, i) => {
      const el = propParts[i];
      el.style.left = (p.x * 100).toFixed(2) + '%';
      el.style.top = (p.y * 100).toFixed(2) + '%';
      el.style.width = p.wf ? (p.wf * 100).toFixed(2) + '%' : (p.w * size / 150).toFixed(1) + 'px';
      el.style.transform = 'translate(' + p.tx + '%,' + p.ty + '%)';
    });
  }

  // ---------- 问助理（2026-11-09） ----------
  const askEl = $('ask'), askInput = $('ask-input'), askNote = $('ask-note'), askSend = $('ask-send');
  let askCloseTimer = 0, askSending = false;
  let enableAssistant = false, pendingQuestion = '';
  function openAsk() {
    clearTimeout(askCloseTimer);
    hideQuick();
    panelEl.hidden = true;
    askEl.hidden = false;
    askSend.disabled = false;
    enableAssistant = false; pendingQuestion = ''; askSend.textContent = '交给助理';
    askNote.textContent = '回车发送 · Esc 关闭';
    askNote.classList.remove('bad');
    layoutOverlays();
    setHit(true);
    setTimeout(() => askInput.focus(), 30);
  }
  function closeAsk() {
    clearTimeout(askCloseTimer);
    if (askEl.hidden) return;
    askEl.hidden = true;
    setHit(false);
    api.askClose?.();
  }
  askEl.addEventListener('submit', e => {
    e.preventDefault();
    const text = enableAssistant ? pendingQuestion : askInput.value.trim();
    if (!text) { askInput.focus(); return; }
    if (askSending) return;   // 连按回车只交一次
    askSending = true;
    askSend.disabled = true;
    askNote.textContent = '正在交给助理…';
    pendingQuestion = text;
    api.ask?.(text, enableAssistant);
  });
  askInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askEl.requestSubmit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
  });
  $('ask-cancel').addEventListener('click', closeAsk);
  // 点到别处（窗口失焦）：没写字就收起，写了字的留着。
  window.addEventListener('blur', () => { if (!askEl.hidden && !askInput.value.trim()) closeAsk(); });
  api.onAskOpen?.(() => openAsk());
  api.onAskResult?.(r => {
    askSending = false;
    if (r && r.ok) {
      enableAssistant = false; pendingQuestion = ''; askSend.textContent = '交给助理';
      askInput.value = '';
      askNote.textContent = '交给助理了，答好了我举牌告诉你';
      askCloseTimer = setTimeout(closeAsk, 1400);
    } else {
      askSend.disabled = false;
      enableAssistant = r?.enableAssistant === true;
      askSend.textContent = enableAssistant ? '开启助理并发送' : '交给助理';
      askNote.textContent = (r && r.error) || '没交出去，再试一次';
      askNote.classList.add('bad');
    }
  });

  // ---------- 等级与进化：当前帧的透明度决定头饰与翅膀的位置 ----------
  const lvEl = $('lv'), headEl = $('evolve-head'), wingsEl = $('evolve-wings'), sparksEl = $('sparks'), haloEl = $('halo'), fxEl = $('fx');
  const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let headAnchor = null, evolutionRun = null, pendingEvolutionBubble = null, quietEvolutionUntil = 0;
  function cacheFrameGeometry(img, url) {
    const sheet = /\/seq-[^/]+\.webp(?:[?#].*)?$/.test(url);
    const cols = sheet ? 5 : 1, rows = cols, size = 192;
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }), frames = [];
    const sw = img.naturalWidth / cols, sh = img.naturalHeight / rows;
    const ratio = Math.min(size / sw, size / sh), dw = sw * ratio, dh = sh * ratio;
    try {
      for (let f = 0; f < cols * rows; f++) {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, f % cols * sw, Math.floor(f / cols) * sh, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
        frames.push(window.HubPetEvolution.measure(ctx.getImageData(0, 0, size, size).data, size, size, sheet ? frames[0] : null));
      }
      frameGeometry.set(url, frames);
    } catch (_) { frameGeometry.set(url, []); /* 读不到透明度时不猜位置，隐藏装饰 */ }
  }
  function evolutionAsset(el, name) {
    if (!name || el.dataset.asset === name) return;
    el.dataset.asset = name; el.src = '../assets/hub-pet/evolve/' + name + '.webp';
  }
  function renderEvolution(t) {
    if (evolutionRun && t - evolutionRun.start >= 1200) finishEvolution(true);
    const g = state.growth, e = evolutionRun ? evolutionRun.from : g && g.evolution;
    const frames = visual && frameGeometry.get(visual.url);
    const geom = frames && frames[visual.spec.sheet ? Math.max(0, visual.shown) : 0];
    const hide = !g || !e || !geom || state.peeking || pose === 'sleep' || pose === 'peek' || visual.spec.img === 'sleep' || visual.spec.sheet === 'dock-right';
    headEl.hidden = hide || !e.head;
    wingsEl.hidden = hide || !e.wings;
    if (!hide) {
      const size = Math.round(150 * (Number(state.scale) || 1));
      headAnchor = window.HubPetEvolution.anchor(geom, headAnchor, size);
      if (e.head) {
        evolutionAsset(headEl, e.head);
        headEl.style.left = (headAnchor.x * 100).toFixed(3) + '%';
        headEl.style.top = (headAnchor.y * 100).toFixed(3) + '%';
        headEl.style.width = (geom.width * e.width * 100).toFixed(3) + '%';
      }
      if (e.wings) {
        evolutionAsset(wingsEl, e.wings);
        wingsEl.classList.toggle('royal', e.n === 6);
        wingsEl.style.left = ((geom.left + geom.right) * 50).toFixed(3) + '%';
        wingsEl.style.top = ((geom.top + geom.height * 0.40) * 100).toFixed(3) + '%';
        wingsEl.style.width = (geom.width * (e.n === 6 ? 1.42 : 1.18) * 100).toFixed(3) + '%';
      }
    }
    return !!evolutionRun;
  }
  function finishEvolution(reveal) {
    if (!evolutionRun) return;
    evolutionRun = null;
    bodyEl.classList.remove('evolving');
    if (reveal && state.growth && !reducedMotion.matches) {
      headEl.classList.remove('evolve-pop'); void headEl.offsetWidth; headEl.classList.add('evolve-pop');
      celebrate(true);
    }
    if (pendingEvolutionBubble) { showBubble(pendingEvolutionBubble); pendingEvolutionBubble = null; }
  }
  function evolve(m) {
    finishEvolution(false);
    if (reducedMotion.matches) {
      // 通知会把姿态切到开心；减少动态效果时也要抑制这次切姿态附带的连跳。
      quietEvolutionUntil = now() + 2000; script = null; hops = []; squash = null;
      return;
    }
    if (!state.growth || document.visibilityState === 'hidden') return;
    evolutionRun = { start: now(), from: m.fromEvolution || null };
    bodyEl.classList.add('evolving');
  }
  let growthKey = '';
  function showGrowth(g) {
    const key = g ? g.level + ':' + g.rank + ':' + (g.perks || []).join(',') : '';
    if (key !== growthKey) {
      growthKey = key;
      const perk = id => !!g && (g.perks || []).indexOf(id) >= 0;
      lvEl.hidden = !perk('chip'); if (g) lvEl.textContent = 'Lv.' + g.level;
      sparksEl.hidden = !perk('sparkle');
      haloEl.hidden = !perk('halo');
    }
    if (!g) finishEvolution(false);
    renderEvolution(now());
    document.body.classList.toggle('peeking', !!state.peeking);
  }
  const FX_COLORS = ['#3478f6', '#ffc83d', '#ff5d7a', '#35c28a', '#9b6bff', '#ff9a3d'];
  function burst(tag, n, make) {
    const body = Math.round(150 * (Number(state.scale) || 1));
    for (let i = 0; i < n; i++) { const el = document.createElement(tag); make(el, i, body); fxEl.appendChild(el); setTimeout(() => el.remove(), 2400); }
  }
  // 撒花：从身体两侧往上喷一把彩纸，同时连跳三下
  function celebrate(big) {
    if (reducedMotion.matches) return;
    const t = now();
    hops.push({ start: t + 40, dur: 380, height: 22 }, { start: t + 460, dur: 420, height: big ? 34 : 28 }, { start: t + 920, dur: 360, height: 16 });
    script = { start: t, dur: 1300, fn: s => ({ rot: 5 * Math.sin(Math.PI * 4 * s) * (1 - s), y: 0, sx: 1, sy: 1 }) };
    burst('i', big ? 34 : 22, (el, i, body) => {
      const left = i % 2 === 0;
      el.style.setProperty('--x', (140 + (left ? -1 : 1) * body * 0.28).toFixed(0) + 'px');
      el.style.setProperty('--y', (body * 0.45).toFixed(0) + 'px');
      el.style.setProperty('--dx', ((left ? -1 : 1) * rand(10, 95)).toFixed(0) + 'px');
      el.style.setProperty('--up', rand(50, 130).toFixed(0) + 'px');
      el.style.setProperty('--c', FX_COLORS[i % FX_COLORS.length]);
      el.style.setProperty('--d', rand(1.2, 1.9).toFixed(2) + 's');
      el.style.setProperty('--delay', (i * 0.018).toFixed(3) + 's');
    });
    wake();
  }
  function hearts() {
    burst('b', 3, (el, i, body) => {
      el.style.setProperty('--x', (140 - 22 + i * 18).toFixed(0) + 'px');
      el.style.setProperty('--y', (body * (1 - box.top) - 14).toFixed(0) + 'px');
      el.style.setProperty('--dx', ((i - 1) * 12).toFixed(0) + 'px');
      el.style.setProperty('--delay', (i * 0.12).toFixed(2) + 's');
    });
  }
  // 单击逗它（r27f）：压一下之外，随机回一个小反应（下蹲小跳、歪头、抖一抖）。躲边、减少动态效果时只压一下。
  function pokeReact() {
    if (reducedMotion.matches || state.peeking || walking) return;
    const t = now(), pick = Math.floor(Math.random() * 3), dir = Math.random() < 0.5 ? -1 : 1;
    if (pick === 0) hops.push({ start: t + 60, dur: 300, height: 9, crouch: 100 });
    else if (pick === 1) script = { start: t, dur: 900, fn: s => { const k = Math.sin(Math.PI * s); return { x: 1.5 * dir * k, y: 0, rot: 8 * dir * k, sx: 1, sy: 1 }; } };
    else { const move = M.IDLE_MOVES.find(m => m.name === 'shake'); script = { start: t, dur: 700, fn: s => move.fn(s, dir) }; }
  }
  // 鼠标靠近（主进程按光标位置算好哪一侧）：侧身看过去；隔 15 秒以上重新靠近时，先下蹲再轻跳一下。
  api.onNear?.(n => {
    const side = n && n.near ? (n.side < 0 ? -1 : 1) : 0;
    const t = now();
    if (side && !nearSide && lively() && pose === 'idle' && !script && !walking && !lifted && t - lastNearHop > 15000) {
      lastNearHop = t;
      hops.push({ start: t + 40, dur: 300, height: 7, crouch: 120 });
    }
    nearSide = side;
    wake();
  });

  // 摸摸：鼠标不按键、在身上左右来回蹭两个来回算一次（主进程限 3 秒一次，确认后才冒爱心）
  let stroke = { x: 0, dir: 0, turns: 0, dist: 0, at: 0 };
  function strokeMove(x) {
    const t = now();
    if (t - stroke.at > 900) stroke = { x, dir: 0, turns: 0, dist: 0, at: t };
    const dx = x - stroke.x;
    if (Math.abs(dx) < 3) return;
    const dir = dx > 0 ? 1 : -1;
    if (stroke.dir && dir !== stroke.dir) stroke.turns++;
    stroke.dir = dir; stroke.dist += Math.abs(dx); stroke.x = x; stroke.at = t;
    if (stroke.turns >= 2 && stroke.dist >= 90) { stroke.turns = 0; stroke.dist = 0; api.pet?.(); }
  }

  // ---------- 鼠标：透明处点穿，身体、气泡、圆点、面板上才接住 ----------
  function setHit(v) { if (v !== hitNow) { hitNow = v; api.hit(v); } }
  function hitTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    const node = el && el.closest('[data-hit]');
    if (!node) return null;
    const kind = node.getAttribute('data-hit');
    if (kind !== 'pet') return kind;
    // 身体的方框四角大多是透明的，只认中间一块
    const r = bodyEl.getBoundingClientRect();
    const ix = r.width * 0.16, iy = r.height * 0.12;
    return x > r.left + ix && x < r.right - ix && y > r.top + iy && y < r.bottom - 4 ? 'pet' : null;
  }
  // ---------- 悬停快捷钮（2026-11-17 r27f） ----------
  // 鼠标在身上停半秒：头顶冒出「问 / 信 / 摸」；移开（离开身体和圆钮）650ms 后收起。正在说话、展开面板、问助理、拖动、躲边时不冒。
  const quickEl = $('quick'), quickN = $('quick-n');
  let quickTimer = 0, quickHideTimer = 0;
  // 安静档（含临时安静、今天静音）、开会时悬停也不冒（r27f 审查第 5 项）。
  const quickAllowed = () => state.hush !== true && state.mode !== 'quiet' && state.meeting !== true && !pressing && !lifted && !state.peeking && pose !== 'peek' && bubbleEl.hidden && card.el.hidden && panelEl.hidden && askEl.hidden;
  function showQuick() {
    if (!quickAllowed()) return;
    const n = Number(state.dots) || 0;
    quickN.hidden = !(n > 0); quickN.textContent = n > 9 ? '9+' : String(n);
    const inbox = quickEl.querySelector('[data-q="inbox"]');
    inbox.classList.toggle('empty', !(n > 0));
    inbox.title = n > 0 ? '看 ' + n + ' 条没看的消息' : '暂时没有没看的消息';
    quickEl.querySelector('[data-q="ask"]').title = state.quickAsk === false ? '打开助理' : '问助理一句';
    quickEl.hidden = false;
    layoutOverlays();
  }
  function hideQuick() {
    clearTimeout(quickTimer); clearTimeout(quickHideTimer); quickTimer = quickHideTimer = 0;
    quickEl.hidden = true;
  }
  function hoverSeen(kind) {
    if (kind === 'pet' || kind === 'quick') {
      clearTimeout(quickHideTimer); quickHideTimer = 0;
      if (kind === 'pet' && quickEl.hidden && !quickTimer) quickTimer = setTimeout(() => { quickTimer = 0; showQuick(); }, 500);
    } else {
      clearTimeout(quickTimer); quickTimer = 0;
      if (!quickEl.hidden && !quickHideTimer) quickHideTimer = setTimeout(() => { quickHideTimer = 0; quickEl.hidden = true; }, 650);
    }
  }
  function clickQuick(target) {
    const btn = target && target.closest && target.closest('[data-q]');
    if (!btn) return;
    const q = btn.dataset.q;
    if (q === 'inbox' && !(Number(state.dots) > 0)) { btn.classList.remove('nope'); void btn.offsetWidth; btn.classList.add('nope'); return; }
    hideQuick();
    api.quick?.(q);
  }

  document.addEventListener('mousemove', e => { if (!pressing) { const hit = hitTarget(e.clientX, e.clientY); setHit(!!hit); hoverSeen(hit); if (hit === 'pet') strokeMove(e.clientX); else stroke.at = 0; } setHold(!!(e.target && e.target.closest && e.target.closest('#ncard, #bubble.has-chips'))); });
  document.addEventListener('mouseleave', () => { if (!pressing) setHit(false); hoverSeen(null); setHold(false); stroke.at = 0; });
  // 窗口点穿时收不到 mousemove：主进程看到光标进了窗口方框，就把位置发过来问一次（不再用全局鼠标钩子）。
  // 接住时总要回报：主进程可能已因光标出框自行改回点穿，这时 hitNow 还是旧值。
  api.onProbe?.(p => { if (pressing || !p) return; const hit = hitTarget(Number(p.x) || 0, Number(p.y) || 0); const v = !!hit; hitNow = v; if (v) api.hit(true); hoverSeen(hit); });
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const target = hitTarget(e.clientX, e.clientY);
    // 面板、问助理输入框、卡片上的 × 都在本窗口里自己处理点击，不交给主进程（不然会被当成拖动或「点卡片打开」）。
    if (target === 'lamp') { clickLamp(e.target); return; }
    if (target === 'quick') { clickQuick(e.target); return; }
    hideQuick();
    if (!target || target === 'panel' || target === 'ask' || target === 'close' || target === 'chip') return;
    pressing = true; stroke.at = 0;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (_) {}
    api.press(target);
  });
  const endPress = () => { if (!pressing) return; pressing = false; bodyEl.classList.remove('dragging'); api.release(); };
  document.addEventListener('pointerup', endPress);
  document.addEventListener('lostpointercapture', endPress);
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (hitTarget(e.clientX, e.clientY) === 'pet') api.menu();
  });

  // ---------- 大小与身体透明边（2026-10-18） ----------
  // 形象图四周有一圈透明边：量出看得见的身体占多大，告诉主进程按真身体贴屏幕边（不然离边还有二三十像素就停住），
  // 脚下那段透明边用来把身体往下挪，让脚踩在任务栏上沿。图是本地文件，画到画布上读透明度。
  let box = { left: 0, right: 0, top: 0, bottom: 0 };
  let sizeKey = '';
  function applySize() {
    const body = Math.round(150 * (Number(state.scale) || 1));
    const key = body + ':' + box.bottom;
    if (key === sizeKey) return;
    sizeKey = key;
    document.documentElement.style.setProperty('--body', body + 'px');
    document.documentElement.style.setProperty('--feet', Math.round(box.bottom * body) + 'px');
  }
  function measureBody(url, role) {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, w, h).data;
        let minX = w, maxX = -1, minY = h, maxY = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] <= 24) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (maxX < 0 || role !== state.role) return; // 量完时已经换了形象，这次的结果作废
        box = { left: minX / w, right: (w - 1 - maxX) / w, top: minY / h, bottom: (h - 1 - maxY) / h };
        sizeKey = '';
        applySize();
        layoutOverlays();
        api.bodyBox?.({ ...box, role });
      } catch (_) { /* 量不出来就按整张图算，和以前一样 */ }
    };
    img.src = url;
  }

  // ---------- 主进程消息 ----------
  api.onState(next => {
    // 换形象，或同一形象更新到新版本，都按换形象处理：重新量轮廓、预载新图、重新摆姿态。
    const roleChanged = next.role !== state.role || (next.roleVersion || null) !== (state.roleVersion || null);
    const prevDock = state.dock;
    state = M.mergeMainState(state, next);   // lowPower 按本条消息归一化：省略＝关，关掉低开销当场恢复
    if (prevDock !== state.dock || roleChanged) {
      document.body.classList.toggle('dock-right', state.dock === 'right');
      document.body.classList.toggle('dock-left', state.dock === 'left');
    }
    applySize();
    if (roleChanged) {
      measureBody(asset('idle'), state.role);
      preloadRole();
      const first = !pose;
      if (first) applyPose(state.pose, true);
      else { pose = state.pose; show(baseSpec(state.pose), { transition: 'pop' }); hops.push({ start: now() + 80, dur: 360, height: 10 }); }
    } else applyPose(state.pose, false);
    if (evolutionRun && state.bubble && /^evolve-[2-6]$/.test(state.bubble.art || '')) pendingEvolutionBubble = state.bubble;
    else { pendingEvolutionBubble = null; showBubble(state.bubble); }
    showDots(state.dots, state.dotTones);
    if (!quickEl.hidden && !quickAllowed()) hideQuick();   // 开口说话、躲边、切安静档、开会时收起快捷钮
    showLamps(state.peeking || state.mode === 'quiet' ? [] : state.lamps);   // 全屏、安静档不亮会话灯（r27d）
    showBusy(Number(state.running) || 0);
    document.body.classList.toggle('meeting', state.meeting === true && !state.peeking);
    document.body.classList.toggle('soft-gpu', M.decorStill({ softGpu: softGpu(), lowPower: lowPower() }));   // pet.css：软件渲染或低开销时停掉无限循环的装饰动画
    updateProp();
    showGrowth(state.growth);
    layoutOverlays();
    wake();
  });
  api.onMotion(m => {
    if (!m) return;
    if (m.phase === 'lift') { swingPeak = 0; lifted = true; bodyEl.classList.add('dragging'); script = null; walking = null; sitting = false; hugging = false; swingVx = drag.vx; }
    else if (m.phase === 'drag') { drag.vx = M.approach(drag.vx, m.vx || 0, 16, 30); drag.vy = M.approach(drag.vy, m.vy || 0, 16, 30); }
    else if (m.phase === 'release') { lifted = false; bodyEl.classList.remove('dragging'); }
    // 甩出去（r27f）：飞的时候身子继续晃，落地压扁回弹；摔得重压得更扁。
    else if (m.phase === 'fly') { flying = { start: now(), dur: Number(m.durationMs) || 600 }; }
    else if (m.phase === 'land') { flying = null; squash = { start: now(), power: 0.06 + 0.1 * M.clamp(m.impact || 0, 0, 1) }; }
    else if (m.phase === 'poke') { squash = { start: now(), power: 0.07 }; if (m.play) pokeReact(); }
    else if (m.phase === 'hug') {
      hugging = m.on === true;
      clearInterval(hugHearts); hugHearts = 0;
      if (hugging) { hearts(); hugHearts = setInterval(() => { if (hugging) hearts(); }, 1100); }
      else squash = { start: now(), power: 0.06 };
    }
    // 走动（r27f）：开始迈步 / 停下；坐在窗口边上（往窗口那边靠）。
    else if (m.phase === 'walk') { walking = m.on === true ? { start: now(), dir: m.dir < 0 ? -1 : 1 } : null; if (m.on === true) sitDir = m.dir < 0 ? -1 : 1; else squash = { start: now(), power: 0.03 }; }
    else if (m.phase === 'sit') sitting = m.on === true;
    else if (m.phase === 'celebrate') celebrate(m.big === true);
    else if (m.phase === 'evolve') evolve(m);
    else if (m.phase === 'petted') { hearts(); squash = { start: now(), power: 0.05 }; hops.push({ start: now() + 60, dur: 300, height: 8 }); }
    wake();
  });
  api.onPanel(p => { showPanel(p && p.items); wake(); });

  // 系统「减少动态效果」告诉主进程：开着时不在任务栏上走动。
  const sendPrefs = () => api.prefs?.({ reducedMotion: reducedMotion.matches });
  reducedMotion.addEventListener?.('change', sendPrefs);
  reducedMotion.addEventListener?.('change', () => wake());   // 关掉「减少动态效果」后恢复呼吸
  sendPrefs();

  window.__hubPetDebug = () => ({ card: cardId ? { id: cardId, title: card.title.textContent, kind: card.kind.textContent, cta: card.cta.textContent, count: card.count.textContent, bad: card.el.classList.contains('bad') } : null,
    evolution: { head: !headEl.hidden, wings: !wingsEl.hidden, anchor: headAnchor, active: !!evolutionRun, geometry: visual && frameGeometry.get(visual.url)?.[visual.spec.sheet ? Math.max(0, visual.shown) : 0] },
    busy: busyEl.hidden ? '' : $('busy-text').textContent,
    prop: propsEl.hidden ? '' : propKind, propRects: propParts.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }),
    lamps: lampsEl.hidden ? null : { merged: lampsEl.classList.contains('merged'), row: lampsEl.classList.contains('row'), items: [...lampsEl.querySelectorAll('[data-lamp]')].map(el => ({ id: el.dataset.lamp, st: el.classList.contains('run') ? 'run' : el.classList.contains('err') ? 'err' : 'done' })), text: lampsEl.textContent },
    // r27f：快捷钮、鼠标靠近、钟摆、抱抱、走动、坐下、下一次小动作还有多久、最近一种新动作
    quick: quickEl.hidden || quickEl.style.visibility === 'hidden' ? null : (() => { const r = quickEl.getBoundingClientRect(); return { col: quickEl.classList.contains('col'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, n: quickN.hidden ? 0 : quickN.textContent, buttons: [...quickEl.querySelectorAll('[data-q]')].map(b => { const x = b.getBoundingClientRect(); return { q: b.dataset.q, left: x.left, top: x.top, right: x.right, bottom: x.bottom }; }) }; })(),
    near: nearSide, nearTurn, swing: { ...swing }, swingPeak, hug: hugging, hugK, walking: !!walking, sitting, sitK, lively: lively(), gestureIn: Math.round(nextGestureAt - now()), lastMove, flying: !!flying, hops: hops.length,
    dotText: dotEl.hidden ? '' : dotEl.textContent, meeting: document.body.classList.contains('meeting'), ask: !askEl.hidden, askNote: askNote.textContent, panel: panelEl.hidden ? null : panelList.textContent, box, edge: state.edge, size: getComputedStyle(document.documentElement).getPropertyValue('--body').trim(), pose, layers: visual ? [visual.key] : [], opacities: visual ? [1] : [], domLayers: layersEl.children.length, frame: visual ? visual.shown : -1, swapping: !!pendingSwap, fps: raf ? 'raf' : timer ? 'timer' : 'stopped', softGpu: softGpu(), still: stillMode(), bubble: bubbleId, bubbleText: bubbleId ? bubbleText.textContent : '', bubbleTag: bubbleKind.hidden ? '' : bubbleKind.textContent, chips: bubbleId ? Array.from(chipsEl.querySelectorAll('.chip')).map(el => el.textContent) : [], dots: lastDots, transform: bodyEl.style.transform });
  api.ready();
})();
