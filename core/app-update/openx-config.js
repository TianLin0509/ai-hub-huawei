'use strict';
// 公司内源（openx 社区上本产品的项目）。enabledInEdition 表示「这是公开版」：
// 公开版：程序更新和组件都先走内源，之后 GitHub → 阿里云（2026-11-16 定）。
// 成员版（2026-11-18 用户改定）：组件（转写、DSH 等 CLI、PPT Doctor、桌宠、外观、会议室组件）也先走内源，之后按原顺序走阿里云高速等外网源；
// 2026-11-19 起只发统一包（专用扩展代码加密在包内，core/sealed-modules.js）：成员版与公开版都只认内源上的统一包版本，不再有 member-v<版本>。
// R29/R35（2026-11-24 用户定）：程序更新与所有组件下载只走内源，没有开关、不再落回外网源（openx-source.js active）。
module.exports = {
  // 2026-11-19 统一包：成员版（迁移版）也只认内源上的统一包，两版取同一份。
  enabledInEdition: true,
  api: 'https://openx.huawei.com/openxApi/project/version/release/query/',
  projectId: 7938,
  // R55（2026-11-27）：版本索引发布的 id。内源的版本列表接口改为要求登录后，客户端用 by_id（匿名可读）读这个发布的描述来代替列表，
  // 格式见 openx-source.js parseIndex，由发版流水线每次发布后更新。0 = 还没建，列表要求登录时如实提示、不兜底。
  indexReleaseId: 12787,   // 2026-11-28 在内源建好的 hub-index 发布
  // 社区只读黑板发布 id（community-board），建好后填此或由 feedback-receiver.json 下发。
  boardReleaseId: 12887,
  // 附件只接受这个站点同域名及其子域名的 https 地址。
  fileSite: 'https://openx.huawei.com/',
  // 内源上本产品的项目页（给用户的手动下载入口）。
  projectPage: 'https://openx.huawei.com/AI-Hub-Huawei',
};
