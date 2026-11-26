'use strict';
// 跳转后台（renderer/backstage-jump.js，2026-11-26）真实界面走查：隐藏的隔离 Hub + 真 PowerShell 会话当后台会话，鼠标点击。
//   助理、分身、会议、帖子四个入口：按钮在不在、状态点、点了是否切到主页该会话的后台终端、返回条一键回原入口；
//   会话已关闭 / 还没有会话时就地说明。各功能的数据用 IPC 夹具替换，不登录、不调真实模型、不碰真实 WeLink。
// 用法：node tests/e2e-backstage-jump-cdp.js [截图目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const D = require('../core/company-assistant/data');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/backstage-jump-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// 分身夹具（合成消息 + 两个分身）沿用分身页 E2E 的写法，直接从那份文件里取出来用，免得两份漂移。
const avatarSrc = fs.readFileSync(path.join(__dirname, 'e2e-avatar-page-cdp.js'), 'utf8');
const seedStart = avatarSrc.indexOf('const ME = '), seedEnd = avatarSrc.indexOf('\n(async () => {', seedStart);
assert.ok(seedStart > 0 && seedEnd > seedStart, 'avatar seed extraction boundary');
// eslint-disable-next-line no-new-func
const { seedSnapshot, seedFleet } = new Function('fs', 'path', 'crypto', 'D', avatarSrc.slice(seedStart, seedEnd) + '\nreturn { seedSnapshot, seedFleet };')(fs, path, crypto, D);
// 会议夹具沿用会议流程 E2E 的 installFixture。
const meetingSrc = fs.readFileSync(path.join(__dirname, 'e2e-company-meeting-flow-cdp.js'), 'utf8');
const fxStart = meetingSrc.indexOf('function installFixture() {'), fxEnd = meetingSrc.indexOf('\n(async () => {', fxStart);
assert.ok(fxStart >= 0 && fxEnd > fxStart, 'meeting fixture extraction boundary');
const meetingFixture = meetingSrc.slice(fxStart, fxEnd).trim();

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backstage-jump-')), dataDir = path.join(root, 'data'), work = path.join(root, 'work');
  for (const p of [dataDir, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: true }));
  const now = Date.now(), snap = seedSnapshot(dataDir, now); seedFleet(dataDir, now, snap);
  const result = { passed: false, checks: [], screenshots: [], fixture: '隔离 Hub（隐藏窗口）+ 真 PowerShell 会话当后台会话；助理/分身/会议/帖子数据为 IPC 夹具；不登录、不调模型' };
  const record = () => fs.writeFileSync(path.join(out, 'backstage-jump-cdp.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'backstage-jump', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work,
      AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: path.join(root, 'welink.jsonl'), WELINK_STANDIN_ANY_GROUP: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const q = s => `document.querySelector(${JSON.stringify(s)})`;
    const until = async (expr, label, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { try { if (await c.eval(expr)) return; } catch { /* 页面还没好 */ } await _waitMs(150); } throw Error('timeout: ' + label); };
    const click = async (selector, label = selector) => {
      await until(`(()=>{const e=${q(selector)};return !!e&&e.getBoundingClientRect().width>0;})()`, label);
      const point = await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);if(!(e===h||e.contains(h)))throw Error('covered '+${JSON.stringify(selector)}+' by '+(h&&h.className));return{x,y};})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { await _waitMs(350); const s = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, `20261126-跳转后台-${name}.png`); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); result.screenshots.push(file); record(); };
    const check = text => { result.checks.push(text); record(); };
    const diag = () => c.eval(`JSON.stringify({active:activeSessionId,view:currentView,pop:document.getElementById('hub-bs-pop')?.textContent||'',ret:!!document.getElementById('hub-bs-return'),btns:[...document.querySelectorAll('.hub-bs-btn')].filter(b=>b.offsetParent).map(b=>[b.dataset.hubBackstage,b.dataset.tone,b.dataset.busy||'']),clicks:window.__bsClicks||[]})`);
    await c.eval(`window.__bsClicks=[];document.addEventListener('click',e=>{const t=e.target;window.__bsClicks.push((t.className&&String(t.className).slice(0,40))||t.tagName);if(window.__bsClicks.length>12)window.__bsClicks.shift();},true)`);
    // 先诊断：点「后台」先出自检弹层，读出结论后再点「进入后台」。
    const panel = async (btnSel, label) => {
      await c.eval(`document.getElementById('hub-bs-pop')?.remove()`);
      await click(btnSel, label);
      await until(`!!document.querySelector('#hub-bs-pop.hub-bs-panel')`, label + ' panel');
      return c.eval(`(()=>{const p=document.getElementById('hub-bs-pop');return{cause:p.dataset.cause,level:p.dataset.level,title:p.querySelector('strong')?.textContent||'',why:p.querySelector('.hub-bs-why')?.textContent||'',todo:p.querySelector('.hub-bs-todo')?.textContent||'',fixes:[...p.querySelectorAll('.hub-bs-fix')].map(b=>b.textContent),enter:!!p.querySelector('[data-hub-bs-enter]'),recreate:!!p.querySelector('[data-hub-bs-recreate]'),text:p.textContent}})()`);
    };
    const enter = async (btnSel, label) => { const r = await panel(btnSel, label); await click('#hub-bs-pop [data-hub-bs-enter]', label + ' enter'); return r; };
    const jumped = id => `activeSessionId===${JSON.stringify(id)} && currentView==='pty' && !!document.getElementById('hub-bs-return')`;

    await until(`document.readyState==='complete' && !!${q('#btn-company-assistant')}`, 'company nav');
    // 一个真 PTY 会话当「后台会话」：先建一个当助理的，再建一个当分身的。
    const mk = async title => c.eval(`(async()=>{const r=await ipcRenderer.invoke('create-session',{kind:'powershell',opts:{title:${JSON.stringify(title)}}});return r?.id||r?.session?.id||r?.sessionId||''})()`);
    const s1 = await mk('助理问答 · 跳转后台验收'), s2 = await mk('分身 · 工具答疑');
    assert.ok(s1 && s2, 'sessions created: ' + JSON.stringify([s1, s2]));
    await until(`sessions.has(${JSON.stringify(s1)}) && sessions.has(${JSON.stringify(s2)})`, 'sessions in renderer map');
    result.sessions = { assistant: s1, avatar: s2 }; record();
    // 各功能状态里填上会话 id（夹具）：助理 status.session、分身每个 avatars[i].session、帖子 status.session。
    await c.eval(`(()=>{const original=ipcRenderer.invoke.bind(ipcRenderer);window.__bsFx={assistant:${JSON.stringify(s1)},avatar:${JSON.stringify(s2)},forum:''};
      ipcRenderer.invoke=async(ch,a)=>{const r=await original(ch,a);
        if(ch==='company-assistant:status'&&r&&typeof r==='object')return {...r,session:window.__bsFx.assistant?{id:window.__bsFx.assistant,open:true,busy:false}:null,chat:window.__bsFx.chatError?[...(r.chat||[]),{id:'bs-err',q:'帮我查一下',state:'error',error:window.__bsFx.chatError,at:Date.now()}]:r.chat};
        if(String(ch).startsWith('avatar:')&&r&&Array.isArray(r.avatars))return {...r,avatars:r.avatars.map(x=>({...x,session:{id:window.__bsFx.avatar,alive:true,questions:3}}))};
        if(ch==='company-forum:status'&&r&&typeof r==='object')return {...r,session:window.__bsFx.forum||null};
        return r;};})()`);

    // ---------- 1. 助理 ----------
    await click('#btn-company-assistant');
    await until(`!${q('#company-assistant-page')}?.hidden && !!${q('#company-assistant-page .hub-bs-btn')}`, 'assistant backstage button');
    const aBtn = await c.eval(`(()=>{const b=${q('#company-assistant-page .ca-head .hub-bs-btn')};const r=b.getBoundingClientRect(),h=b.closest('.ca-head').getBoundingClientRect();return{tone:b.dataset.tone,sid:b.dataset.hubBackstage,title:b.title,inHead:r.top>=h.top&&r.bottom<=h.bottom,h:r.height}})()`);
    assert.equal(aBtn.sid, s1); assert.equal(aBtn.inHead, true, '按钮在页头内，没有折行');
    assert.match(aBtn.title, /助理的后台会话：/);
    await shot('01-助理-页头后台按钮');
    check(`助理：页头右侧出现「后台」按钮，状态点 ${aBtn.tone}（悬停：${aBtn.title.split('\n')[0]}）`);
    const aDiag = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant');
    assert.equal(aDiag.cause, 'ok'); assert.equal(aDiag.enter, true);
    await shot('02a-助理-先自检-正常');
    check(`助理：点「后台」先出自检「${aDiag.title}」——${aDiag.why}；里面有「进入后台」「复制诊断信息」`);
    // 复制诊断信息：脱敏摘要（剪贴板用夹具接住，不写系统剪贴板）
    await c.eval(`window.__bsCopied=[];require('electron').clipboard.writeText=t=>{window.__bsCopied.push(String(t));}`);
    await click('#hub-bs-pop [data-hub-bs-copy]', 'copy diag');
    await until(`window.__bsCopied.length===1`, 'diag copied');
    result.diagnosticSample = await c.eval(`window.__bsCopied[0]`);
    assert.match(result.diagnosticSample, /版本：v\d+\.\d+\.\d+/); assert.match(result.diagnosticSample, /入口：助理/); assert.match(result.diagnosticSample, /自检结论：后台正常（ok）/);
    assert.doesNotMatch(result.diagnosticSample, new RegExp(s1.slice(9)));
    check('助理：「复制诊断信息」得到脱敏摘要（版本、入口、后台状态、结论、能力，会话编号只留前 8 位）');
    await click('#hub-bs-pop [data-hub-bs-enter]', 'assistant enter');
    await until(jumped(s1), 'assistant jump');
    assert.equal(await c.eval(`${q('#company-assistant-page')}.hidden`), true, '助理页收起');
    assert.match(await c.eval(`${q('#hub-bs-return')}.textContent`), /返回助理/);
    await shot('02-助理-跳到后台终端与返回条');
    check('助理：点「后台」切到主页并选中那个会话、打开后台终端；顶部出现「← 返回助理」');
    await click('#hub-bs-return [data-hub-bs-back]');
    await until(`!${q('#company-assistant-page')}?.hidden && !document.getElementById('hub-bs-return')`, 'back to assistant');
    await shot('03-助理-一键返回');
    check('助理：点「返回助理」回到助理页，返回条收起');
    // 会话已关闭：就地说明 + 重新打开
    await c.eval(`window.__bsFx.assistant='closed-session-id'`);
    await c.eval(`(async()=>{await window.__companyAssistantHide?.();})()`); await click('#btn-company-assistant');
    await until(`${q('#company-assistant-page .ca-head .hub-bs-btn')}?.dataset.hubBackstage==='closed-session-id'`, 'assistant closed id');
    assert.equal(await c.eval(`${q('#company-assistant-page .ca-head .hub-bs-btn')}.dataset.tone`), 'closed');
    const d1 = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant closed');
    const pop1 = d1.title + '：' + d1.why + d1.todo;
    assert.equal(d1.cause, 'session-gone'); assert.equal(d1.recreate, true); assert.equal(d1.enter, false);
    assert.equal(await c.eval(`${q('#company-assistant-page')}.hidden`), false, '没跳走，留在助理页');
    await shot('04-助理-会话已关闭就地说明');
    check(`助理：会话已关闭时不跳走，自检说明「${pop1}」，给「重新打开」`);
    await c.eval(`document.getElementById('hub-bs-pop')?.remove()`);
    // 还没有会话
    await c.eval(`window.__bsFx.assistant=''`); await c.eval(`window.__companyAssistantHide?.()`); await click('#btn-company-assistant');
    await until(`${q('#company-assistant-page .ca-head .hub-bs-btn')}?.dataset.tone==='none'`, 'assistant no session');
    const d2 = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant none');
    const pop2 = d2.title + '：' + d2.why;
    assert.equal(d2.cause, 'not-started');
    await shot('05-助理-还没有会话就地说明');
    check(`助理：还没有会话时灰色空心点，自检说明「${pop2}」`);
    // 没有这个能力：没检测到 CodeAgent、也没接 API → 按钮「需配置」，自检说清要配什么（不是故障）；等待中的问题也直接写「需要先配置」
    await c.eval(`(()=>{const pref=require('../renderer/codeagent-preference');window.__bsPrefOrig=pref.detectedInstalled;pref.detectedInstalled=()=>false;})()`);
    await c.eval(`document.getElementById('hub-bs-pop')?.remove(); window.__companyAssistantHide?.()`); await click('#btn-company-assistant');
    await until(`${q('#company-assistant-page .ca-head .hub-bs-btn')}?.dataset.tone==='setup'`, 'assistant needs setup');
    assert.match(await c.eval(`${q('#company-assistant-page .ca-head .hub-bs-btn')}.textContent`), /需配置/);
    const d3 = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant setup');
    assert.equal(d3.cause, 'no-engine'); assert.match(d3.text, /需要配置，不是故障/); assert.deepEqual(d3.fixes, ['一键安装 CodeAgent', '接部门 API']);
    await shot('05b-助理-没有能力-需要先配置');
    check(`助理：没检测到 CodeAgent 也没接 API 时按钮写「需配置」；自检「${d3.title}」，标「需要配置，不是故障」，一键「${d3.fixes.join('」「')}」`);
    await c.eval(`(()=>{require('../renderer/codeagent-preference').detectedInstalled=window.__bsPrefOrig;})()`);
    // 出故障：最近一问报 429 限流 → 自检归到「额度或限流」，给「打开账号页」
    await c.eval(`window.__bsFx.assistant=${JSON.stringify(s1)}; window.__bsFx.chatError='API Error: 429 Too Many Requests (rate limit)'`);
    await c.eval(`document.getElementById('hub-bs-pop')?.remove(); window.__companyAssistantHide?.()`); await click('#btn-company-assistant');
    await until(`${q('#company-assistant-page .ca-head .hub-bs-btn')}?.dataset.hubBackstage===${JSON.stringify(s1)}`, 'assistant back to s1');
    const d4 = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant quota');
    assert.equal(d4.cause, 'quota'); assert.ok(d4.fixes.includes('打开账号页')); assert.equal(d4.enter, true);
    await shot('05c-助理-故障-额度或限流');
    check(`助理：最近一问报 429 时自检「${d4.title}」——${d4.todo.replace('你可以这样做：', '')}；一键「${d4.fixes.join('」「')}」，仍可进入后台`);
    await c.eval(`window.__bsFx.chatError=''; document.getElementById('hub-bs-pop')?.remove(); window.__companyAssistantHide?.()`); await click('#btn-company-assistant');
    await until(`!${q('#company-assistant-page')}?.hidden`, 'assistant reopened');
    // 卡住（模拟运行状态：运行中且 2 分钟无输出）→ 自检「后台可能卡住了」+「重启后台会话」
    await c.eval(`(()=>{window.__bsRtOrig=window.__hubSessionRuntime;window.__hubSessionRuntime=id=>id===${JSON.stringify(s1)}?{state:'running',meta:'2m',lastOutputAt:Date.now()-125000}:window.__bsRtOrig(id);})()`);
    await until(`${q('#company-assistant-page .ca-head .hub-bs-btn')}?.dataset.tone==='stuck'`, 'stuck tone');
    const d5 = await panel('#company-assistant-page .ca-head .hub-bs-btn', 'assistant stuck');
    assert.equal(d5.cause, 'stuck'); assert.ok(d5.fixes.includes('重启后台会话'));
    await shot('05d-助理-卡住-模拟状态');
    check(`助理（模拟运行状态）：运行中且 2 分钟没输出时按钮显示秒数，自检「${d5.title}」——${d5.why}；一键「重启后台会话」`);
    await c.eval(`window.__hubSessionRuntime=window.__bsRtOrig`);
    await c.eval(`document.getElementById('hub-bs-pop')?.remove(); window.__bsFx.assistant=${JSON.stringify(s1)}; window.__companyAssistantHide?.()`);

    // ---------- 2. 分身 ----------
    await click('#btn-avatar');
    await until(`!${q('#avatar-page')}?.hidden && document.querySelectorAll('#avatar-page .avx-row').length>0`, 'avatar list');
    await c.eval(`[...document.querySelectorAll('#avatar-page [data-av="sel"]')].find(e=>e.dataset.id&&e.dataset.id!=='all')?.click()`);
    await until(`!!${q('#avatar-page .avx-dh .hub-bs-btn')}`, 'avatar backstage button');
    const av = await c.eval(`(()=>{const b=${q('#avatar-page .avx-dh .hub-bs-btn')},tabs=${q('#avatar-page .avx-tabs')},p=${q('#avatar-page .avx-body')};return{sid:b.dataset.hubBackstage,dup:!!${q('#avatar-page [data-av="open-session"]')},tabsOneLine:tabs?tabs.scrollHeight<=tabs.clientHeight+2:true,scroll:p?p.scrollHeight-p.clientHeight:0,docScroll:document.documentElement.scrollHeight-innerHeight}})()`);
    assert.equal(av.sid, s2); assert.equal(av.dup, false, '原「打开会话」已被统一按钮替换，不重复');
    assert.equal(av.tabsOneLine, true, '7 个页签仍在一行');
    assert.ok(av.docScroll <= 1, '页面没有纵向滚动');
    await shot('06-分身-右上角后台按钮');
    check('分身：单个分身页右上角「后台」替换原「打开会话」，7 个页签仍一行，页面无纵向滚动');
    const avDiag = await enter('#avatar-page .avx-dh .hub-bs-btn', 'avatar');
    check(`分身：自检「${avDiag.title}」后进入后台`);
    try { await until(jumped(s2), 'avatar jump', 10000); } catch (e) { result.diag = await diag(); record(); throw e; }
    assert.match(await c.eval(`${q('#hub-bs-return')}.textContent`), /返回分身/);
    await shot('07-分身-跳到后台终端');
    await click('#hub-bs-return [data-hub-bs-back]');
    await until(`!${q('#avatar-page')}?.hidden && !!${q('#avatar-page .avx-dh .hub-bs-btn')}`, 'back to avatar detail');
    check('分身：跳到「分身 · 工具答疑」后台终端，「返回分身」回到原来选中的分身');
    await c.eval(`window.__avatarHide?.()`);

    // ---------- 3. 帖子（没有整理会话） ----------
    await until(`!!${q('#btn-company-forum')}`, 'forum nav');
    await click('#btn-company-forum');
    await until(`!${q('#company-forum-page')}?.hidden && !!${q('#company-forum-page .cf-head .hub-bs-btn')}`, 'forum button');
    assert.equal(await c.eval(`${q('#company-forum-page .cf-head .hub-bs-btn')}.dataset.tone`), 'none');
    const d6 = await panel('#company-forum-page .cf-head .hub-bs-btn', 'forum');
    assert.equal(d6.cause, 'not-started'); assert.equal(d6.recreate, true);
    await shot('08-帖子-还没有整理会话');
    check(`帖子：还没整理过时灰点；自检「${d6.title}」，并给「重新打开」（按原路建整理会话）`);
    await c.eval(`document.getElementById('hub-bs-pop')?.remove(); window.__companyForumHide?.()`);

    // ---------- 4. 会议（理解会话） ----------
    await until(`!!${q('#btn-company-meeting')}`, 'meeting nav');
    await c.eval('(' + meetingFixture + ')()'); await c.eval('m3Fixture.asr={ready:true}');
    await click('#btn-company-meeting'); await until(`${q('[data-m="source"]')}?.options.length===1`, 'meeting fixture source');
    await c.eval(`${q('[data-m="system"]')}.checked=false;${q('[data-m="mic"]')}.checked=false;`);
    await click('[data-act="start"]'); await until(`${q('.company-meeting')}?.dataset.phase==='live'`, 'meeting live');
    if (await c.eval(`${q('[data-act-local="dismiss"]')}?.offsetWidth>0`)) await click('[data-act-local="dismiss"]');
    await c.eval(`m3Fixture.current.sessionId=${JSON.stringify(s1)}; m3Fixture.current.agent={state:'ready'};`);
    await until(`${q('[data-m="bs-slot"] .hub-bs-btn')}?.dataset.hubBackstage===${JSON.stringify(s1)}`, 'meeting footer button', 20000);
    const mb = await c.eval(`(()=>{const b=${q('[data-m="bs-slot"] .hub-bs-btn')},f=${q('.meeting-footer')}.getBoundingClientRect(),r=b.getBoundingClientRect();return{inFooter:r.top>=f.top-1&&r.bottom<=f.bottom+1,tone:b.dataset.tone}})()`);
    assert.equal(mb.inFooter, true, '会议底栏放得下按钮');
    await shot('09-会议-底栏后台按钮');
    check(`会议：底栏「会议 AI 状态」旁出现「后台」（理解会话），状态点 ${mb.tone}；状态读会话表，没新增 IPC`);
    const mDiag = await enter('[data-m="bs-slot"] .hub-bs-btn', 'meeting');
    check(`会议：自检「${mDiag.title}」后进入后台`);
    await until(jumped(s1), 'meeting jump');
    assert.match(await c.eval(`${q('#hub-bs-return')}.textContent`), /返回会议/);
    await shot('10-会议-跳到理解会话后台');
    await click('#hub-bs-return [data-hub-bs-back]');
    await until(`${q('.company-meeting')}?.dataset.phase==='live' && !${q('#company-meeting-page')}?.hidden`, 'back to meeting');
    check('会议：跳到理解会话后台终端，「返回会议」回到会议页，采集仍在进行（phase=live）');
    // 会议在 1280×650、1366×768@125% 下底栏不被挤
    for (const [w, h, s] of [[1280, 650, 1], [1366, 768, 1.25]]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: Math.round(w / s), height: Math.round(h / s), deviceScaleFactor: s, mobile: false });
      await _waitMs(400);
      const fit = await c.eval(`(()=>{const b=${q('[data-m="bs-slot"] .hub-bs-btn')},f=${q('.meeting-footer')};const r=b.getBoundingClientRect(),fr=f.getBoundingClientRect();return{visible:r.width>0&&r.right<=innerWidth+1&&r.top>=fr.top-1&&r.bottom<=fr.bottom+1,overflow:f.scrollWidth-f.clientWidth}})()`);
      assert.equal(fit.visible, true, `${w}x${h}@${s} footer button visible`);
      await shot(`11-会议-底栏-${w}x${h}@${s}`);
      check(`会议：${w}×${h}@${s * 100}% 下底栏「后台」完整可见（底栏横向溢出 ${fit.overflow}px）`);
    }
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ---------- 5. 状态点样式（模拟各状态，只为看样式） ----------
    await c.eval(`(()=>{const bs=require('../renderer/backstage-jump');const host=document.createElement('div');host.id='bs-demo';host.style.cssText='position:fixed;left:120px;top:120px;z-index:99999;display:flex;flex-direction:column;gap:10px;padding:16px 18px;background:#fff;border:1px solid #e3e6eb;border-radius:12px;font:13px Microsoft YaHei';
      const now=Date.now(),rows=[['运行中',{state:'running',meta:'38s',lastOutputAt:now-3000}],['可能卡住',{state:'running',lastOutputAt:now-150000}],['等待操作',{state:'waiting'}],['报错',{state:'failed',detail:'额度不足'}],['休眠中',{state:'dormant'}],['空闲',{state:'idle'}],['状态待确认',{state:'unknown'}],['已关闭',null],['没有会话','none']];
      host.innerHTML='<b>状态点样式（模拟数据，仅看样式）</b>'+rows.map(([n,rt])=>'<div style="display:flex;align-items:center;gap:12px"><span style="width:70px">'+n+'</span>'+bs.backstageButtonHtml({sessionId:rt==='none'?'':'demo',from:'assistant',runtime:rt==='none'?null:rt})+'</div>').join('')+'<div>报错旁链接：'+bs.backstageLinkHtml({sessionId:'demo',from:'assistant'})+'</div>'+'<div style="display:flex;align-items:center;gap:12px"><span style="width:70px">需配置</span>'+bs.backstageButtonHtml({sessionId:'',from:'assistant',needsSetup:true})+'</div>';document.body.append(host);host.querySelectorAll('[data-hub-backstage]').forEach(b=>b.removeAttribute('data-hub-backstage'));})()`);
    await shot('12-状态点样式-模拟');
    await c.eval(`document.getElementById('bs-demo')?.remove()`);
    check('状态点样式：运行中（蓝、呼吸）、可能卡住（琥珀 + 秒数）、等待（琥珀）、报错（红）、休眠（空心）、空闲（绿）、已关闭/没有会话（浅灰空心）——模拟数据截图');

    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    try { if (c) { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261126-跳转后台-失败现场.png'), Buffer.from(s.data, 'base64')); } } catch { /* 截不到 */ }
  } finally {
    record();
    if (c) await c.close().catch(() => {});
    if (hub) result.teardown = await gracefulQuit(hub).catch(e => String(e));
    record();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  }
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error?.split('\n')[0], out }, null, 1));
  process.exit(result.passed ? 0 : 1);
})();
