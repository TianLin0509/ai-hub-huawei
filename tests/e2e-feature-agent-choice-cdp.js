'use strict';
// 隔离真实 Electron、鼠标键盘操作、模拟 CLI；不访问真实模型，不更改生产账号。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(process.env.R13_OUTPUT || 'D:/AIWork/20261120-hubh-weekend-rsi-lead-claude/r13');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-agent-gui-r13-')), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ models: { defaults: { codeagent: 'fixture-next' } } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  require('../core/codeagent-models').recordMenu(data, ['GLM-5.2-WX-Auto', 'fixture-auth-failure', 'fixture-model-denied', 'fixture-next'], { complete: true });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const result = { ok: false, checks: [], shots: [], fixture: '全新隔离 Hub 数据、真实 Electron 与鼠标键盘、模拟 CLI，不验证供应商网络或账号权限' };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', label: 'feature-agent-r13', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_CODEAGENT_COMMAND: path.resolve('tests/fixtures/help-ask-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async expression => { for (let i = 0; i < 150; i++) { const value = await c.eval(expression); if (value) return value; await sleep(200); } throw Error('等待失败：' + expression); };
    const click = async selector => {
      const xy = await wait(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e||e.disabled) return null; const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, hit=document.elementFromPoint(x,y); return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const key = async key => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: { Home: 36, ArrowDown: 40, Enter: 13 }[key] }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); };
    const select = async (selector, value) => {
      const index = await c.eval(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o=>o.value===${JSON.stringify(value)})`);
      assert.ok(index >= 0, value + '在模型清单中'); await click(selector); await key('Home');
      for (let i = 0; i < index; i++) await key('ArrowDown'); await key('Enter');
    };
    const shot = async name => { await sleep(250); const file = path.join(out, `20261123-agent-picker-root-${name}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    await c.eval('window.__hubOpenConfigModal()');
    await click('#cfg-tab-agents');
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===7`);
    assert.equal(await c.eval(`(async()=> (await ipcRenderer.invoke('feature-agents:get')).features.length)()`), 11);
    assert.equal(await c.eval(`document.querySelectorAll('#cfg-feature-agents [data-fa-reset]').length`), 0);
    const meetingDefault = await c.eval(`(() => { const s=document.querySelector('#cfg-feature-agents [data-fa-row="meeting"] [data-fa-backend]'); return { text:s.selectedOptions[0].textContent, title:s.title }; })()`);
    assert.equal(meetingDefault.text, '默认·会议所选'); assert.match(meetingDefault.title, /会议中所选引擎/);
    result.checks.push('会议默认项显示短文案并保留悬停全称；默认行不显示恢复按钮');
    result.layout = await c.eval(`(() => { const p=document.querySelector('#config-main-view'); return {height:p.clientHeight,scrollHeight:p.scrollHeight,width:innerWidth,heightWindow:innerHeight}; })()`);
    assert.ok(result.layout.scrollHeight <= result.layout.height + 2, '设置页一屏不滚动');
    result.checks.push('全新用户十一项功能按日常与 PPT 分屏，1440×900 一屏'); await shot('defaults');
    assert.ok(await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-row="help"] [data-fa-model]').selectedOptions[0].textContent.includes('fixture-next')`), '问问 Hub 默认显示新建会话默认而非 CLI 旧模型');
    await click('[data-fa-group="ppt"]');
    assert.equal(await c.eval(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length`), 4);
    await shot('ppt-settings'); await click('[data-fa-group="common"]');
    await select('#cfg-feature-agents [data-fa-row="help"] [data-fa-backend]', 'codeagent');
    await wait(`!document.querySelector('#cfg-feature-agents [data-fa-row="help"] [data-fa-model]').disabled`);
    await select('#cfg-feature-agents [data-fa-row="help"] [data-fa-model]', 'GLM-5.2-WX-Auto');
    await wait(`document.querySelector('#cfg-feature-agents [data-fa-row="help"] [data-fa-model]').value==='GLM-5.2-WX-Auto'`);
    assert.equal(await c.eval(`document.querySelectorAll('#cfg-feature-agents [data-fa-reset]').length`), 1);
    await shot('changed-row');
    await click('#config-close'); await click('#btn-help-ask');
    await click('#help-ask-panel [data-feature-agent="help"]');
    await wait(`document.querySelector('.fa-popup [data-fa-model]')?.value==='GLM-5.2-WX-Auto'`);
    result.checks.push('设置页选择经真实 IPC 保存，功能入口读取同一份设置'); await shot('help-selection');
    await click('.fa-popup [data-fa-close]');
    await click('#help-ask-panel textarea'); await c.send('Input.insertText', { text: '回车键在哪设置？' }); await click('#help-ask-panel [data-ha="send"]');
    await wait(`document.querySelector('#help-ask-panel')?.textContent.includes('测试替身')`);
    result.checks.push('问问 Hub 真实单次 CLI 子进程按所选模型返回回答'); await shot('help-answer');
    await click('#help-ask-panel [data-feature-agent="help"]');
    await select('.fa-popup [data-fa-model]', 'fixture-auth-failure');
    await wait(`document.querySelector('.fa-popup [data-fa-model]').value==='fixture-auth-failure'`);
    await click('.fa-popup [data-fa-close]'); await click('#help-ask-panel textarea');
    await c.send('Input.insertText', { text: '登录失败后怎么处理？' }); await click('#help-ask-panel [data-ha="send"]');
    await wait(`document.querySelector('.ha-fallback-notice')?.textContent.includes('所选 CodeAgent 失败，已改用默认')`);
    result.checks.push('所选 CLI 真实模拟登录失败后回默认链，回答旁显示回退提示'); await shot('runtime-fallback');
    await wait(`document.querySelector('.ask-qa:last-child .ask-a')?.textContent.includes('模型：fixture-next')`);
    result.checks.push('默认回答读取新建会话设定，覆盖 CLI 仍记着的旧模型');
    await click('#help-ask-panel [data-feature-agent="help"]');
    await select('.fa-popup [data-fa-model]', 'fixture-model-denied');
    await click('.fa-popup [data-fa-close]'); await click('#help-ask-panel textarea');
    await c.send('Input.insertText', { text: '模型权限变化时如何继续？' }); await click('#help-ask-panel [data-ha="send"]');
    await wait(`document.querySelector('.ask-qa:last-child .ha-fallback-notice')?.textContent==='已改用 fixture-next'`);
    assert.ok(await c.eval(`document.querySelector('.ask-qa:last-child .ask-a').textContent.includes('模型：fixture-next')`));
    result.checks.push('中文模型权限错误自动换一次，答案上方注明实际使用模型'); await shot('model-retry');
    await click('#help-ask-panel textarea'); await c.send('Input.insertText', { text: '换模型仍失败出口' }); await click('#help-ask-panel [data-ha="send"]');
    await wait(`document.querySelector('.ask-qa:last-child .ask-err')?.textContent.includes('自动换模型后仍未成功')`);
    assert.ok(await c.eval(`Array.from(document.querySelectorAll('.ask-qa:last-child .ha-actions button')).some(b=>b.textContent==='重试')`));
    result.checks.push('第二次失败就地显示重试与选模型，选模型打开同一份功能设置'); await shot('model-retry-failed');
    await click('.ask-qa:last-child [data-feature-agent="help"]');
    await wait(`document.querySelector('.fa-popup [data-fa-model]')?.value==='fixture-model-denied'`);
    await click('.fa-popup [data-fa-close]');
    await click('#help-ask-panel [data-feature-agent="help"]');
    await click('.fa-popup [data-fa-reset]');
    await wait(`document.querySelector('.fa-popup [data-fa-backend]').value===''`);
    assert.equal(await c.eval(`document.querySelectorAll('.fa-popup [data-fa-reset]').length`), 0);
    result.checks.push('只有改过的行显示恢复按钮，恢复后按钮消失');
    await click('.fa-popup [data-fa-close]');
    await c.eval(`require('../core/codeagent-assistant-route').setFeaturePreference(${JSON.stringify(data)}, 'help', {kind:'claude', model:'withdrawn-model'}); window.__featureAgents.refresh()`);
    await wait(`!!document.querySelector('#help-ask-panel [data-fa-unavailable="help"]')`);
    result.checks.push('失效模型在功能旁一行提示并给恢复默认'); await shot('unavailable');
    await click('#help-ask-panel [data-fa-unavailable="help"] button');
    await wait(`!document.querySelector('#help-ask-panel [data-fa-unavailable="help"]')`);
    result.checks.push('功能旁恢复默认立即同步设置');
    await c.eval('window.__hubOpenConfigModal()'); await click('#cfg-tab-agents');
    assert.equal(await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-row="help"] [data-fa-backend]').value`), '');
    await shot('restored');
    await click('#config-close'); await click('#help-ask-panel [data-ha="close"]');
    await click('#btn-company-assistant');
    await click('#company-assistant-page [data-feature-agent="assistant"]');
    await wait(`document.querySelector('.fa-popup [data-fa-row="assistant"]')`);
    await shot('assistant-entry'); await click('.fa-popup [data-fa-close]');
    await click('#company-assistant-page [data-ca="settings"]');
    await click('[data-ca="settings-tab:model"]');
    await wait(`document.querySelectorAll('#fa-assistant-settings [data-fa-row]').length===2`);
    assert.equal(await c.eval(`Array.from(document.querySelector('#fa-assistant-settings [data-fa-backend]').options).some(o=>['claude','codex','deepseek-acp'].includes(o.value))`), false);
    assert.equal(await c.eval(`!!document.querySelector('.fa-legacy-override')`), false);
    await select('#fa-assistant-settings [data-fa-row="assistant"] [data-fa-backend]', 'codeagent');
    await wait(`document.querySelector('.fa-legacy-override')?.textContent.includes('下方供应商默认设置暂不生效')`);
    result.checks.push('不安全后端不出现在工具会话选择中，旧供应商页显示功能选型覆盖提示'); await shot('provider-override');
    result.checks.push('原助理模型与供应商设置页复用统一选择组件'); await shot('assistant-model-settings');
    await click('[data-ca="close-panel"]'); await click('#btn-company-ppt');
    await click('.company-ppt-page [data-feature-agent="ppt,pptMap,pptMake,pptImgtext"]');
    await wait(`document.querySelectorAll('.fa-popup [data-fa-row]').length===4`);
    result.checks.push('PPT 界面入口分别选择找页、做页、图转字与库地图'); await shot('ppt-entry');
    result.ok = true;
    console.log('GUI PASS: ' + result.checks.join('；'));
  } catch (error) {
    result.error = error.stack;
    if (c) try { const file = path.join(out, '20261123-agent-picker-root-failure-1440x900.png'); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); } catch {}
    throw error;
  } finally {
    if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261123-agent-picker-root-gui.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
