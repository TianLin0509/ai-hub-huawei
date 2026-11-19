'use strict';
// CodeAgent 自己的「完成提醒」开不开（2026-11-19，反馈 1ce04c14：答完时 CodeAgent 和 Hub 各提醒一次，想只留一个）。
// CodeAgent 的界面库（OpenTUI）答完会向终端发一条桌面通知转义序列（OSC 777/99/9）；在 Windows Terminal 等终端里
// 就会再弹一条系统通知，和 Hub 的桌面回执重复。官方开关是环境变量 OPENTUI_NOTIFICATIONS=0（只关通知，不影响其他终端能力）。
//   - 默认只留 Hub 的：新开的 CodeAgent 会话带上 OPENTUI_NOTIFICATIONS=0；
//   - 设置里「桌面回执」下勾上「CodeAgent 自己也提醒」就不带（Hub 的那份可在同一处选「关闭」）；
//   - 用户自己在环境里设过 OPENTUI_NOTIFICATIONS / OPENTUI_NOTIFICATION_PROTOCOL 的，照用户的来，不覆盖。
// 开关存在数据目录 codeagent-cli-notify.json；只影响之后新开或重启的会话。
const fs = require('fs');
const path = require('path');

const FILE = 'codeagent-cli-notify.json';
const ENV_KEYS = ['OPENTUI_NOTIFICATIONS', 'OPENTUI_NOTIFICATION_PROTOCOL'];

function dataDirOf(dataDir) { return dataDir || require('./data-dir').getHubDataDir(); }

function getCliNotify(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDirOf(dataDir), FILE), 'utf8')).own === true; } catch { return false; }
}

function setCliNotify(own, dataDir) {
  const dir = dataDirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  require('./atomic-write').writeFileAtomic(fs, path.join(dir, FILE), JSON.stringify({ own: !!own, at: new Date().toISOString() }, null, 1));
  return !!own;
}

// 改的是这次新建的子进程环境副本，不动 Hub 自己的 process.env。
function applyCliNotifyEnv(env, { own = getCliNotify() } = {}) {
  if (!env || own) return env;
  const keys = Object.keys(env).map(k => k.toUpperCase());
  if (ENV_KEYS.some(k => keys.includes(k))) return env;
  env.OPENTUI_NOTIFICATIONS = '0';
  return env;
}

module.exports = { getCliNotify, setCliNotify, applyCliNotifyEnv, FILE };
