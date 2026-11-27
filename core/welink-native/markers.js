'use strict';
//
// 读屏判断全部集中在这一处：CodeAgent 改了文案时只会「认不出」——退化为不保护、不重连，
// 不会误杀、误发、误输入。现场急修不用发版：在 Hub 数据目录放 `welink-native/markers.json`
// （同名键，结构同下）即可覆盖。
//
// 依据：实验成员在 CodeAgent CLI 1.2615.02.05、Windows ConPTY 下的实测标记表 v1（2026-11-27）。
// CodeAgent 是整屏重绘的全屏界面，所以判断基于「渲染后的整屏文字」（./screen.js），不按字节流逐行找。
//
// 结构：
//   页面（pages）：每项是若干「组」，组内所有条件同时满足才算（AND），任一组满足即可（OR）；
//                  条件以 `!` 开头表示「屏幕上不能有」。按 PAGE_ORDER 的先后取第一个命中的页面。
//   连接状态（link）：同一屏里谁最后出现算谁（状态行反复重画时以最新一次为准）。
//                  只认同一行带 WeLink / 助手字样的状态行；原文等建好助手后的实测 v2，先按常见写法占位。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MARKERS = Object.freeze({
  pages: {
    // S5 填 AppID / AppKey 页：用户输入的凭据会显示在框里。Hub 只提示用户自己填，这一页整屏不留、不送键。
    appIdForm: [['Connect enter', 'AppKey:'], ['AppKey:', 'AppID:']],
    // S4 二维码 / 链接页（等扫码）
    needScan: [['Waiting for scan', 'Refresh r'], ['请用 ?weLink 扫描二维码', '(?:Waiting for scan|Refresh r)']],
    // S10 白名单未开：/welink 菜单里没有「扫码新建」这一项（反推判据，本机无法复现）
    notWhitelisted: [['Connect to Welink', 'Confirm enter', '!Scan QR code']],
    // S3 /welink 菜单（扫码新建 / 填已有 AppID）
    welinkMenu: [['Select 1/2', 'Connect to Welink'], ['Confirm enter', 'Connect to Welink']],
    // 选已有助手（非首次）：空格是「连接 / 断开」开关，不是确认——已连接时再按会断开。原文待实测 v2
    pickExisting: [['(?:已有助手|选择助手|existing (?:bot|assistant))', '(?:空格|Space|space)']],
    // S0 新目录首次启动的信任确认
    trustFolder: [['Accessing workspace:', 'Yes, I trust this folder']],
    // S6 帮助面板（排除用）
    helpPage: [['Help \\|\\s+general\\s+commands']],
    // S1 主输入框空闲：占位提示只在框里没字时出现，用户正在打字时它就消失——天然的「别送键」信号
    idle: [['Anything I can assist you with\\?']],
  },
  // 只认同一行里带 WeLink / 助手字样的状态行（审查 2026-11-27：正文里的「Database connected」「not connected」不算）。
  link: {
    connected: [
      'WeLink[^\\n]{0,40}(?<![A-Za-z])(?<!not )connected(?![A-Za-z])',
      '(?<![A-Za-z])(?<!not )connected(?![A-Za-z])[^\\n]{0,40}WeLink',
      '(?:WeLink|助手)[^\\n]{0,40}(?<![未不])(?:已连接|连接成功|在线)',
      '(?:已连接|连接成功)[^\\n]{0,20}(?:WeLink|助手)',
    ],
    disconnected: [
      'WeLink[^\\n]{0,40}(?:disconnected|not connected|offline)',
      '(?:disconnected|not connected)[^\\n]{0,40}WeLink',
      '(?:WeLink|助手)[^\\n]{0,40}(?:未连接|已断开|连接断开|断开连接|连接已断开|不在线|离线)',
    ],
    connecting: [
      'WeLink[^\\n]{0,40}(?<![A-Za-z])connecting(?![A-Za-z])',
      '(?:WeLink|助手)[^\\n]{0,40}(?:连接中|正在连接)',
    ],
  },
  // 用户回车提交的那一行（2.0 旧版叫 /welink-access）。只是候选：还要看到 WeLink 连接页才算真的进了连接流程。
  command: ['^\\s*/welink(?:-access)?\\s*$'],
});

// 这些页面出现，才说明 /welink 真的打开了 WeLink 连接流程
const WELINK_PAGES = Object.freeze(['appIdForm', 'needScan', 'notWhitelisted', 'welinkMenu', 'pickExisting']);
const PAGE_ORDER = Object.freeze(['appIdForm', 'needScan', 'notWhitelisted', 'welinkMenu', 'pickExisting', 'trustFolder', 'helpPage', 'idle']);
const LINK_KEYS = Object.freeze(['connected', 'disconnected', 'connecting']);

function re(source, flags) {
  if (typeof source !== 'string' || !source || source.length > 400) return null;
  try { return new RegExp(source, flags); } catch { return null; }
}
function compileList(list, flags) { return (Array.isArray(list) ? list : []).map(s => re(s, flags)).filter(Boolean); }
function compileGroups(groups) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!Array.isArray(group) || !group.length) continue;
    const conds = group.map(src => {
      const neg = typeof src === 'string' && src.startsWith('!');
      const r = re(neg ? src.slice(1) : src, 'i');
      return r ? { re: r, neg } : null;
    });
    if (conds.every(Boolean)) out.push(conds); // 组里有一条写错就整组不用，免得 AND 变宽
  }
  return out;
}

// 读覆盖文件（只读，不写）；读不到或格式不对就用默认值。
function readOverride(dataDir) {
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'welink-native', 'markers.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

function loadMarkers({ dataDir, override } = {}) {
  const extra = override || readOverride(dataDir) || {};
  const pages = {};
  for (const key of PAGE_ORDER) {
    const custom = extra.pages && Array.isArray(extra.pages[key]) ? compileGroups(extra.pages[key]) : [];
    pages[key] = custom.length ? custom : compileGroups(DEFAULT_MARKERS.pages[key]);
  }
  const link = {};
  for (const key of LINK_KEYS) {
    const custom = extra.link && Array.isArray(extra.link[key]) ? compileList(extra.link[key], 'gi') : [];
    link[key] = custom.length ? custom : compileList(DEFAULT_MARKERS.link[key], 'gi');
  }
  const customCommand = compileList(extra.command, 'i');
  return { pages, link, command: customCommand.length ? customCommand : compileList(DEFAULT_MARKERS.command, 'i') };
}

function groupHit(text, conds) { return conds.every(c => { c.re.lastIndex = 0; return c.re.test(text) !== c.neg; }); }
function pageOf(text, markers) {
  for (const key of PAGE_ORDER) if ((markers.pages[key] || []).some(g => groupHit(text, g))) return key;
  return 'unknown';
}

// 某类标记在 text 里最后一次出现的结束位置；没有就是 -1。
function lastIndexOf(text, regexes) {
  let best = -1;
  for (const r of regexes || []) {
    r.lastIndex = 0;
    if (!r.global) { const m = r.exec(text); if (m) best = Math.max(best, m.index + m[0].length); continue; }
    let m, guard = 0;
    while ((m = r.exec(text)) && guard++ < 1000) {
      best = Math.max(best, m.index + m[0].length);
      if (m[0].length === 0) r.lastIndex += 1;
    }
  }
  return best;
}
function linkOf(text, markers) {
  let state = 'unknown', at = -1;
  for (const key of LINK_KEYS) { const i = lastIndexOf(text, markers.link[key]); if (i > at) { at = i; state = key; } }
  return state;
}

module.exports = { DEFAULT_MARKERS, WELINK_PAGES, PAGE_ORDER, LINK_KEYS, loadMarkers, pageOf, linkOf, lastIndexOf };
