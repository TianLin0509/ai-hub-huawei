'use strict';
// 一键反馈的诊断包（2026-10-29 用户要求尽快增强反馈渠道）：问题描述 + 版本与环境 + 最近的日志尾部，
// 全部脱敏后拼成一份纯文字，提交到自家阿里云（core/own-hosts.js feedbackEndpoint）。
// 只读 Hub 数据目录下 logs/ 里最近改过的日志；不读会话正文、不读配置文件和凭据文件。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_LOG_FILES = 8;
const LINES_PER_LOG = 150;
const MAX_LOG_BYTES = 512 * 1024;      // 每份只读尾部这么多
const MAX_TOTAL_CHARS = 900 * 1024;    // 整包上限（服务端收 1.8 MB 字节）
const LOG_NAME = /\.(?:log|jsonl|txt)$/i;

const SECRET_RULES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐去>'],
  [/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '<密钥已隐去>'],
  [/\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|pwd|cookie|authorization|口令|密码)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1$2<已隐去>'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<邮箱>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '<令牌已隐去>'],
];

function redact(text, { home = os.homedir(), user = safeUser() } = {}) {
  let out = String(text || '');
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  // 用户目录与用户名（工号）：用户目录开头的路径一律换成 ~
  if (home) {
    const variants = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')];
    for (const v of variants) if (v && v.length > 3) out = out.split(v).join('~');
  }
  if (user && user.length >= 3) out = out.replace(new RegExp(escapeRe(user), 'gi'), '<用户>');
  return out;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }

function tailLines(file, lines = LINES_PER_LOG, maxBytes = MAX_LOG_BYTES, fsModule = fs) {
  const st = fsModule.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fsModule.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fsModule.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 丢掉被截断的半行
    const rows = text.split(/\r?\n/);
    if (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows.slice(-lines);
  } finally { fsModule.closeSync(fd); }
}

// 最近改过的日志（按修改时间倒序），只看 logs/ 这一层和下一层。
function recentLogs(logsDir, fsModule = fs) {
  const out = [];
  const visit = (dir, depth) => {
    let names = [];
    try { names = fsModule.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 1) visit(p, depth + 1); continue; }
      if (!LOG_NAME.test(e.name)) continue;
      try { const st = fsModule.statSync(p); if (st.size > 0) out.push({ file: p, name: path.relative(logsDir, p).split(path.sep).join('/'), mtimeMs: st.mtimeMs, size: st.size }); } catch {}
    }
  };
  visit(logsDir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_LOG_FILES);
}

// info：{ productName, edition, version, electron, platform, dataDir }；返回 { text, items, meta }。
function collectBundle({ info = {}, description = '', contact = '', logsDir, fsModule = fs, now = Date.now(), redactOpts } = {}) {
  const items = [];
  const head = [
    `# AI HUB 反馈`,
    `时间：${new Date(now).toISOString()}`,
    `版本：${info.productName || 'AI Hub'} ${info.edition || ''} v${info.version || '?'}`.replace(/\s+/g, ' '),
    `Electron：${info.electron || process.versions.electron || '?'} · 系统：${info.platform || `${process.platform} ${os.release()}`}`,
    info.runtime ? `运行快照：${info.runtime}` : '',
    contact ? `联系方式：${contact}` : '',
    '',
    '## 问题描述',
    String(description || '').trim() || '（未填写）',
    '',
  ].filter(x => x !== '');
  items.push({ name: '版本与系统信息', detail: head[2] });
  if (info.runtime) items.push({ name: '运行快照', detail: info.runtime });
  const parts = [head.join('\n')];
  let total = parts[0].length;
  for (const log of logsDir ? recentLogs(logsDir, fsModule) : []) {
    let rows;
    try { rows = tailLines(log.file, LINES_PER_LOG, MAX_LOG_BYTES, fsModule); } catch { continue; }
    const body = rows.join('\n');
    const block = `\n## 日志 ${log.name}（最后 ${rows.length} 行，改于 ${new Date(log.mtimeMs).toISOString()}）\n${body}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    parts.push(block); total += block.length;
    items.push({ name: '日志 ' + log.name, detail: `最后 ${rows.length} 行` });
  }
  const text = redact(parts.join(''), redactOpts);
  return { text, items, chars: text.length, summary: String(description || '').trim().split(/\r?\n/)[0].slice(0, 120) };
}

module.exports = { collectBundle, redact, recentLogs, tailLines, MAX_TOTAL_CHARS };
