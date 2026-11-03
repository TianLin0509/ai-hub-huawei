'use strict';

const { isCodeAgentKind } = require('./ai-kinds');
const { getSessionRuntimeTruth } = require('./session-runtime-truth');
const CODEAGENT_STOP_ESC_GAP_MS = 300;
const CODEAGENT_RECOVER_WAIT_MS = 3000;
const CODEAGENT_INPUT_POLL_MS = 100;
const CODEAGENT_INPUT_READ_WAIT_MS = 1000;
const CODEAGENT_INPUT_RESIDUAL = 'codeagent-input-residual';
const controllers = new WeakMap();

// Read only the current editor, never transcript/output text above it. The same
// xterm screen mirror is used by the built-in-command entry point.
function inputSnapshot(lines) {
  const picker = require('./codeagent-model-picker');
  if (!picker.promptInputAvailable(lines)) return { state: 'unknown', text: '' };
  const at = lines.findLastIndex(line => /^\s*(?:[│┃]\s*)?[─\s]*[❯›>]/.test(line));
  if (at < 0) return { state: 'unknown', text: '' };
  const first = lines[at].replace(/^\s*(?:[│┃]\s*)?[─\s]*[❯›>]\s?/, '').replace(/\s*[│┃]\s*$/, '').trim();
  const state = require('./pty-prompt-submit').codeAgentInputState(lines, '');
  if (state === 'empty' || !first || /^(?:Anything I can assist you with\?|补充指令（Enter 排队|Try ")/.test(first)) return { state: 'empty', text: '' };
  const body = [first];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s*[│┃]/.test(line) || /Cycle shift\+tab|^[\s│┃─━└┘┌┐]+$/i.test(line)) break;
    body.push(line.replace(/^\s*[│┃]\s?/, '').replace(/\s*[│┃]\s*$/, '').trimEnd());
  }
  return { state: 'nonempty', text: body.join('\n').trim() };
}

function recoveryText(snapshot, previous) {
  const shown = String(snapshot.text || '');
  const squash = text => String(text).replace(/\s+/g, ' ').trim();
  const a = squash(shown).replace(/(?:…|\.\.\.)$/, ''), b = squash(previous?.text || '');
  const folded = /^\s*\[Pasted (?:text|content)\b/i.test(shown);
  const matches = a && b && (b.startsWith(a) || a.startsWith(b));
  if (previous && (folded || matches)) return { text: previous.text, skill: previous.skill || null, incomplete: false };
  return { text: shown, skill: null, incomplete: true };
}

function createCodeAgentInputGuard(manager, {
  openScreen = (sid) => require('./codeagent-model-picker').openSessionScreen(manager, sid),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  stopDiagnose = require('./codeagent-stop-log').recordCodeAgentStop,
  diagnose = event => {
    try {
      const fs = require('node:fs'), path = require('node:path');
      const dir = path.join(require('./data-dir').getHubDataDir(), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'codeagent-input.log');
      if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event }) + '\n');
    } catch { /* A failed diagnostic must not prevent a prompt submission. */ }
  },
} = {}) {
  const previous = new Map(), blocked = new Map(), stopping = new Set();
  // SessionManager.getSession returns a fresh public copy on every call. The
  // internal entry identifies a live PTY across those copies and changes on restart.
  const sessionKey = sid => {
    const entry = manager.sessions?.get?.(sid);
    if (entry) return entry.pty || entry;
    const info = manager.getSession(sid);
    return info ? JSON.stringify([sid, info.kind, info.createdAt, info.startedAt, info.pid, info.codeagentPoolAccount]) : null;
  };
  const session = sid => {
    const s = manager.getSession(sid);
    if (!s || !isCodeAgentKind(s.kind) || ['claude-stream-json', 'codex-app-server', 'acp'].includes(s.runtimeBackend)) throw new Error('当前会话不是可用的 CodeAgent 终端会话');
    return s;
  };
  async function read(sid, timeoutMs = CODEAGENT_INPUT_READ_WAIT_MS) {
    session(sid);
    let screen, timer, expired = false;
    try {
      const operation = (async () => {
        screen = await openScreen(sid);
        if (expired) { screen.dispose(); throw new Error('input-read-timeout'); }
        return inputSnapshot(await screen.lines());
      })();
      const snapshot = await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimer(() => { expired = true; screen?.dispose(); reject(new Error('input-read-timeout')); }, Math.max(1, timeoutMs));
      })]);
      if (snapshot.state === 'unknown') throw new Error('input-frame-unknown');
      return snapshot;
    } catch {
      diagnose('input-read-failed');
      return { state: 'unknown', text: '', readFailed: true };
    } finally { clearTimer(timer); screen?.dispose(); }
  }
  function describe(sid, snapshot) {
    if (snapshot.state !== 'nonempty') return { ok: true, input: null, readFailed: snapshot.readFailed === true };
    const saved = blocked.get(sid);
    const token = saved?.text === snapshot.text && saved.session === sessionKey(sid) ? saved.token : require('node:crypto').randomUUID();
    blocked.set(sid, { token, text: snapshot.text, session: sessionKey(sid) });
    const last = previous.get(sid);
    return { ok: false, notSent: true, code: CODEAGENT_INPUT_RESIDUAL, error: CODEAGENT_INPUT_RESIDUAL,
      message: '终端输入框有未发送内容，请先处理',
      input: { token, ...recoveryText(snapshot, last?.session === sessionKey(sid) ? last : null) } };
  }
  async function clear(sid, token) {
    const snapshot = await read(sid), saved = blocked.get(sid);
    if (snapshot.state === 'empty') { blocked.delete(sid); return { ok: true }; }
    if (!saved || token !== saved.token || saved.session !== sessionKey(sid) || snapshot.state !== 'nonempty' || snapshot.text !== saved.text) return { ...describe(sid, snapshot), ok: false, message: '终端输入已变化或无法确认，请重新取回' };
    manager.writeToSession(sid, '\x15');
    const deadline = now() + 800;
    do {
      await sleep(CODEAGENT_INPUT_POLL_MS);
      const after = await read(sid);
      if (after.state === 'empty') { blocked.delete(sid); return { ok: true }; }
    } while (now() < deadline);
    return { ok: false, notSent: true, message: '尚未确认终端输入已清空，请到终端确认' };
  }
  return {
    diagnose,
    async inspect(sid) { return describe(sid, await read(sid)); },
    async check(sid, { discardToken } = {}) {
      if (discardToken) {
        const cleared = await clear(sid, discardToken);
        if (!cleared.ok) return { ...cleared, notSent: true, code: CODEAGENT_INPUT_RESIDUAL, error: CODEAGENT_INPUT_RESIDUAL };
      }
      return describe(sid, await read(sid));
    },
    clear,
    remember(sid, text, skill) {
      for (const id of previous.keys()) if (!manager.getSession(id)) { previous.delete(id); blocked.delete(id); }
      previous.set(sid, { session: sessionKey(sid), text: String(text), skill: skill ? { name: skill.name, installedAt: skill.installedAt } : null });
    },
    async stop(sid, options = {}) {
      const target = manager.getSession(sid);
      const mainState = getSessionRuntimeTruth(target).state;
      const stopId = require('node:crypto').randomUUID();
      const log = (event, fields = {}) => stopDiagnose({ at: new Date(now()).toISOString(), sessionId: sid, stopId,
        branch: options.branch || 'external', rendererState: options.rendererState || 'unknown', mainState,
        event, ...fields });
      log('requested', { queuePending: options.queuePending === true, queueWaitMs: 0 });
      try { session(sid); } catch (error) { log('rejected'); throw error; }
      const targetKey = sessionKey(sid);
      const entry = manager.sessions?.get?.(sid);
      if (mainState === 'dormant' || ['dormant', 'closed', 'exited'].includes(target.status)
          || entry?.confirmedExit || entry?.pty === null || entry?.pty?.closed === true || entry?.pty?.exitCode != null) {
        log('rejected');
        return { ok: false, code: 'codeagent-already-idle', message: '回答已结束' };
      }
      if (stopping.has(sid)) return { ok: false, message: '正在停止，请稍候' };
      stopping.add(sid);
      try {
        options.beforeEsc?.();
        // Same raw write as terminal-input; no bracketed paste or Enter.
        manager.writeToSession(sid, '\x1b');
        log('esc-first');
        await sleep(CODEAGENT_STOP_ESC_GAP_MS);
        if (sessionKey(sid) !== targetKey) return { ok: false, message: '会话已变化' };
        manager.writeToSession(sid, '\x1b');
        log('esc-second');
        const deadline = now() + CODEAGENT_RECOVER_WAIT_MS;
        let input = null, readFailed = false, inputState = null, lastState = mainState, changed = false;
        do {
          if (sessionKey(sid) !== targetKey) { log('rejected'); return { ok: false, message: '会话已变化' }; }
          const state = getSessionRuntimeTruth(manager.getSession(sid)).state;
          if (state !== lastState) { log('runtime', { mainState: state }); lastState = state; }
          if (lastState !== mainState && !['running', 'unknown', 'starting'].includes(state)) changed = true;
          if (!input && !readFailed) {
            const snapshot = await read(sid, Math.min(CODEAGENT_INPUT_READ_WAIT_MS, Math.max(1, deadline - now())));
            if (snapshot.state !== inputState) { inputState = snapshot.state; log('input', { inputState }); }
            const result = describe(sid, snapshot);
            input = result.input || null; readFailed = result.readFailed === true;
          }
          if (now() >= deadline) {
            log('finished', { mainState: lastState, runtimeBecameNonRunning: changed, runtimeKnown: mainState !== 'unknown', inputState: inputState || 'unknown' });
            return { ok: true, stopRequested: true, input, readFailed };
          }
          await sleep(Math.min(CODEAGENT_INPUT_POLL_MS, deadline - now()));
        } while (true);
      } catch (error) { log('failed'); throw error;
      } finally { stopping.delete(sid); }
    },
  };
}

function codeAgentInputGuard(manager) {
  if (!controllers.has(manager)) controllers.set(manager, createCodeAgentInputGuard(manager));
  return controllers.get(manager);
}

module.exports = { codeAgentInputGuard, createCodeAgentInputGuard, inputSnapshot, recoveryText,
  CODEAGENT_STOP_ESC_GAP_MS, CODEAGENT_RECOVER_WAIT_MS, CODEAGENT_INPUT_RESIDUAL };
