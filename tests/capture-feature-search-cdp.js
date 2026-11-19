'use strict';
// 设置页搜索 + Ctrl+K 命令面板截图与走查（2026-11-20 体验 1、2）：隔离数据目录、隐藏窗口，1440×900。
//   node tests/capture-feature-search-cdp.js --out <新目录> [--tag <文件名标记>] [--before]
// 走的是用户真实路径：点设置 → ⚙️ 设置 → 在搜索框打字 → 回车；任意界面按 Ctrl+K → 打字 → 回车。
// --before：只截改动前也有的界面（配置弹窗、空白 Ctrl+K、输入「工作目录」），给改前改后对照用。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function argsOf(argv) {
  const args = { out: path.join(REPO, 'artifacts', 'feature-search-' + Date.now()), tag: 'after', before: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') { args.before = true; args.tag = 'before'; continue; }
    if (!['--out', '--tag'].includes(argv[i]) || argv[i + 1] == null) throw Error('Expected --out/--tag value');
    args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function run(args) {
  fs.mkdirSync(args.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feature-search-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  for (const dir of [data, work]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const evidence = { shots: [], checks: {}, rendererErrors: [], startedAt: new Date().toISOString() };
  const extraEnv = { AI_HUB_WORKSPACE_ROOT: work, HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex') };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'feature-search-capture', extraEnv });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* ignore */ } });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 15000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(150); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 'clickable ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const key = async (k, code, keyCode, modifiers = 0) => {
      for (const type of ['rawKeyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    };
    const type = async text => c.send('Input.insertText', { text });
    const shot = async name => {
      await sleep(350);
      const image = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      const file = path.join(args.out, `20261119-search-${args.tag}-${name}-1440-uxI.png`);
      fs.writeFileSync(file, image); evidence.shots.push(file);
    };
    // 当前高亮的是哪一项、焦点在哪、页面有没有纵向滚动条
    const flashState = () => c.eval(`(()=>{const f=document.querySelector('.hub-search-flash');const a=document.activeElement;return {flash:f?(f.innerText||f.textContent||'').trim().slice(0,60):null,focus:a?(a.id||a.getAttribute('data-f')||a.getAttribute('data-w')||a.tagName):null,docScroll:document.documentElement.scrollHeight>innerHeight}})()`);
    const openConfig = async () => { await click('#btn-options'); await sleep(250); await click('#options-settings'); await wait(`!document.getElementById('config-modal').classList.contains('hidden')`, 'config open'); await sleep(500); };
    const closeConfig = async () => { await c.eval(`document.getElementById('config-close')?.click()`); await sleep(300); };

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof selectSession === "function" && !!window.LaunchCenter', 'renderer ready', 40000);
    await sleep(1800);

    // 1) 设置弹窗
    await openConfig();
    await shot('1-config');
    if (!args.before) {
      await click('#hub-feature-search-input'); await type('回车'); await sleep(300);
      evidence.checks.listEnter = await c.eval(`[...document.querySelectorAll('.hub-feature-search-item')].map(e=>e.innerText.replace(/\\s+/g,' '))`);
      await shot('2-config-type-回车');
      await key('Enter', 'Enter', 13); await sleep(900);
      evidence.checks.afterEnter = await flashState();
      await shot('3-config-enter-回车键');
      // 跨页：在设置搜索里搜考勤的设置项。新用户考勤默认关，应改去「可选功能」停在考勤那一项
      await c.eval(`(()=>{const i=document.getElementById('hub-feature-search-input');i.focus();i.value='';})()`); await type('考勤 域名'); await sleep(300);
      evidence.checks.listAttendance = await c.eval(`[...document.querySelectorAll('.hub-feature-search-item')].map(e=>e.innerText.replace(/\\s+/g,' '))`);
      await shot('4-config-type-考勤域名');
      await key('Enter', 'Enter', 13); await sleep(1500);
      evidence.checks.afterAttendance = await flashState();
      evidence.checks.optionalDialogOpen = await c.eval(`!!document.querySelector('.optional-features-dialog[open]')`);
      await shot('5-attendance-off-goes-optional');
      await c.eval(`document.querySelector('.optional-features-dialog[open]')?.close()`); await sleep(300);
    }
    await closeConfig();

    // 2) Ctrl+K 命令面板
    await click('#btn-home'); await sleep(500);
    await key('k', 'KeyK', 75, 2); await sleep(400);
    await shot('6-cmdk-empty');
    await type('工作目录'); await sleep(400);
    evidence.checks.cmdkWorkdir = await c.eval(`[...document.querySelectorAll('.hub-cmdk-item')].map(e=>e.innerText.replace(/\\s+/g,' '))`);
    await shot('7-cmdk-type-工作目录');
    if (!args.before) {
      await key('Enter', 'Enter', 13); await sleep(1800);
      evidence.checks.cmdkAfterEnter = await flashState();
      await shot('8-cmdk-enter-工作目录');
      await closeConfig();
      await key('k', 'KeyK', 75, 2); await sleep(400);
      await type('kq'); await sleep(400);
      evidence.checks.cmdkPinyin = await c.eval(`[...document.querySelectorAll('.hub-cmdk-item')].map(e=>e.innerText.replace(/\\s+/g,' '))`);
      await shot('9-cmdk-pinyin-kq');
      await key('Escape', 'Escape', 27); await sleep(200);
      await key('k', 'KeyK', 75, 2); await sleep(400);
      await type('检查更新'); await sleep(300);
      await key('Enter', 'Enter', 13); await sleep(1200);
      evidence.checks.cmdkCheckUpdate = await c.eval(`[...document.querySelectorAll('dialog[open], .app-update-dialog[open]')].map(d=>d.className)`);
      await shot('10-cmdk-检查更新');
      await c.eval(`document.querySelectorAll('dialog[open]').forEach(d=>d.close())`); await sleep(300);
      // 考勤开着时：搜「考勤 域名」→ 打开考勤页、展开页面里的设置、高亮公司域名
      const enabled = await c.eval(`(async()=>{try{await window.__optionalFeatures.set('attendance',true);return window.__optionalFeatures.get('attendance')?.on}catch(e){return e.message}})()`);
      evidence.checks.attendanceEnabled = enabled;
      await sleep(1500);
      await key('k', 'KeyK', 75, 2); await sleep(400);
      await type('考勤 域名'); await sleep(400);
      evidence.checks.cmdkAttendanceOn = await c.eval(`[...document.querySelectorAll('.hub-cmdk-item')].map(e=>e.innerText.replace(/\\s+/g,' '))`);
      await key('Enter', 'Enter', 13); await sleep(2500);
      evidence.checks.attendanceOnAfterEnter = await flashState();
      evidence.checks.attendanceSettingsOpen = await c.eval(`!!document.querySelector('#company-attendance-page .att-settings')`);
      await shot('11-cmdk-考勤开启-公司域名');
    } else {
      await key('Escape', 'Escape', 27);
    }
  } catch (error) { evidence.error = error.stack || String(error); if (error.logTail) evidence.logTail = error.logTail; }
  finally {
    if (c) try { c.close?.(); } catch { /* closed */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(args.out, `20261119-search-${args.tag}-capture-uxI.json`), JSON.stringify(evidence, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* locked logs */ }
  }
  console.log(JSON.stringify({ shots: evidence.shots.length, checks: evidence.checks, error: evidence.error, rendererErrors: evidence.rendererErrors.slice(0, 5) }, null, 1));
  if (evidence.error) process.exitCode = 1;
}

if (require.main === module) run(argsOf(process.argv.slice(2))).catch(error => { console.error(error); process.exit(1); });
