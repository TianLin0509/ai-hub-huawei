'use strict';

function meetingAsrState(asr = {}, meeting = null) {
  const audio = (meeting?.events || []).filter(event => event.kind === 'audio' && event.asr !== 'done');
  const failed = audio.filter(event => event.asr === 'error').length;
  const installing = !!asr.phase;
  const setupText = asr.error ? `本地转写：${asr.error}` : installing ? `本地转写：${asr.phase}`
    : asr.ready ? '本地转写：已就绪' : '本地转写：未安装（约 500 MB）';
  const install = !asr.ready || !!asr.error;
  const reviewReady = !!meeting?.summary && !audio.length && !meeting.finalRequested
    && !(meeting.job && meeting.job.state !== 'error' && meeting.job.kind !== 'prime');
  return {
    setupText, install, installing, installLabel: asr.error ? '重新安装' : installing ? '安装中' : '现在安装',
    pending: audio.length, failed, reviewReady,
    reviewText: audio.length ? `等待本地转写：还有 ${audio.length} 段语音${failed ? `（${failed} 段失败）` : ''}`
      : reviewReady ? '纪要已生成' : '纪要整理中',
    reviewAction: audio.length ? (install ? 'install' : failed ? 'retry-asr' : '') : '',
  };
}

module.exports = { meetingAsrState };
