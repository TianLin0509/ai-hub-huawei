'use strict';
//   1) 考勤地址解析不到（ERR_NAME_NOT_RESOLVED）→ 空状态说清「没连内网或域名不对」，就地给改域名的输入框；
//   2) 已有记录时同样在顶部提示并给输入框；周日 09:06–18:08 在账本里记 7h32（扣午休、晚饭），与公司考勤系统 7.53 小时一致；
//   3) 每天卡片显示扣除后的净加班（可为负），和账本、月合计一致。
// 用法：node tests/e2e-attendance-rest-dns-cdp.js [--out <目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
function ok(label, condition, detail = '') { assert(!!condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : process.env.HUB_E2E_ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'att-rest-art-')));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-att-rest-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false, attendance: true }));
  const bad = 'https://hr.unresolvable-host.invalid';
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'attendance-rest-dns', extraArgs: ['--no-proxy-server'], extraEnv: {
      CLAUDE_HUB_COMPANY_ATTENDANCE: '1', CLAUDE_HUB_ATTENDANCE_TIMER: '0', CLAUDE_HUB_ATTENDANCE_EDGE: '0',
      CLAUDE_HUB_ATTENDANCE_URL: `${bad}/apps/attendanceflow/#/myAttendance`, CLAUDE_HUB_SERVICETIME_URL: `${bad}/apps/servicetimeflow/#/myServicetime`,
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expr, label, timeout = 30000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* */ } await sleep(200); } throw Error('Timeout ' + label); };
    const shot = async name => { await sleep(600); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
    const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
    const P = '#company-attendance-page';

    await wait(`!!document.getElementById('btn-company-attendance')`, 'nav button');
    // 1) 空状态：地址解析不到。
    let st = await c.eval(`ipcRenderer.invoke('company-attendance:sync')`);
    ok('解析失败标 dnsFail，错误说清两种可能', st.lastResult && st.lastResult.dnsFail && /解析不到.*内网.*域名不对/.test(st.lastResult.error) && !/ERR_NAME/.test(st.lastResult.error), st.lastResult?.error);
    await click('#btn-company-attendance');
    await wait(`(()=>{const p=document.querySelector('${P}');return p&&!p.hidden&&!!p.querySelector('[data-att="quick-domain"]')})()`, 'inline domain input');
    // 打开考勤页会自动再读一次：等它读完，截到的是失败提示而不是「正在读取」。
    await wait(`(()=>{const p=document.querySelector('${P}');return !!p.querySelector('[data-att="quick-domain"]')&&/解析不到/.test(p.textContent)})()`, 'dns message after auto sync', 60000);
    const pre = await c.eval(`document.querySelector('${P} [data-f="quickDomain"]').value`);
    ok('空状态就地给改域名的输入框，预填当前域名', !!pre, pre);
    await shot('20261120-rsi-d-attendance-dns-empty');

    // 2) 写入记录（含周日 09:06–18:08），再读一次（仍解析失败）：顶部提示 + 账本里周日记 7h32。
    const recs = [['2026-11-15', '09:06', '18:08'], ['2026-11-16', '08:52', '20:31'], ['2026-11-17', '09:10', '19:05'], ['2026-11-18', '08:40', '21:48'], ['2026-11-19', '08:58', '18:20']]
      .map(([date, first, last]) => ({ date, first, last, firstTag: '智', lastTag: '智', fetchedAt: null }));
    fs.writeFileSync(path.join(data, 'company-attendance', 'records.json'), JSON.stringify(recs));
    st = await c.eval(`ipcRenderer.invoke('company-attendance:sync')`);
    await wait(`(()=>{const p=document.querySelector('${P}');return p&&!!p.querySelector('.att-hero')&&!!p.querySelector('.att-alert [data-att="quick-domain"]')})()`, 'hero with dns alert', 60000);
    await shot('20261120-rsi-d-attendance-dns-with-records');
    const cards = await c.eval(`Object.fromEntries([...document.querySelectorAll('${P} .att-day')].map(b=>[b.dataset.date,b.querySelector('.v').textContent]))`);
    ok('每天卡片显示扣除后的净加班：18:20 走的工作日是 −0h08，不是 +0h22', cards['2026-11-19'] === '−0h08' && cards['2026-11-15'] === '+7h32', JSON.stringify(cards));
    await click(`${P} .att-day[data-date="2026-11-15"]`);
    await wait(`!!document.querySelector('${P} .att-dpanel')`, 'drawer');
    await click(`${P} [data-att="view"][data-v="ledger"]`);
    await wait(`!!document.querySelector('${P} .att-ledger')`, 'ledger');
    const row = await c.eval(`(()=>{const r=[...document.querySelectorAll('${P} .att-ledger tr')].find(t=>/11\\/15|11-15|11月15/.test(t.textContent));return r?[...r.children].map(td=>td.textContent.trim()):null})()`);
    ok('周日 09:06–18:08 在岗 9h02、加班 7h32', row && row.includes('9h02') && row.includes('7h32'), JSON.stringify(row));
    await shot('20261120-rsi-d-attendance-rest-ledger');
    await click(`${P} [data-att="close"]`);
    const rules = await c.eval(`(()=>{const d=document.querySelector('${P} .att-rules');if(!d)return '';d.open=true;return d.textContent})()`);
    ok('口径说明写明周末扣午休和晚饭', /扣掉午休 12:30–13:30 和晚饭 17:30–18:00/.test(rules));
    const overflow = await c.eval(`(()=>{const p=document.querySelector('${P} .att-scroll');return p?p.scrollWidth>p.clientWidth:false})()`);
    ok('1440 宽无横向溢出', !overflow);
    console.log('ARTIFACTS ' + out);
  } finally {
    try { c?.close?.(); } catch { /* */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
