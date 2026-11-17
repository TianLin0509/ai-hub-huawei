'use strict';
//   1) 两个考勤页都读不到 → 考勤页空状态就地给「考勤页」选择和「保存并读取」，错误写清各页结果；
//   2) 正式员工页没有打卡数据、OD 页有 → 自动换到 OD 页读成功，并记住；设置面板能看到「考勤页」选项。
// 用法：node tests/e2e-attendance-od-cdp.js [--out <目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

let odHasData = false;
function fakeSite() {
  const formal = '<!doctype html><meta charset="utf-8"><title>考勤</title><body><h1>我的考勤</h1><p>当前账号没有考勤数据，请到工时页面查看。</p></body>';
  const od = `<!doctype html><meta charset="utf-8"><title>工时</title><body><h1>我的工时</h1><p>近期出勤与工时统计</p><div id="out"></div><script>
    fetch('/servicetime/api/menuConfig').then(r=>r.json());
    fetch('/servicetime/api/queryMyServiceTime?page=1').then(r=>r.json()).then(j=>{document.getElementById('out').textContent=JSON.stringify(j).slice(0,80)});
    </script></body>`;
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    if (req.url.includes('menuConfig')) return json(res, { menus: [{ name: '我的工时' }] });
    if (req.url.includes('queryMyServiceTime')) return json(res, odHasData ? { code: 200, data: { rows: [
      { workDate: '2026-11-16', firstCardTime: '2026-11-16 08:47:12', lastCardTime: '2026-11-16 21:05:40' },
      { workDate: '2026-11-17', firstCardTime: '2026-11-17 09:01:03', lastCardTime: '' },
    ] } } : { code: 200, data: { rows: [] } });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/apps/servicetimeflow') ? od : formal);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : process.env.HUB_E2E_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'att-od-art-')));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-att-od-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: true }));
  const srv = await fakeSite();
  const base = `http://127.0.0.1:${srv.address().port}`;
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'attendance-od', extraEnv: {
      CLAUDE_HUB_COMPANY_ATTENDANCE: '1', CLAUDE_HUB_ATTENDANCE_TIMER: '0', CLAUDE_HUB_ATTENDANCE_EDGE: '0',
      CLAUDE_HUB_ATTENDANCE_URL: `${base}/apps/attendanceflow/#/myAttendance`, CLAUDE_HUB_SERVICETIME_URL: `${base}/apps/servicetimeflow/#/myServicetime`,
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async name => { await sleep(600); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const P = '#company-attendance-page';

    await wait(`!!document.getElementById('btn-company-attendance')`, 'nav button');
    // 1) 两页都没数据。
    let st = await c.eval(`ipcRenderer.invoke('company-attendance:sync')`);
    ok('两页都读不到时报错写清各页', st.lastResult && !st.lastResult.ok && st.lastResult.triedPages && /正式员工考勤页：.*；OD 考勤页：.*页面接口：api\/menuConfig、api\/queryMyServiceTime/.test(st.lastResult.error), st.lastResult?.error);
    await click('#btn-company-attendance');
    await wait(`(()=>{const p=document.querySelector('${P}');return p&&!p.hidden&&!!p.querySelector('[data-att="quick-page"]')})()`, 'inline page choice');
    const opts = await c.eval(`[...document.querySelectorAll('${P} [data-f="quickPage"] option')].map(o=>o.textContent)`);
    ok('空状态就地给考勤页选择', opts.length === 3 && /^自动/.test(opts[0]) && opts.includes('只用 OD 考勤页'), JSON.stringify(opts));
    await shot('20261118-r38d-attendance-od-failed');

    // 2) OD 页有数据：就地选「自动」点「保存并读取」→ 自动换到 OD 页读到。
    odHasData = true;
    await click(`${P} [data-att="quick-page"]`);
    await wait(`document.querySelector('${P} .att-hero')`, 'hero after OD sync', 120000);
    st = await c.eval(`ipcRenderer.invoke('company-attendance:status')`);
    ok('自动换到 OD 页读成功并记住', st.lastResult?.ok && st.lastResult.page === 'servicetime' && st.settings.lastPage === 'servicetime' && /servicetimeflow/.test(st.url), JSON.stringify({ r: st.lastResult, lastPage: st.settings.lastPage }));
    ok('OD 记录按日期和打卡时刻认出', JSON.stringify(st.records.map(r => [r.date, r.first, r.last])) === JSON.stringify([['2026-11-16', '08:47', '21:05'], ['2026-11-17', '09:01', '09:01']]), JSON.stringify(st.records));
    await shot('20261118-r38d-attendance-od-ok');
    await click(`${P} [data-att="settings"]`);
    await wait(`!!document.querySelector('${P} [data-f="page"]')`, 'settings page select');
    await shot('20261118-r38d-attendance-od-settings');
    const overflow = await c.eval(`(()=>{const p=document.querySelector('${P} .att-scroll');return p?p.scrollWidth>p.clientWidth:false})()`);
    ok('1440 宽无横向溢出', !overflow);
    console.log('ARTIFACTS ' + out);
  } finally {
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
