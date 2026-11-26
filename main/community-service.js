'use strict';
// 社区统计的主进程接线（2026-11-24）：匿名安装编号 + 心跳内容 + 每小时发送 + 社区页 IPC。
// 开关记在可选功能里（optional-features.json 的 community，默认开、不提示）；关掉立即停发，社区页显示「已关闭」。
// 收件机本机（维护人电脑）由 main.js 的成员版段落传入 host：心跳写本地、榜单读本地，并多给 30 天趋势与收件状态。
// 每次心跳有结果、开关变化、收件机收到新心跳（最多每分钟一次）后，向界面推 community:summary { state, online, at }。
const path = require('node:path');
const { ensureInstallId } = require('../core/community/install-id');
const { buildPayload } = require('../core/community/payload');
const { createCommunityClient } = require('../core/community/client');
const { cleanNick } = require('../core/community/schema');

const HOST_SUMMARY_GAP_MS = 60 * 1000;

// 「后台」自检的失败原因计数（renderer/backstage-jump.js 每做一次自检报一次）：只记当天「入口:原因 → 次数」，
// 存在 community/diag-counts.json，跨天清零；随下一次心跳带上（关了社区就不发）。
function createDiagCounter(file, now) {
  const fs = require('node:fs');
  const { cleanDiag } = require('../core/community/schema');
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(now()); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = cleanDiag(JSON.parse(fs.readFileSync(file, 'utf8'))) || null; } catch { data = null; }
    return data;
  };
  return {
    record(from, cause) {
      const key = `${String(from || '')}:${String(cause || '')}`;
      if (!/^[a-z][a-z-]{0,15}:[a-z][a-z-]{0,19}$/.test(key)) return false;
      const d = today(), cur = load();
      data = cur && cur.d === d ? cur : { d, c: {} };
      if (!(key in data.c) && Object.keys(data.c).length >= 24) return false;
      data.c[key] = Math.min(1000, (data.c[key] || 0) + 1);
      try { fs.mkdirSync(require('node:path').dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { /* 记不下只影响统计 */ }
      return true;
    },
    current() { const cur = load(); return cur && cur.d === today() ? cur : null; },
  };
}

function createCommunityService({ dataDir, edition, version, profileController, receiverAddress, isEnabled, setEnabledFlag, getHost = () => null,
  fetchImpl, logger = console, now = Date.now, sendToRenderer = () => {}, timers = { setTimeout, clearTimeout }, clientOptions = {} } = {}) {
  let iid = '';
  const diag = createDiagCounter(path.join(dataDir, 'community', 'diag-counts.json'), now);
  const installId = () => iid || (iid = ensureInstallId(dataDir));
  const pc = () => (typeof profileController === 'function' ? profileController() : profileController);
  const payload = () => {
    const c = pc();
    if (!c) return null;
    return buildPayload({ iid: installId(), edition, version, state: c.profile.state, petRole: c.petRole(), dayTokens: c.dayTokens(),
      lastActiveAt: c.lastUsedAt(), now: new Date(now()), diag: diag.current() });
  };
  // 收件机本机：暂停收集时自己的心跳也不记，但不把自己刹住（本机照样能看榜）。
  const host = {
    isHost: () => { const h = getHost(); return !!(h && h.isHost()); },
    ingest: p => { const h = getHost(); if (h.store.readSettings().paused) return { counted: false }; return h.store.ingest(p); },
    board: () => getHost().store.board(installId(), { includeDaily: true }),
  };
  const emit = summary => { try { sendToRenderer('community:summary', summary); } catch { /* 窗口没开 */ } };
  const client = createCommunityClient({ receiverAddress: edition ? receiverAddress : null, buildPayload: payload, isEnabled, host, fetchImpl, logger, now,
    cacheFile: path.join(dataDir, 'community', 'board-cache.json'), onSummary: emit, ...clientOptions });

  // 收件机收到别人的心跳：在线数可能变了，最多每分钟推一次（1000 台每小时各一次也只是每分钟一条）。
  let hostTimer = null, hostLast = -Infinity;
  function notifyHost() {
    if (!edition || !isEnabled() || hostTimer) return;
    const fire = () => {
      hostTimer = null;
      // 排队期间关了开关：不再推「正常」，免得界面从「已关闭」跳回在线数（复审 P2）。
      if (!isEnabled()) return;
      hostLast = now();
      try { const b = host.board(); emit({ state: 'ok', online: b.online, at: b.at }); } catch { /* 收件侧没准备好 */ }
    };
    const wait = Math.max(0, hostLast + HOST_SUMMARY_GAP_MS - now());
    if (wait === 0) fire(); else { hostTimer = timers.setTimeout(fire, wait); hostTimer?.unref?.(); }
  }

  function settings() {
    const h = getHost(), isHost = !!(h && h.isHost());
    const auto = (() => { try { return payload()?.nick || ''; } catch { return ''; } })();
    return { ok: true, enabled: !!isEnabled(), available: !!edition, isHost, hostPaused: isHost ? h.store.readSettings().paused : false,
      nickname: cleanNick(pc()?.profile.state.nickname || ''), autoNick: auto, nick: auto };
  }
  const outside = () => ({ ok: true, state: 'outside', note: '仅在公司内网可用', isHost: false, boards: { level: [], wxp: [], wtok: [], streak: [], ach: [] },
    versions: [], me: null, minK: 5, online: 0, activeNow: 0, today: 0, week: 0, total: 0, todayDelta: 0, weekDelta: 0, at: 0 });

  const handlers = {
    // { force } 忽略 10 分钟缓存；{ cachedOnly } 只读内存或磁盘里的快照，绝不触网（启动时点亮底栏用）。
    'get-board': async (req = {}) => {
      if (!edition) return outside();
      return client.getBoard({ force: req.force === true, cachedOnly: req.cachedOnly === true, iid: installId() });
    },
    // 底栏用：读缓存，不触发网络。
    'get-online': () => (edition ? client.getOnline() : { ok: true, state: 'outside', online: null, at: 0 }),
    'get-settings': () => settings(),
    'set-enabled': async (req = {}) => {
      await setEnabledFlag(req.enabled === true); client.setEnabled(req.enabled === true);
      if (req.enabled !== true && hostTimer) { timers.clearTimeout(hostTimer); hostTimer = null; }
      return settings();
    },
    // 改昵称：复用「个人」页的昵称；下一次心跳带上（不为改名单独发）。返回 nick＝实际会上报的名字。
    'set-nickname': (req = {}) => {
      const c = pc(); if (!c) return { ok: false, error: '个人页数据还没准备好' };
      c.profile.setNickname(cleanNick(req.name)); return settings();
    },
    // 「后台」自检报一次原因（只记本机当天计数，不立刻发；随下一次心跳带上）。
    'diag-record': (req = {}) => ({ ok: diag.record(req.from, req.cause) }),
    'set-host-paused': (req = {}) => {
      const h = getHost(); if (!h || !h.isHost()) return { ok: false, error: '本机不是收件机' };
      const s = h.store.setPaused(req.paused === true);
      return { ...settings(), paused: s.paused };
    },
  };
  function registerIpc(ipcMain) {
    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.handle('community:' + name, async (_e, req = {}) => { try { return await fn(req || {}); } catch (e) { return { ok: false, error: e.message }; } });
    }
  }
  function start() { if (edition && isEnabled()) client.start(); }
  return { start, stop: () => { client.stop(); if (hostTimer) { timers.clearTimeout(hostTimer); hostTimer = null; } }, registerIpc, handlers, client, payload, installId, settings, notifyHost };
}

module.exports = { createCommunityService };
