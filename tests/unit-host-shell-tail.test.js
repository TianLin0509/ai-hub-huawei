'use strict';
// 2026-10-14: the host-shell and login-banner checks clean only a raw tail of
// the 1 MB terminal ring, with the whole-buffer clean as the fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi, cleanTail, detectHostShellTakeover, createAuthBannerMonitor } = require('../core/host-shell-detector');

function noisy(bytes, seed = 7) {
  let x = seed, out = '';
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x; };
  const pieces = ['\x1b[38;2;10;20;30m', '\x1b[0m', '\x1b[3C', '\x1b]0;title\x07', '\x1b[?25l', 'text ', '中文回答 ', '\r\n', '│ ', '\x1b(B'];
  while (out.length < bytes) out += pieces[rnd() % pieces.length];
  return out;
}

test('the cleaned tail equals the tail of the cleaned whole buffer', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const buffer = noisy(1024 * 1024 + seed * 37, seed);
    for (const chars of [500, 1200]) assert.equal(cleanTail(buffer, chars), stripAnsi(buffer).slice(-chars), `seed ${seed}`);
  }
  // A tail made almost entirely of control sequences falls back to the whole buffer.
  const dense = 'PS C:\\Users\\me> ' + '\x1b[0m'.repeat(20000);
  assert.equal(cleanTail(dense, 500), stripAnsi(dense).slice(-500));
});

test('prompt and login-banner detection keep their answers on a 1 MB ring', () => {
  const history = noisy(1024 * 1024);
  assert.equal(detectHostShellTakeover(history + '\r\nPS C:\\Users\\me> '), true);
  assert.equal(detectHostShellTakeover(history + '\r\n\x1b[32mthinking…\x1b[0m'), false);
  const monitor = createAuthBannerMonitor();
  assert.notEqual(monitor.tick(history + '\r\nPlease run /login', 1), 'none');
  assert.equal(createAuthBannerMonitor().tick(history, 1), 'none');
});

test('cuts anywhere inside short sequences and long titles give the whole-buffer answer', () => {
  const body = 'answer 2026;10?(x) '.repeat(4000);
  const window = 32 * 1024;
  const longTitle = '\x1b]0;' + 'title '.repeat(9000) + 'PS C:\\fake> \x07';
  const sequences = ['\x1b[38;2;10;20;30m', '\x1b[12C', '\x1b(B', '\x1b[?25l', '\x1b]0;short PS C:\\x> \x07', longTitle];
  for (const seq of sequences) {
    // Offsets where the window boundary falls `offset` characters into the sequence.
    const first = Math.max(0, seq.length - window);
    const offsets = new Set();
    for (let k = first; k <= Math.min(seq.length, first + 40); k++) offsets.add(k);
    for (let k = Math.max(first, seq.length - 5); k <= seq.length; k++) offsets.add(k);
    for (const offset of offsets) {
      const end = '\nPS C:\\real> ';
      const filler = window - (seq.length - offset) - end.length;
      if (filler < 0) continue;
      const raw = body + seq + 'x'.repeat(filler) + end;
      assert.equal(raw.length - window, body.length + offset);
      for (const chars of [500, 1200]) assert.equal(cleanTail(raw, chars), stripAnsi(raw).slice(-chars), `${JSON.stringify(seq.slice(0, 12))} offset ${offset}`);
    }
  }
});

test('long titles at random places in a 1 MB ring never change the answer', () => {
  let x = 11;
  const rnd = n => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
  for (let round = 0; round < 30; round++) {
    let raw = noisy(1024 * 1024, round + 100);
    const at = raw.length - 1 - rnd(80 * 1024);
    raw = raw.slice(0, at) + '\x1b]0;' + 'Please run /login PS C:\\t> '.repeat(rnd(3000) + 1) + '\x07' + raw.slice(at);
    for (const chars of [500, 1200]) assert.equal(cleanTail(raw, chars), stripAnsi(raw).slice(-chars), `round ${round}`);
  }
});

// 2026-11-18: Claude ends title OSCs with ST (ESC \). The fast tail path must still match the full clean
// exactly, including OSCs that open before the cut and close (or never close) after it.
test('ST-terminated title OSCs before the cut keep the fast tail identical to a full clean', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 60; round++) {
    const parts = [];
    for (let i = 0; i < 400; i++) {
      const r = rnd();
      if (r < 0.15) parts.push(']0;title ' + i + '' + String.fromCharCode(92));
      else if (r < 0.2) parts.push('\x1b]2;bel title\x07');
      else if (r < 0.3) parts.push('\x1b[' + Math.floor(rnd() * 9) + 'C');
      else if (r < 0.35) parts.push('\x07');
      else parts.push('line ' + i + ' ' + 'x'.repeat(Math.floor(rnd() * 200)) + '\r\n');
    }
    const raw = parts.join('');
    for (const chars of [500, 1200]) assert.equal(cleanTail(raw, chars), stripAnsi(raw).slice(-chars), `round ${round}`);
  }
});
