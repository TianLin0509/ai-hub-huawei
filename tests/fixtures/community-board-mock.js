'use strict';
// 社区页 mock 数据（任务书第 5 节 IPC 契约 community:get-board 的形状，外加 mock 稿用到的补充字段：
// E.wxp、me.values、total、todayDelta/weekDelta、host、versions 的 other 合并项），单测和 CDP 界面验收共用。
const PETS = ['shiba', 'cat', 'penguin', 'rabbit', 'hamster', 'cockatiel', 'whale-maid', 'claude-girl', 'gpt-girl'];
const PETCN = { shiba: '柴犬', cat: '小猫', penguin: '企鹅', rabbit: '兔子', hamster: '仓鼠', cockatiel: '玄凤', 'whale-maid': '鲸鱼娘', 'claude-girl': 'Claude娘', 'gpt-girl': 'GPT娘' };
const CUSTOM = ['算法小柴', '调度狂魔', '波束成形', 'OLLA收敛中', '今天不加班', 'MU配对王', 'Token燃烧者', '夜猫子退散', 'HARQ重传', '一键成群'];

// 固定种子造 68 位同事 + 我，按各榜排序取前 20。
function people() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hex = () => Math.floor(rnd() * 65536).toString(16).toUpperCase().padStart(4, '0');
  const list = Array.from({ length: 68 }, (_, i) => {
    const pet = PETS[Math.floor(rnd() * PETS.length)];
    const lv = Math.max(1, Math.round(48 * Math.pow(rnd(), 1.6)));
    return { nick: i < CUSTOM.length && rnd() > 0.3 ? CUSTOM[i] : `${PETCN[pet]}·${hex()}`, pet, lv,
      wxp: Math.min(2000, Math.round(lv * 30 + rnd() * 900)), wtok: Math.round(Math.pow(rnd(), 2.2) * 48000) * 1000,
      streak: Math.round(Math.pow(rnd(), 1.4) * 22), ach: Math.min(32, Math.round(lv * 0.55 + rnd() * 6)) };
  });
  list.push({ nick: '柴犬·3F2A', pet: 'shiba', lv: 17, wxp: 1340, wtok: 6120000, streak: 9, ach: 13, me: true });
  return list;
}
const KEY = { level: 'lv', wxp: 'wxp', wtok: 'wtok', streak: 'streak', ach: 'ach' };
function build() {
  const all = people();
  const boards = {}, ranks = {};
  for (const [b, k] of Object.entries(KEY)) {
    const sorted = [...all].sort((x, y) => y[k] - x[k] || y.wxp - x.wxp);
    ranks[b] = sorted.findIndex(p => p.me) + 1;
    boards[b] = sorted.slice(0, 20).map((p, i) => ({ rank: i + 1, nick: p.nick, pet: p.pet, lv: p.lv, value: p[k], wxp: p.wxp, me: !!p.me }));
  }
  const me = all.find(p => p.me);
  return { boards, total: all.length, me: { nick: me.nick, pet: me.pet, lv: me.lv, ranks, values: { lv: me.lv, wxp: me.wxp, wtok: me.wtok, streak: me.streak, ach: me.ach } } };
}

function board(overrides = {}) {
  const b = build();
  return {
    ok: true, state: 'ok', at: Date.now() - 3 * 60000, isHost: false,
    online: 42, activeNow: 17, today: 68, week: 115, todayDelta: 12, weekDelta: 21, total: b.total,
    versions: [{ v: '5.6.100', n: 31 }, { v: '5.6.99', n: 14 }, { v: '5.6.97', n: 9 }, { v: '5.6.64', n: 6 }, { v: '5.6.2', n: 4 }, { v: 'other', n: 4 }],
    boards: b.boards, me: b.me, minK: 5, ...overrides,
  };
}

function hostBoard() {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const daily = [];
  const end = Date.parse('2026-11-24T04:00:00Z');
  for (let i = 0; i < 30; i++) {
    const day = new Date(end - (29 - i) * 86400000), wk = i % 7 === 5 || i % 7 === 6, base = 8 + i * 1.9;
    const dau = Math.round((wk ? base * 0.45 : base) + rnd() * 5);
    daily.push({ d: day.toISOString().slice(0, 10), dau, act: Math.round(dau * (0.35 + rnd() * 0.15)) });
  }
  return board({ isHost: true, daily, host: { paused: false, pulsesToday: 61, stored: 182 } });
}

const STATES = {
  ok: () => board(),
  host: () => hostBoard(),
  few: () => board({ online: 3, activeNow: 1, today: 4, week: 4, todayDelta: undefined, weekDelta: undefined, total: 4, boards: { level: [], wxp: [], wtok: [], streak: [], ach: [] } }),
  offline: () => board({ state: 'offline' }),
  outside: () => ({ ok: true, state: 'outside' }),
  disabled: () => ({ ok: true, state: 'disabled' }),
  paused: () => board({ state: 'paused' }),
  // 只有第 5 节契约里的字段（m1 还没补字段时的样子）
  bare: () => { const b = board(); delete b.total; delete b.todayDelta; delete b.weekDelta; delete b.me.values; for (const k of Object.keys(b.boards)) b.boards[k] = b.boards[k].map(({ wxp, ...e }) => e); return b; },
};

module.exports = { board, hostBoard, STATES };
