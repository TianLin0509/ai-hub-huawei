'use strict';
// CodeAgent /model 菜单里的用量表（2026-10-29，公司 1.2615.02.01 真机样本见 tests/unit-codeagent-model-picker.test.js 的 CODEAGENT_MENU）：
//   Credit用量                                                                         shift + ↓ to detail
//   月度: 2836.51/20000,已用每天(忙时): 22.93/2500,已 每天(平时,闲时): 258.03/2500,   距离闲时2折还有1小时
//   14.18%                  0.91%                     已用10.32%                     56分钟
//         模型名称                          Credit消耗系数  Token用量/配额           ● 负载      模型描述
//   ❯  1. GLM-5.2-WX-Auto default ✓         0x              Day 29.16M/400M (7.29%)  ● 低负载    为主模型，
//                                                           Hour 2.15M/200M (1.07%)
//                                                           Min 89.66K/1M (8.97%)
// 菜单是 TUI 折行画的：三档 Credit 的百分比落在下一行、「距离闲时2折还有X小时」和「Y分钟」被拆成两行，右侧还混着 Stats / SESSION 面板。
// 所以不按列对齐取数：Credit 的百分比用「已用 / 总额」算出来，下一行里有和它相差不到 0.5 的读数时取屏幕原值；
// 闲时倒计时取下一行里离「距离闲时」那一列最近的「N分钟」。模型行认「N. 名称 … Day a/b (p%)」，随后两行找 Hour / Min。
//
// 这里只解析和存快照，不打开菜单、不改选择逻辑：数据来自 Hub 自己选模型时读到的菜单（core/codeagent-model-picker.js），
// 以及用户自己在终端开着菜单时每轮结束读到的最后一屏（renderer/renderer.js applyCodeAgentScreenContext）。
const fs = require('fs');
const path = require('path');

const NUM = '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)';
const CREDIT_FIELDS = [
  { key: 'monthly', re: new RegExp(`月\\s*度\\s*[:：]\\s*${NUM}\\s*/\\s*${NUM}`) },
  { key: 'busyDay', re: new RegExp(`每\\s*天\\s*[(（]\\s*忙\\s*时\\s*[)）]\\s*[:：]\\s*${NUM}\\s*/\\s*${NUM}`) },
  { key: 'idleDay', re: new RegExp(`每\\s*天\\s*[(（][^)）]*闲\\s*时[^)）]*[)）]\\s*[:：]\\s*${NUM}\\s*/\\s*${NUM}`) },
];
const IDLE_RE = /距\s*离\s*闲\s*时\s*(\d+(?:\.\d+)?)\s*折\s*还\s*有\s*((?:\d+\s*(?:天|小时|分钟|分|秒)\s*)*)/;
const DURATION_TOKEN = /\d+\s*(?:天|小时|分钟|分|秒)(?:\s*\d+\s*(?:小时|分钟|分|秒))*/g;
const PCT_TOKEN = /(\d+(?:\.\d+)?)\s*%/g;
// 模型行：可选光标 + 「N.」+ 名称；同一行里要有 Day 用量才算（正文里的编号列表没有这一段）。
const MODEL_ROW = /^\s*(?:[│┃]\s*)?(?:[❯›▶>]\s*)?(\d{1,2})\.\s+(\S.*)$/;
const UNIT = '(\\d+(?:\\.\\d+)?\\s*[KMBGkmbg]?)';
const windowRe = name => new RegExp(`\\b${name}\\s+${UNIT}\\s*/\\s*${UNIT}\\s*\\(\\s*(\\d+(?:\\.\\d+)?)\\s*%\\s*\\)`);
const DAY_RE = windowRe('Day');
const HOUR_RE = windowRe('Hour');
const MIN_RE = windowRe('Min');
const FACTOR_RE = /(?:^|\s)(\d+(?:\.\d+)?\s*[xX×])(?=\s|$)/;
const LOAD_RE = /●\s*([^\s●│┃]+)/;
const MENU_END = /Navigate\s*↑\s*↓|^\s*[─━]{20,}/;

// 屏幕上的显示列（中文等宽字符占两列），只用来把下一行的「N分钟」对回上一行的「距离闲时」。
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
}
function displayCol(text, index) {
  let col = 0;
  for (const ch of String(text).slice(0, index)) col += isWide(ch.codePointAt(0)) ? 2 : 1;
  return col;
}

const toNumber = s => Number(String(s).replace(/,/g, ''));
const round2 = n => Math.round(n * 100) / 100;
const compact = s => String(s).replace(/\s+/g, '');

function creditField(rows, at, field) {
  const m = field.re.exec(rows[at]);
  if (!m) return null;
  const used = toNumber(m[1]), total = toNumber(m[2]);
  if (!Number.isFinite(used) || !(total > 0)) return null;
  const computed = used / total * 100;
  // 屏幕上显示的百分比（同一行或下一行）：和算出来的差不到 0.5 才认，认不到就用算出来的
  let pct = null, best = 0.5;
  for (const line of [rows[at], rows[at + 1] || '']) {
    for (const p of line.matchAll(PCT_TOKEN)) {
      const v = Number(p[1]);
      if (Math.abs(v - computed) <= best) { best = Math.abs(v - computed); pct = v; }
    }
  }
  return { used: m[1], total: m[2], pct: pct ?? round2(computed) };
}

function idleCountdown(rows, at) {
  const line = rows[at];
  const m = IDLE_RE.exec(line);
  if (!m) return { found: false };
  let text = compact(m[2] || '');
  const discount = `${m[1]}折`;
  // 被折到下一行的剩余部分：「1小时」后面没有分钟，或「还有」后面整个是空的
  if (!/分|秒/.test(text)) {
    const next = rows[at + 1] || '';
    const anchor = displayCol(line, m.index);
    let pick = null, dist = Infinity;
    for (const t of next.matchAll(DURATION_TOKEN)) {
      const col = displayCol(next, t.index);
      if (col < anchor - 12) continue; // 左边那几列是 Credit 百分比，不是倒计时
      const d = Math.abs(col - anchor);
      if (d < dist) { dist = d; pick = compact(t[0]); }
    }
    if (pick && !(text && /小时/.test(text) && /小时/.test(pick))) text += pick;
  }
  return { found: true, text: text || null, discount };
}

function windowOf(re, line) {
  const m = re.exec(line);
  return m ? { used: compact(m[1]), total: compact(m[2]), pct: Number(m[3]) } : null;
}

function modelName(rest) {
  return String(rest).split(/\s{2,}/)[0].replace(/\s*[✔✓]\s*$/, '').replace(/\s+default$/i, '').trim();
}

function parseModels(rows) {
  const models = [];
  let current = null;
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i];
    if (MENU_END.test(line) && models.length) break;
    const row = MODEL_ROW.exec(line);
    const day = row ? DAY_RE.exec(line) : null;
    if (row && day) {
      const beforeDay = line.slice(line.length - row[2].length, day.index); // 「名称 default ✓   0x   」
      const name = modelName(beforeDay);
      if (!name) { current = null; continue; }
      const factor = FACTOR_RE.exec(beforeDay.slice(beforeDay.indexOf(name) + name.length));
      const load = LOAD_RE.exec(line.slice(day.index));
      current = { name, factor: factor ? compact(factor[1]).replace('×', 'x') : null,
        day: windowOf(DAY_RE, line), hour: null, min: null, load: load ? load[1] : null };
      models.push(current);
      continue;
    }
    if (row) { current = null; continue; }
    if (!current) continue;
    if (!current.hour) { const h = windowOf(HOUR_RE, line); if (h) { current.hour = h; continue; } }
    if (!current.min) { const mm = windowOf(MIN_RE, line); if (mm) { current.min = mm; current = null; } }
  }
  return models;
}

// 屏幕行 → { credit, models }；两样都认不出返回 null。
function parseCodeAgentUsageMenu(screenLines) {
  const rows = (Array.isArray(screenLines) ? screenLines : String(screenLines || '').split(/\r?\n/)).map(line => String(line || ''));
  let credit = null;
  const start = rows.findIndex(line => /Credit\s*用量/.test(line));
  // 从「Credit用量」标题往下几行找三档；没有标题（画面上半截被裁掉）时全屏找
  const scan = start >= 0 ? [start, Math.min(rows.length, start + 6)] : [0, rows.length];
  const fields = {};
  let idle = { found: false };
  for (let i = scan[0]; i < scan[1]; i += 1) {
    for (const f of CREDIT_FIELDS) if (!fields[f.key]) { const v = creditField(rows, i, f); if (v) fields[f.key] = v; }
    if (!idle.found) idle = idleCountdown(rows, i);
  }
  if (Object.keys(fields).length) {
    credit = { monthly: fields.monthly || null, busyDay: fields.busyDay || null, idleDay: fields.idleDay || null,
      idleDiscountIn: idle.found ? idle.text : null, idleDiscount: idle.found ? idle.discount : null };
  }
  const models = parseModels(rows);
  if (!credit && !models.length) return null;
  return { credit, models };
}

// ---------------------------------------------------------------- 快照：按账号存最近一次读数
// 键与 core/codeagent-quota.js 一致：个人账号 personal，号池账号用号池编号；label 是界面上显示的账号名（额度条按它对行）。
// 主进程（Hub 选模型时）和界面进程（每轮结束读屏）都会写：读的时候按文件修改时间刷新内存副本。
const FILE = 'codeagent-usage.json';
const cache = new Map(); // file → { mtimeMs, data }

function usageFile(dataDir) { return path.join(dataDir, 'codeagent-pool', FILE); }

function readUsage(dataDir, { fsModule = fs } = {}) {
  if (!dataDir) return {};
  const file = usageFile(dataDir);
  let mtimeMs = 0;
  try { mtimeMs = fsModule.statSync(file).mtimeMs; } catch { cache.delete(file); return {}; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let data = {};
  try { const raw = JSON.parse(fsModule.readFileSync(file, 'utf8')); data = raw && typeof raw.accounts === 'object' && raw.accounts ? raw.accounts : {}; } catch { data = {}; }
  cache.set(file, { mtimeMs, data });
  return data;
}

function recordUsage(dataDir, key, usage, { label = '', source = '', now = Date.now(), fsModule = fs } = {}) {
  if (!dataDir || !key || !usage || (!usage.credit && !(usage.models || []).length)) return null;
  const accounts = { ...readUsage(dataDir, { fsModule }) };
  const prev = accounts[key] || {};
  // 只读到一半（例如画面上半截被裁、只有模型行）：没读到的部分沿用上一次
  const entry = { credit: usage.credit || prev.credit || null, models: (usage.models || []).length ? usage.models : (prev.models || []),
    label: label || prev.label || '', source, at: now };
  accounts[key] = entry;
  const file = usageFile(dataDir);
  try {
    fsModule.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsModule.writeFileSync(tmp, JSON.stringify({ version: 1, accounts }, null, 2), 'utf8');
    fsModule.renameSync(tmp, file);
    cache.set(file, { mtimeMs: fsModule.statSync(file).mtimeMs, data: accounts });
  } catch { cache.set(file, { mtimeMs: -1, data: accounts }); /* 写不了只影响重启后的显示，内存里仍有 */ }
  return entry;
}

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function modelUsage(entry, modelId) {
  if (!entry || !Array.isArray(entry.models) || !modelId) return null;
  const want = squash(modelId);
  return entry.models.find(m => squash(m.name) === want) || null;
}

// 模型下拉旁的灰字「今日 7.29% · 低负载 · 0x」和颜色档（≥80% 红、≥50% 橙）；没数据返回 null。
function usageHint(model) {
  if (!model) return null;
  const parts = [];
  const pct = model.day && Number.isFinite(model.day.pct) ? model.day.pct : null;
  if (pct != null) parts.push(`今日 ${pct}%`);
  if (model.load) parts.push(model.load);
  if (model.factor) parts.push(model.factor);
  if (!parts.length) return null;
  return { text: parts.join(' · '), level: pct == null ? '' : pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : '', pct };
}

// 「1小时56分钟」→ 分钟数；认不出返回 null。
function durationMinutes(text) {
  const s = compact(text || '');
  if (!s) return null;
  let total = 0, any = false;
  for (const [, n, u] of s.matchAll(/(\d+)(天|小时|分钟|分|秒)/g)) {
    any = true;
    total += Number(n) * (u === '天' ? 1440 : u === '小时' ? 60 : u === '秒' ? 1 / 60 : 1);
  }
  return any ? total : null;
}

function formatMinutes(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}小时${r ? r + '分钟' : ''}` : `${r}分钟`;
}

function formatAge(ms) {
  const m = Math.round(Math.max(0, ms) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 2880 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}

module.exports = { parseCodeAgentUsageMenu, recordUsage, readUsage, usageFile, modelUsage, usageHint, durationMinutes, formatMinutes, formatAge, displayCol };
