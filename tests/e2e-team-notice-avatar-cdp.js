'use strict';
// Isolated Electron + production card renderer and question directory. No model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-notice-'));
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const CARDS = [
  { id: 'one', text: '【团队消息 · 1 条】\n- [m1 功能实现] 已完成单测。\n第二行细节' },
  { id: 'many', text: '【团队消息 · 2 条】\n- [m1 功能实现 · 留言] msg-a · 2026-11-04T00:00:00Z\n首条完整正文。\n第二行细节\n- [m2 独立审查] msg-b · 2026-11-04T00:01:00Z\n第二条完整正文。' },
  { id: 'hub', text: '【团队消息 · 1 条】\n- [Hub] 消息等待发送。' },
  { id: 'kickoff', text: '【组队开工 · 来自负责人】你是成员 m1，分工：实现。\n团队目标：验证组队。' },
  { id: 'self', text: '请核对这次修改。' },
];
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn) { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw Error('Renderer readiness timeout'); }
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const evidence = { root: ROOT, checks: [], widths: [], model: 'none; renderer fixtures' };
  let hub, c, failure;
  const ok = (label, value) => { assert(value, label); evidence.checks.push(label); };
  const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'data'), port: await freePort(), label: 'team-notice', windowMode: 'hidden', extraEnv: { CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Page.enable');
    await wait(() => c.eval('!!window._renderTurnCard'));
    await c.eval(`(() => {
      const cards = ${JSON.stringify(CARDS)};
      const host = document.createElement('section'); host.id = 'team-notice-fixture'; host.className = 'msg-overlay';
      host.style.cssText = 'display:block;position:fixed;inset:48px 40px 40px 280px;z-index:99998;overflow:auto;background:var(--surface-canvas);padding:20px';
      host.innerHTML = cards.map(card => window._renderTurnCard({ ...card, role:'user', kind:'codeagent', ts:Date.now(), simpleChat:true })).join('');
      document.body.appendChild(host);
      const nav = document.createElement('aside'); nav.id = 'team-notice-directory'; document.body.appendChild(nav);
      window.__noticeNavigator = require('../renderer/card-question-navigator').createCardQuestionNavigator({ overlay:host, root:nav, getActiveSessionId:()=> 'fixture', getTurnById:id=>cards.find(c=>c.id===id) });
      window.__noticeNavigator.init(); window.__noticeNavigator.refresh();
    })()`);
    await wait(() => c.eval("[...document.querySelectorAll('#team-notice-fixture .turn-avatar img')].every(i=>i.complete&&i.naturalWidth>0)"));
    await c.eval("window.__noticeResizeEvents=[];window.addEventListener('resize',()=>window.__noticeResizeEvents.push({width:innerWidth,height:innerHeight}))");
    for (const width of [1440, 1280]) {
      const before = await c.eval('({width:innerWidth,height:innerHeight,count:window.__noticeResizeEvents.length})');
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await shot('folded-' + width); // Flush compositor after resize before pointer input.
      if (before.width!==width || before.height!==900) await wait(()=>c.eval(`window.__noticeResizeEvents.slice(${before.count}).some(e=>e.width===${width}&&e.height===900)`));
      const rows = await c.eval(`([...document.querySelectorAll('#team-notice-fixture .turn-card')].map(card=>({id:card.dataset.turnId,who:card.querySelector('.turn-who').textContent,avatar:card.querySelector('img').getAttribute('src'),height:card.getBoundingClientRect().height,fold:!!card.querySelector('.team-notice-fold'),summary:card.querySelector('.team-notice-line')?.textContent,overflow:card.scrollWidth>card.clientWidth+1})))`);
      evidence.widths.push({ width, rows });
      const by = Object.fromEntries(rows.map(r => [r.id, r]));
      ok(width + ' member identity and shipped CodeAgent avatar', by.one.who === 'm1 功能实现' && /glm\.png$/.test(by.one.avatar));
      ok(width + ' multiple senders / Hub / lead / user identity', by.many.who === 'm1、m2' && by.hub.who === 'Hub' && by.kickoff.who === '负责人' && by.self.who === '用户');
      ok(width + ' ordinary user remains unfolded with Hub icon', !by.self.fold && !/glm\.png$/.test(by.self.avatar) && !/glm\.png$/.test(by.hub.avatar));
      ok(width + ' compact cards without horizontal overflow', rows.filter(r=>r.id!=='self').every(r=>r.height<=40 && !r.overflow));
      ok(width + ' old and stamped body summaries', by.one.summary==='已完成单测。' && by.many.summary==='2 条 · 首条完整正文。');
      ok(width + ' only user question in directory', await c.eval("window.__noticeNavigator.refresh().count===1 && window.__noticeNavigator.getState().summaries[0]==='请核对这次修改。'"));
      const selector = '#team-notice-fixture [data-turn-id="many"] .team-notice-line';
      const click = async () => { const p = await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed','mouseReleased']) await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1}); };
      await click();
      await shot('opened-' + width);
      const opened = await c.eval(`(()=>{const d=document.querySelector('#team-notice-fixture [data-turn-id="many"] .team-notice-fold');return{open:d.open,text:d.innerText,height:d.getBoundingClientRect().height}})()`);
      evidence.widths.at(-1).opened = opened;
      ok(width + ' real click expands all message bodies', opened.open && opened.text.includes('第二条完整正文。') && opened.height>80);
      await click();
      ok(width + ' real click collapses again', await c.eval(`!document.querySelector('#team-notice-fixture [data-turn-id="many"] .team-notice-fold').open`));
    }
    evidence.uiChecksPassed = true;
  } catch (error) {
    failure = error; evidence.error = error.stack;
    if (c) await shot('failure').catch(e => { evidence.screenshotError = String(e); });
  }
  finally {
    try { if (c) await c.close(); }
    catch (error) { failure ||= error; evidence.cdpCloseError = String(error); }
    try { if (hub) evidence.exit = await gracefulQuit(hub); }
    catch (error) { failure ||= error; evidence.quitError = String(error); }
    finally {
      if (hub) fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'), 'utf8');
      hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
    }
    evidence.ok = evidence.uiChecksPassed === true && !failure;
    fs.writeFileSync(path.join(OUT, '20261104-team-notice-evidence-m3.json'), JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
  console.log('PASS team notice: ' + evidence.checks.length + ' checks; ' + OUT);
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
