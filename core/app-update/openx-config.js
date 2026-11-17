'use strict';
// 公司内源（openx 社区上本产品的项目）。enabledInEdition 表示「这是公开版」：
// 公开版：程序更新和组件都先走内源，之后 GitHub → 阿里云（2026-11-16 定）。
// 成员版（2026-11-18 用户改定）：组件（转写、DSH 等 CLI、PPT Doctor、桌宠、外观、会议室组件）也先走内源，之后按原顺序走阿里云高速等外网源；
// 成员版自己的程序更新包不在内源上，不去内源找（查更新清单时会在后台预热一次内源版本列表，只读、不等结果，给随后的组件下载用）。
// 公开版导出时（tools/public-edition/strip-markers.js）换成下面注释里的那一行，enabledInEdition 变为 true。
module.exports = {
  enabledInEdition: true,
  api: 'https://openx.huawei.com/openxApi/project/version/release/query/',
  projectId: 7938,
  // 附件只接受这个站点同域名及其子域名的 https 地址。
  fileSite: 'https://openx.huawei.com/',
};
