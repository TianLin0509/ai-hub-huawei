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
  // 缺的只是 CodeAgent（没装或读不到版本）时直说，不笼统写「上游信息不全」。
  if (code === 'PROFILE_INCOMPLETE' && (status?.missing || []).includes('codeagentVersion')) {
    return { state: 'needs', text: /没找到 CodeAgent/.test(String(status?.message || '')) ? '没找到 CodeAgent' : '读不到 CodeAgent 版本' };
  }
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
  // 限流按「号 + 模型」记（core/company-proxy/account-router.mjs rateLimitedModels，2026-11-12）：
  // 这张卡的模型被限流才算这个号用不了；没指定模型时看号上有没有任何限流。
  const limited = a => (a.rateLimitedModels || []).some(x => x && x.until > Date.now()
    && (!model || String(x.model || '').toLowerCase() === model.toLowerCase()));
  const usable = a => !a.paused && !a.coolingUntil && !limited(a);
  const allowed = a => !model || !Array.isArray(a.models) || a.modelsAuthoritative !== true || a.models.some(m => String(m).toLowerCase() === model.toLowerCase());
  const pool = accounts.filter(a => a.kind !== 'personal');
  const personal = accounts.find(a => a.kind === 'personal' || a.id === 'personal');
  const poolOk = pool.filter(a => usable(a) && allowed(a));
  if (accounts.length && !accounts.some(usable)) {
    if (accounts.every(a => a.paused || a.coolingReason === 'credential')) {
      return { state: 'needs', text: '需要在 CodeAgent 登录', tip: '公司模型的账号登录都读不出来（可能过期）。请到 Hub「账号」页点击个人账号的「登录」，号池的号也在该页重新登录；登录后自动恢复。' };
    }
    if (accounts.some(a => a.coolingReason === 'rate_limit' || limited(a))) return { state: 'busy', text: '号都在限流冷却', tip: '号池和个人号都被限流，冷却后自动恢复。' };
    return { state: 'needs', text: '号都已暂停', tip: '账号页里把号都暂停了，恢复一个号就能用。' };
  }
  if (poolOk.length) return { state: 'ready', text: `可用 · 号池 ${poolOk.length} 个号`, tip: '经本机反代，按会话分到号池里的号；号池用不了时退回你的个人号。' };
  if (personal && usable(personal)) return { state: 'ready', text: '可用 · 个人号', tip: pool.length ? '号池里没有能用这个模型的号，会用你的个人 CodeAgent 账号。' : '经本机反代，用你的个人 CodeAgent 账号。' };
  return { state: 'ready', text: '可用', tip: '经本机反代，用 CodeAgent 账号。' };
}

// API 网关（部门 API key，2026-11-19）的模型：网关配好了才有。
function gatewayModels(provider) {
  return (Array.isArray(provider?.gatewayModels) ? provider.gatewayModels : []).filter(m => m && typeof m.id === 'string' && m.id)
    .map(m => ({ id: m.id, label: m.label || m.id, note: m.note || '' }));
}
const onGateway = provider => provider?.backend === 'proxy' && provider.upstream === 'gateway';
// 自有接口 / API 账号的模型表（R45：一个接口可配多个模型）：默认模型排第一；老配置只有默认模型这一个。
const listOr = (list, model) => (Array.isArray(list) && list.length ? list : [model || '']);
function ownModelList(provider) {
  const own = provider?.own || {};
  return listOr(own.models || provider?.ownModels, own.model || provider?.model || '');
}
const profileModels = profile => listOr(profile?.models, profile?.model || '');
// 卡片编号：默认模型沿用老编号（own / api:<账号>），其余模型在后面接「#模型名」。
const cardId = (base, list, model) => (model === list[0] ? base : `${base}#${model}`);
function parseCardId(id) {
  const m = /^(own|api:[A-Za-z0-9_-]{1,64})#(.+)$/.exec(String(id || ''));
  return m ? { base: m[1], model: m[2] } : { base: String(id || ''), model: '' };
}

function companyModels(provider) {
  const list = Array.isArray(provider?.companyModels) && provider.companyModels.length ? provider.companyModels
    : Array.isArray(provider?.models) ? provider.models : [];
  return list.filter(m => m && typeof m.id === 'string' && m.id).map(m => ({ id: m.id, label: m.label || m.id,
    ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}) }));
}

// 打开启动中心时默认选中的卡：该工具在「自有 API」里保存的来源和模型（也就是上次选的）。
// 配过部门 API key 选 API 网关，否则选这个工具自己的来源；不默认选公司模型，免得一点创建就把设置改写成公司模型再报错（11-21 全新用户深查 #6）。
// preferred：Hub 里「设为默认」存下的模型（R49 审查 P1-2）。它在这个工具当前的模型卡里（没有 CodeAgent 时不算用不了的公司模型）
// 就默认选它那张卡；不在就照旧用保存的来源和模型。「设为默认」不改线路配置，线路在新建会话时按选中的卡保存。
function defaultPick(kind, provider, { codeagentInstalled = null, preferred = '', status = null } = {}) {
  const base = savedPick(kind, provider, { codeagentInstalled });
  const want = String(preferred || '');
  if (!base || !want || base.model === want) return base;
  const card = cardsFor(kind, provider, status, null, { codeagentInstalled }).find(c => (c.source === 'company' ? c.id : c.model) === want
    && ['gateway', 'own', 'api', 'company'].includes(c.source) && !(c.source === 'company' && codeagentInstalled === false));
  if (!card) return base;
  if (card.source === 'api') return { source: 'api', profileId: card.profileId, model: card.model };
  return { source: card.source, model: want };
}
function savedPick(kind, provider, { codeagentInstalled = null } = {}) {
  if (!provider) return null;
  const untouched = provider.companyDefault === true && provider.backend === 'local';
  if (untouched && codeagentInstalled === false) {
    const gateway = gatewayModels(provider);
    if (gateway.length) return { source: 'gateway', model: gateway[0].id };
    if (kind !== 'deepseek-acp') return { source: 'own', model: provider.own?.model || provider.model || '' };
  }
  if (provider.backend === 'api' && provider.selectedProfileId) {
    const profile = provider.apiProfiles?.find(item => item.id === provider.selectedProfileId);
    if (profile) return { source: 'api', profileId: profile.id, model: profile.model };
  }
  if (onGateway(provider)) {
    const models = gatewayModels(provider);
    return { source: 'gateway', model: models.some(m => m.id === provider.model) ? provider.model : models[0]?.id || provider.model || '' };
  }
  // DSH 存的是自有接口（2026-11-20 起可用）：默认选自有卡，不再悄悄切到公司模型。
  if (kind === 'deepseek-acp' && provider.backend === 'api') return { source: 'own', model: provider.model || '' };
  if (provider.backend === 'proxy' || kind === 'deepseek-acp' || untouched) {
    const models = companyModels(provider);
    const model = models.some(m => m.id === provider.model) ? provider.model : models[0]?.id || '';
    return { source: 'company', model };
  }
  return { source: 'own', model: provider.own?.model || provider.model || '' };
}

// 新建会话前要不要先改保存的设置（选了和保存的不同的卡）：返回 company-api:save 的请求，或 null。
function saveRequest(kind, provider, pick) {
  if (!pick || !provider || !COMPANY_KINDS.has(kind)) return null;
  if (pick.source === 'api') {
    // 选了这个账号的另一个模型：一并记成它的默认模型（下次打开默认选它）。
    const profile = provider.apiProfiles?.find(item => item.id === pick.profileId);
    return { kind, profileAction: 'select', profileId: pick.profileId, ...(pick.model && profile && pick.model !== profile.model ? { model: pick.model } : {}) };
  }
  if (pick.source === 'gateway') {
    return onGateway(provider) && provider.model === pick.model ? null : { kind, backend: 'gateway', model: pick.model };
  }
  if (pick.source === 'company') {
    return provider.backend === 'proxy' && !onGateway(provider) && provider.model === pick.model ? null : { kind, backend: 'proxy', model: pick.model };
  }
  // 自有接口选了另一个模型：带上 ownModel，记成它的默认模型（下次打开默认选它，R45-3）。
  const ownDefault = provider.own?.model || provider.model || '';
  const remember = pick.model && pick.model !== ownDefault && ownModelList(provider).includes(pick.model) ? { ownModel: pick.model } : {};
  if (kind === 'deepseek-acp') {
    if (provider.backend === 'proxy' && provider.own?.backend === 'api') return { kind, backend: 'own', ...remember };
    return remember.ownModel ? { kind, ...remember } : null;
  }
  if (provider.apiProfiles?.length) return { kind, useLocal: true };
  if (provider.backend === 'proxy' || provider.companyDefault === true) return { kind, backend: 'own', ...remember };
  return remember.ownModel ? { kind, ...remember } : null;
}

// 群聊成员（建群 / 加成员）选了 Claude Code、Codex、DSH：每个成员各带各的模型，但同一种工具的来源（公司模型 / 自有来源）
// 全机只有一份设置，所以同一种工具的成员要么都用公司模型、要么都用自有来源。返回建成员前要先保存的设置请求。
function memberSaveRequests(slots, providers) {
  const requests = [];
  for (const kind of COMPANY_KINDS) {
    const models = (slots || []).filter(slot => slot && slot.kind === kind).map(slot => slot.model || '');
    const provider = providers && providers[kind];
    if (!models.length || !provider) continue;
    const companyIds = new Set(companyModels(provider).map(m => m.id));
    const gatewayIds = new Set(gatewayModels(provider).map(m => m.id));
    const apiProfile = provider.apiProfiles?.find(profile => profile.id === provider.selectedProfileId && models.every(id => profileModels(profile).includes(id)));
    // 当前走自有接口（没有命名 profile 的老配置）且模型都在它的模型表里：也算自有来源，不悄悄换到网关。
    const ownApi = provider.backend === 'api' && models.every(id => listOr(provider.ownModels, provider.model).includes(id));
    // 成员模型都在网关表里：走网关线路（当前就走网关，或这些名字既不是公司模型、也不是当前选中的自有接口——从公司线路切过来的也算，11-19 审查发现）。
    if (gatewayIds.size && models.every(id => gatewayIds.has(id)) && (onGateway(provider) || (!apiProfile && !ownApi && !models.some(id => companyIds.has(id))))) {
      const request = saveRequest(kind, provider, { source: 'gateway', model: models[0] });
      if (request) requests.push(request);
      continue;
    }
    const company = models.filter(id => companyIds.has(id));
    if (!company.length && apiProfile) {
      requests.push({ kind, profileAction: 'select', profileId: apiProfile.id });
      continue;
    }
    if (company.length && company.length < models.length) {
      throw new Error(`${require('../core/company-api-config').LABELS[kind]} 成员不能一部分用公司模型、一部分用自有来源，请选成同一种来源`);
    }
    const request = saveRequest(kind, provider, company.length ? { source: 'company', model: company[0] } : { source: 'own', model: models[0] });
    if (request) requests.push(request);
  }
  return requests;
}

function cardsFor(kind, provider, status, pick, { codeagentInstalled = null } = {}) {
  if (!COMPANY_KINDS.has(kind) || !provider) return [];
  const gatewayCards = gatewayModels(provider).map(m => ({ id: 'gw:' + m.id, model: m.id, name: m.id, detail: '', source: 'gateway', sourceText: 'API 网关',
    state: 'ready', statusText: m.note || '用部门 API key', tip: '经本机反代转给 API 网关，用你保存的部门 API key，不走 CodeAgent 账号。网关排队时首字可能要等 10–30 秒。',
    checked: pick?.source === 'gateway' && pick.model === m.id }));
  const cards = companyModels(provider).map(m => {
    const badge = proxyBadge(status, m.id);
    return { id: m.id, name: m.label === m.id ? m.id : m.label, detail: m.label === m.id ? '' : m.id, source: 'company', sourceText: status?.shared ? '共享号池' : '公司模型',
      state: badge.state, statusText: badge.text,
      tip: `${badge.tip} · ${m.contextWindow > 0 ? `模型目录窗口 ${Number(m.contextWindow).toLocaleString()} tokens` : '上下文窗口未知'}`,
      checked: pick?.source === 'company' && pick.model === m.id };
  });
  if (kind !== 'deepseek-acp') {
    const own = provider.apiProfiles?.length ? { backend: 'local' }
      : provider.own || { backend: provider.backend === 'api' ? 'api' : 'local', model: provider.model || '' };
    const api = own.backend === 'api';
    const list = api ? ownModelList({ ...provider, own }) : [''];
    // 一个接口配了多个模型：每个模型一张卡（R45），选哪张会话就用哪个模型。
    for (const model of list) cards.push({ id: cardId('own', list, model), model, name: api ? (model || '自有接口默认模型') : '沿用本机 CLI 配置', detail: '', source: 'own',
      sourceText: api ? '自有接口' : 'CLI 默认', state: api && provider.apiKeyNeedsInput ? 'needs' : 'ready', statusText: api && provider.apiKeyNeedsInput ? 'Key 无法解密，点此补填' : api ? '用你在「自有 API」里填的接口' : '用这台电脑上 CLI 自己的配置',
      tip: api ? '经你自己的接口地址和 Key，不走公司模型。' : '不经 Hub 改接口，CLI 用它本机的登录和模型设置。',
      checked: pick?.source === 'own' && (!api || list.length < 2 || (pick.model || list[0]) === model) });
    for (const profile of provider.apiProfiles || []) {
      const models = profileModels(profile);
      for (const model of models) cards.push({ id: cardId('api:' + profile.id, models, model), profileId: profile.id, model,
        name: profile.label, detail: model, source: 'api', sourceText: '自有 API', state: profile.apiKeyNeedsInput ? 'needs' : 'ready',
        statusText: profile.apiKeyNeedsInput ? 'Key 无法解密，点此补填' : profile.baseURL, tip: profile.baseURL,
        checked: pick?.source === 'api' && pick.profileId === profile.id && (models.length < 2 || (pick.model || models[0]) === model) });
    }
  } else if (provider.own?.backend === 'api') {
    // DSH 只有填过自有接口才有自有卡（公司版 DSH 没有可沿用的本机配置）。
    const list = ownModelList(provider);
    for (const model of list) cards.push({ id: cardId('own', list, model), model, name: model || '自有接口', detail: '', source: 'own', sourceText: '自有接口', state: provider.apiKeyNeedsInput ? 'needs' : 'ready',
      statusText: provider.apiKeyNeedsInput ? 'Key 无法解密，点此补填' : '用你在「自有 API」里填的接口', tip: '直连你自己的 OpenAI 兼容接口和 Key，不走公司模型和 API 网关。',
      checked: pick?.source === 'own' && (list.length < 2 || (pick.model || list[0]) === model) });
  }
  // 正走 API 网关的工具，网关模型卡排在最前；否则排在公司模型后面。
  // 走 API 网关的用户多半没有 CodeAgent：公司模型此刻用不了就不显示那两张卡，免得一屏「公司上游信息不全」（E2E 截图发现）。
  if (onGateway(provider)) return [...gatewayCards, ...cards.filter(c => c.source !== 'company' || c.state === 'ready' || c.checked)];
  const companyCount = companyModels(provider).length;
  if (gatewayCards.length) return [...cards.slice(0, companyCount), ...gatewayCards, ...cards.slice(companyCount)];
  // 还没配 API 网关（11-19 同事反馈找不到入口）：放一张「用部门 API key」卡，点了在卡下就地配置。
  // 这台电脑没装 CodeAgent、公司模型也还没跑起来：多半是 API 用户，把它排第一并标推荐。装了 CodeAgent 的老用户顺序不变。
  const companyReady = codeagentInstalled !== false || cards.slice(0, companyCount).some(c => c.state === 'ready');
  const setup = { id: 'gw-setup', name: '用部门 API key', detail: '', source: 'gateway-setup', sourceText: 'API 网关', state: companyReady ? 'setup' : 'suggest',
    statusText: companyReady ? '没有 CodeAgent 账号时用' : '推荐：粘贴部门发的 key 就能用', tip: '部门发了 API key、没有 CodeAgent 账号的同事用这个：点一下在下面粘贴 key，Claude Code、Codex、DSH 都能用。', checked: false };
  return companyReady ? [...cards.slice(0, companyCount), setup, ...cards.slice(companyCount)] : [setup, ...cards];
}

// 模型下拉 / 会话内切换 / 群聊成员用的清单（R49，11-26 反馈「我想选其他模型，但给的选项里只能选这几个，我也没有这些模型」）：
// 和模型卡同一份来源（cardsFor），卡上不显示的（走网关时用不了的公司模型）这里也不列。每项带 route，
// 会话内切换按会话实际走的线路过滤（网关会话只列网关模型、自有接口会话只列自有接口的模型）。
// 公司版 Claude Code / Codex 永远不回落到官方模型清单：一个也没有时返回空表，界面就地说明并给「去设置添加模型」。
function modelOptions(kind, provider, status, { codeagentInstalled = null } = {}) {
  const company = new Map(companyModels(provider).map(m => [m.id, m]));
  const out = [];
  for (const c of cardsFor(kind, provider, status, null, { codeagentInstalled })) {
    // 本机没有 CodeAgent 时公司模型用不了：没就绪的不进清单（R49 审查 P1-3；卡片上仍显示并写明原因）。
    if (c.source === 'company') { if (codeagentInstalled !== false || c.state === 'ready') out.push({ id: c.id, label: company.get(c.id)?.label || c.id, route: 'company' }); }
    else if (c.source === 'gateway') out.push({ id: c.model, label: c.model + '（API 网关）', route: 'gateway' });
    else if (c.source === 'api') out.push({ id: c.model, label: c.name + ' · ' + c.model, route: 'api' });
    else if (c.source === 'own' && c.sourceText === 'CLI 默认') out.push({ id: '', label: '沿用本机 CLI 配置', route: 'local' });
    else if (c.source === 'own') out.push({ id: c.model || '', label: c.model ? c.model + '（自有接口）' : '自有接口默认模型', route: 'own' });
  }
  return out;
}
// 会话实际走的线路 → 它能切到的模型来源（会话内切换只能在同一条线路里换模型；换线路要新建会话）。
function sessionRoute(session) {
  if (session?.companyRoute === 'proxy') return session.companyUpstream === 'gateway' ? 'gateway' : 'company';
  if (session?.companyRoute === 'api' && !session.cliApiProfileId) return 'own';
  return '';
}
// 菜单说明与空状态用的线路（R49 审查 P2）：在 sessionRoute 之外再认出命名 API 账号（api）和沿用本机 CLI 配置（local），
// 这两种的模型清单由主进程按会话读（session:local-models），不带 route，不参与上面的过滤。
function sessionLine(session) {
  if (session?.cliApiProfileId) return 'api';
  if (session?.companyRoute === 'local') return 'local';
  return sessionRoute(session);
}
function optionsForSession(options, session) {
  const list = Array.isArray(options) ? options : [];
  const route = sessionRoute(session);
  if (!route || !list.some(o => o && o.route)) return list;
  return list.filter(o => o && o.route === route);
}

// 选了 CodeAgent、部门 key 已配好、而 CodeAgent 实时读不到任何可用模型（R45，v5.6.100「连上了对话不生效」）：
// CodeAgent 不走部门 key（已拍板），请求只会发去 CodeAgent 自己的账号然后失败。返回要就地显示的一句话；不该提示时返回空串。
// 模型清单还在读（loading / 还没读）时不提示，免得一闪而过。
function codeagentGatewayHint({ selectedKind, gatewayReady, catalogState, usableCount } = {}) {
  if (selectedKind !== 'codeagent' || !gatewayReady) return '';
  if (!catalogState || catalogState === 'loading' || usableCount == null || usableCount > 0) return '';
  return 'CodeAgent 这边没有可用模型；部门 API key 不走 CodeAgent，选 Claude Code / Codex / DSH 才会用它。';
}

// 「改用部门 key」该开哪个工具（审查 P1-3）：本机已装、能走部门 key 的第一个，顺序 Claude Code → Codex → DSH；
// 都没装（或还不知道）才落回 Claude Code（点了会就地给安装说明）。installed(option) 返回 true / false / null。
const GATEWAY_TARGETS = Object.freeze([
  { option: 'claude', kind: 'claude', label: 'Claude Code' },
  { option: 'codex', kind: 'codex', label: 'Codex' },
  { option: 'deepseek', kind: 'deepseek-acp', label: 'DSH' },
]);
function gatewayLaunchTarget(installed = () => null) {
  return GATEWAY_TARGETS.find(t => installed(t.option, t.kind) === true) || GATEWAY_TARGETS[0];
}

// 模型卡太多时折叠（R45-3 审查 P1-3）：默认 3 行 = 8 张模型卡 + 1 张「更多模型（+K）」，当前选中的卡一定在可见的 8 张里；
// 点「更多模型」在同一区域展开全部，最后一张变「收起」。不超过 9 张时原样全显示。
const FOLD_CELLS = 9;
function foldCards(cards, { expanded = false, cells = FOLD_CELLS } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  if (list.length <= cells) return list;
  const toggle = n => ({ id: 'more', name: expanded ? '收起' : `更多模型（+${n}）`, detail: '', source: 'more', sourceText: '',
    state: 'more', statusText: expanded ? '只显示前几个模型' : '展开这个工具的全部模型', tip: '', checked: false });
  if (expanded) return [...list, toggle(0)];
  let shown = list.slice(0, cells - 1);
  const picked = list.find(c => c.checked);
  if (picked && !shown.includes(picked)) shown = [...shown.slice(0, cells - 2), picked];
  return [...shown, toggle(list.length - shown.length)];
}

function renderCards(cards, escapeHtml) {
  return cards.map(c => `<button type="button" class="session-model-card" role="radio" aria-checked="${c.checked ? 'true' : 'false'}" tabindex="${c.checked ? '0' : '-1'}"`
    + ` data-model-card="${escapeHtml(c.id)}" data-source="${escapeHtml(c.source)}" data-state="${escapeHtml(c.state)}" title="${escapeHtml(c.tip || '')}">`
    + `<span class="smc-top"><span class="smc-name">${escapeHtml(c.name)}</span>${c.sourceText ? `<span class="smc-source" data-source="${escapeHtml(c.source)}">${escapeHtml(c.sourceText)}</span>` : ''}</span>`
    + (c.detail ? `<span class="smc-detail">${escapeHtml(c.detail)}</span>` : '')
    + `<span class="smc-status"><i class="smc-dot" aria-hidden="true"></i>${escapeHtml(c.statusText)}</span>`
    + '</button>').join('');
}

module.exports = { COMPANY_KINDS, proxyBadge, companyModels, gatewayModels, ownModelList, profileModels, parseCardId, defaultPick, saveRequest, memberSaveRequests, cardsFor, renderCards, codeagentGatewayHint, gatewayLaunchTarget, foldCards,
  modelOptions, sessionRoute, sessionLine, optionsForSession };
