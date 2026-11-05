'use strict';
// Home middle column after the company reskin: the composer controls a user actually clicks still work.
// Single session: 引用会话 inserts a picked conversation, typed text is sent to the session and the box
// clears (PTY keystrokes or session:send-prompt), the stop button (shown while the AI runs) is reachable and not under another control. Group chat:
// typed text is sent and shows up as a message. Isolated data dir, hidden window, fake CodeAgent CLI, no model.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const options = { entry: REPO, out: path.join(REPO, 'artifacts', 'home-mid-composer-' + Date.now()) };
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--entry', '--out'].includes(process.argv[i]) || !process.argv[i + 1]) throw Error('Expected --entry / --out');
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}

function seed(dir) {
  const { writeProbed } = require(path.join(options.entry, 'core/codeagent-model-probe'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'composer-personal', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
}

async function run() {
  fs.mkdirSync(options.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mid-composer-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), ''); seed(personal);
  const evidence = { entry: options.entry, root, checks: [], rendererErrors: [] };
  const check = (label, ok) => { assert(ok, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, c, failure;
  try {
    hub = await launchIsolatedHub({ entryPath: options.entry, cwd: options.entry, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'home-mid-composer', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* CDP framing */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(150); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    // A real pointer click at the control's centre; fails if another element covers it.
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return r.width&&r.height&&(h===e||e.contains(h))?{x,y}:null})()`, selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const type = async (selector, text) => { await click(selector); await c.send('Input.insertText', { text }); };
    await wait('typeof selectSession === "function" && !!window.LaunchCenter', 'renderer ready');
    evidence.companyShell = await c.eval('!!document.documentElement.dataset.hwShell');
    // Record what the composer hands to the main process: PTY keystrokes or the structured prompt send.
    await c.eval(`window.__sent=[];{const send=ipcRenderer.send.bind(ipcRenderer),invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.send=(ch,p)=>{if(ch==='terminal-input')__sent.push({ch,...p});return send(ch,p)};ipcRenderer.invoke=(ch,p,...r)=>{if(ch==='session:send-prompt')__sent.push({ch,sessionId:p?.sessionId,data:JSON.stringify(p)});return invoke(ch,p,...r)}}`);

    // Group chat first: the home "new group" entry is only on the empty home screen.
    await click('#btn-home'); await click('#home-create-group');
    await wait(`document.querySelector('.mcm-dialog .mcm-create')`, 'group modal');
    await c.eval(`(()=>{const i=document.querySelector('#mcm-title-input');i.focus();i.select()})()`); await c.send('Input.insertText', { text: '周期方案讨论' });
    await click('.mcm-dialog .mcm-create');
    await wait(`(()=>{const p=document.querySelector('#meeting-room-panel');return p&&p.offsetParent!==null&&document.querySelector('#mr-input-box')})()`, 'group chat open', 45000);
    await sleep(1000);
    await type('#mr-input-box', '群聊回归：各自说一句');
    await click('#mr-send-btn');
    await wait(`[...document.querySelectorAll('#meeting-room-panel .mr-gc-msg, #meeting-room-panel .mr-gc-bubble')].some(e=>e.textContent.includes('群聊回归：各自说一句'))`, 'group message shown', 20000);
    check('group chat: typed text is sent and shown as a message', true);
    check('group chat: input box clears after sending', await c.eval(`!document.querySelector('#mr-input-box').textContent.trim()`));

    // Single session.
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '输入回归', codeagentAccount: 'personal' } })})`);
    assert(created?.id, JSON.stringify(created));
    await c.eval(`selectSession(${JSON.stringify(created.id)})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'composer visible');
    await sleep(1500);

    await click('#terminal-panel .fi-bridge-reference');
    await wait(`document.querySelector('.modal-overlay [data-gc-picker-row]')`, 'reference picker');
    check('引用会话 opens the conversation picker', true);
    await click('.modal-overlay [data-gc-picker-row]');
    await wait(`document.querySelector('#terminal-panel .floating-input-box').textContent.trim().length>0`, 'reference inserted');
    check('引用会话 inserts the picked conversation into the input box', true);
    await c.eval(`document.querySelector('#terminal-panel .floating-input-box').textContent=''`);

    await type('#terminal-panel .floating-input-box', '单会话回归：发一句');
    await click('#terminal-panel .floating-input-send');
    await wait(`__sent.some(p=>p&&p.sessionId===${JSON.stringify(created.id)}&&String(p.data).includes('单会话回归：发一句'))`, 'send carries the text', 20000);
    check('single session: send delivers the typed text to the session', true);
    await wait(`!document.querySelector('#terminal-panel .floating-input-box').textContent.trim()`, 'input cleared');
    check('single session: input box clears after sending', true);

    // Stop is shown while the AI runs; show it the same way the runtime does and hit-test it.
    const stop = await c.eval(`(()=>{const s=document.querySelector('#terminal-panel .floating-input-stop'),send=document.querySelector('#terminal-panel .floating-input-send');s.classList.add('visible');const r=s.getBoundingClientRect(),q=send.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);const box=s.closest('.composer').getBoundingClientRect();return {w:r.width,h:r.height,hit:!!h&&(h===s||s.contains(h)),overlapSend:!(r.right<=q.left||r.left>=q.right||r.bottom<=q.top||r.top>=q.bottom)&&!(send.offsetParent===null),inside:r.left>=box.left&&r.right<=box.right&&r.top>=box.top&&r.bottom<=box.bottom}})()`);
    evidence.stop = stop;
    check('stop button is visible, reachable and inside the composer', stop.w > 0 && stop.h > 0 && stop.hit && stop.inside);
    const shot = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    fs.writeFileSync(path.join(options.out, 'composer-stop-1280.png'), shot);
    await c.eval(`document.querySelector('#terminal-panel .floating-input-stop').classList.remove('visible')`);
    check('no renderer errors', evidence.rendererErrors.length === 0);
    evidence.ok = true;
  } catch (error) { failure = error; evidence.ok = false; evidence.error = error.stack; try { fs.writeFileSync(path.join(options.out, 'failure.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* best effort */ } }
  finally {
    if (hub) { try { evidence.exit = await gracefulQuit(hub); } catch (e) { evidence.exitError = e.message; } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); fs.writeFileSync(path.join(options.out, 'hub.log'), hub.log().join('\n')); }
    try { await c?.close(); } catch { /* closed */ }
    fs.writeFileSync(path.join(options.out, 'composer-e2e.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, out: options.out }));
  }
  if (failure) throw failure;
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
