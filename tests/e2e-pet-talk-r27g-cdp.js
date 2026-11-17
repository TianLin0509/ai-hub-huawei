'use strict';
// r27g 桌宠「话术扩充 + 起名 + 一键回应」隔离实测：6 个形象（含 4 个真实下载形象）× 浅色/深色桌面。
// 走用户真实路径：在「助理 → 设置 → 桌宠」里输名字点保存 → 桌宠回一句；闲聊气泡下用真实鼠标事件点回应按钮 → 它回一句、偏好写进 hub-pet.json。
// 另测：鼠标停在带按钮的气泡上不收、安静档/开会/全屏不开口、大小 0.6/1.6 倍时按钮都在窗口里、活泼档到点自然说早安并记住说过的句子。
// 用法：node tests/e2e-pet-talk-r27g-cdp.js <输出目录> [--roles=01-cat,03-penguin]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(REPO, 'artifacts/pet-talk-r27g'));
const ROLE_ARG = (process.argv.find(a => a.startsWith('--roles=')) || '').slice(8);
const ROLES = ROLE_ARG ? ROLE_ARG.split(',') : ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const NAMES = { '01-cat': '小猫', '03-penguin': '企鹅', '05-rabbit': '兔子', '07-shiba': '柴犬', '09-hamster': '仓鼠', '11-cockatiel': '玄凤' };
const CTXS = ['greet', 'sit', 'back', 'done', 'meetingAfter', 'late', 'offwork', 'noon', 'afternoon', 'sitAgain', 'greet', 'back'];
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
  const evidence = { version: require('../package.json').version, roles: ROLES, steps: [], facts: { bubbles: [] }, errors: [], screenshots: [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-r27g-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  let hub, mainPage, pet;
  const step = async (name, fn) => { await fn(); evidence.steps.push(name); console.log('ok', name); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'pet-r27g', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    const settings = patch => mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', ${JSON.stringify(patch)})`);
    const readFile = () => JSON.parse(fs.readFileSync(path.join(data, 'hub-pet.json'), 'utf8'));
    const noon = new Date(); noon.setHours(14, 0, 0, 0);
    await wait(() => dbg({ op: 'state' }), 'debug');
    await dbg({ op: 'override', nowShift: noon.getTime() - Date.now(), idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false });
    const target = await wait(async () => (await targets(hub.cdpHttpBase)).find(t => /hub-pet\/pet\.html/.test(t.url)), 'pet target');
    pet = await connectCDP(target.webSocketDebuggerUrl);
    await pet.send('Runtime.enable');
    pet.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(m.params.exceptionDetails.text); });
    const json = expr => pet.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const debug = () => json('window.__hubPetDebug()');
    const geometry = () => json(`(()=>{const rect=x=>{const r=x.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:r.width,h:r.height}};const b=document.getElementById('bubble');
      const chips=[...document.querySelectorAll('#bubble-chips .chip')].map(c=>{const r=rect(c);const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {...r,label:c.textContent,hit:!!(hit&&hit.closest&&hit.closest('.chip')===c)}});
      const line=document.querySelector('#bubble .bubble-line');
      return {bubble:b.hidden?null:rect(b),chips,clamped:line?line.scrollHeight>line.clientHeight+1:false,body:rect(document.getElementById('body')),edge:window.__hubPetDebug().edge,win:{w:innerWidth,h:innerHeight}}})()`);
    const shot = async (name, dark) => {
      await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: dark ? { r: 27, g: 31, b: 42, a: 1 } : { r: 226, g: 232, b: 240, a: 1 } });
      // 透明窗口截图不带桌面：只在测试里给页面刷一层「桌面色」。
      await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(dark ? '#1b1f2a' : '#e2e8f0')}`);
      await sleep(160);
      const size = await json('({w: innerWidth, h: innerHeight})');
      const r = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); evidence.screenshots.push(name + '.png');
    };
    const mouse = async (type, x, y) => pet.send('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(80); await mouse('mousePressed', x, y); await sleep(60); await mouse('mouseReleased', x, y); await sleep(400); };
    const clearBubble = async () => { await pet.eval('window.hubPet.dismiss()'); await sleep(450); };
    const clearDots = async () => {
      await dbg({ op: 'click', target: 'dot' }); await sleep(250);
      await pet.eval(`(()=>{const b=document.getElementById('panel-close'); if (!document.getElementById('panel').hidden) b.click();})()`); await sleep(200);
    };
    // 气泡和按钮都在窗口里、在看得见的那一段里；按钮点得到（elementFromPoint 落在按钮上）；文字没被截断。
    // 气泡出场有一小段放大动画：等两次量到的位置一致再量，不然点的位置会偏到气泡正文上（单击气泡＝收起）。
    const stableGeometry = async () => { let a = await geometry(); for (let k = 0; k < 20; k++) { await sleep(120); const b = await geometry(); if (JSON.stringify(b.bubble) === JSON.stringify(a.bubble)) return b; a = b; } return a; };
    const checkBubble = async label => {
      const g = await stableGeometry();
      assert.ok(g.bubble, label + ' 气泡在');
      const visL = (Number(g.edge && g.edge.left) || 0), visR = g.win.w - (Number(g.edge && g.edge.right) || 0);
      assert.ok(g.bubble.top >= 0 && g.bubble.left >= visL - 1 && g.bubble.right <= visR + 1, label + ' 气泡在可见段里 ' + JSON.stringify({ b: g.bubble, visL, visR }));
      assert.ok(g.bubble.bottom <= g.body.top + g.body.h * 0.35, label + ' 气泡不压脸 ' + JSON.stringify({ b: g.bubble, body: g.body }));
      for (const c of g.chips) {
        assert.ok(c.left >= g.bubble.left && c.right <= g.bubble.right + 0.5 && c.bottom <= g.bubble.bottom + 0.5, label + ' 按钮在气泡里 ' + c.label);
        assert.ok(c.hit, label + ' 按钮点得到 ' + c.label);
      }
      assert.equal(g.clamped, false, label + ' 文字没被三行上限截断');
      return g;
    };

    await step('实际下载 4 个在线形象', async () => {
      const got = {};
      for (const id of ROLES.filter(r => !['01-cat', '03-penguin'].includes(r))) {
        const role = await mainPage.eval(`ipcRenderer.invoke('hub-pet:role-download',${JSON.stringify(id)}).then(s => s.roles.find(r => r.id === ${JSON.stringify(id)}))`, { timeoutMs: 180000 });
        assert.equal(role?.installed, true, id + ' installed');
        got[id] = { installed: role.installed, bundled: role.bundled };
      }
      evidence.facts.downloaded = got;
    });

    await step('设置页起名：输入名字点保存，桌宠回一句；设置页 1440 宽不出纵向滚动', async () => {
      await mainPage.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await mainPage.eval(`window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { settingsTab: 'pet' } }))`);
      await wait(() => mainPage.eval(`!!document.querySelector('.pet-tab input[data-pet-name]')`), 'pet tab name input', 30000);
      await sleep(500);
      await mainPage.eval(`(()=>{const el=document.querySelector('.pet-tab input[data-pet-name]');el.focus();el.value='团子';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.pet-tab [data-pet="saveName"]').click();})()`);
      const b = await wait(async () => { const d = await debug(); return /团子/.test(d.bubbleText || '') ? d : null; }, 'rename ack', 8000);
      evidence.facts.renameAck = b.bubbleText;
      assert.equal(b.bubbleText, '好，以后我就叫「团子」了。');
      assert.equal(readFile().petName, '团子');
      await shot('00-起名后回一句-浅', false);
      await sleep(400);
      evidence.facts.settingsScroll = await mainPage.eval(`(()=>{const tab=document.querySelector('.pet-tab');const out=[];for(let e=tab;e&&e!==document.documentElement;e=e.parentElement){const cs=getComputedStyle(e);if(/(auto|scroll)/.test(cs.overflowY)&&e.scrollHeight>e.clientHeight+1)out.push({cls:String(e.className).slice(0,60),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight});}
        const r=document.querySelector('.pet-tab input[data-pet-name]').getBoundingClientRect();return {overflow:out,nameInput:{top:r.top,bottom:r.bottom},viewport:innerHeight,tabHeight:tab.scrollHeight}})()`);
      const ss = await mainPage.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, '00-设置页-名字.png'), Buffer.from(ss.data, 'base64')); evidence.screenshots.push('00-设置页-名字.png');
      await clearBubble();
    });

    let i = Number(process.env.R27G_CTX_OFFSET) || 0;
    for (const role of ROLES) for (const dark of [false, true]) {
      const tag = NAMES[role] + '-' + (dark ? '深' : '浅');
      const ctx = CTXS[i % CTXS.length]; i++;
      await step(tag + '：' + ctx + ' 闲聊气泡带回应按钮，真实鼠标点按钮', async () => {
        await settings({ role, scale: 1, mode: 'lively' });
        await wait(async () => (await dbg({ op: 'state' })).lastSent?.role === role, 'role ' + role);
        await sleep(900);
        const line = await dbg({ op: 'talk', ctx });
        assert.ok(line && line.text, ctx + ' 挑到句子');
        const d = await wait(async () => { const x = await debug(); return x.bubble && x.chips.length === 2 ? x : null; }, tag + ' bubble with chips', 6000);
        const g = await checkBubble(tag);
        const fact = { role, dark, ctx, text: d.bubbleText, tag: d.bubbleTag, chips: d.chips, bubbleH: Math.round(g.bubble.h), bubbleW: Math.round(g.bubble.w) };
        if (!line.named) assert.equal(d.bubbleTag, '团子', '没带名字的句子小标签写名字');
        else assert.match(d.bubbleText, /团子/);
        await shot(`${role}-${dark ? 'dark' : 'light'}-01-${ctx}`, dark);
        // 点第一个按钮（喜欢）或第二个（少说 / 再等 20 分钟），轮着点
        const pick = g.chips[i % 2];
        const before = readFile().talkPrefs || {};
        await pet.eval(`window.__r27gLog=[];if(!window.__r27gHook){window.__r27gHook=1;['pointerdown','click'].forEach(t=>document.addEventListener(t,e=>{const n=e.target&&e.target.closest&&e.target.closest('[data-hit]');window.__r27gLog.push(t+':'+(n?n.getAttribute('data-hit'):'-')+':'+(e.target.className||e.target.tagName)+'@'+Math.round(e.clientX)+','+Math.round(e.clientY))},true))};`);
        const g2 = await stableGeometry();
        const pick2 = g2.chips.find(c => c.label === pick.label) || pick;
        evidence.facts.clickGeo = evidence.facts.clickGeo || []; evidence.facts.clickGeo.push({ tag, before: pick, now: pick2 });
        await clickAt((pick2.left + pick2.right) / 2, (pick2.top + pick2.bottom) / 2);
        const after = await wait(async () => { const x = await debug(); return x.bubbleText && x.bubbleText !== d.bubbleText ? x : null; }, tag + ' ack', 4000)
          .catch(async e => { throw Error(e.message + ' ' + JSON.stringify({ pick, now: await debug(), main: (await dbg({ op: 'state' })).lastSent, log: await json('window.__r27gLog') })); });
        fact.clicked = pick.label; fact.ack = after.bubbleText;
        assert.equal(after.chips.length, 0, '回应那句没有按钮');
        const prefs = readFile().talkPrefs;
        fact.prefs = prefs[line.type];
        if (/再等/.test(pick.label)) assert.match(after.bubbleText, /20 分钟/);
        else assert.notDeepEqual(prefs[line.type], before[line.type], '偏好写进了 hub-pet.json');
        await shot(`${role}-${dark ? 'dark' : 'light'}-02-回应后`, dark);
        evidence.facts.bubbles.push(fact);
        await clearBubble(); await clearDots();
        await mouse('mouseMoved', 2, 2);
      });
    }

    await step('鼠标停在带按钮的气泡上 10 秒不收，移开 2.5 秒后才收', async () => {
      await settings({ role: '01-cat', scale: 1 });
      await sleep(600);
      await dbg({ op: 'talk', ctx: 'back' });
      await wait(async () => (await debug()).chips.length === 2, 'bubble', 5000);
      const g = await stableGeometry();
      await mouse('mouseMoved', g.bubble.left + 12, g.bubble.top + 10);
      await sleep(10000);
      const held = await debug();
      assert.ok(held.bubble, '停着不收');
      await mouse('mouseMoved', 2, 2);
      await sleep(1500);
      assert.ok((await debug()).bubble, '移开后至少再留 2.5 秒');
      await wait(async () => !(await debug()).bubble, 'bubble gone', 11000);   // 移开后恢复悬停前剩下的时间（至少 2.5 秒）
      evidence.facts.hold = { heldAfter10s: true };
      await clearDots();
    });

    await step('大小 0.6 / 1.6 倍：气泡和按钮都在窗口里、点得到', async () => {
      evidence.facts.scales = {};
      for (const scale of [0.6, 1.6]) {
        await settings({ role: '05-rabbit', scale });
        await sleep(900);
        await dbg({ op: 'talk', ctx: 'sit' });
        await wait(async () => (await debug()).chips.length === 2, 'bubble ' + scale, 5000);
        const g = await checkBubble('scale ' + scale);
        evidence.facts.scales[scale] = { bubble: g.bubble, chips: g.chips.map(c => c.label) };
        await shot('scale-' + scale + '-sit', false);
        await clearBubble(); await clearDots();
      }
      await settings({ scale: 1 });
    });

    await step('安静档、开会、全屏：闲聊不开口（进小圆点或不说），规则不变', async () => {
      const res = {};
      await settings({ mode: 'quiet' }); await sleep(400);
      await dbg({ op: 'talk', ctx: 'greet' }); await sleep(600);
      res.quiet = (await debug()).bubble; assert.ok(!res.quiet, '安静档不开口');
      await clearDots();
      await settings({ mode: 'lively' });
      await dbg({ op: 'override', meeting: true }); await sleep(400);
      await dbg({ op: 'talk', ctx: 'greet' }); await sleep(600);
      res.meeting = (await debug()).bubble; assert.ok(!res.meeting, '开会不开口');
      await dbg({ op: 'override', meeting: false }); await clearDots(); await clearBubble();   // 点小圆点会把收着的那句重新说一遍，先收掉
      await dbg({ op: 'override', fullscreen: true }); await sleep(600);
      await dbg({ op: 'talk', ctx: 'greet' }); await sleep(600);
      res.fullscreen = (await debug()).bubble; assert.ok(!res.fullscreen, '全屏不开口 ' + JSON.stringify((await debug()).bubbleText));
      await dbg({ op: 'override', fullscreen: false }); await sleep(800); await clearDots();
      evidence.facts.quietRules = res;
    });

    await step('活泼档到点自然说：周一早上 9 点说早安，说过的句子记进 hub-pet.json', async () => {
      await settings({ resetTalk: true });
      const mon = new Date(); mon.setDate(mon.getDate() + ((8 - mon.getDay()) % 7 || 7)); mon.setHours(9, 0, 0, 0);
      await dbg({ op: 'override', nowShift: mon.getTime() - Date.now(), idleSec: 0 });
      const d = await wait(async () => { const x = await debug(); return x.bubble && x.chips.length ? x : null; }, 'natural greet', 8000);
      const st = await dbg({ op: 'state' });
      assert.match(st.lastSent.bubble.id, /^chatter-greet-/);
      const recent = readFile().talkRecent;
      assert.equal(recent.length, 1); assert.match(recent[0], /^greet-/);
      evidence.facts.natural = { text: d.bubbleText, tag: d.bubbleTag, id: st.lastSent.bubble.id, recent };
      await shot('natural-monday-greet', false);
    });
    evidence.ok = evidence.errors.length === 0;
    if (!evidence.ok) process.exitCode = 1;
  } catch (e) {
    evidence.ok = false; evidence.error = e.stack; process.exitCode = 1;
  } finally {
    if (pet) pet.close();
    if (mainPage) mainPage.close();
    if (hub) evidence.cleanup = await gracefulQuit(hub);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, shots: evidence.screenshots.length, errors: evidence.errors, error: evidence.error, out: OUT }));
  }
}
main();
