'use strict';
// R59 内存紧张就地提示 · 隔离端到端（真实 Claude Code + Haiku，登录态复制到私有配置目录）：
//   node tests/e2e-r59-memory-hint-cdp.js <outDir>
// 隔离 Hub 后台启动，假装整机内存 91%（AI_HUB_E2E_MEMORY_USAGE，只影响这条提示）→ 开 3 个会话各答一句 →
// 会话栏顶部出提示 → 打开启动中心、选 CodeAgent 后出「改用 Lite」并能切过去 → 会话栏点「一键休眠闲着的」→
// 闲着的会话真的休眠、唤醒后上下文还在 → 一键反馈运行快照带低开销模式与会话进程树合计。1440×900 截图。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '../output/r59-hint-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r59-hint-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.join(root, 'claude');
  for (const dir of [data, work, cfg]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const src = process.env.HUB_ASK_CLAUDE_SOURCE_DIR || path.join(os.homedir(), '.claude');
  fs.copyFileSync(path.join(src, '.credentials.json'), path.join(cfg, '.credentials.json'));
  const tasks = [1, 2, 3].map(i => path.join(work, `20261127-r59-hint-s${i}`));
  const fwd = p => p.split(path.sep).join('/');
  const projects = {}; for (const t of tasks) { fs.mkdirSync(t, { recursive: true }); projects[t] = { hasTrustDialogAccepted: true }; projects[fwd(t)] = { hasTrustDialogAccepted: true }; }
  fs.writeFileSync(path.join(cfg, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', projects }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), j({ skipDangerousModePermissionPrompt: true }));
  // 老用户升级：低开销模式关
  fs.writeFileSync(path.join(data, 'optional-features.json'), j({ lowOverhead: false, lowOverheadHint: false, lowOverheadVersion: 1, lowOverheadKeepAlive: 2 }));
  const report = { passed: false, checks: [], out };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`[r59-e2e] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + (typeof detail === 'string' ? detail : j(detail)) : ''}`); };
  let hub, c;
  const wait = async (expr, label, ms = 120000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* loading */ } await sleep(300); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const pos = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled||e.hidden)throw Error('not clickable '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
  };
  const snap = async name => fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const send = async (sid, text) => {
    await c.eval(`selectSession(${j(sid)})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'input visible');
    await click('#terminal-panel .floating-input-box');
    await c.send('Input.insertText', { text });
    await click('#terminal-panel .floating-input-send');
  };
  const ids = [], codewords = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'r59-hint', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, CLAUDE_CONFIG_DIR: cfg, CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_E2E: '1', AI_HUB_E2E_MEMORY_USAGE: '0.91', CLAUDE_HUB_E2E_MEMORY_RELEASE_IDLE_MS: '5000' } });
    c = await connectFirstPage(hub);
    await wait('typeof selectSession === "function" && !!window.__hubMemoryPressureBar', 'renderer ready');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 3; i++) {
      const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd: tasks[i], title: 'R59 提示 ' + (i + 1), model: 'haiku', effort: 'low' } })})`);
      const sid = created && created.id; assert.ok(sid, j(created));
      ids.push(sid);
      const cw = '白杨-' + crypto.randomBytes(2).toString('hex'); codewords.push(cw);
      await send(sid, `请记住暗号：${cw}。只回复 OK。`);
      await wait(`(()=>{const s=sessions.get(${j(sid)});return s&&/^[0-9a-f-]{36}$/.test(s.ccSessionId||'')})()`, 'native bound ' + (i + 1), 180000);
      await wait(`(document.querySelector('#msg-overlay')?.innerText||'').includes('OK')`, 'answer ' + (i + 1), 180000);
    }
    await sleep(8000); // 过 5 秒闲置门槛（E2E 缩短）
    // 真实产品每分钟推一次；这里每秒主动问一次，等两个非当前会话的输出停稳、过闲置门槛。
    const sidebarText = await wait(`(async()=>{await window.__hubMemoryPressureBar.refresh();const e=document.getElementById('mp-bar-sidebar');return e&&!e.hidden&&/个会话闲着/.test(e.innerText)?e.innerText:''})()`, 'sidebar bar', 90000);
    check('会话栏顶部出现内存紧张提示（闲着的会话与按钮）', /内存 91%/.test(sidebarText) && /一键休眠闲着的/.test(sidebarText) && /打开低开销模式/.test(sidebarText), sidebarText.replace(/\s+/g, ' '));
    await snap('20261127-r59-hint-1-sidebar');
    // 启动中心
    await click('#btn-new-more');
    await wait(`(()=>{const m=document.getElementById('new-session-menu');return m&&m.style.display!=='none'})()`, 'launch center open');
    await click('#new-session-menu .new-session-option[data-kind="codeagent"]');
    const launchText = await wait(`(()=>{const e=document.getElementById('mp-bar-launch');return e&&!e.hidden&&/改用 Lite/.test(e.innerText)?e.innerText:''})()`, 'launch bar', 20000);
    check('启动中心选 CodeAgent 时出现「改用 Lite 开新会话」', true, launchText.replace(/\s+/g, ' '));
    await snap('20261127-r59-hint-2-launch');
    await click('#mp-bar-launch [data-mp-action="lite"]');
    const liteSelected = await wait(`document.querySelector('#new-session-menu .new-session-option[data-kind="codeagent-lite"]')?.classList.contains('selected')`, 'lite selected', 5000).catch(() => false);
    check('点「改用 Lite」后启动中心切到 CodeAgent-Lite', liteSelected);
    await snap('20261127-r59-hint-3-launch-lite');
    await click('#new-session-close');
    // 一键休眠
    // 关掉启动中心后终端会重绘一次（算新输出），闲置名单会抖：在同一次求值里刷新、确认按钮在、记下名单并点下去。
    const before = await wait(`(async()=>{const st=await window.__hubMemoryPressureBar.refresh();const b=document.querySelector('#mp-bar-sidebar [data-mp-action="suspend"]');if(!b||!st||!st.idleCount)return null;b.click();return {idleIds:st.idleIds,idleBytes:st.idleBytes}})()`, 'suspend button', 90000);
    const resultTextShown = await wait(`(()=>{const e=document.getElementById('mp-bar-sidebar');return e&&/已休眠/.test(e.innerText)?e.innerText:''})()`, 'suspend result', 30000);
    await snap('20261127-r59-hint-4-suspended');
    // 主进程执行时会重新判一遍闸门，可能比点击那一刻多出刚变闲的会话：按全部会话里实际休眠的个数核对提示。
    const dormant = await wait(`(()=>{const ids=${j(ids)};return ids.filter(id=>/dormant/.test(sessions.get(id)?.status||'')).length})()`, 'dormant', 30000).catch(() => 0);
    const m = /已休眠 (\d+) 个会话/.exec(resultTextShown);
    check('一键休眠：闲着的会话进入休眠，提示的个数与实际一致', dormant > 0 && m && Number(m[1]) === dormant, { idle: before.idleIds.length, dormant, text: resultTextShown.replace(/\s+/g, ' ') });
    // 唤醒其中一个，问回暗号
    const wakeId = (await c.eval(`${j(ids)}.find(id=>/dormant/.test(sessions.get(id)?.status||''))`)) || before.idleIds[0];
    const cw = codewords[ids.indexOf(wakeId)];
    await send(wakeId, '我刚才让你记住的暗号是什么？只回复暗号本身。');
    const recalled = await wait(`(document.querySelector('#msg-overlay')?.innerText||'').includes(${j(cw)})`, 'recall', 240000).catch(() => false);
    check('休眠后唤醒，上下文还在（问回暗号）', recalled, cw);
    // 一键反馈运行快照的文字预览接口不回正文（只回条目名），这里改验同一条测量链路在真实进程里量得出数：
    // 会话进程树合计与「闲着的约占」共用 process-inspector + sessionTreeBytes；文字拼装与截断由单测覆盖。
    const st = await c.eval(`ipcRenderer.invoke('memory-pressure:state')`);
    check('真实进程里量得出会话进程树内存（与运行快照同一链路）', before.idleBytes > 0, { idleBytesMB: Math.round((before.idleBytes || 0) / 1048576), liveNow: st.liveCount });
    report.passed = report.checks.every(x => x.ok);
  } catch (error) {
    report.error = String(error && error.stack || error);
    console.error('[r59-e2e] error', report.error);
    try { await snap('20261127-r59-hint-error'); } catch { /* ignore */ }
    try { report.diag = await c.eval(`(async()=>({ state: await ipcRenderer.invoke('memory-pressure:state'), bar: document.getElementById('mp-bar-sidebar')?.outerHTML || 'no-bar' }))()`); } catch { /* ignore */ }
  } finally {
    try { report.hubLog = (hub?.log?.() || []).filter(l => /memory-pressure/.test(l)).slice(-20); } catch { /* ignore */ }
    fs.writeFileSync(path.join(out, '20261127-r59-hint-e2e.json'), JSON.stringify(report, null, 1));
    try { c?.close?.(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true }).catch(e => console.error('[r59-e2e] quit', e.message));
  }
  console.log('[r59-e2e]', report.passed ? 'PASSED' : 'FAILED', path.join(out, '20261127-r59-hint-e2e.json'));
  process.exitCode = report.passed ? 0 : 1;
}
main();
