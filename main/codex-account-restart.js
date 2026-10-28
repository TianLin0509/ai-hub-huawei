'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// No credential copying: the official CLI owns each account's auth.json.
// Reopen the exact native thread after the previous writer has exited.
function createCodexAccountRestart({ sessionManager, restartSession, saveSession, sendToRenderer, confirmResume, validateLaunch,
  readyTimeoutMs = 45000 }) {
  return async function switchAccount(id, profile, guard) {
    const old = sessionManager.getSession(id);
    if (!old || !guard()) return {ok:false,notSwitched:true,message:'会话状态已变化，未切换账号'};
    if (!old.codexSid || !old.transcriptPath || !fs.existsSync(old.transcriptPath)) {
      return {ok:false,notSwitched:true,message:'尚未找到完整原生会话记录，请等首轮回答结束后再切换'};
    }
    if (old.purpose === 'xresearch-research' || old.writingScope || old.writingContextWarning) {
      return {ok:false,notSwitched:true,message:'此专用会话使用独立运行配置，暂不从输入框切换账号'};
    }
    const historyHome = old.codexHistoryStorageHome || path.dirname(old.codexSessionsRoot || path.dirname(old.transcriptPath));
    const sqliteHome = require('../core/codex-global-account').historySqliteHomeSync(historyHome,
      old.codexHistorySqliteHome || old.nativeRuntime?.sqliteHome);
    if (!fs.existsSync(sqliteHome) || !fs.readdirSync(sqliteHome).some(name => /^state_\d+\.sqlite$/.test(name))) {
      return {ok:false,notSwitched:true,message:'原生历史索引尚未就绪，未切换账号'};
    }
    if (validateLaunch) await validateLaunch(old);
    if (!guard()) return {ok:false,notSwitched:true,message:'会话状态已变化，未切换账号'};
    const attempt = randomUUID();
    const sameHistory = file => {
      try { return !!file && fs.realpathSync(file).toLowerCase() === fs.realpathSync(old.transcriptPath).toLowerCase(); }
      catch { return false; }
    };
    let timer, listener;
    const ready = new Promise(resolve => {
      listener = event => {
        if (event.sessionId === id && event.attempt === attempt && event.nativeSessionId === old.codexSid
            && sameHistory(event.transcriptPath)) resolve(true);
      };
      sessionManager.on('codex-account-resumed', listener);
      timer = setTimeout(() => resolve(false), readyTimeoutMs);
      timer.unref?.();
    });
    const cleanup = () => { clearTimeout(timer); sessionManager.removeListener('codex-account-resumed',listener); };
    try {
      const fresh = await restartSession(id, {
        codexProfile:profile.id,codexAccountPinned:true,
        codexContextProfile:old.codexContextProfile || old.codexProfile,
        codexHistoryStorageHome:historyHome,codexAccountAttempt:attempt,
        codexAccountExpectedTranscript:old.transcriptPath,
        codexAuthGeneration:(old.codexAuthGeneration || 0)+1,
        codexSwitchStatus:old.codexSwitchStatus,
      }, {reason:'account-switch',guard});
      if (!fresh || fresh.ok === false) throw new Error(fresh?.message || '原生会话恢复失败');
      if (!(await (confirmResume ? confirmResume(fresh,guard) : ready))) throw new Error('新账号的原生会话恢复未确认，未自动继续；请查看后台或重连');
      const current = sessionManager.getSession(id);
      if (!current || current.codexSid !== old.codexSid || current.codexProfile !== profile.id || !sameHistory(current.transcriptPath)
          || !guard({allowSuspended:true})) throw new Error('会话状态已变化，未自动继续');
      sessionManager.updateSessionMeta?.(id,{codexAccountExpectedTranscript:null});
      return {ok:true,session:current};
    } catch (error) {
      let current = sessionManager.getSession(id);
      // A failed ready check must never leave a sendable, unverified writer.
      if (current?.codexAccountAttempt === attempt && sessionManager.suspendSession) {
        const stopped = sessionManager.suspendSession(id,{reason:'account-switch'});
        if (stopped?.ok) await require('./ipc/session-handlers').waitForSessionGone(sessionManager,id);
        current = sessionManager.getSession(id);
        if (current?.codexAccountAttempt === attempt) sessionManager.updateSessionMeta(id,{
          codexAccountUncertain:true,codexSwitchStatus:{status:'attention',message:'换号后的进程尚未停止，请关闭后恢复；消息未发送',at:Date.now()}});
      }
      if (!current) {
        const dormant = {...old,status:'dormant',suspendReason:'account-switch',
          codexSwitchStatus:{status:'manual-failed',message:error.message,at:Date.now()}};
        saveSession(dormant);
        sendToRenderer('session-suspended',{sessionId:id,session:dormant});
      }
      return {ok:false,message:error.message,notSwitched:!!current && current.codexSid === old.codexSid
        && current.codexProfile === old.codexProfile && current.codexAuthGeneration === old.codexAuthGeneration
        && current.codexAccountAttempt === old.codexAccountAttempt};
    } finally { cleanup(); }
  };
}

module.exports = {createCodexAccountRestart};
