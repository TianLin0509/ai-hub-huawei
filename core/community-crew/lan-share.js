'use strict';
// 社区·我的团队：找到（或一键建好）本机共享出去的文件夹，在它下面放团队信箱。
// 开箱即用：先用本机已经共享给同事的文件夹（不要管理员权限）；一个都没有时，界面上一键新建，
// 这一步要 Windows 弹一次管理员确认（用户自己点的，不是后台偷偷弹）。
// 信箱目录固定叫 ai-hub-community；对方读取路径为 \\<IP>\<共享名>\ai-hub-community\...
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

// TCP 探测不占文件线程池；失败时不再访问可能长时间挂起的 UNC。
function probeSmb(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    try { socket.connect(445, ip); } catch { finish(false); }
  });
}

const BOX_DIR = 'ai-hub-community';
const NEW_SHARE_NAME = 'AIHubCommunity';

function powershell(script, { timeoutMs = 30000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`;
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } finish(new Error('Windows 查询超时')); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { if (out.length < 1024 * 1024) out += c; });
    child.stderr.on('data', c => { if (err.length < 4096) err += c; });
    child.on('error', e => finish(e));
    child.on('close', code => (code === 0 ? finish(null, out.replace(/^\uFEFF/, '').trim()) : finish(new Error(err.trim().split(/\r?\n/)[0] || 'Windows 查询失败'))));
  });
}

// 本机的磁盘共享（去掉 C$、ADMIN$ 这类隐藏共享和打印机）。
async function listShares(opts = {}) {
  if (process.platform !== 'win32' && !opts.spawnImpl) return [];
  const raw = await powershell("@(Get-CimInstance Win32_Share | Where-Object { $_.Type -eq 0 -and $_.Name -notmatch '\\$$' -and $_.Path } | ForEach-Object { [pscustomobject]@{ name = $_.Name; path = $_.Path } }) | ConvertTo-Json -Compress", opts);
  if (!raw) return [];
  const v = JSON.parse(raw);
  return (Array.isArray(v) ? v : [v]).filter(s => s && s.name && s.path).map(s => ({ name: String(s.name), path: String(s.path) }));
}

// 共享下面能不能建信箱目录（只读共享、拔掉的盘都不行）。
function usable(share) {
  try {
    const dir = path.join(share.path, BOX_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

// 挑一个：之前用过的优先；其次是我们自己建的；再按路径短的（通常是用户专门共享的工作目录）。
// 按顺序逐个试，试到能用的就停：不在用户别的共享里留下空目录。
function pickShare(shares, preferred, test = usable) {
  const rank = s => (preferred && s.name.toLowerCase() === String(preferred).toLowerCase() ? 0 : s.name === NEW_SHARE_NAME ? 1 : 2);
  const order = shares.slice().sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length);
  return order.find(s => test(s)) || null;
}

// 新建共享给谁读（R66-5，2026-11-28 同事反馈看到提示后先把 Everyone 分享禁掉了）：以前共享与目录都给 Everyone（S-1-1-0，含匿名与来宾），
// 现在只给「已登录的用户」（Authenticated Users，S-1-5-11）：同事用自己的域账号照样读得到，匿名、来宾读不到。
// 用 SID 而不是名字：中文 Windows 上组名是本地化的。已经建好的共享不改（用户自己的设置不动），界面上显示它当前给了谁。
const READER_SID = 'S-1-5-11';
// 新建共享：放在非系统盘根目录（有 D: 用 D:），共享与目录都只给「已登录的用户」读。写入只发生在本机，不经过共享。
function defaultNewPath() {
  for (const d of ['D', 'E', 'C']) {
    try { if (fs.statSync(`${d}:\\`).isDirectory()) return `${d}:\\${NEW_SHARE_NAME}`; } catch { /* 没有这个盘 */ }
  }
  return `C:\\${NEW_SHARE_NAME}`;
}

// 一键新建：外层 PowerShell 隐藏运行，里面用 RunAs 拉起一个要管理员确认的 PowerShell 完成建目录、授权、建共享。
async function createShare({ dir = defaultNewPath(), name = NEW_SHARE_NAME, timeoutMs = 120000, spawnImpl } = {}) {
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const inner = [
    `$p=${q(dir)}; New-Item -ItemType Directory -Force -Path $p | Out-Null`,
    `$readers=([System.Security.Principal.SecurityIdentifier]'${READER_SID}').Translate([System.Security.Principal.NTAccount]).Value`,
    `icacls $p /grant '*${READER_SID}:(OI)(CI)RX' | Out-Null`,
    `if (-not (Get-SmbShare -Name ${q(name)} -ErrorAction SilentlyContinue)) { New-SmbShare -Name ${q(name)} -Path $p -ReadAccess $readers | Out-Null }`,
  ].join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `$r = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; $r.ExitCode`;
  let code;
  try { code = await powershell(outer, { timeoutMs, spawnImpl }); }
  catch (e) {
    if (/cancel|取消|拒绝|denied/i.test(e.message)) throw new Error('没有完成管理员确认，共享没有建');
    throw e;
  }
  if (String(code).trim() !== '0') throw new Error('新建共享没有成功（可能没有管理员权限），可以先在资源管理器里把任意一个文件夹共享出去，再点「重新检测」');
  return { name, path: dir };
}

// 这个共享现在给了谁（只读查询，不要管理员权限）：[{ sid, account, allow, right }]，right 0 完全控制 / 1 更改 / 2 读取。
async function shareAccess(name, opts = {}) {
  if (process.platform !== 'win32' && !opts.spawnImpl) return [];
  const q = "'" + String(name).replace(/'/g, "''") + "'";
  const raw = await powershell(`@(Get-SmbShareAccess -Name ${q} | ForEach-Object { $sid = ''; try { $sid = ([System.Security.Principal.NTAccount]$_.AccountName).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}; [pscustomobject]@{ sid = $sid; account = [string]$_.AccountName; allow = ([int]$_.AccessControlType -eq 0); right = [int]$_.AccessRight } }) | ConvertTo-Json -Compress`, opts);
  if (!raw) return [];
  const v = JSON.parse(raw);
  return (Array.isArray(v) ? v : [v]).filter(e => e && (e.sid || e.account)).map(e => ({ sid: String(e.sid || ''), account: String(e.account || ''), allow: e.allow !== false, right: Number(e.right) }));
}
// 把共享权限归成三档给界面看：everyone（所有人，含匿名或来宾）/ signed-in（已登录的同事）/ limited（只给了指定的人）。
const OPEN_SIDS = new Set(['S-1-1-0', 'S-1-5-7', 'S-1-5-32-546']);   // Everyone、匿名登录、来宾组
const SIGNED_IN = sid => sid === 'S-1-5-11' || sid === 'S-1-5-32-545' || /^S-1-5-21-[\d-]+-513$/.test(sid);   // 已登录用户、本机 Users 组、域用户
function shareScope(entries) {
  const allow = (entries || []).filter(e => e && e.allow !== false && (e.sid || e.account));
  if (!allow.length) return { level: 'unknown', label: '没读到' };
  if (allow.some(e => OPEN_SIDS.has(e.sid))) return { level: 'everyone', label: '所有人（Everyone）都能打开' };
  if (allow.some(e => SIGNED_IN(e.sid))) return { level: 'signed-in', label: '已登录的同事能打开' };
  const names = allow.map(e => e.account.replace(/^.*[\\/]/, '')).filter(Boolean);
  return { level: 'limited', label: '只给了：' + names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 个` : '') };
}

function parseInboundSmb(raw) {
  const out = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:445\s+(?:\[?::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})\]?:(\d+)\s/i);
    if (m && m[2] !== '0' && !/^(127|0)\./.test(m[1])) out.add(m[1]);
  }
  return [...out];
}
async function inboundSmbPeers(opts = {}) {
  if (process.platform !== 'win32' && !opts.spawnImpl) return [];
  return parseInboundSmb(await powershell('netstat -n -p TCP | Out-String', { timeoutMs: 15000, ...opts }));
}

const boxDir = share => path.join(share.path, BOX_DIR);
const peerBoxDir = (ip, shareName) => `\\\\${ip}\\${shareName}\\${BOX_DIR}`;

module.exports = { READER_SID, shareAccess, shareScope, BOX_DIR, NEW_SHARE_NAME, powershell, listShares, usable, pickShare, createShare, defaultNewPath, boxDir, peerBoxDir, probeSmb, inboundSmbPeers, parseInboundSmb };
