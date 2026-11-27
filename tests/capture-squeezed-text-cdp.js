'use strict';
// Squeezed-text sweep: finds text boxes squeezed into a one-glyph-wide vertical column
// (the "actual model" label bug: a flex item with overflow-wrap:anywhere and no nowrap
// collapses to min-content = one glyph when the row is tight).
// Walks every page/state of the theme audit across viewport x zoom x theme, reports
// every element whose width < ~2 glyphs while its text spans >= 3 lines, and takes
// before/after shots of the composer row.
// Isolated data, background offscreen window, fake CodeAgent, no model calls.
// Usage: node tests/capture-squeezed-text-cdp.js --entry <checkout> --out <dir> [--themes codex,dark] [--views 1920x100,1366x150] [--lang en] [--states session-cards] [--sweep 0]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const audit = require('./capture-theme-audit-cdp');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function parseArgs(argv) {
  const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'squeezed-' + Date.now()), themes: ['codex', 'dark'], views: ['1920x100', '1920x125', '1920x150', '1366x100', '1366x125', '1366x150', '1024x100', '800x100'], lang: 'zh-CN', states: null, sweep: 1, height: 900 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (['themes', 'views', 'states'].includes(k)) opt[k] = v.split(',');
    else if (['sweep', 'height'].includes(k)) opt[k] = Number(v);
    else if (k === 'lang') opt.lang = v;
    else opt[k] = path.resolve(v);
  }
  return opt;
}

function squeezed() {
  const out = [];
  const short = el => { const parts = []; for (let e = el, n = 0; e && e.nodeType === 1 && n < 4; e = e.parentElement, n++) { let s = e.tagName.toLowerCase(); if (e.id) { s += '#' + e.id; parts.unshift(s); break; } const cls = String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).trim().split(/\s+/).filter(Boolean).slice(0, 2); if (cls.length) s += '.' + cls.join('.'); parts.unshift(s); } return parts.join(' > '); };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.xterm, svg, canvas')) continue;
    const own = [...el.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join('').replace(/\s+/g, '');
    if (own.length < 3) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (/vertical/.test(cs.writingMode)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const fs = parseFloat(cs.fontSize) || 12;
    const lh = parseFloat(cs.lineHeight) || fs * 1.4;
    // A text run whose box is under ~2.2 glyphs wide but at least 3 lines tall is vertically stacked.
    if (r.width < fs * 2.2 && r.height >= lh * 2.6) {
      const props = {}; for (const p of ['overflow-wrap', 'word-break', 'white-space', 'flex', 'min-width', 'width']) props[p] = cs.getPropertyValue(p);
      out.push({ el: short(el), text: own.slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], fontSize: fs, props });
    }
  }
  return out;
}

function seedActual(root, entry, lang) {
  const s = audit.__seed(root, entry);
  const file = path.join(s.data, 'sessions', s.sessions[0].hubId + '.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Long model id + terminal switch: the longest real form of the label.
  rec.actualModel = { id: 'claude-sonnet-4-5-20250929', launchModel: 'claude-opus-4-1-20250805', terminalSwitch: true };
  fs.writeFileSync(file, JSON.stringify(rec));
  const st = JSON.parse(fs.readFileSync(path.join(s.data, 'state.json'), 'utf8'));
  st.sessions[0] = rec; fs.writeFileSync(path.join(s.data, 'state.json'), JSON.stringify(st));
  if (lang && lang !== 'zh-CN') fs.writeFileSync(path.join(s.data, 'config.json'), JSON.stringify({ ui: { language: lang } }, null, 2));
  return s;
}

async function run(opt) {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-squeezed-'));
  const { data, claudeDir, work, personal, sessions } = seedActual(root, opt.entry, opt.lang);
  const result = { entry: opt.entry, commit: '', lang: opt.lang, startedAt: new Date().toISOString(), composer: [], findings: [], errors: [] };
  try { result.commit = require('node:child_process').execFileSync('git', ['-C', opt.entry, 'rev-parse', '--short', 'HEAD'], { windowsHide: true }).toString().trim(); } catch { /* not git */ }
  const save = () => fs.writeFileSync(path.join(opt.out, 'squeezed.json'), JSON.stringify(result, null, 1));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: opt.entry, cwd: opt.entry, dataDir: data, port: await freePort(), windowMode: 'background', label: 'squeezed', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* reload */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    const esc = async () => { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(200); };
    const HOME = `(()=>{document.querySelector('#btn-home')?.click();try{window.__askAsideUi&&window.__askAsideUi.hide()}catch{}})()`;
    const ready = 'typeof selectSession === "function"';
    await wait(ready, 'renderer ready');
    const sid = JSON.stringify(sessions[0].hubId);
    const all = audit.__baseStates(sessions).filter(s => !opt.states || opt.states.includes(s.name));
    const setView = async v => {
      const [w, z] = v.split('x').map(Number); const k = z / 100;
      // Windows display scaling: physical w px at k zoom = w/k CSS px wide, DPR k.
      await c.send('Emulation.setDeviceMetricsOverride', { width: Math.round(w / k), height: Math.round(opt.height / k), deviceScaleFactor: k, mobile: false });
      await sleep(900);
    };
    for (const theme of opt.themes) {
      await c.eval(`localStorage.setItem('hub.theme',${JSON.stringify(theme)})`);
      await c.send('Page.reload', {}); await sleep(1200);
      await wait(ready + ` && document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'theme ' + theme);
      for (const v of opt.views) {
        await setView(v);
        // 1) composer row shot (the reported spot)
        await c.eval(HOME); await sleep(200);
        await c.eval(`selectSession(${sid})`);
        await sleep(2200);
        const info = await c.eval(`(()=>{const e=document.querySelector('.floating-input-bar[data-session-id=${JSON.stringify(sessions[0].hubId)}] .composer-actual-model')||document.querySelector('.composer-actual-model:not([hidden])');const bar=e&&e.closest('.floating-input-bar')||document.querySelector('.floating-input-bar');if(!bar)return null;const b=bar.getBoundingClientRect();const r=e?e.getBoundingClientRect():null;const cs=e?getComputedStyle(e):null;return {bar:[b.left,b.top,b.width,b.height],label:r?[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]:null,text:e?e.textContent:'',display:cs?cs.display:'',title:e?e.title:'',hidden:e?e.hidden:null}})()`);
        const file = `composer-${theme}-${v}.png`;
        if (info) {
          const [x, y, w, h] = info.bar; const pad = 40;
          const clip = { x: Math.max(0, x - pad), y: Math.max(0, y - 160), width: w + pad * 2, height: h + 200, scale: 1 };
          fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })).data, 'base64'));
        }
        fs.writeFileSync(path.join(opt.out, `full-${theme}-${v}.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        const sq = await c.eval(`(${squeezed.toString()})()`);
        result.composer.push({ theme, view: v, file, info, squeezed: sq });
        console.log('composer', theme, v, JSON.stringify(info && { label: info.label, display: info.display }), 'squeezed', sq.length);
        save();
        if (!opt.sweep) continue;
        // 2) sweep every page/state
        for (const st of all) {
          try {
            await c.eval(HOME); await sleep(250);
            const r = await c.eval(st.open);
            if (r === 'missing') { result.errors.push({ theme, view: v, state: st.name, error: 'entry missing' }); continue; }
            await sleep(st.wait || 1200);
            const check = async name => {
              const f = await c.eval(`(${squeezed.toString()})()`);
              if (f.length) {
                const shot = `sq-${theme}-${v}-${name.replace(/[^\w一-龥~-]+/g, '')}.png`;
                fs.writeFileSync(path.join(opt.out, shot), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
                result.findings.push({ theme, view: v, state: name, shot, items: f });
                console.log('  FOUND', theme, v, name, f.length, f.slice(0, 3).map(x => x.el + ' "' + x.text + '"').join(' | '));
              }
            };
            await check(st.name);
            const subSel = st.tabs || st.items;
            if (subSel) {
              const count = await c.eval(`(()=>{const skip=${JSON.stringify(st.skip || '')};return [...document.querySelectorAll(${JSON.stringify(subSel)})].filter(e=>e.getClientRects().length&&!(skip&&new RegExp(skip).test(e.textContent.trim()))).length})()`);
              for (let i = 0; i < Math.min(count, 14); i++) {
                if (st.items && i > 0) { await esc(); await esc(); await c.eval(HOME); await sleep(200); await c.eval(st.open); await sleep(500); }
                const label = await c.eval(`(()=>{const skip=${JSON.stringify(st.skip || '')};const l=[...document.querySelectorAll(${JSON.stringify(subSel)})].filter(e=>e.getClientRects().length&&!(skip&&new RegExp(skip).test(e.textContent.trim())));const e=l[${i}];if(!e)return null;const t=(e.dataset.tab||e.dataset.page||e.getAttribute('aria-label')||e.textContent||'').trim().replace(/[^\\w\\u4e00-\\u9fa5]+/g,'').slice(0,10);e.click();return t||'${i}';})()`);
                if (!label) continue;
                await sleep(1100);
                await check(`${st.name}~${i}-${label}`);
              }
            }
            await esc(); await esc();
          } catch (error) { result.errors.push({ theme, view: v, state: st.name, error: error.message }); }
        }
        save();
      }
    }
    result.ok = true;
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    try { await c?.close(); } catch { /* closed */ }
    result.finishedAt = new Date().toISOString();
    save(); console.log('OUT ' + opt.out);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
  return result;
}

module.exports = { squeezed, run };
if (require.main === module) run(parseArgs(process.argv.slice(2)));
