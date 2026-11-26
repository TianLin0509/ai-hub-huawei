'use strict';
// 公司版「功能使用的 Agent」外壳选择走查（2026-11-26）：隔离真实 Electron、隐藏窗口、1440×900、真实 IPC 与真实目录枚举。
// 场景 A：保存了部门 API key（假 key，不连网关）+ 本机有 CodeAgent（测试替身）+ 本机 Claude Code / Codex；场景 B：什么都没配。
// 下拉用「展开成列表」的方式截图（原生下拉弹层截不到），只为让截图里看得到全部选项。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const out = path.resolve(process.env.HARNESS_OUTPUT || path.join(os.tmpdir(), 'feature-agent-harness'));

async function scenario(name, { gateway, codeagent, legacy }, steps, result) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fa-harness-${name}-`)), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(data); fs.mkdirSync(personal);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { providers: { 'deepseek-acp': { entryPath: __filename } } } }));
  if (gateway) {
    fs.mkdirSync(path.join(data, 'api-gateway'), { recursive: true });
    fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ encryptedKey: 'ZmFrZS1lMmUta2V5',
      models: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.6-plus'], model: 'deepseek-v4.1-flash' }));
  }
  if (codeagent) {
    fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
    require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  }
  if (legacy) require('../core/codeagent-assistant-route').setFeaturePreference(data, 'help', { kind: 'claude', model: 'claude-opus-5-5' });
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: `fa-harness-${name}`, extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_CODEAGENT_COMMAND: codeagent ? path.resolve('tests/fixtures/help-ask-fake/codeagent.cmd') : path.join(root, 'no-codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async expr => { for (let i = 0; i < 150; i++) { const v = await c.eval(expr); if (v) return v; await sleep(200); } throw Error('等待失败：' + expr); };
    const shot = async label => { await sleep(300); const file = path.join(out, `20261126-featbackend-${name}-${label}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    const row = id => `#cfg-feature-agents [data-fa-row="${id}"]`;
    const options = sel => c.eval(`Array.from(document.querySelector(${JSON.stringify(sel)}).options).map(o => ({ value:o.value, text:o.textContent, disabled:o.disabled }))`);
    // 经真实 IPC 存（与下拉 change 同一路径）后等界面重画。
    const pick = async (id, backend, model = '') => {
      const r = await c.eval(`(async () => { const r = await require('electron').ipcRenderer.invoke('feature-agents:set', { feature: ${JSON.stringify(id)}, ui: { backend: ${JSON.stringify(backend)}, model: ${JSON.stringify(model)} } }); await window.__featureAgents.refresh(); return r.ok === false ? r.error : ''; })()`);
      return r;
    };
    // 截图用：把一个下拉展开成列表，看得到全部选项。
    const expand = sel => c.eval(`(() => { const s=document.querySelector(${JSON.stringify(sel)}); s.size=Math.min(s.options.length, 8); s.style.height='auto'; s.style.position='relative'; s.style.zIndex='3'; return s.options.length; })()`);
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    await c.eval('window.__hubOpenConfigModal()');
    await c.eval(`document.querySelector('#cfg-tab-agents').click()`);
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===7`);
    await steps({ c, wait, shot, row, options, pick, expand, result });
  } finally {
    if (c) await c.close();
    // 退出超时只记下（launcher 已结束自己起的进程），不算功能失败；日志尾巴留作排查。
    if (hub) try { result.teardown.push(await gracefulQuit(hub)); } catch (error) { result.teardown.push({ scenario: name, error: error.message, logTail: error.logTail || '' }); }
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const result = { ok: false, checks: [], shots: [], options: {}, teardown: [] };
  const noForeign = list => list.every(o => !/opus|sonnet|haiku|gpt-|claude-/i.test(o.value + o.text));
  try {
    await scenario('A', { gateway: true, codeagent: true, legacy: true }, async ({ c, wait, shot, row, options, pick, expand, result }) => {
      // 升级前存下的「Claude · claude-opus-5-5」：本次回默认，就地提示重选。
      await wait(`!!document.querySelector('${row('help')} .fa-warning')`);
      const warn = await c.eval(`document.querySelector('${row('help')} .fa-warning').textContent`);
      assert.match(warn, /公司里用不了/); result.checks.push('旧版存下的 Claude · claude-opus-5-5：提示「公司里用不了，本次沿用默认，请重新选择」');
      await shot('1-legacy-opus');
      // 1) 选 CodeAgent
      assert.equal(await pick('help', 'codeagent', ''), '');
      await wait(`document.querySelector('${row('help')} [data-fa-backend]').value==='codeagent'`);
      const caModels = await options(`${row('help')} [data-fa-model]`); result.options.helpCodeAgent = caModels;
      const caModel = caModels.find(o => o.value && !o.disabled);
      if (caModel) { assert.equal(await pick('help', 'codeagent', caModel.value), ''); await wait(`document.querySelector('${row('help')} [data-fa-model]').value===${JSON.stringify(caModel.value)}`); }
      result.checks.push(`问问 Hub 选 CodeAgent${caModel ? ' · ' + caModel.text : '（默认模型）'} 保存成功`); await shot('2-codeagent');
      // 2) 选 Claude Code 外壳：模型只有部门 key 和公司模型
      assert.equal(await pick('help', 'claude', ''), '');
      await wait(`document.querySelector('${row('help')} [data-fa-backend]').value==='claude'`);
      const claudeModels = await options(`${row('help')} [data-fa-model]`); result.options.helpClaude = claudeModels;
      assert.ok(noForeign(claudeModels), JSON.stringify(claudeModels));
      assert.ok(claudeModels.some(o => o.text.startsWith('部门 API key · ')) && claudeModels.some(o => o.text.startsWith('公司模型')));
      assert.equal(await c.eval(`document.querySelector('${row('help')} [data-fa-model]').value`), 'src:gateway:deepseek-v4.1-flash');
      result.checks.push(`问问 Hub 选 Claude Code：模型 ${claudeModels.length - 1} 项全是部门 key / 公司模型，默认落在部门 key · deepseek-v4.1-flash，无 claude-opus`);
      await expand(`${row('help')} [data-fa-model]`); await shot('3-claude-harness');
      // 3) 选 Codex 外壳 + 公司模型
      // 测试替身的 CodeAgent 连不上公司上游，公司模型会按反代真实状态灰显；这里选部门 key 的另一个模型。
      const company = 'src:gateway:glm-5.3-flash';
      assert.equal(await pick('help', 'codex', company), '');
      await wait(`document.querySelector('${row('help')} [data-fa-backend]').value==='codex'`);
      const codexModels = await options(`${row('help')} [data-fa-model]`); result.options.helpCodex = codexModels;
      assert.ok(noForeign(codexModels));
      assert.equal(await c.eval(`!!document.querySelector('${row('help')} .fa-warning')`), false);
      result.checks.push(`问问 Hub 选 Codex · 部门 API key · ${company.split(':').pop()} 保存成功、无不可用提示，模型表同样无 gpt-*`);
      await expand(`${row('help')} [data-fa-model]`); await shot('4-codex-harness');
      // 4) 会话功能（助理）：Claude Code = 部门 key 线路；Codex / DSH 灰显说明原因
      await c.eval('window.__featureAgents.refresh()');
      assert.equal(await pick('assistant', 'claude', 'glm-5.3-flash'), '');
      await wait(`document.querySelector('${row('assistant')} [data-fa-backend]').value==='claude'`);
      const st = await c.eval(`(async () => (await require('electron').ipcRenderer.invoke('feature-agents:get')).features.find(f => f.id==='assistant').choice)()`);
      assert.deepEqual(st, { kind: 'api-gateway', model: 'glm-5.3-flash' });
      const asBackends = await options(`${row('assistant')} [data-fa-backend]`); result.options.assistantBackends = asBackends;
      const dsh = asBackends.find(o => o.value === 'deepseek-acp'), codex = asBackends.find(o => o.value === 'codex');
      assert.ok(dsh && dsh.disabled && /DSH/.test(dsh.text)); assert.ok(codex && codex.disabled);
      assert.ok(!asBackends.some(o => o.value === 'api-gateway'));
      result.checks.push('助理选 Claude Code · 部门 API key · glm-5.3-flash，存成原有的部门 key 线路；Codex、DSH 灰显并写明原因');
      await expand(`${row('assistant')} [data-fa-backend]`); await shot('5-assistant-backends-dsh');
      const layout = await c.eval(`(() => { const p=document.querySelector('#config-main-view'); return { h:p.clientHeight, sh:p.scrollHeight }; })()`);
      result.layoutA = layout;
    }, result);
    await scenario('B', { gateway: false, codeagent: false }, async ({ c, wait, shot, row, options, result }) => {
      const backends = await options(`${row('help')} [data-fa-backend]`); result.options.noAccountHelp = backends;
      const claude = backends.find(o => o.value === 'claude');
      assert.ok(claude?.disabled && /部门 API key/.test(claude.text), JSON.stringify(claude));
      await wait(`!!document.querySelector('#cfg-feature-agents [data-fa-open-gateway]')`);
      const line = await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-setup]').textContent`);
      assert.match(line, /部门 API key/);
      result.checks.push('什么都没配：Claude Code / Codex 灰显「需要先保存部门 API key」，底部一行提示 +「去配置部门 API key」按钮');
      await shot('6-no-account');
      await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-open-gateway]').click()`);
      await sleep(800);
      result.checks.push('点「去配置部门 API key」打开网关设置'); await shot('7-open-gateway-settings');
      const layout = await c.eval(`(() => { const p=document.querySelector('#config-main-view'); return { h:p?.clientHeight, sh:p?.scrollHeight }; })()`);
      result.layoutB = layout;
    }, result);
    result.ok = true;
  } catch (error) { result.error = error.stack || String(error); }
  fs.writeFileSync(path.join(out, '20261126-featbackend-e2e-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks.length, shots: result.shots.length, error: result.error?.split('\n')[0] }));
  process.exitCode = result.ok ? 0 : 1;
}
main();
