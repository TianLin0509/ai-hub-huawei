'use strict';
// 桌宠设置「没存上」怎么说（2026-11-21）：以前保存失败一律吞掉，开关看着变了、其实没存上，重启后又回去。
// 两处设置界面共用：助理 → 设置 → 桌宠（pet-settings-tab.js）、Hub 配置里的「助理桌宠」（hub-settings.js）。
// result：hub-pet:set-settings 的返回；error：调用本身抛出的错误。存好了返回空串，否则返回一句「原因 + 下一步」。

const REASONS = Object.freeze({
  EPERM: '没有写入权限（数据目录可能是只读的，或被安全软件拦了）',
  EACCES: '没有写入权限（数据目录可能是只读的，或被安全软件拦了）',
  EROFS: '数据目录所在的盘是只读的',
  ENOSPC: '磁盘空间满了',
  EBUSY: '设置文件正被别的程序占用',
});

function saveFailureText(result, error) {
  if (error) return `没存上：${(error && error.message) || error}。开关已恢复成原来的样子，请再点一次；还不行就点「设置 → 一键反馈」告诉维护人。`;
  if (!result) return '没存上：Hub 没有收到保存结果。开关已恢复成原来的样子，请再点一次；还不行就重启 Hub 再试。';
  const e = result.saveError;
  if (!e) return '';
  const reason = REASONS[e.code] || e.message || '写设置文件失败';
  return `这次改动已生效，但没存进设置文件：${reason}。重启 Hub 后会恢复原样；腾出磁盘空间或解除只读后再改一次即可保存。`;
}

module.exports = { saveFailureText };
