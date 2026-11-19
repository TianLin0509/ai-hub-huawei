'use strict';
// 页面里第一个脚本（2026-11-19）：主进程解开了包内加密模块时，接管本页面的 require（core/sealed-modules.js）；没解开什么也不做。
try { require('../core/sealed-modules').installRenderer(); } catch (error) { console.warn('[sealed] 界面接管失败：', error && error.message); }
