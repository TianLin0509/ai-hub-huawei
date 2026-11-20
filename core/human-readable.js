'use strict';
// 结构化数据 → 人话（2026-11-20 用户反馈：卡片、桌宠、报错里不该让人读 JSON）。
// 只做显示投影：调用方保留原文，放进「查看原始数据」折叠里，排错照样能看全。
// 三个入口：
//   toolHumanSummary(activity)  卡片里的工具记录（主要是 MCP 工具，助理会话最多）
//   humanError(error)           报错弹窗/提示：去掉 Electron IPC 前缀，从错误对象里取出原因
//   humanFields(object)         原生授权卡、Codex /status 等命令结果：对象 → 几行「名称：值」

const IPC_PREFIX_RE = /Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/g;

function clip(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// 工具结果可能是 JSON 文本，也可能是 MCP 的 [{"type":"text","text":"{…}"}] 包装。
function parseJsonResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || !'{['.includes(text[0])) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (Array.isArray(value) && value.length && value.every(item => item && item.type === 'text' && typeof item.text === 'string')) {
    const inner = value.map(item => item.text).join('\n');
    return parseJsonResult(inner) || { __text: inner };
  }
  return value && typeof value === 'object' ? value : null;
}

function safeJson(value) {
  try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { return String(value); }
}

// ---------- 错误 ----------
const ERROR_KEYS = ['message', 'msg', 'error_msg', 'errorMessage', 'error', 'reason', 'detail', 'description', 'issue'];
function errorReason(value, depth = 0) {
  if (value == null || depth > 3) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonResult(value);
    if (parsed && !parsed.__text) return errorReason(parsed, depth + 1) || value;
    return value;
  }
  if (typeof value !== 'object') return String(value);
  for (const key of ERROR_KEYS) {
    const found = errorReason(value[key], depth + 1);
    if (found) return found;
  }
  if (value.code) return String(value.code);
  return '';
}

const KNOWN_ERRORS = [
  [/ENOENT|no such file/i, '找不到文件或目录，可能已被移动或删除'],
  [/EACCES|EPERM|permission denied|access is denied/i, '没有权限访问这个文件或目录'],
  [/EBUSY|resource busy/i, '文件正被别的程序占用'],
  [/ETIMEDOUT|timed? ?out/i, '等待超时'],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network error|socket hang up/i, '网络连不上'],
  [/insufficient[_ ]balance|\b402\b/i, '余额不足'],
  [/rate.?limit|too many requests|\b429\b|quota exceeded/i, '额度或频率到上限了'],
  [/unauthori[sz]ed|invalid api key|\b401\b|not logged in|login required/i, '没登录或凭证失效'],
];

// 返回 { text: 给人看的一句话, detail: 原文（只在和 text 不同时给） }
function humanError(error) {
  const raw = typeof error === 'string' ? error
    : error instanceof Error ? error.message
    : error && typeof error === 'object' ? (errorReason(error) || safeJson(error))
    : String(error ?? '');
  let text = String(raw).replace(IPC_PREFIX_RE, '');
  // 「同步失败：{"code":"ENOENT",…}」这类：前缀保留，JSON 换成里面的原因
  const brace = text.search(/[{[]/);
  if (brace >= 0) {
    const parsed = parseJsonResult(text.slice(brace));
    if (parsed) {
      const reason = parsed.__text || errorReason(parsed);
      const prefix = text.slice(0, brace).replace(/[：:\s]+$/, '');
      const known = KNOWN_ERRORS.find(([re]) => re.test(text));
      const said = known ? known[1] : clip(reason, 160);
      text = [prefix, said].filter(Boolean).join('：') || text;
    }
  }
  text = text.trim() || '操作没有完成';
  // 英文的原因（如 Insufficient Balance、ENOENT: no such file）换成中文说法；前面的中文前缀保留
  const tail = text.match(/^(.*：\s*)?([^一-龥]+)$/);
  if (tail) {
    const known = KNOWN_ERRORS.find(([re]) => re.test(tail[2]));
    if (known) text = `${tail[1] || ''}${known[1]}（${clip(tail[2], 60)}）`;
  }
  const original = typeof error === 'string' ? error : error instanceof Error ? error.message : safeJson(error);
  return { text, detail: original && original.trim() !== text ? original : '' };
}

function humanErrorText(error) { return humanError(error).text; }

// ---------- 工具记录 ----------
const TOOL_LABELS = {
  create_session: '开新会话', send_session: '发给会话', claim_session: '登记负责人', watch_session: '盯住会话',
  read_progress: '读进展卡', history_context: '查历史记录', learning_context: '查学习资料', list_sessions: '列出会话',
  account_status: '查账号额度', update_memory: '写长期备忘', update_front_rules: '改前台守则',
  add_memo: '记备忘', update_memo: '改备忘', list_memos: '看备忘', set_reminder: '设提醒', cancel_reminder: '取消提醒',
  list_reminders: '看提醒', publish_daily_brief: '登记日报', make_podcast: '做播客', list_podcasts: '看播客',
  workbench_status: '看工作台', dispatch_candidates: '挑派活对象', dispatch_to_assistant: '派给助理',
  message_assistant: '转告助理', list_tasks: '看任务单', session_evidence: '取会话证据',
};
// 服务名在标题里的写法：Hub 自己的助理工具不加前缀，其他 MCP 显示服务名
const SERVER_LABELS = { hub_assistant: '' };

function parseToolName(name) {
  const m = String(name || '').match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

const SUBJECT_KEYS = ['title', 'session', 'name', 'query', 'q', 'text', 'file'];
function toolSubject(input) {
  let value = input;
  if (typeof value === 'string') value = parseJsonResult(value) || {};
  if (!value || typeof value !== 'object') return '';
  for (const key of SUBJECT_KEYS) {
    if (typeof value[key] === 'string' && value[key].trim()) return clip(value[key], key === 'text' ? 40 : 60);
  }
  return '';
}

const SEND_STATUS = {
  ok: '已送达，回执已确认', confirmed: '已送达，回执已确认', delivered: '已送达',
  stuck: '已发出但没确认收到，可能卡在输入框', unconfirmed: '已发出，还没收到回执', failed: '没发出去',
};

function countLine(key, list) {
  const names = { tasks: '条任务', sessions: '个会话', accounts: '个账号', memos: '条备忘', reminders: '个提醒',
    podcasts: '期播客', candidates: '个候选', items: '项', questions: '个问题', sources: '条来源' };
  return names[key] ? `共 ${list.length} ${names[key]}` : '';
}

// 返回 null 表示不改（非 MCP 工具），否则
// { title, subject, tone: ok|warn|bad|'', statusText, lines[] }
function toolHumanSummary(activity) {
  if (!activity) return null;
  const parsedName = parseToolName(activity.name);
  if (!parsedName) return null;
  const { server, tool } = parsedName;
  const label = TOOL_LABELS[tool] || tool.replace(/_/g, ' ');
  const serverLabel = Object.prototype.hasOwnProperty.call(SERVER_LABELS, server) ? SERVER_LABELS[server] : server;
  const title = serverLabel ? `${serverLabel} · ${label}` : label;
  const subject = toolSubject(activity.input);
  const raw = typeof activity.result === 'string' ? activity.result : '';
  const base = { title, subject, tone: '', statusText: '', lines: [] };
  if (!raw) return base;

  const tooLong = raw.match(/^Error: result \(([\d,]+) characters/);
  if (tooLong) return { ...base, tone: 'ok', statusText: '结果很长', lines: [`结果有 ${tooLong[1]} 字，已存成文件，分段读取`] };
  const noTool = raw.match(/No such tool available:\s*([\w-]+)/);
  if (noTool) return { ...base, tone: 'bad', statusText: '没调成', lines: [`没有叫「${noTool[1]}」的工具`] };

  const data = parseJsonResult(raw);
  if (!data) return partialJsonSummary(raw, base);
  if (data.__text) return { ...base, lines: [clip(data.__text, 200)] };
  if (Array.isArray(data)) return { ...base, tone: 'ok', statusText: '完成', lines: [`返回 ${data.length} 项`] };

  const lines = [];
  const push = line => { if (line && !lines.includes(line)) lines.push(line); };
  let tone = 'ok', statusText = '完成';
  if (typeof data.error === 'string' || (data.error && typeof data.error === 'object')) {
    tone = 'bad'; statusText = '没做成';
    push(clip(errorReason(data.error) || safeJson(data.error), 200));
  } else if (data.ok === false) {
    tone = data.state === 'unknown' ? 'warn' : 'bad';
    statusText = data.state === 'unknown' ? '没确认送达' : '没做成';
    push(clip(errorReason({ message: data.message, reason: data.reason, issue: data.issue }), 200));
  }

  // 送达回执（开会话、发给会话、转告助理）
  const receipt = data.receipt && typeof data.receipt === 'object' ? data.receipt : null;
  if (receipt) {
    const send = SEND_STATUS[receipt.sendStatus] || SEND_STATUS[receipt.receipt?.status] || '';
    const tries = receipt.sendStatus === 'stuck' && Number(receipt.enterAttempts) > 1 ? `（补按 ${receipt.enterAttempts} 次回车）` : '';
    if (send) push(`任务${send}${tries}`);
    if (receipt.sendStatus === 'stuck' || data.state === 'unknown') { tone = 'warn'; statusText = '没确认送达'; }
  }
  const route = data.route && typeof data.route === 'object' ? data.route : null;
  if (route && (route.kind || route.model)) {
    const effort = {
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[route.effort] || route.effort || '';
    const kind = route.kind === 'codex' ? 'Codex' : route.kind === 'claude' ? 'Claude' : route.kind;
    lines.unshift(`会话已建好（${[kind, route.model, effort && effort + '强度'].filter(Boolean).join(' · ')}）`);
  }
  if (data.taskId) push(`任务单 ${data.taskId}${data.assistant ? ' · ' + data.assistant : ''}${data.newTask === false ? '（已有任务，追加）' : ''}`);
  if (typeof data.title === 'string' && !subject) push(`对象：${clip(data.title, 60)}`);
  if (typeof data.status === 'string' && !receipt) push(`状态：${clip(data.status, 40)}`);
  for (const key of ['note', 'message', 'summary', 'forYou']) {
    if (typeof data[key] === 'string' && data[key].trim()) { push(clip(data[key], 200)); break; }
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) push(countLine(key, value));
  }
  if (data.lowQuota === true) push('账号额度偏紧');
  if (tone === 'bad' && !lines.length) push('工具返回失败，原因见原始数据');
  return { ...base, tone, statusText, lines: lines.filter(Boolean).slice(0, 5) };
}

// 卡片恢复历史时只带结果开头一段（全文按需读），JSON 是半截的：用正则摘出成败和要点，不让半截 JSON 露出来。
function partialJsonSummary(raw, base) {
  let text = raw.trim();
  const wrapped = text.match(/^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/);
  if (wrapped) text = text.slice(wrapped[0].length).replace(/\\\\/g, '\u0000').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\u0000/g, '\\');
  if (!/^[{[]/.test(text)) return base;
  const str = key => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (!m) return '';
    try { return JSON.parse(`"${m[1].replace(/\\$/, '')}"`); } catch { return m[1]; }
  };
  const ok = text.match(/^\{\s*"ok"\s*:\s*(true|false)/);
  const error = str('error');
  const lines = [];
  let tone = '', statusText = '';
  if (error) { tone = 'bad'; statusText = '没做成'; lines.push(clip(error, 200)); }
  else if (ok) { tone = ok[1] === 'true' ? 'ok' : 'bad'; statusText = ok[1] === 'true' ? '完成' : '没做成'; }
  for (const key of ['note', 'message', 'summary', 'forYou']) { const v = str(key); if (v) { lines.push(clip(v, 200)); break; } }
  const list = text.match(/^\{[^[]*?"(tasks|sessions|accounts|memos|reminders|items)"\s*:\s*\[/);
  if (list) {
    const label = { tasks: '条任务', sessions: '个会话', accounts: '个账号', memos: '条备忘', reminders: '个提醒', items: '项' }[list[1]];
    const first = str('title');
    lines.push(`返回一组${label.replace(/^[条个项]/, '') || '结果'}${first ? '，第一项：' + clip(first, 50) : ''}`);
  }
  lines.push("结果较长，这里只摘要点，全文见原始数据");
  return { ...base, tone, statusText, lines: lines.slice(0, 5) };
}

// ---------- 对象 → 几行「名称：值」 ----------
const FIELD_LABELS = {
  command: '命令', description: '说明', file_path: '文件', path: '路径', url: '网址', query: '查询',
  pattern: '匹配', model: '模型', effort: '思考强度', approvalPolicy: '授权方式', sandbox: '沙箱', cwd: '工作目录',
  timeout: '最长等待', content: '内容', old_string: '原文', new_string: '改成', prompt: '提示',
  status: '状态', state: '状态', name: '名称', title: '标题', enabled: '启用', version: '版本',
  profile: '配置', tokenUsage: '上下文用量', total: '已用', contextWindow: '上限',
};
const VALUE_LABELS = {
  'on-request': '需要时问你', 'on-failure': '失败时问你', never: '从不问', untrusted: '除安全命令外都问',
  'workspace-write': '只能写工作目录', 'read-only': '只读', 'danger-full-access': '完全放开',
  ready: '就绪', idle: '空闲', failed: '失败', running: '运行中', completed: '完成', connected: '已连接', disconnected: '未连接',
  low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', true: '是', false: '否',
};
function formatValue(key, value) {
  if (value == null) return '';
  if (key === 'timeout' && Number.isFinite(Number(value))) {
    const ms = Number(value); return ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
  }
  if (Array.isArray(value)) {
    if (value.every(v => v == null || typeof v !== 'object')) return clip(value.join(' '), 160);
    return `${value.length} 项`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '无';
    return clip(keys.slice(0, 6).map(k => `${FIELD_LABELS[k] || k} ${formatValue(k, value[k]) || '—'}`).join('，'), 160);
  }
  const text = String(value);
  return VALUE_LABELS[text] || clip(text, 240);
}
// 返回 [[名称, 值], …]；最要紧的字段排前面，内部编号不显示
function humanFields(object, { max = 12 } = {}) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  const order = Object.keys(FIELD_LABELS);
  const keys = Object.keys(object).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const rows = [];
  for (const key of keys) {
    if (/^(?:_|sessionId$|threadId$|turnId$|id$|clientSubmissionId$)/.test(key)) continue;
    const value = formatValue(key, object[key]);
    if (value === '') continue;
    rows.push([FIELD_LABELS[key] || key, value]);
    if (rows.length >= max) break;
  }
  return rows;
}
const humanFieldsText = (object, options) => humanFields(object, options).map(([k, v]) => `${k}：${v}`).join('\n');

module.exports = { parseJsonResult, humanError, humanErrorText, toolHumanSummary, humanFields, humanFieldsText };

// Codex 原生命令（/status /mcp /hooks /usage …）的结果：先给几行人话，原始 JSON 放在后面的代码块里备查。
function humanCommandOutput(result) {
  if (result == null || typeof result !== 'object') return String(result ?? '');
  const lines = [];
  const list = Array.isArray(result) ? result : Array.isArray(result.data) ? result.data
    : Array.isArray(result.servers) ? result.servers : null;
  if (list) {
    lines.push(`共 ${list.length} 项`);
    for (const item of list.slice(0, 30)) {
      if (!item || typeof item !== 'object') { lines.push(`- ${clip(item, 120)}`); continue; }
      const name = item.name || item.title || item.id || item.command || '（未命名）';
      const state = item.status || item.state || (item.enabled === false ? '未启用' : item.enabled === true ? '已启用' : '');
      const note = item.description || item.error || '';
      lines.push(`- ${clip(name, 60)}${state ? ' · ' + clip(formatValue('status', state), 30) : ''}${note ? ' · ' + clip(errorReason(note) || note, 80) : ''}`);
    }
    if (list.length > 30) lines.push(`…另有 ${list.length - 30} 项`);
    const rest = { ...result }; delete rest.data; delete rest.servers; delete rest.nextCursor;
    const extra = Array.isArray(result) ? '' : humanFieldsText(rest);
    if (extra) lines.unshift(extra);
  } else {
    lines.push(humanFieldsText(result) || '（没有内容）');
  }
  return `${lines.join('\n')}\n\n原始数据（排错用）：\n\`\`\`json\n${safeJson(result)}\n\`\`\``;
}
module.exports.humanCommandOutput = humanCommandOutput;
