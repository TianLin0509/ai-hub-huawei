'use strict';
// 主进程与已解包的公司反代共用同一套端口选择逻辑。
module.exports = require('./company-proxy/port-fallback.cjs');
