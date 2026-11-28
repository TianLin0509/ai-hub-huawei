'use strict';
// 真机压测脚本的总判定（审查 P2）：用例全过、收尾关得掉，而且本轮任何一次关 Hub 都没出过错
// （中途「转换中关 Hub」失败后即使被强制结束、下一次 close 返回 true，也算失败）。
function e2ePassed(report, closed) {
  return !report.error && report.checks.length > 0 && report.checks.every(x => x.ok) && closed === true
    && !report.hubLeft && !(report.quitErrors && report.quitErrors.length);
}
module.exports = { e2ePassed };
