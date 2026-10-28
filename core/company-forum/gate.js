'use strict';
// 隔离测试可用 CLAUDE_HUB_COMPANY_FORUM=1 打开（必须同时有隔离数据目录，生产实例改不了）。
function companyForumEnabled(env = process.env, distribution = require('../distribution')) {
  if (env.CLAUDE_HUB_COMPANY_FORUM && env.CLAUDE_HUB_DATA_DIR) return env.CLAUDE_HUB_COMPANY_FORUM === '1';
  return distribution.target === 'company' && distribution.featureEnabled('companyForum');
}
module.exports = { companyForumEnabled };
