'use strict';

// 公司版：会话卡片和标题栏上的「模型 · 线路 · 号」（2026-11-06）。
// 线路来自会话自己记的 companyRoute（core/session-manager.js：proxy 公司模型 / api 自有接口 / local CLI 默认）；
// 公司模型会话用的是哪个号，来自反代状态里的 sessionAccounts（main/company-proxy-service.js，只有代称：个人 / 号 N）；
// 启动中心固定了号的会话（companyProxyAccount + companyProxyLabel，2026-11-07）一开始就显示这个号，不等第一次回答。

const COMPANY_KINDS = new Set(['claude', 'codex', 'deepseek-acp']);
let sessionAccounts = {};
let sessionAccountIds = {};
let shared = false;
// API 网关会话首包前在排队的（反代状态 gateway.waiting：tag -> { waitedMs, attempt }），收到时刻记下来，本地按秒往上数。
let gatewayWaiting = {};
let gatewayWaitingAt = 0;
const listeners = new Set();

// 和 core/company-model-proxy.js sessionTag 同一规则：会话 ID 只留字母数字、下划线和连字符，最多 64 位。
function tagOf(sessionId) {
  const tag = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return tag || 'default';
}
function shortModel(id) {
  const s = String(id || '');
  if (/^glm/i.test(s)) return 'GLM';
  if (/deepseek/i.test(s)) return 'DS';
  return s;
}
const aliasWords = alias => alias === '个人' ? '个人号' : alias;

function routeInfo(session) {
  if (!session || !session.companyRoute) return null;
  const base = String(session.kind || '').replace(/-resume$/, '');
  if (!COMPANY_KINDS.has(base)) return null;
  const model = session.currentModel?.id || '';
  if (session.companyRoute === 'proxy' && session.companyUpstream === 'gateway') {
    // API 网关（部门 API key，2026-11-19）：没有号；首包前排队时标出已等秒数（实测常见 10–30 秒），免得以为卡住。
    const wait = gatewayWaiting[tagOf(session.id)];
    const waited = wait ? Math.max(0, Math.round((wait.waitedMs + Date.now() - gatewayWaitingAt) / 1000)) : 0;
    const queue = wait ? `网关排队中 ${waited} 秒${wait.attempt > 1 ? '（已自动重试）' : ''}` : '';
    return { route: 'proxy', model, alias: '', source: 'API 网关', gateway: true, waiting: !!wait, waited,
      chip: [shortModel(model), queue ? '排队' : ''].filter(Boolean).join(' · '),
      text: [model, 'API 网关', queue].filter(Boolean).join(' · '),
      title: `API 网关 ${model}（用部门 API key，不走 CodeAgent 账号）${queue ? '。' + queue + '：这个网关首字通常要 10–30 秒，之后会逐字出来；150 秒还没开始会自动重试一次。' : ''}` };
  }
  if (session.companyRoute === 'proxy') {
    const pinned = !shared && session.companyProxyAccount ? (session.companyProxyLabel || (session.companyProxyAccount === 'personal' ? '个人' : '')) : '';
    const alias = pinned || sessionAccounts[tagOf(session.id)] || '';
    if (shared) return { route: 'proxy', model, alias, source: '共享号池', chip: [shortModel(model), '共享'].filter(Boolean).join(' · '),
      text: [model, '共享号池', alias].filter(Boolean).join(' · '), title: '经团队共享主机，账号由主机自动分配；额度与连接状态见右侧栏。' };
    return { route: 'proxy', model, alias, source: '公司模型', ...(session.companyProxyAccount && !shared ? { pinned: true } : {}),
      chip: [shortModel(model), alias].filter(Boolean).join(' · '),
      text: [model, '公司模型', alias ? aliasWords(alias) : ''].filter(Boolean).join(' · '),
      title: `公司模型 ${model}${alias ? ` · ${alias === '个人' ? '你的个人 CodeAgent 账号' : '号池 ' + alias}` : ' · 第一次回答后显示用的是哪个号'}${pinned ? '（启动时选定，整段会话固定用它）' : ''}` };
  }
  const source = session.companyRoute === 'api' ? (session.cliApiProfileLabel || '自有接口') : 'CLI 默认';
  return { route: session.companyRoute, model, alias: '', source,
    chip: session.companyRoute === 'api' ? source : '',
    text: [model, source].filter(Boolean).join(' · '),
    title: session.companyRoute === 'api' ? `${source}${model ? ' ' + model : ''}（不走公司模型）` : 'CLI 默认：用这台电脑上 CLI 自己的配置（不走公司模型）' };
}

// 侧栏额度（2026-11-12 同事反馈：DSH 走反代用 ds1017，额度却显示成 GLM-5.2）：反代会话也按它实际用的号和模型显示。
// 号：启动中心固定的号，否则反代给这个会话分的号；还没发过消息、或走团队共享主机（号由主机分配）时为空。
// 模型：按反代同一规则归到公司模型（core/company-model-proxy.js launchModel：含 deepseek 的归 DeepSeek，其余归 GLM）。
function quotaTarget(session) {
  if (!session || session.companyRoute !== 'proxy' || shared || session.companyUpstream === 'gateway') return null;
  if (!COMPANY_KINDS.has(String(session.kind || '').replace(/-resume$/, ''))) return null;
  const account = session.companyProxyAccount || sessionAccountIds[tagOf(session.id)] || '';
  let model = '';
  try { model = require('../core/company-model-proxy').launchModel(session.currentModel?.id || ''); } catch { model = session.currentModel?.id || ''; }
  return { account, model };
}

function updateStatus(status) {
  const next = status && status.sessionAccounts && typeof status.sessionAccounts === 'object' ? { ...status.sessionAccounts } : {};
  const nextIds = status && status.sessionAccountIds && typeof status.sessionAccountIds === 'object' ? { ...status.sessionAccountIds } : {};
  const waiting = status?.gateway?.waiting && typeof status.gateway.waiting === 'object' ? status.gateway.waiting : {};
  const waitingChanged = Object.keys(waiting).sort().join(',') !== Object.keys(gatewayWaiting).sort().join(',') || Object.keys(waiting).length > 0;
  gatewayWaiting = { ...waiting }; gatewayWaitingAt = Date.now();
  const changed = shared !== (status?.shared === true) || JSON.stringify(next) !== JSON.stringify(sessionAccounts)
    || JSON.stringify(nextIds) !== JSON.stringify(sessionAccountIds) || waitingChanged;
  shared = status?.shared === true;
  sessionAccounts = next;
  sessionAccountIds = nextIds;
  if (changed) for (const fn of listeners) { try { fn(); } catch { /* UI only */ } }
  return changed;
}
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// 有会话在网关排队时，每秒刷新一次标题栏的已等秒数（反代状态每 5 秒才来一次）。
function anyGatewayWaiting() { return Object.keys(gatewayWaiting).length > 0; }

module.exports = { routeInfo, quotaTarget, updateStatus, onChange, tagOf, shortModel, anyGatewayWaiting };
