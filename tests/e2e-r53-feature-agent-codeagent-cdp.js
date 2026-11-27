'use strict';
// R53：问问 Hub / 进展卡摘要选 CodeAgent 时模型列表与会话一样全（带供应商），手填模型试跑后选用。
// 隔离真实 Electron、鼠标键盘操作、假 CodeAgent CLI（tests/fixtures/help-ask-fake）；不访问真实模型，不改生产账号。
// R53: one-shot features list CodeAgent models with providers like sessions; a hand-typed model is trial-run before use.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(process.env.R53_OUTPUT || 'D:/AIWork/20261125-hubh-rsi-lead2-claude/R53');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r53-feature-gui-')), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal); fs.mkdirSync(data);
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  // 清单形状同公司 CodeAgent 1.2615.02.05：Built-in（w3）一组、自配供应商 cannbotprovider 一组，GLM-5.3 两组都有。
  const details = [
    { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2-WX-Auto', provider: 'w3', providerLabel: 'Built-in' },
    { id: 'GLM-5.3-CodeAgent-Auto', label: 'GLM-5.3-CodeAgent-Auto', provider: 'w3', providerLabel: 'Built-in' },
    { id: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek-V4.1-Flash-1017', provider: 'w3', providerLabel: 'Built-in' },
    { id: 'GLM-5.3', label: 'GLM-5.3', provider: 'cannbotprovider', providerLabel: 'cannbotprovider' },
    { id: 'GLM-5.3', label: 'GLM-5.3', provider: 'w3', providerLabel: 'Built-in' },
    { id: 'Qwen3.6-Coder', label: 'Qwen3.6-Coder', provider: 'cannbotprovider', providerLabel: 'cannbotprovider' },
  ];
  require('../core/codeagent-model-probe').writeProbed(path.join(data, 'codeagent-pool', 'personal-models.json'),
    { models: [...new Set(details.map(d => d.id))], details, defaultModel: 'GLM-5.2-WX-Auto', source: 'serve' });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const result = { ok: false, checks: [], shots: [], fixture: '全新隔离 Hub 数据、真实 Electron 与鼠标键盘、假 CodeAgent CLI；模型清单按公司真实分组形状造的，不验证真实账号权限' };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', label: 'r53-feature-agent', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_CODEAGENT_COMMAND: path.resolve('tests/fixtures/help-ask-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expression, tries = 150) => { for (let i = 0; i < tries; i++) { const value = await c.eval(expression); if (value) return value; await sleep(200); } throw Error('等待失败：' + expression); };
    const click = async selector => {
      const xy = await wait(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e||e.disabled) return null; const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, hit=document.elementFromPoint(x,y); return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null; })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const key = async key => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: { Home: 36, ArrowDown: 40, Enter: 13 }[key] }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); };
    const select = async (selector, value) => {
      const index = await c.eval(`Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o=>o.value===${JSON.stringify(value)})`);
      assert.ok(index >= 0, value + ' 在下拉里'); await click(selector); await key('Home');
      for (let i = 0; i < index; i++) await key('ArrowDown'); await key('Enter');
    };
    const shot = async name => { await sleep(300); const file = path.join(out, `20261127-R53-${name}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    const row = id => `#cfg-feature-agents [data-fa-row="${id}"]`;
    const optionTexts = id => c.eval(`Array.from(document.querySelector('${row(id)} [data-fa-model]').options).map(o=>o.textContent)`);
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    await c.eval('window.__hubOpenConfigModal()');
    await click('#cfg-tab-agents');
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length>=7`);
    for (const id of ['help', 'progress']) {
      await select(`${row(id)} [data-fa-backend]`, 'codeagent');
      await wait(`!document.querySelector('${row(id)} [data-fa-model]').disabled`);
    }
    const sessionList = await c.eval(`(async()=> (await ipcRenderer.invoke('feature-agents:get')).features.find(f=>f.id==='avatar').options.find(o=>o.value==='codeagent').models.map(m=>m.label))()`);
    result.lists = { session: sessionList, help: await optionTexts('help'), progress: await optionTexts('progress') };
    for (const id of ['help', 'progress']) {
      for (const label of sessionList) assert.ok(result.lists[id].includes(label), `${id} 列出了 ${label}`);
      assert.ok(result.lists[id].includes('手填模型名…'), `${id} 有手填入口`);
    }
    assert.equal(sessionList.length, 6);
    result.checks.push('问问 Hub、进展卡摘要的 CodeAgent 下拉与会话功能同一份 6 项（GLM-5.3 两个供应商各一项），末尾有「手填模型名…」');
    result.layout = await c.eval(`(() => { const p=document.querySelector('#config-main-view'); return {height:p.clientHeight,scrollHeight:p.scrollHeight}; })()`);
    assert.ok(result.layout.scrollHeight <= result.layout.height + 2, '设置页一屏不滚动');
    await shot('oneshot-codeagent-selected');
    // 原生下拉弹层截不进页面截图：临时把下拉展开成列表（size）拍一张清单，拍完还原。
    await c.eval(`(() => { const s=document.querySelector('${row('help')} [data-fa-model]'); s.size=s.options.length; s.style.position='relative'; s.style.zIndex='5'; s.style.height='auto'; })()`);
    await shot('help-codeagent-list');
    await c.eval(`(() => { const s=document.querySelector('${row('help')} [data-fa-model]'); s.size=0; s.style.cssText=''; })()`);
    // 手填：选「手填模型名…」展开输入框，填一个清单里没有的名字，试跑通过后选用。
    await select(`${row('progress')} [data-fa-model]`, '__custom__');
    await wait(`!document.querySelector('${row('progress')} [data-fa-custom]').hidden`);
    await click(`${row('progress')} [data-fa-custom-input]`);
    await c.send('Input.insertText', { text: 'maas-deepseek-v4.1-flash-baidu-codeagent' });
    await click(`${row('progress')} [data-fa-custom-check]`);
    await wait(`document.querySelector('${row('progress')} [data-fa-model]')?.value==='maas-deepseek-v4.1-flash-baidu-codeagent'`);
    const selectedText = await c.eval(`document.querySelector('${row('progress')} [data-fa-model]').selectedOptions[0].textContent`);
    assert.match(selectedText, /（手填）/);
    const note = await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-message]')?.textContent || ''`);
    assert.match(note, /已连通/);
    result.checks.push(`进展卡摘要手填 maas-deepseek-v4.1-flash-baidu-codeagent，经假 CLI 真实子进程试跑通过后选用，下拉显示「${selectedText}」，底部「${note}」`);
    await shot('custom-model-saved');
    // 手填一个账号用不了的名字：就地说清原因，不保存。
    await select(`${row('help')} [data-fa-model]`, '__custom__');
    await wait(`!document.querySelector('${row('help')} [data-fa-custom]').hidden`);
    await click(`${row('help')} [data-fa-custom-input]`);
    await c.send('Input.insertText', { text: 'fixture-model-denied' });
    await click(`${row('help')} [data-fa-custom-check]`);
    const error = await wait(`(() => { const t=document.querySelector('${row('help')} [data-fa-custom-msg]')?.textContent||''; return /用不了|没成功|超时/.test(t) ? t : ''; })()`);
    assert.match(error, /账号没有这个模型，或名字写错了/);
    const saved = await c.eval(`(async()=> (await ipcRenderer.invoke('feature-agents:get')).features.find(f=>f.id==='help').choice)()`);
    assert.ok(!saved || saved.model !== 'fixture-model-denied', '用不了的手填模型没有保存');
    result.checks.push(`问问 Hub 手填 fixture-model-denied 试跑失败，就地提示「${error}」，没有保存`);
    await shot('custom-model-denied');
    result.ok = true;
    console.log('GUI PASS: ' + result.checks.join('；'));
  } catch (error) {
    result.error = error.stack;
    if (c) try { const file = path.join(out, '20261127-R53-failure-1440x900.png'); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); } catch { /* 截不到就算了 */ }
    throw error;
  } finally {
    if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261127-R53-feature-agent-gui.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
