'use strict';
// Home middle column (session list, conversation, composer) in three states — no session, one
// session, group chat — at 1440 and 1280. Each state is captured twice: with the company shell
// (data-hw-shell) and with that hook removed, so a candidate can prove its rules stay scoped.
// Also records the distinct font sizes and the smallest one per state. Isolated data dir, hidden
// window, fake CodeAgent CLI; no real model or company request.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { createHash } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }];
// Group first: the home "new group" entry is only on the empty home screen.
const STATES = ['empty', 'group', 'session'];

function argsOf(argv) {
  const args = { entry: REPO, out: path.join(REPO, 'artifacts', 'home-mid-' + Date.now()), states: STATES };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--entry', '--out', '--states'].includes(argv[i]) || !argv[i + 1]) throw Error('Expected --entry/--out/--states value');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (typeof args.states === 'string') args.states = args.states.split(',');
  if (args.states.some(s => !STATES.includes(s))) throw Error('Unknown state');
  args.states = STATES.filter(s => args.states.includes(s));
  args.entry = path.resolve(args.entry); args.out = path.resolve(args.out);
  return args;
}

function seed(dir, accountId) {
  const entry = path.resolve(process.env.HOME_MID_ENTRY || REPO);
  const { writeProbed } = require(path.join(entry, 'core/codeagent-model-probe'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
}

// Appends a short exchange to the fake CLI's transcript so the card view has real turns to show.
function writeExchange(file, sessionId, cwd) {
  const at = Date.now(), line = (o, dt) => JSON.stringify({ sessionId, cwd, uuid: require('node:crypto').randomUUID(), timestamp: new Date(at + dt).toISOString(), ...o });
  fs.appendFileSync(file, [
    line({ type: 'user', message: { role: 'user', content: '按 10 ms / 20 ms 两档周期，对比同信道种子下的上行 SINR，给出分档门限建议。' } }, 0),
    line({ type: 'assistant', message: { role: 'assistant', model: 'GLM-5.2-WX-Auto', content: [{ type: 'text', text: '先确认口径：用 3 个信道种子、每个 200 个样本，按 5% 边缘用户和均值两个指标给门限。开始跑对比，预计 6 分钟。' }] } }, 30000),
  ].join('\n') + '\n');
}

async function run(args) {
  if (fs.existsSync(args.out) && fs.readdirSync(args.out).length) throw Error('Use a new output directory: ' + args.out);
  fs.mkdirSync(args.out, { recursive: true });
  process.env.HOME_MID_ENTRY = args.entry;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-mid-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  seed(personal, 'capture-personal');
  const log = path.join(root, 'codeagent-fixture.jsonl');
  const evidence = { entry: args.entry, root, shots: [], errors: [], rendererErrors: [], startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(path.join(args.out, 'home-mid-manifest.json'), JSON.stringify(evidence, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: args.entry, cwd: args.entry, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'home-mid-capture', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: log, CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* CDP framing */ } });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(150); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return r.width&&r.height&&(h===e||e.contains(h))?{x,y}:null})()`, selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    await wait('typeof selectSession === "function" && !!window.LaunchCenter', 'renderer ready');
    const fontStats = `(()=>{const sizes={},small=[],examples={};for(const e of document.querySelectorAll('#session-sidebar *, #terminal-panel *, #meeting-room-panel *, #home-workbench *, .floating-input-bar *')){if(!e.offsetParent&&getComputedStyle(e).position!=='fixed')continue;const own=[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());if(!own)continue;const r=e.getBoundingClientRect();if(!r.width||!r.height||r.right<0||r.left>innerWidth)continue;const fs=parseFloat(getComputedStyle(e).fontSize);if(!fs)continue;sizes[fs]=(sizes[fs]||0)+1;const name=x=>x.id?'#'+x.id:(typeof x.className==='string'&&x.className.trim()?'.'+x.className.trim().split(' ').filter(Boolean).join('.'):x.tagName.toLowerCase());const where=[e,e.parentElement,e.parentElement?.parentElement].filter(Boolean).map(name).reverse().join('>');(examples[fs]||(examples[fs]=[])).length<6&&examples[fs].push(where+' "'+e.textContent.trim().slice(0,12)+'"');if(fs<12)small.push(where+':'+fs)}return {sizes,distinct:Object.keys(sizes).length,small:small.slice(0,20),examples,overflow:document.documentElement.scrollWidth>innerWidth}})()`;
    const prepare = async state => {
      if (state === 'empty') { await click('#btn-home'); await sleep(400); return; }
      if (state === 'session') {
        const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
        const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: 'SRS 分档方案实现', codeagentAccount: 'personal' } })})`);
        if (!created?.id) throw Error('session not created: ' + JSON.stringify(created));
        evidence.sessionId = created.id;
        await wait(`(()=>{try{return require('fs').readFileSync(${JSON.stringify(log)},'utf8').length>${before}}catch{return false}})()`, 'fake CLI started');
        const started = fs.readFileSync(log, 'utf8').slice(before).trim().split('\n').map(JSON.parse).find(r => r.hubSession === created.id && r.sessionId);
        if (started) writeExchange(path.join(started.configDir, 'projects', started.cwd.replace(/[^A-Za-z0-9]/g, '-'), started.sessionId + '.jsonl'), started.sessionId, started.cwd);
        await c.eval(`selectSession(${JSON.stringify(created.id)})`);
        await wait(`document.querySelector('#session-sidebar .session-item.selected')`, 'session selected');
        await sleep(2500);
        return;
      }
      await click('#btn-home'); await click('#home-create-group');
      await wait(`document.querySelector('.mcm-dialog .mcm-create')`, 'group modal');
      await c.eval(`(()=>{const i=document.querySelector('#mcm-title-input');i.focus();i.select()})()`); await c.send('Input.insertText', { text: 'SRS 周期方案讨论' });
      await click('.mcm-dialog .mcm-create');
      await wait(`(()=>{const p=document.querySelector('#meeting-room-panel');return p&&p.offsetParent!==null&&document.querySelector('#mr-input-box')})()`, 'group chat open', 45000);
      await sleep(1500);
    };
    for (const state of args.states) {
      try {
        await prepare(state);
        // Optional diagnostics: HOME_MID_PROBE is a renderer expression; its result is kept with the evidence.
        if (process.env.HOME_MID_PROBE) evidence[`probe-${state}`] = await c.eval(process.env.HOME_MID_PROBE);
        for (const vp of VIEWPORTS) {
          await c.send('Emulation.setDeviceMetricsOverride', { ...vp, deviceScaleFactor: 1, mobile: false });
          await c.send('Page.captureScreenshot', { format: 'png' }); await sleep(500);
          for (const mode of ['hw', 'nohw']) {
            await c.eval((mode === 'hw' ? "document.documentElement.dataset.hwShell='1'" : 'delete document.documentElement.dataset.hwShell') + ";typeof scheduleSessionListRender==='function'&&scheduleSessionListRender()"); await sleep(600);
            await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: vp.height - 2 }); await sleep(400);
            const image = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
            const file = `home-${state}-${vp.width}-${mode}.png`; fs.writeFileSync(path.join(args.out, file), image);
            const shot = { state, mode, ...vp, file, sha256: sha(image), fonts: mode === 'hw' ? await c.eval(fontStats) : undefined };
            if (mode === 'nohw' && await c.eval(`!!document.querySelector('link[href$="hw-mid.css"]')`)) {
              // Scoping proof: without data-hw-shell, the frame must be byte-identical with hw-mid.css switched off.
              // Toasts and the caret change on their own: hide them. The status bar ticks every second; keep it (its ticks
              // may not repaint in a hidden window) and leave it out of the comparison; a 2px blinking dot inside the clipped-out
              // strip keeps the hidden window producing frames, otherwise an unchanged page never delivers a screenshot.
              await c.eval(`(()=>{const st=document.createElement('style');st.id='scope-freeze';st.textContent='[role=tooltip],[role=status]:not(#hub-system-footer *),[role=alert],.toast,.hub-toast,.app-toast{visibility:hidden!important}*{caret-color:transparent!important}';document.head.append(st);document.activeElement?.blur();const t=document.createElement('div');t.id='scope-tick';t.style.cssText='position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:2147483647;pointer-events:none';document.body.append(t);let on=0;window.__scopeTick=setInterval(()=>{t.style.background=(on^=1)?'#000':'#fff'},100)})()`);
              const clip = { x: 0, y: 0, width: vp.width, height: Math.floor(await c.eval(`(document.getElementById('hub-system-footer')?.getBoundingClientRect().top)||innerHeight`)) };
              await sleep(1200);
              const link = `document.querySelector('link[href$="hw-mid.css"]')`;
              const grab = async disabled => { await c.eval(`${link}.disabled=${disabled}`); await sleep(1200); return Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'); };
              const same = (x, y) => c.eval(`(()=>{const {nativeImage}=require('electron');const crop=b=>nativeImage.createFromDataURL('data:image/png;base64,'+b).crop(${JSON.stringify(clip)}).toBitmap();return crop(${JSON.stringify(x.toString('base64'))}).equals(crop(${JSON.stringify(y.toString('base64'))}))})()`);
              // off → on → off: only a frame that is stable on its own (off == off again) can prove anything.
              shot.scopeTries = 0; shot.scopedIdentical = 'unstable';
              for (let attempt = 0; attempt < 4 && shot.scopedIdentical === 'unstable'; attempt++) {
                shot.scopeTries++;
                const off = await grab(true), on = await grab(false), again = await grab(true);
                await c.eval(`${link}.disabled=false`);
                if (!await same(off, again)) continue;
                shot.scopedIdentical = await same(off, on);
                if (!shot.scopedIdentical) { fs.writeFileSync(path.join(args.out, `scope-off-${state}-${vp.width}.png`), off); fs.writeFileSync(path.join(args.out, `scope-on-${state}-${vp.width}.png`), on); }
              }
              await c.eval(`document.getElementById('scope-freeze')?.remove();clearInterval(window.__scopeTick);document.getElementById('scope-tick')?.remove()`);
            }
            evidence.shots.push(shot);
            save(); console.log(JSON.stringify({ captured: file }));
          }
          await c.eval("document.documentElement.dataset.hwShell='1'");
        }
      } catch (error) {
        evidence.errors.push({ state, error: error.stack });
        try { fs.writeFileSync(path.join(args.out, `failed-${state}.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* best effort */ }
        save(); console.error('Capture failed: ' + state + ': ' + error.message);
      }
    }
  } catch (error) { evidence.errors.push({ error: error.stack }); }
  finally {
    if (hub) { try { evidence.exit = await gracefulQuit(hub); } catch (e) { evidence.exitError = e.message; } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); fs.writeFileSync(path.join(args.out, 'hub.log'), hub.log().join('\n')); }
    try { await c?.close(); } catch { /* closed */ }
    evidence.complete = evidence.errors.length === 0 && evidence.rendererErrors.length === 0; evidence.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ complete: evidence.complete, shots: evidence.shots.length, errors: evidence.errors.length, out: args.out }));
    if (!evidence.complete) process.exitCode = 1;
  }
}
if (require.main === module) run(argsOf(process.argv.slice(2))).catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { run, argsOf };
