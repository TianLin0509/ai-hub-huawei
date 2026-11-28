'use strict';
// 启动中心「负责人」下拉 + 右键负责人「创建子会话…」：隔离 Hub（临时数据目录、独立 CDP、窗口隐藏），不调模型、不建真会话。
// 组队数据（负责人清单、挂载接口）在页面里替换成样例，主进程的挂载逻辑由 tests/unit-team-attach-member.test.js 覆盖。验证：
// 1) 侧栏右键负责人出现「创建子会话…」，普通会话没有；2) 点它打开启动中心，「负责人」下拉预选这位负责人、出现任务输入；
// 3) 普通打开启动中心回到「无（独立会话）」；一个负责人都没有时整块不显示；4) 1440 宽页脚不挤出按钮；
// 5) 会话建好后按点「创建会话」那一刻的选择调用挂载，并改成看得懂的标题。
// 6) 选了负责人自动切到 CodeAgent、其他 AI 选项置灰、下拉旁一行说明；选回「无」或关掉启动中心后恢复。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lead-picker-'));
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const LEAD = 'card-question-nav-e2e';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  let hub, c;
  const evidence = { out: OUT, checks: [] };
  const ok = (label, value) => { assert.ok(value, label); evidence.checks.push(label); };
  const until = async expr => { for (let n = 0; n < 300; n++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('timeout ' + expr); };
  const shot = async name => fs.writeFileSync(path.join(OUT, name), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const mouse = async (sel, button = 'left') => {
    await c.eval(`document.querySelector(${j(sel)}).scrollIntoView({block:'center'})`);
    const pos = await c.eval(`(()=>{const r=document.querySelector(${j(sel)}).getBoundingClientRect();return{x:r.x+Math.min(60,r.width/2),y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pos, button, clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pos, button, clickCount: 1 }); await sleep(300);
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'data'), port, windowMode: 'hidden', label: 'lead-picker',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude') } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Page.enable');
    await until('!!window.LaunchLeadPicker && !!window.LaunchCenter?.openSubSession && !!window.__teamUi && !!window.__hubE2E?.cardQuestionNavigator');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 样例：两个 CodeAgent 会话，一个是负责人；负责人清单与挂载接口换成样例。
    await c.eval(String.raw`(()=>{__hubE2E.cardQuestionNavigator.mountFixture({count:0});
      const lead=sessions.get(${j(LEAD)});Object.assign(lead,{kind:'codeagent',title:'接口迁移负责人'});
      sessions.set('plain-0001',{id:'plain-0001',kind:'codeagent',title:'普通会话',status:'idle',createdAt:Date.now(),lastMessageTime:Date.now()});
      window.__isLeadOrig=__teamUi.isLead;__teamUi.isLead=id=>id===${j(LEAD)};
      window.__leadOptions=[{sid:${j(LEAD)},title:'接口迁移负责人',members:2,lastActive:Date.now()}];window.__attachCalls=[];window.__renames=[];
      const orig=ipcRenderer.invoke.bind(ipcRenderer);window.__invokeOrig=orig;
      ipcRenderer.invoke=(ch,a)=>ch==='team:lead-options'?Promise.resolve({ok:true,result:window.__leadOptions})
        :ch==='team:attach-member'?(window.__attachCalls.push(a),Promise.resolve({ok:true,result:{memberId:'m3'}}))
        :ch==='rename-session'?(window.__renames.push(a),Promise.resolve({ok:true})):orig(ch,a);
      renderSessionList();return true})()`);
    await until(`!!document.querySelector('#session-list [data-session-id="plain-0001"]') && !!document.querySelector('#session-list [data-session-id=${j(LEAD)}]')`);
    const menuState = () => c.eval(`(()=>{const m=document.getElementById('context-menu');const b=m.querySelector('[data-action="create-child"]');return{open:m.style.display==='block',child:b&&b.style.display!=='none'}})()`);
    // 1) 普通会话右键：没有「创建子会话…」。
    await mouse('#session-list [data-session-id="plain-0001"]', 'right');
    let m = await menuState();
    ok('普通会话右键菜单里没有「创建子会话…」', m.open && !m.child);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' }); await c.eval(`document.getElementById('context-menu').style.display='none'`);
    // 负责人右键：有，点它打开启动中心并预选。
    await mouse(`#session-list [data-session-id=${j(LEAD)}]`, 'right');
    m = await menuState();
    ok('负责人右键菜单里有「创建子会话…」', m.open && m.child);
    // 休眠的负责人没有这一项。
    await c.eval(`document.getElementById('context-menu').style.display='none';sessions.get(${j(LEAD)}).status='dormant'`);
    await mouse(`#session-list [data-session-id=${j(LEAD)}]`, 'right');
    ok('休眠的负责人右键没有「创建子会话…」', !(await menuState()).child);
    await c.eval(`document.getElementById('context-menu').style.display='none';sessions.get(${j(LEAD)}).status='idle'`);
    await mouse(`#session-list [data-session-id=${j(LEAD)}]`, 'right');
    await shot('01-右键负责人.png');
    await mouse('#context-menu [data-action="create-child"]');
    await until(`document.getElementById('new-session-lead')?.value===${j(LEAD)}`);
    const picker = () => c.eval(`(()=>{const s=document.getElementById('new-session-lead-section'),sel=document.getElementById('new-session-lead'),t=document.getElementById('new-session-lead-task');
      const f=s.closest('.session-create-footer'),btn=document.getElementById('new-session-submit').getBoundingClientRect(),fr=f.getBoundingClientRect();
      return{hidden:s.hidden,value:sel.value,options:[...sel.options].map(o=>o.textContent),task:!t.hidden,active:s.classList.contains('active'),
        submitInside:btn.right<=fr.right+1&&btn.left>=fr.left-1,overflow:f.scrollWidth>f.clientWidth+1}})()`);
    let p = await picker();
    ok('点「创建子会话…」打开启动中心，下拉预选这位负责人并出现任务输入：' + j(p.options), p.value === LEAD && p.task && p.active && p.options[1] === '接口迁移负责人（2 名成员）');
    ok('1440 宽页脚不溢出，「创建会话」按钮仍在页脚内', !p.overflow && p.submitInside);
    const kinds = () => c.eval(`(()=>{const bs=[...document.querySelectorAll('#new-session-menu .new-session-option[data-kind]')];
      return{selected:bs.find(b=>b.classList.contains('selected'))?.dataset.kind||'',disabled:bs.filter(b=>b.disabled).map(b=>b.dataset.kind),enabled:bs.filter(b=>!b.disabled).map(b=>b.dataset.kind),
        note:!document.getElementById('new-session-lead-note').hidden}})()`);
    let k = await kinds();
    ok('选了负责人：自动切到 CodeAgent，其他 AI 置灰，下拉旁有说明：' + j(k), k.selected === 'codeagent' && k.note && k.disabled.includes('claude') && k.disabled.includes('codex')
      && k.enabled.every(x => x === 'codeagent' || x === 'codeagent-lite') && k.enabled.includes('codeagent-lite'));
    // 置灰的选项真实鼠标点不动。
    await mouse('#new-session-menu .new-session-option[data-kind="claude"]');
    ok('点置灰的 Claude Code 不会切过去', (await kinds()).selected === 'codeagent');
    await c.eval(`document.getElementById('new-session-lead-task').value='核对下拉'`);
    await shot('02-启动中心预选负责人.png');
    // 5) 建好会话后按选择挂载（这里直接调挂载那一步，不建真会话）。
    await c.eval(`window.LaunchLeadPicker.attach({id:'child-9999'}, window.LaunchLeadPicker.selection())`); await sleep(200);
    const calls = await c.eval('({a:window.__attachCalls,r:window.__renames})');
    ok('挂载调用带负责人、新会话和任务，并把标题改成任务：' + j(calls), calls.a.length === 1 && calls.a[0].leadSid === LEAD && calls.a[0].sessionId === 'child-9999' && calls.a[0].task === '核对下拉' && calls.r[0]?.title === '核对下拉');
    // 3) 普通打开：回到「无」；没有任何负责人时整块不显示。
    await c.eval(`LaunchCenter.close(); LaunchCenter.open('session')`);
    await until(`document.getElementById('new-session-lead')?.value===''`);
    p = await picker();
    ok('普通打开启动中心回到「无（独立会话）」，任务输入收起', p.value === '' && !p.task && !p.hidden);
    k = await kinds();
    ok('没选负责人时所有 AI 选项恢复可点、说明收起：' + j(k.disabled), k.disabled.length === 0 && !k.note);
    await c.eval(`window.__leadOptions=[];LaunchCenter.close(); LaunchCenter.open('session')`); await sleep(400);
    p = await picker();
    ok('一个负责人都没有时「负责人」整块不显示', p.hidden);
    await shot('03-没有负责人时.png');
    await c.eval(`LaunchCenter.close();ipcRenderer.invoke=window.__invokeOrig;__teamUi.isLead=window.__isLeadOrig;`);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: true, out: OUT, checks: evidence.checks.length }, null, 2));
  } finally {
    if (c) try { c.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
