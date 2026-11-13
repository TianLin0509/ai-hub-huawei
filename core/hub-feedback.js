'use strict';
// 一键反馈的诊断包（2026-10-29 用户要求尽快增强反馈渠道）：问题描述 + 版本与环境 + 最近的日志尾部，
// 全部脱敏后拼成一份纯文字，提交到自家阿里云（core/own-hosts.js feedbackEndpoint）。
// 只读 Hub 数据目录下近期日志、固定诊断与更新结果；不读会话正文、不读配置文件和凭据文件。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_LOG_FILES = 8;
const LINES_PER_LOG = 150;
const MAX_LOG_BYTES = 512 * 1024;      // 每份只读尾部这么多
// 整包上限按 UTF-8 字节算：公司代理单次 POST 超过约 100 KB 就 403（80 KB 能过），所以整包压到 80 KB 以内。
const MAX_TOTAL_BYTES = 80 * 1024;
const MAX_TOTAL_CHARS = MAX_TOTAL_BYTES;
const MAX_DESC_BYTES = 24 * 1024;      // 用户描述最多占这么多，其余留给环境信息和日志
const LIFECYCLE_FILES = 3;
const LIFECYCLE_LINES = 40;
const LIFECYCLE_BYTES = 6 * 1024;
const LOG_NAME = /\.(?:log|jsonl|txt)$/i;

const SECRET_RULES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <已隐去>'],
  [/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '<密钥已隐去>'],
  [/\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|xauth[-_]?token|mtoken|token|secret|password|passwd|pwd|cookie|authorization|口令|密码)((?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)[^\s"',;]{4,}/gi, '$1$2<已隐去>'],
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

function byteLen(s) { return Buffer.byteLength(String(s), 'utf8'); }

// 从尾部往前取整行，装进 budget 字节；最新的行优先保留，返回 { rows, dropped }。
function fitTail(rows, budget) {
  const kept = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    let line = rows[i];
    let n = byteLen(line) + 1;
    if (used + n > budget) {
      if (kept.length) break;
      // 最新一行本身就超了：保留它的结尾部分
      line = Buffer.from(line, 'utf8').subarray(Math.max(0, byteLen(line) - Math.max(0, budget - 1))).toString('utf8').replace(/^\uFFFD+/, '');
      n = byteLen(line) + 1;
    }
    kept.push(line); used += n;
  }
  return { rows: kept.reverse(), dropped: rows.length - kept.length };
}

// 数据目录里的补充证据：上次更新结果和最近几份生命周期记录（闪退、异常退出）。
function extraSources(dataDir, fsModule = fs) {
  const out = [];
  if (!dataDir) return out;
  for (const name of ['last-result.json', 'last-result.json.seen']) {
    const file = path.join(dataDir, 'app-update', name);
    try { const st = fsModule.statSync(file); out.push({ file, name: 'app-update/' + name, mtimeMs: st.mtimeMs, size: st.size, kind: 'update', lines: 30, bytes: 4 * 1024 }); } catch {}
  }
  const dir = path.join(dataDir, 'diagnostics');
  const proxy = [];
  const proxyFile = path.join(dir, 'company-model-proxy.log');
  try {
    const st = fsModule.statSync(proxyFile);
    if (st.size > 0) proxy.push({ file: proxyFile, name: 'diagnostics/company-model-proxy.log', mtimeMs: st.mtimeMs, size: st.size,
      kind: 'company-proxy', lines: 40, bytes: 32 * 1024 });
  } catch {}
  let names = [];
  try { names = fsModule.readdirSync(dir); } catch {}
  const life = [];
  for (const name of names) {
    if (!/^process-lifecycle-.*\.jsonl$/i.test(name)) continue;
    const file = path.join(dir, name);
    try { const st = fsModule.statSync(file); if (st.size > 0) life.push({ file, name: 'diagnostics/' + name, mtimeMs: st.mtimeMs, size: st.size, kind: 'lifecycle', lines: LIFECYCLE_LINES, bytes: LIFECYCLE_BYTES }); } catch {}
  }
  life.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 1).concat(proxy, life.slice(0, LIFECYCLE_FILES));
}

// info：{ productName, edition, version, electron, platform, dataDir }；返回 { text, items, meta }。
// 整包不超过 MAX_TOTAL_BYTES：描述与环境信息先占位，其余按「更新结果 → 生命周期记录 → 日志（新的优先）」分配，
// 每份只保留最新的若干行；被裁掉的行数写进预览和正文。
function collectBundle({ info = {}, description = '', contact = '', logsDir, dataDir, fsModule = fs, now = Date.now(), redactOpts } = {}) {
  const items = [];
  let desc = String(description || '').trim() || '（未填写）';
  let descCut = 0;
  if (byteLen(desc) > MAX_DESC_BYTES) {
    const keep = Buffer.from(desc, 'utf8').subarray(0, MAX_DESC_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
    descCut = byteLen(desc) - byteLen(keep); desc = keep;
  }
  const head = [
    `# AI HUB 反馈`,
    `时间：${new Date(now).toISOString()}`,
    `版本：${info.productName || 'AI Hub'} ${info.edition || ''} v${info.version || '?'}`.replace(/\s+/g, ' '),
    `Electron：${info.electron || process.versions.electron || '?'} · 系统：${info.platform || `${process.platform} ${os.release()}`}`,
    info.runtime ? `运行快照：${info.runtime}` : '',
    contact ? `联系方式：${contact}` : '',
    '',
    '## 问题描述',
    desc,
    '',
  ].filter(x => x !== '');
  items.push({ name: '版本与系统信息', detail: head[2] });
  if (info.runtime) items.push({ name: '运行快照', detail: info.runtime });
  const headText = redact(head.join('\n'), redactOpts);
  const parts = [headText];
  const reserve = 512; // 给末尾「已裁剪」说明留的位置
  let total = byteLen(headText) + reserve;
  let trimmedLines = 0, trimmedFiles = 0;
  const sources = [...extraSources(dataDir, fsModule), ...(logsDir ? recentLogs(logsDir, fsModule).map(l => ({ ...l, kind: 'log', lines: LINES_PER_LOG, bytes: MAX_LOG_BYTES })) : [])];
  for (const log of sources) {
    let rows;
    try { rows = tailLines(log.file, log.lines, log.bytes, fsModule); } catch { continue; }
    const title = log.kind === 'log' ? `日志 ${log.name}` : log.kind === 'lifecycle' ? `生命周期记录 ${log.name}`
      : log.kind === 'company-proxy' ? `公司模型诊断 ${log.name}` : `更新结果 ${log.name}`;
    const room = MAX_TOTAL_BYTES - total - 200; // 200：小节标题
    if (room < 1024) { trimmedFiles++; trimmedLines += rows.length; continue; }
    // 先脱敏再量，保证最终字节数不会因脱敏变长而超限
    const fit = fitTail(rows.map(r => redact(r, redactOpts)), room);
    if (!fit.rows.length) { trimmedFiles++; trimmedLines += rows.length; continue; }
    const block = `\n## ${title}（最后 ${fit.rows.length} 行，改于 ${new Date(log.mtimeMs).toISOString()}）\n${fit.rows.join('\n')}\n`;
    parts.push(block); total += byteLen(block);
    trimmedLines += fit.dropped;
    items.push({ name: title, detail: `最后 ${fit.rows.length} 行` + (fit.dropped ? `（较早的 ${fit.dropped} 行因大小上限未附带）` : '') });
  }
  if (trimmedFiles) items.push({ name: '未附带的日志', detail: `${trimmedFiles} 份因大小上限整份未附带` });
  if (descCut) items.push({ name: '问题描述过长', detail: `超出的 ${descCut} 字节已裁掉` });
  if (trimmedLines || trimmedFiles || descCut) {
    const kb = Math.round(MAX_TOTAL_BYTES / 1024);
    parts.push(`\n## 已裁剪\n整包限 ${kb} KB：日志按新的优先，共裁掉较早的 ${trimmedLines} 行` + (trimmedFiles ? `，${trimmedFiles} 份整份未附带` : '') + (descCut ? `，描述末尾 ${descCut} 字节未附带` : '') + '。\n');
    items.push({ name: '已按大小上限裁剪', detail: `整包限 ${kb} KB，共裁掉较早的 ${trimmedLines} 行日志` });
  }
  const text = parts.join('');
  return { text, items, chars: text.length, bytes: byteLen(text), trimmedLines, summary: String(description || '').trim().split(/\r?\n/)[0].slice(0, 120) };
}

module.exports = { collectBundle, redact, recentLogs, tailLines, fitTail, MAX_TOTAL_BYTES, MAX_TOTAL_CHARS };
