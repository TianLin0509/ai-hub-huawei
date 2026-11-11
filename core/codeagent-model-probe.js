'use strict';
// 一键获取某个 CodeAgent 账号能用哪些模型（2026-10-16 用户要求：「我的号只有 GLM，另一个号只有 DeepSeek」要一眼看出来）。
// 做法：在后台悄悄起一个这个账号配置目录下的 CodeAgent，等它出现输入框，打开它自己的 /model 菜单，读出菜单里的模型，
// 按 Esc 关掉菜单；需要更新命令缓存时，在同一个临时 PTY 输入 / 读建议，再清空退出。不发消息、不调模型。
// 菜单的识别沿用 core/codeagent-model-picker.js（公司真机逐行原文写成的规则）。
const fs = require('fs');
const path = require('path');

const MODELS_FILE = 'hub-models.json';
const COMMANDS_ONLY_TIMEOUT_MS = 90000;
const MODEL_PROBE_TIMEOUT_MS = 150000;
const NEEDS_LOGIN = /W3\s*用户名|please\s+(?:run\s+)?\/?login|not\s+(?:logged\s+in|authenticated)|No valid auth token|请先登录|未登录/i;
// 临时探测也会启动完整运行时。只有 PTY 确认退出，才允许下一次探测。
// 超时后仍保留此保护；迟到的 onExit 会自动解除，不靠进程名猜测/结束其他会话。
let activeProbe = null;

function cleanModelId(label) {
  const id = String(label || '').replace(/\s+default\b.*$/i, '').replace(/[✔✓]/g, '').trim();
  return require('./codeagent-models').isSafeModelId(id) ? id : '';
}

function readProbed(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = (Array.isArray(raw.models) ? raw.models : []).map(cleanModelId).filter(Boolean);
    // source：serve = 经 CodeAgent serve 接口读的（core/codeagent-serve.js），menu = 读 /model 屏幕
    // Keep old model values usable while the caller refreshes stale menu evidence.
    return models.length ? { models, defaultModel: cleanModelId(raw.defaultModel), at: raw.at || null, source: raw.source || 'menu', parserVersion: raw.parserVersion } : null;
  } catch { return null; }
}

function writeProbed(file, result) {
  if (!Array.isArray(result.models) || !result.models.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, models: result.models, defaultModel: result.defaultModel || '', at: new Date().toISOString(),
    source: result.source || 'menu', ...((result.source || 'menu') === 'menu' ? { parserVersion: require('./codeagent-models').MODEL_MENU_PARSER_VERSION } : {}) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function modelsFromPicker(picker) {
  const models = [];
  let defaultModel = '';
  for (const row of picker.rows) {
    const id = cleanModelId(row.label);
    if (!id || models.some(m => m.toLowerCase() === id.toLowerCase())) continue;
    models.push(id);
    if (/\bdefault\b/i.test(row.text)) defaultModel = id;
  }
  return { models, defaultModel };
}

// command/configDirEnv 来自 core/codeagent-config.js；cwd 必须是一个下面没有 .cac 凭证的目录（否则会认成别的号）。
async function probeModels({ command, configDirEnv, configDir, cwd, dataDir, env = process.env, ptyModule = null,
  accountKey, cliVersion, versionProbe, commandsOnly = false, probeTrace, forceCommands = false, commandsTimeoutMs = COMMANDS_ONLY_TIMEOUT_MS, modelTimeoutMs = MODEL_PROBE_TIMEOUT_MS,
  readyTimeoutMs = 40000, menuTimeoutMs = 15000, exitTimeoutMs = 5000, cols = 160, rows = 160 } = {}) {
  const trace = probeTrace || require('./codeagent-commands-probe').createCommandTrace(dataDir, { accountKey });
  let commandsAttempted = false, modelResult = null;
  if (!probeTrace && accountKey) { trace('requested', { hasSessionVersion: !!cliVersion }); trace('probe-start'); }
  const unavailable = (reason, result) => {
    commandsAttempted = true;
    if (accountKey) {
      trace('failed', { reason, state: 'failed' });
      require('./codeagent-commands-probe').commandDiagnostic(dataDir, reason, []);
      require('./codeagent-models').appendModelLog(dataDir, { event: 'commands-probe', result: 'failed', reason });
    }
    return accountKey ? { ...result, commandsProbe: { ok: false, reason } } : result;
  };
  if (activeProbe) return unavailable('cleanup-pending', { ok: false, cleanupPending: true, error: '上一次模型探测的临时进程尚未确认退出，暂不启动新探测；退出后可重新获取' });
  const picker = require('./codeagent-model-picker');
  const { createTrustScreen } = require('./claude-trust-dialog');
  const pty = ptyModule || require('node-pty');
  const screen = createTrustScreen({ cols, rows });
  if (!screen) return unavailable('screen-unavailable', { ok: false, error: '终端组件不可用' });
  fs.mkdirSync(cwd, { recursive: true });
  try { require('./claude-project-trust.js').ensureCodeAgentProjectTrusted(cwd, { configDir, stateFileName: '.cac.json' }); } catch { /* 有 --skip-safe-check 兜底 */ }
  const childEnv = { ...env, [configDirEnv]: configDir };
  require('./codeagent-launch-env').applyAccountEnv(childEnv, { configDirEnv, configDir });
  // 不让这个临时进程的 hook 冒充 Hub 会话
  for (const key of Object.keys(childEnv)) if (/^CLAUDE_HUB_(?:SESSION_ID|PORT|TOKEN)$|^CODEAGENT_HUB_/.test(key)) delete childEnv[key];
  if (process.platform === 'win32' && !childEnv.WT_SESSION) childEnv.WT_SESSION = 'ai-hub';
  const head = /^[A-Za-z0-9_.-]+$/.test(command) ? command : `"${path.normalize(String(command).replace(/"/g, ''))}"`;
  let proc;
  // Windows 上 node-pty 收到数组会按 C 运行库规则给引号加反斜杠转义，cmd 不认；整行字符串原样交给它。
  // /s 去掉最外层一对引号，里面的命令照原样执行。
  const line = `/d /s /c "call ${head} --disable-update --skip-safe-check"`;
  try { proc = pty.spawn('cmd.exe', process.platform === 'win32' ? line : ['/d', '/s', '/c', `call ${head} --disable-update --skip-safe-check`], { name: 'xterm-256color', cols, rows, cwd, env: childEnv }); }
  catch (error) { screen.dispose(); return unavailable('spawn-failed', { ok: false, error: `启动 CodeAgent 失败：${error.message}` }); }
  let exited = false;
  const lifecycle = {};
  activeProbe = lifecycle;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  let screenDisposed = false, screenRevision = 0;
  const dataListener = proc.onData(data => { if (!screenDisposed) { screenRevision += 1; screen.write(data); } });
  proc.onExit(() => {
    exited = true;
    if (activeProbe === lifecycle) activeProbe = null;
    resolveExit();
  });
  let timedOut = false, watchdog;
  const cancelled = new Promise((_, reject) => {
    watchdog = setTimeout(() => { timedOut = true; reject(Object.assign(new Error('timeout'), { code: 'probe-timeout' })); }, commandsOnly ? commandsTimeoutMs : modelTimeoutMs);
  });
  const guarded = promise => Promise.race([promise, cancelled]);
  const readLines = options => guarded(screen.lines(options));
  const write = key => { if (timedOut) throw new Error('timeout'); proc.write(key); };
  const sleep = ms => guarded(new Promise(r => setTimeout(r, ms)));
  const waitFor = async (test, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exited) {
      const lines = await readLines();
      const hit = test(lines);
      if (hit) return { hit, lines };
      await sleep(300);
    }
    return { hit: null, lines: await readLines() };
  };
  const readCommands = async readyLines => {
    commandsAttempted = true;
    let result, version = cliVersion;
    try {
      const versions = require('./codeagent-version-probe');
      if (!version) {
        trace('version-start');
        version = versions.parseCodeAgentVersion(readyLines.join('\n')) || await guarded((versionProbe || versions.codeagentVersion)(command));
        if (!version) throw new Error('version-unavailable');
        trace('version-done', { version });
      }
      result = await require('./codeagent-commands-probe').probeCommands({ dataDir, accountKey, version,
        readFrame: async () => {
          const revision = screenRevision, diagnosticLines = await readLines({ trimRight: false });
          return { lines: diagnosticLines.map(line => line.trimEnd()), diagnosticLines, revision };
        },
        write, sleep, now: Date.now, exited: () => exited || timedOut, trace, force: forceCommands, cancelled: () => timedOut });
    } catch {
      if (!version) trace('version-failed', { reason: timedOut ? 'timeout' : 'version-unavailable' });
      result = { ok: false, reason: timedOut ? 'timeout' : 'version-or-probe-unavailable' };
      trace('failed', { reason: result.reason, state: 'failed' });
      require('./codeagent-commands-probe').commandDiagnostic(dataDir, result.reason, []);
    }
    require('./codeagent-models').appendModelLog(dataDir, { event: 'commands-probe', result: result.skipped ? 'skipped' : result.ok ? 'read' : 'failed', reason: result.reason || '' });
    return result;
  };
  try {
    trace('ready-wait', { result: 'waiting' });
    const ready = await waitFor(lines => (NEEDS_LOGIN.test(lines.join('\n')) ? 'login' : picker.promptInputReady(lines) ? 'ready' : null), readyTimeoutMs);
    trace('ready-wait', { result: ready.hit || (exited ? 'exited' : 'timeout') });
    if (ready.hit === 'login') return unavailable('login-required', { ok: false, error: '这个号需要重新登录' });
    if (!ready.hit) return unavailable(exited ? 'process-exited' : 'ready-timeout', { ok: false, error: exited ? 'CodeAgent 启动后退出了' : 'CodeAgent 输入框没有出现（超时）' });
    if (commandsOnly) {
      const commandsProbe = await readCommands(ready.lines);
      return { ok: commandsProbe.ok, commandsProbe, ...(commandsProbe.ok ? {} : { error: commandsProbe.reason }) };
    }
    write('/model');
    await sleep(500);
    write('\r');
    const menu = await waitFor(lines => picker.parsePicker(lines, { allowNoCursor: true }), menuTimeoutMs);
    let result;
    if (!menu.hit) {
      require('./codeagent-models').appendModelLog(dataDir, { event: 'menu-cache-skipped', reason: 'unrecognized-menu' });
      result = { ok: false, error: '没有读到完整模型菜单，已保留上次清单' };
    }
    // 同一屏上的用量表顺手解析（只读屏，core/codeagent-usage-menu.js），调用方按这个号记快照
    let usage = null;
    let parsed = menu.hit, menuLines = menu.lines;
    try {
      if (!menu.hit) throw new Error('menu-unavailable');
      const menuUsage = require('./codeagent-usage-menu');
      const read = await guarded(menuUsage.readUsageMenu(picker.modelMenuLines(menu.lines), { readLines: async () => picker.modelMenuLines(await readLines()),
        timeoutMs: menuUsage.PROBE_USAGE_WAIT_MS, dataDir, source: 'probe' }));
      usage = read.usage;
      menuLines = read.lines;
      parsed = picker.parsePicker(read.lines, { allowNoCursor: true }) || parsed;
    } catch { usage = null; }
    if (timedOut) throw new Error('timeout');
    if (parsed) {
      const collected = await guarded(picker.collectModelMenu({ lines: menuLines, readLines, write, revision: () => screenRevision, pause: sleep, now: Date.now }));
      require('./codeagent-models').appendModelLog(dataDir, { event: 'menu-scroll', ok: collected.ok, steps: collected.steps,
        reason: collected.reason, atNumber: collected.atNumber });
      result = collected.ok && collected.models.length ? { ...collected, usage: { ...usage, ...collected.usage, credit: collected.usage?.credit || usage?.credit || null, models: collected.usage?.models || usage?.models || [] } }
        : { ok: false, error: `模型菜单未完整读取：${collected.reason || '没有读到有效模型，可稍后刷新重试'}`, ...(usage ? { usage } : {}) };
    }
    if (!result.ok && !accountKey) return result;
    modelResult = result;
    const closed = await guarded(picker.closeModelMenu({ readLines, write, pause: sleep, now: Date.now }));
    if (!closed.ok) return { ...result, commandsProbe: { ok: false, reason: closed.reason } };
    if (accountKey) result.commandsProbe = await readCommands(ready.lines);
    if (timedOut) throw new Error('timeout');
    return result;
  } catch (error) {
    if (!timedOut) { trace('failed', { reason: 'probe-error', state: 'failed' }); throw error; }
    trace('ready-wait', { result: 'timeout' });
    return unavailable('timeout', commandsAttempted && modelResult ? modelResult
      : { ok: false, error: commandsOnly ? '命令列表读取超时' : '模型探测超时' });
  } finally {
    clearTimeout(watchdog);
    if (accountKey && !commandsAttempted) {
      require('./codeagent-commands-probe').commandDiagnostic(dataDir, 'probe-not-ready', []);
      require('./codeagent-models').appendModelLog(dataDir, { event: 'commands-probe', result: 'failed', reason: 'probe-not-ready' });
    }
    let killFailed = false;
    try { if (!exited) proc.kill(); } catch { killFailed = true; }
    let timer;
    if (!exited) {
      await Promise.race([exitPromise, new Promise(resolve => {
        timer = setTimeout(resolve, Math.max(1, Number(exitTimeoutMs) || 5000));
      })]);
    }
    clearTimeout(timer);
    screenDisposed = true;
    if (dataListener && typeof dataListener.dispose === 'function') dataListener.dispose();
    screen.dispose();
    if (!exited) return { ok: false, cleanupPending: true,
      error: killFailed ? '模型探测结束，但结束临时进程失败；尚未确认退出，已暂停后续探测'
        : '模型探测结束，但临时进程退出超时；已暂停后续探测，退出后可重新获取' };
  }
}

module.exports = { NEEDS_LOGIN, MODELS_FILE, COMMANDS_ONLY_TIMEOUT_MS, MODEL_PROBE_TIMEOUT_MS, probeModels, readProbed, writeProbed, modelsFromPicker, cleanModelId };
