'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
async function main() {
  const output = path.resolve(process.argv[2] || 'artifacts/20261123-agentcenter-cdp');
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-market-cdp-'));
  const home = path.join(root, 'home with space'), config = path.join(home, '.cac'), data = path.join(root, 'data');
  const marketDir = path.join(config, 'plugins', 'marketplaces', 'aimarket', '.cac-plugin');
  fs.mkdirSync(marketDir, { recursive: true });
  const manifest = path.join(marketDir, 'marketplace.json');
  fs.writeFileSync(manifest, JSON.stringify({ skills: Array.from({ length: 18 }, (_, i) => ({
    name: 'market-skill-' + String(i + 1).padStart(2, '0'), version: '1.2.0', description: '按团队流程整理材料，生成可复核的工作简报。', author: { name: '团队市场' },
  })), plugins: [{ name: 'team-toolbox', version: '2.0', description: '团队技能与工具合集', author: '工程团队' }],
    mcps: [{ name: 'company-search', version: '1.0', description: '检索公司内网知识', author: '知识平台' }] }));
  const fake = path.join(root, 'fake-cli.cjs'), command = path.join(root, 'codeagent.cmd');
  fs.writeFileSync(fake, `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('1.2615.02.05');process.exit(0);}
if(a.includes('--help')){console.log('Usage: codeagent [options]\\n--model --disable-update --effort');process.exit(0);}
const dir=process.env.CODEAGENT3_CONFIG_DIR;
if(a[0]!=='skills'||a[1]!=='add'){console.error('unsupported fake operation');process.exit(2);}
const once=path.join(dir,'fail-once');if(fs.existsSync(once)){fs.unlinkSync(once);console.error('ECONNREFUSED company network');process.exit(8);}
const p=path.join(dir,'skills',a[2]);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'SKILL.md'),'---\\nname: '+a[2]+'\\ndescription: 市场假 CLI 安装验证\\n---\\n');console.log('installed');`);
  fs.writeFileSync(command, '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n');
  const checks = [], report = { simulatedCli: true, realCompanyNetworkTested: false, checks };
  let hub, cdp;
  const until = async (expression, label) => {
    for (const end = Date.now() + 30000; Date.now() < end;) {
      if (await cdp.eval(expression)) return;await sleep(150);
    }
    throw Error('等待超时：' + label);
  };
  const click = async selector => {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('找不到按钮');const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('按钮不可见');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
  const search = async value => {
    await click('#cp-market-search');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp.send('Input.insertText', { text: value });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'agentcenter', extraEnv: {
      USERPROFILE: home, HOME: home, CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1',
      AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: config,
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    } });
    cdp = await connectFirstPage(hub, null, { waitMainMs: 15000 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('window.hubWorkspaces && document.querySelector("#scene-rail")?.dataset.railGroupsInstalled === "true"', '导航事件接线完成');
    await until('document.querySelector("#btn-rail-group-rules")?.getBoundingClientRect().width > 0', '规则分组入口');
    const groupPoint=await cdp.eval('(()=>{const r=document.querySelector("#btn-rail-group-rules").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...groupPoint});
    await until('document.querySelector("#btn-rail-capabilities")?.getBoundingClientRect().width > 0', '分组中的资源入口');
    await click('#btn-rail-capabilities');
    await until('document.querySelector("[data-cp-tab=market]")', 'AI 市场页签');
    await click('[data-cp-tab=market]');
    await until('document.querySelectorAll(".cp-market-row").length > 0', '读取本机市场');
    const before = await cdp.eval('document.querySelector(".cp-market-pagination span").textContent');
    await click('[data-cp-market-page="1"]');
    const after = await cdp.eval('document.querySelector(".cp-market-pagination span").textContent');
    assert.notEqual(before, after);checks.push('真实点击分页成功，市场共 20 个假条目');
    await search('market-skill-01');
    await until('document.querySelectorAll(".cp-market-row").length === 1', '市场搜索');
    fs.writeFileSync(path.join(config, 'fail-once'), '1');
    await click('[data-cp-install="skill:market-skill-01"]');
    await until('document.querySelector("[data-cp-install]")?.textContent === "重试"', '失败与重试按钮');
    assert.match(await cdp.eval('document.querySelector(".cp-market-action").textContent'), /公司内网连接失败/);
    checks.push('假 CLI 非零退出后，条目旁显示公司内网失败原因和重试');
    await click('[data-cp-install="skill:market-skill-01"]');
    await until('document.querySelector("[data-cp-install]")?.textContent === "已安装"', '重试安装成功');
    assert.equal(await cdp.eval('document.querySelector(".cp-market-action small")'), null);
    const installedPoint=await cdp.eval('(()=>{const r=document.querySelector("[data-cp-install]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...installedPoint});
    await until('[...document.querySelectorAll(".hub-tip:not([hidden])")].some(e=>e.textContent.includes("新开 CodeAgent 会话"))', '已安装按钮悬停说明');
    checks.push('安装成功说明仅在已安装按钮悬停时显示，不占列表高度');
    checks.push('真实鼠标重试成功，读回 SKILL.md 后按钮变为已安装');
    await click('[data-cp-tab=catalog]');
    await until('document.querySelector("#capability-page")?.textContent.includes("market-skill-01")', '能力库刷新');
    checks.push('切回能力库，已出现刚安装的 CodeAgent 技能');
    await click('[data-cp-tab=market]');
    await until('document.querySelector("[data-cp-install]")?.textContent === "已安装"', '保留已装状态');
    await until('!document.querySelector("#capability-page .cp-progress")', '市场刷新完成后测量分页');
    await search('market-skill-');
    const layout = await cdp.eval(`(()=>{const e=document.querySelector('#capability-page .cp-scroll');const rows=[...document.querySelectorAll('.cp-market-row')];const foot=document.querySelector('.cp-market-pagination').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,rows:rows.length,lastRowBottom:rows.at(-1).getBoundingClientRect().bottom,paginationTop:foot.top,paginationBottom:foot.bottom};})()`);
    assert.ok(layout.scrollHeight <= layout.clientHeight + 1, JSON.stringify(layout));
    assert.ok(layout.lastRowBottom <= layout.paginationTop + 1, JSON.stringify(layout));
    assert.ok(layout.paginationBottom <= 900, JSON.stringify(layout));report.layout = layout;
    assert.ok(layout.rows>=7&&layout.rows<=8,'1440×900 每页应显示 7–8 条：'+JSON.stringify(layout));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:700,deviceScaleFactor:1,mobile:false});
    await until(`document.querySelectorAll('.cp-market-row').length < ${layout.rows}`, '窗口缩小时重新分页');
    report.shortWindowRows=await cdp.eval('document.querySelectorAll(".cp-market-row").length');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await until(`document.querySelectorAll('.cp-market-row').length === ${layout.rows}`, '恢复窗口时重新分页');
    checks.push('1440×900 每页 7–8 条；窗口缩小与恢复都按列表实际高度重新分页');
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(output, '20261123-agentcenter-1440x900-codex.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));report.screenshot = screenshotPath;
    checks.push('1440×900 主市场列表与分页同屏，无纵向滚动');
    fs.renameSync(manifest, manifest + '.disabled');
    await click('[data-cp-action=refresh]');
    await until('document.querySelector("#capability-page")?.textContent.includes("还没有 AI 市场副本")', '缺失市场说明');
    checks.push('无市场副本时在原页给出下一步，无报错弹窗');
    await click('[data-cp-action=market-by-id]');
    await click('#cp-market-id');await cdp.send('Input.insertText',{text:'from-agentcenter'});
    fs.writeFileSync(path.join(config,'fail-once'),'1');
    await click('#cp-market-id-form button[type=submit]');
    await until('document.querySelector("#cp-market-id-form button[type=submit]")?.textContent === "重试"','按 ID 安装失败提示');
    assert.match(await cdp.eval('document.querySelector(".cp-market-id-result").textContent'),/公司内网/);
    await click('#cp-market-id-form button[type=submit]');
    await until('document.querySelector("#cp-market-id-form button[type=submit]")?.textContent === "安装" && document.querySelector(".cp-market-id-result")?.textContent.includes("已安装")','按 ID 重试安装未收录条目');
    assert.ok(fs.existsSync(path.join(config,'skills','from-agentcenter','SKILL.md')));
    checks.push('无市场副本时真实点击按 ID 安装，失败重试后新条目落地');
    await click('[data-cp-tab=catalog]');
    await until('document.querySelector("#capability-page")?.textContent.includes("from-agentcenter")','按 ID 安装后刷新能力库');
    await click('[data-cp-tab=market]');await until('!document.querySelector("#capability-page .cp-progress")','返回市场');
    // 两个已装插件模拟黄区真实副本，不连接真实公司账号。
    const pluginNames=['codebase-win','developer-test-agent'];
    for(const name of pluginNames){const p=path.join(config,'plugins','cache','aimarket',name,'1','.cac-plugin');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'plugin.json'),JSON.stringify({name}));}
    fs.writeFileSync(path.join(config,'settings.json'),JSON.stringify({enabledPlugins:Object.fromEntries(pluginNames.map(name=>[name+'@aimarket',true]))}));
    fs.writeFileSync(manifest,JSON.stringify({plugins:pluginNames.map(name=>({name,version:'1.0',description:'模拟黄区已经安装的插件',author:'团队市场'}))}));
    // 清空此前的搜索条件，再刷新本机副本。
    await click('#cp-market-search');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',windowsVirtualKeyCode:8});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',windowsVirtualKeyCode:8});
    await click('[data-cp-action=refresh]');
    await until('document.querySelectorAll(".cp-market-row").length === 2 && !document.querySelector("#capability-page .cp-progress")','两个已装插件副本');
    assert.match(await cdp.eval('document.querySelector(".cp-market-source-hint").textContent'),/本机市场副本只有已装条目/);
    checks.push('两个条目全部已装时给出打开 AgentCenter、复制 ID 安装的就地提示');
    // 只截获外链提交，避免验收在用户桌面弹出系统浏览器。
    await cdp.eval('window.__marketOriginalInvoke=ipcRenderer.invoke;window.__marketOpenedUrl=null;ipcRenderer.invoke=function(channel,...args){if(channel==="open-external-url"){window.__marketOpenedUrl=args[0];return Promise.resolve({success:true});}return window.__marketOriginalInvoke.call(this,channel,...args);};true');
    await click('[data-cp-action=market-browse]');
    assert.equal(await cdp.eval('window.__marketOpenedUrl'),new URL(require('../renderer/codeagent-setup').OFFICIAL_INSTALL_URL).origin);
    await cdp.eval('ipcRenderer.invoke=window.__marketOriginalInvoke;delete window.__marketOriginalInvoke;true');
    checks.push('打开 AgentCenter 按钮提交正确外链（浏览器调用已截获，未启动真实系统浏览器）');
    report.byIdLayout=await cdp.eval('(()=>{const e=document.querySelector("#capability-page .cp-scroll");return{scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,formVisible:!!document.querySelector("#cp-market-id-form"),rows:document.querySelectorAll(".cp-market-row").length};})()');
    assert.ok(report.byIdLayout.scrollHeight<=report.byIdLayout.clientHeight+1,JSON.stringify(report.byIdLayout));
    const byIdShot=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(screenshotPath,Buffer.from(byIdShot.data,'base64'));
    report.ok = true;
  } catch (error) {
    report.ok = false;report.error = error.stack;
    if(cdp){
      report.ui=await cdp.eval('document.body.innerText.slice(0,1200)').catch(()=>null);
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'}).catch(()=>null);
      if(shot)fs.writeFileSync(path.join(output,'20261123-agentcenter-gui-失败-codex.png'),Buffer.from(shot.data,'base64'));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, '20261123-agentcenter-gui-codex.json'), JSON.stringify(report, null, 2));
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack);process.exitCode = 1; });
