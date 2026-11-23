'use strict';
// 后台功能共用选型；无显式选择时完全走原调用，不改 CLI 和启动中心默认值。
const routes = require('./codeagent-assistant-route');
const ONESHOT = ['codeagent', 'claude', 'codex'];
// 会话功能依赖任务文件和受控 MCP。其他 CLI 尚无等价的工具边界，不提供会话选项。
const SESSION = ['codeagent'];
const ALL_BACKENDS = [...ONESHOT, 'deepseek-acp', 'qwen', 'glm'];
const FEATURES = [
  { id: 'help', label: '问问 Hub', kinds: ONESHOT, defaultText: '按发行版自动选用可用 CLI' },
  { id: 'pptMap', label: 'PPT 库地图', kinds: ONESHOT, defaultText: 'CodeAgent · DeepSeek Flash → GLM Auto' },
  { id: 'ppt', label: 'PPT 找页', kinds: SESSION, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'pptMake', label: 'PPT 做页', kinds: SESSION, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'pptImgtext', label: 'PPT 图转字', kinds: SESSION, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'assistant', label: '助理（电脑 / 手机 / 简报）', kinds: SESSION, defaultText: 'CodeAgent · 助理模型与供应商' },
  { id: 'avatar', label: '分身', kinds: SESSION, defaultText: 'CodeAgent · 分身指定或助理模型' },
  { id: 'forum', label: '论坛热帖汇总', kinds: SESSION, defaultText: 'CodeAgent · 启动默认模型' },
  { id: 'progress', label: '进展卡自动摘要', kinds: ONESHOT, defaultText: 'Claude · Haiku' },
  { id: 'meeting', label: '会议理解 / 问答', kinds: SESSION, defaultText: '会议中所选引擎' },
  { id: 'text', label: '草稿整理 / 团队文字任务', kinds: SESSION, defaultText: 'CodeAgent · 启动默认模型' },
];
const LABELS = { codeagent: 'CodeAgent', claude: 'Claude', codex: 'Codex', 'deepseek-acp': 'DSH', qwen: 'Qwen Code', glm: 'ZCode' };
function feature(id) { const row = FEATURES.find(f => f.id === id); if (!row) throw new Error('未知功能'); return row; }
function catalog(dataDir, { env = process.env, findCommand = require('./community-setup').findCommand } = {}) {
  const models = require('./model-options');
  const config = require('./hub-config').getConfig();
  const codexHome = env.CODEX_HOME || require('./codex-usage-scope').resolveCodexUsageScope(config, { hubDataDir: dataDir }).home;
  return ALL_BACKENDS.map(kind => {
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
}
function resolve(dataDir, id, options = {}) {
  const f = feature(id), choice = routes.featurePreference(dataDir, id);
  if (!choice) return { choice: null, selected: null, warning: '' };
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
    if (!b || (normalized.model && !b.models.some(m => m.id === normalized.model && !m.unavailable && (!normalized.codeagentModelProvider || m.provider === normalized.codeagentModelProvider)))) throw new Error('所选后端或模型当前不可用，请恢复默认');
    routes.setFeaturePreference(dataDir, id, normalized);
  } else routes.setFeaturePreference(dataDir, id, null);
  return resolve(dataDir, id, options);
}
function session(dataDir, id, kind, opts, options) {
  const r = resolve(dataDir, id, options), selected = r.selected;
  if (!selected) return { kind, opts, warning: r.warning };
  const out = { ...opts, featureAgent: id, featureAgentChoice: JSON.stringify(selected), ...require('./codeagent-model-choice').routeFields(selected) };
  // 不把 CodeAgent 专用账号、模型字段带进其他后端。
  if (selected.kind !== 'codeagent') for (const k of Object.keys(out)) if (/^codeagent/i.test(k)) delete out[k];
  if (selected.model) { out.model = selected.model; out.fixedModel = selected.model; if (selected.kind === 'codeagent') out.codeagentRouteModel = selected.model; }
  return { kind: selected.kind, opts: out, warning: '' };
}
function assertSessionKind(kind, opts = {}) {
  if (opts.featureAgent && ['company-assistant', 'company-forum', 'company-ai', 'avatar-agent'].includes(opts.purpose)
    && !/^codeagent(?:-resume)?$/.test(kind)) throw Object.assign(new Error('此功能尚不支持该后端的受控只读执行，请恢复默认'), { code: 'FEATURE_AGENT_UNSAFE_BACKEND', notSent: true });
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
module.exports = { FEATURES, LABELS, catalog, resolve, set, session, stale, state, assertSessionKind };
