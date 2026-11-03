'use strict';

const { isCodeAgentKind } = require('../core/ai-kinds');

function codeAgentCanStop(session, state) {
  return isCodeAgentKind(session?.kind) && session.agentRuntime === 'pty' && state === 'running';
}

function restoreRecoveredPrompt(input, recovery, { document, window, session, onChange }) {
  let text = recovery.text;
  if (recovery.skill && text.startsWith('/' + recovery.skill.name)) text = text.slice(recovery.skill.name.length + 1).replace(/^ /, '');
  require('./composer-paste-chips').renderComposerValue(input, text, { document });
  if (recovery.skill) require('./composer-codeagent-skills').insertSkillTag(input, recovery.skill, { document, window, session, onChange });
  onChange();
  input.focus();
}

function createCodeAgentInputRecovery({ document, host, invoke, readDraft, restoreDraft, notify, isRunning, confirmReplace }) {
  const panel = document.createElement('section');
  panel.className = 'codeagent-input-recovery'; panel.hidden = true;
  panel.setAttribute('role', 'status');
  const text = document.createElement('span'), recover = document.createElement('button'), discard = document.createElement('button');
  recover.type = discard.type = 'button'; recover.textContent = '取回编辑'; discard.textContent = '丢弃';
  panel.append(text, recover, discard); host.append(panel);
  let current = null, busy = false;
  async function takeBack(result, automatic = false) {
    if (!result?.input) return false;
    const draft = readDraft();
    if (draft.trim()) {
      if (automatic) { show(result); text.textContent = '终端有未发送的提示词，当前草稿已保留'; return false; }
      if (!await confirmReplace('当前输入框已有草稿。用取回内容替换当前草稿？选择取消将保留当前草稿。')) return false;
    }
    if (readDraft() !== draft) { notify('当前草稿已变化，未覆盖，请重新取回', 'warning'); return false; }
    restoreDraft(result.input);
    // Preserve the recovered original in Hub before clearing the terminal. Clear
    // checks the editor token again; a changed editor is never silently erased.
    const cleared = await invoke('codeagent:input-clear', { token: result.input.token });
    if (!cleared?.ok) { if (cleared?.input) show(cleared); notify(cleared?.message || '无法确认终端输入已清空', 'warning'); return false; }
    panel.hidden = true; current = null;
    notify(result.input.incomplete ? '已取回终端可读内容，可能不完整' : '上一条提示词已取回，可继续编辑', result.input.incomplete ? 'warning' : 'info');
    return true;
  }
  function show(result, retry = null) {
    current = { result, retry }; text.textContent = result.message || '终端输入框有未发送内容，请先处理'; panel.hidden = false;
  }
  async function action(fn) {
    if (busy) return;
    busy = true; recover.disabled = discard.disabled = true;
    try { await fn(); }
    catch { notify('无法操作终端输入，请到终端确认', 'warning'); }
    finally { busy = false; recover.disabled = discard.disabled = false; }
  }
  recover.addEventListener('click', () => action(async () => {
    const latest = await invoke('codeagent:input-inspect', {});
    if (!latest?.input) { notify('未发现可取回的提示词', 'info'); return; }
    await takeBack(latest);
  }));
  discard.addEventListener('click', () => action(async () => {
    const pending = current;
    if (!pending) return;
    if (pending.retry) { panel.hidden = true; await pending.retry(pending.result.input?.token); return; }
    const cleared = await invoke('codeagent:input-clear', { token: pending.result.input?.token });
    if (!cleared?.ok) { if (cleared?.input) show(cleared); notify(cleared?.message || '终端输入未清空', 'warning'); return; }
    current = null; panel.hidden = true; notify('已丢弃终端残留，当前草稿已保留', 'info');
  }));
  return { panel, show, takeBack,
    submitted(value) { if (readDraft() === value) restoreDraft({ text: '', skill: null }); panel.hidden = true; current = null; },
    async stop(diagnostic = {}) {
      if (!isRunning()) { notify('回答已结束', 'info'); return; }
      const result = await invoke('codeagent:input-stop', { ...diagnostic, rendererState: 'running' });
      if (!result?.ok) { notify(result?.message || '停止失败，请到终端确认', 'warning'); return; }
      if (result.input) await takeBack(result, true);
      else notify(result.readFailed ? '停止指令已发送，暂时无法读取终端输入，请到终端确认' : '停止指令已发送，未发现可取回的提示词', result.readFailed ? 'warning' : 'info');
    },
  };
}

module.exports = { codeAgentCanStop, restoreRecoveredPrompt, createCodeAgentInputRecovery };
