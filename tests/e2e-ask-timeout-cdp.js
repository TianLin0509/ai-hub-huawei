'use strict';
// 隔离 GUI 验收：真实抽屉 + IPC + 后台 CLI 替身；鼠标提问、排队、超时、取消与重试。
// 不启动完整业务环境、不调用模型、不接触生产 Hub；时限缩短以复现故障。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ask-timeout-gui-'));
  const out = path.join(repo, 'artifacts/20261123-ask-timeout-codex'); fs.mkdirSync(out, { recursive: true });
  const cli = path.join(root, 'fixture-cli.js'), cmd = path.join(root, 'fixture.cmd');
  fs.writeFileSync(cli, `
    const fs=require('node:fs'),path=require('node:path'); let input='';
    process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
      const scenario=input.includes('timeout')?'timeout':input.includes('cancel')?'cancel':'';
      const mark=path.join(${JSON.stringify(root)},scenario+'.json');
      if(scenario&&!fs.existsSync(mark)){
        const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
        fs.writeFileSync(mark,JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);
      }else process.stdout.write('测试回答：'+input.split('问题：').pop());
    });`);
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const entry = path.join(root, 'fixture-main.js'), html = path.join(root, 'fixture.html');
  fs.writeFileSync(entry, `
    const {app,BrowserWindow,ipcMain}=require('electron');
    const {prepareBackgroundChromium,keepWindowInBackground}=require(${JSON.stringify(path.join(repo, 'core/e2e-desktop-sandbox'))});
    prepareBackgroundChromium(app);
    app.setPath('userData',${JSON.stringify(path.join(root, 'data/electron-userdata'))});
    const {createAskAsideService,registerAskAsideIpc}=require(${JSON.stringify(path.join(repo, 'main/ask-aside/service'))});
    let win,service;
    app.whenReady().then(()=>{
      service=createAskAsideService({sessionManager:{getSession:()=>({kind:'codeagent',cwd:${JSON.stringify(root)},ccSessionId:'11111111-1111-4111-8111-111111111111'})},
        getHubDataDir:()=>${JSON.stringify(path.join(root, 'data'))},resolveConfig:()=>({command:${JSON.stringify(cmd)},configDir:${JSON.stringify(root)}}),
        hasHistory:()=>true,idleMs:2000,timeoutMs:10000,sendToRenderer:(c,p)=>win?.webContents.send(c,p)});
      registerAskAsideIpc(ipcMain,service);
      win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false}});
      keepWindowInBackground(win);win.showInactive();
      win.loadFile(${JSON.stringify(html)});
    });
    app.on('window-all-closed',()=>{service?.dispose().finally(()=>app.quit())});
  `);
  fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
    <link rel="stylesheet" href="${pathToFileURL(path.join(repo, 'renderer/styles/hw-tokens.css')).href}">
    <link rel="stylesheet" href="${pathToFileURL(path.join(repo, 'renderer/styles/ask-aside.css')).href}">
    <style>body{font:14px 'Microsoft YaHei';margin:24px;background:#f4f5f7}#terminal-panel{height:800px}#toolbar-actions{height:40px}</style>
    <div id="terminal-panel"><div id="toolbar-actions"></div><p>模拟主会话：旁问取消时这里继续运行。</p></div>
    <script>const {ipcRenderer}=require('electron');
    window.ui=require(${JSON.stringify(path.join(repo, 'renderer/ask-aside-ui'))}).createAskAsideUi({document,ipcRenderer,getSession:()=>({id:'s',kind:'codeagent',title:'故障恢复验收'})});
    ui.sync(true);</script></html>`);
  let hub, c; const report = { checks: [], modelUsed: false, root };
  const wait = async (expr, label) => {
    for (const end = Date.now() + 15000; Date.now() < end;) { if (await c.eval(expr)) return; await sleep(50); }
    throw new Error('等待失败：' + label);
  };
  const click = async selector => {
    const point = await c.eval(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('按钮不可用');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
  const ask = async question => {
    await click('.ask textarea'); await c.send('Input.insertText', { text: question });
    await click('.ask-f .btn-pri');
  };
  const shot = async name => fs.writeFileSync(path.join(out, `20261123-ask-timeout-codex-${name}.png`), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const checkPids = async scenario => {
    const ids = JSON.parse(fs.readFileSync(path.join(root, scenario + '.json'), 'utf8'));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && ids.some(alive); i++) await sleep(50);
    assert.deepEqual(ids.map(alive), [false, false]);
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), entryPath: entry, port: await freePort(), windowMode: 'background', label: 'ask-timeout-gui' });
    c = await connectFirstPage(hub, target => target.type === 'page');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('!!window.ui', '抽屉就绪'); await click('.ask-entry');
    await ask('timeout 第一题'); await ask('第二题自动继续');
    await wait(`document.querySelectorAll('.ask-qa[data-status="queued"]').length===1`, '第二题排队'); await shot('queued');
    await wait(`document.querySelector('.ask-qa[data-status="error"] [data-ask-action="retry"]')&&document.querySelector('.ask-qa[data-status="done"]')`, '超时后第二题完成');
    assert.match(await c.eval(`document.querySelector('.ask-b').textContent`), /无新输出/);
    await shot('timeout'); await checkPids('timeout'); report.checks.push('超时停止转圈、显示原因与重试/取消，第二题自动完成，进程树退出');
    // 错误恢复草稿沿用原行为；点重试应只发送原问题一次。
    await click('[data-ask-action="retry"]');
    await wait(`document.querySelectorAll('.ask-qa[data-status="done"]').length===2`, '重试完成');
    report.checks.push('点击重试，原问题重新发出并收到答案');
    await ask('cancel 第四题'); await ask('第五题自动继续');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(root, 'cancel.json')); i++) await sleep(20);
    await wait(`document.querySelector('.ask-qa[data-status="running"] [data-ask-action="cancel"]')`, '运行中可取消');
    await click('.ask-qa[data-status="running"] [data-ask-action="cancel"]');
    await wait(`document.querySelectorAll('.ask-qa[data-status="done"]').length===3`, '取消后第五题完成');
    assert.equal(await c.eval(`document.querySelector('.ask textarea').value`), '', '主动取消不把已放弃的问题再次塞回输入框');
    await checkPids('cancel'); await shot('cancel');
    report.checks.push('点击取消后第五题自动完成，旧进程树退出，主会话保留');
    assert.equal(await c.eval(`document.documentElement.scrollWidth>innerWidth`), false);
    report.passed = true;
  } finally {
    if (c) await c.close();
    if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261123-ask-timeout-codex-gui.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
