'use strict';
// 助理走部门 API key（2026-11-24 用户决定：助理要能用部门 key，CodeAgent 不改）。
// 做法：助理会话改用 Claude Code，经本机反代的网关上游答题（与「用 API key 开始」的 Claude Code 会话同一条线路）。
// key 仍只在 core/api-gateway.js 的加密存储里、由主进程交给反代；会话环境里只有反代的本机 Key，没有部门 key。
const KIND = 'api-gateway';
const LABEL = '部门 API key（网关）';
const PURPOSES = ['company-assistant'];
const gateway = () => require('./api-gateway');

// 会话启动参数：只对这次会话把 Claude Code 指向本机反代的网关上游，不改全局「自有 API」设置。
function launchValues(values = {}) {
  return { ...values, COMPANY_CLI: true, CLAUDE_BACKEND: 'proxy', CLAUDE_UPSTREAM: 'gateway' };
}
// 放行只认「助理 + 选型结果是部门 key」：功能标记、用途、选型记录三者都对上才算，别的功能带上网关标记也不放行。
function allowedSession(kind, opts = {}) {
  if (opts.apiGatewayRoute !== true || !/^claude(?:-resume)?$/.test(String(kind || '')) || !PURPOSES.includes(opts.purpose) || opts.featureAgent !== 'assistant') return false;
  try { return JSON.parse(String(opts.featureAgentChoice || '')).kind === KIND; } catch { return false; }
}

// 这条线路能不能用：已保存部门 key，本机有 Claude Code（助理会话靠它调工具）。返回 { available, reason }。
function availability(dataDir, { findCommand = require('./community-setup').findCommand, env = process.env } = {}) {
  let keySet = false;
  try { keySet = gateway().read(dataDir).keySet; } catch { keySet = false; }
  if (!keySet) return { available: false, reason: '还没保存部门 API key' };
  try { require('./company-ai-policy').assertKind('claude'); } catch { return { available: false, reason: '当前发行版不提供 Claude Code' }; }
  let claude = '';
  try { claude = findCommand('claude', env) || ''; } catch { claude = ''; }
  if (!claude) return { available: false, reason: '本机没有 Claude Code，助理要靠它作答' };
  return { available: true, reason: '' };
}

// 开箱即用：用户没选过、本机没有 CodeAgent、部门 key 已配好且能用时，助理默认走部门 key。
// 有 CodeAgent 的用户（含所有老用户）不受影响。backends 给定时按它判断（与「功能使用的 Agent」同一份目录）。
function autoDefault(dataDir, { backends, findCommand = require('./community-setup').findCommand, env = process.env } = {}) {
  if (backends) {
    const codeagent = backends.find(b => b.kind === 'codeagent');
    const route = backends.find(b => b.kind === KIND);
    return !!route?.available && !codeagent?.available;
  }
  // 先看有没有存部门 key（读一个小文件）：没存的绝大多数用户不再去查本机命令，启动时不多花时间。
  if (!availability(dataDir, { findCommand, env }).available) return false;
  let codeagent = '';
  try { codeagent = findCommand('codeagent', env) || ''; } catch { codeagent = 'unknown'; } // 查不清时按「有」处理，不悄悄切线路
  return !codeagent;
}

// 反代要不要常驻：助理明确选了部门 key，或按上面的规则默认用它。
function inUse(dataDir, options = {}) {
  try {
    const pref = require('./codeagent-assistant-route').featurePreference(dataDir, 'assistant');
    if (pref) return pref.kind === KIND && availability(dataDir, options).available;
    return autoDefault(dataDir, options);
  } catch { return false; }
}

// 助理这一问以网关报错收场：取本机反代翻好的人话（「API 网关：…」），没翻过的按状态码套同一口径。
// 返回 { line, actions }（actions：gateway-settings / model / retry，界面按 id 接线）；认不出返回 null。
const ACTION_MAP = { rekey: 'gateway-settings', 'switch-model': 'model', 'group-help': 'gateway-settings', retry: 'retry', compact: 'retry' };
function failure(text) {
  const errors = require('./api-gateway-errors');
  const raw = String(text || '');
  const at = raw.indexOf(errors.ERROR_PREFIX);
  let message = '', actions = [];
  if (at >= 0) {
    message = raw.slice(at + errors.ERROR_PREFIX.length).split(/\r?\n/)[0].replace(/（网关原话：[^）]*）/, '').replace(/["'}\]\s\\]+$/, '').trim();
    actions = /key 无效|地址填错|网关地址/.test(message) ? ['rekey'] : /额度/.test(message) ? ['switch-model', 'rekey']
      : /分组开放|使用权限|已经没有|太大|太长|上下文/.test(message) ? ['switch-model']
        : /太久没开始回答|限流|出错|HTTP 5/.test(message) ? ['retry', 'switch-model'] : ['retry'];
  } else {
    const status = Number((/\b([45]\d\d)\b/.exec(raw) || [])[1]) || 0;
    const timedOut = !status && /timed?\s*out|ETIMEDOUT|超时/i.test(raw);
    if (!status && !timedOut) return null;
    if (timedOut) { message = '网关太久没开始回答，可能正在排队。稍后重问，或换个首字更快的模型。'; actions = ['retry', 'switch-model']; }
    else { const e = errors.classify({ status, body: raw }); message = e.message; actions = e.actions; }
  }
  if (!message) return null;
  return { line: `${LABEL}：${message}`, actions: [...new Set(actions.map(a => ACTION_MAP[a]).filter(Boolean))] };
}

module.exports = { KIND, LABEL, launchValues, allowedSession, availability, autoDefault, inUse, failure };
