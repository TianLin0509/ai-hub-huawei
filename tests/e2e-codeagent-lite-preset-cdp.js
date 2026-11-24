'use strict';
// 一键全切 CodeAgent-Lite / 还原（2026-11-24）：隔离真实 Electron、鼠标点击、模拟 CLI；不访问真实模型，不改生产账号。
// 检查：按钮与分类标签同一行、1440×900 设置页一屏不滚动、切换与还原的回执和实际选型。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const out = path.resolve(process.env.LITE_PRESET_OUTPUT || 'D:/AI-Artifacts/20261124-lite-guard');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-preset-gui-')), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ models: { defaults: { codeagent: 'fixture-next' } } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  require('../core/codeagent-models').recordMenu(data, ['GLM-5.2-WX-Auto', 'fixture-next'], { complete: true });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const result = { ok: false, checks: [], shots: [], fixture: '全新隔离 Hub 数据、真实 Electron 与鼠标点击、模拟 CLI' };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'hidden', label: 'lite-preset', extraEnv: {
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
    const shot = async name => { await sleep(250); const file = path.join(out, `20261124-lite-preset-${name}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    const layout = () => c.eval(`(() => { const p=document.querySelector('#config-main-view'), tabs=document.querySelector('#cfg-feature-agents .fa-group-tabs'), btn=document.querySelector('[data-fa-preset="codeagent-lite"]'), first=tabs.querySelector('[data-fa-group]');
      const a=first.getBoundingClientRect(), b=btn.getBoundingClientRect(); return {height:p.clientHeight,scrollHeight:p.scrollHeight,tabsHeight:tabs.offsetHeight,sameRow:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2)<4}; })()`);
    const kinds = () => c.eval(`(async()=> (await ipcRenderer.invoke('feature-agents:get')).features.filter(f=>f.kinds.includes('codeagent-lite')).map(f=>f.choice?.kind || null))()`);
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    await c.eval('window.__hubOpenConfigModal()');
    await click('#cfg-tab-agents');
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===7 && !!document.querySelector('[data-fa-preset="codeagent-lite"]')`);
    assert.equal(await c.eval(`!!document.querySelector('[data-fa-preset="reset-lite"]')`), false, '没有 Lite 项时不显示还原');
    result.layoutBefore = await layout();
    assert.ok(result.layoutBefore.sameRow, '一键按钮与分类标签同一行');
    assert.ok(result.layoutBefore.scrollHeight <= result.layoutBefore.height + 2, '设置页一屏不滚动');
    result.checks.push('按钮与「日常功能 / PPT」同一行靠右，1440×900 一屏'); await shot('before');
    await click('[data-fa-preset="codeagent-lite"]');
    await wait(`document.querySelector('#cfg-feature-agents [data-fa-message]')?.textContent.includes('CodeAgent-Lite')`);
    result.receipt = await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-message]').textContent`);
    assert.match(result.receipt, /已将 8 项互动功能切换为 CodeAgent-Lite（省内存），下次任务生效/);
    assert.deepEqual(await kinds(), Array(8).fill('codeagent-lite'));
    assert.equal(await c.eval(`document.querySelector('[data-fa-preset="codeagent-lite"]').disabled`), true, '全是 Lite 后置灰');
    result.layoutAfter = await layout();
    assert.ok(result.layoutAfter.scrollHeight <= result.layoutAfter.height + 2, '切换后（每行多了恢复默认）仍一屏');
    result.checks.push('一键全切：8 项都成 Lite，回执清楚，按钮置灰并出现「还原 Lite」'); await shot('after-lite');
    await click('#cfg-feature-agents [data-fa-group="ppt"]');
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===4`);
    result.layoutPpt = await layout();
    assert.ok(result.layoutPpt.scrollHeight <= result.layoutPpt.height + 2);
    await shot('after-lite-ppt');
    await click('[data-fa-preset="reset-lite"]');
    await wait(`document.querySelector('#cfg-feature-agents [data-fa-message]')?.textContent.includes('还原为默认')`);
    result.resetReceipt = await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-message]').textContent`);
    assert.deepEqual(await kinds(), Array(8).fill(null));
    assert.equal(await c.eval(`!!document.querySelector('[data-fa-preset="reset-lite"]')`), false);
    result.checks.push('还原 Lite：8 项回到默认，还原按钮收起'); await shot('after-reset');
    result.ok = true;
    console.log('GUI PASS: ' + result.checks.join('；'));
  } catch (error) {
    result.error = error.stack;
    if (c) try { const file = path.join(out, '20261124-lite-preset-failure-1440x900.png'); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); } catch {}
    throw error;
  } finally {
    if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261124-lite-preset-gui.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄稍后释放 */ }
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
