'use strict';
// 问问 Hub（2026-11-19）：引擎顺序、只读参数、60 秒总时限、取消与杀进程树、说明书注入、两份说明书的公开版泄露复查、主进程服务、底栏按钮。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHelpAskEngine, buildPrompt, manualFile, preferredOrder, childEnv, codeAgentArgs, claudeArgs, codexArgs, readOnlyCapable } = require('../core/help-ask/engine');
const { createHelpAskService, editionOf } = require('../main/help-ask-service');
const { helpAskButtonHtml, answerBlocks } = require('../renderer/help-ask-ui');
const { runOnce } = require('../core/company-assistant/ppt-map-model');

const ROOT = path.resolve(__dirname, '..');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-ask-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// 公司 CodeAgent 1.2615 的 --help 里实际有的参数（2026-11-19 维护人取回）；没有 --max-turns。
const CODEAGENT_HELP = '-p, --print --model --output-format --effort --tools --permission-mode --strict-mcp-config --no-session-persistence --disable-update --skip-safe-check';
const CLAUDE_HELP = '-p, --print --tools --permission-mode --strict-mcp-config --no-session-persistence --max-turns --settings';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function engineWith(t, { found = {}, run, edition = 'member', env = {}, totalMs, models = [], current = '', config = {} } = {}) {
  const dataDir = tmp(t);
  const personal = path.join(dataDir, 'personal'); fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: current }));
  if (models.length) require('../core/codeagent-models').recordMenu(dataDir, models, { complete: true });
  const calls = [];
  const engine = createHelpAskEngine({
    dataDir, edition, env: { ...env, AI_HUB_CODEAGENT_CONFIG_DIR: personal }, totalMs, getConfig: () => config,
    findCommand: id => found[id] || null,
    resolveCodeAgent: () => ({ command: found.codeagent, configDir: personal }),
    codexMcpNames: () => ['wireless', 'bad name'],
    runOnce: async opts => {
      calls.push(opts);
      if (opts.args[0] === '--help' || opts.args[1] === '--help') return { code: 0, stdout: /claude/.test(opts.command) ? CLAUDE_HELP : CODEAGENT_HELP };
      return run ? run(opts) : { code: 0, stdout: JSON.stringify({ type: 'result', result: '答案' }) };
    },
    manualPath: () => manualFile('member'),
  });
  return { engine, calls, dataDir };
}
// 模拟一个一直不回、直到被取消的子进程。
const hang = opts => new Promise(resolve => { opts.signal.addEventListener('abort', () => resolve({ code: null, stdout: '', aborted: true }), { once: true }); });

test('引擎顺序：成员版先 CodeAgent；公开版先用已登录的 Claude Code / Codex；可用环境变量或配置改', () => {
  assert.deepEqual(preferredOrder({ env: {}, edition: 'member' }), ['codeagent', 'claude', 'codex']);
  assert.deepEqual(preferredOrder({ env: {}, edition: 'public' }), ['claude', 'codex', 'codeagent']);
  assert.deepEqual(preferredOrder({ env: { AI_HUB_HELP_ASK_ENGINE: 'codex' }, edition: 'member' }), ['codex', 'codeagent', 'claude']);
  assert.deepEqual(preferredOrder({ env: {}, preferred: 'codeagent', edition: 'public' }), ['codeagent', 'claude', 'codex']);
  assert.deepEqual(preferredOrder({ env: { AI_HUB_HELP_ASK_ENGINE: 'bogus' }, edition: 'member' }), ['codeagent', 'claude', 'codex']);
});

test('只读参数：CodeAgent、Claude Code 关工具（--tools 空串）、默认权限、不起 MCP、不留会话；只加 --help 里有的参数', () => {
  const ca = codeAgentArgs('deepseek-v4.1-flash-1017', CODEAGENT_HELP);
  for (const flag of ['--tools', '--permission-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-update', '--skip-safe-check']) assert.ok(ca.includes(flag), flag);
  assert.equal(ca[ca.indexOf('--tools') + 1], '');
  assert.equal(ca[ca.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!ca.includes('--max-turns'), '公司 CodeAgent 的 --help 里没有 --max-turns，就不传');
  assert.ok(!ca.includes('--mcp-config'));
  assert.deepEqual(codeAgentArgs('m', ''), ['-p', '--model', 'm'], '没探测到 --help 时不乱加参数');
  const cl = claudeArgs(CLAUDE_HELP, { settingsFile: 'C:/s.json' });
  for (const flag of ['--tools', '--permission-mode', '--strict-mcp-config', '--no-session-persistence', '--max-turns', '--settings']) assert.ok(cl.includes(flag), flag);
  assert.equal(cl[cl.indexOf('--tools') + 1], '');
  const cx = codexArgs('C:/o.txt', ['wireless', 'bad name']);
  assert.deepEqual(cx.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.ok(cx.includes('mcp_servers.wireless.enabled=false'));
  assert.ok(!cx.some(a => /bad name/.test(a)), '名字不安全的 MCP 不拼进命令行');
  assert.equal(cx.at(-1), '-');
});

test('一个 AI 命令行都没有：不起进程，回 needSetup 让界面就地给安装和登录按钮', async t => {
  const { engine, calls } = engineWith(t);
  assert.equal(engine.state().engine, null);
  const r = await engine.ask({ question: '回车键在哪改' });
  assert.equal(r.ok, false); assert.equal(r.needSetup, true);
  assert.equal(calls.length, 0);
});

test('成员版 CodeAgent：跟随新建会话默认，模型权限失败后从账号清单换一次；说明书和问题经标准输入传', async t => {
  let n = 0;
  const { engine, calls, dataDir } = engineWith(t, { found: { codeagent: 'C:/x/codeagent.cmd' },
    current: 'GLM-5.2-WX-Auto', models: ['GLM-5.2-WX-Auto', 'fixture-next'],
    config: { defaultModels: { codeagent: 'fixture-next' } },
    run: () => (++n === 1 ? { code: 1, stderr: '模型不存在' } : { code: 0, stdout: JSON.stringify({ type: 'result', result: '设置菜单 →「⚙️ 设置」' }) }) });
  const r = await engine.ask({ question: '回车想换行在哪改？' });
  assert.equal(r.ok, true); assert.equal(r.engine, 'codeagent'); assert.equal(r.model, 'GLM-5.2-WX-Auto');
  const asks = calls.filter(c => c.args[0] === '-p');
  assert.deepEqual(asks.map(c => c.args[2]), ['fixture-next', 'GLM-5.2-WX-Auto']);
  assert.equal(r.warning, '已改用 GLM-5.2-WX-Auto');
  assert.match(asks[0].input, /【使用说明书开始】[\s\S]*## 2\. 界面地图[\s\S]*【使用说明书结束】/);
  assert.match(asks[0].input, /【用户问题】\n回车想换行在哪改？/);
  assert.equal(asks[0].cwd, path.join(dataDir, 'help-ask', 'cwd'), '工作目录是 Hub 数据目录下的空文件夹，不是用户项目');
  await engine.ask({ question: '再问一次' });
  assert.equal(calls.filter(c => c.args[0] === '--help').length, 2, '默认引擎缓存 --help；替代模型独立只读探测一次');
});

test('没有功能覆盖时每次重新读新建会话默认；没设 Hub 默认则跟随 CLI，未知清单不写死旧模型', async t => {
  const config = { defaultModels: { codeagent: 'fixture-new' } };
  const { engine, calls } = engineWith(t, { found: { codeagent: 'fixture' }, current: 'fixture-cli',
    models: ['fixture-cli', 'fixture-new'], config });
  await engine.ask({ question: '问题一' });
  config.defaultModels.codeagent = 'fixture-cli'; await engine.ask({ question: '问题二' });
  delete config.defaultModels.codeagent; await engine.ask({ question: '问题三' });
  assert.deepEqual(calls.filter(c => c.input).map(c => c.args[c.args.indexOf('--model') + 1]), ['fixture-new', 'fixture-cli', 'fixture-cli']);
  const unknown = engineWith(t, { found: { codeagent: 'fixture' }, current: 'fixture-unknown' });
  await unknown.engine.ask({ question: '权限清单尚未读到' });
  assert.equal(unknown.calls.find(c => c.input).args[2], 'fixture-unknown');
});

test('Claude 和 Codex 默认同样读取新建会话设置', async t => {
  for (const [kind, model] of [['claude', 'claude-haiku-4-5'], ['codex', 'gpt-5.4']]) {
    const { engine, calls } = engineWith(t, { edition: 'public', found: { [kind]: kind }, config: { defaultModels: { [kind]: model } },
      run: spec => { if (kind === 'codex') fs.writeFileSync(spec.args[spec.args.indexOf('--output-last-message') + 1], '答案'); return { code: 0, stdout: '答案' }; } });
    const result = await engine.ask({ question: '设置在哪' });
    assert.equal(result.ok, true); assert.equal(result.model, model);
    const ask = calls.find(c => c.input); assert.equal(ask.args[ask.args.indexOf('--model') + 1], model);
  }
});

test('同事中文模型权限报错只重试一次；替代也失败时不再走其他引擎', async t => {
  const { engine, calls } = engineWith(t, { found: { codeagent: 'fixture', claude: 'claude' }, current: 'GLM-5.2-WX-Auto',
    models: ['GLM-5.2-WX-Auto', 'fixture-next', 'fixture-third'],
    run: () => ({ code: 0, stdout: JSON.stringify({ type: 'result', is_error: true, result: '您当前的模型 GLM-5.2-WX-Auto 可能已经升级或被调整了权限' }) }) });
  const result = await engine.ask({ question: '权限错误' });
  assert.equal(result.ok, false); assert.match(result.error, /请重试或选模型/);
  assert.deepEqual(calls.filter(c => c.input).map(c => c.args[2]), ['GLM-5.2-WX-Auto', 'fixture-next']);
});

test('权限清单没有其他模型时直接给选模型出口；网络错误不冒充权限错误', async t => {
  const { engine, calls } = engineWith(t, { found: { codeagent: 'fixture' }, current: 'fixture-only', models: ['fixture-only'],
    run: () => ({ code: 1, stderr: 'model not found' }) });
  const result = await engine.ask({ question: '只有一个模型' });
  assert.match(result.error, /未找到其他可用模型/); assert.equal(calls.filter(c => c.input).length, 1);
  const classify = require('../core/help-ask/model-choice').modelUnavailable;
  for (const error of ['Not logged in', '401 Unauthorized', 'network timeout', 'rate limit', '403 Forbidden']) assert.equal(classify(Error(error)), false, error);
  for (const error of ['model_not_found', 'You do not have access to model X', '当前模型无权限']) assert.equal(classify(Error(error)), true, error);
});

test('功能显式模型仍优先；失败替代跳过已知不可用模型，不改用户默认或功能选择', async t => {
  const choice = { kind: 'codeagent', model: 'fixture-explicit' };
  t.mock.method(require('../core/feature-agent-choice'), 'resolve', () => ({ selected: choice }));
  const config = { defaultModels: { codeagent: 'fixture-blocked' } };
  const { engine, calls, dataDir } = engineWith(t, { found: { codeagent: 'fixture' }, config,
    current: 'fixture-cli', models: ['fixture-explicit', 'fixture-blocked', 'fixture-cli'],
    run: spec => spec.args[2] === 'fixture-explicit' ? { code: 1, stderr: 'model unavailable' } : { code: 0, stdout: JSON.stringify({ type: 'result', result: '替代回答' }) } });
  require('../core/codeagent-quota').markModelAvoid(dataDir, 'personal', { model: 'fixture-blocked', reason: 'model-config' });
  const result = await engine.ask({ question: '显式选择' });
  assert.equal(result.ok, true); assert.equal(result.warning, '已改用 fixture-cli');
  const asks = calls.filter(c => c.input);
  assert.deepEqual(asks.map(c => c.args[2]), ['fixture-explicit', 'fixture-cli']);
  for (const call of asks) { assert.equal(call.args[call.args.indexOf('--tools') + 1], ''); assert.ok(call.args.includes('--strict-mcp-config')); }
  assert.deepEqual(choice, { kind: 'codeagent', model: 'fixture-explicit' });
  assert.equal(config.defaultModels.codeagent, 'fixture-blocked');
});

test('替代模型与首请求共用总时限，到点停止且没有第三次调用', async t => {
  let n = 0;
  const { engine, calls } = engineWith(t, { totalMs: 200, found: { codeagent: 'fixture' }, current: 'fixture-first', models: ['fixture-first', 'fixture-next', 'fixture-third'],
    run: opts => ++n === 1 ? { code: 1, stderr: 'model unavailable' } : hang(opts) });
  const result = await engine.ask({ question: '替代超时' });
  assert.equal(result.timedOut, true); assert.equal(calls.filter(c => c.input).length, 2);
  assert.ok(calls.filter(c => c.input).every(c => c.signal.aborted));
});

test('公开版先用 Claude Code；它快速失败再换 Codex（MCP 逐个关掉）', async t => {
  const { engine, calls } = engineWith(t, { edition: 'public', found: { claude: 'C:/x/claude.exe', codex: 'C:/x/codex.cmd', codeagent: 'C:/x/codeagent.cmd' },
    run: opts => {
      if (/claude/.test(opts.command)) return { code: 1, stderr: '请先 /login' };
      const out = opts.args[opts.args.indexOf('--output-last-message') + 1]; fs.writeFileSync(out, 'Codex 的答案'); return { code: 0, stdout: '' };
    } });
  const r = await engine.ask({ question: '怎么升级' });
  assert.equal(r.ok, true); assert.equal(r.engine, 'codex'); assert.equal(r.answer, 'Codex 的答案');
  assert.equal(r.tried[0].engine, 'claude'); assert.match(r.tried[0].error, /login/);
  assert.ok(calls.find(c => c.args[0] === 'exec' && c.args.includes('mcp_servers.wireless.enabled=false')));
  assert.ok(!calls.some(c => c.command.includes('codeagent')), 'Codex 答出来了就不再起 CodeAgent');
});

test('总时限：含探测一共 60 秒（这里缩成 0.3 秒），到点结束进程、不再换模型或引擎，回「这次没答上来」', async t => {
  const { engine, calls } = engineWith(t, { totalMs: 300, found: { codeagent: 'C:/x/codeagent.cmd', claude: 'C:/x/claude.exe' }, run: hang });
  const t0 = Date.now();
  const r = await engine.ask({ question: '卡住的问题' });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true);
  assert.match(r.error, /这次没答上来/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(calls.filter(c => c.args[0] === '-p').length, 1, '只起了一个模型进程');
  assert.ok(calls.every(c => c.timeoutMs <= Math.max(1000, 300) + 2000), '子进程时限按剩余总时间给（最少 1 秒，多 2 秒让总时限先到）');
  assert.ok(calls.find(c => c.args[0] === '-p').signal.aborted, '到点发了取消（runOnce 据此结束进程树）');
});

test('取消：外部取消立即结束，不换下一个引擎', async t => {
  const { engine, calls } = engineWith(t, { found: { codeagent: 'C:/x/codeagent.cmd', claude: 'C:/x/claude.exe' }, run: hang });
  const ac = new AbortController();
  const pending = engine.ask({ question: '要取消的问题', signal: ac.signal });
  await sleep(50); ac.abort();
  const r = await pending;
  assert.equal(r.ok, false); assert.equal(r.cancelled, true);
  assert.equal(calls.filter(c => c.args[0] === '-p').length, 1);
});

test('Windows 真进程：空字符串参数经 cmd /d /s /c 后仍在；取消会结束整个进程树（含孙进程）', { skip: process.platform !== 'win32' }, async t => {
  const dir = tmp(t);
  const echo = path.join(dir, 'echo-args.js');
  fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const r = await runOnce({ command: process.execPath, args: [echo, '--tools', '', '--strict-mcp-config'], cwd: dir, env: process.env, timeoutMs: 20000 });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), ['--tools', '', '--strict-mcp-config']);

  const parent = path.join(dir, 'parent.js'), pids = path.join(dir, 'pids.json');
  fs.writeFileSync(parent, [
    "const { spawn } = require('child_process');",
    "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    `require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, c.pid]));`,
    'setInterval(() => {}, 1000);'].join('\n'));
  const ac = new AbortController();
  const running = runOnce({ command: process.execPath, args: [parent], cwd: dir, env: process.env, timeoutMs: 60000, signal: ac.signal });
  for (let i = 0; i < 100 && !fs.existsSync(pids); i++) await sleep(100);
  const [p, c] = JSON.parse(fs.readFileSync(pids, 'utf8'));
  ac.abort();
  const done = await running;
  assert.equal(done.aborted, true);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && (alive(p) || alive(c)); i++) await sleep(100);
  assert.equal(alive(p), false, '子进程已结束'); assert.equal(alive(c), false, '孙进程已结束');
});

test('主进程服务：取消后马上能问下一题，旧问答的收尾不占名额', async t => {
  const dataDir = tmp(t);
  const signals = [];
  const engine = { state: () => ({ engine: 'codeagent', manualPath: null }),
    ask: ({ signal }) => { signals.push(signal); return new Promise(r => signal.addEventListener('abort', () => setTimeout(() => r({ ok: false, cancelled: true, error: '已取消' }), 200))); } };
  const svc = createHelpAskService({ getHubDataDir: () => dataDir, distribution: { target: 'company', featureEnabled: () => false }, createEngine: () => engine, getConfig: () => ({}) });
  const first = svc.ask({ question: '第一个' });
  assert.equal(svc.cancel(), true);
  assert.equal(signals[0].aborted, true);
  assert.equal(svc.state().busy, false, '取消后立刻放开');
  const second = svc.ask({ question: '第二个' });
  assert.equal(svc.state().busy, true);
  assert.equal((await first).cancelled, true);
  assert.equal(svc.state().busy, true, '旧问答收尾不会清掉新问答的名额');
  svc.cancel(); await second;
});

test('提示词：规则在前、追问只带最近 3 轮、子进程不带 Hub 会话变量', () => {
  const p = buildPrompt({ manual: 'M', question: 'Q', history: [1, 2, 3, 4].map(i => ({ q: 'q' + i, a: 'a' + i })) });
  assert.match(p, /^你是「AI HUB-H」/);
  assert.match(p, /优先按 Hub 说明书回答 AI Hub 自身的设置与数据目录/);
  assert.match(p, /只有明确询问 CodeAgent 等 CLI 自身配置时才回答该工具/);
  assert.ok(!p.includes('q1') && p.includes('q2') && p.includes('q4'));
  const env = childEnv({ CLAUDE_HUB_SESSION_ID: 'x', CLAUDE_HUB_TOKEN: 'y', CODEAGENT_HUB_X: 'z', PATH: 'p' });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

test('说明书：成员版、公开版各一份；公开版没有成员版专属内容，过公开版泄露规则，也没有人名和工号', () => {
  const pub = fs.readFileSync(path.join(ROOT, 'core/help-ask/manual-public.md'), 'utf8');
  const memberFile = path.join(ROOT, 'core/help-ask/manual-member.md');
  const member = fs.existsSync(memberFile) ? fs.readFileSync(memberFile, 'utf8') : null; // 公开版里没有成员版那份
  assert.match(pub, /^# AI HUB-H 使用说明书（公开版）/);
  for (const text of [member, pub].filter(Boolean)) for (const h of ['## 1. 入门', '## 2. 界面地图', '### 2.4 设置菜单', '### 2.5 配置弹窗', '## 4. 常见问题', '## 5. 最近更新', '## 6. 遇到问题怎么一键反馈']) assert.ok(text.includes(h), h);
  if (member) { assert.match(member, /^# AI HUB-H 使用说明书（成员版）/); assert.match(member, /「用户群」/); }
  assert.ok(!pub.includes('「用户群」'));
  assert.doesNotMatch(pub, /(?<![\d.\w])[a-zA-Z]?\d{8}(?![\d.\w])/);
  assert.doesNotMatch(pub, new RegExp('\u7530\u54e5|\u6797\u7530|hua' + 'wei\.com'));
  // 成员库里再用公开版泄露规则全文复查，并确认成员版那份和生成脚本不进公开版（公开版里这两个文件本身不存在）
  const rules = path.join(ROOT, 'tools', 'public-edition', 'public-rules.js');
  const targetFile = path.join(ROOT, 'tools', 'public-edition', 'public-target.json');
  if (fs.existsSync(rules) && fs.existsSync(targetFile)) {
    const { scanText } = require(rules);
    assert.deepEqual(scanText(pub, 'core/help-ask/manual-public.md').filter(h => h.severity !== 'warning'), []);
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.ok(target.drop.includes('core/help-ask/manual-member.md'));
    assert.ok(target.drop.includes('tools/help-manual/**'));
  }
});

test('说明书缺成员版时退回公开版', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'manual-public.md'), 'p');
  assert.equal(manualFile('member', dir), path.join(dir, 'manual-public.md'));
  assert.equal(manualFile('public', path.join(dir, 'none')), null);
});

test('主进程服务：同时只答一个；问答记本机历史；打开说明书复制到数据目录', async t => {
  const dataDir = tmp(t);
  let release;
  const engine = {
    state: () => ({ engine: 'codeagent', manualPath: path.join(ROOT, 'core/help-ask/manual-public.md') }),
    ask: () => new Promise(r => { release = () => r({ ok: true, answer: 'a', engine: 'codeagent', ms: 5 }); }),
  };
  const svc = createHelpAskService({ getHubDataDir: () => dataDir, distribution: { target: 'company', featureEnabled: () => false }, createEngine: () => engine, getConfig: () => ({}) });
  const first = svc.ask({ question: '第一个' });
  assert.equal(svc.state().busy, true);
  assert.equal((await svc.ask({ question: '第二个' })).busy, true);
  release();
  assert.equal((await first).ok, true);
  const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'help-ask', 'history.jsonl'), 'utf8').trim());
  assert.equal(line.q, '第一个'); assert.equal(line.ok, true); assert.ok(!('answer' in line));
  const opened = svc.openManual();
  assert.equal(opened.ok, true); assert.ok(fs.readFileSync(opened.path, 'utf8').startsWith('# AI HUB-H 使用说明书'));
  assert.equal(editionOf({ target: 'company', featureEnabled: n => n === 'memberUpgrade' }), 'public');
  assert.equal(editionOf({ target: 'company', featureEnabled: () => false }), 'member');
  assert.equal(editionOf({ target: null, featureEnabled: () => true }), 'public');
});

test('底栏按钮与回答渲染', () => {
  const html = helpAskButtonHtml();
  assert.match(html, /data-help-ask/); assert.match(html, /问问 Hub/); assert.match(html, /aria-controls="help-ask-panel"/);
  assert.deepEqual(answerBlocks('**结论**：在这里\n\n用 `设置`'), [[{ text: '结论：在这里' }], [{ text: '用 ' }, { code: '设置' }]]);
});

test('--help 没探测到 --tools（关不掉工具）时，这家引擎不用来答疑', () => {
  assert.equal(readOnlyCapable(''), false);
  assert.equal(readOnlyCapable('Usage: x -p --model'), false);
  assert.equal(readOnlyCapable(CLAUDE_HELP), true);
  assert.equal(readOnlyCapable(CODEAGENT_HELP), true);
});

test('底栏「问问 Hub」在整页视图上也看得见：面板层级高于整页视图、左栏和底栏，低于对话框（2026-11-20 反馈：只有主页能弹出）', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'renderer/help-ask-ui.js'), 'utf8');
  const z = Number(/\.ask\.help-ask-panel\s*\{\s*z-index:(\d+)/.exec(ui)?.[1]);
  const css = fs.readdirSync(path.join(ROOT, 'renderer/styles')).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(path.join(ROOT, 'renderer/styles', f), 'utf8')).join('\n');
  const pageZ = [...css.matchAll(/\.(?:company-[\w-]+-page|assistant-page|avatar-page|codeagent-accounts-page|profile-page)\s*\{[^}]*z-index:\s*(\d+)/g)].map(m => Number(m[1]));
  assert.ok(pageZ.length >= 5, '找到整页视图的层级');
  assert.ok(z > Math.max(...pageZ, 1000, 1100), `面板 ${z} 要高于整页视图 ${Math.max(...pageZ)}、左栏 1000、底栏 1100`);
  assert.ok(z < 5000, '低于对话框');
});
