'use strict';
// AI HUB-H 的 WeLink 用户群（r46/r47，2026-11-18）：群号只写在这一处，底栏「用户群」弹层（渲染进程）和
// 反馈收件机的「一键入群」（主进程）都从这里读；以后加 3 群只改下面这张表。
// 群号属于公司内部信息；内源统一包只在公司内网分发，2026-11-28 起公开版（统一包）也带本文件。
// full：已知满员（WeLink 普通群上限 500 人）。收件机选群时还会实时查一次人数，这里只是先验，满了的群不显示「一键入群」。
const WELINK_USER_GROUPS = Object.freeze([
  Object.freeze({ name: 'AI HUB-H 用户群 2 群', id: '1032091168311185959', full: false }),
  Object.freeze({ name: 'AI HUB-H 用户群 1 群', id: '1027004116133667157', full: true }),
]);
// 实时人数达到这个数就当满员。
const GROUP_FULL_AT = 500;

function listGroups(groups = WELINK_USER_GROUPS) {
  return (Array.isArray(groups) ? groups : [])
    .filter(group => group && /^\d{6,}$/.test(String(group.id || '')) && String(group.name || '').trim())
    .map(group => ({ name: String(group.name).trim(), id: String(group.id), full: group.full === true }));
}

module.exports = { WELINK_USER_GROUPS, GROUP_FULL_AT, listGroups };
