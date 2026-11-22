'use strict';
// 只有整条回复都是暗号才静默；带有实际内容的汇报仍然显示。
const NO_UPDATE_MARK = '[[hub:no-update]]';
function isNoUpdateReply(text) {
  return /^\s*`?\[\[hub:no-update\]\]`?\s*$/.test(String(text || ''));
}
module.exports = { NO_UPDATE_MARK, isNoUpdateReply };
