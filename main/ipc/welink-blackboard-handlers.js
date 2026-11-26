'use strict';
const { sharedBlackboard, proxyHint } = require('../../core/company-assistant/welink-blackboard');

function registerWelinkBlackboardIpc(ipcMain, { service = null, getService = () => service, enabled = true, blackboard = enabled ? (service?.blackboard || sharedBlackboard()) : null, sendToRenderer = () => {} } = {}) {
  let lastSummary = '';
  function snapshot() {
    const a = getService(), flow = a?.loginFlow, install = a?.cliInstaller?.snapshot?.();
    return blackboard.buildSnapshot({ loginFlow: flow ? { active: flow.state === 'waiting', qrSvg: flow.qr?.value || null, url: flow.url || null, status: flow.state, message: flow.progress?.text || (flow.state === 'waiting' ? '等待完成身份确认' : '') } : null,
      installFlow: install ? { running: !['idle', 'error', 'done'].includes(install.phase), stage: install.phase, message: install.message || '', proxyHint: install.proxyHint || proxyHint(install.error || '') } : null });
  }
  const digestOf = s => JSON.stringify([{ health: s.health, badgeCount: s.badgeCount, cooldownRemainingSec: s.cooldownRemainingSec, authState: s.auth.state }, s.updatedAt || 0, s.events?.[0]?.id || '', s.loginFlow, s.installFlow]);
  function changed() {
    if (!enabled) return;
    const s = snapshot(), summary = { health: s.health, badgeCount: s.badgeCount, cooldownRemainingSec: s.cooldownRemainingSec, authState: s.auth.state, updatedAt: s.updatedAt || 0, lastEventId: s.events?.[0]?.id || '' };
    const encoded = digestOf(s);
    if (encoded !== lastSummary) { lastSummary = encoded; sendToRenderer('welink-blackboard:changed', summary); }
  }
  const needService = () => { const a = getService(); if (!a) throw new Error('WeLink 服务尚未就绪，请稍后重试'); return a; };
  const mutate = async action => {
    const saved = await blackboard.withLock('assistant', 'settings', action);
    if (saved === false) throw Object.assign(new Error('状态未保存：无法写入本机数据目录，请检查目录权限后重试'), { publicMessage: '状态未保存：无法写入本机数据目录，请检查目录权限后重试' });
    return saved;
  };
  const handlers = {
    snapshot: () => ({}),
    refresh: async () => { await needService().refreshWelinkBlackboard(); return {}; },
    'install-cli': async request => {
      const cli = blackboard.read().cli;
      const result = await needService().installCli({ upgrade: request?.upgrade === true || (request?.upgrade !== false && (!!cli.path || cli.outdated)) });
      if (!result?.ok) return { ok: false, error: proxyHint(result?.error || result?.state?.error || '') || '安装未完成，请检查公司网络后重试', proxyHint: proxyHint(result?.error || result?.state?.error || ''), result };
      await needService().refreshWelinkBlackboard(); return { result };
    },
    'find-cli': async () => { const search = await needService().findCli({ force: true }); await needService().refreshWelinkBlackboard(); return { search }; },
    'start-login': async request => ({ flow: await needService().login({ restart: !!request?.restart, clean: !!request?.clean }) }),
    logout: async request => {
      if (request?.confirmed !== true) throw new Error('请先确认退出 WeLink 登录');
      const result = await needService().logout();
      if (!result?.ok) throw new Error('WeLink 尚未确认退出，请稍后重试');
      const saved = await blackboard.withLock('assistant', 'settings', () => blackboard.setAuth({ state: 'signed_out' }));
      return saved === false ? { warning: '已退出登录，本机状态暂未写入，请刷新重试' } : {};
    },
    'clear-cooldown': async () => { await mutate(() => blackboard.clearCooldown()); const gate = getService()?.welinkGate; if (gate) { gate.clearLocalCooldown ? gate.clearLocalCooldown() : (gate.pausedUntil = 0); } return {}; },
    'clear-events': async () => { await mutate(() => blackboard.clearEvents()); return {}; },
    'update-policy': async request => { await mutate(() => blackboard.updatePolicy(request)); return {}; },
  };
  // Stub operations never call a real CLI or touch production credentials.
  let stubOverlay = {}, lastStubKey = '';
  const STUB_QR = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><rect x="12" y="12" width="32" height="32" fill="#111"/><rect x="76" y="12" width="32" height="32" fill="#111"/><rect x="12" y="76" width="32" height="32" fill="#111"/><rect x="56" y="56" width="16" height="16" fill="#111"/></svg>', 'utf8').toString('base64');
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle('welink-blackboard:' + name, async (_event, request = {}) => {
    try {
      if (!enabled) return { ok: false, error: '这个版本未启用 WeLink 工作台' };
      if (name === 'logout' && request?.confirmed !== true) throw new Error('请先确认退出 WeLink 登录');
      if (name === 'update-policy' && request?.groupReadMode !== undefined && !['hotspot_first', 'conservative_30s'].includes(request.groupReadMode)) return { ok: false, error: '请选择热点优先或保守 30 秒策略' };
      const stubRaw = blackboard.stub();
      if (stubRaw) {
        const stubKey = JSON.stringify(stubRaw);
        if (stubKey !== lastStubKey) { lastStubKey = stubKey; stubOverlay = {}; }
        const s = { ...snapshot(), ...stubOverlay };
        if (name === 'logout') stubOverlay = { ...stubOverlay, auth: { ...s.auth, state: 'signed_out' }, health: 'warning', advice: null, loginFlow: null };
        if (name === 'start-login') stubOverlay.loginFlow = stubRaw.loginFlow || s.loginFlow || { active: true, qrSvg: STUB_QR, status: 'waiting', message: '等待完成身份确认' };
        if (name === 'clear-events') stubOverlay.events = [];
        if (name === 'clear-cooldown') stubOverlay = { ...stubOverlay, cooldown: { until: 0, reason: '', caller: '', consecutive: 0 }, cooldownRemainingSec: 0, advice: s.advice?.kind === 'rate_limited' ? null : s.advice, health: s.advice?.kind === 'rate_limited' ? 'healthy' : s.health, auth: s.auth?.state === 'rate_limited' ? { ...s.auth, state: 'online' } : s.auth };
        if (name === 'update-policy') { if (!['hotspot_first', 'conservative_30s'].includes(request.groupReadMode)) throw new Error('请选择有效策略'); stubOverlay.policy = { ...s.policy, groupReadMode: request.groupReadMode }; }
        return { ok: true, snapshot: { ...s, ...stubOverlay }, ...(name === 'start-login' ? { flow: stubOverlay.loginFlow } : {}), ...(name === 'find-cli' ? { search: { state: 'found', path: s.cli.path } } : {}), ...(name === 'install-cli' ? { result: { ok: true } } : {}) };
      }
      const result = await handler(request); changed(); return { ok: true, ...result, snapshot: snapshot() };
    } catch (error) { return { ok: false, error: error?.publicMessage || proxyHint(error) || '操作未完成：' + (error?.code === 'WELINK_RATE_LIMITED' ? 'WeLink 限流，请稍后再试' : ['WELINK_BUSY', 'ABORT_ERR'].includes(error?.code) ? error.message : name === 'logout' && request?.confirmed !== true ? '请先确认退出 WeLink 登录' : '请检查公司网络与 WeLink 状态后重试') }; }
  });
  // Event driven only: no polling, watcher or idle timer. Non-company builds skip disk reads.
  if (!enabled || !blackboard) return { snapshot: () => null, changed: () => {}, dispose: () => {} };
  lastSummary = digestOf(snapshot());
  const unsubscribe = blackboard.subscribe(changed);
  return { snapshot, changed, dispose: unsubscribe };
}
module.exports = { registerWelinkBlackboardIpc };
