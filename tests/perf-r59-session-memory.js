'use strict';
//   node tests/perf-r59-session-memory.js <outDir>
// 隔离 Hub 后台启动 → 依次开到 1/3/6 个会话（每个发一句短话、等它答完）→ 每一档采整棵进程树 →
// 打开低开销模式再采 → 模拟 L1 保活 2 个（休眠最早的 4 个）再采 → 唤醒第 1 个、问回暗号，验证上下文没丢。
// 内存口径：工作集（WorkingSet，近似任务管理器「内存」列）和私有提交（PrivatePageCount），按进程树归类。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const PS = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress';
const psRows = () => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', PS],
  { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => { if (err) return reject(err); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }));
const MB = n => +(Number(n || 0) / 1048576).toFixed(1);

async function sampleTree(rootPid, label) {
  const rows = await psRows();
  const kids = new Map();
  for (const r of rows) { if (r.ProcessId === r.ParentProcessId) continue; if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []); kids.get(r.ParentProcessId).push(r); }
  const subtree = pid => { const out = []; const st = [rows.find(r => r.ProcessId === pid)].filter(Boolean); while (st.length) { const r = st.pop(); out.push(r); for (const c of kids.get(r.ProcessId) || []) st.push(c); } return out; };
  const all = subtree(rootPid);
  const hub = all.filter(r => /^electron\.exe$/i.test(r.Name));
  const hubIds = new Set(hub.map(r => r.ProcessId));
  // 渲染进程：命令行带 --type=renderer
  const renderer = hub.filter(r => /--type=renderer/.test(r.CommandLine || ''));
  const groups = [];
  for (const h of hub) for (const c of kids.get(h.ProcessId) || []) {
    if (hubIds.has(c.ProcessId)) continue;
    const t = subtree(c.ProcessId);
    const names = {}; for (const r of t) names[r.Name] = (names[r.Name] || 0) + 1;
    groups.push({ root: c.Name, pid: c.ProcessId, procs: t.length, wsMB: MB(t.reduce((s, r) => s + Number(r.WorkingSetSize), 0)), pvMB: MB(t.reduce((s, r) => s + Number(r.PrivatePageCount), 0)), names,
      detail: t.map(r => ({ name: r.Name, wsMB: MB(r.WorkingSetSize), pvMB: MB(r.PrivatePageCount), cmd: String(r.CommandLine || '').slice(0, 160) })) });
  }
  const byName = {};
  for (const r of all) { const k = r.Name; byName[k] ||= { n: 0, wsMB: 0, pvMB: 0 }; byName[k].n++; byName[k].wsMB = +(byName[k].wsMB + MB(r.WorkingSetSize)).toFixed(1); byName[k].pvMB = +(byName[k].pvMB + MB(r.PrivatePageCount)).toFixed(1); }
  const sum = (list, key) => MB(list.reduce((s, r) => s + Number(r[key]), 0));
  return { label, at: new Date().toISOString(), totalProcs: all.length, totalWsMB: sum(all, 'WorkingSetSize'), totalPvMB: sum(all, 'PrivatePageCount'),
    hubWsMB: sum(hub, 'WorkingSetSize'), hubPvMB: sum(hub, 'PrivatePageCount'), rendererWsMB: sum(renderer, 'WorkingSetSize'), hubProcs: hub.length,
    sysFreeMB: MB(os.freemem()), byName, groups };
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '../output/r59-mem-' + Date.now()));
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r59-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.join(root, 'claude');
  for (const dir of [data, work, cfg]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const src = process.env.HUB_ASK_CLAUDE_SOURCE_DIR || path.join(os.homedir(), '.claude');
  fs.copyFileSync(path.join(src, '.credentials.json'), path.join(cfg, '.credentials.json'));
  const tasks = Array.from({ length: 6 }, (_, i) => path.join(work, `20261127-r59-s${i + 1}`));
  const fwd = p => p.split(path.sep).join('/');
  const projects = {}; for (const t of tasks) { fs.mkdirSync(t, { recursive: true }); projects[t] = { hasTrustDialogAccepted: true }; projects[fwd(t)] = { hasTrustDialogAccepted: true }; }
  fs.writeFileSync(path.join(cfg, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', projects }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), j({ skipDangerousModePermissionPrompt: true }));
  // 老用户升级路径：低开销模式默认关（反馈的 3 人都是升级上来的）。
  fs.writeFileSync(path.join(data, 'optional-features.json'), j({ lowOverhead: false, lowOverheadHint: false, lowOverheadVersion: 1, lowOverheadKeepAlive: 2 }));
  const report = { outDir, samples: [], checks: [], codewords: [] };
  const save = () => fs.writeFileSync(path.join(outDir, '20261127-r59-mem-samples.json'), JSON.stringify(report, null, 1));
  let hub, c;
  const wait = async (expr, label, ms = 120000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { try { if (await c.eval(expr)) return; } catch { /* loading */ } await sleep(300); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const pos = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled||e.hidden)throw Error('not clickable '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
  };
  const send = async (sid, text) => {
    await c.eval(`selectSession(${j(sid)})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'input visible');
    await click('#terminal-panel .floating-input-box');
    await c.send('Input.insertText', { text });
    await click('#terminal-panel .floating-input-send');
  };
  const sample = async label => { const s = await sampleTree(hub.pid, label); report.samples.push(s); save(); console.log(`[r59] ${label}: procs=${s.totalProcs} WS=${s.totalWsMB}MB PV=${s.totalPvMB}MB hub=${s.hubWsMB}MB renderer=${s.rendererWsMB}MB`); return s; };
  const ids = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'r59-mem', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, CLAUDE_CONFIG_DIR: cfg, CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' } });
    c = await connectFirstPage(hub);
    await wait('typeof selectSession === "function"', 'renderer ready');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(20000);
    await sample('N=0 Hub only');
    for (let i = 0; i < 6; i++) {
      const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd: tasks[i], title: 'R59 会话 ' + (i + 1), model: 'haiku', effort: 'low' } })})`);
      const sid = created && created.id; if (!sid) throw Error('create failed ' + j(created));
      ids.push(sid);
      const codeword = '青松-' + crypto.randomBytes(2).toString('hex');
      report.codewords.push({ sid, codeword });
      await send(sid, `请记住暗号：${codeword}。只回复 OK。`);
      await wait(`(()=>{const s=sessions.get(${j(sid)});return s&&/^[0-9a-f-]{36}$/.test(s.ccSessionId||'')})()`, 'native bound ' + (i + 1), 180000);
      await wait(`(document.querySelector('#msg-overlay')?.innerText||'').includes('OK')`, 'answer ' + (i + 1), 180000);
      if (i === 0 || i === 2 || i === 5) { await sleep(15000); await sample(`N=${i + 1} idle after answer`); }
    }
    // 低开销模式打开（L2–L7 立即生效；L1 要 10 分钟闲置才收，下面单独模拟）
    const lo = await c.eval(`ipcRenderer.invoke('low-overhead:set',{on:true,keepAlive:2})`);
    report.checks.push({ name: 'low-overhead on', ok: !!(lo && lo.ok), detail: lo && lo.message });
    await sleep(75000);
    await sample('N=6 low-overhead on (L1 not yet fired)');
    // 模拟 L1 保活 2 个：休眠最早的 4 个（真实 L1 要等它们闲置满 10 分钟，结果相同）
    await c.eval(`selectSession(${j(ids[5])})`);
    const susp = [];
    for (const sid of ids.slice(0, 4)) susp.push(await c.eval(`ipcRenderer.invoke('suspend-session',${j(sid)})`));
    report.checks.push({ name: 'suspend 4', ok: susp.every(r => r && r.ok), detail: susp.map(r => r && (r.ok ? 'ok' : r.error)) });
    await sleep(20000);
    await sample('N=6 with 4 suspended (keepAlive=2)');
    // 唤醒第 1 个并问回暗号，量唤醒到答出的时间
    const t0 = Date.now();
    await send(ids[0], '我刚才让你记住的暗号是什么？只回复暗号本身。');
    const cw = report.codewords[0].codeword;
    let ok = true;
    try { await wait(`(document.querySelector('#msg-overlay')?.innerText||'').includes(${j(cw)})`, 'recall codeword', 240000); } catch { ok = false; }
    report.checks.push({ name: 'wake session 1 keeps context', ok, wakeToAnswerSec: +((Date.now() - t0) / 1000).toFixed(1), codeword: cw });
    await sleep(15000);
    await sample('after waking session 1');
    try { fs.writeFileSync(path.join(outDir, '20261127-r59-after-wake.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* 截图失败不影响数据 */ }
  } catch (error) {
    report.error = String(error && error.stack || error);
    console.error('[r59] error', report.error);
  } finally {
    save();
    try { c?.close?.(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true }).catch(e => console.error('[r59] quit', e.message));
  }
  console.log('[r59] report', path.join(outDir, '20261127-r59-mem-samples.json'));
}
main();
