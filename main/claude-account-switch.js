'use strict';

const path = require('node:path');
const { atomicJson, readJson, fail } = require('../core/claude-account-credentials');
const { installAccount, mirrorAccess, ensureRuntimeIdentity, MARKER } = require('../core/claude-account-runtime');
const { isConfirmedQuotaWall, selectQuotaAccount, quotaReading, CONTINUE_AFTER_SWITCH } = require('../core/claude-quota-switch-policy');
// 额度查询按需触发（2026-10-29 用户）：不按时钟轮询；账号有回合结束时才考虑查，
// 离额度越远间隔越长。额度用完换号前的那次查询不受影响，照常立即查。
// 原先每 90–120 秒查一次，Anthropic 的额度接口常回 429。
// 同日起每回合的状态栏已免费带回额度：读数够新就不再发请求，这里只是兜底。
// 账号只在 Hub 里用，候选账号沿用上次读数（过了重置时间按已重置算）。
const USAGE_SPREAD_MS = 30_000;
function usageGapMs(usage) {
  const used = ['five_hour', 'seven_day'].map(k => usage?.[k]?.utilization).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!used.length) return 10 * 60_000;
  const max = Math.max(...used);
  return max >= 80 ? 5 * 60_000 : max >= 50 ? 15 * 60_000 : 30 * 60_000;
}
const hookTurnKey = event => event.promptId ? `prompt:${event.promptId}` : event.turnId ? `turn:${event.turnId}` : null;

function createClaudeAccountSwitch({ sessionManager, broker, profiles, scopeFor,
  sendToPty, drainSubmission = () => Promise.resolve(), saveSession, now = Date.now, prefreshEnabled = () => false,
  random = Math.random, later = (fn, ms) => setTimeout(fn, ms), relaunch = null, verifyRoute = null }) {
  const pending = new Map();
  const manualEpoch = new Map();
  const restored = new Set();
  const nextUsage = new Map();
  // An account is checked only after one of its turns ends, never on a clock.
  function usageAfterTurn(session) {
    if (!managed(session)) return;
    const profileId = session.claudeProfile;
    if ((nextUsage.get(profileId) || 0) > now()) return;
    nextUsage.set(profileId, now() + 10 * 60_000);
    const handle = later(() => void Promise.resolve().then(() => {
      const profile = account(profileId);
      return broker.usage(profile, { maxAgeMs: usageGapMs(broker.cached?.(profile)?.usage), why: 'after-turn' });
    }).then(snapshot => {
      nextUsage.set(profileId, now() + usageGapMs(snapshot?.usage));
    }).catch(error => {
      // 例行查询失败与换号无关：说清是额度没刷新、不影响当前会话。
      publish(session.id, 'usage-unavailable', error?.code === 'CLAUDE_USAGE_RATE_LIMIT'
        ? '额度暂未刷新（Anthropic 限流），稍后自动再查；不影响当前会话'
        : '额度暂未刷新，稍后自动再查；不影响当前会话');
    }), Math.floor(random() * USAGE_SPREAD_MS));
    handle?.unref?.();
  }
  const observedTurns = new Map();
  const manualRequests = new Map();
  const activeTurns = new Map();
  const admissions = new Map();
  const deferredFailures = new Map();
  // Sessions being stopped and reopened by an account switch: their suspension is ours.
  const relaunching = new Set();
  // Native id that was running when a session's account changed. That process
  // may still hold the old account's quota, so its status-line readings are
  // never credited to the new account.
  const preSwitchNative = new Map();
  let timer;
  const fileFor = session => path.join(session.claudeRuntimeHome, '.hub-switch.json');
  const managed = session => session?.claudeRuntimeHome
    && /^claude(?:-resume)?$/.test(session.kind) && session.agentRuntime === 'pty';
  const eligible = session => managed(session) && session.claudeAutoSwitch === true;
  function publish(id, status, message, details = {}) {
    sessionManager.updateSessionMeta(id, { claudeSwitchStatus: { status, message, at: now(), ...details } });
  }
  function record(session, value) { atomicJson(fileFor(session), value); }
  // 2026-10-28: after the new login is installed, the conversation continues in a
  // new Claude process under a new native session id. A hot swap inside the old
  // process kept its session id, its open connection and whatever it had loaded
  // in memory. Without a relauncher (tests, old wiring) the old behaviour stays.
  async function relaunchUnderNewAccount(id, guard) {
    if (typeof relaunch !== 'function') return sessionManager.getSession(id);
    const beforeNative = sessionManager.getSession(id)?.ccSessionId;
    relaunching.add(id);
    let fresh;
    try { fresh = await relaunch(id, guard); } finally { relaunching.delete(id); }
    const live = sessionManager.getSession(id);
    if (!fresh || fresh.ok === false || !managed(live) || !live.ccSessionId || live.ccSessionId === beforeNative) {
      throw fail('CLAUDE_RELAUNCH_FAILED', fresh?.message || '账号已切换，但会话未能在新进程中重新打开；请从休眠恢复后继续');
    }
    observedTurns.delete(id); activeTurns.delete(id); restored.add(id);
    return live;
  }
  function reconcile(session) {
    if (restored.has(session.id)) return;
    const saved = readJson(fileFor(session), true);
    if (saved && ['switching', 'sending'].includes(saved.phase)) {
      record(session, { ...saved, phase: 'attention' });
      publish(session.id, 'attention', '上次换号或续跑结果未确认，请核对任务后手动继续');
    }
    restored.add(session.id);
  }
  // 跨出口换号（2026-10-29 用户放开）：换号会重开进程，新进程按新账号的出口启动，
  // 每个账号仍只从自己的 IP 出网。前提是有重开进程的能力，且换之前经目标线路实测出口 IP 无误。
  const network = () => require('../core/claude-account-network');
  const crossRouteAllowed = () => typeof relaunch === 'function' && typeof verifyRoute === 'function';
  async function routeReady(from, to) {
    if (network().sameRoute(from, to)) return;
    if (!crossRouteAllowed()) throw fail('CLAUDE_ROUTE_LOCKED', '这两个账号绑定不同网络出口，当前不能跨出口换号；请用目标账号新建会话');
    let result;
    try { result = await verifyRoute(to); } catch (error) { result = { ok: false, reason: error.message }; }
    if (!result?.ok) throw fail('CLAUDE_ROUTE_UNVERIFIED', `${to.label || to.id} 的出口核对未通过（${result?.reason || '原因未知'}），保持原账号`);
  }
  function account(id) {
    const profile = profiles().find(p => p.id === id);
    if (!profile) throw fail('CLAUDE_PROFILE_MISSING', 'Claude 账号配置已移除');
    return profile;
  }
  async function refresh(session) {
    const profile = account(session.claudeProfile);
    const credentials = await broker.getCredentials(profile);
    const live = sessionManager.getSession(session.id);
    if (!managed(live) || live.claudeProfile !== profile.id || live.ccSessionId !== session.ccSessionId) return;
    await mirrorAccess({ home: live.claudeRuntimeHome, profile, credentials });
    const repaired = await ensureRuntimeIdentity({ home: live.claudeRuntimeHome, profile });
    if (repaired) console.warn(`[claude-identity] ${live.id} 的设备号与登录账号不一致，已改回 ${profile.id} 的设备号`);
  }
  async function beforeSend(id, options = {}) {
    const session = sessionManager.getSession(id);
    if (!managed(session)) return;
    if (!options.claudeAccountContinuation && !manualRequests.has(id)) manualEpoch.set(id, (manualEpoch.get(id) || 0) + 1);
    if (pending.has(id)) await pending.get(id);
    const live = sessionManager.getSession(id);
    if (!managed(live)) throw fail('CLAUDE_SESSION_CHANGED', '会话已关闭或改变，未发送');
    if (manualRequests.has(id) && !options.claudeSubmissionAdmitted) throw fail('CLAUDE_ACCOUNT_QUEUED', '账号将在当前回合结束后切换，请等切换完成再发送');
    reconcile(live);
    try { await refresh(live); }
    catch (error) { publish(id, 'attention', error.message); throw error; }
  }

  function busy(session) {
    if (admissions.get(session.id)?.size) return true;
    const turn = activeTurns.get(session.id);
    // A matching terminal hook outranks the UI's slower running-state update.
    if (turn && turn.nativeSessionId === session.ccSessionId) return turn.active;
    return sessionManager.isAgentTurnActive?.(session.id) === true || session.agentTurnActive === true || session.status === 'running'
      || require('../core/session-runtime-truth').sessionRuntimeIsActive(session);
  }
  async function beginSubmission(id, options = {}) {
    if (!managed(sessionManager.getSession(id))) return () => {};
    if (manualRequests.has(id)) {
      if (pending.has(id)) await pending.get(id);
      if (manualRequests.has(id)) throw fail('CLAUDE_ACCOUNT_QUEUED', '账号将在当前回合结束后切换，请等切换完成再发送');
    }
    deferredFailures.delete(id);
    const lease = { continuation: options.claudeAccountContinuation === true, started: false };
    const leases = admissions.get(id) || new Set();
    leases.add(lease); admissions.set(id, leases);
    let priorTurn = observedTurns.get(id);
    let released = false;
    const release = receipt => {
      if (released) return;
      released = true; leases.delete(lease);
      if (admissions.get(id) !== leases) return;
      if (!leases.size && admissions.get(id) === leases) admissions.delete(id);
      const session = sessionManager.getSession(id);
      if (!managed(session)) return;
      const unknown = receipt?.ok !== true || (receipt.sendStatus && receipt.sendStatus !== 'ok');
      if ((unknown || observedTurns.get(id) === priorTurn) && !receipt?.notSent && !options.localCommandObserver) {
        // A send receipt can precede the authoritative prompt hook. Keep the
        // account fixed even when that receipt says accepted, or is unknown.
        activeTurns.set(id, { nativeSessionId: session.ccSessionId, active: true });
      }
      const deferred = !admissions.has(id) && deferredFailures.get(id);
      if (deferred) {
        deferredFailures.delete(id);
        if (deferred.epoch === (manualEpoch.get(id) || 0) && deferred.generation === (session.claudeAuthGeneration || 0)
          && deferred.nativeId === session.ccSessionId && deferred.turn === observedTurns.get(id)?.turnId) {
          activeTurns.set(id, { nativeSessionId: session.ccSessionId, active: false });
          if (!manualRequests.has(id)) void onFailure(deferred.event).catch(error => publish(id, 'attention', error.message));
        }
      }
      const request = manualRequests.get(id);
      if (request && !busy(session)) void executeManual(id, request).catch(error => publish(id, 'manual-failed', error.message));
    };
    // Several callers may finish authentication before their queue slot opens.
    // Each submission needs the hook baseline from its own actual queue slot.
    release.started = () => { priorTurn = observedTurns.get(id); lease.baseline = priorTurn; lease.started = true; };
    try { await beforeSend(id, { ...options, claudeSubmissionAdmitted: true }); }
    catch (error) { release({ notSent: true }); throw error; }
    return release;
  }
  function accountOptions(id) {
    const session = sessionManager.getSession(id);
    if (!session || !/^claude(?:-resume)?$/.test(session.kind)) return { ok: false, message: '此会话不是 Claude 订阅会话' };
    const canSwitch = !!managed(session);
    const request = manualRequests.get(id);
    const accounts = profiles().map(profile => {
      let available = false;
      try {
        const oauth = readJson(path.join(profile.home, '.credentials.json')).claudeAiOauth;
        available = !!oauth?.accessToken && (Number(oauth.expiresAt) > now() || !!oauth.refreshToken);
      } catch { /* A missing account is shown explicitly as unavailable. */ }
      const routeCompatible = crossRouteAllowed() || network().sameRoute(account(session.claudeProfile || 'default'), profile);
      return { id: profile.id, label: profile.label || profile.id, current: profile.id === session.claudeProfile,
        available: available && routeCompatible, reason: !routeCompatible ? '绑定不同出口，请用该账号新建会话' : available ? '' : '此账号尚未登录或登录已过期' };
    });
    return { ok: true, currentProfile: session.claudeProfile || 'default', canSwitch, accounts,
      reason: canSwitch ? '' : '此旧会话未启用独立账号切换；新建 Claude 订阅会话后即可使用',
      pendingProfile: request?.profileId || null, pendingLabel: request?.label || null };
  }
  async function executeManual(id, request) {
    if (manualRequests.get(id) !== request) return { ok: true, status: 'cancelled' };
    const prior = pending.get(id);
    if (prior) { try { await prior; } catch { /* Report the manual attempt separately. */ } }
    const initial = sessionManager.getSession(id);
    if (!managed(initial) || manualRequests.get(id) !== request) return { ok: false, message: '会话或账号选择已改变' };
    if (busy(initial)) return { ok: true, status: 'queued', message: '当前回合结束后切换账号' };
    const submissions = drainSubmission(id);
    const nativeId = initial.ccSessionId;
    const generation = initial.claudeAuthGeneration || 0;
    const valid = () => {
      const current = sessionManager.getSession(id);
      return managed(current) && current.ccSessionId === nativeId && manualRequests.get(id) === request
        && (current.claudeAuthGeneration || 0) === generation && !busy(current);
    };
    const interrupted = () => ({ ok: true,
      status: manualRequests.get(id) === request && managed(sessionManager.getSession(id)) ? 'queued' : 'cancelled',
      message: '当前回合结束后切换账号' });
    const task = (async () => {
      await submissions;
      if (!valid()) return interrupted();
      const profile = account(request.profileId);
      await routeReady(account(initial.claudeProfile), profile);
      publish(id, 'manual-switching', `正在切换到${request.label}…`, { targetProfile: profile.id, targetLabel: request.label });
      const snapshot = await broker.usage(profile, { maxAgeMs: Infinity, why: 'manual-target' });
      const reading = quotaReading(snapshot, initial.currentModel?.id || initial.model || '', now());
      if (!reading || reading.exhausted) throw fail('CLAUDE_ACCOUNT_NO_QUOTA', reading ? '所选账号当前模型的额度已耗尽，保持原账号' : '暂时无法确认所选账号额度，保持原账号');
      const credentials = await broker.getCredentials(profile);
      if (!valid()) return interrupted();
      const intent = { phase: 'switching', mode: 'manual', eventKey: `manual:${request.sequence}`, from: initial.claudeProfile, to: profile.id, at: now() };
      record(initial, intent);
      const marker = await installAccount({ home: initial.claudeRuntimeHome, profile, credentials,
        scope: scopeFor(profile.id), expectedGeneration: generation, shouldInstall: valid });
      if (!marker) {
        record(initial, { ...intent, phase: 'cancelled' });
        return interrupted();
      }
      preSwitchNative.set(id, nativeId);
      const updated = sessionManager.updateSessionMeta(id, { claudeProfile: profile.id, claudeProfileLabel: profile.label,
        claudeUsageScope: marker.scope, claudeAuthGeneration: marker.generation });
      if (!updated) throw fail('CLAUDE_SESSION_CLOSED', '会话已经关闭');
      saveSession(updated);
      manualRequests.delete(id);
      publish(id, 'manual-switching', `正在用${request.label}重新打开会话…`, { targetProfile: profile.id, targetLabel: request.label });
      let reopened;
      try { reopened = await relaunchUnderNewAccount(id, () => !manualRequests.has(id) && !admissions.get(id)?.size); }
      catch (error) {
        record(updated, { ...intent, phase: 'attention', generation: marker.generation });
        publish(id, 'attention', error.message);
        return { ok: false, message: error.message };
      }
      record(reopened, { ...intent, phase: 'completed', generation: marker.generation, attempted: [] });
      observedTurns.delete(id); activeTurns.delete(id);
      publish(id, 'manual-switched', `已切换到${request.label}，下一条消息使用该账号额度`);
      return { ok: true, status: 'switched', session: sessionManager.getSession(id) };
    })();
    pending.set(id, task);
    try {
      const result = await task;
      if (result.status === 'queued' && manualRequests.get(id) === request) {
        publish(id, 'manual-queued', `当前回合结束后切换到${request.label}`, { targetProfile: request.profileId, targetLabel: request.label });
      }
      return result;
    } catch (error) {
      if (manualRequests.get(id) !== request) return { ok: true, status: 'cancelled' };
      manualRequests.delete(id);
      const saved = readJson(fileFor(initial), true);
      if (saved?.phase === 'switching') record(initial, { ...saved, phase: 'attention' });
      publish(id, 'manual-failed', error.message || '账号切换失败，保持原账号');
      return { ok: false, message: error.message || '账号切换失败' };
    } finally { if (pending.get(id) === task) pending.delete(id); }
  }
  let requestSequence = 0;
  async function requestAccount(id, profileId) {
    const session = sessionManager.getSession(id);
    if (!managed(session)) return { ok: false, message: '此旧会话未启用独立账号切换，请新建 Claude 订阅会话后使用' };
    let profile;
    try { profile = account(profileId); } catch (error) { return { ok: false, message: error.message }; }
    if (!crossRouteAllowed() && !network().sameRoute(account(session.claudeProfile), profile)) {
      return { ok: false, message: '这两个账号绑定不同网络出口，当前不能跨出口换号；请用目标账号新建会话' };
    }
    manualEpoch.set(id, (manualEpoch.get(id) || 0) + 1);
    if (profile.id === session.claudeProfile) {
      const cancelled = manualRequests.delete(id);
      publish(id, 'manual-cancelled', cancelled ? '已取消待执行的账号切换' : '当前已使用此账号');
      return { ok: true, status: cancelled ? 'cancelled' : 'unchanged' };
    }
    const request = { profileId, label: profile.label || profile.id, sequence: ++requestSequence };
    manualRequests.set(id, request);
    if (busy(session)) {
      publish(id, 'manual-queued', `当前回合结束后切换到${request.label}`, { targetProfile: profileId, targetLabel: request.label });
      return { ok: true, status: 'queued', message: '当前回合结束后切换账号' };
    }
    return executeManual(id, request);
  }
  function endTurn(event) {
    const turn = observedTurns.get(event.sessionId);
    const session = sessionManager.getSession(event.sessionId);
    if (!managed(session) || !turn || !event.turnId || event.turnId !== turn.turnId
      || event.nativeSessionId !== session.ccSessionId || turn.generation !== (session.claudeAuthGeneration || 0)) return false;
    activeTurns.set(session.id, { nativeSessionId: session.ccSessionId, active: false });
    const request = manualRequests.get(session.id);
    if (request) {
      void executeManual(session.id, request).catch(error => publish(session.id, 'manual-failed', error.message));
      return true;
    }
    return false;
  }

  async function onFailure(event) {
    const rawEvent = event;
    event = { ...event, turnId: hookTurnKey(event) };
    if (endTurn(event)) return;
    const session = sessionManager.getSession(event.sessionId);
    if (!eligible(session) || pending.has(session.id)) return;
    const leases = admissions.get(session.id);
    if (leases?.size) {
      const turn = observedTurns.get(session.id);
      if (turn && event.turnId && turn.turnId === event.turnId && event.nativeSessionId === session.ccSessionId
        && [...leases].every(lease => lease.started) && [...leases].some(lease => lease.baseline !== turn)) {
        deferredFailures.set(session.id, { event: rawEvent, turn: turn.turnId, nativeId: session.ccSessionId,
          generation: session.claudeAuthGeneration || 0, epoch: manualEpoch.get(session.id) || 0 });
      }
      return;
    }
    reconcile(session);
    if (!event.nativeSessionId || event.nativeSessionId !== session.ccSessionId) return;
    const observed = observedTurns.get(session.id);
    if (observed && (!event.turnId || !observed.turnId || event.turnId !== observed.turnId
      || observed.generation !== (session.claudeAuthGeneration || 0))) return;
    const previous = readJson(fileFor(session), true);
    if (previous?.phase === 'attention') return;
    const eventKey = `${event.nativeSessionId}:${event.turnId || event.at}`;
    if (previous?.eventKey === eventKey) return;
    const epoch = manualEpoch.get(session.id) || 0;
    const submittedBeforeFailure = drainSubmission(session.id);
    const activeId = session.claudeProfile;
    const model = session.currentModel?.id || session.model || '';
    const unchanged = () => {
      const live = sessionManager.getSession(session.id);
      return eligible(live) && live.ccSessionId === event.nativeSessionId && (manualEpoch.get(session.id) || 0) === epoch
        && ![...(admissions.get(session.id) || [])].some(lease => !lease.continuation);
    };
    let switched;
    const transaction = (async () => {
      await submittedBeforeFailure;
      if (!unchanged()) return;
      const current = await broker.usage(account(activeId), { why: 'wall-current' });
      if (!isConfirmedQuotaWall({ ...event, snapshot: current, model, now: now() })) return;
      publish(session.id, 'checking', '额度已耗尽，正在确认其他账号的可用额度…');
      const attempted = [...new Set([...(previous?.attempted || []), activeId])];
      const candidates = [];
      for (const profile of profiles()) {
        if (attempted.includes(profile.id)) continue;
        if (!crossRouteAllowed() && !network().sameRoute(account(activeId), profile)) continue;
        try { candidates.push(await broker.usage(profile, { maxAgeMs: Infinity, why: 'wall-candidate' })); }
        catch (error) { candidates.push({ id: profile.id, ready: false, error: error.code }); }
      }
      if (!unchanged()) return;
      // 跨出口的候选先实测出口；核对不过就换下一个候选，不记入 attempted（下次撞墙还能再试）。
      const unverified = [];
      let target = selectQuotaAccount({ currentId: activeId, candidates, attempted, model, now: now() });
      while (target) {
        try { await routeReady(account(activeId), account(target.id)); break; }
        catch (error) {
          console.warn(`[claude-switch] ${target.id} 未通过出口核对：${error.message}`);
          unverified.push(target.id);
          target = selectQuotaAccount({ currentId: activeId, candidates, attempted: [...attempted, ...unverified], model, now: now() });
        }
      }
      if (!unchanged()) return;
      if (!target) {
        record(session, { eventKey, phase: 'waiting', attempted, at: now() });
        publish(session.id, 'waiting', unverified.length
          ? '有额度的账号出口核对未通过，没有换号；保持当前会话，可稍后手动继续'
          : '没有已确认可用的账号；保持当前会话，可稍后手动继续');
        return;
      }
      const profile = account(target.id);
      const credentials = await broker.getCredentials(profile);
      if (!unchanged()) return;
      const intent = { eventKey, phase: 'switching', attempted, from: activeId, to: target.id, at: now() };
      record(session, intent);
      publish(session.id, 'switching', `正在切换到${profile.label || '可用账号'}，保留当前上下文…`);
      const marker = await installAccount({ home: session.claudeRuntimeHome, profile, credentials,
        scope: scopeFor(target.id), expectedGeneration: session.claudeAuthGeneration || 0, shouldInstall: unchanged });
      if (!marker) {
        record(session, { ...intent, phase: 'cancelled' });
        publish(session.id, 'cancelled', '检测到新消息或会话变化，已取消本次自动换号');
        return;
      }
      preSwitchNative.set(session.id, event.nativeSessionId);
      const updated = sessionManager.updateSessionMeta(session.id, { claudeProfile: target.id,
        claudeProfileLabel: profile.label, claudeUsageScope: marker.scope, claudeAuthGeneration: marker.generation });
      if (!updated) throw fail('CLAUDE_SESSION_CLOSED', '会话已经关闭，未自动继续');
      saveSession(updated); // Persist ownership before a continuation can leave the Hub.
      switched = { ...intent, phase: 'switched', generation: marker.generation };
      record(updated, switched);
    })();
    pending.set(session.id, transaction);
    try { await transaction; }
    catch (error) {
      const saved = readJson(fileFor(session), true);
      if (saved?.phase === 'switching') record(session, { ...saved, phase: 'attention' });
      publish(session.id, 'attention', error.message || '账号切换失败，请核对后继续');
      return;
    } finally { if (pending.get(session.id) === transaction) pending.delete(session.id); }
    if (!switched) return;
    if (!unchanged()) {
      publish(session.id, 'switched', '账号已切换；你已提交新消息，未追加自动继续');
      return;
    }
    let nativeAfter = event.nativeSessionId;
    if (typeof relaunch === 'function') {
      try {
        publish(session.id, 'switching', '账号已切换，正在新进程中重新打开会话…');
        const noUserInput = () => (manualEpoch.get(session.id) || 0) === epoch
          && ![...(admissions.get(session.id) || [])].some(lease => !lease.continuation);
        nativeAfter = (await relaunchUnderNewAccount(session.id, noUserInput)).ccSessionId;
      } catch (error) {
        record(session, { ...switched, phase: 'attention' });
        publish(session.id, 'attention', error.message);
        return;
      }
    }
    const canContinue = () => {
      const live = sessionManager.getSession(session.id);
      return eligible(live) && live.ccSessionId === nativeAfter && (manualEpoch.get(session.id) || 0) === epoch
        && ![...(admissions.get(session.id) || [])].some(lease => !lease.continuation)
        && live.claudeAuthGeneration === switched.generation;
    };
    record(session, { ...switched, phase: 'sending' });
    const stillSending = () => {
      const current = readJson(fileFor(session), true);
      return current?.phase === 'sending' && current.eventKey === switched.eventKey
        && current.generation === switched.generation;
    };
    try {
      const receipt = await sendToPty(session.id, CONTINUE_AFTER_SWITCH, session.kind, {
        // A relaunched CLI is still starting: wait for its input box before typing.
        claudeAccountContinuation: true, requireReady: typeof relaunch === 'function', shouldSubmit: canContinue,
        clientSubmissionId: `claude-quota-${session.id}-${switched.generation}`,
      });
      const accepted = receipt?.ok === true && !receipt.notSent
        && (!receipt.sendStatus || receipt.sendStatus === 'ok')
        && (!receipt.status || ['accepted', 'ok'].includes(receipt.status));
      if (!stillSending()) return;
      if (!accepted) {
        record(session, { ...switched, phase: 'attention' });
        publish(session.id, 'attention', receipt?.reason || '账号已切换，继续消息未获确认；请核对任务，不会自动重发');
      } else {
        record(session, { ...switched, phase: 'continued' });
        publish(session.id, 'continued', '账号已切换，已提交继续；正在等待 Claude 响应');
      }
    } catch (error) {
      if (!stillSending()) return;
      record(session, { ...switched, phase: 'attention' });
      publish(session.id, 'attention', '账号已切换，继续消息未获确认；请核对任务，不会自动重发');
    }
  }
  return {
    beforeSend, beginSubmission, onFailure, accountOptions, requestAccount,
    manages: id => !!managed(sessionManager.getSession(id)),
    // A status-line quota reading counts for the session's account only when it
    // comes from the current native process, under the current login generation.
    acceptsPassiveUsage({ sessionId, nativeSessionId, generation, scope }) {
      const session = sessionManager.getSession(sessionId);
      if (!session?.claudeRuntimeHome || !nativeSessionId || nativeSessionId !== session.ccSessionId) return false;
      if (Number(generation ?? -1) !== (session.claudeAuthGeneration || 0)) return false;
      if (scope && session.claudeUsageScope && scope !== session.claudeUsageScope) return false;
      return preSwitchNative.get(sessionId) !== nativeSessionId;
    },
    onPrompt(event) {
      event = { ...event, turnId: hookTurnKey(event) };
      const session = sessionManager.getSession(event.sessionId);
      if (managed(session) && session.ccSessionId === event.nativeSessionId) {
        deferredFailures.delete(event.sessionId);
        const saved = readJson(fileFor(session), true);
        const ownContinuation = saved?.phase === 'sending' && String(event.prompt || '').includes(CONTINUE_AFTER_SWITCH);
        // Raw backstage typing bypasses beforeSend, but the authoritative
        // UserPromptSubmit hook still cancels any older automatic action.
        if (!ownContinuation) manualEpoch.set(event.sessionId, (manualEpoch.get(event.sessionId) || 0) + 1);
        observedTurns.set(event.sessionId, { ...event, generation: session.claudeAuthGeneration || 0 });
        activeTurns.set(event.sessionId, { nativeSessionId: session.ccSessionId, active: true });
      }
    },
    onCompleted(event) {
      event = { ...event, turnId: hookTurnKey(event) };
      usageAfterTurn(sessionManager.getSession(event.sessionId));
      if (deferredFailures.get(event.sessionId)?.turn === event.turnId) deferredFailures.delete(event.sessionId);
      if (endTurn(event)) return;
      const id = event.sessionId;
      const session = sessionManager.getSession(id);
      if (!eligible(session) || pending.has(id)) return;
      const saved = readJson(fileFor(session), true);
      const turn = observedTurns.get(id);
      if (!saved || !turn || event.nativeSessionId !== session.ccSessionId
        || turn.nativeSessionId !== event.nativeSessionId || !(turn.at >= saved.at) || event.at < turn.at
        || !event.turnId || !turn.turnId || event.turnId !== turn.turnId
        || turn.generation !== (session.claudeAuthGeneration || 0)) return;
      record(session, { ...saved, phase: 'completed', attempted: [] });
      publish(id, 'completed', '当前账号任务已完成，上下文继续保留');
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (prefreshEnabled()) void Promise.resolve().then(() => broker.prefresh?.(profiles())).catch(() => {});
        for (const session of sessionManager.getAllSessions()) {
          if (!managed(session) || pending.has(session.id)) continue;
          void refresh(session).catch(error => publish(session.id, 'attention', error.message));
        }
      }, 30_000);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    isSwitching(id) { return relaunching.has(id); },
    forget(id) { manualEpoch.set(id, (manualEpoch.get(id) || 0) + 1); restored.delete(id); observedTurns.delete(id); activeTurns.delete(id); manualRequests.delete(id); admissions.delete(id); deferredFailures.delete(id); preSwitchNative.delete(id); },
  };
}

module.exports = { createClaudeAccountSwitch };
