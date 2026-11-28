'use strict';
// Hermes Agent（NousResearch 的开源 Agent 框架，Python，PyPI 包 hermes-agent）接入 Hub（2026-11-28）。
//
// 运行方式：Hermes 官方的 ACP 服务（python -m acp_adapter），由 Hub 的 ACP 卡片会话驱动（core/acp-session.js）。
// 不走终端界面：Hermes 的终端界面在 Windows 上没有可供 Hub 观察的接口，ACP 是它官方给编辑器用的接入方式，
// 有新建、恢复（session/load）、分支、权限确认，回复和工具调用都按协议回报。
// 启动经 core/hermes-acp-launch.py：修 Windows 上子进程继承通信管道导致终端工具卡死的问题（见该文件说明）。
//
// 模型线路和 opencode / pi 同一套（core/opencode-cli-profile.js availableRoutes，开箱即用：先用 Hub 已有的钥匙）。
// 每个 Hub 会话一个 HERMES_HOME（Hub 数据目录下），启动时写好这次线路的 config.yaml，钥匙只放环境变量，config.yaml 里写 ${变量名}（Hermes 读配置时展开），不落盘；
// 恢复时用同一个目录，Hermes 自己的会话库 state.db 就在里面。没有 Hub 线路时不设 HERMES_HOME，用用户自己的 Hermes 配置。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const HERMES_PACKAGE = 'hermes-agent';
const HERMES_VERSION = '0.19.0';   // 组件包里装的版本（2026-11-28 本机 ACP 实测）
const HERMES_PYTHON = '3.12';      // 组件包自带的 Python（python-build-standalone）
const HERMES_INSTALL_HINT = '请在启动中心点「一键安装 Hermes」（从公司内源下载，装进 Hub 自己的目录，自带 Python）；已用官方脚本装过 Hermes 的会自动识别';
const ROUTE_LABELS = { company: '公司模型', own: '自有接口', deepseek: 'DeepSeek API', tokenplan: 'Token Plan', native: 'Hermes 自己的配置' };
// 钥匙变量名用 AUXILIARY_…_API_KEY 形式：Hermes 认它为内部密钥，主进程读配置能展开，但终端快照和它起的一切子进程都会剥掉（审查 P1-4）。
const KEY_ENV = 'AUXILIARY_AI_HUB_HERMES_API_KEY';
// Hub 权限档 → Hermes ACP 的会话模式（default 每次问、accept_edits 自动改文件、dont_ask 都不问）。
const SESSION_MODES = { bypassPermissions: 'dont_ask', acceptEdits: 'accept_edits', default: 'default' };

const envGet = (env, name) => { const k = Object.keys(env || {}).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
// 独立 Python 的库在同级 Lib/site-packages，虚拟环境的 python 在 Scripts 下、库在上一级；装了 ACP 扩展才有 acp_adapter。
const hasAcp = python => [path.dirname(python), path.dirname(path.dirname(python))].some(root => fs.existsSync(path.join(root, 'Lib', 'site-packages', 'acp_adapter')));

// 找 Hermes 的 Python：显式指定（AI_HUB_HERMES_PYTHON）→ 官方安装脚本装的（%LOCALAPPDATA%\hermes\hermes-agent 的虚拟环境）→ Hub 一键安装的那份。
// 只读文件、不起进程。
function resolveHermesRuntime(env = process.env) {
  const explicit = envGet(env, 'AI_HUB_HERMES_PYTHON').trim();
  if (explicit) return isFile(explicit) && hasAcp(explicit) ? { python: explicit, source: 'user', version: '' } : null;
  const local = envGet(env, 'LOCALAPPDATA') || path.join(envGet(env, 'USERPROFILE') || os.homedir(), 'AppData', 'Local');
  for (const venv of ['venv', '.venv']) {
    const python = path.join(local, 'hermes', 'hermes-agent', venv, 'Scripts', 'python.exe');
    if (isFile(python) && hasAcp(python)) return { python, source: 'user', version: '' };
  }
  try {
    const m = require('./cli-tools/registry').managed('hermes', env);
    if (m?.bin) return { python: m.bin, version: m.version || '', source: 'hub', dir: m.dir };
  } catch (_) {}
  return null;
}

function diagnoseHermes(env = process.env) {
  const runtime = resolveHermesRuntime(env);
  if (!runtime) return { state: 'none', message: '没有找到 Hermes。' + HERMES_INSTALL_HINT };
  return { state: 'ready', version: runtime.version || '', python: runtime.python, source: runtime.source };
}

// Hermes 的终端工具在 Windows 上要 Git Bash：和 Claude Code 用同一个定位（用户指定 → 本机已装 → Hub 装的 Git 组件）。
function gitBashFor(env) {
  try { return require('./git-bash').findGitBash(env) || ''; } catch (_) { return ''; }
}

// ---------- 模型线路 ----------
// 直接复用 opencode 的线路清单（公司模型 / 自有接口 / DeepSeek / Token Plan，地址、钥匙、模型表一样），模型编号也同一写法：线路名/模型。
function availableRoutes(config = {}, env = process.env, { dataDir, sessionId } = {}) {
  return require('./opencode-cli-profile').availableRoutes(config, env, { dataDir, sessionId: sessionId || 'hermes-catalog' });
}
const routeLabel = route => route.gateway ? 'API 网关' : ROUTE_LABELS[route.id] || route.id;
const splitModel = value => require('./opencode-cli-profile').splitModel(value);
function hermesModelOptions(config = {}, env = process.env, extra = {}) {
  const options = [];
  for (const route of availableRoutes(config, env, extra)) {
    for (const id of route.models) options.push({ id: `${route.provider}/${id}`, label: `${id} · ${routeLabel(route)}`, source: 'hermes-' + route.id });
  }
  if (!options.length) options.push({ id: '', label: 'Hermes 自己的默认模型（hermes model 里配置）', source: 'hermes-native' });
  return options;
}
function defaultHermesModel(config = {}, env = process.env, extra = {}) {
  const route = availableRoutes(config, env, extra)[0];
  return route ? `${route.provider}/${route.defaultModel}` : '';
}
// 存的模型属于 Hub 线路、但这条线路这次不可用：说清缺什么，不悄悄换线路（和 opencode 同一口径）。
function savedRouteProblem(model, routes) {
  const problem = require('./opencode-cli-profile').savedRouteProblem(model, routes);
  return problem && { ...problem, message: problem.message.replace('opencode 会话', 'Hermes 会话') };
}

// Hub 会话 → 它自己的 HERMES_HOME（会话 id 取哈希，不拼进路径）。
function sessionHome(dataDir, id) {
  return path.join(dataDir || require('./data-dir').getHubDataDir(), 'hermes', 'sessions', createHash('sha256').update(String(id)).digest('hex').slice(0, 24), 'home');
}

// config.yaml：JSON 也是合法的 YAML，直接写 JSON，免得自己拼 YAML 转义。
// 钥匙写成 ${变量名}：hermes-agent 0.19 的 model 段不认 key_env（只认 api_key，没填就发 no-key-required），
// 但配置值支持 ${VAR} 展开（2026-11-28 黄区实测公司反代回 401 查出）。
function hermesConfig(route, model) {
  return {
    model: { default: model, provider: 'custom', base_url: route.baseURL, api_key: '${' + KEY_ENV + '}', context_length: route.contextOf(model) },
  };
}

// 权限档：完全放开 = 会话模式 dont_ask + Hub 自动批准 Hermes 的逐次确认（危险命令同样直接执行）；其余档由用户在卡片里点允许。
// 没传或不认的档按主进程缺省「完全放开」（core/permission-modes.js DEFAULT_MODE：组队、群聊等后台会话不经启动中心）。
function permissionFor(mode) {
  const normalized = require('./permission-modes').normalize('hermes', mode) || 'bypassPermissions';
  return { mode: normalized, sessionModeId: SESSION_MODES[normalized] || 'default', policy: normalized === 'bypassPermissions' ? 'bypass' : 'ask' };
}

// ---------- 启动参数（交给 AcpSession） ----------
// opts：id、cwd、model（线路名/模型）、acpSid（Hermes 会话 id，恢复用）、permissionMode、autonomous、nativeRuntime。
function buildHermesOptions(kind, opts, config = {}, dataDir, baseEnv = process.env) {
  const runtime = resolveHermesRuntime(baseEnv);
  if (!runtime) throw new Error('没有找到 Hermes。' + HERMES_INSTALL_HINT);
  dataDir = dataDir || require('./data-dir').getHubDataDir();
  const routes = availableRoutes(config, baseEnv, { dataDir, sessionId: opts.id });
  let model = String(opts.model || '').trim();
  const problem = model ? savedRouteProblem(model, routes) : null;
  if (problem) throw Object.assign(new Error(problem.message), { code: 'HERMES_ROUTE_MISSING', route: problem });
  if (!model && routes[0]) model = `${routes[0].provider}/${routes[0].defaultModel}`;
  let { provider, id } = splitModel(model);
  const route = routes.find(r => r.provider === provider);
  // 公司线路换了上游（CodeAgent ↔ API 网关）后存的模型不在表里：改用这条线路的默认模型（和 opencode 一致）。
  if (route && id && !route.models.includes(id)) { id = route.defaultModel; model = `${provider}/${id}`; }
  // 自有接口的 Key 解不开（换了电脑或系统账号）：就地说清，不拿空 Key 去请求。
  if (route?.own && config.dshApiKeyNeedsInput) throw new Error(require('./own-api-secrets').KEY_NEEDED);
  if (!route) model = '';
  // 环境变量：Hub 令牌、别家工具的会话变量都不带给 Hermes（它跑的命令会继承整份环境）。
  // 走 Hub 线路时去掉所有模型钥匙变量：Hermes 会按环境里的钥匙自动认 provider，留着就可能悄悄改用别家（2026-11-28 本机实测恢复会话时改走了 DeepSeek）。
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    const low = name.toLowerCase();
    if (/^(claude_hub_|claude_env_file|claude_securestorage|hub_bridge_|hub_feishu_|mobile_|ai_team_hub_callback|codex_thread|codex_session|hermes_(?!git_bash_path$)|ai_hub_hermes_|auxiliary_ai_hub_hermes_|python(path|home|startup|userbase))/.test(low)
      || ['electron_run_as_node', 'node_options', 'claudecode', 'claude_config_dir', 'ai_hub_token_plan_key', 'virtual_env', 'conda_prefix'].includes(low)
      || (route && (/(_api_key|_token|_base_url|_secret|_password|_pass|_key)$/.test(low) || ['google_application_credentials', 'vertex_credentials_path'].includes(low)) && !/^(github|gh|git)_/.test(low))) delete env[name];
  }
  require('./company-model-proxy').applyNoProxy(env);
  // 启动用 -I（不读 PYTHON* 变量、不加用户目录）+ -X utf8；下面两个给 Hermes 再起的 Python 子进程用。
  Object.assign(env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HERMES_REDACT_SECRETS: '1' });
  const bash = envGet(env, 'HERMES_GIT_BASH_PATH') ? '' : gitBashFor(baseEnv);
  if (bash) env.HERMES_GIT_BASH_PATH = bash;
  const perm = permissionFor(opts.autonomous === true ? null : opts.permissionMode);
  if (perm.policy === 'bypass') env.HERMES_YOLO_MODE = '1';
  let home = null;
  if (route) {
    home = sessionHome(dataDir, opts.id);
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'config.yaml');
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(hermesConfig(route, id), null, 2), 'utf8');
    fs.renameSync(temp, file);
    env.HERMES_HOME = home;
    env[KEY_ENV] = route.key;
    // 公司反代在本机，绕开代理；自有接口沿用系统代理设置（和 opencode 一致）。
    if (route.id === 'company') { try { require('./company-model-proxy').applyEndpointNoProxy(env, { origin: route.baseURL }); } catch (_) {} }
  }
  const rawSid = String(opts.acpSid || '').trim();
  if (rawSid && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(rawSid)) throw new Error('这个 Hermes 会话的记录编号已损坏，没法接着聊；请新建一个 Hermes 会话');
  return { id: opts.id, kind: 'hermes', cwd: opts.cwd, home,
    // Hermes 报给 ACP 的当前模型编号是 custom:<模型>；Hub 显示用「线路名/模型」。
    model: route ? `custom:${id}` : undefined, hubModel: model,
    profileId: 'hermes:' + (route ? route.id : 'native'), route: route ? route.id : 'native',
    permissionPolicy: perm.policy, sessionModeId: perm.sessionModeId,
    resumeId: rawSid || undefined, restoredRuntime: opts.nativeRuntime,
    storeDir: path.join(dataDir, 'acp-history'),
    runtime: { version: runtime.version, source: runtime.source, python: runtime.python },
    launch: { command: runtime.python, args: ['-I', '-X', 'utf8', require('./acp-profiles').dshRuntimeFile('hermes-acp-launch.py')], cwd: opts.cwd, env, secrets: route ? [route.key] : [] } };
}

module.exports = { HERMES_PACKAGE, HERMES_VERSION, HERMES_PYTHON, HERMES_INSTALL_HINT, ROUTE_LABELS, KEY_ENV, SESSION_MODES, routeLabel,
  resolveHermesRuntime, diagnoseHermes, availableRoutes, hermesModelOptions, defaultHermesModel, savedRouteProblem,
  sessionHome, hermesConfig, permissionFor, buildHermesOptions };
