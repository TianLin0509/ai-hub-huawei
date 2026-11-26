'use strict';
// 会话功能走部门 API key（2026-11-24 用户决定：先放开助理，同日扩到心声 / PPT / 分身 / 会议 / 文字共 8 项，CodeAgent 不改）。
// 做法：所选功能的会话改用 Claude Code，经本机反代的网关上游答题（与「用 API key 开始」的 Claude Code 会话同一条线路）。
// key 仍只在 core/api-gateway.js 的加密存储里、由主进程交给反代；会话环境里只有反代的本机 Key，没有部门 key。
const KIND = 'api-gateway';
const LABEL = '部门 API key（网关）';
// 功能 ↔ 用途一一绑定：只认表里的组合，别的功能或配错用途的一律不放行（跨功能伪造挡在这里）。
const FEATURE_PURPOSES = Object.freeze({
  assistant: 'company-assistant', ppt: 'company-assistant', pptMake: 'company-assistant', pptImgtext: 'company-assistant',
  meeting: 'company-assistant', forum: 'company-forum', avatar: 'avatar-agent', text: 'company-ai',
});
const FEATURE_IDS = Object.freeze(Object.keys(FEATURE_PURPOSES));
const gateway = () => require('./api-gateway');

// 会话启动参数：只对这次会话把 Claude Code 指向本机反代的网关上游，不改全局「自有 API」设置。
function launchValues(values = {}) {
  return { ...values, COMPANY_CLI: true, CLAUDE_BACKEND: 'proxy', CLAUDE_UPSTREAM: 'gateway' };
}
// 放行只认「表里的功能 + 该功能自己的用途 + 选型结果是部门 key + none 档 MCP」：网关标记、会话类型、功能与用途、选型记录、
// MCP 档位全对上才算（缺档位或 full / lean 会继承用户自己的 MCP，一律不放行）。
function allowedSession(kind, opts = {}) {
  if (!opts || opts.apiGatewayRoute !== true || opts.mcpProfile !== 'none' || !/^claude(?:-resume)?$/.test(String(kind || ''))) return false;
  const id = String(opts.featureAgent || '');
  if (!Object.prototype.hasOwnProperty.call(FEATURE_PURPOSES, id) || FEATURE_PURPOSES[id] !== opts.purpose) return false;
  return isGatewayChoice(opts.featureAgentChoice);
}

function isGatewayChoice(raw) {
  try { return JSON.parse(String(raw || '')).kind === KIND; } catch { return false; }
}
// 恢复休眠的功能会话（论坛 / 会议 / 分身等）：只认磁盘上的会话记录（主进程写的），渲染层传来的 featureAgent 等一概不认。
// 记录里功能、用途、选型三者配套且是 Claude Code 会话，才给出网关字段（含 none 档 MCP）；否则返回 null，按普通会话恢复。
function resumeFields(saved) {
  if (!saved || typeof saved !== 'object' || !/^claude(?:-resume)?$/.test(String(saved.kind || ''))) return null;
  const id = String(saved.featureAgent || '');
  if (!Object.prototype.hasOwnProperty.call(FEATURE_PURPOSES, id) || FEATURE_PURPOSES[id] !== saved.purpose || !isGatewayChoice(saved.featureAgentChoice)) return null;
  return { featureAgent: id, featureAgentChoice: String(saved.featureAgentChoice), purpose: saved.purpose, apiGatewayRoute: true, mcpProfile: 'none' };
}

// 这条线路能不能用：已保存部门 key，本机有 Claude Code（助理会话靠它调工具）。返回 { available, reason }。
function availability(dataDir, { findCommand = require('./community-setup').findCommand, env = process.env } = {}) {
  let keySet = false;
  try { keySet = gateway().read(dataDir).keySet; } catch { keySet = false; }
  if (!keySet) return { available: false, reason: '还没保存部门 API key' };
  try { require('./company-ai-policy').assertKind('claude'); } catch { return { available: false, reason: '当前发行版不提供 Claude Code' }; }
  let claude = '';
  try { claude = findCommand('claude', env) || ''; } catch { claude = ''; }
  if (!claude) return { available: false, reason: '本机没有 Claude Code，部门 key 要靠它作答' };
  return { available: true, reason: '' };
}

// 开箱即用：用户没选过、本机没有可用的 CodeAgent、部门 key 已配好且能用时，8 项会话功能都默认走部门 key
// （11-24 先只管助理；R49-2，11-26 扩到全部 8 项，起因是只有部门 key 的同事在 PPT / 分身 / 论坛等功能里默认落到 CodeAgent 而失败）。
// 有 CodeAgent 的用户（含所有老用户）不受影响。backends 给定时按它判断（与「功能使用的 Agent」同一份目录）。
function autoDefault(dataDir, { backends, findCommand = require('./community-setup').findCommand, env = process.env } = {}) {
  if (backends) return !!backends.find(b => b.kind === KIND)?.available && codeagentMissing(dataDir, { backends, env });
  // 先看有没有存部门 key（读一个小文件）：没存的绝大多数用户不再去查本机命令，启动时不多花时间。
  if (!availability(dataDir, { findCommand, env }).available) return false;
  return codeagentMissing(dataDir, { findCommand, env });
}
// 没有可用的 CodeAgent：没装，或装了但没有模型权限。查不清时按「有」处理，不悄悄切线路。
// backends 给定时「装没装」按目录里的 codeagent 行（与「功能使用的 Agent」同一份）。
function codeagentMissing(dataDir, { backends, findCommand = require('./community-setup').findCommand, env = process.env } = {}) {
  if (backends) return !backends.find(b => b.kind === 'codeagent')?.available || noCodeagentModels(dataDir, env);
  let codeagent = '';
  try { codeagent = findCommand('codeagent', env) || ''; } catch { return false; }
  return !codeagent || noCodeagentModels(dataDir, env);
}
// 「没有模型权限」只认确凿的，号池里登记了别的号时一律不算（可能用号池的号）：
//   A. serve 连上了、读到的清单是空的（SERVE_EMPTY_MODELS 标记比最近一次非空清单新）；
//   B. 个人号清单里的每个模型都有「模型配置报错」记录（codeagent-quota 的模型避让，含已过 6 小时试探期、还没被一次成功回答解除的）。
//      这里不套 codeagent-models 的「清单里本来就有它就不置灰」豁免：那条豁免是给下拉显示用的，真实报错写入时 have 一定含这个模型。
//   兜底：清单里能用的（含 CodeAgent 自配供应商的模型）一个都没有。
// 清单还没读到过（新装、没登录过）按「有」处理，老用户的默认不变。
function noCodeagentModels(dataDir, env = process.env) {
  try {
    if (require('./codeagent-pool').readRegistry(dataDir).accounts.length) return false;
    const models = require('./codeagent-models');
    const catalog = models.readModelCatalog(dataDir, { accountKey: 'personal' });
    const configDir = require('./codeagent-config').resolveCodeAgentConfig(env).configDir;
    // CodeAgent 的 settings.json 里自配了供应商模型：这些模型不经账号清单，serve 报空清单也照样能用，按「有」处理（窄复审 P2-2）。
    if (models.settingsProviderModels(configDir).length) return false;
    const empty = require('./codeagent-model-probe').readEmptyCatalog(require('./codeagent-pool').personalModelsFile(dataDir));
    if (empty && (!catalog || !(Date.parse(catalog.at) > Date.parse(empty.at)))) return true;
    if (!catalog) return false;
    const usable = models.modelOptions(dataDir, { configDir, accountKey: 'personal' });
    if (!usable.length) return true;
    const Q = require('./codeagent-quota');
    const avoid = Q.modelAvoidAll(dataDir).personal || {};
    return catalog.models.length > 0 && catalog.models.every(id => !!Q.modelAvoidEntry({ personal: avoid }, 'personal', id));
  } catch { return false; }
}

// 反代要不要常驻：8 项里任一项明确选了部门 key，或有一项没选过、按上面的规则默认用它。
// 只把论坛 / PPT 设成部门 key、助理仍是 CodeAgent 时也要常驻，否则网关上游没人提供。
function inUse(dataDir, options = {}) {
  try {
    const routes = require('./codeagent-assistant-route');
    let explicit = false, unpicked = false;
    for (const id of FEATURE_IDS) {
      const pref = routes.featurePreference(dataDir, id);
      if (!pref) unpicked = true;
      if (pref?.kind === KIND) explicit = true;
    }
    if (explicit) return availability(dataDir, options).available;
    return unpicked && autoDefault(dataDir, options);
  } catch { return false; }
}

// 一问以网关报错收场：取本机反代翻好的人话（「API 网关：…」），没翻过的按状态码套同一口径。
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

// 网关会话出错时一定给网关口径：failure() 认不出（没有状态码等）也给一行带原文摘要的说法，不落回 CodeAgent 的供应商卡或「未登录」。
function gatewayFailure(text) {
  const hit = failure(text);
  if (hit) return hit;
  const raw = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { line: `${LABEL}：${raw ? `网关报错（${raw}）` : 'Claude Code 没能连上部门网关'}，可以重试；仍不行请到设置 →「API 网关」检查 key。`, actions: ['retry'] };
}

module.exports = { KIND, LABEL, FEATURE_PURPOSES, FEATURE_IDS, launchValues, allowedSession, isGatewayChoice, resumeFields, availability, autoDefault, codeagentMissing, inUse, failure, gatewayFailure };
