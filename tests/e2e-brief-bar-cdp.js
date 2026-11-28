'use strict';
// 交卷 / 请拍板简述条：隔离 Hub（临时数据目录、独立 CDP、窗口隐藏），不调模型。
// 进展卡快照用样例数据直接交给简述条（主进程读卡、推送 progress-cards:changed 的链路已有单测覆盖），验证：
// 1) 等你拍板的卡一来就出两行简述卡（问题 + 推荐），在主页、会话页都看得到，1440 宽不压住工具栏；
// 2) 状态改成「已完成」时出交卷卡；3) 真实鼠标点「打开会话」跳到那个会话并收起；点 × 收起且重载后不再出现；
// 4) 同一会话有简述卡时，答完的回执不再弹（回执只给别的会话）。
// 5) 审查阻断回归：先打开会话 A、再切到主页，A 的卡来了不能被当成「已看到」吞掉；收起后 Agent 只改卡上别处不再弹。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
// 页面里 require 的是渲染进程目录下的模块；路径拼出来写，免得被当成本测试文件的相对引用。
const R = name => j('./' + name);
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-brief-bar-'));
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  let hub, c;
  const evidence = { out: OUT, checks: [] };
  const ok = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };
  const until = async expr => { for (let n = 0; n < 300; n++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout ' + expr); };
  const shot = async name => fs.writeFileSync(path.join(OUT, name), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const click = async sel => {
    const pos = await c.eval(`(()=>{const r=document.querySelector(${j(sel)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button: 'left', clickCount: 1 }); await sleep(300);
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'data'), port, windowMode: 'hidden', label: 'brief-bar',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Page.enable');
    await until('!!window.__briefBar && !!window.__hubE2E?.cardQuestionNavigator');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 两个样例会话：A 等你拍板，B 在跑；先停在主页。
    await c.eval(String.raw`(()=>{for(const [id,title] of [['brief-a','接口迁移'],['brief-b','周报整理']])sessions.set(id,{id,title,kind:'codeagent',status:'idle',createdAt:Date.now(),lastMessageTime:Date.now()});
      window.__card=(sid,plain,dt=0)=>({sessionId:sid,title:sessions.get(sid).title,cardPath:'D:/w/'+sid+'/进展卡.md',mtimeMs:Date.now()-dt,plain});
      scheduleSessionListRender&&scheduleSessionListRender();return true})()`);
    const decide = { status: '有风险', line: '接口跑通一半', decision: { question: '老接口要不要保留一个版本', recommendation: '保留一版，下月再删' } };
    await c.eval(`__briefBar.accept([__card('brief-a',${j(decide)}),__card('brief-b',{status:'顺利',line:'在汇总'})])`);
    await sleep(200);
    const bar = () => c.eval(`(()=>{const b=document.getElementById('brief-bar');if(!b)return null;const r=b.getBoundingClientRect(),t=document.getElementById('app-toolbar').getBoundingClientRect();
      return{items:__briefBar.items().map(x=>x.kind),more:b.querySelector('[data-brief-more]')?.textContent||'',cards:[...b.querySelectorAll('.brief-card')].map(x=>({kind:x.dataset.kind,text:x.innerText.replace(/\s+/g,' ').trim()})),top:Math.round(r.top),toolbarBottom:Math.round(t.bottom),w:Math.round(r.width),cx:Math.round(r.left+r.width/2)}})()`);
    let b = await bar();
    ok('等你拍板的卡一来就出简述卡：' + j(b && b.cards), b && b.cards.length === 1 && b.cards[0].kind === 'decide' && /老接口要不要保留一个版本/.test(b.cards[0].text) && /推荐：保留一版/.test(b.cards[0].text));
    ok(`在工具栏下面、水平居中（top ${b.top} ≥ 工具栏底 ${b.toolbarBottom}，中心 ${b.cx}）`, b.top >= b.toolbarBottom && Math.abs(b.cx - 720) < 4 && b.w <= 560);
    await shot('01-请拍板-主页.png');

    // B 状态改成「已完成」：出交卷卡，排在最新。
    await c.eval(`__briefBar.accept([__card('brief-a',${j(decide)}),__card('brief-b',{status:'已完成',line:'周报已生成，放在 D:/w/周报.md'})])`);
    await sleep(200);
    b = await bar();
    ok('状态改成「已完成」出交卷卡；默认只展开最新一张，其余收成「还有 1 条」：' + j([b.items, b.more]), b.items.length === 2 && b.items.includes('handoff') && b.cards.length === 1 && b.more === '还有 1 条');
    await click('#brief-bar [data-brief-more]');
    b = await bar();
    ok('点「还有 1 条」展开两张，交卷卡写结论', b.cards.length === 2 && b.cards.some(x => x.kind === 'handoff' && /周报已生成/.test(x.text)));
    await shot('02-交卷加请拍板.png');

    // 同一会话有简述卡时，答完不再弹回执；别的会话照常。
    const receipt = await c.eval(`(()=>{const sent=[];const orig=ipcRenderer.send;ipcRenderer.send=(ch,p)=>{if(ch==='desktop-notification:show'){sent.push(p.sessionId);return}return orig.call(ipcRenderer,ch,p)};
      const n=require(${R('session-ready-notifier.js')}).createSessionReadyNotifier({ipcRenderer,getSessions:()=>[...sessions.values()].filter(s=>s.id.startsWith('brief-')),isCovered:id=>!!window.__briefBar?.covers(id)});
      n.prime();for(const s of sessions.values())if(s.id.startsWith('brief-'))Object.assign(s,{unreadCount:1,lastCompletedAt:Date.now(),replyReadyText:'完成',attentionState:'reply-ready'});
      sessions.set('brief-c',{id:'brief-c',title:'别的会话',kind:'codeagent',status:'idle',createdAt:Date.now(),lastMessageTime:Date.now(),unreadCount:1,lastCompletedAt:Date.now(),replyReadyText:'完成',attentionState:'reply-ready'});
      const r=n.scan();ipcRenderer.send=orig;return{sent,r:{notified:r.notified,readyCount:r.readyCount}}})()`);
    ok('有简述卡的两个会话不弹回执，别的会话照常弹：' + j(receipt), receipt.sent.length === 1 && receipt.sent[0] === 'brief-c');

    // 真实鼠标点 A 的「打开会话」：跳过去，A 的卡收起。
    await click('#brief-bar .brief-card[data-kind="decide"] .brief-open');
    await until(`activeSessionId==='brief-a'`);
    b = await bar();
    ok('点「打开会话」跳到那个会话、那张卡收起', b && b.cards.length === 1 && b.cards[0].kind === 'handoff');
    await shot('03-打开会话后.png');
    // 点 × 收起交卷卡；重新创建简述条（相当于重开 Hub）不再出现。
    await click('#brief-bar .brief-x');
    ok('点 × 后简述条消失', (await bar()) === null);
    const reopen = await c.eval(`(()=>{const ui=require(${R('brief-bar.js')}).createBriefBar({document,storage:localStorage});ui.accept([__card('brief-b',{status:'已完成',line:'周报已生成'})]);ui.accept([__card('brief-b',{status:'已完成',line:'周报已生成'})]);return ui.items().length})()`);
    ok('收起记录存在本机，重开后同一张卡不再出现', reopen === 0);
    // 5a) 审查阻断 1：先打开会话 B，再切到主页；B 来了新的拍板，卡要留着，不能被当成「已看到」。
    await c.eval(`selectSession('brief-b')`); await until(`activeSessionId==='brief-b'`);
    await click('#btn-home'); await until(`!!window.__hubPageOpen?.()`);
    const q2 = { status: '有风险', line: '周报缺数', decision: { question: '缺的两组数据要不要先空着', recommendation: '先空着，标注待补' } };
    await c.eval(`__briefBar.accept([__card('brief-b',${j(q2)},0)])`); await sleep(200);
    b = await bar();
    ok('停在主页时（上一个打开的是这个会话）新卡照样出现，不被吞掉', b && b.items.includes('decide'));
    await shot('04-切到主页后来卡.png');
    // 5b) 审查阻断 2：点 × 收起后，Agent 只更新卡上别处（修改时间变了），不再弹；问题变了才弹。
    await click('#brief-bar .brief-x');
    await c.eval(`__briefBar.accept([__card('brief-b',${j(q2)},0)])`); await sleep(150);
    ok('收起后卡被再次修改（问题没变）：不再弹', (await bar()) === null);
    const q3 = { ...q2, decision: { question: '要不要延后一天发', recommendation: '延后' } };
    await c.eval(`__briefBar.accept([__card('brief-b',${j(q3)},0)])`); await sleep(150);
    b = await bar();
    ok('拍板问题变了：作为新的一件再弹', b && b.items.length === 1);
    // 6) 「设置 › 桌宠与回执」提醒选「关」：简述条静音；改回后还在等的出现。
    const setMode = mode => c.eval(`ipcRenderer.invoke('hub-pet:set-settings',{notifyMode:'${mode}'}).then(()=>{window.dispatchEvent(new Event('focus'));return true})`);
    await setMode('off'); await sleep(400);
    ok('提醒设成「关」：简述条不显示', (await bar()) === null);
    await setMode('pet'); await sleep(400);
    b = await bar();
    ok('改回后还在等的拍板出现', b && b.items.includes('decide'));
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: true, out: OUT, checks: evidence.checks.length }, null, 2));
  } finally {
    if (c) try { c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
