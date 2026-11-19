'use strict';
// 「CLI 启动即退出」的假 CodeAgent（2026-11-20，tests/capture-cli-exit-resend-cdp.js 用）：
// 标记文件在时，交互启动打印两行报错就退出，终端回到 PowerShell，复现「CLI 已退出到系统终端」；
// 标记文件删掉后（模拟用户修好了原因），和「问问 Hub」用的假 CodeAgent 一样正常启动。版本、帮助、单次问答等调用始终照常。
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const flag = process.env.CLI_EXIT_FAKE_FLAG || '';
const oneShot = args.some(a => ['-p', '--print', '--version', '-v', '--help'].includes(a));
if (!oneShot && flag && fs.existsSync(flag)) {
  process.stdout.write('Starting CodeAgent...\r\nError: Effort level "max" is not available for this model\r\n', () => process.exit(1));
} else {
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'help-ask-fake', 'help-ask-fake.js'), ...args], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status == null ? 1 : r.status);
}
