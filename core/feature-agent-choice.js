'use strict';
// 后台功能共用选型；无显式选择时完全走原调用，不改 CLI 和启动中心默认值。
const routes = require('./codeagent-assistant-route');
const ONESHOT = ['codeagent', 'claude', 'codex'];
// 会话功能依赖任务文件和受控 MCP。其他 CLI 尚无等价的工具边界，不提供会话选项。
// CodeAgent-Lite：同一个 CodeAgent（账号、模型、MCP 全同），只是固定走多会话共用的 serve 后台进程，省内存。
const SESSION = ['codeagent', 'codeagent-lite'];
const LITE = 'codeagent-lite';
// 部门 API key（网关）：8 项会话功能都可显式选（2026-11-24）；会话由 Claude Code 经本机反代的网关上游作答（core/assistant-gateway-route.js）。
// 没选过时：没有可用 CodeAgent 且部门 key 可用就自动走网关（11-24 只管助理；R49-2 起 8 项会话功能 + PPT 库地图），否则默认 CodeAgent。
const gatewayRoute = () => require('./assistant-gateway-route');
const GATEWAY = 'api-gateway';
const SESSION_GW = [...SESSION, GATEWAY];
// 「只统计（不调模型）」档（2026-11-28 蒸馏自己）：只给带 statsOnly 的功能，不进后端目录，选了就不调用任何模型。
const STATS_ONLY = 'stats-only';
const ALL_BACKENDS = ['codeagent', LITE, 'claude', 'codex', 'deepseek-acp', 'qwen', 'glm'];
const FEATURES = [
  { id: 'help', label: '问问 Hub', kinds: ONESHOT, defaultText: '按发行版自动选用可用 CLI' },
  { id: 'pptMap', label: 'PPT 库地图', kinds: ONESHOT, defaultText: 'CodeAgent · DeepSeek Flash → GLM Auto' },
  { id: 'ppt', label: 'PPT 找页', kinds: SESSION_GW, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'pptMake', label: 'PPT 做页', kinds: SESSION_GW, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'pptImgtext', label: 'PPT 图转字', kinds: SESSION_GW, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'assistant', label: '助理（电脑 / 手机 / 简报）', kinds: SESSION_GW, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'avatar', label: '分身', kinds: SESSION_GW, defaultText: 'CodeAgent · 分身指定或助理模型' },
  { id: 'forum', label: '论坛热帖汇总', kinds: SESSION_GW, defaultText: 'CodeAgent · 启动默认模型' },
  { id: 'progress', label: '进展卡自动摘要', kinds: ONESHOT, defaultText: 'Claude · Haiku' },
  { id: 'meeting', label: '会议理解 / 问答', kinds: SESSION_GW, defaultText: '会议中所选引擎' },
  { id: 'text', label: '草稿整理 / 团队文字任务', kinds: SESSION_GW, defaultText: 'CodeAgent · 启动默认模型' },
  { id: 'crew', label: '社区团队来信（自动作答 / 起草回信）', kinds: ONESHOT, exclude: ['codex', 'deepseek-acp'], defaultText: 'CodeAgent · 启动默认模型' },
  { id: 'distill', label: '蒸馏自己', kinds: SESSION_GW, statsOnly: true, noPreset: true, defaultText: 'CodeAgent · 助理模型与供应商' },
];
const LABELS = { codeagent: 'CodeAgent', [LITE]: 'CodeAgent-Lite（省内存）', claude: 'Claude', codex: 'Codex', 'deepseek-acp': 'DSH', qwen: 'Qwen Code', glm: 'ZCode', [GATEWAY]: '部门 API key（网关）', [STATS_ONLY]: '只统计（不调模型）' };
// 网关这一行：模型 = key 的对话模型表（附一键体检的说明）+ 手填检测通过的；allowCustom 让界面给出「手填模型」。
function gatewayRow(dataDir, { env, findCommand }) {
  const gw = require('./api-gateway');
  let view = { models: [], customModels: [], model: '' }, models = [];
  try {
    view = gw.read(dataDir);
    models = [...gw.modelChoices(dataDir).map(m => ({ id: m.id, label: m.note ? `${m.id} · ${m.note}` : m.id, ...(m.ok === false ? { unhealthy: true } : {}) })),
      ...view.customModels.map(id => ({ id, label: `${id} · 手填`, custom: true }))];
  } catch { models = []; }
  const a = gatewayRoute().availability(dataDir, { env, findCommand });
  return { kind: GATEWAY, label: LABELS[GATEWAY], available: a.available, reason: a.reason, defaultModel: view.model || '', models, allowCustom: true };
}
function feature(id) { const row = FEATURES.find(f => f.id === id); if (!row) throw new Error('未知功能'); return row; }
// 公司版会话功能另收「Claude Code 外壳 + 公司模型 / 自有接口 / 自有 API」（部门 key 那条仍存成 api-gateway，和以前同一条线路）。
// 单次任务另收 DSH（经 ACP 只读作答，core/dsh-oneshot.js）。
const kindAllowed = (f, kind) => (kind === STATS_ONLY ? !!f.statsOnly : !f.exclude?.includes(kind) && (f.kinds.includes(kind) || (companyEdition() && (f.kinds === ONESHOT ? kind === 'deepseek-acp' : kind === 'claude'))));
// 公司版（2026-11-26 修正）：Claude Code / Codex / DSH 只是外壳（harness），公司里没有 Claude、GPT 这类模型。
// 外壳背后的模型只从启动中心同一份来源里列（2026-11-27 宗旨：部门 API / 自有 API 用户和 CodeAgent 用户同样的体验）：
// 部门 API key（网关）、公司模型（经本机反代用 CodeAgent 账号）、自有接口、自有 API 账号。「沿用本机 CLI 配置」不进后台功能
// （公司里 CLI 自己没有可用模型，就是 11-26 修掉的那种「本机默认模型」）。
// 枚举直接复用启动中心的模型卡函数（renderer/launch-model-cards.js cardsFor + core/company-api-config.js settings），不另写一套。
const HARNESS = ['claude', 'codex', 'deepseek-acp'];
const HARNESS_SOURCES = ['gateway', 'company', 'own', 'api'];
const SOURCE_LABELS = require('./harness-route').LABELS;
const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' };
// 同一来源下的同一个模型：自有 API 账号还要账号对上。
const sameModel = (m, c) => m.id === c.model && m.source === c.source && (c.source !== 'api' || m.profileId === c.profileId);
const NO_SOURCE = '需要先配置模型来源：部门 API key、自有 API，或装好 CodeAgent 用公司模型';
const companyEdition = () => { try { return require('./company-api-config').isCompany(); } catch { return false; } };
// 主进程注入：反代状态（模型卡状态点用）与「用前拉起反代」。没注入时（单测、旧调用方）状态按「选中后自动启动」显示。
let runtime = { proxyStatus: null, ensureProxy: null };
function setRuntime(next = {}) { runtime = { ...runtime, ...next }; }
// 默认链用（没给功能显式选过时）：只跟启动中心为这个工具存下的线路走——那里选的是部门 key / 公司模型，就经本机反代用它；
// 选的是自有接口或沿用本机 CLI 配置，返回 null，照旧用 CLI 自己的配置（Codex 审查 P2：不能凭存着 key 就盖掉原来能用的线路）。
// 启动中心为这个工具存下的线路（2026-11-27 起含自有接口 / 自有 API 账号）；「沿用本机 CLI 配置」返回 null。
function launchRoute(kind, provider) {
  if (!provider) return null;
  if (provider.backend === 'proxy') return { source: provider.upstream === 'gateway' ? 'gateway' : 'company', model: provider.model || '' };
  if (provider.backend === 'api' && provider.selectedProfileId) {
    const profile = (provider.apiProfiles || []).find(p => p.id === provider.selectedProfileId);
    return profile ? { source: 'api', profileId: profile.id, model: profile.model || '' } : null;
  }
  if (provider.backend === 'api' || (kind === 'deepseek-acp' && provider.own?.backend === 'api')) return { source: 'own', model: provider.model || provider.own?.model || '' };
  return null;
}
function harnessDefault(dataDir, kind, options = {}) {
  if (!companyEdition() || !HARNESS.includes(kind)) return null;
  let provider = null;
  try { provider = options.providers?.[kind] || require('./company-api-config').settings(require('./hub-config').readConfigJsonForUpdate())[kind]; } catch { provider = null; }
  const saved = launchRoute(kind, provider);
  if (!saved || (options.sources && !options.sources.includes(saved.source))) return null;
  const row = (options.backends || catalog(dataDir, options)).find(b => b.kind === kind);
  const usable = (row?.models || []).filter(m => !m.unavailable && m.source === saved.source && (saved.source !== 'api' || m.profileId === saved.profileId));
  const hit = usable.find(m => m.id === saved.model) || usable[0];
  return row?.available && hit ? { kind, source: saved.source, model: hit.id, ...(hit.profileId ? { profileId: hit.profileId } : {}) } : null;
}
// 没有就用启动中心配了模型来源（部门 key / 公司模型 / 自有接口 / 自有 API）的 Claude Code、Codex，会话照启动中心那条线起。
function workKind(options = {}) {
  const find = options.findCommand || require('./community-setup').findCommand, env = options.env || process.env;
  const has = kind => { try { return !!find(kind, env); } catch { return kind === 'codeagent'; } };
  if (!companyEdition() || has('codeagent')) return 'codeagent';
  let providers = options.providers || null;
  if (!providers) try { providers = require('./company-api-config').settings(require('./hub-config').readConfigJsonForUpdate()); } catch { providers = null; }
  return ['claude', 'codex'].find(kind => launchRoute(kind, providers?.[kind]) && has(kind)) || 'codeagent';
}
// 有功能选了「外壳 + 部门 key / 公司模型」时本机反代要常驻（main.js 反代 isEnabled），免得改完配置被收掉。
// PPT 库地图没选过、走自动默认的外壳 + 部门 key 时也算（R49-2 审查 P2-1：只装了 Codex、会话功能用不了网关时，反代不能被收掉）。
function harnessInUse(dataDir) {
  try {
    if (FEATURES.some(f => { const p = routes.featurePreference(dataDir, f.id); return HARNESS.includes(p?.kind) && require('./harness-route').viaProxy(p?.source); })) return true;
    // 没选过、走自动默认且经本机反代（外壳 + 部门 key / 公司模型）的功能也算（R49-2 审查 P2-1；11-27 审查 P2-7 扩到全部功能）。
    // 部门 key 那条（api-gateway）由 assistant-gateway-route inUse 管。目录只读一次。
    const unpicked = FEATURES.filter(f => !routes.featurePreference(dataDir, f.id));
    if (!unpicked.length) return false;
    if (!gatewayRoute().codeagentMissing(dataDir)) return false;
    const backends = catalog(dataDir);
    return unpicked.some(f => { const a = autoSelected(dataDir, f, { backends }); return a?.kind !== GATEWAY && require('./harness-route').viaProxy(a?.source); });
  } catch { return false; }
}
// 单次任务用外壳前拉起本机反代（部门 key 只要反代在跑；公司模型还要上游就绪）。没注入时不拦，由反代地址缺失时报人话。
async function ensureProxy(source) {
  if (!runtime.ensureProxy) return;
  const status = await runtime.ensureProxy(source);
  // 部门 key 只要本机反代在跑；「not-ready」说的是公司上游（CodeAgent）没就绪，与网关无关（同 main.js ensureSessionLaunchAuth）。
  const bad = source === 'gateway' ? ['failed', 'stopped'] : ['failed', 'stopped', 'not-ready'];
  if (status && bad.includes(status.state)) throw new Error(status.message || (source === 'gateway' ? '本机反代没有启动，部门 API key 暂时用不了' : '公司模型反代还没准备好'));
}
function harnessRow(kind, { env, findCommand, codeagentAvailable, providers }) {
  let status = null;
  const provider = providers?.[kind] || null;
  try { status = runtime.proxyStatus ? runtime.proxyStatus() : null; } catch { status = null; }
  let cards = [];
  try { cards = provider ? require('../renderer/launch-model-cards').cardsFor(kind, provider, status, null, { codeagentInstalled: codeagentAvailable }) : []; } catch { cards = []; }
  // 留后台功能真能用的四种来源：公司模型要本机有 CodeAgent，或共享号池 / 反代已就绪（账号在那边）；自有卡里「沿用本机 CLI 配置」不要。
  const label = c => c.source === 'api' ? `${SOURCE_LABELS.api} · ${c.name}${c.model && c.model !== c.name ? ' · ' + c.model : ''}`
    : `${SOURCE_LABELS[c.source]} · ${c.source === 'own' ? c.model || '接口默认模型' : c.name || c.model || c.id}`;
  const models = cards.filter(c => c.source === 'gateway' || (c.source === 'company' && (codeagentAvailable || c.state === 'ready'))
    || (c.source === 'own' && c.sourceText === '自有接口') || c.source === 'api')
    .map(c => ({ id: c.model || (c.source === 'company' ? c.id : ''), label: label(c), source: c.source, ...(c.profileId ? { profileId: c.profileId } : {}),
      note: c.statusText || '', ...(c.state === 'error' || c.state === 'needs' ? { unavailable: true } : {}) }));
  const gatewayKey = !!provider?.gatewayModels;
  let cli = '';
  try {
    if (kind !== 'deepseek-acp') cli = findCommand(kind, env) || '';
    else {
      // 一键安装或 npm 全局装的 DSH 不写 entryPath：和启动中心、DSH 单次问答同一套查找（dsh-cli-profile resolveDshCliRuntime）。
      const entry = require('./hub-config').getConfig().acp?.providers?.[kind];
      cli = entry?.entryPath && require('node:fs').existsSync(entry.entryPath) ? entry.entryPath : '';
      if (!cli) try { cli = require('./dsh-cli-profile').resolveDshCliRuntime(entry, env)?.entryPath || ''; } catch { cli = ''; }
    }
  } catch { cli = ''; }
  const usable = models.filter(m => !m.unavailable);
  const reason = !cli ? `本机没有 ${HARNESS_LABELS[kind]}` : !usable.length ? (models.length ? '已配的模型来源暂时都用不了' : NO_SOURCE) : '';
  // 首选：启动中心为这个工具存下的线路；没有再按 部门 key → 自有接口 → 自有 API → 公司模型。
  const saved = launchRoute(kind, provider);
  const preferred = (saved && usable.find(m => m.source === saved.source && (saved.source !== 'api' || m.profileId === saved.profileId) && (!saved.model || m.id === saved.model)))
    || ['gateway', 'own', 'api', 'company'].map(src => usable.find(m => m.source === src)).find(Boolean);
  return { kind, label: HARNESS_LABELS[kind], harness: true, available: !!cli && usable.length > 0, reason,
    setup: !usable.length ? (gatewayKey ? 'own' : 'source') : '', defaultModel: preferred ? preferred.id : '', defaultSource: preferred ? preferred.source : '',
    ...(preferred?.profileId ? { defaultProfileId: preferred.profileId } : {}), models };
}
function catalog(dataDir, { env = process.env, findCommand = require('./community-setup').findCommand } = {}) {
  const models = require('./model-options');
  const config = require('./hub-config').getConfig();
  const codexHome = env.CODEX_HOME || require('./codex-usage-scope').resolveCodexUsageScope(config, { hubDataDir: dataDir }).home;
  const company = companyEdition();
  let codeagentAvailable = false, providers;
  // 三个外壳共用一次读配置（settings 内部还会读会话列表），不按行重复读。
  const companyProviders = () => {
    if (providers === undefined) { try { providers = require('./company-api-config').settings(require('./hub-config').readConfigJsonForUpdate()); } catch { providers = null; } }
    return providers;
  };
  const rows = ALL_BACKENDS.filter(kind => kind !== LITE).map(kind => {
    if (company && HARNESS.includes(kind)) {
      try { require('./company-ai-policy').assertKind(kind); } catch { return { kind, label: HARNESS_LABELS[kind], harness: true, available: false, reason: '当前发行版不提供', models: [], defaultModel: '' }; }
      return harnessRow(kind, { env, findCommand, codeagentAvailable, providers: companyProviders() });
    }
    let options = [], available = false;
    try {
      require('./company-ai-policy').assertKind(kind);
      require('./community-provider').assertProviderAvailable(kind);
      if (ONESHOT.includes(kind)) available = !!findCommand(kind, env);
      else { const entry = config.acp?.providers?.[kind]; available = !!entry?.entryPath && require('node:fs').existsSync(entry.entryPath); }
      options = kind === 'codeagent' ? routes.modelOptions(dataDir, 'personal', require('./codeagent-config').resolveCodeAgentConfig(env).configDir)
        : kind === 'claude' ? require('./claude-model-catalog').buildClaudeModelSnapshot({ configDir: env.CLAUDE_CONFIG_DIR, homeDir: env.CLAUDE_HUB_HOME_DIR }).models
        : kind === 'codex' ? require('./codex-model-catalog').buildCodexTuningSnapshot([], { configDir: codexHome }).models
        : require('./acp-model-catalog').acpModelOptions(kind, config.acp?.providers?.[kind]?.model);
      if (!options.length && kind !== 'codeagent') options = models.MODEL_OPTIONS_BY_KIND[kind] || [];
    } catch { available = false; }
    const defaultModel = config.defaultModels?.[kind] || config.acp?.providers?.[kind]?.model || models.DEFAULT_MODEL_BY_KIND[kind] || '';
    if (kind === 'codeagent') codeagentAvailable = available;
    return { kind, label: LABELS[kind], available, defaultModel, models: options };
  });
  // Lite 的可用性、模型目录与默认模型完全沿用 CodeAgent，不另做配置。
  const base = rows.find(row => row.kind === 'codeagent');
  if (base) rows.splice(rows.indexOf(base) + 1, 0, { ...base, kind: LITE, label: LABELS[LITE], models: base.models.slice() });
  rows.push(gatewayRow(dataDir, { env, findCommand }));
  return rows;
}
function resolve(dataDir, id, options = {}) {
  const f = feature(id), choice = routes.featurePreference(dataDir, id);
  if (!choice) {
    // 开箱即用（R49-2 扩到 8 项会话功能 + PPT 库地图；11-27 按「部门 API / 自有 API 用户与 CodeAgent 用户同样体验」细化）：
    // 没选过、本机没有可用的 CodeAgent（没装或没有模型权限，判定见 assistant-gateway-route codeagentMissing）时，
    // 跟启动中心为 Claude Code 存下的线路走（部门 key / 公司模型 / 自有接口 / 自有 API），没存过再用部门 key。有 CodeAgent 的保持原默认。
    const auto = autoSelected(dataDir, f, options);
    return auto ? { choice: null, selected: auto, warning: '', auto: true } : { choice: null, selected: null, warning: '' };
  }
  // 旧版存下的外壳选择（没有模型来源，模型是 claude-opus / gpt 这类公司里用不了的）：不再照跑，提示重选，本次沿用默认。
  if (companyEdition() && HARNESS.includes(choice.kind) && !HARNESS_SOURCES.includes(choice.source)) return { choice, selected: null, legacy: true, warning: legacyWarning(choice) };
  if (!kindAllowed(f, choice.kind)) return { choice, selected: null, warning: '此功能尚不支持该后端的受控只读执行，本次沿用默认。' };
  if (choice.kind === STATS_ONLY) return { choice, selected: { kind: STATS_ONLY, model: '' }, warning: '' };
  const backends = options.backends || catalog(dataDir, options);
  const backend = backends.find(b => b.kind === choice.kind && b.available);
  const hit = backend?.models.find(m => !m.unavailable && (choice.source ? sameModel(m, choice) : m.id === choice.model) && (!choice.codeagentModelProvider || (m.provider || m.codeagentModelProvider) === choice.codeagentModelProvider));
  if (!backend || ((choice.model || choice.source) && !hit && !customCodeAgent(f, choice))) return { choice, selected: null, warning: '所选后端或模型当前不可用，本次沿用默认。' };
  return { choice, selected: choice, warning: '' };
}
// 单次任务（问问 Hub / PPT 库地图 / 进展卡摘要）用 CodeAgent 时可以手填模型名：单次执行直接把名字交给 CLI 的 --model，
// 不经 /model 菜单，所以清单里没有、但账号能用的模型照样能跑。手填的名字试跑通过才记下（customCodeAgentModel），带 custom 标记。
// One-shot CodeAgent features accept a hand-typed model name; it is saved only after a trial run succeeds.
function customCodeAgent(f, choice) {
  return !!choice?.custom && choice.kind === 'codeagent' && oneshot(f) && require('./model-id').isSafeModelId(choice.model);
}
function legacyWarning(choice) {
  const what = `${HARNESS_LABELS[choice.kind] || choice.kind}${choice.model ? ' · ' + choice.model : ' · 本机默认模型'}`;
  return `之前选的「${what}」在公司里用不了：${HARNESS_LABELS[choice.kind] || choice.kind} 在公司版只当外壳，模型要用部门 API key、公司模型或自有 API。本次沿用默认，请重新选择。`;
}
// 没选过的功能、本机没有可用的 CodeAgent：默认用哪条线。8 项会话功能（会议的本场手选仍优先，见 meeting.js engineFor）+ PPT 库地图；
// 问问 Hub 有自己的默认链（core/help-ask/engine.js）；进展卡代写公司版默认不开（CodeAgent 用户也一样）。
function autoSelected(dataDir, f, options = {}) {
  if (!companyEdition() || (f.kinds === ONESHOT && f.id !== 'pptMap')) return null;
  // 「没有可用的 CodeAgent」沿用 R49 的判定（没装、serve 空清单、个人号模型全在避让里；号池登记了号或自配了供应商模型都算有）。
  // 先做便宜的判断：没给目录时先查命令和小文件，绝大多数有 CodeAgent 的老用户不读完整目录。
  if (!gatewayRoute().codeagentMissing(dataDir, { backends: options.backends, findCommand: options.findCommand, env: options.env || process.env })) return null;
  const backends = options.backends || catalog(dataDir, options);
  if (f.kinds === ONESHOT) {
    for (const kind of HARNESS) { const hit = harnessDefault(dataDir, kind, { ...options, backends, sources: HARNESS_SOURCES }); if (hit) return hit; }
    // 启动中心没存线路：取第一个可用外壳的首选；首选是部门 key 时要 key 真存着（R49：没存部门 key 谁都不自动）。
    let keySet = false;
    try { keySet = !!require('./api-gateway').read(dataDir).keySet; } catch { keySet = false; }
    const row = HARNESS.map(kind => backends.find(b => b.kind === kind)).find(b => b?.available && b.defaultSource && (b.defaultSource !== 'gateway' || keySet));
    return row ? { kind: row.kind, source: row.defaultSource, model: row.defaultModel, ...(row.defaultProfileId ? { profileId: row.defaultProfileId } : {}) } : null;
  }
  const pick = harnessDefault(dataDir, 'claude', { ...options, backends, sources: HARNESS_SOURCES });
  if (pick) return pick.source === 'gateway' ? { kind: GATEWAY, model: pick.model } : pick;
  return backends.find(b => b.kind === GATEWAY)?.available ? { kind: GATEWAY, model: '' } : null;
}
function set(dataDir, id, choice, options) {
  const f = feature(id);
  if (choice) {
    if (!kindAllowed(f, choice.kind) || (choice.model && !require('./model-id').isSafeModelId(choice.model))) throw new Error('请选择可用的后端和模型');
    if (choice.kind === STATS_ONLY) { routes.setFeaturePreference(dataDir, id, { kind: STATS_ONLY, model: '' }); return resolve(dataDir, id, options); }
    const harness = companyEdition() && HARNESS.includes(choice.kind);
    if (harness && !HARNESS_SOURCES.includes(choice.source)) throw new Error('请选择模型来源：部门 API key、公司模型或自有 API');
    if (harness && choice.source === 'api' && !/^[a-zA-Z0-9_-]{1,64}$/.test(choice.profileId || '')) throw new Error('请选择自有 API 账号');
    // 下拉里重新选回之前手填的那个模型时，沿用手填标记（清单里本来就没有它；R53）。
    const previous = routes.featurePreference(dataDir, id);
    const custom = customCodeAgent(f, choice) || customCodeAgent(f, { ...choice, custom: !!previous?.custom && previous.kind === choice.kind && previous.model === choice.model && !choice.codeagentModelProvider });
    const normalized = { kind: choice.kind, model: choice.model || '', ...(harness ? { source: choice.source, ...(choice.source === 'api' ? { profileId: choice.profileId } : {}) } : {}),
      ...require('./codeagent-model-choice').routeFields(choice), ...(custom ? { custom: true } : {}) };
    const backends = options?.backends || catalog(dataDir, options);
    const b = backends.find(b => b.kind === normalized.kind && b.available);
    if (normalized.kind === GATEWAY && !b) throw new Error(backends.find(r => r.kind === GATEWAY)?.reason || '部门 API key 暂时用不了');
    if (harness && !b) throw new Error(backends.find(r => r.kind === normalized.kind)?.reason || '所选外壳暂时用不了');
    // 自有接口 / 自有 API 账号可以不写模型名（用接口自己的默认模型），其余来源要选具体模型。
    if (harness && !normalized.model && !['own', 'api'].includes(normalized.source)) throw new Error('请选择模型');
    if (!b || ((normalized.model || harness) && !custom && !b.models.some(m => !m.unavailable && (harness ? sameModel(m, normalized) : m.id === normalized.model) && (!normalized.codeagentModelProvider || m.provider === normalized.codeagentModelProvider)))) throw new Error('所选后端或模型当前不可用，请恢复默认');
    routes.setFeaturePreference(dataDir, id, normalized);
  } else routes.setFeaturePreference(dataDir, id, null);
  return resolve(dataDir, id, options);
}
function session(dataDir, id, kind, opts, options) {
  const r = resolve(dataDir, id, options), selected = r.selected;
  if (!selected) return { kind, opts, warning: r.warning };
  if (selected.kind === GATEWAY) {
    // 不带 CodeAgent 专用字段；MCP 只挂该功能自己注入的会话工具（none 档 + 严格模式），模型空时用网关默认模型。
    const out = { ...opts, featureAgent: id, featureAgentChoice: JSON.stringify(selected), apiGatewayRoute: true, mcpProfile: 'none' };
    for (const k of Object.keys(out)) if (/^codeagent/i.test(k)) delete out[k];
    let model = selected.model;
    if (!model) try { model = require('./api-gateway').read(dataDir).model; } catch { model = ''; }
    if (model) { out.model = model; out.fixedModel = model; }
    return { kind: 'claude', opts: out, warning: '' };
  }
  if (selected.kind === 'claude' && selected.source) {
    // Claude Code 外壳 + 公司模型 / 自有接口 / 自有 API（2026-11-27）：和部门 key 那条同样的受控边界（none 档 MCP + 严格模式），
    // 连接只改这一个会话（core/assistant-gateway-route.js launchValues 按 source 定）。
    const out = { ...opts, featureAgent: id, featureAgentChoice: JSON.stringify(selected), apiGatewayRoute: true, mcpProfile: 'none' };
    for (const k of Object.keys(out)) if (/^codeagent/i.test(k)) delete out[k];
    delete out.model; delete out.fixedModel;
    if (selected.model) { out.model = selected.model; out.fixedModel = selected.model; }
    return { kind: 'claude', opts: out, warning: '' };
  }
  const out = { ...opts, featureAgent: id, featureAgentChoice: JSON.stringify(selected), ...require('./codeagent-model-choice').routeFields(selected) };
  const codeagentFamily = selected.kind === 'codeagent' || selected.kind === LITE;
  // 不把 CodeAgent 专用账号、模型字段带进其他后端。
  if (!codeagentFamily) for (const k of Object.keys(out)) if (/^codeagent/i.test(k)) delete out[k];
  // 功能选型指定了模型时，调用方（如分身页模型卡）带进来的供应商不能挂到这个模型上：换成功能选型自己的（没有就不带）。
  if (selected.model && codeagentFamily) {
    for (const k of ['codeagentModelProvider', 'codeagentModelProviderLabel', 'codeagentModelMenuLabel']) delete out[k];
    Object.assign(out, require('./codeagent-model-choice').routeFields(selected));
  }
  if (selected.model) { out.model = selected.model; out.fixedModel = selected.model; if (codeagentFamily) out.codeagentRouteModel = selected.model; }
  if (selected.kind === LITE) {
    // 底层仍建 codeagent 会话；显式放行共享 serve（core/codeagent-run-mode.js），serve 不支持思考强度。
    out.codeagentRunMode = 'serve';
    out.codeagentLiteFeature = true;
    delete out.effort;
    return { kind: 'codeagent', opts: out, warning: '' };
  }
  return { kind: selected.kind, opts: out, warning: '' };
}
function assertSessionKind(kind, opts = {}) {
  if (opts.featureAgent && ['company-assistant', 'company-forum', 'company-ai', 'avatar-agent'].includes(opts.purpose)
    && !/^codeagent(?:-resume)?$/.test(kind) && !gatewayRoute().allowedSession(kind, opts)) throw Object.assign(new Error('此功能尚不支持该后端的受控只读执行，请恢复默认'), { code: 'FEATURE_AGENT_UNSAFE_BACKEND', notSent: true });
}
function stale(dataDir, id, meta, options) {
  const selected = resolve(dataDir, id, options).selected;
  return (meta?.featureAgentChoice || '') !== (selected ? JSON.stringify(selected) : '');
}
// ── 设置页与功能内「⚙ Agent」用的选项表（公司版与启动中心同一份来源）。渲染层只按这里给的 options / current 画下拉。
// 后台功能能跑哪种外壳 + 来源：单次任务（问问 Hub / PPT 库地图 / 进展卡摘要）Claude Code、Codex 都能走部门 key 或公司模型；
// 会话功能要受控工具（none 档 MCP + 只读边界），只有 Claude Code 经部门 key 那条线做到了（存成 api-gateway，和以前同一条线路）。
const oneshot = f => f.kinds === ONESHOT;
function harnessSupport(f, kind) {
  // DSH 单次任务经 ACP 只读作答（core/dsh-oneshot.js）；DSH 没有自有 API 账号表，模型卡里本来就没有这种来源。
  if (oneshot(f)) return { ok: true, sources: HARNESS_SOURCES };
  if (kind === 'claude') return { ok: true, sources: HARNESS_SOURCES, store: GATEWAY };
  return { ok: false, reason: '这个功能要在会话里调用 Hub 工具，目前接通的是 CodeAgent 和 Claude Code（模型来源一样可选）' };
}
const SRC = 'src:';
const sourceValue = (source, id) => `${SRC}${source}:${id}`;
// 自有 API 账号的值带账号编号：src:api:<账号>:<模型>（账号编号不含冒号，模型名可以含）。
const sourceValueOf = m => m.source === 'api' ? `${SRC}api:${m.profileId}:${m.id}` : sourceValue(m.source, m.id);
function parseSourceValue(value) {
  const text = String(value || '');
  if (!text.startsWith(SRC)) return null;
  const rest = text.slice(SRC.length), at = rest.indexOf(':');
  if (at <= 0) return null;
  const source = rest.slice(0, at), tail = rest.slice(at + 1);
  if (source !== 'api') return { source, model: tail };
  const cut = tail.indexOf(':');
  return cut > 0 ? { source, profileId: tail.slice(0, cut), model: tail.slice(cut + 1) } : null;
}
function featureOptions(f, backends) {
  const out = featureOptionsRaw(f, backends);
  if (f.statsOnly) out.push({ value: STATS_ONLY, label: LABELS[STATS_ONLY], available: true, reason: '', setup: '', defaultModel: '', allowCustom: false, models: [] });
  return out;
}
function featureOptionsRaw(f, backends) {
  backends = backends.filter(b => !f.exclude?.includes(b.kind));
  const choiceValues = require('./codeagent-model-choice');
  const plain = (b, models) => ({ value: b.kind, label: b.label, available: !!b.available, reason: b.reason || '', setup: b.setup || '', allowCustom: !!b.allowCustom || (oneshot(f) && b.kind === 'codeagent' && !!b.available),
    defaultModel: b.defaultModel || '', models: models.map(m => ({ value: choiceValues.choiceValue(m), label: m.label || m.id, id: m.id, ...(m.unavailable ? { unavailable: true } : {}) })) });
  // 单次任务的 Claude / Codex 目录里同一模型会按思考档出现多次，按名字并成一项。CodeAgent 不并：同名模型在不同供应商（菜单分组）
  // 是不同线路，单次执行也能按供应商跑（feature-agent-run 的 --settings），和会话里的模型下拉同样列全、同样带供应商（R53）。
  const dedupe = (b, models) => oneshot(f) && b.kind !== 'codeagent' ? [...new Map(models.map(m => [m.id, { id: m.id, label: m.id, unavailable: m.unavailable }])).values()] : models;
  if (!companyEdition()) return backends.filter(b => f.kinds.includes(b.kind)).map(b => plain(b, dedupe(b, b.models || [])));
  const out = [];
  for (const b of backends) {
    if (b.kind === GATEWAY) continue; // 公司版里部门 key 就是「Claude Code · 部门 API key」，不单列
    if (!HARNESS.includes(b.kind)) { if (f.kinds.includes(b.kind)) out.push(plain(b, dedupe(b, b.models || []))); continue; }
    const sup = harnessSupport(f, b.kind);
    if (!sup.ok) { out.push({ value: b.kind, label: b.label, available: false, reason: sup.reason, models: [], defaultModel: '' }); continue; }
    const models = (b.models || []).filter(m => sup.sources.includes(m.source));
    const preferred = models.find(m => !m.unavailable && m.source === b.defaultSource && m.id === b.defaultModel && (m.source !== 'api' || m.profileId === b.defaultProfileId))
      || models.find(m => !m.unavailable);
    // 部门 key 可以手填模型（会话功能那条线以前就有）：只在部门 key 已配好时给。
    const gatewayReady = models.some(m => m.source === 'gateway' && !m.unavailable);
    out.push({ value: b.kind, label: b.label, available: !!b.available && !!preferred, reason: b.available && !preferred ? NO_SOURCE : b.reason || '',
      setup: b.setup || '', defaultModel: preferred ? preferred.label : '', allowCustom: !!sup.store && gatewayReady, ...(sup.store ? { store: sup.store } : {}),
      models: models.map(m => ({ value: sourceValueOf(m), id: m.id, source: m.source, ...(m.profileId ? { profileId: m.profileId } : {}), label: m.label, ...(m.unavailable ? { unavailable: true } : {}) })) });
  }
  return out;
}
// 存着的选择 → 下拉当前值（公司版里部门 key 显示为 Claude Code 外壳）。
function currentValues(f, choice) {
  if (!choice) return { backend: '', model: '' };
  if (companyEdition() && choice.kind === GATEWAY) return { backend: 'claude', model: choice.model ? sourceValue('gateway', choice.model) : '' };
  if (companyEdition() && HARNESS.includes(choice.kind)) return { backend: choice.kind, model: choice.source ? sourceValueOf({ ...choice, id: choice.model }) : choice.model || '' };
  return { backend: choice.kind, model: choice.model ? require('./codeagent-model-choice').choiceValue({ id: choice.model, provider: choice.codeagentModelProvider,
    providerLabel: choice.codeagentModelProviderLabel, menuLabel: choice.codeagentModelMenuLabel }) : '' };
}
// 下拉的值 → 要存的选择。backend 为空 = 恢复默认。外壳没选具体模型时用该外壳的首选可用模型（部门 key 优先）。
function choiceFromUi(dataDir, id, { backend = '', model = '' } = {}, options = {}) {
  const f = feature(id);
  if (!backend) return null;
  if (backend === STATS_ONLY) { if (!f.statsOnly) throw new Error('这个功能不支持只统计'); return { kind: STATS_ONLY, model: '' }; }
  if (!companyEdition() || !HARNESS.includes(backend)) {
    const c = require('./codeagent-model-choice').decodeChoice(model);
    return { kind: backend, model: c.id || '', ...require('./codeagent-model-choice').routeFields(c) };
  }
  const sup = harnessSupport(f, backend);
  if (!sup.ok) throw new Error(sup.reason);
  // 会话功能里部门 key 仍存成 api-gateway（和分身页、以前存下的同一种）；手填的模型名（不带来源）也算部门 key。
  const stored = c => sup.store === GATEWAY && c.source === 'gateway' ? { kind: GATEWAY, model: c.model } : c;
  const parsed = parseSourceValue(model);
  if (parsed) {
    if (!sup.sources.includes(parsed.source)) throw new Error('这个功能不支持所选模型来源');
    return stored({ kind: backend, ...parsed });
  }
  if (model && sup.store === GATEWAY) return { kind: GATEWAY, model: String(model) };
  const backends = options.backends || catalog(dataDir, options);
  const row = backends.find(b => b.kind === backend);
  const usable = (row?.models || []).filter(m => !m.unavailable && sup.sources.includes(m.source));
  const preferred = usable.find(m => m.source === row?.defaultSource && m.id === row?.defaultModel && (m.source !== 'api' || m.profileId === row?.defaultProfileId)) || usable[0];
  if (!preferred) throw new Error(row?.reason || NO_SOURCE);
  return stored({ kind: backend, source: preferred.source, model: preferred.id, ...(preferred.profileId ? { profileId: preferred.profileId } : {}) });
}
function setFromUi(dataDir, id, values, options = {}) {
  const backends = options.backends || catalog(dataDir, options);
  return set(dataDir, id, choiceFromUi(dataDir, id, values, { ...options, backends }), { ...options, backends });
}
function state(dataDir, options) {
  const backends = options?.backends || catalog(dataDir, options);
  const config = require('./hub-config').getConfig();
  let cliModel = '';
  try { cliModel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('./codeagent-config').resolveCodeAgentConfig().configDir, 'settings.json'), 'utf8')).model || ''; } catch { /* CLI 自选 */ }
  const assistant = routes.preference(dataDir), codeagentModel = assistant?.model || config.defaultModels?.codeagent || cliModel || 'CLI 当前模型';
  const defaultLabel = f => {
    // 没有可用 CodeAgent 时的自动默认：写出实际走的外壳、来源和模型。
    const auto = resolve(dataDir, f.id, { backends });
    if (auto.auto) {
      const a = auto.selected;
      // 来源打头（「部门 API key · …」「自有接口 · …」），和 R49 的写法一致：用户先看到用的是哪把 key / 哪个接口。
      if (a.kind === GATEWAY) return `${SOURCE_LABELS.gateway} · Claude Code · ${a.model || backends.find(b => b.kind === GATEWAY)?.defaultModel || '网关默认模型'}`;
      const m = (backends.find(b => b.kind === a.kind)?.models || []).find(x => sameModel(x, a));
      const name = m?.label ? m.label.split(' · ').slice(1).join(' · ') : a.model;
      return `${SOURCE_LABELS[a.source]} · ${HARNESS_LABELS[a.kind] || a.kind}${name ? ' · ' + name : ''}`;
    }
    if (['assistant', 'ppt', 'pptMake', 'pptImgtext', 'distill'].includes(f.id)) return `CodeAgent · ${codeagentModel}`;
    if (f.id === 'forum' || f.id === 'text') return `CodeAgent · ${config.defaultModels?.codeagent || cliModel || 'CLI 当前模型'}`;
    if (f.id === 'help') {
      const order = require('./help-ask/engine').preferredOrder({ preferred: config.helpAsk?.engine,
        edition: require('./distribution').featureEnabled('memberUpgrade') ? 'public' : 'member' });
      // 公司版外壳：CLI 在就算可用（默认链会先走部门 key / 公司模型，没有再沿用本机 CLI 配置，见 core/help-ask/engine.js）。
      const usable = b => b.available || (companyEdition() && b.harness && b.reason !== `本机没有 ${b.label}`);
      const kind = order.find(k => backends.some(b => b.kind === k && usable(b)));
      if (kind && companyEdition() && HARNESS.includes(kind)) {
        const row = backends.find(b => b.kind === kind);
        const pick = harnessDefault(dataDir, kind, { backends });
        return pick ? `${HARNESS_LABELS[kind]} · ${SOURCE_LABELS[pick.source]} · ${pick.model}` : `${HARNESS_LABELS[kind]} · 启动中心所选线路`;
      }
      const model = kind ? require('./help-ask/model-choice').defaultModel(dataDir, kind, { config }) : '';
      return kind ? `${LABELS[kind]} · ${model || 'CLI 当前模型'}` : '暂无可用 CLI';
    }
    // 进展卡摘要的默认是 Claude Haiku，公司版不调用外部 AI（company-ai-policy），默认等于不自动代写。
    if (f.id === 'progress' && companyEdition()) return '不自动代写 · 选一个后端即开启';
    return f.defaultText;
  };
  return { ok: true, company: companyEdition(), backends, features: FEATURES.map(f => {
    const r = resolve(dataDir, f.id, { backends }), options = featureOptions(f, backends);
    // 手填过的 CodeAgent 模型不在清单里：补成下拉里的一项，标明是手填的，而不是显示成「不可用」。
    const row = r.selected?.custom && options.find(o => o.value === r.selected.kind);
    if (row && !row.models.some(m => m.value === r.selected.model)) row.models.push({ value: r.selected.model, id: r.selected.model, label: `${r.selected.model}（手填）` });
    // 升级前单次任务按名字并项，存下的 CodeAgent 选择不带供应商（如 DeepSeek-V4.1-Flash-1017）；现在选项带供应商，
    // 当前值对不上会显示成「（不可用）」。对齐到同名的第一项（同名多个供应商时也取第一项，和 resolve() 命中的一致；R53 审查 P1）。
    // Choices saved before R53 carry no provider: show them as the first listed same-name option instead of 'unavailable'.
    const current = currentValues(f, r.choice), own = options.find(o => o.value === current.backend);
    if (r.selected && current.model && !r.selected.codeagentModelProvider && !r.selected.custom && own && !own.models.some(m => m.value === current.model)) {
      const same = own.models.find(m => !m.unavailable && m.id === current.model);
      if (same) current.model = same.value;
    }
    return { ...f, defaultText: defaultLabel(f), ...r, options, current };
  }) };
}
// 会话的功能选型是否仍继承助理设置（assistantChoice）的模型与供应商：没有功能选型，或只把后端选成 CodeAgent / Lite、
// 没单独指定模型和供应商（一键全切 Lite 写的就是这种）。选了别的后端或具体模型的，以功能选型为准。
function inheritsAssistantChoice(raw) {
  if (!raw) return true;
  try {
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (c?.kind === 'codeagent' || c?.kind === LITE) && !c.model && !c.codeagentModelProvider;
  } catch { return false; }
}
// 一键预设（设置 →「功能使用的 Agent」顶部）：
//   codeagent-lite —— 默认或选了 CodeAgent 的会话类功能改走 CodeAgent-Lite（保留原来选好的模型与供应商）；选了其他后端（如部门 API key）的不动；
//   reset-lite     —— 只把当前是 CodeAgent-Lite 的恢复默认，其他显式选型不动。
const PRESETS = ['codeagent-lite', 'reset-lite'];
function applyPreset(dataDir, preset, options = {}) {
  if (!PRESETS.includes(preset)) throw new Error('未知的一键预设');
  // 蒸馏自己是一次性的单次调用，没有常驻会话，切 Lite 省不了内存，不参与一键预设。
  const targets = FEATURES.filter(f => f.kinds.includes(LITE) && !f.noPreset);
  let backends = null;
  if (preset === 'codeagent-lite') {
    backends = options.backends || catalog(dataDir, options);
    const lite = backends.find(b => b.kind === LITE);
    if (!lite?.available) throw new Error('本机 CodeAgent-Lite 暂不可用（未检测到可用的 CodeAgent），未做任何修改');
  }
  const plan = [], changed = [], skipped = [];
  for (const f of targets) {
    const current = routes.featurePreference(dataDir, f.id);
    if (preset === 'codeagent-lite') {
      if (!current || current.kind === 'codeagent') {
        const { kind: _kind, ...rest } = current || {};
        void _kind;
        plan.push([f.id, current, { ...rest, kind: LITE, model: current?.model || '' }]);
        changed.push(f.id);
      } else if (current.kind !== LITE) skipped.push(f.id);
    } else if (current?.kind === LITE) { plan.push([f.id, current, null]); changed.push(f.id); }
  }
  const done = [];
  try {
    for (const [id, previous, next] of plan) { routes.setFeaturePreference(dataDir, id, next); done.push([id, previous]); }
  } catch (error) {
    // 写到一半失败：已改的逐项还原，不留半截状态。
    for (const [id, previous] of done.reverse()) { try { routes.setFeaturePreference(dataDir, id, previous); } catch { /* 尽力还原 */ } }
    throw error;
  }
  const stateOptions = backends ? { ...options, backends } : options;
  return { ok: true, preset, changed, skipped: preset === 'codeagent-lite' ? skipped : [], state: state(dataDir, stateOptions) };
}
// 手填 CodeAgent 模型（单次任务）：按真实执行路径试跑一句，通了才记下并选用；不通就地说清是「账号用不了这个模型 / 名字不对」还是别的原因。
// Hand-typed CodeAgent model for one-shot features: trial-run one line through the real runner, save only on success.
async function customCodeAgentModel(dataDir, id, model, { run = require('./feature-agent-run').run, backends, now = Date.now } = {}) {
  const f = feature(id), name = String(model || '').trim();
  if (!f || !oneshot(f)) return { ok: false, error: '这个功能不支持手填 CodeAgent 模型' };
  if (!require('./model-id').isSafeModelId(name)) return { ok: false, error: '模型名里有不支持的字符' };
  const rows = backends || catalog(dataDir);
  if (!rows.find(b => b.kind === 'codeagent')?.available) return { ok: false, error: '本机 CodeAgent 暂不可用' };
  const listed = rows.find(b => b.kind === 'codeagent').models.find(m => !m.unavailable && m.id.toLowerCase() === name.toLowerCase());
  const choice = listed ? { kind: 'codeagent', model: listed.id, ...require('./codeagent-model-choice').routeFields(listed) } : { kind: 'codeagent', model: name, custom: true };
  const started = now();
  try {
    await run(choice, '只回复 OK，不要别的内容。', { dataDir, timeoutMs: 90000 });
  } catch (error) {
    const said = require('./hub-feedback').redact(String(error?.message || error)).slice(0, 160);
    if (require('./help-ask/model-choice').modelUnavailable(error)) return { ok: false, code: 'model-unavailable', error: `CodeAgent 用不了「${name}」：这个账号没有这个模型，或名字写错了（CodeAgent 原话：${said}）` };
    return { ok: false, code: error?.timedOut ? 'timeout' : 'run-failed', error: error?.timedOut ? `试跑「${name}」超时，没等到回答；可稍后再试` : `试跑「${name}」没成功：${said}` };
  }
  set(dataDir, id, choice, { backends: rows });
  return { ok: true, model: choice.model, firstMs: now() - started, already: !!listed };
}
module.exports = { FEATURES, LABELS, GATEWAY, STATS_ONLY, HARNESS, HARNESS_SOURCES, SESSION_KINDS: SESSION, PRESETS, catalog, resolve, set, setFromUi, choiceFromUi, session, stale, state,
  assertSessionKind, applyPreset, inheritsAssistantChoice, setRuntime, ensureProxy, harnessInUse, harnessDefault, featureOptions, workKind, customCodeAgentModel };
