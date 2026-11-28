'use strict';
// 真机压测：一键反馈（2026-11-28）。在公司电脑上用安装版 Hub 程序跑隔离实例 + 假 welink-cli（只把参数记到文件，不发任何消息）。
// 走同事的真实路径：设置菜单 → 一键反馈 → 写描述 → 点「一键发到 WeLink」，看成功提示；
// 再把假 CLI 切成「发送失败」「卡住超时」看失败提示与待发/保存说明；连点两下只发一次；「我的反馈」里能看到记录。
// 不点「复制」类按钮（会写系统剪贴板、打开 WeLink），不碰真实 WeLink。
//   HUB_TEST_ELECTRON_EXE=<AI Hub Community.exe>，以 ELECTRON_RUN_AS_NODE=1 运行：node tests/e2e-company-feedback-real.js [--port 19602]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { MAINTAINER_WELINK } = require('../core/hub-feedback-welink');
delete process.env.ELECTRON_RUN_AS_NODE;
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]) || 19602;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hubsess-feedback-'));
const rootFile = argv.indexOf('--root-file') >= 0 ? argv[argv.indexOf('--root-file') + 1] : null;
if (rootFile) fs.writeFileSync(rootFile, root);
const out = path.join(root, 'out'); fs.mkdirSync(out, { recursive: true });
const report = { root, checks: [], screenshots: [], texts: {}, passed: false };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); console.log((ok ? '通过 ' : '失败 ') + name, detail === undefined ? '' : JSON.stringify(detail)); save(); return !!ok; };

async function main() {
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  for (const p of [home, dataDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(p, { recursive: true });
  const callLog = path.join(root, 'welink-calls.jsonl'), modeFile = path.join(root, 'mode.txt'), fakeCli = path.join(root, 'welink-cli-fake.js');
  fs.writeFileSync(modeFile, 'normal');
  fs.writeFileSync(callLog, '');
  // normal：发送成功；fail：服务端报错；hang：卡住不返回（看超时提示）。
  fs.writeFileSync(fakeCli, `const fs=require('fs'),a=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');fs.appendFileSync(${JSON.stringify(callLog)},JSON.stringify(a)+'\\n');
if(a[0]==='auth'){console.log('User Token:   valid\\nUID: fixture-colleague');}
else if(mode==='hang'){setTimeout(()=>{},120000);}
else if(mode==='fail'){console.log(JSON.stringify({code:500,message:'server busy'}));process.exitCode=1;}
else console.log(JSON.stringify({code:0,data:{msgId:'1'}}));`);
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const extraEnv = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '',
    CLAUDE_HUB_WELINK_CLI: fakeCli, [pathKey]: [system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'none', name: '测试不更新', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/v{version}/' }]) };
  for (const provider of ['CODEX', 'CLAUDE', 'KIMI', 'GEMINI']) extraEnv[`HUB_SESSION_SEARCH_${provider}_ROOTS`] = path.join(root, 'empty');
  const sends = () => fs.readFileSync(callLog, 'utf8').split('\n').filter(l => l.includes('send-to-user')).map(l => JSON.parse(l));
  let hub, cdp;
  const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await cdp.eval(expr)) return true; } catch {} await sleep(200); } throw Error('超时：' + label); };
  const click = async sel => {
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('找不到 '+${JSON.stringify(sel)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('看不见 '+${JSON.stringify(sel)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  };
  const shot = async name => { const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }); const f = path.join(out, name + '.jpg'); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); report.screenshots.push(f); };
  const msg = () => cdp.eval('document.querySelector("[data-hf=msg]")?.textContent || ""');
  const typeDesc = async text => {
    await click('[data-hf="desc"]');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send('Input.insertText', { text });
  };
  const openDialog = async () => {
    if (!await cdp.eval('!!document.querySelector(".hub-feedback-dialog")?.open')) { await click('#btn-options'); await click('#options-feedback'); }
    await until('document.querySelector(".hub-feedback-dialog")?.open', '反馈弹窗');
    await until('!document.querySelector("[data-hf=wl-send]").hidden', 'WeLink 发送按钮', 20000);
  };
  try {
    hub = await launchIsolatedHub({ dataDir, port, label: 'feedback-real', extraEnv, windowMode: 'hidden' });
    report.pid = hub.pid;
    // 办公电脑上冷启动慢：主界面页最多等约 2 分钟。
    for (let i = 0; !cdp; i++) {
      try { cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url), { waitMainMs: 15000 }); }
      catch (error) { if (i >= 8) throw error; await sleep(3000); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("options-feedback") && !!window.__hubFeedback', '反馈菜单', 120000);
    report.hubVersion = await cdp.eval(`require('../package.json').version`).catch(() => null);
    await openDialog();
    const ui = await cdp.eval(`(()=>{const q=n=>document.querySelector('[data-hf="'+n+'"]');return {to:q('to')?.textContent,auto:q('wl-send')?.textContent,copy:q('wl-copy')?.textContent,dialog:document.querySelector('.hub-feedback-dialog').innerText.replace(/\\s+/g,' ').slice(0,600)};})()`);
    report.texts.dialog = ui;
    check('弹窗写明发给维护人 WeLink 账号', String(ui.to || '').includes(MAINTAINER_WELINK), ui.to);
    await shot('fb-1-dialog');

    // ① 成功
    await typeDesc('压测：CodeAgent 会话首句被挡回（隔离实例，假 welink-cli，不发真实消息）');
    let t = Date.now();
    await click('[data-hf="wl-send"]');
    await until('/已发到/.test(document.querySelector("[data-hf=msg]").textContent)', '成功提示', 40000).catch(() => {});
    report.texts.ok = await msg();
    const s1 = sends();
    check('① 点「一键发到 WeLink」后提示已发送', /已发到/.test(report.texts.ok), { ms: Date.now() - t, text: report.texts.ok });
    check('① 假 CLI 收到一条发给维护人的私聊命令，正文含描述', s1.length === 1 && s1[0][3] === MAINTAINER_WELINK && /首句被挡回/.test(s1[0][5] || ''), { n: s1.length, len: (s1[0] || [])[5]?.length });
    await shot('fb-2-sent');

    // ② 服务端失败
    fs.writeFileSync(modeFile, 'fail');
    await openDialog();
    await typeDesc('压测：发送失败场景');
    t = Date.now();
    await click('[data-hf="wl-send"]');
    await sleep(1500);
    const endFail = Date.now() + 45000; let failText = '';
    while (Date.now() < endFail) { failText = await msg(); if (failText && !/正在|发送中/.test(failText)) break; await sleep(500); }
    report.texts.fail = failText;
    check('② 发送失败有一行说明（不是空白、不是原样 JSON），并说明内容没丢', !!failText && !/[{}]|undefined|\[object/.test(failText) && /失败|没发出|未发出|没能/.test(failText), { ms: Date.now() - t, text: failText });
    await shot('fb-3-fail');

    // ③ 卡住超时
    fs.writeFileSync(modeFile, 'hang');
    await openDialog();
    await typeDesc('压测：WeLink 卡住场景');
    t = Date.now();
    await click('[data-hf="wl-send"]');
    const endHang = Date.now() + 70000; let hangText = '';
    while (Date.now() < endHang) { hangText = await msg(); if (hangText && !/正在|发送中/.test(hangText)) break; await sleep(1000); }
    report.texts.hang = hangText;
    check('③ WeLink 卡住时 60 秒内给出结论（不无限转圈）', !!hangText && !/正在|发送中/.test(hangText), { ms: Date.now() - t, text: hangText });
    await shot('fb-4-hang');

    // ④ 连点两下只发一次
    fs.writeFileSync(modeFile, 'normal');
    await openDialog();
    await typeDesc('压测：连点两下');
    const before = sends().length;
    await click('[data-hf="wl-send"]'); await click('[data-hf="wl-send"]').catch(() => {});
    await sleep(8000);
    report.texts.double = await msg();
    check('④ 连点两下只发出一条', sends().length - before === 1, { added: sends().length - before, text: report.texts.double });

    // ⑤ 我的反馈
    if (await cdp.eval('!!document.querySelector(".hub-feedback-dialog")?.open')) await click('[data-hf="cancel"]').catch(() => {});
    await click('#btn-options'); await click('#options-feedback-mine');
    await sleep(3000);
    report.texts.mine = await cdp.eval('(document.querySelector("#hub-feedback-mine")?.innerText || "").replace(/\\s+/g, " ").slice(0, 800)');
    check('⑤ 「我的反馈」能看到已发记录', /已发到维护人/.test(report.texts.mine), report.texts.mine);
    await shot('fb-5-mine');
    report.passed = report.checks.every(c => c.ok);
  } catch (error) {
    report.error = String(error.stack || error);
    if (cdp) await shot('fb-failure').catch(() => {});
  } finally {
    report.sendsTotal = (() => { try { return sends().length; } catch { return null; } })();
    // 隔离 Hub 没能正常退出算失败（E2E_INJECT_QUIT_FAIL=1 可注入，自测用）。
    if (hub) {
      try {
        if (process.env.E2E_INJECT_QUIT_FAIL === '1') { await gracefulQuit(hub).catch(() => {}); throw Error('注入的退出失败'); }
        report.teardown = await gracefulQuit(hub);
      } catch (e) { report.teardownError = String(e.message || e); check('隔离 Hub 正常退出', false, report.teardownError); }
    }
    report.passed = !report.error && report.checks.length > 0 && report.checks.every(c => c.ok);
    save();
    console.log('REPORT ' + path.join(out, 'report.json'));
    process.exit(report.passed ? 0 : 1);
  }
}
main();
