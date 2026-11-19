'use strict';
// 「问问 Hub」界面截图（2026-11-19）：隔离数据目录、隐藏窗口、假 CodeAgent；1440×900 截主页、会话页和打开的答疑面板。
//   node tests/capture-help-ask-cdp.js --out <新目录> [--states home,session,panel] [--ask "问题"]
// --ask 给了就真的发问（走本机真实 CLI，需要另设 AI_HUB_CODEAGENT_COMMAND 等），截回答出来后的面板。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function argsOf(argv) {
  const args = { out: path.join(REPO, 'artifacts', 'help-ask-' + Date.now()), states: 'home,session,panel', ask: '', real: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--real') { args.real = true; continue; }
    if (!['--out', '--states', '--ask'].includes(argv[i]) || argv[i + 1] == null) throw Error('Expected --out/--states/--ask value');
    args[argv[i].slice(2)] = argv[++i];
  }
  args.states = String(args.states).split(',').filter(Boolean);
  return args;
}

function seed(dir) {
  const { writeProbed } = require(path.join(REPO, 'core/codeagent-model-probe'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'capture-personal', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
}

async function run(args) {
  fs.mkdirSync(args.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-help-ask-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const evidence = { root, shots: [], rendererErrors: [], startedAt: new Date().toISOString() };
  const extraEnv = { AI_HUB_WORKSPACE_ROOT: work, HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' };
  if (!args.real) {
    seed(personal);
    Object.assign(extraEnv, { AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/help-ask-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex') });
  }
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'help-ask-capture', extraEnv, allowExternalState: args.real });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* framing */ } });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(200); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return r.width&&r.height&&(h===e||e.contains(h))?{x,y}:null})()`, selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof selectSession === "function" && !!window.LaunchCenter', 'renderer ready');
    await sleep(1500);
    const shot = async name => {
      await c.send('Page.captureScreenshot', { format: 'png' }); await sleep(400);
      const image = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      const file = path.join(args.out, `20261119-help-ask-${name}-1440-m6.png`);
      fs.writeFileSync(file, image); evidence.shots.push(file);
      evidence[`scroll-${name}`] = await c.eval('({doc:document.documentElement.scrollHeight>innerHeight,panel:(()=>{const p=document.querySelector(".help-ask-panel");return p?{h:p.scrollHeight,ch:p.clientHeight}:null})()})');
    };
    for (const state of args.states) {
      if (state === 'home') { await click('#btn-home'); await sleep(600); await shot('home'); }
      if (state === 'session') {
        const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '示例会话' } })})`);
        if (created?.id) { await c.eval(`selectSession(${JSON.stringify(created.id)})`); await sleep(2500); }
        await shot('session');
      }
      if (state === 'welcome-link') {
        await click('#btn-home'); await sleep(600);
        await shot('welcome-link-before'); evidence.linkRect = await c.eval(`(()=>{const r=document.querySelector('#community-help-ask').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`);
        await click('#community-help-ask');
        await wait(`document.querySelector('.help-ask-panel:not([hidden])')`, 'panel opened from home link');
        await sleep(800); await shot('welcome-link');
        await c.eval(`document.querySelector('.help-ask-panel [data-ha="close"]').click()`); await sleep(300);
      }
      if (state === 'cancel') {
        // 取消：问第一题、点「取消」，第一题标已取消；紧接着问第二题能正常答出（假 CodeAgent）
        await click('#btn-help-ask'); await wait(`document.querySelector('.help-ask-panel:not([hidden])')`, 'panel open');
        const ask = async q => { await c.eval(`(()=>{const t=document.querySelector('.help-ask-panel textarea');t.focus();t.value=''})()`); await c.send('Input.insertText', { text: q }); await click('.help-ask-panel [data-ha="send"]'); };
        await ask('第一题：要取消的');
        await click('.help-ask-panel [data-ha="cancel"]');
        evidence.cancelState = await c.eval(`[...document.querySelectorAll('.help-ask-panel .ask-qa')].pop().innerText`);
        const t0 = Date.now(); await ask('第二题：回车想换行在哪改？');
        await wait(`(()=>{const last=[...document.querySelectorAll('.help-ask-panel .ask-qa')].pop();return last&&last.querySelector('.ask-a')})()`, 'second answer', 60000);
        evidence.afterCancelMs = Date.now() - t0;
        await shot('cancel');
      }
      if (state === 'config') {
        await click('#btn-options'); await sleep(300); await click('#options-settings'); await sleep(1200);
        evidence.configVisible = await c.eval(`[...document.querySelectorAll('#config-main-view label, #config-main-view .config-section-label span:first-child, #config-main-view strong')].filter(e=>e.offsetParent).map(e=>e.textContent.trim().slice(0,30))`);
        await shot('config');
        await c.eval(`document.getElementById('config-cancel')?.click()`); await sleep(300);
      }
      if (state === 'panel') {
        await click('#btn-help-ask');
        await wait(`document.querySelector('.help-ask-panel:not([hidden])')`, 'panel open');
        await sleep(800);
        await wait(`(()=>{const p=document.querySelector('.help-ask-panel .ask-ttl p');return p&&/用 /.test(p.textContent)||document.querySelector('.help-ask-panel [data-ha="setup"]')})()`, 'engine state', 15000).catch(() => {});
        evidence.panelState = await c.eval(`document.querySelector('.help-ask-panel .ask-ttl p')?.textContent`);
        await shot('panel');
        if (args.ask) {
          await c.eval(`(()=>{const t=document.querySelector('.help-ask-panel textarea');t.focus();t.value='';})()`);
          await c.send('Input.insertText', { text: args.ask });
          const t0 = Date.now();
          await click('.help-ask-panel [data-ha="send"]');
          if (!args.real) { await wait(`document.querySelector('.help-ask-panel [data-ha="cancel"]')`, 'pending with cancel button'); await shot('pending'); }
          await wait(`(()=>{const last=[...document.querySelectorAll('.help-ask-panel .ask-qa')].pop();return last&&(last.querySelector('.ask-a')||last.querySelector('.ask-err'))})()`, 'answer', 200000);
          evidence.askMs = Date.now() - t0;
          evidence.answer = await c.eval(`[...document.querySelectorAll('.help-ask-panel .ask-qa')].pop().innerText`);
          await sleep(600);
          await shot('answer');
        }
      }
    }
  } catch (error) { evidence.error = error.stack || String(error); }
  finally {
    if (c) try { c.close?.(); } catch { /* closed */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(args.out, '20261119-help-ask-capture-m6.json'), JSON.stringify(evidence, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* locked logs */ }
  }
  console.log(JSON.stringify({ shots: evidence.shots, error: evidence.error, rendererErrors: evidence.rendererErrors.slice(0, 5), askMs: evidence.askMs }, null, 1));
  if (evidence.error) process.exitCode = 1;
}

if (require.main === module) run(argsOf(process.argv.slice(2))).catch(error => { console.error(error); process.exit(1); });
