'use strict';
// 「待你看」只计负责人自己和独立会话（2026-11-22）：成员新回复不计；成员等你拍板/出错汇总到负责人那一条。
// 「成员回复」「独立会话回复」「成员等授权」，核对侧栏顶上的「待你看」。AI HUB-H 版。
// 用法：node tests/e2e-attention-lead-cdp.js [输出目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const net = require('node:net');
const getFreePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const out = path.resolve(process.argv[2] || path.join(__dirname, '../artifacts/20261122-attention-lead'));
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubh-attention-lead-'));
const checks = [], shots = [];
const ok = label => { checks.push(label); console.log('PASS ' + label); };

let hub, c;
(async () => { try {
  hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await getFreePort(), windowMode: 'background', label: 'attention lead',
    extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
  c = await connectFirstPage(hub, t => t.type === 'page' && /index\.html/i.test(t.url || ''));
  const until = async (expr, label, ms = 20000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await c.eval(expr); if (v) return v; await sleep(150); } throw Error('timeout: ' + label + ' last=' + j(v)); };
  const shot = async name => { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 600 }); await sleep(400); const r = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, `20261122-待你看-1440x900-${name}.png`); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); shots.push(f); console.log('SHOT ' + f); };
  const point = async sel => until(`(()=>{const e=document.querySelector(${j(sel)});if(!e)return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+Math.min(r.width/2,60),y:r.y+r.height/2}:null})()`, 'clickable ' + sel, 8000);
  const clickAt = async sel => { const r = await point(sel);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
  await until('!!window.__hubE2E && typeof sessions!=="undefined"', 'renderer');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const now = Date.now(), m = 60000;
  await c.eval(`(()=>{const n=${now},m=${m};
    window.__hubE2E.addFakeSessions([
      {id:'fx-lead',title:'负责人 · 调度对齐',kind:'claude',createdAt:n-6*3600000,lastMessageTime:n-4*m},
      {id:'fx-m1',title:'m1 信道对齐',kind:'claude',createdAt:n-5*3600000,lastMessageTime:n-8*m},
      {id:'fx-m2',title:'m2 回归测试',kind:'claude',createdAt:n-5*3600000,lastMessageTime:n-9*m},
      {id:'fx-solo',title:'零碎 · 证书续期',kind:'claude',createdAt:n-3*3600000,lastMessageTime:n-30*m}]);
    ipcRenderer.emit('team:changed',{},{leadSid:'fx-lead',team:{leadSid:'fx-lead',members:[1,2].map(i=>({sid:'fx-m'+i,memberId:'m'+i,status:'working',role:'m'+i})),plans:[]}});
    return true})()`);
  if (await c.eval('document.getElementById("app-container").classList.contains("rail-hidden")')) await clickAt('#btn-toggle-navigation');
  const onHome = `(()=>{const a=document.getElementById('assistant-page');return (!a||a.hidden)&&document.getElementById('session-list').getBoundingClientRect().width>0})()`;
  await sleep(2500);
  for (let i = 0; i < 6; i++) { if (await c.eval(onHome)) { await sleep(1500); if (await c.eval(onHome)) break; } await clickAt('#btn-home'); await sleep(1200); }
  await until(onHome, 'home page');
  await until(`!!document.querySelector('#session-list [data-session-id="fx-lead"]')`, 'lead row');

  let clock = Date.now();
  const turn = async (sid, prompt, reply) => {
    clock += 2000;
    await c.eval(`ipcRenderer.emit('hook-event',{},${j({ event: 'prompt', sessionId: sid, eventAt: clock, latestUserMessage: prompt })})`);
    await sleep(200);
    clock += 2000;
    await c.eval(`ipcRenderer.emit('hook-event',{},${j({ event: 'stop', sessionId: sid, eventAt: clock, lastAssistantMessage: reply })})`);
    await sleep(900);
  };
  const facts = () => c.eval(`(()=>{const b=document.getElementById('attention-jump');return {shown:!!b&&!b.hidden,text:b?.textContent||'',tip:b?.title||'',active:activeSessionId}})()`);
  const settle = () => sleep(2600); // 「待你看」每 2 秒刷新一次

  let f = await facts();
  assert.equal(f.shown, false, '起始没有待你看：' + j(f));

  // ① 成员有新回复：不进「待你看」
  await turn('fx-m1', '继续', '第一版信道对齐完成，误差 0.3 dB');
  await settle(); f = await facts();
  assert.equal(f.shown, false, '成员新回复不该进待你看：' + j(f));
  ok('①组队成员有新回复：「待你看」不出现');

  // ② 独立会话有新回复：进「待你看」
  await turn('fx-solo', '查一下', '证书 30 天后到期，已续好');
  await settle(); f = await facts();
  assert.equal(f.text, '待你看 1', '独立会话照算：' + j(f));
  ok('②独立会话有新回复：「待你看 1」');
  await shot('1-成员回复不计独立会话计');

  // ③ 成员停下等授权（要用户拍板）：汇总到负责人那一条
  clock += 2000;
  await c.eval(`ipcRenderer.emit('hook-event',{},${j({ event: 'prompt', sessionId: 'fx-m2', eventAt: clock, latestUserMessage: '跑回归' })})`);
  await sleep(200); clock += 1000;
  await c.eval(`ipcRenderer.emit('hook-event',{},${j({ event: 'permission-request', sessionId: 'fx-m2', eventAt: clock, toolName: 'Bash', toolInput: { command: 'node scripts/run_unit_tests.js' } })})`);
  await settle(); f = await facts();
  assert.equal(f.text, '待你看 2', '成员要拍板汇总成负责人一条（加独立会话共 2）：' + j(f));
  assert.match(f.tip, /1 个要你回复/, j(f));
  assert.match(f.tip, /负责人 · 调度对齐：m2 回归测试等你拍板/, '悬停写明是哪个成员要拍板：' + f.tip);
  ok('③成员等授权：汇总进负责人那一条，「待你看 2」，悬停「负责人 · 调度对齐：m2 回归测试等你拍板」');
  await shot('2-成员拍板汇总到负责人');

  // ④ 点「待你看」：先跳到负责人（要你回复的排前面），成员行在它下面展开
  await clickAt('#attention-jump');
  await until(`activeSessionId==='fx-lead'`, 'jump to lead');
  await sleep(800);
  const memberRowVisible = await c.eval(`!!document.querySelector('#session-list [data-session-id="fx-m2"]')?.getBoundingClientRect().width`);
  assert.ok(memberRowVisible, '跳到负责人后成员行可见');
  ok('④点「待你看」先跳到负责人，下面展开的成员行里能看到 m2');
  await shot('3-点待你看跳到负责人');

  const summary = { ok: true, checks, shots };
  fs.writeFileSync(path.join(out, '20261122-待你看-e2e结果.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (e) {
  console.error('FAIL ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  try { c && c.close && c.close(); } catch {}
  if (hub) await gracefulQuit(hub).catch(() => {});
} })();
