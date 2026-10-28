'use strict';

function eligible(session) {
  return !!session && /^codex(?:-resume)?$/.test(session.kind || '')
    && session.agentRuntime === 'pty' && !session.runtimeBackend && !!session.codexProfile
    && session.codexProfile !== 'deepseek-api';
}

// Account ownership only comes from session-updated. Selecting a row never
// changes the chip optimistically, nor does this component touch the draft.
function mountCodexAccountChip({ document: doc, tuningControls, sessionId, getSession, ipcRenderer, beforeSwitch }) {
  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'composer-chip composer-codex-account';
  chip.dataset.sessionId = sessionId;
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  tuningControls.append(chip);
  let menu = null, options = null, pendingProfile = null, inFlight = false;
  let disposed = false, request = 0, revision = 0, signature = '', feedback = null;

  function close() {
    request++;
    menu?.remove();
    menu = null;
    chip.setAttribute('aria-expanded', 'false');
  }

  function position() {
    if (!menu) return;
    const rect = chip.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth || 1024;
    const height = doc.defaultView?.innerHeight || 768;
    menu.style.left = Math.max(8, Math.min(rect.left, width - menu.getBoundingClientRect().width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.top - menu.getBoundingClientRect().height - 6, height - menu.getBoundingClientRect().height - 8)) + 'px';
  }

  function paintMenu() {
    if (!menu) return;
    menu.replaceChildren();
    const session = getSession();
    const status = session?.codexSwitchStatus;
    const pending = isQueued(status) ? status.targetProfile : pendingProfile;
    const note = doc.createElement('div');
    note.className = 'model-picker-note codex-account-note';
    note.setAttribute('role', 'status');
    note.dataset.state = feedback?.state || (isFailure(status) ? 'error' : 'pending');
    note.textContent = feedback?.message || (!options?.canSwitch && options?.reason) || status?.message || options?.reason
      || (options ? '选择此会话使用的账号；工作中会等本轮结束后切换。' : '正在读取账号…');
    for (const account of options?.accounts || []) {
      const current = account.id === session?.codexProfile;
      const cancelPending = current && !!pending;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'model-picker-item claude-account-option codex-account-option' + (current ? ' current' : '');
      button.dataset.profileId = account.id;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(current));
      button.disabled = inFlight || isSwitching(status) || !options.canSwitch
        || (!current && account.available !== true);
      button.textContent = `${current ? '✓ ' : ''}${account.label || account.id}`
        + (cancelPending ? ' · 当前账号（取消待切换）' : current ? ' · 当前账号' : '')
        + (account.id === pending ? ' · 待切换' : '')
        + (!account.available && !current && account.reason ? ` · ${account.reason}` : '');
      button.title = !options.canSwitch ? options.reason || '此会话暂不能切换账号' : account.reason || '';
      button.addEventListener('click', () => void select(account.id));
      menu.append(button);
    }
    menu.append(note);
    position();
  }

  function update() {
    if (disposed) return;
    const session = getSession();
    const next = JSON.stringify([session?.codexProfile, session?.codexProfileLabel,
      session?.codexAuthGeneration, session?.codexSwitchStatus]);
    if (signature !== next) {
      signature = next; revision++; feedback = null;
      pendingProfile = isQueued(session?.codexSwitchStatus)
        ? session.codexSwitchStatus.targetProfile : null;
    }
    chip.hidden = !eligible(session);
    if (chip.hidden) { close(); return; }
    const label = session.codexProfileLabel || session.codexProfile;
    chip.textContent = `账号 · ${label} ▾`;
    chip.setAttribute('aria-label', `Codex 账号：${label}`);
    chip.dataset.profileId = session.codexProfile;
    chip.dataset.status = session.codexSwitchStatus?.status || '';
    chip.title = feedback?.message || session.codexSwitchStatus?.message || '选择当前会话使用的 Codex 订阅账号';
    paintMenu();
  }

  async function open() {
    if (disposed || !eligible(getSession())) return;
    if (menu) { close(); return; }
    const session = getSession(), ticket = ++request;
    menu = doc.createElement('div');
    menu.className = 'model-picker-menu claude-account-menu codex-account-menu';
    menu.dataset.sessionId = sessionId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '选择 Codex 账号');
    doc.body.append(menu);
    chip.setAttribute('aria-expanded', 'true');
    options = null; feedback = null;
    paintMenu();
    try {
      const result = await ipcRenderer.invoke('session:codex-account-options', { sessionId });
      if (disposed || ticket !== request || getSession() !== session) return;
      if (!result?.ok) throw new Error(result?.reason || result?.message || '无法读取账号列表');
      options = result;
      pendingProfile = result.pendingProfile || null;
      paintMenu();
    } catch (error) {
      if (disposed || ticket !== request || getSession() !== session) return;
      feedback = { state: 'error', message: error.message || String(error) };
      paintMenu();
    }
  }

  async function select(profileId) {
    const account = options?.accounts?.find(row => row.id === profileId);
    const session = getSession();
    if (disposed || inFlight || !account || !options.canSwitch || !eligible(session)
      || isSwitching(session.codexSwitchStatus)
      || (profileId !== session.codexProfile && account.available !== true)) return;
    const startedRevision = revision;
    inFlight = true;
    feedback = { state: 'pending', message: '正在申请切换账号…' };
    paintMenu();
    try {
      await beforeSwitch?.();
      if (disposed || getSession() !== session || startedRevision !== revision) return;
      const result = await ipcRenderer.invoke('session:set-codex-account', { sessionId, profileId });
      if (disposed || getSession() !== session || startedRevision !== revision) return;
      if (!result?.ok) throw new Error(result?.message || result?.reason || '切换账号失败');
      pendingProfile = result.status === 'queued' ? profileId : null;
      feedback = { state: result.status === 'queued' ? 'pending' : 'success',
        message: result.message || ({ queued: '已排队，本轮结束后切换账号', switched: '账号已切换',
          unchanged: '当前已使用此账号', cancelled: '已取消待切换账号' }[result.status] || '请求已处理') };
    } catch (error) {
      if (disposed || getSession() !== session || startedRevision !== revision) return;
      feedback = { state: 'error', message: error.message || String(error) };
    } finally {
      inFlight = false;
      if (!disposed && getSession() === session) update();
    }
  }

  const outside = event => { if (menu && !menu.contains(event.target) && !chip.contains(event.target)) close(); };
  const keydown = event => { if (menu && event.key === 'Escape') { close(); chip.focus(); } };
  chip.addEventListener('click', event => { event.stopPropagation(); void open(); });
  doc.addEventListener('pointerdown', outside, true);
  doc.addEventListener('keydown', keydown);
  update();
  return { chip, update, open, select, dispose() {
    disposed = true; close();
    doc.removeEventListener('pointerdown', outside, true);
    doc.removeEventListener('keydown', keydown);
  } };
}

function isQueued(status) { return ['queued', 'manual-queued'].includes(status?.status); }
function isFailure(status) { return ['attention', 'manual-failed'].includes(status?.status); }

function isSwitching(status) {
  return status?.status === 'manual-switching' || status?.status === 'switching';
}

// A resumed writer must launch with its target account. The chip keeps the last
// confirmed ownership until the new writer's native session-start is verified.
function applyCodexAccountMeta(local, patch) {
  const status = patch.codexSwitchStatus !== undefined ? patch.codexSwitchStatus : local.codexSwitchStatus;
  const switching = isSwitching(status) || isFailure(status);
  let changed = false;
  for (const key of ['codexProfile', 'codexProfileLabel', 'codexAuthGeneration',
    'codexAutoSwitch', 'codexAccountPinned', 'codexSwitchStatus']) {
    if (!Object.hasOwn(patch, key)) continue;
    if (switching && ['codexProfile', 'codexProfileLabel', 'codexAuthGeneration'].includes(key)) continue;
    if (local[key] !== patch[key]) { local[key] = patch[key]; changed = true; }
  }
  return changed;
}

function preserveCodexAccountRestart(local, patch) {
  if (!local || !/^codex(?:-resume)?$/.test(local.kind || '')
    || patch?.suspendReason !== 'account-switch') return false;
  applyCodexAccountMeta(local, patch);
  // Keep DOM, draft controller, focus, preview, card and split-pane membership.
  const failed = patch.status === 'dormant' && isFailure(patch.codexSwitchStatus);
  local._codexAccountRestart = !failed;
  if (failed) local.status = 'dormant';
  local.suspendReason = 'account-switch';
  local._agentWorking = false;
  local.gcWorking = false;
  return true;
}

function resumeCodexAccountRestart(local, patch) {
  if (!local?._codexAccountRestart) return false;
  const account = Object.fromEntries(['codexProfile', 'codexProfileLabel', 'codexAuthGeneration']
    .map(key => [key, local[key]]));
  const ux = Object.fromEntries(['pinned', 'bottomed', 'unreadCount', 'lastOutputPreview', 'title']
    .map(key => [key, local[key]]));
  Object.assign(local, patch, ux, account, { suspendedAt: null, suspendReason: null, _codexAccountRestart: false });
  applyCodexAccountMeta(local, patch);
  return true;
}

module.exports = { eligible, mountCodexAccountChip, isSwitching, applyCodexAccountMeta,
  preserveCodexAccountRestart, resumeCodexAccountRestart };
