'use strict';
// 可选功能（2026-10-30 用户）：公司版的助理、论坛、考勤（2026-11-07）、桌宠默认都关，用户在设置菜单「可选功能」里自己开。
// 起因：同事反馈电脑卡、鼠标漂移；这些功能不用也一直在后台取数、开隐藏浏览器窗口、挂鼠标钩子，不想用的人白付开销。
// 助理、论坛的开关记在数据目录 optional-features.json；桌宠沿用自己的 hub-pet.json（main.js 把三者拼成一张清单）。
// 文件不存在 = 第一次用这一版：一律关（老用户原来是被默认打开的，不是自己选的，同样关一次）。
// 低开销模式（2026-11-23，同事反馈「一启动风扇就转、开两个会话内存很高」）：新装默认开，后台功能全关、用到哪项在它的页面上一键开；
// 老用户升级不改任何开关，只提示一次。设置页「资源与后台」集中开关并显示各项当前占用。
const fs = require('fs');
const path = require('path');

const FILE = 'optional-features.json';

// 设置菜单「可选功能」里每一项的说明：用来做什么、开着有什么开销。
const CATALOG = Object.freeze({
  assistant: { name: '助理', desc: '整理每日简报、提醒待处理的 WeLink 消息，并回答工作问题。会议和会议室可以单独使用。', cost: '开着时工作日每 10 分钟后台读一次 WeLink，每分钟检查一次登录' },
  forum: { name: '帖子', desc: '公司发文（政策讲话、公司文件、公告）和心声、稼先今天的热帖，附 AI 摘要；发文上新会提醒', cost: '开着时工作日早上在后台用无头 Edge（借本机 Edge 的登录状态，不弹窗）取一次，之后每小时只重看发文；没登录会每 30 分钟重试' },
  attendance: { name: '考勤', desc: '读自己的打卡记录，统计加班、80 小时红线和年度工时', cost: '开着时每天在后台打开一次考勤页（隐藏窗口，取不到时用无头 Edge），当天取到就不再访问' },
  w3: { name: '门户待办', desc: '读公司门户首页上自己的待办、提的申请和公司文件；新待办、拖了很久的待办和卡住的申请会提醒', cost: '开着时每天早上 6 点后在后台用无头 Edge 打开一次门户首页（约 10 秒、不弹窗），当天取到就不再访问；页面上可随时手动刷新' },
  // 会议室（2026-11-19 反馈 1b517a0b：占后台资源希望能关）：老用户默认开——行为不变；新装在低开销模式下默认关。
  rooms: { name: '会议室', desc: '按你的规则每天放号时自动抢订会议室，结果和快开会了由桌宠或通知卡提醒', cost: '开着时每 15 秒看一次抢订结果；打开过会议室页后，后台常驻一个会议室组件进程（约几十到一百多 MB 内存）' },
  tray: { name: '关窗口时最小化到托盘', desc: '点窗口右上角的关闭只把 Hub 收到右下角托盘，会话照常在后台跑；单击托盘图标打开，右键「退出 AI Hub」才真正退出', cost: '几乎没有，只多一个托盘图标' },
  // 多开提示（2026-11-20 体验 7）：默认开；已开着 Hub 时再打开会问「切过去？」。经常有意开两个的人可以关掉。
  multiOpen: { name: '再打开 Hub 时提示切过去', desc: '已经开着一个 AI Hub 时再双击图标，先问一句「已在运行，切过去？」；选「再开一个」照样能开两个', cost: '没有，只在打开 Hub 时看一眼' },
  pet: { name: '桌宠', desc: '桌面角落的小猫：会话答完、提醒、会议室结果都由它举卡片告诉你，右键还能问助理', cost: '开着时一直有一个置顶的小窗口，每 0.1 秒看一次光标是否碰到它' },
  // 低开销模式新纳入开关的三项：以前没有开关、一直在后台跑。老用户升级后保持开（行为不变），新装默认关。
  liveMeter: { name: '底栏网速与显卡读数', desc: '左下角的 ↓↑ 实时网速和 GPU 占用；CPU、内存读数不受影响', cost: '开着时常驻一个 PowerShell 读网卡（约 150 MB 内存），每 10 秒运行一次 nvidia-smi 读显卡' },
  searchIndex: { name: '后台会话搜索索引', desc: '启动后趁电脑空闲给历史会话建搜索索引，之后跟着新会话自动更新，搜索时立刻出结果', cost: '第一次要扫描全部会话记录（记录多时要几分钟，磁盘和 CPU 都会忙），之后常驻一个搜索进程并监听会话目录。关着时搜索照样能用，第一次搜时当场建索引' },
  // 社区统计（2026-11-24）：默认开、不提示；不是后台开销，低开销模式与新装判定都不动它。
  // settingsOnly：不在「可选功能」里列出，开关放在设置 › 高级 › 隐私 的「纯离线模式」（反着存：纯离线开＝本项关）。
  community: { settingsOnly: true, name: '参与社区统计', desc: '每小时匿名报一次等级、本周经验与 Token 合计等几个数，用于左侧「社区」页的在线人数和排行榜；不含姓名、工号、对话和文件', cost: '几乎没有：每小时一个不到 1 KB 的内网请求，3 秒超时，失败不重试' },
  quotaRefresh: { name: 'CodeAgent 多账号额度自动刷新', desc: '有两个以上 CodeAgent 账号时，每 15 分钟把各号的剩余额度读一遍', cost: '每读一个号临时起一个 CodeAgent 后台进程（约 0.5 GB 内存），读完即关。关着时额度面板里手动刷新照样能用' },
});

// 低开销模式管的后台功能（顺序即设置页「资源与后台」的显示顺序）。托盘、多开提示不是后台开销，不在其中。
const BACKGROUND_IDS = Object.freeze(['assistant', 'forum', 'attendance', 'w3', 'rooms', 'pet', 'liveMeter', 'searchIndex', 'quotaRefresh']);
// 关掉低开销模式时恢复为开的几项（老版本里它们本来就一直开着）；助理、帖子等各自是可选功能，保持原样。
const RESTORE_ON_STANDARD = Object.freeze(['liveMeter', 'searchIndex', 'quotaRefresh']);
// 文件里记的新装 / 升级判定版本：没有这个标记就还没判定过。
const LOW_OVERHEAD_VERSION = 1;
const DEFAULT_KEEP_ALIVE = 2;
function clampKeepAlive(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : DEFAULT_KEEP_ALIVE;
}

// 其他模块（会话处理、底栏读数、搜索）不经 main.js 传参也能问「这项开着没」：main.js 建好实例后登记进来。
// 没登记（单测、子进程）时一律当作开着，保持老行为。
let active = null;
function registerActive(instance) { active = instance || null; }

// 这台电脑上用过 Hub 的痕迹（任何一样在就按老用户处理，绝不动已有功能）。
// state.json 丢了会从 sessions/、meetings/ 自愈（main.js 启动自愈），所以这两个目录里有东西也算；
// 其余几个文件只在用过之后才会写，新装启动到这里时一定还不在。
const HISTORY_FILES = ['state.json', 'config.json', 'hub-pet.json', 'usage-cache.json', 'token-usage-ledger.json'];
const HISTORY_DIRS = ['sessions', 'meetings'];
function hasHubHistory(dataDir) {
  for (const name of HISTORY_FILES) { try { if (fs.existsSync(path.join(dataDir, name))) return true; } catch { return true; } }
  for (const name of HISTORY_DIRS) {
    try { if (fs.readdirSync(path.join(dataDir, name)).length) return true; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true; }   // 读不了（权限等）宁可当老用户
  }
  return false;
}
function backgroundOn(id) { return active ? active.get(id) : true; }
function lowOverheadOn() { try { return !!(active && active.lowOverhead && active.lowOverhead()); } catch { return false; } }
// 常驻巡检的间隔：低开销模式开着时放慢 4 倍（和 core/low-overhead-policy.js 的 L6 同一倍数）。
function slowedMs(baseMs) { return lowOverheadOn() ? baseMs * require('./low-overhead-policy').BACKGROUND_SLOWDOWN : baseMs; }

// defaults 只给隔离测试用（main.js 在用环境变量强开助理/论坛的隔离实例里传 true，老的端到端测试照旧能直接用）。
// detectFreshInstall：判定新装还是升级（main.js 在正式实例里开）。新装＝数据目录里没有本文件、也没有任何用过的痕迹（hasHubHistory）
// （state.json 在本模块之后才第一次写，新装时一定还不在）：打开低开销模式、所有后台功能都关。
// 升级：一个开关都不改，新纳入的三项按老行为记为开，并留一次「可开启低开销模式」的提示。
// 不开 detectFreshInstall（单测、隔离实例）：按老行为，不判定、不提示。
function createOptionalFeatures({ dataDir, logger = console, defaults = {}, detectFreshInstall = false } = {}) {
  const file = path.join(dataDir, FILE);
  let value = {
    assistant: defaults.assistant === true, forum: defaults.forum === true, attendance: defaults.attendance === true, w3: defaults.w3 === true,
    rooms: defaults.rooms !== false, tray: defaults.tray === true, multiOpen: defaults.multiOpen !== false,
    liveMeter: defaults.liveMeter !== false, searchIndex: defaults.searchIndex !== false, quotaRefresh: defaults.quotaRefresh !== false,
    community: defaults.community !== false,
  };
  // 用户亲手关掉（或在「还没开启」页点了「不用，收起入口」）的功能，左侧导航不再显示它（2026-11-18 用户反馈）。
  // 只认用户自己的这一下：默认关着、从没碰过的功能照旧显示入口，点进去是说明页，新用户不会因为默认关着就找不到。
  let hidden = new Set();
  // 首次点关闭时问过「退出 / 最小化到托盘」没有（2026-11-21 同事反馈关窗直接退出、找不到托盘设置）：问过一次就记住，不再问。
  // 用户在「可选功能」里亲手开关过托盘，也算已经选过。
  let closeAsked = false;
  // 低开销模式本身（模式开关，不是某项功能），以及升级用户的一次性提示。
  let lowOverhead = false, lowOverheadHint = false, lowOverheadVersion = 0;
  // 低开销模式开着时保活几个会话（2026-11-23 P1 v2，1 | 2 | 3，默认 2）：和模式开关记在同一个文件，设置页保存 config.json 时不会被冲掉。
  let lowOverheadKeepAlive = DEFAULT_KEEP_ALIVE;
  // 桌宠的开关存在自己的 hub-pet.json（两个版本都默认关），不在这张表里；main.js 拼清单时把它并进来。
  let fileExists = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fileExists = true;
    for (const k of Object.keys(value)) if (typeof raw?.[k] === 'boolean') value[k] = raw[k];
    if (Array.isArray(raw?.navHidden)) hidden = new Set(raw.navHidden.filter(k => k in value));
    closeAsked = raw?.closeAsked === true;
    lowOverhead = raw?.lowOverhead === true;
    lowOverheadHint = raw?.lowOverheadHint === true;
    lowOverheadVersion = Number(raw?.lowOverheadVersion) || 0;
    if (raw?.lowOverheadKeepAlive != null) lowOverheadKeepAlive = clampKeepAlive(raw.lowOverheadKeepAlive);
  } catch (error) {
    if (error.code !== 'ENOENT') { fileExists = true; logger.warn?.('[optional-features] unreadable, all off:', error.message); }
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...value, navHidden: [...hidden], closeAsked, lowOverhead, lowOverheadHint, lowOverheadVersion, lowOverheadKeepAlive }, null, 1) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) { logger.warn?.('[optional-features] save failed:', error.message); }
  }

  // 新装 / 升级判定只做一次，结果记进文件。
  let installKind = 'legacy';
  if (detectFreshInstall && lowOverheadVersion < LOW_OVERHEAD_VERSION) {
    const used = fileExists || hasHubHistory(dataDir);
    if (used) {
      // 文件里没写过的新项按老行为记为开（上面的默认值已经是开），其他一律保持原样。
      installKind = 'upgrade';
      lowOverhead = false; lowOverheadHint = true;
    } else {
      installKind = 'fresh';
      for (const id of BACKGROUND_IDS) if (id in value) value[id] = false;
      lowOverhead = true; lowOverheadHint = false;
    }
    lowOverheadVersion = LOW_OVERHEAD_VERSION;
    save();
  }

  // 模式替用户批量关的那一段时间里，set(false) 不收起左侧入口（那不是用户亲手关的）。
  let sweeping = false;
  return {
    file,
    get: id => value[id] === true,
    navHidden: id => value[id] !== true && hidden.has(id),
    set(id, on) {
      if (!(id in value)) throw new Error('未知的可选功能：' + id);
      value = { ...value, [id]: !!on };
      if (on) hidden.delete(id); else if (!sweeping) hidden.add(id);
      if (id === 'tray') closeAsked = true;
      save();
      return value[id];
    },
    // fn 可以是异步的（会议室要先结束组件进程才记成关）：等它做完再恢复。
    async sweep(fn) { sweeping = true; try { return await fn(); } finally { sweeping = false; } },
    // 还没问过、托盘也没开：第一次点关闭时就地问一句。
    closePromptPending: () => !closeAsked && value.tray !== true,
    // 记住关窗的选择：tray=true 打开「关窗口时最小化到托盘」，false 保持直接退出。
    rememberCloseChoice(tray) {
      closeAsked = true;
      value = { ...value, tray: !!tray };
      save();
      return value.tray;
    },
    lowOverhead: () => lowOverhead,
    lowOverheadKeepAlive: () => lowOverheadKeepAlive,
    setLowOverheadKeepAlive(n) { lowOverheadKeepAlive = clampKeepAlive(n); save(); return lowOverheadKeepAlive; },
    setLowOverhead(on) { lowOverhead = !!on; lowOverheadHint = false; save(); return lowOverhead; },
    // fresh（新装）/ upgrade（老用户升级）/ legacy（没判定，单测与隔离实例）。
    installKind: () => installKind,
    lowOverheadHintPending: () => lowOverheadHint && !lowOverhead,
    dismissLowOverheadHint() { lowOverheadHint = false; save(); },
  };
}

// 低开销模式总开关：开＝逐项关掉开着的后台功能；关＝把 RESTORE_ON_STANDARD 三项恢复为开。
// list：当前清单（main.js optionalFeatureList）；apply(id, on)：让一项当场生效，做不到就抛出原因。
// 有一项没处理成就不把模式记成已切换（否则页面显示「已开」、后台其实还有东西在跑），已处理成的保持新状态。
async function switchLowOverhead({ features, list, apply, on }) {
  const targets = on ? list.filter(f => BACKGROUND_IDS.includes(f.id) && f.on) : list.filter(f => RESTORE_ON_STANDARD.includes(f.id) && !f.on);
  const failed = [];
  await features.sweep(async () => {
    for (const f of targets) {
      try { await apply(f.id, !on); }
      catch (error) { failed.push({ id: f.id, name: f.name, error: error && error.message ? error.message : String(error) }); }
    }
  });
  if (!failed.length) features.setLowOverhead(on);
  const what = failed.map(f => (on ? `${f.name}没关上（${f.error}）` : `${f.name}没开上（${f.error}）`)).join('；');
  const message = !failed.length ? '' : features.lowOverhead() ? `${what}，低开销模式保持开` : `${what}，低开销模式保持关`;
  return { handled: targets.length, failed, partial: failed.length > 0, message };
}

module.exports = { switchLowOverhead, CATALOG, FILE, BACKGROUND_IDS, RESTORE_ON_STANDARD, LOW_OVERHEAD_VERSION, createOptionalFeatures, registerActive, backgroundOn, lowOverheadOn, slowedMs, hasHubHistory };
