'use strict';
// 真实验收（R58b）：公司版组队里招一名非 CodeAgent 成员，走完「建成员 → 开工任务送达 → 成员自己跑 hub-team send 交回 → 负责人收到」。
// 隔离 Hub、隐藏窗口、独立数据目录；负责人是本地 CodeAgent 协议夹具（不是模型），成员是真实 CLI：
//   --kind claude        Claude Code（公司版「本机 CLI 自带配置」线路），登录信息从 --claude-auth 复制进临时目录，默认用 haiku 省额度；
//   --kind deepseek-acp  DSH（公司版「自有接口」线路），接口地址与 Key 由环境变量 R58B_DSH_BASE_URL / R58B_DSH_API_KEY / R58B_DSH_MODEL 给，
//                        DSH 程序由 AI_HUB_CLI_TOOLS_DIR 指向的安装目录提供。Key 只进隔离数据目录，产物里不出现。
// 走真实界面：负责人提交计划后在侧栏点「待批准」、看审批表、点批准。
// 用法：node tests/e2e-company-team-mix-real.js --kind claude [--claude-auth <.credentials.json>] [--out <产物目录>]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { createHash } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const KIND = arg('--kind', 'claude');
// --scripted-model：DSH 用本机脚本模型（tests/helpers/scripted-openai-model.js），真实 DSH 程序、真实工具调用，不联网不花钱。
const SCRIPTED = argv.includes('--scripted-model');
if (!['claude', 'deepseek-acp'].includes(KIND)) throw Error('--kind 只能是 claude 或 deepseek-acp');
const LABEL = KIND === 'claude' ? 'Claude Code' : 'DSH';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'r58b-team-mix-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal');
const CONTROL = path.join(ROOT, 'fixture-control'), LOG = path.join(ROOT, 'fixture.jsonl'), CLAUDE_DIR = path.join(ROOT, 'claude');
const ART = path.resolve(arg('--out') || path.join(REPO, 'artifacts', `20261128-r58b-team-mix-${KIND}`));
const TOKEN = `R58B-MIX-${KIND.toUpperCase()}-${Date.now().toString(36)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 30000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(300); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
const launches = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(v => v.configDir) : [];
const secrets = [];
const scrub = text => { let t = String(text ?? ''); for (const s of secrets) if (s) t = t.split(s).join('***'); return t.replace(/sk-[\w.-]{8,}/g, 'sk-***'); };
const hashOf = file => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

function unlinkLinks(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { try { fs.unlinkSync(p); } catch {} } }
    else if (st.isDirectory()) unlinkLinks(p);
  }
}
function seedCodeAgent(dir, accountId, model) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId, expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
}
function seedClaude(authFile) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(authFile, path.join(CLAUDE_DIR, '.credentials.json'));
  fs.writeFileSync(path.join(CLAUDE_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, theme: 'light', projects: {} }));
  fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
}

async function run() {
  const marker = path.join(REPO, 'community-edition.json');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).target, 'company', 'Run in the company edition');
  for (const dir of [DATA, WORK, ART, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  const config = { team: { autoApproveLeads: false } };
  const extraEnv = {};
  let authFile = null, authBefore = null, dshRoute = null, scripted = null;
  if (KIND === 'claude') {
    authFile = path.resolve(arg('--claude-auth') || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'));
    authBefore = hashOf(authFile);
    seedClaude(authFile);
  } else {
    if (SCRIPTED) {
      scripted = await require('./helpers/scripted-openai-model').startScriptedModel({ log: shape => console.log('MODEL ' + JSON.stringify(shape)) });
      Object.assign(process.env, { R58B_DSH_BASE_URL: scripted.baseURL, R58B_DSH_API_KEY: 'scripted-local', R58B_DSH_MODEL: 'scripted-model' });
    }
    const baseURL = process.env.R58B_DSH_BASE_URL, apiKey = process.env.R58B_DSH_API_KEY, model = process.env.R58B_DSH_MODEL;
    if (!baseURL || !apiKey || !model) throw Error('DSH 用例要 R58B_DSH_BASE_URL / R58B_DSH_API_KEY / R58B_DSH_MODEL');
    secrets.push(apiKey);
    // Key 不落明文文件：Hub 起来后经设置页同一个保存入口（company-api:save）写入，保存时按 Hub 的规矩加密。
    dshRoute = { kind: 'deepseek-acp', baseURL, apiKey, model };
    // DSH 程序：R58B_DSH_CLI_ROOT 指向装好的运行环境；拼接目录建在临时目录里，测完连同链接一起摘掉。
    if (process.env.R58B_DSH_CLI_ROOT) extraEnv.AI_HUB_DSH_CLI_ROOT = path.resolve(process.env.R58B_DSH_CLI_ROOT);
    extraEnv.AI_HUB_CLI_TOOLS_DIR = path.join(ROOT, 'tools');
    extraEnv.AI_HUB_DSH_START_TIMEOUT_MS = '240000';
  }
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(config), 'utf8');
  seedCodeAgent(PERSONAL, 'p-fixture', 'GLM-5.2-WX');
  const evidence = { kind: KIND, token: TOKEN, checks: [], root: ROOT, artifacts: ART, lead: 'local CodeAgent protocol fixture (no model)',
    member: KIND === 'claude' ? 'real Claude Code CLI, model haiku' : SCRIPTED ? 'real DSH CLI with a local scripted model (not a real LLM)' : `real DSH CLI, model ${process.env.R58B_DSH_MODEL}` };
  const ok = (label, condition = true, detail) => { assert(condition, label + (detail ? ' :: ' + scrub(JSON.stringify(detail)) : '')); evidence.checks.push(label); console.log('PASS ' + label); };
  let hub, cdp, failure, seq = 0;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`);
  const click = async selector => {
    const p = await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(ART, `20261128-r58b-${KIND}-${name}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); (evidence.screenshots ||= []).push(f); };
  const command = async (sid, args, fail = false) => {
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'fixture ready', 60000);
    const id = ++seq, request = path.join(CONTROL, `${sid}.request`), result = path.join(CONTROL, `${sid}.${id}.response`);
    fs.writeFileSync(request + '.tmp', JSON.stringify({ id, args })); fs.renameSync(request + '.tmp', request);
    await wait(() => fs.existsSync(result), `CLI ${args[0]}`);
    const r = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (fail) { assert.notEqual(r.code, 0); return r.err; }
    assert.equal(r.code, 0, r.err || r.error); return JSON.parse(r.out);
  };
  const nativeReceived = (sid, needle) => launches().filter(v => v.hubSession === sid).some(v => {
    const file = path.join(v.configDir, 'projects', v.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${v.sessionId}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .some(r => r.type === 'user' && String(JSON.stringify(r.message?.content || '')).includes(needle));
  });
  const started = Date.now();
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'r58b team mix', extraEnv: {
      ...extraEnv, HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', AI_HUB_WORKSPACE_ROOT: WORK,
      AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_SERVE: '0',
      AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG, CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'empty-scan'), CLAUDE_CONFIG_DIR: CLAUDE_DIR, CODEX_HOME: path.join(ROOT, 'codex'),
      CLAUDE_HUB_HOME_DIR: path.join(ROOT, 'home'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '',
    } });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval('!!window.__teamUi'), 'renderer ready', 60000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    ok('公司发行标记生效，组队已开启', await cdp.eval("require('../core/distribution').target==='company' && require('../core/distribution').featureEnabled('leadTeam')"));
    if (dshRoute) {
      const saved = await invoke('company-api:save', dshRoute);
      assert.ok(saved?.ok, '保存 DSH 自有接口失败：' + scrub(saved?.error));
      ok('DSH 自有接口已按设置页入口保存（Key 加密落盘）', !fs.readFileSync(path.join(DATA, 'config.json'), 'utf8').includes(dshRoute.apiKey));
    }
    // 定位中心先查一遍，accounts 才有「装没装」的结论（启动中心打开时也会这样查）。
    await invoke('harness:locate-all', { fresh: true }).catch(() => null);
    const lead = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: 'R58b 负责人', codeagentAccount: 'personal' } });
    assert.ok(lead?.id, 'lead created');
    const accounts = await command(lead.id, ['accounts']);
    const backend = (accounts.backends || []).find(b => b.kind === KIND);
    evidence.backend = backend && { ...backend, models: (backend.models || []).slice(0, 5) };
    evidence.recommendedMix = accounts.recommendedMix;
    ok(`accounts 列出 ${LABEL} 且已就绪`, backend?.ready === true, backend);
    const planFile = path.join(ROOT, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ goal: 'R58b 混编回执验证', members: [{ role: '回执验证', title: `验证-${LABEL}`, kind: KIND, worktree: false,
      task: `只做一件事：用开工消息里给的 hub-team 命令向负责人交付，命令是 send --to lead --deliver --message "${TOKEN} 已收到开工任务"。` +
        '在你的终端或命令工具里直接运行它，看到返回 ok 就结束，不做别的事、不读文件、不改文件。' }] }), 'utf8');
    const plan = await command(lead.id, ['propose', '--plan-file', planFile]);
    ok('propose 提交待批准计划（自动批准已关）', plan.status === 'pending', plan);
    await wait(() => cdp.eval(`!!document.querySelector('[data-team-approve="${lead.id}"]')`), 'approval badge', 30000);
    await click(`[data-team-approve="${lead.id}"]`);
    await wait(() => cdp.eval("!!document.querySelector('.team-modal') && !document.querySelector('[data-team-act=approve]').disabled"), 'approval loaded', 30000);
    const modal = await cdp.eval(`(()=>{const m=document.querySelector('.team-modal');const a=document.querySelector('[data-team-account="0"]');return {text:m.textContent,account:a.selectedOptions[0]?.textContent||'',disabled:a.disabled,overflow:m.scrollWidth>m.clientWidth+1}})()`);
    ok(`审批表显示 ${LABEL} 后端，不点名账号`, modal.text.includes(LABEL) && modal.account.startsWith('不点名账号') && modal.disabled, modal);
    ok('审批表没有水平溢出', !modal.overflow);
    await shot('01-approval-1440');
    await click('[data-team-act="approve"]');
    await wait(() => cdp.eval("!document.querySelector('.team-modal')"), 'approved', 120000);
    const team = await wait(async () => { const t = (await invoke('team:list')).result[0]; const m = t?.members?.[0]; return m && ['active', 'failed'].includes(m.status) && t; }, 'member created', 180000);
    const member = team.members[0];
    evidence.memberRow = { memberId: member.memberId, status: member.status, kind: member.kind, model: member.model, error: member.error };
    ok(`批准后建出 ${LABEL} 成员`, member.status === 'active' && member.kind === KIND && !member.account, member);
    // 渲染端登记的会话信息：成员不走卡片共用进程，权限档沿用后台会话的缺省（完全放开），不会每步停下等人点。
    evidence.memberSession = await wait(() => cdp.eval(`(()=>{const s=typeof sessions!=='undefined'&&sessions.get(${JSON.stringify(member.sid)});return s?{kind:s.kind,hubTeamMember:!!s.hubTeamMember,cardRunMode:s.cardRunMode||null,permissionMode:s.permissionMode||null}:null})()`), 'member session info', 30000);
    ok('成员独立进程（不走卡片），权限不是每步确认', evidence.memberSession.cardRunMode !== 'card' && !['default', 'plan'].includes(evidence.memberSession.permissionMode), evidence.memberSession);
    await shot('02-member-in-sidebar');
    await wait(async () => { const t = (await invoke('team:list')).result[0]; return t.messages.some(m => m.from === 'lead' && m.to === member.memberId && m.state === 'sent'); }, 'kickoff submitted', 240000);
    ok('开工任务已提交给成员', true);
    const back = await wait(async () => { const t = (await invoke('team:list')).result[0]; return t.messages.find(m => m.from === member.memberId && m.to === 'lead'); }, 'member receipt via hub-team send', 600000);
    evidence.receipt = back;
    ok('成员自己跑 hub-team send 交回（Hub 按成员身份记账）', back.from === member.memberId);
    await wait(() => nativeReceived(lead.id, TOKEN), 'lead received the receipt text', 120000);
    ok('负责人会话收到带暗号的回执', true);
    const delivered = (await invoke('team:list')).result[0].members[0];
    ok('成员按 --deliver 记为已交付', delivered.delivered === true || delivered.status === 'dismissed', delivered);
    await shot('03-receipt-delivered');
    evidence.elapsedSec = Math.round((Date.now() - started) / 1000);
    evidence.passed = true;
  } catch (e) {
    failure = e; evidence.error = scrub(e.stack || String(e)); if (cdp) await shot('failure').catch(() => {});
  } finally {
    try { if (cdp) await cdp.close(); } catch {}
    try { if (hub) evidence.exit = await gracefulQuit(hub); } catch (e) { failure ||= e; evidence.exitError = scrub(e.stack); }
    if (hub) fs.writeFileSync(path.join(ART, `20261128-r58b-${KIND}-hub.log`), scrub(hub.log().join('\n')), 'utf8');
    if (scripted) { evidence.modelRequests = scripted.state.requests; await scripted.close(); }
    if (authFile) {
      evidence.authUnchanged = hashOf(authFile) === authBefore;
      if (!evidence.authUnchanged) failure ||= Error('原始登录文件被改动');
    }
    fs.writeFileSync(path.join(ART, `20261128-r58b-${KIND}-evidence.json`), scrub(JSON.stringify(evidence, null, 2)));
    // 临时目录里有复制来的登录信息或 Key：测完整个删掉。
    // DSH 会在会话目录里建指向安装目录的目录联接：先只摘链接，再删真实目录，删除不穿透到联接目标。
    try { unlinkLinks(ROOT); fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); evidence.cleaned = true; } catch (e) { console.warn('清理临时目录失败：' + ROOT + ' ' + e.message); }
    console.log('ARTIFACTS ' + ART);
  }
  if (failure) throw failure;
}
run().catch(e => { console.error(scrub(e.stack || e)); process.exitCode = 1; });
