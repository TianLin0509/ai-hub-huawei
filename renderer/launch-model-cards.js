'use strict';

// 公司版启动中心的「模型卡」（2026-11-06）：选 Claude Code / Codex / DSH 后，下面一排卡片直接选模型——
// 两个公司模型（经本机反代，用 CodeAgent 账号）和这个工具自己的来源（自有接口 / CLI 默认）。
// 每张卡写模型名、来源和状态点；公司模型没就绪时用人话写原因。纯函数，workspace-controller.js 负责接线。
// 选中的卡在新建会话时写回「自有 API」里该工具的设置（core/company-api-config.js withSettings 的 proxy / own），
// 所以下次打开默认就是上次选的。

const COMPANY_KINDS = new Set(['claude', 'codex', 'deepseek-acp']);

function shortReason(status) {
  const code = String(status?.code || '');
  if (code === 'INITIALIZING') return { state: 'busy', text: '公司模型准备中' };
  if (code === 'ZONE_UNKNOWN') return { state: 'needs', text: '需要选择区域' };
  if (/^SIGNER_INIT/.test(code)) return { state: 'needs', text: '首次签名初始化未完成' };
  if (code === 'PROFILE_INCOMPLETE') return { state: 'needs', text: '公司上游信息不全' };
  return { state: 'needs', text: '公司上游还没准备好' };
}

// 反代状态 → 卡片状态点：ready 可用 / busy 准备中 / needs 要你处理 / error 出错 / idle 还没启动（选中后自动启动）。
function proxyBadge(status, model = '') {
  const s = status || {};
  if (s.shared) {
    if (s.state !== 'running') return { state: 'needs', text: '共享主机暂不可用', tip: s.message || '请在号池内网共享中检查主机连接。' };
    const base = v => String(v || '').toLowerCase().replace(/-auto$/, '');
    const available = (s.accounts || []).filter(a => !a.paused && !a.coolingUntil
      && (!model || a.modelsAuthoritative !== true || (a.models || []).some(m => base(m) === base(model))));
    return available.length ? { state: 'ready', text: `共享可用 · ${available.length} 个号`, tip: '经团队共享主机自动选号，额度由所有同事共同使用；逐号读数见右侧栏。' }
      : { state: 'needs', text: '共享号池暂不可用', tip: '请联系主机管理员检查账号登录、暂停状态和模型权限。' };
  }
  if (!status || s.state === 'stopped' || s.state === 'draining') {
    return { state: 'idle', text: '选中后自动启动', tip: '公司模型反代现在没在运行；用公司模型新建会话时，Hub 会在后台启动它（几秒）。' };
  }
  if (s.state === 'starting') return { state: 'busy', text: '公司模型准备中', tip: s.message || '公司模型反代正在启动…' };
  if (s.state === 'failed') return { state: 'error', text: '反代没能启动', tip: s.message || '公司模型反代没能启动，详情见设置 › 自有 API。' };
  if (s.state === 'not-ready') return { ...shortReason(s), tip: s.message || '' };
  const accounts = Array.isArray(s.accounts) ? s.accounts : [];
  const usable = a => !a.paused && !a.coolingUntil;
  const allowed = a => !model || !Array.isArray(a.models) || a.modelsAuthoritative !== true || a.models.some(m => String(m).toLowerCase() === model.toLowerCase());
  const pool = accounts.filter(a => a.kind !== 'personal');
  const personal = accounts.find(a => a.kind === 'personal' || a.id === 'personal');
  const poolOk = pool.filter(a => usable(a) && allowed(a));
  if (accounts.length && !accounts.some(usable)) {
    if (accounts.every(a => a.paused || a.coolingReason === 'credential')) {
      return { state: 'needs', text: '需要在 CodeAgent 登录', tip: '公司模型的账号登录都读不出来（可能过期）。打开 CodeAgent 命令行登录一下，号池的号到「账号」页重新登录；登录后自动恢复。' };
    }
    if (accounts.some(a => a.coolingReason === 'rate_limit')) return { state: 'busy', text: '号都在限流冷却', tip: '号池和个人号都被限流，冷却后自动恢复。' };
    return { state: 'needs', text: '号都已暂停', tip: '账号页里把号都暂停了，恢复一个号就能用。' };
  }
  if (poolOk.length) return { state: 'ready', text: `可用 · 号池 ${poolOk.length} 个号`, tip: '经本机反代，按会话分到号池里的号；号池用不了时退回你的个人号。' };
  if (personal && usable(personal)) return { state: 'ready', text: '可用 · 个人号', tip: pool.length ? '号池里没有能用这个模型的号，会用你的个人 CodeAgent 账号。' : '经本机反代，用你的个人 CodeAgent 账号。' };
  return { state: 'ready', text: '可用', tip: '经本机反代，用 CodeAgent 账号。' };
}

function companyModels(provider) {
  const list = Array.isArray(provider?.companyModels) && provider.companyModels.length ? provider.companyModels
    : Array.isArray(provider?.models) ? provider.models : [];
  return list.filter(m => m && typeof m.id === 'string' && m.id).map(m => ({ id: m.id, label: m.label || m.id }));
}

// 打开启动中心时默认选中的卡：该工具在「自有 API」里保存的来源和模型（也就是上次选的）。
function defaultPick(kind, provider) {
  if (!provider) return null;
  if (provider.backend === 'proxy' || kind === 'deepseek-acp') {
    const models = companyModels(provider);
    const model = models.some(m => m.id === provider.model) ? provider.model : models[0]?.id || '';
    return { source: 'company', model };
  }
  return { source: 'own', model: provider.own?.model || provider.model || '' };
}

// 新建会话前要不要先改保存的设置（选了和保存的不同的卡）：返回 company-api:save 的请求，或 null。
function saveRequest(kind, provider, pick) {
  if (!pick || !provider || !COMPANY_KINDS.has(kind)) return null;
  if (pick.source === 'company') {
    return provider.backend === 'proxy' && provider.model === pick.model ? null : { kind, backend: 'proxy', model: pick.model };
  }
  if (kind === 'deepseek-acp') return null;
  return provider.backend === 'proxy' ? { kind, backend: 'own' } : null;
}

function cardsFor(kind, provider, status, pick) {
  if (!COMPANY_KINDS.has(kind) || !provider) return [];
  const cards = companyModels(provider).map(m => {
    const badge = proxyBadge(status, m.id);
    return { id: m.id, name: m.label === m.id ? m.id : m.label, detail: m.label === m.id ? '' : m.id, source: 'company', sourceText: status?.shared ? '共享号池' : '公司模型',
      state: badge.state, statusText: badge.text, tip: badge.tip, checked: pick?.source === 'company' && pick.model === m.id };
  });
  if (kind !== 'deepseek-acp') {
    const own = provider.own || { backend: provider.backend === 'api' ? 'api' : 'local', model: provider.model || '' };
    const api = own.backend === 'api';
    cards.push({ id: 'own', name: api ? (own.model || '自有接口默认模型') : '沿用本机 CLI 配置', detail: '', source: 'own',
      sourceText: api ? '自有接口' : 'CLI 默认', state: 'ready', statusText: api ? '用你在「自有 API」里填的接口' : '用这台电脑上 CLI 自己的配置',
      tip: api ? '经你自己的接口地址和 Key，不走公司模型。' : '不经 Hub 改接口，CLI 用它本机的登录和模型设置。', checked: pick?.source === 'own' });
  }
  return cards;
}

function renderCards(cards, escapeHtml) {
  return cards.map(c => `<button type="button" class="session-model-card" role="radio" aria-checked="${c.checked ? 'true' : 'false'}" tabindex="${c.checked ? '0' : '-1'}"`
    + ` data-model-card="${escapeHtml(c.id)}" data-source="${escapeHtml(c.source)}" data-state="${escapeHtml(c.state)}" title="${escapeHtml(c.tip || '')}">`
    + `<span class="smc-top"><span class="smc-name">${escapeHtml(c.name)}</span><span class="smc-source" data-source="${escapeHtml(c.source)}">${escapeHtml(c.sourceText)}</span></span>`
    + (c.detail ? `<span class="smc-detail">${escapeHtml(c.detail)}</span>` : '')
    + `<span class="smc-status"><i class="smc-dot" aria-hidden="true"></i>${escapeHtml(c.statusText)}</span>`
    + '</button>').join('');
}

module.exports = { COMPANY_KINDS, proxyBadge, companyModels, defaultPick, saveRequest, cardsFor, renderCards };
