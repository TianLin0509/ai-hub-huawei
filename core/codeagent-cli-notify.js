'use strict';
// CodeAgent 自己的「完成提醒」开不开（2026-11-19 首版，反馈 1ce04c14：答完时 CodeAgent 和 Hub 各提醒一次，想只留一个；
// 2026-11-20 用户：Hub 自己有通知或桌宠时才关，用户可改回）。
// CodeAgent 的界面库（OpenTUI）答完会向终端发一条桌面通知转义序列（OSC 777/99/9），自己不调系统通知；
// 在 Windows Terminal 等支持它的终端里就会弹一条系统通知。官方开关是环境变量 OPENTUI_NOTIFICATIONS=0（只关通知，不影响其他终端能力）。
// 三档（存在数据目录 codeagent-cli-notify.json，只影响之后新开或重启的会话）：
//   - auto（默认）：Hub 自己在提醒（桌面回执不是「关闭」，或桌宠开着）时，新开的 CodeAgent 会话带上 OPENTUI_NOTIFICATIONS=0；
//     Hub 回执选了「关闭」且没开桌宠时不带，免得两边都不提醒；
//   - hub：总是只留 Hub 的；
//   - own：不管 Hub，CodeAgent 自己也提醒。
// 用户自己在环境里设过 OPENTUI_NOTIFICATIONS / OPENTUI_NOTIFICATION_PROTOCOL 的，照用户的来，不覆盖。
// 只改这次新建的子进程环境副本，不动 Hub 的 process.env，也不碰用户的 CodeAgent 配置文件。
const fs = require('fs');
const path = require('path');

const FILE = 'codeagent-cli-notify.json';
const MODES = Object.freeze(['auto', 'hub', 'own']);
const ENV_KEYS = ['OPENTUI_NOTIFICATIONS', 'OPENTUI_NOTIFICATION_PROTOCOL'];

function dataDirOf(dataDir) { return dataDir || require('./data-dir').getHubDataDir(); }

// 11-19 首版只存 own 布尔：勾过「CodeAgent 自己也提醒」的算 own，其余回到默认 auto。
function getMode(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDirOf(dataDir), FILE), 'utf8'));
    if (MODES.includes(raw.mode)) return raw.mode;
    return raw.own === true ? 'own' : 'auto';
  } catch { return 'auto'; }
}

function setMode(mode, dataDir) {
  if (!MODES.includes(mode)) throw new Error('不认识的提醒档位：' + mode);
  const dir = dataDirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  require('./atomic-write').writeFileAtomic(fs, path.join(dir, FILE), JSON.stringify({ mode, at: new Date().toISOString() }, null, 1));
  return mode;
}

// Hub 自己会不会提醒：桌面回执三档不是「关闭」（pet 档在桌宠没开时也会弹右下角小卡），或桌宠开着。
// 读不到桌宠设置时按默认值（回执 pet 档＝会提醒）。
function hubNotifies(dataDir) {
  const petSettings = require('./hub-pet/settings');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dataDirOf(dataDir), petSettings.FILE), 'utf8')); } catch {}
  const s = petSettings.normalize(raw, petSettings.defaults());
  return s.notifyMode !== 'off' || s.enabled === true;
}

function state(dataDir) {
  const mode = getMode(dataDir);
  const hub = hubNotifies(dataDir);
  return { mode, hubNotifies: hub, suppress: mode === 'hub' || (mode === 'auto' && hub) };
}

function applyCliNotifyEnv(env, { dataDir, suppress } = {}) {
  if (!env) return env;
  const off = typeof suppress === 'boolean' ? suppress : state(dataDir).suppress;
  if (!off) return env;
  // 空值等于没设（OpenTUI 也按自动探测处理），只有非空值才算用户自己定过。
  const keys = Object.keys(env).filter(k => String(env[k] ?? '').trim()).map(k => k.toUpperCase());
  if (ENV_KEYS.some(k => keys.includes(k))) return env;
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'OPENTUI_NOTIFICATIONS') delete env[k];
  env.OPENTUI_NOTIFICATIONS = '0';
  return env;
}

module.exports = { FILE, MODES, getMode, setMode, hubNotifies, state, applyCliNotifyEnv };
