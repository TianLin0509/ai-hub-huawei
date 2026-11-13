'use strict';
// CodeAgent 版本兼容（2026-10-28 用户：很多同事是 1.2605，CSOP 官方当前分发的就是 1.2605.05.01；Hub 按 1.2615 做的）。
// 做法：启动前读一次这台电脑上 CodeAgent 的 --help，它不认的启动参数就不传（连同参数值一起去掉），其余原样。
// 所有版本都按本机 --help 探测，不用版本号推断能力；帮助读不到时原样启动。
// 帮助里一个参数可能写成别名（2615 的 --append-system-prompt-file 只以 --append-system-prompt[-file] 出现），见 ALIASES。
// 同一命令 6 小时内只读一次；程序文件变了（大小或修改时间）马上重新认，判断不出变化的升级最晚 6 小时重新认。
// 同步入口只读缓存；冷缓存原样启动，由 prepare 在后台读好，避免探测 CLI 阻塞界面。

// Hub 会传的参数各带几个值：0 = 开关；1 = 一个值；'many' = 后面跟到下一个 -- 参数为止（--mcp-config 可以给多个文件）。
const ARITY = Object.freeze({
  '--disable-update': 0, '--skip-safe-check': 0, '--strict-mcp-config': 0, '--fork-session': 0,
  '--setting-sources': 1, '--settings': 1, '--model': 1, '--effort': 1, '--permission-mode': 1, '--append-system-prompt-file': 1,
  '--disabled-mcp-servers': 1, '--add-dir': 1, '--session-id': 1,
  '--mcp-config': 'many',
});
// 帮助里出现其中任何一个写法就算认这个参数。
const ALIASES = Object.freeze({ '--append-system-prompt-file': ['--append-system-prompt'], '--resume': ['-r'] });
// --resume 可以不带值（打开选择列表），也可以带会话 id：值不以 -- 开头才算它的。
const OPTIONAL_VALUE = new Set(['--resume']);

const HELP_TTL_MS = 6 * 3600 * 1000;
const CLI_TIMEOUT_MS = 4000;
const helpCache = new Map();
const pendingProbes = new Map();
let probeSeq = 0;

function fileStamp(file) {
  try { const s = require('fs').statSync(file); return { stamp: `${s.size}:${s.mtimeMs}`, mtimeMs: s.mtimeMs }; }
  catch { return { stamp: '', mtimeMs: 0 }; }
}
// 程序文件身份。文件还在就不重新搜索 PATH，建会话时只多一次 stat。
function locate(command, knownFile = '') {
  const known = knownFile ? fileStamp(knownFile) : null;
  if (known && known.stamp) return { file: knownFile, ...known };
  let file = '';
  try { file = require('./codeagent-config').commandFile(command); } catch { /* 按找不到算 */ }
  return { file, ...(file ? fileStamp(file) : { stamp: '', mtimeMs: 0 }) };
}
function isFresh(hit, command, nowMs) {
  return !!hit && nowMs - hit.at < HELP_TTL_MS && locate(command, hit.file).stamp === hit.stamp;
}
// 后起的探测优先：程序被替换时，先起的旧结果晚到也不覆盖新结果。
function store(command, ticket, version, text, nowMs) {
  const hit = helpCache.get(command);
  if (hit && hit.seq > ticket.seq) return;
  helpCache.set(command, { text, at: nowMs, version, file: ticket.file, stamp: ticket.stamp, seq: ticket.seq });
}
const parseVersion = text => (/\d+\.\d+(?:\.\d+)*/.exec(text) || [''])[0];
const usableHelp = text => (/(?:^|\s)--[a-z]/m.test(text) ? text : '');

// 返回缓存的帮助文本；没有当前程序的缓存时返回空串，保持启动参数不变。
function readHelp(command, { exec, platform, now = Date.now } = {}) {
  const hit = helpCache.get(command);
  if (isFresh(hit, command, now())) return hit.text;
  // 同一程序的过期结果先用，后台更新；发消息时不再同步等待 CLI。
  if (hit && locate(command, hit.file).stamp === hit.stamp) {
    void prepare(command, { exec, platform, now });
    return hit.text;
  }
  return '';
}

// 后台探测 CLI（隐藏窗口、4 秒、失败算空）。计时自己管，并结束整棵进程树：
// 子进程的子进程占着输出管道时，execFile 的回调可能迟迟不来，不能让建会话跟着等。
function runCliAsync(command, flag, { exec = require('child_process').execFile, platform = process.platform, kill = killTree } = {}) {
  return new Promise(resolve => {
    let child = null, timer = null, settled = false;
    const finish = text => { if (settled) return; settled = true; clearTimeout(timer); resolve(text); };
    try {
      const opts = { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 };
      const callback = (error, stdout) => finish(error ? '' : String(stdout || ''));
      child = platform === 'win32'
        ? exec(require('./windows-powershell').windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', require('./codeagent-config').commandHead(command) + ' ' + flag], opts, callback)
        : exec(command, [flag], opts, callback);
      child?.on?.('error', () => finish(''));
      timer = setTimeout(() => { finish(''); kill(child, platform); }, CLI_TIMEOUT_MS);
      timer.unref?.();
    } catch { finish(''); }
  });
}
function killTree(child, platform = process.platform) {
  const pid = child && child.pid;
  try {
    if (pid && platform === 'win32') require('child_process').execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child?.kill?.();
  } catch { /* 已退出 */ }
}

// 启动时的版本提醒可能刚读过版本：能用就不再起进程，读不出来时由后台探测补齐。
async function sharedVersion(command, ticket, prior) {
  if (prior && prior.stamp !== ticket.stamp) return '';
  const shared = require('./codeagent-version-probe').peekCodeAgentVersion(command, { notBefore: ticket.mtimeMs });
  if (!shared) return '';
  let timer = null;
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve(''), CLI_TIMEOUT_MS); timer.unref?.(); });
  try { return await Promise.race([shared, limit]); }
  catch { return ''; }
  finally { clearTimeout(timer); }
}

// 后台读好兼容信息，永不 reject。同一命令同一程序文件的并发调用共用一次探测；缓存有效时立即返回。
function prepare(command, { exec, platform, kill, now = Date.now } = {}) {
  const prior = helpCache.get(command);
  if (isFresh(prior, command, now())) return Promise.resolve();
  const location = locate(command);
  const running = pendingProbes.get(command);
  if (running && running.stamp === location.stamp) return running.promise;
  const ticket = { seq: ++probeSeq, ...location };
  const promise = (async () => {
    const options = { exec, platform, kill };
    const shared = await sharedVersion(command, ticket, prior);
    // 两个只读探测并行，未知版本不能把首次启动等待从 4 秒叠成 8 秒。
    const [version, help] = await Promise.all([
      shared || runCliAsync(command, '--version', options).then(parseVersion),
      runCliAsync(command, '--help', options),
    ]);
    const text = usableHelp(help);
    store(command, ticket, version, text, now());
  })().catch(() => {}).finally(() => { if (pendingProbes.get(command)?.promise === promise) pendingProbes.delete(command); });
  pendingProbes.set(command, { stamp: ticket.stamp, promise });
  return promise;
}
function prepareForKind(kind, options) {
  if (!/^codeagent(?:-resume)?$/.test(String(kind || ''))) return Promise.resolve();
  try { return prepare(require('./codeagent-config').resolveCodeAgentConfig(process.env).command, options); }
  catch { return Promise.resolve(); }
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

module.exports = { ARITY, ALIASES, readHelp, prepare, prepareForKind, cachedVersion, flagListed, filterArgs, _helpCache: helpCache };
