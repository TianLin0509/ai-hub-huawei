'use strict';

function delegationGuidance() {
  return '本团队只使用 CodeAgent；需要额外人手向负责人说明。';
}

// 开工时直接交给成员，不依赖负责人再次转述。
const RECEIPT_FORMAT = [
  '交付或汇报的回执格式：',
  '1. 第一句先回答负责人的问题，再讲结果或功能能否使用；',
  '2. 对照验收标准说明达到与否；',
  '3. 给出证据位置（命令与输出摘要、文件路径）；',
  '4. 说明未完成项与风险。',
];
module.exports = { delegationGuidance, RECEIPT_FORMAT };
