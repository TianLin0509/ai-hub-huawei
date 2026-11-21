'use strict';
// 小修集合（2026-11-19）真实界面回归：隔离 Hub、全新 data 目录、模拟 CodeAgent、无头，1440×960 截图。
//   1. 代码块字号跟随正文字号与 Ctrl+加减号；
//   2. Hub 设置「新建会话默认工作目录」、助理设置「我的工作目录」；
//   3. 按会话记住后台显示方式（左右并排）。
// 用法：node tests/e2e-small-fixes-20261119-cdp.js [--tag after]
//   环境变量 M5_REPO 指向要测的程序目录（默认本仓库；指向 origin/main 的副本可拍「改前」）；
//   HUB_E2E_ELECTRON 指向 electron.exe（worktree 没有 node_modules 时借成员库的）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(process.env.M5_REPO || path.join(__dirname, '..'));
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? process.argv[i + 1] : 'after'; })();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'small-fixes-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'fake.jsonl');
const CHOSEN = path.join(ROOT, 'chosen root');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(150); } throw Error('Timeout ' + label + (last ? ': ' + last.message : '')); }
const results = [];
function note(label, value) { results.push({ label, value }); console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }

function writeHistory(file, sessionId) {
  const rows = []; let parent = null;
  const bodies = [
    ['user', '帮我写一个读取 CSV 的函数'],
    ['assistant', '下面是一个最小实现：\n\n```python\nimport csv\n\ndef read_rows(path):\n    with open(path, newline="", encoding="utf-8") as f:\n        return list(csv.DictReader(f))\n```\n\n调用 `read_rows("data.csv")` 即可，返回每行一个字典。'],
    ['user', '好的，谢谢'],
    ['assistant', '不客气。'],
  ];
  for (const [role, text] of bodies) {
    const id = crypto.randomUUID();
    rows.push(JSON.stringify({ type: role, sessionId, cwd: WORK, uuid: id, parentUuid: parent, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }));
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
  const electron = process.env.HUB_E2E_ELECTRON;
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'small-fixes', windowMode: 'background',
    ...(electron ? { executablePath: electron } : {}),
    extraEnv: {
      // 不设 AI_HUB_WORKSPACE_ROOT：要测的就是「没有环境变量时」界面设置能不能改工作根。
      AI_HUB_WORKSPACE_ROOT: '', AI_HUB_LEGACY_WORKSPACE_ROOTS: '',
      AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
    } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  const click = async selector => {
    const xy = await wait(() => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width)return null;return {x:r.left+r.width/2,y:r.top+r.height/2}})()`), 'clickable ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(OUT, `20261119-m5-${name}-${TAG}.png`); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); note('截图', file); };
  const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await wait(() => c.eval('document.readyState==="complete"&&typeof selectSession==="function"&&(sessionSplit,true)'), 'app ready');
    const made = [];
    for (const title of ['代码示例', '另一个会话']) {
      const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title, codeagentAccount: 'personal' } });
      made.push(await wait(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), 'native identity ' + title));
    }
    const [s1, s2] = made;
    const native = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.hubSession === s1.id && r.configDir);
    writeHistory(path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), s1.ccSessionId + '.jsonl'), s1.ccSessionId);
    const id1 = JSON.stringify(s1.id), id2 = JSON.stringify(s2.id);
    await c.eval(`selectSession(${id1})`);
    await wait(() => c.eval(`activeSessionId===${id1}&&currentView==='card'`), 'selected');
    await c.eval(`window._loadSessionHistoryToOverlay(${id1},{forceScrollBottom:true})`);
    await wait(() => c.eval(`!!document.querySelector('#msg-overlay .code-block-wrap pre')`), 'code block rendered');

    // ── 1. 代码块字号 ──
    const sizes = () => c.eval(`(()=>{const pre=document.querySelector('#msg-overlay .code-block-wrap pre'),body=pre.closest('.turn-body');return {body:getComputedStyle(body).fontSize,code:getComputedStyle(pre).fontSize}})()`);
    note('1 默认字号（正文/代码）', await sizes());
    await c.eval(`require('../renderer/card-display-settings.js').applyCardDisplaySettings(document,{cardFontSize:20})`);
    await sleep(200);
    const at20 = await sizes();
    note('1 正文字号调到 20px 后（正文/代码）', at20);
    await c.eval(`setFontSize(20)`);
    await sleep(200);
    const zoomed = await sizes();
    note('1 再 Ctrl+加号到阅读字号 20（正文/代码）', zoomed);
    note('1 代码块外层裁切', await c.eval(`(()=>{const out=[];let e=document.querySelector('#msg-overlay .code-block-wrap pre');while(e&&e.id!=='msg-overlay'){const cs=getComputedStyle(e);if(cs.overflow!=='visible'||cs.maxHeight!=='none'||cs.contentVisibility!=='visible')out.push([e.className.slice(0,50),cs.overflow,cs.maxHeight,cs.contentVisibility,Math.round(e.getBoundingClientRect().height)]);e=e.parentElement;}return out})()`));
    await c.eval(`(()=>{const row=document.querySelector('#msg-overlay .code-block-wrap').closest('.conversation-progress-row');row?.querySelector('[data-progress-expand]')?.click();})()`);
    await c.eval(`document.querySelector('#msg-overlay .code-block-wrap').scrollIntoView({block:'center'})`);
    await sleep(500);
    await shot('1-code-font');
    await c.eval(`setFontSize(16);require('../renderer/card-display-settings.js').applyCardDisplaySettings(document,{})`);

    // ── 3. 后台显示方式：左右并排后切走再回来 ──
    await click('#btn-backstage-menu');
    await click('[data-backstage-layout="split"]');
    await wait(() => c.eval('sessionSplit.isBackstage()'), 'split backstage opened', 20000);
    await c.eval(`selectSession(${id2})`);
    await wait(() => c.eval(`activeSessionId===${id2}`), 'switched to s2');
    await sleep(800);
    note('3 切到另一个会话时还在并排', await c.eval('sessionSplit.isBackstage()'));
    await c.eval(`selectSession(${id1})`);
    await wait(() => c.eval(`activeSessionId===${id1}`), 'back to s1');
    let restored = false;
    try { restored = await wait(() => c.eval('sessionSplit.isBackstage()'), 'split restored', 8000); } catch { restored = false; }
    note('3 切回原会话后仍是左右并排', !!restored);
    await shot('3-backstage-split-back');
    // 3b. 休眠会话：切回时终端起不来（唤醒故意拖 9 秒，超过 6 秒等待），先卡片 + 轻提示，唤醒后自动恢复并排。
    if (restored) {
      await c.eval(`selectSession(${id2})`);
      await wait(() => c.eval(`activeSessionId===${id2}`), 'switched to s2 (before suspend)');
      await sleep(600);
      const sus = await invoke('suspend-session', { sessionId: s1.id });
      note('3b 让原会话休眠', sus && sus.ok);
      await wait(() => c.eval(`sessions.get(${id1})?.status==='dormant'`), 's1 dormant', 20000);
      await c.eval(`(()=>{const ipc=require('electron').ipcRenderer;if(ipc.__m5Slow)return;const orig=ipc.invoke.bind(ipc);ipc.__m5Slow=true;ipc.invoke=(ch,...a)=>ch==='resume-session'?new Promise(r=>setTimeout(r,9000)).then(()=>orig(ch,...a)):orig(ch,...a);})()`);
      await c.eval(`selectSession(${id1})`);
      const toast = await wait(() => c.eval(`(()=>{const t=document.getElementById('gc-fork-toast');return t&&/左右并排/.test(t.textContent)?t.textContent:null})()`), 'fallback toast', 12000).catch(() => '');
      note('3b 等不到终端时的提示', toast || '(没有提示)');
      note('3b 提示时的视图', await c.eval(`({backstage:sessionSplit.isBackstage(),view:currentView,status:sessions.get(${id1})?.status})`));
      await shot('3b-dormant-fallback-toast');
      let rewoke = false;
      try { rewoke = await wait(() => c.eval(`sessions.get(${id1})?.status!=='dormant'&&sessionSplit.isBackstage()`), 'split restored after wake', 30000); } catch { rewoke = false; }
      note('3b 唤醒后自动恢复左右并排', !!rewoke);
      await sleep(500);
      await shot('3b-dormant-restored');
    }
    if (restored) {
      await click('#btn-backstage-menu');
      await click('[data-backstage-layout="single"]');
      await wait(() => c.eval('!sessionSplit.isBackstage()'), 'single');
      await c.eval(`selectSession(${id2})`); await sleep(500); await c.eval(`selectSession(${id1})`); await sleep(2500);
      note('3 改回卡片/后台切换后，切回来保持卡片', await c.eval(`!sessionSplit.isBackstage()&&currentView==='card'`));
    }

    // ── 2a. Hub 设置 · 新建会话默认工作目录 ──
    note('2 改前工作根', (await invoke('workspace:work-root')).root);
    await c.eval('openConfigModal()');
    await wait(() => c.eval(`!document.getElementById('config-modal').classList.contains('hidden')`), 'config modal');
    const hasField = await c.eval(`!!document.getElementById('cfg-workspace-root')`);
    note('2 设置里有「新建会话默认工作目录」', hasField);
    if (hasField) {
      await c.eval(`window.__hubSettingsTabs?.reveal(document.getElementById('cfg-workspace-root'));document.getElementById('cfg-workspace-root').scrollIntoView({block:'center'})`);
      await sleep(300);
      await shot('2a-hub-settings-before-save');
      await click('#cfg-workspace-root');
      await c.send('Input.insertText', { text: CHOSEN });
      await click('#config-save');
      await wait(() => c.eval(`document.getElementById('config-save-msg').classList.contains('success')`), 'saved', 15000);
      await sleep(300);
      await shot('2a-hub-settings-saved');
      const root = await invoke('workspace:work-root');
      note('2 保存后工作根', root);
      assert.equal(path.resolve(root.root), path.resolve(CHOSEN));
      assert.equal(root.flat, true);
      const def = await invoke('workspace:default', {});
      note('2 新建会话默认目录', def && (def.path || def.cwd));
      const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
      note('2 config.json workspace', saved.workspace);
    } else {
      await c.eval(`window.__hubSettingsTabs?.reveal(document.getElementById('cfg-composer-enter'));document.getElementById('cfg-composer-enter')?.scrollIntoView({block:'center'})`);
      await sleep(300);
      await shot('2a-hub-settings-before-save');
    }
    await c.eval(`document.getElementById('config-modal').classList.add('hidden')`);

    // ── 2b. 助理设置 · 我的工作目录 ──
    const status = await invoke('company-assistant:status', {});
    note('2 助理状态里的工作目录', status && status.workDir);
    try {
      await click('#btn-company-assistant');
      await sleep(800);
      // 全新用户第一次进助理页先过「开启助理」一步（真实点击）。
      await c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='开启助理'&&x.getBoundingClientRect().width);if(b)b.click();})()`);
      await sleep(1500);
      await wait(() => c.eval(`!!document.querySelector('[data-ca^="settings-tab"],[data-slot="panel"]')`), 'assistant page', 15000);
      await c.eval(`(()=>{const b=document.querySelector('[data-ca="settings-tab:welink"]');if(b)b.click();})()`);
      await sleep(800);
      if (!(await c.eval(`!!document.querySelector('.ca-settings')`))) {
        await c.eval(`(()=>{const b=[...document.querySelectorAll('[data-ca]')].find(x=>/^settings/.test(x.dataset.ca));if(b)b.click();})()`);
        await sleep(600);
        await c.eval(`(()=>{const b=document.querySelector('[data-ca="settings-tab:welink"]');if(b)b.click();})()`);
        await sleep(800);
      }
      note('2 助理设置页显示', await c.eval(`(()=>{const s=document.querySelector('[data-slot="work-dir"]');return s?s.textContent:'(没有这一栏)'})()`));
      await c.eval(`document.querySelector('[data-slot="work-dir"]')?.scrollIntoView({block:'center'})`);
      await sleep(300);
      await shot('2b-assistant-work-dir');
    } catch (error) { note('2 助理页没能打开', error.message); }
  } finally {
    fs.writeFileSync(path.join(OUT, `20261119-m5-e2e-${TAG}.json`), JSON.stringify(results, null, 2));
    await gracefulQuit(hub, { allowAlreadyExited: true }).catch(() => {});
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
