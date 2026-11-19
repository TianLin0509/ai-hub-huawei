'use strict';

function meetingAsrState(asr = {}, meeting = null) {
  const audio = (meeting?.events || []).filter(event => event.kind === 'audio' && event.asr !== 'done');
  const failed = audio.filter(event => event.asr === 'error').length;
  const installing = !!asr.phase;
  const size = asr.sizeText || '300 MB';
  // r59：有结构化进度时，数字由下方统一进度条显示，这里只留一句话。
  const setupText = asr.error ? `本地转写：${asr.error}` : installing && asr.progress ? '本地转写：正在安装，可以先录音，装好后自动补转写' : installing ? `本地转写：${asr.phase}`
    : asr.upgrade ? `本地转写：旧引擎可用但较慢，建议升级（约 ${size}，更快、中文更准）` : asr.ready ? '本地转写：已就绪' : `本地转写：未安装（约 ${size}）`;
  const install = !asr.ready || !!asr.error || !!asr.upgrade;
  const reviewReady = !!meeting?.summary && !audio.length && !meeting.finalRequested
    && !(meeting.job && meeting.job.state !== 'error' && meeting.job.kind !== 'prime');
  return {
    setupText, install, installing, installLabel: asr.error ? '重新安装' : installing ? '安装中' : asr.upgrade ? '升级转写引擎' : '现在安装',
    pending: audio.length, failed, reviewReady,
    reviewText: audio.length ? `等待本地转写：还有 ${audio.length} 段语音${failed ? `（${failed} 段失败）` : ''}`
      : reviewReady ? '纪要已生成' : '纪要整理中',
    reviewAction: audio.length ? (install ? 'install' : failed ? 'retry-asr' : '') : '',
  };
}

module.exports = { meetingAsrState };
