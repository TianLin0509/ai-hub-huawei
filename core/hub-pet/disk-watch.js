'use strict';
// 硬盘快满时桌宠提醒（2026-11-09）：盘写满时程序写不了日志、会话和下载一起出错，往往要等出了事才发现。
// 每 10 分钟看一次系统盘和 Hub 数据所在的盘；用了 90% 以上，每块盘每天说一次，点卡片打开「硬盘管理」看哪里占地方。
// 只在桌宠开着时看（关着时底栏的硬盘读数照旧），读盘用 statfs，不扫目录。
const fs = require('fs');
const path = require('path');

const WARN_PCT = 90;
const EVERY_MS = 10 * 60 * 1000;

function driveRoot(p) {
  const root = path.parse(path.resolve(String(p || ''))).root;
  return root || null;
}

// roots 去重后逐个读；返回用了 warnPct 以上的盘：[{ root, pct, freeGb }]
async function fullDrives(roots, { statfs = fs.promises.statfs.bind(fs.promises), warnPct = WARN_PCT } = {}) {
  const out = [];
  for (const root of [...new Set(roots.filter(Boolean))]) {
    try {
      const s = await statfs(root);
      const block = Number(s.bsize || s.frsize || 0);
      const total = block * Number(s.blocks || 0), free = block * Number(s.bavail ?? s.bfree ?? 0);
      if (!(total > 0)) continue;
      const pct = Math.round((total - free) / total * 100);
      if (pct >= warnPct) out.push({ root, pct, freeGb: Math.round(free / 1024 ** 3 * 10) / 10 });
    } catch { /* 读不了的盘（光驱、断开的网盘）不管 */ }
  }
  return out;
}

function createDiskWatch({ roots = () => [], notify, active = () => true, statfs, now = () => Date.now(), everyMs = EVERY_MS, warnPct = WARN_PCT } = {}) {
  const told = new Map();   // 盘 → 哪天说过
  let timer = null;
  const day = () => { const d = new Date(now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  async function check() {
    if (!active()) return [];
    const list = await fullDrives(roots(), { statfs, warnPct });
    const said = [];
    for (const d of list) {
      if (told.get(d.root) === day()) continue;
      const name = d.root.replace(/[\\/]+$/, '');
      const ok = notify?.({ id: `disk:${name}:${day()}`, kind: 'disk', page: 'disk', tone: 'bad', cta: '看看哪里占地方',
        title: `${name} 盘已经用了 ${d.pct}%`, text: `只剩 ${d.freeGb} GB。盘满了会话、下载和日志都会出错，先清一清再开大任务。` });
      if (ok) { told.set(d.root, day()); said.push(d); }
    }
    return said;
  }
  return {
    check,
    start() { if (timer) return; timer = setInterval(() => { void check().catch(() => {}); }, everyMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { WARN_PCT, createDiskWatch, driveRoot, fullDrives };
