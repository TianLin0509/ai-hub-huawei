'use strict';
// 假 CodeAgent：第一次进入目录时画「是否信任此目录」确认框（版式照公司 CodeAgent 的底栏写法），回车后进入输入框。
// FAKE_TRUST_MODE=auto：选项行带高亮光标，Hub 能自动点掉；=stuck：没有光标标记，Hub 认得字样但点不了，要用户自己回车。
// serve / 其他子命令直接失败退出（单测与 E2E 关掉 serve 读取）。
const args = process.argv.slice(2);
if (args[0] === 'serve' || args.includes('--version')) { process.stdout.write('fake-trust 0.0.0\n'); process.exit(args[0] === 'serve' ? 1 : 0); }
const mode = process.env.FAKE_TRUST_MODE === 'stuck' ? 'stuck' : 'auto';
const out = s => process.stdout.write(s);
const at = (row, text) => `\x1b[${row};1H\x1b[2K${text}`;
let trusted = false;
// 像真 CLI 一样：配置目录里还没有状态文件就建一个空的（Hub 应在它建好后补写信任）。
try {
  const fs = require('fs'), path = require('path'), dir = process.env.FAKE_CA_CONFIG_DIR;
  if (dir && !fs.existsSync(path.join(dir, '.cac.json'))) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.cac.json'), '{"numStartups":1}'); }
} catch { /* 只是模拟 */ }
function drawTrust() {
  out('\x1b[?1049h\x1b[2J');
  out(at(2, ' Accessing workspace:'));
  out(at(3, ' ' + process.cwd()));
  out(at(5, ' Quick safety check: Is this a project you created or one you trust?'));
  out(at(7, (mode === 'auto' ? ' ❯ ' : '   ') + '1. Yes, I trust this folder'));
  out(at(8, '   2. No, exit'));
  out(at(10, ' Select option ↑ ↓ | Confirm Enter | No, exit Esc'));
}
function drawPrompt() {
  out('\x1b[2J');
  out(at(2, ' fake CodeAgent ready'));
  out(at(4, '❯ '));
  out(at(6, ' ? for shortcuts'));
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  const s = chunk.toString('utf8');
  // 记下每段输入是在信任框点掉之前还是之后收到的：E2E 据此确认没有字被敲进信任框。
  if (process.env.FAKE_INPUT_LOG) { try { require('fs').appendFileSync(process.env.FAKE_INPUT_LOG, JSON.stringify({ trusted, data: s }) + '\n'); } catch { /* 只是记录 */ } }
  // 真 CodeAgent 点完信任后还要加载几秒才出输入框，这段时间正是用户以为「卡住」的时候。
  // stuck 模式只认测试替用户按的 y：Hub 别处误敲的回车不能悄悄把框点掉，对照实验才分得清。
  if (!trusted && (mode === 'stuck' ? s === 'y' : s.includes('\r'))) { trusted = true; out('\x1b[2J'); setTimeout(drawPrompt, Number(process.env.FAKE_TRUST_BOOT_MS || 8000)); }
  else if (s.includes('\x03')) process.exit(0);
});
drawTrust();
setInterval(() => {}, 60000);
