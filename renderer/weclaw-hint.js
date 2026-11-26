'use strict';
// 主进程只在本机装了员工助手时才给出提示（没装的人看不到这句）；按钮经 weclaw:open 打开员工助手。
// 各页能力不同，提示也分开说：帖子能整页改走员工助手；考勤只有首页摘要能由它读，打卡明细仍要在这里登录。
const TEXT = {
  forum: '打开员工助手并登录后会自动改走它，更稳。',
  attendance: '可选：打开员工助手并登录，它能读到考勤首页的待处理异常；打卡明细仍需在这里登录。',
};
function hintHtml(attr, btnClass, kind = 'forum') {
  return `<p class="wch-hint">${TEXT[kind] || TEXT.forum}<button type="button" class="${btnClass}" ${attr}="open-weclaw">打开员工助手</button></p>`;
}
async function openWeclaw() {
  const { ipcRenderer } = require('electron');
  const r = await ipcRenderer.invoke('weclaw:open');
  if (r && r.missing) throw new Error('这台电脑上没找到员工助手');
  if (r && r.ok === false) throw new Error(r.error || '没能打开员工助手');
  return r;
}
module.exports = { hintHtml, openWeclaw };
