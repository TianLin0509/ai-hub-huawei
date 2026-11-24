'use strict';

// 提示闸门：Hub 里所有「要不要打扰用户」的提示（会话提示条、错误轻提示、常驻提示）都先过这里，一处决定显示还是只进日志。
// 2026-11-24 盘点：输入框上方和会话里的提示绝大多数是虚警（自动重试中、已自动换路、探测失败、后台任务失败、同一原因重复）。
// 规则只管「显示与否」，不改报错的检测逻辑；被拦下的照样写进日志（window-events.log 的 notice-muted 行），诊断包里看得到。
//
// 留下来的只有两类：
//   1. 这一轮真失败了、用户不动手就继续不了（登录失效、额度用完、权限被拒、上下文太长、发送失败）；
//   2. 用户的数据有风险（保存失败、会丢改动）。
// 用户自己点的按钮没成功（kind: 'user-action'）也照常显示：那是他刚做的事的直接结果。

// 显式分类：发出方知道自己是什么，就带 noticeKind；不带时按文字归类。
const SHOW_KINDS = new Set(['blocking', 'data-risk', 'user-action']);
const MUTE_KINDS = new Set(['recovered', 'auto', 'probe', 'background', 'info']);

// 文字归类（发出方没带 noticeKind 时）。先认「必须让用户知道」的，再认「可以静默」的；都不像的按级别：error 显示、其余静默。
const BLOCKING_TEXT = /登录(?:已)?(?:过期|失效)|重新登录|未登录|需要登录|请登录|\b401\b|额度(?:已)?用完|额度不足|余额不足|quota exceeded|exceeded your .{0,20}quota|上下文太长|prompt is too long|\b413\b|请求太大|权限被拒|没有权限|无权限|拒绝访问|未发送|没发出去|还没发出|未发出|发送失败|没有发出|没能发出|未创建|请手动|撤销|启动失败|起不来|无法启动|打不开/i;
const DATA_RISK_TEXT = /保存失败|没保存|未保存|写入失败|会丢|丢失|数据(?:文件)?损坏|恢复失败/;
const MUTE_TEXT = new RegExp([
  '自动重试', '正在重试', '重试中', '稍后自动', '正在重连', '重新连接中', '正在连接', '正在恢复',
  '已恢复', '已自动', '自动换', '自动切', '已切换到', '已换成', '改走', '退回个人号', '换号', '已换号', '已解除',
  '已休眠', '低开销模式', '内存占用', '版本', '体检', '探测', '检测到新', '可选', '不影响',
].join('|'));

const DEDUPE_MS = 30 * 60 * 1000;

// 错误码要留在原因里：401 和 403、500 是不同的事，不能互相去重。
const ERROR_CODE = /\b(?:HTTP|API Error|Error|error|status|code|状态码|错误码?)\s*[:：]?\s*(\d{3})\b|\b(E[A-Z]{3,}|ERR_[A-Z_]+|[A-Z][A-Z]+(?:_[A-Z]+)+)\b/g;
function normalizeReason(text) {
  const raw = String(text || '');
  const codes = [];
  for (const m of raw.matchAll(ERROR_CODE)) codes.push(m[1] || m[2]);
  // 只抹掉「第 2 次」「3/5」「12 秒」「15:10」这类每次都变的计数和时间，其余原文保留（账号、模型、资源名都在原文里）。
  const body = raw
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, '#:#')
    .replace(/\d+\s*\/\s*\d+/g, '#/#')
    .replace(/第\s*\d+\s*次|attempt\s*\d+|\d+(?:\.\d+)?\s*(?:秒|分钟|小时|ms\b|s\b|min\b)/gi, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
  return codes.length ? `${body} [${[...new Set(codes)].join(',')}]` : body;
}

function classify(notice = {}) {
  const kind = String(notice.noticeKind || '');
  if (SHOW_KINDS.has(kind) || MUTE_KINDS.has(kind)) return kind;
  const text = String(notice.message || '');
  // 带按钮的（登录、打开后台确认信任）是要用户动手的，照常显示。
  if (notice.action) return 'blocking';
  if (DATA_RISK_TEXT.test(text)) return 'data-risk';
  if (BLOCKING_TEXT.test(text) && !/已自动|自动重试|稍后自动|已恢复|暂用/.test(text)) return 'blocking';
  if (MUTE_TEXT.test(text)) return 'auto';
  return notice.level === 'error' ? 'blocking' : 'info';
}

// 一个渲染进程一个闸门。log(event, detail) 接日志；now() 方便测试。
function createNoticeGate({ log = () => {}, now = () => Date.now(), dedupeMs = DEDUPE_MS } = {}) {
  const shown = new Map(); // `${scope}|${reason}` → 上次显示时间
  const pending = new Map(); // 等待自动恢复的提示：key → timer
  const muted = []; // 最近 100 条被拦下的（诊断用）

  function record(notice, why) {
    const entry = { at: now(), why, kind: notice.noticeKind || '', level: notice.level || '', sessionId: notice.sessionId || '', message: String(notice.message || '').slice(0, 300) };
    muted.push(entry);
    if (muted.length > 100) muted.shift();
    try { log('notice-muted', entry); } catch {}
  }

  function reasonKey(notice) {
    return `${notice.sessionId || '-'}|${notice.reasonKey || normalizeReason(notice.message)}`;
  }

  // decide：返回 { show, kind, why }。显示时同时记下，30 分钟内同会话同原因不再显示。
  function decide(notice = {}) {
    try { return decideInner(notice || {}); }
    catch { return { show: true, kind: 'blocking', why: 'gate-error' }; } // 闸门出错照常显示，不吞真失败
  }
  function decideInner(notice) {
    const kind = classify(notice);
    if (!String(notice.message || '').trim()) return { show: false, kind, why: 'empty' };
    if (MUTE_KINDS.has(kind)) { record(notice, kind); return { show: false, kind, why: kind }; }
    if (kind !== 'user-action') {
      const key = reasonKey(notice);
      const last = shown.get(key);
      if (last && now() - last < dedupeMs) { record(notice, 'duplicate'); return { show: false, kind, why: 'duplicate' }; }
      shown.set(key, now());
    }
    return { show: true, kind, why: kind };
  }

  // 自动可恢复的错误：先等 graceMs，期间 resolve(key) 就什么都不显示；到时仍没恢复才交给 decide 再显示一行。
  function defer(key, notice, show, graceMs = 20000) {
    if (pending.has(key)) return;
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      const verdict = decide({ ...notice, noticeKind: 'blocking' }); // 宽限期过了还没恢复，就是真失败
      if (verdict.show) show();
    }, graceMs));
  }
  function resolve(key) {
    const timer = pending.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    pending.delete(key);
    record({ message: key }, 'recovered');
    return true;
  }
  // 原因解除（例如重新登录成功）后，同一原因再次发生要能再提示一次。
  function forget(sessionId, reason) {
    const prefix = `${sessionId || '-'}|`;
    for (const key of [...shown.keys()]) if (key.startsWith(prefix) && (!reason || key === prefix + reason)) shown.delete(key);
  }

  return { decide, defer, resolve, forget, recentMuted: () => muted.slice() };
}

// 自动换号的进度（正在确认额度、正在切换、已切换并继续）不进状态行，账号下拉悬停照样看得到；
// 换不了（没有可用账号、出错要核对）和用户自己点的手动换号才显示。
const SWITCH_STATUS_SILENT = new Set(['checking', 'switching', 'switched', 'continued', 'cancelled', 'usage-unavailable']);
function switchStatusVisible(status) {
  return !!(status && status.message && !SWITCH_STATUS_SILENT.has(status.status));
}

module.exports = { createNoticeGate, switchStatusVisible, classify, normalizeReason, SHOW_KINDS, MUTE_KINDS, DEDUPE_MS };
