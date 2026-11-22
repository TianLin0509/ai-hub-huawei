'use strict';
// 一键反馈改走 WeLink（2026-11-21 维护人定）：内网收件机要过「取地址 → 维护人电脑在线 → 端口 → 网段放行」好几关，
// 同事普遍反馈发不出去；WeLink 人人都开着，消息直接进维护人的 WeLink 聊天，不依赖维护人电脑。
// 两条路：装了 welink-cli 的「一键发送」（im send-to-user，收信账号固定）；没装的「复制并打开 WeLink」，用户自己粘贴发送。
// 聊天消息只放精简版（问题描述 + 版本环境 + 最近报错几行）；完整诊断包照旧存到「下载」，维护人需要时再要。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { redact, recentLogs, tailLines } = require('./hub-feedback');

const MAINTAINER_WELINK = 'l00807938';
// 单条聊天消息的上限没实测过：手机对话按 1500 字保守切（core/company-assistant/phone.js），这里一样；整条精简版最多两段。
const CHUNK = 1500;
const MAX_CHARS = 2 * CHUNK;
const ERROR_LINE = /error|exception|fail|fatal|timeout|refused|denied|错误|失败|异常|超时|报错|拒绝|崩溃|闪退/i;
const ERROR_LINES = 12;
const LINE_MAX = 220;
const NOTE = '\n（完整诊断包已存在反馈人电脑的「下载」文件夹，需要时可以找对方要）';

// 精简版：头部（版本、系统、运行快照、联系方式）+ 问题描述 + 最近日志里的报错行（新的优先，每行截到 220 字），总长 ≤ maxChars。
function compactFeedback({ info = {}, description = '', contact = '', logsDir, now = Date.now(), maxChars = MAX_CHARS, fsModule = fs, redactOpts } = {}) {
  const desc = String(description || '').trim() || '（未填写）';
  const head = ['【AI HUB 一键反馈】',
    `版本：${info.productName || 'AI Hub'} ${info.edition || ''} v${info.version || '?'}`.replace(/\s+/g, ' '),
    `系统：${info.platform || process.platform}`];
  if (info.runtime) head.push(`运行快照：${info.runtime}`);
  if (contact) head.push(`联系方式：${contact}`);
  head.push(`时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`, '', '问题描述：');
  const headText = redact(head.join('\n'), redactOpts);
  const errors = [];
  for (const log of logsDir ? recentLogs(logsDir, fsModule) : []) {
    let rows = [];
    try { rows = tailLines(log.file, 300, 256 * 1024, fsModule); } catch { continue; }
    for (let i = rows.length - 1; i >= 0 && errors.length < ERROR_LINES; i--) {
      if (!ERROR_LINE.test(rows[i])) continue;
      const line = redact(rows[i], redactOpts).replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
      if (line && !errors.some(e => e.line === line)) errors.push({ name: log.name, line });
    }
    if (errors.length >= ERROR_LINES) break;
  }
  const body = redact(desc, redactOpts);
  const room = maxChars - headText.length - 1 - NOTE.length;
  // 先保描述：描述太长就截描述、不带报错行；否则报错行从最旧的一行往外裁。
  if (body.length > room) return headText + '\n' + body.slice(0, Math.max(0, room - 12)) + '…（描述过长已截断）' + NOTE;
  const lines = errors.map(e => `[${e.name}] ${e.line}`);
  const title = '\n\n最近报错（新的在前）：\n';
  while (lines.length && headText.length + 1 + body.length + title.length + lines.join('\n').length > room) lines.pop();
  return headText + '\n' + body + (lines.length ? title + lines.join('\n') : '') + NOTE;
}

// 按行切成 ≤ max 字的几段（与手机对话同一种切法）。
function chunks(text, max = CHUNK) {
  const out = []; let cur = '';
  for (const para of String(text || '').split(/\n/)) {
    let p = para;
    while (p.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(p.slice(0, max)); p = p.slice(max); }
    if ((cur ? cur.length + 1 : 0) + p.length > max) { out.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur) out.push(cur);
  return out.filter(s => s.trim());
}

// 找 WeLink 桌面客户端（2026-11-21 公司真机：注册表 welink: 协议 → "C:\Program Files (x86)\WeLink_Desktop\WeLinkPC.exe" "%1"；
// 老版本装在 WeLinkPC\ 目录）。顺序：协议登记的程序 → 常见安装目录 → 开始菜单 / 公共桌面的快捷方式。
const KNOWN_DIRS = ['WeLink_Desktop', 'WeLinkPC', 'WeLink'];
function regQuery(key, execFileImpl) {
  return new Promise(resolve => {
    try {
      execFileImpl('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
    } catch { resolve(''); }
  });
}
function exeFromCommand(text) {
  const m = /"([^"]+?WeLinkPC\.exe)"/i.exec(String(text || '')) || /([A-Za-z]:\\[^"\r\n]*?WeLinkPC\.exe)/i.exec(String(text || ''));
  return m ? m[1].trim() : '';
}
async function findWelinkDesktop({ env = process.env, fsModule = fs, execFileImpl = execFile } = {}) {
  const exists = p => { try { return !!p && fsModule.existsSync(p); } catch { return false; } };
  for (const key of ['HKCU\\Software\\Classes\\welink\\shell\\open\\command', 'HKCR\\welink\\shell\\open\\command']) {
    const exe = exeFromCommand(await regQuery(key, execFileImpl));
    if (exists(exe)) return { path: exe, via: 'protocol' };
  }
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.APPDATA].filter(Boolean);
  for (const root of roots) for (const dir of KNOWN_DIRS) {
    const exe = path.join(root, dir, 'WeLinkPC.exe');
    if (exists(exe)) return { path: exe, via: 'dir' };
  }
  const menus = [path.join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(env.PUBLIC || 'C:\\Users\\Public', 'Desktop')].filter(Boolean);
  for (const menu of menus) {
    const stack = [[menu, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let entries = [];
      try { entries = fsModule.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 2) stack.push([p, depth + 1]); continue; }
        // WeLink Desktop.lnk / WeLinkPC.lnk；会议（WeLink Meeting）、eShare、卸载、分析器都不是聊天客户端。
        if (/^welink.*\.lnk$/i.test(e.name) && !/meeting|eshare|卸载|uninstall|analyzer/i.test(e.name)) return { path: p, via: 'shortcut' };
      }
    }
  }
  return { path: null, via: null };
}

// welink-cli 发消息前要向本机 WeLink 桌面客户端（127.0.0.1:14114）取签名；客户端没开或掉登录时只报
// 「Response missing required fields (sign/nonce/timestamp)」（2026-11-21 公司真机 Q-1121-01：客户端被同账号另一台设备挤下线，
// auth status 仍显示 token valid）。翻成用户能照做的话。
const CLIENT_DOWN = /sign\/nonce\/timestamp|用户未登录|14114/i;
const SELF_SEND_REASON = '你就是维护人，本机发给自己会被 WeLink 拒绝；反馈已保存在『我的反馈』，可复制内容';
function friendlySendError(reason) {
  if (/not\s+allow\s+to\s+send\s+messages\s+to\s+self/i.test(String(reason || '')))
    return { clientDown: false, selfSend: true, reason: SELF_SEND_REASON };
  return CLIENT_DOWN.test(String(reason || ''))
    ? { clientDown: true, reason: '电脑上的 WeLink 没打开或没登录（welink-cli 要靠它发消息）。请打开并登录 WeLink 后再点一次，或者直接点「复制并打开 WeLink」' }
    : { clientDown: false, reason };
}

// welink-cli 回执是否真发出去了（与手机对话同一套判断）；发出去返回空串，否则返回原因。
function sendReceiptError(result, parseJson) {
  if (!result || result.code !== 0) return String((result && (result.stderr || result.stdout)) || '发送命令失败').trim().slice(0, 200);
  const receipt = parseJson(result.stdout);
  const code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
  if (receipt?.ok === false || receipt?.success === false || (code !== undefined && !['0', '200'].includes(String(code))))
    return String(receipt?.error?.error_msg || receipt?.message || receipt?.resultContext || `发送业务码 ${code}`).slice(0, 200);
  return '';
}

module.exports = { friendlySendError, SELF_SEND_REASON, MAINTAINER_WELINK, CHUNK, MAX_CHARS, compactFeedback, chunks, findWelinkDesktop, exeFromCommand, sendReceiptError };
