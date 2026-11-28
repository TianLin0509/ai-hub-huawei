'use strict';
// 真机验收：一句话起团队（2026-11-23）。在装有公司 CodeAgent 的电脑上，用真实 CLI 和个人账号：
// 首页点「新建普通会话」→ 默认 CodeAgent → 在输入框打一句「组个队做 X」→ 负责人自己用内置组队技能招人 →
// Hub 自动批准 → 成员出现在侧栏负责人下面、开在 Hub 建好的 worktree 里 → 等成员交付。
// 隔离数据目录、隐藏窗口；个人账号配置复制进临时目录使用，真实 ~/.cac 只读（结束时核对哈希）。
//   <Hub 程序> 以 ELECTRON_RUN_AS_NODE=1 运行：node tests/e2e-company-team-oneline-real.js --exe <AI Hub Community.exe> [--root-file <把测试根目录写到这个文件>]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

// 本脚本借 Hub 程序当 Node 跑；拉起的 Hub 本身不能继承这个开关，否则它也按 Node 运行、不出界面。
delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const exe = arg('--exe');
// 隔离启动器要求数据目录在系统临时目录下的专用子目录里。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubteam-oneline-'));
if (arg('--root-file')) fs.writeFileSync(arg('--root-file'), root);
const waitMin = Number(arg('--wait-min') || 25);
// --plain：工作目录是普通文件夹（不 git init），验证非 git 目录也能一句话组队、成员能交付。
const plain = argv.includes('--plain');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
const READY = String.raw`Anything I can assist you with|bypass permissions on \(`;

const out = path.join(root, 'out'), cac = path.join(root, 'cac-home', '.cac'), dataDir = path.join(root, 'data');
const work = path.join(root, 'work'), repo = path.join(root, 'demo-repo');
const report = { startedAt: new Date().toISOString(), root, exe, checks: [], screenshots: [], timeline: [], passed: false };
const t0 = Date.now();
const log = (msg, extra) => { const line = { s: Math.round((Date.now() - t0) / 1000), msg, ...(extra ? { extra } : {}) }; report.timeline.push(line); console.log(j(line)); save(); };
const save = () => { try { fs.writeFileSync(path.join(out, 'report.json'), j(report, null, 1)); } catch {} };
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

function prepare() {
  for (const d of [out, cac, dataDir, work, repo]) fs.mkdirSync(d, { recursive: true });
  // 个人账号配置：只复制顶层小文件，跳过历史、日志和备份；真实目录不写。
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
  // 根下 ~/.cac.json 放到副本目录旁（新版模型清单只在那里，Hub 对 *.cac 目录读同级 .cac.json）。
  try { fs.copyFileSync(path.join(os.homedir(), '.cac.json'), path.join(path.dirname(cac), '.cac.json')); } catch { /* 没有就算了 */ }
  report.realCacFieldsBefore = cacFields();
  report.gitVersion = execFileSync('git', ['--version'], { windowsHide: true }).toString().trim();
  if (plain) { fs.writeFileSync(path.join(repo, 'README.md'), '# demo（普通文件夹，不是 git 仓库）\n'); report.plain = true; return; }
  // 演示仓库：git 仓库主目录，用来验证招人时自动建 worktree。
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString().trim();
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  report.repoBase = git(['rev-parse', 'HEAD']);
}
// 真实 ~/.cac/settings.json 按字段记短哈希（不记内容），收尾比对哪些字段变了。
function cacFields() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cac', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Object.fromEntries(Object.keys(v).map(k => [k, crypto.createHash('sha256').update(j(v[k])).digest('hex').slice(0, 10)]));
  } catch { return null; }
}
// 起隔离 Hub 后 5 秒核一次进程树（2026-11-28 公司真机事故后补）：命令行出现生产数据目录、或主进程没带隔离的 --user-data-dir，
// 只结束这一个核实过的主进程 PID 并报错退出。进程树只收比父进程晚启动的子进程。
async function guardIsolatedHub(pid) {
  await sleep(5000);
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const table = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 }).toString('utf8'))
    .map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine || '', created: Number((/\d+/.exec(String(p.CreationDate || '')) || [0])[0]) }));
  const created = new Map(table.map(p => [p.pid, p.created])); const tree = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const p of table) if (!tree.has(p.pid) && tree.has(p.ppid) && !(p.created && created.get(p.ppid) && p.created < created.get(p.ppid))) { tree.add(p.pid); grew = true; } }
  const self = table.find(p => p.pid === pid);
  const bad = table.filter(p => tree.has(p.pid) && /AppData\\Roaming\\ai-hub-community|\\\.ai-hub-community(\\|"|\s|$)/i.test(p.cmd)).map(p => ({ pid: p.pid, name: p.name }));
  const isolatedUserData = !!self && self.cmd.toLowerCase().includes(('--user-data-dir=' + path.join(dataDir, 'electron-userdata')).toLowerCase());
  report.guard = { ok: !!self && !bad.length && isolatedUserData, bad, isolatedUserData };
  if (report.guard.ok) { log('隔离守卫通过', { pid }); return; }
  if (self && /AI Hub Community\.exe$/i.test(self.name)) { try { process.kill(pid); } catch {} }
  hub = null;
  throw Error('隔离守卫：' + (!self ? '隔离 Hub 5 秒内已退出' : bad.length ? '命令行出现生产数据目录 ' + j(bad) : '主进程没带隔离的 --user-data-dir') + '，已结束 PID ' + pid);
}

async function main() {
  prepare();
  log('准备完成', { gitVersion: report.gitVersion, plain });
  // WeLink 假桩：隔离 Hub 读到「未登录」，不碰本机 WeLink 登录。
  const welinkStub = path.join(root, 'welink-cli-stub.js');
  fs.writeFileSync(welinkStub, "console.log(JSON.stringify({ authenticated: false, loggedIn: false }));\n");
  hub = await launchIsolatedHub({ dataDir, port: Number(arg('--port')) || await freePort(), windowMode: 'background', label: 'team oneline', executablePath: exe,
    entryPath: arg('--entry') || path.resolve(__dirname, '..'), cwd: path.dirname(exe), extraEnv: {
      AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_WORKSPACE_ROOT: work,
      AI_HUB_UPDATE_SOURCES: j([{ id: 'none', name: '测试不更新', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/v{version}/' }]), DEEPSEEK_API_KEY: '', CLAUDE_HUB_WELINK_CLI: welinkStub } });
  report.pid = hub.pid;
  await guardIsolatedHub(hub.pid);
  // 安装版冷启动在办公电脑上较慢：主界面页最多等 2 分钟，等不到就把现有页面地址写进报告。
  for (let i = 0; !c; i++) {
    try { c = await connectFirstPage(hub, target => /index\.html/.test(target.url), { waitMainMs: 15000 }); }
    catch (error) {
      if (i >= 8) { report.targets = await fetch(hub.cdpHttpBase + '/json/list').then(r => r.json()).catch(e => String(e)); throw error; }
      await sleep(3000);
    }
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('typeof sessions !== "undefined" && typeof selectSession === "function"', '界面加载', 90000);
  report.hubVersion = await c.eval(`require('../package.json').version`).catch(() => null);
  report.skillVersion = await c.eval(`require('../core/codeagent-bundled-skills').TEAM_SKILL_VERSION`).catch(() => null);
  check('隔离 Hub 起来了，内置组队技能 0.7.0', report.skillVersion === '0.7.0', { hub: report.hubVersion, skill: report.skillVersion });
  check('组队技能已装进个人账号目录', fs.existsSync(path.join(cac, 'skills', 'company-team', 'SKILL.md')));
  await sleep(1500);
  await shot('01-home');

  // ① 首页「新建普通会话」→ 默认 CodeAgent → 创建（真实点击）
  const before = new Set(await c.eval('[...sessions.keys()]'));
  await click('#home-create-session');
  await until(`document.querySelector('#new-session-submit')?.getBoundingClientRect().width > 0`, '新建会话表单', 30000);
  const kind = await c.eval(`document.querySelector('.new-session-option.selected')?.dataset.kind`);
  check('新建会话默认选中 CodeAgent', kind === 'codeagent', kind);
  await click('#new-session-submit');
  let lead = null;
  // 首次「检查账号并启动」在办公电脑上可能要一两分钟：最多等 4 分钟，每 30 秒记一次按钮文字。
  const endCreate = Date.now() + 240000; let lastNote = 0;
  while (!lead && Date.now() < endCreate) {
    lead = (await c.eval('[...sessions.keys()]')).find(id => !before.has(id));
    if (!lead && Date.now() - lastNote > 30000) { lastNote = Date.now(); log('等建会话', await c.eval(`(() => { const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const buttons = [...document.querySelectorAll('button')].filter(vis).map(b => b.innerText.trim()).filter(Boolean);
      return { submit: document.querySelector('#new-session-submit')?.innerText || '(表单已关)', buttons: buttons.slice(-25) }; })()`).catch(e => String(e))); }
    // 账号默认模型在公司侧不可用时 Hub 会弹「换成它并创建」：和真实用户一样点它，并记下弹窗原文。
    if (!lead && !report.modelSwitch) {
      const confirm = await c.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换成它并创建' && x.getBoundingClientRect().width > 0);
        if (!b) return null; const box = b.closest('[role=dialog], .modal, .dialog, .confirm, section, div'); b.setAttribute('data-e2e-switch', '1');
        return (box?.parentElement?.innerText || box?.innerText || '').replace(/\s+/g, ' ').slice(0, 600); })()`).catch(() => null);
      if (confirm) { report.modelSwitch = confirm; log('模型确认弹窗', confirm); await shot('01b-model-confirm'); await click('[data-e2e-switch="1"]'); }
    }
    if (!lead) await sleep(1000);
  }
  if (!lead) report.afterSubmit = await c.eval(`(() => { const vis = e => e && e.getBoundingClientRect().width > 0;
    const modal = [...document.querySelectorAll('.modal, [role=dialog], #new-session-modal')].filter(vis).map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 1200));
    const alerts = [...document.querySelectorAll('[role=alert], .toast, .error, .new-session-error')].filter(vis).map(e => e.innerText.trim()).filter(Boolean).slice(0, 10);
    const btn = document.querySelector('#new-session-submit'); return { modal, alerts, submit: btn && { disabled: btn.disabled, text: btn.innerText, visible: vis(btn) }, sessions: [...sessions.keys()].length };
  })()`).catch(e => String(e));
  if (!check('负责人会话建出', !!lead, report.afterSubmit)) throw Error('负责人会话没建出');
  report.leadSid = lead;
  // 等 CodeAgent 输入框就绪
  const endReady = Date.now() + 240000;
  while (Date.now() < endReady && !new RegExp(READY).test(await screenText(lead))) await sleep(1500);
  check('CodeAgent 启动就绪', new RegExp(READY).test(await screenText(lead)));
  await c.eval(`selectSession(${j(lead)})`); await sleep(800);
  await c.eval(`typeof applyViewMode === 'function' && applyViewMode('card')`).catch(() => {});
  await sleep(800);

  // ② 输入框里打一句话，回车发送（真实键盘）
  const sentence = plain
    ? `组个两人小队帮我做：在 ${repo} 这个文件夹里，一人写 hello.py（运行后打印「你好，AI Hub」），另一人写 USAGE.md 说明怎么运行它；做完你验收后用一句话告诉我结果。`
    : `组个两人小队帮我做：在 ${repo} 这个 git 仓库里，一人写 hello.py（运行后打印「你好，AI Hub」），另一人写 USAGE.md 说明怎么运行它；成员各自在 Hub 建好的 worktree 里提交，做完你验收后用一句话告诉我结果。`;
  report.sentence = sentence;
  const box = `.floating-input-bar[data-session-id="${lead}"] .floating-input-box`;
  await until(`!!document.querySelector(${j(box)})`, '输入框', 30000);
  await click(box);
  await c.send('Input.insertText', { text: sentence });
  await sleep(500);
  await shot('02-typed-one-sentence');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  log('已发送一句话');

  // ③ 等负责人招人、成员出现在侧栏
  const teamOf = async () => ((await ipc('team:list')).result || []).find(t => t.leadSid === lead) || null;
  let team = null, sawMembers = false;
  const endTeam = Date.now() + 15 * 60000;
  while (Date.now() < endTeam) {
    team = await teamOf();
    if (team?.members?.filter(m => m.sid).length >= 2) { sawMembers = true; break; }
    await sleep(5000);
  }
  report.plans = team?.plans;
  if (!check('负责人一句话招到 ≥2 名成员（自动批准）', sawMembers, team && { plans: team.plans.map(p => ({ status: p.status, size: p.members.length })), members: team.members.map(m => ({ id: m.memberId, status: m.status, title: m.title })) })) {
    await shot('03-no-team'); throw Error('没招到人');
  }
  check('计划按规则自动批准', team.plans.some(p => p.status === 'approved'));
  const rowSel = `[data-sidebar-render-key="team:${lead}"] .session-item.child`;
  await until(`document.querySelectorAll(${j(rowSel)}).length >= 2`, '侧栏成员行', 60000);
  check('侧栏负责人下面出现成员行', true, await c.eval(`[...document.querySelectorAll(${j(rowSel)})].map(e => e.innerText.replace(/\\s+/g,' ').slice(0,60))`));
  await sleep(4000);
  await shot('03-sidebar-team');

  // worktree：Hub 替成员建好（读负责人视角的 status，经 hub-team 同一服务）
  const members = team.members.filter(m => m.sid);
  const sess = await c.eval(`${j(members.map(m => m.sid))}.map(id => ({ id, cwd: sessions.get(id)?.cwd || '' }))`);
  report.memberCwds = sess;
  if (plain) {
    // 普通文件夹没法建 worktree：成员要能开出来，工作目录存在（记下实际落在哪里，供判断是否合理）。
    check('非 git 目录：成员会话开出来、工作目录存在', sess.length >= 2 && sess.every(s => s.cwd && fs.existsSync(s.cwd)), sess);
  } else {
    const wtOk = sess.filter(s => s.cwd && fs.realpathSync.native(path.dirname(s.cwd)).toLowerCase() === fs.realpathSync.native(path.dirname(repo)).toLowerCase() && /-m\d+-/.test(path.basename(s.cwd)) && fs.existsSync(path.join(s.cwd, '.git')));
    check('成员开在 Hub 自动建的 worktree 里（仓库同级、独立分支）', wtOk.length >= 1, sess);
  }

  // ④ 点开一个成员看它在干活
  await click(rowSel);
  await sleep(6000);
  await shot('04-member-open');

  // ⑤ 等交付：成员交付或负责人汇总
  const endDone = Date.now() + waitMin * 60000;
  let delivered = 0;
  while (Date.now() < endDone) {
    team = await teamOf();
    delivered = (team?.members || []).filter(m => m.delivered).length;
    if (delivered >= 2) break;
    await sleep(15000);
  }
  report.delivered = delivered;
  check('成员交付（--deliver）', delivered >= 1, { delivered, members: (team?.members || []).map(m => ({ id: m.memberId, status: m.status, state: m.state, delivered: !!m.delivered })) });
  // 产物：各 worktree 里的提交
  if (plain) {
    // 产物：目标文件夹或成员工作目录里出现 hello.py / USAGE.md。
    const dirs = [...new Set([repo, ...sess.map(s => s.cwd).filter(Boolean)])];
    report.products = dirs.map(d => { try { return { dir: d, files: fs.readdirSync(d).filter(n => !n.startsWith('.')) }; } catch (e) { return { dir: d, error: e.message }; } });
    const has = name => report.products.some(p => (p.files || []).includes(name));
    check('非 git 目录：交付了 hello.py 和 USAGE.md', has('hello.py') && has('USAGE.md'), report.products);
  } else {
    report.commits = sess.map(s => { try { return { cwd: s.cwd, log: execFileSync('git', ['log', '--oneline', '-3'], { cwd: s.cwd, windowsHide: true }).toString().trim(), files: fs.readdirSync(s.cwd).filter(n => !n.startsWith('.')) }; } catch (e) { return { cwd: s.cwd, error: e.message }; } });
    check('worktree 里有成员的提交', report.commits.some(x => x.log && x.log.split('\n').length >= 2), report.commits);
  }
  await c.eval(`selectSession(${j(lead)})`); await sleep(20000);
  await shot('05-lead-after-delivery');
  report.leadText = (await c.eval(`(document.querySelector('#msg-overlay')?.innerText || '').slice(-1500)`).catch(() => ''));
  report.passed = report.checks.every(x => x.ok);
}

main().catch(error => { report.error = String(error.stack || error); console.error(error); })
  .finally(async () => {
    try { if (c && !report.screenshots.some(f => /final/.test(f))) await shot('99-final'); } catch {}
    report.realCacUnchanged = hash(path.join(os.homedir(), '.cac', 'settings.json')) === report.realCacSettingsHash
      && hash(path.join(os.homedir(), '.cac', '.credentials.json')) === report.realCacCredHash;
    report.realCacFieldsAfter = cacFields();
    report.realCacChangedKeys = Object.keys({ ...(report.realCacFieldsBefore || {}), ...(report.realCacFieldsAfter || {}) })
      .filter(k => (report.realCacFieldsBefore || {})[k] !== (report.realCacFieldsAfter || {})[k]);
    try { if (hub) fs.writeFileSync(path.join(out, 'hub-main.log'), hub.log().join(String.fromCharCode(10))); } catch {}
    report.finishedAt = new Date().toISOString(); save();
    try { if (hub) await gracefulQuit(hub); } catch {}
    console.log('REPORT ' + path.join(out, 'report.json'));
    process.exit(report.passed ? 0 : 1);
  });
