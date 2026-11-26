'use strict';
// 跳转后台 · 先诊断（2026-11-26）：点「后台」先给一句白话自检结论——最可能的原因、你可以怎么做、一键修复按钮，
// 再决定进不进后台。原因分类不另起一套：报错文字先过已有的已知问题表（core/known-issues.js，一键动作由
// renderer/hub-error-card.js 的 known:* 统一执行），认不出的再按常见关键词归类，最后看后台会话自身状态。
// 纯函数，不读写任何东西；诊断信息（给同事转发）在这里脱敏拼好。

const { matchKnownIssue } = require('../core/known-issues');

// 原因类别：id → 白话标题、能力缺失还是故障。capability=true 表示「没有这个能力，需要先配置」，界面用中性色而不是红色。
const CAUSES = {
  'no-engine': { title: '需要先配置：没有可用的 CodeAgent 或 API', capability: true, level: 'warn' },
  'no-permission': { title: '账号没有权限（没开通模型或账号不可用）', level: 'error' },
  'auth-expired': { title: '登录或授权过期了', level: 'error' },
  network: { title: '网络或公司出口不通', level: 'error' },
  'session-failed': { title: '后台会话启动失败或出错了', level: 'error' },
  'session-gone': { title: '后台会话已关闭', level: 'warn' },
  stuck: { title: '后台可能卡住了', level: 'warn' },
  quota: { title: '额度用完或被限流', level: 'error' },
  outdated: { title: '版本过旧，需要更新', level: 'warn' },
  'waiting-input': { title: '后台在等你确认', level: 'warn' },
  unknown: { title: '后台状态待确认（可能断连）', level: 'warn' },
  'not-started': { title: '还没有后台会话', level: 'info' },
  dormant: { title: '后台会话在休眠', level: 'info' },
  'gateway-config': { title: '部门 API 网关的 key 或地址不对', level: 'error' },
  'model-config': { title: '模型或供应商设置不对', level: 'error' },
  other: { title: '出错了，Hub 暂时认不出原因', level: 'error' },
  ok: { title: '后台正常', level: 'ok' },
};

// 已知问题表的条目 → 原因类别。
const KNOWN_TO_CAUSE = {
  'codeagent-missing': 'no-engine', 'cli-missing': 'no-engine',
  'codeagent-no-model': 'no-permission', 'codeagent-account-unusable': 'no-permission', 'account-unavailable': 'no-permission',
  'welink-login-expired': 'auth-expired',
  'welink-proxy-unreachable': 'network', 'company-proxy-not-ready': 'network', 'company-proxy-failed': 'network', 'cert-intercepted': 'network',
  'codeagent-quota': 'quota',
  'codeagent-outdated': 'outdated', 'update-corrupt': 'outdated', 'update-blocked': 'outdated',
};

// 分身第 1 批已有的结构化失败（core/avatar/agent-session.js normalizeFailure）→ 原因类别。按分身负责人口径：
// 网关 401/405 归网关设置，不归 CodeAgent；WeLink 过期不归模型鉴权；模型 429 不许诺自动重试（原文 headline 自己写清）。
const AVATAR_FAILURE_TO_CAUSE = {
  welink_rate_limit: 'quota', model_rate_limit: 'quota',
  welink_expired: 'auth-expired', agent_not_logged_in: 'auth-expired',
  gateway_401: 'gateway-config', gateway_405: 'gateway-config',
  provider_405: 'model-config', model_unavailable: 'no-permission',
  read_failed: 'other', tick_error: 'other',
};

// 已知问题表认不出时的兜底关键词（顺序即优先级）。只用来归类，原文不展示在按钮提示里。
const KEYWORDS = [
  ['quota', /\b429\b|rate.?limit|限流|额度(?:不足|用完|耗尽)|quota|too many requests|token\s*消耗/i],
  ['no-permission', /\b403\b|forbidden|permission denied|无权限|没有权限|未授权使用|没有可用(?:的)?模型|no (?:available )?model/i],
  ['auth-expired', /\b401\b|unauthori[sz]ed|登录(?:已)?过期|授权过期|token (?:expired|invalid)|请(?:重新)?登录|not logged in/i],
  ['network', /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|socket hang up|network|网络(?:不通|异常|错误)|连不上|超时/i],
  ['no-engine', /未找到.{0,12}(?:CodeAgent|CLI)|CodeAgent\s*未安装|没有可用的(?:引擎|回答通道)|spawn .*ENOENT/i],
  ['outdated', /版本(?:较旧|过旧|太旧)|请(?:先)?(?:更新|升级)/],
  ['session-failed', /启动(?:失败|异常)|exited|退出码|crash|闪退/i],
];

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

// 脱敏：用户目录里的用户名、邮箱、工号样式、密钥样式、链接参数、长串编号；再截短。
function redact(text, max = 160) {
  let s = String(text || '');
  try { s = require('../core/hub-feedback').redact(s); } catch { /* 没有 node 环境时只用下面的规则 */ }
  // 整段 Cookie / Set-Cookie 值、JSON 里带引号的凭据字段（先于折叠空白，按行处理）。
  s = s.replace(/\b(Set-Cookie|Cookie)\s*[:=][^\r\n]*/gi, '$1: <已隐去>')
    .replace(/(["'])(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|cookie|authorization|session(?:id)?|sid)\1\s*:\s*(["'])[^"'\r\n]*\3/gi, '$1$2$1:$3<已隐去>$3')
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, '<令牌已隐去>');
  s = s.replace(/\s+/g, ' ').trim();
  // 用户目录：用户名可能带空格，到下一个分隔符为止；UNC 共享路径整段隐去。
  s = s.replace(/\\\\[^\\\s"'<>]+\\[^"'<>\r\n]*/g, '<共享路径>')
    .replace(/([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/"'<>]+(?=[\\/])/gi, '$1<用户>')
    .replace(/([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\s"'<>]+/gi, '$1<用户>')
    .replace(/(\/(?:home|Users)\/)[^/\s"'<>]+/g, '$1<用户>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<邮箱>')
    .replace(/\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<密钥>')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '<凭据>')
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|cookie|authorization)\b\s*[:=]\s*\S+/gi, '$1=<已隐去>')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1?<参数已隐去>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<IP>')
    .replace(/(?<![A-Za-z0-9_])[A-Za-z]{0,2}\d{6,}(?![A-Za-z0-9_])/g, '<工号>')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<长串>');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 主函数。input：
//   from/label：入口；sessionId；runtime：会话状态（同 backstage-jump 的 __hubSessionRuntime，null=会话已关闭）；
//   entry：入口自己报的 { error, area, capability: { codeagent: true|false|null, api: bool } }；
//   env：{ update: { version } 有新版本时 }；canRecreate：入口能否重开会话。
function diagnoseBackstage({ sessionId = '', runtime, entry = {}, env = {}, canRecreate = false, now = Date.now(), stuckMs = 90000 } = {}) {
  const actions = [];
  // 已保存过部门 key（env.gatewayKey）：「打开自有 API」换成「改用部门 key」并排第一（沿用 m3/R45 口径）。
  const add = (label, act, extra = {}) => {
    if (act === 'known:open-company-api' && env.gatewayKey) { if (!actions.some(a => a.act === 'hub-bs:use-gateway')) actions.unshift({ label: '改用部门 key', act: 'hub-bs:use-gateway' }); return; }
    if (label && act && !actions.some(a => a.act === act)) actions.push({ label, act, ...extra });
  };
  const GATEWAY_WRONG = ['known:codeagent-personal-login', 'known:proxy-restart', 'known:welink-login'];
  // 入口口径（会议）：codeagentOnly 不给接 API / 装其他工具的引导；noSessionRestart 不给通用重启（入口有自己的恢复）；
  // recording 时不给会重启 Hub 的修复（会断采集），改提示会后再修；hint 是入口自己的修复路径。
  const make = (cause, text, todo) => {
    let list = actions;
    if (entry.channel === 'gateway' && ['auth-expired', 'network', 'no-permission', 'quota', 'gateway-config'].includes(cause)) {
      list = list.filter(a => !GATEWAY_WRONG.includes(a.act) && a.act !== 'known:open-accounts');
      if (!list.some(a => a.act === 'hub-bs:gateway-settings')) list.unshift({ label: '打开网关设置', act: 'hub-bs:gateway-settings' });
    }
    if (entry.codeagentOnly) list = list.filter(a => !['known:open-company-api', 'hub-bs:use-gateway'].includes(a.act));
    if (entry.noSessionRestart) list = list.filter(a => a.act !== 'known:session-restart');
    let note = todo;
    if (entry.recording && list.some(a => /^known:update-/.test(a.act))) { list = list.filter(a => !/^known:update-/.test(a.act)); note = `${note || ''}更新要重启 Hub，会打断正在录的会议，会后再更新。`; }
    if (entry.hint && cause !== 'ok' && cause !== 'not-started' && cause !== 'dormant') note = `${note ? note + ' ' : ''}${entry.hint}`;
    return { cause, ...CAUSES[cause], text, todo: note, actions: list, canEnter: !!sessionId && !!runtime };
  };
  const cap = entry.capability || {};
  const err = String(entry.error || '').trim();

  // 1. 没有这个能力：既没装 CodeAgent 也没接 API —— 不是故障，是需要先配置。
  if (cap.codeagent === false && !cap.api) {
    add('一键安装 CodeAgent', 'known:codeagent-oneclick'); add('接部门 API', 'known:open-company-api');
    if (entry.codeagentOnly) return make('no-engine', '这台电脑上没检测到可用的 CodeAgent，这个功能没有可用的回答引擎。', '一键安装 CodeAgent，装好后再试一次。');
    return make('no-engine', '这台电脑上没检测到 CodeAgent，也没接部门 API 网关，助理和分身没有可用的回答通道，所以不会有后台会话。', '装好 CodeAgent（一键安装），或接上部门 API 网关；任选其一，配好后直接再问一次即可。');
  }
  // 2·网关：助理已按部门 API 网关口径归好类（core/api-gateway-errors.js）——直接用它的标题，修复指向网关设置。
  const g = entry.gatewayError;
  if (g && (g.code || g.title)) {
    const cause = { quota: 'quota', bad_key: 'gateway-config', method_not_allowed: 'gateway-config', unreachable: 'network', timeout: 'network', no_permission: 'no-permission', model_not_found: 'model-config' }[g.code] || 'gateway-config';
    add('打开网关设置', 'hub-bs:gateway-settings');
    return make(cause, String(g.title || CAUSES[cause].title), String(g.message || '').slice(0, 120) || '到网关设置里核对 key、地址和模型，再重试。');
  }
  // 2a. 入口自带结构化失败（分身）：直接用它的归类和原话，修复按钮就在入口自己的报错条上，这里只指路，不另给按钮，免得口径打架。
  const f = entry.failure;
  if (f && (f.code || f.headline)) {
    const cause = AVATAR_FAILURE_TO_CAUSE[f.code] || 'other';
    const labels = (f.actions || []).map(a => a && a.label).filter(Boolean);
    return make(cause, String(f.headline || CAUSES[cause].title), labels.length ? `在页面上的报错条里点「${labels.join('」或「')}」处理；${f.retryable && f.retryAfterMs ? '它也会自己按时重试。' : '处理完再试一次。'}` : '按页面报错条上的说明处理；看不懂就点「复制诊断信息」发给维护人。');
  }
  // 2. 入口自己报了错：先过已知问题表，再按关键词归类。
  if (err) {
    const known = matchKnownIssue({ area: entry.area || 'codeagent', title: err, details: err }) || matchKnownIssue({ title: err, details: err });
    if (known) {
      const cause = KNOWN_TO_CAUSE[known.id] || 'other';
      if (known.action) add(known.action.label, known.action.act);
      for (const more of known.more || []) add(more.label, more.act);
      if (cause === 'session-failed' || cause === 'other') add('重启后台会话', 'known:session-restart', { needsSession: true });
      return make(cause, known.title || CAUSES[cause].title, known.fix);
    }
    const hit = KEYWORDS.find(([, re]) => re.test(err));
    const cause = hit ? hit[0] : 'other';
    const todo = {
      quota: '到「账号」页换一个还有额度的号，或稍后再试；对话不会丢。',
      'no-permission': '到「账号」页换个有权限的号，或找部门负责人开通模型权限；也可以接部门 API 先用起来。',
      'auth-expired': '重新登录一次（CodeAgent 个人账号或 WeLink 扫码），再点「重试」。',
      network: '确认连着公司内网或 VPN；在「网络」里重测一次出口，通了再重试。',
      'no-engine': '装好 CodeAgent 或接上部门 API，再问一次。',
      outdated: '到「设置 › 检查更新」更新到最新版（从公司内源下载）。',
      'session-failed': '先「重启后台会话」；还不行就进后台看最后几行输出，或一键反馈。',
      other: '进后台看看它停在哪一步；看不懂就点「复制诊断信息」发给维护人，或一键反馈。',
    }[cause];
    const fixes = {
      quota: [['打开账号页', 'known:open-accounts']], 'no-permission': [['打开账号页', 'known:open-accounts'], ['接部门 API', 'known:open-company-api']],
      'auth-expired': [['个人账号重新登录', 'known:codeagent-personal-login']], network: [['重新启动模型通道', 'known:proxy-restart']],
      'no-engine': [['一键安装 CodeAgent', 'known:codeagent-oneclick'], ['接部门 API', 'known:open-company-api']], outdated: [['检查更新', 'known:update-check']],
    }[cause] || [];
    for (const [label, act] of fixes) add(label, act);
    if (sessionId && runtime && ['session-failed', 'other', 'network', 'auth-expired'].includes(cause)) add('重启后台会话', 'known:session-restart', { needsSession: true });
    const why = {
      quota: '最近一次请求被拒：账号额度用完，或请求太频繁被限流了。',
      'no-permission': '最近一次请求被拒：这个账号没有对应模型的权限，或账号暂时不可用。',
      'auth-expired': '最近一次请求没通过身份校验：登录或授权过期了。',
      network: '最近一次请求没连上：网络或公司出口不通（超时、连接被拒）。',
      'no-engine': '没找到可用的回答通道（CodeAgent 没装或没找到）。',
      outdated: '报错提示版本过旧，需要更新。',
      'session-failed': '后台会话启动失败或中途退出了。',
      other: '最近一次请求出错了，Hub 认不出具体原因。',
    }[cause];
    return make(cause, why, todo);
  }
  // 3. 看后台会话自己的状态。
  if (!sessionId) return make('not-started', '这个功能现在还没有后台会话：它在处理请求时才会起会话，这是正常的。', canRecreate ? '可以直接去用（问一句、点一下），会话起来后这里就能跳过去；也可以点「重新打开」先把会话起好。' : '直接去用（问一句、点一下），会话起来后这里就能跳过去。');
  if (!runtime) {
    return make('session-gone', '这个入口记着的后台会话已经关了（可能被自动轮换或手动关闭）。', canRecreate ? '点「重新打开」恢复或新开一个，再进后台。' : '再用一次这个功能会自动起新会话。');
  }
  const state = runtime.state;
  if (state === 'failed' || state === 'interrupted') {
    add('重启后台会话', 'known:session-restart', { needsSession: true });
    return make('session-failed', state === 'failed' ? '后台会话报错停下了。' : '后台会话这一轮被中断了。', '先「重启后台会话」；或进后台看最后几行输出找原因。');
  }
  if (state === 'running' && runtime.lastOutputAt > 0 && now - runtime.lastOutputAt >= stuckMs) {
    add('重启后台会话', 'known:session-restart', { needsSession: true });
    return make('stuck', `后台在运行，但已经 ${seconds(now - runtime.lastOutputAt)}没有新输出，可能卡在某一步（比如等网络、等授权确认）。`, '先进后台看它停在哪一行；确实不动了再「重启后台会话」。');
  }
  if (state === 'waiting') return make('waiting-input', '后台会话停在一个需要你确认或选择的地方。', '进后台，按终端里的提示选一下或回车确认。');
  if (state === 'dormant') return make('dormant', '后台会话在休眠（省资源），没有在跑。', '进后台会自动唤醒它。');
  if (state === 'unknown') {
    add('重启后台会话', 'known:session-restart', { needsSession: true });
    return make('unknown', '暂时确认不了后台是否还在运行，可能断连或状态过期。', '进后台看一眼；先别重复发送同一条请求。');
  }
  if (env.update?.version) add(`更新到 v${env.update.version}`, 'known:update-check');
  return make('ok', state === 'running' || state === 'starting' ? '后台正在处理，有新输出。' : '后台会话空闲，没有发现问题。', env.update?.version ? `可以进后台看它在做什么。另外有新版本 v${env.update.version}（公司内源），有空可以更新。` : '可以进后台看它在做什么。');
}

// 最近错误只给「类别 + 错误码」，不带报错原文：原文可能夹着模型输出或业务正文（例如 JSON 解析错误会带出样本），
// 脱敏正则挡不住正文，所以可转发的诊断一律走白名单。原文留在本机页面和日志里。
function errorCodes(text) {
  const t = String(text || ''), codes = [];
  const push = v => { if (v && !codes.includes(v) && codes.length < 4) codes.push(v); };
  for (const m of t.matchAll(/\b(?:HTTP|status|code|Error)[\s:=]*([1-5]\d{2})\b/gi)) push(m[1]);
  for (const m of t.matchAll(/\b([1-5]\d{2})\s+(?:Unauthorized|Forbidden|Too Many Requests|Not Found|Method Not Allowed|Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error)\b/gi)) push(m[1]);
  for (const m of t.matchAll(/\b(E[A-Z]{3,}|ERR_[A-Z_]{3,})\b/g)) push(m[1]);
  for (const m of t.matchAll(/(?:退出码|exit code)[\s:：]*(-?\d{1,4})/gi)) push('exit ' + m[1]);
  return codes;
}
function errorSummary(entry = {}, result) {
  const raw = String(entry.error || ''), f = entry.failure;
  if (!raw && !f) return '无';
  const known = raw ? (matchKnownIssue({ area: entry.area || 'codeagent', title: raw, details: raw }) || matchKnownIssue({ title: raw, details: raw })) : null;
  const parts = [];
  if (result && result.cause && result.cause !== 'ok') parts.push(`类别 ${result.cause}`);
  if (f && f.code) parts.push(`失败码 ${String(f.code).replace(/[^\w-]/g, '').slice(0, 40)}`);
  if (known) parts.push(`已知问题 ${known.id}`);
  const codes = errorCodes(raw);
  if (codes.length) parts.push(`错误码 ${codes.join('/')}`);
  return parts.length ? `有（${parts.join('；')}）；原文留在本机，未复制` : '有（未归类）；原文留在本机，未复制';
}

const RUNTIME_TEXT = { running: '运行中', starting: '启动中', waiting: '等待操作', failed: '报错', interrupted: '已中断', dormant: '休眠', idle: '空闲', completed: '空闲', unknown: '待确认' };
const CAP_TEXT = v => (v === true ? '已检测到' : v === false ? '未检测到' : '未知');

// 一键复制的诊断信息：脱敏、不含对话内容；可以直接发给维护人或群里，也随「一键反馈」带走。
function diagnosticText({ version = '', label = '', sessionId = '', kind = '', runtime, entry = {}, result, now = Date.now(), stuckMs = 90000 } = {}) {
  const d = new Date(now), p = n => String(n).padStart(2, '0');
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const quiet = runtime?.state === 'running' && runtime.lastOutputAt > 0 ? now - runtime.lastOutputAt : 0;
  const sess = !sessionId ? '没有' : !runtime ? `已关闭（编号 ${sessionId.slice(0, 8)}）`
    : `${RUNTIME_TEXT[runtime.state] || runtime.state}${quiet >= stuckMs ? `，已 ${seconds(quiet)}没有新输出` : ''}${kind ? ` · ${kind}` : ''} · 编号 ${sessionId.slice(0, 8)}`;
  const cap = entry.capability || {};
  return [
    'AI HUB-H 诊断信息（已脱敏，不含对话内容）',
    `时间：${at}`,
    `版本：v${version || '未知'}`,
    `入口：${label || '未知'}`,
    `后台会话：${sess}`,
    `自检结论：${result ? `${result.title}（${result.cause}）` : '未做'}`,
    `最近错误：${errorSummary(entry, result)}`,
    `CodeAgent：${CAP_TEXT(cap.codeagent)}；部门 API：${cap.api ? '已接' : cap.api === false ? '未接' : '未知'}`,
  ].join('\n');
}

// 匿名计数（只在本机累计，不上传；上报开关待拍板）。字段：日期、原因类别、入口、次数——不含会话编号、错误原文、用户信息。
const STATS_KEY = 'hub:backstageDiag:counts';
function recordDiagnosis(storage, { cause, from, now = Date.now() } = {}) {
  if (!storage || !cause) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  let data;
  try { data = JSON.parse(storage.getItem(STATS_KEY) || 'null'); } catch { data = null; }
  if (!data || data.v !== 1) data = { v: 1, days: {} };
  const bucket = data.days[day] ||= {};
  const key = `${from || 'unknown'}:${cause}`;
  bucket[key] = (bucket[key] || 0) + 1;
  for (const old of Object.keys(data.days).sort().slice(0, -14)) delete data.days[old];   // 只留 14 天
  try { storage.setItem(STATS_KEY, JSON.stringify(data)); } catch { /* 存不下就不计 */ }
  return data;
}

module.exports = { CAUSES, KNOWN_TO_CAUSE, diagnoseBackstage, diagnosticText, redact, recordDiagnosis, STATS_KEY };
