'use strict';
// 隔离 Electron 的真实卡片、侧栏和 hook 处理函数；输入为模拟记录，不调用真实模型。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r10-ui-'));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(root, 'artifacts'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let hub, c, failure;
  const evidence = { checks: [], mode: '隔离 Electron，模拟记录与 hook，未调用模型', root };
  const ok = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };
  const wait = async expr => { const end = Date.now() + 30000; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(100); } throw Error('界面等待超时：' + expr); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'r10-team',
      extraEnv: { CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Page.enable');
    await wait('!!window._renderTurnCard && !!window.__teamUi');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const state = await c.eval(`(async () => {
      const id='r10-lead-0001', at=Date.now()-10000;
      const s={id,kind:'codeagent',title:'移植验收负责人',status:'idle',unreadCount:1,attentionState:'reply-ready',replyReady:true,replyReadyText:'之前的真实结论'};
      sessions.set(id,s);
      onPromptSubmittedFromHook(id,at,{programMessage:true});
      const afterPrompt={unread:s.unreadCount,reply:s.replyReadyText};
      onReplyCompleteFromHook(id,at+1000,{lastAssistantMessage:'[[hub:no-update]]'});
      const afterSilent={unread:s.unreadCount,reply:s.replyReadyText,status:s.status};
      // 两次 Stop 相隔超过真实的 500 毫秒去重窗。
      await new Promise(r=>setTimeout(r,550));
      onPromptSubmittedFromHook(id,at+2000,{programMessage:true});
      onReplyCompleteFromHook(id,at+3000,{lastAssistantMessage:'功能完成，可交付'});
      const afterReal={unread:s.unreadCount,reply:s.replyReadyText};
      const clean={id:'r10-clean-0001',kind:'codeagent',title:'安静负责人',status:'idle',unreadCount:0};sessions.set(clean.id,clean);
      onPromptSubmittedFromHook(clean.id,at,{programMessage:true});onReplyCompleteFromHook(clean.id,at+1000,{lastAssistantMessage:'[[hub:no-update]]'});
      renderSessionList();
      const host=document.createElement('section');host.id='r10-team-fixture';host.className='msg-overlay';
      host.style.cssText='display:block;position:fixed;inset:70px 50px 60px 300px;z-index:99998;overflow:auto;background:var(--surface-canvas);padding:20px';
      const cards=[
        {id:'r10-short',role:'user',text:'【团队消息 · 2 条】\\n- [m1 消息实现 · 留言] #12 08:00\\n第一条结论\\n- [m1] #13 08:01\\n第二条证据'},
        {id:'r10-file',role:'user',text:'【团队消息 · 4 条 · 原文已存文件】\\n- [m2 独立审查] 4 条 · 7200 字 · #14、#15、#16、#17\\n原文：D:/fixture/batch.md'},
        {id:'r10-recall',role:'user',text:'【回到队里 · 新任务】继续原任务\\n分工：消息实现\\n任务：修复边界'},
        {id:'r10-silent',role:'assistant',text:'[[hub:no-update]]'},
        {id:'r10-real',role:'assistant',text:'[[hub:no-update]]\\n这里还有实际内容，必须展示'},
      ];
      host.innerHTML=cards.map(t=>window._renderTurnCard({...t,kind:'codeagent',ts:Date.now(),simpleChat:true})).join('');document.body.appendChild(host);
      return {afterPrompt,afterSilent,afterReal,cleanUnread:clean.unreadCount,cleanAttention:clean.attentionState};
    })()`);
    evidence.attention = state;
    ok('程序消息不清除之前的未读', state.afterPrompt.unread === 1 && state.afterPrompt.reply === '之前的真实结论');
    ok('静默完成保留旧未读和结论', state.afterSilent.unread === 1 && state.afterSilent.reply === '之前的真实结论');
    ok('真实新回复增加负责人未读', state.afterReal.unread === 2 && state.afterReal.reply === '功能完成，可交付');
    ok('无旧未读的静默负责人仍然安静', state.cleanUnread === 0 && state.cleanAttention !== 'reply-ready');
    await wait("document.querySelector('#r10-team-fixture .team-notice-fold') !== null");
    const ui = await c.eval(`(() => {
      const by=id=>document.querySelector('[data-turn-id="'+id+'"]');
      return {shortWho:by('r10-short').querySelector('.turn-who').textContent,fileWho:by('r10-file').querySelector('.turn-who').textContent,
        recallWho:by('r10-recall').querySelector('.turn-who').textContent,
        summary:by('r10-short').querySelector('.team-notice-line').textContent,
        silentHeight:by('r10-silent').getBoundingClientRect().height,realHeight:by('r10-real').getBoundingClientRect().height,
        folds:['r10-short','r10-file','r10-recall'].map(id=>({id,height:by(id).getBoundingClientRect().height,fold:!!by(id).querySelector('.team-notice-fold')})),
        overflow:document.getElementById('r10-team-fixture').scrollHeight>document.getElementById('r10-team-fixture').clientHeight,
        cleanClass:document.querySelector('[data-session-id="r10-clean-0001"]')?.className};
    })()`);
    evidence.ui = ui;
    ok('短号、落盘索引、叫回任务署名正确', ui.shortWho === 'm1 消息实现' && ui.fileWho === 'm2 独立审查' && ui.recallWho === '负责人');
    ok('短号时间不误当正文摘要', ui.summary === '2 条 · 第一条结论');
    ok('静默暗号隐藏且带实际正文的回复可见', ui.silentHeight === 0 && ui.realHeight > 0);
    ok('团队消息与返工卡片都折成一行', ui.folds.every(x => x.fold && x.height <= 40));
    ok('1440 宽一屏容纳本次卡片', !ui.overflow);
    ok('静默负责人侧栏无未读高亮', !!ui.cleanClass && !ui.cleanClass.includes('need-unread'));
    // 截图让隐藏窗口完成尺寸变化后的合成，随后鼠标坐标才与画面一致。
    const foldedShot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, '20261123-r10-team-codex-folded.png'), Buffer.from(foldedShot.data, 'base64'));
    const selector = '[data-turn-id="r10-short"] .team-notice-line';
    const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();window.__r10Pointer=[];for(const type of ['pointerdown','click'])document.addEventListener(type,event=>window.__r10Pointer.push({type,target:event.target.outerHTML.slice(0,180),x:event.clientX,y:event.clientY}),true);return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    evidence.pointer = { point, hit: await c.eval(`document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,240)`) };
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    evidence.pointer.events = await c.eval('window.__r10Pointer');
    await wait("document.querySelector('[data-turn-id=\"r10-short\"] .team-notice-fold').open");
    ok('真实点击可展开完整消息', await c.eval("document.querySelector('[data-turn-id=\"r10-short\"] .team-notice-fold').open && document.querySelector('[data-turn-id=\"r10-short\"]').innerText.includes('第二条证据')"));
    const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(out, '20261123-r10-team-codex-ui.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { failure = error; evidence.error = error.stack; }
  finally {
    try { if (c) await c.close(); } catch (error) { failure ||= error; }
    try { if (hub) evidence.exit = await gracefulQuit(hub); } catch (error) { failure ||= error; }
    if (hub) fs.writeFileSync(path.join(out, '20261123-r10-team-codex-hub.log'), hub.log().join('\n'), 'utf8');
    hub?.child.stdout?.destroy(); hub?.child.stderr?.destroy(); hub?.child.stdin?.destroy();
    evidence.ok = !failure;
    fs.writeFileSync(path.join(out, '20261123-r10-team-codex-ui-evidence.json'), JSON.stringify(evidence, null, 2));
    // 外置证据已经保存，只清理这次 mkdtemp 创建的隔离用户数据。
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('hub-r10-ui-') && path.relative(root, out).startsWith('..')) fs.rmSync(root, { recursive: true });
  }
  if (failure) throw failure;
  console.log(`通过 ${evidence.checks.length} 项隔离界面验证：${out}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
