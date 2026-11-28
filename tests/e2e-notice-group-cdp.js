'use strict';
// 相邻团队消息合并成组 +「简洁」开关 + 顶部概览条（来源 3dea7fba / bd8ba8a0 / 5e462a33 / de959e5e）。
// 隔离 Hub（临时数据目录、独立 CDP、窗口隐藏）里用真实卡片渲染器挂卡片，不调模型：
// 1)「简洁」关（HUB-H 默认）：相邻团队消息合成一组，中间夹用户的话或正常回复就断开，「无新进展」不打断；收起一行，组员不显示；
// 2) 真实鼠标点开一组：每条原文按原顺序展开，被点的那一行不跳；整张重画后展开状态保留；
// 3)「简洁」开：团队消息和「无新进展」整张藏掉，点按钮切换后分组重算；
// 4) 概览条：真实取数（隔离数据里全是 0，只剩「在跑一览」），再换成样例数字看 0 段不画、收起/展开、点一段打开在跑一览。
// 截图写到 HUB_E2E_ARTIFACT_DIR（默认临时目录），1440×900。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { teamNoticeSummary } = require('../renderer/team-notice-identity');
const { isNoUpdateReply } = require('../core/team-silent-reply');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notice-group-'));
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const SID = 'card-question-nav-e2e';
const team = (who, body) => `【团队消息 · 1 条】\n- [${who}] #${Math.floor(Math.random() * 90 + 10)} 11-28 20:0${Math.floor(Math.random() * 9)}\n${body}`;
const TURNS = [
  { id: 'own-1', role: 'user', text: '开始吧' },
  { id: 't1', role: 'user', text: team('m1 消息合并', '第一条：单测已过。') },
  { id: 'n1', role: 'assistant', kind: 'codeagent', text: '[[hub:no-update]]' },
  { id: 't2', role: 'user', text: team('m2 重绘减负', '第二条：侧栏重绘次数从 3 降到 1。') },
  { id: 'n2', role: 'assistant', kind: 'codeagent', text: '[[hub:no-update]]' },
  { id: 't3', role: 'user', text: team('m1 消息合并', '📌 **第三条：截图已交，等审查。**\n细节见回执') },
  { id: 'a1', role: 'assistant', kind: 'codeagent', text: '收到三条，我汇总一下。' },
  { id: 't4', role: 'user', text: team('m3 审查', '第四条：单独一条，前面有正常回复，不该并进上一组。') },
  { id: 'own-x', role: 'user', text: '这句是用户说的，应把前后断开' },
  { id: 'h1', role: 'user', text: '【团队消息 · 1 条】\n- [Hub] 计划已批准。' },
  { id: 'h2', role: 'user', text: '【回到队里 · 新任务】把审查意见改完' },
  { id: 'own-2', role: 'user', text: '继续' },
];

// 按需求独立算出应有的分组：折叠卡相邻成组；「无新进展」不打断；其余卡片断开。「简洁」开着时团队消息整张藏掉，不成组。
function expectedGroups(turns, concise) {
  const groups = []; let run = null;
  const close = () => { if (run && run.ids.length > 1) groups.push(run); run = null; };
  for (const t of turns) {
    const kind = t.role === 'user' ? teamNoticeSummary(t.text)?.kind : null;
    if (t.role === 'assistant' && isNoUpdateReply(t.text)) continue;
    if (!kind) { close(); continue; }
    if (concise) continue;
    if (!run) run = { ids: [] };
    run.ids.push(t.id);
  }
  close();
  return groups;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  let hub, c;
  const evidence = { out: OUT, checks: [] };
  const ok = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };
  const until = async expr => { for (let n = 0; n < 300; n++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout ' + expr); };
  const shot = async name => fs.writeFileSync(path.join(OUT, name), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const click = async sel => {
    await c.eval(`document.querySelector(${j(sel)}).scrollIntoView({block:'center',behavior:'instant'})`); await sleep(100);
    const pos = await c.eval(`(()=>{const r=document.querySelector(${j(sel)}).getBoundingClientRect();return{x:r.x+Math.min(40,r.width/2),y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 }); await sleep(250);
    return pos;
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'data'), port, windowMode: 'hidden', label: 'notice-group',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Page.enable');
    await until('!!window.__hubE2E?.cardQuestionNavigator && !!window._mountSessionTurnCard && !!window.__conciseView && !!window.__overviewStrip');
    await until("!!document.getElementById('concise-view-rules')");
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.eval(String.raw`__hubE2E.cardQuestionNavigator.mountFixture({count:0});
      window.__turns=${j(TURNS)};
      window.__mountAll=()=>{const o=document.getElementById('msg-overlay');o.innerHTML='';
        for(const t of __turns)_mountSessionTurnCard(${j(SID)},{...t,ts:t.ts||Date.now()},{kind:'codeagent',container:o});return o.children.length;};
      // 夹具不走选会话流程：按真实会话那样画一次顶栏（面包屑 + 动作区），「简洁」按钮由顶栏变化自动补进来。
      paintAppToolbarForSession(${j(SID)}, sessions.get(${j(SID)}));
      __mountAll();`);
    // 启动后首页会异步把顶栏画回「主页」一次：夹具会话的顶栏要在那之后再画，直到「简洁」按钮出现在可见的动作区里。
    await until(`(()=>{if(document.querySelector('#toolbar-actions:not([hidden]) > .concise-toggle:not([hidden])'))return true;
      if(document.getElementById('toolbar-actions').hidden)paintAppToolbarForSession(${j(SID)}, sessions.get(${j(SID)}));return false;})()`);
    await sleep(300);
    const read = () => c.eval(String.raw`(()=>{const o=document.getElementById('msg-overlay');
      const cards=[...o.querySelectorAll(':scope > .turn-card')];
      const heads=cards.filter(x=>x.classList.contains('notice-group-head')).map(h=>{
        const members=cards.filter(x=>x.dataset.noticeGroup===JSON.stringify([h.dataset.sessionId||'',h.dataset.turnId||''])&&x.dataset.noticeKind);
        return {id:h.dataset.turnId,count:Number(h.dataset.noticeGroup),open:h.classList.contains('notice-group-open'),
          bar:h.querySelector('.notice-group-bar')?.textContent||'',barTop:Math.round(h.querySelector('.notice-group-bar')?.getBoundingClientRect().top||0),
          height:Math.round(h.getBoundingClientRect().height),
          members:[h,...members].map(m=>({id:m.dataset.turnId,shown:getComputedStyle(m).display!=='none',open:!!m.querySelector('details.team-notice-fold')?.open,
            text:m.querySelector('.team-notice-full')?.textContent||''}))};});
      const shown=cards.filter(x=>getComputedStyle(x).display!=='none').map(x=>x.dataset.turnId);
      return {heads,shown,noUpdateText:o.querySelector('.turn-card.no-update .turn-body')?.textContent.trim()||'',
        concise:document.querySelector('.concise-toggle')?.getAttribute('aria-pressed'),conciseShown:!document.querySelector('.concise-toggle')?.hidden};})()`);

    // 1) 默认「简洁」关：团队消息照常显示，相邻的合成组。
    let state = await read();
    ok('「简洁」按钮出现在会话顶栏且默认关：' + j([state.conciseShown, state.concise]), state.conciseShown && state.concise === 'false');
    ok('「无新进展」卡片只写一句，不露暗号', state.noUpdateText === '无新进展');
    const expected = expectedGroups(TURNS, false);
    assert.deepEqual(state.heads.map(h => [h.id, h.count]), expected.map(g => [g.ids[0], g.ids.length]), '分组与需求推算一致：' + j(state.heads.map(h => [h.id, h.count])));
    for (const [i, h] of state.heads.entries()) {
      assert.deepEqual(h.members.map(m => m.id), expected[i].ids, h.id + ' 组员按原顺序');
      assert.equal(h.open, false, h.id + ' 默认收起');
      assert.match(h.bar, new RegExp('^▸' + h.count + ' 条'), h.id + ' 摘要写条数：' + h.bar);
      assert.ok(h.height < 60, h.id + ' 收起时只占一行：' + h.height);
      assert.ok(h.members.slice(1).every(m => !m.shown), h.id + ' 组员收起时不显示');
    }
    ok('相邻团队消息合组，夹着正常回复或用户的话断开，无新进展不打断：' + state.heads.map(h => h.bar).join(' | '), true);
    ok('组摘要先写最新一句结论，去掉 📌 与加粗记号：' + state.heads[0].bar, /最新 m1 消息合并：第三条：截图已交，等审查。$/.test(state.heads[0].bar));
    await c.eval(`document.querySelector('#msg-overlay > .notice-group-head').scrollIntoView({block:'center',behavior:'instant'})`); await sleep(150);
    await shot('02-简洁关-默认-合并一行.png');

    // 2) 点开最大的一组。
    const big = [...state.heads].sort((a, b) => b.count - a.count)[0];
    const barSel = `#msg-overlay > .turn-card[data-turn-id="${big.id}"] .notice-group-bar`;
    const pos = await click(barSel);
    state = await read();
    const opened = state.heads.find(h => h.id === big.id);
    ok('点击后整组展开', opened.open === true);
    ok(`被点的那一行留在原位：${Math.round(pos.y)} → ${opened.barTop}`, Math.abs(opened.barTop - pos.y) < 20);
    const src = Object.fromEntries(TURNS.map(t => [t.id, t.text]));
    const norm = s => String(s).replace(/[*#`>\-·\s📌]/gu, '');
    for (const m of opened.members) {
      assert.equal(m.shown && m.open, true, m.id + ' 展开后原文可见');
      const lastLine = src[m.id].trim().split('\n').map(s => s.trim()).filter(Boolean).pop();
      assert.ok(norm(m.text).includes(norm(lastLine).slice(0, 12)), m.id + ' 原文末行在展开区里：' + m.text);
    }
    ok('展开后每条原文按顺序显示', true);
    await shot('03-点开一组.png');

    // 整张重画：仍展开，位置不跳。
    const before = opened.barTop;
    await c.eval(`(()=>{const o=document.getElementById('msg-overlay');const keep=o.scrollTop;__mountAll();_noticeGroups.apply(o);o.scrollTop=keep;})()`); await sleep(300);
    const again = (await read()).heads.find(h => h.id === big.id);
    ok('整张重画后仍展开、每条仍展开', again.open && again.members.every(m => m.shown && m.open));
    ok(`重画后位置不跳：${before} → ${again.barTop}`, Math.abs(again.barTop - before) <= 2);

    // 收起后再重画，保持收起。
    await click(barSel);
    await c.eval(`__mountAll()`); await sleep(250);
    ok('收起后重画仍收起', (await read()).heads.find(h => h.id === big.id).open === false);

    // 3) 真实鼠标点「简洁」打开：团队消息和「无新进展」整张藏掉，只剩对话；再点关掉，分组回来。
    await click('.concise-toggle');
    state = await read();
    ok('点「简洁」打开后只剩用户和 Agent 的对话、分组清空：' + j(state.shown), state.concise === 'true' && state.heads.length === 0 && state.shown.join() === 'own-1,a1,own-x,own-2');
    ok('打开状态记在本机', await c.eval(`JSON.parse(localStorage.getItem('hub.conciseView.onSessions.v1')||'[]').includes(${j(SID)})`));
    await shot('01-简洁开.png');
    await click('.concise-toggle'); // 关回去，给概览条截图看卡片
    ok('再点关掉后分组回来', (await read()).heads.length === expected.length);

    // 4) 概览条：真实取数。
    await c.eval('__overviewStrip.load()'); await sleep(200);
    const strip = () => c.eval(`(()=>{const el=document.getElementById('ov-strip');const r=el.getBoundingClientRect();return{text:el.textContent,segs:[...el.querySelectorAll('.ov-strip-seg')].map(b=>b.textContent),
      crumb:Math.round(document.getElementById('toolbar-crumb').getBoundingClientRect().width),title:(()=>{const t=document.querySelector('#toolbar-crumb .terminal-title');return t?t.scrollWidth<=t.clientWidth+1:null})(),parent:el.parentElement.id,w:Math.round(r.width),h:Math.round(r.height),visible:r.width>0&&!el.hidden,collapsed:el.classList.contains('collapsed'),hot:el.classList.contains('hot'),
      overflow:document.getElementById('app-toolbar').scrollWidth>document.getElementById('app-toolbar').clientWidth+1}})()`);
    let s = await strip();
    ok('概览条挂在顶部工具栏；隔离数据全是 0 时整条不显示，不占顶栏宽度', s.parent === 'app-toolbar' && !s.visible && s.segs.length === 0);
    // 样例数字：等你 2、卡住 1、在跑 0（0 段不画）。
    await c.eval(`(()=>{const orig=ipcRenderer.invoke.bind(ipcRenderer);window.__roOrig=orig;window.__roCounts={waiting:0,suspect:0,running:5,done:4,rest:9};
      ipcRenderer.invoke=(ch,...a)=>ch==='running-overview:get'?Promise.resolve({ok:true,at:Date.now(),counts:window.__roCounts,rows:[]}):orig(ch,...a);})()`);
    await c.eval('__overviewStrip.load()'); await sleep(200);
    s = await strip();
    ok('只有在跑的会话、没人等你也没卡住时，整条不显示（「在跑」只进悬停提示）', !s.visible);
    await c.eval('window.__roCounts={waiting:2,suspect:1,running:5,done:4,rest:9}');
    await c.eval('__overviewStrip.load()'); await sleep(200);
    s = await strip();
    ok('样例数字：等你 2、卡住 1，0 段不画，「刚完成」不在条上：' + s.segs.join('|'), s.segs.join('|') === '等你2|卡住1' && s.hot && s.visible);
    // 对照：把概览条和「简洁」按钮都藏起来时，会话标题本来有多宽、会不会被挤（工具栏里其他按钮也在抢宽度）。
    const crumbBase = await c.eval(`(()=>{const a=document.getElementById('ov-strip'),b=document.querySelector('.concise-toggle');a.style.display='none';b.style.display='none';
      const t=document.querySelector('#toolbar-crumb .terminal-title');const r={crumb:Math.round(document.getElementById('toolbar-crumb').getBoundingClientRect().width),fits:t.scrollWidth<=t.clientWidth+1,title:t.textContent,need:t.scrollWidth,have:t.clientWidth};
      a.style.display='';b.style.display='';return r})()`);
    evidence.crumb = { withStrip: s.crumb, without: crumbBase };
    console.log('crumb', JSON.stringify(evidence.crumb));
    ok(`1440 宽时工具栏不溢出，概览条不超过 140px（概览条 ${s.w}×${s.h}，面包屑 ${s.crumb}px / 无概览条与简洁按钮时 ${crumbBase.crumb}px）`, !s.overflow && s.h <= 30 && s.w <= 140);
    await shot('04-概览条-样例数字.png');
    await click('#ov-strip .ov-strip-fold');
    s = await strip();
    ok('收起后只剩「一览」和合计 3', s.collapsed && s.segs.join() === '一览3');
    await shot('05-概览条-收起.png');
    await click('#ov-strip .ov-strip-fold');
    ok('展开后恢复', !(await strip()).collapsed);
    await click('#ov-strip .ov-strip-waiting');
    await until("!!document.querySelector('.ro-overlay')");
    ok('点「等你」打开在跑一览弹窗', true);
    await shot('06-点概览条打开在跑一览.png');
    await c.eval(`document.querySelector('.ro-overlay [data-action="close"]').click(); ipcRenderer.invoke=window.__roOrig;`);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: true, out: OUT, checks: evidence.checks.length }, null, 2));
  } finally {
    if (c) try { c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
