'use strict';
// 助理桌宠的窗口与行为（主进程）。设计：docs/design/hub-pet.md。
// 一个透明、无边框、置顶、不进任务栏的小窗，Hub 开着时出现；动画全在渲染端（renderer/hub-pet/pet.js），
// 这里负责：窗口位置（拖动、惯性、贴边、躲边、记住位置）、姿态判断、气泡排队、右键菜单、打开助理页。
const fs = require('fs');
const path = require('path');
const { ASSISTANT_ACTIONS, MODES, ROLES, SpeechQueue, chatterFor, decidePose, localDateKey, speakGate, weeklyNudge } = require('../core/hub-pet/state');
const { applyReply, cleanName, noteSpoken, normalizePrefs, pickLine } = require('../core/hub-pet/talk');
const { allowedRange, clampTo, cubicOut, dockOf, flingPlan, flyAt, releasePlan, walkIntervals, walkPlan } = require('../core/hub-pet/motion');
const { CLICK_MODES, NOTIFY_MODES, SCALE_MAX, SCALE_MIN, createSettingsStore, isUrgentNotice, parseBox, parseScale } = require('../core/hub-pet/settings');
const { DEFAULT_ROLE, createRolePackStore } = require('../core/hub-pet/role-packs');
const { createFullscreenWatch } = require('../core/hub-pet/fullscreen-watch');
const { createDiskWatch } = require('../core/hub-pet/disk-watch');

const WIN_W = 280;
const WIN_H = 340;                       // 原大小时的窗口高度；放大后按身体加高（winH）
const BODY = 150;                        // 原大小时宠物身体的显示尺寸（DIP），在窗口底部居中
const INSET = { left: (WIN_W - BODY) / 2, right: (WIN_W - BODY) / 2, top: 0, bottom: 6 };
// 大小（2026-10-18 用户：设置里滑动条连续调）：身体 = BODY × scale（SCALE_MIN–SCALE_MAX，见 core/hub-pet/settings.js）；
// 窗口宽不变（放到最大 240 也装得下），高度按身体加高。
const HEAD_ROOM = WIN_H - BODY;          // 身体上方留给气泡、提醒列表的高度
const MARGIN = 24;
const EDGE_CUT_MAX = 120;                // 告诉渲染端「窗口伸出屏幕」的宽度上限，见 edgeCut
const PEEK_VISIBLE = 0.42;               // 躲边时露出身体的比例
const POLL_MS = 4000;                    // 看助理忙不忙、有没有离开电脑
const DRAG_TICK_MS = 16;
// 鼠标是否落在桌宠身上：每 100ms 看一次光标位置，只有光标进了桌宠窗口的方框才问渲染端「点到身体没有」。
// 以前用 setIgnoreMouseEvents 的 forward（Windows 上是全局低级鼠标钩子）：Hub 主进程一忙，全系统鼠标都卡顿、漂移（2026-10-30 同事反馈）。
const HOVER_TICK_MS = 100;
const CLICK_SLOP = 4;
const MODE_LABELS = { lively: '活泼', gentle: '温和', quiet: '安静' };
const MODE_HINTS = { lively: '提醒之外，早上问候、久坐提醒', gentle: '只说助理的提醒', quiet: '不说话，只亮小圆点' };

const MODE_SET = new Set(MODES);
// 2026-11-17 r27f：鼠标离身体中心多近算「靠近」（身体半宽 + 这么多 DIP）；按住多久算抱抱；两次单击隔多久内算双击。
const NEAR_PAD = 110;
const HUG_MS = 600;
const DOUBLE_MS = 400;
// 在任务栏上走动：出来后 4–8 分钟第一次，之后每 8–15 分钟一次；条件不满足（在说话、在开会、人走开了……）1–2 分钟后再看。
const WALK_FIRST = [240000, 480000];
const WALK_EVERY = [480000, 900000];
const WALK_RETRY = [60000, 120000];
const between = ([lo, hi]) => Math.round(lo + Math.random() * (hi - lo));

function createHubPetController({
  BrowserWindow, BaseWindow = null, screen, ipcMain, Menu, powerMonitor, app,
  htmlPath, preloadPath, assetsDir, dataDir,
  company = false, available = true,
  getMainWindow, focusPrimaryWindow, sendToRenderer,
  noticeBus, isAssistantBusy = () => false,
  // 2026-11-09 联动：getSessionActivity() → { running }（正在跑的会话数）；askAssistant(text) → 交给助理的一问；
  // getPages() → { assistant: bool, rooms: { label, hint } | null }（右键菜单里放哪些入口）。
  getSessionActivity = () => null, askAssistant = null, getPages = () => ({}),
  // 2026-11-12 等级联动：getProfile() → { level, rank, perks }（「个人」页的等级、段位、已解锁特效）；onPetted() 被摸了一下。
  getProfile = () => null, onPetted = null,
  // diskRoots() → 要看的盘（系统盘、Hub 数据所在盘）；不给就不看。
  diskRoots = null, diskStatfs = undefined,
  // inMeeting() → 会议页正在录制：这时只亮小圆点，不举卡片（屏幕可能在共享）。
  inMeeting = () => false,
  // r27d：isQuotaLow() → 当前账号额度是否快用完（main.js 按账号用量读数判断，每次轮询都问，切号/重置后自动熄）。
  isQuotaLow = () => false,
  // softGpu() → 本次启动是否关了硬件加速（core/gpu-mode.js 判定，main-bootstrap 记在 process 上）。
  softGpu = () => !!process.__hubGpuDisabledReason,
  // lowOverhead() → 低开销模式是否开着（2026-11-23 P1 L3）：开着时渲染端静默省电，提醒气泡照常。
  lowOverhead = () => false,
  canShow = () => true, debug = false, watchFullscreen = true,
  logger = console, now = () => Date.now(),
  fetchImpl = globalThis.fetch, roleSources = null, autoRoleDelayMs = 2500,
} = {}) {
  // now 是「现在几点」（可在单测里固定）；窗口移动的动画计时一律用真实时钟 Date.now()。
  if (typeof BrowserWindow !== 'function') throw new Error('BrowserWindow is required');
  // 形象：程序自带的（公司版只带小猫、企鹅）+ 在线下载到数据目录的（core/hub-pet/role-packs.js）。
  const roles = createRolePackStore({ assetsDir, dataDir, logger, fetchImpl, ...(roleSources ? { sources: roleSources } : {}),
    emit: (channel, payload) => { try { sendToRenderer?.(channel, payload); } catch (_) {} } });
  // r58：桌宠形象包的下载源标识，和 role-packs.js download() 查内源的版本名、文件名一致（pet-role-<包版本>）。
  // 「pet-role:<id>」只看这一个形象；「pet-role」看目录里全部可下载的形象。
  // 目录还没读过时只替用户查一次（check 会推送界面状态，每次刷新都查会让设置页反复重画）。
  let roleCatalogTried = false;
  require('../core/app-update/download-points').register('pet-role', async point => {
    let catalog = roles.snapshot().catalog;
    if (!catalog && !roleCatalogTried) { roleCatalogTried = true; try { await roles.check(); } catch (_) {} catalog = roles.snapshot().catalog; }
    const id = String(point).split(':')[1] || '';
    const packs = (catalog && Array.isArray(catalog.packs) ? catalog.packs : []).filter(p => !id || p.id === id);
    return packs.length ? { items: packs.map(p => ({ file: p.file, release: `pet-role-${p.version}`, version: p.version })) } : null;
  });
  require('../core/app-update/download-points').register('pet-role:', point => require('../core/app-update/download-points').lookup('pet-role')(point));
  // 设置里记住的形象：装了的，或者是在线可下载的已知形象（2026-10-18：2.1.8 选了兔子等的用户升级后，
  // 记忆不能因为一次别的设置写盘就被改成小猫；显示时没装照样先用小猫，见 currentRole）。
  const knownRole = id => ROLES.some(r => r.id === id);
  const settings = createSettingsStore({ dataDir, company, logger, roleOk: id => roles.installed(id) || knownRole(id) });
  const speech = new SpeechQueue({ now });
  const chatterTrack = {};
  // 存的形象被删掉（或换到没带这只的版本）时用小猫顶上。
  const currentRole = () => { const r = settings.get().role; return roles.installed(r) ? r : DEFAULT_ROLE; };

  let win = null;
  let started = false;
  let disposed = false;
  let pollTimer = null;
  let deadlineTimer = null;
  let moveTimer = null;
  let drag = null;
  let lastSent = '';
  let reminderSyncWarned = false;
  let pose = 'idle';
  let fullscreen = false;
  let peekPulledOut = false;     // 躲边时被用户拖出来了：这次全屏期间不再躲，全屏结束后复位        // 正在躲边（全屏且设置里开着「全屏时躲边」）
  let screenFull = false;        // 前台程序是不是全屏（关了躲边也照样不说话）
  let peekFrom = null;           // 躲边前的位置，全屏结束后回去
  let dock = null;
  let pettedAt = 0;
  let lastRelease = null;       // 最近一次松手的速度与计划（隔离测试读）
  let signals = { quotaLow: null };   // null＝跟随真实额度；调试 setSignal 可强制 true/false
  // 形象图里身体四周的透明边（占身体框的比例，渲染端量出来的）。贴边按看得见的身体算，
  // 不然图里那圈透明边会像「空气墙」一样，离屏幕边还有二三十像素就停住（2026-10-18 用户在公司反馈）。
  // 量过的形象记在 hub-pet.json 的 bodyBoxes 里，启动时直接用，不再「先按整张图摆、量完又挪一下」（2026-10-18 审核）。
  const ZERO_BOX = { left: 0, right: 0, top: 0, bottom: 0 };
  const cachedBox = id => parseBox((settings.get().bodyBoxes || {})[id]);
  let boxRole = currentRole();
  let bodyBox = cachedBox(boxRole) || { ...ZERO_BOX };
  let flushTimer = null;          // 拖大小滑块时，停下 300ms 再写盘
  const overrides = {};          // 隔离测试注入（idleSec / busy / fullscreen / cursor）

  const fsWatch = createFullscreenWatch({ logger, foreground: true, onChange: (value) => { if (overrides.fullscreen == null) setScreenFull(value); } });

  const enabled = () => available && !disposed && settings.get().enabled;
  const alive = () => !!(win && !win.isDestroyed());
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload); };
  let ignoring = null, hoverTimer = null, lastProbe = ''; // 点穿状态，见 setIgnore / hoverTick

  const scaleNow = () => parseScale(settings.get().scale) ?? 1;
  // 某个大小、某组透明边下的几何：身体边长、窗口高、身体相对窗口的边距。改大小或量出透明边时，新旧两套都要算。
  function geom(scale = scaleNow(), box = bodyBox) {
    const b = Math.round(BODY * scale), side = (WIN_W - b) / 2;
    const h = Math.max(WIN_H, HEAD_ROOM + b);
    return { body: b, h, size: { width: WIN_W, height: h },
      inset: { left: side + Math.round(box.left * b), right: side + Math.round(box.right * b), top: 0, bottom: INSET.bottom } };
  }
  const bodyPx = () => geom().body;
  const winH = () => geom().h;
  const winSize = () => geom().size;
  const inset = () => geom().inset;
  function displayFor(point) {
    try { return screen.getDisplayNearestPoint(point); } catch (_) { return screen.getPrimaryDisplay(); }
  }
  // 身体中心所在屏幕的工作区。
  function areaFor(pos, g = geom()) {
    return displayFor({ x: Math.round(pos.x + WIN_W / 2), y: Math.round(pos.y + g.h - INSET.bottom - g.body / 2) }).workArea;
  }
  const areaAt = pos => areaFor(pos);
  function rangeFor(pos, g = geom()) { return allowedRange(areaFor(pos, g), g.size, g.inset); }
  const rangeAt = pos => rangeFor(pos);
  // 隔离测试（调试入口 override virtual）：测试窗口被压在屏幕外、挪不动，这时以「自己放的位置」当窗口位置，走动、甩出去的规划照真实屏幕算。
  function winBounds() { const b = win.getBounds(); return overrides.virtual && placed ? { ...b, x: placed.x, y: placed.y } : b; }
  function currentPos() { const b = winBounds(); return { x: b.x, y: b.y }; }
  // 最近一次自己放窗口的位置。混合 DPI 下 getBounds 读回来可能和设的差 1px，连续改大小时按读回值算会一点点漂；
  // 读回值和它相差不超过 2px 就以它为准（2026-10-18 审核）。
  let placed = null;
  function place(pos) {
    if (!alive()) return;
    placed = { x: Math.round(pos.x), y: Math.round(pos.y), height: winH() };
    win.setBounds({ x: placed.x, y: placed.y, width: WIN_W, height: placed.height }, false);
  }
  function placedBounds() {
    const b = winBounds();
    if (placed && Math.abs(b.x - placed.x) <= 2 && Math.abs(b.y - placed.y) <= 2 && Math.abs(b.height - placed.height) <= 2) return { ...placed };
    return { x: b.x, y: b.y, height: b.height };
  }

  // 存的位置不在现在的任何屏幕上（副屏拔了），窗口被拉回最近的屏幕时为 true：这时不拿窗口的位置覆盖存的副屏位置，
  // 只有用户真的拖过才写（2026-10-18 审核）。
  let savedDetached = false;
  function defaultPosition(g = geom()) {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - WIN_W + g.inset.right - MARGIN, y: area.y + area.height - g.h + INSET.bottom - 8 };
  }
  function initialPosition() {
    const saved = settings.get().position;
    if (saved) {
      // 存的位置所在的屏幕已经拔掉时，clamp 会把它拉回最近的屏幕。
      const pos = clampTo(rangeAt(saved), saved.x, saved.y);
      savedDetached = pos.x !== saved.x || pos.y !== saved.y;
      return pos;
    }
    savedDetached = false;
    return defaultPosition();
  }
  // 大小或透明边变了，存的位置怎么换算：脚的位置不动（窗口底边对齐），原来贴边的继续贴边。
  // 窗口开没开都按这个算（桌宠关着时改大小，下次打开不会悬在半空）。存的位置不在现有屏幕上时只按脚换算，不往现有屏幕上拉。
  function convertSaved(saved, g0, g1) {
    const feetShift = { x: saved.x, y: saved.y + g0.h - g1.h };
    const r0 = rangeFor(saved, g0);
    const c = clampTo(r0, saved.x, saved.y);
    if (c.x !== saved.x || c.y !== saved.y) return feetShift;
    const d = dockOf({ position: saved, area: areaFor(saved, g0), size: g0.size, inset: g0.inset });
    const r1 = rangeFor(feetShift, g1);
    return clampTo(r1, d === 'left' ? r1.minX : d === 'right' ? r1.maxX : feetShift.x, feetShift.y);
  }
  // 窗口伸出所在屏幕工作区的宽度（左、右）。告诉渲染端，气泡、提醒面板、小圆点都只放在看得见的那一段里（2026-10-18 审核：
  // 原来写死 65px，小猫 100% 贴右边时会被裁约 30px，60% 时约 48px）。
  // 窗口和工作区完全不相交时（隔离测试把窗口停在屏幕外，或系统暂时没报对位置）按 0 算；每边最多 EDGE_CUT_MAX，
  // 保证气泡和面板总有地方放（正常贴边最多伸出约 113px：60%、贴右边；躲边时本来就不冒气泡）。
  function edgeCut() {
    if (!alive()) return { left: 0, right: 0 };
    // 调试覆盖（r27d）：隔离测试的窗口被压在屏幕外、挪不到真实屏幕边，用它模拟贴边伸出多少。
    if (overrides.edge && typeof overrides.edge === 'object') return { left: Math.max(0, Number(overrides.edge.left) || 0), right: Math.max(0, Number(overrides.edge.right) || 0) };
    const b = placedBounds();
    const area = areaFor(b);
    const h = winH();
    const apart = b.x + WIN_W <= area.x || b.x >= area.x + area.width || b.y + h <= area.y || b.y >= area.y + area.height;
    if (apart) return { left: 0, right: 0 };
    const cut = v => Math.min(EDGE_CUT_MAX, Math.max(0, Math.round(v)));
    return { left: cut(area.x - b.x), right: cut(b.x + WIN_W - (area.x + area.width)) };
  }

  // 隐藏的宿主窗口（2026-10-17，公司 CI 39030602842）：桌宠是置顶窗，Windows 挑「进程主窗口」时（Get-Process 的
  // MainWindowTitle、按标题里 PID/版本认实例）会先挑到它，读成「AI Hub 桌宠」。有宿主的窗口和看不见的窗口都不参与挑选，
  // 所以给桌宠挂一个永不显示的宿主：主窗口照旧被认出来。不挂在 Hub 主窗口下——那样主窗口最小化时桌宠会跟着消失。
  let owner = null;
  function ensureOwner() {
    if (!BaseWindow) return null;
    if (owner && !owner.isDestroyed?.()) return owner;
    try {
      owner = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false, title: 'AI Hub 桌宠宿主' });
      owner.on?.('closed', () => { owner = null; });
    } catch (error) { owner = null; logger.warn?.('[hub-pet] owner window failed:', error && error.message); }
    return owner;
  }
  function ensureWindow() {
    if (alive()) return win;
    // 关着时换过形象：用新形象量过的透明边摆位置。
    if (boxRole !== currentRole()) { boxRole = currentRole(); bodyBox = cachedBox(boxRole) || bodyBox; }
    const parent = ensureOwner();
    win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: WIN_W, height: winH(), show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true /* 右键菜单要能拿到焦点，点别处才会收起 */, alwaysOnTop: true, hasShadow: false, title: 'AI Hub 桌宠',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: true },
    });
    try { win.setAlwaysOnTop(true, 'floating'); } catch (_) {}
    win.setMenuBarVisibility?.(false);
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    ignoring = null; setIgnore(true);
    const pos = initialPosition();
    place(pos);
    dock = dockOf({ position: pos, area: areaAt(pos), size: winSize(), inset: inset() });
    win.on('closed', () => { win = null; lastSent = ''; stopMove(); drag = null; });
    win.webContents.once('did-finish-load', () => {
      if (!alive()) return;
      lastSent = '';
      evaluate();
      if (canShow()) win.showInactive();
    });
    Promise.resolve(win.loadFile(htmlPath)).catch(error => logger.warn?.('[hub-pet] load failed:', error && error.message));
    return win;
  }

  // ---------- 姿态与说话 ----------
  // 隔离测试可以把「现在几点」挪到白天（nowShift），避免夜里跑测试时一直在打盹。
  const clock = () => now() + (Number(overrides.nowShift) || 0);

  function idleSeconds() {
    if (Number.isFinite(overrides.idleSec)) return overrides.idleSec;
    try { return powerMonitor.getSystemIdleTime(); } catch (_) { return 0; }
  }
  function assistantBusy() {
    if (typeof overrides.busy === 'boolean') return overrides.busy;
    try { return !!isAssistantBusy(); } catch (_) { return false; }
  }
  function meetingNow() {
    if (typeof overrides.meeting === 'boolean') return overrides.meeting;
    try { return inMeeting() === true; } catch (_) { return false; }
  }
  function gate(spokenAt, item) {
    // Recheck queued/current notices as well as newly arriving ones. Changing
    // the routing setting must also withdraw an already displayed pet bubble.
    if (item?.notify && item.kind !== 'disk' && item.kind !== 'growth' && !petTakes(item)) {
      return { ok: false, reason: 'notification-mode' };
    }
    return speakGate(settings.get(), { now: clock(), pose, fullscreen: fullscreen || screenFull, meeting: meetingNow() }, spokenAt, item);
  }

  function evaluate() {
    if (!alive()) return;
    if (excursion) guardExcursion({ quiet: true });
    // 换了形象：量过的就直接用它的透明边（refit 里会再进 evaluate，boxRole 先改掉，不会绕圈）。
    if (boxRole !== currentRole()) {
      boxRole = currentRole();
      const box = cachedBox(boxRole);
      if (box && JSON.stringify(box) !== JSON.stringify(bodyBox)) { applyBodyBox(box); return; }
    }
    const t = clock();
    const idleSec = idleSeconds();
    const running = sessionsRunning();
    const follow = settings.get().followSessions !== false;
    let quotaLow = signals.quotaLow;
    if (typeof quotaLow !== 'boolean') { try { quotaLow = isQuotaLow?.() === true; } catch (_) { quotaLow = false; } }
    const ctxBase = { now: t, fullscreen, assistantBusy: assistantBusy(), sessionsBusy: follow ? running : 0, idleSec, quotaLow, pettedAt };
    // 先按「没在说话」定姿态（决定能不能开口：打盹时不说），再推进气泡队列，最后按是否在说话定最终姿态。
    pose = decidePose({ ...ctxBase, speaking: false });
    // 闲聊（2026-11-17 r27g）：按情境挑句子，说过的记进 hub-pet.json，短期内不重复；名字和回应偏好也从那里来。
    const s0 = settings.get();
    const chatter = chatterFor(s0.mode, { now: t, idleSec, meeting: meetingNow(), doneAt: chatterTrack.doneAt }, chatterTrack, { name: s0.petName, prefs: s0.talkPrefs, recent: s0.talkRecent });
    if (chatter && speech.push(chatter)) settings.update({ talkRecent: noteSpoken(s0.talkRecent, chatter.talk.line) });
    if (typeof askAssistant === 'function') { let pages = {}; try { pages = getPages?.() || {}; } catch (_) {} if (pages.assistant) { const nudge = weeklyNudge(settings.get().mode, { now: t, idleSec }, chatterTrack); if (nudge) { remember(nudge); speech.push(nudge); } } }
    speech.tick(gate);
    const snap = speech.snapshot();
    pose = decidePose({ ...ctxBase, speaking: !!snap.bubble, speakingTone: snap.bubble && snap.bubble.tone, speakingKind: snap.bubble && snap.bubble.kind });
    const s = settings.get();
    const role = currentRole();
    const state = {
      growth: growthView(),
      pose, role, roleVersion: (typeof roles.version === 'function' && roles.version(role)) || null, assetBase: roles.assetBase(role), mode: s.mode, dock: fullscreen ? 'right' : excursion ? null : dock, peeking: fullscreen, scale: scaleNow(),
      // r27f：悬停快捷钮里「问」能不能就地提问（没接助理时改为打开助理页）；单击是逗它还是打开；正在走动。
      quickAsk: canAsk(), clickMode: s.clickMode === 'open' ? 'open' : 'play', walking: !!excursion,
      // 安静档、临时安静、今天静音：悬停不冒快捷钮（r27f 审查第 5 项；开会看 meeting）。
      hush: s.mode === 'quiet' || s.quietUntil > t || s.silentDate === localDateKey(t),
      bubble: snap.bubble ? bubbleView(snap.bubble) : null,
      running: follow ? running : 0,
      // r27c：会话状态灯（在跑 / 答完 / 出错，点灯直达会话）、小圆点分色计数、开会与额度低时身上的道具。
      lamps: follow ? sessionLamps(snap.finished) : [], dotTones: snap.dotTones, meeting: meetingNow(), quotaLow,
      dots: snap.dots, quiet: !gate([]).ok, sequences: (roles.meta(role) && roles.meta(role).sequences) || [], clipped: (roles.meta(role) && roles.meta(role).clipped) || {},
      night: pose === 'sleep', edge: edgeCut(),
      // 软件渲染（启动时关了硬件加速）：渲染端据此降帧、停无限循环动画（2026-11-23 开销优化）。
      softGpu: softGpu() === true,
      // 低开销模式：空闲不排帧、停装饰循环动画；只有开着时才带这个字段，关闭时状态和原来逐字节一致。
      ...(lowOverhead() === true ? { lowPower: true } : {}),
    };
    const key = JSON.stringify(state);
    if (key !== lastSent) { lastSent = key; send('hub-pet:state', state); }
    scheduleDeadline();
  }

  // 等级装饰与进化共用等级规则；设置里可以整体关掉。
  function growthView() {
    if (settings.get().showGrowth === false) return null;
    let p = null;
    try { p = getProfile?.() || null; } catch (_) {}
    if (!p || !Number.isFinite(p.level)) return null;
    const { evolutionOf, perksOf } = require('../core/profile/rules');
    return { level: p.level, rank: p.rank || 1, perks: perksOf(p.level), evolution: evolutionOf(p.level) };
  }
  // 「个人」页的等级变了：马上换装饰，不等下一次轮询。
  function setProfile() { if (alive()) evaluate(); }
  // 升级、解锁成就：连跳撒花 + 举一张卡片，点卡片打开「个人」页。只有桌宠会庆祝，不受回执三档影响。
  function celebrate({ id, title, text, big = false, art = '', evolution, fromEvolution } = {}) {
    if (!canNotify()) return false;
    pettedAt = clock();
    const evolve = evolution && settings.get().showGrowth !== false;
    send('hub-pet:motion', evolve ? { phase: 'evolve', evolution, fromEvolution } : { phase: 'celebrate', big: big === true });
    onNotice({ id: 'growth:' + String(id || now()), kind: 'growth', notify: true, page: 'profile', cta: '看看我的成就', title: String(title || '').slice(0, 60), text: String(text || '').slice(0, 200), ...(/^(?:(?:rank|badge)-\d{1,2}|evolve-[2-6])$/.test(art) ? { art } : {}) });
    return true;
  }
  // 被摸了（鼠标在身上来回蹭）：醒一分钟、冒爱心，记一次亲密度。3 秒内只算一次。
  let lastPetAt = 0;
  function petted(motion = 'petted') {
    const t = now();
    if (t - lastPetAt < 3000) return false;
    lastPetAt = t; pettedAt = clock();
    if (motion) send('hub-pet:motion', { phase: motion });
    try { onPetted?.(); } catch (_) {}
    evaluate();
    return true;
  }
  // 第一次出来：说一句自我介绍，告诉用户能做什么（只说一次）。
  let introTimer = null;
  function introduce() {
    if (settings.get().introduced) return;
    settings.update({ introduced: true });
    speech.push({ id: 'intro', kind: 'chatter', sticky: true, title: '你好，我是桌宠。答完来报信，蹭蹭是摸摸；右键问助理、换形象。' });
  }

  function scheduleDeadline() {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    const due = speech.nextDeadline();
    if (due == null) return;
    deadlineTimer = setTimeout(() => { deadlineTimer = null; evaluate(); }, Math.max(50, due - now() + 20));
  }

  // 发给渲染端的气泡：去掉会变的到点时刻（停留暂停时会改，不然每次都算「有变化」），倒计时由渲染端按 ms 自己走。
  // 起了名字：闲聊气泡左上角标出名字（句子里已经带名字的不重复标）。
  function bubbleView(b) {
    const { until: _u, named: _n, ...rest } = b;
    const name = settings.get().petName;
    return b.kind === 'chatter' && !b.notify && name && !b.named ? { ...rest, name } : rest;
  }
  // 气泡下的回应按钮（2026-11-17 r27g）：记进回应偏好（hub-pet.json），之后少说不喜欢的那类；
  // 「再等 20 分钟」只推迟久坐提醒。回应后它回一句（2.6 秒，不计入每小时开口次数）。
  let ackSeq = 0;
  function reply(id, choice) {
    const cur = speech.current;
    if (!cur || cur.id !== String(id || '') || !Array.isArray(cur.chips) || !cur.chips.some(c => c.id === choice)) return false;
    speech.takeCurrent();
    const s = settings.get();
    const { prefs, ack } = applyReply(s.talkPrefs, { type: cur.talk && cur.talk.type, ctx: cur.talk && cur.talk.ctx, choice, name: s.petName });
    settings.update({ talkPrefs: prefs });
    if (choice === 'snooze') chatterTrack.sitSnoozeUntil = clock() + 20 * 60000;
    pettedAt = clock();
    if (choice === 'up') send('hub-pet:motion', { phase: 'petted' });
    if (ack) speech.push({ id: 'ack-' + now() + '-' + (++ackSeq), kind: 'chatter', title: ack, ack: true, ms: 2600 });
    evaluate();
    return true;
  }

  function onNotice(notice) {
    if (!notice || !notice.id) return;
    // 回执不交给桌宠（选了右下角小卡或关闭）：总线上的通知卡片也不由桌宠说；硬盘快满只有桌宠会说，照说（2026-11-11）。
    if (notice.notify && notice.kind !== 'disk' && notice.kind !== 'growth' && !petTakes(notice)) return;
    // 有去处的通知（会话、页面）记下来：点卡片或面板里的「打开」时按它跳。
    if (notice.sessionId || notice.page || notice.noticeId || notice.action) remember(notice);
    if (speech.push(notice)) {
      // 答完的会话记个时刻：30 分钟内答完 3 个，活泼档会说一句「连着答完好几个」（2026-11-17 r27g）。
      if (notice.notify && notice.kind === 'session' && notice.tone !== 'bad' && notice.err !== true) chatterTrack.doneAt = [...(chatterTrack.doneAt || []), clock()].slice(-10);
      // 被通知叫醒：夜里打盹时也醒过来说完（和被点一下一样醒一分钟）。
      if (notice.notify) pettedAt = clock();
      evaluate();
    }
  }

  // ---------- 通知交给桌宠（2026-11-09） ----------
  // 原来弹在右下角的通知卡（会话答完、联动消息、网页会话、到点提醒），开着桌宠时改由桌宠举着卡片说：
  // 点卡片直接打开会话；不点 9 秒后收进小圆点，点小圆点能翻到。桌宠没开、被收起或设置里关了「通知交给桌宠」时返回 false，
  // 调用方照旧弹原通知卡。
  const opened = new Map();       // 通知 id → 去处（sessionId / page / noticeId）
  function remember(item) {
    opened.set(String(item.id), { sessionId: item.sessionId || null, page: item.page || null, noticeId: item.noticeId || null, kind: item.kind || '', action: item.action || null, notify: item.notify === true });
    while (opened.size > 300) opened.delete(opened.keys().next().value);
  }
  const NOTIFY_KIND = { reminder: 'hub-reminder', bridge: 'bridge' };
  const diskWatch = typeof diskRoots === 'function' ? createDiskWatch({ roots: diskRoots, statfs: diskStatfs, now,
    active: () => canNotify(), notify: item => { if (!canNotify()) return false; onNotice({ ...item, notify: true }); return true; } }) : null;
  let diskFirst = null;   // 不用 reminder：那是桌宠提醒（要点了才算确认）的类别
  function canNotify() {
    return enabled() && started && alive() && win.isVisible?.() !== false;
  }
  // 回执三档（2026-11-11）：pet 交给桌宠；off 只把要紧的交给桌宠；popup 一律不交。
  function petTakes(item) {
    const mode = settings.get().notifyMode;
    return mode === 'pet' || (mode === 'off' && isUrgentNotice(item));
  }
  // 右下角通知卡的分流：true＝已有着落（桌宠说了，或关了回执、这条不要紧），false＝照旧弹右下角小卡。
  function routeDesktopNotice(payload = {}) {
    const mode = settings.get().notifyMode;
    if (mode === 'popup') return false;
    if (mode === 'off' && !isUrgentNotice(payload)) return true;
    return notify(payload);
  }
  function notify(payload = {}) {
    if (!canNotify() || !petTakes(payload)) return false;
    const sessionId = String(payload.sessionId || '').slice(0, 160);
    // 公司助理的提醒本来就经提醒总线交给了桌宠（onNotice），这里只拦掉重复的那张通知卡。
    if (payload.kind === 'assistant' && sessionId === 'company-assistant') return true;
    const kind = NOTIFY_KIND[payload.kind] || (sessionId.startsWith('web:') ? 'web' : 'session');
    const at = Number(payload.completedAt) || now();
    onNotice({
      id: `notify:${sessionId}:${at}`, kind, notify: true, title: String(payload.title || 'AI 会话'), text: String(payload.body || ''),
      sessionId: sessionId || null, count: Number(payload.readyCount) || 0, tone: payload.tone === 'bad' ? 'bad' : '', ...(payload.err === true ? { err: true } : {}),
      cta: kind === 'hub-reminder' ? '打开助理' : kind === 'bridge' ? '打开联动' : '打开会话',
    });
    return true;
  }
  function sessionsRunning() {
    if (Number.isFinite(overrides.running)) return overrides.running;
    try { const a = getSessionActivity?.(); return Math.max(0, Math.round(Number(a && a.running) || 0)); } catch (_) { return 0; }
  }
  // 会话状态灯（2026-11-17 r27c）：正在跑的会话一盏转圈灯；答完、出错但还没看的会话各一盏绿灯、橙灯。
  // 在跑的排前面；同一会话又跑起来了就只亮转圈灯。最多给渲染端 30 盏，超过 6 盏由渲染端合并成数字。
  // r27d：活动里带 known（侧栏还活着的全部会话）时，按它校正：已关闭/休眠的不亮，标题取当前名字，
  // 通知早于该会话最近一轮开始的（上一轮的结果）不再亮。调试覆盖 sessions 时可一并给 known。
  function sessionLamps(finished = []) {
    let list = [], known = null;
    if (Array.isArray(overrides.sessions)) { list = overrides.sessions; if (Array.isArray(overrides.known)) known = overrides.known; }
    else {
      try {
        const a = getSessionActivity?.();
        list = Array.isArray(a && a.sessions) ? a.sessions : [];
        if (Array.isArray(a && a.known)) known = a.known;
      } catch (_) {}
    }
    const live = known ? new Map(known.filter(k => k && k.id).map(k => [String(k.id), k])) : null;
    const out = [], seen = new Set();
    const add = (id, title, st) => { id = String(id || '').slice(0, 160); if (!id || seen.has(id)) return; seen.add(id); out.push({ id, title: String(title || '').slice(0, 40), st }); };
    for (const s of list) add(s && s.id, live?.get(String(s && s.id))?.title || (s && s.title), 'run');
    for (const f of finished || []) {
      if (live) {
        const k = live.get(String(f.id));
        if (!k || (Number(k.startedAt) || 0) > (Number(f.at) || 0)) continue;
        add(f.id, k.title || f.title, f.st === 'err' ? 'err' : 'done');
      } else add(f.id, f.title, f.st === 'err' ? 'err' : 'done');
    }
    return out.slice(0, 30);
  }
  function openSession(sessionId) {
    const sid = String(sessionId || '').slice(0, 160);
    if (!sid) return false;
    try { focusPrimaryWindow?.(); } catch (_) {}
    try { sendToRenderer?.('desktop-notification:open-session', { sessionId: sid }); } catch (_) {}
    speech.seenSession(sid);
    evaluate();
    return true;
  }
  // 值得提醒的新版本：每个版本说一次，点开「检查更新」窗口。
  function announceUpdate(version) {
    const v = String(version || '').replace(/[^0-9A-Za-z.-]/g, '').slice(0, 24);
    if (!v || !canNotify()) return false;
    onNotice({ id: 'update:' + v, kind: 'update', notify: true, page: 'update', cta: '去更新', title: 'AI HUB 有新版本 ' + v, text: '点开看这版改了什么，一键升级，会话和设置都保留。' });
    return true;
  }
  // 用户已经在 Hub 里点开了这个会话：小圆点里它的「已完成」就不用再留着。
  function sessionSeen(sessionId) { if (alive() && speech.seenSession(sessionId)) evaluate(); }
  function syncReminders() {
    let items = [];
    try { items = noticeBus?.reminders?.() || []; }
    catch { if (!reminderSyncWarned) { reminderSyncWarned = true; logger.warn?.('[hub-pet] 提醒存储不可用，暂不恢复提醒'); } }
    speech.syncReminders(items); evaluate();
  }
  function confirmReminders(items) {
    const ids = items.filter(item => item.kind === 'reminder').map(item => item.id);
    if (!ids.length) return true;
    try { noticeBus?.acknowledgeReminders?.(ids); return true; }
    catch (error) { syncReminders(); logger.warn?.('[hub-pet] reminder confirmation failed:', error.message); return false; }
  }

  // ---------- 全屏躲边 ----------
  function setScreenFull(value) {
    screenFull = !!value;
    if (!screenFull) peekPulledOut = false; // 全屏结束：下次再全屏照常躲边
    setFullscreen(screenFull && settings.get().peekOnFullscreen !== false && !peekPulledOut);
    evaluate();
  }
  function peekTarget(from, g = geom()) {
    const area = areaFor(from, g);
    const visible = g.body * (1 - bodyBox.left - bodyBox.right);
    return { x: area.x + area.width - g.inset.left - Math.round(visible * PEEK_VISIBLE), y: area.y + area.height - g.h + INSET.bottom };
  }
  function setFullscreen(value) {
    if (value === fullscreen) return;
    fullscreen = value;
    if (alive() && !drag) {
      if (fullscreen) {
        // 正在任务栏上走动：躲边结束后回到它原来的家，不回到走到一半的地方。
        const home = excursion ? excursion.home : null;
        abortExcursion();
        peekFrom = home || currentPos();
        const pos = currentPos();
        const to = peekTarget(pos);
        animateTo([{ from: pos, to, durationMs: 420 }], () => send('hub-pet:motion', { phase: 'land', impact: 0.2 }));
      } else if (peekFrom) {
        const back = peekFrom;
        peekFrom = null;
        animateTo([{ from: currentPos(), to: back, durationMs: 420 }], () => { send('hub-pet:motion', { phase: 'land', impact: 0.4 }); evaluate(); });
      }
    }
    evaluate();
  }

  // ---------- 移动动画（滑行、贴边、躲边） ----------
  function stopMove() { if (moveTimer) clearInterval(moveTimer); moveTimer = null; }
  function animateTo(steps, done) {
    stopMove();
    const queue = steps.filter(s => s.durationMs > 0);
    if (!queue.length || !alive()) { done?.(); return; }
    let step = queue.shift();
    let startAt = Date.now();
    moveTimer = setInterval(() => {
      if (!alive()) { stopMove(); return; }
      // 走动的每一步先核一遍：前台窗口、工作区、安静/开会/减少动态/锁屏变了就当场停下回原处（r27f 审查第 1、2 项）。
      if (step.kind === 'walk' && guardExcursion()) return;
      const elapsed = Date.now() - startAt;
      const p = Math.min(1, elapsed / step.durationMs);
      // fly：甩出去的抛物线（core/hub-pet/motion.js 的 flyAt）；walk：匀速踱步；其余 cubic-out 缓动。
      if (step.kind === 'fly') place(flyAt(step, elapsed));
      else {
        const k = step.kind === 'walk' ? p : cubicOut(p);
        place({ x: step.from.x + (step.to.x - step.from.x) * k, y: step.from.y + (step.to.y - step.from.y) * k });
      }
      if (p < 1) return;
      if (queue.length) { step = queue.shift(); startAt = Date.now(); return; }
      stopMove();
      done?.();
    }, DRAG_TICK_MS);
  }

  // ---------- 拖动 ----------
  // ---------- 点穿与接住（不挂全局鼠标钩子） ----------
  function setIgnore(v) {
    if (!alive() || ignoring === v) return;
    ignoring = v;
    win.setIgnoreMouseEvents(v);
  }
  // 鼠标靠近（r27f）：光标离身体中心不到「身体半宽 + NEAR_PAD」就告诉渲染端在哪一侧，它侧身看过去、轻跳一下。
  // 只在进出、换边时发一次；躲边、拖动时不算。动作开不开由渲染端按安静档、开会、减少动态效果定。
  let nearKey = '';
  function nearTick(c, b) {
    const g = geom();
    const cx = b.x + WIN_W / 2 + (bodyBox.left - bodyBox.right) * g.body / 2;
    const cy = b.y + b.height - INSET.bottom - g.body / 2;
    const dx = c.x - cx, dy = c.y - cy, r = g.body / 2 + NEAR_PAD;
    const near = !fullscreen && !drag && dx * dx + dy * dy < r * r;
    const key = near ? (dx >= 0 ? 'right' : 'left') : '';
    if (key === nearKey) return;
    nearKey = key;
    send('hub-pet:near', { near, side: dx >= 0 ? 1 : -1 });
  }
  function hoverTick() {
    if (!alive() || drag || !win.isVisible?.()) return;
    const c = cursor(), b = winBounds();
    nearTick(c, b);
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (!inside) { lastProbe = ''; if (ignoring === false) setIgnore(true); return; }
    if (ignoring === false) return; // 已接住：离开身体由渲染端的 mousemove / mouseleave 报
    const key = `${Math.round(c.x)},${Math.round(c.y)},${b.x},${b.y}`;
    if (key === lastProbe) return;
    lastProbe = key;
    send('hub-pet:probe', { x: c.x - b.x, y: c.y - b.y });
  }
  function startHover() { if (!hoverTimer) { hoverTimer = setInterval(hoverTick, HOVER_TICK_MS); hoverTimer.unref?.(); } }
  function stopHover() { if (hoverTimer) clearInterval(hoverTimer); hoverTimer = null; lastProbe = ''; }
  function cursor() {
    if (overrides.cursor) return overrides.cursor; // 隔离测试不动真鼠标，用注入的位置模拟拖动
    try { return screen.getCursorScreenPoint(); } catch (_) { return { x: 0, y: 0 }; }
  }
  function onPress(target) {
    if (!alive()) return;
    stopMove();
    // 走动途中被按住：先停下。拖走了就以落点为新家；只是点一下或抱一下，过一会儿自己走回家。
    const away = excursion ? excursion.home : null;
    abortExcursion();
    const c = cursor();
    const pos = currentPos();
    drag = { target: target || 'pet', start: c, offset: { x: c.x - pos.x, y: c.y - pos.y }, moved: false, samples: [{ t: Date.now(), x: pos.x, y: pos.y }], startedAt: Date.now(), last: pos, away, hug: false };
    if (nearKey) { nearKey = ''; send('hub-pet:near', { near: false, side: 1 }); }
    setIgnore(false);
    moveTimer = setInterval(dragTick, DRAG_TICK_MS);
  }
  function dragTick() {
    if (!drag || !alive()) { stopMove(); return; }
    if (!drag.releasing && Date.now() - drag.startedAt > 120000) { onRelease(); return; }
    const c = cursor();
    if (fullscreen) {
      // 躲边（只露个头）时：没拖开只算点击；真拖开了就从边上拽出来，这次全屏期间不再躲（2026-11-22 同事反馈「桌宠拖不动」，
      // 隔离 Hub 复现：以前躲边时按住拖，位移 0px。系统「有程序全屏」的判断也会把放映、共享、别的屏上的全屏都算进来）。
      if (Math.hypot(c.x - drag.start.x, c.y - drag.start.y) < CLICK_SLOP) return;
      peekPulledOut = true;
      fullscreen = false;
      peekFrom = null;
      evaluate();
    }
    if (!drag.moved && Math.hypot(c.x - drag.start.x, c.y - drag.start.y) < CLICK_SLOP) {
      // 按住不放（单击只逗它的新习惯下）：抱抱。慢慢压扁、冒爱心，记一次亲密度（和摸摸共用 3 秒一次的限制）。
      if (!drag.hug && drag.target === 'pet' && clickPlays() && Date.now() - drag.startedAt >= HUG_MS) {
        drag.hug = true;
        send('hub-pet:motion', { phase: 'hug', on: true });
        petted(null);
      }
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      if (drag.hug) { drag.hug = false; send('hub-pet:motion', { phase: 'hug', on: false }); }
      send('hub-pet:motion', { phase: 'lift' });
    }
    // 限位取「鼠标所在屏」和「宠物现在所在屏」的并集：以前只按现在所在的屏，宠物出不了这块屏（双屏拖不过去）；
    // 只按要去的位置所在屏时，身体中心一过两屏中线范围就整个换掉，会闪跳一下（2026-10-18 审核）。松手后再按落点所在屏贴好。
    const want = { x: c.x - drag.offset.x, y: c.y - drag.offset.y };
    const g = geom();
    const a = allowedRange(displayFor({ x: Math.round(c.x), y: Math.round(c.y) }).workArea, g.size, g.inset);
    const b = rangeFor(drag.last, g);
    const range = { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
    const pos = clampTo({ ...range, minY: range.minY - 40 }, want.x, want.y);
    const t = Date.now();
    const prev = drag.samples[drag.samples.length - 1];
    if (pos.x === prev.x && pos.y === prev.y && t - prev.t < 100) return;
    drag.samples.push({ t, x: pos.x, y: pos.y });
    if (drag.samples.length > 30) drag.samples.shift();
    const dt = Math.max(1, t - prev.t) / 1000;
    place(pos);
    drag.last = pos;
    send('hub-pet:motion', { phase: 'drag', vx: (pos.x - prev.x) / dt, vy: (pos.y - prev.y) / dt });
  }
  function onRelease() {
    if (!drag) return;
    drag.releasing = true;
    if (drag.moved) dragTick(); // 先跟上松手那一刻的鼠标位置，再按最后 180ms 的速度规划滑行
    if (!drag) return;
    const d = drag;
    drag = null;
    stopMove();
    if (!d.moved) {
      if (d.hug) { send('hub-pet:motion', { phase: 'hug', on: false }); evaluate(); }
      else handleClick(d.target);
      if (d.away) scheduleReturn(d.away);
      return;
    }
    pettedAt = clock();
    const position = currentPos();
    // 甩出去（够快）：沿抛物线落到任务栏上；慢慢放下：照旧原地停住（只滑一小段、离边近就贴边）。
    const args = { samples: d.samples, position, area: areaAt(position), size: winSize(), inset: inset() };
    const plan = flingPlan(args) || releasePlan(args);
    send('hub-pet:motion', { phase: 'release', speed: plan.speed, vx: plan.vx, vy: plan.vy });
    if (plan.fling) send('hub-pet:motion', { phase: 'fly', durationMs: plan.steps[0].durationMs, vx: plan.vx });
    lastRelease = { speed: Math.round(plan.speed), samples: d.samples.length, steps: plan.steps.map(st => st.kind), dock: plan.dock, fling: !!plan.fling, final: plan.final };
    animateTo(plan.steps, () => {
      dock = plan.dock;
      settings.update({ position: plan.final });
      savedDetached = false;
      send('hub-pet:motion', { phase: 'land', impact: plan.fling ? plan.impact : Math.min(1, 0.35 + plan.speed / 2400) });
      lastSent = '';
      evaluate();
    });
  }

  // ---------- 点击与菜单 ----------
  function openAssistant(payload = {}) {
    try { focusPrimaryWindow?.(); } catch (_) {}
    try { sendToRenderer?.('hub-pet:open-assistant', { source: 'pet', ...payload }); } catch (_) {}
  }
  // 打开一条通知的去处：页面 → 打开那一页；会话 → 切到那个会话；其余（助理提醒）→ 助理页并定位到这条。
  function openItem(item = {}) {
    const known = opened.get(String(item.id || '')) || {};
    const sessionId = item.sessionId || known.sessionId;
    const page = item.page || known.page;
    const noticeId = item.noticeId || known.noticeId;
    const kind = item.kind || known.kind;
    if (kind === 'chatter') return;
    const action = ASSISTANT_ACTIONS.find(a => a.action === (item.action || known.action));
    if (action) { openAssistant({ action: action.action, prompt: action.prompt }); return; }
    if (page) {
      try { focusPrimaryWindow?.(); } catch (_) {}
      try { sendToRenderer?.('hub-pet:open-page', { page: String(page).slice(0, 40), ...(noticeId ? { noticeId: String(noticeId).slice(0, 160) } : {}) }); } catch (_) {}
      return;
    }
    // 只有通知卡片（会话完成等）直接跳会话；助理的简报、会前准备等仍打开助理页并定位到那一条。
    if (sessionId && (item.notify || known.notify) && kind !== 'reminder' && sessionId !== 'company-assistant') {
      try { focusPrimaryWindow?.(); } catch (_) {}
      try { sendToRenderer?.('desktop-notification:open-session', { sessionId: String(sessionId).slice(0, 160) }); } catch (_) {}
      speech.seenSession(sessionId);
      return;
    }
    openAssistant({ noticeId: String(noticeId || item.id || '').slice(0, 160), sessionId: sessionId ? String(sessionId).slice(0, 160) : undefined });
  }
  function handleClick(target) {
    pettedAt = clock();
    if (target === 'bubble') {
      const item = speech.takeCurrent();
      // 闲聊（含首次介绍）点完就地收起，不展开没有实际去处的助理入口。
      if (item && item.kind === 'chatter') { evaluate(); return; }
      // 通知卡片：点一下就去（和原来的通知卡一样），不再多展开一层。
      if (item && item.notify && confirmReminders([item])) { send('hub-pet:motion', { phase: 'poke' }); openItem(item); }
      else if (item && confirmReminders([item])) send('hub-pet:panel', { items: [item] });
    } else if (target === 'dot') {
      const items = speech.takeDots();
      if (items.length && confirmReminders(items)) send('hub-pet:panel', { items });
    } else if (!clickPlays()) {
      // 旧习惯（设置里可切回）：单击就打开助理。
      send('hub-pet:motion', { phase: 'poke' });
      openAssistant({});
    } else {
      // 新习惯（2026-11-17 r27f，用户拍板）：单击只是逗它一下，双击才打开助理。第一次单击时说一句新玩法。
      const t = Date.now();
      if (t - lastPetClick < DOUBLE_MS) {
        lastPetClick = 0;
        send('hub-pet:motion', { phase: 'poke' });
        openAssistant({});
      } else {
        lastPetClick = t;
        send('hub-pet:motion', { phase: 'poke', play: true });
        if (!settings.get().clickHinted) {
          settings.update({ clickHinted: true });
          speech.push({ id: 'click-hint', kind: 'chatter', sticky: true, title: '单击是逗我玩，双击打开助理，按住是抱抱。想要单击就打开，可在设置里改回来。' });
        }
      }
    }
    evaluate();
  }
  let lastPetClick = 0;
  const clickPlays = () => settings.get().clickMode !== 'open';
  function canAsk() {
    if (typeof askAssistant !== 'function') return false;
    let pages = {};
    try { pages = getPages?.() || {}; } catch (_) {}
    return pages.assistant !== false;
  }
  // 悬停快捷钮（r27f）：问＝就地问助理（没接助理时打开助理页），信＝翻没看的消息，摸＝摸摸它。
  function quick(type) {
    pettedAt = clock();
    if (type === 'ask') { if (canAsk()) openAsk(); else openAssistant({}); return true; }
    if (type === 'inbox') { handleClick('dot'); return true; }
    if (type === 'pet') { petted(); return true; }
    return false;
  }

  // ---------- 在任务栏上走动（2026-11-17 r27f） ----------
  // 偶尔沿任务栏上沿踱几步，或走到前台窗口边上坐一会儿，然后走回原处（不改存的位置）。
  // 只在桌面空白处走：身体不进前台窗口在底带上占的横向范围，窗口铺满底带（最大化）就不走；拿不到前台窗口位置也不走。
  // 走的时候主进程 16ms 挪一次窗口、渲染端满帧，走完立即停下、降回平时的帧率。
  let walkTimer = null, dwellTimer = null, excursion = null, lastWalk = null, askOpen = false;
  let rendererPrefs = { reducedMotion: false };
  // 锁屏、睡眠（r27f 审查第 2 项）：收到就停下回原处、暂停排期；解锁、醒来后过 1–2 分钟再按当时的前台窗口和工作区重新核。
  let screenLocked = false;
  const onLock = () => { screenLocked = true; if (excursion) guardExcursion(); if (walkTimer) clearTimeout(walkTimer); walkTimer = null; };
  const onUnlock = () => { if (!screenLocked) return; screenLocked = false; scheduleWalk(WALK_RETRY); };
  const POWER_EVENTS = [['lock-screen', onLock], ['suspend', onLock], ['unlock-screen', onUnlock], ['resume', onUnlock]];
  function scheduleWalk(range) {
    if (walkTimer) clearTimeout(walkTimer);
    walkTimer = null;
    if (!started) return;
    walkTimer = setTimeout(() => { walkTimer = null; walkTick(false); }, between(range));
    walkTimer.unref?.();
  }
  // 前台窗口（DIP）：{ kind: 'desk' } 或 { kind: 'win', rect }；拿不到返回 null。物理像素按各屏缩放换算（多屏、混合缩放）。
  function foregroundDip() {
    if ('foreground' in overrides) return overrides.foreground || null;
    const f = fsWatch.foreground();
    if (!f || f.kind === 'unknown') return null;
    if (f.kind === 'desk') return { kind: 'desk' };
    let r = f.rect;
    try { if (typeof screen.screenToDipRect === 'function') r = screen.screenToDipRect(null, r); } catch (_) { return null; }
    if (!r || !(r.width > 0)) return null;
    // 前台就是桌宠自己（刚点过它）：不知道用户真正在用哪个窗口，这次不走。
    if (alive()) { const b = winBounds(); if (Math.abs(r.x - b.x) <= 4 && Math.abs(r.y - b.y) <= 4 && Math.abs(r.width - b.width) <= 4) return null; }
    return { kind: 'win', rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  }
  function walkBlocked() {
    const s = settings.get(), t = clock();
    if (!alive() || !started || !win.isVisible?.()) return 'hidden';
    if (s.walk === false) return 'off';
    if (s.mode === 'quiet' || s.quietUntil > t || s.silentDate === localDateKey(t)) return 'quiet';
    if (meetingNow()) return 'meeting';
    if (fullscreen || screenFull || peekFrom) return 'fullscreen';
    if (rendererPrefs.reducedMotion) return 'reduced-motion';
    if (screenLocked) return 'locked';
    if (drag || moveTimer || excursion) return 'moving';
    if ((menuAlive() && menuWin.isVisible()) || askOpen) return 'menu';
    if (pose !== 'idle') return 'pose';
    if (speech.snapshot().bubble) return 'speaking';
    if (idleSeconds() > 120) return 'away';
    return '';
  }
  // force（隔离测试）：跳过「在说话、人走开、频率」这类软条件，但关掉、安静、开会、全屏、减少动态效果照样不走。
  const HARD_BLOCKS = new Set(['hidden', 'off', 'quiet', 'meeting', 'fullscreen', 'reduced-motion', 'locked', 'moving']);
  // 走动途中（出去、坐着、回来）随时要停下的：这些一出现就立即停、直接回原处，不再慢慢走回去。
  const STOP_NOW = new Set(['hidden', 'off', 'quiet', 'meeting', 'fullscreen', 'reduced-motion', 'locked']);
  const sameArea = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  // 走动还安不安全：返回停下的原因，安全返回 ''。
  // 剩下要走的路（现在的位置、原处、出去时的目标）必须整段落在同一段空白里：前台窗口换了、最大化了、挪到底带上，
  // 或屏幕工作区变了（任务栏挪位、分辨率/缩放改了），都按新的算；拿不到前台窗口（比如前台就是桌宠自己）时沿用上一次的判断。
  function excursionUnsafe() {
    const why = walkBlocked();
    if (STOP_NOW.has(why)) return why;
    const home = excursion.home, pos = currentPos(), g = geom();
    const area = areaAt(home);
    if (excursion.area && !sameArea(area, excursion.area)) return 'work-area';
    const fg = foregroundDip();
    if (!fg || fg.kind !== 'win') return '';
    const range = allowedRange(area, g.size, g.inset);
    const floorBottom = home.y + g.size.height - g.inset.bottom;
    const free = walkIntervals({ range, size: g.size, inset: g.inset, band: { top: floorBottom - g.body, bottom: floorBottom }, foreground: fg.rect });
    const xs = [pos.x, home.x];
    if (excursion.phase === 'out' && excursion.plan) xs.push(excursion.plan.to.x);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return free.some(([a, b]) => lo >= a - 0.5 && hi <= b + 0.5) ? '' : 'foreground';
  }
  // 不安全就中止：停在哪儿都直接放回原处（原处是用户自己放的位置，不会穿过窗口走回去）。quiet：从 evaluate 里调，不再回调 evaluate。
  function guardExcursion({ quiet = false } = {}) {
    if (!excursion || drag || !alive()) return false;
    const why = excursionUnsafe();
    if (!why) return false;
    abortExcursion({ snapHome: true });
    lastWalk = { ...(lastWalk || {}), at: now(), aborted: why };
    if (why === 'locked') { if (walkTimer) clearTimeout(walkTimer); walkTimer = null; }
    else scheduleWalk(WALK_RETRY);
    if (!quiet) evaluate();
    return true;
  }
  function walkTick(force, rnd) {
    if (excursion) return lastWalk;
    const why = walkBlocked();
    if (why && !(force && !HARD_BLOCKS.has(why))) { lastWalk = { at: now(), skipped: why }; scheduleWalk(WALK_RETRY); return lastWalk; }
    const fg = foregroundDip();
    if (!fg) { lastWalk = { at: now(), skipped: 'no-foreground' }; scheduleWalk(WALK_RETRY); return lastWalk; }
    const pos = currentPos(), g = geom();
    const res = walkPlan({ position: pos, area: areaAt(pos), size: g.size, inset: g.inset, body: g.body, foreground: fg.kind === 'win' ? fg.rect : null, ...(rnd ? { rnd } : {}) });
    if (!res.plan) { lastWalk = { at: now(), skipped: res.reason }; scheduleWalk(WALK_RETRY); return lastWalk; }
    lastWalk = { at: now(), plan: { from: res.plan.from, to: res.plan.to, sit: res.plan.sit, durationMs: res.plan.durationMs, dwellMs: res.plan.dwellMs }, foreground: fg };
    excursion = { home: res.plan.from, plan: res.plan, phase: 'out', area: areaAt(pos) };
    startGuard();
    walkLeg(res.plan.from, res.plan.to, res.plan.durationMs, () => {
      if (!excursion) return;
      excursion.phase = 'dwell';
      if (res.plan.sit) send('hub-pet:motion', { phase: 'sit', on: true });
      dwellTimer = setTimeout(() => { dwellTimer = null; walkHome(); }, res.plan.dwellMs);
      dwellTimer.unref?.();
    });
    return lastWalk;
  }
  function walkLeg(from, to, durationMs, done) {
    send('hub-pet:motion', { phase: 'walk', on: true, dir: to.x >= from.x ? 1 : -1, durationMs });
    lastSent = ''; evaluate();
    animateTo([{ kind: 'walk', from, to, durationMs }], () => { send('hub-pet:motion', { phase: 'walk', on: false }); done(); });
  }
  function walkHome() {
    if (!excursion || !alive()) return;
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    send('hub-pet:motion', { phase: 'sit', on: false });
    excursion.phase = 'back';
    const from = currentPos(), to = excursion.home;
    const dist = Math.abs(to.x - from.x);
    if (dist < 2 && Math.abs(to.y - from.y) < 2) { endExcursion(); return; }
    walkLeg(from, { x: to.x, y: to.y }, Math.round(Math.min(6000, Math.max(700, dist / 70 * 1000))), endExcursion);
  }
  // 坐着、停着的时候没有逐帧挪动，靠这个 120ms 的小定时器盯着（走动时每帧本来就核）。
  let guardTimer = null;
  function startGuard() {
    if (guardTimer) return;
    guardTimer = setInterval(() => { if (!excursion) stopGuard(); else if (excursion.phase === 'dwell') guardExcursion(); }, 120);
    guardTimer.unref?.();
  }
  function stopGuard() { if (guardTimer) clearInterval(guardTimer); guardTimer = null; }
  function endExcursion() {
    stopGuard();
    excursion = null;
    lastSent = ''; evaluate();
    scheduleWalk(WALK_EVERY);
  }
  // 中途打断（被按住、躲边、改大小、关掉）：snapHome 时直接回原处。
  function abortExcursion({ snapHome = false } = {}) {
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    stopGuard();
    if (!excursion) return;
    const home = excursion.home;
    excursion = null;
    if (moveTimer && !drag) stopMove();
    send('hub-pet:motion', { phase: 'walk', on: false });
    send('hub-pet:motion', { phase: 'sit', on: false });
    if (snapHome && alive()) place(home);
    lastSent = '';
  }
  // 点了一下或抱了一下（没拖走）：1.5 秒后自己走回家。
  function scheduleReturn(home) {
    if (dwellTimer) clearTimeout(dwellTimer);
    excursion = { home, plan: null, phase: 'dwell', area: areaAt(home) };
    startGuard();
    dwellTimer = setTimeout(() => { dwellTimer = null; walkHome(); }, 1500);
    dwellTimer.unref?.();
  }

  // ---------- 右键菜单（2026-10-17：自绘浮层，替换系统原生菜单） ----------
  // 一个透明小窗，第一次右键时建好，之后只是显示/隐藏（打开快）。同样挂在隐藏宿主下，不抢 Hub 主窗口的标题。
  // 点菜单外面（失焦）、按 Esc、或点了会离开的项目就收起；切换开关、换频率、换形象后菜单留着，结果当场可见。
  const MENU_W = 260;
  const menuHtml = path.join(path.dirname(htmlPath || ''), 'pet-menu.html');
  const menuPreload = path.join(path.dirname(preloadPath || ''), 'pet-menu-preload.js');
  let menuWin = null;
  let menuReady = false;
  let menuAnchor = null;
  let menuSize = { width: MENU_W, height: 420 };
  const menuAlive = () => !!(menuWin && !menuWin.isDestroyed());
  const POSE_TEXT = { idle: '在旁边陪着你', typing: '助理正在干活', happy: '有话要跟你说', sleep: '在打盹', peek: '躲在屏幕边上', tired: '有点累了' };
  const pad2 = n => String(n).padStart(2, '0');

  function menuState() {
    const s = settings.get(), t = clock();
    const role = currentRole();
    const list = roleList();
    const me = list.find(r => r.id === role) || { id: role, name: (ROLES.find(r => r.id === role) || {}).name || '桌宠' };
    const dots = speech.snapshot().dots;
    const quietHour = s.quietUntil > t;
    const running = sessionsRunning();
    const status = [running ? `${running} 个会话在跑` : (POSE_TEXT[pose] || ''), dots ? `${dots} 条没看` : '', s.mode === 'quiet' ? '只亮小圆点' : meetingNow() ? '开会中，只亮小圆点' : ''].filter(Boolean).join(' · ');
    // 快捷入口（2026-11-09）：问助理、翻没看的通知、会议室。
    let pages = {};
    try { pages = getPages?.() || {}; } catch (_) {}
    const quick = [];
    if (typeof askAssistant === 'function' && pages.assistant !== false) quick.push({ type: 'ask', label: '问助理一句…', icon: 'ask' });
    if (dots) quick.push({ type: 'inbox', label: `看 ${dots} 条没看的`, icon: 'inbox' });
    // 2026-11-12：摸摸（和鼠标在身上蹭一样），带上现在的等级。
    const growth = growthView();
    quick.push({ type: 'pet', label: '摸摸它', hint: growth ? 'Lv.' + growth.level + ' · ' + growth.evolution.name : '', icon: 'heart' });
    if (pages.rooms) quick.push({ type: 'page', page: 'rooms', label: String(pages.rooms.label || '会议室'), hint: String(pages.rooms.hint || ''), icon: 'room' });
    return {
      role: { id: me.id, name: me.name, preview: me.preview || '' }, status, mode: s.mode, quick,
      modes: MODES.map(id => ({ id, label: MODE_LABELS[id], hint: MODE_HINTS[id] })),
      quietHour, quietUntilText: quietHour ? `${pad2(new Date(s.quietUntil).getHours())}:${pad2(new Date(s.quietUntil).getMinutes())}` : '',
      silentToday: s.silentDate === localDateKey(t),
      actions: ASSISTANT_ACTIONS.map(a => ({ action: a.action, label: a.label })),
      roles: list.filter(r => r.installed).map(r => ({ id: r.id, name: r.name, preview: r.preview || '' })),
      moreRoles: list.some(r => !r.installed),
    };
  }
  function sendMenuState() { if (menuAlive() && menuReady) menuWin.webContents.send('hub-pet-menu:state', menuState()); }

  function ensureMenu() {
    if (menuAlive()) return menuWin;
    const parent = ensureOwner();
    menuReady = false;
    menuWin = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: MENU_W, height: menuSize.height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true, alwaysOnTop: true, hasShadow: false, title: 'AI Hub 桌宠菜单',
      webPreferences: { preload: menuPreload, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    try { menuWin.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
    menuWin.setMenuBarVisibility?.(false);
    menuWin.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    menuWin.webContents.on('will-navigate', event => event.preventDefault());
    menuWin.on('blur', () => hideMenu());
    menuWin.on('closed', () => { menuWin = null; menuReady = false; });
    Promise.resolve(menuWin.loadFile(menuHtml)).catch(error => logger.warn?.('[hub-pet] menu load failed:', error && error.message));
    return menuWin;
  }
  function menuBounds() {
    const c = menuAnchor || cursor();
    const area = displayFor(c).workArea;
    const w = MENU_W, h = Math.max(120, Math.min(area.height, menuSize.height));
    const right = c.x + w > area.x + area.width;
    const up = c.y + h > area.y + area.height;
    // 卡片在窗口里左留 14px、上留 10px：让卡片的角正好落在鼠标处。
    const x = right ? c.x - w + 14 : c.x - 14;
    const y = up ? c.y - h + 18 : c.y - 10;
    return { bounds: { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, x))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, y))), width: w, height: Math.round(h) }, origin: { right, up } };
  }
  function popupMenu() {
    if (!alive()) return;
    menuAnchor = cursor();
    ensureMenu();
    const open = () => {
      if (!menuAlive()) return;
      sendMenuState();
      const { bounds, origin } = menuBounds();
      menuWin.setBounds(bounds, false);
      menuWin.show();
      menuWin.focus();
      menuWin.webContents.send('hub-pet-menu:open', origin);
    };
    if (menuReady) open(); else menuWin.webContents.once('did-finish-load', () => { menuReady = true; open(); });
  }
  function hideMenu() { if (menuAlive() && menuWin.isVisible()) menuWin.hide(); }
  // 打开桌宠头顶的输入框：窗口要拿到焦点才能打字（平时 showInactive，不抢焦点）。
  function openAsk() {
    if (!alive()) return;
    askOpen = true;
    setIgnore(false);
    try { win.focus(); } catch (_) {}
    send('hub-pet:ask-open', {});
  }
  function menuAct(a = {}) {
    const t = clock();
    if (a.type === 'action') {
      const item = ASSISTANT_ACTIONS.find(x => x.action === a.action);
      hideMenu();
      if (item) openAssistant({ action: item.action, prompt: item.prompt });
      return;
    }
    if (a.type === 'settings') { hideMenu(); openAssistant({ settingsTab: String(a.tab || 'pet') }); return; }
    if (a.type === 'ask') { hideMenu(); openAsk(); return; }
    if (a.type === 'inbox') { hideMenu(); handleClick('dot'); return; }
    if (a.type === 'pet') { hideMenu(); petted(); return; }
    if (a.type === 'page' && typeof a.page === 'string') { hideMenu(); openItem({ page: a.page }); return; }
    if (a.type === 'hide') { hideMenu(); setSettings({ enabled: false }); return; }
    if (a.type === 'close') { hideMenu(); return; }
    if (a.type === 'mode' && MODE_SET.has(a.mode)) settings.update({ mode: a.mode });
    else if (a.type === 'quietHour') settings.update({ quietUntil: a.value ? t + 3600000 : 0 });
    else if (a.type === 'silentToday') settings.update({ silentDate: a.value ? localDateKey(t) : '' });
    else if (a.type === 'role' && typeof a.role === 'string' && roles.installed(a.role)) settings.update({ role: a.role });
    else return;
    evaluate();
    sendMenuState();
    try { sendToRenderer?.('hub-pet:settings-changed', publicSettings()); } catch (_) {}
  }

  // ---------- IPC ----------
  const fromPet = event => !!(event && alive() && event.sender === win.webContents);
  const fromMenu = event => !!(event && menuAlive() && event.sender === menuWin.webContents);
  const fromMain = event => { const m = getMainWindow?.(); return !!(event && m && !m.isDestroyed?.() && event.sender === m.webContents); };
  const handlers = {
    'hub-pet:ready': (event) => { if (fromPet(event)) { lastSent = ''; evaluate(); } },
    'hub-pet:hit': (event, hit) => { if (fromPet(event) && !drag) setIgnore(!hit); },
    'hub-pet:press': (event, payload) => { if (fromPet(event)) onPress(payload && payload.target); },
    'hub-pet:release': (event) => { if (fromPet(event)) onRelease(); },
    'hub-pet:pet': (event) => { if (fromPet(event)) petted(); },
    'hub-pet:menu': (event) => { if (fromPet(event)) { if (drag) { drag = null; stopMove(); } popupMenu(); } },
    'hub-pet-menu:ready': (event) => { if (fromMenu(event)) { menuReady = true; sendMenuState(); } },
    'hub-pet-menu:size': (event, box) => {
      if (!fromMenu(event) || !box) return;
      const h = Math.round(Number(box.height) || 0);
      if (h < 80 || h > 1200 || h === menuSize.height) return;
      menuSize = { width: MENU_W, height: h };
      if (menuWin.isVisible()) menuWin.setBounds(menuBounds().bounds, false);
    },
    'hub-pet-menu:act': (event, payload) => { if (fromMenu(event)) menuAct(payload || {}); },
    'hub-pet:open-notice': (event, item) => {
      if (!fromPet(event) || !item) return;
      if (!confirmReminders([item])) return;
      // 「形象没下载下来」的提示：直接打开「助理 → 设置 → 桌宠」。
      if (/^pet-role-missing-/.test(String(item.id || ''))) { openAssistant({ settingsTab: 'pet' }); return; }
      openItem(item);
    },
    // 鼠标停在通知卡片上暂停倒计时；点卡片上的 × 收进小圆点。
    'hub-pet:hold': (event, on) => { if (fromPet(event) && speech.hold(on === true)) evaluate(); },
    'hub-pet:reply': (event, payload) => { if (fromPet(event) && payload) reply(payload.id, String(payload.choice || '')); },
    'hub-pet:dismiss': (event) => {
      if (!fromPet(event)) return;
      const item = speech.takeCurrent();
      if (item) { if (!item.ack) speech.toDot(item); evaluate(); }
    },
    // 桌宠头顶的「问助理」输入框：交给助理，答完由助理发通知回来（kind answer），桌宠举卡片说。
    'hub-pet:ask': (event, payload) => {
      if (!fromPet(event)) return;
      const text = String(payload && payload.text || '').trim().slice(0, 2000);
      const reply = r => send('hub-pet:ask-result', r);
      if (!text) { reply({ ok: false, error: '先写一句要问的' }); return; }
      if (typeof askAssistant !== 'function') { reply({ ok: false, error: '这个版本没有接入助理，暂时不能从桌宠提问。' }); return; }
      Promise.resolve().then(() => askAssistant(text, { enableAssistant: payload?.enableAssistant === true })).then(() => { reply({ ok: true }); evaluate(); },
        error => reply({ ok: false, enableAssistant: error?.code === 'ASSISTANT_DISABLED', error: String(error && error.message || error).slice(0, 160) }));
    },
    'hub-pet:ask-close': (event) => { if (fromPet(event)) { askOpen = false; setIgnore(true); } },
    // r27f：悬停快捷钮（问 / 信 / 摸）；渲染端的系统偏好（减少动态效果时不走动）。
    'hub-pet:quick': (event, type) => { if (fromPet(event)) { quick(String(type || '')); evaluate(); } },
    'hub-pet:prefs': (event, prefs) => { if (fromPet(event) && prefs && typeof prefs === 'object') { rendererPrefs = { reducedMotion: prefs.reducedMotion === true }; if (excursion) guardExcursion(); } },
    // 点会话状态灯：直达那个会话；答完、出错的灯随即熄掉。
    'hub-pet:open-session': (event, id) => { if (fromPet(event)) openSession(id); },
    'hub-pet:signal': (event, patch) => { if (fromMain(event)) setSignal(patch); },
    'hub-pet:session-seen': (event, id) => { if (fromMain(event)) sessionSeen(String(id || '').slice(0, 160)); },
    // 渲染端量出的身体透明边（比例）。只认 0–0.45 的数，防止一张奇怪的图把限位算坏；量的是别的形象（刚换过）就不认。
    // 量出来就记进 hub-pet.json，下次启动直接用。
    'hub-pet:body-box': (event, box) => {
      if (!fromPet(event) || !box) return;
      const role = currentRole();
      if (typeof box.role === 'string' && box.role && box.role !== role) return;
      const next = parseBox(box);
      if (!next) return;
      boxRole = role;
      applyBodyBox(next, JSON.stringify(cachedBox(role)) !== JSON.stringify(next) ? { bodyBoxes: { [role]: next } } : {});
    },
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.on(channel, fn);

  // roles：[{ id, name, bundled, installed, available, update, bytes, preview, previewMain }]，「换形象」只列 installed 的。
  function roleList() { return roles.listRoles(); }
  function publicSettings() {
    const { bodyBoxes: _boxes, talkRecent: _recent, ...s } = settings.get();
    const t = clock();
    return { available, settings: { ...s, role: currentRole() }, roles: roleList(), modes: MODES.map(id => ({ id, label: MODE_LABELS[id] })),
      quietHour: s.quietUntil > t, silentToday: s.silentDate === localDateKey(t), running: alive() };
  }
  ipcMain.handle('hub-pet:get-settings', (event) => (fromMain(event) ? publicSettings() : null));
  // 写盘失败时带上 saveError（{ code, message }），设置页据此在开关旁说「没存上」；拖滑块的 live 不写盘，不带。
  ipcMain.handle('hub-pet:set-settings', (event, patch) => {
    if (!fromMain(event)) return null;
    setSettings(patch);
    const saveError = patch && patch.live === true ? null : settings.lastSaveError();
    return saveError ? { ...publicSettings(), saveError } : publicSettings();
  });
  // 形象下载：只在用户点「下载 / 检查新形象」时联网；进度经 hub-pet:roles-state 推给主窗口。
  ipcMain.handle('hub-pet:roles', (event) => (fromMain(event) ? roles.snapshot() : null));
  ipcMain.handle('hub-pet:roles-check', (event) => (fromMain(event) ? roles.check() : null));
  ipcMain.handle('hub-pet:role-download', async (event, id) => {
    if (!fromMain(event)) return null;
    const snap = await roles.download(String(id || ''));
    lastSent = '';
    evaluate();
    return snap;
  });
  if (debug) {
    ipcMain.handle('hub-pet:debug', (event, req = {}) => {
      if (!fromMain(event)) return null;
      if (req.op === 'notice') return noticeBus?.publish(req.notice) || false;
      if (req.op === 'notify') return notify(req.payload || {});
      if (req.op === 'click') { handleClick(req.target || 'bubble'); return true; }
      if (req.op === 'menu-state') return menuState();
      if (req.op === 'menu-act') { menuAct(req.act || {}); return true; }
      if (req.op === 'ask-open') { openAsk(); return true; }
      if (req.op === 'signal') { setSignal(req.patch || {}); return true; }
      if (req.op === 'push') { onNotice(req.notice); return true; }   // 隔离测试：新版本、硬盘等不走提醒总线的通知
      if (req.op === 'update') return announceUpdate(req.version);
      if (req.op === 'open-session') return openSession(req.id);
      if (req.op === 'celebrate') return celebrate(req.payload || {});
      if (req.op === 'pet') return petted();
      // 截图与端到端用：直接说某个情境的一句（不走时段判断），或点气泡下的回应按钮。
      if (req.op === 'talk') {
        const s0 = settings.get();
        const line = pickLine(String(req.ctx || 'greet'), { now: clock(), name: s0.petName, prefs: s0.talkPrefs, recent: s0.talkRecent, rng: () => 0.5 });
        if (!line) return null;
        speech.push({ id: 'chatter-dbg-' + now(), kind: 'chatter', title: line.text, chips: line.chips, named: line.named, talk: { line: line.id, type: line.type, ctx: line.ctx } });
        evaluate();
        return line;
      }
      if (req.op === 'reply') return reply(speech.current && speech.current.id, String(req.choice || ''));
      if (req.op === 'disk-check') return diskWatch ? diskWatch.check() : [];
      if (req.op === 'override') {
        for (const k of ['idleSec', 'busy', 'fullscreen', 'nowShift', 'running', 'meeting', 'sessions', 'known', 'edge']) if (k in req) overrides[k] = req[k];
        // r27f：前台窗口（DIP，{ kind:'win', rect } / { kind:'desk' } / null）；传 'real' 改回真实读数。
        if ('virtual' in req) { overrides.virtual = req.virtual === true; if (overrides.virtual && alive()) place(initialPosition()); }
        if ('foreground' in req) { if (req.foreground === 'real') delete overrides.foreground; else overrides.foreground = req.foreground; }
        if ('fullscreen' in req) setScreenFull(req.fullscreen === true);
        evaluate();
        return true;
      }
      if (req.op === 'state') return { lastSent: lastSent ? JSON.parse(lastSent) : null, bounds: alive() ? winBounds() : null, area: alive() ? areaAt(currentPos()) : null, bodyBox: { ...bodyBox }, inset: inset(), edge: edgeCut(), scale: scaleNow(), dock, savedPosition: settings.get().position, savedDetached, visible: alive() && win.isVisible(), petPid: alive() ? win.webContents.getOSProcessId() : null, fullscreenWatch: fsWatch.isRunning(), lastRelease, autoRole: { ...autoRole }, role: settings.get().role,
        excursion: excursion ? { home: excursion.home, phase: excursion.phase, sit: excursion.plan && excursion.plan.sit } : null, lastWalk, walkScheduled: !!walkTimer, near: nearKey, clickMode: settings.get().clickMode, clickHinted: settings.get().clickHinted, askOpen, drag: drag ? { target: drag.target, moved: drag.moved, hug: drag.hug, start: drag.start } : null, moving: !!moveTimer };
      if (req.op === 'metrics') {
        const pid = alive() ? win.webContents.getOSProcessId() : null;
        return (app?.getAppMetrics?.() || []).filter(m => m.pid === pid || m.type === 'GPU').map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu && m.cpu.percentCPUUsage }));
      }
      // rnd（隔离测试）：固定随机数，0.1 ≈ 能坐就坐到窗口边上、0.9 ≈ 随便踱几步
      if (req.op === 'walk') return walkTick(true, Number.isFinite(req.rnd) ? () => req.rnd : null);
      if (req.op === 'walk-home') { walkHome(); return true; }
      if (req.op === 'quick') return quick(String(req.type || ''));
      if (req.op === 'foreground') return { raw: fsWatch.foreground(), dip: foregroundDip() };
      if (req.op === 'press') { onPress(req.target); return true; }
      if (req.op === 'release') { onRelease(); return true; }
      if (req.op === 'move') { if (alive()) place(req.pos); return true; }
      if (req.op === 'cursor') { overrides.cursor = req.pos || null; return true; }
      if (req.op === 'hide') { if (alive()) win.hide(); return true; }
      if (req.op === 'show') { if (alive()) win.showInactive(); return true; }
      return null;
    });
  }

  function setSignal(patch = {}) {
    if (typeof patch.quotaLow === 'boolean' || patch.quotaLow === null) signals = { ...signals, quotaLow: patch.quotaLow };
    evaluate();
  }

  function setSettings(patch = {}) {
    // live：设置页正在拖大小滑块。只改内存、实时挪窗口，停下 300ms（或松手发来不带 live 的最后一次）再写一次盘（2026-10-18 审核：
    // 原来每 60ms 一次、每次写两遍盘）。
    const live = patch.live === true;
    const clean = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (typeof patch.role === 'string' && roles.installed(patch.role)) clean.role = patch.role;
    if (MODE_SET.has(patch.mode)) clean.mode = patch.mode;
    if (typeof patch.peekOnFullscreen === 'boolean') clean.peekOnFullscreen = patch.peekOnFullscreen;
    if (NOTIFY_MODES.includes(patch.notifyMode)) clean.notifyMode = patch.notifyMode;
    if (typeof patch.followSessions === 'boolean') clean.followSessions = patch.followSessions;
    if (typeof patch.showGrowth === 'boolean') clean.showGrowth = patch.showGrowth;
    if (typeof patch.clickPlay === 'boolean') clean.clickMode = patch.clickPlay ? 'play' : 'open';
    if (CLICK_MODES.includes(patch.clickMode)) clean.clickMode = patch.clickMode;
    if (typeof patch.walk === 'boolean') clean.walk = patch.walk;
    const t = clock();
    if (typeof patch.quietHour === 'boolean') clean.quietUntil = patch.quietHour ? t + 3600000 : 0;
    if (typeof patch.silentToday === 'boolean') clean.silentDate = patch.silentToday ? localDateKey(t) : '';
    if (patch.resetPosition === true) clean.position = null;
    // 起名（2026-11-17 r27g）：空串＝不起名；「忘掉我的回应」清空回应偏好和说过的句子。
    let renamed = '';
    if (typeof patch.petName === 'string') { clean.petName = cleanName(patch.petName); if (clean.petName && clean.petName !== settings.get().petName) renamed = clean.petName; }
    if (patch.resetTalk === true) { clean.talkPrefs = normalizePrefs(null); clean.talkRecent = []; }
    const scale = parseScale(patch.scale);
    const g0 = geom();
    if (scale != null && scale !== scaleNow()) {
      clean.scale = scale;
      // 存的位置按脚换算（窗口开没开都换算；没存过位置的照旧用默认位置，不写）。
      const saved = settings.get().position;
      if (saved && !('position' in clean)) clean.position = convertSaved(saved, g0, geom(scale));
    }
    settings.update(clean, { persist: !live });
    if (clean.position === null) savedDetached = false;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (live && settings.isDirty()) {
      flushTimer = setTimeout(() => { flushTimer = null; settings.flush(); }, 300);
      flushTimer.unref?.();
    }
    if ('scale' in clean && excursion) abortExcursion({ snapHome: true });
    if (clean.position === null && excursion) abortExcursion();
    // 关掉走动：和安静档一样，由 evaluate 里的 guardExcursion 当场停下放回原处。
    if ('scale' in clean) refitWindow(g0);
    if ('peekOnFullscreen' in clean) setFullscreen(screenFull && clean.peekOnFullscreen);
    if (clean.position === null && alive() && !drag) {
      // 「回到右下角」：滑回默认位置。
      const to = initialPosition();
      animateTo([{ from: currentPos(), to, durationMs: 420 }], () => {
        dock = dockOf({ position: to, area: areaAt(to), size: winSize(), inset: inset() });
        send('hub-pet:motion', { phase: 'land', impact: 0.3 }); lastSent = ''; evaluate();
      });
    }
    if (renamed && alive()) speech.push({ id: 'ack-name-' + now() + '-' + (++ackSeq), kind: 'chatter', title: '好，以后我就叫「' + renamed + '」了。', ack: true, ms: 3500 });
    if ('enabled' in clean) { if (clean.enabled) start(); else stop(); }
    else evaluate();
  }

  // 大小或身体透明边变了，挪窗口（g0 是变之前的几何）：脚的位置不动（窗口底边对齐），窗口按新高度往上长；
  // 原来贴着边的继续贴着，超出屏幕的拉回来；没存过位置的回到新大小下的默认位置；躲边中的按新大小重新躲。
  // 只挪窗口，不写盘：存的位置由调用方按 convertSaved 换算后写。返回是否挪了（挪了就已经 evaluate 过）。
  function refitWindow(g0) {
    if (!alive() || drag) return false;
    stopMove();
    const g1 = geom();
    const base = placedBounds();
    if (fullscreen) {
      if (peekFrom) peekFrom = { x: peekFrom.x, y: peekFrom.y + g0.h - g1.h };
      place(peekTarget({ x: base.x, y: base.y + base.height - g1.h }, g1));
    } else if (!settings.get().position) {
      const pos = defaultPosition(g1);
      place(pos);
      dock = dockOf({ position: pos, area: areaFor(pos, g1), size: g1.size, inset: g1.inset });
    } else {
      const want = { x: base.x, y: base.y + base.height - g1.h };
      const range = rangeFor(want, g1);
      const pos = clampTo(range, dock === 'left' ? range.minX : dock === 'right' ? range.maxX : want.x, want.y);
      place(pos);
      dock = dockOf({ position: pos, area: areaFor(pos, g1), size: g1.size, inset: g1.inset });
    }
    lastSent = '';
    evaluate();
    return true;
  }
  // 换上新的身体透明边。存过位置、且不是「副屏拔了被拉回来」的，按贴边换算后写盘；没存过位置的不写（2026-10-18 审核）。
  function applyBodyBox(next, extraPatch = {}) {
    const patch = { ...extraPatch };
    const changed = JSON.stringify(next) !== JSON.stringify(bodyBox);
    const g0 = geom();
    if (changed) {
      bodyBox = { ...next };
      const saved = settings.get().position;
      if (saved && !savedDetached) patch.position = convertSaved(saved, g0, geom());
    }
    if (Object.keys(patch).length) settings.update(patch);
    if (changed && !refitWindow(g0)) evaluate();
  }

  // ---------- 记住的形象没装：后台补下载（2026-10-18） ----------
  // 2.1.9 起兔子、柴犬、仓鼠、玄凤改成在线下载。之前选了它们的用户升级后，设置里还记着，但这台电脑上没有图：
  // 启动后在后台用设置页同一条下载路径（多源、字节数 + SHA-256 校验）补装，装好就换上；
  // 下载不成功时，只说一次温和的提示，指到「助理 → 设置 → 桌宠」。每次启动最多试一次，不反复联网。
  let autoRoleTimer = null;
  let autoRole = { phase: 'idle', id: null, error: null };   // 隔离测试读
  function rememberedMissingRole() {
    const want = settings.get().role;
    return want && knownRole(want) && !roles.installed(want) ? want : null;
  }
  async function restoreRememberedRole() {
    const want = rememberedMissingRole();
    if (!want || disposed || autoRole.phase !== 'idle') return autoRole;
    // 用户正在设置页里自己下载，就交给那边，不抢。
    if (roles.snapshot().state.phase === 'downloading') { autoRole = { phase: 'skipped', id: want, error: null }; return autoRole; }
    autoRole = { phase: 'downloading', id: want, error: null };
    logger.info?.(`[hub-pet] remembered role ${want} is not installed; downloading it in the background`);
    let error = null;
    try {
      const snap = await roles.download(want);
      if (!roles.installed(want)) error = (snap && snap.state && snap.state.error) || '下载没成功';
    } catch (e) { error = (e && e.message) || String(e); }
    if (disposed) return autoRole;
    if (!error) {
      autoRole = { phase: 'installed', id: want, error: null };
      lastSent = '';
      evaluate();
      try { sendToRenderer?.('hub-pet:settings-changed', publicSettings()); } catch (_) {}
      return autoRole;
    }
    autoRole = { phase: 'failed', id: want, error: String(error).slice(0, 200) };
    logger.warn?.(`[hub-pet] background download of ${want} failed:`, autoRole.error);
    // 用户这期间自己换了别的形象，就不打扰了。
    if (settings.get().role !== want) return autoRole;
    const name = (ROLES.find(r => r.id === want) || {}).name || '你选的形象';
    onNotice({ id: `pet-role-missing-${want}`, kind: 'pet-role', title: `${name}还没下载下来，先由小猫陪你`,
      text: `新版里${name}改成在线下载了，刚才自动下载没成功。网络好的时候，在「助理 → 设置 → 桌宠」里点「下载」就能换回${name}。` });
    return autoRole;
  }
  function scheduleRoleRestore() {
    if (autoRoleTimer || autoRole.phase !== 'idle' || !rememberedMissingRole()) return;
    autoRoleTimer = setTimeout(() => { autoRoleTimer = null; void restoreRememberedRole(); }, autoRoleDelayMs);
    autoRoleTimer.unref?.();
  }

  // ---------- 生命周期 ----------
  function start() {
    if (!enabled() || started) return false;
    started = true;
    ensureWindow();
    noticeBus?.on?.('notice', onNotice);
    noticeBus?.on?.('reminders-changed', syncReminders);
    syncReminders();
    pollTimer = setInterval(evaluate, POLL_MS);
    startHover();
    if (watchFullscreen && overrides.fullscreen == null) fsWatch.start();
    scheduleRoleRestore();
    for (const [ev, fn] of POWER_EVENTS) { try { powerMonitor?.on?.(ev, fn); } catch (_) {} }
    scheduleWalk(WALK_FIRST);
    // 出来 6 秒后再自我介绍：先让用户看到它，再开口。
    if (!settings.get().introduced) { introTimer = setTimeout(() => { introTimer = null; if (started && alive()) { introduce(); evaluate(); } }, 6000); introTimer.unref?.(); }
    if (diskWatch) { diskWatch.start(); diskFirst = setTimeout(() => { diskFirst = null; void diskWatch.check().catch(() => {}); }, 60000); diskFirst.unref?.(); }
    return true;
  }
  function stop() {
    if (!started) return;
    started = false;
    if (introTimer) { clearTimeout(introTimer); introTimer = null; }
    abortExcursion();
    for (const [ev, fn] of POWER_EVENTS) { try { powerMonitor?.removeListener?.(ev, fn); } catch (_) {} }
    screenLocked = false;
    if (walkTimer) clearTimeout(walkTimer);
    walkTimer = null; askOpen = false; nearKey = '';
    noticeBus?.removeListener?.('notice', onNotice);
    noticeBus?.removeListener?.('reminders-changed', syncReminders);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    stopHover();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    if (autoRoleTimer) clearTimeout(autoRoleTimer);
    autoRoleTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    settings.flush();
    stopMove();
    drag = null;
    fsWatch.stop();
    diskWatch?.stop();
    if (diskFirst) clearTimeout(diskFirst);
    diskFirst = null;
    fullscreen = false;
    screenFull = false;
    peekFrom = null;
    if (alive()) win.destroy();
    win = null;
    placed = null;
    if (menuAlive()) menuWin.destroy();
    menuWin = null; menuReady = false;
    if (owner && !owner.isDestroyed?.()) { try { owner.destroy(); } catch (_) {} }
    owner = null;
    lastSent = '';
  }
  function dispose() {
    if (disposed) return;
    stop();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    settings.flush();
    roles.cancel();
    disposed = true;
    for (const [channel, fn] of Object.entries(handlers)) ipcMain.removeListener?.(channel, fn);
    ipcMain.removeHandler?.('hub-pet:get-settings');
    ipcMain.removeHandler?.('hub-pet:set-settings');
    for (const ch of ['hub-pet:roles', 'hub-pet:roles-check', 'hub-pet:role-download']) ipcMain.removeHandler?.(ch);
    if (debug) ipcMain.removeHandler?.('hub-pet:debug');
  }

  // 低开销模式切换后立即重发一次状态（没开桌宠或还没启动时什么都不做）。
  function refreshLowOverhead() { if (enabled() && started && alive()) evaluate(); }

  return { start, stop, dispose, refreshLowOverhead, setSignal, setSettings, setProfile, celebrate, petted, roleList, notify, routeDesktopNotice, canNotify, sessionSeen, announceUpdate, isActive: () => enabled() && started && alive(), getWindow: () => win, getWindows: () => [win, menuWin].filter(Boolean), getSettings: () => settings.get(), _evaluate: evaluate, _speech: speech, _roles: roles, _reply: reply, _chatterTrack: chatterTrack,
    _restoreRememberedRole: restoreRememberedRole, _autoRole: () => ({ ...autoRole }) };
}

module.exports = { BODY, INSET, SCALE_MAX, SCALE_MIN, WIN_H, WIN_W, createHubPetController };
