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
// 整包上限按 UTF-8 字节算：公司代理单次 POST 超过约 100 KB 就 403（80 KB 能过）；2026-11-23 起单条上传小于 50 KB，整包压到 44 KB。
const MAX_TOTAL_BYTES = 44 * 1024;
const MAX_TOTAL_CHARS = MAX_TOTAL_BYTES;
const MAX_DESC_BYTES = 24 * 1024;      // 用户描述最多占这么多，其余留给环境信息和日志
const LIFECYCLE_FILES = 3;
const LIFECYCLE_LINES = 40;
const LIFECYCLE_BYTES = 6 * 1024;
const LOG_NAME = /\.(?:log|jsonl|txt)$/i;
// 描述里点名的日志（如门户页反馈点名 company-w3.log）：排在最前，但只取最近这么多，不挤掉其余证据。
const NAMED_LOG_LINES = 40;
const NAMED_LOG_BYTES = 12 * 1024;
// 出问题时用户在哪（当前会话的类型、正在看的页面、描述里提到的功能）→ 优先带哪些日志。
// 2026-11-24 WeLink 4 份一键反馈的日志摘录全被助理消息轮询日志占满，DSH、门户、桌宠日志一行没有，描述里也没点名日志。
// 按日志文件名匹配，logs/ 和 diagnostics/ 两处都找。
const SCENE_LOGS = {
  dsh: /acp|dsh|company-model-proxy|company-proxy/i,
  codex: /codex/i,
  codeagent: /codeagent/i,
  w3: /company-w3/i,
  pet: /pet/i,
};
const SCENE_LOG_FILES = 4;
// 轮询类日志隔一会儿就写一行，量大、对排查帮助小：每份最多带 2 行。
const POLL_LOG = /message-round|message-refresh|company-assistant-welink|heartbeat/i;
const POLL_LOG_LINES = 2;

function sceneOfKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (base === 'dsh' || base === 'deepseek-acp') return 'dsh';
  if (base === 'codex' || base === 'deepseek') return 'codex';
  return base === 'codeagent' ? 'codeagent' : '';
}
// 返回相关场景列表，先看页面，再看描述里提到的功能，最后看当前会话类型。
function feedbackScenes({ kind = '', view = '', description = '' } = {}) {
  const out = [];
  const add = s => { if (s && !out.includes(s)) out.push(s); };
  const v = String(view || ''), d = String(description || '');
  if (/门户|company-w3/i.test(v)) add('w3');
  if (/桌宠|hub-pet/i.test(v)) add('pet');
  if (/门户|company-w3/i.test(d)) add('w3');
  if (/桌宠/.test(d)) add('pet');
  if (/\bDSH\b/i.test(d)) add('dsh');
  if (/\bcodex\b/i.test(d)) add('codex');
  add(sceneOfKind(kind));
  return out;
}
// 日志名命中第几个场景（scenes 已按「页面 > 描述 > 会话」排好），没命中返回 -1。
function sceneRank(scenes) {
  const res = (Array.isArray(scenes) ? scenes : []).map(s => SCENE_LOGS[s]).filter(Boolean);
  return name => res.findIndex(re => re.test(String(name || '')));
}
function sceneTest(scenes) { const rank = sceneRank(scenes); return name => rank(name) >= 0; }
// diagnostics/ 只取这两份（写入方已核对：不记对话正文和密钥），其余诊断文件不外发。
const DIAG_SCENE_FILES = ['company-model-proxy.log', 'codex-runtime-broker.log'];
// CodeAgent 切模型时存的终端整屏画面（codeagent-model-picker-*.txt）：上半屏可能是用户对话正文，脱敏处理不了，一律不带。
const PRIVATE_LOG = /^codeagent-model-picker/i;
// 界面打开反馈时的上下文：开着页面时只报页面，不带后台会话的类型（那个会话和这次问题无关）。
function feedbackContext({ view = '', kind = '' } = {}) { const v = String(view || ''); return { view: v, kind: v ? '' : String(kind || '') }; }
const isPollLog = name => POLL_LOG.test(String(name || ''));

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
// mention：问题描述原文。描述里点名的日志（如门户页预填「日志附在下面的 company-w3.log 里」）排在最前、一定带上；
// 否则一天只写几行的功能日志会被刷得勤的日志挤出前 8 份或整包上限（2026-11-24 门户反馈说附了日志却一行都没有）。
// scenes：feedbackScenes() 的结果，相关的日志紧随点名日志排在前面。
function listLogs(dir, prefix, fsModule, maxDepth) {
  const out = [];
  const visit = (d, depth) => {
    let names = [];
    try { names = fsModule.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) visit(p, depth + 1); continue; }
      if (!LOG_NAME.test(e.name) || PRIVATE_LOG.test(e.name)) continue;
      try { const st = fsModule.statSync(p); if (st.size > 0) out.push({ file: p, name: prefix + path.relative(dir, p).split(path.sep).join('/'), mtimeMs: st.mtimeMs, size: st.size }); } catch {}
    }
  };
  visit(dir, 0);
  return out;
}
function recentLogs(logsDir, fsModule = fs, { mention = '', scenes = [] } = {}) {
  const said = String(mention || '');
  const named = l => !!said && said.includes(path.basename(l.file));
  const related = sceneTest(scenes);
  const rank = l => named(l) ? 2 : related(l.name) ? 1 : 0;
  return listLogs(logsDir, '', fsModule, 1).sort((a, b) => (rank(b) - rank(a)) || (b.mtimeMs - a.mtimeMs)).slice(0, MAX_LOG_FILES);
}
// 和本次场景相关的日志：logs/ 里的，加上 diagnostics/ 白名单里的（DSH 的 company-model-proxy.log、Codex 的 codex-runtime-broker.log）。
// 先按场景优先级（页面 > 描述 > 会话），同一场景里新的优先。
function sceneLogs({ logsDir, dataDir, scenes = [], fsModule = fs } = {}) {
  if (!scenes.length) return [];
  const rank = sceneRank(scenes);
  const diag = dataDir ? listLogs(path.join(dataDir, 'diagnostics'), 'diagnostics/', fsModule, 0).filter(l => DIAG_SCENE_FILES.includes(path.basename(l.file))) : [];
  const rows = [...(logsDir ? listLogs(logsDir, '', fsModule, 1) : []), ...diag].map(l => ({ ...l, rank: rank(l.name) })).filter(l => l.rank >= 0);
  return rows.sort((a, b) => (a.rank - b.rank) || (b.mtimeMs - a.mtimeMs)).slice(0, SCENE_LOG_FILES);
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
function collectBundle({ info = {}, description = '', contact = '', logsDir, dataDir, fsModule = fs, now = Date.now(), redactOpts, scenes = [] } = {}) {
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
    info.mcpDiagnostics ? `MCP 诊断：${info.mcpDiagnostics}` : '',
    contact ? `联系方式：${contact}` : '',
    '',
    '## 问题描述',
    desc,
    '',
  ].filter(x => x !== '');
  items.push({ name: '版本与系统信息', detail: head[2] });
  if (info.runtime) items.push({ name: '运行快照', detail: info.runtime });
  if (info.mcpDiagnostics) items.push({ name: '本会话 MCP 诊断', detail: info.mcpDiagnostics });
  const headText = redact(head.join('\n'), redactOpts);
  const parts = [headText];
  const reserve = 512; // 给末尾「已裁剪」说明留的位置
  let total = byteLen(headText) + reserve;
  let trimmedLines = 0, trimmedFiles = 0;
  // 描述里点名的日志和本次场景相关的日志放在补充证据之前，先占预算（每份最多 NAMED_LOG_LINES 行 / NAMED_LOG_BYTES），其余照旧按新旧分配；
  // 轮询类日志每份最多 POLL_LOG_LINES 行。同一份文件只带一次。
  const logs = logsDir ? recentLogs(logsDir, fsModule, { mention: description, scenes }) : [];
  const said = String(description || '');
  const isNamed = l => !!said && said.includes(path.basename(l.file));
  // 公司模型诊断保留原来的 32 KB 窗口和标题：里面有 8~12 KB 的单行探测记录，窗口小了会被当半行丢掉。
  const lead = l => l.name === 'diagnostics/company-model-proxy.log' ? { ...l, kind: 'company-proxy', lines: 40, bytes: 32 * 1024 }
    : { ...l, kind: 'log', lines: isPollLog(l.name) ? POLL_LOG_LINES : NAMED_LOG_LINES, bytes: NAMED_LOG_BYTES };
  const seen = new Set();
  const sources = [
    ...logs.filter(isNamed).map(lead),
    ...sceneLogs({ logsDir, dataDir, scenes, fsModule }).map(lead),
    ...extraSources(dataDir, fsModule),
    ...logs.filter(l => !isNamed(l)).map(l => ({ ...l, kind: 'log', lines: isPollLog(l.name) ? POLL_LOG_LINES : LINES_PER_LOG, bytes: MAX_LOG_BYTES })),
  ].filter(l => { const k = path.resolve(l.file).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
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

module.exports = { collectBundle, redact, recentLogs, sceneLogs, feedbackScenes, feedbackContext, isPollLog, tailLines, fitTail, MAX_TOTAL_BYTES, MAX_TOTAL_CHARS, POLL_LOG_LINES };
