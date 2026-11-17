'use strict';
// r27c 桌宠「状态一眼分清」隔离实测：6 个形象（含 4 个真实下载形象）× 浅色/深色桌面，逐类事件截图并断言道具、状态灯、分色小圆点。
// 事件用调试入口注入（会话答完、等你回复、出错、新版本、硬盘、开会、额度低）；安静档、全屏躲边规则一并回归。
// r27d（2026-11-17）追加：点当前灯、安静档、7/20/30 灯展开可点（贴边/大尺寸）、道具随大小重算、系统缩放 100/150/225% 截图矩阵。
// 用法：node tests/e2e-pet-status-r27c-cdp.js <输出目录> [--roles=01-cat,03-penguin]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage, connectCDP } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(REPO, 'artifacts/pet-status-r27c'));
const ROLE_ARG = (process.argv.find(a => a.startsWith('--roles=')) || '').slice(8);
const ROLES = ROLE_ARG ? ROLE_ARG.split(',') : ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const NAMES = { '01-cat': '小猫', '03-penguin': '企鹅', '05-rabbit': '兔子', '07-shiba': '柴犬', '09-hamster': '仓鼠', '11-cockatiel': '玄凤' };
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
const RUN3 = [{ id: 'run-a', title: '登录页改版' }, { id: 'run-b', title: '回归测试' }, { id: 'run-c', title: '周报草稿' }];
const RUN8 = Array.from({ length: 8 }, (_, i) => ({ id: 'run-' + i, title: '会话 ' + (i + 1) }));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const evidence = { version: require('../package.json').version, roles: ROLES, steps: [], facts: { shots: [] }, errors: [], screenshots: [], fixtures: true };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pet-r27c-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  // 等级高一点：头上有头饰，验证头顶道具会让开头饰。
  const { Profile } = require('../core/profile/service');
  const p = new Profile({ dataDir: data, saveDelayMs: 1e9 });
  p.state.xp = 21000; p.state.lastLevel = require('../core/profile/rules').levelOf(p.state.xp);
  p.state.backfill = { at: Date.now(), days: 0, sessions: 0 }; p.save();
  let hub, mainPage, pet, seq = 0;
  const step = async (name, fn) => { await fn(); evidence.steps.push(name); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'pet-r27c', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    } });
    mainPage = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => mainPage.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    const settings = patch => mainPage.eval(`ipcRenderer.invoke('hub-pet:set-settings', ${JSON.stringify(patch)})`);
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    await wait(() => dbg({ op: 'state' }), 'debug');
    await dbg({ op: 'override', nowShift: noon.getTime() - Date.now(), idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false });
    const target = await wait(async () => (await targets(hub.cdpHttpBase)).find(t => /hub-pet\/pet\.html/.test(t.url)), 'pet target');
    pet = await connectCDP(target.webSocketDebuggerUrl);
    await pet.send('Runtime.enable');
    pet.ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.errors.push(m.params.exceptionDetails.text); });
    const json = expr => pet.eval(`JSON.stringify(${expr})`).then(JSON.parse);
    const debug = () => json('window.__hubPetDebug()');
    const geometry = () => json(`(()=>{const rect=x=>{const r=x.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}};const c=document.getElementById('ncard');return {body:rect(document.getElementById('body')),card:c.hidden?null:rect(c),win:{w:innerWidth,h:innerHeight}}})()`);
    const shot = async (name, dark) => {
      await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: dark ? { r: 27, g: 31, b: 42, a: 1 } : { r: 226, g: 232, b: 240, a: 1 } });
      // 透明窗口截图不带桌面：只在测试里给页面刷一层「桌面色」。
      await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(dark ? '#1b1f2a' : '#e2e8f0')}`);
      await sleep(160);
      const size = await json('({w: innerWidth, h: innerHeight})');
      const r = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); evidence.screenshots.push(name + '.png');
    };
    const clickAt = async (x, y) => {
      await pet.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(80);
      await pet.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await pet.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(400);
    };
    const dismiss = async () => { await pet.eval('window.hubPet.dismiss()'); await sleep(450); };
    const clearDots = async () => {
      await dbg({ op: 'click', target: 'dot' }); await sleep(250);
      await pet.eval(`(()=>{const b=document.getElementById('panel-close'); if (!document.getElementById('panel').hidden) b.click();})()`); await sleep(200);
    };
    // 道具都在窗口里、贴着身体（离身体方框不超过 40px）。
    const checkProp = async (expect, label) => {
      const d = await wait(async () => { const x = await debug(); return x.prop === expect && x.propRects.length ? x : null; }, label + ' prop ' + expect, 6000);
      const g = await geometry();
      for (const r of d.propRects) {
        assert.ok(r.left >= -2 && r.right <= g.win.w + 2 && r.top >= -2 && r.bottom <= g.win.h + 2, label + ' 道具在窗口里 ' + JSON.stringify(r));
        if (g.card) {
          const ox = Math.max(0, Math.min(r.right, g.card.right) - Math.max(r.left, g.card.left)), oy = Math.max(0, Math.min(r.bottom, g.card.bottom) - Math.max(r.top, g.card.top));
          assert.ok(ox * oy <= 0.15 * (r.right - r.left) * (r.bottom - r.top), label + ' 道具没被卡片盖住 ' + JSON.stringify({ r, card: g.card }));
        }
        assert.ok(r.right >= g.body.left - 40 && r.left <= g.body.right + 40 && r.bottom >= g.body.top - 60 && r.top <= g.body.bottom + 10, label + ' 道具贴着身体 ' + JSON.stringify(r));
      }
      return d;
    };

    await step('实际下载 4 个在线形象', async () => {
      const got = {};
      for (const id of ROLES.filter(r => !['01-cat', '03-penguin'].includes(r))) {
        const role = await mainPage.eval(`ipcRenderer.invoke('hub-pet:role-download',${JSON.stringify(id)}).then(s => s.roles.find(r => r.id === ${JSON.stringify(id)}))`, { timeoutMs: 180000 });
        assert.equal(role?.installed, true, id + ' installed');
        assert.equal(role.bundled, false, id + ' must be a downloadable character');
        got[id] = { installed: role.installed, bundled: role.bundled, version: role.version || role.installedVersion || '' };
      }
      evidence.facts.downloaded = got;
    });

    for (const role of ROLES) for (const dark of [false, true]) {
      const tag = NAMES[role] + '-' + (dark ? '深' : '浅');
      await step(tag + '：7 类事件道具 + 状态灯 + 分色小圆点', async () => {
        await settings({ role, scale: 1, mode: 'gentle', showGrowth: true }); await dbg({ op: 'override', meeting: false, sessions: RUN3, running: 3 });
        await dbg({ op: 'signal', patch: { quotaLow: false } });
        await wait(async () => (await dbg({ op: 'state' })).lastSent?.role === role, 'role ' + role);
        await sleep(1200);
        const facts = { role, dark };
        const n = () => ++seq;
        // 1 答完：举绿色对勾牌；三盏在跑灯 + 这盏答完灯
        await dbg({ op: 'notify', payload: { sessionId: 'done-' + n(), title: '登录页改版方案', body: '三种布局已出完，推荐 B。', completedAt: Date.now() + seq } });
        facts.done = await checkProp('done', tag + ' 答完');
        assert.equal(facts.done.lamps.items.length, 4); assert.equal(facts.done.lamps.items.filter(l => l.st === 'run').length, 3);
        await shot(`${role}-${dark ? 'dark' : 'light'}-01-答完`, dark); await dismiss();
        // 2 等你回复：冒「…」、歪头招手
        await dbg({ op: 'notice', notice: { id: 'await:' + n(), kind: 'awaiting-reply', notify: true, page: 'assistant', title: '有 2 个人在等你回复', text: '最久的等了 3 小时。' } });
        facts.wait = await checkProp('wait', tag + ' 等回复');
        await shot(`${role}-${dark ? 'dark' : 'light'}-02-等你回复`, dark); await dismiss();
        // 3 出错（err:true）：感叹号 + 汗；卡片抬头「出错了」
        await dbg({ op: 'notice', notice: { id: 'answer:err-' + n(), kind: 'answer', notify: true, page: 'assistant', tone: 'bad', err: true, title: '助理这一问没答完：今天的会', text: '助理会话超时，可到助理页重问。' } });
        facts.err = await checkProp('err', tag + ' 出错');
        assert.equal(facts.err.card.kind, '出错了');
        await shot(`${role}-${dark ? 'dark' : 'light'}-03-出错`, dark); await dismiss();
        // 4 新版本：礼盒
        await dbg({ op: 'update', version: '9.' + n() + '.0' });
        facts.gift = await checkProp('gift', tag + ' 新版本');
        await shot(`${role}-${dark ? 'dark' : 'light'}-04-新版本`, dark); await dismiss();
        // 5 硬盘：容量条（警示色，不写出错）
        await dbg({ op: 'push', notice: { id: 'disk:C:' + n(), kind: 'disk', notify: true, page: 'disk', tone: 'bad', cta: '看看哪里占地方', title: 'C 盘已经用了 94%', text: '只剩 18.2 GB。' } });
        facts.disk = await checkProp('disk', tag + ' 硬盘');
        assert.equal(facts.disk.card.kind, '硬盘'); assert.notEqual(facts.disk.card.kind, '出错了');
        await shot(`${role}-${dark ? 'dark' : 'light'}-05-硬盘`, dark); await dismiss();
        // 6 开会：戴耳机、变淡；会上来的会话答完只进小圆点（分色计数）
        await dbg({ op: 'override', meeting: true });
        await dbg({ op: 'notify', payload: { sessionId: 'meet-' + n(), title: '会上答完的', completedAt: Date.now() + seq } });
        facts.meeting = await checkProp('meeting', tag + ' 开会');
        assert.equal(facts.meeting.meeting, true); assert.equal(facts.meeting.card, null, '开会不举卡片');
        assert.ok(facts.meeting.dotText.length > 0);
        await shot(`${role}-${dark ? 'dark' : 'light'}-06-开会中`, dark);
        await dbg({ op: 'override', meeting: false });
        // 7 额度低：头顶低电量（没在说话时常驻）
        await dbg({ op: 'signal', patch: { quotaLow: true } });
        facts.battery = await checkProp('battery', tag + ' 额度低');
        await shot(`${role}-${dark ? 'dark' : 'light'}-07-额度低`, dark);
        await dbg({ op: 'signal', patch: { quotaLow: false } });
        // 8 超过 6 个会话：状态灯合并成数字
        await dbg({ op: 'override', sessions: RUN8, running: 8 }); await sleep(500);
        facts.merged = await debug();
        assert.equal(facts.merged.lamps.merged, true);
        await shot(`${role}-${dark ? 'dark' : 'light'}-08-灯合并`, dark);
        await clearDots();
        await dbg({ op: 'override', sessions: [], running: 0 });
        evidence.facts.shots.push({ role, dark, done: facts.done.lamps, dot: facts.merged.dotText, props: Object.fromEntries(['done', 'wait', 'err', 'gift', 'disk', 'meeting', 'battery'].map(k => [k, facts[k].propRects])) });
      });
    }

    await step('点灯直达会话：答完的灯熄掉；合并后点一下展开', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'gentle' }); await dbg({ op: 'override', sessions: RUN3.slice(0, 1), running: 1 });
      await dbg({ op: 'notify', payload: { sessionId: 'lamp-done', title: '点灯直达', completedAt: Date.now() } }); await sleep(600); await dismiss();
      const before = await debug();
      assert.deepEqual(before.lamps.items.map(l => l.st), ['run', 'done']);
      const r = await json(`(()=>{const r=document.querySelector('[data-lamp="lamp-done"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await clickAt(r.x, r.y);
      const after = await wait(async () => { const d = await debug(); return d.lamps && d.lamps.items.length === 1 ? d : null; }, 'lamp off');
      assert.deepEqual(after.lamps.items.map(l => l.id), ['run-a']);
      evidence.facts.lampClick = { before: before.lamps, after: after.lamps };
      await dbg({ op: 'override', sessions: RUN8, running: 8 }); await sleep(400);
      const m = await json(`(()=>{const r=document.getElementById('lamps').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await clickAt(m.x, m.y);
      const open = await debug();
      assert.equal(open.lamps.merged, false); assert.equal(open.lamps.items.length, 8);
      await shot('99-灯合并后展开', false);
      evidence.facts.lampExpand = open.lamps;
      await clearDots(); await dbg({ op: 'override', sessions: [], running: 0 });
    });

    await step('安静档、全屏躲边规则不变', async () => {
      await settings({ mode: 'quiet' }); await sleep(300);
      await dbg({ op: 'notify', payload: { sessionId: 'quiet-1', title: '安静档答完', completedAt: Date.now() } }); await sleep(600);
      const q = await debug();
      assert.equal(q.card, null, '安静档不举卡片'); assert.equal(q.prop, '', '安静档不挂事件道具'); assert.ok(q.dotText.length > 0, '只亮小圆点');
      evidence.facts.quiet = { card: q.card, prop: q.prop, dot: q.dotText };
      await settings({ mode: 'gentle' }); await clearDots();
      await dbg({ op: 'override', fullscreen: true, sessions: RUN3, running: 3 }); await sleep(1500);
      await dbg({ op: 'push', notice: { id: 'disk:fs:' + (++seq), kind: 'disk', notify: true, page: 'disk', tone: 'bad', title: 'C 盘已经用了 95%' } }); await sleep(600);
      const f = await debug();
      assert.equal(f.card, null, '全屏不举卡片'); assert.equal(f.prop, '', '全屏不挂道具'); assert.equal(f.lamps, null, '全屏躲边时不亮状态灯');
      assert.equal((await dbg({ op: 'state' })).lastSent.pose, 'peek');
      evidence.facts.fullscreen = { card: f.card, prop: f.prop, lamps: f.lamps };
      await dbg({ op: 'override', fullscreen: false, sessions: [], running: 0 }); await sleep(1500); await clearDots();
    });


    // ---------- r27d 审查返工（2026-11-17）：m69 第 1、5、6、7 项的真实渲染回归 + 系统缩放 100/150/225% 截图矩阵 ----------
    const lampFacts = () => json(`(()=>{const e=document.getElementById('lamps');if(e.hidden)return null;const r=e.getBoundingClientRect();
      const items=[...e.querySelectorAll('[data-lamp]')].map(x=>{const b=x.getBoundingClientRect();const cx=b.x+b.width/2,cy=b.y+b.height/2;const hit=document.elementFromPoint(cx,cy);
        return {id:x.dataset.lamp,cx,cy,inside:b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,hit:!!(hit&&hit.closest&&hit.closest('[data-lamp]')===x)}});
      return {merged:e.classList.contains('merged'),row:e.classList.contains('row'),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},win:{w:innerWidth,h:innerHeight},items}})()`);
    const runs = n => Array.from({ length: n }, (_, i) => ({ id: 'many-' + i, title: '会话 ' + (i + 1) }));
    const propWidth = () => json(`(()=>{const i=document.querySelector('#props>i');return i?parseFloat(i.style.width)||i.getBoundingClientRect().width:0})()`);

    await step('r27d-1 卡片正在展示时点它的灯：卡片和灯一起收掉，不回未读', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'gentle' }); await dbg({ op: 'override', sessions: [], running: 0 }); await clearDots();
      await dbg({ op: 'notify', payload: { sessionId: 'r27d-current', title: '刚答完就点灯', completedAt: Date.now() + (++seq) } });
      const before = await wait(async () => { const d = await debug(); return d.card && d.lamps ? d : null; }, 'card+lamp');
      const r = await json(`(()=>{const r=document.querySelector('[data-lamp="r27d-current"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await clickAt(r.x, r.y);
      const after = await wait(async () => { const d = await debug(); return !d.card && !d.lamps ? d : null; }, 'card and lamp gone');
      await sleep(400);
      const later = await debug();
      assert.equal(later.dotText, '', '不回到未读小圆点');
      evidence.facts.r27d_currentClick = { before: { card: before.card, lamps: before.lamps }, after: { card: after.card, lamps: after.lamps, dot: later.dotText } };
    });

    await step('r27d-5 安静档：不挂低电量、不亮灯；开会耳机保留', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'quiet' });
      await dbg({ op: 'signal', patch: { quotaLow: true } }); await dbg({ op: 'override', meeting: false, sessions: RUN3, running: 3 }); await sleep(900);
      const q1 = await debug(); const l1 = await lampFacts();
      assert.equal(q1.prop, '', '安静档不挂低电量'); assert.equal(l1, null, '安静档不亮会话灯');
      await shot('r27d-quiet-quotaLow-running', false);
      await dbg({ op: 'override', meeting: true }); await sleep(900);
      const q2 = await debug(); const l2 = await lampFacts();
      assert.equal(q2.prop, 'meeting', '开会耳机保留'); assert.equal(l2, null);
      await shot('r27d-quiet-meeting', false);
      await settings({ mode: 'gentle' }); await sleep(900);
      const g = await debug();
      assert.equal(g.prop, 'meeting'); assert.equal((await lampFacts()).items.length, 3, '温和档灯照常');
      evidence.facts.r27d_quiet = { quotaRun: { prop: q1.prop, lamps: l1 }, meeting: { prop: q2.prop, lamps: l2 }, gentle: { prop: g.prop } };
      await dbg({ op: 'override', meeting: false, sessions: [], running: 0 }); await dbg({ op: 'signal', patch: { quotaLow: false } });
    });

    await step('r27d-6 展开 7/20/30 盏灯：每盏都在窗口里且点得到（居中、贴左边、贴右边、桌宠 1.6 倍）', async () => {
      // 隔离 Hub 的窗口压在屏幕外，挪不到真实屏幕边；贴边用调试覆盖 edge 模拟窗口伸出屏幕的宽度（与主进程算法同口径）。
      const spots = [
        { tag: '居中', scale: 1, edge: null },
        { tag: '贴左边', scale: 1, edge: { left: 70, right: 0 } },
        { tag: '贴右边', scale: 1, edge: { left: 0, right: 70 } },
        { tag: '1.6倍', scale: 1.6, edge: null },
        { tag: '1.6倍贴右边', scale: 1.6, edge: { left: 0, right: 70 } },
      ];
      evidence.facts.r27d_lamps = [];
      for (const spot of spots) for (const n of [7, 20, 30]) {
        await settings({ role: '03-penguin', scale: spot.scale, mode: 'gentle' }); await sleep(300);
        await dbg({ op: 'override', edge: spot.edge }); await sleep(200);
        await dbg({ op: 'override', sessions: runs(n), running: n }); await sleep(600);
        let f = await lampFacts();
        assert.equal(f.merged, true, n + ' 盏先合并');
        await clickAt((f.rect.left + f.rect.right) / 2, (f.rect.top + f.rect.bottom) / 2);
        f = await wait(async () => { const x = await lampFacts(); return x && !x.merged ? x : null; }, 'expanded ' + n);
        const edge = (await dbg({ op: 'state' })).edge || {};
        if (spot.edge) assert.deepEqual(edge, spot.edge, '贴边模拟生效');
        const bad = f.items.filter(i => !i.inside || !i.hit || i.cx < (edge.left || 0) || i.cx > f.win.w - (edge.right || 0));
        assert.equal(f.items.length, n);
        assert.deepEqual(bad.map(i => i.id), [], `${spot.tag} ${n} 盏都可见可点`);
        evidence.facts.r27d_lamps.push({ spot: spot.tag, n, row: f.row, rect: f.rect, win: f.win, edge, clipped: bad.length });
        if (n === 30) await shot(`r27d-30灯展开-${spot.tag}`, false);
        // 抽查：点最后一盏（原先被裁掉的那一端）能直达
        const last = f.items[n - 1];
        await clickAt(last.cx, last.cy);
        await dbg({ op: 'override', sessions: [], running: 0 }); await sleep(300);
      }
      await settings({ scale: 1 }); await dbg({ op: 'override', edge: null }); await sleep(300);
    });

    await step('r27d-7 道具跟着桌宠大小重算（静止同帧）：低电量 1→1.5 倍宽度 34→51px', async () => {
      await settings({ role: '01-cat', scale: 1, mode: 'gentle' }); await dbg({ op: 'signal', patch: { quotaLow: true } });
      await checkProp('battery', 'scale1');
      const w1 = await propWidth();
      const rows = [];
      for (const s of [1.5, 0.6, 1.6, 1]) {
        await settings({ scale: s });
        const w = await wait(async () => { const x = await propWidth(); return Math.abs(x - 34 * s) <= 1.2 ? x : null; }, 'battery width at ' + s, 4000);
        await checkProp('battery', 'scale' + s);
        rows.push({ scale: s, width: w });
      }
      evidence.facts.r27d_propScale = { w1, rows };
      await dbg({ op: 'signal', patch: { quotaLow: false } });
    });

    await step('r27d 截图矩阵：6 形象 × 浅/深桌面 × 系统缩放 100/150/225%（答完卡片 + 低电量 + 3 盏灯）', async () => {
      evidence.facts.r27d_matrix = [];
      const size = await json('({w: innerWidth, h: innerHeight})');
      for (const role of ROLES) {
        await settings({ role, scale: 1, mode: 'gentle', showGrowth: true });
        await wait(async () => (await dbg({ op: 'state' })).lastSent?.role === role, 'role ' + role); await sleep(900);
        for (const dpr of [1, 1.5, 2.25]) {
          await pet.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: dpr, mobile: false });
          await sleep(300);
          for (const dark of [false, true]) {
            await dbg({ op: 'override', sessions: RUN3, running: 3 }); await dbg({ op: 'signal', patch: { quotaLow: true } });
            const battery = await checkProp('battery', `${role} dpr${dpr}`);
            const lamps = await lampFacts();
            assert.ok(lamps && lamps.items.length === 3 && lamps.items.every(i => i.inside && i.hit), `${role} dpr${dpr} 灯可见可点`);
            await dbg({ op: 'notify', payload: { sessionId: 'mx-' + (++seq), title: '登录页改版方案', body: '三种布局已出完，推荐 B。', completedAt: Date.now() + seq } });
            const done = await checkProp('done', `${role} dpr${dpr} 答完`);
            const name = `r27d-${role}-${dark ? 'dark' : 'light'}-dpr${Math.round(dpr * 100)}`;
            await pet.send('Emulation.setDefaultBackgroundColorOverride', { color: dark ? { r: 27, g: 31, b: 42, a: 1 } : { r: 226, g: 232, b: 240, a: 1 } });
            await pet.eval(`document.documentElement.style.backgroundColor=document.body.style.backgroundColor=${JSON.stringify(dark ? '#1b1f2a' : '#e2e8f0')}`);
            await sleep(160);
            const r2 = await pet.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } });
            fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r2.data, 'base64')); evidence.screenshots.push(name + '.png');
            evidence.facts.r27d_matrix.push({ role, dark, dpr, battery: battery.propRects, done: done.propRects, lamps: lamps.items.length });
            await dismiss(); await clearDots();
          }
        }
        await pet.send('Emulation.clearDeviceMetricsOverride');
      }
      await dbg({ op: 'override', sessions: [], running: 0 }); await dbg({ op: 'signal', patch: { quotaLow: false } });
    });

    evidence.facts.final = await dbg({ op: 'state' });
    assert.deepEqual(evidence.errors, []);
    evidence.ok = true;
  } catch (e) { evidence.ok = false; evidence.errors.push(e.stack || e.message); process.exitCode = 1; }
  finally {
    if (pet) pet.close(); if (mainPage) mainPage.close();
    if (hub) evidence.cleanup = await gracefulQuit(hub);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, steps: evidence.steps.length, errors: evidence.errors, screenshots: evidence.screenshots.length, output: OUT }));
  }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
