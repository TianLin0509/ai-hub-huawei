'use strict';
// CodeAgent 版本过旧提醒（2026-10-27，公司版）。同事反馈老版本 CodeAgent 下卡片视图不显示回答：
// 卡片读的是 CodeAgent 3.0 起才有的 hooks 与 ~/.cac/projects/…/*.jsonl 会话记录（2.5 及以前存在 SQLite 里）。
// 公司回执 Q-1027-12：`codeagent --version` 输出形如「1.2615.02.01 (codeAgentCLI)」；升级用 `codeagent update`
// （TUI 里 /update），或到 CSOP 软件中心下载 Cli3.0-Setup.exe 重装。门槛取 Hub 实测通过的版本，也是公司手册上的最新版。
const MIN_VERSION = '1.2615.02.01';
// 公司内网下载页只随公司版发出（community/targets/company/overlay/core/codeagent-upgrade.json），其他发行版没有这个文件就不显示「打开下载页」。
// yellowZoneDownload 是最新版安装包的云盘直链，只有黄区网络能打开，界面上要标「黄区专用」。
const UPGRADE_LINKS = (() => {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'codeagent-upgrade.json'), 'utf8')) || {}; } catch { return {}; }
})();
const DOWNLOAD_PAGE = String(UPGRADE_LINKS.downloadPage || '') || null;
const YELLOW_ZONE_DOWNLOAD = String(UPGRADE_LINKS.yellowZoneDownload || '') || null;

function parse(version) {
  const m = /^(\d+(?:\.\d+)*)/.exec(String(version || '').trim());
  return m ? m[1].split('.').map(Number) : null;
}

// 按数字逐段比（1.2615.02.01 与 1.2615.2.1 视为相同，缺的段当 0）；读不懂返回 null。
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// 只在明确读出版本且低于门槛时提醒；读不出版本不打扰（可能是没装或命令被改名）。
function isOutdated(version, min = MIN_VERSION) {
  return compare(version, min) === -1;
}

async function check({ probe, installed }) {
  if (!installed) return { installed: false, outdated: false, min: MIN_VERSION };
  try {
    const version = await probe();
    return { installed: true, version, min: MIN_VERSION, outdated: isOutdated(version), downloadPage: DOWNLOAD_PAGE, yellowZoneDownload: YELLOW_ZONE_DOWNLOAD };
  } catch (error) {
    return { installed: true, version: null, min: MIN_VERSION, outdated: false, error: error.message };
  }
}

module.exports = { MIN_VERSION, DOWNLOAD_PAGE, YELLOW_ZONE_DOWNLOAD, compare, isOutdated, check };
