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
];
const LABELS = { codeagent: 'CodeAgent', [LITE]: 'CodeAgent-Lite（省内存）', claude: 'Claude', codex: 'Codex', 'deepseek-acp': 'DSH', qwen: 'Qwen Code', glm: 'ZCode', [GATEWAY]: '部门 API key（网关）' };
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
// 公司版（2026-11-26 修正）：Claude Code / Codex / DSH 只是外壳（harness），公司里没有 Claude、GPT 这类模型。
// 外壳背后的模型只从启动中心同一份来源里列：部门 API key（网关）的模型、公司模型（经本机反代用 CodeAgent 账号）。
// 枚举直接复用启动中心的模型卡函数（renderer/launch-model-cards.js cardsFor + core/company-api-config.js settings），不另写一套。
const HARNESS = ['claude', 'codex', 'deepseek-acp'];
const HARNESS_SOURCES = ['gateway', 'company'];
const SOURCE_LABELS = { gateway: '部门 API key', company: '公司模型（CodeAgent 账号）' };
const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' };
const companyEdition = () => { try { return require('./company-api-config').isCompany(); } catch { return false; } };
// 主进程注入：反代状态（模型卡状态点用）与「用前拉起反代」。没注入时（单测、旧调用方）状态按「选中后自动启动」显示。
let runtime = { proxyStatus: null, ensureProxy: null };
function setRuntime(next = {}) { runtime = { ...runtime, ...next }; }
// 默认链用（没给功能显式选过时）：只跟启动中心为这个工具存下的线路走——那里选的是部门 key / 公司模型，就经本机反代用它；
// 选的是自有接口或沿用本机 CLI 配置，返回 null，照旧用 CLI 自己的配置（Codex 审查 P2：不能凭存着 key 就盖掉原来能用的线路）。
function harnessDefault(dataDir, kind, options = {}) {
  if (!companyEdition() || !HARNESS.includes(kind)) return null;
  let provider = null;
  try { provider = require('./company-api-config').settings(require('./hub-config').readConfigJsonForUpdate())[kind]; } catch { provider = null; }
  if (provider?.backend !== 'proxy') return null;
  const source = provider.upstream === 'gateway' ? 'gateway' : 'company';
  const row = (options.backends || catalog(dataDir, options)).find(b => b.kind === kind);
  const usable = (row?.models || []).filter(m => !m.unavailable && m.source === source);
  const hit = usable.find(m => m.id === provider.model) || usable[0];
  return row?.available && hit ? { kind, source, model: hit.id } : null;
}
// 有功能选了「外壳 + 部门 key / 公司模型」时本机反代要常驻（main.js 反代 isEnabled），免得改完配置被收掉。
// PPT 库地图没选过、走自动默认的外壳 + 部门 key 时也算（R49-2 审查 P2-1：只装了 Codex、会话功能用不了网关时，反代不能被收掉）。
function harnessInUse(dataDir) {
  try {
    if (FEATURES.some(f => { const p = routes.featurePreference(dataDir, f.id); return HARNESS.includes(p?.kind) && HARNESS_SOURCES.includes(p?.source); })) return true;
    return !routes.featurePreference(dataDir, 'pptMap') && !!autoHarness(dataDir);
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
  // 只留后台功能真能用的两种来源；公司模型要本机有 CodeAgent（账号在它那里）。自有接口 / 自有 API 账号暂不进后台功能（见交付说明）。
  const models = cards.filter(c => c.source === 'gateway' || (c.source === 'company' && codeagentAvailable))
    .map(c => ({ id: c.model || c.id, label: `${SOURCE_LABELS[c.source]} · ${c.name || c.model || c.id}`, source: c.source,
      note: c.statusText || '', ...(c.state === 'error' || c.state === 'needs' ? { unavailable: true } : {}) }));
  const gatewayKey = !!provider?.gatewayModels;
  let cli = '';
  try {
    if (kind !== 'deepseek-acp') cli = findCommand(kind, env) || '';
    else { const entry = require('./hub-config').getConfig().acp?.providers?.[kind]; cli = entry?.entryPath && require('node:fs').existsSync(entry.entryPath) ? entry.entryPath : ''; }
  } catch { cli = ''; }
  const usable = models.filter(m => !m.unavailable);
  const reason = !cli ? `本机没有 ${HARNESS_LABELS[kind]}` : !usable.length
    ? (gatewayKey ? '部门 API key 和公司模型暂时都用不了' : '需要先保存部门 API key（或装好 CodeAgent 用公司模型）') : '';
  const preferred = usable.find(m => m.source === 'gateway') || usable[0];
  return { kind, label: HARNESS_LABELS[kind], harness: true, available: !!cli && usable.length > 0, reason,
    setup: !gatewayKey ? 'gateway' : '', defaultModel: preferred ? preferred.id : '', defaultSource: preferred ? preferred.source : '', models };
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
    // 开箱即用（R49-2，11-26 从助理扩到全部）：没选过、本机没有可用的 CodeAgent（没装或没有模型权限）、部门 key 已配好时，
    // 8 项会话功能默认走部门 key，PPT 库地图默认用 Claude Code / Codex 外壳经部门 key；有 CodeAgent 的保持原默认。
    if (f.kinds.includes(GATEWAY) && gatewayRoute().autoDefault(dataDir, { backends: options.backends }))
      return { choice: null, selected: { kind: GATEWAY, model: '' }, warning: '', auto: true };
    const harness = id === 'pptMap' ? autoHarness(dataDir, options) : null;
    if (harness) return { choice: null, selected: harness, warning: '', auto: true };
    return { choice: null, selected: null, warning: '' };
  }
  // 旧版存下的外壳选择（没有模型来源，模型是 claude-opus / gpt 这类公司里用不了的）：不再照跑，提示重选，本次沿用默认。
  if (companyEdition() && HARNESS.includes(choice.kind) && !HARNESS_SOURCES.includes(choice.source)) return { choice, selected: null, legacy: true, warning: legacyWarning(choice) };
  if (!f.kinds.includes(choice.kind)) return { choice, selected: null, warning: '此功能尚不支持该后端的受控只读执行，本次沿用默认。' };
  const backends = options.backends || catalog(dataDir);
  const backend = backends.find(b => b.kind === choice.kind && b.available && f.kinds.includes(b.kind));
  const hit = backend?.models.find(m => !m.unavailable && m.id === choice.model && (!choice.source || m.source === choice.source) && (!choice.codeagentModelProvider || (m.provider || m.codeagentModelProvider) === choice.codeagentModelProvider));
  if (!backend || (choice.model && !hit)) return { choice, selected: null, warning: '所选后端或模型当前不可用，本次沿用默认。' };
  return { choice, selected: choice, warning: '' };
}
// 单次功能（PPT 库地图）的自动默认：公司版、部门 key 已存、没有可用的 CodeAgent 时，用本机能用的外壳（Claude Code 优先，其次 Codex）
// 经本机反代走部门 key，模型取网关默认模型。先做两步便宜的判断（读 key 文件、查 codeagent 命令），过了才读完整目录。
function autoHarness(dataDir, options = {}) {
  if (!companyEdition()) return null;
  try { if (!require('./api-gateway').read(dataDir).keySet) return null; } catch { return null; }
  const backends = options.backends;
  if (!gatewayRoute().codeagentMissing(dataDir, { ...options, backends })) return null;
  const rows = backends || catalog(dataDir, options);
  for (const kind of ['claude', 'codex']) {
    const row = rows.find(b => b.kind === kind && b.harness && b.available);
    const models = (row?.models || []).filter(m => m.source === 'gateway' && !m.unavailable);
    const hit = models.find(m => m.id === row?.defaultModel) || models[0];
    if (hit) return { kind, model: hit.id, source: 'gateway' };
  }
  return null;
}
function legacyWarning(choice) {
  const what = `${HARNESS_LABELS[choice.kind] || choice.kind}${choice.model ? ' · ' + choice.model : ' · 本机默认模型'}`;
  return `之前选的「${what}」在公司里用不了：${HARNESS_LABELS[choice.kind] || choice.kind} 在公司版只当外壳，模型要用部门 API key 或公司模型。本次沿用默认，请重新选择。`;
}
function set(dataDir, id, choice, options) {
  const f = feature(id);
  if (choice) {
    if (!f.kinds.includes(choice.kind) || (choice.model && !require('./model-id').isSafeModelId(choice.model))) throw new Error('请选择可用的后端和模型');
    const harness = companyEdition() && HARNESS.includes(choice.kind);
    if (harness && !HARNESS_SOURCES.includes(choice.source)) throw new Error('请选择部门 API key 或公司模型');
    const normalized = { kind: choice.kind, model: choice.model || '', ...(harness ? { source: choice.source } : {}), ...require('./codeagent-model-choice').routeFields(choice) };
    const backends = options?.backends || catalog(dataDir);
    const b = backends.find(b => b.kind === normalized.kind && b.available);
    if (normalized.kind === GATEWAY && !b) throw new Error(backends.find(r => r.kind === GATEWAY)?.reason || '部门 API key 暂时用不了');
    if (harness && !b) throw new Error(backends.find(r => r.kind === normalized.kind)?.reason || '所选外壳暂时用不了');
    if (harness && !normalized.model) throw new Error('请选择模型');
    if (!b || (normalized.model && !b.models.some(m => m.id === normalized.model && !m.unavailable && (!normalized.source || m.source === normalized.source) && (!normalized.codeagentModelProvider || m.provider === normalized.codeagentModelProvider)))) throw new Error('所选后端或模型当前不可用，请恢复默认');
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
  const out = { ...opts, featureAgent: id, featureAgentChoice: JSON.stringify(selected), ...require('./codeagent-model-choice').routeFields(selected) };
  const codeagentFamily = selected.kind === 'codeagent' || selected.kind === LITE;
  // 不把 CodeAgent 专用账号、模型字段带进其他后端。
  if (!codeagentFamily) for (const k of Object.keys(out)) if (/^codeagent/i.test(k)) delete out[k];
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
  if (kind === 'deepseek-acp') return { ok: false, reason: 'DSH 暂不能跑后台功能，可在启动中心用 DSH 开会话' };
  if (oneshot(f)) return { ok: true, sources: HARNESS_SOURCES };
  if (kind === 'claude') return { ok: true, sources: ['gateway'], store: GATEWAY };
  return { ok: false, reason: '这个功能要受控工具，目前只支持 CodeAgent 和 Claude Code' };
}
const SRC = 'src:';
const sourceValue = (source, id) => `${SRC}${source}:${id}`;
function parseSourceValue(value) {
  const text = String(value || '');
  if (!text.startsWith(SRC)) return null;
  const rest = text.slice(SRC.length), at = rest.indexOf(':');
  return at > 0 ? { source: rest.slice(0, at), model: rest.slice(at + 1) } : null;
}
function featureOptions(f, backends) {
  const choiceValues = require('./codeagent-model-choice');
  const plain = (b, models) => ({ value: b.kind, label: b.label, available: !!b.available, reason: b.reason || '', setup: b.setup || '', allowCustom: !!b.allowCustom,
    defaultModel: b.defaultModel || '', models: models.map(m => ({ value: choiceValues.choiceValue(m), label: m.label || m.id, id: m.id, ...(m.unavailable ? { unavailable: true } : {}) })) });
  const dedupe = models => oneshot(f) ? [...new Map(models.map(m => [m.id, { id: m.id, label: m.id, unavailable: m.unavailable }])).values()] : models;
  if (!companyEdition()) return backends.filter(b => f.kinds.includes(b.kind)).map(b => plain(b, dedupe(b.models || [])));
  const out = [];
  for (const b of backends) {
    if (b.kind === GATEWAY) continue; // 公司版里部门 key 就是「Claude Code · 部门 API key」，不单列
    if (!HARNESS.includes(b.kind)) { if (f.kinds.includes(b.kind)) out.push(plain(b, dedupe(b.models || []))); continue; }
    const sup = harnessSupport(f, b.kind);
    if (!sup.ok) { out.push({ value: b.kind, label: b.label, available: false, reason: sup.reason, models: [], defaultModel: '' }); continue; }
    if (sup.store === GATEWAY) {
      const gw = backends.find(r => r.kind === GATEWAY) || { available: false, reason: '还没保存部门 API key', models: [] };
      const cli = b.available || b.reason !== `本机没有 ${b.label}`;
      const reason = !cli ? b.reason : gw.available ? '' : (gw.reason === '还没保存部门 API key' ? '需要先保存部门 API key' : gw.reason);
      out.push({ value: b.kind, label: b.label, available: !!gw.available, reason, setup: /部门 API key/.test(reason) && cli ? 'gateway' : '', allowCustom: !!gw.available,
        defaultModel: gw.defaultModel ? `${SOURCE_LABELS.gateway} · ${gw.defaultModel}` : '', store: GATEWAY,
        models: (gw.models || []).map(m => ({ value: m.id, id: m.id, label: `${SOURCE_LABELS.gateway} · ${m.label || m.id}`, ...(m.unavailable ? { unavailable: true } : {}) })) });
      continue;
    }
    const models = (b.models || []).filter(m => sup.sources.includes(m.source));
    const preferred = models.find(m => !m.unavailable && m.source === 'gateway') || models.find(m => !m.unavailable);
    out.push({ value: b.kind, label: b.label, available: !!b.available && !!preferred, reason: b.available && !preferred ? '需要先保存部门 API key（或装好 CodeAgent 用公司模型）' : b.reason || '',
      setup: b.setup || '', defaultModel: preferred ? preferred.label : '',
      models: models.map(m => ({ value: sourceValue(m.source, m.id), id: m.id, source: m.source, label: m.label, ...(m.unavailable ? { unavailable: true } : {}) })) });
  }
  return out;
}
// 存着的选择 → 下拉当前值（公司版里部门 key 显示为 Claude Code 外壳）。
function currentValues(f, choice) {
  if (!choice) return { backend: '', model: '' };
  if (companyEdition() && choice.kind === GATEWAY) return { backend: 'claude', model: choice.model || '' };
  if (companyEdition() && HARNESS.includes(choice.kind)) return { backend: choice.kind, model: choice.source ? sourceValue(choice.source, choice.model) : choice.model || '' };
  return { backend: choice.kind, model: choice.model ? require('./codeagent-model-choice').choiceValue({ id: choice.model, provider: choice.codeagentModelProvider,
    providerLabel: choice.codeagentModelProviderLabel, menuLabel: choice.codeagentModelMenuLabel }) : '' };
}
// 下拉的值 → 要存的选择。backend 为空 = 恢复默认。外壳没选具体模型时用该外壳的首选可用模型（部门 key 优先）。
function choiceFromUi(dataDir, id, { backend = '', model = '' } = {}, options = {}) {
  const f = feature(id);
  if (!backend) return null;
  if (!companyEdition() || !HARNESS.includes(backend)) {
    const c = require('./codeagent-model-choice').decodeChoice(model);
    return { kind: backend, model: c.id || '', ...require('./codeagent-model-choice').routeFields(c) };
  }
  const sup = harnessSupport(f, backend);
  if (!sup.ok) throw new Error(sup.reason);
  if (sup.store === GATEWAY) return { kind: GATEWAY, model: String(model || '') };
  const parsed = parseSourceValue(model);
  if (parsed) {
    if (!sup.sources.includes(parsed.source)) throw new Error('这个功能不支持所选模型来源');
    return { kind: backend, source: parsed.source, model: parsed.model };
  }
  const backends = options.backends || catalog(dataDir);
  const row = backends.find(b => b.kind === backend);
  const preferred = (row?.models || []).find(m => !m.unavailable && m.source === 'gateway' && sup.sources.includes(m.source))
    || (row?.models || []).find(m => !m.unavailable && sup.sources.includes(m.source));
  if (!preferred) throw new Error(row?.reason || '需要先保存部门 API key（或装好 CodeAgent 用公司模型）');
  return { kind: backend, source: preferred.source, model: preferred.id };
}
function setFromUi(dataDir, id, values, options = {}) {
  const backends = options.backends || catalog(dataDir);
  return set(dataDir, id, choiceFromUi(dataDir, id, values, { ...options, backends }), { ...options, backends });
}
function state(dataDir, options) {
  const backends = options?.backends || catalog(dataDir);
  const config = require('./hub-config').getConfig();
  let cliModel = '';
  try { cliModel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('./codeagent-config').resolveCodeAgentConfig().configDir, 'settings.json'), 'utf8')).model || ''; } catch { /* CLI 自选 */ }
  const assistant = routes.preference(dataDir), codeagentModel = assistant?.model || config.defaultModels?.codeagent || cliModel || 'CLI 当前模型';
  const defaultLabel = f => {
    // 没有可用 CodeAgent 时的自动默认（R49-2）：会话功能写部门 key 和网关默认模型，PPT 库地图写所用外壳。
    const auto = resolve(dataDir, f.id, { backends });
    if (auto.auto && auto.selected?.kind === GATEWAY) return `${LABELS[GATEWAY]} · ${backends.find(b => b.kind === GATEWAY)?.defaultModel || '网关默认模型'}`;
    if (auto.auto && auto.selected) return `${SOURCE_LABELS.gateway} · ${HARNESS_LABELS[auto.selected.kind]} · ${auto.selected.model}`;
    if (['assistant', 'ppt', 'pptMake', 'pptImgtext'].includes(f.id)) return `CodeAgent · ${codeagentModel}`;
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
    const r = resolve(dataDir, f.id, { backends });
    return { ...f, defaultText: defaultLabel(f), ...r, options: featureOptions(f, backends), current: currentValues(f, r.choice) };
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
  const targets = FEATURES.filter(f => f.kinds.includes(LITE));
  let backends = null;
  if (preset === 'codeagent-lite') {
    backends = options.backends || catalog(dataDir);
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
module.exports = { FEATURES, LABELS, GATEWAY, HARNESS, HARNESS_SOURCES, SESSION_KINDS: SESSION, PRESETS, catalog, resolve, set, setFromUi, choiceFromUi, session, stale, state,
  assertSessionKind, applyPreset, inheritsAssistantChoice, setRuntime, ensureProxy, harnessInUse, harnessDefault, featureOptions };
