'use strict';
// 桌宠待办卡片（2026-11-26）真 Hub + CDP，隔离数据、后台窗口：按用户真实路径走一遍——
// 双击桌宠 → 卡片弹出、光标在输入框 → 打字「3点 交周报」回车 → 勾掉一条 → 右键菜单「添加待办…」→
// 记「1分钟后 喝水」→ 到点桌宠气泡带「完成 / 10 分钟后」→ 点「10 分钟后」→ 文件里时间推后。
// 用法：node tests/e2e-pet-todo-cdp.js <输出目录>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'artifacts/pet-todo-e2e'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
async function wait(fn, label, timeout = 25000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error('timeout: ' + label + ' ' + (last && last.message || ''));
}
const targets = base => new Promise((resolve, reject) => {
  http.get(base + '/json/list', res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ev = { version: require('../package.json').version, steps: [], errors: [], screenshots: [] };
  const step = (name, detail) => { ev.steps.push({ name, ...(detail ? { detail } : {}) }); console.log('✓', name, detail ? JSON.stringify(detail) : ''); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-todo-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  // 全新用户：只打开桌宠（介绍说过、单击提示看过，免得气泡挡视线），其他什么都不配。
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, clickHinted: true, role: '01-cat', mode: 'gentle', optInV: 1 }));
  let hub = null;
  const pages = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'pet-todo', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    const mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    await wait(() => dbg({ op: 'state' }), 'pet debug');
    await dbg({ op: 'override', idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false, virtual: true });
    const attach = async (re, label) => {
      const t = await wait(async () => (await targets(hub.cdpHttpBase)).find(x => re.test(x.url)), label);
      const c = await connectCDP(t.webSocketDebuggerUrl); pages.push(c);
      await c.send('Runtime.enable');
      c.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') ev.errors.push(label + ': ' + m.params.exceptionDetails.text); });
      return c;
    };
    const pet = await attach(/hub-pet\/pet\.html/, 'pet');
    const json = (c, expr) => c.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const shot = async (c, name, bg = '#e2e8f0') => {
      await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 226, g: 232, b: 240, a: 1 } });
      await c.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(bg)}`);
      const size = await json(c, '({w: innerWidth, h: innerHeight})');
      const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); ev.screenshots.push(name + '.png');
    };
    const mouse = async (c, x, y, button = 'left') => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
      await sleep(40);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    };
    const center = (c, sel) => json(c, `(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const type = async (c, text) => {
      await c.send('Input.insertText', { text });
      await sleep(250);
      for (const t of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    };
    await sleep(1500);

    // 1. 双击桌宠身体 → 卡片
    const body = await json(pet, `(()=>{const r=document.getElementById('body').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*0.6}})()`);
    await mouse(pet, body.x, body.y); await sleep(120); await mouse(pet, body.x, body.y);
    const card = await attach(/hub-pet\/pet-todo\.html/, 'todo card');
    const cdbg = () => json(card, 'window.__hubPetTodoDebug()');
    await wait(async () => (await card.eval('document.activeElement && document.activeElement.id')) === 'input', 'input focused after double-click');
    assert.equal((await dbg({ op: 'state' })).todoCard.visible, true);
    step('双击桌宠弹出待办卡片，光标在输入框', { rows: (await cdbg()).rows });

    // 2. 一行输入回车
    await card.send('Input.insertText', { text: '3点 交周报' });
    const hint = await wait(async () => (await cdbg()).hint, 'time preview');
    assert.match(hint, /15:00 提醒|明天 15:00 提醒/);
    for (const t of ['keyDown', 'keyUp']) await card.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await wait(async () => (await cdbg()).state.today.concat((await cdbg()).state.later).some(x => x.title === '交周报'), 'added 交周报');
    await type(card, '订周四会议室');
    await type(card, '以后 整理季度材料目录');
    await wait(async () => (await cdbg()).state.later.some(x => x.title === '整理季度材料目录'), 'later item');
    step('输入框回车添加 3 条（识别时间、放进稍后）', { preview: hint });

    // 3. 勾掉一条
    const firstChk = await center(card, '#today .trow .chk');
    await mouse(card, firstChk.x, firstChk.y);
    await wait(async () => (await cdbg()).state.done.length === 1, 'done one');
    const toggle = await center(card, '#tog-done'); await mouse(card, toggle.x, toggle.y);
    const toggle2 = await center(card, '#tog-later'); await mouse(card, toggle2.x, toggle2.y);
    await sleep(300);
    await shot(card, '01-待办卡片');
    const file = await wait(() => findFile(data, 'pet-reminders.json'), 'pet-reminders.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(saved.items.every(x => Number.isFinite(x.at)), 'every item keeps a numeric at (old versions can read it)');
    step('勾选完成；数据写进桌宠提醒文件', { file: path.relative(data, file), items: saved.items.length });

    // 4. 右键菜单
    await card.eval('window.hubPetTodo.act({ type: "close" })');
    await sleep(300);
    await pet.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: body.x, y: body.y, button: 'right', clickCount: 1 });
    await pet.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: body.x, y: body.y, button: 'right', clickCount: 1 });
    const menu = await attach(/hub-pet\/pet-menu\.html/, 'menu');
    const labels = await wait(async () => { const l = await json(menu, `[...document.querySelectorAll('#quick .item .txt')].map(e=>e.textContent)`); return l.length ? l : null; }, 'menu items');
    assert.deepEqual(labels.slice(0, 2), ['添加待办…', '打开待办']);
    await sleep(250);
    await shot(menu, '02-右键菜单');
    const addItem = await center(menu, '#quick .item');
    await mouse(menu, addItem.x, addItem.y);
    await wait(async () => (await card.eval('document.activeElement && document.activeElement.id')) === 'input', 'card from menu');
    step('右键菜单顶部有「添加待办…」「打开待办」，点了弹出卡片', { labels: labels.slice(0, 3) });

    // 5. 到点提醒：记「1分钟后 喝水」，等它到点，气泡上点「10 分钟后」
    await type(card, '1分钟后 喝水');
    await wait(async () => (await cdbg()).state.today.some(x => x.title === '喝水'), 'timed item');
    await card.eval('window.hubPetTodo.act({ type: "close" })');
    const chips = await wait(async () => { const c = await json(pet, `[...document.querySelectorAll('#bubble-chips .chip')].map(e=>e.textContent)`); return c.length ? c : null; }, 'reminder bubble chips', 90000);
    assert.deepEqual(chips, ['完成', '10 分钟后']);
    await sleep(400);
    await shot(pet, '03-到点提醒气泡');
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).items.find(x => x.title === '喝水');
    const snooze = await center(pet, '#bubble-chips .chip:nth-child(2)');
    await mouse(pet, snooze.x, snooze.y);
    const after = await wait(() => { const it = JSON.parse(fs.readFileSync(file, 'utf8')).items.find(x => x.title === '喝水'); return it.at > before.at ? it : null; }, 'snoozed');
    assert.equal(after.deliveredAt, null);
    step('到点桌宠气泡带「完成 / 10 分钟后」，点「10 分钟后」后时间推后', { pushedMin: Math.round((after.at - Date.now()) / 60000) });

    // 6. 设置里关掉「双击记待办」→ 双击打开助理
    await mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', { dblTodo: false })`);
    await sleep(700);
    await mouse(pet, body.x, body.y); await sleep(120); await mouse(pet, body.x, body.y);
    await sleep(600);
    const st = await dbg({ op: 'state' });
    assert.equal(st.dblClick, 'assistant');
    assert.equal(st.todoCard.visible, false, 'card stays closed');
    step('设置关掉「双击记待办」后双击不再弹卡片');
    assert.equal(ev.errors.length, 0, 'no page exceptions: ' + ev.errors.join('; '));
    ev.ok = true;
  } catch (error) {
    ev.ok = false; ev.failure = error.stack || String(error);
    console.error(error);
  } finally {
    for (const c of pages) { try { c.close(); } catch (_) {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(ev, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  process.exitCode = ev.ok ? 0 : 1;
}
main();
