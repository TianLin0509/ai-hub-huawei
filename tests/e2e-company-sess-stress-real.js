'use strict';
// 真机压测：会话与低开销模式（2026-11-28）。在装有公司 CodeAgent 的电脑上，用真实 CLI 和个人账号副本跑隔离 Hub：
//   --case mem   原生（PTY）与 CodeAgent-Lite（共享 serve）各开 N 个会话，量进程树工作集与私有内存；
//   --case flow  前台卡片回答 → 切后台看真终端 → 后台再问 → 切回前台；长回答中途停止；Hub 重启后历史还在。
// 隔离数据目录、隐藏窗口；个人账号配置复制进临时目录使用，真实 ~/.cac 只读（结束时核对哈希）。
//   <Hub 程序> 以 ELECTRON_RUN_AS_NODE=1 运行：
//   node tests/e2e-company-sess-stress-real.js --exe <AI Hub Community.exe> --case mem --mode pty|lite --ns 1,3,5 [--warm] [--port 19600]
//   node tests/e2e-company-sess-stress-real.js --exe <AI Hub Community.exe> --case flow --kind codeagent|codeagent-lite [--port 19601]
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

delete process.env.ELECTRON_RUN_AS_NODE; // 本脚本借 Hub 程序当 Node 跑，拉起的 Hub 不能继承
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = name => argv.includes(name);
const exe = arg('--exe');
const caseName = arg('--case', 'mem');
const port = Number(arg('--port', '19600'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubsess-' + caseName + '-'));
if (arg('--root-file')) fs.writeFileSync(arg('--root-file'), root);
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const READY = /Anything I can assist you with|bypass permissions on \(/;
const out = path.join(root, 'out'), cac = path.join(root, 'cac'), dataDir = path.join(root, 'data'), work = path.join(root, 'work');
const report = { case: caseName, argv, startedAt: new Date().toISOString(), root, exe, checks: [], screenshots: [], timeline: [], passed: false };
const t0 = Date.now();
const save = () => { try { fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1)); } catch {} };
const log = (msg, extra) => { const line = { s: Math.round((Date.now() - t0) / 1000), msg, ...(extra !== undefined ? { extra } : {}) }; report.timeline.push(line); console.log(j(line)); save(); };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); log((ok ? '通过 ' : '失败 ') + name, detail); return !!ok; };
let hub, c;
const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return true; await sleep(500); } throw Error('超时：' + label); };
const shot = async name => {
  const s = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  const file = path.join(out, name + '.jpg'); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); report.screenshots.push(file); log('截图 ' + name);
};
const click = async selector => {
  const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('找不到 '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const ipc = (channel, args) => c.eval(`require('electron').ipcRenderer.invoke(${j(channel)}, ${j(args)})`);
const screenText = async sid => String(await ipc('debug:get-session-buffer', sid).catch(() => '') || '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
const overlayText = () => c.eval(`(document.querySelector('#msg-overlay')?.innerText || '')`).catch(() => '');

function prepare() {
  for (const d of [out, cac, dataDir, work]) fs.mkdirSync(d, { recursive: true });
  const real = path.join(os.homedir(), '.cac');
  report.realCacSettingsHash = hash(path.join(real, 'settings.json'));
  report.realCacCredHash = hash(path.join(real, '.credentials.json'));
  for (const name of fs.readdirSync(real)) {
    const src = path.join(real, name);
    if (!fs.statSync(src).isFile()) continue;
    if (/^history\.jsonl$|\.log$|\.bak|hub-backup|\.(cjs|html)$|^build-asar/i.test(name)) continue;
    if (fs.statSync(src).size > 2 * 1024 * 1024) continue;
    fs.copyFileSync(src, path.join(cac, name));
  }
}

// ---------- 进程与内存 ----------
function processTable() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,CreationDate,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  return JSON.parse(raw).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, ws: Number(p.WorkingSetSize) || 0, priv: Number(p.PrivatePageCount) || 0, cmd: p.CommandLine || '', created: Number((/\d+/.exec(String(p.CreationDate || '')) || [0])[0]) }));
}
let baselinePids = new Set();
// 口径：Hub 主进程起算的整棵进程树（含 Electron 自身、PTY 外壳、CodeAgent CLI/serve 及其子进程），
// 另加「脱离父进程、但命令行里带本次测试根目录或测试账号目录」的新进程（serve 收不到的 bun / MCP 子进程）。
function measure(label) {
  const table = processTable();
  const byParent = new Map();
  for (const p of table) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  const tree = []; const seen = new Set(); const stack = [hub.pid];
  // 防 PID 复用：子进程必须比父进程晚创建，否则是别人家的进程碰巧挂在一个被复用的号码下（memLite2 曾把另一套 Hub 算进来）。
  const createdOf = new Map(table.map(p => [p.pid, p.created]));
  while (stack.length) { const pid = stack.pop(); for (const k of byParent.get(pid) || []) { if (seen.has(k.pid)) continue; if (k.created && createdOf.get(pid) && k.created < createdOf.get(pid)) continue; seen.add(k.pid); tree.push(k); stack.push(k.pid); } }
  const self = table.find(p => p.pid === hub.pid); if (self) tree.unshift(self);
  const rootLower = root.toLowerCase();
  const orphans = table.filter(p => !seen.has(p.pid) && p.pid !== hub.pid && !baselinePids.has(p.pid) && p.cmd.toLowerCase().includes(rootLower));
  const isHub = p => /^AI Hub Community\.exe$/i.test(p.name);
  const sum = (list, key) => Math.round(list.reduce((a, p) => a + p[key], 0) / 1048576);
  const agents = [...tree.filter(p => !isHub(p)), ...orphans];
  const m = {
    label, at: Math.round((Date.now() - t0) / 1000),
    totalWsMB: sum([...tree, ...orphans], 'ws'), totalPrivMB: sum([...tree, ...orphans], 'priv'),
    hubWsMB: sum(tree.filter(isHub), 'ws'), hubPrivMB: sum(tree.filter(isHub), 'priv'),
    agentWsMB: sum(agents, 'ws'), agentPrivMB: sum(agents, 'priv'),
    count: tree.length + orphans.length, orphanCount: orphans.length,
    byName: Object.entries([...tree, ...orphans].reduce((a, p) => { const k = p.name; a[k] = a[k] || { n: 0, wsMB: 0 }; a[k].n++; a[k].wsMB += p.ws / 1048576; return a; }, {})).map(([k, v]) => ({ name: k, n: v.n, wsMB: Math.round(v.wsMB) })),
  };
  log('内存 ' + label, m);
  (report.memory ||= []).push(m);
  return m;
}

// ---------- 建会话（真实点击启动中心） ----------
async function createSession(kind) {
  const before = new Set(await c.eval('[...sessions.keys()]'));
  await c.eval('window.WorkspaceController?.openNewSessionModal?.({})');
  await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话表单', 30000);
  await sleep(600);
  await until(`!!document.querySelector('.new-session-option[data-kind="${kind}"]')`, '框架按钮 ' + kind, 20000);
  await click(`.new-session-option[data-kind="${kind}"]`);
  await sleep(500);
  const pressed = await c.eval(`document.querySelector('.new-session-option[data-kind="${kind}"]')?.getAttribute('aria-pressed')`);
  await click('#new-session-submit');
  const t = Date.now(); let sid = null; let switched = null;
  while (!sid && Date.now() - t < 240000) {
    sid = (await c.eval('[...sessions.keys()]')).find(id => !before.has(id));
    if (!sid) {
      const confirm = await c.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0);
        if (!b) return null; b.setAttribute('data-e2e-switch', '1'); const box = b.closest('[role=dialog], .modal, .dialog, section, div');
        return (box?.parentElement?.innerText || box?.innerText || '').replace(/\\s+/g, ' ').slice(0, 500); })()`).catch(() => null);
      if (confirm) { switched = confirm; log('模型确认弹窗', confirm); if (!report.modelSwitchShot) { report.modelSwitchShot = true; await shot('model-confirm'); } await click('[data-e2e-switch="1"]'); }
      await sleep(1000);
    }
  }
  const ms = Date.now() - t;
  if (!sid) {
    const ui = await c.eval(`(() => { const vis = e => e && e.getBoundingClientRect().width > 0; return { modal: [...document.querySelectorAll('.modal, [role=dialog], #new-session-modal')].filter(vis).map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 800)),
      alerts: [...document.querySelectorAll('[role=alert], .toast, .error, .new-session-error')].filter(vis).map(e => e.innerText.trim()).slice(0, 8) }; })()`).catch(e => String(e));
    throw Object.assign(Error('会话没建出：' + kind), { ui });
  }
  const info = await c.eval(`(() => { const s = sessions.get(${j(sid)}); return s && { kind: s.kind, runMode: s.codeagentRunMode || null, runtimeBackend: s.runtimeBackend || null, model: s.model || s.launchModel || null }; })()`);
  log('会话建出 ' + kind, { sid, ms, pressed, info, switched: !!switched });
  return { sid, ms, info };
}
// --send-delay-s：就绪后再等几秒才发第一句（区分「用户就绪后立刻打字」与「等启动选模型做完」两种情形）。
const sendDelayMs = Number(arg('--send-delay-s', '0')) * 1000;
async function waitPtyReady(sid, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (READY.test(await screenText(sid))) { if (sendDelayMs) await sleep(sendDelayMs); return true; } await sleep(1500); }
  return false;
}
// --no-view-switch：像用户一样直接在当前界面的输入框里打字，不额外切会话/切卡片视图（切视图会让终端改尺寸、CLI 整屏重画）。
const noViewSwitch = flag('--no-view-switch');
// keepView：保持当前视图（例如停在「后台」真终端时直接在输入条里发），不切会话、不切卡片。
async function sendText(sid, text, { keepView = false } = {}) {
  const stay = keepView || noViewSwitch;
  if (!stay || !(await c.eval(`activeSessionId === ${j(sid)}`).catch(() => false))) { await c.eval(`selectSession(${j(sid)})`); await sleep(600); }
  if (!stay) await c.eval(`typeof applyViewMode === 'function' && applyViewMode('card')`).catch(() => {});
  const box = `.floating-input-bar[data-session-id="${sid}"] .floating-input-box`;
  await until(`!!document.querySelector(${j(box)})`, '输入框', 30000);
  await click(box);
  await c.send('Input.insertText', { text });
  await sleep(300);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function waitOverlay(sid, re, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await c.eval(`activeSessionId === ${j(sid)} || selectSession(${j(sid)})`).catch(() => {}); if (re.test(await overlayText())) return true; await sleep(1500); }
  // 没等到：记下界面提示与终端尾部，便于定位（不含截图）。
  const alerts = await c.eval(`[...document.querySelectorAll('[role=alert], .toast, .error')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText.trim()).slice(0, 5)`).catch(() => []);
  log('没等到回答', { alerts, screenTail: (await screenText(sid)).replace(/[ \t]+\n/g, '\n').slice(-600) });
  return false;
}

async function bootHub(tag) {
  hub = await launchIsolatedHub({ dataDir, port, windowMode: 'background', label: 'sess ' + tag, executablePath: exe,
    entryPath: path.resolve(__dirname, '..'), cwd: path.dirname(exe), extraEnv: {
      AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_WORKSPACE_ROOT: work,
      AI_HUB_UPDATE_SOURCES: j([{ id: 'none', name: '测试不更新', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/v{version}/' }]), DEEPSEEK_API_KEY: '' } });
  report.pids = [...(report.pids || []), hub.pid];
  c = null;
  for (let i = 0; !c; i++) {
    try { c = await connectFirstPage(hub, target => /index\.html/.test(target.url), { waitMainMs: 15000 }); }
    catch (error) { if (i >= 8) throw error; await sleep(3000); }
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('typeof sessions !== "undefined" && typeof selectSession === "function" && !!window.WorkspaceController?.openNewSessionModal', '界面加载', 120000);
  report.hubVersion = await c.eval(`require('../package.json').version`).catch(() => null);
  log('Hub 起来了 ' + tag, { pid: hub.pid, version: report.hubVersion });
  await sleep(3000);
}

// ---------- 用例 ----------
async function caseMem() {
  const mode = arg('--mode', 'pty');
  const kind = mode === 'lite' ? 'codeagent-lite' : 'codeagent';
  const ns = String(arg('--ns', '1,3,5')).split(',').map(Number);
  const warm = flag('--warm');
  const settle = Number(arg('--settle-s', '60')) * 1000;
  report.mode = mode; report.ns = ns; report.warm = warm;
  baselinePids = new Set(processTable().map(p => p.pid));
  await bootHub(mode);
  await sleep(20000);
  measure('N=0');
  const sids = [];
  for (const n of ns) {
    while (sids.length < n) {
      const { sid, info } = await createSession(kind);
      sids.push(sid);
      if (sids.length === 1) check('会话运行方式符合 ' + mode, mode === 'lite' ? info.runMode === 'serve' : info.runMode !== 'serve', info);
      if (mode === 'pty') check('PTY 会话就绪 #' + sids.length, await waitPtyReady(sid));
      if (warm) {
        await sendText(sid, '请只回复 7 乘以 6 的结果数字，不要任何其它内容');
        check('回答出来 #' + sids.length, await waitOverlay(sid, /(^|\D)42(\D|$)/, 180000));
      }
    }
    if (n === ns[0]) await shot('mem-' + mode + '-n' + n);
    await sleep(settle);
    const a = measure('N=' + n + ' a');
    await sleep(15000);
    const b = measure('N=' + n + ' b');
    (report.memSummary ||= []).push({ n, totalWsMB: Math.round((a.totalWsMB + b.totalWsMB) / 2), agentWsMB: Math.round((a.agentWsMB + b.agentWsMB) / 2),
      totalPrivMB: Math.round((a.totalPrivMB + b.totalPrivMB) / 2), agentPrivMB: Math.round((a.agentPrivMB + b.agentPrivMB) / 2) });
  }
  await shot('mem-' + mode + '-final');
  report.passed = report.checks.every(x => x.ok);
}

async function caseFlow() {
  const kind = arg('--kind', 'codeagent');
  await bootHub(kind);
  const { sid, info } = await createSession(kind);
  report.sid = sid; report.info = info;
  if (info.runMode !== 'serve') check('PTY 就绪', await waitPtyReady(sid));
  // ① 前台卡片回答
  let t = Date.now();
  await sendText(sid, '请只回复 7 乘以 6 的结果数字，不要任何其它内容');
  check('① 前台卡片出回答', await waitOverlay(sid, /(^|\D)42(\D|$)/), { ms: Date.now() - t });
  await shot('flow-1-card');
  // ② 切后台看真终端
  await until('!!document.querySelector("#btn-backstage") && !document.querySelector("#btn-backstage").hidden', '后台按钮', 20000).catch(() => {});
  const hasBtn = await c.eval('(() => { const b = document.querySelector("#btn-backstage"); return !!b && !b.hidden && b.getBoundingClientRect().width > 0; })()');
  check('② 有「后台」按钮', hasBtn);
  if (hasBtn) {
    t = Date.now();
    // --inject-backstage-broken：故意让「后台」按钮失效（换成没有监听的克隆），用来证明下面的判定会失败。
    if (flag('--inject-backstage-broken')) await c.eval('(() => { const b = document.querySelector("#btn-backstage"); b.replaceWith(b.cloneNode(true)); return true; })()');
    await click('#btn-backstage');
    // 界面真的切到后台：按钮按下、有可见的 xterm；缓冲区里有同一会话内容。都满足才算过。
    const backstageShown = () => c.eval(`(() => { const b = document.querySelector('#btn-backstage'); const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      return b?.getAttribute('aria-pressed') === 'true' && [...document.querySelectorAll('.xterm')].some(vis); })()`).catch(() => false);
    let termOk = false, shown = false, term = '';
    const end = Date.now() + 90000;
    while (Date.now() < end) { shown = await backstageShown(); term = await screenText(sid); if (shown && /42/.test(term) && term.length > 50) { termOk = true; break; } await sleep(1500); }
    check('② 界面切到后台真终端，且是同一会话内容', termOk, { ms: Date.now() - t, shown, tail: term.slice(-300) });
    await sleep(2000);
    await shot('flow-2-backstage');
    // ③ 后台状态下再问一句（输入条仍在）→ 切回前台
    let sentInBackstage = true;
    await sendText(sid, '请只回复 8 乘以 9 的结果数字，不要任何其它内容', { keepView: true }).catch(e => { sentInBackstage = false; log('后台发送失败', String(e)); });
    // 发送后仍停在后台，并在真终端里等到回答
    let termAnswer = false; const endT = Date.now() + 180000;
    while (Date.now() < endT) { if (/(^|\D)72(\D|$)/.test(await screenText(sid))) { termAnswer = true; break; } await sleep(1500); }
    const stillBackstage = await backstageShown();
    check('③ 保持后台状态发送，真终端里出回答', sentInBackstage && termAnswer && stillBackstage, { sentInBackstage, termAnswer, stillBackstage });
    if (await c.eval('document.querySelector("#btn-backstage")?.getAttribute("aria-pressed")') === 'true') await click('#btn-backstage');
    await sleep(1500);
    check('③ 点「后台」后回到卡片', !(await backstageShown()));
    const both = await waitOverlay(sid, /(^|\D)72(\D|$)/, 180000);
    const ov = await overlayText();
    check('③ 切回前台两轮都在', both && /(^|\D)42(\D|$)/.test(ov), { tail: ov.slice(-400) });
    await shot('flow-3-back-card');
  }
  // ④ 长回答中途停止
  await sendText(sid, '请写一篇约 3000 字的文章，介绍无线通信中 HARQ 的原理、演进和工程取舍，分十个小节，每节都要详细。');
  const stopSel = `.floating-input-bar[data-session-id="${sid}"] .floating-input-stop`;
  await sleep(15000);
  const lenBefore = (await overlayText()).length;
  const stopVisible = await c.eval(`(() => { const b = document.querySelector(${j(stopSel)}); return !!b && b.getBoundingClientRect().width > 0; })()`);
  check('④ 长回答进行中有停止按钮', stopVisible, { overlayLen: lenBefore });
  if (stopVisible) {
    t = Date.now();
    await click(stopSel);
    let stopped = false;
    const end = Date.now() + 30000;
    while (Date.now() < end) { const v = await c.eval(`(() => { const b = document.querySelector(${j(stopSel)}); return !b || b.getBoundingClientRect().width === 0; })()`); if (v) { stopped = true; break; } await sleep(500); }
    const stopMs = Date.now() - t;
    await sleep(8000);
    const l1 = (await overlayText()).length; await sleep(8000); const l2 = (await overlayText()).length;
    check('④ 点停止后 5 秒内停下且不再增长', stopped && stopMs <= 5000 && l2 === l1, { stopMs, l1, l2 });
    await shot('flow-4-stopped');
    t = Date.now();
    await sendText(sid, '请只回复 6 乘以 6 的结果数字，不要任何其它内容');
    check('④ 停止后下一句正常回答', await waitOverlay(sid, /(^|\D)36(\D|$)/), { ms: Date.now() - t });
  }
  // ⑤ 重启 Hub 后历史还在、能继续
  const before = await overlayText();
  await gracefulQuit(hub); hub = null; log('Hub 已优雅退出');
  await sleep(5000);
  await bootHub(kind + ' restart');
  const still = await c.eval(`sessions.has(${j(sid)})`);
  check('⑤ 重启后会话仍在侧栏', still);
  if (still) {
    await c.eval(`selectSession(${j(sid)})`); await sleep(8000);
    if (info.runMode !== 'serve') await waitPtyReady(sid, 120000);
    const ov = await overlayText();
    check('⑤ 重启后历史卡片在', /(^|\D)42(\D|$)/.test(ov) && /(^|\D)36(\D|$)/.test(ov), { beforeLen: before.length, afterLen: ov.length, tail: ov.slice(-300) });
    await shot('flow-5-restarted');
    t = Date.now();
    await sendText(sid, '请只回复 5 乘以 5 的结果数字，不要任何其它内容').catch(e => log('重启后发送失败', String(e)));
    check('⑤ 重启后能继续问答', await waitOverlay(sid, /(^|\D)25(\D|$)/), { ms: Date.now() - t });
    await shot('flow-6-after-restart-answer');
  }
  report.passed = report.checks.every(x => x.ok);
}


// 探针：CodeAgent 模型菜单开着时，终端焦点报告（ESC[O / ESC[I）等输入会不会把菜单关掉。
const ESC = String.fromCharCode(27), CR = String.fromCharCode(13);
async function caseFocusProbe() {
  await bootHub('focusprobe');
  const { sid } = await createSession('codeagent');
  check('PTY 就绪', await waitPtyReady(sid));
  await sleep(45000); // 等启动选模型做完
  const menuOpen = async () => /Credit用量|模型名称|Select model/.test(await screenText(sid));
  const type = data => c.eval(`require('electron').ipcRenderer.send('terminal-input', { sessionId: ${j(sid)}, data: ${j(data)} })`);
  const probes = [['焦点移出 ESC[O', ESC + '[O'], ['焦点移入 ESC[I', ESC + '[I'], ['光标位置回复 ESC[12;40R', ESC + '[12;40R'], ['空操作（对照）', '']];
  report.focusProbe = [];
  for (const [name, seq] of probes) {
    await type('/model'); await sleep(800); await type(CR);
    let opened = false; for (let i = 0; i < 20 && !opened; i++) { await sleep(500); opened = await menuOpen(); }
    await sleep(1500);
    const stillBefore = await menuOpen();
    if (seq) await type(seq);
    await sleep(2500);
    const openAfter = await menuOpen();
    report.focusProbe.push({ name, opened, stillBefore, openAfter });
    log('探针 ' + name, { opened, stillBefore, openAfter });
    await type(ESC); await sleep(1500); // 关菜单
  }
  report.passed = true;
}

// F06 主动组队：启动中心「群聊」拉 3 个默认成员（公司默认 CodeAgent）→ 一句话 → 3 个成员各自回答。
async function caseGroup() {
  await bootHub('group');
  await click('#btn-new');
  await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', '启动中心', 30000);
  await click('[data-launch-intent="group"]');
  await until(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length >= 2`, '建群面板', 30000);
  while (await c.eval(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length`) < 3) { await click('#mcm-add-member'); await sleep(500); }
  // 等成员模型下拉读到账号可用模型（面板打开后会主动读，最多约 30 秒）；空着就是体验缺陷，如实记下。
  const endModels = Date.now() + 40000;
  while (Date.now() < endModels && !(await c.eval(`[...document.querySelectorAll('#meeting-create-modal .mcm-model-select')].every(s => s.value)`).catch(() => false))) await sleep(1000);
  report.groupModelValues = await c.eval(`[...document.querySelectorAll('#meeting-create-modal .mcm-model-select')].map(s => s.value)`);
  check('成员模型下拉都选中了可用模型（不空）', report.groupModelValues.length >= 3 && report.groupModelValues.every(Boolean), report.groupModelValues);
  report.groupSlots = await c.eval(`[...document.querySelectorAll('#meeting-create-modal .mcm-slot')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 80))`);
  await shot('group-1-create');
  let t = Date.now();
  await click('#meeting-create-modal .mcm-create');
  // 不替用户点任何确认框：出现「换个模型」确认就记为失败（真实用户会卡在这里）。
  const confirmShown = () => c.eval(`[...document.querySelectorAll('button')].some(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0)`).catch(() => false);
  let sawConfirm = false;
  const members = async () => (await ipc('get-meetings')).at(-1)?.subSessions || [];
  const endM = Date.now() + 240000; let subs = [];
  while (Date.now() < endM) {
    subs = await members(); if (subs.length >= 3) break;
    if (!sawConfirm && await confirmShown()) { sawConfirm = true; await shot('group-1b-model-confirm'); }
    await sleep(1500);
  }
  check('建群全程没有弹「换个模型」确认框', !sawConfirm);
  check('群里 3 名成员建出', subs.length >= 3, { ms: Date.now() - t, n: subs.length });
  const sids = subs.map(s => (typeof s === 'string' ? s : s.sessionId || s.id || s.sid)).filter(Boolean);
  report.groupSids = sids;
  const kinds = await c.eval(`${j(sids)}.map(id => sessions.get(id)?.kind || '?')`);
  report.groupKinds = kinds;
  for (const sid of sids) await waitPtyReady(sid, 180000);
  await sleep(5000);
  t = Date.now();
  await click('#mr-input-box');
  await c.send('Input.insertText', { text: '请每位成员只回复 9 乘以 9 的结果数字，不要任何其它内容' });
  await sleep(300);
  await click('#mr-send-btn');
  const answered = new Set(); const endA = Date.now() + 300000;
  while (Date.now() < endA && answered.size < sids.length) {
    for (const sid of sids) if (!answered.has(sid) && /(^|\D)81(\D|$)/.test(await screenText(sid))) { answered.add(sid); log('成员回答', { sid: sid.slice(0, 8), ms: Date.now() - t }); }
    await sleep(3000);
  }
  report.groupRoomText = (await c.eval(`(document.querySelector('#meeting-room, .meeting-room, #mr-messages')?.innerText || '').replace(/\s+/g, ' ').slice(-1200)`).catch(() => ''));
  check('一问多答：3 名成员都回答', answered.size === sids.length && sids.length >= 3, { answered: answered.size, kinds, ms: Date.now() - t });
  await shot('group-2-answers');
}

// F03/F04：启动中心里公司电脑上能选的框架（含 DSH 是否可用）；F20-1：问问 Hub 真问一句。
async function caseKinds() {
  await bootHub('kinds');
  await c.eval('window.WorkspaceController?.openNewSessionModal?.({})');
  await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话表单', 30000);
  await sleep(2500);
  report.kinds = await c.eval(`[...document.querySelectorAll('.new-session-option')].map(b => ({ kind: b.dataset.kind, text: b.innerText.replace(/\s+/g, ' ').slice(0, 60), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true', title: (b.title || '').slice(0, 120) }))`);
  log('启动中心框架', report.kinds);
  check('启动中心列出多个框架', report.kinds.length >= 2, report.kinds.map(k => k.kind));
  await shot('kinds-launcher');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(1000);
  // 问问 Hub
  await click('#btn-help-ask');
  await until(`!!document.querySelector('.help-ask-panel:not([hidden])')`, '问问 Hub 面板', 20000);
  await sleep(3000);
  report.askState = await c.eval(`document.querySelector('.help-ask-panel .ask-ttl p')?.textContent || ''`).catch(() => '');
  const t = Date.now();
  await c.eval(`(() => { const ta = document.querySelector('.help-ask-panel textarea'); ta.focus(); ta.value = ''; })()`);
  await c.send('Input.insertText', { text: '怎么把会话切成省内存的 CodeAgent-Lite？' });
  await click('.help-ask-panel [data-ha="send"]');
  let answer = '';
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    answer = await c.eval(`(() => { const last = [...document.querySelectorAll('.help-ask-panel .ask-qa')].pop(); const a = last && last.querySelector('.ask-a'); return a ? a.innerText : ''; })()`).catch(() => '');
    const busy = await c.eval(`!!document.querySelector('.help-ask-panel [data-ha="cancel"]:not([hidden])')`).catch(() => false);
    if (answer && answer.length > 20 && !busy) break;
    await sleep(2000);
  }
  report.askAnswer = answer.slice(0, 800);
  check('问问 Hub 回答提到 Lite 的入口', /Lite/.test(answer) && /(启动中心|新建|设置|一键)/.test(answer), { ms: Date.now() - t, state: report.askState, answer: answer.slice(0, 300) });
  await shot('askhub-answer');
}

// F02/F03/F04：一个窗口里起多种框架的会话（--kinds codeagent,codeagent-lite,claude,opencode,deepseek），各问一句，再来回切换核对内容不串。
// 起不来的框架如实记下界面给的原因（截图 + 提示原文），作为「公司不可用」的证据。
async function caseMulti() {
  const kinds = String(arg('--kinds', 'codeagent,codeagent-lite,claude,opencode')).split(',').filter(Boolean);
  await bootHub('multi');
  const made = [];
  for (const [i, kind] of kinds.entries()) {
    const t = Date.now();
    try {
      const { sid, info } = await createSession(kind);
      made.push({ kind, sid, info, n: 11 + i * 7 });
      check(`${kind} 会话建出`, true, { ms: Date.now() - t, info });
    } catch (error) {
      const ui = error.ui || await c.eval(`[...document.querySelectorAll('[role=alert], .toast, .error, .modal, [role=dialog]')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 400))`).catch(() => []);
      check(`${kind} 会话建出`, false, { ms: Date.now() - t, error: String(error.message || error), ui });
      await shot('multi-fail-' + kind);
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    }
  }
  for (const m of made) {
    if (/^codeagent$/.test(m.kind)) await waitPtyReady(m.sid, 180000); else await sleep(15000);
    const t = Date.now();
    await sendText(m.sid, `请只回复 ${m.n} 加 ${m.n} 的结果数字，不要任何其它内容`);
    m.answer = 2 * m.n;
    m.ok = await waitOverlay(m.sid, new RegExp(`(^|\\D)${m.answer}(\\D|$)`), 240000);
    check(`${m.kind} 前台卡片回答`, m.ok, { ms: Date.now() - t });
    await shot('multi-answer-' + m.kind);
  }
  // 来回切换：每个会话的卡片里只能有自己的答案
  for (let round = 0; round < 2; round++) for (const m of made.filter(x => x.ok)) {
    await c.eval(`selectSession(${j(m.sid)})`); await sleep(1500);
    const ov = await overlayText();
    const others = made.filter(x => x.ok && x !== m && new RegExp(`(^|\\D)${x.answer}(\\D|$)`).test(ov)).map(x => x.kind);
    check(`切换第 ${round + 1} 轮：${m.kind} 内容不丢不串`, new RegExp(`(^|\\D)${m.answer}(\\D|$)`).test(ov) && !others.length, { others });
  }
}

async function main() {
  if (caseName === 'selftest') fs.mkdirSync(out, { recursive: true }); else prepare();
  log('准备完成', { case: caseName });
  if (caseName === 'selftest') {
    report.realCacSettingsHash = hash(path.join(os.homedir(), '.cac', 'settings.json'));
    report.realCacCredHash = hash(path.join(os.homedir(), '.cac', '.credentials.json'));
    hub = { log: () => [], selftest: true }; check('自测占位', true); return;
  }
  if (caseName === 'mem') await caseMem();
  else if (caseName === 'flow') await caseFlow();
  else if (caseName === 'focusprobe') await caseFocusProbe();
  else if (caseName === 'group') await caseGroup();
  else if (caseName === 'kinds') await caseKinds();
  else if (caseName === 'multi') await caseMulti();
  else throw Error('未知用例 ' + caseName);
}

// 收尾：账号目录被改、Hub 没能正常退出都算失败；最终报告在退出之后才写。
// 自测注入：E2E_INJECT_QUIT_FAIL=1 让退出失败，E2E_INJECT_CAC_CHANGE=1 模拟账号目录被改（--case selftest 不起 Hub，只跑收尾）。
const quitHub = process.env.E2E_INJECT_QUIT_FAIL === '1' ? async () => { throw Error('注入的退出失败'); } : async h => (h.selftest ? { ok: true, selftest: true } : gracefulQuit(h));
async function finalize() {
  try { if (c && hub && hub.pid) await shot('99-final'); } catch {}
  if (process.env.E2E_INJECT_CAC_CHANGE === '1') report.realCacSettingsHash = 'injected-change';
  report.realCacUnchanged = hash(path.join(os.homedir(), '.cac', 'settings.json')) === report.realCacSettingsHash
    && hash(path.join(os.homedir(), '.cac', '.credentials.json')) === report.realCacCredHash;
  if (!report.realCacUnchanged) check('真实账号目录未被改动', false);
  try { if (hub && hub.log) fs.writeFileSync(path.join(out, 'hub-main.log'), hub.log().join(String.fromCharCode(10))); } catch {}
  if (hub) {
    try { report.teardown = await quitHub(hub); }
    catch (error) { report.teardownError = String(error.message || error); check('隔离 Hub 正常退出', false, report.teardownError); }
  }
  report.passed = !report.error && report.checks.length > 0 && report.checks.every(x => x.ok);
  report.finishedAt = new Date().toISOString(); save();
  console.log('REPORT ' + path.join(out, 'report.json'));
  process.exit(report.passed ? 0 : 1);
}
main().catch(error => { report.error = String(error.stack || error); if (error.ui) report.errorUi = error.ui; console.error(error); })
  .finally(finalize);
