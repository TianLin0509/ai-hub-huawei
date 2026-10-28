'use strict';

// Neutral: sent by the new account, so it must not announce another account's quota ran out.
const CONTINUE_AFTER_SWITCH = '继续刚才中断的任务。先核对上一项工具操作的结果，只继续尚未完成的部分。';
const nativeId = s => s?.codexSid || s?.ccSessionId;
const generation = s => s?.codexAuthGeneration || 0;
const fault = message => Object.assign(new Error(message), { code: 'CODEX_ACCOUNT_SWITCH' });

function quota(snapshot, now) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now || now - snapshot.observedAt > 60000) return null;
  // Some subscription plans authoritatively expose only a weekly window.
  const windows = [snapshot.usage5h, snapshot.usage7d].filter(v => v != null);
  if (!windows.length || snapshot.unavailable) return null;
  if (windows.some(w => Number.isFinite(w.resetsAt) && w.resetsAt > 0 && w.resetsAt <= now)) return null;
  const values = windows.map(w => w.pct);
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 100)) return null;
  return { exhausted: values.some(v => v >= 100), remaining: Math.min(...values.map(v => 100 - v)) };
}
function quotaFailure(event) {
  const text = [event.error, event.errorDetails].map(value => typeof value === 'string' ? value : JSON.stringify(value || '')).join(' ');
  if (/unauthorized|authentication|invalid[_ -]?(?:grant|token)|\b40[13]\b|network|timeout|ECONN|overloaded|verification|banned|suspend/i.test(text)) return false;
  // A generic HTTP 429/rate_limit is not proof of a subscription quota wall.
  return /quota[_ -]?(?:exceeded|exhausted)|usage[_ -]?limit|you(?:'ve| have) hit your usage limit|额度.*(?:耗尽|用完|上限)/i.test(text);
}

function createCodexAccountSwitch({ sessionManager, profiles, readUsage, switchAccount, sendToPty,
  prepareCredentials = null, saveSession = () => {}, now = Date.now }) {
  const pending = new Map(), requests = new Map(), epochs = new Map(), turns = new Map();
  const admissions = new Map(), deferred = new Map(), checked = new Set(), switchedAt = new Map();
  const restarting = new Set(), preparing = new Set(), waitingInputs = new Map();
  const promptHints = new Map();
  const get = id => sessionManager.getSession(id);
  const epoch = id => epochs.get(id) || 0;
  const bump = id => epochs.set(id, epoch(id) + 1);
  const managed = s => !!(s && /^codex(?:-resume)?$/.test(s.kind) && s.agentRuntime === 'pty'
    && !s.runtimeBackend && s.codexProfile && s.codexProfile !== 'deepseek-api');
  const switchable = s => managed(s) && s.codexAccountProcessOwned === true;
  const eligible = s => switchable(s) && s.codexAutoSwitch === true;
  function publish(id, status, message, details = {}) {
    const s = sessionManager.updateSessionMeta(id, { codexSwitchStatus: { status, message, at: now(), ...details } });
    if (s) saveSession(s);
  }
  function reconcile(id) {
    if (checked.has(id)) return;
    checked.add(id);
    if (['switching', 'sending', 'refreshing'].includes(get(id)?.codexSwitchStatus?.status))
      publish(id, 'attention', '上次换号或继续结果未确认，请核对任务后手动继续');
  }
  function busy(id, { ownLease = null, ignoreQueued = false } = {}) {
    if ([...(admissions.get(id) || [])].some(lease => lease !== ownLease && (!ignoreQueued || lease.started))) return true;
    const s = get(id), turn = turns.get(id);
    const runtimes = [s, s?.cliRuntime, s?.nativeRuntime].filter(Boolean);
    const activeJob = job => !['completed', 'failed', 'cancelled', 'settled', 'done'].includes(job?.state || job?.status);
    if (runtimes.some(r => r.connection === 'disconnected' || r.state === 'unknown'
      || r.backgroundTasks?.some(activeJob) || r.backgroundActivities?.some(activeJob))
      || s?.backgroundJobs?.running?.length || s?.status === 'unknown') return true;
    if (turn && turn.nativeId === nativeId(s) && turn.generation === generation(s)) return turn.active;
    return sessionManager.isAgentTurnActive?.(id) === true || ['running', 'waiting', 'starting'].includes(s?.status)
      || ['running', 'waiting', 'starting'].includes(s?.cliRuntime?.state);
  }
  const find = id => profiles().find(p => p.id === id);
  function accountOptions(id) {
    const s = get(id);
    if (!managed(s)) return { ok: false, canSwitch: false, message: '此会话不是可切换账号的 Codex 订阅终端会话' };
    return { ok: true, canSwitch: switchable(s),
      reason: switchable(s) ? '' : '此旧会话尚未启用独立账号运行目录，请新建会话后切换账号', currentProfile: s.codexProfile,
      pendingProfile: requests.get(id)?.profile.id || null, pendingLabel: requests.get(id)?.profile.label || null,
      accounts: profiles().map(p => ({ id: p.id, label: p.label || p.id, current: p.id === s.codexProfile,
        available: p.available !== false && p.ready !== false, reason: p.reason || '' })) };
  }
  async function install(id, profile, guard, { preservePinned = false } = {}) {
    if (!guard()) return false;
    const before = get(id), priorGeneration = generation(before), sid = nativeId(before);
    restarting.add(id);
    const result = await switchAccount(id, profile, guard);
    if (result === false || result?.cancelled || result?.status === 'cancelled') return false;
    if (!result || result.ok === false) throw fault(result?.message || '账号切换结果未确认，请核对会话');
    if (result.notSwitched) return false;
    const live = get(id);
    if (!managed(live) || nativeId(live) !== sid) throw fault('原生会话归属发生变化，未自动继续');
    const updated = sessionManager.updateSessionMeta(id, { codexProfile: profile.id, codexProfileLabel: profile.label || profile.id,
      codexAccountPinned: preservePinned ? before.codexAccountPinned === true : true,
      codexAuthGeneration: Math.max(priorGeneration + 1, generation(live)) });
    if (!updated) throw fault('会话已关闭，账号切换结果需要核对');
    saveSession(updated);
    switchedAt.set(id, now());
    turns.delete(id);
    return true;
  }
  async function manual(id, request) {
    if (pending.has(id)) { try { await pending.get(id); } catch {} }
    if (requests.get(id) !== request || !switchable(get(id))) return { ok: true, status: 'cancelled' };
    if (busy(id)) return { ok: true, status: 'queued' };
    const initial = get(id), sid = nativeId(initial), gen = generation(initial);
    const startEpoch = epoch(id);
    const guard = ({ allowSuspended = false } = {}) => requests.get(id) === request && epoch(id) === startEpoch
      && !admissions.get(id)?.size && (allowSuspended
        ? (!get(id) || (switchable(get(id)) && nativeId(get(id)) === sid))
        : switchable(get(id)) && nativeId(get(id)) === sid && generation(get(id)) === gen && !busy(id));
    const task = (async () => {
      const reading = quota(await readUsage(request.profile), now());
      if (!guard()) return { ok: true, status: requests.get(id) === request ? 'queued' : 'cancelled' };
      if (!reading || reading.exhausted) throw fault('所选账号没有已确认的可用额度，保持当前账号');
      publish(id, 'switching', `正在切换到${request.profile.label || request.profile.id}…`, { mode: 'manual' });
      if (!await install(id, request.profile, guard)) {
        const status = requests.get(id) === request ? 'queued' : 'cancelled';
        publish(id, status, status === 'queued' ? '当前回合结束后切换账号' : '已取消账号切换');
        return { ok: true, status };
      }
      if (requests.get(id) === request) requests.delete(id);
      publish(id, 'switched', `已切换到${request.profile.label || request.profile.id}，下一条消息使用该账号`);
      return { ok: true, status: 'switched', session: get(id) };
    })();
    pending.set(id, task);
    try { return await task; }
    catch (error) {
      if (requests.get(id) === request) requests.delete(id);
      publish(id, 'attention', error.message);
      return { ok: false, message: error.message };
    } finally { if (pending.get(id) === task) { pending.delete(id); restarting.delete(id); } }
  }
  async function requestAccount(id, profileId) {
    // Once the old writer is being replaced, a new choice must not invalidate
    // the exact-resume guard and strand the session between two processes.
    // Usage lookup is still cancellable because it has not touched the writer.
    if (restarting.has(id) || preparing.has(id)) return { ok: false, message: '正在恢复会话或准备登录，请完成后再选择账号' };
    if (!managed(get(id))) return { ok: false, message: '此会话不支持账号切换' };
    if (!switchable(get(id))) return { ok: false, message: '此旧会话尚未启用独立账号运行目录，请新建会话后切换账号' };
    const profile = find(profileId);
    if (!profile) return { ok: false, message: '账号配置已移除' };
    if (profileId !== get(id).codexProfile && (profile.available === false || profile.ready === false))
      return { ok: false, message: profile.reason || '账号尚未准备好，请先登录' };
    bump(id); deferred.delete(id);
    if (get(id).codexProfile === profileId) {
      requests.delete(id); publish(id, 'cancelled', '已取消待执行的账号切换');
      return { ok: true, status: 'cancelled' };
    }
    const request = { profile }; requests.set(id, request);
    if (busy(id)) {
      publish(id, 'queued', `当前回合结束后切换到${profile.label || profile.id}`, { targetProfile: profile.id });
      return { ok: true, status: 'queued' };
    }
    return manual(id, request);
  }
  function replay(id) {
    if (admissions.has(id)) return;
    const failure = deferred.get(id); deferred.delete(id);
    if (failure && failure.epoch === epoch(id) && nativeId(get(id)) === failure.nativeId
      && generation(get(id)) === failure.generation && turns.get(id)?.turnId === failure.turnId) {
      turns.get(id).active = false;
      if (!requests.has(id)) void onFailure(failure.event).catch(e => publish(id, 'attention', e.message));
    }
    if (requests.has(id) && !busy(id)) void manual(id, requests.get(id)).catch(e => publish(id, 'attention', e.message));
  }
  async function beginSubmission(id, options = {}) {
    if (options.codexAccountProbe) {
      if (!pending.has(id) || get(id)?.codexAccountAttempt !== options.codexAccountProbe || !options.localCommandObserver) {
        throw Object.assign(fault('恢复探针与当前进程不匹配'),{notSent:true});
      }
      return () => {};
    }
    if (get(id)?.codexAccountUncertain) throw fault('换号后的运行状态尚未确认，请关闭后恢复；本条消息未发送');
    // The native writer may be absent during exact-SID restart. Finish that
    // transaction before admitting the next message; never bypass its barrier.
    if (pending.has(id) && (restarting.has(id) || preparing.has(id) || !managed(get(id)))) {
      waitingInputs.set(id, (waitingInputs.get(id) || 0) + 1);
      try { await pending.get(id); }
      finally { const remaining = (waitingInputs.get(id) || 1) - 1; if (remaining) waitingInputs.set(id, remaining); else waitingInputs.delete(id); }
      if (!managed(get(id))) throw fault('会话尚未恢复，本条消息未发送');
    }
    if (!managed(get(id))) return () => {};
    if (requests.has(id)) {
      if (pending.has(id)) await pending.get(id);
      if (requests.has(id)) throw fault('当前回合结束后将切换账号，请等切换完成再发送');
    }
    deferred.delete(id);
    if (!options.codexAccountContinuation) bump(id);
    const leases = admissions.get(id) || new Set();
    const lease = { continuation: !!options.codexAccountContinuation, started: false };
    leases.add(lease); admissions.set(id, leases);
    let released = false;
    const release = receipt => {
      if (released) return;
      released = true; leases.delete(lease);
      if (admissions.get(id) !== leases) return;
      if (!leases.size) admissions.delete(id);
      if (!managed(get(id))) return;
      const unknown = receipt?.ok !== true || (receipt.sendStatus && receipt.sendStatus !== 'ok');
      if (!receipt?.notSent && !options.localCommandObserver && (unknown || turns.get(id) === lease.baseline))
        turns.set(id, { ...(turns.get(id) !== lease.baseline ? turns.get(id) : {}),
          nativeId: nativeId(get(id)), generation: generation(get(id)), active: true });
      replay(id);
    };
    const markStarted = () => { lease.started = true; lease.baseline = turns.get(id); };
    release.started = typeof prepareCredentials !== 'function' ? markStarted : () => {
      if (lease.preparation) return lease.preparation;
      const prior = pending.get(id);
      preparing.add(id);
      // Publish the barrier before invoking any asynchronous credential code.
      // This task never drains its own submission queue.
      const task = Promise.resolve().then(async () => {
        if (prior) await prior;
        const initial = get(id), profile = initial && find(initial.codexProfile);
        const sid = nativeId(initial), gen = generation(initial), initialTurn = turns.get(id);
        const stillOwnsLease = () => !released && admissions.get(id) === leases && leases.has(lease);
        const sameSession = () => stillOwnsLease() && managed(get(id)) && !get(id).codexAccountUncertain
          && nativeId(get(id)) === sid && get(id).codexProfile === profile?.id && generation(get(id)) === gen;
        if (!profile || !sameSession()) throw fault('会话或账号已变化，本条消息未发送');
        const prepared = await prepareCredentials(id, profile);
        if (!sameSession()) throw fault('登录准备期间会话已变化，本条消息未发送');
        if (!prepared || typeof prepared.needsRestart !== 'boolean') throw fault('登录准备结果未确认，本条消息未发送');
        if (prepared.needsRestart) {
          const guard = ({ allowSuspended = false } = {}) => stillOwnsLease() && turns.get(id) === initialTurn
            && ![...leases].some(other => other !== lease && other.started)
            && (allowSuspended ? (!get(id) || (switchable(get(id)) && nativeId(get(id)) === sid
              && get(id).codexProfile === profile.id && !get(id).codexAccountUncertain))
              : sameSession() && switchable(get(id)) && !busy(id, { ownLease: lease, ignoreQueued: true }));
          if (!guard()) throw fault('登录已更新，请等当前回合和后台任务结束后再发送；本条消息未发送');
          if (lease.continuation) throw fault('继续前登录发生变化，请核对会话后手动继续；本条消息未发送');
          publish(id, 'refreshing', '登录已更新，正在恢复原生会话；消息尚未发送');
          if (!await install(id, profile, guard, { preservePinned: true })) throw fault('会话恢复已取消，本条消息未发送');
          publish(id, 'refreshed', '登录已更新，原生会话已恢复');
        }
        if (!stillOwnsLease() || !managed(get(id)) || get(id).codexAccountUncertain) throw fault('会话未确认，消息未发送');
        markStarted();
      }).catch(error => {
        const failure = error instanceof Error ? error : fault(String(error));
        failure.notSent = true;
        if (admissions.get(id) === leases && managed(get(id))) publish(id, 'attention', failure.message);
        throw failure;
      }).finally(() => {
        if (pending.get(id) === task) { pending.delete(id); preparing.delete(id); restarting.delete(id); }
      });
      lease.preparation = task;
      pending.set(id, task);
      return task;
    };
    try {
      if (pending.has(id)) await pending.get(id);
      if (!managed(get(id))) throw fault('会话已关闭，未发送');
      reconcile(id);
    } catch (error) { release({ notSent: true }); throw error; }
    return release;
  }
  function matching(event) {
    const s = get(event.sessionId), turn = turns.get(event.sessionId);
    return managed(s) && event.turnId && event.nativeSessionId === nativeId(s) && turn
      && turn.turnId === event.turnId && turn.generation === generation(s)
      && (!Number.isFinite(event.at) || event.at >= (turn.at || 0))
      && (event.generation == null || event.generation === generation(s)) ? turn : null;
  }
  function end(event) {
    const turn = matching(event);
    if (!turn) return false;
    turn.active = false;
    if (requests.has(event.sessionId)) { replay(event.sessionId); return true; }
    return false;
  }
  async function onFailure(event) {
    const id = event.sessionId;
    if (end(event)) return;
    if (!eligible(get(id)) || pending.has(id) || !matching(event) || !quotaFailure(event)) return;
    const leases = admissions.get(id);
    if (leases?.size) {
      const turn = turns.get(id);
      if ([...leases].every(l => l.started) && [...leases].some(l => l.baseline !== turn))
        deferred.set(id, { event, nativeId: nativeId(get(id)), generation: generation(get(id)), turnId: event.turnId, epoch: epoch(id) });
      return;
    }
    if (busy(id)) return;
    reconcile(id);
    const initial = get(id), previous = initial.codexSwitchStatus;
    const eventKey = `${event.nativeSessionId}:${event.turnId}`;
    if (previous?.status === 'attention' || previous?.eventKey === eventKey) return;
    const startEpoch = epoch(id), gen = generation(initial);
    const valid = ({ allowSuspended = false } = {}) => (allowSuspended && !get(id)
      || eligible(get(id)) && nativeId(get(id)) === event.nativeSessionId) && epoch(id) === startEpoch
      && !requests.has(id) && ![...(admissions.get(id) || [])].some(l => !l.continuation);
    let switched = false;
    const attempted = [...new Set([...(previous?.attempted || []), initial.codexProfile])];
    const task = (async () => {
      if (!quota(await readUsage(find(initial.codexProfile)), now())?.exhausted || !valid()) return;
      const candidates = [];
      for (const profile of profiles()) {
        if (attempted.includes(profile.id) || profile.available === false || profile.ready === false) continue;
        try { const reading = quota(await readUsage(profile), now()); if (reading && !reading.exhausted) candidates.push({ profile, reading }); } catch {}
      }
      if (!valid()) return;
      candidates.sort((a, b) => b.reading.remaining - a.reading.remaining || a.profile.id.localeCompare(b.profile.id));
      if (!candidates.length) { publish(id, 'waiting', '没有已确认可用的账号，请稍后继续', { eventKey, attempted }); return; }
      publish(id, 'switching', '额度已耗尽，正在切换账号并保留原生会话…', { eventKey, attempted });
      switched = await install(id, candidates[0].profile, (options = {}) => valid(options)
        && (options.allowSuspended || generation(get(id)) === gen && !busy(id)));
      if (switched) publish(id, 'switched', '账号已切换', { eventKey, attempted });
      else publish(id, 'cancelled', '检测到会话或新消息变化，本次未切换账号', { eventKey, attempted });
    })();
    pending.set(id, task);
    try { await task; }
    catch (error) { publish(id, 'attention', error.message, { eventKey, attempted }); return; }
    finally { if (pending.get(id) === task) { pending.delete(id); restarting.delete(id); } }
    if (!switched || !valid() || waitingInputs.get(id)) return;
    const switchedGeneration = generation(get(id));
    publish(id, 'sending', '账号已切换，正在提交继续', { eventKey, attempted, generation: switchedGeneration });
    promptHints.set(id, { own: true, nativeId: nativeId(get(id)), generation: switchedGeneration, at: now() });
    const stillSending = () => get(id)?.codexSwitchStatus?.status === 'sending'
      && get(id)?.codexSwitchStatus?.eventKey === eventKey && generation(get(id)) === switchedGeneration;
    try {
      const receipt = await sendToPty(id, CONTINUE_AFTER_SWITCH, get(id).kind, { codexAccountContinuation: true,
        requireReady: true, shouldSubmit: () => valid() && !waitingInputs.get(id) && generation(get(id)) === switchedGeneration,
        clientSubmissionId: `codex-quota-${id}-${switchedGeneration}` });
      if (!stillSending()) return;
      const accepted = receipt?.ok === true && !receipt.notSent && (!receipt.sendStatus || receipt.sendStatus === 'ok')
        && (!receipt.status || ['accepted', 'ok'].includes(receipt.status));
      publish(id, accepted ? 'continued' : 'attention', accepted ? '账号已切换，已提交继续' : '继续消息未获确认，请核对任务；不会自动重发', { eventKey, attempted });
    } catch (error) { if (stillSending()) publish(id, 'attention', '继续消息未获确认，请核对任务；不会自动重发', { eventKey, attempted }); }
  }
  function acceptsPrompt(event, s, native = false) {
    const prior = s && turns.get(s.id);
    // Hook dispatch timestamps need not precede the native task_started time.
    // Only a native-bound turn supplies an ordering floor for another native
    // event; generation and restart time still exclude the previous process.
    const turnAt = native && !prior?.turnId ? prior?.nativeFloorAt || 0 : prior?.at || 0;
    return managed(s) && event.nativeSessionId === nativeId(s)
      && (event.generation == null || event.generation === generation(s))
      && (!Number.isFinite(event.at) || event.at >= Math.max(switchedAt.get(s.id) || 0, turnAt));
  }
  return { manages: id => managed(get(id)) || pending.has(id), isSwitching: id => pending.has(id), accountOptions, requestAccount, beginSubmission, onFailure,
    onRuntimeChanged(id) { if (managed(get(id))) replay(id); },
    // Hook prompt ids and native task_started turn ids are different domains.
    // Hooks cancel stale work immediately; native events bind completion ids.
    onHookPrompt(event) {
      const s = get(event.sessionId);
      if (!acceptsPrompt(event, s)) return;
      const prior = turns.get(s.id);
      if (prior?.turnId && (event.turnId === prior.turnId || Number.isFinite(event.at) && event.at <= prior.at)) return;
      if (prior?.turnId && prior.active && !prior.hookObserved) {
        // The native start can beat UserPromptSubmit delivery. Bind that first
        // hook to the current turn instead of erasing its completion identity.
        prior.hookObserved = true;
        return;
      }
      const own = ['sending', 'continued'].includes(s.codexSwitchStatus?.status)
        && String(event.prompt || '').includes(CONTINUE_AFTER_SWITCH);
      if (!own) bump(s.id);
      deferred.delete(s.id);
      promptHints.set(s.id, { own, nativeId: nativeId(s), generation: generation(s), at: event.at });
      turns.set(s.id, { nativeId: nativeId(s), generation: generation(s), at: event.at, active: true,
        priorTurnId: prior?.turnId || prior?.priorTurnId,
        nativeFloorAt: prior?.turnId ? prior.at : prior?.nativeFloorAt });
    },
    onPrompt(event) {
      const s = get(event.sessionId);
      if (!event.turnId || !acceptsPrompt(event, s, true)) return;
      if (turns.get(s.id)?.priorTurnId === event.turnId) return;
      if (turns.get(s.id)?.turnId === event.turnId && turns.get(s.id)?.generation === generation(s)) return;
      deferred.delete(s.id);
      const hint = promptHints.get(s.id); promptHints.delete(s.id);
      const own = ['sending', 'continued'].includes(s.codexSwitchStatus?.status)
        && (String(event.prompt || '').includes(CONTINUE_AFTER_SWITCH)
        || (!event.prompt && hint?.own && hint.nativeId === nativeId(s) && hint.generation === generation(s)));
      if (!own) bump(s.id);
      turns.set(s.id, { turnId: event.turnId, nativeId: nativeId(s), generation: generation(s), at: event.at, active: true,
        hookObserved: !!(hint && hint.nativeId === nativeId(s) && hint.generation === generation(s)) });
    },
    onCompleted(event) {
      if (!matching(event)) return;
      deferred.delete(event.sessionId);
      if (end(event)) return;
      if (!pending.has(event.sessionId)) publish(event.sessionId, 'completed', '当前回合已完成', { attempted: [] });
    },
    forget(id) { bump(id); requests.delete(id); turns.delete(id); admissions.delete(id); deferred.delete(id); checked.delete(id); switchedAt.delete(id); promptHints.delete(id); },
  };
}

module.exports = { createCodexAccountSwitch, CONTINUE_AFTER_SWITCH, quota, quotaFailure };
