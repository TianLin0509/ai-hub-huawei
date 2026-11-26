'use strict';
// R47：一句话组队的启动链路验收。Hidden isolated Hub + production hub-team CLI; CodeAgent is a local fixture, not a model.
// 夹具代替「遵守系统提示的模型」：只有启动参数里的系统提示带组队指路时，它才按指路去 status → accounts → propose。
// The fixture stands in for a model that obeys the launch system prompt; no real model is called.
// 用法：node tests/e2e-r47-team-guide-cdp.js [--out <截图目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const { writeProbed } = require('../core/codeagent-model-probe');

const REPO = path.resolve(__dirname, '..');
const outAt = process.argv.indexOf('--out');
const ART = path.resolve(outAt > 0 ? process.argv[outAt + 1] : path.join(REPO, 'artifacts', `r47-team-guide-${Date.now()}`));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r47-team-guide-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl');
const MODEL = 'GLM-5.2-WX-Auto';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 60000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(250); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
function seed(dir, accountId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: MODEL }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [MODEL], defaultModel: MODEL, source: 'test-fixture' });
}
const launches = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v => !v.probe && Array.isArray(v.args)) : [];
const systemPromptOf = sid => {
  const v = launches().filter(l => l.hubSession === sid).at(-1);
  if (!v) return null;
  const at = v.args.indexOf('--append-system-prompt-file');
  return at >= 0 ? fs.readFileSync(v.args[at + 1], 'utf8') : '';
};

async function run() {
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  seed(PERSONAL, 'p-fixture');
  const a = pool.addAccount(DATA, { note: '组队指路夹具' });
  seed(pool.accountDir(DATA, a), 'a-fixture');
  const evidence = { checks: [], root: ROOT, art: ART, model: 'none; local CodeAgent fixture stands in for the model' };
  const ok = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', extraEnv: {
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK,
      AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      CODEAGENT_TEAM_FAKE_GUIDE: '1', AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'),
      CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'),
    } });
    evidence.pid = hub.pid;
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('typeof selectSession === "function" && !!window.__teamUi'), 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 规则页整体关掉：指路仍要在。Rules page off: the guide must still be there.
    const off = await invoke('hub-rules:set-enabled', { enabled: false });
    ok('规则页通用规则已关闭', off.ok && off.data.official.enabled === false);

    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: 'R47 一句话组队负责人', codeagentAccount: 'pool', codeagentPoolPick: a, model: MODEL, codeagentModelPick: true } });
    ok('负责人 CodeAgent 会话已建', !!lead?.id);
    await wait(() => fs.existsSync(path.join(CONTROL, `${lead.id}.ready`)), 'lead fixture ready');
    const leadPrompt = systemPromptOf(lead.id);
    evidence.leadSystemPrompt = leadPrompt;
    ok('规则关闭时，负责人启动参数里的系统提示仍带组队指路', !!leadPrompt && leadPrompt.includes('## 组队指路') && !leadPrompt.includes('【通用规则'));

    await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
    const box = `.floating-input-bar[data-session-id="${lead.id}"] .floating-input-box`;
    await click(box);
    const sentence = '组个队做一个登录页：一人实现，一人审查';
    await cdp.send('Input.insertText', { text: sentence });
    await sleep(300);
    await shot('01-typed-one-sentence');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

    const guideFile = path.join(CONTROL, `${lead.id}.guide.json`);
    const record = await wait(() => fs.existsSync(guideFile) && JSON.parse(fs.readFileSync(guideFile, 'utf8')), 'fixture followed guide');
    evidence.fixtureRecord = record;
    ok('夹具收到用户这句话，并在系统提示里读到指路', record.text.includes('组个队') && record.guide === true);
    ok('负责人所在号池目录里的 company-team 技能文件可读', record.skillReadable === true
      && path.resolve(record.skillFile) === path.resolve(pool.accountDir(DATA, a), 'skills', 'company-team', 'SKILL.md'));
    ok('组队命令走的是 Hub 数据目录下真实的 team/hub-team.cmd（PowerShell 调用，同技能第 0 节）', record.teamCommandExists === true
      && path.resolve(record.teamCommand) === path.resolve(DATA, 'team', 'hub-team.cmd'));
    ok('按指路依次跑了 status、accounts、propose', record.steps.map(s => s.args[0]).join(',') === 'status,accounts,propose' && record.steps.every(s => s.code === 0));
    const proposal = JSON.parse(record.steps[2].out);
    evidence.proposal = proposal;
    ok('组队提案已提交且按默认自动批准', proposal.status === 'approved');

    const team = await wait(async () => { const t = (await invoke('team:list')).result.find(x => x.leadSid === lead.id || x.lead === lead.id) || (await invoke('team:list')).result[0]; return t && t.members.length === 2 && t.members.every(m => m.status === 'active') && t; }, 'two members active', 90000);
    ok('两名成员建好并在队', team.members.length === 2);
    await wait(() => cdp.eval(`document.querySelectorAll('[data-sidebar-render-key="team:${lead.id}"] .session-item.child').length===2`), 'sidebar members');
    await sleep(800);
    await shot('02-sidebar-team-members');
    for (const m of team.members) {
      await wait(() => fs.existsSync(path.join(CONTROL, `${m.sid}.ready`)), 'member fixture ready');
      const p = systemPromptOf(m.sid);
      ok(`${m.memberId} 是 Hub 招来的子会话，系统提示不带组队指路`, p !== null && !p.includes('## 组队指路'));
    }
    const answered = await wait(() => cdp.eval(`(()=>{const t=document.body.innerText;return t.includes('已按组队指路提交组队计划')})()`).catch(() => false), 'lead answer visible', 30000).catch(() => false);
    evidence.leadAnswerVisible = answered;
    await cdp.eval(`selectSession(${JSON.stringify(lead.id)})`);
    await sleep(800);
    await shot('03-lead-after-propose');
    evidence.ok = true;
  } catch (error) { evidence.ok = false; evidence.error = error.stack; process.exitCode = 1; try { if (cdp) await shot('99-failure'); } catch {} }
  finally {
    if (cdp) await cdp.close();
    if (hub) {
      fs.writeFileSync(path.join(ART, 'r47-hub.log'), hub.log().join('\n'));
      try { evidence.exit = await gracefulQuit(hub); } catch (error) { evidence.ok = false; evidence.quitError = error.message; process.exitCode = 1; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); hub.child.stdin?.destroy(); }
    }
    fs.writeFileSync(path.join(ART, 'r47-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, art: ART, error: evidence.error }));
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
