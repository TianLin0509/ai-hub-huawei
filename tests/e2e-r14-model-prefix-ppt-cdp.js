'use strict';
// 隔离 Hub + 模拟 CodeAgent/旧 Doctor；鼠标键盘验证，不连接公司模型、不下载组件。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts/20261123-r14-model-prefix-codex/gui'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const GLM = 'glm-5.3-flash', DS = 'deepseek-v4.1-flash';
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal'), legacy = path.join(root, 'doctor/PPT-Doctor.exe');
  const project = path.join(work, 'model-prefix');
  for (const dir of [OUT, data, project, personal, path.dirname(legacy), path.join(data, 'company-assistant')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: GLM }));
  fs.writeFileSync(legacy, '旧版程序夹具，不可执行');
  fs.writeFileSync(path.join(path.dirname(legacy), 'manifest.json'), JSON.stringify({ version: '1.8.2' }));
  fs.writeFileSync(path.join(data, 'company-assistant/settings.json'), JSON.stringify({ enabled: false, ppt: {} }));
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const answer = path.join(root, 'answer.txt'), command = path.join(root, 'codeagent.cmd'), router = path.join(root, 'router.cjs');
  fs.writeFileSync(answer, GLM);
  fs.writeFileSync(router, `require(${JSON.stringify(path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${router}" %*\r\n`);
  const report = { provenance: '隔离 Hub/CDP 鼠标键盘 + 模拟 CLI/旧 Doctor；升级安装 IPC 由夹具代替', checks: [] };
  let hub, c;
  const until = async (expression, label, timeout = 45000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await c.eval(expression)) return; await sleep(180); }
    throw new Error('等待超时：' + label);
  };
  const check = (label, value = true) => { assert.ok(value, label); report.checks.push(label); console.log('通过：' + label); };
  const invoke = (name, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(name)}, ${JSON.stringify(payload)})`);
  const click = async selector => {
    const xy = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('未找到按钮');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
  const send = async (id, text) => {
    await click(`.floating-input-bar[data-session-id="${id}"] .floating-input-box`);
    await c.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'r14-model-prefix', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_SERVE: '1',
      CODEAGENT_POOL_FAKE_MODELS: [GLM, DS].join(','), CODEAGENT_POOL_FAKE_MENU_MODELS: [GLM, DS].map(m => 'ascend/' + m).join(','),
      CODEAGENT_POOL_FAKE_HELP_SETTINGS: '1', CODEAGENT_POOL_FAKE_MENU_SELECT: '1', CODEAGENT_POOL_FAKE_ANSWER_MODEL_FILE: answer,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0',
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', PPT_DOCTOR_EXE: legacy,
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof selectSession === 'function'`, '会话界面');
    await invoke('codeagent-pool:probe', { id: 'personal' });
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: project, title: '前缀模型验收', codeagentAccount: 'personal', model: GLM, codeagentModelPick: true } });
    assert.ok(created?.id); const id = created.id;
    await c.eval(`selectSession(${JSON.stringify(id)})`);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .composer-model')`, '模型入口');
    await sleep(1800);
    await click(`.floating-input-bar[data-session-id="${id}"] .composer-model`);
    await until(`document.querySelectorAll('.model-picker-item[data-model-id]').length===2`, '读取两个模型');
    check('手动会话的模型没有全部灰显', await c.eval(`[...document.querySelectorAll('.model-picker-item[data-model-id]')].every(e=>!e.classList.contains('disabled'))`));
    await click(`.model-picker-item[data-model-id="${DS}"]`);
    await until(`sessions.get(${JSON.stringify(id)})?.currentModel?.id===${JSON.stringify(DS)} && !sessions.get(${JSON.stringify(id)})._modelSwitchPending`, '前台切换带前缀的菜单项');
    check('前台短名称成功选中 ascend 菜单项');
    await send(id, '切换后验证');
    await until(`sessions.get(${JSON.stringify(id)})?.codeagentActualModel===${JSON.stringify('ascend/' + DS)}`, '回答记录确认');
    check('会话记录确认实际使用带前缀模型');
    check('等价前缀不会误报模型切换失败', !fs.readFileSync(path.join(data, 'logs/codeagent-model.log'), 'utf8').includes('event=switch-mismatch'));
    await shot('20261123-r14-front-switch');
    const type = data => c.eval(`require('electron').ipcRenderer.send('terminal-input',${JSON.stringify({ sessionId: id, data })})`);
    await type('/model'); await sleep(200); await type('\r'); await sleep(500); await type('\r'); await sleep(800);
    await send(id, '后台切换后验证');
    await until(`sessions.get(${JSON.stringify(id)})?.codeagentActualModel===${JSON.stringify('ascend/' + GLM)}`, '后台实际模型');
    await until(`sessions.get(${JSON.stringify(id)})?.currentModel?.id===${JSON.stringify(GLM)}`, '前台显示同步');
    check('后台切模型后前台与恢复使用的模型同步', (await c.eval(`sessions.get(${JSON.stringify(id)}).fixedModel`)) === GLM);
    await shot('20261123-r14-backstage-switch');
    await click('#btn-company-ppt');
    await until(`document.querySelector('[data-ppt-status]')?.dataset.state==='upgrade'`, '旧版提示');
    check('旧版版本号与升级入口同处一行', await c.eval(`(()=>{const e=document.querySelector('[data-ppt-status]');return e.textContent.includes('检测到旧版 1.8.2，需升级')&&!e.classList.contains('pptw-guide')&&e.getBoundingClientRect().height<70})()`));
    check('详细说明收进信息图标', await c.eval(`document.querySelector('[data-ppt-status] [aria-label="升级说明"]')?.title.includes('版本太旧')`));
    for (const tab of ['find', 'map', 'materials', 'make']) {
      await click(`[data-ppt-tab="${tab}"]`); await sleep(250);
      check(`PPT ${tab} 页签升级入口可见`, await c.eval(`(()=>{const b=document.querySelector('[data-ppt-status] [data-ppt="doctor-install"]');const r=b.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`));
      if (tab === 'map') check('旧 Doctor 不触发库地图扫描或重复的长错误', await c.eval(`document.querySelector('[data-pptg-guide]').textContent==='库地图暂不可用' && document.querySelector('[data-pptg-status]').textContent===''`));
      await shot('20261123-r14-ppt-' + tab);
    }
    await c.eval(`(()=>{const ipc=require('electron').ipcRenderer,original=ipc.invoke.bind(ipc);window.r14UpgradeClicks=0;ipc.invoke=(name,...args)=>name==='components:doctor-install'?(window.r14UpgradeClicks++,Promise.resolve({ok:false,error:'升级入口验收，不下载组件'})):original(name,...args)})()`);
    await click('[data-ppt-status] [data-ppt="doctor-install"]');
    await until(`window.r14UpgradeClicks===1`, '升级按钮');
    check('一键升级按钮确实进入原有安装闭环');
    report.passed = true;
  } catch (error) { report.error = error.stack; if (c) await shot('20261123-r14-failure').catch(() => {}); throw error; }
  finally {
    if (c) await c.close().catch(() => {});
    if (hub) { await gracefulQuit(hub); fs.writeFileSync(path.join(OUT, '20261123-r14-hub.log'), hub.log().join('\n')); }
    fs.writeFileSync(path.join(OUT, '20261123-r14-evidence.json'), JSON.stringify(report, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: !!report.passed, checks: report.checks.length, error: report.error?.split('\n')[0] }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
