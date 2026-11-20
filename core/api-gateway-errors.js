'use strict';

// 部门 API 网关（New API）报错 → 一句人话 + 修复按钮 + 打码后的网关原话（2026-11-20 B 线）。
// 设置页（保存、一键体检）和本机代理（core/company-proxy/gateway-provider.mjs）共用这一份口径。
// 依据：11-19 黄区实测坏 key 401「Invalid token」、不存在的模型 503 model_not_found；
// New API 的报错原文（中英两种）见其 i18n：无效的令牌 / 额度不足 / 无可用渠道（No available channel for model X under group Y）/
// 该令牌无权使用模型；上下文超长是后端 vLLM 的原话（maximum context length is N tokens）。

// 按钮：界面按 id 接线。
const ACTIONS = Object.freeze({
  'switch-model': '换个模型',
  rekey: '重新填 key',
  'group-help': '分组说明',
  tutorial: '打开教程',
  retry: '重试',
  compact: '压缩上下文后重发',
});
// 教程页是公司内部站点，只放成员版；公开版导出时剥掉，没有教程地址就不出「打开教程」按钮。
const TUTORIAL_URL = '';

// 本机代理翻好的报错统一用这个前缀开头，renderer/turn-error-help.js 按它认。界面只写「API 网关 / 网关」，不写平台名（公开版用词合规）。
const ERROR_PREFIX = 'API 网关：';

// 网关原话打码：key、长令牌、长数字（工号 / 手机号）、邮箱、地址、IP。只留前 200 字。
function redact(text) {
  return String(text || '')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-<已隐去>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <已隐去>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<邮箱已隐去>')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<地址已隐去>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<地址已隐去>')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, m => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<已隐去>' : m))
    .replace(/(?<![A-Za-z0-9_])[A-Za-z]?\d{7,}(?![A-Za-z0-9_])/g, '<编号已隐去>')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}
const withTutorial = actions => (TUTORIAL_URL ? actions : actions.filter(a => a !== 'tutorial'));

// 网关 JSON 错误里可读的那句话与错误码。
function parseBody(body) {
  const raw = String(body || '');
  try {
    const json = JSON.parse(raw);
    const e = json?.error && typeof json.error === 'object' ? json.error : json;
    const message = [e?.message, json?.message, typeof json?.error === 'string' ? json.error : '', json?.msg, json?.detail].find(v => typeof v === 'string' && v.trim()) || '';
    const code = [e?.code, e?.type, json?.code].find(v => typeof v === 'string' && v.trim()) || '';
    return { message, code };
  } catch { return { message: /^\s*</.test(raw) ? '' : raw.slice(0, 400), code: '' }; }
}

const RE = {
  badKey: /invalid[_ ]?(api[_ ]?)?(token|key)|无效的令牌|令牌(已过期|已被禁用|不存在|无效)|token (has )?(expired|is disabled|not found)|unauthori[sz]ed|未提供令牌/i,
  quota: /额度|quota|余额|insufficient|balance|pre_consume|签到/i,
  noChannel: /no available channel|无可用渠道|没有可用(的)?渠道|渠道不可用|under group|分组\s*\S+\s*下/i,
  forbidden: /无权|没有权限|权限不足|白名单|whitelist|not allowed|forbidden|no access|access denied|permission|模型无权限|not (in|on) (the )?allow/i,
  modelGone: /model_not_found|model .*(does not exist|not found|not exist)|模型(不存在|已下线|下线|未找到)|unknown model|no such model/i,
  context: /maximum context length|context[_ ]length[_ ]exceeded|上下文.{0,6}(超|过长|超出|超过)|prompt is too long|too many (input )?tokens|input .*too long|exceeds? .*(context|max(imum)? (input|model) length)|max_model_len/i,
  rate: /rate limit|too many requests|限流|请求过于频繁|并发/i,
};

// 从「under group free」「当前分组 free 下」里取分组名。
function groupFromText(text) {
  const m = /under group\s+["'`]?([A-Za-z0-9_-]+)/i.exec(text) || /分组\s*["'`「]?([A-Za-z0-9_-]+)["'`」]?\s*下/.exec(text);
  return m ? m[1] : '';
}

// status：HTTP 状态码；networkCode：'unreachable' | 'timeout'（没拿到响应时）。
// ctx：{ model, group, usable: [这把 key 能用的模型名], known: [目录里的全部模型名], waitedMs }，有就把话说具体。
// 返回 { code, title, message, actions, retry, detail, status（给客户端的状态码） }。
function classify({ status = 0, body = '', networkCode = '', model = '', group = '', usable = [], known = [], waitedMs = 0 } = {}) {
  const { message: raw, code: rawCode } = parseBody(body);
  const text = `${rawCode} ${raw}`;
  const detail = redact(raw || rawCode || (status ? `HTTP ${status}` : ''));
  const others = (usable || []).filter(id => id && id !== model).slice(0, 6);
  const otherText = others.length ? `能用的有：${others.join('、')}。` : '';
  const named = model ? `「${model}」` : '这个模型';
  const out = (code, title, message, actions, retry, clientStatus) => ({ code, title, message, actions: withTutorial(actions), retry, detail, status: clientStatus });

  if (networkCode === 'timeout') {
    return out('timeout', '网关太久没开始回答', `${named}等了 ${Math.max(1, Math.round(waitedMs / 1000))} 秒还没开始回答，网关可能正在排队。可以稍后重发，或换个首字更快的模型。${otherText}`,
      ['retry', 'switch-model'], true, 504);
  }
  if (networkCode === 'unreachable') {
    return out('unreachable', '连不上网关', '连不上网关：电脑多半不在公司内网（例如在家没连 VPN），或网关地址不对。连上内网后重试。', ['retry', 'tutorial'], true, 502);
  }
  // 额度在前：New API 额度不足有时回 403。
  if (RE.quota.test(text) && !RE.context.test(text)) {
    return out('quota', '额度不足', `这把 key 的额度用完了。free 分组可以在网关模型服务网页的个人资料里签到续上额度；也可以找管理员加额度。`, ['tutorial', 'group-help', 'rekey'], false, 400);
  }
  if (status === 401 || RE.badKey.test(text)) {
    return out('bad_key', 'key 无效', 'key 无效：网关不认这个 key（复制不完整、已过期或被禁用）。请重新粘贴 key（要复制完整，通常以 sk- 开头）再试。', ['rekey', 'tutorial'], false, 401);
  }
  // New API 对目录里根本没有的模型也回「无可用渠道」：目录里没有它就按「已下线」讲。
  const gone = model && known?.length && !known.includes(model);
  if (RE.noChannel.test(text) && !gone) {
    const g = groupFromText(text) || group;
    return out('no_channel', `这个模型不对你的${g ? ' ' + g + ' ' : ''}分组开放`,
      `${named}不对你的${g ? ' ' + g + ' ' : ''}分组开放（网关说这个分组下没有可用渠道），换个模型就行。${otherText}`, ['switch-model', 'group-help'], false, 400);
  }
  if (status === 403 || RE.forbidden.test(text)) {
    return out('forbidden', '没有这个模型的权限', `这把 key 没有${named}的使用权限（不在白名单里或分组不开放）。${otherText || '换个模型，或找管理员开通。'}`, ['switch-model', 'group-help', 'rekey'], false, 403);
  }
  if (RE.context.test(text)) {
    return out('context_too_long', '对话太长了', `这轮对话超出了${named}的上下文上限。请压缩上下文（Claude Code 输入 /compact，Codex 输入 /compact）或新开会话，也可以换个上下文更长的模型。`,
      ['compact', 'switch-model'], false, 400);
  }
  // 404 只在网关原话点名了这个模型时才算「模型下线」：不带模型名的 404 多半是地址不对（少了 /v1），留给 http_404，
  // 自有接口「测试连接」靠它自动补 /v1（main/ipc/config-handlers.js）。
  const namesModel = !!model && text.toLowerCase().includes(String(model).toLowerCase());
  if (gone || RE.modelGone.test(text) || (status === 404 && namesModel)) {
    return out('model_gone', '网关上没有这个模型', `网关上已经没有${named}（可能已下线换新）。请换个模型；一键体检会刷新最新的模型表。${otherText}`, ['switch-model'], false, 400);
  }
  if (status === 429 || RE.rate.test(text)) {
    return out('rate_limited', '网关限流了', '网关限流了：请求太密，请稍等半分钟再发。', ['retry'], true, 429);
  }
  if (status >= 500) {
    return out('server', '网关出错了', `网关返回 HTTP ${status}，多半是网关自己的问题，稍后重试；一直不行可以换个模型。${otherText}`, ['retry', 'switch-model'], true, status);
  }
  return out(status ? 'http_' + status : 'unknown', '网关报错', `网关返回${status ? ' HTTP ' + status : '了错误'}。详情里是网关原话。`, ['retry', 'tutorial'], status >= 500, status >= 400 && status < 600 ? status : 502);
}

// 给 CLI 看的一句话（会话里只显示文字）：人话 + 网关原话（打码）。
function sentence(result) {
  return `${ERROR_PREFIX}${result.message}${result.detail && !result.message.includes(result.detail) ? `（网关原话：${result.detail}）` : ''}`;
}

module.exports = { ACTIONS, TUTORIAL_URL, ERROR_PREFIX, redact, parseBody, classify, sentence, groupFromText };
