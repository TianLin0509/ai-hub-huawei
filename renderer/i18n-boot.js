'use strict';
// 界面语言引导（2026-11-20）：尽早装好翻译层，英文模式下首帧就是英文。见 renderer/i18n-dom.js。
try {
  require('./i18n-dom.js').installI18n({ window, ipcRenderer: require('electron').ipcRenderer });
} catch (error) {
  console.warn('[i18n] 启动失败，界面保持中文：', error && error.message);
}
