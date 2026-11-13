'use strict';
// 「个人」页的等级与成就规则（2026-11-12）。全是纯函数与常量：经验怎么算、多少经验几级、成就各自的达成条件。
// 等级与使用程度成正比：每天打开、发消息、AI 答完、新建会话、用到各功能都给经验；每项有每日上限，刷不出虚高的等级。

const MAX_LEVEL = 60;
// 升到第 n 级累计需要的经验：50·n·(n-1)。每天正常用约 250 经验：10 级约 18 天，20 级约 2.5 个月，30 级约半年。
const xpForLevel = n => 50 * n * (n - 1);
function levelOf(xp) {
  let n = Math.floor((1 + Math.sqrt(1 + 0.08 * Math.max(0, Number(xp) || 0))) / 2);
  while (n > 1 && xpForLevel(n) > xp) n--;
  while (n < MAX_LEVEL && xpForLevel(n + 1) <= xp) n++;
  return Math.max(1, Math.min(MAX_LEVEL, n));
}

// 段位：每档一枚徽章（renderer/assets/profile/rank-<n>.webp）。
const RANKS = [
  { n: 1, from: 1, name: '见习驾驭者', metal: '青铜' },
  { n: 2, from: 5, name: '入门驾驭者', metal: '白银' },
  { n: 3, from: 10, name: '熟练驾驭者', metal: '黄金' },
  { n: 4, from: 15, name: '资深驾驭者', metal: '蓝宝石' },
  { n: 5, from: 20, name: '专家驾驭者', metal: '紫晶' },
  { n: 6, from: 30, name: '大师驾驭者', metal: '翡翠' },
  { n: 7, from: 40, name: '宗师驾驭者', metal: '红宝石' },
  { n: 8, from: 50, name: '传奇驾驭者', metal: '钻石' },
];
const rankOf = level => RANKS.reduce((hit, r) => (level >= r.from ? r : hit), RANKS[0]);

// 经验规则：each 是单次经验，cap 是每天计经验的次数上限。
const XP = {
  open: { each: 20, cap: 1, label: '每天打开' },
  prompt: { each: 4, cap: 60, label: '发一条消息' },
  turn: { each: 2, cap: 60, label: 'AI 答完一轮' },
  session: { each: 6, cap: 10, label: '新建会话' },
  feature: { each: 15, cap: 1, label: '当天用到一个功能' },   // 每个功能每天一次
  featureFirst: { each: 40, label: '第一次用某个功能' },
  streak: { each: 5, cap: 7, label: '连续使用加成（每天 5×连续天数，最多 7 天）' },
  pet: { each: 2, cap: 5, label: '摸摸桌宠' },
  backfillDay: { each: 150, label: '历史活跃日（按日估算）' },
};
const TIER_XP = { bronze: 50, silver: 120, gold: 300 };

// 能计入「用过的功能」的功能。只有本版本里真的接上了的才算进总数（见 service.registerFeature）。
const FEATURES = {
  chat: '会话对话', assistant: '问助理', rooms: '会议室', meeting: '会议录制', ppt: 'PPT', forum: '帖子',
  attendance: '考勤', team: '组队协作', roundtable: '圆桌群聊', aside: '问一句', skill: '技能', rules: '规则',
  components: '组件体检', disk: '硬盘清理', pet: '桌宠',
};

// 桌宠特效：到等级自动解锁，桌宠设置里可以整体关掉。
const PET_PERKS = [
  { id: 'chip', level: 1, name: '等级角标', desc: '桌宠脚边挂上你的等级' },
  { id: 'sparkle', level: 5, name: '星光', desc: '桌宠身边偶尔闪起小星星' },
  { id: 'halo', level: 20, name: '光环', desc: '脚下亮起一圈柔光' },
];
const perksOf = level => PET_PERKS.filter(p => level >= p.level).map(p => p.id);

// 形态和素材共用这一份规则，下载形象也只按透明度戴头饰，不单独存坐标。
const EVOLUTIONS = Object.freeze([
  { n: 1, level: 1, name: '初生', head: '', wings: '', width: 0 },
  { n: 2, level: 10, name: '星冠', head: 'head-2', wings: '', width: 0.30 },
  { n: 3, level: 20, name: '银冠', head: 'head-3', wings: '', width: 0.32 },
  { n: 4, level: 30, name: '金冠', head: 'head-4', wings: '', width: 0.34 },
  { n: 5, level: 40, name: '羽翼', head: 'head-5', wings: 'wings-5', width: 0.36 },
  { n: 6, level: 50, name: '王者', head: 'head-6', wings: 'wings-6', width: 0.38 },
].map(Object.freeze));
const evolutionOf = level => EVOLUTIONS.reduce((hit, e) => Number(level) >= e.level ? e : hit, EVOLUTIONS[0]);
const evolutionChange = (from, to) => evolutionOf(to).n > evolutionOf(from).n ? evolutionOf(to) : null;

// 亲密度：摸一次 1 点，桌宠陪伴一天 5 点。
const BOND_STEPS = [0, 10, 30, 60, 100, 160, 240, 340, 460, 600];
function bondOf(points) {
  let level = 1;
  for (let i = 0; i < BOND_STEPS.length; i++) if (points >= BOND_STEPS[i]) level = i + 1;
  const next = BOND_STEPS[level] ?? null;
  return { level, points, floor: BOND_STEPS[level - 1], next };
}

// 成就。icon 是徽章图编号（renderer/assets/profile/badge-<icon>.webp）；need 指这项成就依赖的功能，本版本没接上就不显示。
// metric 从统计量里取当前进度，达到 goal 即解锁。
const f = id => s => (s.features[id] || 0);
const ACHIEVEMENTS = [
  { id: 'first-chat', group: 'chat', icon: 1, tier: 'bronze', name: '初次启程', desc: '发出第一条消息', goal: 1, metric: s => s.prompts },
  { id: 'chat-100', group: 'chat', icon: 2, tier: 'bronze', name: '百问', desc: '累计发出 100 条消息', goal: 100, metric: s => s.prompts },
  { id: 'chat-1000', group: 'chat', icon: 3, tier: 'silver', name: '千问', desc: '累计发出 1,000 条消息', goal: 1000, metric: s => s.prompts },
  { id: 'chat-5000', group: 'chat', icon: 4, tier: 'gold', name: '万语千言', desc: '累计发出 5,000 条消息', goal: 5000, metric: s => s.prompts },
  { id: 'sessions-50', group: 'chat', icon: 5, tier: 'bronze', name: '多线并进', desc: '累计新建 50 个会话', goal: 50, metric: s => s.sessions },
  { id: 'streak-3', group: 'keep', icon: 6, tier: 'bronze', name: '小火苗', desc: '连续使用 3 天', goal: 3, metric: s => s.bestStreak },
  { id: 'streak-7', group: 'keep', icon: 7, tier: 'silver', name: '连续七天', desc: '连续使用 7 天', goal: 7, metric: s => s.bestStreak },
  { id: 'streak-30', group: 'keep', icon: 8, tier: 'gold', name: '持之以恒', desc: '连续使用 30 天', goal: 30, metric: s => s.bestStreak },
  { id: 'days-30', group: 'keep', icon: 9, tier: 'bronze', name: '满月', desc: '累计活跃 30 天', goal: 30, metric: s => s.activeDays },
  { id: 'days-100', group: 'keep', icon: 10, tier: 'silver', name: '百日同行', desc: '累计活跃 100 天', goal: 100, metric: s => s.activeDays },
  { id: 'days-365', group: 'keep', icon: 11, tier: 'gold', name: '日积月累', desc: '累计活跃 365 天', goal: 365, metric: s => s.activeDays },
  { id: 'night-owl', group: 'keep', icon: 12, tier: 'bronze', name: '深夜同行', desc: '有 10 天在 23 点到凌晨 4 点之间用过', goal: 10, metric: s => s.nightDays },
  { id: 'early-bird', group: 'keep', icon: 13, tier: 'bronze', name: '早起鸟', desc: '有 5 天在早上 6 点到 8 点之间用过', goal: 5, metric: s => s.earlyDays },
  { id: 'weekend', group: 'keep', icon: 14, tier: 'bronze', name: '周末也在', desc: '有 4 个周末日用过', goal: 4, metric: s => s.weekendDays },
  { id: 'marathon', group: 'chat', icon: 15, tier: 'silver', name: '高频使用', desc: '一天内发出 50 条消息', goal: 50, metric: s => s.maxDayPrompts },
  { id: 'multitask', group: 'chat', icon: 16, tier: 'bronze', name: '多任务', desc: '一天内新建 5 个会话', goal: 5, metric: s => s.maxDaySessions },
  { id: 'token-100m', group: 'chat', icon: 17, tier: 'silver', name: '亿级算力', desc: '累计用掉 1 亿 Token', goal: 1e8, metric: s => s.tokens },
  { id: 'explorer-5', group: 'explore', icon: 18, tier: 'bronze', name: '探索先锋', desc: '用过 5 个不同的功能', goal: 5, metric: s => s.featuresUsed },
  { id: 'explorer-all', group: 'explore', icon: 19, tier: 'gold', name: '全能选手', desc: '用遍本版本的全部功能', goal: s => Math.max(6, s.featuresAvail), metric: s => s.featuresUsed },
  { id: 'assistant-10', group: 'explore', icon: 20, tier: 'bronze', name: '得力助手', desc: '问助理 10 次', goal: 10, metric: f('assistant'), need: 'assistant' },
  { id: 'rooms-1', group: 'explore', icon: 21, tier: 'bronze', name: '有会议室了', desc: '用抢会议室发起一次预订', goal: 1, metric: f('rooms'), need: 'rooms' },
  { id: 'meeting-1', group: 'explore', icon: 22, tier: 'bronze', name: '会议有记录', desc: '录制一场会议', goal: 1, metric: f('meeting'), need: 'meeting' },
  { id: 'ppt-1', group: 'explore', icon: 23, tier: 'bronze', name: '找页高手', desc: '用一次 PPT 找页或制作', goal: 1, metric: f('ppt'), need: 'ppt' },
  { id: 'team-1', group: 'explore', icon: 24, tier: 'silver', name: '组队出击', desc: '批准一次多会话组队', goal: 1, metric: f('team'), need: 'team' },
  { id: 'roundtable-1', group: 'explore', icon: 25, tier: 'bronze', name: '圆桌会议', desc: '开一次圆桌或群聊', goal: 1, metric: f('roundtable'), need: 'roundtable' },
  { id: 'skill-5', group: 'explore', icon: 26, tier: 'bronze', name: '技能拼图', desc: '带技能发出 5 条消息', goal: 5, metric: f('skill'), need: 'skill' },
  { id: 'rules-1', group: 'explore', icon: 27, tier: 'bronze', name: '定制规则', desc: '保存一次自己的规则', goal: 1, metric: f('rules'), need: 'rules' },
  { id: 'forum-5', group: 'explore', icon: 28, tier: 'bronze', name: '热榜常客', desc: '看 5 次帖子页的热帖', goal: 5, metric: f('forum'), need: 'forum' },
  { id: 'pet-first', group: 'grow', icon: 29, tier: 'bronze', name: '初次相遇', desc: '摸一摸桌宠', goal: 1, metric: s => s.petPets, need: 'pet' },
  { id: 'pet-100', group: 'grow', icon: 30, tier: 'silver', name: '默契伙伴', desc: '累计摸桌宠 100 次', goal: 100, metric: s => s.petPets, need: 'pet' },
  { id: 'level-10', group: 'grow', icon: 31, tier: 'silver', name: '登上山腰', desc: '升到 10 级', goal: 10, metric: s => s.level },
  { id: 'level-30', group: 'grow', icon: 32, tier: 'gold', name: '加冕', desc: '升到 30 级', goal: 30, metric: s => s.level },
];
// 成就页按这四组分栏。
const GROUPS = [{ id: 'chat', name: '对话' }, { id: 'keep', name: '坚持' }, { id: 'explore', name: '探索' }, { id: 'grow', name: '伙伴与成长' }];
const goalOf = (a, stats) => (typeof a.goal === 'function' ? a.goal(stats) : a.goal);

module.exports = { MAX_LEVEL, xpForLevel, levelOf, RANKS, rankOf, XP, TIER_XP, FEATURES, PET_PERKS, perksOf, EVOLUTIONS, evolutionOf, evolutionChange, bondOf, ACHIEVEMENTS, GROUPS, goalOf };
