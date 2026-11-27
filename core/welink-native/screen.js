'use strict';
// 渲染后的整屏文字：CodeAgent 是整屏重绘的全屏界面，字节流去掉转义后文字会错位拼接，
// 所以把会话终端输出的最后一段交给无界面 xterm 回放，只取当前这一屏（与 core/hub-phone/session-chat.js 同一做法）。
// 只回放末尾 tailBytes（默认 64 KB）：全量回放多 MB 缓冲会卡主进程（审查 2026-11-27）；CodeAgent 隔几秒就整屏重画，
// 末尾一段足够盖住最近一整屏。结果只在内存里用来判断状态，不落盘、不打日志（填 AppKey 页上会显示用户输入的凭据）。
const TAIL_BYTES = 64 * 1024;

async function renderScreenLines({ text, cols, rows, tailBytes = TAIL_BYTES } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: Math.max(40, Math.min(300, cols || 120)), rows: Math.max(10, Math.min(80, rows || 30)), scrollback: 0, allowProposedApi: true,
    ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: parseInt(require('node:os').release().split('.').pop(), 10) || 0 } } : {}) });
  try {
    await new Promise(resolve => term.write(text.slice(-Math.max(1024, tailBytes)), resolve));
    const b = term.buffer.active, lines = [];
    for (let i = 0; i < term.rows; i += 1) lines.push(b.getLine(b.baseY + i)?.translateToString(true) || '');
    return lines;
  } finally { term.dispose(); }
}

module.exports = { renderScreenLines, TAIL_BYTES };
