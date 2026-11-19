'use strict';
// pi（开源终端编码 Agent，npm 包 @earendil-works/pi-coding-agent，前身 @mariozechner/pi-coding-agent）接入 Hub（r39，2026-11-18）。
//
// 运行方式和 DSH 一样：真实的 pi 终端界面跑在 PTY 里，Hub 用 -e 加载自己的观察扩展（core/pi-cli-observer.mjs），
// 由它把会话身份、轮次和消息写进事件日志，Hub 据此出卡片、状态和发送回执（core/pi-cli-session.js）。
// 会话记录就是 pi 自己的会话文件（~/.pi/agent/sessions/…jsonl），恢复用 --session <文件>，用户在自己终端里 pi -r 也能看到。
//
// 模型线路（开箱即用：先用 Hub 已有的钥匙，找不到才让 pi 用它自己的登录）：
//   company   公司版：本机公司模型反代（core/company-model-proxy.js），和 DSH 同一条
//   deepseek  DeepSeek 官方 API：Hub 设置里的 DeepSeek Key，没有就用本机环境变量 DEEPSEEK_API_KEY
//   tokenplan 阿里云 Token Plan 套餐：Hub 设置里的套餐 Key（和千问 / DSH 共用）
//   native    以上都没有：不替 pi 选模型，用户在 pi 里 /login 或用它自己的配置
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_ENTRY = PI_PACKAGE + '/dist/bundle/cli.js';
const PI_VERSION = '1.5.2';          // 一键安装装的版本（2026-11-18 本机真实跑通）
const PI_MIN_NODE = '22.19.0';       // 包里 engines 写的 >=22.19.0；体检、启动、一键安装都按完整版本比（r39 审查：只看大版本会把 22.0–22.18 当成可用）
const LEGACY_PACKAGE = '@mariozechner/pi-coding-agent';
const PLAN_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const PI_INSTALL_HINT = '请在「CLI 安装」里点「安装 pi」（Hub 装一份自管的，不改你的全局 npm），或自己运行 npm i -g ' + PI_PACKAGE;
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const envGet = (env, name) => { const k = Object.keys(env || {}).find(x => x.toLowerCase() === name.toLowerCase()); return k ? String(env[k] || '') : ''; };

// 用户自己全局装的 pi 可能在的根目录（根目录下有 node_modules）：npm 全局目录、PATH 上 pi.cmd 所在目录、各 Node 安装目录。
function userRoots(env = process.env) {
  const roots = [envGet(env, 'NPM_CONFIG_PREFIX')];
  const appdata = envGet(env, 'APPDATA');
  if (appdata) roots.push(path.join(appdata, 'npm'));
  for (const dir of envGet(env, 'PATH').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (['pi.cmd', 'pi.ps1'].some(name => fs.existsSync(path.join(dir, name)))) roots.push(dir, path.dirname(dir));
  }
  try { roots.push(...require('./local-node').candidateDirs(env)); } catch (_) {}
  const seen = new Set();
  return roots.filter(r => r && path.isAbsolute(r)).filter(r => { const k = path.resolve(r).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function runtimeAt(root, source) {
  const entryPath = path.join(root, 'node_modules', ...PI_ENTRY.split('/'));
  if (!fs.existsSync(entryPath)) return null;
  return { root, entryPath, source, version: readJson(path.join(root, 'node_modules', PI_PACKAGE, 'package.json'))?.version || '' };
}

// 找 pi：用户自己装的优先，Hub 一键安装的那份兜底。只读文件、不起进程，体检和新建会话随时可以调。
// legacy：只找到旧包名 @mariozechner/pi-coding-agent（作者已标记弃用，扩展接口不同），提示升级而不是硬跑。
function resolvePiRuntime(env = process.env) {
  for (const root of userRoots(env)) { const hit = runtimeAt(root, 'user'); if (hit) return hit; }
  try {
    const m = require('./cli-tools/registry').managed('pi', env);
    const hit = m && runtimeAt(m.dir, 'hub');
    if (hit) return hit;
  } catch (_) {}
  const legacy = userRoots(env).find(root => fs.existsSync(path.join(root, 'node_modules', LEGACY_PACKAGE, 'package.json')));
  return legacy ? { legacy: true, root: legacy, version: readJson(path.join(legacy, 'node_modules', LEGACY_PACKAGE, 'package.json'))?.version || '' } : null;
}
// 给 pi 用的 Node：Hub 一键安装的那份优先，但也要核版本（以前直接返回，没看版本）；不够就在本机找 22.19 以上的。
function nodeFor(env = process.env) {
  const local = require('./local-node');
  try {
    const hub = require('./cli-tools/registry').managedBin('node', env);
    if (hub && local.versionAtLeast(local.nodeVersion(hub), PI_MIN_NODE)) return hub;
  } catch (_) {}
  return local.findNode({ env, minVersion: PI_MIN_NODE }) || '';
}

// 体检与安装状态（core/env-check.js、设置页）：ready / legacy / no-node / none。
function diagnosePi(env = process.env) {
  const runtime = resolvePiRuntime(env);
  if (!runtime) return { state: 'none', message: '没有找到 pi。' + PI_INSTALL_HINT };
  if (runtime.legacy) return { state: 'legacy', version: runtime.version,
    message: `找到的是旧包 ${LEGACY_PACKAGE} ${runtime.version}（作者已改名弃用）。` + PI_INSTALL_HINT };
  const node = nodeFor(env);
  if (!node) return { state: 'no-node', version: runtime.version, entryPath: runtime.entryPath, source: runtime.source,
    message: 'pi 需要 Node.js 22.19 或更新版本，本机没有找到；一键安装 pi 时会顺带装好 Node.js' };
  return { state: 'ready', version: runtime.version, entryPath: runtime.entryPath, source: runtime.source, node };
}

// ---------- 模型线路 ----------
function tokenPlanModels() {
  try {
    const ids = require('./acp-model-catalog').acpModelOptions('deepseek-acp').map(m => m.id)
      .concat(require('./acp-model-catalog').acpModelOptions('qwen').map(m => m.id), require('./acp-model-catalog').acpModelOptions('glm').map(m => m.id));
    return [...new Set(ids)];
  } catch { return []; }
}
// 每个模型都写 input（反馈 03243735）：pi 读模型时直接调 model.input.includes("image")，registerProvider 这条路不补默认值，缺了就报 reading 'includes'。
// 本次可用的线路，按默认优先顺序。company 只在公司版、且反代端点在时出现。
function availableRoutes(config = {}, env = process.env, { dataDir, sessionId } = {}) {
  const routes = [];
  if (config.companyCli) {
    try {
      // 部门 API key 用户（DSH 选的是反代里的 API 网关上游）：pi 和 DSH 走同一条网关，会话钥匙带网关标记、模型用网关上的模型。
      // 以前这里不看网关设置，一律走 CodeAgent 那条公司上游：没装 CodeAgent 的网关用户一发消息就报错（2026-11-20 同事反馈）。
      const gateway = config.dshBackend === 'proxy' && config.dshUpstream === 'gateway';
      const route = require('./company-model-proxy').dshRoute({ dataDir, sessionId: sessionId || 'pi-catalog', model: config.dshApiModel, gateway });
      routes.push({ id: 'company', provider: route.providerId, keyEnv: route.keyEnv, key: route.key, gateway,
        providerConfig: { name: gateway ? 'API 网关' : '公司模型', baseUrl: route.baseURL, api: 'openai-completions', apiKey: '$' + route.keyEnv,
          models: route.providerConfig.models.map(m => ({ id: m.id, name: m.id, reasoning: true, input: ['text'], contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            compat: m.compat, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) },
        models: route.providerConfig.models.map(m => m.id), defaultModel: route.model });
    } catch (_) { /* 反代没配好：公司版这条线不可用，下面的线路照常 */ }
  }
  const deepseekKey = String(config.deepseekApiKey || '').trim() || envGet(env, 'DEEPSEEK_API_KEY').trim();
  if (deepseekKey) routes.push({ id: 'deepseek', provider: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', key: deepseekKey,
    models: DEEPSEEK_MODELS, defaultModel: DEEPSEEK_MODELS[0] });
  const planKey = String(config.acp?.apiKey || '').trim() || envGet(env, 'AI_HUB_TOKEN_PLAN_KEY').trim();
  const planModels = tokenPlanModels();
  if (planKey && planModels.length) routes.push({ id: 'tokenplan', provider: 'hub-tokenplan', keyEnv: 'AI_HUB_PI_TOKEN_PLAN_KEY', key: planKey,
    providerConfig: { name: 'Token Plan 套餐', baseUrl: PLAN_BASE_URL, api: 'openai-completions', apiKey: '$AI_HUB_PI_TOKEN_PLAN_KEY',
      models: planModels.map(id => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) },
    models: planModels, defaultModel: planModels[0] });
  return routes;
}
const ROUTE_LABELS = { company: '公司模型', deepseek: 'DeepSeek API', tokenplan: 'Token Plan', native: 'pi 自己的登录' };
// 线路显示名：公司线路走的是 API 网关时写「API 网关」，免得网关用户以为用的是 CodeAgent 账号。
const routeLabel = route => route.gateway ? 'API 网关' : ROUTE_LABELS[route.id];
// Hub 线路的 provider 名 → 线路、缺什么、在哪补（缺钥匙时就地提示用）。
// hubOnly：这个 provider 只有 Hub 注入才存在（套餐、公司模型）；deepseek 是 pi 自带的 provider 名，用户也可能在 pi 自己的配置里配了它。
const HUB_PROVIDERS = {
  deepseek: { route: 'deepseek', need: 'DeepSeek API Key', billing: 'DeepSeek 官方 API 计费', keyField: 'deepseek', hubOnly: false },
  'hub-tokenplan': { route: 'tokenplan', need: '阿里云 Token Plan 套餐 Key', billing: '消耗 Token Plan 套餐额度', keyField: 'tokenplan', hubOnly: true },
  'company-proxy': { route: 'company', need: '公司模型接入（设置 → 公司模型）', billing: '公司模型', keyField: null, hubOnly: true },
};
// 会话首次启动时的凭据来源：'pi:native' → native（pi 自己的配置或登录），'pi:deepseek' 等 → Hub 线路；老记录没有时返回 ''。
function savedRouteSource(profileId) {
  const m = /^pi:(native|deepseek|tokenplan|company)$/.exec(String(profileId || ''));
  return m ? m[1] : '';
}
// 会话存的是 Hub 线路的模型、但这条线路这次不可用（钥匙删了、没填）：返回要告诉用户的问题；可用或不是 Hub 线路返回 null。
// r39 审查 P1：以前这里会悄悄换成第一条可用线路（例如套餐模型变成 DeepSeek API），模型和计费方式都被换掉。现在保持用户选的，当场说清缺什么。
// r39 二次返工 P2：只凭 provider 名判断会把「pi 自己配的 DeepSeek」当成 Hub 线路缺钥匙。现在看会话的凭据来源：
// 首次就是 native 的会话、模型又是 pi 自己也能解析的 provider（deepseek），恢复时沿用 pi 自己的配置，不拦；
// Hub 线路的会话（pi:deepseek 等）和只有 Hub 才有的 provider（套餐、公司模型）照旧缺钥匙就拦，不悄悄换来源。
function savedRouteProblem(model, routes, source = '') {
  const { provider, id } = splitModel(model);
  const info = HUB_PROVIDERS[provider];
  if (!info || routes.some(r => r.provider === provider)) return null;
  if (source === 'native' && !info.hubOnly) return null;
  return { route: info.route, provider, model: String(model), label: ROUTE_LABELS[info.route], keyField: info.keyField,
    message: `这个 pi 会话用的是「${ROUTE_LABELS[info.route]}」线路的 ${id}（${info.billing}），但 Hub 里没有${info.need}。`
      + `Hub 没有改用别的线路或模型，免得换成另一种计费；补上${info.keyField ? ' Key' : '配置'}后再打开这个会话即可。` };
}
function piRouteCheck(model, config = {}, env = process.env, extra = {}) {
  const problem = savedRouteProblem(model, availableRoutes(config, env, extra), savedRouteSource(extra.profileId));
  return problem ? { ok: false, ...problem } : { ok: true };
}
// 模型选择器用：「线路/模型」，例如 deepseek/deepseek-flash。没有任何 Hub 线路时只有一项「pi 自己的默认模型」。
function piModelOptions(config = {}, env = process.env, extra = {}) {
  const options = [];
  for (const route of availableRoutes(config, env, extra)) {
    for (const id of route.models) options.push({ id: `${route.provider}/${id}`, label: `${id} · ${routeLabel(route)}`, source: 'pi-' + route.id });
  }
  if (!options.length) options.push({ id: '', label: 'pi 自己的默认模型（在 pi 里 /login 或 /model）', source: 'pi-native' });
  return options;
}
function defaultPiModel(config = {}, env = process.env, extra = {}) {
  const route = availableRoutes(config, env, extra)[0];
  return route ? `${route.provider}/${route.defaultModel}` : '';
}
function splitModel(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('/');
  return at > 0 ? { provider: text.slice(0, at), id: text.slice(at + 1) } : { provider: '', id: text };
}

// ---------- 启动参数 ----------
// opts：id、cwd、model（线路/模型）、effort、acpSid（pi 会话 id）、piSessionFile（恢复用的会话文件）、
//       piProfileId（恢复时传会话首次的 pi:native / pi:deepseek…，区分凭据来自 pi 自己还是 Hub 线路）。
function buildPiCliOptions(kind, opts, config = {}, dataDir, baseEnv = process.env) {
  const runtime = resolvePiRuntime(baseEnv);
  if (!runtime || runtime.legacy) throw new Error((runtime?.legacy ? `找到的是已弃用的旧包 ${LEGACY_PACKAGE}。` : '没有找到 pi。') + PI_INSTALL_HINT);
  const node = nodeFor(baseEnv);
  if (!node) throw new Error('pi 需要 Node.js 22.19 或更新版本，本机没有找到。' + PI_INSTALL_HINT);
  const routes = availableRoutes(config, baseEnv, { dataDir, sessionId: opts.id });
  let model = String(opts.model || '').trim();
  let { provider, id } = splitModel(model);
  const source = savedRouteSource(opts.piProfileId);
  const ownProvider = source === 'native' && !(HUB_PROVIDERS[provider]?.hubOnly);
  // native 会话恢复：模型（如 pi 自己配的 deepseek/…）原样交给 pi 解析，用它自己的配置，不套 Hub 线路（r39 二次返工）。
  let route = ownProvider ? undefined : routes.find(r => r.provider === provider);
  // 存的模型所在线路这次不可用（例如钥匙删了）：不换线路、不换模型，报清缺什么（界面就地给补钥匙的输入框）。
  // 只有完全没指定模型的新会话才自动选默认线路。
  const problem = model ? savedRouteProblem(model, routes, source) : null;
  if (problem) throw Object.assign(new Error(problem.message), { code: 'PI_ROUTE_KEY_MISSING', piRoute: problem });
  if (!model && routes[0]) { route = routes[0]; provider = route.provider; id = route.defaultModel; model = `${provider}/${id}`; }
  // 公司线路换了上游（CodeAgent 公司模型 ↔ API 网关）：会话存的模型在这边不存在，原样交给 pi 只会报找不到模型。
  // 和 DSH 一样改用这条线路的默认模型（标题栏的模型名会跟着变，看得见）。线路本身（计费来源）没变，只是同一条线路上模型表换了。
  if (route?.id === 'company' && id && !route.models.includes(id)) { id = route.defaultModel; model = `${provider}/${id}`; }
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (/^(CLAUDE_HUB_(TOKEN|PORT|SESSION)|AI_TEAM_HUB_CALLBACK|CODEX_THREAD|CODEX_SESSION)/.test(name)
      || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'AI_HUB_TOKEN_PLAN_KEY'].includes(name)) delete env[name];
  }
  const providers = {};
  for (const r of routes) {
    env[r.keyEnv] = r.key;
    if (r.providerConfig) providers[r.provider] = r.providerConfig;
  }
  Object.assign(env, { AI_HUB_PI_PROVIDERS: JSON.stringify(providers), PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
  const observer = require('./acp-profiles').dshRuntimeFile('pi-cli-observer.mjs', __dirname);
  const args = [runtime.entryPath, '-e', observer];
  // Hub 线路明确给 --provider；用户 pi 自己的模型（如 anthropic/claude-…）原样交给 --model，由 pi 解析。
  if (provider && route) args.push('--provider', provider, '--model', id);
  else if (model) args.push('--model', model);
  if (opts.effort && /^(off|minimal|low|medium|high|xhigh)$/.test(opts.effort)) args.push('--thinking', opts.effort);
  // 会话文件是 pi 自己报的路径；pi 在第一条消息后才写这个文件。报过路径但文件不在＝一句没聊过（或被删），
  // 这时再拿会话 id 去续，pi 找不到会直接退出（r39 返工 E2E 实测：退出码 1），所以开一个新的。没报过路径的老记录仍按 id 续。
  const resume = opts.piSessionFile ? (fs.existsSync(opts.piSessionFile) ? opts.piSessionFile : null) : opts.acpSid || null;
  if (resume) args.push('--session', resume);
  return { id: opts.id, kind: 'pi', cwd: opts.cwd, model, effort: opts.effort || null, resumeId: resume ? opts.acpSid || null : null,
    route: route ? route.id : 'native', runtime: { version: runtime.version, source: runtime.source, entryPath: runtime.entryPath },
    profileId: 'pi:' + (route ? route.id : 'native'), launch: { command: node, args, env } };
}

module.exports = { PI_PACKAGE, PI_ENTRY, PI_VERSION, PI_MIN_NODE, LEGACY_PACKAGE, PI_INSTALL_HINT, ROUTE_LABELS, routeLabel,
  resolvePiRuntime, diagnosePi, nodeFor, savedRouteProblem, savedRouteSource, piRouteCheck, availableRoutes, piModelOptions, defaultPiModel, splitModel, buildPiCliOptions, userRoots };
