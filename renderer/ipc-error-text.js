'use strict';

// Electron 把主进程抛的错包成「Error invoking remote method 'xxx': Error: 原因」。
// 给用户看时只留原因，前缀对同事没有意义，还会让人以为程序崩了。
function cleanIpcError(error) {
  const text = String(error && error.message ? error.message : error || '');
  return text.replace(/Error invoking remote method '[^']+': (?:Error: )?/g, '').trim();
}

module.exports = { cleanIpcError };
