'use strict';
//   1) 没开启：左侧有「考勤」，点开是可选功能的开启提示；
//   2) 在页面上点「开启」→ Hub 隐藏窗口打开假考勤页、点「打卡记录」、截下接口 → 记录写入（真实取数链路，只是站点是假的）；
//   3) 预置三个月历史后截首屏、明细抽屉（时间轴 / 账本）、设置面板。
// 用法：node tests/capture-attendance-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

const REAL8 = [['2026-11-07', '16:03', '22:26', '智', '智'], ['2026-11-06', '08:53', '19:36', '智', '智'], ['2026-11-05', '08:47', '22:54', '智', '手'], ['2026-11-04', '08:43', '20:54', '智', '智'],
  ['2026-11-03', '09:29', '23:03', '手', '手'], ['2026-11-02', '08:42', '22:41', '智', '智'], ['2026-11-01', '01:29', '01:51', '手', '智'], ['2026-10-31', '08:42', '19:20', '智', '智']];
const card = ([d, a, b, ta, tb]) => ({ attendanceDate: d, clockInDate: d, earlyClockInTime: a, lateClockInTime: b, earlyClockTag: ta + ',S', lateClockTag: tb + ',S', dataSource: 'realtime' });

// 预置历史（只给界面验收用的固定样例）：8–10 月工作日，9 月偏重以触发超 80 小时。
function history() {
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let d = new Date(2026, 7, 3); d < new Date(2026, 9, 31); d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w === 0 || (w === 6 && rnd() > 0.2)) continue;
    const heavy = d.getMonth() === 8 ? 75 : 0;
    const a = 520 + Math.floor(rnd() * 45), b = 1170 + heavy + Math.floor(rnd() * 200);
    const t = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: k, first: t(a), last: t(Math.min(b, 1439)), firstTag: '智', lastTag: rnd() > 0.9 ? '手' : '智', fetchedAt: '2026-11-01T08:00:00.000Z' });
  }
  return out;
}

function fakeSite() {
  const html = `<!doctype html><meta charset="utf-8"><title>考勤</title><body><h1>我的考勤</h1><p>本月出勤统计与假期日历</p>
    <span id="t">打卡记录</span><div id="out"></div><script>
    fetch('/attendanceDocument/homePage/queryHolidayCalendarDetails').then(r=>r.json());
    document.getElementById('t').onclick=()=>fetch('/attendanceCompanion/services/attendance/card/queryCardRecord',{method:'POST',body:'{"jsonParam":"x"}'}).then(r=>r.json()).then(j=>{document.getElementById('out').textContent='共 '+j.length+' 天'});
    </script>`;
  const srv = http.createServer((req, res) => {
    if (req.url.includes('queryCardRecord')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(REAL8.map(card))); return; }
    if (req.url.includes('queryHolidayCalendarDetails')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([{ holidayDate: '2026-10-01', holidayName: '法定假 国庆' }])); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'attendance-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-attendance-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: false }));
  const srv = await fakeSite();
  const evidence = { steps: [], rendererErrors: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'attendance-capture', extraEnv: {
      CLAUDE_HUB_COMPANY_ATTENDANCE: '1', CLAUDE_HUB_ATTENDANCE_TIMER: '0', CLAUDE_HUB_ATTENDANCE_EDGE: '0',
      CLAUDE_HUB_ATTENDANCE_URL: `http://127.0.0.1:${srv.address().port}/apps/attendanceflow/#/myAttendance`,
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch { /* */ } });
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async name => { await sleep(700); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + name); };
    const clickSel = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);

    await wait(`!!document.getElementById('btn-company-attendance')`, 'nav button');
    evidence.steps.push('nav button present');
    await clickSel('#btn-company-attendance');
    await wait(`(()=>{const p=document.getElementById('company-attendance-page');return p&&!p.hidden})()`, 'page open');
    await shot('01-未开启');
    const enable = await c.eval(`(()=>{const b=document.querySelector('#company-attendance-page [data-of-gate="on"]');if(!b)return false;b.click();return b.textContent.trim()})()`);
    evidence.steps.push('enable button: ' + enable);
    await wait(`ipcRenderer.invoke('optional-features:list').then(l=>l.find(x=>x.id==='attendance')?.on)`, 'feature on');
    const synced = await c.eval(`ipcRenderer.invoke('company-attendance:sync')`);
    evidence.sync = { ok: synced?.lastResult?.ok, via: synced?.lastResult?.via, got: synced?.lastResult?.got, error: synced?.lastResult?.error, holidays: Object.keys(synced?.holidays || {}) };
    if (!synced?.lastResult?.ok) throw Error('真实取数链路失败：' + JSON.stringify(evidence.sync));
    await wait(`document.querySelector('#company-attendance-page .att-hero')`, 'hero after sync', 15000);
    await shot('02-首次读取后');

    // 预置历史：关页 → 写记录文件 → 再开
    const file = path.join(data, 'company-attendance', 'records.json');
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify([...history(), ...cur].sort((a, b) => (a.date < b.date ? -1 : 1)), null, 1));
    await clickSel('#btn-home'); await sleep(400); await clickSel('#btn-company-attendance');
    await wait(`document.querySelector('#company-attendance-page .att-year svg')`, 'year chart');
    await shot('03-首屏');
    await c.eval(`document.querySelector('#company-attendance-page .att-scroll').scrollTop=9999`); await shot('04-年度统计');
    await c.eval(`document.querySelector('#company-attendance-page .att-scroll').scrollTop=0`);
    await clickSel('#company-attendance-page .att-day[data-date="2026-11-05"]');
    await wait(`document.querySelector('#company-attendance-page .att-dpanel .att-tl')`, 'drawer time');
    await shot('05-明细-时间轴');
    await clickSel('#company-attendance-page [data-att="view"][data-v="ledger"]');
    await wait(`document.querySelector('#company-attendance-page .att-ledger')`, 'ledger'); await shot('06-明细-账本');
    await clickSel('#company-attendance-page [data-att="prev"]'); await shot('07-明细-上个月');
    await clickSel('#company-attendance-page .att-x'); await sleep(300);
    await clickSel('#company-attendance-page [data-att="settings"]'); await shot('08-设置');
    evidence.layout = await c.eval(`(()=>{const p=document.getElementById('company-attendance-page');const r=s=>{const e=p.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.top),Math.round(b.height)]};return {pageTop:p.style.top,pageScroll:p.scrollTop,head:r('.att-head'),panel:r('.att-panel'),scroll:r('.att-scroll'),scrollTop:p.querySelector('.att-scroll').scrollTop}})()`);
    evidence.fonts = await c.eval(`(()=>{const s={};for(const e of document.querySelectorAll('#company-attendance-page *')){if(!e.offsetParent)continue;const own=[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());if(!own)continue;const f=parseFloat(getComputedStyle(e).fontSize);s[f]=(s[f]||0)+1}return s})()`);
    evidence.overflowX = await c.eval(`(()=>{const p=document.querySelector('#company-attendance-page .att-scroll');return p.scrollWidth>p.clientWidth})()`);
  } catch (error) { evidence.error = error.message; }
  finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    srv.close();
  }
  console.log(JSON.stringify({ out, error: evidence.error || null, sync: evidence.sync, rendererErrors: evidence.rendererErrors.length, overflowX: evidence.overflowX }));
  if (evidence.error) process.exitCode = 1;
}
run();
