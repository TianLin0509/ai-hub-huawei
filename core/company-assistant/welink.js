'use strict';
// 公司版助理的 WeLink 取数层（2026-10-16 用户定：只读；数据只留在公司电脑）。
// 依据公司真机 welink-cli 1.0.14 的命令树（Q-1016-19）：Hub 只调用下面白名单里的查询类子命令，
// 发消息、回邮件、建会议、建日程、云盘增删改一律拦住——不靠说明，靠这里的白名单。
// 唯一的例外是手机对话往用户选定的那个群发文字（sendAllowed），只有 Hub 主进程能用。
// 同一份白名单也给 CodeAgent 用的只读包装脚本（welink-ro.js），它在助理会话里只能通过包装脚本调 welink-cli。
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const READ_ONLY = Object.freeze({
  im: ['query-recent-conversation', 'query-history-message', 'query-group-member'],
  meeting: ['list', 'query-list', 'info', 'topic', 'topic-materials', 'fuzzy-search'],
  calendar: ['list', 'get'],
  mail: ['folders', 'list', 'get'],
  search: ['person', 'group'],
  contact: ['detail', 'favorite_list'],
  onebox: ['user-info', 'folder-list', 'file-info', 'node-search'],
  auth: ['status'],
  version: [''],
  '--version': [''],
});
// Hub 可自动维护登录、初始化日历；会话只读包装不开放这两条。
const SETUP = Object.freeze({ auth: ['login', 'logout'], mail: ['autodiscover'] });

// 唯一放行的写命令（2026-10-18 用户同意）：手机对话往他自己选定的那个群发文字（phone.js）。
// 只有 Hub 主进程传 sendGroup（设置里选定的群号）时才放行，而且群号必须一字不差；助理会话用的 welink-ro 永远不传。
// 第二处（2026-11-12）：本人在页面上点了「发送」的那一条私聊回复，收信账号必须和调用方给的一字不差（sendUser）。
function sendAllowed(list, sendGroup, sendUser = '') {
  if (list[0] !== 'im' || list.length !== 6) return false;
  const opt = name => { const i = list.indexOf(name); return i >= 2 && i % 2 === 0 ? list[i + 1] : undefined; };
  if (typeof opt('--text') !== 'string' || opt('--text').trim() === '') return false;
  if (sendGroup && list[1] === 'send-to-group') return opt('--group-id') === String(sendGroup);
  if (sendUser && list[1] === 'send-to-user') return opt('--receiver') === String(sendUser);
  return false;
}

// 第三处（r47，2026-11-18）：反馈收件机替同事「一键入群」——只许把调用方给的那个账号加进调用方给的用户群
// （成员版的用户群配置），群号和账号都必须一字不差；助理会话和其他调用方永远不传 addMember。
function addMemberAllowed(list, addMember) {
  if (!addMember || list[0] !== 'im' || list[1] !== 'add-group-member' || list.length !== 6) return false;
  const opt = name => { const i = list.indexOf(name); return i >= 2 && i % 2 === 0 ? list[i + 1] : undefined; };
  const groups = (Array.isArray(addMember.groups) ? addMember.groups : []).map(String);
  const account = String(addMember.account || '');
  return !!account && groups.includes(opt('--group-id')) && opt('--user-account') === account && !list.some(a => /[\r\n]/.test(a));
}

// 第四处（2026-11-18）：本人在页面上点「撤回」，只许撤回调用方给定的会话里、给定编号的那一条。
function recallAllowed(list, recall) {
  if (!recall || list[0] !== 'im' || list[1] !== 'recall-message' || list.length !== 6) return false;
  const opt = name => { const i = list.indexOf(name); return i >= 2 && i % 2 === 0 ? list[i + 1] : undefined; };
  return (opt('--group-id') ?? opt('--user-account')) === String(recall.conv) && opt('--message-id') === String(recall.messageId);
}

function checkArgs(args, { allowSetup = false, sendGroup = '', sendUser = '', addMember = null, recall = null } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const [group, sub = ''] = list;
  if (sendAllowed(list, sendGroup, sendUser)) return list; // 发出的文字可以有换行
  if (addMemberAllowed(list, addMember)) return list;
  if (recallAllowed(list, recall)) return list;
  const ok = group === '--version' ? list.length === 1 : (READ_ONLY[group] || []).includes(group === 'version' ? '' : sub)
    || (allowSetup && (SETUP[group] || []).includes(sub));
  if (!ok) throw Object.assign(new Error(`助理只能用 welink-cli 的查询命令，拒绝执行：${[group, sub].filter(Boolean).join(' ') || '（空）'}`), { code: 'WELINK_NOT_ALLOWED' });
  if (list.some(a => /[\r\n]/.test(a))) throw Object.assign(new Error('welink-cli 参数里不能有换行'), { code: 'WELINK_BAD_ARG' });
  return list;
}

// 找 welink-cli（2026-10-19 扩大范围：用户在一台新电脑上装了，Hub 却说没找到——每个人的 npm 全局目录不一样，
// 有人改到 D:\nodejs\node_global，有人用 nvm；装完没重启 Hub 时，Hub 的 PATH 也还是旧的）。
// 快速查找只看文件和缓存：环境变量 → 设置 → npm / PATH 目录；where 在后台补查。
// 还找不到就交给 findCliDeep 在后台全盘找，找到后记进设置，下次直接用。
const PKG_EXE = ['node_modules', '@welink', 'welink-cli', 'welink-cli.exe'];
function cliUnder(dir, fsModule = fs) {
  if (!dir) return null;
  for (const p of [path.join(dir, ...PKG_EXE), path.join(dir, 'welink-cli.exe')]) { try { if (fsModule.existsSync(p)) return p; } catch { /* 读不了就跳过 */ } }
  return null;
}
// npm 全局目录的候选（2026-11-07 抽到 core/tool-discovery/npm-global-dirs.js，CodeAgent 也用）。
const { npmPrefixes, registryPathDirs, npmConfigPrefix, runText } = require('../tool-discovery/npm-global-dirs');
// 同步调用方只读路径，不等待 where；按环境隔离缓存，在途去重，未找到一分钟后可再试。
const cliCaches = new WeakMap();
// 只认文件名是 welink-cli 的程序（.js / .cjs 是测试替身）。2026-11-12 同事电脑：设置里记成了 WeLink 桌面客户端 WeLinkPC.exe，
// Hub 每次读版本、查登录都启动它一次；客户端是单实例程序，第二次启动就把主窗口弹到最前，于是每 10 分钟左右弹一次。
// 不是 welink-cli 的路径一律不运行、不记入设置。
function isCliFile(file) {
  const base = String(file || '').split(/[\\/]/).pop().toLowerCase();
  if (/\.[cm]?js$/.test(base)) return true;
  // 改过名的副本（welink-cli (1).exe、welink-cli-1.0.16.exe）照认；名字里没有 welink-cli 的（WeLinkPC.exe 等）不认。
  return base.includes('welink-cli') && /\.(?:exe|cmd|bat)$/.test(base);
}
function resolveCli({ env = process.env, configured = '', fsModule = fs, now = Date.now, execFileImpl = execFile } = {}) {
  const pick = [env.CLAUDE_HUB_WELINK_CLI, configured].find(p => p && isCliFile(p) && fsModule.existsSync(p));
  if (pick) return pick;
  let caches = cliCaches.get(env);
  if (!caches) { caches = new WeakMap(); cliCaches.set(env, caches); }
  let cache = caches.get(fsModule);
  if (!cache) { cache = { path: null, pending: false, at: -Infinity, missKey: null, missAt: -Infinity }; caches.set(fsModule, cache); }
  // 2026-11-20 实测：没装 welink-cli 的电脑上，状态查询每次都把 PATH 每个目录再查两遍，空闲 1 分钟约 3700 次文件检查。
  // 同一份 PATH 刚扫过没找到，10 秒内不再重扫（装好后最多 10 秒认到；设置里记的路径、环境变量指定的路径不受影响）。
  const scanKey = String(env.PATH || env.Path || '');
  if (!(cache.missKey === scanKey && now() - cache.missAt < 10000)) {
    for (const dir of npmPrefixes(env, fsModule)) { const hit = cliUnder(dir, fsModule); if (hit) return hit; }
    // 保留单次运行的只读包装能力：PATH 上的 exe 或 npm cmd 的兄弟 exe 可立即找到。
    for (const dir of scanKey.split(path.delimiter).filter(Boolean)) {
      const hit = cliUnder(dir.replace(/^"|"$/g, ''), fsModule);
      if (hit) return hit;
    }
    cache.missKey = scanKey; cache.missAt = now();
  }
  if (cache.path && fsModule.existsSync(cache.path)) return cache.path;
  cache.path = null;
  if (cache.pending || now() - cache.at < 60000) return null;
  cache.pending = true;
  const finish = (error, stdout) => {
    cache.pending = false;
    cache.at = now();
    if (error) return;
    const found = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const f of found) {
      const sibling = cliUnder(path.dirname(f), fsModule);
      if (sibling) { cache.path = sibling; break; }
      try { if (/\.exe$/i.test(f) && isCliFile(f) && fsModule.existsSync(f)) { cache.path = f; break; } } catch { /* 查询结束前路径变得不可读 */ }
    }
  };
  try {
    execFileImpl('where', ['welink-cli'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env }, finish);
  } catch (error) { finish(error); }
  return null;
}

// 全盘找（异步，后台跑，最多约 2 分钟）：
//   1) 注册表里最新的 PATH（装完 welink-cli 没重启 Hub 时，Hub 进程的 PATH 是旧的）；
//   2) npm config get prefix（用最新的 PATH 跑）；
//   3) 前两步都没找到时，在用户目录、各个硬盘里按文件名找 welink-cli.exe（限制深度，跳过 Windows 系统目录）。
// 2026-11-07：装了多份时要全部交给版本选择（core/tool-discovery），所以每一步都收集全部结果放进 paths；
// path / via 仍是第一个结果，老调用方不变。
async function findCliDeep({ env = process.env, fsModule = fs, execFileImpl, timeoutMs = 120000, onStage = () => {}, roots: rootsOverride = null } = {}) {
  const started = Date.now(), left = () => Math.max(5000, timeoutMs - (Date.now() - started));
  const found = [];
  const add = (p, via) => { if (p && !found.some(f => f.path.toLowerCase() === p.toLowerCase())) found.push({ path: p, via }); };
  onStage('path');
  const fresh = await registryPathDirs({ env, execFileImpl, platform: 'win32' });
  for (const dir of fresh) add(cliUnder(dir, fsModule), 'path');
  onStage('npm');
  const prefix = await npmConfigPrefix({ env, freshDirs: fresh, execFileImpl });
  add(prefix && cliUnder(prefix, fsModule), 'npm');
  if (!found.length) {
    onStage('disk');
    const drives = 'CDEFGH'.split('').map(l => l + ':\\').filter(d => { try { return fsModule.existsSync(d); } catch { return false; } });
    const roots = rootsOverride || [[env.USERPROFILE, 8], ...drives.map(d => [d, 5])].filter(([r]) => r);
    for (const [root, depth] of roots) {
      if (Date.now() - started > timeoutMs) break;
      const script = `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem -LiteralPath '${String(root).replace(/'/g, "''")}' -Directory -Force | Where-Object { $_.Name -notmatch '^(Windows|\$Recycle\.Bin|System Volume Information|ProgramData)$' } | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter 'welink-cli.exe' -File -Recurse -Depth ${depth} -Force } | Select-Object -First 8 -ExpandProperty FullName`;
      const out = (await runText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: left(), execFileImpl })).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const file of out) { try { if (fsModule.existsSync(file)) add(file, 'disk'); } catch { /* 跳过 */ } }
    }
  }
  return found.length ? { path: found[0].path, via: found[0].via, paths: found } : { path: null, via: null, paths: [] };
}

// welink-cli 自己上报使用统计（Telemetry）失败时打的告警行（2026-11-21，群里多人原文）：
//   [WARN] Telemetry: report error: HTTP request failed: Could not connect to server (code=7) | detail: Failed to connect to proxyhk... port 8080 ...
// 1.0.20 exe 里同类行共 5 种：posting to / report failed / report succeeded / report error / unknown error in async report / emit code。
// 上报走公司代理，代理不通就打这一行，和登录、查询成败无关。以前它含 fail/error 字样，扫码面板据此判「登录没成功」并藏起二维码，
// 邮件日历配置、手机对话的报错也把它当原因显示。只认行首（可带时间戳）的 [级别] Telemetry，查询结果 JSON 里的文字不受影响。
const TELEMETRY_NOISE = /^[^\S\r\n]*(?:[^\s"[]+[^\S\r\n]+){0,2}(?:\[(?:WARN|WARNING|ERROR|INFO|DEBUG)\][^\S\r\n]*Telemetry\b|Telemetry\s*:\s*(?:report|posting\s+to|unknown\s+error\s+in\s+async|emit\s+code)\b)[^\r\n]*(?:\r\n|\n|\r|$)/gim;
const dropNoise = text => String(text || '').replace(TELEMETRY_NOISE, '');

// 跑一条 welink-cli。.js 结尾的是测试用的假程序，用 Hub 自己的程序以 Node 方式运行。
// onData：边跑边拿到目前为止的全部输出（扫码登录要在命令结束前把二维码显示出来）。
function run(args, { cli, timeoutMs = 30000, allowSetup = false, sendGroup = '', sendUser = '', addMember = null, recall = null, env = process.env, spawnFn = spawn, onData = null, signal = null } = {}) {
  const list = checkArgs(args, { allowSetup, sendGroup, sendUser, addMember, recall });
  if (!cli) return Promise.reject(Object.assign(new Error('没找到 welink-cli：请在当前页面点「一键安装」或「查找或一键安装」'), { code: 'WELINK_MISSING' }));
  const isScript = /\.(?:c?js)$/i.test(cli);
  const cmd = isScript ? process.execPath : cli;
  const argv = isScript ? [cli, ...list] : list;
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false, stopping = null, cleanupTimer = null;
    if (signal?.aborted) { reject(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' })); return; }
    const child = spawnFn(cmd, argv, { windowsHide: true, env: { ...env, ...(isScript ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
    const stop = error => {
      if (done || stopping) return; stopping = error; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      cleanupTimer = setTimeout(() => {
        if (done) return; done = true;
        reject(Object.assign(new Error(error.message + '；进程退出尚未确认，请稍后重试'), { code: 'WELINK_CLEANUP_TIMEOUT' }));
      }, 10000);
      // Only this invocation's child tree; never find/kill a process by name.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', e => { console.warn('[welink] 结束登录进程树失败', e.message); child.kill(); });
        killer.on('close', code => { if (code && child.exitCode == null) { console.warn('[welink] 结束登录进程树返回', code); child.kill(); } });
      } else child.kill();
    };
    const aborted = () => stop(Object.assign(new Error('已停止这次 WeLink 登录'), { code: 'WELINK_ABORTED' }));
    const timer = setTimeout(() => stop(Object.assign(new Error(`welink-cli 超过 ${Math.round(timeoutMs / 1000)} 秒没返回：${list.slice(0, 2).join(' ')}`), { code: 'WELINK_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    const tell = () => { if (onData) { try { onData(dropNoise(out) + dropNoise(err)); } catch { /* 显示失败不影响命令 */ } } };
    // 按 UTF-8 解码且跨数据块拼字（二维码的 █▀▄ 各占 3 个字节，按块各自转字符串会把切开的字变成乱码）。
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', d => { out += d; tell(); });
    child.stderr?.on('data', d => { err += d; tell(); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', aborted); reject(e); });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', aborted); if (stopping) reject(stopping); else resolve({ code, stdout: dropNoise(out), stderr: dropNoise(err) }); });
  });
}

// 从输出里取 JSON（有的命令前后带提示文字）。取不到返回 null。
function parseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 往下找 */ }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  for (let end = s.length; end > start; end -= 1) {
    const ch = s[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try { return JSON.parse(s.slice(start, end)); } catch { /* 再短一点 */ }
  }
  return null;
}

// 登录与日历状态：auth status 里 Token EXPIRED 或没登录 → 要扫码；日历报 Exchange 域名没找到 → 要初始化。
const LOGIN_NEEDED = /EXPIRED|INVALID|REVOKED|credentials\s+corrupted|未登录|已失效|已过期|not\s+logged\s*in|not\s+authenticated|unauthenticated|no\s+token|\buser\s+token\s+not\s+found\b|refresh\s+token\s+invalid|run:?\s*['"`]?welink-cli\s+auth\s+login/i;
// 1.0.20 自动刷新令牌时夹带的进度行（Q-1106-07 从 exe 里读到）：不是登录状态，判断前先去掉——
// 尤其「Sign data expired …」里的 expired 会被误当成令牌过期，平白去跑一次 auth login。
const PROGRESS_LINE = /^.*(?:sign\s+data\s+expired|obtaining\s+sign|token\s+refresh(?:ed|ing)?\s+complete|refreshing\s+token|token\s+will\s+auto-refresh).*$/gim;
function loginState(statusText) {
  const s = String(statusText || '').replace(PROGRESS_LINE, '');
  // 1.0.20 的在线输出可能把账号写在 Account / User ID 行（只从 exe 字符串里看到，待真机核对）：没有 UID 行时用它们兜底。
  const uid = (s.match(/\bUID\s*[:：]\s*([A-Za-z0-9_-]+)/i) || s.match(/\b(?:User\s*ID|Account)\s*[:：]\s*([A-Za-z0-9_-]+)/i) || [])[1] || null;
  // 有「User Token: …」这一行时只看这一行（1.0.14 / 1.0.20 都有）：别的行（如 refresh token）写着 expired 不算数。
  const line = (s.match(/User\s+Token\s*[:：]\s*([^\r\n]*)/i) || [])[1];
  if (line != null) return /^\s*(?:VALID|OK|有效)\b/i.test(line) ? { ok: true, uid } : { ok: false, reason: 'expired', uid };
  // 2026-11-06：INVALID / REVOKED 也按过期处理——以前只要读到 UID 就算已登录，令牌作废了还照常去取数。
  // 1.0.20 未登录改成「Status: not authenticated」、退出码 0（Q-1106-06）；旧正则认不出，Hub 判成「无法识别」，既不续期也不提示扫码。
  // 兜底：输出里只要叫人去跑 auth login，就按要登录处理——以后措辞再变也不至于卡死。
  if (LOGIN_NEEDED.test(s)) return { ok: false, reason: 'expired', uid };
  if (/Token\s*[:：]\s*(?:VALID|OK|有效)|已登录|\blogged\s*in|Status\s*[:：]\s*authenticated/i.test(s) || uid) return { ok: true, uid };
  return { ok: false, reason: 'unknown', uid };
}
// 同 parseJson，但先把长整数的消息编号改成字符串（JSON.parse 会把它们舍入成同一个数，相邻两条消息就分不清了）。
function parseJsonBig(text) {
  return parseJson(String(text || '').replace(/("(?:msgId|msg_id|messageId|message_id|messageID|maxMsgId|minMsgId|meetingId|groupId|group_id)"\s*:\s*)(\d{15,})/g, '$1"$2"'));
}
// 群的历史消息（im query-history-message）。字段依据公司真机回执 Q-1018-04：msgId（整型）、sender（账号）、content、contentType、serverSendTime。
// msgId 是很长的整数，JSON.parse 会丢精度（游标就对不上了）：先把它们改成字符串再解析，比较大小用 BigInt。
function groupMessages(text) {
  const data = parseJsonBig(text);
  if (data == null) return null;
  const found = [];
  const walk = (v, depth) => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) { if (x && typeof x === 'object' && (x.msgId != null || x.msg_id != null)) found.push(x); else walk(x, depth + 1); } return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  const big = v => { try { return /^\d+$/.test(String(v)) ? BigInt(String(v)) : null; } catch { return null; } };
  return found.map(m => {
    const id = String(m.msgId ?? m.msg_id);
    const rawAt = m.serverSendTime ?? m.server_send_time ?? m.sendTime ?? m.send_time;
    const at = rawAt == null || rawAt === '' ? NaN : Number(rawAt) < 1e11 ? Number(rawAt) * 1000 : Number(rawAt);
    let content = m.content ?? m.msgContent ?? m.text ?? '';
    if (content && typeof content === 'object') content = content.text ?? content.content ?? '';
    return { id, n: big(id), sender: String(m.sender ?? m.sender_account ?? m.senderAccount ?? ''), type: String(m.contentType ?? m.content_type ?? ''),
      at: Number.isFinite(at) ? at : null, text: String(content || '') };
  }).filter(m => m.n !== null).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
}
// 群成员（im query-group-member）：只取账号和显示名，给「手机」设置页核对群里是不是只剩自己和小微助手。
function groupMembers(text) {
  const data = parseJson(text);
  let list = [];
  const walk = (v, depth) => {
    if (list.length || depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && !Array.isArray(x))) { list = v.filter(x => x && typeof x === 'object'); return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  const pick = (m, keys) => { for (const k of keys) if (m[k] != null && m[k] !== '') return String(m[k]); return ''; };
  return list.map(m => ({ account: pick(m, ['account', 'userAccount', 'user_account', 'memberAccount', 'staffAccount', 'w3Account']),
    name: pick(m, ['name', 'staffName', 'staff_name', 'nativeName', 'native_name', 'nickName', 'userName', 'account']) }));
}
const calendarNeedsSetup =text => /Exchange server domain not found|mail autodiscover/i.test(String(text || ''));

// ---- 扫码登录的二维码（2026-10-22 v3.1.1，依据公司回执 Q-1021-14：welink-cli 1.0.14 反汇编）----
// 真机 auth login 不出图片、不出 base64，而是在 stdout 上用 Unicode 半块字符画二维码，外面套一个 +---+ / | | 的框；
// 每个字符 = 1 列 × 2 行模块：█ 上下都黑，▀ 只有上黑，▄ 只有下黑，空格都白。框后面那个网址是登录网页，不是图片。
const QR_CELL = Object.freeze({ ' ': [0, 0], '█': [1, 1], '▀': [1, 0], '▄': [0, 1] });
const QR_MIN = 21; // 最小的二维码（版本 1）是 21×21 模块
// 最后一个完整的框（两条等长的 +---+ 之间全是等宽的 |…| 行）。二维码刷新时一次输出里会有多个框，以最后一个为准；
// 流式输出里框只到一半时不算。行内（包括行尾）的空格原样保留：它们是白模块。
function lastQrBox(text) {
  let box = null, last = null;
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    const border = /^\s*\+(-+)\+\s*$/.exec(line);
    if (border) {
      if (box && box.rows.length && border[1].length === box.width) { last = box; box = null; } else box = { width: border[1].length, rows: [] };
      continue;
    }
    if (!box) continue;
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    if (!row || row[1].length !== box.width) { box = null; continue; }
    box.rows.push(row[1]);
  }
  return last;
}
// 字符画 → 布尔矩阵（true=黑）。只有矩阵完整、每个字符都认得时才返回，否则 null。
// 奇数行的二维码最后一行字符只用 ▀：多出来的那半行全白，去掉它让矩阵回到正方形。
function qrMatrixFromBlocks(text) {
  const box = lastQrBox(text);
  if (!box) return null;
  const top = [], bottom = [];
  for (const line of box.rows) {
    const t = [], b = [];
    for (const ch of line) { const cell = QR_CELL[ch]; if (!cell) return null; t.push(!!cell[0]); b.push(!!cell[1]); }
    top.push(t); bottom.push(b);
  }
  const matrix = [];
  top.forEach((t, i) => { matrix.push(t, bottom[i]); });
  const width = box.width;
  if (!bottom[bottom.length - 1].some(Boolean) && matrix.length !== width) matrix.pop();
  if (width < QR_MIN || matrix.length < QR_MIN || matrix.some(r => r.length !== width)) return null;
  return matrix;
}
// 布尔矩阵 → 半块字符画（与上面的解析互逆；测试和 welink-cli 替身用它按真机格式出图）。
function qrBlocksFromMatrix(matrix) {
  const width = matrix[0].length, lines = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let s = '';
    for (let x = 0; x < width; x += 1) { const t = !!matrix[y][x], b = !!(matrix[y + 1] && matrix[y + 1][x]); s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
    lines.push('|' + s + '|');
  }
  const border = '+' + '-'.repeat(width) + '+';
  return [border, ...lines, border].join('\n');
}
// 在主进程里把矩阵画成 SVG，交给页面的是 data: 地址（页面 CSP 只放行 'self' file: data: 图片，不用改 CSP，也不引入二维码库）。
// 黑 #000、白底、四周留 4 个模块的静区（扫码需要），每个模块 7px，crispEdges 保证边缘不糊。
function qrSvgDataUri(matrix, { cell = 7, margin = 4 } = {}) {
  const width = matrix[0].length, height = matrix.length, W = (width + margin * 2) * cell, H = (height + margin * 2) * cell;
  let d = '';
  matrix.forEach((row, y) => {
    for (let x = 0; x < width;) {
      if (!row[x]) { x += 1; continue; }
      let end = x; while (end < width && row[end]) end += 1;
      d += `M${(x + margin) * cell} ${(y + margin) * cell}h${(end - x) * cell}v${cell}h-${(end - x) * cell}z`;
      x = end;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
  return { value: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'), px: W, modules: width };
}
// 输出里有完整的框，却一个 █▀▄ 都没有（或带 U+FFFD 替换符）：多半是编码不对。只报告，不猜着换 GBK。
function loginOutputGarbled(text) {
  const s = String(text || '');
  if (/[█▀▄]/.test(s)) return false;
  return s.includes('\uFFFD') || !!lastQrBox(s)?.rows.some(r => /\S/.test(r));
}
// 「If QR code is not displayed correctly, open this URL to scan:」后面那个登录网页（只认 https），作兜底链接，不当图片。
function loginUrlFromOutput(text) {
  const s = String(text || '');
  const after = /open\s+this\s+url[^\r\n]*[\r\n]+\s*(https:\/\/[^\s"<>]+)/i.exec(s);
  if (after) return after[1];
  const any = s.match(/https:\/\/[^\s"<>]+/g);
  return any ? any[any.length - 1] : null;
}
// 扫码登录没成功的原因（2026-11-19，依据黄区真机 welink-cli 1.0.20 exe 里的原文）：
// 登录分三段——向服务器要二维码（qrcode/generate）→ 等手机扫码（qrcode/status）→ 用授权码换令牌（qrcode/login，回 sign/nonce/timestamp），
// 期间还要经 WebSocket 向「本机 WeLink 桌面端」（127.0.0.1）取一份签名。后两段出错时 CLI 只打一行英文，以前 Hub 只说「没查到已登录」。
// 排在前面的优先：同一次输出里既有网络错又有桌面端错时，按桌面端说。
const LOGIN_CAUSES = Object.freeze([
  { id: 'credentials', re: /credentials\s+corrupted|Credential\s+signature\s+verification\s+failed|Credential\s+decryption\s+failed/i,
    title: '这台电脑上保存的 WeLink 登录信息损坏了', next: '点「清除并重新扫码」：Hub 先清掉本机旧的登录信息，再出新二维码。', action: 'relogin-clean' },
  { id: 'pc-version', re: /WeLink\s+PC\s+version\s+may\s+be\s+incompatible/i,
    title: 'WeLink 桌面端版本太旧', next: '把这台电脑上的 WeLink 桌面端升级到最新版，再点「重新获取二维码」。' },
  { id: 'pc-busy', re: /WeLink\s+PC\s+may\s+be\s+busy|WeLink\s+PC\s+verification\s+timeout/i,
    title: 'WeLink 桌面端暂时没回应', next: '等几秒再点「重新获取二维码」；仍不行就退出并重新打开 WeLink 桌面端。' },
  { id: 'pc', re: /Cannot\s+connect\s+to\s+WeLink\s+PC|ensure\s+WeLink\s+PC\s+is\s+running|WeLink\s+PC\s+not\s+running|check\s+if\s+WeLink\s+PC\s+is\s+responding|WebSocket\s+Connect\s+Timeout/i,
    title: '这台电脑上的 WeLink 桌面端没开或没响应', next: 'welink-cli 登录时要向本机的 WeLink 桌面端取一份签名。请打开这台电脑上的 WeLink 桌面端并登录本人账号，再点「重新获取二维码」。' },
  { id: 'other-device', re: /sign\/nonce\/timestamp|invalid\s+sign\s+data|auth_sign_ws_failed|Sign\s+WebSocket\s+Failed|unknown_ws_error/i,
    title: '没拿到登录签名：你的 WeLink 可能正登录在另一台电脑上', next: 'WeLink 同一时间只能在一台电脑上登录。请在这台电脑的 WeLink 桌面端登录本人账号（另一台会下线），确认登上后点「重新获取二维码」。' },
  { id: 'code', re: /授权码(?:为空|已过期|无效)/,
    title: '这次扫码的授权已失效', next: '点「重新获取二维码」再扫一次，扫完记得在手机上点确认。' },
  { id: 'timeout', re: /QR\s+code\s+(?:scan\s+|login\s+)?time[d\s-]*out/i,
    title: '二维码超时了，没等到扫码', next: '点「重新获取二维码」，出码后尽快用手机 WeLink 扫。' },
  { id: 'qr-request', re: /QR\s+code\s+request\s+failed|Failed\s+to\s+parse\s+QR\s+code\s+response|Invalid\s+QR\s+code\s+response/i,
    title: '没能从 WeLink 服务器拿到二维码', next: '多半是这台电脑没连上公司网络，或请求被公司代理拦了。确认已连公司网络后点「重新获取二维码」；仍不行点「一键反馈」。' },
  { id: 'agent', re: /Agent\s+login\s+failed|授权码登录失败/i,
    title: 'WeLink 服务器没接受这次登录', next: '点「重新获取二维码」再扫一次。连续不行时，常见原因是 WeLink 正登录在另一台电脑上，或账号还没开通 WeLink CLI；可点「一键反馈」带上日志。' },
  { id: 'network', re: /Polling\s+error|Timeout\s+was\s+reached|Connection\s+timeout|Failed\s+to\s+resolve|Could\s+not\s+resolve|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i,
    title: '登录途中网络断了', next: '确认这台电脑连着公司网络，再点「重新获取二维码」。' },
]);
// 登录原文要显示在界面、带进一键反馈：先抹掉令牌、签名、授权头和长串编码（Codex 复审：JSON 里带引号的字段、Bearer 也要抹）。
function scrubLine(text) {
  return String(text || '')
    .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 ***')
    .replace(/(["']?\b(?:[\w-]*token|ticket|secret|password|sign|nonce|authorization|auth_code|uuid)["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic) \*\*\*)[^\s"',}]+/gi, '$1***')
    // 长串编码：至少含一个字母或数字（二维码边框「+-----+」不算）。
    .replace(/(?=[A-Za-z0-9+/_=-]*[A-Za-z0-9])[A-Za-z0-9+/_=-]{32,}/g, '***');
}
const LOGIN_STEP_LINE = /Token\s+expired,\s+refreshing|Token\s+refresh\s+failed|Proceeding\s+with\s+QR\s+code\s+login|Sign\s+data\s+expired\s+or\s+missing|Token\s+invalid\s+while\s+sign\s+expired|Obtaining\s+sign\s+via\s+WebSocket/i;
function loginDiagnosis(text) {
  const lines = dropNoise(text).split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
  for (const c of LOGIN_CAUSES) {
    const line = lines.filter(l => c.re.test(l)).pop();
    if (line) return { id: c.id, title: c.title, next: c.next, action: c.action || 'login', line: scrubLine(line).slice(0, 200) };
  }
  return null;
}
// 登录进度（显示用）：Waiting for scan... (elapsed N seconds) → 等待扫码；Scan successful → 已扫码；timeout/failed → 失败及原因。
// 上面那张原因表里认得的行（如「Cannot connect to WeLink PC.」不含 fail/error 字样）也算失败。
function loginProgress(text) {
  const lines = dropNoise(text).split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
  let phase = null, elapsed = null, reason = '';
  for (const line of lines) {
    if (/^https?:\/\//i.test(line) || /not\s+displayed\s+correctly/i.test(line)) continue;
    // 1.0.20 登录开头先试着刷新旧令牌，失败了接着出二维码；扫码后取签名前也会打「Sign data expired…」。这些是过程，不是失败。
    if (LOGIN_STEP_LINE.test(line)) continue;
    const wait = /Waiting\s+for\s+scan/i.test(line);
    if (/Scan\s+successful/i.test(line)) { phase = 'scanned'; reason = ''; } else if (/time[d\s-]*out|expired|fail|error|超时|失败|过期/i.test(line) || LOGIN_CAUSES.some(c => c.re.test(line))) { phase = 'failed'; reason = scrubLine(line).slice(0, 200); } else if (wait) {
      phase = 'waiting'; reason = '';
      const n = /elapsed\s+(\d+)\s*s/i.exec(line); elapsed = n ? Number(n[1]) : elapsed ?? 0;
    } else if (!phase && /Obtaining\s+QR\s+code/i.test(line)) phase = 'obtaining';
  }
  return phase ? { phase, elapsed, reason } : null;
}

// auth login 的二维码：半块字符画（真机格式，优先）→ data URI → 图片路径 → 网址。
// kind:'url' 只说明输出里有登录网页；它不是图片，页面不会放进 <img>，扫码面板只把它当「在浏览器打开」的兜底链接。
function qrFromLoginOutput(text) {
  const s = String(text || '');
  const matrix = qrMatrixFromBlocks(s);
  if (matrix) { const svg = qrSvgDataUri(matrix); return { kind: 'blocks', value: svg.value, px: svg.px, modules: svg.modules }; }
  const dataUri = s.match(/data:image\/(?:png|jpe?g|svg\+xml);base64,[A-Za-z0-9+/=]+/);
  if (dataUri) return { kind: 'data', value: dataUri[0] };
  const file = s.match(/[A-Za-z]:\\[^\r\n"<>|]*?\.(?:png|jpe?g|bmp|svg)/i) || s.match(/\/[^\s"<>|]+\.(?:png|jpe?g|svg)/i);
  if (file) return { kind: 'file', value: file[0] };
  const url = s.match(/https?:\/\/[^\s"<>]+/);
  if (url) return { kind: 'url', value: url[0] };
  return null;
}
// 登录输出是否在要人扫码：手动扫码面板和自动续期（auth-keeper）共用这一个判断。
// 认二维码本身（字符画、图片、网址），也认真机这几行固定文字——框还没画完时就能停下自动续期。
const SCAN_PROMPT = /请.{0,12}扫码|二维码|scan\s+(?:the\s+)?qr|qr\s*code|Please\s+scan|Waiting\s+for\s+scan|WeLink\s+QR\s+Code\s+Login/i;
function loginNeedsScan(text) {
  const s = String(text || '');
  return !!qrFromLoginOutput(s) || SCAN_PROMPT.test(s) || /^\s*\+-{21,}\+\s*$/m.test(s);
}

// 用户看到的报错说人话（2026-11-06）：CLI 原文只进日志，界面和回答里给原因和下一步。认不出的保持原样。
// 启动失败（exe 正被 npm 升级替换、被占用、一时不存在）的错误码：Hub 隔 2 秒自动重试一次。
const SPAWN_RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'UNKNOWN']);
const AUTH_FAILURE = /(?:token|session)\s*(?:is\s*)?(?:expired|invalid)|unauthenticated|not\s+authenticated|not\s+logged\s*in|未登录|登录(?:已)?(?:过期|失效)|no\s+token|\buser\s+token\s+not\s+found\b|refresh\s+token\s+invalid|run:?\s*['"`]?welink-cli\s+auth\s+login/i;
const FRIENDLY = [
  [e => e.code === 'WELINK_MISSING', () => '没找到 welink-cli：请在当前页面点「一键安装」或「查找或一键安装」，装好后会自动填入路径'],
  [e => e.syscall === 'spawn' || SPAWN_RETRY.has(e.code), () => 'welink-cli 暂时打不开（可能正在升级或被占用），Hub 稍后自动重试'],
  [e => e.code === 'WELINK_TIMEOUT', e => { const s = /(\d+)\s*秒/.exec(e.message || ''); return `WeLink 这次响应太慢${s ? `（超过 ${s[1]} 秒）` : ''}，已跳过，稍后自动重试`; }],
  [e => e.code === 'WELINK_CLEANUP_TIMEOUT', () => 'WeLink 上一条查询还没退出，稍后自动重试'],
  [e => AUTH_FAILURE.test(e.message || ''), () => 'WeLink 登录已过期，Hub 正在自动续期；续上后再问一次即可'],
  // R32：网关拒绝。换过工号（命令行还登着旧账号）最常见，其次是桌面端没登录；助理页 WeLink 一行会写明是哪种并给按钮。
  [e => /proxy\s*failed/i.test(e.message || ''), () => 'WeLink 服务器拒绝了这次请求（proxy failed）：多半是 welink-cli 还登着旧账号、和电脑上的 WeLink 不是同一个账号。到助理页看 WeLink 一行，点「重新登录」'],
  [e => /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|socket hang up|network error/i.test(e.message || ''), () => 'WeLink 网络暂时不通，Hub 稍后自动重试'],
  [e => /internal server error|service unavailable|bad gateway|gateway timeout|\bstatus\s+5\d\d\b/i.test(e.message || ''), () => 'WeLink 服务端暂时出错，稍后自动重试'],
];
function friendlyError(error) {
  const e = typeof error === 'string' ? { message: error } : error || {};
  for (const [hit, say] of FRIENDLY) if (hit(e)) return say(e);
  return String(e.message || '');
}

module.exports = { READ_ONLY, SETUP, checkArgs, isCliFile, resolveCli, findCliDeep, npmPrefixes, cliUnder, run, parseJson, parseJsonBig, groupMessages, groupMembers, loginState, calendarNeedsSetup,
  dropNoise, qrFromLoginOutput, qrMatrixFromBlocks, qrBlocksFromMatrix, qrSvgDataUri, loginOutputGarbled, loginUrlFromOutput, loginProgress, loginNeedsScan, loginDiagnosis, LOGIN_CAUSES, scrubLine, friendlyError, SPAWN_RETRY, AUTH_FAILURE };
