'use strict';

// 昨日之我默认「我的提问 + 最近 7 天」走常驻内存（2026-11-05）。真实隔离 Hub + 真实 SQLite 子进程 +
// 真实鼠标/键盘输入，不调用 AI。验收：默认范围、打字到出结果的耗时、AI 回答与 7 天前的提问
// 默认不出现、「扩大」一次性生效、用户改过的范围与时间被记住。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const net = require('node:net');
// 公司版没有 usage-refresh-fixture，这里就地取一个空闲端口。
const getFreePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const ROOT = path.resolve(__dirname, '..');
// 证据目录可用 HUB_E2E_ARTIFACTS_DIR 指到仓库外（截图、耗时、日志）。
const OUT = process.env.HUB_E2E_ARTIFACTS_DIR || path.join(ROOT, 'artifacts', 'yesterday-fast-default');
const DAY = 24 * 60 * 60 * 1000;

function writeTranscript(root, name, rows) {
  const file = path.join(root, 'project', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-yesterday-fast-'));
  const dataDir = path.join(temp, 'data');
  const roots = ['claude', 'codex', 'kimi', 'gemini'].map(name => path.join(temp, name));
  roots.forEach(root => fs.mkdirSync(root));
  const now = Date.now();
  const iso = at => new Date(at).toISOString();
  writeTranscript(roots[0], 'recent', [
    { type: 'user', uuid: 'u1', sessionId: 'recent', cwd: temp, timestamp: iso(now - 2 * DAY), message: { role: 'user', content: 'FASTMARK 帮我看看仿真配置' } },
    { type: 'assistant', uuid: 'a1', sessionId: 'recent', cwd: temp, timestamp: iso(now - 2 * DAY + 5000), message: { role: 'assistant', content: [{ type: 'text', text: 'ASSISTONLY 这是 AI 的回答' }] } },
  ]);
  writeTranscript(roots[0], 'old', [
    { type: 'user', uuid: 'u2', sessionId: 'old', cwd: temp, timestamp: iso(now - 20 * DAY), message: { role: 'user', content: 'OLDMARK 二十天前的提问' } },
    { type: 'assistant', uuid: 'a2', sessionId: 'old', cwd: temp, timestamp: iso(now - 20 * DAY + 5000), message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },
  ]);
  const result = { scope: 'Real isolated Hub + real SQLite child + CDP mouse/keyboard; no AI calls', temp, checks: [], timings: {} };
  let hub, client;
  const invoke = (name, request) => client.eval(`ipcRenderer.invoke(${JSON.stringify(name)}, ${JSON.stringify(request)})`);
  const until = async (label, fn, budget = 30000) => {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await _waitMs(50); }
    throw new Error(`Timeout: ${label}`);
  };
  // 像人一样点：等目标停稳（两次取样位置一致）且该点命中目标本身，再按下鼠标。
  // 关闭工作台后工具栏有收展动画，过早点击会落在别的元素上。
  const click = async selector => {
    let last = null;
    const point = await until(`stable ${selector}`, async () => {
      const p = await client.eval(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); if(!r.width||!r.height) return null;
        const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y); return el.contains(hit)?{x,y,w:r.width}:null; })()`);
      const stable = p && last && p.x === last.x && p.y === last.y && p.w === last.w;
      last = p; return stable ? p : null;
    }, 10000);
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const state = () => client.eval(`({
    scope: document.querySelector('#session-search-scope-tabs [data-scope].active')?.dataset.scope,
    time: document.querySelector('#session-search-time')?.value,
    summary: document.querySelector('#session-search-result-summary')?.textContent || '',
    results: document.querySelector('#search-results')?.textContent || '',
    widenVisible: !!document.querySelector('#session-search-widen') && !document.querySelector('#session-search-widen').hidden,
  })`);
  // 清空输入框后用真实键入写入查询，并在页面内计时：从键入到结果区出现目标文字。
  const typeAndTime = async (text, expect) => {
    await client.eval(`(() => { const q=document.querySelector('#search-query'); q.focus(); q.select(); })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await client.eval(`window.__fastProbe={start:performance.now(),hit:null};`);
    await client.send('Input.insertText', { text });
    return until(`results for ${text}`, () => client.eval(`(() => {
      const box=document.querySelector('#search-results'); const summary=document.querySelector('#session-search-result-summary').textContent;
      const ok=${expect ? `box.textContent.includes(${JSON.stringify(expect)})` : `/当前条件下没有匹配/.test(box.textContent) && !/继续检索/.test(summary)`};
      return ok ? Math.round(performance.now()-__fastProbe.start) : null; })()`));
  };
  // 真实关闭：点工作台的关闭按钮（没有就走同一个 close 入口），确认页面真的收起后再重新打开。
  const closeHistory = async () => {
    const hasClose = await client.eval(`(() => { const b=[...document.querySelectorAll('[data-hw-close]')].find(el=>el.getBoundingClientRect().width>0); return !!b; })()`);
    if (hasClose) await click('[data-hw-close]'); else await client.eval('window.hubWorkspaces.close()');
    await until('history closed', () => client.eval('!window.hubWorkspaces.isOpen()'));
    result.afterClose = await client.eval(`(() => { const b=document.querySelector('#btn-global-search'); const r=b?.getBoundingClientRect(); const hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {rect:r&&{x:r.x,y:r.y,w:r.width,h:r.height},hit:hit&&(hit.id||hit.className||hit.tagName),inside:!!(hit&&b.contains(hit))}; })()`);
  };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await getFreePort(), windowMode: 'hidden', extraEnv: {
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: roots[0], HUB_SESSION_SEARCH_CODEX_ROOTS: roots[1],
      HUB_SESSION_SEARCH_KIMI_ROOTS: roots[2], HUB_SESSION_SEARCH_GEMINI_ROOTS: roots[3],
    } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer', () => client.eval('!!window.__hubE2E?.globalSessionSearch'));
    await until('fixtures indexed', async () => (await invoke('search-past-sessions', { query: 'OLDMARK', scopes: ['user'] })).totalSessions === 1
      && (await invoke('search-past-sessions', { query: 'FASTMARK', scopes: ['user'] })).totalSessions === 1, 60000);

    await click('#btn-global-search');
    await until('history UI', () => client.eval('document.querySelector("#search-query")?.getBoundingClientRect().width > 0'));
    let s = await until('default state rendered', async () => { const v = await state(); return /范围/.test(v.summary) ? v : null; });
    result.defaultState = s;
    assert.equal(s.scope, 'user'); assert.equal(s.time, '7d');
    assert.match(s.summary, /范围：我的提问 · 最近 7 天/); assert.equal(s.widenVisible, true);
    result.checks.push('First open defaults to 我的提问 + 最近 7 天 and shows the scope in the summary line');

    const backend = await invoke('search-past-sessions', { query: 'FASTMARK', scopes: ['user'], timeRange: '7d' });
    assert.equal(backend.searchPath, 'memory');
    result.checks.push('Backend answers the default scope from the resident in-memory path');

    result.timings.typeToResultMs = [];
    for (let i = 0; i < 5; i++) result.timings.typeToResultMs.push(await typeAndTime(i % 2 ? '仿真配置' : 'FASTMARK', 'FASTMARK'));
    result.checks.push('Typing a word shows the matching question (key-in → visible, in page)');
    fs.writeFileSync(path.join(OUT, 'default-results.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const ipcSamples = [];
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await invoke('search-past-sessions', { query: i % 2 ? '仿真' : 'FASTMARK', scopes: ['user'], timeRange: '7d', limit: 50 }); ipcSamples.push(Date.now() - t0); }
    result.timings.ipcRoundTripMs = ipcSamples;

    await typeAndTime('ASSISTONLY', null);
    await typeAndTime('OLDMARK', null);
    result.checks.push('By default an AI-only phrase and a 20-day-old question are not returned');

    await click('#session-search-widen');
    const widened = await until('widened result', async () => { const v = await state(); return v.results.includes('OLDMARK') ? v : null; });
    assert.equal(widened.scope, 'dialogue'); assert.equal(widened.time, 'all');
    result.checks.push('「扩大到全部时间与 AI 回答」 finds the old question in one click');
    fs.writeFileSync(path.join(OUT, 'widened.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

    await closeHistory();
    await click('#btn-global-search');
    s = await until('reopened state', async () => { const v = await state(); return v.scope === 'user' && v.time === '7d' ? v : null; }, 5000)
      .catch(async error => { result.reopenDiag = { state: await state(), stored: await client.eval(`({scope:localStorage.getItem('hub.search.scope'),time:localStorage.getItem('hub.search.timeRange'),open:window.hubWorkspaces.isOpen()})`) }; throw error; });
    assert.equal(s.scope, 'user'); assert.equal(s.time, '7d');
    result.checks.push('Widening is one-off: reopening returns to 我的提问 + 最近 7 天');

    if (await client.eval(`document.querySelector('#session-search-advanced').hidden`)) await click('#session-search-filter-toggle');
    await click('#session-search-scope-tabs [data-scope="assistant"]');
    await client.eval(`(() => { const t=document.querySelector('#session-search-time'); t.value='3d'; t.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await closeHistory();
    await click('#btn-global-search');
    s = await until('remembered state', async () => { const v = await state(); return /范围/.test(v.summary) ? v : null; });
    assert.equal(s.scope, 'assistant'); assert.equal(s.time, '3d');
    result.checks.push('A scope/time the user picked is remembered on the next open');
    fs.writeFileSync(path.join(OUT, 'remembered.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    result.passed = true;
  } catch (error) { result.error = error.stack; throw error; }
  finally {
    if (client) await client.close().catch(() => {});
    if (hub) { fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n'), 'utf8'); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ passed: result.passed || false, checks: result.checks, timings: result.timings, reopenDiag: result.reopenDiag, afterClose: result.afterClose, error: result.error, evidence: path.join(OUT, 'result.json') }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
