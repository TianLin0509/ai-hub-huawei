'use strict';
// opencode（开源终端编码 Agent，npm 包 opencode-ai，单个原生程序 opencode.exe）接入 Hub（2026-11-26）。
//
// 运行方式：真实的 opencode 终端界面跑在 PTY 里；启动时用 --port 让它在本机 127.0.0.1 开自带的服务（随机端口 + 随机密码），
// Hub 经这个服务发消息（prompt_async）、订阅事件（/event）拿状态与回复、用 /tui/select-session 让终端显示同一个会话
// （core/opencode-cli-session.js）。不靠往终端里粘贴，消息送没送到以 opencode 自己记下的 user 消息为准。
// 会话记录在 opencode 自己的数据目录（~/.local/share/opencode），用户在自己终端里 opencode -s <id> 也能接着聊。
//
// 模型线路和 pi 同一套（core/pi-cli-profile.js availableRoutes，开箱即用：先用 Hub 已有的钥匙）：
//   company   公司版：本机公司模型反代（CodeAgent 账号或 API 网关），和 DSH / pi 同一条
//   own       公司版 DSH 选了「自有接口」：用户自己的 OpenAI 兼容地址
//   deepseek  DeepSeek 官方 API：Hub 设置里的 DeepSeek Key
//   tokenplan 阿里云 Token Plan 套餐 Key
//   native    以上都没有：不替 opencode 选模型，用它自己的配置或 /connect 登录
// Hub 线路写成一份临时配置（OPENCODE_CONFIG，叠加在用户自己的配置之上），钥匙写成 {env:变量名}，不落盘。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const OPENCODE_PACKAGE = 'opencode-ai';
const OPENCODE_VERSION = '1.19.6';   // 一键安装装的版本（2026-11-26 本机实测：PTY 终端 + 本机服务 + 断外网可用）
const BIN_PACKAGES = ['opencode-windows-x64-baseline', 'opencode-windows-x64'];   // baseline 优先：不要求 AVX2，老 CPU 也能跑（Hub 组件也用它）
// 一键安装走 Hub 的 CLI 组件（core/cli-tools，只从公司内源下载并核对签名、大小和 sha256），不改走 npm（AI HUB-H 铁律：组件只走内源）。
const OPENCODE_INSTALL_HINT = '请在启动中心点「一键安装 opencode」（从公司内源下载，装进 Hub 自己的目录）；已自己装过 opencode 的会自动识别';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const ROUTE_LABELS = { company: '公司模型', own: '自有接口', deepseek: 'DeepSeek API', tokenplan: 'Token Plan', native: 'opencode 自己的配置' };
const ROUTE_PROVIDERS = { company: 'hub-company', own: 'hub-own', deepseek: 'hub-deepseek', tokenplan: 'hub-tokenplan' };

const envGet = (env, name) => { const k = Object.keys(env || {}).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const exeName = (platform = process.platform) => platform === 'win32' ? 'opencode.exe' : 'opencode';

// node_modules 下 opencode-ai 自带的平台程序（npm 装法）：先认 baseline 版（不要求 AVX2），再认普通版。
function binUnder(modules) {
  for (const name of BIN_PACKAGES) {
    const bin = path.join(modules, name, 'bin', exeName());
    if (isFile(bin)) return { bin, version: readJson(path.join(modules, name, 'package.json'))?.version || readJson(path.join(modules, OPENCODE_PACKAGE, 'package.json'))?.version || '' };
  }
  const own = path.join(modules, OPENCODE_PACKAGE, 'bin', exeName());
  if (isFile(own)) return { bin: own, version: readJson(path.join(modules, OPENCODE_PACKAGE, 'package.json'))?.version || '' };
  return null;
}

// 找 opencode：显式指定（AI_HUB_OPENCODE_PATH）→ 用户自己装的（PATH 上的 opencode.exe、npm 全局、官方安装脚本目录）→ Hub 一键安装的那份。
// 只读文件、不起进程，体检和新建会话随时可以调。
function resolveOpencodeRuntime(env = process.env) {
  const explicit = envGet(env, 'AI_HUB_OPENCODE_PATH').trim();
  if (explicit) return isFile(explicit) ? { bin: explicit, source: 'user', version: '' } : null;
  const roots = [];
  for (const dir of envGet(env, 'PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const direct = path.join(dir, exeName());
    if (isFile(direct)) return { bin: direct, source: 'user', version: '' };
    if (fs.existsSync(path.join(dir, 'opencode.cmd'))) roots.push(path.join(dir, 'node_modules'));
  }
  const appdata = envGet(env, 'APPDATA');
  if (appdata) roots.push(path.join(appdata, 'npm', 'node_modules'));
  const prefix = envGet(env, 'NPM_CONFIG_PREFIX');
  if (prefix) roots.push(path.join(prefix, 'node_modules'));
  for (const modules of roots) {
    const hit = binUnder(path.join(modules, OPENCODE_PACKAGE, 'node_modules')) || binUnder(modules);
    if (hit) return { ...hit, source: 'user' };
  }
  const home = envGet(env, 'USERPROFILE') || envGet(env, 'HOME') || os.homedir();
  const official = path.join(home, '.opencode', 'bin', exeName());
  if (isFile(official)) return { bin: official, source: 'user', version: '' };
  try {
    const m = require('./cli-tools/registry').managed('opencode', env);
    if (m?.bin) return { bin: m.bin, version: m.version || '', source: 'hub' };
  } catch (_) {}
  return null;
}

function diagnoseOpencode(env = process.env) {
  const runtime = resolveOpencodeRuntime(env);
  if (!runtime) return { state: 'none', message: '没有找到 opencode。' + OPENCODE_INSTALL_HINT };
  return { state: 'ready', version: runtime.version || '', bin: runtime.bin, source: runtime.source };
}

// ---------- 模型线路 ----------
// 复用 pi 的线路清单（同一套钥匙、同一个公司反代），换成 opencode 的 provider 写法（内置的 @ai-sdk/openai-compatible，不用联网下载）。
function availableRoutes(config = {}, env = process.env, { dataDir, sessionId } = {}) {
  const routes = [];
  let piRoutes = [];
  try { piRoutes = require('./pi-cli-profile').availableRoutes(config, env, { dataDir, sessionId: sessionId || 'opencode-catalog' }); } catch (_) {}
  for (const r of piRoutes) {
    const provider = ROUTE_PROVIDERS[r.id];
    if (!provider) continue;
    const baseURL = r.id === 'deepseek' ? DEEPSEEK_BASE : String(r.providerConfig?.baseUrl || '').replace(/\/+$/, '');
    if (!baseURL) continue;
    const contextOf = id => r.providerConfig?.models?.find(m => m.id === id)?.contextWindow || 128000;
    routes.push({ id: r.id, provider, keyEnv: r.id === 'company' ? r.keyEnv : 'AI_HUB_OPENCODE_' + r.id.toUpperCase() + '_KEY', key: r.key,
      gateway: !!r.gateway, baseURL, models: r.models.slice(), defaultModel: r.defaultModel, contextOf, thinking: r.id === 'company' });
  }
  // 公司版 DSH 选了「自有接口」：同一组地址、Key、模型也给 opencode 用（反代不在时它也能用）。
  if (config.companyCli && config.dshBackend === 'api') {
    try {
      const own = require('./company-model-proxy').dshOwnRoute({ baseURL: config.dshApiBaseUrl, apiKey: config.dshApiKey, model: config.dshApiModel });
      routes.unshift({ id: 'own', provider: ROUTE_PROVIDERS.own, keyEnv: 'AI_HUB_OPENCODE_OWN_KEY', key: own.key, baseURL: own.baseURL,
        models: [own.model], defaultModel: own.model, contextOf: () => 128000, own: true, thinking: true });
    } catch (_) { /* 自有接口没填全：这条线不可用 */ }
  }
  return routes;
}
const routeLabel = route => route.gateway ? 'API 网关' : ROUTE_LABELS[route.id] || route.id;
function splitModel(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('/');
  return at > 0 ? { provider: text.slice(0, at), id: text.slice(at + 1) } : { provider: '', id: text };
}
function opencodeModelOptions(config = {}, env = process.env, extra = {}) {
  const options = [];
  for (const route of availableRoutes(config, env, extra)) {
    for (const id of route.models) options.push({ id: `${route.provider}/${id}`, label: `${id} · ${routeLabel(route)}`, source: 'opencode-' + route.id });
  }
  if (!options.length) options.push({ id: '', label: 'opencode 自己的默认模型（在 opencode 里 /connect 或 /models）', source: 'opencode-native' });
  return options;
}
function defaultOpencodeModel(config = {}, env = process.env, extra = {}) {
  const route = availableRoutes(config, env, extra)[0];
  return route ? `${route.provider}/${route.defaultModel}` : '';
}

// 存的模型属于 Hub 线路、但这条线路这次不可用：说清缺什么，不悄悄换线路（和 pi 同一口径）。
function savedRouteProblem(model, routes) {
  const { provider, id } = splitModel(model);
  const routeId = Object.keys(ROUTE_PROVIDERS).find(k => ROUTE_PROVIDERS[k] === provider);
  if (!routeId || routes.some(r => r.provider === provider)) return null;
  const need = { company: '公司模型接入（设置 → 公司模型）', own: 'DSH 自有接口（设置 → 自有 API → DSH）', deepseek: 'DeepSeek API Key', tokenplan: '阿里云 Token Plan 套餐 Key' }[routeId];
  return { route: routeId, model: String(model), message: `这个 opencode 会话用的是「${ROUTE_LABELS[routeId]}」线路的 ${id}，但 Hub 里没有${need}。补上后再打开这个会话即可；Hub 没有改用别的线路或模型。` };
}

// 思考开关（2026-11-28 用户反馈「opencode 好像不支持 DeepSeek，GLM 可以」）：opencode 对自定义模型默认什么思考参数都不发，
// 反代转公司上游时按「请求带了思考开关才开思考」处理（DSH / pi / Claude Code / Codex 都带），于是 opencode 经公司上游一直在不思考档跑，
// DeepSeek 掉得最明显（黄区测评同题 11 题：opencode 配 DeepSeek 过 7、配 GLM 过 10）。公司线路和自有接口与 DSH 一样默认开到 high：
// reasoning_effort 由 opencode 内置的 openai-compatible 发出，反代据此给上游开思考；走 API 网关时反代会去掉它，网关的推理模型本来就想。
const thinkingFields = route => (route.thinking ? { reasoning: true, options: { reasoningEffort: 'high' } } : {});

// 权限模式 → opencode 的 permission 配置（启动中心选的档）。plan 用 opencode 自带的 plan 智能体（只读、出方案）。
function permissionConfig(mode) {
  if (mode === 'acceptEdits') return { permission: { edit: 'allow', bash: 'ask', external_directory: 'ask', webfetch: 'ask' } };
  if (mode === 'default') return { permission: { edit: 'ask', bash: 'ask', external_directory: 'ask', webfetch: 'ask' } };
  if (mode === 'plan') return { default_agent: 'plan', permission: { edit: 'deny', bash: 'ask', external_directory: 'ask', webfetch: 'ask' } };
  return { permission: 'allow' };
}

// ---------- 启动参数 ----------
// opts：id、cwd、model（provider/model）、acpSid（opencode 会话 id，恢复用）、permissionMode。
function buildOpencodeCliOptions(kind, opts, config = {}, dataDir, baseEnv = process.env) {
  const runtime = resolveOpencodeRuntime(baseEnv);
  if (!runtime) throw new Error('没有找到 opencode。' + OPENCODE_INSTALL_HINT);
  const routes = availableRoutes(config, baseEnv, { dataDir, sessionId: opts.id });
  let model = String(opts.model || '').trim();
  const problem = model ? savedRouteProblem(model, routes) : null;
  if (problem) throw Object.assign(new Error(problem.message), { code: 'OPENCODE_ROUTE_MISSING', route: problem });
  if (!model && routes[0]) model = `${routes[0].provider}/${routes[0].defaultModel}`;
  let { provider, id } = splitModel(model);
  const route = routes.find(r => r.provider === provider);
  // 公司线路换了上游（CodeAgent ↔ API 网关）后存的模型不在表里：改用这条线路的默认模型（和 pi / DSH 一致）。
  if (route && id && !route.models.includes(id)) { id = route.defaultModel; model = `${provider}/${id}`; }
  // 环境变量清理：Windows 变量名不分大小写，按小写比对（复审 P2-1）。Hub 的令牌、别的工具的会话变量、各家 API Key 都不带给 opencode：
  // 它跑的命令和脚本会继承整份环境。只放这次选中线路的那一把钥匙。
  const env = { ...baseEnv };
  // 用户自己的模型 Key（ANTHROPIC_API_KEY 等）只在走 Hub 线路时才去掉；用 opencode 自己的配置时它可能就靠这些变量（复审二 P2-2）。
  const dropExact = new Set(['electron_run_as_node', 'node_options', 'claudecode', 'claude_config_dir', 'ai_hub_token_plan_key', 'node_use_env_proxy',
    ...(route ? ['deepseek_api_key', 'anthropic_api_key', 'openai_api_key', 'dashscope_api_key'] : [])]);
  for (const name of Object.keys(env)) {
    const low = name.toLowerCase();
    if (/^(claude_hub_(token|port|session)|ai_team_hub_callback|codex_thread|codex_session|opencode_|ai_hub_opencode_)/.test(low) || dropExact.has(low)) delete env[name];
  }
  require('./company-model-proxy').applyNoProxy(env);   // 本机服务 127.0.0.1 永远不走代理（复审 P1-7）
  const providers = {};
  if (route) {
    env[route.keyEnv] = route.key;
    // 单步输出上限：公司线路（公司上游 / API 网关）放到 32768，和 DSH、pi 一致（11-28 黄区实测 16384 会截断长输出；opencode 自己再按 32000 封顶）；
    // 其他线路（自有接口、DeepSeek 官方、Token Plan）的上限各家不同，保持 16384。
    providers[route.provider] = { npm: '@ai-sdk/openai-compatible', name: routeLabel(route), options: { baseURL: route.baseURL, apiKey: `{env:${route.keyEnv}}` },
      models: Object.fromEntries(route.models.map(m => [m, { name: m, limit: { context: route.contextOf(m), output: route.id === 'company' ? 32768 : 16384 }, ...thinkingFields(route) }])) };
    // 公司反代在本机，绕开代理；自有接口沿用系统代理设置（和 DSH 自有接口一致）。
    if (route.id === 'company') { try { require('./company-model-proxy').applyEndpointNoProxy(env, { origin: route.baseURL }); } catch (_) {} }
  }
  const hubConfig = { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled',
    ...(Object.keys(providers).length ? { provider: providers } : {}), ...permissionConfig(opts.autonomous === true ? null : require('./permission-modes').normalize('opencode', opts.permissionMode)) };
  const sessionRoot = path.join(dataDir || require('./data-dir').getHubDataDir(), 'opencode', 'sessions', createHash('sha256').update(String(opts.id)).digest('hex').slice(0, 24));
  fs.mkdirSync(sessionRoot, { recursive: true });
  const configFile = path.join(sessionRoot, 'hub-opencode.json');
  fs.writeFileSync(configFile, JSON.stringify(hubConfig, null, 2));
  const password = require('node:crypto').randomBytes(18).toString('hex');
  Object.assign(env, { OPENCODE_CONFIG: configFile, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: '1' });
  // 公司版：内网拿不到 models.dev、LSP 与默认插件的下载，提前关掉，免得启动时卡在联网上（本机断外网实测这样能正常用）。
  if (config.companyCli || require('./distribution').target === 'company') {
    Object.assign(env, { OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' });
  }
  const args = ['--hostname', '127.0.0.1'];   // --port 由会话启动时挑空闲端口补上
  if (model) args.push('--model', model);
  // 恢复不用 --session：会话在 opencode 里被删了时它会直接退出、只留一句英文。改由 Hub 启动后经本机服务核对会话还在，
  // 再让终端切过去（core/opencode-cli-session.js），找不到时给人话提示。
  // 记录里的会话编号格式不对：直接报错，不悄悄开一个新会话冒充恢复（复审 P2-2）。
  const rawSid = String(opts.acpSid || '').trim();
  if (rawSid && !/^ses_[A-Za-z0-9]+$/.test(rawSid)) throw new Error('这个 opencode 会话的记录编号已损坏，没法接着聊；请新建一个 opencode 会话');
  const resume = rawSid || null;
  return { id: opts.id, kind: 'opencode', cwd: opts.cwd, model, resumeId: resume, password, sessionRoot,
    modelOptions: route ? route.models.map(m => ({ id: `${route.provider}/${m}`, label: `${m} · ${routeLabel(route)}`, source: 'opencode-' + route.id })) : [],
    route: route ? route.id : 'native', runtime: { version: runtime.version, source: runtime.source, bin: runtime.bin },
    profileId: 'opencode:' + (route ? route.id : 'native'), launch: { command: runtime.bin, args, env } };
}

module.exports = { OPENCODE_PACKAGE, OPENCODE_VERSION, OPENCODE_INSTALL_HINT, ROUTE_LABELS, ROUTE_PROVIDERS, routeLabel,
  resolveOpencodeRuntime, diagnoseOpencode, availableRoutes, opencodeModelOptions, defaultOpencodeModel, savedRouteProblem,
  permissionConfig, splitModel, buildOpencodeCliOptions };
