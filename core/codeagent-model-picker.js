'use strict';
// 公司 CodeAgent 换模型：在它自己的 /model 菜单里替用户选中（2026-10-14 用户：「就是在 CLI 里输入 /model，
// 然后选择对应的模型」）。
//
// 为什么不用启动参数：公司真机三轮排查（2026-10-13）确认，交互模式下 --model / --settings / 环境变量 /
// 「/model <名字>」都不生效，启动画面写着 MiniMax、回答仍是 GLM；只有 -p 一问一答模式认 --model。
// 所以新建、恢复、会话中换模型都走同一条路：
//   1. 敲 /model 回车（走 sendToPty：等 CLI 就绪、斜杠命令不套 Hub 规则、以「菜单出现」为回执，不补回车）；
//   2. 读渲染后的屏幕，找到光标行和目标行，一次按一下方向键，每次都重新读屏确认光标真的动了；
//   3. 菜单上写着「s to use this session only」就按 s，只改这个会话；没有这个提示就按回车，
//      回车会把它存成以后新会话的默认模型，Hub 事后把配置里的 model 改回原值（只动这一个键）；
//   4. 确认普通输入框恢复且稳定（最好还有「Set model to …」）；下一轮回答再由 codeagent-models 核对实际模型。
// 普通新建默认沿用 CLI 模型；明确选模型时第一条消息等待结果。失败保护正文，不把未知菜单当作已关闭。
const fs = require('node:fs');
const path = require('node:path');
const { withoutAnnouncement } = require('./group-chat-cli-ready-detector');

const CURSOR_GLYPHS = '❯›▶>';
// 行首可能残留没擦干净的旧字符（「erva4. Sonnet」，2026-10-14 替身实录），所以「编号.」不要求在行首；
// 靠下面「编号连续」和「含模型名」两道筛选排除正文。
const NUMBERED_ROW = new RegExp(`(?:^|[^\\d.])([${CURSOR_GLYPHS}])?\\s*(\\d{1,2})\\.\\s+(\\S.*?)\\s*$`);
const BARE_CURSOR_ROW = new RegExp(`^(\\s*)([${CURSOR_GLYPHS}])\\s+(\\S.*?)\\s*$`);
const MODEL_WORDS = /\b(?:GLM|MiniMax|DeepSeek|Qwen|Kimi)(?=[\d\W]|$)|\b(?:Default|Auto|Opus|Sonnet|Haiku|Fable)\b|模型/i;
const SESSION_ONLY_KEY = /(?:^|[\s·|])([a-z])\s+to\s+use\s+(?:this|for this)\s+session\s+only/i;

const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
// 菜单可能显示 ascend/ 等线路前缀；完整名称优先，去前缀后必须唯一。
const bareLabel = value => String(value || '').trim().split('/').pop().toLowerCase();
const aliasRows = (rows, label) => (rows || []).reduce((hits, row, index) =>
  bareLabel(row.label) === bareLabel(label) ? [...hits, index] : hits, []);
// 行里第一段（两个以上空格或「·」之前）是模型名，后面是说明。CodeAgent 在当前默认模型后面标「default ✓」。
const rowLabel = text => String(text || '').replace(/[\u2580-\u259f]/g, '').split(/\s{2,}|\s+·\s+/)[0].replace(/\s*[✔✓]\s*$/, '').replace(/\s+default$/, '').trim();

// 公司 CodeAgent 1.2615.02.01 的模型菜单（2026-10-16 公司真机 Q-1016-01 第 9 轮逐行原文，见单测）：
//   「  Select model    …    ✕」、搜索框「⌕ Search…」、用量表、表头「模型名称  Credit消耗系数 …」、「  Built-in」、
//   「  ❯  1. GLM-5.2-WX-Auto default ✓   0x  Day …」，底栏「Navigate ↑ ↓ | … | Select enter | Back esc」。
// 账号只有一个可选模型时菜单只有一行：认出这个外框时一行也算菜单（以前至少要两行，11 次都判成菜单没出现）。
const CODEAGENT_MENU_TITLE = /^\s*(?:[│┃]\s*)?(?:Select model|Switch model|选择模型|切换模型)\s*(?:[✕×]\s*)?(?:[│┃]\s*)?$/i;
const CODEAGENT_MENU_FOOTER = /Navigate\s*↑\s*↓.*(?:Select\s+enter.*Back\s+esc|Clear\s+esc.*Select\s+enter)/i;
// 模型菜单的标题：公司 CodeAgent 与 Claude 替身都是「Select model」，旧版/汉化界面可能是「选择模型」「切换模型」。
const MENU_TITLE = /Select model|Switch model|选择模型|切换模型/i;
const MENU_HEADER = /模型名称.*(?:Token用量|Credit消耗系数)|Model\s+name.*(?:Token|Credit)/i;
const SCROLLED_MENU = /(?:[↑↓]\s*\d+\s*(?:more|hidden)|\b\d+\s+more\s+(?:models|items)|scroll\s+(?:for|to see)\s+more|更多模型|[↑↓]\s*更多)/i;
const SCROLLBAR_ROW = /[\u2580-\u259f]\s*$/;
const MODEL_SEARCH_WAIT_MS = 1500;
const MODEL_SCROLL_LIMIT = 60;
const MODEL_FRAME_STABLE_MS = 320;
const MODEL_COLLECT_TIMEOUT_MS = 45000;

function modelMenuLines(lines) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  const titleAt = screen.findLastIndex(line => MENU_TITLE.test(line));
  const border = titleAt < 0 ? null : screen.slice(titleAt + 1).find(line => /^\s*╭[─━]+╮/.test(line));
  return border ? screen.map(line => require('./codeagent-commands-probe').mainColumn(line, border.indexOf('╮') + 1)) : screen;
}
const searchText = lines => (modelMenuLines(lines).findLast(line => /⌕/.test(line)) || '').replace(/^.*⌕\s*/, '').replace(/\s*[│┃]\s*$/, '').trim();
const searchEmpty = lines => !searchText(lines) || /^Search(?:…|\.\.\.)?$/i.test(searchText(lines));

// 测试替身（真 Claude Code）的菜单里只有 Claude 的模型名：用 AI_HUB_CODEAGENT_PICKER_LABELS
// （JSON：{ "MiniMax-M2.7": "Haiku" }）把 Hub 的模型名对到菜单里的名字。真 CodeAgent 不需要。
function pickerLabelFor(modelId, env = process.env) {
  try {
    const map = JSON.parse(env.AI_HUB_CODEAGENT_PICKER_LABELS || '{}');
    const hit = Object.keys(map).find(key => key.toLowerCase() === String(modelId).toLowerCase());
    if (hit && typeof map[hit] === 'string' && map[hit].trim()) return map[hit].trim();
  } catch { /* 格式不对就当没配 */ }
  return String(modelId || '');
}

// 菜单里两行模型之间的分组标题（Built-in、Custom 等）；用量行、表头、边框不算。
// 菜单滚动时右侧有一列滚动条（█ 等块字符，见 SCROLLBAR_ROW），标题行末尾也带着它：先去掉再认标题，
// 否则「Built-in      █」被当成带两格空白的说明行，内置组没了分组、按供应商选模型时回车前的分组核对必然失败（2026-11-28 黄区真机）。
function groupHeading(line) {
  const heading = String(line || '').replace(/[\s▀-▟]+$/, '').replace(/^[\s│┃]+|[\s│┃]+$/g, '').trim();
  return heading && !/^(?:[╭╰─━┌└]|⌕|Credit|月度|忙时|闲时|Hour\b|Min\b|Day\b|Token\b|模型名称|Model\s+name)/i.test(heading)
    && !/\s{2,}|[●%]/.test(heading) && heading.length <= 100 ? heading : '';
}

// 解析屏幕上的模型菜单。认不出返回 null。
// rows: [{ line, cursor, number|null, text, label }]，cursor 是光标所在行的下标。
function parsePicker(lines, { requireTitle = false, allowNoCursor = false } = {}) {
  const screen = modelMenuLines(lines);
  const titleLine = screen.findLastIndex(line => CODEAGENT_MENU_TITLE.test(line));
  const headerLine = screen.findLastIndex(line => MENU_HEADER.test(line));
  const startLine = Math.max(titleLine, headerLine);
  const footerLine = screen.findIndex((line, index) => index > startLine && CODEAGENT_MENU_FOOTER.test(line));
  const codeagentFrame = startLine >= 0 && footerLine > startLine;
  const minRows = codeagentFrame ? 1 : 2;
  let rows = [];
  screen.forEach((line, index) => {
    if (index <= startLine || footerLine >= 0 && index >= footerLine) return;
    const m = line.match(NUMBERED_ROW);
    if (m) rows.push({ line: index, cursor: !!m[1], number: Number(m[2]), text: m[3], label: rowLabel(m[3]) });
  });
  const numberedCount = rows.length;
  // 编号要连续，排除正文里碰巧以「1. 」开头的几行。
  if (rows.length >= minRows) {
    const runs = [];
    for (const row of rows) {
      const last = runs[runs.length - 1];
      if (last && row.number === last[last.length - 1].number + 1
          && (startLine >= 0 || row.line - last[last.length - 1].line <= 3)) last.push(row);
      else runs.push([row]);
    }
    // 公司 CodeAgent 1.2615.02.05 的菜单每个分组各自从 1 编号（2026-11-25 同事一键反馈实录：Built-in 1–3、Custom 又 1–9，
    // 见 tests/fixtures/codeagent-model-picker-grouped-real.txt）。以前只认跨分组连续编号，整张菜单被拆成几份、只留一组，
    // 另一组的模型（如 Built-in 的 DeepSeek-V4.1-Flash-1017）永远「菜单里没有」。中间隔着分组标题、又从 1 起的一段并回同一张菜单，
    // number 改成整张菜单里的顺序号（方向键就是按这个顺序走的），groupNumber 留菜单上显示的组内编号。
    // CodeAgent 1.2615.02.05 numbers each group from 1. A run that restarts at 1 after a group heading belongs to the same menu.
    const blocks = [];
    for (const run of runs) {
      const prev = blocks[blocks.length - 1], prevLast = prev && prev[prev.length - 1];
      const digitAt = screen[run[0].line].search(/\d/);
      if (prev && codeagentFrame && run[0].number === 1 && screen.slice(prevLast.line + 1, run[0].line)
        .some(line => groupHeading(line) && line.search(/\S/) < digitAt)) prev.push(...run.map(row => ({ ...row, restarted: true })));
      else blocks.push([...run]);
    }
    for (const block of blocks) {
      if (!block.some(row => row.restarted)) continue;
      const start = block[0].number;
      block.forEach((row, index) => { row.groupNumber = row.number; row.number = start + index; delete row.restarted; });
    }
    // 屏幕镜像里可能还留着菜单的旧画面（TUI 重绘没擦干净）：取最靠下、也就是最新的那一份。
    rows = blocks.filter(run => run.length >= minRows && (run.some(r => r.cursor) || allowNoCursor && codeagentFrame)).pop() || [];
  } else rows = [];
  // 没有编号的菜单：以光标行为准，向上下收集同一缩进、光标列为空白的相邻行。
  if (rows.length < minRows) {
    rows = [];
    const isCursorRow = line => BARE_CURSOR_ROW.test(line) && !/^\s*[❯›▶>]\s*\//.test(line) && MODEL_WORDS.test(line);
    let at = -1;
    for (let i = screen.length - 1; i >= 0; i -= 1) if (isCursorRow(screen[i])) { at = i; break; }
    if (at >= 0) {
      const [, indent] = screen[at].match(BARE_CURSOR_ROW);
      const col = indent.length;
      const sibling = line => line.length > col + 2 && line.slice(0, col + 1).trim() === '' && line[col + 2] !== ' ' && line.trim();
      let top = at, bottom = at;
      while (top - 1 >= 0 && sibling(screen[top - 1])) top -= 1;
      while (bottom + 1 < screen.length && sibling(screen[bottom + 1])) bottom += 1;
      for (let i = top; i <= bottom; i += 1) {
        const text = i === at ? screen[i].match(BARE_CURSOR_ROW)[3] : screen[i].trim();
        rows.push({ line: i, cursor: i === at, number: null, text, label: rowLabel(text) });
      }
    }
  }
  if (rows.length < minRows || !rows.some(row => MODEL_WORDS.test(row.text))) return null;
  // Group headings belong to the following rows; duplicate names may be
  // offered by separate providers. Never identify those rows by name alone.
  // 标题要缩进在编号列左边：右侧说明列折行的文字不算分组标题。
  let group = '';
  for (const row of rows) {
    const previous = rows[rows.indexOf(row) - 1], digitAt = screen[row.line].search(/\d/);
    for (const line of screen.slice(previous ? previous.line + 1 : startLine + 1, row.line)) {
      const heading = groupHeading(line);
      if (heading && line.search(/[^\s│┃]/) < digitAt) group = heading;
    }
    if (group) row.group = group;
  }
  // 公司 CodeAgent 1.2615.02.05 的内置模型那一组上方没有标题（只有下面的「Custom」有）：菜单里有分组标题时，
  // 第一个标题之前、名字不带「供应商/」前缀的行就是内置组，记成 Built-in，按供应商 w3 / Built-in 选时才认得出（R53 审查 P0）。
  // 只有一组、没有任何标题的老菜单不动。
  // The first (built-in) group of CodeAgent 1.2615.02.05 has no heading; when other groups are headed, its rows are Built-in.
  if (codeagentFrame && rows.some(row => row.group)) {
    for (const row of rows) {
      if (row.group) break;
      if (!String(row.label || '').includes('/')) row.group = 'Built-in';
    }
  }
  // 判断「能不能发消息」时，菜单上方必须有菜单标题：回答正文里的「> 1. GLM… / 2. MiniMax…」这类编号列表
  // 也有光标符号和模型名，以前会被当成菜单，之后每条消息都以「仍在模型选择界面」退回（2026-10-16 同事反馈
  // 2.1.0 发送被弹回）。Hub 自己刚打开菜单、正在读它时不要求（替身的重绘可能把标题挤出屏幕）。
  if (requireTitle && startLine < 0 && !screen.slice(Math.max(0, rows[0].line - 12), rows[0].line).some(line => MENU_TITLE.test(line))) return null;
  const cursor = rows.findIndex(row => row.cursor);
  if (cursor < 0 && !(allowNoCursor && codeagentFrame)) return null;
  const footer = screen.slice(rows[rows.length - 1].line + 1).join('\n');
  const sessionKey = (footer.match(SESSION_ONLY_KEY) || [])[1] || null;
  const incompleteReason = !searchEmpty(screen) ? 'filtered-menu' : !codeagentFrame ? 'missing-menu-boundary'
    : rows[0].number !== 1 ? 'missing-first-row'
      : rows.length !== numberedCount || rows.some((row, index) => row.number !== index + 1) ? 'nonconsecutive-rows'
        : screen.slice(startLine + 1, footerLine).some(line => SCROLLED_MENU.test(line) || SCROLLBAR_ROW.test(line)) ? 'scroll-truncated'
          : rows.some(row => /(?:\.\.\.|…)$/.test(row.label)) ? 'truncated-label' : '';
  const totalMatch = screen.slice(startLine + 1, footerLine >= 0 ? footerLine + 1 : undefined).join('\n')
    .match(/\b(\d+)\s+(?:models|items)\b|(?:共|总计)\s*(\d+)\s*(?:个)?模型/i);
  const total = totalMatch ? Number(totalMatch[1] || totalMatch[2]) : null;
  const reason = !incompleteReason && total && total !== rows.length ? 'scroll-truncated' : incompleteReason;
  return { rows, cursor, sessionKey, codeagentFrame, complete: !reason, incompleteReason: reason, total };
}

// 菜单存在与“能解析选项”是两件事。Select model 来自公司用户报告及
// 2026-10-14 Claude 替身实录；不能把未知布局当成菜单已经关闭。
function modelDialogVisible(lines) {
  const text = (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/)).join('\n');
  return !!parsePicker(lines, { requireTitle: true, allowNoCursor: true }) || /^\s*(?:[│┃]\s*)?Select model\s*(?:[✕×]\s*)?(?:[│┃])?\s*$/im.test(text)
    || !!require('./cli-model-command').parseClaudeModelSwitchConfirmation(text);
}

function promptInputReady(lines) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  if (modelDialogVisible(screen)) return false;
  // 公司 2026-10-08 实录，见 unit-codeagent-launch / trust-screen。
  if (screen.some(line => /^\s*(?:[│┃]\s*)?>\s+Anything I can assist you with\?/i.test(line))) return true;
  // 真 Claude 测试替身：必须同时有空输入行和它下面的状态栏，菜单消失本身不算就绪。
  // 2026-10-15 v2.1.300 实录的 ConPTY 重绘会留下「────────────❯ NBSP」；
  // 仅容许水平分隔线残留，任意旧正文、模型编号和仍打开的菜单都不能算普通输入。
  const prompt = screen.findLastIndex(line => /^[\s─]*[❯›]\s*(?:Try "[^"]*")?\s*$/.test(line));
  return prompt >= 0 && screen.slice(prompt + 1).some(line => /\? for shortcuts|bypass permissions|(?:manual|plan|accept edits) mode on|shift\+tab/i.test(line));
}

// 正文投递只需确认普通输入区，不能要求它为空或模型已经空闲：用户可在
// 原生草稿后追加，也可在公司实录的“补充指令”框里给忙着的 CLI 排队。
// 菜单退出的稳定确认仍用上面的空输入判据，不放宽模型选择成功的条件。
function promptInputAvailable(lines) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  if (modelDialogVisible(screen)) return false;
  if (promptInputReady(screen)) return true;
  const companyPrompt = screen.findLastIndex(line => /^\s*(?:[│┃]\s*)?>\s*/.test(line));
  if (companyPrompt >= 0) {
    if (/^\s*(?:[│┃]\s*)?>\s+补充指令（Enter 排队等待发送）/.test(screen[companyPrompt])) return true;
    // 底栏左边是权限模式名（公司实录「Bypass」）。别的模式名可能带连字符或是中文（如「Auto-Accept」），
    // 以前只认纯字母，输入框里有草稿时整条消息被退回（2026-10-16 同事反馈 2.1.0 发送被弹回）。
    if (screen.slice(companyPrompt + 1).some(line => /^\s*(?:[│┃]\s*)?[^\s|│┃][^|│┃]{0,40}\(Cycle shift\+tab\)\s*\|/i.test(line))) return true;
  }
  // Claude 替身的非空输入仍有同一底栏。排除只剩一个编号选项的残缺帧。
  const prompt = screen.findLastIndex(line => /^[\s─]*[❯›]\s*/.test(line)
    && !(NUMBERED_ROW.test(line) && MODEL_WORDS.test(line)));
  return prompt >= 0 && screen.slice(prompt + 1).some(line => /\? for shortcuts|bypass permissions|(?:manual|plan|accept edits) mode on|shift\+tab/i.test(line));
}

// 菜单把长模型名截断显示（公司实录「DeepSeek-V4.1-Flash-1…」，目标 deepseek-v4.1-flash-1017）：截断名的前缀是目标名的开头才算候选，
// 规则与用量表共用（codeagent-usage-menu truncatedNameMatches）。只命中唯一一行才选；几行同前缀分不清就不选，免得误选。
function truncatedRows(rows, label) {
  const { truncatedNameMatches } = require('./codeagent-usage-menu');
  return (rows || []).reduce((hits, row, index) => truncatedNameMatches(row.label, label)
    || truncatedNameMatches(bareLabel(row.label), bareLabel(label)) ? [...hits, index] : hits, []);
}
// 搜索与翻页用：名字完全相同（不分大小写）优先，其次唯一命中的截断名。
function locateLabel(rows, label, route = {}) {
  if (route.provider) return findTarget({ rows }, label, route);
  const exact = (rows || []).filter(row => exactLabel(row.label, label));
  if (exact.length) return findTarget({ rows }, label);
  const aliases = aliasRows(rows, label);
  if (aliases.length) return aliases.length === 1 ? aliases[0] : -1;
  const cut = truncatedRows(rows, label);
  return cut.length === 1 ? cut[0] : -1;
}

// 目标在哪一行：模型名完全相同优先，其次唯一命中的截断名，再次以它开头，最后整行包含。
function groupMatches(row, provider = '', providerLabel = '') {
  if (!provider) return true;
  const group = squash(row.group);
  const candidates = [provider, providerLabel, String(provider).split('/').pop(), String(providerLabel).split('/').pop()].map(squash).filter(Boolean);
  const prefix = String(row.label || '').split('/').slice(0, -1).join('/');
  if (prefix && candidates.includes(squash(prefix))) return true;
  return !!group && (candidates.includes(group) || provider === 'w3' && /^(?:builtin|内置)$/.test(group));
}

function defaultGroup(picker) {
  const groups = [...new Set((picker?.rows || [])
    .filter(row => /(?:^|\s)(?:default|默认)(?=\s|[✓✔]|$)/i.test(row.text))
    .map(row => row.group).filter(Boolean))];
  return groups.length === 1 ? groups[0] : '';
}

function findTarget(picker, label, { provider = '', providerLabel = '' } = {}) {
  if (provider) {
    const indexed = picker?.rows.map((row, index) => ({ row, index })).filter(({ row }) => groupMatches(row, provider, providerLabel)) || [];
    const target = findTarget({ rows: indexed.map(item => item.row) }, label);
    return target >= 0 ? indexed[target].index : -1;
  }
  const want = squash(label);
  if (!picker || !want) return -1;
  const exact = picker.rows.map((row, index) => squash(row.label) === want ? index : -1).filter(index => index >= 0);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const group = defaultGroup(picker);
    const preferred = group ? exact.filter(index => groupMatches(picker.rows[index], group)) : [];
    return preferred.length === 1 ? preferred[0] : -1;
  }
  const aliases = aliasRows(picker.rows, label);
  if (aliases.length) return aliases.length === 1 ? aliases[0] : -1;
  const cut = truncatedRows(picker.rows, label);
  if (cut.length) return cut.length === 1 ? cut[0] : -1;
  const unique = indexes => {
    if (indexes.length === 1) return indexes[0];
    const group = defaultGroup(picker);
    const preferred = group ? indexes.filter(index => groupMatches(picker.rows[index], group)) : [];
    return preferred.length === 1 ? preferred[0] : -1;
  };
  const prefix = picker.rows.map((row, index) => squash(row.label).startsWith(want) ? index : -1).filter(index => index >= 0);
  if (prefix.length) return unique(prefix);
  return unique(picker.rows.map((row, index) => squash(row.text).includes(want) ? index : -1).filter(index => index >= 0));
}

function confirmationSeen(lines, label) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || ''));
  const want = squash(label);
  return text.split(/\r?\n/).some(line => /set model to|model set to|switched to|已切换|切换到|模型已/i.test(line) && squash(line).includes(want));
}

// ---------------------------------------------------------------- 会话屏幕镜像
// 与 codex-fast-command 同一做法：用会话缓冲快照重建一个终端模拟器，再接上之后的输出。
async function openSessionScreen(manager, sid) {
  const { Terminal } = require('@xterm/headless');
  const queued = [];
  let terminal = null, replayed = false, disposed = false, chain = Promise.resolve();
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  const apply = event => event.type === 'resize' ? terminal.resize(event.cols, event.rows) : write(event.data);
  const enqueue = event => {
    if (event.sessionId !== sid || disposed) return;
    if (!replayed) queued.push(event);
    else {
      chain = chain.then(() => apply(event));
      // 监听回调不能 await；由 lines() 将错误传给调用方，这里只避免读取前的未处理拒绝。
      chain.catch(() => {});
    }
  };
  const listener = event => enqueue({ ...event, type: 'write' });
  const resizeListener = event => enqueue({ ...event, type: 'resize' });
  const unsubscribe = () => {
    manager.removeListener('output', listener);
    manager.removeListener('terminal-resized', resizeListener);
  };
  manager.on('output', listener);
  manager.on('terminal-resized', resizeListener);
  try {
    const snapshot = await manager.getSessionBufferSnapshot(sid);
    // windowsPty 与会话自己的快照终端一致（core/terminal-snapshot.js）：不按 ConPTY 解释换行和光标移动，
    // 重绘会错一行，光标看起来就「没动」（2026-10-14 替身实测）。
    terminal = new Terminal({ cols: snapshot.baseCols || snapshot.cols || 120, rows: snapshot.baseRows || snapshot.rows || 30, scrollback: 200, allowProposedApi: true,
      ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: parseInt(require('node:os').release().split('.').pop(), 10) || 0 } } : {}) });
    await write(snapshot.text || '');
    for (const operation of snapshot.operations || []) {
      if (operation.type === 'resize') terminal.resize(operation.cols, operation.rows);
      else if (operation.type === 'write') await write(operation.data);
    }
    for (const event of queued) if (!event.seq || event.seq > snapshot.seq) await apply(event);
    replayed = true;
  } catch (error) {
    disposed = true; unsubscribe(); try { terminal && terminal.dispose(); } catch {}
    throw error;
  }
  return {
    async lines() {
      // await 期间 output/resize 仍能延长队列；等旧尾部会把已收到的新菜单
      // 藏到下一次读取。排到当前尾部稳定才返回，拒绝的链仍向调用方传播。
      let observed;
      do { observed = chain; await observed; } while (observed !== chain);
      const buffer = terminal.buffer.active, out = [];
      for (let i = buffer.baseY; i < buffer.baseY + terminal.rows; i += 1) out.push(buffer.getLine(i)?.translateToString(true) || '');
      return out;
    },
    dispose() {
      disposed = true; unsubscribe();
      const cleanup = () => { try { terminal.dispose(); } catch {} };
      chain.then(cleanup, cleanup);
    },
  };
}

// ---------------------------------------------------------------- 默认模型保护
function readModelKey(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return { exists: true, model: value && typeof value.model === 'string' ? value.model : undefined,
      provider: value?.provider, activeProvider: value?.enterprise?.activeProvider };
  } catch (error) { return { exists: !(error && error.code === 'ENOENT'), model: undefined, unreadable: !(error && error.code === 'ENOENT') }; }
}
function snapshotDefaults(configDir) {
  return ['settings.json', 'settings.local.json'].map(name => ({ file: path.join(configDir, name), ...readModelKey(path.join(configDir, name)) }));
}
// 配置目录的规范写法（2026-10-19 公司个人账号默认模型被改回 DS 的排查）：快照和写回必须是 CodeAgent 实际写的那个目录，
// 不能因为大小写、分隔符、目录链接不同而比错。先 realpath，拿不到时退回绝对路径。
function normalizeConfigDir(dir) {
  if (!dir) return '';
  const resolved = path.resolve(String(dir));
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}
const sameDefaults = (a, b) => a.model === b.model && a.provider === b.provider && a.activeProvider === b.activeProvider;
// 菜单会同时改模型和供应商；自动会话选完恢复这三个字段，其余配置原样保留。
// 原来没有这份文件、CodeAgent 新建了它并写了 model：只去掉 model 键。
function restoreDefaults(snapshot) {
  const restored = [];
  for (const before of snapshot) {
    if (before.unreadable) continue;
    let raw;
    try { raw = fs.readFileSync(before.file, 'utf8'); } catch { continue; }
    let value;
    try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { continue; }
    if (sameDefaults(readModelKey(before.file), before)) continue;
    if (before.model === undefined) delete value.model; else value.model = before.model;
    if (before.provider === undefined) delete value.provider; else value.provider = before.provider;
    if (before.activeProvider === undefined) { if (value.enterprise) delete value.enterprise.activeProvider; }
    else { value.enterprise = value.enterprise || {}; value.enterprise.activeProvider = before.activeProvider; }
    const temp = `${before.file}.hub-model-${process.pid}.tmp`;
    // Windows 上 CLI 或杀毒正读着 settings.json 时覆盖改名会短暂 EPERM：有界重试，否则用户的默认模型会被留成菜单改过的值。
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); require('./claude-project-trust').renameWithRetrySync(temp, before.file); restored.push(path.basename(before.file)); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  return restored;
}

// 回车之后看住默认模型：CodeAgent 可能在回显之后、甚至几秒后才写配置（以前只在 0.6 秒和 2.1 秒各改回一次，
// 它后写就把改回的值盖掉）。在 durationMs 内每 intervalMs 读一次，被改了就改回；最后再读一次核对。
// 返回 { restored: [文件名], changes: [{ file, written, restoredTo, ok }], verified, before, after }（before/after 是 settings.json 的 model）。
async function guardDefaults(snapshot, { durationMs = 3500, intervalMs = 150, onChange = null } = {}) {
  const restored = new Set();
  const changes = [];
  const deadline = Date.now() + durationMs;
  for (;;) {
    for (const before of snapshot) {
      if (before.unreadable) continue;
      const now = readModelKey(before.file);
      if (!now.exists || now.unreadable || sameDefaults(now, before)) continue;
      // 改回失败（文件被占用、权限等）不能停在被改后的值：记下原因，下一拍接着重试，看守结束时仍没改回就由 verified:false 报出。
      let done = [], error = '';
      try { done = restoreDefaults([before]); } catch (e) { error = e && e.message ? e.message : String(e); }
      const after = readModelKey(before.file);
      const change = { file: path.basename(before.file), written: now.model, restoredTo: before.model, ok: sameDefaults(after, before), ...(error ? { error } : {}) };
      changes.push(change);
      if (done.length) restored.add(change.file);
      try { onChange && onChange(change); } catch { /* 只是记日志 */ }
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const verified = snapshot.every(before => before.unreadable || !readModelKey(before.file).exists || sameDefaults(readModelKey(before.file), before));
  const main = snapshot.find(before => path.basename(before.file) === 'settings.json');
  return { restored: [...restored], changes, verified, before: main ? main.model : undefined, after: main ? readModelKey(main.file).model : undefined };
}

// 账号的模型权限清单里有没有这个模型（清单未知时不拦，菜单本身再核一次）。
// 「菜单里的第一个模型」（2026-10-25 用户：CodeAgent 会记住上一次用的模型，普通新建的会话都打开 /model 选第一个）。
// 不是真实模型名：pickModel 认它时选菜单第 1 项，回执里的 picked 是那一行的模型名。
const FIRST_MENU_MODEL = '@first';
const isFirstMenuModel = modelId => modelId === FIRST_MENU_MODEL;
function modelAllowed(modelId, allowedModels) {
  if (isFirstMenuModel(modelId)) return true;
  if (!Array.isArray(allowedModels) || !allowedModels.length) return true;
  const want = String(modelId || '').toLowerCase();
  return allowedModels.some(m => String(m || '').toLowerCase() === want);
}

// ---------------------------------------------------------------- 选择
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(screen, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lines = [];
  while (Date.now() < deadline) {
    lines = await screen.lines();
    const value = predicate(lines);
    if (value) return { value, lines };
    await sleep(80);
  }
  return { value: null, lines };
}

// 等画面安静：连续 quietMs 内读屏内容不变（最多等 maxMs）。CodeAgent 刚启动时 MCP 逐个连上、标题栏计数一直在变，
// 这段时间里 CLI 整屏重画会把刚打开的模型菜单关掉（2026-11-28 黄区真机）。
async function waitQuiet(screen, { quietMs = 3000, maxMs = 20000 } = {}) {
  const deadline = Date.now() + maxMs;
  let previous = null, since = Date.now();
  while (Date.now() < deadline) {
    // 顶部公告横幅在滚动重画，不算画面在变（A-08）。
    const text = withoutAnnouncement(await screen.lines()).join('\n');
    if (text !== previous) { previous = text; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return true;
    await sleep(250);
  }
  return false;
}

// 用户在终端里的按键（主进程 terminal-input 登记；焦点报告、光标位置回复这类终端自动应答不算）。
const userInputAt = new Map();
// 终端自动发回的应答与鼠标上报（焦点进出、光标位置、设备属性、OSC 颜色、SGR/X10 鼠标）：不是人在打字。
// 带 ? 或 > 前缀的 CSI 只会是终端应答（如 DECRPM「ESC[?2026;0$y」、设备属性），按键不会发；OSC、DCS 应答同理。
const AUTO_REPLY = /\x1b\[[IO]|\x1b\[(?!1;[2-8]R)\d+;\d+R|\x1b\[[?>][\d;$]*[a-zA-Z]|\x1b\[[\d;]*\$y|\x1b\[[\d;]*c|\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\/g;
function noteUserInput(sid, data, at = Date.now()) {
  if (typeof data !== 'string' || !data) return;
  const rest = data.replace(AUTO_REPLY, '');
  if (!rest) return;
  // 排查用样本：控制序列按转义写出，可见文字只记长度（不记内容）。
  const sample = rest.charCodeAt(0) === 27 ? JSON.stringify(rest.slice(0, 16)) : `text(${rest.length})`;
  userInputAt.set(String(sid), { at, sample });
}
function userInputSince(sid, since) { const hit = userInputAt.get(String(sid)); return hit && hit.at >= since ? hit : null; }
// 会话身份：同一个会话号、同一个终端进程。重拉或关闭后不再替它按键。
// 会话执行快照：原地重拉不换会话对象、只把 modelSubmissionEpoch 加一并往同一个 pty 写重拉命令，
// 所以要同时核对 epoch、pty、关闭/休眠状态（session-model-pin 的同一口径），再加会话对象与终端进程号兜底。
function sessionExecution(manager, sid) {
  const pins = require('./session-model-pin');
  const entry = manager.sessions?.get?.(sid);
  const info = manager.getSession?.(sid);
  if (!entry && !info) return null;
  return { snapshot: pins.captureSessionExecution(manager, sid), pty: entry?.pty, pid: info?.pid ?? info?.ptyPid ?? '' };
}
function sameExecution(start, manager, sid) {
  if (!start) return false;
  const pins = require('./session-model-pin');
  if (!pins.sameSessionExecution(start.snapshot, manager, sid)) return false;
  const entry = manager.sessions?.get?.(sid), info = manager.getSession?.(sid);
  return entry?.pty === start.pty && (info?.pid ?? info?.ptyPid ?? '') === start.pid;
}
// 输入框下方状态行里的当前模型（「… (Cycle shift+tab) | DeepSeek-V4.1-Flash-1017      @  ✲  ↵  ▷ │」）。
function statusModel(lines) {
  const list = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = /\|\s*([^|@│]+?)\s{2,}@\s/.exec(list[i]);
    if (m) return m[1].trim();
  }
  return '';
}

async function waitForInput(screen, timeoutMs = 3000) {
  let previous = '', readySince = 0;
  return waitFor(screen, lines => {
    if (!promptInputReady(lines)) { readySince = 0; return false; }
    const text = withoutAnnouncement(lines).join('\n');
    if (!readySince || text !== previous) { previous = text; readySince = Date.now(); }
    // Esc 后输入框必须真实恢复且稳定；不能只睡一拍就把正文当 Alt+键送进去。
    return Date.now() - readySince >= 320;
  }, timeoutMs);
}

const exactLabel = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// 指定了供应商时，菜单行「供应商/名字」就是这个模型的原样写法：Hub 存的 id / menuLabel 不带前缀（serve 与 settings.json 自配都是），
// 公司 1.2615.02.05 的 Custom 组却显示「cannbotprovider/GLM-5.3」。不认它时首屏、搜索命中都被当成未确认的别名丢掉（R53 审查 P1）。
// With a provider, '<provider>/<label>' on the menu is the exact spelling of that route's model.
const exactRow = (row, label, route = {}) => exactLabel(row?.label, label)
  || [route.provider, route.providerLabel].some(prefix => prefix && exactLabel(row?.label, `${prefix}/${label}`));
const pickerSignature = picker => picker ? JSON.stringify(picker.rows.map(row => [row.number, row.label, row.cursor])) : '';

// Poll the model rows, not changing Stats/history text beside the menu. A key
// must change the rows/cursor and remain stable through split focus/move frames.
async function waitForPickerChange(screen, before, timeoutMs) {
  let previous = '', stableSince = 0;
  return waitFor(screen, lines => {
    const picker = parsePicker(lines), signature = pickerSignature(picker);
    if (!signature || signature === before) { previous = ''; return false; }
    if (signature !== previous) { previous = signature; stableSince = Date.now(); }
    return Date.now() - stableSince >= MODEL_FRAME_STABLE_MS ? picker : false;
  }, timeoutMs);
}

async function closeModelMenu({ readLines, write, pause = sleep, now = Date.now, timeoutMs = 3000 }) {
  const deadline = now() + timeoutMs;
  let phase = 'start', readySince = null;
  while (now() < deadline) {
    const lines = await readLines();
    if (!modelDialogVisible(lines) && promptInputReady(lines)) {
      if (readySince === null) readySince = now();
      if (now() - readySince >= MODEL_FRAME_STABLE_MS) return { ok: true, lines };
    } else {
      readySince = null;
      if (phase === 'start' && !modelDialogVisible(lines)) { write('\x1b'); phase = 'closing'; }
      if (modelDialogVisible(lines) && (phase === 'start' || phase === 'clearing' && searchEmpty(lines))) {
        phase = searchEmpty(lines) ? 'closing' : 'clearing';
        write('\x1b');
      }
    }
    await pause(80);
  }
  return { ok: false, reason: 'menu-close-unconfirmed' };
}

// Only the hidden background probe may promote a traversed list to complete.
async function collectModelMenu({ lines, readLines, write, revision, pause = sleep, now = Date.now, timeoutMs = MODEL_COLLECT_TIMEOUT_MS }) {
  let picker = parsePicker(lines, { allowNoCursor: true });
  const deadline = now() + timeoutMs, seen = new Map(), tokens = new Map();
  let credit = null, steps = 0;
  const number = frame => frame.rows[frame.cursor]?.number ?? frame.rows[0]?.number;
  const failed = reason => ({ ok: false, reason, atNumber: picker ? number(picker) : null, steps });
  if (!picker || !searchEmpty(lines)) return failed('menu-unrecognized');
  const take = () => {
    for (const row of picker.rows) {
      if (!row.number || seen.has(row.number) && !exactLabel(seen.get(row.number).label, row.label)) return false;
      seen.set(row.number, row);
    }
    const usage = require('./codeagent-usage-menu').parseCodeAgentUsageMenu(modelMenuLines(lines));
    if (usage?.credit) credit = usage.credit;
    for (const model of usage?.models || []) {
      const previous = tokens.get(model.name.toLowerCase());
      tokens.set(model.name.toLowerCase(), { ...model, hour: model.hour || previous?.hour || null, min: model.min || previous?.min || null });
    }
    return true;
  };
  const step = async key => {
    const beforeRevision = revision(), before = pickerSignature(picker);
    write(key); steps++;
    let previous = '', since = 0, fresh = false;
    const turnDeadline = Math.min(deadline, now() + MODEL_SEARCH_WAIT_MS);
    while (now() < turnDeadline) {
      const nextLines = await readLines(), next = parsePicker(nextLines, { allowNoCursor: true });
      fresh = revision() > beforeRevision;
      if (fresh && next) {
        const signature = pickerSignature(next) + JSON.stringify(require('./codeagent-usage-menu').parseCodeAgentUsageMenu(modelMenuLines(nextLines)));
        if (signature !== previous) { previous = signature; since = now(); }
        if (now() - since >= MODEL_FRAME_STABLE_MS) { lines = nextLines; picker = next; return { ok: true, changed: pickerSignature(next) !== before }; }
      }
      await pause(80);
    }
    return { ok: false, reason: fresh ? 'menu-scroll-unstable' : 'menu-scroll-no-frame' };
  };
  if (!picker.complete) {
    if (!['scroll-truncated', 'missing-first-row'].includes(picker.incompleteReason)) return failed(picker.incompleteReason);
    while (number(picker) !== 1 && steps < MODEL_SCROLL_LIMIT && now() < deadline) {
      const moved = await step('\x1b[A');
      if (!moved.ok) return failed(moved.reason);
      if (!moved.changed) return failed('menu-first-unconfirmed');
    }
    if (number(picker) !== 1) return failed('menu-first-unconfirmed');
    let unchanged = 0, completed = false;
    while (steps < MODEL_SCROLL_LIMIT * 2 && now() < deadline) {
      if (!take()) return failed('menu-number-conflict');
      const beforeNumber = number(picker), moved = await step('\x1b[B');
      if (!moved.ok) return failed(moved.reason);
      unchanged = moved.changed ? 0 : unchanged + 1;
      if (number(picker) === 1 && beforeNumber !== 1 || unchanged >= 2) { completed = true; break; }
    }
    if (!completed) return failed('menu-scroll-limit');
  }
  if (!take()) return failed('menu-number-conflict');
  const rows = [...seen.values()].sort((a, b) => a.number - b.number);
  if (!rows.length || rows.some((row, i) => row.number !== i + 1) || picker.total && picker.total !== rows.length) return failed('menu-number-gap');
  return { ok: true, ...require('./codeagent-model-probe').modelsFromPicker({ rows }), menuComplete: true,
    usage: { credit, models: rows.map(row => tokens.get(row.label.toLowerCase())).filter(Boolean),
      modelsComplete: rows.every(row => tokens.get(row.label.toLowerCase())?.day) }, steps };
}

async function findOffscreenTarget({ picker, screen, manager, sid, label, route = {}, log, reopenMenu, onSearchFrame, relaxUnique = null }) {
  const initial = modelMenuLines(await screen.lines());
  if (initial.some(line => /⌕/.test(line))) {
    const oldSearch = searchText(initial);
    if (!/^Search(?:…|\.\.\.)?$/i.test(oldSearch) && oldSearch) manager.writeToSession(sid, '\x7f'.repeat(oldSearch.length));
    manager.writeToSession(sid, label);
    let previous = '';
    const stable = await waitFor(screen, lines => {
      const text = modelMenuLines(lines).join('\n');
      if (text === initial.join('\n')) { previous = ''; return false; }
      if (text === previous) return { picker: parsePicker(lines, { allowNoCursor: true }) };
      previous = text; return false;
    }, MODEL_SEARCH_WAIT_MS);
    onSearchFrame(stable.lines);
    let searched = { value: stable.value?.picker || null };
    let found = searched.value && locateLabel(searched.value.rows, label, route);
    if (found >= 0 && searched.value && !searched.value.complete && !exactRow(searched.value.rows[found], label, route)
      && bareLabel(searched.value.rows[found]?.label) === bareLabel(label)) found = -1;
    // 搜索结果里同名行只有一条、只是分组对不上（搜索结果常不带分组标题）：选它，并把目标分组改成这一行的，免得回车前的分组核对再拦下。
    // 以前这里对不上就按 Esc 清搜索，新版 CodeAgent 上清不掉、重开菜单也失败（2026-11-25 同事日志 switch-search result=clear-failed）。
    // Search results often carry no group heading: a single same-name row is taken and the route follows its group.
    // 搜索结果总是「过滤过」，看不出有没有被滚走的行：只在账号清单里这个模型最多一个供应商时放宽（allSeen=false）。
    if (!(found >= 0) && route.provider && searched.value && relaxUnique) {
      const relaxed = relaxUnique(searched.value, { allSeen: false, stage: 'search' });
      if (relaxed >= 0) found = relaxed;
    }
    if (!route.provider && searched.value?.rows.filter(row => exactLabel(row.label, label)).length > 1 && found < 0) {
      return { error: `多个供应商都有 ${label}，请在助理设置或模型列表中选择供应商`, requiresGroupSelection: true };
    }
    if (Number.isInteger(found) && found >= 0) {
      picker = searched.value;
      let searchSteps = 0;
      while (picker.cursor !== found && searchSteps++ < MODEL_SCROLL_LIMIT) {
        const prior = pickerSignature(picker), down = found > picker.cursor;
        manager.writeToSession(sid, down ? '\x1b[B' : '\x1b[A');
        searched = await waitForPickerChange(screen, prior, MODEL_SEARCH_WAIT_MS);
        if (!searched.value) break;
        picker = searched.value;
        found = locateLabel(picker.rows, label, route);
        if (found < 0) break;
      }
      if (picker.cursor >= 0 && locateLabel(picker.rows, label, route) === picker.cursor) {
        log({ event: 'switch-search', result: 'found' }); return { picker, target: picker.cursor };
      }
    }
    // Focused empty search boxes omit their placeholder. Read the box contents,
    // not the placeholder; never scroll a list which may still be filtered.
    manager.writeToSession(sid, '\x1b');
    const cleared = await waitFor(screen, lines => searchEmpty(lines) && parsePicker(lines, { allowNoCursor: true }), MODEL_SEARCH_WAIT_MS);
    log({ event: 'switch-search', result: cleared.value ? 'scroll-fallback' : 'clear-failed' });
    if (!cleared.value) {
      const reopened = await reopenMenu();
      if (!reopened.value) return { error: '搜索未能清空，退出并重开模型菜单失败' };
      picker = reopened.value;
    } else picker = cleared.value;
  } else log({ event: 'switch-search', result: 'unavailable' });
  // A focused search box may hide the list cursor. One Down can move focus,
  // but selection is permitted only if the next frame exposes a real cursor.
  if (picker.cursor < 0) {
    manager.writeToSession(sid, '\x1b[B');
    const focused = await waitForPickerChange(screen, pickerSignature(picker), MODEL_SEARCH_WAIT_MS);
    if (!focused.value) return { error: '无法确认模型列表的选中项，没有选择模型' };
    picker = focused.value;
  }
  // 截断名要翻完整个列表才知道是不是唯一：一路记下命中的行，完全同名的随时优先；翻到底只有一行时再按上键退回去。
  // nameRows：指定线路时，一路上所有完全同名或截断名像它的行（不论分组）。翻完一圈线路里一行都没有时，交给 relaxUnique（allSeen）判定
  // 能否按「整张菜单同名只有一行」选它（2026-11-25 公司实录滚动布局：一屏只显示一个模型，旧线路对不上新分组名，翻完照报「没有」）。
  // nameRows: every same-name or truncated-lookalike row met while scrolling, any group; decided by relaxUnique once the list is fully traversed.
  const seen = new Set(), truncated = new Set(), aliases = new Set(), nameRows = new Map(), limit = picker.total || MODEL_SCROLL_LIMIT;
  // 行的身份用组内编号：分组菜单滚动后，上面的组滚出屏幕，下面一组的顺序号会从 4 变回 1（不再看得到重新编号），
  // 按顺序号记账会把同一行记成两行，误报「多个线路都有」（R53 审查 P1）。
  const identityOf = row => JSON.stringify([row.groupNumber ?? row.number, row.label]);
  const noteTruncated = () => {
    for (const index of truncatedRows(picker.rows, label)) if (groupMatches(picker.rows[index], route.provider, route.providerLabel)) truncated.add(identityOf(picker.rows[index]));
    for (const index of aliasRows(picker.rows, label)) if (groupMatches(picker.rows[index], route.provider, route.providerLabel)) aliases.add(identityOf(picker.rows[index]));
    if (route.provider && relaxUnique) {
      for (const row of picker.rows) if (exactLabel(row.label, label)) nameRows.set(identityOf(row), row);
      for (const index of truncatedRows(picker.rows, label)) nameRows.set(identityOf(picker.rows[index]), picker.rows[index]);
    }
  };
  let steps = 0;
  while (steps < limit) {
    const row = picker.rows[picker.cursor], identity = identityOf(row);
    if (exactRow(row, label, route) && groupMatches(row, route.provider, route.providerLabel)) { log({ event: 'switch-scroll', steps, result: 'found' }); return { picker, target: picker.cursor }; }
    noteTruncated();
    if (seen.has(identity)) break;
    seen.add(identity);
    const before = pickerSignature(picker);
    manager.writeToSession(sid, '\x1b[B'); steps++;
    const next = await waitForPickerChange(screen, before, MODEL_SEARCH_WAIT_MS);
    if (!next.value) break;
    picker = next.value;
  }
  if (exactRow(picker.rows[picker.cursor], label, route) && groupMatches(picker.rows[picker.cursor], route.provider, route.providerLabel)) { log({ event: 'switch-scroll', steps, result: 'found' }); return { picker, target: picker.cursor }; }
  noteTruncated();
  let candidates = aliases.size ? aliases : truncated, sameNameOnly = false;
  // 带总数提示时要真走过这么多行才算翻完（光标停住不动不等于到底）。
  if (!candidates.size && nameRows.size && steps < limit && (!picker.total || seen.size >= picker.total)) {
    const rows = [...nameRows.values()], relaxed = relaxUnique({ rows }, { allSeen: true, stage: 'scroll' });
    if (relaxed >= 0) { candidates = new Set([identityOf(rows[relaxed])]); sameNameOnly = true; }
  }
  if (candidates.size === 1 && steps < limit) {
    const [only] = candidates;
    for (let back = 0; back <= steps + 1; back += 1) {
      const row = picker.rows[picker.cursor];
      if (row && identityOf(row) === only) { log({ event: 'switch-scroll', steps, back, result: aliases.size ? 'found-alias' : sameNameOnly ? 'found-same-name-other-group' : 'found-truncated' }); return { picker, target: picker.cursor }; }
      const before = pickerSignature(picker);
      manager.writeToSession(sid, '[A');
      const next = await waitForPickerChange(screen, before, MODEL_SEARCH_WAIT_MS);
      if (!next.value) break;
      picker = next.value;
    }
  }
  log({ event: 'switch-scroll', steps, result: truncated.size > 1 ? 'ambiguous-truncated' : 'not-found', ...(truncated.size ? { truncated: truncated.size } : {}) });
  if (aliases.size > 1) return { error: `多个线路都有 ${label}，请重新选择带完整前缀或供应商的模型`, requiresGroupSelection: true };
  return { picker, target: -1 };
}

// 选中之后 CLI 打印的「Set model to <模型>」：从原始输出里找，不依赖屏幕重绘。界面框架用光标移动代替空格，
// 去掉控制序列后单词会粘在一起，所以压成小写字母数字再比。返回回显里模型名开头的一段（已压缩），没有返回 null。
// 会话里已经聊过时，选中后还会弹「Switch model? … ❯ 1. Yes, switch to X / 2. No, go back」（提醒换模型后历史要重读）。
// 用户点了换模型就是要换：移到「Yes」回车（同 Claude 的处理，core/cli-model-command.js）。
async function waitForEcho(manager, sid, mark, timeoutMs, screen) {
  const { stripAnsi } = require('./ansi-utils.js');
  const { parseClaudeModelSwitchConfirmation } = require('./cli-model-command');
  const deadline = Date.now() + timeoutMs;
  let answered = false;
  while (Date.now() < deadline) {
    const fresh = squash(stripAnsi(String(manager.getSessionOutputSince(sid, mark) || '')));
    const at = fresh.lastIndexOf('setmodelto');
    if (at >= 0 && fresh.length - at > 'setmodelto'.length + 2) return fresh.slice(at + 'setmodelto'.length, at + 'setmodelto'.length + 40);
    if (!answered && screen) {
      const dialog = parseClaudeModelSwitchConfirmation((await screen.lines()).join('\n'));
      if (dialog) {
        answered = true;
        const moves = dialog.number - dialog.cursor;
        for (let i = 0; i < Math.abs(moves); i += 1) { manager.writeToSession(sid, moves > 0 ? '\x1b[B' : '\x1b[A'); await sleep(150); }
        await sleep(200);
        manager.writeToSession(sid, '\r');
      }
    }
    await sleep(100);
  }
  return null;
}

// 在已经打开的会话里选模型。返回 { ok, mode: 'session'|'default', confirmed, restored, message }。
// 账号旧清单不拒绝选择；目标是否能选以这次 CodeAgent 菜单为准。
// configDir：CodeAgent 这个会话实际用的配置目录（回车会写它的 settings.json）；先规范化，快照、写回、核对都用同一个。
// guardMs：回车后看住默认模型多久；onDefaultChange(change)：每次发现被改、改回时回调（调用方记日志）。
// readyFirstMs：先等 CLI 画出普通输入框并稳定下来再敲 /model（自动会话启动时用；2026-10-20 发布闸门 no-choice：
// 启动后马上敲，/model 的回车有时没被执行，输入行停在「❯ /model」，第一条题目发不出去）。
// keepDefault（2026-10-28 用户「记住最新的选择作为默认」）：手动会话这次选的模型留作 CodeAgent 的默认模型——按回车存成默认、不改回原值，
// 下次新建会话 CodeAgent 直接用它起，不再开菜单（core/codeagent-launch-model.js 的 cli-remembered）。自动会话不传，照旧只改本会话、事后改回。
async function pickModel({ manager, sid, kind, modelId, provider = '', providerLabel = '', menuLabel = '', configDir, dataDir, sendToPty, screenTimeoutMs = 8000, guardMs = 3500, onDefaultChange = null, env = process.env, readyFirstMs = 0, keepDefault = false }) {
  const first = isFirstMenuModel(modelId);
  let label = first ? '' : menuLabel || pickerLabelFor(modelId, env);
  const route = { provider, providerLabel };
  const dir = normalizeConfigDir(configDir);
  let defaults = null;
  const screen = await openSessionScreen(manager, sid);
  let attempted = false, result, menu = null, usage = null;
  // 失败时把当时的画面带回去，写进数据目录方便排查（公司电脑上的菜单长相我们看不到）。
  const fail = async message => ({ ok: false, message, screen: await screen.lines().catch(() => []) });
  const nameMatch = require('./model-name-match');
  const accountKey = () => manager.getSession?.(sid)?.codeagentPoolAccount || 'personal';
  const log = fields => require('./codeagent-models').appendModelLog(dataDir, { session: String(sid).slice(0, 8), model: modelId, ...fields });
  let substituted = null, catalogCache = null;
  // 已知目录：账号 serve 清单里的 id ↔ 菜单显示名；读不到就当空目录。
  const catalogRows = () => {
    if (catalogCache) return catalogCache;
    try { catalogCache = (require('./codeagent-models').readModelCatalog(dataDir, { configDir, accountKey: accountKey() })?.details || []).filter(row => row && row.id && row.label); }
    catch { catalogCache = []; }
    return catalogCache;
  };
  // 上次读全的菜单（只用于菜单一屏放不下时找写法），加上目录里的显示名。
  const knownMenuNames = () => {
    let cached = [];
    try { cached = dataDir ? require('./codeagent-models').readMenu(dataDir, accountKey()) : []; } catch { cached = []; }
    return [...new Set([...cached, ...catalogRows().map(row => row.label)])];
  };
  const idForLabel = name => (catalogRows().find(row => exactLabel(row.label, name)) || {}).id || name;
  // 这个模型在账号里已知的供应商（含暂不可用的、settings.json 自配的、目录里的），小写 id。
  const knownProviders = name => {
    const ids = new Set();
    try {
      for (const o of require('./codeagent-models').modelOptions(dataDir, { configDir, accountKey: accountKey(), includeUnavailable: true })) {
        if (o.provider && (exactLabel(o.id, name) || exactLabel(o.menuLabel, name) || exactLabel(o.id, modelId))) ids.add(String(o.provider).toLowerCase());
      }
    } catch { /* 读不到清单就只看目录 */ }
    for (const row of catalogRows()) {
      if (row.provider && (exactLabel(row.label, name) || exactLabel(row.id, name) || exactLabel(row.id, modelId))) ids.add(String(row.provider).toLowerCase());
    }
    return ids;
  };
  // 指定了供应商、菜单（或搜索结果）里有同名行但分组对不上（没有分组标题，或标题写法和供应商 id 不同）时，
  // 同时满足下面条件才选那一行：同名只有一行、没有截断名也像它、这一行的分组不是另一个已知供应商、
  // 并且行已看全或账号里这个模型最多一个供应商。多条同名仍按分组挑，不猜。目标分组跟随这一行，返回值仍报入参供应商。
  // 2026-11-25 同事反馈：菜单明明有 GLM-5.3-CodeAgent-Auto 却判「没有」、搜索清不掉，助理连续失败触发 4 小时熔断。
  // A provider was given and the row exists but its group does not match: take the single same-name row only when it is
  // unambiguous (no truncated lookalike, its group is not another known provider, rows fully seen or at most one known provider).
  const relaxUnique = (menu, { allSeen = false, stage = 'menu' } = {}) => {
    const rows = menu?.rows || [];
    const same = rows.map((row, index) => exactLabel(row.label, label) ? index : -1).filter(index => index >= 0);
    if (same.length !== 1) return -1;
    // 截断名带着别家「供应商/」前缀的（如 Custom 组的 cannbotprovider/deepseek-v4.1-f…）是另一条线路，不算「也像它」（R53 审查 P0）。
    const foreign = row => { const prefix = String(row?.label || '').split('/').slice(0, -1).join('/'); return !!prefix && !groupMatches(row, provider, providerLabel); };
    if (truncatedRows(rows, label).some(index => !same.includes(index) && !foreign(rows[index]))) return -1;
    const row = rows[same[0]], known = knownProviders(label), wanted = squash(provider), group = squash(row.group);
    if (group && [...known].some(id => squash(id) === group && squash(id) !== wanted)) return -1;
    if (!allSeen && known.size > 1) return -1;
    log({ event: 'group-relaxed', stage, provider, group: row.group || '(无)', label: row.label, known: known.size });
    route.provider = row.group || ''; route.providerLabel = '';
    return same[0];
  };
  // retry：Hub 自己重开菜单时保留输入行里的草稿（有字就不发、不清），不能像首次那样先清输入行。
  async function openMenu({ retry = false } = {}) {
    let sent = await sendToPty(sid, '/model', kind, { codeagentModelPick: true, ...(retry ? { preserveInput: true } : {}) });
    // 补全只接受了命令文本时可补回车，菜单已开则绝不补。
    if (sent && sent.sendStatus === 'stuck') {
      const lines = await screen.lines();
      const promptLine = lines[lines.findLastIndex(line => /^[\s─]*[❯›>]\s*/.test(line))] || '';
      if (modelDialogVisible(lines) || await waitFor(screen, modelDialogVisible, 1500).then(r => r.value)) sent = { ...sent, sendStatus: 'ok' };
      else if (/^[\s─]*[❯›>]\s*\/model\s*$/.test(promptLine)) {
        manager.writeToSession(sid, '\r');
        if ((await waitFor(screen, modelDialogVisible, screenTimeoutMs)).value) sent = { ...sent, sendStatus: 'ok' };
      }
    }
    if (!sent || sent.ok === false || sent.notSent || sent.sendStatus && sent.sendStatus !== 'ok') {
      if (sent?.notSent) attempted = false;
      return fail((sent && sent.message) || 'CodeAgent 没有确认打开模型菜单');
    }
    return null;
  }
  async function choose({ retry = false } = {}) {
    // 已有菜单时不要再把 /model 填进搜索框。明确的模型切换可接手当前菜单。
    let existingMenu = modelDialogVisible(await screen.lines());
    if (!existingMenu && readyFirstMs > 0) {
      // 认不出输入框（旧版 CodeAgent 画面不同，见 screenHasContent 的说明）等到点也照常往下走，和不等时一样。
      const seen = await waitFor(screen, lines => loginRequired(lines, manager.getSession?.(sid)) || modelDialogVisible(lines) || promptInputReady(lines), readyFirstMs);
      if (loginRequired(seen.lines, manager.getSession?.(sid))) {
        const message = 'CodeAgent 还没登录，请点击「登录」，完成后再发送。';
        manager.emit?.('session-notice', { sessionId: sid, level: 'warning', persistent: true, action: 'codeagent-login', message });
        return { ...(await fail(message)), loginRequired: true, inputReady: false, inputUsable: false };
      }
      if (seen.value) await waitForInput(screen, 3000);
      existingMenu = modelDialogVisible(await screen.lines());
    }
    attempted = true;
    if (!existingMenu) {
      const failed = await openMenu({ retry });
      if (failed) return failed;
    }
    const opened = await waitFor(screen, lines => parsePicker(lines, { allowNoCursor: true }), screenTimeoutMs);
    if (!opened.value) {
      require('./codeagent-models').appendModelLog(dataDir, { event: 'menu-cache-skipped', reason: 'unrecognized-menu' });
      return fail('当前 CodeAgent 模型菜单的布局无法自动识别，未完成模型切换');
    }
    let picker = opened.value;
    // 菜单上方的 Credit 用量和每个模型的 Token 用量：只读屏解析，不影响下面的选择（core/codeagent-usage-menu.js）
    try {
      const menuUsage = require('./codeagent-usage-menu');
      const read = await menuUsage.readUsageMenu(modelMenuLines(opened.lines), { readLines: async () => modelMenuLines(await screen.lines()),
        timeoutMs: menuUsage.PICKER_USAGE_WAIT_MS, dataDir, source: 'picker' });
      usage = read.usage;
      picker = parsePicker(read.lines, { allowNoCursor: true }) || picker;
    } catch { usage = null; }
    // 初始完整菜单只作为诊断返回；会话内搜索、翻页与选择都不写清单。
    if (picker.complete) menu = picker.rows.map(row => row.label);
    else require('./codeagent-models').appendModelLog(dataDir, { event: 'menu-cache-skipped', reason: picker.incompleteReason, rows: picker.rows.length });
    // 选第一个：认出的第一行得是菜单的第 1 项（滚动过的菜单看不到第 1 项，不猜）。光标不一定停在第 1 项（会停在上次的模型上），照常按方向键挪过去。
    if (first && (picker.rows[0].number ?? 1) !== 1) return fail(`模型菜单没有从第 1 项列起（第一行是 ${picker.rows[0].number}. ${picker.rows[0].label}），没有选`);
    if (first) label = picker.rows[0].label;
    // 同一模型的不同写法（线路前缀、内部 id、菜单显示名）：菜单里没有原样的这一行时，先按统一对照换成菜单上的写法（core/model-name-match.js）。
    if (!first && !picker.rows.some(row => exactLabel(row.label, label)) && !aliasRows(picker.rows, label).length && !truncatedRows(picker.rows, label).length) {
      const same = nameMatch.resolveName(label, picker.rows.map(row => row.label), { catalog: catalogRows() });
      const known = same.index >= 0 || picker.complete ? same : nameMatch.resolveName(label, knownMenuNames(), { catalog: catalogRows() });
      if (known.index >= 0) { log({ event: 'name-match', from: label, to: known.name, kind: known.kind }); label = known.name; }
    }
    let target = first ? 0 : findTarget(picker, label, route);
    // 指定了供应商、菜单里也有同名行，但分组对不上（菜单没有分组标题，或标题写法和供应商 id 不同）：
    // 同名行只有一条、菜单的行确定看全了时就选它，记一行日志；多条同名仍按分组挑，不猜。
    // 2026-11-25 同事反馈：菜单明明有 GLM-5.3-CodeAgent-Auto 却判「没有」，助理连续失败触发 4 小时熔断。
    // Provider given and the menu has the same name, but the group does not match (no group headings, or a heading spelled differently
    // from the provider id): pick it when it is the only same-name row and the menu is fully seen; several same-name rows still need the group.
    if (!first && target < 0 && route.provider) {
      // 只因别的行名字被截断而算「不完整」时，行是全的；带总数提示且行数不够的仍算没看全。
      const allSeen = (picker.complete || picker.incompleteReason === 'truncated-label') && (!picker.total || picker.total === picker.rows.length);
      const relaxed = relaxUnique(picker, { allSeen, stage: 'menu' });
      if (relaxed >= 0) target = relaxed;
    }
    if (!first && target >= 0 && !picker.complete && !exactRow(picker.rows[target], label, route)
      && bareLabel(picker.rows[target].label) === bareLabel(label)) target = -1;
    if (!first && !picker.rows.some(row => exactLabel(row.label, label)) && aliasRows(picker.rows, label)
      .filter(index => groupMatches(picker.rows[index], route.provider, route.providerLabel)).length > 1) {
      return { ...(await fail(`多个线路都有 ${modelId}，请重新选择带完整前缀或供应商的模型`)), requiresGroupSelection: true };
    }
    if (!provider && dataDir) {
      const accountKey = manager.getSession?.(sid)?.codeagentPoolAccount || 'personal';
      const candidates = require('./codeagent-models').modelOptions(dataDir, { configDir, accountKey }).filter(o => exactLabel(o.id, first ? label : modelId));
      if (new Set(candidates.map(o => o.provider).filter(Boolean)).size > 1) {
        // 完整清单已知同名多供应商，即使当前屏只露出一组，也不能取它。
        const group = defaultGroup(picker);
        if (!group) return { ...(await fail(`多个供应商都有 ${modelId}，请在助理设置或模型列表中选择供应商`)), requiresGroupSelection: true };
        route.provider = group;
        target = findTarget(picker, label, route);
      }
    }
    if (!provider && picker.rows.filter(row => exactLabel(row.label, label)).length > 1) {
      target = findTarget(picker, label, route);
      if (target < 0) return { ...(await fail(`多个分组都有 ${modelId}，无法确认账号默认分组，请在模型列表中重新选择带分组的项`)), requiresGroupSelection: true };
      route.provider = picker.rows[target].group;
    }
    const searchOffscreen = () => findOffscreenTarget({ picker, screen, manager, sid, label, route, relaxUnique,
        reopenMenu: async () => {
          if (!(await closeModelMenu({ readLines: () => screen.lines(), write: key => manager.writeToSession(sid, key) })).ok) return { value: null };
          if (await openMenu()) return { value: null };
          return waitFor(screen, lines => searchEmpty(lines) && parsePicker(lines, { allowNoCursor: true }), screenTimeoutMs);
        },
        onSearchFrame: lines => {
          const read = require('./codeagent-usage-menu').parseCodeAgentUsageMenu(modelMenuLines(lines));
          if (read?.models.some(model => model.day)) {
            const byName = new Map((usage?.models || []).map(model => [model.name.toLowerCase(), model]));
            for (const model of read.models) byName.set(model.name.toLowerCase(), model);
            usage = { credit: read.credit || usage?.credit || null, models: [...byName.values()] };
          }
          if (!dataDir) return;
          try {
            const file = path.join(dataDir, 'logs', 'codeagent-model-picker-search.txt');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `${new Date().toISOString()} switch-search ${modelId}\n\n${lines.join('\n')}\n`, 'utf8');
          } catch { /* 搜索画面附件失败不影响本次选择。 */ }
        },
        log });
    if (target < 0 && !first) {
      const found = await searchOffscreen();
      if (found.error) return { ...(await fail(found.error)), ...(found.requiresGroupSelection ? { requiresGroupSelection: true } : {}) };
      picker = found.picker; target = found.target;
    }
    if (target < 0 && truncatedRows(picker.rows, label).length > 1) {
      return fail(`模型菜单里有几行截断的名字都像 ${modelId}（${truncatedRows(picker.rows, label).map(index => picker.rows[index].label).join('、')}），分不清是哪一个，没有选`);
    }
    // 精确查不到：只在同家族、同版本号、Auto 一致的候选里挑唯一最接近的一个，由调用方在界面说明「已改用 X」。
    // 同版本多条线路分不出（没指定线路）、或同家族只有别的版本：不选，带 nameFallback 由调用方沿用账号默认模型并说明一行。
    // 完全没有同家族候选才是普通的「菜单里没有」，报错并列出可选项。
    let nameFallback = '';
    if (target < 0 && !first) {
      const pool = picker.complete ? picker.rows.map(row => row.label) : [...new Set([...picker.rows.map(row => row.label), ...knownMenuNames()])];
      const near = nameMatch.resolveName(label, pool, { catalog: catalogRows(), allowSimilar: true });
      if (near.index >= 0 && !exactLabel(near.name, label)) {
        log({ event: 'name-match', from: label, to: near.name, kind: near.kind });
        if (near.kind === 'similar') substituted = { from: modelId, to: near.name };
        label = near.name;
        target = picker.rows.findIndex(row => exactLabel(row.label, label) && groupMatches(row, route.provider, route.providerLabel));
        if (target < 0 && !picker.complete) {
          const found = await searchOffscreen();
          if (!found.error && found.target >= 0) { picker = found.picker; target = found.target; }
        }
      } else if (near.kind === 'ambiguous' || (near.sameFamily || []).length) {
        nameFallback = nameMatch.fallbackNote(modelId, near);
        log({ event: 'name-match', from: label, result: near.kind === 'ambiguous' ? 'ambiguous' : 'other-version-only' });
      }
    }
    if (target < 0) {
      const options = picker.complete ? picker.rows.map(row => row.label) : [...new Set([...picker.rows.map(row => row.label), ...knownMenuNames()])];
      // 菜单里其实有同名（或截断名像它）、只是分组消歧没选：算匹配问题（menuMiss，不计熔断）；菜单里确实没有这个名字仍计熔断。
      const sameName = picker.rows.some(row => exactLabel(row.label, label)) || truncatedRows(picker.rows, label).length > 0;
      return { ...(await fail(`模型菜单里没有 ${modelId}（菜单里有：${options.join('、')}）`)), ...(sameName ? { menuMiss: true } : {}), ...(nameFallback ? { nameFallback } : {}) };
    }
    if (picker.cursor < 0) {
      manager.writeToSession(sid, '\x1b[B');
      const focused = await waitForPickerChange(screen, pickerSignature(picker), MODEL_SEARCH_WAIT_MS);
      if (!focused.value) return fail('无法确认模型列表的选中项，没有选择模型');
      picker = focused.value; target = findTarget(picker, label, route);
      if (target < 0) return { ...(await fail(`模型菜单里没有 ${modelId}`)), ...(picker.rows.some(row => exactLabel(row.label, label)) ? { menuMiss: true } : {}) };
    }
    // 可见目标仍沿用行号差逐键移动；跨屏搜索/翻页已逐步确认。选择键之前再读一次光标，
    // 镜像尚未更新时不猜选中项，之后仍以 CLI 自己的回显核对结果。
    if (tookOver()) return { ...(await fail('你已在终端里操作，Hub 不再替你选模型')), tookOver: true };
    const steps = target - picker.cursor;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      manager.writeToSession(sid, steps > 0 ? '\x1b[B' : '\x1b[A');
      await sleep(150);
    }
    await sleep(300);
    const selectedLabel = picker.rows[target].label;
    // 回车前核对光标：终端重绘（切会话、改窗口大小会让 CLI 整屏重画）的一瞬间读到的可能是半帧，稍等再读几次；
    // 菜单整个不见了（CLI 重画时把菜单关了）标 menuVanished，由下面重开一次菜单再选（2026-11-28 黄区真机：新会话就绪后马上发第一句，
    // 启动选模型 2/2 失败在这里，第一句被「原模型不可用」挡回）。
    const onTarget = p => !!p && exactLabel(p.rows[p.cursor]?.label, selectedLabel) && groupMatches(p.rows[p.cursor], route.provider, route.providerLabel);
    let checked = parsePicker(await screen.lines());
    for (let i = 0; i < 5 && !onTarget(checked); i += 1) { await sleep(300); checked = parsePicker(await screen.lines()); }
    if (!onTarget(checked)) {
      const vanished = !checked && !modelDialogVisible(await screen.lines());
      // 排查用：核对时光标所在行、各行分组与目标，写进模型日志（不含会话正文）。
      log({ event: 'pick-check-failed', target: `${selectedLabel}@${picker.rows[target].group || '-'}#${target}/${picker.cursor}`,
        route: route.provider || '-', vanished, cursor: checked ? `${checked.rows[checked.cursor]?.label || '-'}@${checked.rows[checked.cursor]?.group || '-'}#${checked.cursor}` : '(无菜单)',
        rows: checked ? checked.rows.map(row => `${row.label}@${row.group || '-'}`).join('+') : '' });
      return { ...(await fail(`未确认光标已移到 ${selectedLabel} 的目标分组，没有选择模型`)), ...(vanished ? { menuVanished: true } : {}) };
    }
    const restoreSnapshot = dir && !keepDefault ? snapshotDefaults(dir) : [];
    const mode = picker.sessionKey && !keepDefault ? 'session' : 'default';
    const mark = typeof manager.getSessionOutputMark === 'function' ? manager.getSessionOutputMark(sid) : null;
    // 重试那一轮在按回车前再核一次会话执行：中途被原地重拉（epoch 变了）或关掉，就不往新一轮里按键。
    if (tookOver()) return { ...(await fail('你已在终端里操作，或会话在选模型期间被重拉/关闭，没有选择模型')), tookOver: true };
    manager.writeToSession(sid, mode === 'session' ? picker.sessionKey : '\r');
    const echo = mark == null ? null : await waitForEcho(manager, sid, mark, screenTimeoutMs, screen);
    // CLI 可能在回显之后才把默认模型写进配置：看住一段时间，被改就改回，最后核对（按 s 只改本会话时也看，防菜单行为变化）。
    let restored = [];
    if (restoreSnapshot.length) {
      defaults = await guardDefaults(restoreSnapshot, { durationMs: mode === 'default' ? guardMs : Math.min(guardMs, 1200), onChange: onDefaultChange });
      defaults.dir = dir;
      restored = defaults.restored;
      if (!defaults.verified) {
        return { ...(await fail(`CodeAgent 把默认模型改成了 ${defaults.after || '（空）'}，Hub 没能改回 ${defaults.before || '（空）'}`)), restored, defaults };
      }
    }
    // 回显可能用菜单上的显示名（例如「Sonnet 5.5」），也可能用模型名：两种都算对。
    const echoMatches = echo && [modelId, label, picker.rows[target].label].some(name => squash(name) && echo.startsWith(squash(name)));
    // 选第一个不核对名字：菜单上的显示名和回显可以不同（替身实录：第 1 项「Default」，回显「Opus 5.5 … for this session only」）。
    if (echo && !echoMatches && !first) {
      return { ...(await fail(`CodeAgent 回显选中的不是 ${modelId}（回显：${echo.slice(0, 30)}）`)), restored, defaults };
    }
    const ready = await waitForInput(screen);
    if (!ready.value) return { ...(await fail('选中后未确认恢复普通输入框')), restored, defaults };
    return { ok: true, mode, confirmed: !!echo, restored, defaults, provider: provider || route.provider || picker.rows[target].group || '',
      ...(keepDefault ? { keptDefault: true } : {}), ...(first ? { picked: label } : {}),
      ...(substituted ? { substituted: { ...substituted, id: idForLabel(substituted.to) } } : {}) };
  }
  // 「菜单不见了」不等于「没人选」：用户可能在后台终端里自己选了别的模型、正在打字，或者会话已经重拉/关掉。
  // 只有同一个会话、开始以来没有用户按键、输入行是空的，才由 Hub 重开菜单再选；否则一个键都不再写。
  const startedAt = Date.now();
  const execution = sessionExecution(manager, sid);
  const modelBefore = statusModel(await screen.lines().catch(() => []));
  let handsOff = false;
  // 每次实际按键前、以及收尾时都核一次：用户在终端里按过键，或会话被重拉/关闭，Hub 就不再写任何键。
  const tookOver = () => !!userInputSince(sid, startedAt) || (!!execution && !sameExecution(execution, manager, sid));
  async function retryDecision() {
    if (!sameExecution(execution, manager, sid)) return { retry: false, why: 'session-changed' };
    const lines = await screen.lines().catch(() => []);
    const input = userInputSince(sid, startedAt);
    if (input) {
      const now = statusModel(lines);
      if (now && modelBefore && squash(now) !== squash(modelBefore)) return { retry: false, why: 'user-picked', userPicked: now, input: input.sample };
      return { retry: false, why: 'user-active', input: input.sample };
    }
    if (!promptInputReady(lines)) return { retry: false, why: 'input-not-empty' };
    return { retry: true };
  }
  // 用户接手或会话换了：不再写任何键；用户在终端里选了别的模型就沿用他的选择。
  async function handOff(stage, extra = {}) {
    const decision = await retryDecision();
    log({ event: 'pick-retry-skipped', reason: stage, ...extra, ...(decision.why ? { why: decision.why } : {}), ...(decision.userPicked ? { userPicked: decision.userPicked } : {}), ...(decision.input ? { input: decision.input } : {}) });
    handsOff = true;
    attempted = false; // 不再替用户关菜单、删字
    if (decision.userPicked) result = { ok: true, mode: 'user', confirmed: true, userPicked: decision.userPicked, inputReady: true };
  }
  try {
    result = await choose();
    if (result?.tookOver) await handOff('took-over');
    // 菜单在回车前被 CLI 重画关掉了：没按回车、什么也没选。等画面安静下来（启动时 MCP 还在连）再重开菜单选，最多再试两次。
    for (let retry = 1; !handsOff && retry <= 2 && !result?.ok && result?.menuVanished; retry += 1) {
      const quiet = await waitQuiet(screen);
      const decision = await retryDecision();
      if (!decision.retry) { await handOff('menu-vanished', { retry, quiet }); break; }
      log({ event: 'pick-retry', reason: 'menu-vanished', retry, quiet });
      result = await choose({ retry: true });
      if (result?.tookOver) { await handOff('took-over', { retry }); break; }
    }
  } catch (error) {
    if (error?.notSent) attempted = false;
    result = await fail(error && error.message ? error.message : String(error));
  } finally {
    // 发过 /model 即须负责退出，不能等“解析成功”后才承担清理责任。
    try {
      if (handsOff || tookOver()) {
        // 用户在终端里接手了（或会话已换）：不写任何键，只如实报告输入框现状。
        const lines = await screen.lines().catch(() => []);
        result = { ...result, inputReady: promptInputReady(lines), inputUsable: promptInputReady(lines) };
      } else if (!result?.loginRequired) {
        const closed = attempted ? await closeModelMenu({ readLines: () => screen.lines(), write: key => manager.writeToSession(sid, key) }) : null;
        let ready = closed?.ok ? { value: true } : await waitForInput(screen);
        // Esc 只关掉补全列表时，「/model」还留在输入行里（2026-10-20 发布闸门实录）：没有菜单时退格清掉，再确认一次。
        if (!ready.value && attempted && !modelDialogVisible(await screen.lines())) {
          for (let i = 0; i < 12; i += 1) { manager.writeToSession(sid, '\x7f'); await sleep(30); }
          ready = await waitForInput(screen);
        }
        // inputUsable：认不出普通输入框（旧版 CodeAgent 画面不同，见 screenHasContent），但菜单已关、输入行没留着「/model」。
        // 自动会话据此照常把问题发出去（main/ipc/session-handlers.js runCodeAgentPick）；用户会话仍按 inputReady 处理。
        result = { ...result, inputReady: !!ready.value, inputUsable: !!ready.value || inputUsableAfterPick(await screen.lines(), manager.getSession?.(sid)) };
        if (!ready.value) result = { ...result, ok: false, message: `${result?.message || '模型操作尚未完成'}；尚未确认恢复普通输入框` };
      }
    } catch (error) {
      result = { ...result, ok: false, inputReady: false,
        message: `${result?.message || '模型操作失败'}；退出菜单失败：${error && error.message ? error.message : String(error)}` };
    } finally {
      screen.dispose();
    }
  }
  // 会话内菜单仅供诊断，调用方不得据此改写后台探测清单或菜单缓存。
  // 读到的用量表：调用方按账号记快照（core/codeagent-usage-menu.js recordUsage），额度条和模型下拉显示。
  if (usage) result = { ...result, usage };
  if (!result.ok && !result.loginRequired) {
    require('./codeagent-models').appendModelLog(dataDir, { event: 'pick-menu-failed', session: String(sid).slice(0, 8), model: modelId, error: result.message });
    const pickFailure = pickFailureKind(result);
    result = { ...result, technicalReason: result.message, pickFailure,
      message: result.requiresGroupSelection ? result.message : result.nameFallback || pickFailureMessage(pickFailure, modelId) };
  }
  return menu ? { ...result, menu } : result;
}

// 选不上的三种情况分开说（R53，2026-11-27 同事反馈「deepseek-v4.1-flash 用不了」：以前一律说「这个账号选不了」，
// 用户分不清是账号没开通还是 Hub 没对上菜单）。
//   absent      菜单读到了、搜过也翻过，确实没有这个名字：多半是账号没开通，换一个模型；
//   unconfirmed 已在菜单里按了选择键，只是没等到 CodeAgent 回到普通输入框：去后台看一眼；
//   mismatch    其余：菜单布局没认出、光标没对上、同名行分不清等，是 Hub 没对上菜单，不是账号没有，去后台手动选一次。
// Three failure kinds: the model is really absent from the menu, the pick was sent but not confirmed, or Hub could not match the menu.
function pickFailureKind(result) {
  const reason = String(result?.message || '');
  // 菜单里确实没有、但退出菜单没确认（终端还停在菜单里）：也给「打开后台」去关掉它，不当成单纯的「没有」（R53 审查 P2）。
  if (/^模型菜单里没有 /.test(reason) && !result.menuMiss && result.inputReady !== false) return 'absent';
  if (/^选中后未确认恢复普通输入框|^CodeAgent 回显选中的不是|^CodeAgent 把默认模型改成了/.test(reason)) return 'unconfirmed';
  return 'mismatch';
}
function pickFailureMessage(kind, modelId) {
  if (kind === 'absent') return `CodeAgent 模型菜单里没有 ${modelId}，这个账号可能没开通它；请换一个菜单里有的模型`;
  if (kind === 'unconfirmed') return `已在 CodeAgent 模型菜单里选了 ${modelId}，但没等到它回到输入框；请点「打开后台」看一眼终端`;
  return `Hub 没能在 CodeAgent 模型菜单里自动选中 ${modelId}（菜单没对上，不一定是账号没有这个模型）；请点「打开后台」在菜单里手动选一次`;
}

// ---------------------------------------------------------------- 排队与第一条消息的闸门
const pending = new Map(); // sid → Promise
const failures = new Map(); // 完成不等于成功；pending 删除后仍须保护后来的正文。
let queue = Promise.resolve();
function notSent(message, code = 'codeagent-model-pick-failed') {
  return Object.assign(new Error(message), { notSent: true, code });
}
function failureMessage(result, inputReady) {
  if (result?.loginRequired) return result.message;
  const reason = require('./message-text').reasonText(result?.message, '所选模型未完成切换');
  return inputReady
    ? `${reason}。普通输入框已恢复，本条消息未发送；再次发送将沿用 CodeAgent 当前模型，也可以先重新选择模型。`
    : `${reason}。本条消息未发送；请点“后台”退出模型菜单，恢复普通输入框后再发送，或重新选择模型。`;
}
// 同一时间只做一次：回车方式会改写共用的默认模型，几个会话并发选会互相覆盖快照。
function schedulePick(sid, task) {
  const run = queue.then(task, task).then(result => {
    if (result?.ok) failures.delete(sid);
    else failures.set(sid, { result, reported: false });
    return result;
  }, error => {
    failures.set(sid, { result: { ok: false, inputReady: false, message: error?.message || String(error) }, reported: false });
    throw error;
  });
  queue = run.catch(() => {});
  const tracked = run.finally(() => { if (pending.get(sid) === tracked) pending.delete(sid); });
  pending.set(sid, tracked);
  tracked.catch(() => {});
  return tracked;
}
async function waitForPick(sid, timeoutMs = 150000) {
  const task = pending.get(sid);
  if (!task) return;
  // 上限只能让这次提交明确失败，不能放行正文穿过仍在操作的菜单。
  let timer = null;
  const limit = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(notSent(
    'CodeAgent 仍在处理模型选择，本条消息未发送；请稍后再发送或到“后台”查看菜单。', 'codeagent-model-pick-timeout')), timeoutMs); });
  try {
    const result = await Promise.race([task, limit]);
    if (!result?.ok) {
      const failure = failures.get(sid);
      if (failure) failure.reported = true;
      if (result?.inputReady) failures.delete(sid);
      throw Object.assign(notSent(failureMessage(result, result?.inputReady)), { modelMenuClosed: result?.inputReady === true || result?.inputUsable === true });
    }
    return result;
  } catch (error) {
    if (error.notSent) throw error;
    const failure = failures.get(sid);
    if (failure) failure.reported = true;
    throw notSent(failureMessage(failure?.result || { message: error?.message || String(error) }, false));
  }
  finally { clearTimeout(timer); }
}
function isPicking(sid) { return pending.has(sid); }

// 认不出普通输入框时，只要画面不是空白、又没有菜单或选择框，就照常发送（与 1.0.6 一致）。
// 2026-10-16 同事反馈：CodeAgent 1.2605.05.01（比本机的 1.2615 旧）的画面和规则对不上，2.1.0 起每条消息都被退回，
// CLI 里直接打字却能发。闸门的本意是「别把正文打进菜单或选择框」：只在明确看到它们时才拦，不按版本号逐个适配
// （用户：「输入框不一样就不敢发了，很蠢……我们没法保证所有用户都是最新版本」）。空白屏仍然拦：CLI 还没画出来。
function screenHasContent(lines) {
  return lines.some(line => line.trim());
}

// 选模型收尾后能不能照常发问题（不要求认出普通输入框）：没有能认出的菜单、没有菜单的标题或底栏残留、
// 最下面的输入行没留着「/model」、画面不是空白。认不出就当不能用，走原来的失败路径。
// 「↑↓」类操作提示：菜单或选择框还开着（旧版/汉化界面的底栏写法不一，宁可当成没关）。
const MENU_TRACES = /Select model|Switch model|选择模型|切换模型|Navigate\s*↑\s*↓|↑\s*\/?\s*↓|Back\s+esc|⌕\s*Search/i;
function loginRequired(lines, session) {
  // 已完成对话的会话不再按正文里的登录词拦截；首轮只检查底部六行非空内容。
  return !session?.lastCompletedAt && require('./codeagent-model-probe').NEEDS_LOGIN.test(
    lines.filter(line => line.trim()).slice(-6).join('\n'));
}
function inputUsableAfterPick(lines, session) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  if (loginRequired(screen, session)) return false;
  if (!screenHasContent(screen) || modelDialogVisible(screen) || screen.some(line => MENU_TRACES.test(line))) return false;
  const promptLine = screen[screen.findLastIndex(line => /^\s*(?:[│┃]\s*)?[─\s]*[❯›>]/.test(line))] || '';
  return !/[❯›>]\s*\/model\b/i.test(promptLine);
}

async function beforePrompt(manager, sid, { allowUnready = false, isChoiceDialog = null } = {}) {
  const rejectPending = () => {
    if (isPicking(sid)) throw notSent('CodeAgent 正在切换模型，本条消息未发送；切换完成后再发送。', 'codeagent-model-pick-pending');
  };
  let screen;
  try {
    // 入队之后才开始的 picker 可能把 /model 排在本条后面；此处只能拒绝，不能等它造成自锁。
    rejectPending();
    // 真实 SessionManager 都有屏幕快照；精简替身仍可用当前输出检查已知菜单。
    screen = typeof manager.getSessionBufferSnapshot === 'function' ? await openSessionScreen(manager, sid) : null;
    const lines = screen ? await screen.lines() : String(manager.getSessionBuffer?.(sid) || '').split(/\r?\n/);
    rejectPending();
    if (loginRequired(lines, manager.getSession?.(sid))) {
      const message = 'CodeAgent 尚未登录或登录已过期，本条消息未发送。请点击「登录」，完成后再发送。';
      manager.emit?.('session-notice', { sessionId: sid, level: 'warning', persistent: true, action: 'codeagent-login', message });
      throw notSent(message, 'codeagent-login-required');
    }
    const failure = failures.get(sid);
    const inputReady = promptInputAvailable(lines);
    const menuOpen = modelDialogVisible(lines);
    // 选择框只看当前屏幕：整段历史里启动时出现过的框不算（旧版启动弹过一次框，之后会一直被当成还开着）。
    const choiceOpen = !inputReady && typeof isChoiceDialog === 'function' && !!isChoiceDialog(lines.join('\n'));
    const usable = inputReady || (!menuOpen && !choiceOpen && screenHasContent(lines));
    if (failure) {
      // 输入框已恢复时提示并继续本条消息，不要求用户重复发送。
      if (usable) {
        failures.delete(sid);
        manager.emit?.('session-notice', { sessionId: sid, level: 'warning', persistent: true,
          message: `${require('./message-text').reasonText(failure.result?.message, '自动选择模型没成功')}。输入框已恢复，本条消息将沿用 CodeAgent 当前模型发送；也可以重新选择模型。` });
      } else {
        failure.reported = true;
        throw notSent(failureMessage(failure.result, usable));
      }
    }
    if (menuOpen) throw notSent(
      'CodeAgent 当前仍在模型选择界面，本条消息未发送；请点“后台”退出菜单，恢复普通输入框后再发送。', 'codeagent-model-menu-open');
    if (choiceOpen) throw notSent(
      'CodeAgent 正在等你在终端里做选择，本条消息未发送；请点“后台”处理完后再发送。', 'cli-choice-pending');
    if (!usable && !allowUnready) throw notSent(
      '尚未确认 CodeAgent 的普通输入框，本条消息未发送；请等会话启动完成，或点“后台”查看并退出选择菜单后再发送。', 'codeagent-input-not-ready');
    if (!inputReady && usable && !allowUnready) console.warn(`[codeagent] ${String(sid).slice(0, 8)} input frame not recognized; sending (no menu or choice dialog on screen)`);
  } catch (error) {
    if (error.notSent) throw error;
    throw notSent(`无法确认 CodeAgent 当前输入位置，本条消息未发送：${error?.message || String(error)}`, 'codeagent-input-check-failed');
  } finally { screen?.dispose(); }
}

function resetFailure(sid) { failures.delete(sid); }

module.exports = {
  waitQuiet,
  waitForInput,
  noteUserInput,
  statusModel,
  FIRST_MENU_MODEL,
  isFirstMenuModel,
  parsePicker,
  pickFailureKind,
  modelMenuLines,
  closeModelMenu,
  collectModelMenu,
  modelDialogVisible,
  promptInputReady,
  promptInputAvailable,
  inputUsableAfterPick,
  findTarget,
  confirmationSeen,
  pickerLabelFor,
  snapshotDefaults,
  restoreDefaults,
  guardDefaults,
  normalizeConfigDir,
  modelAllowed,
  openSessionScreen,
  pickModel,
  schedulePick,
  waitForPick,
  isPicking,
  beforePrompt,
  resetFailure,
};
