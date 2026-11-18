'use strict';
// Real meeting renderer + real MeetingCompanion, isolated files; native CLI/network/capture are not used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..'), out = path.join(repo, 'artifacts/meeting-auto-default');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function fixture(repo, root) {
  const { MeetingCompanion } = require(repo + '/core/company-assistant/meeting');
  const engine = require(repo + '/core/company-assistant/meeting-engine');
  const fs = require('node:fs'), path = require('node:path');
  const DS = 'deepseek-v4.1-flash-1017', GLM = 'GLM-5.2-WX';
  const personalDir = path.join(root, 'test-personal'), dataDir = path.join(root, 'test-models');
  fs.mkdirSync(personalDir, { recursive: true });
  fs.writeFileSync(path.join(personalDir, 'settings.json'), JSON.stringify({ model: DS }));
  const probed = require(repo + '/core/codeagent-pool').personalModelsFile(dataDir);
  fs.mkdirSync(path.dirname(probed), { recursive: true });
  fs.writeFileSync(probed, JSON.stringify({ at: new Date().toISOString(), source: 'serve', models: [DS], defaultModel: DS }));
  const created = [], sessions = new Map();
  let menuReady = false, catalogState = 'loading', reads = 0, retries = 0;
  const fullModels = [DS, 'glm-4.7-w8a8', 'qwen3.8-27b'];
  const models = [{ id: GLM }, { id: DS }];
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false }, {
    dataDir, meetingAsr: { status: () => ({ ready: true }) }, powerSaveBlocker: {},
    // Fresh Hub data has no menu cache; Claude+GLM must not outrank the validated default.
    meetingModels: () => menuReady ? require(repo + '/core/codeagent-config').localModelOptions(dataDir) : [], meetingTerminals: () => ({ codeagent: true, claude: models }),
    meetingDefaultEngine: () => engine.accountDefault({ dataDir, personalDir }),
    getSession: id => sessions.get(id), createSession: async (kind, opts) => { created.push({ kind, model: opts.model }); sessions.set(opts.id, { kind, ...opts }); },
    closeSession: async id => sessions.delete(id),
  });
  m.timer = 1; m.tools = { start: async () => {}, bind() {}, close() {} }; m.keepAwake = () => {};
  const first = m.create({ title: '会议默认模型验证（模拟客户端）', audio: [] });
  await m.ensureLane(first.id, 'job');
  const saved = m.load(first.id); saved.state = 'ended'; saved.primeRequested = false; saved.questionPrimeRequested = false; m.save(saved);
  // Exercise the real control/save path, but not the background dispatch loop or any business tools.
  m.tick = async () => {};
  const publishModels = next => {
    catalogState = next;
    if (next === 'ready') {
      require(repo + '/core/codeagent-model-probe').writeProbed(probed, { models: fullModels, defaultModel: DS, source: 'serve' }); menuReady = true;
    }
    ipcRenderer.emit('codeagent-pool:changed', {}, { id: 'personal', ok: next === 'ready' });
  };
  window.meetingDefaultFixture = { id: first.id, created, m, publishModels, stats: () => ({ reads, retries }),
    configuredDefault: () => JSON.parse(fs.readFileSync(path.join(personalDir, 'settings.json'), 'utf8')).model };
  const invoke = ipcRenderer.invoke.bind(ipcRenderer);
  ipcRenderer.invoke = async (channel, args = {}) => {
    if (channel === 'codeagent:models') {
      if (args.account !== 'personal') throw Error('unexpected model account'); reads++;
      return { options: menuReady ? fullModels.map(id => ({ id })) : [], catalog: { state: catalogState, error: catalogState === 'failed' ? '模拟网络暂不可用' : '' } };
    }
    if (channel === 'codeagent-pool:probe') {
      if (args.id !== 'personal') throw Error('unexpected probe account'); retries++; publishModels('ready'); return { ok: true };
    }
    if (channel === 'company-assistant:meeting-status') return m.status(args.id || first.id);
    if (channel === 'company-assistant:meeting-sources') return { ok: true, sources: [] };
    if (channel === 'company-assistant:meeting-control') {
      m.control(args.id, args.op, args.value); await m.ensureLane(args.id, 'job'); return m.status(args.id);
    }
    if (channel.startsWith('company-assistant:meeting-')) throw Error('unexpected meeting action: ' + channel);
    return invoke(channel, args);
  };
  return { created, preferred: m.status(first.id).recommendedEngine };
}
(async () => {
  let hub, c; const result = { passed: false, evidence: '真实会议界面与服务；CLI创建为模拟，无公司请求、无录音采集' };
  fs.mkdirSync(out, { recursive: true });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-auto-ui-'));
    for (const dir of ['data', 'work', 'personal', 'scan']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'work', '.aiwork-root'), '');
    fs.writeFileSync(path.join(root, 'data', 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
    const welink = path.join(root, 'no-welink.js'); fs.writeFileSync(welink, 'process.stdout.write(JSON.stringify({authenticated:false}));');
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'meeting auto default test', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'work'), AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_WELINK_CLI: welink,
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false }, foreign: { ok: false } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const until = async expr => { for (let i = 0; i < 120; i++) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('timeout: ' + expr); };
    const click = async selector => {
      const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
    };
    await until('!!document.getElementById("btn-company-meeting")');
    result.initial = await c.eval('(' + fixture.toString() + ')(' + JSON.stringify(repo) + ',' + JSON.stringify(root) + ')');
    assert.equal(result.initial.preferred, 'codeagent|deepseek-v4.1-flash-1017');
    await click('#btn-company-meeting');
    await until('!!document.querySelector("[data-m=engine]")?.options.length');
    await click('[data-m=more] > summary');
    await c.eval(`(()=>{const e=document.querySelector('[data-m=history]');e.value=meetingDefaultFixture.id;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.querySelector("[data-m=history]").value === meetingDefaultFixture.id');
    // 选择历史会议会收起“更多”，交互前重新展开，不能点击折叠区域的零尺寸坐标。
    if (!await c.eval('document.querySelector("[data-m=more]").open')) await click('[data-m=more] > summary');
    result.autoLabel = await c.eval('document.querySelector("[data-m=engine]").options[0].textContent');
    assert.match(result.autoLabel, /自动.*CodeAgent.*deepseek/);
    await until('meetingDefaultFixture.stats().reads > 0');
    assert.match(await c.eval('document.querySelector("[data-m=model-catalog-status]").textContent'), /正在读取/);
    await c.eval('meetingDefaultFixture.publishModels("ready")');
    await until('[...document.querySelector("[data-m=engine]").options].some(o=>o.value==="codeagent|qwen3.8-27b")');
    result.codeagentOptions = await c.eval('[...document.querySelector("[data-m=engine]").options].map(o=>o.value).filter(id=>id.startsWith("codeagent|"))');
    assert.deepEqual(result.codeagentOptions.sort(), ['codeagent|deepseek-v4.1-flash-1017', 'codeagent|glm-4.7-w8a8', 'codeagent|qwen3.8-27b'].sort());
    assert.equal(await c.eval('document.querySelector("[data-m=engine]").value'), '');
    await c.eval(`(()=>{const e=document.querySelector('[data-m=engine]');e.value='codeagent|glm-4.7-w8a8';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('meetingDefaultFixture.created.at(-1).model === "glm-4.7-w8a8"');
    await c.eval('meetingDefaultFixture.publishModels("failed")');
    await until('!document.querySelector("[data-m=model-catalog-retry]").hidden');
    assert.equal(await c.eval('document.querySelector("[data-m=engine]").value'), 'codeagent|glm-4.7-w8a8');
    await click('[data-m=model-catalog-retry]');
    await until('document.querySelector("[data-m=model-catalog]").hidden');
    result.catalogSync = await c.eval('meetingDefaultFixture.stats()');
    assert.equal(result.catalogSync.retries, 1);
    assert.equal(await c.eval('meetingDefaultFixture.configuredDefault()'), 'deepseek-v4.1-flash-1017');
    if (!await c.eval('document.querySelector("[data-m=more]").open')) await click('[data-m=more] > summary');
    fs.writeFileSync(path.join(out, 'meeting-auto.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await c.eval(`(()=>{const e=document.querySelector('[data-m=engine]');e.value='claude|GLM-5.2-WX';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('meetingDefaultFixture.created.at(-1).kind === "claude"');
    await c.eval(`(()=>{const e=document.querySelector('[data-m=engine]');e.value='';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('meetingDefaultFixture.created.at(-1).kind === "codeagent"');
    result.created = await c.eval('meetingDefaultFixture.created');
    assert.deepEqual(result.created.map(x => x.model), ['deepseek-v4.1-flash-1017', 'glm-4.7-w8a8', 'GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
    result.passed = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; }
  finally {
    if (hub) fs.writeFileSync(path.join(out, 'gui-hub.log'), hub.log().join('\n'));
    c?.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, 'gui-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
})();
