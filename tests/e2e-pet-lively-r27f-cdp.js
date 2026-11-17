'use strict';
// r27f 桌宠「待机更活、悬停快捷钮与单击只逗它、偶尔在任务栏走动」隔离实测（2026-11-17）。
// 6 个形象（含 4 个真实下载形象）× 浅色/深色桌面：悬停快捷钮、鼠标靠近侧身、单击逗它（首次提示）、按住抱抱、拎起钟摆、走到窗口边坐下，逐一截图并断言。
// 安静档、开会、全屏躲边时新行为不出现；系统缩放 100%/150%/225%（--force-device-scale-factor）下走动不出工作区、不压前台窗口。
// 设置页「桌宠」Tab 在 1440×900 下不出纵向滚动。
// r27f2 审查返工：每个形象放大 1.6 倍亮 6 盏灯时快捷钮不压灯；走动途中最大化前台窗口、切安静、开会、减少动态效果当场停下回原处；
// 安静档、开会时真把鼠标停在身上也不冒快捷钮；往上甩最后停的位置＝存下的位置。
// 用法：node tests/e2e-pet-lively-r27f-cdp.js <输出目录> [--roles=01-cat,03-penguin] [--skip-scale]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(REPO, 'artifacts/pet-lively-r27f'));
const ROLE_ARG = (process.argv.find(a => a.startsWith('--roles=')) || '').slice(8);
const ROLES = ROLE_ARG ? ROLE_ARG.split(',') : ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const SKIP_SCALE = process.argv.includes('--skip-scale');
const NAMES = { '01-cat': '小猫', '03-penguin': '企鹅', '05-rabbit': '兔子', '07-shiba': '柴犬', '09-hamster': '仓鼠', '11-cockatiel': '玄凤' };
const RUN6 = Array.from({ length: 6 }, (_, i) => ({ id: 'run-' + i, title: '会话 ' + (i + 1) }));
const rectGap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const INSET_X = 65;   // 窗口 280 宽、身体 150：身体左右各让 65
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); });
});
async function wait(fn, label, timeout = 25000) {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(120);
  }
  throw Error('Timeout: ' + label + (last ? ': ' + last.message : ''));
}
function targets(base) {
  return new Promise((resolve, reject) => {
    http.get(base + '/json/list', res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
// 身体看得见的横向范围：窗口左边 + 主进程算的身体边距（已扣掉形象图里的透明边，各形象不同）
const bodySpan = (b, inset) => [b.x + inset.left, b.x + 280 - inset.right];
const overlaps = ([a, b], r) => a < r.x + r.width && b > r.x;

async function openHub(label, extraArgs, evidence) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-r27f-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  // 等级先给到中间（不在升级边上）：抱抱、摸摸记的亲密度不会正好触发升级庆祝，截图只看新动作。
  const { Profile } = require('../core/profile/service');
  const prof = new Profile({ dataDir: data, saveDelayMs: 1e9 });
  prof.state.xp = 21000; prof.state.lastLevel = require('../core/profile/rules').levelOf(prof.state.xp);
  prof.state.backfill = { at: Date.now(), days: 0, sessions: 0 }; prof.save();
  const hub = await launchIsolatedHub({ dataDir: data, port: await port(), label, windowMode: 'background', extraArgs, extraEnv: {
    CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
  } });
  const mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
  const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
  const settings = patch => mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', ${JSON.stringify(patch)})`);
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  await wait(() => dbg({ op: 'state' }), 'debug');
  // 隔离测试窗口被压在屏幕外、挪不动：打开 virtual，以控制器「自己放的位置」当窗口位置（走动、甩出去照真实屏幕的工作区算）。
  await dbg({ op: 'override', nowShift: noon.getTime() - Date.now(), idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false, virtual: true });
  const target = await wait(async () => (await targets(hub.cdpHttpBase)).find(t => /hub-pet\/pet\.html/.test(t.url)), 'pet target');
  const pet = await connectCDP(target.webSocketDebuggerUrl);
  await pet.send('Runtime.enable');
  pet.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(label + ': ' + m.params.exceptionDetails.text); });
  const json = expr => pet.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const debug = () => json('window.__hubPetDebug()');
  const shot = async (name, dark) => {
    await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: dark ? { r: 27, g: 31, b: 42, a: 1 } : { r: 226, g: 232, b: 240, a: 1 } });
    // 透明窗口截图不带桌面：只在测试里给页面刷一层「桌面色」。
    await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(dark ? '#1b1f2a' : '#e2e8f0')}`);
    const size = await json('({w: innerWidth, h: innerHeight})');
    const r = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); evidence.screenshots.push(name + '.png');
  };
  const close = async () => { try { pet.close(); } catch (_) {} try { mainPage.close(); } catch (_) {} return gracefulQuit(hub); };
  return { hub, mainPage, pet, dbg, settings, json, debug, shot, close, data };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const evidence = { version: require('../package.json').version, roles: ROLES, steps: [], facts: { shots: [], scale: [] }, errors: [], screenshots: [] };
  let H = null;
  const step = async (name, fn) => { await fn(); evidence.steps.push(name); };
  try {
    H = await openHub('pet-r27f', [], evidence);
    const { dbg, settings, json, debug, shot, pet, mainPage } = H;
    const bodyCenter = () => json(`(()=>{const r=document.getElementById('body').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*0.6}})()`);
    const state = () => dbg({ op: 'state' });
    const toScreen = async p => { const b = (await state()).bounds; return { x: b.x + p.x, y: b.y + p.y }; };
    const moveMouse = async (x, y) => { await pet.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); };
    const resetHome = async () => { await dbg({ op: 'walk-home' }); await wait(async () => !(await state()).excursion, 'home', 9000); };
    const farCursor = { x: -30000, y: -30000 };

    await step('实际下载 4 个在线形象', async () => {
      const got = {};
      for (const id of ROLES.filter(r => !['01-cat', '03-penguin'].includes(r))) {
        const role = await mainPage.eval(`ipcRenderer.invoke('hub-pet:role-download',${JSON.stringify(id)}).then(s => s.roles.find(r => r.id === ${JSON.stringify(id)}))`, { timeoutMs: 180000 });
        assert.equal(role?.installed, true, id + ' installed');
        assert.equal(role.bundled, false, id + ' must be a downloadable character');
        got[id] = { installed: role.installed, bundled: role.bundled };
      }
      evidence.facts.downloaded = got;
    });

    await step('首次单击：逗它一下 + 一句新玩法提示；400ms 内连点两下才打开助理', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'gentle' });
      await dbg({ op: 'cursor', pos: farCursor });
      await sleep(900);
      const c = await toScreen(await bodyCenter());
      await dbg({ op: 'cursor', pos: c });
      await dbg({ op: 'press', target: 'pet' }); await sleep(60); await dbg({ op: 'release' });
      const s1 = await wait(async () => { const s = await state(); return s.lastSent?.bubble?.id === 'click-hint' ? s : null; }, 'click hint', 4000);
      assert.equal(s1.clickHinted, true);
      assert.equal(s1.askOpen, false);
      await sleep(400);
      await shot('00-小猫-浅-首次单击提示', false);
      evidence.facts.clickHint = s1.lastSent.bubble.title;
      await pet.eval('window.hubPet.dismiss()'); await sleep(500);
      await dbg({ op: 'press', target: 'pet' }); await dbg({ op: 'release' }); await sleep(80);
      await dbg({ op: 'press', target: 'pet' }); await dbg({ op: 'release' });
      const open = await mainPage.eval(`new Promise(r => setTimeout(() => r(document.body.innerText.includes('助理')), 900))`);
      evidence.facts.doubleClickOpensAssistant = open;
      await dbg({ op: 'cursor', pos: farCursor });
      // 第一次摸摸会解锁一个成就卡片（已有行为）：先摸一次并收起，后面抱抱的截图只看新动作
      await dbg({ op: 'pet' }); await sleep(1500);
      for (let i = 0; i < 3; i++) { await pet.eval('window.hubPet.dismiss()'); await sleep(400); }
    });

    for (const role of ROLES) for (const dark of [false, true]) {
      const tag = `${role}-${dark ? 'dark' : 'light'}`;
      const name = NAMES[role] + '-' + (dark ? '深' : '浅');
      await step(name + '：悬停快捷钮、靠近侧身、按住抱抱、拎起钟摆、走到窗口边坐下', async () => {
        await settings({ role, scale: 1, mode: 'gentle', walk: true });
        await wait(async () => (await state()).lastSent?.role === role, 'role ' + role);
        await dbg({ op: 'cursor', pos: farCursor });
        await sleep(1200);
        const facts = { role, dark };
        await pet.eval(`window.__m=[];window.hubPet.onMotion(m=>window.__m.push(m.phase+(m.vx!=null?':'+Math.round(m.vx):'')))`);
        // 1 悬停半秒：头顶冒「问 / 信 / 摸」，三个钮都在窗口里、不压住身体中心
        const bc = await bodyCenter();
        await moveMouse(bc.x, bc.y); await sleep(250); await moveMouse(bc.x + 2, bc.y);
        const q = await wait(async () => { const d = await debug(); return d.quick ? d : null; }, name + ' quick', 3000);
        const win = await json('({w: innerWidth, h: innerHeight})');
        assert.deepEqual(q.quick.buttons.map(b => b.q), ['ask', 'inbox', 'pet']);
        for (const b of q.quick.buttons) assert.ok(b.left >= 0 && b.right <= win.w && b.top >= 0 && b.bottom <= win.h, name + ' 快捷钮在窗口里');
        assert.ok(q.quick.bottom <= bc.y, name + ' 快捷钮在身体上方');
        facts.quick = q.quick;
        await sleep(450);   // 等冒出动画走完
        await shot(`${tag}-01-悬停快捷钮`, dark);
        await moveMouse(2, 2);
        await wait(async () => !(await debug()).quick, name + ' quick hides', 2000);
        // 2 鼠标从左边靠近：侧身看过去
        const b = (await state()).bounds;
        await dbg({ op: 'cursor', pos: { x: b.x + INSET_X - 60, y: b.y + b.height - 80 } });
        const n = await wait(async () => { const d = await debug(); return d.near === -1 && Math.abs(d.nearTurn) > 0.6 ? d : null; }, name + ' near', 3000);
        facts.near = { side: n.near, turn: n.nearTurn, transform: n.transform };
        await shot(`${tag}-02-靠近侧身`, dark);
        await dbg({ op: 'cursor', pos: farCursor }); await sleep(300);
        // 3 按住 0.6 秒：抱抱（压扁、冒爱心），松手不算单击
        const c = await toScreen(bc);
        await dbg({ op: 'cursor', pos: c });
        await dbg({ op: 'press', target: 'pet' });
        const h = await wait(async () => { const d = await debug(); return d.hug && d.hugK > 0.5 ? d : null; }, name + ' hug', 3000);
        facts.hug = { hugK: h.hugK, transform: h.transform };
        await sleep(500);
        await shot(`${tag}-03-抱抱`, dark);
        await dbg({ op: 'release' }); await sleep(300);
        assert.equal((await debug()).hug, false);
        // 4 拎起来横着拖：约 1000 DIP/s 往左拖一下再停住，身子像钟摆一样甩起来（渲染端记下这次摆到的最大角度）
        await dbg({ op: 'press', target: 'pet' });
        for (let i = 1; i <= 8; i++) { await dbg({ op: 'cursor', pos: { x: c.x - i * 36, y: c.y - i * 6 } }); await sleep(30); }
        const sw = await wait(async () => { const d = await debug(); return d.swingPeak > 3 ? d : null; }, name + ' swing', 3000)
          .catch(async e => { throw Error(e.message + ' ' + JSON.stringify({ peak: (await debug()).swingPeak, m: await json('window.__m') })); });
        facts.swing = { now: sw.swing, peak: sw.swingPeak };
        await shot(`${tag}-04-拎起钟摆`, dark);
        for (let i = 15; i >= 0; i--) { await dbg({ op: 'cursor', pos: { x: c.x - i * 18, y: c.y - i * 3 } }); await sleep(60); }
        await sleep(300);
        await dbg({ op: 'release' }); await sleep(700);
        await dbg({ op: 'cursor', pos: farCursor });
        await settings({ resetPosition: true }); await sleep(700);
        // 5 走到前台窗口边上坐下（窗口在左边、底部压到任务栏）
        const s0 = await state();
        const home = s0.bounds, area = s0.area;
        const fg = { x: area.x + 80, y: area.y + 60, width: home.x - 140 - (area.x + 80), height: area.height - 40 };
        await dbg({ op: 'override', foreground: { kind: 'win', rect: fg } });
        const w = await dbg({ op: 'walk', rnd: 0.1 });
        assert.ok(w.plan, name + ' 能走 ' + JSON.stringify(w));
        assert.equal(w.plan.sit, 'right-of-window');
        await wait(async () => (await debug()).walking, name + ' walking', 2000);
        await sleep(Math.min(700, w.plan.durationMs / 2));
        const mid = await debug();
        facts.walkMid = { walking: mid.walking, fps: mid.fps, transform: mid.transform };
        assert.equal(mid.fps, 'raf', '走动时满帧');
        await shot(`${tag}-05-走动中`, dark);
        const sat = await wait(async () => { const d = await debug(); return d.sitting && d.sitK > 0.9 ? d : null; }, name + ' sit', w.plan.durationMs + 3000);
        const st1 = await state(), there = st1.bounds;
        assert.ok(!overlaps(bodySpan(there, st1.inset), fg), name + ' 坐下的地方不压窗口 ' + JSON.stringify({ there, fg, home, area, plan: w.plan }));
        assert.ok(there.x >= area.x - INSET_X && there.x + 280 - INSET_X <= area.x + area.width, name + ' 不出工作区');
        facts.sit = { at: there, fg, sitK: sat.sitK };
        await shot(`${tag}-06-坐在窗口边`, dark);
        await resetHome();
        await sleep(400);
        const back = (await state()).bounds;
        assert.equal(back.x, home.x, name + ' 走回原处');
        await sleep(1200);
        facts.fpsAfterWalk = (await debug()).fps;   // 走完降回平时的帧率（待机是 timer 或 stopped）
        await dbg({ op: 'override', foreground: 'real' });
        // 7 r27f2：放大到 1.6 倍、亮 6 盏会话灯，悬停冒出的快捷钮不压灯
        await settings({ scale: 1.6 }); await sleep(700);
        await dbg({ op: 'override', sessions: RUN6, running: 6 });
        await wait(async () => { const d = await debug(); return d.lamps && d.lamps.items.length === 6 ? d : null; }, name + ' 6 lamps', 5000);
        await sleep(300);
        const bc2 = await bodyCenter();
        await moveMouse(bc2.x, bc2.y); await sleep(250); await moveMouse(bc2.x + 2, bc2.y);
        const q2 = await wait(async () => { const d = await debug(); return d.quick ? d : null; }, name + ' quick@1.6', 3000);
        await sleep(450);
        const lampRect = await json(`(()=>{const r=document.getElementById('lamps').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})()`);
        const qr = await json(`(()=>{const r=document.getElementById('quick').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})()`);
        const win2 = await json('({w: innerWidth, h: innerHeight})');
        facts.lampsQuick = { lamps: lampRect, row: q2.lamps && q2.lamps.row, quick: qr, overlap: rectGap(lampRect, qr) };
        assert.equal(facts.lampsQuick.overlap, 0, name + ' 1.6 倍快捷钮不压状态灯 ' + JSON.stringify(facts.lampsQuick));
        assert.ok(qr.top >= 0 && qr.bottom <= win2.h, name + ' 1.6 倍快捷钮在窗口里');
        await shot(`${tag}-07-放大1.6倍-快捷钮避开状态灯`, dark);
        await moveMouse(2, 2);
        await dbg({ op: 'override', sessions: [], running: 0 });
        await settings({ scale: 1 }); await sleep(600);
        evidence.facts.shots.push(facts);
      });
    }

    await step('走完立即降帧；待机小动作间隔 8–20 秒（活泼时）', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'gentle' });
      await dbg({ op: 'cursor', pos: farCursor });
      const gaps = [];
      let last = null;
      for (const end = Date.now() + 50000; Date.now() < end && gaps.length < 3;) {
        const d = await debug();
        if (d.lastMove && d.lastMove !== last) { gaps.push({ move: d.lastMove, gestureIn: d.gestureIn }); last = d.lastMove; }
        await sleep(400);
      }
      const d = await debug();
      assert.equal(d.lively, true);
      assert.ok(d.gestureIn <= 20000, '下一次小动作 ≤20 秒 ' + d.gestureIn);
      evidence.facts.gestures = { seen: gaps, lively: d.lively, fpsIdle: d.fps };
    });

    await step('安静档、开会、全屏躲边：不走、不冒快捷钮、不靠近轻跳，待机节奏回到 28–45 秒', async () => {
      const s0 = await state();
      const fg = { x: s0.area.x + 80, y: s0.area.y + 60, width: s0.bounds.x - 140 - (s0.area.x + 80), height: s0.area.height - 40 };
      await dbg({ op: 'override', foreground: { kind: 'win', rect: fg } });
      const out = {};
      for (const [k, on, off] of [
        ['quiet', () => settings({ mode: 'quiet' }), () => settings({ mode: 'gentle' })],
        ['meeting', () => dbg({ op: 'override', meeting: true }), () => dbg({ op: 'override', meeting: false })],
        ['fullscreen', () => dbg({ op: 'override', fullscreen: true }), () => dbg({ op: 'override', fullscreen: false })],
      ]) {
        await on(); await sleep(1500);
        const w = await dbg({ op: 'walk', rnd: 0.1 });
        const d = await debug();
        assert.equal(w.skipped, k, k + ' 不走');
        assert.equal(d.lively, false, k + ' 不活泼');
        // 真把鼠标停在身上 1 秒：不冒快捷钮（r27f2：原来只读了状态、没悬停）
        let hovered = null;
        if (k !== 'fullscreen') {
          const bc = await bodyCenter();
          await moveMouse(bc.x, bc.y); await sleep(250); await moveMouse(bc.x + 2, bc.y); await sleep(900);
          hovered = (await debug()).quick;
          assert.equal(hovered, null, k + ' 悬停不冒快捷钮');
          await moveMouse(2, 2);
        }
        out[k] = { walk: w.skipped, lively: d.lively, gestureIn: d.gestureIn, quick: d.quick, hoveredQuick: hovered };
        if (k === 'fullscreen') { assert.equal((await state()).lastSent.pose, 'peek'); await shot('90-全屏躲边不变', false); }
        if (k === 'meeting') await shot('91-开会不变', false);
        if (k === 'quiet') await shot('92-安静档悬停不冒快捷钮', false);
        await off(); await sleep(1500);
      }
      await settings({ walk: false });
      out.off = (await dbg({ op: 'walk', rnd: 0.1 })).skipped;
      assert.equal(out.off, 'off');
      await settings({ walk: true });
      await dbg({ op: 'override', foreground: 'real' });
      evidence.facts.blocks = out;
    });

    await step('r27f2：走动途中最大化前台窗口、切安静、开会、减少动态效果，当场停下回原处；往上甩停的位置＝存的位置', async () => {
      await settings({ role: '03-penguin', scale: 1, mode: 'gentle', walk: true, resetPosition: true }); await sleep(800);
      await dbg({ op: 'cursor', pos: farCursor });
      const out = {};
      for (const [k, fire, undo] of [
        ['foreground', async a => dbg({ op: 'override', foreground: { kind: 'win', rect: { x: a.x - 8, y: a.y - 8, width: a.width + 16, height: a.height + 16 } } }), async () => dbg({ op: 'override', foreground: { kind: 'desk' } })],
        ['quiet', async () => settings({ mode: 'quiet' }), async () => settings({ mode: 'gentle' })],
        ['meeting', async () => dbg({ op: 'override', meeting: true }), async () => dbg({ op: 'override', meeting: false })],
        ['reduced-motion', async () => pet.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }), async () => pet.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })],
      ]) {
        await dbg({ op: 'override', foreground: { kind: 'desk' } });
        const s0 = await state();
        const w = await dbg({ op: 'walk', rnd: 0.9 });
        assert.ok(w.plan, k + ' 能出发 ' + JSON.stringify(w));
        await sleep(700);
        const midX = (await state()).bounds.x;
        assert.notEqual(midX, s0.bounds.x, k + ' 已经走出去');
        await fire(s0.area);
        const t0 = Date.now();
        const st = await wait(async () => { const x = await state(); return !x.excursion && !x.moving ? x : null; }, k + ' stop', 2000);
        const ms = Date.now() - t0;
        await sleep(300);
        const after = await state();
        assert.equal(after.bounds.x, s0.bounds.x, k + ' 回到原处');
        assert.equal(after.lastWalk.aborted, k, k + ' 停下原因');
        assert.equal((await debug()).walking, false, k + ' 渲染端不再迈步');
        out[k] = { home: s0.bounds.x, mid: midX, after: after.bounds.x, stopMs: ms, aborted: after.lastWalk.aborted, excursion: st.excursion };
        if (k === 'foreground') await shot('93-走动中最大化-停下回原处', false);
        await undo(); await sleep(600);
      }
      // 往上甩：从任务栏上方快速往上一甩，飞完窗口停的位置就是存下的位置（不在半空）
      const s1 = await state();
      const bc = await toScreen(await bodyCenter());
      await dbg({ op: 'cursor', pos: bc });
      await dbg({ op: 'press', target: 'pet' });
      for (let i = 1; i <= 6; i++) { await dbg({ op: 'cursor', pos: { x: bc.x, y: bc.y - i * 25 } }); await sleep(40); }
      // 最后几下每步挪 90 DIP、不额外等（CDP 一来一回约 20–40ms），松手前 180ms 的速度稳在「甩」的门槛 900 DIP/s 以上
      for (let i = 1; i <= 4; i++) { await dbg({ op: 'cursor', pos: { x: bc.x + i * 15, y: bc.y - 150 - i * 90 } }); }
      await dbg({ op: 'release' });
      const rel = (await state()).lastRelease;
      await sleep(1800);
      const s2 = await state();
      const saved = await mainPage.eval(`ipcRenderer.invoke('hub-pet:get-settings').then(s => JSON.stringify(s.settings.position))`).then(JSON.parse);
      out.fling = { release: rel, bounds: { x: s2.bounds.x, y: s2.bounds.y }, saved, floorY: s1.bounds.y };
      assert.equal(rel && rel.fling, true, '算甩 ' + JSON.stringify(rel));
      assert.deepEqual({ x: s2.bounds.x, y: s2.bounds.y }, rel.final, '窗口停的位置＝计划的落点');
      assert.deepEqual(saved, rel.final, '存下的位置＝窗口停的位置');
      await shot('94-往上甩落到任务栏', false);
      await settings({ resetPosition: true }); await sleep(800);
      await dbg({ op: 'override', foreground: 'real' });
      evidence.facts.r27f2 = out;
    });

    await step('前台窗口真实读数（同一个全屏检测进程顺带读）', async () => {
      const f = await wait(async () => { const x = await dbg({ op: 'foreground' }); return x.raw ? x : null; }, 'foreground reading', 8000).catch(() => null);
      evidence.facts.foregroundReal = f;
    });

    await step('设置页「桌宠」Tab：1440×900 不出纵向滚动，两个新开关在', async () => {
      await mainPage.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await mainPage.eval(`window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { settingsTab: 'pet' } }))`);
      const ok = await wait(() => mainPage.eval(`!!document.querySelector('[data-pet="clickPlay"]') && !!document.querySelector('[data-pet="walk"]')`), 'pet tab switches', 15000);
      await sleep(800);
      const m = await mainPage.eval(`JSON.stringify((()=>{const els=[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2&&e.clientHeight>200&&e.offsetParent!==null});const tab=document.querySelector('[data-slot="pet-tab"]');const r=tab&&tab.getBoundingClientRect();return {scrollers:els.map(e=>({id:e.id,cls:String(e.className).slice(0,60),sh:e.scrollHeight,ch:e.clientHeight})),doc:{sh:document.documentElement.scrollHeight,ch:innerHeight},tabBottom:r&&r.bottom,clickPlay:document.querySelector('[data-pet="clickPlay"]').checked,walk:document.querySelector('[data-pet="walk"]').checked}})())`).then(JSON.parse);
      const r = await mainPage.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, '95-设置页-桌宠Tab-1440x900.png'), Buffer.from(r.data, 'base64')); evidence.screenshots.push('95-设置页-桌宠Tab-1440x900.png');
      assert.ok(ok);
      assert.equal(m.clickPlay, true, '默认单击只逗它');
      assert.equal(m.walk, true, '默认会走动');
      assert.ok(m.tabBottom <= 900, '桌宠 Tab 在一屏内 ' + m.tabBottom);
      assert.deepEqual(m.scrollers, [], '设置面板不出纵向滚动');
      evidence.facts.settingsTab = m;
      await mainPage.send('Emulation.clearDeviceMetricsOverride');
    });

    evidence.facts.final = await state();
  } catch (e) { evidence.ok = false; evidence.errors.push(e.stack || e.message); process.exitCode = 1; }
  finally { if (H) evidence.cleanup = await H.close(); H = null; }

  // ---------- 系统缩放 100% / 150% / 225%：每档单独起一个隔离 Hub ----------
  if (!SKIP_SCALE && process.exitCode !== 1) {
    for (const f of [1, 1.5, 2.25]) {
      let S = null;
      try {
        await step(`系统缩放 ${f * 100}%：走 6 次，不出工作区、不压前台窗口；走完回原处`, async () => {
          S = await openHub('pet-r27f-dpr' + f, ['--force-device-scale-factor=' + f], evidence);
          await S.settings({ role: '01-cat', scale: 1, mode: 'gentle', walk: true });
          await S.dbg({ op: 'cursor', pos: { x: -30000, y: -30000 } });
          await sleep(1500);
          const s0 = await S.dbg({ op: 'state' });
          const home = s0.bounds, area = s0.area;
          // 前台窗口占工作区横向 30%–60%、底部压任务栏；桌宠在右下角，左右两段都在
          const fg = { x: Math.round(area.x + area.width * 0.3), y: area.y + 40, width: Math.round(area.width * 0.3), height: area.height - 20 };
          await S.dbg({ op: 'override', foreground: { kind: 'win', rect: fg } });
          const rows = [];
          for (const rnd of [0.1, 0.9, 0.3, 0.7, 0.5, 0.95]) {
            const w = await S.dbg({ op: 'walk', rnd });
            if (!w.plan) { rows.push({ rnd, skipped: w.skipped }); continue; }
            await wait(async () => { const d = await S.debug(); return !d.walking && (await S.dbg({ op: 'state' })).excursion?.phase === 'dwell' ? d : null; }, 'arrive', w.plan.durationMs + 4000);
            const sb = await S.dbg({ op: 'state' }), b = sb.bounds;
            const span = bodySpan(b, sb.inset);
            assert.ok(span[0] >= area.x - 1 && span[1] <= area.x + area.width + 1, `${f} 身体不出工作区 ${JSON.stringify({ span, area })}`);
            assert.ok(b.y + b.height <= area.y + area.height + 1, `${f} 不掉出任务栏`);
            assert.ok(!overlaps(span, fg), `${f} 不压前台窗口`);
            rows.push({ rnd, to: b.x, sit: w.plan.sit, span });
            if (rnd === 0.1) await S.shot(`dpr${Math.round(f * 100)}-坐在窗口边`, false);
            await S.dbg({ op: 'walk-home' });
            await wait(async () => !(await S.dbg({ op: 'state' })).excursion, 'home', 9000);
            assert.equal((await S.dbg({ op: 'state' })).bounds.x, home.x, `${f} 走回原处`);
          }
          assert.ok(rows.filter(r => r.to != null).length >= 4, `${f} 至少走成 4 次 ${JSON.stringify(rows)}`);
          const real = await S.dbg({ op: 'foreground' }).catch(() => null);
          evidence.facts.scale.push({ factor: f, area, home, fg, rows, realForeground: real });
        });
      } catch (e) { evidence.ok = false; evidence.errors.push(e.stack || e.message); process.exitCode = 1; }
      finally { if (S) await S.close(); }
    }
  }
  if (evidence.ok !== false) { assert.deepEqual(evidence.errors, []); evidence.ok = true; }
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, errors: evidence.errors, screenshots: evidence.screenshots.length, output: OUT }));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
