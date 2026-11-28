'use strict';
// 侧栏、首页、额度看板只为「看得见的变化」重绘（2026-11-25 后台开销修复 m3）。
//
// 起因：status-event / session-usage-updated / session-updated 每来一条就排一次整表重绘，
// 实测忙时每秒 2–3 次、每次约 70 ms，而其中多数事件只改了上下文 token 数、会话累计用量这类遥测，
// 侧栏上根本没有地方显示。
//
// 做法是「排除清单」而不是「白名单」：会话对象上除下面列出的纯遥测字段外，任何字段变了都照旧重绘，
// 新加的字段不用来这里登记也不会漏刷；原生会话的 nativeRuntime 快照每条都换新对象，
// 只比较侧栏真正用到的那部分（运行状态与说明文字、取消状态）。
// 「会话详情」开关打开时，侧栏每行会显示累计用量（renderer/session-details.js），这时用量也算可见。

// 纯遥测：侧栏、首页都不显示（上下文百分比 contextPct 首页和详情都会显示，所以不在这里）。
const TELEMETRY_KEYS = new Set([
  'contextUsed', 'contextMax', 'contextEffectiveMax', 'contextEffectiveObservedAt',
  'sessionUsage', '_tokenSamples', 'apiMs', 'linesAdded', 'linesRemoved',
]);
// 详情模式下可见的遥测。
const DETAIL_KEYS = new Set(['sessionUsage']);

function valueKey(value) {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return type[0] + ':' + String(value);
  if (type === 'function' || type === 'symbol') return value; // 按引用比
  try { return 'j:' + JSON.stringify(value); } catch { return value; } // 有环、定时器句柄等：按引用比
}

// 侧栏消费的原生快照字段：运行状态与连接（状态点）、原因与待答请求内容（悬停说明、等待文字），
// 提交与取消状态（core/session-runtime-issue.js 据此亮「状态待核对」）。版本号、内容条目、时间戳不在其列。
function defaultRuntimeKey(session) {
  const r = session.nativeRuntime;
  if (!r || typeof r !== 'object') return valueKey(r);
  return valueKey([r.state, r.connection, r.reason, r.turnId, Array.isArray(r.requests) ? r.requests : null,
    r.submission?.status || null, r.submission?.sendStatus || null, r.cancellation?.status || null]);
}

/**
 * 取一个会话在侧栏 / 首页上「看得见的部分」的签名。两次签名用 sameSurface 比较。
 * @param {object} session
 * @param {{details?: boolean, runtimeKey?: (session: object) => any}} [options]
 *   details：侧栏「会话详情」是否打开；runtimeKey：原生快照里侧栏用到的部分（默认取状态、连接、原因、请求数、取消状态）；
 *   ignore：不参与比较的字段，默认是纯遥测清单。
 */
function surfaceSignature(session, { details = false, runtimeKey = defaultRuntimeKey, ignore = TELEMETRY_KEYS } = {}) {
  if (!session || typeof session !== 'object') return [valueKey(session)];
  const parts = [];
  for (const key of Object.keys(session).sort()) {
    if (key === 'nativeRuntime') continue;
    if (ignore.has(key) && !(details && DETAIL_KEYS.has(key))) continue;
    // 首页只在没有 lastMessageTime 时才拿 updatedAt 当活动时间。
    if (key === 'updatedAt' && session.lastMessageTime) continue;
    parts.push(key, valueKey(session[key]));
  }
  let runtime;
  try { runtime = runtimeKey(session); } catch { runtime = session.nativeRuntime; }
  parts.push('\u0000runtime', runtime);
  return parts;
}

// 保存用的签名：哪些变化值得把会话表交给主进程写 state.json。
// 遥测（含上下文百分比）走 30 秒一次的慢保存；会话累计用量由主进程自己记账并写单会话文件，
// 界面传过去也会被主进程覆盖（main/ipc/persistence-handlers.js 的 authoritativeUsage），所以不算。
// 原生快照只要换了版本就算变化，和改前一样照存。
const PERSIST_TELEMETRY_KEYS = new Set([...TELEMETRY_KEYS, 'contextPct', 'updatedAt']);
function persistRuntimeKey(session) {
  const r = session.nativeRuntime;
  if (!r || typeof r !== 'object') return valueKey(r);
  return valueKey([r.epoch, r.revision, r.state, r.connection, r.turnId, r.cancellation?.status || null]);
}
function persistSignature(session) {
  return surfaceSignature(session, { runtimeKey: persistRuntimeKey, ignore: PERSIST_TELEMETRY_KEYS });
}
// 只看遥测字段有没有变（决定要不要排 30 秒慢保存）。
function telemetrySignature(session) {
  if (!session || typeof session !== 'object') return [];
  const parts = [];
  for (const key of ['contextPct', 'contextUsed', 'contextMax', 'contextEffectiveMax', 'contextEffectiveObservedAt']) parts.push(valueKey(session[key]));
  return parts;
}

function sameSurface(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// session-updated 处理前后各取一次签名：看得见的变了排重绘，落盘字段变了排保存，只有遥测变了排慢保存。
// 不认识的会话（界面会话表里还没有）照旧保存，与改前通用保存监听一致。
function createSessionUpdateGate({ isDetailsEnabled = () => false, render, persist, telemetryPersist }) {
  return {
    begin(local) {
      if (!local) return { finish() { persist(); } };
      const details = !!isDetailsEnabled();
      const surface = surfaceSignature(local, { details });
      const saved = persistSignature(local);
      const telemetry = telemetrySignature(local);
      return {
        finish() {
          if (!sameSurface(surface, surfaceSignature(local, { details: !!isDetailsEnabled() }))) render();
          if (!sameSurface(saved, persistSignature(local))) persist();
          else if (!sameSurface(telemetry, telemetrySignature(local))) telemetryPersist();
        },
      };
    },
  };
}

module.exports = { createSessionUpdateGate, TELEMETRY_KEYS, DETAIL_KEYS, PERSIST_TELEMETRY_KEYS, surfaceSignature, persistSignature, telemetrySignature, sameSurface, defaultRuntimeKey };
