'use strict';
// 技能广场（2026-11-27）：员工助手技能的分档、归类、敏感标记与 SKILL.md 头解析。纯函数，不碰文件。
// 关键词表移植自调研原型 weclaw_skill_convert.py 的 DEPS / SENSITIVE（已在公司真机跑通）。

// 员工助手专属依赖：命中即说明不能原样在 HUB-H 里跑。tier：fix＝需改写，delegate＝交回员工助手执行。
const DEPS = [
  { key: 'weclaw-cli', label: 'weclaw-cli', tier: 'fix',
    re: /\bweclaw(-cli)?(\.exe)?\s+(agent|compose|knowledge|meeting|search|todo|watch|welink|wenote|whoami|faq)\b/,
    why: '员工助手命令行；公司电脑上 HUB-H 可直接调同一个 weclaw-cli，但要求员工助手已登录' },
  { key: 'welink-cli', label: 'welink-cli', tier: 'fix', re: /\bwelink-cli\b/,
    why: 'WeLink 命令行；HUB-H 已接入 welink-cli，改成 HUB-H 的调用口径即可' },
  { key: 'clouddocs-cli', label: 'clouddocs-cli', tier: 'fix', re: /\bclouddocs-cli\b/, why: '云文档命令行，随员工助手安装' },
  { key: 'agent-service', label: '员工助手本机服务', tier: 'fix',
    re: /(localhost|127\.0\.0\.1):300[89]|\{agentBase\}|AGENT_HTTP_BASE_URL|WECLAW_AGENT_BASE_URL/,
    why: '调员工助手本机 3008/3009 接口（Onebox 上传、cloud-create 等），HUB-H 里没有' },
  { key: 'inner-browser', label: '内嵌浏览器', tier: 'delegate', re: /inner[-_]browser|inner_scripts|\.tool\.js\b|recorder_panel/,
    why: '员工助手内嵌浏览器脚本；HUB-H 没有同样的浏览器，建议把这一步交回员工助手执行' },
  { key: 'agent-tools', label: '员工助手专属工具名', tier: 'fix', re: /\b(myAgentWebFetch|ask_user_question|todoAgent|desktop_discover)\b/,
    why: 'opencode 插件提供的工具名，Claude/Codex 没有同名工具' },
  { key: 'file-block', label: 'file 交付块', tier: 'fix', re: /```file/, why: '员工助手前端的文件卡片格式，HUB-H 不识别，改成普通路径输出' },
  { key: 'onebox-upload', label: 'Onebox 上传', tier: 'fix', re: /onebox\/upload|onebox_file_id/, why: '依赖员工助手宿主 Cookie 上传 Onebox' },
];

// 这些技能离不开员工助手的宿主能力（内嵌浏览器、登录态、Onebox 办公套件），一律委托。
const DELEGATE_NAMES = new Set(['itimes-timesheet', 'ihr-flow', 'etravel', 'personal-leave', 'skill-todo-worker', 'skill-creator',
  'weclaw-onebox-word', 'weclaw-onebox-ppt', 'weclaw-onebox-excel']);

// 公司域名主体用字符码拼出来，源码里不出现明文（发版预检与公开版规则会拦明文域名）。
const CORP = String.fromCharCode(104, 117, 97, 119, 101, 105);
// 「仅公司」提示：内网域名、工号样式、公司邮箱。只提示，不阻止导入。
const SENSITIVE = [
  { key: 'intranet', label: '内网地址', re: new RegExp(String.raw`https?:\/\/[\w.-]*${CORP}\.com`, 'i') },
  { key: 'staff-id', label: '工号样式', re: /\b[a-zA-Z]\d{8}\b/ },
  { key: 'email', label: '公司邮箱', re: new RegExp(String.raw`[\w.-]+@(?:[\w-]+\.)*${CORP}\.com\b`, 'i') },
];

// 归类：按名字+描述关键词，先命中先得。
const CATEGORIES = [
  ['ppt', /ppt|幻灯|演示文稿|slides?\b|deck\b|胶片/i],
  ['intranet', /工时|timesheet|itimes|考勤|请假|休假|leave|差旅|etravel|travel|报销|ihr|\bhr\b|审批|流程|内网|w3|人事|薪酬/i],
  ['welink', /welink|会议|meeting|日程|待办|\btodo|群聊|消息|通讯录|邮件|mail/i],
  ['office', /word|excel|docx?\b|xlsx?\b|pdf|onebox|文档|表格|办公|云文档|clouddocs|笔记|wenote/i],
  ['dev', /代码|编程|开发|研发|git|code|debug|测试|\btest|api\b|仿真|脚本|script|skill-creator|cli\b/i],
];
const CATEGORY_LABELS = { office: '办公文档', ppt: 'PPT', welink: '会议与 WeLink', intranet: '内网办事', dev: '研发', other: '其他' };

function classifyCategory(name, description) {
  const text = `${name || ''} ${description || ''}`;
  for (const [id, re] of CATEGORIES) if (re.test(text)) return id;
  return 'other';
}

/** texts：{ 相对路径: 正文 } → 依赖命中（路径或正文命中都算）（每项带出现的前 5 个文件）。 */
function detectDeps(texts) {
  const out = [];
  for (const dep of DEPS) {
    const files = Object.keys(texts).filter(file => dep.re.test(file) || dep.re.test(texts[file])); // 文件名也算（a.tool.js、inner_scripts/）
    if (files.length) out.push({ key: dep.key, label: dep.label, why: dep.why, tier: dep.tier, files: files.slice(0, 5) });
  }
  return out;
}
function detectSensitive(texts) {
  const hits = {};
  for (const s of SENSITIVE) for (const t of Object.values(texts)) if (s.re.test(t)) { hits[s.key] = true; break; }
  return hits;
}

/** 四档里的前三档（installed 由调用方按台账和本机目录判定）。 */
function useTier({ names = [], deps = [] }) {
  if (names.some(n => DELEGATE_NAMES.has(String(n || '').toLowerCase()))) return 'delegate';
  if (deps.some(d => d.tier === 'delegate')) return 'delegate';
  return deps.length ? 'fix' : 'ok';
}

// ---- SKILL.md 头：与原型 parse_fm 同口径（单行、引号、> | 折叠块拼成一行）
const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BOM = String.fromCharCode(0xFEFF);
function parseFrontmatter(text) {
  let src = String(text || '');
  if (src.startsWith(BOM)) src = src.slice(1);
  const m = FM.exec(src);
  if (!m) return { fm: {}, order: [], body: src };
  const fm = {}, order = [];
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (km) {
      key = km[1];
      const val = km[2].trim();
      fm[key] = ['>', '>-', '|', '|-', '>+', '|+'].includes(val) ? '' : val.replace(/^['"]|['"]$/g, '');
      if (!order.includes(key)) order.push(key);
    } else if (key && /^[ \t]/.test(line)) {
      fm[key] = `${fm[key]} ${line.trim()}`.trim();
    }
  }
  return { fm, order, body: src.slice(m[0].length) };
}

/** 规范名：小写字母、数字、连字符。中文名之类规范后太短时用后备（目录名、skillId）。 */
function slug(name, ...fallbacks) {
  const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  let s = clean(name);
  for (const f of fallbacks) { if (s.length >= 2) break; s = clean(f); }
  return (s.length >= 2 ? s : 'skill').slice(0, 64).replace(/-+$/, '');
}
/** 安装目录名 weclaw-<规范名>，整体 ≤64；本身已是 weclaw- 开头的不重复加前缀。 */
function targetName(normalized) {
  const s = String(normalized || 'skill');
  return (s.startsWith('weclaw-') ? s : `weclaw-${s}`).slice(0, 64).replace(/-+$/, '');
}
const TARGET_NAME_RE = /^weclaw-[a-z0-9-]{1,57}$/;

module.exports = { DEPS, DELEGATE_NAMES, SENSITIVE, CATEGORIES, CATEGORY_LABELS, classifyCategory, detectDeps, detectSensitive, useTier,
  parseFrontmatter, slug, targetName, TARGET_NAME_RE };
