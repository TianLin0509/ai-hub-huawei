'use strict';
// FIX-D（2026-05-01）：检测 PTY ring buffer 末尾是否回到宿主 shell prompt（PowerShell / bash / cmd）。
//   命中 → 视为 CLI 自我退出（Codex 自动更新 / Gemini OAuth refresh / Claude panic 等）。
//   配合 main.js _gcWaitTurnComplete 里的 10s 心跳 + 连续 2 次命中机制使用，让 watcher 在
//   ~10-20s 内 settle errored，而不是等 5min 硬 timeout。
//
// 误判防护：
//   1. 严格只看 buffer tail（最后 500 字符）— 避免命中历史 prompt
//   2. 调用方需要"连续 N 次命中"才确认（main.js 里 N=2）
//   3. 去 ANSI / 控制字符后再匹配 — CLI alt-screen 渲染不会在 tail 留下干净的 PS prompt 字串

// 匹配模式：
//   - PowerShell: `PS C:\Users\xxx>`、`PS C:\Users\xxx\>`
//   - cmd:       `C:\Users\xxx>`
//   - bash:      `user@host:~$`、`$`
//   都要求出现在行首、tail 末尾结束（^/(?:\n|^) 锚 + $\s*$ 锚）
const HOST_SHELL_PROMPT_RE = /(?:^|\n)\s*(?:PS [A-Za-z]:\\[^\n]*?>\s*(?:\n\s*>>\s*)*$|[\w-]+@[^\s]+:[^\s]*?\$\s*$|\$\s*$|[A-Za-z]:\\[^\n]*?>\s*$)/;

// Same result as .replace(/\x1b\][^\x07]*\x07/g, '') but linear. That regex rescans to the
// end of the buffer for every OSC with no BEL after it (Claude ends titles with ESC \),
// which took 2.8 s on a 1 MB terminal ring (2026-11-18 profile). Once no BEL follows an
// OSC start, no later OSC can match either, so the rest is kept as is.
function removeBelOscs(text) {
  let out = '', from = 0;
  for (;;) {
    const start = text.indexOf('\x1b]', from);
    if (start < 0) break;
    const bel = text.indexOf('\x07', start + 2);
    if (bel < 0) break;
    out += text.slice(from, start);
    from = bel + 1;
  }
  return from ? out + text.slice(from) : text;
}

function stripAnsi(buf) {
  return removeBelOscs(String(buf || '')
    .replace(/\x1b\[(\d*)C/g, (_match, count) => ' '.repeat(Math.min(Number(count) || 1, 200)))
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
}

// The last `chars` characters of the cleaned buffer. Codex checks this on every
// keystroke; cleaning the whole 1 MB ring for 500 characters cost 3–4 ms each
// time (2026-10-14). Clean a raw tail instead, but only when its first character
// is provably outside every sequence stripAnsi removes; otherwise clean it all.
const RAW_TAIL_CHARS = 32 * 1024;
const SEQUENCE_PARAM = /[0-9;?[()]/;
function safeTailStart(raw, cut) {
  // OSC: stripAnsi removes from the first ESC ] after a BEL up to the next BEL,
  // which may lie far before the cut (a long window title).
  // Claude ends its title OSC with ST (ESC \), not BEL, so this case is common; falling
  // back to cleaning the whole 1 MB ring cost 100–190 ms per prompt (2026-11-18 profile).
  // stripAnsi deletes such an OSC through the next BEL; with no BEL after the cut nothing
  // is deleted across it, and with one the tail can start right after that BEL.
  if (raw.lastIndexOf('\x1b]', cut - 1) > raw.lastIndexOf('\x07', cut - 1)) {
    const bel = raw.indexOf('\x07', cut);
    if (bel >= 0) return bel + 1 < raw.length ? safeTailStart(raw, bel + 1) : -1;
  }
  // CSI and charset sequences are short: step back over their parameters to the ESC.
  let start = cut;
  while (start > 0 && cut - start < 64 && SEQUENCE_PARAM.test(raw[start - 1])) start -= 1;
  if (start > 0 && raw[start - 1] === '\x1b') return start - 1;
  // Ordinary digits or brackets before the cut: not inside a sequence. A run this long
  // without its ESC in sight cannot be decided cheaply.
  return cut - start >= 64 ? -1 : cut;
}
function cleanTail(rawBuffer, chars) {
  const raw = String(rawBuffer || '');
  if (raw.length > RAW_TAIL_CHARS) {
    const start = safeTailStart(raw, raw.length - RAW_TAIL_CHARS);
    if (start >= 0) {
      const clean = stripAnsi(raw.slice(start));
      if (clean.length >= chars) return clean.slice(-chars);
    }
  }
  return stripAnsi(raw).slice(-chars);
}

// PowerShell 改窗口标题用 ESC ] 0;… ESC \ 结尾（ST），stripAnsi 只去掉 ESC 本身，标题残渣
// 「]0;C:\WINDOWS\…\powershell.exe\」会粘在提示符前面，提示符不在行首就认不出 CLI 已退出，
// 正文被粘进 PowerShell 当命令执行（2026-11-20 隔离 Hub 实测）。认提示符前把这段残渣换成换行。
const PROMPT_TITLE_RESIDUE_RE = /\]\d+;[^\n\x07]*?\\(?=PS [A-Za-z]:\\)/g;
function cleanPromptTitles(text) { return String(text || '').replace(PROMPT_TITLE_RESIDUE_RE, '\n'); }

function detectHostShellTakeover(rawBuffer) {
  if (!rawBuffer) return false;
  return HOST_SHELL_PROMPT_RE.test(cleanPromptTitles(cleanTail(rawBuffer, 500)));
}

// 回到宿主 PowerShell 的原因是「找不到 CLI 程序」（反馈 08441c2e，2026-11-19）：PowerShell 不论中英文都打
// 「CategoryInfo : ObjectNotFound: (claude:String) [], CommandNotFoundException」（绝对路径时括号里是完整路径）。
// ConPTY 会折行，去掉控制序列与空白后再认；只看尾部，并且取最后一次，旧的报错被新输出盖过就不算。
const MISSING_CLI_RE = /ObjectNotFound:\((?:[^()]*[\\/])?(claude|codex|codeagent|codeagentcli|gemini|kimi)(?:\.exe|\.cmd|\.ps1|\.bat)?:String\)\[\],CommandNotFoundException/gi;
function detectMissingCliCommand(rawBuffer) {
  if (!rawBuffer) return null;
  const compact = cleanTail(rawBuffer, 2000).replace(/\s+/g, '');
  let last = null;
  for (const m of compact.matchAll(MISSING_CLI_RE)) last = m;
  if (!last) return null;
  // 报错之后又有了别的命令输出（不只是提示符）就不算。
  const after = compact.slice(last.index + last[0].length);
  if (after.replace(/\+FullyQualifiedErrorId:CommandNotFoundException/i, '').replace(/PS[A-Za-z]:\\[^>]*>/g, '').length > 0) return null;
  const command = last[1].toLowerCase();
  return command === 'codeagentcli' ? 'codeagent' : command;
}

// Codex 0.153 的 /new 在同一个 TUI 里结束当前线程时，先打印
// "To continue this session, run codex resume, then select … (<旧线程 id>)"，再以
// source=startup 报新线程的 SessionStart（2026-09-26 真机实测，不是 clear）。只认带着
// 「当前绑定线程 id」的这句提示：模型在工具里嵌套跑的 codex 不会把父线程 id 画到这个终端上。
// ConPTY 用光标移动代替空格、长 id 会折行，所以去掉控制序列与全部空白后再比对。
// 只看最后一次这样的提示，它必须指向当前绑定的线程。
function detectCodexThreadEnded(rawBuffer, boundSid) {
  const sid = String(boundSid || '').replace(/\s+/g, '');
  if (!rawBuffer || !sid) return false;
  const compact = stripAnsi(rawBuffer).replace(/\s+/g, '');
  const at = compact.lastIndexOf('Tocontinuethissession');
  if (at < 0) return false;
  const hint = compact.slice(at);
  // 0.157.1 prints the executable resume command directly, without the old
  // title + parenthesized id. Match the UUID in that command, not arbitrary
  // occurrences of the bound id elsewhere in a newer thread's output.
  const direct = /^Tocontinuethissession,runcodexresume([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i.exec(hint);
  if (direct) return direct[1] === sid;
  const parenthesized = /^Tocontinuethissession,runcodexresume\(([^)]+)\)/.exec(hint);
  if (parenthesized) return parenthesized[1] === sid;
  return hint.startsWith('Tocontinuethissession,runcodexresume,thenselect') && hint.includes(`(${sid})`);
}

// ---------------------------------------------------------------------------
// createAuthBannerMonitor — CLI 登录失效横幅检测（2026-07-12 maintainer）。
//   血泪：旧实现在 dispatcher 心跳里对整个 8KB ring buffer 裸测 AUTH_FAILURE_RE，
//   AI 回答/工具输出里提到 "not logged in"（如 gh CLI 报 "not logged into any
//   GitHub hosts"）就被当场 markErrored('auth_required') —— PTY 明明在正常回答，
//   群聊 UI 却显示「发送失败」+ 空气泡。
//   判定收紧为三重门（全过才 'confirmed'）：
//     1. 只看 stripAnsi 后的 buffer 尾部（真登录错误 = CLI 停在错误横幅上）
//     2. 连续 2 次心跳命中（单次滚屏路过不算）
//     3. 两次命中之间 PTY 零新输出（正常回答会持续滚动/重绘 spinner，activity 一直变）
const AUTH_FAILURE_RE = /(not logged in|please run\s+\/login|run\s+\/login|authentication required|login required)/i;
const AUTH_TAIL_CHARS = 1200;

function createAuthBannerMonitor() {
  let hits = 0;
  let lastActivity = null;
  return {
    // rawBuffer: PTY ring buffer；activityStamp: sessionManager.getGroupChatLastActivity(sid)
    // 返回 'none' | 'suspect' | 'confirmed'
    tick(rawBuffer, activityStamp) {
      const tail = cleanTail(rawBuffer, AUTH_TAIL_CHARS);
      if (!AUTH_FAILURE_RE.test(tail)) {
        hits = 0;
        lastActivity = null;
        return 'none';
      }
      // activityStamp 缺失（PTY 从未输出/接口异常）时不做"静默"判定——
      //   宁可漏报等 soft-alert 人工处理，不给误杀留门（2026-07-12 审查加固）。
      const quietSinceLastHit = hits > 0 && activityStamp != null && activityStamp === lastActivity;
      hits += 1;
      lastActivity = activityStamp;
      return (hits >= 2 && quietSinceLastHit) ? 'confirmed' : 'suspect';
    },
  };
}

module.exports = {
  HOST_SHELL_PROMPT_RE,
  AUTH_FAILURE_RE,
  stripAnsi,
  cleanTail,
  detectHostShellTakeover,
  cleanPromptTitles,
  detectMissingCliCommand,
  detectCodexThreadEnded,
  createAuthBannerMonitor,
};
