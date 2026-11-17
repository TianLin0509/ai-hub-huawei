'use strict';
// r27f3 返工回归（真 Hub + CDP，隔离数据）：6 个形象 × 大小 0.6/1/1.6 × 贴左/贴右 × 状态灯 1/7/20 盏（合并的点开展开），
// 鼠标在身上停到快捷钮冒出后，用 elementFromPoint 逐盏核对「灯的中心点下去点中的是这盏灯本身」，并核快捷钮不出可见段。
// 起因：m96 复审发现企鹅 0.6 倍贴左、展开 20 盏时快捷钮盖住第 1、19 盏灯中心。
// 用法：node tests/e2e-pet-quick-lamps-r27f3-cdp.js <输出目录> [--roles=01-cat,03-penguin]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(REPO, 'artifacts/pet-quick-lamps-r27f3'));
const ROLE_ARG = (process.argv.find(a => a.startsWith('--roles=')) || '').slice(8);
const ROLES = ROLE_ARG ? ROLE_ARG.split(',') : ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const BUNDLED = ['01-cat', '03-penguin'];
const SCALES = [0.6, 1, 1.6], SIDES = ['left', 'right'], COUNTS = [1, 7, 20];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
async function wait(fn, label, timeout = 25000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(120); }
  throw new Error('timeout: ' + label + ' ' + (last && last.message || ''));
}
const targets = base => new Promise((resolve, reject) => {
  http.get(base + '/json/list', res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
});

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const evidence = { version: require('../package.json').version, roles: ROLES, cases: [], failures: [], errors: [], screenshots: [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-r27f3-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  let hub = null, pet = null, mainPage = null;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'pet-r27f3', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    const settings = patch => mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', ${JSON.stringify(patch)})`);
    await wait(() => dbg({ op: 'state' }), 'debug');
    // 隔离窗口压在屏幕外：打开 virtual，以控制器自己放的位置当窗口位置；贴边宽度仍由主进程按真实身体边距算（不伪造 edge）。
    await dbg({ op: 'override', idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false, virtual: true });
    const target = await wait(async () => (await targets(hub.cdpHttpBase)).find(t => /hub-pet\/pet\.html/.test(t.url)), 'pet target');
    pet = await connectCDP(target.webSocketDebuggerUrl);
    await pet.send('Runtime.enable');
    pet.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(m.params.exceptionDetails.text); });
    const json = expr => pet.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const debug = () => json('window.__hubPetDebug()');
    const mouse = (x, y) => pet.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await pet.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
    const shot = async name => {
      await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 226, g: 232, b: 240, a: 1 } });
      await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor='#e2e8f0'`);
      const size = await json('({w: innerWidth, h: innerHeight})');
      const r = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); evidence.screenshots.push(name + '.png');
    };

    for (const id of ROLES.filter(r => !BUNDLED.includes(r))) {
      const role = await mainPage.eval(`ipcRenderer.invoke('hub-pet:role-download',${JSON.stringify(id)}).then(s => s.roles.find(r => r.id === ${JSON.stringify(id)}))`, { timeoutMs: 180000 });
      assert.equal(role?.installed, true, id + ' installed');
    }

    for (const role of ROLES) for (const scale of SCALES) {
      await settings({ role, scale, mode: 'gentle' }); await sleep(1200);
      for (let i = 0; i < 3; i++) { await pet.eval('window.hubPet.dismiss()'); await sleep(250); }
      for (const side of SIDES) for (const n of COUNTS) {
        const label = `${role} ×${scale} 贴${side === 'left' ? '左' : '右'} ${n}灯`;
        try {
          await mouse(1, 1); await sleep(800);   // 先离开身体，收起上一组的快捷钮
          const s = await dbg({ op: 'state' });
          const x = side === 'left' ? s.area.x - s.inset.left : s.area.x + s.area.width - 280 + s.inset.right;
          await dbg({ op: 'move', pos: { x, y: s.bounds.y } });
          const sessions = Array.from({ length: n }, (_, i) => ({ id: `r27f3-${n}-${i}`, title: '会话 ' + (i + 1) }));
          await dbg({ op: 'override', sessions, running: n }); await sleep(600);
          // 超过 6 盏先合并；上一组点开的展开 8 秒后自己收起——等它回到合并，再真点一次展开，保证量的时候是刚展开的全部灯
          let lamps = await wait(async () => { const d = await debug(); return d.lamps && (n > 6 ? d.lamps.merged : d.lamps.items.length === n) && d.lamps; }, 'lamps ' + label, 10000);
          if (lamps.merged) {
            const c = await json('(()=>{const r=document.getElementById("lamps").getBoundingClientRect();return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2}})()');
            await click(c.x, c.y);
            lamps = await wait(async () => { const d = await debug(); return d.lamps && !d.lamps.merged && d.lamps.items.length === n && d.lamps; }, 'expand ' + label, 4000);
          }
          const center = await json('(()=>{const r=document.getElementById("body").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.6}})()');
          await mouse(center.x, center.y); await sleep(200); await mouse(center.x + 2, center.y);
          const quickShown = !!(await wait(async () => (await debug()).quick, 'quick ' + label, 3000).catch(() => null));
          await sleep(350);   // 冒出动画走完
          const g = await json(`(()=>{const R=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
            const lamp=document.getElementById('lamps'),q=document.getElementById('quick');
            const items=[...lamp.querySelectorAll('[data-lamp]')].map((e,i)=>{const r=e.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,h=document.elementFromPoint(x,y);
              return {i,x,y,hit:!!(h&&h.closest&&h.closest('[data-lamp]')===e),top:h?(h.id||h.className||h.tagName):null}});
            return {lamps:R(lamp),quick:q.hidden||getComputedStyle(q).visibility==='hidden'?null:R(q),col:q.classList.contains('col'),items,win:{w:innerWidth,h:innerHeight}}})()`);
          const edge = (await dbg({ op: 'state' })).edge || {};
          const blocked = g.items.filter(i => !i.hit);
          const qOut = g.quick && (g.quick.left < (edge.left || 0) - 0.5 || g.quick.right > g.win.w - (edge.right || 0) + 0.5 || g.quick.top < -0.5 || g.quick.bottom > g.win.h + 0.5);
          const rec = { role, scale, side, n, edge, lampsCount: g.items.length, quickShown: !!g.quick, col: g.col, blocked, quickOutOfView: !!qOut, quick: g.quick, lamps: g.lamps };
          evidence.cases.push(rec);
          if (g.items.length !== n || blocked.length || qOut || !quickShown) evidence.failures.push({ label, lampsCount: g.items.length, blocked, quickOutOfView: !!qOut, quickShown });
          if (n === 20 && (role === '03-penguin' || role === '01-cat') && scale !== 1) await shot(`${role}-${scale}x-${side}-20灯-快捷钮`);
        } catch (e) { evidence.failures.push({ label, error: e.message }); }
      }
    }
  } catch (e) { evidence.errors.push(e.stack || String(e)); }
  finally {
    try { pet && pet.close(); } catch (_) {} try { mainPage && mainPage.close(); } catch (_) {}
    if (hub) evidence.cleanup = await gracefulQuit(hub);
    evidence.summary = { cases: evidence.cases.length, lampsChecked: evidence.cases.reduce((a, c) => a + c.lampsCount, 0), blockedLamps: evidence.cases.reduce((a, c) => a + c.blocked.length, 0),
      quickShown: evidence.cases.filter(c => c.quickShown).length, quickCol: evidence.cases.filter(c => c.col).length, failures: evidence.failures.length, errors: evidence.errors.length };
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ summary: evidence.summary, failures: evidence.failures.slice(0, 10), errors: evidence.errors.slice(0, 3), out: OUT }));
    if (evidence.failures.length || evidence.errors.length) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
