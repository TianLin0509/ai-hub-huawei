'use strict';

// 公司版：会话卡片和标题栏上的「模型 · 线路 · 号」（2026-11-06）。
// 线路来自会话自己记的 companyRoute（core/session-manager.js：proxy 公司模型 / api 自有接口 / local CLI 默认）；
// 公司模型会话用的是哪个号，来自反代状态里的 sessionAccounts（main/company-proxy-service.js，只有代称：个人 / 号 N）。

const COMPANY_KINDS = new Set(['claude', 'codex', 'deepseek-acp']);
let sessionAccounts = {};
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
  if (session.companyRoute === 'proxy') {
    const alias = sessionAccounts[tagOf(session.id)] || '';
    return { route: 'proxy', model, alias, source: '公司模型',
      chip: [shortModel(model), alias].filter(Boolean).join(' · '),
      text: [model, '公司模型', alias ? aliasWords(alias) : ''].filter(Boolean).join(' · '),
      title: `公司模型 ${model}${alias ? ` · ${alias === '个人' ? '你的个人 CodeAgent 账号' : '号池 ' + alias}` : ' · 第一次回答后显示用的是哪个号'}` };
  }
  const source = session.companyRoute === 'api' ? '自有接口' : 'CLI 默认';
  return { route: session.companyRoute, model, alias: '', source,
    chip: session.companyRoute === 'api' ? '自有接口' : '',
    text: [model, source].filter(Boolean).join(' · '),
    title: session.companyRoute === 'api' ? `自有接口${model ? ' ' + model : ''}（不走公司模型）` : 'CLI 默认：用这台电脑上 CLI 自己的配置（不走公司模型）' };
}

function updateStatus(status) {
  const next = status && status.sessionAccounts && typeof status.sessionAccounts === 'object' ? { ...status.sessionAccounts } : {};
  const changed = JSON.stringify(next) !== JSON.stringify(sessionAccounts);
  sessionAccounts = next;
  if (changed) for (const fn of listeners) { try { fn(); } catch { /* UI only */ } }
  return changed;
}
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { routeInfo, updateStatus, onChange, tagOf, shortModel };
