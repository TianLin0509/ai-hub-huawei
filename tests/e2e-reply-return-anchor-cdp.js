'use strict';
// 长回复回来看（2026-11-27）真实 Hub 回归：隔离 Hub、合成历史、模拟 CodeAgent，无头。
// 1) 会话 A 不在前台时跑完一条超过一屏的回复 → 点回 A，停在这条回复开头，底部显示「跳到最新」，点它回到最新；
// 2) 正在看 A 时跑完 → 保持跟随在底部；
// 3) A 在前台但窗口失焦时跑完 → 窗口重新获得焦点时停在回复开头。截图写到 HUB_E2E_ARTIFACT_DIR。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-anchor-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'fake.jsonl');
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(100); } throw Error('Timeout ' + label + (last ? ': ' + last.message : '')); }
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

function writeHistory(file, sessionId, longLast) {
  const rows = [];
  let parent = null;
  const turns = [['user', '先看一下目录结构'], ['assistant', '目录结构如下：src、tests、docs。'], ['user', '把第三章的推导完整写出来']];
  const paragraphs = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：这是一条很长的回复，用来验证回来时停在回复开头。`).join('\n\n');
  turns.push(['assistant', (longLast ? '【回复开头】下面是完整推导。\n\n' + paragraphs : '【短回复】好的。') + '\n\n【回复结尾】']);
  turns.forEach(([role, text], i) => {
    const id = crypto.randomUUID();
    rows.push(JSON.stringify({ type: role, sessionId, cwd: WORK, uuid: id, parentUuid: parent, timestamp: new Date(Date.now() - 60000 + i * 1000).toISOString(),
      message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) } }));
    parent = id;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.join('\n') + '\n');
}

async function run() {
  for (const dir of [DATA, WORK, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'fixture', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'reply-anchor', windowMode: 'background', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(OUT, name + '.png'); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); console.log('SHOT ' + file); };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 后台窗口本身拿不到焦点；模拟「用户正看着窗口」，失焦用例里再单独改掉。
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait(() => c.eval('document.readyState==="complete"&&typeof selectSession==="function"&&!!window.__codeagentAccountsOpen'), 'app ready');
    const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
    const make = async (title, longLast) => {
      const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title, codeagentAccount: 'personal' } });
      const session = await wait(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), 'native identity ' + title);
      const native = await wait(() => fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.hubSession === session.id && r.configDir), 'native log ' + title);
      const file = path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), session.ccSessionId + '.jsonl');
      writeHistory(file, session.ccSessionId, longLast);
      return { id: session.id, file };
    };
    const A = await make('长回复会话', true), B = await make('另一个会话', false);
    const O = `document.getElementById('msg-overlay')`;
    const open = async sid => {
      await c.eval(`selectSession(${JSON.stringify(sid)},{forceScrollBottom:true})`);
      await wait(() => c.eval(`activeSessionId===${JSON.stringify(sid)}&&currentView==='card'&&[...${O}.querySelectorAll(':scope>.turn-card')].some(x=>x.textContent.includes('【回复结尾】'))`), 'cards ' + sid);
      await sleep(600);
    };
    const finish = sid => c.eval(`require('electron').ipcRenderer.emit('turn-complete-event',{}, {hubSessionId:${JSON.stringify(sid)},transcriptPath:${JSON.stringify(A.file)},text:'',completedAt:Date.now(),kind:'codeagent'})`);
    // 回复开头那张卡相对视口顶部的位置；按钮是否可见与文字。
    const where = () => c.eval(`(()=>{const o=${O},b=o.getBoundingClientRect();const card=[...o.querySelectorAll(':scope>.turn-card')].find(x=>x.textContent.includes('【回复开头】'));const btn=document.getElementById('card-jump-latest');
      return {startOffset:card?Math.round(card.getBoundingClientRect().top-b.top):null,gap:Math.round(o.scrollHeight-o.clientHeight-o.scrollTop),replyTaller:card?card.getBoundingClientRect().height>o.clientHeight:false,button:btn&&!btn.hidden?btn.textContent:null,following:o._cardFollowController.isFollowing()}})()`);

    // 1) A 不在前台时跑完
    await open(A.id);
    ok('A 的最后一条回复超过一屏', (await where()).replyTaller);
    await open(B.id);
    await finish(A.id);
    await sleep(300);
    await open(A.id);
    let w = await where();
    ok('切回 A：停在这条回复开头', w.startOffset !== null && w.startOffset >= 0 && w.startOffset <= 40 && !w.following, JSON.stringify(w));
    ok('底部提示「跳到最新」', /跳到最新|Jump to latest/.test(w.button || ''), JSON.stringify(w));
    await shot('20261127-R50-2a-切回停在回复开头');
    await c.eval(`document.getElementById('card-jump-latest').click()`); await sleep(400);
    w = await where();
    ok('点「跳到最新」回到底部并继续跟随', w.gap <= 3 && w.following && !w.button, JSON.stringify(w));
    await open(B.id); await open(A.id);
    w = await where();
    ok('只定位一次：再切回来照常在最新', w.gap <= 3, JSON.stringify(w));

    // 2) 正在看 A 时跑完：保持跟随
    await finish(A.id); await sleep(800);
    w = await where();
    ok('正在看的会话跑完不跳，仍在底部跟随', w.gap <= 3 && w.following, JSON.stringify(w));

    // 3) A 在前台但窗口失焦时跑完 → 重新获得焦点时停在回复开头
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await c.eval(`document.hasFocus=()=>false`);
    await finish(A.id); await sleep(800);
    w = await where();
    ok('失焦期间仍在底部（没回来之前不动）', w.gap <= 3, JSON.stringify(w));
    await c.eval(`delete document.hasFocus`);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await c.eval(`window.dispatchEvent(new Event('focus'))`); await sleep(300);
    w = await where();
    ok('窗口回到前台：停在回复开头并提示跳到最新', w.startOffset >= 0 && w.startOffset <= 40 && /跳到最新|Jump to latest/.test(w.button || ''), JSON.stringify(w));
    await shot('20261127-R50-2b-窗口回到前台停在回复开头');
  } finally {
    try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (error) { console.error('quit: ' + error.message); }
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
