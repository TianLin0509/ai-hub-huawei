'use strict';
// 「WeLink (Beta)」公共黑板页的受控快照：单测与 CDP 验收共用。字段按接口契约 v1（welink-blackboard:snapshot 的返回形状）；
// 全部是虚构的脱敏数据，不含任何真实账号、人名、工号或消息正文。
const NOW = new Date(2026, 10, 26, 14, 10, 0).getTime();
const MIN = 60000;
const BLACKBOARD = 'C:\\HubData\\company-assistant\\welink-blackboard.json';
const LOCK = 'C:\\HubData\\company-assistant\\welink-blackboard.lock';

const caller = (label, kind, calls1h, ok1h, rateLimited1h, errors1h, lastStatus, ago) => ({ label, kind, calls1h, ok1h, rateLimited1h, errors1h, lastAt: ago == null ? 0 : NOW - ago * MIN, lastStatus });

function online() {
  return {
    schemaVersion: 1, updatedAt: NOW - 2 * MIN,
    cli: { path: 'C:\\HubData\\tools\\welink-cli\\welink-cli.exe', source: 'managed', version: '1.0.20', minRecommendedVersion: '1.0.20', outdated: false, checkedAt: NOW - 5 * MIN },
    auth: { state: 'online', accountLabel: 'user***01', desktopOnline: true, desktopMismatch: false, reason: '', updatedAt: NOW - 2 * MIN },
    authBusy: null,
    cooldown: { until: 0, reason: '', caller: '', consecutive: 0 },
    policy: { groupReadMode: 'hotspot_first', conservativeIntervalSec: 30, hotspotIntervalSec: 10 },
    callers: {
      assistant: caller('公司助理', 'builtin', 9, 9, 0, 0, 'ok', 3),
      avatar: caller('数字分身', 'builtin', 18, 17, 1, 0, 'ok', 1),
      phone: caller('手机对话', 'builtin', 6, 6, 0, 0, 'ok', 12),
      feedback: caller('一键反馈', 'builtin', 1, 1, 0, 0, 'idle', 40),
      join: caller('一键入群', 'builtin', 0, 0, 0, 0, 'idle', null),
      'welink-ro': caller('会话只读工具', 'external', 5, 5, 0, 0, 'ok', 8),
      external: caller('其他外部组件', 'external', 2, 1, 0, 1, 'error', 25),
    },
    events: [],
    health: 'healthy', badgeCount: 0, headline: 'WeLink 运行正常', advice: null,
    cooldownRemainingSec: 0, lockHolder: null,
    paths: { blackboardFile: BLACKBOARD, lockFile: LOCK },
    lastSuccessAt: NOW - 2 * MIN, loginFlow: null, installFlow: null,
  };
}

function cliMissing() {
  const s = online();
  s.cli = { path: '', source: 'missing', version: '', minRecommendedVersion: '1.0.20', outdated: false, checkedAt: NOW - MIN };
  s.auth = { ...s.auth, state: 'cli_missing', accountLabel: '', reason: '' };
  for (const c of Object.values(s.callers)) Object.assign(c, { calls1h: 0, ok1h: 0, rateLimited1h: 0, errors1h: 0, lastStatus: 'idle', lastAt: 0 });
  return { ...s, health: 'error', badgeCount: 1, headline: '安装 WeLink 命令行工具' };
}

function cliOutdated() {
  const s = online();
  s.cli = { ...s.cli, version: '1.0.17', outdated: true };
  return { ...s, health: 'warning', badgeCount: 1, headline: '升级 WeLink 命令行工具' };
}

function proxy407() {
  const s = cliMissing();
  s.installFlow = { running: false, stage: 'failed', message: '下载失败', proxyHint: '公司代理要求认证（407）。请完成公司代理认证后重试安装。' };
  s.advice = { kind: 'proxy_407', title: '下载被代理拦下（407 需要代理认证）', detail: '检查代理账号是否已登录，再点重试', primaryAction: 'install-cli', secondaryAction: 'refresh', redZoneNote: '' };
  return s;
}

function installing() {
  const s = cliMissing();
  s.installFlow = { running: true, stage: 'download', message: '正在下载 WeLink 命令行 1.0.20…' };
  return s;
}

function rateLimited() {
  const s = online();
  s.cooldown = { until: NOW + 22000, reason: '服务端限流，稍后再试', caller: 'avatar', consecutive: 2 };
  s.auth = { ...s.auth, state: 'rate_limited' };
  s.callers.avatar = caller('数字分身', 'builtin', 24, 19, 5, 0, 'rate_limited', 0);
  s.lockHolder = null;
  return { ...s, health: 'warning', badgeCount: 1, headline: '正在等待 WeLink 限流冷却', cooldownRemainingSec: 22,
    advice: { kind: 'rate_limited', title: '正在等待 WeLink 限流冷却', detail: '倒计时结束自动恢复，不用操作', primaryAction: 'refresh', secondaryAction: 'clear-cooldown', redZoneNote: '' } };
}

function needsScan() {
  const s = online();
  s.auth = { ...s.auth, state: 'needs_scan', accountLabel: '', desktopOnline: true, reason: '登录已失效，请重新扫码' };
  return { ...s, health: 'warning', badgeCount: 1, headline: '登录已失效，请重新扫码',
    advice: { kind: 'needs_scan', title: 'WeLink 登录已失效，需要扫码', detail: '用手机 WeLink 扫码即可恢复', primaryAction: 'start-login', secondaryAction: 'refresh', redZoneNote: '无摄像头环境可在桌面端完成身份确认' } };
}

const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="white"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1zM10 10h2v2h-2zM14 14h3v3h-3z" fill="black"/></svg>';
function scanning() {
  const s = needsScan();
  s.loginFlow = { active: true, qrSvg: QR_SVG, status: 'waiting', message: '请用手机 WeLink 扫码' };
  s.authBusy = { owner: 'hub', op: 'login' };
  s.lockHolder = { owner: 'assistant', op: 'login', ageSec: 6 };
  return s;
}

const STATUSES = ['ok', 'ok', 'rate_limited', 'ok', 'error', 'ok', 'auth_error'];
const CMDS = ['im query-history', 'im list-chats', 'im send', 'group join', 'auth status', 'im query-unread'];
const IDS = ['assistant', 'avatar', 'phone', 'feedback', 'join', 'welink-ro', 'external'];
const SUMMARY = { ok: '正常完成', rate_limited: '服务端限流，已共享冷却', error: '调用未完成', auth_error: '需要检查登录状态' };
function withEvents(n, only) {
  const s = online();
  s.events = Array.from({ length: n }, (_, i) => {
    const status = only || STATUSES[i % STATUSES.length];
    const id = IDS[i % IDS.length];
    return { id: 'ev-' + (n - i), at: NOW - i * 97000, caller: id, callerLabel: s.callers[id].label, command: CMDS[i % CMDS.length], durationMs: 180 + i * 137, status, summary: SUMMARY[status] };
  });
  return s;
}

const STATES = { online, cliMissing, cliOutdated, proxy407, installing, rateLimited, needsScan, scanning, withEvents };
module.exports = { NOW, STATES, online, cliMissing, cliOutdated, proxy407, installing, rateLimited, needsScan, scanning, withEvents, QR_SVG };
