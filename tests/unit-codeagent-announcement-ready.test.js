'use strict';
// A-08（2026-11-28 黄区实录）：CodeAgent 命令行顶部的公告横幅
// 「★ 公告 ｜ 📢📢 预告同步：CodeAgent 桌面版正在最后打磨中， Close(Alt+X)」在一行里滚动重画，
// 画面一直在变，就绪判断和模型菜单的「画面稳定」等不到，输入框已就绪也报 cli-not-ready / 尚未确认恢复普通输入框，首句被拦下。
// 修法：稳定判断忽略公告那一行；不按 Alt+X 去关它。
const test = require('node:test');
const assert = require('node:assert/strict');
const detector = require('../core/group-chat-cli-ready-detector');
const picker = require('../core/codeagent-model-picker');

// 真实屏幕（m3 黄区实录，前 25 行，已脱敏）。
const BANNER = ' ★ 公告 ｜                                    📢📢 预告同步：CodeAgent 桌面版正在最后打磨中， Close(Alt+X) ';
const SCREEN = [
  '', BANNER, '',
  '              ██████   ██████  ███████  ████████  ██████   ███████ ████████ ██    ██ ████████            ',
  '                                    New version available: 1.2615.02.06.                                 ',
  '                                  You can run /update command to upgrade.                                ',
  '      ╭────────────────────────────────────────────────────────────────────────────────────────────╮     ',
  '      │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史)                     │     ',
  '      │                                                                                            │     ',
  '      │ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto                                    @  ✲  ↵  ▷   │     ',
  '      ╰────────────────────────────────────────────────────────────────────────────────────────────╯     ',
  '      ╭────────────────────────────────────────────────────────────────────────────────────────────╮     ',
  '      │ RECENT SESSIONS                   /sessions   │  TIPS                                /help │     ',
  '      │ No recent sessions                               !bash                        for bash mode│     ',
];
// 公告滚动时 CLI 只重画横幅那几格（实录 startup-blocks 首行就是这种残片：颜色序列尾巴 + 半截「公告」）。
// 首屏：横幅用光标定位画在第 2 行（ConPTY 实录同样是定位后写行）。
const DRAW = SCREEN.map(line => line === BANNER ? '\x1b[2;1H' + BANNER : line).join('\r\n');
const scrollFrame = i => `\x1b[2;${38 + (i % 5)}H\x1b[38;2;0;0;0m信${' '.repeat(36 - (i % 5))}📢📢 预告同步：CodeAgent 桌面版正在最后打磨中，`;

function withClock(fn) {
  const real = Date.now; let now = 1_000_000;
  Date.now = () => now;
  try { return fn(ms => { now += ms; }); } finally { Date.now = real; }
}

test('detector: input box ready under a scrolling announcement banner → ready', () => withClock(tick => {
  const sid = 'a08-ready'; detector.cleanup(sid);
  let buf = SCREEN.join('\r\n');
  assert.equal(detector.isReady(sid, 'codeagent', buf), false); // 第一次只建立基线
  for (let i = 0; i < 4; i++) { tick(500); buf += scrollFrame(i); detector.isReady(sid, 'codeagent', buf); }
  assert.equal(detector.isReady(sid, 'codeagent', buf), true);
  detector.cleanup(sid);
}));

test('detector: only the banner, no input box yet → not ready', () => withClock(tick => {
  const sid = 'a08-banner-only'; detector.cleanup(sid);
  let buf = SCREEN.slice(0, 6).join('\r\n') + ' '.repeat(600);
  for (let i = 0; i < 8; i++) { tick(500); buf += scrollFrame(i); assert.equal(detector.isReady(sid, 'codeagent', buf), false); }
  detector.cleanup(sid);
}));

test('detector: no banner, tail still changing → still waits (unchanged behaviour)', () => withClock(tick => {
  const sid = 'a08-no-banner'; detector.cleanup(sid);
  let buf = SCREEN.filter(line => line !== BANNER).join('\r\n');
  detector.isReady(sid, 'codeagent', buf);
  for (let i = 0; i < 4; i++) { tick(500); buf += `\x1b[1;1HConnecting MCP ${i}/9`; assert.equal(detector.isReady(sid, 'codeagent', buf), false); }
  detector.cleanup(sid);
}));

// Codex 审查 P1 反例：有公告时，输入框之后还有真实输出（MCP 逐个连上）——不能因为只看输入框附近就判稳定、永久放行。
for (const style of ['newline', 'positioned']) test(`detector: banner + real output after the input box keeps changing → still not ready (${style})`, () => withClock(tick => {
  const sid = 'a08-mcp-' + style; detector.cleanup(sid);
  let buf = DRAW;
  detector.isReady(sid, 'codeagent', buf);
  for (let i = 0; i < 8; i++) {
    tick(500);
    buf += scrollFrame(i) + (style === 'newline' ? `\r\nConnecting MCP ${i}/9` : `\x1b[30;1HConnecting MCP ${i}/9`);
    assert.equal(detector.isReady(sid, 'codeagent', buf), false, `第 ${(i + 1) * 500}ms 仍在输出，不该判就绪`);
  }
  // 输出停了、只剩横幅在滚：1.5 秒后就绪。
  for (let i = 0; i < 4; i++) { tick(500); buf += scrollFrame(i); detector.isReady(sid, 'codeagent', buf); }
  assert.equal(detector.isReady(sid, 'codeagent', buf), true);
  detector.cleanup(sid);
}));

// 审查第二轮反例：公告画在第 2 行，之后公告消失，第 2 行被真实输出复用（每 500ms 重画成 Connecting MCP）——这些不能被当成横幅删掉。
test('detector: banner row later reused by real output (Connecting MCP on row 2) → still not ready', () => withClock(tick => {
  const sid = 'a08-row-reuse'; detector.cleanup(sid);
  let buf = DRAW;
  detector.isReady(sid, 'codeagent', buf);
  for (let i = 0; i < 8; i++) {
    tick(500);
    buf += `\x1b[2;1H\x1b[K\x1b[38;2;200;200;200mConnecting MCP ${i}/9`;
    assert.equal(detector.isReady(sid, 'codeagent', buf), false, `第 ${(i + 1) * 500}ms 第 2 行仍在变，不该判就绪`);
  }
  detector.cleanup(sid);
}));

test('only writes matching the seen banner text are stripped; other writes on the same row are kept', () => {
  const raw = DRAW + scrollFrame(1) + '\x1b[2;5H桌面版正在最后打磨中' + '\x1b[2;1HConnecting MCP 3/9';
  const out = detector.stripAnnouncementWrites(raw);
  assert.ok(out.includes('Connecting MCP 3/9'), '真实输出保留');
  assert.ok(!out.includes('桌面版正在最后打磨中\x1b[2;1H'), '公告原文片段剔除');
  assert.ok(!out.includes('预告同步'), '带公告标记的写入剔除');
});

test('banner row unknown (no cursor positioning before it): nothing stripped, conservative', () => {
  const raw = SCREEN.join('\r\n') + scrollFrame(1).replace(/^\x1b\[[0-9;]*H/, '');
  assert.equal(detector.stripAnnouncementWrites(raw), raw);
});

test('picker: banner line scrolling does not keep the screen "busy"', async () => {
  let i = 0;
  const screen = { lines: async () => SCREEN.map(line => line === BANNER ? BANNER.replace('📢📢', ' '.repeat(i++ % 4) + '📢📢') : line) };
  assert.equal(await picker.waitQuiet(screen, { quietMs: 400, maxMs: 3000 }), true);
  const ready = await picker.waitForInput(screen, 3000);
  assert.equal(!!ready.value, true);
});

test('picker: a real screen change (not the banner) still counts as busy', async () => {
  let i = 0;
  const screen = { lines: async () => SCREEN.map(line => /New version/.test(line) ? `MCP 连接中 ${i++}` : line) };
  assert.equal(await picker.waitQuiet(screen, { quietMs: 400, maxMs: 1200 }), false);
});

test('announcement pattern only matches the banner line', () => {
  assert.equal(detector.withoutAnnouncement(SCREEN).length, SCREEN.length - 1);
  assert.ok(!detector.CODEAGENT_ANNOUNCEMENT.test('      │ > Anything I can assist you with? (Ctrl+J 换行 · esc×2 清空 · ↑↓ 历史)'));
});
