'use strict';
// Isolated, offscreen desktop-pet regression. Events are fixtures; real error production is covered by unit-hub-pet-notify.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'artifacts/pet-fixes'));
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
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const evidence = { version: require('../package.json').version, steps: [], facts: {}, errors: [], screenshots: [], fixtures: true };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-fixes-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: false, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  const { Profile } = require('../core/profile/service');
  const p = new Profile({ dataDir: data, saveDelayMs: 1e9 });
  p.state.xp = 21000; p.state.lastLevel = require('../core/profile/rules').levelOf(p.state.xp);
  p.state.backfill = { at: Date.now(), days: 0, sessions: 0 }; p.save();
  let hub, mainPage, pet;
  const step = async (name, fn) => { await fn(); evidence.steps.push(name); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'pet-fixes', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    const settings = patch => mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', ${JSON.stringify(patch)})`);
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    await wait(() => dbg({ op: 'state' }), 'debug');
    await dbg({ op: 'override', nowShift: noon.getTime() - Date.now(), idleSec: 0, running: 0, fullscreen: false, meeting: false });
    const target = await wait(async () => (await targets(hub.cdpHttpBase)).find(t => /hub-pet\/pet\.html/.test(t.url)), 'pet target');
    pet = await connectCDP(target.webSocketDebuggerUrl);
    await pet.send('Runtime.enable');
    pet.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(m.params.exceptionDetails.text); });
    const json = expr => pet.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const shot = async (name, dark = false) => {
      await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: dark ? { r: 27, g: 31, b: 42, a: 1 } : { r: 226, g: 232, b: 240, a: 1 } });
      // Transparent Electron windows ignore the CDP default background in screenshots; paint a test-only desktop backdrop.
      await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(dark ? '#1b1f2a' : '#e2e8f0')}`);
      await sleep(180);
      const size = await json('({w: innerWidth, h: innerHeight})');
      const r = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
      const file = name + '.png'; fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64')); evidence.screenshots.push(file);
    };
    const click = async selector => {
      const r = await json(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await pet.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 });
      await sleep(60);
      await pet.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 });
      await sleep(400);
    };
    const dismiss = async () => { await pet.eval('window.hubPet.dismiss()'); await sleep(400); };
    await step('首次介绍完整可读，实际点气泡后就地收起', async () => {
      await wait(async () => (await dbg({ op: 'state' }))?.lastSent?.bubble?.id === 'intro', 'intro', 20000);
      await sleep(500);
      const intro = await json(`(()=>{const e=document.getElementById('bubble'),s=document.getElementById('bubble-text'),r=document.createRange();r.selectNodeContents(s);const b=e.getBoundingClientRect();return {text:s.textContent,lines:[...r.getClientRects()].map(x=>({top:x.top,bottom:x.bottom})),bottom:b.bottom,top:b.top,clamp:getComputedStyle(e).webkitLineClamp}})()`);
      evidence.facts.intro = intro;
      assert.match(intro.text, /点击确认/);
      assert.ok(intro.lines.every(r => r.top >= intro.top && r.bottom <= intro.bottom), 'intro text must be inside bubble');
      await shot('01-首次介绍-完整确认');
      await click('#bubble');
      assert.equal(await pet.eval('document.getElementById("panel").hidden'), true);
      assert.equal((await dbg({ op: 'state' })).lastSent.bubble, null);
      await shot('02-首次介绍点击-就地收起');
    });
    await step('等你回复保持待机，完成通知仍欢呼', async () => {
      await dbg({ op: 'notice', notice: { id: 'wait-fix', kind: 'awaiting-reply', title: '有 2 个人在等你回复' } });
      assert.equal((await dbg({ op: 'state' })).lastSent.pose, 'idle');
      await sleep(500); await shot('03-等你回复-待机'); await dismiss();
      await dbg({ op: 'notify', payload: { sessionId: 'done-fixture', title: '会话答完了', body: '结果已整理好。', completedAt: Date.now() } });
      assert.equal((await dbg({ op: 'state' })).lastSent.pose, 'happy');
      await sleep(600); await shot('04-完成回执-欢呼'); await dismiss();
    });
    await step('错误卡片抬头为出错了，收起后的面板也保留错误抬头', async () => {
      await dbg({ op: 'notice', notice: { id: 'answer:error-fixture', kind: 'answer', notify: true, page: 'assistant', tone: 'bad', err: true, title: '助理这一问没答完：今天的会', text: '助理会话超时，可到助理页重问。' } });
      assert.equal((await dbg({ op: 'state' })).lastSent.pose, 'tired');
      assert.equal(await pet.eval('document.getElementById("ncard-kind").textContent'), '出错了');
      await sleep(500); await shot('05-真实错误格式-出错了');
      // Let the actual timeout put the card into the dot queue.
      await pet.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await wait(async () => !(await dbg({ op: 'state' })).lastSent.bubble, 'card timeout', 15000);
      await click('#dot');
      assert.match(await pet.eval('document.getElementById("panel-list").textContent'), /出错了/);
      await shot('06-错误历史面板');
      await pet.eval('document.getElementById("panel-close").click()');
    });
    await step('普通坏消息沿用类别抬头，不误报执行错误', async () => {
      evidence.facts.warningLabels = [];
      for (const [kind, title, expected] of [['attendance', '该走了', '考勤'], ['w3', '待办已超期', '通知'], ['room', '会议室需要重新登录', '会议室']]) {
        await dbg({ op: 'notice', notice: { id: 'warning:' + kind, kind, title, notify: true, tone: 'bad', err: false } });
        const label = await pet.eval('document.getElementById("ncard-kind").textContent');
        assert.equal(label, expected); evidence.facts.warningLabels.push({ kind, title, label });
        await shot('06b-警示不是错误-' + kind); await dismiss();
      }
      // Disk warnings enter the controller directly from disk-watch, not through NoticeBus.
      const { label } = require('../renderer/hub-pet/pet-notices');
      assert.equal(label({ kind: 'disk', tone: 'bad', title: '硬盘已用 90%' }), '硬盘');
    });
    await step('闲聊气泡实际点击后不展开助理面板', async () => {
      // Chatter is generated internally, not published on NoticeBus. Use the real lunch-time path.
      await settings({ mode: 'lively' });
      await wait(async () => (await dbg({ op: 'state' })).lastSent.bubble?.kind === 'chatter', 'chatter');
      await shot('07-闲聊'); await click('#bubble');
      assert.equal(await pet.eval('document.getElementById("panel").hidden'), true);
      assert.equal((await dbg({ op: 'state' })).lastSent.bubble, null);
      await shot('08-闲聊点击-就地收起');
    });
    await step('会话标签位于身体和头饰外侧，覆盖两种内置形象及三档大小', async () => {
      await dbg({ op: 'override', running: 2 });
      evidence.facts.busy = [];
      for (const role of ['01-cat', '03-penguin']) for (const scale of [0.7, 1, 1.6]) {
        await settings({ role, scale }); await sleep(900);
        const g = await json(`(()=>{const b=document.getElementById('body').getBoundingClientRect(),r=document.getElementById('busy').getBoundingClientRect(),h=document.getElementById('evolve-head').getBoundingClientRect();const rect=x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom});return {body:rect(b),busy:rect(r),head:rect(h),state:window.__hubPetDebug?.()}})()`);
        const outside = (a, b) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
        assert.ok(outside(g.busy, g.body), 'busy must not overlap the body canvas or animated tail');
        assert.ok(outside(g.busy, g.head), 'busy must not overlap headpiece');
        assert.ok(g.busy.left >= -1 && g.busy.right <= 281, 'busy inside window');
        const side = (280 - 150 * scale) / 2, width = g.busy.right - g.busy.left;
        const visL = (g.state.edge.left || 0) + 6, visR = 280 - (g.state.edge.right || 0) - 6;
        if (side - width - 8 < visL && side + 150 * scale + 8 + width > visR) {
          assert.ok(Math.abs(g.busy.left - visL) < 1, 'two-side fallback anchors to the visible outer edge');
          assert.ok(g.busy.bottom < g.body.top, 'two-side fallback is above the whole body canvas');
          g.fallbackVerified = true;
        }
        evidence.facts.busy.push({ role, scale, ...g });
        await shot(`09-外侧标签-${role}-${scale}`);
      }
      await dbg({ op: 'override', running: 0 });
      assert.ok(evidence.facts.busy.some(g => g.fallbackVerified), 'must exercise both sides too narrow');
    });
    await step('深浅背景下的淡描边对照，滤镜仅作用于形象', async () => {
      await settings({ role: '03-penguin', scale: 1, showGrowth: false }); await sleep(900);
      const filter = await pet.eval('getComputedStyle(document.getElementById("layers")).filter');
      assert.match(filter, /drop-shadow/); evidence.facts.outlineFilter = filter;
      for (const dark of [false, true]) {
        await pet.eval('document.getElementById("layers").style.filter="none"');
        await shot('10-企鹅-描边前-' + (dark ? '深' : '浅'), dark);
        await pet.eval('document.getElementById("layers").style.filter=""');
        await shot('11-企鹅-描边后-' + (dark ? '深' : '浅'), dark);
      }
    });
    await step('实际下载兔子形象并验证深浅背景描边', async () => {
      const role = await mainPage.eval(`ipcRenderer.invoke('hub-pet:role-download','05-rabbit').then(s => s.roles.find(r => r.id === '05-rabbit'))`, { timeoutMs: 120000 });
      assert.equal(role?.installed, true, 'downloaded rabbit installed');
      assert.equal(role.bundled, false, 'must use a downloadable character'); evidence.facts.downloadedRole = role;
      await settings({ role: '05-rabbit', scale: 1, mode: 'gentle', showGrowth: false }); await sleep(900);
      assert.match((await dbg({ op: 'state' })).role, /05-rabbit/);
      for (const dark of [false, true]) {
        await pet.eval('document.getElementById("layers").style.filter="none"');
        await shot('12-下载兔子-描边前-' + (dark ? '深' : '浅'), dark);
        await pet.eval('document.getElementById("layers").style.filter=""');
        await shot('13-下载兔子-描边后-' + (dark ? '深' : '浅'), dark);
      }
    });
    if (!process.argv.includes('--skip-perf')) await step('打字态描边前后 CPU 交错采样', async () => {
      await settings({ role: '03-penguin', scale: 1, mode: 'gentle', showGrowth: false });
      await dbg({ op: 'override', running: 2 }); await sleep(900);
      const samples = [];
      // A/B/B/A, 12 samples per condition. Both renderer and shared GPU CPU use Electron's one-core percent convention.
      for (const outline of [false, true, true, false]) {
        await pet.eval(`document.getElementById('layers').style.filter=${JSON.stringify(outline ? '' : 'none')}`);
        await sleep(1500); await dbg({ op: 'metrics' });
        for (let n = 0; n < 6; n++) {
          await sleep(1000); const m = await dbg({ op: 'metrics' });
          const renderer = m.find(x => x.type === 'Tab'), gpu = m.find(x => x.type === 'GPU');
          assert.ok(renderer && Number.isFinite(renderer.cpu), 'must receive actual pet renderer CPU');
          samples.push({ outline, renderer: renderer.cpu, gpu: gpu && Number.isFinite(gpu.cpu) ? gpu.cpu : null });
        }
      }
      const summary = outline => {
        const rows = samples.filter(x => x.outline === outline), avg = k => { const values = rows.map(x => x[k]).filter(Number.isFinite); return values.length ? values.reduce((s, x) => s + x, 0) / values.length : null; };
        return { samples: rows.length, rendererMean: avg('renderer'), rendererMax: Math.max(...rows.map(x => x.renderer)), gpuMean: avg('gpu') };
      };
      evidence.facts.typingCpu = { order: 'off/on/on/off', units: 'Electron CPU percent, one core', role: '03-penguin', scale: 1, before: summary(false), after: summary(true), samples };
      await pet.eval('document.getElementById("layers").style.filter=""'); await dbg({ op: 'override', running: 0 });
    });
    evidence.facts.final = await dbg({ op: 'state' });
    assert.deepEqual(evidence.errors, []);
    evidence.ok = true;
  } catch (e) { evidence.ok = false; evidence.errors.push(e.stack || e.message); process.exitCode = 1; }
  finally {
    if (pet) pet.close(); if (mainPage) mainPage.close();
    if (hub) evidence.cleanup = await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, steps: evidence.steps, errors: evidence.errors, screenshots: evidence.screenshots.length, output: OUT }));
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
