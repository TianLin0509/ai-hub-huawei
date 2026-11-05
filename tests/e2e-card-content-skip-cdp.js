'use strict';
// 长历史跳过布局的真实操作回归：隔离 Hub、合成历史、模拟 CodeAgent，无头。
// 真实点击问题目录、页内查找；复制在写剪贴板之前截获，不碰系统剪贴板。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'card-skip-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'fake.jsonl');
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const TURNS = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(100); } throw Error('Timeout ' + label + (last ? ': ' + last.message : '')); }
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

const bodyOf = (role, i) => `${role} turn ${i}. Synthetic content only.\n\n- Step one verified.\n- Step two needs review.\n\n`
  + (i % 5 === 0 && role === 'assistant' ? '```js\nconst sample = ' + i + ';\n```\n\n' : '') + 'Sample text. '.repeat(10 + (i % 40));
function writeHistory(file, sessionId) {
  const rows = [];
  let parent = null;
  for (let i = 0; i < TURNS; i++) for (const role of ['user', 'assistant']) {
    const id = crypto.randomUUID();
    rows.push(JSON.stringify({ type: role, sessionId, cwd: WORK, uuid: id, parentUuid: parent, timestamp: new Date(Date.now() - TURNS * 1000 + i * 1000).toISOString(),
      message: { role, content: [{ type: 'text', text: bodyOf(role, i) }] } }));
    parent = id;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.join('\n') + '\n');
}

async function run() {
  for (const dir of [DATA, WORK, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'fixture', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'card-skip', windowMode: 'background', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  const click = async selector => {
    const xy = await wait(() => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width)return null;return {x:r.left+r.width/2,y:r.top+r.height/2}})()`), selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const key = async (name, code, vk) => { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: vk }); };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(image.data, 'base64')); };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await wait(() => c.eval('document.readyState==="complete"&&typeof selectSession==="function"&&(sessionSplit,true)&&!!window.__codeagentAccountsOpen'), 'app ready');
    const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: 'card skip', codeagentAccount: 'personal' } });
    const session = await wait(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), 'native identity');
    const native = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.hubSession === session.id && r.configDir);
    writeHistory(path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), session.ccSessionId + '.jsonl'), session.ccSessionId);
    const sid = JSON.stringify(session.id);
    await c.eval(`selectSession(${sid})`);
    await wait(() => c.eval(`activeSessionId===${sid}&&currentView==='card'`), 'selected');
    await c.eval(`window._loadSessionHistoryToOverlay(${sid},{forceScrollBottom:true})`);
    for (let i = 0; i < 8; i++) await c.eval(`window._loadSessionHistoryToOverlay(${sid},{older:true})`);
    const O = `document.getElementById('msg-overlay')`;
    // 跳过状态：最新 8 张从不处理；其余的卡，视口上下一屏内不跳过，更远的跳过。
    const skipState = async () => {
      await sleep(400);
      return c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect(),cards=[...o.querySelectorAll(':scope>.turn-card')],rest=cards.slice(0,-8);const margin=o.clientHeight;const wrongFar=[],wrongNear=[];let far=0,near=0;for(const x of rest){const r=x.getBoundingClientRect();const isNear=r.bottom>=b.top-margin&&r.top<=b.bottom+margin;if(isNear){near++;if(x.style.contentVisibility!=='visible')wrongNear.push(x.dataset.turnId)}else{far++;if(x.style.contentVisibility!=='auto')wrongFar.push(x.dataset.turnId)}}return {cards:cards.length,far,near,wrongFar:wrongFar.length,wrongNear:wrongNear.length,tailPlain:cards.slice(-8).every(x=>!x.style.contentVisibility)}})()`);
    };
    const skipOk = state => state.wrongFar === 0 && state.wrongNear === 0 && state.tailPlain;
    const counts = await skipState();
    ok('翻页后远处卡跳过，视口附近和最新 8 张不跳过', counts.cards > 190 && counts.far > 170 && skipOk(counts), JSON.stringify(counts));

    // 完整性：每张卡的复制文本都和原始历史对得上，顺序不变。
    const texts = await c.eval(`(()=>{const extract=require('../renderer/visible-card-text').extractVisibleCardText;return [...${O}.querySelectorAll(':scope>.turn-card')].map(x=>extract(x.querySelector('.turn-body')))})()`);
    const numbered = texts.map(text => ({ text, match: /^(user|assistant) turn (\d+)\./.exec(text) })).filter(row => row.match).map(row => Object.assign(row.match, { text: row.text }));
    const mismatch = numbered.findIndex((m, i) => i > 0 && (Number(m[2]) < Number(numbered[i - 1][2])));
    ok('跳过的卡复制文本完整、顺序不变', numbered.length >= counts.cards - 1 && mismatch < 0, `${numbered.length}/${texts.length}`);
    // Markdown 渲染后列表符号会变，所以按每张卡特有的重复段数逐张比对正文。
    const wrong = numbered.filter(m => (m.text.match(/Sample text\./g) || []).length !== 10 + (Number(m[2]) % 40) || !m.text.includes('Step two needs review.'));
    ok('每张卡的正文和原始历史一致', wrong.length === 0, `${numbered.length - wrong.length}/${numbered.length}`);

    const visibleContained = await c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect();return [...o.querySelectorAll(':scope>.turn-card')].filter(x=>{const r=x.getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom}).filter(x=>getComputedStyle(x).contentVisibility==='auto').length})()`);
    ok('视口里的卡没有绘制隔离，渲染和不跳过时一样', visibleContained === 0, String(visibleContained));

    // 真实点击问题目录。
    await c.eval(`${O}._cardFollowController?.pause()`);
    const targetIndex = await c.eval(`Math.floor(document.querySelectorAll('.card-question-nav-item').length/3)`);
    const settled = async () => { let last = null; for (let i = 0; i < 40; i++) { const now = await c.eval(`${O}.scrollTop`); if (now === last) return now; last = now; await sleep(250); } return last; };
    await c.eval(`window.__jumpCard=(()=>{const before=document.querySelector('.card-question-nav-item[data-question-index="${targetIndex}"]');before.click();return 1})()`);
    await sleep(300);
    await settled();
    const jump = await c.eval(`(()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card.user')],active=document.querySelector('.card-question-nav-item.active');const tops=cards.map(x=>Math.round(x.getBoundingClientRect().top-o.getBoundingClientRect().top));const nearest=tops.reduce((a,b)=>Math.abs(b-10)<Math.abs(a-10)?b:a);return {nearest,activeIndex:active&&Number(active.dataset.questionIndex),target:${targetIndex}}})()`);
    ok('问题目录平滑跳转落点准确', Math.abs(jump.nearest - 10) <= 3 && jump.activeIndex === jump.target, JSON.stringify(jump));
    // 长跳：先到 10% 处，再跳到 70% 处。
    await c.eval(`(()=>{const o=${O};o._cardFollowController?.pause();o.scrollTop=Math.floor(o.scrollHeight*0.1);return 1})()`);
    await sleep(500);
    const longIndex = await c.eval(`Math.floor(document.querySelectorAll('.card-question-nav-item').length*0.7)`);
    await c.eval(`document.querySelector('.card-question-nav-item[data-question-index="${longIndex}"]').click()`);
    await sleep(300);
    await settled();
    await sleep(600);
    const longJump = await c.eval(`(()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card.user')],tops=cards.map(x=>Math.round(x.getBoundingClientRect().top-o.getBoundingClientRect().top)),active=document.querySelector('.card-question-nav-item.active');return {nearest:tops.reduce((a,b)=>Math.abs(b-10)<Math.abs(a-10)?b:a),activeIndex:active&&Number(active.dataset.questionIndex),target:${longIndex}}})()`);
    ok('问题目录长跳落点准确', Math.abs(longJump.nearest - 10) <= 3 && longJump.activeIndex === longJump.target, JSON.stringify(longJump));
    // 平滑途中读者自己滚动：校正取消，不把人拉回去。
    await c.eval(`(()=>{const o=${O};document.querySelector('.card-question-nav-item[data-question-index="5"]').click();o.dispatchEvent(new WheelEvent('wheel',{deltaY:300,bubbles:true}));o.scrollTop=o.scrollTop+300;return 1})()`);
    await sleep(300);
    await settled();
    const interrupted = await c.eval(`(()=>{const o=${O},card=[...o.querySelectorAll(':scope>.turn-card.user')][5];return Math.round(card.getBoundingClientRect().top-o.getBoundingClientRect().top)})()`);
    ok('跳转途中读者滚动后不再校正', Math.abs(interrupted - 10) > 3, String(interrupted));
    // 设置弹窗开关：字号没变不重量，变了才重量。
    const remeasures = await c.eval(`(()=>{const skip=window._cardContentSkip(),orig=skip.remeasure;let n=0;skip.remeasure=()=>{n++;return orig()};const size=Number(getComputedStyle(document.documentElement).getPropertyValue('--card-content-font-size').replace('px','')),family='system';applyHubCardDisplaySettings({cardFontSize:size});const same=n;applyHubCardDisplaySettings({cardFontSize:size});const again=n;applyHubCardDisplaySettings({cardFontSize:size+1});const changed=n;applyHubCardDisplaySettings({cardFontSize:size});skip.remeasure=orig;return {same,again,changed,size}})()`);
    await sleep(300);
    ok('字号没变不重量，变了才重量', remeasures.again === remeasures.same && remeasures.changed === remeasures.again + 1, JSON.stringify(remeasures));
    await shot('20261105-card-skip-question-jump-1440');

    // 真实页内查找。
    await c.eval(`${O}.focus()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
    await wait(() => c.eval(`document.getElementById('terminal-search').style.display!=='none'`), 'find opens');
    await c.send('Input.insertText', { text: `user turn ${TURNS - 60}.` });
    await wait(() => c.eval(`/1/.test(document.getElementById('terminal-search-count').textContent)`), 'find count');
    await key('Enter', 'Enter', 13);
    await sleep(800);
    const find = await c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect();const card=[...o.querySelectorAll(':scope>.turn-card.user')].find(x=>x.textContent.includes('user turn ${TURNS - 60}.'));const r=card.getBoundingClientRect();return {count:document.getElementById('terminal-search-count').textContent,visible:r.bottom>b.top&&r.top<b.bottom}})()`);
    ok('页内查找能找到跳过的卡并滚到位', find.visible, JSON.stringify(find));
    const afterFind = await skipState();
    ok('查找结束后恢复跳过', skipOk(afterFind), JSON.stringify(afterFind));
    await key('Escape', 'Escape', 27);

    // 上一条回答：从底部开始，真实按钮逐条往上跳。
    await c.eval(`(()=>{const o=${O};o._cardFollowController?.pause();o.scrollTop=Math.floor(o.scrollHeight/2);return 1})()`);
    await sleep(500);
    const answerAction = await c.eval(`[...document.querySelectorAll('[data-directory-action]')].map(b=>b.dataset.directoryAction).find(x=>/prev|up/i.test(x))`);
    await c.eval(`document.querySelector('[data-directory-action="${answerAction}"]').click()`);
    await sleep(600);
    const answer = await c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect();const tops=[...o.querySelectorAll(':scope>.turn-card.assistant')].map(x=>Math.round(x.getBoundingClientRect().top-b.top));return tops.reduce((p,n)=>Math.abs(n-10)<Math.abs(p-10)?n:p)})()`);
    ok('上一条回答按钮落点准确', typeof answer === 'number' && Math.abs(answer - 10) <= 3, `action=${answerAction} top=${answer}`);

    // 全局搜索命中定位（代码里是平滑滚动，后台窗口会半路停，所以等它结束后看是否可见，并在没到位时记录）。
    const hit = await c.eval(`(async()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card')],t=cards[50];o.scrollTop=o.scrollHeight;await new Promise(r=>setTimeout(r,400));const found=focusOrdinarySearchHit({bestMatch:{eventId:t.dataset.turnId}},null);const marked=t.classList.contains('global-search-focus');let last=-1;for(let i=0;i<30&&o.scrollTop!==last;i++){last=o.scrollTop;await new Promise(r=>setTimeout(r,200))}const r=t.getBoundingClientRect(),b=o.getBoundingClientRect();return {found,highlighted:marked,visible:r.bottom>b.top&&r.top<b.bottom,distance:Math.round(r.top-b.top)}})()`);
    // 落点靠 scrollIntoView 平滑滚动，后台窗口里改前版本也到不了，这里只验证能认出并标记跳过的卡。
    ok('全局搜索命中认出跳过的卡并标记', hit.found === true && hit.highlighted === true, JSON.stringify(hit));

    // 多选复制：真实按钮「全选」「一键复制」，写剪贴板之前截获，不碰系统剪贴板。
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer,orig=ipc.invoke.bind(ipc);window.__clip=[];ipc.invoke=(n,...a)=>{if(n==='clipboard:write-text'){window.__clip.push(a[0]);return Promise.resolve({ok:true,attempts:1})}return orig(n,...a)};return 1})()`);
    await c.eval(`(()=>{const o=${O};cardMultiSelectController.enter(o.querySelector(':scope>.turn-card[data-turn-id]').dataset.turnId);document.getElementById('card-multi-select-all').click();document.getElementById('card-multi-select-copy').click();return cardMultiSelectController.selectedCount()})()`);
    await wait(() => c.eval(`window.__clip.length>0`), 'multi-select copy');
    const copied = await c.eval(`window.__clip.at(-1)`);
    await c.eval(`cardMultiSelectController.exit()`);
    const inCopy = (copied.match(/(?:user|assistant) turn \d+\./g) || []).length;
    const expectedSamples = numbered.reduce((sum, m) => sum + 10 + (Number(m[2]) % 40), 0);
    const samplesInCopy = (copied.match(/Sample text\./g) || []).length;
    ok('多选复制包含全部跳过的卡，正文完整', inCopy === numbered.length && samplesInCopy === expectedSamples, JSON.stringify({ inCopy, cards: numbered.length, samplesInCopy, expectedSamples }));
    const afterCopy = await skipState();
    ok('复制后跳过状态不变', skipOk(afterCopy), JSON.stringify(afterCopy));

    // 跨卡选中。
    const selection = await c.eval(`(()=>{const cards=[...${O}.querySelectorAll(':scope>.turn-card')],a=cards[20].querySelector('.turn-body'),z=cards[23].querySelector('.turn-body'),s=getSelection();s.removeAllRanges();const r=document.createRange();r.setStartBefore(a.firstChild);r.setEndAfter(z.lastChild);s.addRange(r);const text=s.toString();s.removeAllRanges();return text})()`);
    for (const piece of texts.slice(20, 24)) ok('跨卡选中包含第 ' + piece.slice(0, 24), selection.replace(/\s+/g, '').includes(piece.replace(/\s+/g, '').slice(0, 60)));

    // 宽度变化后再跳转：先记下真实高度对照。
    const before = await c.eval(`(()=>{const o=${O};return o.scrollHeight})()`);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 960, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const resized = await c.eval(`(async()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card.user')],t=cards[Math.floor(cards.length/2)];o._cardFollowController?.pause();o.scrollTop=o.scrollHeight;await new Promise(r=>setTimeout(r,300));const rel=()=>t.getBoundingClientRect().top-o.getBoundingClientRect().top;o.scrollTo({top:o.scrollTop+rel()-10,behavior:'instant'});await new Promise(r=>setTimeout(r,500));return {error:Math.round(rel()-10),height:o.scrollHeight}})()`);
    ok('窗口变窄后跳转仍准确', Math.abs(resized.error) <= 3, JSON.stringify({ ...resized, before }));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const back = await c.eval(`${O}.scrollHeight`);
    ok('窗口变回后总高度恢复（误差不超过 1%）', Math.abs(back - before) / before <= 0.01, `${before}->${back}`);

    // 改字号后再跳转。
    await c.eval(`applyHubCardDisplaySettings({cardFontSize:20})`);
    await sleep(600);
    const fonted = await c.eval(`(async()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card.user')],t=cards[Math.floor(cards.length/2)];o.scrollTop=o.scrollHeight;await new Promise(r=>setTimeout(r,300));const rel=()=>t.getBoundingClientRect().top-o.getBoundingClientRect().top;o.scrollTo({top:o.scrollTop+rel()-10,behavior:'instant'});await new Promise(r=>setTimeout(r,500));return {error:Math.round(rel()-10),height:o.scrollHeight}})()`);
    ok('改字号后高度变化且跳转仍准确', Math.abs(fonted.error) <= 3 && fonted.height > back * 1.02, JSON.stringify({ ...fonted, back }));
    await c.eval(`applyHubCardDisplaySettings({cardFontSize:16})`);
    await sleep(600);

    // 看着的卡被撑高（等同展开工具详情）后滚走再回来：高度不丢，不跳。
    const grown = await c.eval(`(async()=>{const o=${O},settle=ms=>new Promise(r=>setTimeout(r,ms));const cards=[...o.querySelectorAll(':scope>.turn-card')],t=cards[Math.floor(cards.length/2)];o._cardFollowController?.pause();t.scrollIntoView({block:'start',behavior:'instant'});await settle(400);const h0=o.scrollHeight;const box=document.createElement('div');box.style.height='600px';t.querySelector('.turn-body').append(box);await settle(300);const h1=o.scrollHeight;o.scrollTop=o.scrollHeight;await settle(500);const h2=o.scrollHeight;t.scrollIntoView({block:'start',behavior:'instant'});await settle(500);const h3=o.scrollHeight;const top=Math.round(t.getBoundingClientRect().top-o.getBoundingClientRect().top);box.remove();await settle(300);return {grew:h1-h0,awayDelta:h2-h1,backDelta:h3-h1,top}})()`);
    ok('展开后滚走再回来高度不丢', Math.abs(grown.grew - 600) <= 2 && Math.abs(grown.awayDelta) <= 2 && Math.abs(grown.backDelta) <= 2, JSON.stringify(grown));

    // 上翻看历史时来了新回答：视口不动；新卡进来，退出最新区的卡开始跳过。
    const file = path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), session.ccSessionId + '.jsonl');
    const appendTurn = i => {
      for (const role of ['user', 'assistant']) fs.appendFileSync(file, JSON.stringify({ type: role, sessionId: session.ccSessionId, cwd: WORK, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text: bodyOf(role, i) }] } }) + '\n');
    };
    await c.eval(`(()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card')],t=cards[60];o._cardFollowController?.pause();t.scrollIntoView({block:'start',behavior:'instant'});window.__anchor=t;return 1})()`);
    await sleep(400);
    const anchorBefore = await c.eval(`Math.round(window.__anchor.getBoundingClientRect().top)`);
    const cardsBefore = await c.eval(`${O}.querySelectorAll(':scope>.turn-card').length`);
    appendTurn(TURNS);
    await c.eval(`window._loadSessionHistoryToOverlay(${sid},{incremental:true})`);
    await sleep(500);
    const arrived = await c.eval(`(()=>{const o=${O},cards=[...o.querySelectorAll(':scope>.turn-card')];return {cards:cards.length,anchor:Math.round(window.__anchor.getBoundingClientRect().top),last:cards.at(-1).textContent.includes('assistant turn ${TURNS}.'),tailPlain:cards.slice(-8).every(x=>!x.style.contentVisibility)}})()`);
    ok('上翻时新回答到达，视口不动，新卡在末尾', arrived.cards === cardsBefore + 2 && Math.abs(arrived.anchor - anchorBefore) <= 2 && arrived.last && arrived.tailPlain, JSON.stringify({ ...arrived, anchorBefore }));
    const afterArrive = await skipState();
    ok('退出最新区的卡进入跳过', skipOk(afterArrive), JSON.stringify(afterArrive));

    // 跟随模式：停在底部时新回答到达，仍贴底。
    await c.eval(`${O}._cardFollowController?.follow()`);
    await sleep(300);
    appendTurn(TURNS + 1);
    await c.eval(`window._loadSessionHistoryToOverlay(${sid},{incremental:true})`);
    await sleep(500);
    const followed = await c.eval(`(()=>{const o=${O};return {gap:Math.round(o.scrollHeight-o.scrollTop-o.clientHeight),last:[...o.querySelectorAll(':scope>.turn-card')].at(-1).textContent.includes('assistant turn ${TURNS + 1}.')}})()`);
    ok('跟随时新回答到达仍贴底', followed.last && followed.gap <= 3, JSON.stringify(followed));

    // 切会话再回来：跳过状态和内容都在。
    const other = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: 'other', codeagentAccount: 'personal' } });
    await wait(async () => (await invoke('get-sessions')).find(s => s.id === other.id), 'other session');
    await c.eval(`selectSession(${JSON.stringify(other.id)})`);
    await wait(() => c.eval(`activeSessionId===${JSON.stringify(other.id)}`), 'other selected');
    await c.eval(`selectSession(${sid})`);
    await wait(() => c.eval(`activeSessionId===${sid}&&${O}.querySelectorAll(':scope>.turn-card').length>0`), 'returned');
    const returned = await c.eval(`(()=>{const cards=[...${O}.querySelectorAll(':scope>.turn-card')];return {cards:cards.length,withText:cards.filter(x=>x.querySelector('.turn-body')?.textContent.trim().length>0).length}})()`);
    ok('切会话返回后卡片和正文都在', returned.withText === returned.cards && returned.cards > 0, JSON.stringify(returned));
    console.log('ARTIFACTS ' + OUT);
  } finally {
    try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (error) { console.error('quit: ' + error.message); }
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
