'use strict';

function eligible(session) {
  return !!session && /^claude(?:-resume)?$/.test(session.kind || '')
    && session.agentRuntime === 'pty' && !session.runtimeBackend && !!session.claudeProfile;
}

// Account ownership only comes from session-updated. Selecting a row never
// changes the chip optimistically, nor does this component touch the draft.
function mountClaudeAccountChip({ document: doc, tuningControls, sessionId, getSession, ipcRenderer }) {
  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'composer-chip composer-claude-account';
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
    const status = session?.claudeSwitchStatus;
    const pending = status?.status === 'manual-queued' ? status.targetProfile : pendingProfile;
    const note = doc.createElement('div');
    note.className = 'model-picker-note claude-account-note';
    note.setAttribute('role', 'status');
    note.dataset.state = feedback?.state || (status?.status === 'manual-failed' ? 'error' : 'pending');
    note.textContent = feedback?.message || (!options?.canSwitch && options?.reason) || status?.message || options?.reason
      || (options ? '选择此会话使用的账号；工作中会等本轮结束后切换。' : '正在读取账号…');
    for (const account of options?.accounts || []) {
      const current = account.id === session?.claudeProfile;
      const cancelPending = current && !!pending;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'model-picker-item claude-account-option' + (current ? ' current' : '');
      button.dataset.profileId = account.id;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(current));
      button.disabled = inFlight || status?.status === 'manual-switching' || !options.canSwitch
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
    const next = JSON.stringify([session?.claudeProfile, session?.claudeProfileLabel,
      session?.claudeAuthGeneration, session?.claudeSwitchStatus]);
    if (signature !== next) {
      signature = next; revision++; feedback = null;
      pendingProfile = session?.claudeSwitchStatus?.status === 'manual-queued'
        ? session.claudeSwitchStatus.targetProfile : null;
    }
    chip.hidden = !eligible(session);
    if (chip.hidden) { close(); return; }
    const label = session.claudeProfileLabel || session.claudeProfile;
    chip.textContent = `账号 · ${label} ▾`;
    chip.setAttribute('aria-label', `Claude 账号：${label}`);
    chip.dataset.profileId = session.claudeProfile;
    chip.dataset.status = session.claudeSwitchStatus?.status || '';
    chip.title = feedback?.message || session.claudeSwitchStatus?.message || '选择当前会话使用的 Claude 订阅账号';
    paintMenu();
  }

  async function open() {
    if (disposed || !eligible(getSession())) return;
    if (menu) { close(); return; }
    const session = getSession(), ticket = ++request;
    menu = doc.createElement('div');
    menu.className = 'model-picker-menu claude-account-menu';
    menu.dataset.sessionId = sessionId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '选择 Claude 账号');
    doc.body.append(menu);
    chip.setAttribute('aria-expanded', 'true');
    options = null; feedback = null;
    paintMenu();
    try {
      const result = await ipcRenderer.invoke('session:claude-account-options', { sessionId });
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
      || session.claudeSwitchStatus?.status === 'manual-switching'
      || (profileId !== session.claudeProfile && account.available !== true)) return;
    const startedRevision = revision;
    inFlight = true;
    feedback = { state: 'pending', message: '正在申请切换账号…' };
    paintMenu();
    try {
      const result = await ipcRenderer.invoke('session:set-claude-account', { sessionId, profileId });
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

module.exports = { eligible, mountClaudeAccountChip };
