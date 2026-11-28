'use strict';
// 真机压测：PPT「图片转可编辑」（2026-11-28）。在装有 PPT Doctor 与公司 CodeAgent 的电脑上，
// 隔离 Hub（隐藏窗口、独立数据目录）→ PPT 页 →「图片转可编辑」→ 把真实图片拖进投放区（CDP 拖放，等同用户拖入）→
// 逐状态记录（识别 → CodeAgent 看图修正 → 装配）直到结束；另测转换中再拖一张、坏图、中文路径、并发两张、转换中关 Hub。
// 不点「打开 PPT」（会在用户桌面弹出 PowerPoint），只核对产物文件。
//   <Hub 程序> 以 ELECTRON_RUN_AS_NODE=1 运行：
//   node tests/e2e-company-ppt-imgtext-real.js --exe <AI Hub Community.exe> --images a.png,b.png [--stress <样本目录>] [--out <证据目录>] [--wait-min 8]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe');
const images = String(arg('--images') || '').split(',').filter(Boolean);
const stressDir = arg('--stress');
const waitMin = Number(arg('--wait-min') || 8);
const fullAgent = Number(arg('--full-agent') ?? 1);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-imgtext-real-'));
const out = arg('--out') || path.join(root, 'out'), cac = path.join(root, 'cac-home', '.cac'), dataDir = path.join(root, 'data');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const report = { startedAt: new Date().toISOString(), root, exe, runs: [], stress: [], checks: [], screenshots: [], timeline: [] };
const t0 = Date.now();
const save = () => { try { fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1)); } catch {} };
const log = (msg, extra) => { const line = { s: Math.round((Date.now() - t0) / 1000), msg, ...(extra ? { extra } : {}) }; report.timeline.push(line); console.log(j(line)); save(); };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); log((ok ? '通过 ' : '失败 ') + name, detail); return !!ok; };
let hub, c;
const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return true; await sleep(500); } throw Error('超时：' + label); };
const shot = async name => {
  const s = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  const file = path.join(out, name + '.jpg'); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); report.screenshots.push(file);
};
const click = async selector => {
  const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('找不到 '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
};
const ipc = (action, data) => c.eval(`require('electron').ipcRenderer.invoke(${j('company-assistant:' + action)}, ${j(data)})`);
// 用户把文件拖进投放区：CDP 原生拖放事件带真实文件路径，页面走自己的 drop 处理（webUtils.getPathForFile）。
async function dropFile(file) {
  const point = await c.eval(`(() => {const e=document.querySelector('[data-ppt-drop]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await c.send('Input.dispatchDragEvent', { type, ...point, data });
}
const convState = () => c.eval(`(() => {const m=document.querySelector('[data-ppt-conversion] [data-conversion-state]');const box=document.querySelector('[data-ppt-conversion]');return {state:m?m.dataset.conversionState:'', text:(box?.innerText||'').slice(0,300), jobId:box?.dataset.jobId||''};})()`);

function prepare() {
  for (const d of [out, cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  // 根下 ~/.cac.json 放到副本目录旁：CodeAgent 新版模型清单只在那里，Hub 对 *.cac 目录读同级 .cac.json（m1 ff9f96b30；只复制目录会误判「默认模型下线」）。
  try { fs.copyFileSync(path.join(os.homedir(), '.cac.json'), path.join(path.dirname(cac), '.cac.json')); } catch { /* 没有就算了 */ }
  const real = path.join(os.homedir(), '.cac');
  if (fs.existsSync(real)) for (const name of fs.readdirSync(real)) {
    const src = path.join(real, name);
    if (!fs.statSync(src).isFile()) continue;
    if (/^history\.jsonl$|\.log$|\.bak|hub-backup|\.(cjs|html)$|^build-asar/i.test(name)) continue;
    if (fs.statSync(src).size > 2 * 1024 * 1024) continue;
    fs.copyFileSync(src, path.join(cac, name));
  }
  // 指定用哪一份 PPT Doctor（例如刚从内源全新安装的 v2.0.7 副本），写进隔离数据目录的设置；不指定就按 Hub 自动发现。
  const doctorExe = arg('--doctor-exe');
  if (doctorExe) { fs.mkdirSync(path.join(dataDir, 'company-assistant'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'company-assistant', 'settings.json'), j({ ppt: { doctorExe } })); report.doctorExe = doctorExe; }
  // 测试用的配置副本里指定一个可用模型，并写 Hub 记的「上次选的模型」——等同用户之前已在换模型卡片里选过它；真实 ~/.cac 不动。
  const wantModel = arg('--codeagent-model');
  if (wantModel) {
    const f = path.join(cac, 'settings.json'); let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    report.codeagentModelFrom = cfg.model || ''; cfg.model = wantModel; fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); report.codeagentModel = wantModel;
    fs.writeFileSync(path.join(dataDir, 'codeagent-last-model.json'), j({ personal: { model: wantModel, at: new Date().toISOString() } }));
  }
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
}

// 一张图走完整条用户路径：拖入 → 状态逐个记录 → 结束态。返回本张的耗时与结果。
// opts.onWaiting：等 CodeAgent 看图修正 opts.afterSec 秒后点「不等了，先用 OCR 初稿装配」（fallback）或「停止 CodeAgent」（stop）。
async function convertOne(file, label, opts = {}) {
  const run = { file: path.basename(file), label, states: [], startedAt: Date.now(), onWaiting: opts.onWaiting || null };
  report.runs.push(run);
  const before = (await convState().catch(() => ({}))).jobId || '';
  await c.eval(`(() => { const n = document.querySelector('[data-ppt-notice]'); if (n) n.textContent = ''; return true; })()`).catch(() => {});
  await dropFile(file);
  // 拖入后必须换成新任务；没换说明被拒（上一张还在处理），记下提示，不把旧任务算到这张头上。
  // 页面要等 OCR 初稿做完才拿到任务编号（开始调用会等识别结束），所以最多等 4 分钟；
  // 期间出现「仍在处理」提示即被拒，框里出现报错而没有新任务即开工前就失败（如 0 字节）。
  const endNew = Date.now() + 240000;
  let fresh = false;
  await sleep(1500);
  while (Date.now() < endNew) {
    const s = await convState().catch(() => ({}));
    if (s.jobId && s.jobId !== before) { fresh = true; break; }
    const notice = await c.eval(`document.querySelector('[data-ppt-notice]')?.textContent || ''`).catch(() => '');
    if (/仍在处理|请等本轮/.test(notice)) break;
    if (s.text && !/正在生成 OCR 初稿/.test(s.text) && !s.state) break;
    await sleep(1000);
  }
  if (!fresh) {
    run.refused = await c.eval(`document.querySelector('[data-ppt-notice]')?.textContent || ''`).catch(() => '');
    run.boxText = (await convState().catch(() => ({}))).text;
    run.seconds = Math.round((Date.now() - run.startedAt) / 1000); run.final = 'refused'; log(`${label} 被拒`, run.refused); save();
    return run;
  }
  let last = '', jobId = '', waitingSince = 0, acted = false;
  const end = Date.now() + (opts.waitMin || waitMin) * 60000;
  while (Date.now() < end) {
    const s = await convState().catch(() => ({ state: '', text: '' }));
    if (s.jobId) jobId = s.jobId;
    if (s.state === 'waiting_agent' && !waitingSince) waitingSince = Date.now();
    if (opts.onWaiting && !acted && waitingSince && Date.now() - waitingSince >= (opts.afterSec ?? 20) * 1000) {
      acted = true;
      run.waitUi = await c.eval(`({waited: document.querySelector('[data-ppt-agent-waited]')?.textContent || '', fallback: !!document.querySelector('[data-ppt="conversion-fallback"]'), stop: !!document.querySelector('[data-ppt="conversion-stop"]')})`).catch(e => ({ error: String(e) }));
      await shot(`${label}-waiting-ui`).catch(() => {});
      run.actedAt = Math.round((Date.now() - run.startedAt) / 1000);
      await click(opts.onWaiting === 'stop' ? '[data-ppt="conversion-stop"]' : '[data-ppt="conversion-fallback"]').catch(e => { run.actError = String(e); });
      log(`${label} 点了 ${opts.onWaiting}`, run.waitUi);
    }
    const key = s.state || s.text.slice(0, 40);
    if (key && key !== last) { last = key; run.states.push({ s: Math.round((Date.now() - run.startedAt) / 1000), state: s.state, text: s.text.slice(0, 160) }); log(`${label} → ${key}`); await shot(`${label}-${run.states.length}-${s.state || 'x'}`).catch(() => {}); }
    if (['done', 'error', 'needs_component'].includes(s.state)) break;
    await sleep(1000);
  }
  run.seconds = Math.round((Date.now() - run.startedAt) / 1000);
  run.final = last;
  if (run.actedAt != null) run.afterActSeconds = run.seconds - run.actedAt;
  if (jobId) {
    const r = await ipc('ppt-imgtext-status', { jobId }).catch(e => ({ error: String(e) }));
    const job = r.job || {};
    run.job = { state: job.state, flattened: !!job.flattened, code: job.code, error: job.error, opsFixed: job.opsFixed, step: job.step, builds: job.builds, vision: job.vision, mode: job.result?.mode, pixelGate: job.result?.pixel_gate?.passed, pptx: job.result?.pptx, reviewItems: (job.result?.reviewItems || []).length };
    run.pptxExists = !!(job.result?.pptx && fs.existsSync(job.result.pptx));
    if (run.pptxExists) (report.outputs ||= []).push({ label, file: run.file, pptx: job.result.pptx, mode: job.result.mode, flattened: !!job.flattened });
  }
  save();
  return run;
}

async function stress() {
  const tmp = path.join(root, 'stress'); fs.mkdirSync(tmp, { recursive: true });
  const [A, B, C] = [images[0], images[1] || images[0], images[2] || images[0]];
  // 1) 等 CodeAgent 时点「停止」：结束这张，之后能换图
  const rs = await convertOne(C, 'stop', { onWaiting: 'stop', afterSec: 15 });
  check('等 CodeAgent 时有「已等时长」「不等了」「停止」', rs.waitUi?.fallback && rs.waitUi?.stop && /已等/.test(rs.waitUi?.waited || ''), rs.waitUi);
  check('点「停止 CodeAgent」10 秒内结束这张并说明可用 OCR 初稿装配', rs.job?.state === 'error' && rs.job?.code === 'AGENT_STOPPED' && rs.afterActSeconds <= 10, { after: rs.afterActSeconds, job: rs.job });
  // 2) 坏图：截断的 PNG、改了扩展名的文本、0 字节（每张在空闲时拖入）
  const bytes = fs.readFileSync(A);
  const cases = [
    ['截断PNG', path.join(tmp, 'broken-cut.png'), f => fs.writeFileSync(f, bytes.subarray(0, Math.floor(bytes.length / 3)))],
    ['文本改名png', path.join(tmp, 'not-image.png'), f => fs.writeFileSync(f, '这不是图片\n'.repeat(50))],
    ['0字节', path.join(tmp, 'empty.png'), f => fs.writeFileSync(f, '')],
  ];
  for (const [name, file, make] of cases) {
    make(file);
    const r = await convertOne(file, 'bad-' + name, { onWaiting: 'fallback', afterSec: 5, waitMin: 4 });
    const said = r.job?.error || r.boxText || r.refused || '';
    report.stress.push({ case: name, final: r.final, seconds: r.seconds, job: r.job, said: said.slice(0, 300) });
    const readable = /[一-鿿]/.test(said) && !/cannot identify|Traceback|Error:/i.test(said);
    check(`坏图「${name}」给出中文说明且不挂住`, (r.job?.state === 'error' || r.job?.state === 'done' || r.final === 'refused') && (r.job?.state === 'done' || readable) && r.seconds < 240, { seconds: r.seconds, said, state: r.job?.state });
  }
  // 3) 中文路径 + 空格 + 中文文件名；等 CodeAgent 时点「不等了」
  const zh = path.join(tmp, '中文 目录 测试', '第3页 密集 技术稿（副本）.png'); fs.mkdirSync(path.dirname(zh), { recursive: true }); fs.copyFileSync(A, zh);
  const rz = await convertOne(zh, 'zh-path', { onWaiting: 'fallback', afterSec: 10 });
  report.stress.push({ case: '中文路径', seconds: rz.seconds, afterAct: rz.afterActSeconds, job: rz.job, pptxExists: rz.pptxExists });
  check('中文路径文件名正常转换（不等 CodeAgent 直接 OCR 初稿装配）', rz.job?.state === 'done' && rz.pptxExists, rz.job);
  // 4) 转换中再拖一张：友好拒绝，不替换当前任务
  const before = (await convState()).jobId;
  await c.eval(`(() => { const n = document.querySelector('[data-ppt-notice]'); if (n) n.textContent = ''; return true; })()`).catch(() => {});
  await dropFile(B); await sleep(3000);
  await dropFile(C); await sleep(2500);
  const notice = await c.eval(`document.querySelector('[data-ppt-notice]')?.textContent || ''`).catch(() => '');
  const endStart = Date.now() + 240000;
  while (Date.now() < endStart && (await convState()).jobId === before) await sleep(1000);
  const after = await convState();
  const afterJob = after.jobId ? (await ipc('ppt-imgtext-status', { jobId: after.jobId }).catch(() => ({}))).job : null;
  check('转换中再拖一张：提示请等本轮完成、当前任务不被替换', /仍在处理|请等/.test(notice) && afterJob && path.basename(afterJob.image) === path.basename(B), { notice, image: afterJob && path.basename(afterJob.image) });
  const endB = Date.now() + waitMin * 60000;
  while (Date.now() < endB && !['done', 'error', 'needs_component'].includes((await convState()).state)) {
    if ((await convState()).state === 'waiting_agent' && await c.eval(`!!document.querySelector('[data-ppt="conversion-fallback"]')`)) await click('[data-ppt="conversion-fallback"]').catch(() => {});
    await sleep(3000);
  }
  // 5) 两个入口同时发起（MCP / 页面）：IPC 并发两张，不在 CDP 里等识别做完
  await c.eval(`window.__pairDone = null; Promise.all([${j(A)}, ${j(B)}].map(p => require('electron').ipcRenderer.invoke('company-assistant:ppt-imgtext-start', { imagePath: p }))).then(r => (window.__pairDone = r), e => (window.__pairDone = [{ error: String(e) }])); true`);
  const endP = Date.now() + 5 * 60000;
  while (Date.now() < endP && !(await c.eval('!!window.__pairDone'))) await sleep(2000);
  const pair = await c.eval('window.__pairDone || []');
  const ids = pair.map(x => x?.id).filter(Boolean), finals = {};
  const end2 = Date.now() + waitMin * 60000;
  while (Date.now() < end2 && ids.some(id => !finals[id])) {
    for (const id of ids) if (!finals[id]) {
      const r = await ipc('ppt-imgtext-status', { jobId: id });
      if (r.job?.state === 'waiting_agent') await ipc('ppt-imgtext-fallback', { jobId: id }).catch(() => {});
      if (['done', 'error', 'needs_component'].includes(r.job?.state)) finals[id] = { state: r.job.state, error: r.job.error, pptx: r.job.result?.pptx, image: path.basename(r.job.image) };
    }
    await sleep(2000);
  }
  report.stress.push({ case: '并发两张', start: pair.map(x => x?.state || x?.error), finals });
  const fin = Object.values(finals);
  check('并发两张各自完成、产物不串', fin.length === 2 && fin.every(f => f.state === 'done') && new Set(fin.map(f => f.pptx)).size === 2, finals);
}

function doctorProcs() {
  try {
    const outp = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='PPT-Doctor.exe'" | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CommandLine }`], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    return outp.split(/\r?\n/).filter(Boolean).filter(l => l.includes(root));
  } catch (e) { return ['ERR ' + e.message]; }
}

async function main() {
  // 隔离副本会被内源静默升级写回 app.asar，那时实际跑的是原包而不是要测的代码：发现就停，不测。
  if (fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) throw new Error('隔离副本的 resources 下又出现了 app.asar（可能被静默升级写回），实际会跑原包；请先改名或重建副本再测');
  prepare();
  // 不让隔离实例用本机真实 WeLink 登录去拉消息、整理助理（2026-11-28 真机压测踩到：后台读了几百次历史消息并占住 CodeAgent）。
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'ppt imgtext real', executablePath: exe,
    entryPath: path.resolve(__dirname, '..'), cwd: path.dirname(exe), extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: welinkStub, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
      // 不让隔离副本自己检查或静默换装新版本（真实内源仍可用于组件下载）。
      AI_HUB_QUIET_UPDATE: '0', AI_HUB_UPDATE_STARTUP_DELAY_MS: String(24 * 3600 * 1000), DEEPSEEK_API_KEY: '' } });
  await require('./helpers/isolation-guard').guardIsolatedHub(hub, root);   // 5 秒内发现用到生产数据目录就只结束这个主进程并报错
  report.pid = hub.pid;
  for (let i = 0; !c; i++) {
    try { c = await connectFirstPage(hub, target => /index\.html/.test(target.url), { waitMainMs: 15000 }); }
    catch (error) { if (i >= 8) throw error; await sleep(3000); }
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 账号默认模型在公司侧不可用时，Hub 建会话会弹「新建会话需要换个模型」并等用户选。脚本不替用户点（红队审核：代点会掩盖卡死），
  // 只记下出现的时刻和原文，收尾时记为失败；要测功能本身，请用 --codeagent-model 给测试用的配置副本指定一个可用模型。
  let swapBusy = false;
  const swapTimer = setInterval(async () => {
    if (swapBusy || !c || report.modelSwapCard) return; swapBusy = true;
    try {
      const hit = await c.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0); if (!b) return null; const card = b.closest('[role=dialog], [role=alertdialog], [class*=hmn]') || b.parentElement; return (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300); })()`).catch(() => null);
      if (hit) { report.modelSwapCard = { s: Math.round((Date.now() - t0) / 1000), text: hit }; log('出现「新建会话需要换个模型」卡片（未代点）', hit.slice(0, 120)); }
    } finally { swapBusy = false; }
  }, 3000);
  swapTimer.unref?.();
  await until('!!document.getElementById("btn-company-ppt")', 'PPT 入口', 120000);
  report.hubVersion = await c.eval(`require('../package.json').version`).catch(() => null);
  const tOpen = Date.now();
  await click('#btn-company-ppt');
  await until('["ready","empty","missing","upgrade","error"].includes(document.querySelector("[data-ppt-status]")?.dataset.state)', 'Doctor 状态', 90000);
  report.doctorStatus = await c.eval(`({state: document.querySelector("[data-ppt-status]").dataset.state, text: document.querySelector("[data-ppt-status]").innerText.slice(0,200)})`);
  report.doctorStatusSeconds = Math.round((Date.now() - tOpen) / 1000);
  log('Doctor 状态', report.doctorStatus);
  await shot('01-ppt-home');
  check('全新数据目录：自动找到本机 PPT Doctor，不需要手填', ['ready', 'empty'].includes(report.doctorStatus.state), report.doctorStatus);
  await click('[data-ppt="convert-mode"]');
  await until('!document.querySelector("[data-ppt-convert-panel]").hidden', '转可编辑面板');
  await shot('02-convert-panel');
  // 第 1 张：等 CodeAgent 20 秒后点「不等了」——量从拖入到拿到可编辑 PPT 的时间
  const quick = await convertOne(images[0], 'img01-quick', { onWaiting: 'fallback', afterSec: 20 });
  check(`${path.basename(images[0])}：点「不等了」后拿到可编辑 PPT`, quick.job?.state === 'done' && quick.pptxExists && quick.job?.mode === 'image_fallback', { seconds: quick.seconds, afterAct: quick.afterActSeconds, job: quick.job });
  // 其余：完整等 CodeAgent 看图修正（量真实耗时，核对类型小错不再整轮失败）
  for (const [i, file] of images.slice(1, fullAgent + 1).entries()) {
    const r = await convertOne(file, `img${String(i + 2).padStart(2, '0')}-agent`, { waitMin: 20 });
    check(`${path.basename(file)} 走完 CodeAgent 看图修正并产出 PPTX`, r.job?.state === 'done' && r.pptxExists, { seconds: r.seconds, job: r.job });
  }
  if (stressDir) await stress();
  // 转换中关 Hub：不能留下这个 Hub 拉起的 PPT Doctor 进程
  if (stressDir) {
    await dropFile(images[0]); await sleep(8000);
    report.procsBeforeQuit = doctorProcs();
    const quitOk = await closeHub('转换中关 Hub'); if (!quitOk) log('关 Hub 出错', report.quitErrors);
    await sleep(10000);
    report.procsAfterQuit = doctorProcs();
    check('转换中关 Hub：10 秒后没有残留的 PPT Doctor 进程', report.procsAfterQuit.length === 0, report.procsAfterQuit);
  }
}

// 关 Hub：优雅退出失败就记进报告并保留 hub 引用，再只结束这个脚本自己拉起、核实过的主进程（hub.child），不按进程树或进程名收。
async function closeHub(why) {
  if (!hub) return true;
  try { await gracefulQuit(hub); hub = null; return true; }
  catch (e) {
    (report.quitErrors ||= []).push({ why, error: String(e && e.message || e).slice(0, 300) });
    try { if (hub.child && hub.child.pid === hub.pid && hub.child.exitCode == null) hub.child.kill(); } catch (k) { report.quitErrors.push({ why: why + ' kill', error: String(k) }); }
    await sleep(3000);
    if (hub.isAlive && !hub.isAlive()) { hub = null; return false; }
    report.hubLeft = { pid: hub.pid };   // 仍在：报告里写明 PID，交给人工核实后处理
    return false;
  }
}

main().catch(e => { report.error = String(e && e.stack || e); log('出错', report.error); })
  .finally(async () => {
    const closed = await closeHub('收尾');
    report.finishedAt = new Date().toISOString();
    if (report.modelSwapCard) report.checks.push({ name: '没有出现需要用户去点的换模型卡片', ok: false, detail: report.modelSwapCard });
    report.passed = require('./helpers/e2e-verdict').e2ePassed(report, closed);
    save();
    console.log('REPORT ' + path.join(out, 'report.json'));
    process.exit(report.passed ? 0 : 1);
  });
