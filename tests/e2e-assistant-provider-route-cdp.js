'use strict';
// 隔离 Electron 真界面、鼠标操作；合成模型清单与成功记录，不调用公司接口。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-provider-gui-r12-'));
  const out = path.resolve('artifacts/20261123-assistant405-r12'); fs.mkdirSync(out, { recursive: true });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  let hub, c;
  const result = { ok: false, checks: [], fixture: '真实 Electron 与鼠标操作，合成服务数据；不连接真实供应商' };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'hub'), port, windowMode: 'hidden', label: 'assistant-provider-r12', extraArgs: ['--enable-features=SharedArrayBuffer'], extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_CODEAGENT_COMMAND: path.resolve('tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < 100; i++) { if (await c.eval(`document.readyState === 'complete' && !!document.getElementById('btn-company-assistant')`)) break; await sleep(100); }
    await c.eval(`(async () => {
      window.__companyAssistantHide?.(); document.querySelector('#company-assistant-page')?.remove(); window.__optionalFeatures = null;
      const { CompanyAssistant } = require('../core/company-assistant/service'), path = require('node:path'), fs = require('node:fs');
      const root = ${JSON.stringify(root)}, dataDir = path.join(root, 'fixture'), configDir = path.join(root, 'fixture-config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enterprise: { providers: { bad: { mainModel: 'custom-model', apiBaseUrl: 'https://bad.example.test/v1' }, good: { mainModel: 'custom-model', apiBaseUrl: 'https://good.example.test/v1' } } } }));
      const models = require('../core/codeagent-models'), routes = require('../core/codeagent-assistant-route');
      models.recordMenu(dataDir, ['custom-model'], { complete: true });
      const a = new CompanyAssistant({ dataDir, noTools: true, noTimer: true, noPrewarm: true, bus: { latest: () => [] }, getSession: () => null });
      a.cli = () => ''; a.changed = () => {};
      a.modelSettings = (account = 'personal') => ({ ok: true, account, choice: routes.preference(dataDir, account), manual: routes.lastSuccessful(dataDir, account), options: models.modelOptions(dataDir, { configDir }) });
      const f = window.providerFixture = { a, dataDir, routes, messages: [], calls: [] };
      const ipc = { on() {}, async invoke(channel, args) { f.calls.push({ channel, args });
        try {
          if (channel === 'company-assistant:status') return a.status();
          if (channel === 'company-assistant:memory') return { ok: true, items: [] };
          if (channel === 'company-assistant:model-settings') return a.modelSettings();
          if (channel === 'company-assistant:set-model-choice') return a.setModelChoice(args);
          throw Error('unexpected IPC ' + channel);
        } catch(e) { return { ok: false, error: e.message }; }
      } };
      f.page = require('../renderer/company-assistant-page').createCompanyAssistantPage({ document, window, ipcRenderer: ipc, showMessage: msg => f.messages.push(msg) });
      await f.page.open();
    })()`);
    const until = async expr => { for (let i = 0; i < 80; i++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('GUI timeout: ' + expr); };
    const click = async selector => {
      const point = await c.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(150);
    };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(s.data, 'base64')); };
    await until(`!!document.querySelector('[data-ca="settings"]')`);
    await click('[data-ca="settings"]'); await click('[data-ca="settings-tab:model"]');
    await until(`!!document.querySelector('[data-model-choice]')`);
    assert.equal(await c.eval(`document.querySelector('[data-model-choice]').options.length`), 3);
    assert.equal(await c.eval(`document.querySelector('[data-model-choice]').value`), '');
    result.checks.push('全新数据默认沿用，两个同名自配供应商分别可选');
    await c.eval(`(() => { const e = document.querySelector('[data-model-choice]'); e.value = [...e.options].find(o => o.text.includes('bad')).value; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await click('[data-model-save]');
    await until(`providerFixture.routes.preference(providerFixture.dataDir)?.codeagentModelProvider === 'bad'`);
    await click('[data-ca="settings-tab:welink"]'); await click('[data-ca="settings-tab:model"]');
    await until(`document.querySelector('[data-model-choice]')?.selectedOptions[0]?.text.includes('bad')`);
    result.checks.push('选择供应商保存后，重新进入模型页仍显示所选组合');
    const size = await c.eval(`(() => { const e = document.querySelector('.ca-tab-body'); return { height:e.clientHeight, scroll:e.scrollHeight, outer:document.documentElement.scrollHeight, viewport:innerHeight }; })()`);
    assert.ok(size.scroll <= size.height + 1, JSON.stringify(size));
    result.checks.push('1440×900 模型页一屏，无纵向滚动'); await shot('20261123-assistant405-r12-model.png');
    await click('[data-ca="close-panel"]');
    await c.eval(`(() => { const f = providerFixture; f.a.saveChat([{ id:'no-manual', q:'首次错误', state:'error', at:Date.now(), error:'供应商接口不接受对话请求（405）', providerRepair:f.routes.repairAction(f.dataDir) }]); f.page.close(); return f.page.open(); })()`);
    await until(`!!document.querySelector('.ca-turn-error [data-ca="settings-tab:model"]')`);
    assert.equal(await c.eval(`document.querySelectorAll('[data-ca^="repair-provider:"]').length`), 0);
    await click('.ca-turn-error [data-ca="settings-tab:model"]');
    await until(`!!document.querySelector('[data-model-choice]')`);
    result.checks.push('没有手动成功记录时只提供模型设置入口，不显示恢复按钮');
    await click('[data-ca="close-panel"]');
    await c.eval(`(() => { const f = providerFixture; f.routes.rememberSuccess(f.dataDir, { kind:'codeagent', currentModel:{id:'custom-model'}, codeagentModelProvider:'good' }, { model:'custom-model', text:'成功', stopReason:'end_turn', ts:Date.now() }); f.a.saveChat([{ id:'failed', q:'测试', state:'error', at:Date.now(), error:'供应商「bad」（https://bad.example.test/v1）的接口不接受对话请求（405）', providerRepair:f.routes.repairAction(f.dataDir) }]); f.page.close(); return f.page.open(); })()`);
    await until(`!!document.querySelector('[data-ca="repair-provider:failed"]')`);
    await click('[data-ca="repair-provider:failed"]');
    await until(`providerFixture.messages.some(m => m.includes('已改用手动会话'))`);
    assert.equal(await c.eval(`providerFixture.routes.choose(providerFixture.dataDir).codeagentModelProvider`), 'good');
    assert.equal(await c.eval(`providerFixture.calls.filter(x => x.channel.includes('retry-chat')).length`), 0);
    result.checks.push('错误旁一键恢复成功供应商，不自动重发'); await shot('20261123-assistant405-r12-repair.png');
    result.ok = true; console.log('GUI PASS: ' + result.checks.join('；'));
  } catch (error) {
    result.error = error.stack;
    if (c) { try { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261123-assistant405-r12-failure.png'), Buffer.from(s.data, 'base64')); } catch {} }
    throw error;
  } finally {
    if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261123-assistant405-r12-gui.json'), JSON.stringify(result, null, 2));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
