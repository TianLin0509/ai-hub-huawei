'use strict';

// 把新会话登记到对话记录接入（transcript tap）。登记失败不抛出（会话已建好，不能因此算创建失败），
// 而是返回 { ok: false, step: 'tap', message }，由新建流程带回界面给一行提示（renderer/session-create-outcome.js）。
// options 可以是函数：组装登记参数时出错（如读事件文件路径）也算登记没成，同样不抛出。
function registerTranscriptTap(transcriptTap, session, options, logger = console) {
  try {
    transcriptTap.registerSession(session.id, session.transcriptKind || session.kind, typeof options === 'function' ? options() : options);
    return { ok: true };
  } catch (error) {
    // 注册失败时 watcher 收不到 turn-complete 信号，群聊要等 180 秒软提醒才发现该成员「卡住」；日志方便定位。
    const message = (error && error.message) || String(error);
    logger.warn?.('[tap] registerSession failed for', String(session.id).slice(0, 8), session.kind, ':', message);
    return { ok: false, step: 'tap', message };
  }
}

module.exports = { registerTranscriptTap };
