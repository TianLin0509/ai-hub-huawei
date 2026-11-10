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

const CURSOR_GLYPHS = '❯›▶>';
// 行首可能残留没擦干净的旧字符（「erva4. Sonnet」，2026-10-14 替身实录），所以「编号.」不要求在行首；
// 靠下面「编号连续」和「含模型名」两道筛选排除正文。
const NUMBERED_ROW = new RegExp(`(?:^|[^\\d.])([${CURSOR_GLYPHS}])?\\s*(\\d{1,2})\\.\\s+(\\S.*?)\\s*$`);
const BARE_CURSOR_ROW = new RegExp(`^(\\s*)([${CURSOR_GLYPHS}])\\s+(\\S.*?)\\s*$`);
const MODEL_WORDS = /\b(?:GLM|MiniMax|DeepSeek|Qwen|Kimi|Default|Auto|Opus|Sonnet|Haiku|Fable)\b|模型/i;
const SESSION_ONLY_KEY = /(?:^|[\s·|])([a-z])\s+to\s+use\s+(?:this|for this)\s+session\s+only/i;

const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
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
    // 屏幕镜像里可能还留着菜单的旧画面（TUI 重绘没擦干净）：取最靠下、也就是最新的那一份。
    rows = runs.filter(run => run.length >= minRows && (run.some(r => r.cursor) || allowNoCursor && codeagentFrame)).pop() || [];
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
  return (rows || []).reduce((hits, row, index) => truncatedNameMatches(row.label, label) ? [...hits, index] : hits, []);
}
// 搜索与翻页用：名字完全相同（不分大小写）优先，其次唯一命中的截断名。
function locateLabel(rows, label) {
  const exact = (rows || []).findIndex(row => exactLabel(row.label, label));
  if (exact >= 0) return exact;
  const cut = truncatedRows(rows, label);
  return cut.length === 1 ? cut[0] : -1;
}

// 目标在哪一行：模型名完全相同优先，其次唯一命中的截断名，再次以它开头，最后整行包含。
function findTarget(picker, label) {
  const want = squash(label);
  if (!picker || !want) return -1;
  const exact = picker.rows.findIndex(row => squash(row.label) === want);
  if (exact >= 0) return exact;
  const cut = truncatedRows(picker.rows, label);
  if (cut.length) return cut.length === 1 ? cut[0] : -1;
  const prefix = picker.rows.findIndex(row => squash(row.label).startsWith(want));
  if (prefix >= 0) return prefix;
  return picker.rows.findIndex(row => squash(row.text).includes(want));
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
    return { exists: true, model: value && typeof value.model === 'string' ? value.model : undefined };
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
// 只把这次被菜单改掉的 model 键改回去，其余内容原样保留。
// 原来没有这份文件、CodeAgent 新建了它并写了 model：只去掉 model 键。
function restoreDefaults(snapshot) {
  const restored = [];
  for (const before of snapshot) {
    if (before.unreadable) continue;
    let raw;
    try { raw = fs.readFileSync(before.file, 'utf8'); } catch { continue; }
    let value;
    try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { continue; }
    const now = value && typeof value.model === 'string' ? value.model : undefined;
    if (now === before.model) continue;
    if (before.model === undefined) delete value.model; else value.model = before.model;
    const temp = `${before.file}.hub-model-${process.pid}.tmp`;
    // Windows 上 CLI 或杀毒正读着 settings.json 时覆盖改名会短暂 EPERM：有界重试，否则用户的默认模型会被留成菜单改过的值。
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); require('./claude-project-trust').renameWithRetrySync(temp, before.file, { retries: process.platform === 'win32' ? 20 : 0, retryCodes: new Set(['EPERM', 'EBUSY']) }); restored.push(path.basename(before.file)); }
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
      if (!now.exists || now.unreadable || now.model === before.model) continue;
      // 改回失败（文件被占用、权限等）不能停在被改后的值：记下原因，下一拍接着重试，看守结束时仍没改回就由 verified:false 报出。
      let done = [], error = '';
      try { done = restoreDefaults([before]); } catch (e) { error = e && e.message ? e.message : String(e); }
      const after = readModelKey(before.file).model;
      const change = { file: path.basename(before.file), written: now.model, restoredTo: before.model, ok: after === before.model, ...(error ? { error } : {}) };
      changes.push(change);
      if (done.length) restored.add(change.file);
      try { onChange && onChange(change); } catch { /* 只是记日志 */ }
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  const verified = snapshot.every(before => before.unreadable || !readModelKey(before.file).exists || readModelKey(before.file).model === before.model);
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

async function waitForInput(screen, timeoutMs = 3000) {
  let previous = '', readySince = 0;
  return waitFor(screen, lines => {
    if (!promptInputReady(lines)) { readySince = 0; return false; }
    const text = lines.join('\n');
    if (!readySince || text !== previous) { previous = text; readySince = Date.now(); }
    // Esc 后输入框必须真实恢复且稳定；不能只睡一拍就把正文当 Alt+键送进去。
    return Date.now() - readySince >= 320;
  }, timeoutMs);
}

const exactLabel = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
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

async function findOffscreenTarget({ picker, screen, manager, sid, label, log, reopenMenu, onSearchFrame }) {
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
    let found = searched.value && locateLabel(searched.value.rows, label);
    if (Number.isInteger(found) && found >= 0) {
      picker = searched.value;
      let searchSteps = 0;
      while (picker.cursor !== found && searchSteps++ < MODEL_SCROLL_LIMIT) {
        const prior = pickerSignature(picker), down = found > picker.cursor;
        manager.writeToSession(sid, down ? '\x1b[B' : '\x1b[A');
        searched = await waitForPickerChange(screen, prior, MODEL_SEARCH_WAIT_MS);
        if (!searched.value) break;
        picker = searched.value;
        found = locateLabel(picker.rows, label);
        if (found < 0) break;
      }
      if (picker.cursor >= 0 && locateLabel(picker.rows, label) === picker.cursor) {
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
  const seen = new Set(), truncated = new Set(), limit = picker.total || MODEL_SCROLL_LIMIT;
  const identityOf = row => JSON.stringify([row.number, row.label]);
  const noteTruncated = () => { for (const index of truncatedRows(picker.rows, label)) truncated.add(identityOf(picker.rows[index])); };
  let steps = 0;
  while (steps < limit) {
    const row = picker.rows[picker.cursor], identity = identityOf(row);
    if (exactLabel(row.label, label)) { log({ event: 'switch-scroll', steps, result: 'found' }); return { picker, target: picker.cursor }; }
    noteTruncated();
    if (seen.has(identity)) break;
    seen.add(identity);
    const before = pickerSignature(picker);
    manager.writeToSession(sid, '\x1b[B'); steps++;
    const next = await waitForPickerChange(screen, before, MODEL_SEARCH_WAIT_MS);
    if (!next.value) break;
    picker = next.value;
  }
  if (exactLabel(picker.rows[picker.cursor]?.label, label)) { log({ event: 'switch-scroll', steps, result: 'found' }); return { picker, target: picker.cursor }; }
  noteTruncated();
  if (truncated.size === 1) {
    const [only] = truncated;
    for (let back = 0; back <= steps + 1; back += 1) {
      const row = picker.rows[picker.cursor];
      if (row && identityOf(row) === only) { log({ event: 'switch-scroll', steps, back, result: 'found-truncated' }); return { picker, target: picker.cursor }; }
      const before = pickerSignature(picker);
      manager.writeToSession(sid, '[A');
      const next = await waitForPickerChange(screen, before, MODEL_SEARCH_WAIT_MS);
      if (!next.value) break;
      picker = next.value;
    }
  }
  log({ event: 'switch-scroll', steps, result: truncated.size > 1 ? 'ambiguous-truncated' : 'not-found', ...(truncated.size ? { truncated: truncated.size } : {}) });
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
async function pickModel({ manager, sid, kind, modelId, configDir, dataDir, sendToPty, screenTimeoutMs = 8000, guardMs = 3500, onDefaultChange = null, env = process.env, readyFirstMs = 0, keepDefault = false }) {
  const first = isFirstMenuModel(modelId);
  let label = first ? '' : pickerLabelFor(modelId, env);
  const dir = normalizeConfigDir(configDir);
  let defaults = null;
  const screen = await openSessionScreen(manager, sid);
  let attempted = false, result, menu = null, usage = null;
  // 失败时把当时的画面带回去，写进数据目录方便排查（公司电脑上的菜单长相我们看不到）。
  const fail = async message => ({ ok: false, message, screen: await screen.lines().catch(() => []) });
  async function openMenu() {
    let sent = await sendToPty(sid, '/model', kind, { codeagentModelPick: true });
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
  async function choose() {
    // 已有菜单时不要再把 /model 填进搜索框。明确的模型切换可接手当前菜单。
    let existingMenu = modelDialogVisible(await screen.lines());
    if (!existingMenu && readyFirstMs > 0) {
      // 认不出输入框（旧版 CodeAgent 画面不同，见 screenHasContent 的说明）等到点也照常往下走，和不等时一样。
      const seen = await waitFor(screen, lines => modelDialogVisible(lines) || promptInputReady(lines), readyFirstMs);
      if (seen.value) await waitForInput(screen, 3000);
      existingMenu = modelDialogVisible(await screen.lines());
    }
    attempted = true;
    if (!existingMenu) {
      const failed = await openMenu();
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
    let target = first ? 0 : findTarget(picker, label);
    if (target < 0 && !first) {
      const found = await findOffscreenTarget({ picker, screen, manager, sid, label,
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
        log: fields => require('./codeagent-models').appendModelLog(dataDir, { session: String(sid).slice(0, 8), model: modelId, ...fields }) });
      if (found.error) return fail(found.error);
      picker = found.picker; target = found.target;
    }
    if (target < 0 && truncatedRows(picker.rows, label).length > 1) {
      return fail(`模型菜单里有几行截断的名字都像 ${modelId}（${truncatedRows(picker.rows, label).map(index => picker.rows[index].label).join('、')}），分不清是哪一个，没有选`);
    }
    if (target < 0) return fail(`模型菜单里没有 ${modelId}（菜单里有：${picker.rows.map(row => row.label).join('、')}）` );
    if (picker.cursor < 0) {
      manager.writeToSession(sid, '\x1b[B');
      const focused = await waitForPickerChange(screen, pickerSignature(picker), MODEL_SEARCH_WAIT_MS);
      if (!focused.value) return fail('无法确认模型列表的选中项，没有选择模型');
      picker = focused.value; target = findTarget(picker, label);
      if (target < 0) return fail(`模型菜单里没有 ${modelId}`);
    }
    // 可见目标仍沿用行号差逐键移动；跨屏搜索/翻页已逐步确认。选择键之前再读一次光标，
    // 镜像尚未更新时不猜选中项，之后仍以 CLI 自己的回显核对结果。
    const steps = target - picker.cursor;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      manager.writeToSession(sid, steps > 0 ? '\x1b[B' : '\x1b[A');
      await sleep(150);
    }
    await sleep(300);
    const selectedLabel = picker.rows[target].label;
    const checked = parsePicker(await screen.lines());
    if (!checked || !exactLabel(checked.rows[checked.cursor]?.label, selectedLabel)) return fail(`未确认光标已移到 ${selectedLabel}，没有选择模型`);
    const restoreSnapshot = dir && !keepDefault ? snapshotDefaults(dir) : [];
    const mode = picker.sessionKey && !keepDefault ? 'session' : 'default';
    const mark = typeof manager.getSessionOutputMark === 'function' ? manager.getSessionOutputMark(sid) : null;
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
    const echoMatches = echo && [label, picker.rows[target].label].some(name => squash(name) && echo.startsWith(squash(name)));
    // 选第一个不核对名字：菜单上的显示名和回显可以不同（替身实录：第 1 项「Default」，回显「Opus 5.5 … for this session only」）。
    if (echo && !echoMatches && !first) {
      return { ...(await fail(`CodeAgent 回显选中的不是 ${modelId}（回显：${echo.slice(0, 30)}）`)), restored, defaults };
    }
    const ready = await waitForInput(screen);
    if (!ready.value) return { ...(await fail('选中后未确认恢复普通输入框')), restored, defaults };
    return { ok: true, mode, confirmed: !!echo, restored, defaults, ...(keepDefault ? { keptDefault: true } : {}), ...(first ? { picked: label } : {}) };
  }
  try {
    result = await choose();
  } catch (error) {
    if (error?.notSent) attempted = false;
    result = await fail(error && error.message ? error.message : String(error));
  } finally {
    // 发过 /model 即须负责退出，不能等“解析成功”后才承担清理责任。
    try {
      const closed = attempted ? await closeModelMenu({ readLines: () => screen.lines(), write: key => manager.writeToSession(sid, key) }) : null;
      let ready = closed?.ok ? { value: true } : await waitForInput(screen);
      // Esc 只关掉补全列表时，「/model」还留在输入行里（2026-10-20 发布闸门实录）：没有菜单时退格清掉，再确认一次。
      if (!ready.value && attempted && !modelDialogVisible(await screen.lines())) {
        for (let i = 0; i < 12; i += 1) { manager.writeToSession(sid, '\x7f'); await sleep(30); }
        ready = await waitForInput(screen);
      }
      // inputUsable：认不出普通输入框（旧版 CodeAgent 画面不同，见 screenHasContent），但菜单已关、输入行没留着「/model」。
      // 自动会话据此照常把问题发出去（main/ipc/session-handlers.js runCodeAgentPick）；用户会话仍按 inputReady 处理。
      result = { ...result, inputReady: !!ready.value, inputUsable: !!ready.value || inputUsableAfterPick(await screen.lines()) };
      if (!ready.value) result = { ...result, ok: false, message: `${result?.message || '模型操作尚未完成'}；尚未确认恢复普通输入框` };
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
  if (!result.ok) {
    require('./codeagent-models').appendModelLog(dataDir, { event: 'pick-menu-failed', session: String(sid).slice(0, 8), model: modelId, error: result.message });
    result = { ...result, technicalReason: result.message, message: `这个账号在 CodeAgent 模型菜单里选不了 ${modelId}` };
  }
  return menu ? { ...result, menu } : result;
}

// ---------------------------------------------------------------- 排队与第一条消息的闸门
const pending = new Map(); // sid → Promise
const failures = new Map(); // 完成不等于成功；pending 删除后仍须保护后来的正文。
let queue = Promise.resolve();
function notSent(message, code = 'codeagent-model-pick-failed') {
  return Object.assign(new Error(message), { notSent: true, code });
}
function failureMessage(result, inputReady) {
  const reason = result?.message || '所选模型未完成切换';
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
function inputUsableAfterPick(lines) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
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
    const failure = failures.get(sid);
    const inputReady = promptInputAvailable(lines);
    const menuOpen = modelDialogVisible(lines);
    // 选择框只看当前屏幕：整段历史里启动时出现过的框不算（旧版启动弹过一次框，之后会一直被当成还开着）。
    const choiceOpen = !inputReady && typeof isChoiceDialog === 'function' && !!isChoiceDialog(lines.join('\n'));
    const usable = inputReady || (!menuOpen && !choiceOpen && screenHasContent(lines));
    if (failure) {
      // 选模型失败已经提示过一次、菜单也关了：之后的消息照常发，不再一直退回。
      if (usable) failures.delete(sid);
      if (!usable || !failure.reported) {
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
  FIRST_MENU_MODEL,
  isFirstMenuModel,
  parsePicker,
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
