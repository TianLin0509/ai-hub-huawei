'use strict';
// 公司版「功能使用的 Agent」三类用户走查（2026-11-27 宗旨：部门 API / 自有 API 用户和 CodeAgent 用户同样的体验）。
// 隔离真实 Electron、隐藏窗口、1440×900、真实 IPC 与真实目录枚举；key 全是假的，不连任何网关或接口。
//   U1 只有 CodeAgent；U2 只有部门 API key；U3 只有自有 API（Claude Code 自有接口 + Codex 自有 API 账号 + DSH 自有接口）；U4 什么都没配。
// 下拉用「展开成列表」的方式截图（原生下拉弹层截不到），只为让截图里看得到全部选项。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const out = path.resolve(process.env.HARNESS_OUTPUT || path.join(os.tmpdir(), 'feature-agent-sources'));
const SESSION_IDS = ['assistant', 'ppt', 'avatar', 'forum', 'meeting', 'text'];

async function scenario(name, { gateway, codeagent, own }, steps, result) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fa-src-${name}-`)), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(data); fs.mkdirSync(personal);
  const config = { acp: { providers: { 'deepseek-acp': { entryPath: __filename } } } };
  if (own) {
    config.providers = {
      claude: { backend: 'api', base_url: 'https://own-api.example.invalid/anthropic', api_key: 'sk-own-fake-0123456789', model: 'own-claude-model' },
      codex: { backend: 'api', selected_api_profile: 'team1', api_profiles: [{ id: 'team1', label: '组里的接口', baseURL: 'https://team-api.example.invalid/v1', apiKey: 'sk-team-fake-0123456789', model: 'qwen3-coder', wireApi: 'chat' }] },
    };
    config.acp.companyApi = { baseURL: 'https://own-api.example.invalid/v1', apiKey: 'sk-own-fake-0123456789', model: 'own-dsh-model' };
  }
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  if (gateway) {
    fs.mkdirSync(path.join(data, 'api-gateway'), { recursive: true });
    fs.writeFileSync(path.join(data, 'api-gateway', 'gateway.json'), JSON.stringify({ encryptedKey: 'ZmFrZS1lMmUta2V5',
      models: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen3.6-plus'], model: 'deepseek-v4.1-flash' }));
  }
  if (codeagent) {
    fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
    require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  }
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: `fa-src-${name}`, extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      AI_HUB_CODEAGENT_COMMAND: codeagent ? path.resolve('tests/fixtures/help-ask-fake/codeagent.cmd') : path.join(root, 'no-codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async expr => { for (let i = 0; i < 150; i++) { const v = await c.eval(expr); if (v) return v; await sleep(200); } throw Error('等待失败：' + expr); };
    const shot = async label => { await sleep(300); const file = path.join(out, `20261127-featsources-${name}-${label}-1440x900.png`); fs.writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shots.push(file); };
    const row = id => `#cfg-feature-agents [data-fa-row="${id}"]`;
    const options = sel => c.eval(`Array.from(document.querySelector(${JSON.stringify(sel)}).options).map(o => ({ value:o.value, text:o.textContent, disabled:o.disabled }))`);
    const pick = (id, backend, model = '') => c.eval(`(async () => { const r = await require('electron').ipcRenderer.invoke('feature-agents:set', { feature: ${JSON.stringify(id)}, ui: { backend: ${JSON.stringify(backend)}, model: ${JSON.stringify(model)} } }); await window.__featureAgents.refresh(); return r.ok === false ? r.error : ''; })()`);
    const state = () => c.eval(`require('electron').ipcRenderer.invoke('feature-agents:get')`);
    const expand = sel => c.eval(`(() => { const s=document.querySelector(${JSON.stringify(sel)}); s.size=Math.min(s.options.length, 9); s.style.height='auto'; s.style.position='relative'; s.style.zIndex='3'; return s.options.length; })()`);
    await wait(`typeof window.__hubOpenConfigModal==='function' && !!window.__featureAgents && document.readyState==='complete'`);
    await c.eval('window.__hubOpenConfigModal()');
    await c.eval(`document.querySelector('#cfg-tab-agents').click()`);
    await wait(`document.querySelectorAll('#cfg-feature-agents [data-fa-row]').length===7`);
    await steps({ c, wait, shot, row, options, pick, state, expand, result });
  } finally {
    if (c) await c.close();
    if (hub) try { result.teardown.push(await gracefulQuit(hub)); } catch (error) { result.teardown.push({ scenario: name, error: error.message, logTail: error.logTail || '' }); }
  }
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const result = { ok: false, checks: [], shots: [], defaults: {}, options: {}, teardown: [] };
  const noForeign = list => list.every(o => !/opus|sonnet|haiku|gpt-|claude-/i.test((o.value + o.text).replace(/own-claude-model/g, ''))); // 去掉夹具自有模型名，免得误判
  const defaultsOf = st => Object.fromEntries(st.features.map(f => [f.id, { text: f.defaultText, auto: !!f.auto, selected: f.selected || null }]));
  try {
    await scenario('U1', { codeagent: true }, async ({ shot, state, result }) => {
      const d = defaultsOf(await state()); result.defaults.U1 = d;
      for (const id of SESSION_IDS) { assert.equal(d[id].auto, false, id); assert.match(d[id].text, id === 'meeting' ? /^会议中所选引擎$/ : /^CodeAgent/, id); }
      result.checks.push('U1 只有 CodeAgent：会话功能默认仍是 CodeAgent，不自动改线路（老用户不变）');
      await shot('1-codeagent-defaults');
    }, result);
    await scenario('U2', { gateway: true }, async ({ c, shot, row, options, state, expand, result }) => {
      const d = defaultsOf(await state()); result.defaults.U2 = d;
      for (const id of SESSION_IDS) { assert.equal(d[id].auto, true, id); assert.equal(d[id].selected.kind, 'api-gateway', id); assert.match(d[id].text, /^部门 API key · Claude Code/, id); }
      assert.equal(d.meeting.auto, true, '会议没选过也默认走部门 key（R49-2）；本场手选仍优先');
      result.checks.push(`U2 只有部门 key：${SESSION_IDS.length} 项会话功能默认都走「部门 API key · Claude Code」（以前只有助理会自动走）`);
      await shot('2-gateway-defaults');
      const helpBackends = await options(`${row('help')} [data-fa-backend]`); result.options.U2help = helpBackends;
      assert.ok(!helpBackends.find(o => o.value === 'deepseek-acp')?.disabled, 'DSH 可选');
      await c.eval(`(() => { const s=document.querySelector('${row('help')} [data-fa-backend]'); s.value='deepseek-acp'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(1200);
      const dshModels = await options(`${row('help')} [data-fa-model]`); result.options.U2helpDsh = dshModels;
      assert.ok(noForeign(dshModels) && dshModels.some(o => o.text.startsWith('部门 API key · ')), JSON.stringify(dshModels));
      result.checks.push('U2 问问 Hub 可选 DSH，模型是部门 API key 的模型');
      await expand(`${row('help')} [data-fa-model]`); await shot('3-help-dsh-gateway');
    }, result);
    await scenario('U3', { own: true }, async ({ c, wait, shot, row, options, pick, state, expand, result }) => {
      const d = defaultsOf(await state()); result.defaults.U3 = d;
      for (const id of SESSION_IDS) { assert.equal(d[id].auto, true, id); assert.deepEqual(d[id].selected, { kind: 'claude', source: 'own', model: 'own-claude-model' }, id); assert.match(d[id].text, /^自有接口 · Claude Code · own-claude-model/, id); }
      result.checks.push('U3 只有自有 API：会话功能默认都走「自有接口 · Claude Code · own-claude-model」（启动中心为 Claude Code 存的线路）');
      await shot('4-own-defaults');
      // 助理：Claude Code 模型下拉里有自有接口；Codex / DSH 写明原因。
      await wait(`!!document.querySelector('${row('assistant')} [data-fa-backend]')`);
      assert.equal(await pick('assistant', 'claude', 'src:own:own-claude-model'), '');
      await wait(`document.querySelector('${row('assistant')} [data-fa-backend]').value==='claude'`);
      const asModels = await options(`${row('assistant')} [data-fa-model]`); result.options.U3assistant = asModels;
      assert.ok(asModels.some(o => o.text === '自有接口 · own-claude-model' && !o.disabled), JSON.stringify(asModels));
      assert.ok(noForeign(asModels.filter(o => o.value !== 'src:own:own-claude-model')));
      result.checks.push('U3 助理选 Claude Code · 自有接口 · own-claude-model 保存成功');
      await expand(`${row('assistant')} [data-fa-model]`); await shot('5-assistant-own');
      // 问问 Hub：Codex 用自有 API 账号；DSH 用自有接口。
      assert.equal(await pick('help', 'codex', 'src:api:team1:qwen3-coder'), '');
      await wait(`document.querySelector('${row('help')} [data-fa-backend]').value==='codex'`);
      const cxModels = await options(`${row('help')} [data-fa-model]`); result.options.U3helpCodex = cxModels;
      assert.ok(cxModels.some(o => o.value === 'src:api:team1:qwen3-coder' && /自有 API · 组里的接口/.test(o.text)), JSON.stringify(cxModels));
      const st = await state();
      assert.deepEqual(st.features.find(f => f.id === 'help').choice, { kind: 'codex', model: 'qwen3-coder', source: 'api', profileId: 'team1' });
      result.checks.push('U3 问问 Hub 选 Codex · 自有 API · 组里的接口 · qwen3-coder 保存成功（存了账号编号）');
      await expand(`${row('help')} [data-fa-model]`); await shot('6-help-codex-profile');
      assert.equal(await pick('pptMap', 'deepseek-acp', 'src:own:own-dsh-model'), '');
      await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-group="ppt"]').click()`); // PPT 库地图在「PPT」分组页签里
      await wait(`document.querySelector('${row('pptMap')} [data-fa-backend]')?.value==='deepseek-acp'`);
      result.checks.push('U3 PPT 库地图选 DSH · 自有接口 · own-dsh-model 保存成功');
      await shot('7-pptmap-dsh-own');
    }, result);
    await scenario('U4', {}, async ({ c, wait, shot, options, row, result }) => {
      const backends = await options(`${row('help')} [data-fa-backend]`); result.options.U4help = backends;
      assert.ok(backends.find(o => o.value === 'claude')?.disabled);
      await wait(`!!document.querySelector('#cfg-feature-agents [data-fa-open-own]')`);
      const line = await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-setup]').textContent`);
      assert.match(line, /部门 API key、自有 API/); assert.equal(await c.eval(`!!document.querySelector('#cfg-feature-agents [data-fa-open-gateway]')`), true);
      result.checks.push('U4 什么都没配：底部一行写清要配什么，旁边「去配置部门 API key」「去配置自有 API」两个按钮');
      await shot('8-nothing');
      await c.eval(`document.querySelector('#cfg-feature-agents [data-fa-open-own]').click()`);
      await sleep(900);
      result.checks.push('点「去配置自有 API」打开自有接口设置'); await shot('9-open-own-settings');
    }, result);
    result.ok = true;
  } catch (error) { result.error = error.stack || String(error); }
  fs.writeFileSync(path.join(out, '20261127-featsources-e2e-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks.length, shots: result.shots.length, error: result.error?.split('\n')[0] }));
  process.exitCode = result.ok ? 0 : 1;
}
main();
