'use strict';
// 预览退出回原位（2026-11-27）真实 Hub 回归：隔离 Hub、合成历史、模拟 CodeAgent，无头。
// 往上翻到对话中间 → 点卡片里的图片路径打开预览 → 点关闭，停回原来那段对话；网页链接预览同样；
// 原本在底部跟随的，关掉预览照旧在最新。截图写到 HUB_E2E_ARTIFACT_DIR。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-return-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'fake.jsonl');
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const IMAGE = path.join(WORK, '20261127-信道对比图.png');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(100); } throw Error('Timeout ' + label + (last ? ': ' + last.message : '')); }
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

function writeHistory(file, sessionId, pageUrl) {
  const rows = [];
  let parent = null;
  const para = n => Array.from({ length: n === 4 ? 60 : 12 }, (_, i) => `第 ${n} 轮第 ${i + 1} 段：用来把对话撑长。`).join('\n\n');
  const turns = [];
  for (let n = 1; n <= 4; n++) {
    turns.push(['user', `第 ${n} 个问题`]);
    const middle = n === 2 ? `【中间那段】对比图在 ${IMAGE} ，参考页面 [仿真说明](${pageUrl})。\n\n` : '';
    turns.push(['assistant', middle + para(n) + (n === 4 ? '\n\n【对话结尾】' : '')]);
  }
  turns.forEach(([role, text], i) => {
    const id = crypto.randomUUID();
    rows.push(JSON.stringify({ type: role, sessionId, cwd: WORK, uuid: id, parentUuid: parent, timestamp: new Date(Date.now() - 120000 + i * 1000).toISOString(),
      message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) } }));
    parent = id;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.join('\n') + '\n');
}

async function run() {
  for (const dir of [DATA, WORK, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  // 1×1 像素 PNG 放大显示即可。
  fs.writeFileSync(IMAGE, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'fixture', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  const page = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<h1>仿真说明</h1><p>本地测试页</p>'); });
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${page.address().port}/sim-notes`;
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'preview-return', windowMode: 'background', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(OUT, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); console.log('SHOT ' + file); };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait(() => c.eval('document.readyState==="complete"&&typeof selectSession==="function"&&!!window.__codeagentAccountsOpen'), 'app ready');
    const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: '预览回原位', codeagentAccount: 'personal' } });
    const session = await wait(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), 'native identity');
    const native = await wait(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.hubSession === session.id && r.configDir), 'native log');
    const histFile = path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), session.ccSessionId + '.jsonl');
    writeHistory(histFile, session.ccSessionId, pageUrl);
    const O = `document.getElementById('msg-overlay')`;
    await c.eval(`selectSession(${JSON.stringify(session.id)},{forceScrollBottom:true})`);
    await wait(() => c.eval(`currentView==='card'&&${O}.textContent.includes('【对话结尾】')`), 'cards');
    await sleep(800);
    const middleCard = `[...${O}.querySelectorAll(':scope>.turn-card')].find(x=>x.textContent.includes('【中间那段】'))`;
    const where = () => c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect(),card=${middleCard};const btn=document.getElementById('card-jump-latest');
      return {scrollTop:Math.round(o.scrollTop),middleOffset:card?Math.round(card.getBoundingClientRect().top-b.top):null,gap:Math.round(o.scrollHeight-o.clientHeight-o.scrollTop),following:o._cardFollowController.isFollowing(),button:btn&&!btn.hidden?btn.textContent:null,previewOpen:document.getElementById('preview-panel').style.display==='flex'}})()`);
    // 像用户一样用滚轮往上翻，直到「中间那段」在视口上部。
    const box = await c.eval(`(()=>{const r=${O}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for (let i = 0; i < 80; i++) {
      const w = await where();
      if (w.middleOffset !== null && w.middleOffset >= 0 && w.middleOffset < 200) break;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: w.middleOffset < 0 ? -120 : 120 });
      await sleep(60);
    }
    await sleep(300);
    const before = await where();
    ok('往上翻到了对话中间', before.middleOffset >= 0 && before.middleOffset < 200 && !before.following && before.gap > 400, JSON.stringify(before));

    const clickIn = async (selector, label) => {
      const pt = await c.eval(`(()=>{const a=${middleCard}?.querySelector(${JSON.stringify(selector)});if(!a)return null;const r=a.getClientRects()[0];return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      ok(label + '：卡片里有可点的链接', !!pt);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await wait(async () => (await where()).previewOpen, label + ' 预览打开', 15000);
      await sleep(800);
    };
    const closeAndCheck = async (label, shotName) => {
      if (shotName) await shot(shotName + '-预览中');
      await c.eval(`document.getElementById('preview-close').click()`);
      await wait(async () => !(await where()).previewOpen, label + ' 预览关闭', 10000);
      await sleep(600);
      const after = await where();
      ok(label + '：关掉后停回原来那段对话', Math.abs(after.middleOffset - before.middleOffset) <= 4 && !after.following, JSON.stringify({ before, after }));
      ok(label + '：底部仍可「回到最新」', !!after.button, JSON.stringify(after));
      if (shotName) await shot(shotName + '-关闭后回原位');
    };

    // 1) 图片路径 → 文件预览
    await clickIn('a.rt-file-link', '图片');
    await closeAndCheck('图片预览', '20261127-R50-3a-图片预览');
    // 2) 网页链接 → 网页预览
    await clickIn(`a[href^="${pageUrl}"]`, '网页链接');
    await closeAndCheck('链接预览', '20261127-R50-3b-链接预览');
    // 2b) 审查 P2-3：全屏预览切分屏，左半屏对话回到原来那段；在分屏里往下滚，再关预览，不被旧位置覆盖
    await clickIn('a.rt-file-link', '图片（切分屏）');
    await c.eval(`document.getElementById('preview-layout-split').click()`); await sleep(800);
    const split = await where();
    ok('全屏切分屏：左半屏对话停在原来那段', split.previewOpen && Math.abs(split.middleOffset - before.middleOffset) <= 40 && !split.following, JSON.stringify({ before, split }));
    await shot('20261127-R50-P2-3-全屏切分屏回原位');
    const half = await c.eval(`(()=>{const r=${O}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for (let i = 0; i < 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: half.x, y: half.y, deltaX: 0, deltaY: 120 }); await sleep(80); }
    await sleep(400);
    const scrolled = await where();
    await c.eval(`document.getElementById('preview-close').click()`);
    await wait(async () => !(await where()).previewOpen, '分屏预览关闭', 10000); await sleep(600);
    const afterHalf = await where();
    ok('分屏里滚过再关预览：不被拉回打开预览时的位置', afterHalf.middleOffset < before.middleOffset - 200 && !afterHalf.following, JSON.stringify({ before, scrolled, afterHalf }));

    // 3) 原本在底部跟随：关掉预览照旧在最新
    await c.eval(`document.getElementById('card-jump-latest').click()`); await sleep(400);
    await c.eval(`openPreviewPanel(${JSON.stringify(IMAGE)},{preview:true})`);
    await wait(async () => (await where()).previewOpen, '预览打开', 15000); await sleep(500);
    await c.eval(`document.getElementById('preview-close').click()`);
    await wait(async () => !(await where()).previewOpen, '预览关闭', 10000); await sleep(600);
    const bottom = await where();
    ok('原本在最新：关掉预览照旧在最新并跟随', bottom.gap <= 3 && bottom.following, JSON.stringify(bottom));

    // 4) 审查 P2-2：全屏预览盖着对话时跑完超过一屏的回复，关掉预览停在这条回复开头
    await c.eval(`openPreviewPanel(${JSON.stringify(IMAGE)},{preview:true,fullscreen:true})`);
    await wait(async () => (await where()).previewOpen, '预览打开', 15000); await sleep(500);
    ok('全屏预览盖住了对话区', await c.eval(`document.getElementById('terminal-panel').style.display==='none'`));
    await c.eval(`require('electron').ipcRenderer.emit('turn-complete-event',{}, {hubSessionId:${JSON.stringify(session.id)},transcriptPath:${JSON.stringify(histFile)},text:'',completedAt:Date.now(),kind:'codeagent'})`);
    await sleep(500);
    await c.eval(`document.getElementById('preview-close').click()`);
    await wait(async () => !(await where()).previewOpen, '预览关闭', 10000); await sleep(600);
    const lastStart = await c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect();const card=[...o.querySelectorAll(':scope>.turn-card')].find(x=>x.textContent.includes('第 4 轮第 1 段'));const btn=document.getElementById('card-jump-latest');return {offset:card?Math.round(card.getBoundingClientRect().top-b.top):null,taller:card?card.getBoundingClientRect().height>o.clientHeight:false,button:btn&&!btn.hidden?btn.textContent:null}})()`);
    ok('预览期间跑完的长回复：关掉预览停在回复开头并提示跳到最新', lastStart.taller && lastStart.offset >= 0 && lastStart.offset <= 40 && /跳到最新|Jump to latest/.test(lastStart.button || ''), JSON.stringify(lastStart));
    await shot('20261127-R50-P2-2-预览期间跑完回来停在开头');
  } finally {
    try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (error) { console.error('quit: ' + error.message); }
    page.close();
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
