'use strict';

const { isDeepStrictEqual } = require('node:util');

// 注意：memoryLinkWarning **故意不在这个名单里**。这里的语义是「新会话缺该字段就继承旧值」，
// 而 memory link 每次 spawn 都会重新检测——放进来会让警告一旦出现就永久粘住，修好了也删不掉
// （cwdFellBackFrom 能放是因为 healPersistedCwds 里有显式 delete 清除路径，它没有）。
const RESUME_META_FIELDS = [
  'nativeConfig',
  'cwdFellBackFrom',
  'transcriptPath',
  'codexSid',
  'acpSid',
  'codeagentRunMode',
  'codeagentLiteFeature',
  'featureAgent',
  'featureAgentChoice',
  'cardRunMode',
  'cardScope',
  'acpProfileId',
  'acpCapabilities',
  'runtimeBackend',
  'nativeRuntime',
  'codexApprovalPolicy',
  'codexSandbox',
  'codexSessionsRoot',
  'codexAllowMtimeFallback',
  'codexProfile',
  'claudeProfile',
  'claudeProfileLabel',
  'claudeConfigDir',
  'codexProfileLabel',
  'mcpProfile',
  'fastMode',
  'autonomous',
  'permissionMode',
  'workspaceGuard',
  'codexSpeedTier',
  'geminiChatId',
  'antigravityProfile',
  'antigravityProfileLabel',
  'antigravityProfileHome',
  'geminiProjectHash',
  'geminiProjectRoot',
  'kimiSid',
  'kimiSessionDir',
  'currentModel',
  'fixedModel',
  'modelPinSource',
  'modelChange',
  'codeagentUserModel',
  'codeagentModelPick',
  'codeagentModelProvider',
  'codeagentModelProviderLabel',
  'codeagentModelMenuLabel',
  'codeagentRouteModel',
  // 否则休眠 / 重启后显示名和侧栏图标退回占位或清单第一项（2026-10-18 用户反馈 v2.1.11）。
  'codeagentActualModel',
  // 后台 /model 换代但对不回清单时的记录（core/codeagent-models.js observeModel）：恢复会话据此改用 CodeAgent 默认模型。
  'codeagentBackendSwitch',
  'codeagentRequestedModel',
  'codeagentLaunchModel',
  'codeagentForkSourceSessionId',
  'codeagentPrefixFork',
  'codeagentPoolAccount',
  'codeagentPoolLabel',
  'companyProxyAccount',
  'companyProxyLabel',
  'companyUpstream',
  'effort',
  'contextPct',
  'contextUsed',
  'sessionUsage',
  'contextMax',
  'contextEffectiveMax',
  'contextEffectiveObservedAt',
  'lastCompletedAt',
  'lastRunStartedAt',
  'lastRunDurationMs',
  'recentArtifacts',
  'userRenamed',
  'autoTitleGenerated',
  'branchSourceSessionId',
  'branchIndex',
  'branchAutoTitlePending',
  'purpose',
  // Hub 招来的团队成员：恢复后系统提示仍不带组队指路（core/team-guide.js）。
  'hubTeamMember',
  'researchSessionId',
  'hiddenFromSidebar',
  'completionNotificationEnabled',
  'bottomed',
  // 已读异常与通知已读同义：renderer reload / Hub restart 后也不能重新播报
  // 同一条历史断连；真正的新失败由 transcript occurrenceId 重新升起。
  '_connectionIssueAck',
];
const PTY_CLEARED_FIELDS = new Set(['runtimeBackend', 'nativeRuntime', 'nativeConfig']);

function withoutVolatileTimestamps(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const { updatedAt: _updatedAt, savedAt: _savedAt, ...stable } = entity;
  return stable;
}

// Every persist round compares all 1400+ kept sessions. Most of them are
// shallow copies of the previous record (closed sessions without UI edits), so
// first check whether every field still holds the very same value; only fall
// back to the deep comparison when something was actually replaced.
function sameFieldValues(left, right) {
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Object.getOwnPropertySymbols(left).length || Object.getOwnPropertySymbols(right).length) return false;
  let count = 0;
  for (const key of Object.keys(left)) {
    if (key === 'updatedAt' || key === 'savedAt') continue;
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false;
    count += 1;
  }
  for (const key of Object.keys(right)) {
    if (key !== 'updatedAt' && key !== 'savedAt') count -= 1;
  }
  return count === 0;
}

function persistentEntityEquals(left, right) {
  if (!left || !right) return left === right;
  if (typeof left === 'object' && typeof right === 'object' && sameFieldValues(left, right)) return true;
  return isDeepStrictEqual(
    withoutVolatileTimestamps(left),
    withoutVolatileTimestamps(right),
  );
}

function mergeResumeMetaFields(list, previousSessions) {
  const oldByHubId = new Map((previousSessions || []).map(s => [s.hubId, s]));
  for (const newSession of list || []) {
    if (!newSession || !newSession.hubId) continue;
    const oldSession = oldByHubId.get(newSession.hubId);
    if (!oldSession) continue;
    // PTY 会话故意把原生后端与快照置空（isCodexSession 靠它们区分）。原生时代的
    // 会话在 PTY 里恢复后若继承旧值，落盘记录会仍是原生后端，重启后被当成原生会话。
    const ptyOwned = newSession.agentRuntime === 'pty';
    for (const field of RESUME_META_FIELDS) {
      if (ptyOwned && PTY_CLEARED_FIELDS.has(field)) continue;
      if (field === 'userRenamed' && oldSession.userRenamed === true) {
        newSession.userRenamed = true;
        continue;
      }
      if (newSession[field] == null && oldSession[field] != null) {
        newSession[field] = oldSession[field];
      }
    }
  }
  return list;
}

function buildMeetingsForState(meetingList, meetingManager) {
  if (!Array.isArray(meetingList)) {
    return meetingManager.getAllMeetings().filter(m => !(m.creationPending && !m.subSessions?.length));
  }
  return meetingList.filter(item => {
    const authoritative = item?.id && meetingManager.getMeeting(item.id);
    const meeting = authoritative || item;
    return !(meeting?.creationPending && !meeting.subSessions?.length);
  }).map(rendererMeeting => {
    if (!rendererMeeting || !rendererMeeting.id) return rendererMeeting;
    const authoritative = meetingManager.getMeeting(rendererMeeting.id);
    if (!authoritative) return rendererMeeting;
    const { sceneHint: _rendererSceneHint, ...rendererFields } = rendererMeeting;
    return {
      ...rendererFields,
      // Renames are acknowledged by MeetingRoomManager. An older queued
      // renderer snapshot must not roll the name/protection back afterwards.
      title: typeof authoritative.title === 'string' ? authoritative.title : rendererMeeting.title,
      titleRevision: Number(authoritative.titleRevision) || 0,
      scene: rendererMeeting.scene || authoritative.scene,
      ...require('../../core/group-scene-hint').sceneHintFields(authoritative.sceneHint),
      mode: rendererMeeting.mode || authoritative.mode,
      groupChat: typeof rendererMeeting.groupChat === 'boolean'
        ? rendererMeeting.groupChat
        : !!authoritative.groupChat,
      groupMode: rendererMeeting.groupMode || authoritative.groupMode || 'deliberation',
      groupRecentRawN: Number.isInteger(rendererMeeting.groupRecentRawN)
        ? rendererMeeting.groupRecentRawN
        : (Number.isInteger(authoritative.groupRecentRawN) ? authoritative.groupRecentRawN : 5),
      userRenamed: typeof authoritative.userRenamed === 'boolean' ? authoritative.userRenamed : !!rendererMeeting.userRenamed,
      autoTitlePending: typeof authoritative.autoTitlePending === 'boolean' ? authoritative.autoTitlePending : !!rendererMeeting.autoTitlePending,
      autoTitleGenerated: typeof authoritative.autoTitleGenerated === 'boolean' ? authoritative.autoTitleGenerated : !!rendererMeeting.autoTitleGenerated,
      completionNotificationEnabled: typeof rendererMeeting.completionNotificationEnabled === 'boolean'
        ? rendererMeeting.completionNotificationEnabled
        : !!authoritative.completionNotificationEnabled,
      bottomed: typeof rendererMeeting.bottomed === 'boolean'
        ? rendererMeeting.bottomed
        : !!authoritative.bottomed,
      lastCompletedAt: typeof rendererMeeting.lastCompletedAt === 'number'
        ? rendererMeeting.lastCompletedAt
        : (typeof authoritative.lastCompletedAt === 'number' ? authoritative.lastCompletedAt : null),
      participants: Array.isArray(rendererMeeting.participants)
        ? rendererMeeting.participants
        : (Array.isArray(authoritative.participants) ? authoritative.participants : null),
      slotSpecs: Array.isArray(rendererMeeting.slotSpecs)
        ? rendererMeeting.slotSpecs
        : (Array.isArray(authoritative.slotSpecs) ? authoritative.slotSpecs : null),
      covenantText: (typeof rendererMeeting.covenantText === 'string' && rendererMeeting.covenantText)
        ? rendererMeeting.covenantText
        : (authoritative.covenantText || ''),
      // 串行工作流配置（2026-06-17 maintainer）：state.json 是 boot 恢复源，必须带上；
      //   优先 renderer 值，兜底后端权威（update-meeting 已写入 authoritative）
      serialWorkflow: (rendererMeeting.serialWorkflow && typeof rendererMeeting.serialWorkflow === 'object')
        ? rendererMeeting.serialWorkflow
        : (authoritative.serialWorkflow || null),
      // 编排身份由主进程权威维护（成员由编排员动态加入），先取主进程值。
      orchestration: authoritative.orchestration || rendererMeeting.orchestration || null,
    };
  });
}

function handlePersistSessions(list, meetingList, deps, { deferStateSave = false } = {}) {
  if (!Array.isArray(list)) return false;

  const {
    getImmersiveByMeeting,
    getLastPersistedMeetingIds,
    getLastPersistedMeetings = () => [],
    getLastPersistedSessionIds,
    getLastPersistedSessions,
    meetingManager,
    meetingStore,
    sessionStore,
    setLastPersistedMeetingIds,
    setLastPersistedMeetings = () => {},
    setLastPersistedSessionIds,
    setLastPersistedSessions,
    stateStore,
  } = deps;

  // Guard: an empty list while two or more sessions were last persisted is far more
  // likely an incomplete renderer snapshot (restore not finished) than a user deleting
  // everything at once. Single deletes still flow through the normal diff below.
  if (list.length === 0) {
    const lastIds = getLastPersistedSessionIds();
    if (lastIds && lastIds.size >= 2) {
      console.warn(`[persist-sessions] refused empty session list (last persisted ${lastIds.size}), no records removed`);
      return false;
    }
  }

  const previousSessions = getLastPersistedSessions();
  const sharedViewerIds = new Set();
  const previousSessionsById = new Map(
    (previousSessions || []).filter(Boolean).map(session => [session.hubId, session]),
  );
  // User names are main-owned. Renderer autosave only supplies navigation,
  // runtime and draft metadata; a delayed window snapshot cannot rename.
  const { titleMetadata } = require('../../core/title-metadata');
  list = list.map(row => {
    const authoritative = deps.sessionManager?.getSession(row?.hubId) || previousSessionsById.get(row?.hubId);
    return authoritative ? { ...row, ...titleMetadata(authoritative) } : row;
  });
  // Closed copies in another Hub are navigation entries, not writers.
  // Keep unchanged entries without disk polling. Explicit edits and resume read
  // the current file under ownership protection instead of rewriting snapshots.
  const owners = deps.sessionManager?._openOwners?.();
  const uiFields = ['title','userRenamed','pinned','bottomed','completionNotificationEnabled','_connectionIssueAck'];
  const uiSnapshots = deps.sessionManager ? (deps.sessionManager._persistedUiInputs ||= new Map()) : new Map();
  let closedMetadataChanges = 0;

  if (owners) list = list.map(session => {
    if (!session?.hubId || deps.sessionManager.getSession(session.hubId)) return session;
    const lastInput = uiSnapshots.get(session.hubId) || previousSessionsById.get(session.hubId) || {};
    const edits = {};
    for (const field of uiFields) if (Object.hasOwn(session,field) && !isDeepStrictEqual(session[field],lastInput[field])) edits[field]=session[field];
    const accept = value => {uiSnapshots.set(session.hubId, Object.fromEntries(uiFields.map(field=>[field,session[field]])));return value;};
    const previous = previousSessionsById.get(session.hubId);
    if (previous && !Object.keys(edits).length) {
      sharedViewerIds.add(session.hubId);
      return accept({ ...previous });
    }
    const owner = owners.owner(session.hubId);
    const saved = sessionStore.loadSessionFile(session.hubId,{strict:true});
    if (owner && owner.pid !== process.pid) {
      sharedViewerIds.add(session.hubId);
      return accept(saved || session);
    }
    if (!saved) return accept(session);
    sharedViewerIds.add(session.hubId);
    if (!Object.keys(edits).length) return accept(saved);
    return owners.editClosed(session.hubId, () => {
      const latest=sessionStore.loadSessionFile(session.hubId,{strict:true}) || saved;
      const next={...latest,...edits,updatedAt:Date.now()};
      sessionStore.saveSessionFile(session.hubId,next);
      closedMetadataChanges++;
      return accept(next);
    });
  });
  mergeResumeMetaFields(list, previousSessions);
  // Only ids and member lists are needed; avoid cloning every meeting (timelines,
  // workflows) on each persist round.
  require('../../core/session-meeting-membership.js').restoreMissingMeetingIds(
    list, meetingManager.getMeetingMemberships?.() || meetingManager.getAllMeetings?.() || []);
  for (const session of list) {
    const live = deps.getLiveSession?.(session.hubId);
    // Renderer persistence can race the latest usage event. The main-process
    // snapshot owns accounting; never replace it with an older renderer copy.
    const authoritativeUsage = live?.sessionUsage || previousSessionsById.get(session.hubId)?.sessionUsage;
    if (authoritativeUsage) session.sessionUsage = authoritativeUsage;
    // During account restart the chip deliberately keeps the previous label.
    // A renderer autosave must not move the actual writer back to that account.
    if (live?.antigravityProfile) {
      Object.assign(session, {antigravityProfile:live.antigravityProfile,
        antigravityProfileLabel:live.antigravityProfileLabel,antigravityProfileHome:live.antigravityProfileHome});
    }
    if (live?.codexProfile) {
      Object.assign(session, require('../../core/session-capabilities').codexSessionAccountMeta(live), {
        codexProfile:live.codexProfile,codexProfileLabel:live.codexProfileLabel,
        codexSid:live.codexSid,codexSessionsRoot:live.codexSessionsRoot,
        transcriptPath:live.transcriptPath,
      });
    }
    if (live && ['codex-app-server','acp'].includes(live.runtimeBackend)) {
      session.runtimeBackend = live.runtimeBackend;
      session.nativeRuntime = require('../../core/codex-native-runtime.js').persistNativeRuntime(live);
      session.codexSid = live.codexSid;
      session.codexApprovalPolicy = live.codexApprovalPolicy;
      session.codexSandbox = live.codexSandbox;
      if(live.runtimeBackend==='acp') {
        session.acpSid=live.acpSid;session.acpProfileId=live.acpProfileId;session.acpCapabilities=live.acpCapabilities;
      }
      if (live.codexSharedControl?.role === 'viewer') sharedViewerIds.add(session.hubId);
    }
  }

  const nowTs = Date.now();
  let changedSessions = closedMetadataChanges;
  let changedMeetings = 0;
  let removedEntities = 0;

  const newSessionIds = new Set(list.map(session => session && session.hubId).filter(Boolean));
  for (const oldId of getLastPersistedSessionIds()) {
    if (!newSessionIds.has(oldId)) {
      const remove = () => {
        stateStore.markRemovedSession(oldId);
        sessionStore.deleteSessionFile(oldId);
        sessionStore.cancelDirty(oldId);
        removedEntities += 1;
      };
      try {
        if (owners) owners.editSessions([oldId], remove, { allowOwn: true });
        else remove();
      } catch (error) {
        if (error.code !== 'SESSION_OCCUPIED') throw error;
        const saved = sessionStore.loadSessionFile(oldId,{strict:true}) || previousSessionsById.get(oldId);
        sharedViewerIds.add(oldId);
        if (saved) { list.push(saved); newSessionIds.add(oldId); }
      }
    }
  }
  setLastPersistedSessionIds(newSessionIds);

  for (const session of list) {
    if (!session || !session.hubId) continue;
    const authoritative = deps.sessionManager?.getSession(session.hubId);
    Object.assign(session, require('../../core/session-model-pin').modelPinFields(authoritative || {}));
    if (authoritative?.runtimeBackend === 'claude-stream-json') {
      session.runtimeBackend = authoritative.runtimeBackend;
      session.nativeRuntime = authoritative.nativeRuntime;
      session.nativeConfig = authoritative.nativeConfig;
      session.ccSessionId = authoritative.ccSessionId;
    }
    // 接入方式只在主进程确定（缺 Key 不换线），渲染层漏带时以主进程为准。
    if (authoritative?.deepseekRoute && !session.deepseekRoute) session.deepseekRoute = authoritative.deepseekRoute;
    if (typeof authoritative?.codeagentModelPick === 'boolean') session.codeagentModelPick = authoritative.codeagentModelPick;
    Object.assign(session, require('../../core/codeagent-model-choice').routeFields(authoritative));
    if (authoritative?.codeagentForkSourceSessionId) session.codeagentForkSourceSessionId = authoritative.codeagentForkSourceSessionId;
    if (authoritative?.codeagentPrefixFork) session.codeagentPrefixFork = authoritative.codeagentPrefixFork;
    if (authoritative?.codeagentRouteModel) session.codeagentRouteModel = authoritative.codeagentRouteModel;
    // 运行方式、Lite 标记与功能选型以主进程为准（渲染层漏带时 Hub 重启后会被当成 PTY 会话或选型已变）。
    if (authoritative?.codeagentRunMode === 'serve') session.codeagentRunMode = 'serve';
    if (authoritative?.codeagentLiteFeature === true) session.codeagentLiteFeature = true;
    // 团队成员标记只在主进程定（招人时写入），渲染层自动保存漏带时以主进程为准。
    if (authoritative?.hubTeamMember === true) session.hubTeamMember = true;
    if (authoritative?.featureAgent) { session.featureAgent = authoritative.featureAgent; session.featureAgentChoice = authoritative.featureAgentChoice || ''; }
    for (const field of ['codeagentActualModel', 'codeagentRequestedModel', 'codeagentLaunchModel']) {
      if (authoritative?.[field]) session[field] = authoritative[field];
    }
    if (authoritative?.codeagentPoolAccount) { session.codeagentPoolAccount = authoritative.codeagentPoolAccount; session.codeagentPoolLabel = authoritative.codeagentPoolLabel || ''; }
    if (authoritative?.companyProxyAccount) { session.companyProxyAccount = authoritative.companyProxyAccount; session.companyProxyLabel = authoritative.companyProxyLabel || ''; }
    const previous = previousSessionsById.get(session.hubId);
    const changed = !previous
      || typeof previous.updatedAt !== 'number'
      || !persistentEntityEquals(session, previous);
    if (changed) {
      if (sharedViewerIds.has(session.hubId)) {
        session.updatedAt = typeof previous?.updatedAt === 'number' ? previous.updatedAt : nowTs;
        continue;
      }
      session.updatedAt = nowTs;
      sessionStore.markDirty(session.hubId, session);
      changedSessions += 1;
    } else {
      session.updatedAt = previous.updatedAt;
    }
  }

  setLastPersistedSessions(list);

  const meetingsForState = buildMeetingsForState(meetingList, meetingManager);
  const previousMeetings = getLastPersistedMeetings();
  const previousMeetingsById = new Map(
    (previousMeetings || []).filter(Boolean).map(meeting => [meeting.id, meeting]),
  );

  const newMeetingIds = new Set(meetingsForState.map(meeting => meeting && meeting.id).filter(Boolean));
  for (const oldId of getLastPersistedMeetingIds()) {
    if (!newMeetingIds.has(oldId)) {
      stateStore.markRemovedMeeting(oldId);
      meetingStore.deleteMeetingFile(oldId);
      meetingStore.cancelDirty(oldId);
      removedEntities += 1;
    }
  }
  setLastPersistedMeetingIds(newMeetingIds);

  const immersiveByMeeting = getImmersiveByMeeting();
  for (const meeting of meetingsForState) {
    if (meeting && meeting.id) {
      const immersive = immersiveByMeeting[meeting.id];
      if (typeof immersive === 'boolean') meeting.immersive = immersive;
      const previous = previousMeetingsById.get(meeting.id);
      const changed = !previous
        || typeof previous.updatedAt !== 'number'
        || !persistentEntityEquals(meeting, previous);
      if (changed) {
        meeting.updatedAt = nowTs;
        meetingStore.markDirty(meeting.id, meeting);
        changedMeetings += 1;
      } else {
        meeting.updatedAt = previous.updatedAt;
      }
    }
  }

  setLastPersistedMeetings(meetingsForState);

  if (!deferStateSave && (changedSessions > 0 || changedMeetings > 0 || removedEntities > 0)) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: list,
      meetings: meetingsForState,
      immersiveByMeeting,
    });
  }

  return true;
}

function registerPersistenceIpc(ipcMain, deps) {
  // 增量保存的底稿（见下方 persist-sessions:delta）：按发送窗口记上一份已保存的工作现场。
  const baselines = new Map();
  const senderKey = event => event?.sender?.id ?? 'default';
  ipcMain.handle('persist-sessions:flush', async (_e, list, meetingList) => {
    // 显式保存（重启前）不登记底稿，界面随后一律发整份；这里也删掉旧底稿，免得过期底稿被拿来拼增量（审查建议 2）。
    baselines.delete(senderKey(_e));
    if (!handlePersistSessions(list, meetingList, deps, { deferStateSave: true })) throw new Error('工作现场无效，未保存');
    await Promise.all([deps.sessionStore.flushPending(), deps.meetingStore.flushPending()]);
    // Background saving logs errors, whereas an explicit user save must fail
    // closed. Force the latest snapshot even when metadata compares unchanged
    // after an earlier failed attempt updated the in-memory persistence cache.
    await deps.stateStore.saveForRestart({
      version: 1, cleanShutdown: false,
      sessions: deps.getLastPersistedSessions(),
      meetings: deps.getLastPersistedMeetings(),
      immersiveByMeeting: deps.getImmersiveByMeeting(),
    });
    return { ok: true };
  });
  ipcMain.handle('get-dormant-sessions', () => ({
    sessions: deps.getLastPersistedSessions(),
    wasCleanShutdown: deps.bootWasClean,
  }));

  // 现在首次与每 30 次发整份并带序号；其余只发变了的条目和顺序，这里在上一份上拼回完整列表，
  // 浅复制后走原来的 handlePersistSessions（它会改写收到的条目，复制保证记着的那份不被改）。
  // 序号对不上、条目缺失或重复，一律让界面下次发整份，宁可多传不少存。
  const watchedSenders = new WeakSet();
  // saved 为假（空列表护栏拒绝、保存抛错）时不推进底稿、直接删掉：下一次增量对不上序号，界面会重发整份（审查建议 1）。
  const remember = (event, seq, list, meetingList, saved = true) => {
    const key = senderKey(event);
    if (!saved || !Number.isSafeInteger(seq)) { baselines.delete(key); return; }
    // 窗口销毁后底稿随之丢掉，不留旧窗口的整份会话表（审查建议 4）。
    const sender = event?.sender;
    if (sender && typeof sender === 'object' && typeof sender.once === 'function' && !watchedSenders.has(sender)) {
      watchedSenders.add(sender);
      try { sender.once('destroyed', () => baselines.delete(key)); } catch { /* 拿不到事件时底稿留到下次整份覆盖 */ }
    }
    baselines.set(key, { seq,
      sessions: new Map(list.filter(Boolean).map(row => [row.hubId, row])),
      meetings: new Map((Array.isArray(meetingList) ? meetingList : []).filter(Boolean).map(row => [row.id, row])) });
  };
  const save = (event, list, meetingList) => {
    try { return handlePersistSessions(list, meetingList, deps); }
    catch(error) {
      console.error('[session-persistence] save rejected:',error);
      event.sender?.send('session-persistence-error', {message:error.message});
      return false;
    }
  };
  ipcMain.on('persist-sessions', (_e, list, meetingList, meta) => {
    if (!Array.isArray(list)) { save(_e, list, meetingList); return; }
    const rows = list.map(row => (row && typeof row === 'object' ? { ...row } : row));
    const meetings = Array.isArray(meetingList) ? meetingList.map(row => (row && typeof row === 'object' ? { ...row } : row)) : meetingList;
    const saved = save(_e, rows, meetings) === true;
    remember(_e, meta?.seq, list, meetingList, saved);
  });
  ipcMain.on('persist-sessions:delta', (_e, delta) => {
    const key = senderKey(_e), base = baselines.get(key);
    const resync = () => { baselines.delete(key); _e.sender?.send('persist-sessions:resync'); };
    if (!base || !delta || base.seq !== delta.base || !Array.isArray(delta.order) || !Array.isArray(delta.meetingOrder)) return resync();
    const sessions = new Map(base.sessions), meetings = new Map(base.meetings);
    for (const row of delta.changed || []) if (row?.hubId) sessions.set(row.hubId, row);
    for (const row of delta.changedMeetings || []) if (row?.id) meetings.set(row.id, row);
    const list = delta.order.map(id => sessions.get(id));
    const meetingList = delta.meetingOrder.map(id => meetings.get(id));
    if (list.some(row => !row) || meetingList.some(row => !row)
        || new Set(delta.order).size !== delta.order.length || new Set(delta.meetingOrder).size !== delta.meetingOrder.length) return resync();
    const saved = save(_e, list.map(row => ({ ...row })), meetingList.map(row => ({ ...row }))) === true;
    remember(_e, delta.seq, list, meetingList, saved);
  });
}

module.exports = {
  RESUME_META_FIELDS,
  buildMeetingsForState,
  handlePersistSessions,
  mergeResumeMetaFields,
  persistentEntityEquals,
  registerPersistenceIpc,
};
