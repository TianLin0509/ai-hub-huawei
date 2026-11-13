'use strict';
// 主进程建好门户待办服务后登记在这里，助理的工具分派（company-assistant/hub-tools.js）从这里拿，两边互不引用。
// 功能关着或这个版本没有时拿到 null。
let provider = null;
function setPortal(fn) { provider = typeof fn === 'function' ? fn : null; }
function portal() { try { return provider ? provider() : null; } catch { return null; } }
module.exports = { setPortal, portal };
