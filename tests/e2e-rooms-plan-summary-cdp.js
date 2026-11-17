'use strict';
// 打开会议室页 → 抢订计划，勾周几、填时间、添加会议室，顶部说明跟着变成「几点抢、抢哪天哪个时段、按什么顺序」。
// 用法：node tests/e2e-rooms-plan-summary-cdp.js [--out <目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : process.env.HUB_E2E_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-sum-art-')));
  fs.mkdirSync(out, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rooms-sum-'));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'background', label: 'rooms-summary', extraEnv: {
      ...(fs.existsSync(path.join(REPO, 'community-edition.json')) ? {} : { CLAUDE_HUB_COMPANY_ASSISTANT: '1' }), CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = typeof expr === 'function' ? await expr() : await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(200); } throw Error('Timeout ' + label); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const type = (sel, value) => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const sum = () => c.eval(`document.querySelector('[data-cr-slot="plan-summary"]')?.textContent||''`);

    await wait(`!!document.getElementById('btn-company-rooms')`, 'rooms nav', 60000);
    await click('#btn-company-rooms');
    await wait(`!!document.querySelector('[data-cr-tab="plan"]')`, 'rooms page');
    await click('[data-cr-tab="plan"]');
    await wait(`!!document.querySelector('[data-cr-slot="plan-summary"]')`, 'plan tab');
    const empty = await wait(sum, 'summary text');
    ok('空计划时说明还差什么', /^还差：/.test(empty) && /放号时，替你预订 \d+ 天后那天的会议室/.test(empty), empty);
    ok('「会议在周几」标签替换了「哪几天要抢」', await c.eval(`document.querySelector('.cr-days-field span')?.textContent.startsWith('会议在周几')`));
    // 没装会议室组件时计划是锁着的（只读）；这里只验说明文字跟着草稿变，测试里解锁输入框。
    const unlock = () => c.eval(`document.querySelectorAll('#company-rooms-page [disabled], .cr-sheet [disabled]').forEach(e=>e.disabled=false)`);
    await unlock();
    for (let d = 1; d <= 7; d++) { await unlock(); await c.eval(`(()=>{const e=document.querySelector('[data-cr-day="${d}"]');if(e.checked!==${[1, 3].includes(d)})e.click();return 1})()`); }
    await type('[data-cr-field="开始时间"]', '14:00');
    await type('[data-cr-new-room]', 'A1-101 会议室');
    await unlock(); await click('[data-cr-op="add"]'); await unlock();
    await type('[data-cr-new-room]', 'B2-202 会议室');
    await unlock(); await click('[data-cr-op="add"]'); await unlock();
    const full = await wait(async () => { const t = await sum(); return /^按现在的设置/.test(t) && t; }, 'full summary');
    ok('填好后说明写清几点抢、哪天哪个时段、房间顺序', /每天 \d\d:\d\d 放号时，如果 \d+ 天后那天是周一、周三，就替你预订那天 14:00–\d\d:\d\d 的会议室，按 A1-101 会议室 → B2-202 会议室 的顺序/.test(full), full);
    fs.writeFileSync(path.join(out, '20261118-r38d-rooms-plan.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const scroll = await c.eval(`(()=>{const p=document.querySelector('[data-cr-slot="plan-summary"]')?.closest('.cr-main, .cr-body, section')?.parentElement;return p?{sh:p.scrollHeight,ch:p.clientHeight}:null})()`);
    console.log('LAYOUT ' + JSON.stringify(scroll));
    console.log('ARTIFACTS ' + out);
  } finally {
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
