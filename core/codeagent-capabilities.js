'use strict';
// CodeAgent 版本兼容（2026-10-28 用户：很多同事是 1.2605，CSOP 官方当前分发的就是 1.2605.05.01；Hub 按 1.2615 做的）。
// 做法：启动前读一次这台电脑上 CodeAgent 的 --help，它不认的启动参数就不传（连同参数值一起去掉），其余原样。
// 只在读到的版本明确低于 1.2615 时才过滤（2026-10-28 用户：不能影响 2615）：2615 及以上、版本或 --help 读不到时一律原样，行为和以前完全一样。
// 帮助里一个参数可能写成别名（2615 的 --append-system-prompt-file 只以 --append-system-prompt[-file] 出现），见 ALIASES。
// 同一命令 6 小时内只读一次（同步读最多 4 秒，会卡主进程，所以要缓存）；CodeAgent 升级后最晚 6 小时重新认。

// Hub 会传的参数各带几个值：0 = 开关；1 = 一个值；'many' = 后面跟到下一个 -- 参数为止（--mcp-config 可以给多个文件）。
const ARITY = Object.freeze({
  '--disable-update': 0, '--skip-safe-check': 0, '--strict-mcp-config': 0, '--fork-session': 0,
  '--setting-sources': 1, '--model': 1, '--effort': 1, '--permission-mode': 1, '--append-system-prompt-file': 1,
  '--disabled-mcp-servers': 1, '--add-dir': 1, '--session-id': 1,
  '--mcp-config': 'many',
});
// 帮助里出现其中任何一个写法就算认这个参数。
const ALIASES = Object.freeze({ '--append-system-prompt-file': ['--append-system-prompt'], '--resume': ['-r'] });
const FILTER_BELOW = '1.2615';
// --resume 可以不带值（打开选择列表），也可以带会话 id：值不以 -- 开头才算它的。
const OPTIONAL_VALUE = new Set(['--resume']);

const HELP_TTL_MS = 6 * 3600 * 1000;
const helpCache = new Map();

function runCli(command, flag, { run = require('child_process').spawnSync, platform = process.platform } = {}) {
  try {
    const opts = { encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 };
    const r = platform === 'win32'
      ? run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', require('./codeagent-config').commandHead(command) + ' ' + flag], opts)
      : run(command, [flag], opts);
    return !r.error && r.status === 0 ? String(r.stdout || '') : '';
  } catch { return ''; }
}

// 返回用来过滤的帮助文本；不该过滤时返回空串（版本读不到、版本不低于 1.2615、帮助不像 CodeAgent 的）。
function readHelp(command, { run, platform, now = Date.now } = {}) {
  const hit = helpCache.get(command);
  if (hit && now() - hit.at < HELP_TTL_MS) return hit.text;
  let text = '';
  const version = (/\d+\.\d+(?:\.\d+)*/.exec(runCli(command, '--version', { run, platform })) || [''])[0];
  const older = version && require('./codeagent-version-check').compare(version, FILTER_BELOW) === -1;
  if (older) {
    text = runCli(command, '--help', { run, platform });
    if (!/(?:^|\s)--[a-z]/m.test(text)) text = '';
  }
  helpCache.set(command, { text, at: now(), version });
  return text;
}

function cachedVersion(command) { const hit = helpCache.get(command); return hit ? hit.version || '' : ''; }

function flagListed(help, flag) {
  return new RegExp('(?:^|[\\s,])' + flag.replace(/[-]/g, '\\-') + '(?:[\\s=,<\\[]|$)', 'm').test(help);
}

// 返回 { args, dropped }。help 为空时原样返回。
function filterArgs(args, help) {
  if (!help) return { args: args.slice(), dropped: [] };
  const out = [], dropped = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const known = Object.prototype.hasOwnProperty.call(ARITY, a) || OPTIONAL_VALUE.has(a);
    if (!known || [a, ...(ALIASES[a] || [])].some(f => flagListed(help, f))) { out.push(args[i]); continue; }
    dropped.push(a);
    if (OPTIONAL_VALUE.has(a)) { if (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i++; continue; }
    const n = ARITY[a];
    if (n === 'many') { while (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) i++; }
    else i += n;
  }
  return { args: out, dropped };
}

module.exports = { ARITY, ALIASES, FILTER_BELOW, readHelp, cachedVersion, flagListed, filterArgs, _helpCache: helpCache };
