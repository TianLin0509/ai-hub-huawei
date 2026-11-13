'use strict';

// 用户自己的 Codex 配置（~/.codex/config.toml，或用户自设的 CODEX_HOME）归用户所有。
//
// 以前 Hub 每次启动 Codex 都往这份全局配置里补 [notice] 和 [windows] sandbox 两组设置，
// 改写方式是正则拼接，遇到以下写法会把文件写坏，Hub 里外的 Codex 都起不来：
//   1. 用户原有 [windows] sandbox = "elevated"（Codex 自己的沙箱设置会写这一行）：
//      替换时正则吞掉前面的换行，变成 `[windows]sandbox = "unelevated"`，TOML 语法错误；
//   2. 用户用点号键 `windows.sandbox = ...` / 内联表 `windows = {...}`、表头后带注释
//      `[windows] # ...`、或 `notice.xxx = ...`：Hub 认不出，又追加一个 [windows]/[notice]，
//      Codex 报 duplicate key。
// 现在这些设置一律经启动命令的 -c 传入，只在本次会话生效，不再写用户的文件。
// 本模块负责两件事：判断一个 CODEX_HOME 是不是 Hub 自己的；把旧版本写坏的文件修回来。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HUB_STATUS_LINE = '["model-with-reasoning", "context-remaining", "current-dir"]';

function codexStatusLineConfigArg(configDir, { fsModule = fs, env = process.env, homeDir = os.homedir() } = {}) {
  const home = configDir || env.CODEX_HOME || path.join(env.USERPROFILE || env.HOME || homeDir, '.codex');
  try {
    // Preserve an existing status line and the old # status_line opt-out.
    if (fsModule.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('status_line')) return '';
  } catch (error) { if (error.code !== 'ENOENT') return ''; }
  return ` -c 'tui.status_line=${HUB_STATUS_LINE}'`;
}

function norm(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

/** CODEX_HOME 是否在 Hub 数据目录之下（API 档、公司模型、账号运行时等 Hub 自建目录）。 */
function isHubOwnedCodexHome(codexHome, hubDataDir) {
  if (!codexHome || !hubDataDir) return false;
  const home = norm(codexHome);
  const root = norm(hubDataDir);
  return home === root || home.startsWith(root + path.sep.toLowerCase()) || home.startsWith(root + '/');
}

// Hub 旧版本写过的键：[节名, 键, Hub 写入的值]
const HUB_KEYS = [
  ['windows', 'sandbox', '"unelevated"'],
  ['notice', 'hide_rate_limit_model_nudge', 'true'],
  ['notice', 'hide_full_access_warning', 'true'],
];
const HUB_KEY_LINE = new RegExp(`^(?:${HUB_KEYS.map(([, k, v]) => `${k}\\s*=\\s*${v}`).join('|')})\\s*$`);

function isBareHeader(line, section) {
  return line.trim() === `[${section}]`;
}

// 同一个节在文件里除「标准 [节名] 表头」之外的其他定义方式。
function otherDefinitions(lines, section) {
  let found = 0;
  let inRoot = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      inRoot = false;
      const m = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/);
      if (m && m[1] === section && line !== `[${section}]`) found += 1; // [ windows ] / [windows] # 注释
      continue;
    }
    if (inRoot && new RegExp(`^${section}\\s*(\\.|=)`).test(line)) found += 1; // 点号键 / 内联表
  }
  return found;
}

/**
 * 修复 Hub 旧版本写坏的 Codex 配置文本。只处理 Hub 自己写入的形状，别的内容原样保留。
 * @returns {{ text: string, changed: boolean, fixes: string[] }}
 */
function repairHubCodexConfigText(input) {
  const original = String(input || '');
  // 按 \n 切、行尾 \r 留在行内，原文的换行风格（含混用）原样保留。
  let lines = original.split('\n');
  const fixes = [];

  // 1. 粘行：Hub 替换已有键时吞掉了换行，Hub 的键被接在上一行末尾。
  const next = [];
  for (const rawLine of lines) {
    const cr = rawLine.endsWith('\r') ? '\r' : '';
    const line = cr ? rawLine.slice(0, -1) : rawLine;
    const m = line.match(/^(.*\S)(sandbox = "unelevated"|hide_rate_limit_model_nudge = true|hide_full_access_warning = true)\s*$/);
    // 前半截是表头（以 ] 结尾）或另一条键值（含 =）才算粘行；`my_sandbox = ...`、
    // `windows.sandbox = ...`、行尾注释里的文字这类合法写法不满足，原样保留。
    if (m && !m[1].includes('#') && (/\]\s*$/.test(m[1]) || m[1].includes('='))) {
      // 被覆盖前的原值已经丢失。sandbox 只会在原值不是 unelevated 时被改写，
      // Codex 自己的沙箱设置写的是 "elevated"，按它还原，不替用户改选择。
      const restored = m[2].startsWith('sandbox') ? 'sandbox = "elevated"' : m[2];
      next.push(m[1] + cr, restored + cr);
      fixes.push(`拆开粘在一起的一行：${line.trim()}`);
      continue;
    }
    next.push(rawLine);
  }
  lines = next;

  // 2. 重复定义：Hub 追加的 [windows]/[notice] 块与用户原有的其他写法冲突时，删掉 Hub 的块。
  for (const section of ['windows', 'notice']) {
    const bareIdx = lines.map((l, i) => (isBareHeader(l, section) ? i : -1)).filter(i => i >= 0);
    if (!bareIdx.length) continue;
    const conflicts = otherDefinitions(lines, section) + bareIdx.length - 1;
    if (conflicts <= 0) continue;
    // 从后往前找只含 Hub 键的块，删到不再冲突为止。
    let remaining = conflicts;
    for (const start of [...bareIdx].reverse()) {
      if (remaining <= 0) break;
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
      const body = lines.slice(start + 1, end).filter(l => l.trim());
      if (!body.length || !body.every(l => HUB_KEY_LINE.test(l.trim()))) continue;
      // 连同块前一个空行一起删，保持文件整洁。
      const from = start > 0 && !lines[start - 1].trim() ? start - 1 : start;
      lines.splice(from, end - from);
      fixes.push(`删除与原有写法重复的 [${section}] 块`);
      remaining -= 1;
    }
  }

  // The old startup writer appended exactly this [tui] block. Scan statements
  // so a header inside a multiline string cannot be mistaken for a real table.
  try {
    const { samePath, scanTomlStatements } = require('./toml-statements');
    const { statements } = scanTomlStatements(lines.join('\n'));
    for (let index = statements.length - 1; index >= 0; index -= 1) {
      const header = statements[index];
      if (header.kind !== 'table' || !samePath(header.path, ['tui']) || lines[header.startLine].trim() !== '[tui]') continue;
      const body = [];
      for (let j = index + 1; j < statements.length && statements[j].kind === 'kv'; j += 1) body.push(statements[j]);
      if (body.length !== 1 || !samePath(body[0].path, ['tui', 'status_line']) || body[0].valueText !== HUB_STATUS_LINE
          || body[0].startLine !== header.startLine + 1 || body[0].endLine !== body[0].startLine
          || lines[body[0].startLine].trim() !== `status_line = ${HUB_STATUS_LINE}`) continue;
      const conflict = statements.slice(0, index).some(item =>
        item.kind !== 'kv' ? samePath(item.path, ['tui']) : item.table.length === 0 && item.path[0] === 'tui');
      if (!conflict) continue;
      const from = header.startLine > 0 && !lines[header.startLine - 1].trim() ? header.startLine - 1 : header.startLine;
      lines.splice(from, body[0].endLine - from + 1);
      fixes.push('删除与原有写法重复的 [tui] 块');
    }
  } catch { /* 无法识别结构时不猜测删除用户的 [tui] 内容 */ }

  const text = lines.join('\n');
  return { text, changed: text !== original, fixes };
}

/**
 * 修复用户 Codex 配置文件；只在确实识别到 Hub 旧版本的损坏形状时写盘，写前备份原文件。
 */
function repairUserCodexConfigFile(configPath, { logger = console, now = () => new Date() } = {}) {
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); }
  catch (error) { return { changed: false, fixes: [], error: error.code === 'ENOENT' ? null : error.message }; }
  const result = repairHubCodexConfigText(text);
  if (!result.changed) return { changed: false, fixes: [] };
  const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const backup = `${configPath}.hub-repair-${stamp}.bak`;
  try {
    fs.copyFileSync(configPath, backup);
    fs.writeFileSync(configPath, result.text, 'utf8');
    logger.log?.(`[codex-config] 已修复 Hub 旧版本写坏的 ${configPath}（${result.fixes.join('；')}），原文件备份为 ${backup}`);
    return { changed: true, fixes: result.fixes, backup };
  } catch (error) {
    logger.warn?.(`[codex-config] 修复 ${configPath} 失败：${error.message}`);
    return { changed: false, fixes: [], error: error.message };
  }
}

module.exports = { isHubOwnedCodexHome, repairHubCodexConfigText, repairUserCodexConfigFile, codexStatusLineConfigArg };
