'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');

function codeAgentCanStop(session, state) {
  return isCodeAgentKind(session?.kind) && session.agentRuntime === 'pty' && state === 'running';
}

function restoreRecoveredPrompt(input, recovery, { document, window, session, onChange }) {
  const skills = require('./composer-codeagent-skills');
  const draft = String(input.innerText ?? input.textContent ?? '');
  const existing = skills.selectedSkill(input);
  const append = !!draft.trim() || !!existing;
  const skill = append ? existing : recovery.skill;
  let text = append ? draft + (draft.trim() ? '\n\n' : '') + recovery.text : recovery.text;
  if (skill && text.startsWith('/' + skill.name)) text = text.slice(skill.name.length + 1).replace(/^ /, '');
  require('./composer-paste-chips').renderComposerValue(input, text, { document });
  if (skill) skills.insertSkillTag(input, skill, { document, window, session, focus: false, onChange });
  onChange();
  input.focus();
  try {
    const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  } catch { /* Detached drafts do not have a browser selection. */ }
}

function showStopToast(document, message) {
  document.getElementById('codeagent-stop-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'codeagent-stop-toast'; toast.className = 'codeagent-stop-toast'; toast.setAttribute('role', 'status');
  const text = document.createElement('span'); text.textContent = message; toast.append(text);
  document.body.append(toast);
  const timer = setTimeout(() => toast.remove(), 3000); timer.unref?.();
  return toast;
}

function createCodeAgentInputRecovery({ invoke, notify, isRunning }) {
  return {
    async stop(diagnostic = {}) {
      if (!isRunning()) { notify('回答已结束', 'info'); return; }
      const result = await invoke('codeagent:input-stop', { ...diagnostic, rendererState: 'running' });
      if (!result?.ok) { notify(result?.message || '停止失败，请到终端确认', 'warning'); return; }
      if (result.cleared === false) { notify('终端输入框未能清空，请到终端确认后再发送', 'warning'); return result; }
      if (result.notSent) return; // The send result restores this unsent draft exactly once.
      notify('已停止', 'info');
      return result;
    },
  };
}

module.exports = { codeAgentCanStop, restoreRecoveredPrompt, createCodeAgentInputRecovery, showStopToast };
