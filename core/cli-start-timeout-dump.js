'use strict';
// CLI 冷启动超时（就绪检查 60 秒没过）时，把终端最后一屏单独存一份，失败提示里带上路径
// 起因：同事说「CodeAgent 起不来」时，只看得到一句「会话还没就绪」，看不到它当时停在哪一屏。
// HUB-H 已有 logs/codeagent-startup-blocks.log（滚动日志、进一键反馈），这里补「每次一份、提示里给路径」的现场文件。
// 文件放 Hub 数据目录 diagnostics/cli-start-timeouts，只保留最新 KEEP 份；内容按一键反馈同一口径脱敏（用户目录、用户名、密钥）。
const fs = require('fs');
const path = require('path');

const KEEP = 50;
const SCREEN_LINES = 40;
const RAW_TAIL = 4000;

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function lastScreen(buf) {
  const text = require('./group-chat-cli-ready-detector').terminalText(String(buf || '').slice(-20000));
  const lines = String(text || '').split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-SCREEN_LINES).join('\n');
}

function scrub(text) {
  try { return require('./env-check').sanitize(text); } catch { return String(text || ''); }
}

/** 写一份超时现场，返回文件路径；写不了返回 ''（只是诊断，不影响主流程）。 */
function dumpStartTimeout({ dataDir, sid, kind, buf, waitedMs, now = new Date() }) {
  try {
    const dir = path.join(dataDir || require('./data-dir').getHubDataDir(), 'diagnostics', 'cli-start-timeouts');
    fs.mkdirSync(dir, { recursive: true });
    const safeSid = String(sid || 'unknown').replace(/[^\w-]/g, '').slice(0, 8) || 'unknown';
    const safeKind = String(kind || 'cli').replace(/[^\w-]/g, '').slice(0, 20) || 'cli';
    const file = path.join(dir, `${stamp(now)}-${safeSid}-${safeKind}.txt`);
    const raw = String(buf || '');
    const body = [
      `会话 ${safeSid}  后端 ${safeKind}  等了 ${Math.round((Number(waitedMs) || 0) / 1000)} 秒仍未识别到输入框`,
      `终端累计 ${raw.length} 字符；下面是还原成文字后的最后 ${SCREEN_LINES} 行（已去掉用户目录、用户名和密钥）：`,
      '----',
      scrub(lastScreen(raw)),
      '----',
      '原始字节末尾（JSON 转义，同样脱敏）：',
      // 先脱敏再转义（审查阻断）：转义后路径里的反斜杠成双、换行成了字面转义符，用户目录对不上、token 规则会把后面整段吞掉。
      JSON.stringify(scrub(raw.slice(-RAW_TAIL))),
      '',
    ].join('\n');
    fs.writeFileSync(file, body, 'utf8');
    prune(dir);
    return file;
  } catch { return ''; }
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.txt')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP))) fs.unlinkSync(path.join(dir, name));
  } catch { /* 清理失败下次再清 */ }
}

/** 这个会话最近 withinMs 内落过的现场文件（最新一份）；没有返回 ''。给「发送超时」这类不经过就绪检查返回值的提示补路径用。 */
function recentDumpFor({ dataDir, sid, withinMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  try {
    const dir = path.join(dataDir || require('./data-dir').getHubDataDir(), 'diagnostics', 'cli-start-timeouts');
    const safeSid = String(sid || '').replace(/[^\w-]/g, '').slice(0, 8);
    if (!safeSid) return '';
    const hit = fs.readdirSync(dir).filter(name => name.endsWith('.txt') && name.includes(`-${safeSid}-`))
      .map(name => path.join(dir, name)).map(file => ({ file, at: fs.statSync(file).mtimeMs }))
      .filter(x => now - x.at <= withinMs).sort((x, y) => y.at - x.at)[0];
    return hit ? hit.file : '';
  } catch { return ''; }
}

module.exports = { dumpStartTimeout, recentDumpFor, lastScreen, KEEP };
