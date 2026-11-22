'use strict';
// 网络用量与上传限制·界面进程（core/net-guard.js，2026-11-23）：界面进程开着 Node，这里在其余脚本之前装好 http/https 与子进程的检查。
// 普通安装没有限制模块，这里什么都不做。
try { require('../core/net-guard').installNodeGuard(); } catch (error) { console.warn('[net-usage] 界面进程初始化失败：', error && error.message); }
