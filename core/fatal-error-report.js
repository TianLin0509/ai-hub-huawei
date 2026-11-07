'use strict';
// 主进程出现未捕获异常时：先把原因写进 diagnostics/fatal-<时间>.txt，再弹一个说人话的对话框，最后退出。
// 之前的处理器原样 rethrow，Electron 的默认弹框也被它顶掉，用户只看到 Hub 消失。
const fs = require('node:fs');
const path = require('node:path');

function plainReason(error) {
  const code = error && error.code;
  if (code === 'ENOSPC') return '磁盘空间已满，请清理磁盘后重新打开。';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return '数据目录不可写，请检查目录权限后重新打开。';
  return '程序遇到没有预料到的错误。';
}

function reportFatal(error, { dataDir, showDialog, exit = code => process.exit(code), fsModule = fs, now = Date.now, version = '' } = {}) {
  let file = null;
  const stack = String((error && error.stack) || error);
  try {
    const dir = path.join(dataDir, 'diagnostics');
    fsModule.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `fatal-${new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${process.pid}.txt`);
    fsModule.writeFileSync(file, `${new Date(now()).toISOString()} v${version}\ncode=${(error && error.code) || ''}\n${stack}\n`, 'utf8');
  } catch { file = null; }
  try {
    if (showDialog) showDialog('AI Hub 无法继续运行', `${plainReason(error)}\n\n${file ? '详细信息已保存到：' + file : '（详细信息没能保存）'}\n\n${String((error && error.message) || error).slice(0, 300)}`);
  } catch {}
  exit(1);
  return file;
}

module.exports = { reportFatal, plainReason };
