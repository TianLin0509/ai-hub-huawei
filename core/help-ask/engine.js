'use strict';
// 「问问 Hub」答疑引擎（2026-11-19）：把《使用说明书》当上下文，起一次后台单次问答进程回答「XX 设置在哪」这类使用问题。
// - 只读（2026-11-19 审查要求）：三家都按各自 --help 实际支持的参数关掉工具、权限和 MCP——
//   CodeAgent / Claude Code：--tools ""、--permission-mode default、--strict-mcp-config（不给 --mcp-config 即不起任何 MCP）、--no-session-persistence；
//   Codex：exec --ephemeral --sandbox read-only，并把用户 config.toml 里的每个 MCP 逐个 enabled=false（-c mcp_servers={} 只合并不清空）。
//   工作目录是 Hub 数据目录下一个空文件夹，不碰用户的项目；一次性调用、不落会话记录，不新开 Hub 会话。
// - 引擎顺序（负责人 11-19 拍板）：成员版 CodeAgent → Claude Code → Codex；公开版先用用户已登录的 Claude Code → Codex，CodeAgent 最后。
//   配置 helpAsk.engine 或环境变量 AI_HUB_HELP_ASK_ENGINE 可指定先用哪个。
// - 时限：一个问题总共 60 秒（含 --help 探测）；到点结束整个进程树，不再换下一个引擎或模型，直接回「这次没答上来」。
//   某个引擎很快失败（没登录、没权限）才换下一个。--help 探测结果按引擎缓存。用户取消同样立即结束进程树。
// - 进程一律隐藏窗口；cmd 包装与杀进程树复用 company-assistant/ppt-map-model 的 runOnce。
// - 说明书按发行版选：成员版 manual-member.md，公开版 manual-public.md（公开版里没有成员版那份）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withDeadline } = require('./request-lifecycle');

const ENGINES = ['codeagent', 'claude', 'codex'];
const LABEL = { codeagent: 'CodeAgent', claude: 'Claude Code', codex: 'Codex' };
const TOTAL_MS = 60000;
const IDLE_MS = 45000; // 保留原有一分钟总上限，静默更早退出。
const MAX_QUESTION = 2000;
const MAX_HISTORY = 3;
const MAX_ANSWER = 20000;
const modelChoice = require('./model-choice');

function manualFile(edition, dir = __dirname) {
  const own = path.join(dir, edition === 'member' ? 'manual-member.md' : 'manual-public.md');
  if (fs.existsSync(own)) return own;
  const other = path.join(dir, 'manual-public.md');
  return fs.existsSync(other) ? other : null;
}

const RULES = [
  '你是「AI HUB-H」（桌面程序 AI HUB-Huawei）的答疑助手，只根据下面的《使用说明书》回答用户怎么用这个软件。',
  '规则：',
  '1. 只依据说明书作答。说明书里没有的，直接说「说明书里没有写这个」，建议点面板里的「一键反馈」或到用户群问维护人；不要猜，不要编造按钮或菜单。',
  '2. 涉及页面或设置时写出完整点击路径，例如：设置菜单 →「⚙️ 设置」→「回车键」。',
  '3. 先用一句话给结论，再列最多 5 步操作；用中文，简短，不要大段复制说明书原文。',
  '4. 只回答，不要调用任何工具，不要读写文件，不要执行命令。',
  '5. 问题和这个软件的使用无关时，说明你只回答 AI HUB-H 的使用问题。',
  '6. 按说明书标注的适用版本作答：第 3 节是现版操作，第 4 节已替换失效旧卡，仍带历史日期的答复仅适用于所注明时期；第 5 节旧版本记录只用于解释变更经过。之前的问答仅供理解追问，现版事实以说明书为准。',
].join('\n');

function buildPrompt({ manual, question, history = [] }) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  const past = (Array.isArray(history) ? history : []).filter(h => h && h.q && h.a).slice(-MAX_HISTORY)
    .map(h => `用户：${String(h.q).slice(0, 500)}\n助手：${String(h.a).slice(0, 1500)}`).join('\n\n');
  return `${RULES}\n\n【使用说明书开始】\n${manual}\n【使用说明书结束】\n\n`
    + (past ? `【之前的问答，仅供理解追问】\n${past}\n\n` : '')
    + `【用户问题】\n${q}\n`;
}

function cleanAnswer(raw) {
  return String(raw || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/扩展初始化中：\S*?\.m?js\s*/g, '').replace(/\r\n/g, '\n').trim().slice(0, MAX_ANSWER);
}

// 子进程环境：不带 Hub 会话变量，免得这个临时进程的 hook 冒充某个 Hub 会话（同 ask-aside、codeagent-serve）。
function childEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_|^CLAUDECODE$|^CLAUDE_CODE_ENTRYPOINT$/i.test(key) || key === 'CODEAGENT3_LAUNCHER_PID') delete out[key];
  }
  return out;
}

function preferredOrder({ preferred = '', env = process.env, edition = 'member' } = {}) {
  const base = edition === 'member' ? ['codeagent', 'claude', 'codex'] : ['claude', 'codex', 'codeagent'];
  const want = [env.AI_HUB_HELP_ASK_ENGINE, preferred].map(v => String(v || '').trim().toLowerCase()).find(v => ENGINES.includes(v));
  return want ? [want, ...base.filter(e => e !== want)] : base;
}

// 参数按 --help 里实际出现的才加（help 为空 = 没探测到，只加必需的 -p / --model）。
const supports = (help, flag) => !!help && help.includes(flag);
// 关不掉工具（--help 没探测到 --tools）就不用这个引擎答：答疑必须只读，宁可换下一家。
const readOnlyCapable = help => supports(help, '--tools');
function codeAgentArgs(model, help) {
  const a = ['-p', '--model', model];
  if (supports(help, '--output-format')) a.push('--output-format', 'json');
  if (supports(help, '--effort')) a.push('--effort', 'low');
  if (supports(help, '--tools')) a.push('--tools', '');
  if (supports(help, '--permission-mode')) a.push('--permission-mode', 'default');
  if (supports(help, '--strict-mcp-config')) a.push('--strict-mcp-config');
  if (supports(help, '--no-session-persistence')) a.push('--no-session-persistence');
  if (supports(help, '--max-turns')) a.push('--max-turns', '1');
  if (supports(help, '--disable-update')) a.push('--disable-update');
  // 工作目录是 Hub 自己建的空文件夹，不用再问「是否信任」（公司 1.2615 不带它会在输出前打两遍安全提示，11-19 实测）。
  if (supports(help, '--skip-safe-check')) a.push('--skip-safe-check');
  return a;
}
function claudeArgs(help, { model = '', settingsFile = '' } = {}) {
  const a = ['-p', '--output-format', 'text'];
  if (supports(help, '--tools')) a.push('--tools', '');
  if (supports(help, '--permission-mode')) a.push('--permission-mode', 'default');
  if (supports(help, '--strict-mcp-config')) a.push('--strict-mcp-config');
  if (supports(help, '--no-session-persistence')) a.push('--no-session-persistence');
  if (supports(help, '--max-turns')) a.push('--max-turns', '1');
  if (settingsFile && supports(help, '--settings')) a.push('--settings', settingsFile);
  if (model && require('../model-id').isSafeModelId(model)) a.push('--model', model);
  return a;
}
function codexArgs(outputFile, mcpNames = []) {
  const a = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only'];
  for (const name of mcpNames) if (/^[A-Za-z0-9_-]+$/.test(name)) a.push('-c', `mcp_servers.${name}.enabled=false`);
  a.push('--output-last-message', outputFile, '-');
  return a;
}

function createHelpAskEngine({ dataDir, edition = 'public', env = process.env, getPreferred = () => '',
  getConfig = () => require('../hub-config').getConfig(),
  findCommand = (cmd, e) => require('../community-setup').findCommand(cmd, e),
  resolveCodeAgent = e => require('../codeagent-config').resolveCodeAgentConfig(e),
  runOnce = require('../company-assistant/ppt-map-model').runOnce,
  replyText = require('../company-assistant/ppt-map-model').replyText,
  codexMcpNames = e => require('../ask-aside-codex').configuredMcpNames([path.join(e.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')]),
  readManual = file => fs.readFileSync(file, 'utf8'), manualPath = () => manualFile(edition),
  now = Date.now, totalMs = TOTAL_MS, idleMs = IDLE_MS } = {}) {
  const cwd = require('../work-file-root').directory('help-workspace', path.join(dataDir, 'help-ask', 'cwd'));
  const helpCache = new Map(); // 引擎 → --help 文本（看支持哪些参数）
  const defaultModel = kind => modelChoice.defaultModel(dataDir, kind, { config: getConfig(), env, resolveCodeAgent });

  function detect() {
    return preferredOrder({ preferred: getPreferred(), env, edition }).map(id => {
      let command = null;
      try { command = findCommand(id, env); } catch { command = null; }
      return { id, label: LABEL[id], available: !!command, command };
    });
  }

  function state() {
    const engines = detect();
    const first = engines.find(e => e.available);
    const file = manualPath();
    const selection = require('../feature-agent-choice').resolve(dataDir, 'help');
    return { selection, engines: engines.map(({ id, label, available }) => ({ id, label, available })), engine: selection.selected?.kind || (first ? first.id : null),
      engineLabel: selection.selected ? LABEL[selection.selected.kind] : first ? first.label : '', manual: !!file, manualPath: file, edition, totalSeconds: Math.round(totalMs / 1000), idleSeconds: Math.round(idleMs / 1000) };
  }

  // 每次子进程的时限 = 剩下的总时间（再多给 2 秒，让总时限的取消先到，统一按「超时」收尾）。
  const left = ctx => Math.max(1000, ctx.deadline - now()) + 2000;
  const stopped = (r, ctx) => r.aborted || ctx.signal.aborted;

  async function helpOf(id, command, launchEnv, ctx) {
    if (helpCache.has(id)) return helpCache.get(id);
    const args = id === 'codex' ? ['exec', '--help'] : ['--help'];
    const r = await runOnce({ command, args, cwd, env: launchEnv, timeoutMs: left(ctx), signal: ctx.signal, onActivity: ctx.onActivity });
    if (stopped(r, ctx)) throw Object.assign(new Error('stopped'), { stopped: true });
    const text = String(r.stdout || '') + String(r.stderr || '');
    if (/-p\b|--print|exec/.test(text)) helpCache.set(id, text);
    return text;
  }

  function failText(label, r) {
    if (r.timedOut) return `${label} 没在时限内答完`;
    const detail = cleanAnswer(r.stderr || r.stdout).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 240);
    return `${label} 没答出来（退出码 ${r.code}）${detail ? '：' + detail : ''}`;
  }

  async function runCodeAgent(found, prompt, ctx) {
    let config = {};
    try { config = resolveCodeAgent(env) || {}; } catch { config = {}; }
    const command = config.command || found;
    const e = childEnv(env);
    try { require('../codeagent-launch-env').applyAccountEnv(e, { configDirEnv: config.configDirEnv, configDir: config.configDir }); } catch { /* 按 CLI 默认账号 */ }
    const help = await helpOf('codeagent', command, e, ctx);
    if (!readOnlyCapable(help)) throw new Error('CodeAgent 没探测到只读参数（--tools），为安全起见这次不用它答');
    const model = defaultModel('codeagent'), args = codeAgentArgs(model, help);
    if (!model) args.splice(args.indexOf('--model'), 2); // 未确定模型时沿用 CLI，不强塞旧候选。
    const r = await runOnce({ command, args, input: prompt, cwd, env: e, timeoutMs: left(ctx), signal: ctx.signal, onActivity: ctx.onActivity });
    if (stopped(r, ctx)) throw Object.assign(new Error('stopped'), { stopped: true });
    let text = '', lastError = '';
    try { text = r.code === 0 ? cleanAnswer(replyText(r.stdout)) : ''; } catch (error) { lastError = error.message; }
    if (text) return { answer: text, model };
    lastError = lastError || failText('CodeAgent', r);
    throw Object.assign(new Error(lastError), { timedOut: !!r.timedOut, model });
  }

  async function runClaude(command, prompt, ctx) {
    const e = childEnv(env);
    // 不读用户自己的 CLAUDE.md（个人编码规矩会把答疑带偏，2026-11-19 实测）；输出风格经 --settings 文件改回默认（经 cmd 传 JSON 会丢引号）。
    e.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    if (!e.CLAUDE_CODE_GIT_BASH_PATH) { try { const bash = require('../git-bash').findGitBash(e); if (bash) e.CLAUDE_CODE_GIT_BASH_PATH = bash; } catch { /* Claude Code 自己回退 */ } }
    const help = await helpOf('claude', command, e, ctx);
    if (!readOnlyCapable(help)) throw new Error('Claude Code 没探测到只读参数（--tools），为安全起见这次不用它答');
    let settingsFile = '';
    try { settingsFile = path.join(dataDir, 'help-ask', 'claude-settings.json'); fs.writeFileSync(settingsFile, JSON.stringify({ outputStyle: 'default' })); } catch { settingsFile = ''; }
    const model = defaultModel('claude') || String(env.AI_HUB_HELP_ASK_CLAUDE_MODEL || '').trim();
    const args = claudeArgs(help, { model, settingsFile });
    const r = await runOnce({ command, args, input: prompt, cwd, env: e, timeoutMs: left(ctx), signal: ctx.signal, onActivity: ctx.onActivity });
    if (stopped(r, ctx)) throw Object.assign(new Error('stopped'), { stopped: true });
    if (r.code === 0 && cleanAnswer(r.stdout)) return { answer: cleanAnswer(r.stdout), model };
    throw Object.assign(new Error(failText('Claude Code', r)), { timedOut: !!r.timedOut, model });
  }

  async function runCodex(command, prompt, ctx) {
    const out = path.join(dataDir, 'help-ask', `codex-last-${process.pid}-${now()}.txt`);
    let names = [];
    try { names = codexMcpNames(env) || []; } catch { names = []; }
    try {
      const model = defaultModel('codex'), args = codexArgs(out, names);
      if (model) args.splice(1, 0, '--model', model);
      const r = await runOnce({ command, args, input: prompt, cwd, env: childEnv(env), timeoutMs: left(ctx), signal: ctx.signal, onActivity: ctx.onActivity });
      if (stopped(r, ctx)) throw Object.assign(new Error('stopped'), { stopped: true });
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch { /* 没写出来 */ }
      if (r.code === 0 && cleanAnswer(text)) return { answer: cleanAnswer(text), model };
      throw Object.assign(new Error(failText('Codex', r)), { timedOut: !!r.timedOut, model });
    } finally { try { fs.unlinkSync(out); } catch { /* 没有 */ } }
  }

  // 返回 { ok, answer, engine, engineLabel, model, ms, tried }；失败时 ok:false，并标 needSetup / timedOut / cancelled。
  async function ask({ question, history = [], signal = null } = {}) {
    const q = String(question || '').trim();
    if (!q) return { ok: false, error: '先写一句想问的问题' };
    const file = manualPath();
    if (!file) return { ok: false, error: '安装包里缺少使用说明书，请升级到最新版本' };
    const engines = detect().filter(e => e.available);
    if (!engines.length) return { ok: false, needSetup: true, error: '这台电脑上还没有可用的 AI 命令行（CodeAgent、Claude Code 或 Codex）' };
    const prompt = buildPrompt({ manual: readManual(file), question: q, history });
    const selection = require('../feature-agent-choice').resolve(dataDir, 'help');
    fs.mkdirSync(cwd, { recursive: true });
    const t0 = now();
    const tried = [];
    let warning = selection.warning || '';
    // 模型权限失败只换一次；再失败直接给界面出口，不叠加默认引擎链而反复请求。
    async function retryModel(failed, error, ctx) {
      tried.push({ engine: failed.kind, model: failed.model, error: String(error.message || error) });
      const next = modelChoice.alternative(dataDir, failed, { env, findCommand, config: getConfig(), resolveCodeAgent });
      if (!next) return { ok: false, error: `${tried.at(-1).error}；未找到其他可用模型，请选模型后重试`, warning, tried, ms: now() - t0 };
      try {
        const answer = await require('../feature-agent-run').run(next, prompt,
          { dataDir, env, signal: ctx.signal, onActivity: ctx.onActivity, runOnce, findCommand, timeoutMs: left(ctx) });
        return { ok: true, answer, engine: next.kind, engineLabel: LABEL[next.kind], model: next.model,
          warning: `已改用 ${next.model}`, tried, ms: now() - t0 };
      } catch (retryError) {
        if (ctx.signal.aborted || retryError.stopped || retryError.aborted || retryError.timedOut) throw retryError;
        tried.push({ engine: next.kind, model: next.model, error: String(retryError.message || retryError) });
        return { ok: false, error: `${tried.at(-1).error}；自动换模型后仍未成功，请重试或选模型`, warning, tried, ms: now() - t0 };
      }
    }
    try {
      return await withDeadline(async ({ signal: requestSignal, onActivity }) => {
        const ctx = { signal: requestSignal, onActivity, deadline: t0 + totalMs };
        if (selection.selected) {
          const selected = selection.selected.model ? selection.selected : { ...selection.selected, model: defaultModel(selection.selected.kind) };
          try {
            const answer = await require('../feature-agent-run').run(selected, prompt,
              { dataDir, env, signal: requestSignal, onActivity, runOnce, findCommand, timeoutMs: left(ctx) });
            return { ok: true, answer, engine: selected.kind, engineLabel: LABEL[selected.kind], model: selected.model, ms: now() - t0, tried };
          } catch (error) {
            if (requestSignal.aborted || error.stopped || error.aborted || error.timedOut) throw error;
            if (modelChoice.modelUnavailable(error)) return await retryModel(selected.model ? selected : { ...selected, model: defaultModel(selected.kind) }, error, ctx);
            warning = `所选 ${LABEL[selected.kind] || selected.kind} 失败，已改用默认`;
            tried.push({ engine: selected.kind, label: LABEL[selected.kind], error: String(error.message || error), selected: true });
          }
        }
        for (const e of engines) {
          if (requestSignal.aborted) break;
          try {
            const r = e.id === 'codeagent' ? await runCodeAgent(e.command, prompt, ctx)
              : e.id === 'claude' ? await runClaude(e.command, prompt, ctx) : await runCodex(e.command, prompt, ctx);
            return { ok: true, answer: r.answer, engine: e.id, engineLabel: e.label, model: r.model, warning, ms: now() - t0, tried };
          } catch (error) {
            if (error && error.stopped) break;
            if (!requestSignal.aborted && !error?.timedOut && modelChoice.modelUnavailable(error)) return await retryModel({ kind: e.id, model: error.model || defaultModel(e.id) }, error, ctx);
            tried.push({ engine: e.id, label: e.label, error: String(error && error.message || error) });
            if (error && error.timedOut) throw error; // 超时不再换下一个引擎
          }
        }
        if (requestSignal.aborted) throw requestSignal.reason;
        return { ok: false, error: tried.map(t => t.error).join('；') || '没有可用的回答', warning, tried, ms: now() - t0 };
      }, { signal, timeoutMs: totalMs, idleMs });
    } catch (error) {
      return { ok: false, timedOut: !!error.timedOut, timeoutKind: error.timeoutKind || '', cancelled: !!signal?.aborted,
        error: error.timedOut ? `这次没答上来：${error.message}` : error.message, warning, tried, ms: now() - t0 };
    }
  }

  return { state, ask, detect, _cwd: cwd };
}

module.exports = { ENGINES, LABEL, RULES, TOTAL_MS, manualFile, buildPrompt, cleanAnswer, childEnv, preferredOrder, readOnlyCapable,
  codeAgentArgs, claudeArgs, codexArgs, createHelpAskEngine };
