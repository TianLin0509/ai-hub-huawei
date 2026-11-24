'use strict';
// 假 CodeAgent：启动后先画输入框，过 FAKE_MENU_DELAY_MS 毫秒弹出工具授权菜单（版式照 Claude Code / CodeAgent 的权限确认）。
// 上下键移动高亮、回车选中；选中后记一行 { chosen, label, keys } 到 FAKE_INPUT_LOG，接着弹下一道（FAKE_MENU_COUNT 道为止）。
// 每段输入也原样记下（{ data, menu }），E2E 据此核对卡片送进来的按键。serve / --version 直接退出。
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'serve' || args.includes('--version')) { process.stdout.write('fake-permission 0.0.0\n'); process.exit(args[0] === 'serve' ? 1 : 0); }
const out = s => process.stdout.write(s);
const at = (row, text) => `\x1b[${row};1H\x1b[2K${text}`;
const log = obj => { if (process.env.FAKE_INPUT_LOG) { try { fs.appendFileSync(process.env.FAKE_INPUT_LOG, JSON.stringify(obj) + '\n'); } catch { /* 只是记录 */ } } };
const MENUS = [
  { tool: 'Bash(dir)', detail: 'dir', options: ['Yes', "Yes, and don't ask again for dir commands in this project", 'No, and tell CodeAgent what to do differently (esc)'] },
  { tool: 'Bash(del a.txt)', detail: 'del a.txt', options: ['Yes', "Yes, and don't ask again for del commands in this project", 'No, and tell CodeAgent what to do differently (esc)'] },
];
const count = Math.max(1, Math.min(MENUS.length, Number(process.env.FAKE_MENU_COUNT || 2)));
let menu = -1, cursor = 0, pending = [], locked = true;

function drawPrompt(note = '') {
  out('\x1b[2J');
  out(at(2, ' fake CodeAgent ready'));
  if (note) out(at(4, ' ● ' + note));
  out(at(8, '❯ '));
  out(at(10, ' ? for shortcuts'));
}
function drawMenu() {
  const m = MENUS[menu];
  out('\x1b[2J');
  out(at(2, ' ● ' + m.tool));
  out(at(4, ' Bash command'));
  out(at(5, '   ' + m.detail));
  out(at(7, ' Do you want to proceed?'));
  m.options.forEach((label, i) => out(at(8 + i, (i === cursor ? ' ❯ ' : '   ') + (i + 1) + '. ' + label)));
  out(at(12, ' Enter to confirm · Esc to cancel'));
}
function nextMenu() {
  menu += 1; cursor = 0; pending = []; locked = false;
  if (menu >= count) { drawPrompt('all done'); return; }
  drawMenu();
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
  const s = chunk.toString('utf8');
  log({ data: s, menu });
  if (s.includes('\x03')) process.exit(0);
  if (locked || menu < 0 || menu >= count) return;
  // 一段输入里可能连着几个键，逐个处理
  for (const key of s.match(/\x1b\[[AB]|\r|[\s\S]/g) || []) {
    if (key === '\x1b[A' || key === '\x1b[B' || key === '\r') pending.push(key); else continue;
    if (key === '\x1b[A') cursor = Math.max(0, cursor - 1);
    else if (key === '\x1b[B') cursor = Math.min(MENUS[menu].options.length - 1, cursor + 1);
    else if (key === '\r') {
      const label = MENUS[menu].options[cursor];
      log({ chosen: String(cursor + 1), label, keys: pending, menu });
      drawPrompt(cursor === 2 ? 'Rejected ' + MENUS[menu].tool : 'Ran ' + MENUS[menu].tool);
      setTimeout(nextMenu, Number(process.env.FAKE_MENU_GAP_MS || 1500));
      locked = true; // 两道菜单之间不再收键
      return;
    }
    drawMenu();
  }
});
drawPrompt();
setTimeout(nextMenu, Number(process.env.FAKE_MENU_DELAY_MS || 3000));
setInterval(() => {}, 60000);
