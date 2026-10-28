'use strict';

// PTY Claude 会话的推理档切换（2026-10-24）。
// 9-25 Claude 改回 PTY 运行后，推理档 chip 只剩原生会话可点；这里给 PTY 会话补上同一能力：
//   1. 经 group-chat-watcher.sendToPty（PTY 正规提交入口）发 `/effort <档>`；
//   2. 以会话自己的 transcript 为准确认：Claude 会写一行 local-command-stdout，
//      实测样本（Claude Code 2.1.310）：
//        Set effort level to high (saved as your default for new sessions): ...
//        Set effort level to max (this session only): ...
//        Effort level set to auto
//   3. `/effort` 顺手把账号 settings.json 的 effortLevel 改成默认值；chip 只改当前会话，
//      所以确认后把 effortLevel 还原成切换前的值（与 /model 的默认值保护同一原则）。
const fs = require('fs');
const path = require('path');

// 只开放 Hub 重启会话时能沿用的档位（session-manager 的 CLAUDE_EFFORT_LEVELS）。
const PTY_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function effortConfirmed(text, level) {
  const escaped = String(level).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:set effort level to ${escaped}(?![a-z])|effort level set to ${escaped}(?![a-z]))`, 'i').test(String(text || ''));
}

function readTail(file, offset) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size - offset, 1024 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function effortLevelOf(file) {
  const settings = readSettings(file);
  return settings && Object.hasOwn(settings, 'effortLevel') ? { had: true, value: settings.effortLevel } : { had: false };
}

// 只动 effortLevel 这一个键；别的键以磁盘上最新内容为准。
function restoreEffortLevel(file, before) {
  const settings = readSettings(file);
  if (!settings) return false;
  const current = Object.hasOwn(settings, 'effortLevel') ? settings.effortLevel : undefined;
  if (before.had ? current === before.value : current === undefined) return false;
  if (before.had) settings.effortLevel = before.value; else delete settings.effortLevel;
  const temp = `${file}.hub-effort-${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return true;
}

// 发送走 group-chat-watcher.sendToPty 的 localCommandObserver（与 Codex /fast 同一模式）：
// 本地命令不触发 UserPromptSubmit，由确认器以 transcript 判定成功，不补回车、不进命令记录。
function transcriptObserver(transcriptPath, level, { wait, timeoutMs }) {
  const offset = fileSize(transcriptPath);
  return {
    async wait() {
      for (let waited = 0; waited <= timeoutMs; waited += 100) {
        if (effortConfirmed(readTail(transcriptPath, offset), level)) return { ok: true };
        await wait(100);
      }
      return { ok: false, message: 'Claude 没有确认这次切换，档位保持不变' };
    },
    dispose() {},
  };
}

async function setPtyClaudeEffort({ session, effort, send, configDir, wait = ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs = 8000 }) {
  const level = String(effort || '').trim().toLowerCase();
  if (!PTY_CLAUDE_EFFORTS.includes(level)) return { ok: false, message: '思考档无效：' + effort };
  if (!session?.transcriptPath) return { ok: false, message: '会话记录还没绑定，请先发一条消息后再切换推理档' };
  const settingsFile = path.join(configDir, 'settings.json');
  const before = effortLevelOf(settingsFile);
  const observer = transcriptObserver(session.transcriptPath, level, { wait, timeoutMs });
  const sent = await send('/effort ' + level, observer);
  if (!sent?.ok || sent.notSent || sent.sendStatus === 'stuck') {
    return { ok: false, message: sent?.message || 'Claude 没有确认这次切换，档位保持不变' };
  }
  // Claude 写 settings.json 与写 transcript 的先后不固定：等它落盘（最多 1.5 秒）再还原默认值。
  let restored = false;
  for (let waited = 0; waited <= 1500 && !restored; waited += 100) {
    try { restored = restoreEffortLevel(settingsFile, before); } catch { /* 被占用时下一轮再试 */ }
    if (!restored) await wait(100);
  }
  return { ok: true, effort: level, defaultRestored: restored };
}

module.exports = { PTY_CLAUDE_EFFORTS, effortConfirmed, restoreEffortLevel, effortLevelOf, setPtyClaudeEffort };
