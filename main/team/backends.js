'use strict';
// 公司版组队里 CodeAgent 以外的成员后端（R58b）：每个后端装没装好、线路配没配好、能选哪些模型、走不走公司线路。
// Non-CodeAgent team backends for the company edition: installed, route configured, model choices, company route or not.
// 只读本机已有的检测结论和设置：不联网、不试跑 CLI、不改设置。Read-only: no network, no CLI trial run, no settings change.
const LABELS = Object.freeze({ codeagent: 'CodeAgent', claude: 'Claude Code', codex: 'Codex', 'deepseek-acp': 'DSH' });
// 组队可招的后端（负责人仍只能是 CodeAgent）。DSH 成员靠启动时注入的组队身份交回执（core/acp-profiles.js hubTeamEnv）。
// Kinds a team member may use; the lead stays CodeAgent. DSH members get their team identity at launch.
const TEAM_MEMBER_KINDS = Object.freeze(['claude', 'codex', 'deepseek-acp']);
const LOCATOR_IDS = Object.freeze({ claude: 'claude', codex: 'codex', 'deepseek-acp': 'dsh' });
// 各后端在组队里的用途，写进 accounts 给负责人看。What each backend is good for in a team.
const USES = Object.freeze({
  codeagent: '默认主力：实现、改代码、用公司内网工具和号池额度',
  claude: '异构审查、方案复核、长文档归纳；换一家模型看同一份代码',
  codex: '异构审查、代码复核与补测试',
  'deepseek-acp': '异构审查与推理复核',
});
// 名字的几种常见写法。Common spellings of a kind.
const ALIASES = Object.freeze({ 'claude-code': 'claude', claudecode: 'claude', dsh: 'deepseek-acp' });
const resolveKind = value => { const k = String(value || '').trim().toLowerCase(); return ALIASES[k] || k; };

function routeOf(kind, config = {}) {
  if (kind === 'deepseek-acp') return { backend: config.dshBackend || 'local', upstream: config.dshUpstream || '', model: config.dshApiModel || '' };
  return { backend: config[kind + 'Backend'] || 'local', upstream: config[kind + 'Upstream'] || '', model: config[kind + 'ApiModel'] || '' };
}
function routeLabel(route) {
  if (route.backend === 'proxy') return route.upstream === 'gateway' ? 'API 网关（部门 key，经本机反代）' : '公司模型（CodeAgent 账号，经本机反代）';
  if (route.backend === 'api') return '自有接口（用户自己的 API）';
  return '本机 CLI 自带配置';
}

function installState(kind, locator, dshDiagnose) {
  const id = LOCATOR_IDS[kind];
  let seen = null;
  try { seen = locator.peek(id); } catch { seen = null; }
  if (seen) return seen.verdict === 'ok' ? { installed: true } : { installed: false, reason: seen.reason || `${LABELS[kind]} 不能用` };
  // 定位中心这次启动还没检测过：按同步查找结果判断，不试跑。Not checked yet this run: quick lookup only.
  let launch = null;
  try { launch = locator.launchSpec(id); } catch { launch = null; }
  // DSH 还要终端界面包（TUI）配套：同步查一次运行环境，缺核心或缺 TUI 都算没装好（定位中心首轮探测前也不误报就绪）。
  if (kind === 'deepseek-acp' && launch && !launch.pending) {
    let diagnosis = null;
    try { diagnosis = dshDiagnose(); } catch { diagnosis = null; }
    if (!diagnosis?.runtime) {
      let reason = '';
      try { reason = require('../../core/dsh-cli-profile').describeRuntimeIssue(diagnosis || {}); } catch { reason = ''; }
      return { installed: false, reason: reason || 'DSH 运行环境不完整（缺核心或终端界面包），可在启动中心一键补齐' };
    }
  }
  return launch && !launch.pending ? { installed: true, unverified: true }
    : { installed: false, reason: `本机没找到 ${LABELS[kind]}，可在启动中心一键安装` };
}

function modelsOf(kind, route, { dataDir, proxy, apiConfig, readRaw }) {
  try {
    if (route.backend === 'proxy') return route.upstream === 'gateway' ? proxy.gatewayModelIds(dataDir) : proxy.companyModelIds(dataDir);
    if (route.backend === 'api') {
      const own = apiConfig.ownSource(readRaw(), kind);
      return [...new Set([own.model, ...(own.models || []), route.model].filter(Boolean))];
    }
  } catch { /* 读不到模型表就当没有可选项 */ }
  return [];
}

// kinds 默认 TEAM_MEMBER_KINDS；deps 可注入（单测）。Returns one row per backend.
function listTeamBackends({ config = {}, dataDir = '', kinds = TEAM_MEMBER_KINDS, deps = {} } = {}) {
  const locator = deps.locator || require('../../core/harness-locator');
  const proxy = deps.proxy || require('../../core/company-model-proxy');
  const apiConfig = deps.apiConfig || require('../../core/company-api-config');
  const readRaw = deps.readRaw || (() => require('../../core/hub-config').readConfigJsonForUpdate());
  const kindAllowed = deps.kindAllowed || (kind => require('../../core/company-ai-policy').groupKindAllowed(kind));
  const dshDiagnose = deps.dshDiagnose || (() => require('../../core/dsh-cli-profile').diagnoseDshRuntime(config.acp?.providers?.['deepseek-acp'] || {}));
  return kinds.filter(kindAllowed).map(kind => {
    const route = routeOf(kind, config);
    const install = installState(kind, locator, dshDiagnose);
    let configured = true, configReason = '';
    try { apiConfig.assertLaunchConfigured(kind, config, {}); } catch (error) { configured = false; configReason = String(error?.message || error); }
    const models = modelsOf(kind, route, { dataDir, proxy, apiConfig, readRaw });
    const ready = install.installed && configured;
    // 公司线路（公司模型或 API 网关）不花用户自己的钱，只有它才进混编推荐。Only company routes are recommended.
    const companyRoute = route.backend === 'proxy';
    return {
      kind, label: LABELS[kind], use: USES[kind], installed: install.installed, ...(install.unverified ? { installUnverified: true } : {}),
      route: route.backend, ...(route.upstream ? { upstream: route.upstream } : {}), routeLabel: routeLabel(route), companyRoute,
      ready, models, defaultModel: route.model || (companyRoute && models[0]) || '',
      unavailableReason: !install.installed ? install.reason : !configured ? configReason : '',
    };
  });
}

// 混编配方（方案二）：按本机已就绪、走公司线路的后端给建议。建议，不强制。
// Mix recipe: built from ready backends on a company route; advisory only.
const MIX_PREFERENCE = Object.freeze(['deepseek-acp', 'claude', 'codex']);
function recommendedMix(backends = []) {
  const usable = MIX_PREFERENCE.map(kind => backends.find(b => b.kind === kind && b.ready && b.companyRoute)).filter(Boolean);
  if (!usable.length) {
    return { heterogeneous: [], slots: [{ slot: '全部', kind: 'codeagent' }],
      note: '本机没有走公司线路且已就绪的其他后端，全队用 CodeAgent 即可；不要招 backends 里 ready=false 的后端。' };
  }
  const first = usable[0];
  return {
    heterogeneous: usable.map(b => b.kind),
    slots: [
      { slot: '实现', kind: 'codeagent', why: USES.codeagent },
      { slot: '审查/复核', kind: first.kind, why: `换后端独立审查，减少同源盲点；${first.label} 走${first.routeLabel}` },
      { slot: '调研（2 人时）', kinds: ['codeagent', first.kind], why: '两位调研用两个不同后端，结论互相印证' },
    ],
    minNonCodeAgent: 1,
    note: `2 人以上的队建议至少 1 名非 CodeAgent 成员（建议，不强制），优先 ${usable.map(b => `${b.label}（kind=${b.kind}）`).join('、')}。`
      + '用户点名的后端优先；没有理由不偏离配方，偏离时在该成员的 task 里写一句理由。',
  };
}

module.exports = { LABELS, TEAM_MEMBER_KINDS, USES, resolveKind, routeLabel, listTeamBackends, recommendedMix, MIX_PREFERENCE };
