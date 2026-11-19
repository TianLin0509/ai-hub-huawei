'use strict';
// 公司内源（openx 社区上本产品的项目）。enabledInEdition 表示「这是公开版」：
// 公开版：程序更新和组件都先走内源，之后 GitHub → 阿里云（2026-11-16 定）。
// 成员版（2026-11-18 用户改定）：组件（转写、DSH 等 CLI、PPT Doctor、桌宠、外观、会议室组件）也先走内源，之后按原顺序走阿里云高速等外网源；
// 2026-11-19 起只发统一包（专用扩展代码加密在包内，core/sealed-modules.js）：成员版与公开版都只认内源上的统一包版本，不再有 member-v<版本>。
module.exports = {
  // 2026-11-19 统一包：成员版（迁移版）也只认内源上的统一包，两版取同一份。
  enabledInEdition: true,
  api: 'https://openx.huawei.com/openxApi/project/version/release/query/',
  projectId: 7938,
  // 附件只接受这个站点同域名及其子域名的 https 地址。
  fileSite: 'https://openx.huawei.com/',
};
