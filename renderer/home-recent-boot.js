'use strict';
// 主页「接着做」和快捷键表的挂载（页面不允许内联脚本，这里单独一个文件）。
require('./home-recent').mount({ document, getSessions: () => sessions, selectSession, escapeHtml });
require('./shortcut-help').mount({ document, escapeHtml });
require('./attention-jump').mount({ document, getSessions: () => sessions, getActiveSessionId: () => activeSessionId, selectSession });
