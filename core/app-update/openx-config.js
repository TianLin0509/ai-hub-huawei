'use strict';
// 公司内源（openx 社区上本产品的项目）。enabledInEdition 表示「这是公开版」：
// 公开版：程序更新和组件都先走内源，之后 GitHub → 阿里云（2026-11-16 定）。
// 成员版（2026-11-18 用户改定）：组件（转写、DSH 等 CLI、PPT Doctor、桌宠、外观、会议室组件）也先走内源，之后按原顺序走阿里云高速等外网源；
// 成员版程序更新包（2026-11-19 用户改定）也先走内源，只认内源上单独的 member-v<版本> 版本（与公开版同名不同内容，绝不混用）。
// 公开版导出时（tools/public-edition/strip-markers.js）换成下面注释里的那一行，enabledInEdition 变为 true。
module.exports = {
  enabledInEdition: true,
  api: 'https://openx.huawei.com/openxApi/project/version/release/query/',
  projectId: 7938,
  // 附件只接受这个站点同域名及其子域名的 https 地址。
  fileSite: 'https://openx.huawei.com/',
};
