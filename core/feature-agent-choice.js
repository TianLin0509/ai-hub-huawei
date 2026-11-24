'use strict';
// 后台功能共用选型；无显式选择时完全走原调用，不改 CLI 和启动中心默认值。
const routes = require('./codeagent-assistant-route');
const ONESHOT = ['codeagent', 'claude', 'codex'];
// 会话功能依赖任务文件和受控 MCP。其他 CLI 尚无等价的工具边界，不提供会话选项。
// CodeAgent-Lite：同一个 CodeAgent（账号、模型、MCP 全同），只是固定走多会话共用的 serve 后台进程，省内存。
const SESSION = ['codeagent', 'codeagent-lite'];
const LITE = 'codeagent-lite';
// 部门 API key（网关）：8 项会话功能都可显式选（2026-11-24）；会话由 Claude Code 经本机反代的网关上游作答（core/assistant-gateway-route.js）。
// 没选过时自动改走网关只对助理生效，其余 7 项默认仍是 CodeAgent。
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
function catalog(dataDir, { env = process.env, findCommand = require('./community-setup').findCommand } = {}) {
  const models = require('./model-options');
  const config = require('./hub-config').getConfig();
  const codexHome = env.CODEX_HOME || require('./codex-usage-scope').resolveCodexUsageScope(config, { hubDataDir: dataDir }).home;
  const rows = ALL_BACKENDS.filter(kind => kind !== LITE).map(kind => {
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
    // 开箱即用：助理没选过、本机没有 CodeAgent、部门 key 已配好时默认走部门 key；有 CodeAgent 的保持原默认。
    if (id === 'assistant' && gatewayRoute().autoDefault(dataDir, { backends: options.backends }))
      return { choice: null, selected: { kind: GATEWAY, model: '' }, warning: '', auto: true };
    return { choice: null, selected: null, warning: '' };
  }
  if (!f.kinds.includes(choice.kind)) return { choice, selected: null, warning: '此功能尚不支持该后端的受控只读执行，本次沿用默认。' };
  const backends = options.backends || catalog(dataDir);
  const backend = backends.find(b => b.kind === choice.kind && b.available && f.kinds.includes(b.kind));
  const hit = backend?.models.find(m => !m.unavailable && m.id === choice.model && (!choice.codeagentModelProvider || (m.provider || m.codeagentModelProvider) === choice.codeagentModelProvider));
  if (!backend || (choice.model && !hit)) return { choice, selected: null, warning: '所选后端或模型当前不可用，本次沿用默认。' };
  return { choice, selected: choice, warning: '' };
}
function set(dataDir, id, choice, options) {
  const f = feature(id);
  if (choice) {
    if (!f.kinds.includes(choice.kind) || (choice.model && !require('./model-id').isSafeModelId(choice.model))) throw new Error('请选择可用的后端和模型');
    const normalized = { kind: choice.kind, model: choice.model || '', ...require('./codeagent-model-choice').routeFields(choice) };
    const backends = options?.backends || catalog(dataDir);
    const b = backends.find(b => b.kind === normalized.kind && b.available);
    if (normalized.kind === GATEWAY && !b) throw new Error(backends.find(r => r.kind === GATEWAY)?.reason || '部门 API key 暂时用不了');
    if (!b || (normalized.model && !b.models.some(m => m.id === normalized.model && !m.unavailable && (!normalized.codeagentModelProvider || m.provider === normalized.codeagentModelProvider)))) throw new Error('所选后端或模型当前不可用，请恢复默认');
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
function state(dataDir, options) {
  const backends = options?.backends || catalog(dataDir);
  const config = require('./hub-config').getConfig();
  let cliModel = '';
  try { cliModel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('./codeagent-config').resolveCodeAgentConfig().configDir, 'settings.json'), 'utf8')).model || ''; } catch { /* CLI 自选 */ }
  const assistant = routes.preference(dataDir), codeagentModel = assistant?.model || config.defaultModels?.codeagent || cliModel || 'CLI 当前模型';
  const defaultLabel = f => {
    if (f.id === 'assistant' && resolve(dataDir, f.id, { backends }).auto) {
      return `${LABELS[GATEWAY]} · ${backends.find(b => b.kind === GATEWAY)?.defaultModel || '网关默认模型'}`;
    }
    if (['assistant', 'ppt', 'pptMake', 'pptImgtext'].includes(f.id)) return `CodeAgent · ${codeagentModel}`;
    if (f.id === 'forum' || f.id === 'text') return `CodeAgent · ${config.defaultModels?.codeagent || cliModel || 'CLI 当前模型'}`;
    if (f.id === 'help') {
      const order = require('./help-ask/engine').preferredOrder({ preferred: config.helpAsk?.engine,
        edition: require('./distribution').featureEnabled('memberUpgrade') ? 'public' : 'member' });
      const kind = order.find(k => backends.some(b => b.kind === k && b.available));
      const model = kind ? require('./help-ask/model-choice').defaultModel(dataDir, kind, { config }) : '';
      return kind ? `${LABELS[kind]} · ${model || 'CLI 当前模型'}` : '暂无可用 CLI';
    }
    return f.defaultText;
  };
  return { ok: true, backends, features: FEATURES.map(f => ({ ...f, defaultText: defaultLabel(f), ...resolve(dataDir, f.id, { backends }) })) };
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
module.exports = { FEATURES, LABELS, GATEWAY, SESSION_KINDS: SESSION, PRESETS, catalog, resolve, set, session, stale, state, assertSessionKind, applyPreset, inheritsAssistantChoice };
