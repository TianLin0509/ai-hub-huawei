'use strict';
// PPT 页「做页」Tab 端到端（2026-11-11）：真实隔离 Hub 窗口（无头）+ CDP 鼠标键盘；全新用户，没有 PPT Doctor、没有素材包、没有模型。
// 样例、粘贴生成、预览、右栏都走真实主进程与引擎；「模型提交页面说明」是夹具（界面的开始 / 轮询回包被替换，生成那一步仍由主进程真实执行）；
// 打开 PowerPoint、插入当前文稿、写剪贴板的回包是夹具（真实 PowerPoint 另行验证）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const out = process.env.PPT_UI_OUT || path.resolve(__dirname, '../artifacts', `ppt-make-${Date.now()}`);

// 模型回包夹具：一条句末带句号、一个素材库里没有的素材、两个图位。
const MODEL_SPEC = { title: '示例页：两项改进叠加，指标提升XX%', col: [
  { row: [
    { type: 'panel', head: '现状与问题', body: { type: 'text', items: ['现有做法看不到全局信息。', '高负载下 {r:XX%} 用户速率不达标'] } },
    { type: 'panel', head: '验证结果', body: { col: [{ type: 'image', placeholder: '指标对比曲线' }, { type: 'image', placeholder: '测试过程截图' }] } },
  ] },
  { type: 'material', name: '灰渐变屋顶栏头', size: 40 },
  { type: 'bar', t: '两项改进叠加后指标提升 XX%，待补数据' },
] };
const PASTED = { title: '粘贴页：别的模型写好的页面说明', col: [{ type: 'text', items: ['直接生成，不经过助理', '关键数字 {r:1.3X}'] }, { type: 'bar', t: '粘贴的页面说明可以直接生成' }] };

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-make-e2e-')), dataDir = path.join(root, 'data');
  for (const dir of [dataDir, out]) fs.mkdirSync(dir, { recursive: true });
  // 全新用户：只开了助理这个可选功能，别的什么都没配。
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  const result = { provenance: '真实隔离Hub/CDP鼠标键盘，全新数据目录（无Doctor、无素材包、无模型）；样例/粘贴生成/预览为真实主进程与引擎；模型提交、PowerPoint打开与插入、剪贴板为夹具', root, checks: [], shots: [] };
  let hub, c;
  const wait = async (expr, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(200); } throw new Error('timeout: ' + label); };
  const click = async selector => { const r = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw new Error('missing selector '+${j(selector)});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 }); };
  const text = selector => c.eval(`document.querySelector(${j(selector)})?.textContent||''`);
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const target = path.join(out, `20261111-ppt-make-${name}-claude.png`); fs.writeFileSync(target, Buffer.from(image.data, 'base64')); result.shots.push(target); };
  // 一屏：页面和三栏都不出现纵向滚动，栏内内容没有被裁掉，底部按钮在可视范围内。
  const oneScreen = async label => {
    const m = await c.eval(`(()=>{const s=document.querySelector('#company-ppt-page .pptw-scroll'),d=document.scrollingElement;const cols=[...document.querySelectorAll('.pptk-left,.pptk-main,.pptk-side')].map(e=>({over:e.scrollHeight-e.clientHeight,bottom:e.getBoundingClientRect().bottom}));const last=[...document.querySelectorAll('.pptk-left>:last-child,.pptk-side>:last-child,.pptk-main>:last-child')].map(e=>e.getBoundingClientRect().bottom);return{w:innerWidth,h:innerHeight,page:s.scrollHeight-s.clientHeight,doc:d.scrollHeight-d.clientHeight,cols,last}})()`);
    assert.deepEqual([m.w, m.h], [1440, 900]);
    assert.ok(m.page <= 1 && m.doc <= 1, `${label}：页面出现纵向滚动 ${m.page}/${m.doc}px`);
    m.cols.forEach((col, i) => { assert.ok(col.over <= 1, `${label}：第 ${i + 1} 栏内容超出 ${col.over}px`); assert.ok(col.bottom <= 900, `${label}：第 ${i + 1} 栏超出窗口`); });
    assert.ok(m.last.every(b => b <= 900), `${label}：有内容落在一屏之外`);
  };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: 'ppt-make', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_WELINK_CLI: welinkStub, PPTX_FINDER_DATA_DIR: path.join(root, 'pptx-finder') } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('!!document.getElementById("btn-company-ppt")', 'PPT nav'); await click('#btn-company-ppt');
    await wait('!!document.querySelector("[data-ppt-tab=make]")', 'make tab button');

    // 1) 全新用户点「做页」：不用任何配置，立刻出一页骨架样例
    await click('[data-ppt-tab="make"]');
    await wait('!!document.querySelector(".pptk-slide svg") && !document.querySelector(".pptk-busy")', 'first example preview');
    assert.equal(await c.eval('document.querySelector("[data-ppt-make-panel]").hidden'), false);
    assert.equal(await c.eval('document.querySelector("[data-ppt-search-panel]").hidden && document.querySelector("[data-ppt-materials-panel]").hidden'), true, '做页 Tab 不显示找页和素材面板');
    const count = await c.eval('document.querySelectorAll(".pptk-sk").length');
    assert.ok(count >= 5, '骨架列表');
    assert.match(await text('[data-pptk-cap]'), /骨架样例/);
    assert.ok(await c.eval('document.querySelectorAll(".pptk-slide svg *").length') > 30, '预览里画出了形状');
    const ratio = await c.eval('(()=>{const b=document.querySelector(".pptk-slide").getBoundingClientRect();return b.width/b.height})()');
    assert.ok(Math.abs(ratio - 16 / 9) < 0.02, '预览是 16:9');
    assert.match(await text('[data-pptk-side]'), /自查提醒/); assert.match(await text('[data-pptk-side]'), /待贴图位/); assert.match(await text('.pptk-stat'), /字数\d+最小字号\d+ pt/);
    await oneScreen('首次打开');
    await shot('01-first-open');
    result.checks.push(`全新用户：点「做页」直接出骨架样例预览（${count} 个骨架，不依赖素材包和模型），1440×900 无纵向滚动`);

    // 1b) 分类筛选与一屏分页：骨架多于一屏时翻页不滚动；切分类后列表只剩该类
    const all = (await c.eval(`ipcRenderer.invoke('company-assistant:ppt-make-skeletons')`)).skeletons;
    const listIds = () => c.eval('[...document.querySelectorAll(".pptk-sk")].map(e=>e.dataset.id)');
    const pagerText = () => text('[data-pptk-pager] span');
    assert.match(await c.eval('document.querySelector("[data-pptk-cat]").selectedOptions[0].textContent'), new RegExp('全部 · ' + all.length));
    assert.ok(await pagerText(), `${all.length} 个骨架一屏放不下时有翻页`);
    const page1 = await listIds();
    await click('[data-pptk="next"]');
    await wait(`(()=>{const ids=[...document.querySelectorAll(".pptk-sk")].map(e=>e.dataset.id);return ids.length&&!ids.includes(${j(page1[0])})})()`, 'list next page');
    await oneScreen('骨架翻页');
    const cat = '方案与原理', inCat = all.filter(s => s.category === cat).map(s => s.id);
    await c.eval(`(()=>{const s=document.querySelector("[data-pptk-cat]");s.value=${j(cat)};s.dispatchEvent(new Event("change"))})()`);
    await wait(`[...document.querySelectorAll(".pptk-sk")].every(e=>${j(inCat)}.includes(e.dataset.id))`, 'category filter');
    const catPage = await listIds(), perPage = page1.length, catPages = Math.ceil(inCat.length / perPage);
    assert.deepEqual(catPage, inCat.slice(0, perPage), '分类第一页');
    assert.equal(await pagerText(), catPages > 1 ? `1 / ${catPages}` : '', '分类内按高度分页');
    await oneScreen('分类筛选');
    await shot('01b-category');
    result.checks.push(`分类筛选：全部 ${all.length} 个骨架每页 ${perPage} 个、翻页不滚动；切到「${cat}」只剩该类 ${inCat.length} 个（${catPages} 页），1440×900 无纵向滚动`);
    await c.eval('(()=>{const s=document.querySelector("[data-pptk-cat]");s.value="";s.dispatchEvent(new Event("change"))})()');
    await wait(`document.querySelector(".pptk-sk")?.dataset.id===${j(page1[0])}`, 'back to all');

    // 1c) 下载整套模板：不经模型、不依赖素材包，生成全部骨架的多页 pptx 并用 PowerPoint 打开（打开回包为夹具）
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__packRestore=()=>{ipcRenderer.invoke=invoke};window.__packOpen=[];ipcRenderer.invoke=(ch,a)=>{if(ch==='company-assistant:ppt-make-open'){window.__packOpen.push(a.jobId);return Promise.resolve({ok:true})}return invoke(ch,a)}})()`);
    await click('[data-pptk="pack"]');
    await wait('/已生成 \\d+ 页的整套模板/.test(document.querySelector("[data-ppt-notice]").textContent)', 'pack notice', 60000);
    const packNote = await text('[data-ppt-notice]'), packFile = packNote.split('：').pop();
    assert.ok(packNote.includes(`已生成 ${all.length} 页`) && packFile.endsWith(`通用汇报页模板包-${all.length}页.pptx`) && fs.existsSync(packFile), packNote);
    assert.equal((await c.eval('window.__packOpen')).length, 1, '生成后用 PowerPoint 打开');
    const { openZip, readEntry } = require('../core/company-assistant/ppt-slide-preview');
    assert.equal((readEntry(openZip(packFile), 'ppt/presentation.xml').toString('utf8').match(/<p:sldId /g) || []).length, all.length, '模板包页数等于骨架数');
    await oneScreen('下载整套模板');
    await shot('01c-pack');
    await c.eval('window.__packRestore()');
    result.checks.push(`下载整套模板：全新用户一键生成 ${all.length} 页模板包（${require('node:path').basename(packFile)}）并调用 PowerPoint 打开`);

    // 2) 切换骨架 →「先看骨架样子」
    const firstSvg = await c.eval('document.querySelector(".pptk-slide").innerHTML.length');
    await click('.pptk-sk:nth-child(4)');
    const picked = await text('.pptk-sk.on b');
    assert.match(await text('[data-pptk-chain]'), /^论证链：/);
    await click('[data-pptk="example"]');
    await wait(`document.querySelector("[data-pptk-cap] span")?.textContent===${j(picked)} && !document.querySelector(".pptk-busy")`, 'switched example');
    assert.notEqual(await c.eval('document.querySelector(".pptk-slide").innerHTML.length'), firstSvg, '换了骨架，预览跟着换');
    await oneScreen('切换骨架');
    await shot('02-switch-skeleton');
    result.checks.push(`切换到「${picked}」并点「先看骨架样子」：预览换成该骨架的示意页`);

    // 3) 生成这一页：没写内容先就地提醒；写了以后显示人话状态和已用时间；模型提交（夹具）后右栏出现提醒与图位
    await click('[data-pptk="start"]');
    await wait('/先写一句/.test(document.querySelector("[data-ppt-notice]").textContent)', 'empty brief notice');
    const seed = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-make-example',{skeletonId:${j('gain-steps')}})`);
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__mk={phase:'waiting',calls:[],invoke};const id=${j(seed.job.id)},waiting={id,kind:'make',skeleton:'夹具',state:'waiting_agent',startedAt:Date.now(),rev:0,submits:0};
      ipcRenderer.invoke=async(ch,a)=>{const name=ch.replace('company-assistant:','');
        if(name==='ppt-make-start'){window.__mk.calls.push([name,a]);waiting.startedAt=Date.now();return{ok:true,job:waiting}}
        if(name==='ppt-make-status'&&a.jobId===id){if(window.__mk.phase==='waiting')return{ok:true,job:waiting};if(window.__mk.phase==='submit'){window.__mk.phase='done';await invoke('company-assistant:ppt-make-rerender',{jobId:id,spec:${j(MODEL_SPEC)}})}return invoke(ch,a)}
        if(['ppt-make-open','ppt-make-insert','ppt-make-folder'].includes(name)){window.__mk.calls.push([name,a.jobId]);return name==='ppt-make-insert'?{ok:true,page:5,target:'季度汇报.pptx'}:{ok:true}}
        return invoke(ch,a)}})()`);
    await click('[data-pptk-brief]'); await c.send('Input.insertText', { text: '两项改进叠加后，指标提升，数据待补' });
    await click('[data-pptk="start"]');
    await wait('document.querySelector(".pptk-busy b")?.textContent==="正在让助理写页面内容…"', 'waiting state');
    await wait('/已用 [1-9]\\d* 秒/.test(document.querySelector("[data-pptk-clock]")?.textContent||"")', 'elapsed clock', 8000);
    assert.deepEqual(await c.eval('window.__mk.calls[0]'), ['ppt-make-start', { skeletonId: await c.eval('document.querySelector(".pptk-sk.on").dataset.id'), brief: '两项改进叠加后，指标提升，数据待补' }]);
    await oneScreen('生成中');
    await shot('03-generating');
    await c.eval('window.__mk.phase="submit"');
    await wait('document.querySelectorAll(".pptk-warn li").length>0 && !document.querySelector(".pptk-busy")', 'model result');
    const warns = await c.eval('[...document.querySelectorAll(".pptk-warn li")].map(e=>e.textContent)');
    assert.ok(warns.some(w => /句号/.test(w)) && warns.some(w => /素材库里没有/.test(w)), '自查提醒：' + warns.join(' | '));
    const slots = await c.eval('[...document.querySelectorAll(".pptk-slots li")].map(e=>e.textContent)');
    assert.ok(slots.includes('指标对比曲线') && slots.includes('测试过程截图'), '待贴图位：' + slots.join(' | '));
    assert.match(await text('[data-pptk-cap]'), /生成结果/);
    assert.match(await c.eval('document.querySelector(".pptk-slide").innerHTML'), /示例页/);
    await oneScreen('模型提交后');
    await shot('04-result-warnings');
    result.checks.push(`生成这一页：等待时显示「正在让助理写页面内容…」和已用时间；模型提交（夹具）后右栏列出 ${warns.length} 条自查提醒、${slots.length} 个待贴图位，预览换成新页`);

    // 4) 右栏按钮：打开、插入、所在文件夹按当前任务调用（回包为夹具）
    await click('[data-pptk="open"]'); await wait('/已用 PowerPoint 打开/.test(document.querySelector("[data-ppt-notice]").textContent)', 'open notice');
    await click('[data-pptk="insert"]'); await wait('/已插入到「季度汇报.pptx」第 5 页/.test(document.querySelector("[data-ppt-notice]").textContent)', 'insert notice');
    await click('[data-pptk="folder"]'); await wait('window.__mk.calls.length===4', 'folder call');
    assert.deepEqual(await c.eval('window.__mk.calls.slice(1)'), [['ppt-make-open', seed.job.id], ['ppt-make-insert', seed.job.id], ['ppt-make-folder', seed.job.id]]);
    // 手改页面说明：打开编辑框，里面是当前这页的 JSON
    await click('[data-pptk="edit"]');
    assert.equal(JSON.parse(await c.eval('document.querySelector("[data-pptk-spec]").value')).title, MODEL_SPEC.title);
    await oneScreen('手改页面说明');
    await click('[data-pptk="edit-cancel"]');
    result.checks.push('用 PowerPoint 打开 / 插入到当前文稿 / 打开所在文件夹：按当前这一页调用，结果写在提示里；「改页面说明后重新生成」打开当前页的 JSON');

    // 5) 粘贴页面说明：写错了就地说第几行；别的 AI 带代码块围栏的回答也能直接生成
    await click('[data-pptk="paste"]');
    await wait('!!document.querySelector("[data-pptk-spec]")', 'paste box');
    await c.send('Input.insertText', { text: '{\n  "title": "少了逗号"\n  "col": []\n}' });
    await click('[data-pptk="paste-go"]');
    await wait('!document.querySelector("[data-pptk-err]").hidden', 'json error');
    assert.match(await text('[data-pptk-err]'), /第 3 行附近有错/);
    await oneScreen('粘贴出错');
    await shot('05-paste-error');
    await c.eval(`(()=>{const e=document.querySelector("[data-pptk-spec]");e.value=${j('好的，页面说明如下：\n```json\n' + JSON.stringify(PASTED, null, 2) + '\n```\n')}})()`);
    await click('[data-pptk="paste-go"]');
    await wait('!document.querySelector("[data-pptk-spec]") && /粘贴页/.test(document.querySelector(".pptk-slide")?.innerHTML||"")', 'pasted page');
    assert.equal(await text('.pptk-ok'), '没有发现问题');
    assert.equal(await text('.pptk-none'), '这一页没有留图位');
    await oneScreen('粘贴生成');
    result.checks.push('粘贴页面说明：JSON 写错时就地提示「第 3 行附近有错」；带代码块围栏的回答直接生成，不经助理');

    // 6) 复制写法说明：点击时才写剪贴板（这里换成记录，不动系统剪贴板）
    const stubbed = await c.eval('(()=>{const cb=require("electron").clipboard;window.__copied=null;try{cb.writeText=t=>{window.__copied=t}}catch{}return cb.writeText.toString().includes("__copied")})()');
    if (stubbed) {
      await click('[data-pptk="guide"]');
      await wait('typeof window.__copied==="string"', 'guide copied');
      const copied = await c.eval('window.__copied');
      assert.ok(copied.includes(picked) && copied.includes('只输出一个 JSON 对象') && copied.includes('"title"'));
      await wait('/已复制/.test(document.querySelector("[data-ppt-notice]").textContent)', 'guide notice');
      result.checks.push(`复制写法说明：剪贴板内容含「${picked}」的骨架说明、写法规则和示意 JSON（${copied.length} 字）`);
    } else {
      const guide = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-make-guide',{skeletonId:document.querySelector(".pptk-sk.on").dataset.id})`);
      assert.ok(guide.ok && guide.text.includes(picked));
      result.checks.push('复制写法说明：剪贴板替换不了，只核对了写法说明通道返回的文字，未点击按钮');
    }

    // 7) 失败：写明原因和下一步，按钮就在旁边
    await c.eval(`(()=>{const prev=ipcRenderer.invoke;ipcRenderer.invoke=(ch,a)=>ch==='company-assistant:ppt-make-start'?Promise.resolve({ok:false,error:'CodeAgent 还没登录（故障夹具）'}):prev(ch,a)})()`);
    await click('[data-pptk="start"]');
    await wait('!!document.querySelector(".pptk-fail")', 'failure card');
    assert.match(await text('.pptk-fail'), /CodeAgent 还没登录（故障夹具）/); assert.match(await text('.pptk-fail'), /下一步：/);
    assert.equal(await c.eval('document.querySelectorAll(".pptk-fail [data-pptk]").length'), 2);
    await oneScreen('失败提示');
    await shot('06-failure');
    await click('.pptk-fail [data-pptk="example"]');
    await wait('!!document.querySelector(".pptk-slide svg") && !document.querySelector(".pptk-fail") && !document.querySelector(".pptk-busy")', 'recover by example');
    result.checks.push('失败时写明原因和下一步，「重试」「先看骨架样子」就在提示里，点一下恢复预览');

    // 8) 切到别的 Tab 再回来：三个面板互不串
    await click('[data-ppt-tab="materials"]');
    await wait('document.querySelector("[data-ppt-make-panel]").hidden && !document.querySelector("[data-ppt-materials-panel]").hidden', 'materials tab');
    await click('[data-ppt-tab="find"]');
    await wait('document.querySelector("[data-ppt-make-panel]").hidden && document.querySelector("[data-ppt-materials-panel]").hidden && !document.querySelector("[data-ppt-search-panel]").hidden', 'find tab');
    await click('[data-ppt-tab="make"]');
    await wait('!document.querySelector("[data-ppt-make-panel]").hidden && !!document.querySelector(".pptk-slide svg")', 'back to make');
    await oneScreen('切回做页');
    result.checks.push('找页 / 素材 / 做页三个 Tab 来回切换：各自面板互不影响，回到做页时上一页预览还在');
    // 9) 不选骨架，直接出 3 版：一段描述建一组三个方案，写好一版先看一版，方案条上切换（助理回包为夹具，三版的文件与预览是真实引擎生成）
    const seeds = [];
    for (const sk of all.slice(0, 3)) seeds.push((await c.eval(`ipcRenderer.invoke('company-assistant:ppt-make-example',{skeletonId:${j(sk.id)}})`)).job);
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);const done=${j(seeds)}.map((s,i)=>({...s,kind:'make',groupId:'g1',variant:'方案 '+'ABC'[i],skeleton:'方案 '+'ABC'[i]+' · '+s.skeleton}));
      const waiting=d=>({id:d.id,kind:'make',groupId:'g1',variant:d.variant,skeleton:d.variant,state:'waiting_agent',startedAt:Date.now(),rev:0,submits:0});
      window.__auto={ready:0,calls:[],restore:()=>{ipcRenderer.invoke=invoke}};
      ipcRenderer.invoke=(ch,a)=>{const name=ch.replace('company-assistant:','');
        if(name==='ppt-make-auto'){window.__auto.calls.push(a);return Promise.resolve({ok:true,groupId:'g1',jobs:done.map(waiting)})}
        const i=done.findIndex(d=>d.id===a?.jobId);
        if(name==='ppt-make-status'&&i>=0)return Promise.resolve({ok:true,job:i<window.__auto.ready?done[i]:waiting(done[i])});
        return invoke(ch,a)}})()`);
    await c.eval('(()=>{const t=document.querySelector("[data-pptk-brief]");t.value="三项措施叠加后指标提升，数据待补";})()');
    await click('[data-pptk="auto"]');
    await wait('document.querySelectorAll(".pptk-vars .pptk-var").length===3 && !!document.querySelector(".pptk-busy")', 'auto group waiting');
    assert.deepEqual(await c.eval('window.__auto.calls'), [{ brief: '三项措施叠加后指标提升，数据待补' }]);
    await oneScreen('三版等待中');
    await shot('07-auto-waiting');
    await c.eval('window.__auto.ready=1');
    await wait('!!document.querySelector(".pptk-slide svg") && !document.querySelector(".pptk-busy")', 'first variant ready');
    assert.match(await text('.pptk-var.on'), /^方案 A$/);
    assert.equal(await c.eval('[...document.querySelectorAll(".pptk-var")].filter(e=>e.textContent.includes("…")).length'), 2, '另外两版还在写');
    await c.eval('window.__auto.ready=3');
    await wait('[...document.querySelectorAll(".pptk-var")].every(e=>!e.textContent.includes("…"))', 'all variants ready');
    await click('.pptk-var:nth-child(2)');
    await wait('document.querySelector(".pptk-var.on")?.textContent==="方案 B" && !!document.querySelector(".pptk-slide svg") && !document.querySelector(".pptk-busy")', 'switch to variant B');
    assert.ok((await text('[data-pptk-cap]')).includes(seeds[1].skeleton), '切到方案 B 后显示它用的骨架');
    await oneScreen('三版切换');
    await shot('08-auto-variants');
    await c.eval('window.__auto.restore()');
    result.checks.push('不选骨架直接出 3 版：一次提问建三个方案；第一版写好即可预览，其余在方案条上显示进行中；写完后点方案 B 切换预览；1440×900 无纵向滚动');
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    if (c) { try { result.lastNotice = await c.eval('document.querySelector("[data-ppt-notice]")?.textContent'); await shot('failed'); } catch (captureError) { result.captureError = captureError.message; } }
    throw error;
  } finally {
    if (c) await c.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261111-ppt-make-evidence-claude.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 隔离目录删不掉时留在系统临时目录 */ }
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
