'use strict';
// 一键反馈精简版（2026-11-26）：旧的诊断包把日志尾部原样附上（每份 40~150 行，多是 JSON），整包四十多 KB，
// 还每次往「下载」存一份；维护人真正要看的只有几样。这里只留排查必需的：
//   版本与系统 → 问题描述 → 当时的状态（页面/会话类型、运行快照、最近几次启动是否异常退出、上次更新结果）
//   → 近期关键错误（只取报错行，同类合并计数，每行截短）→ 本机 CLI 识别结论（每个 CLI 一行）。
// 正常运行的流水、窗口状态、查过的每个位置、PATH 全表都不再带。整份纯文本 Markdown，默认不超过 3000 字（WeLink 两条以内）。
// 另把任何「盘符:\Users\某人」开头的路径换成 ~，最后再用 leakCheck 自查一遍，查到就整行去掉。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { redact, recentLogs, sceneLogs, tailLines, isPollLog } = require('./hub-feedback');

const MAX_CHARS = 3000;
const MAX_DESC_CHARS = 1200;
const ERROR_LINE = /\b(?:error|exception|fail(?:ed|ure)?|fatal|timeout|timed out|refused|denied|crash(?:ed)?|ENOENT|EACCES|ECONN\w*|EPIPE)\b|错误|失败|异常|超时|报错|拒绝|崩溃|闪退/i;
// 带了 error 字样但不是故障的常见写法：计数为 0、成功、ok:true。
const NOT_ERROR = /\b(?:errors?|failures?|failed)["']?\s*[:=]\s*(?:0|null|false|\[\]|"")(?!\d)|"ok"\s*:\s*true|\bno errors?\b/i;
const MAX_ERRORS = 10;
const BAD_EVENT = /render-process-gone|child-process-gone|window-unresponsive|uncaught|crash|oom/i;
const LINE_MAX = 160;
const WINDOW_MS = 3 * 24 * 3600 * 1000; // 只看最近 3 天的报错
const READ_LINES = 400;
const READ_BYTES = 256 * 1024;
const DIAG_HEADS = ['## 本机 CLI 识别诊断', '## AI Hub CLI 定位诊断'];

// 任何用户目录（不只本机账号）：C:\Users\xxx、C:/Users/xxx、C:\\Users\\xxx → ~
const USER_DIR = /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+[^\\/\s"'<>|:*?]+/gi;
function scrub(text, opts) {
  return redact(String(text || ''), opts).replace(USER_DIR, '~');
}

// 脱敏自查：返回还残留的敏感片段类别（空数组即通过）。
const LEAK_RULES = [
  ['用户目录路径', /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+(?!<)[^\\/\s"'<>]+/i],
  ['Bearer 令牌', /\bBearer\s+(?!<)[A-Za-z0-9._~+/=-]{8,}/i],
  ['API 密钥', /\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{12,}/],
  ['JWT 令牌', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['口令或令牌字段', /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|cookie|authorization)["']?\s*[:=]\s*["']?(?!<)[^\s"',;<]{6,}/i],
  ['邮箱', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
function leakCheck(text, { home = os.homedir(), user = safeUser() } = {}) {
  const s = String(text || '');
  const hits = LEAK_RULES.filter(([, re]) => re.test(s)).map(([name]) => name);
  if (home && home.length > 3 && [home, home.replace(/\\/g, '/')].some(v => s.toLowerCase().includes(v.toLowerCase()))) hits.push('本机用户目录');
  if (user && user.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${escapeRe(user)}([^A-Za-z0-9]|$)`, 'i').test(s)) hits.push('本机用户名');
  return [...new Set(hits)];
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }

// 一行日志 → { at(ms|null), level, failed, text }：JSON 行只取时间和几个说明字段，其余字段丢掉。
// failed：结构上就是故障（error/err 非空、ok:false 带原因、异常事件），不靠关键词也算报错（审查 #2）。
const TIME_KEYS = ['ts', 'at', 'time', 'timestamp', 'date'];
const MSG_KEYS = ['error', 'err', 'reason', 'message', 'msg', 'event', 'phase', 'code', 'exitCode', 'status'];
const ERROR_KEYS = new Set(['error', 'err', 'message', 'msg', 'reason']);
// Error 对象只取 name、message 和堆栈第一处位置。
function errorText(v) {
  if (v == null || v === '' || v === false || v === 0) return '';
  if (typeof v !== 'object') return String(v);
  const name = typeof v.name === 'string' ? v.name : '';
  const msg = typeof v.message === 'string' ? v.message : (typeof v.msg === 'string' ? v.msg : '');
  const where = typeof v.stack === 'string' ? ((/\bat\s+([^\n]{1,80})/.exec(v.stack) || [])[1] || '') : '';
  return [name && msg ? `${name}: ${msg}` : (name || msg), where ? `@ ${where.trim()}` : ''].filter(Boolean).join(' ');
}
function parseLine(raw) {
  let s = String(raw || '').trim();
  let at = null, level = '', failed = false;
  const iso = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]?\s*/.exec(s);
  if (iso) { at = Date.parse(iso[1].replace(' ', 'T')); s = s.slice(iso[0].length); }
  const brace = s.indexOf('{');
  if (brace >= 0 && brace < 40) {
    try {
      const obj = JSON.parse(s.slice(brace));
      if (obj && typeof obj === 'object') {
        if (typeof obj.level === 'string') level = obj.level;
        for (const k of TIME_KEYS) if (at == null && obj[k]) { const t = typeof obj[k] === 'number' ? obj[k] : Date.parse(obj[k]); if (Number.isFinite(t)) at = t; }
        if (errorText(obj.error) || errorText(obj.err) || /^(?:error|fatal)$/i.test(level) || BAD_EVENT.test(String(obj.event || ''))) failed = true;
        const bits = [];
        for (const k of MSG_KEYS) {
          const v = k === 'error' || k === 'err' ? errorText(obj[k]) : obj[k];
          if (v == null || v === '' || typeof v === 'object') continue;
          bits.push(ERROR_KEYS.has(k) ? String(v) : `${k}=${v}`);
        }
        if (obj.ok === false && bits.length) failed = true;
        const prefix = s.slice(0, brace).trim();
        s = [prefix, ...bits].filter(Boolean).join(' · ') || s;
      }
    } catch { /* 不是整行 JSON，按原文 */ }
  }
  return { at: Number.isFinite(at) ? at : null, level, failed, text: s.replace(/\s+/g, ' ').trim() };
}
// 同类报错合并：数字、十六进制串、引号里的值都当成同一种。
function errorKey(text) {
  return String(text).toLowerCase().replace(/0x[0-9a-f]+|[0-9a-f]{8,}|\d+/g, '#').replace(/"[^"]{0,80}"|'[^']{0,80}'/g, '"…"').slice(0, 120);
}
function shortTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function logLabel(name) { return String(name || '').replace(/^diagnostics\//, '').replace(/\.(?:log|jsonl|txt|json)$/i, '').replace(/-\d{3,}$/, ''); }

// 从相关日志里挑报错：点名的日志 → 场景相关 → 其余最近改过的；轮询类日志不看。返回去重后的 [{ at, label, text, count }]，新的在前。
function keyErrors({ logsDir, dataDir, scenes = [], mention = '', now = Date.now(), fsModule = fs, redactOpts } = {}) {
  const said = String(mention || '');
  const recent = logsDir ? recentLogs(logsDir, fsModule, { mention, scenes }) : [];
  const named = recent.filter(l => !!said && said.includes(path.basename(l.file)));
  const lifecycle = [];
  try {
    const dir = path.join(dataDir || '', 'diagnostics');
    for (const n of fsModule.readdirSync(dir)) if (/^process-lifecycle-.*\.jsonl$/i.test(n)) {
      const file = path.join(dir, n); const st = fsModule.statSync(file);
      if (st.size > 0) lifecycle.push({ file, name: 'diagnostics/' + n, mtimeMs: st.mtimeMs });
    }
  } catch { /* 没有生命周期记录 */ }
  lifecycle.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set();
  const once = l => { const k = path.resolve(l.file).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; };
  // 来源优先级：点名的日志 0 → 场景相关 1 → 其余 2；选取和裁剪都先按优先级、再按时间（审查 #4）。
  const sceneList = sceneLogs({ logsDir, dataDir, scenes, fsModule });
  const ordered = [...named.map(l => ({ ...l, prio: 0 })), ...sceneList.map(l => ({ ...l, prio: 1 })), ...recent.map(l => ({ ...l, prio: 2 })),
    ...lifecycle.slice(0, 3).map(l => ({ ...l, prio: 2 }))].filter(once).filter(l => !isPollLog(l.name));
  const byKey = new Map();
  for (const log of ordered) {
    let rows = [];
    try { rows = tailLines(log.file, READ_LINES, READ_BYTES, fsModule); } catch { continue; }
    for (const raw of rows) {
      if (raw.indexOf('{') < 0 && !ERROR_LINE.test(raw)) continue;
      const { at, text, failed } = parseLine(raw);
      // JSON 行只看说明字段（命令原文、窗口状态等其余字段不算），或结构上就是故障。
      if (!failed && (!ERROR_LINE.test(text) || NOT_ERROR.test(text))) continue;
      if (at && now - at > WINDOW_MS) continue;
      if (!text) continue;
      const clean = scrub(text, redactOpts);
      const key = logLabel(log.name) + '|' + errorKey(clean);
      const hit = byKey.get(key);
      if (hit) { hit.count += 1; if ((at || 0) > (hit.at || 0)) { hit.at = at; hit.text = clean; } }
      else byKey.set(key, { at, label: logLabel(log.name), text: clean, count: 1, prio: log.prio });
    }
  }
  return [...byKey.values()].sort((x, y) => (x.prio - y.prio) || ((y.at || 0) - (x.at || 0))).slice(0, MAX_ERRORS);
}

// 最近几次启动：多少次、有没有异常退出（只读 diagnostics/process-lifecycle-*.jsonl 的事件名和退出码）。
function lifecycleSummary({ dataDir, fsModule = fs, files = 5 } = {}) {
  let list = [];
  try {
    const dir = path.join(dataDir || '', 'diagnostics');
    list = fsModule.readdirSync(dir).filter(n => /^process-lifecycle-.*\.jsonl$/i.test(n))
      .map(n => { const file = path.join(dir, n); try { return { file, mtimeMs: fsModule.statSync(file).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, files);
  } catch { return ''; }
  if (!list.length) return '';
  let clean = 0, abnormal = 0, running = 0; let lastBad = null;
  list.forEach(({ file, mtimeMs }, index) => {
    let rows = [];
    try { rows = tailLines(file, 80, 48 * 1024, fsModule); } catch { return; }
    const events = rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    const exit = events.find(e => e.event === 'process-exit' || e.event === 'app-quit');
    let bad = events.filter(e => BAD_EVENT.test(String(e.event || ''))).pop();
    if (!bad && exit && (exit.cleanExit === false || (exit.code != null && Number(exit.code) !== 0))) bad = exit;
    if (!bad && !exit && index > 0) bad = { event: '未见正常退出记录，可能被强制结束或断电', ts: new Date(mtimeMs).toISOString() };
    if (bad) {
      abnormal += 1;
      if (!lastBad) lastBad = { at: Date.parse(bad.ts || '') || mtimeMs, what: [bad.event, bad.reason, bad.type, bad.code != null ? `code=${bad.code}` : '', bad.exitCode != null ? `exitCode=${bad.exitCode}` : ''].filter(Boolean).join(' ') };
    } else if (exit) clean += 1; else running += 1;
  });
  const parts = [`最近 ${list.length} 次启动：正常退出 ${clean} 次`, abnormal ? `异常 ${abnormal} 次` : '无异常退出'];
  if (running) parts.push('含本次运行');
  let line = parts.join('，');
  if (lastBad) line += `；最近一次异常 ${shortTime(lastBad.at)}（${String(lastBad.what).slice(0, 80)}）`;
  return line;
}

// 上次一键更新的结果：只读，依次看 last-result.json 和启动后已改名的 .seen（不消费结果）；去掉 PowerShell 写入的 BOM（审查 #3）。
function updateSummary({ dataDir, fsModule = fs } = {}) {
  for (const name of ['last-result.json', 'last-result.json.seen']) {
    let raw;
    try { raw = JSON.parse(String(fsModule.readFileSync(path.join(dataDir || '', 'app-update', name), 'utf8')).replace(/^﻿/, '')); } catch { continue; }
    if (!raw || typeof raw !== 'object') continue;
    const ok = raw.ok === true || /^(?:ok|success|done|installed)$/i.test(String(raw.status || raw.result || ''));
    const ver = raw.version || raw.toVersion || raw.to || raw.target || '';
    const why = errorText(raw.error || raw.reason || raw.message || '');
    const at = raw.at || raw.finishedAt || raw.ts || '';
    const rolled = raw.rolledBack || raw.rollback ? '，已回滚' : '';
    return `${ok ? '成功' : '未成功'}${ver ? ' v' + ver : ''}${at ? '（' + shortTime(Date.parse(at)) + '）' : ''}${rolled}${!ok && why ? '：' + why.slice(0, 100) : ''}`;
  }
  return '';
}

// CLI 识别诊断：每个 CLI 只留结论那一行（「■ 名称：能用 · 原因」）和「用的是」一行，PATH 全表、查过的位置都不带。
function cliSummary(diag) {
  const out = [];
  for (const line of String(diag || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('■')) {
      if (/：还没查过$/.test(t)) continue;
      // 「没找到 · 这台电脑上没找到 X：查了 7 处（PATH、注册表…）」→「没找到 · 查了 7 处」：去掉重复的名字和长括号。
      out.push('- ' + t.slice(1).trim().replace(/（[^）]{24,}）/g, '').replace(/ · 这台电脑上没找到 [^：]+：/, ' · ').slice(0, 140));
    }
    else if (/^用的是：/.test(t) && out.length) out[out.length - 1] += '｜' + t.replace(/^用的是：/, '').replace(/（.*$/, '').slice(0, 90);
    else if (/端口|port/i.test(t) && /占用|冲突|in use/i.test(t)) out.push('- ' + t.slice(0, 140));
  }
  return out.slice(0, 8);
}
function splitDescription(description) {
  const d = String(description || '');
  let at = -1;
  for (const h of DIAG_HEADS) { const i = d.indexOf(h); if (i >= 0 && (at < 0 || i < at)) at = i; }
  return at < 0 ? { user: d.trim(), diag: '' } : { user: d.slice(0, at).trim(), diag: d.slice(at) };
}

const VIEW_NAMES = { dsh: 'DSH 会话', codex: 'Codex 会话', codeagent: 'CodeAgent 会话', claude: 'Claude 会话', meeting: '群聊会话' };

// info：{ productName, edition, version, electron, platform, runtime, mcpDiagnostics }；ctx：{ kind, view }。
// 返回 { text, chars, items, leaks }；leaks 为自查后仍残留的类别（正常为空，残留行已整行去掉）。
function slimFeedback({ info = {}, description = '', contact = '', logsDir, dataDir = logsDir ? path.dirname(logsDir) : '', scenes = [], ctx = {}, wantGroup = false,
  now = Date.now(), maxChars = MAX_CHARS, fsModule = fs, redactOpts } = {}) {
  const { user, diag } = splitDescription(description);
  let desc = user || '（未填写）';
  if (desc.length > MAX_DESC_CHARS) desc = desc.slice(0, MAX_DESC_CHARS) + '…（后面较长，已截断）';
  const items = [];
  const env = [
    `- 版本：${`${info.productName || 'AI Hub'} v${info.version || '?'}${info.edition ? '（' + info.edition + '）' : ''}`}`,
    `- 系统：${info.platform || `${process.platform} ${os.release()}`}${info.electron ? ` · Electron ${info.electron}` : ''}`,
    contact ? `- 联系方式：${contact}` : '',
    wantGroup ? '- 希望进群交流：是（已引导加入 AI HUB-H 用户群）' : '',
  ].filter(Boolean);
  items.push({ name: '版本与系统', detail: `${info.productName || 'AI Hub'} v${info.version || '?'}` });
  const where = [ctx.view ? `页面「${ctx.view}」` : '', ctx.kind ? (VIEW_NAMES[String(ctx.kind).replace(/-resume$/, '')] || `${ctx.kind} 会话`) : ''].filter(Boolean).join('，');
  const life = lifecycleSummary({ dataDir, fsModule });
  const upd = updateSummary({ dataDir, fsModule });
  const state = [
    where ? `- 出问题时在：${where}` : '',
    info.runtime ? `- 运行快照：${String(info.runtime).slice(0, 400)}` : '',
    info.mcpDiagnostics ? `- MCP：${String(info.mcpDiagnostics).replace(/\s+/g, ' ').slice(0, 200)}` : '',
    life ? `- ${life}` : '',
    upd ? `- 上次一键更新：${upd}` : '',
  ].filter(Boolean);
  if (info.mcpDiagnostics) items.push({ name: '本会话 MCP 诊断', detail: String(info.mcpDiagnostics) });
  if (state.length) items.push({ name: '当时的状态', detail: '页面/会话类型、运行快照、最近启动与更新结果' });
  const errors = keyErrors({ logsDir, dataDir, scenes, mention: description, now, fsModule, redactOpts });
  const errLines = errors.map(e => `- ${[shortTime(e.at), e.count > 1 ? `×${e.count}` : '', `[${e.label}]`].filter(Boolean).join(' ')} ${e.text.slice(0, LINE_MAX)}${e.text.length > LINE_MAX ? '…' : ''}`);
  items.push({ name: '近期关键错误', detail: errLines.length ? `最近 3 天 ${errLines.length} 类（同类合并计数，每条截短）` : '最近 3 天没有报错' });
  const cli = cliSummary(diag);
  if (cli.length) items.push({ name: '本机 CLI 识别结论', detail: `${cli.length} 个 CLI，每个一行` });

  const section = (title, rows) => rows.length ? [`## ${title}`, ...rows, ''] : [];
  const build = (errs, cliRows) => [
    `# ${info.productName || 'AI Hub'} 一键反馈 · ${shortTime(now)}`, '',
    ...section('环境', env),
    '## 问题描述', desc, '',
    ...section('当时的状态', state),
    ...section(`近期关键错误（${errs.length ? `${errs.length} 类，和这次问题相关的在前` : '最近 3 天没筛到'}）`, errs.length ? errs : ['- 无']),
    ...section('本机 CLI 识别', cliRows),
  ].join('\n').trim() + '\n';
  // 超长时先少带报错行，再去掉 CLI 结论；描述始终保留。
  let errs = errLines.slice(), cliRows = cli.slice();
  let text = scrub(build(errs, cliRows), redactOpts);
  while (text.length > maxChars && errs.length > 3) { errs.pop(); text = scrub(build(errs, cliRows), redactOpts); }
  while (text.length > maxChars && cliRows.length) { cliRows.pop(); text = scrub(build(errs, cliRows), redactOpts); }
  // 自查：残留敏感片段的行整行去掉。
  const leaks = leakCheck(text, redactOpts || {});
  if (leaks.length) text = text.split('\n').filter(l => !leakCheck(l, redactOpts || {}).length).join('\n');
  return { text, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), items, leaks, summary: safeSummary(user, redactOpts) };
}

// 外发请求里单独带的一行摘要也走同一套脱敏和自查，查到残留就不带（审查 #1）。
function safeSummary(user, opts) {
  const line = scrub(String(user || '').split(/\r?\n/)[0], opts).slice(0, 120);
  return leakCheck(line, opts || {}).length ? '' : line;
}

module.exports = { slimFeedback, keyErrors, lifecycleSummary, updateSummary, cliSummary, splitDescription, parseLine, errorKey, leakCheck, scrub, MAX_CHARS };
