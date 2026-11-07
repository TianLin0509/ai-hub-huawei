'use strict';
// 隔离测试可用 CLAUDE_HUB_COMPANY_ATTENDANCE=1 打开（必须同时有隔离数据目录，生产实例改不了）。
function companyAttendanceEnabled(env = process.env, distribution = require('../distribution')) {
  if (env.CLAUDE_HUB_COMPANY_ATTENDANCE && env.CLAUDE_HUB_DATA_DIR) return env.CLAUDE_HUB_COMPANY_ATTENDANCE === '1';
  return distribution.target === 'company' && distribution.featureEnabled('companyAttendance');
}
module.exports = { companyAttendanceEnabled };
