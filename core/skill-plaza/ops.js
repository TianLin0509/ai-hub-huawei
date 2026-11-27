'use strict';
// 技能广场 · 员工助手来源的四个重活：扫描、预览、导入、移除。都要递归读写文件，
// 正式运行时在 Worker 线程里跑（core/skill-plaza/worker.js），主进程不同步阻塞；参数和返回值都可序列化。
// 第二个参数 { fs, hooks } 只给单测在本线程注入故障用。
const fs = require('node:fs');
const path = require('node:path');
const rules = require('./rules');
const source = require('./weclaw-source');
const installer = require('./installer');

const publicItem = item => { const { _internal, sensitive, ...rest } = item; return rest; };

/** ctx：{ homeDir, dataDir, roots, targets:[{id,label,dir,present}] } */
function scanItems(ctx) {
  const scan = source.scanWeclaw(ctx.homeDir, { roots: ctx.roots });
  const ledger = installer.readLedger(ctx.dataDir); // 列表只读，台账坏了也照常显示
  for (const item of scan.items) {
    const name = rules.targetName(item.name);
    item.installedIn = (ctx.targets || []).filter(t => installer.readOrigin(path.join(t.dir, name))?.id === item.id).map(t => t.id);
    if (item.use !== 'delegate' && (ledger[item.id] || item.installedIn.length)) item.use = 'installed';
  }
  return { roots: scan.roots, items: scan.items, ledgerDirs: Object.values(ledger).flatMap(e => e.targets.map(t => path.basename(t.dir))) };
}
function findItem(ctx, id) {
  if (typeof id !== 'string' || !id.startsWith(source.ID_PREFIX) || id.length > 200) throw new Error('找不到这个技能，请刷新后重试');
  const item = scanItems(ctx).items.find(i => i.id === id);
  if (!item) throw new Error('找不到这个技能，请刷新后重试');
  return item;
}

function scan(ctx) {
  const r = scanItems(ctx);
  return { roots: r.roots, items: r.items.map(publicItem), ledgerDirs: r.ledgerDirs };
}

function preview(ctx) {
  const item = findItem(ctx, ctx.id);
  const p = installer.plan(item);
  return { item: publicItem(item), mapping: p.mapping, migrationNotes: p.migrationNotes, targetName: p.name,
    fileCount: p.fileCount, totalBytes: p.totalBytes, tooLarge: p.overLimit };
}

/** ctx.chosen：已确认本机有的目标；ctx.skipped：调用方先判出的跳过项。 */
function importSkill(ctx, { fs: io, hooks } = {}) {
  const item = findItem(ctx, ctx.id);
  const tier = item._internal.tier;
  if (tier === 'delegate') throw new Error('这个技能离不开员工助手，请用「交员工助手执行」');
  if (tier === 'fix' && ctx.acknowledgeRewrite !== true) throw new Error('这个技能需要改写，请先在详情里勾选「我知道要改写」');
  const p = installer.plan(item);
  // 上限按最终产物（含导入时生成的说明文件）核算
  if (p.overLimit) throw new Error(`技能超过 ${source.LIMIT_FILES} 个文件或 50 MB（含导入时生成的说明文件），没有导入`);
  const opt = io ? { fs: io } : {};
  // 台账先读（损坏就在写任何东西之前停下），落位后写台账，台账写成才删旧版备份
  const ledger = installer.readLedger(ctx.dataDir, { strict: true, ...opt });
  const tx = installer.install(item, p, ctx.chosen, { ledgerEntry: ledger[item.id] || null, ...opt, ...(hooks || {}) });
  if (tx.installed.length) {
    const prev = ledger[item.id]?.targets || [];
    ledger[item.id] = { at: Date.now(), source: 'weclaw',
      targets: [...prev.filter(e => !tx.installed.some(n => n.target === e.target)), ...tx.installed] };
    try { installer.writeLedger(ctx.dataDir, ledger, opt); }
    catch (error) { throw tx.rollback(error.message); }
  }
  const leftovers = tx.commit();
  return { name: item.name, installed: tx.installed, skipped: [...(ctx.skipped || []), ...tx.skipped], ...(leftovers.length ? { leftovers } : {}) };
}

function remove(ctx, { fs: io } = {}) {
  const id = ctx.id;
  const opt = io ? { fs: io } : {};
  const ledger = installer.readLedger(ctx.dataDir, { strict: true, ...opt });
  const entry = ledger[id];
  const dirs = Object.fromEntries((ctx.targets || []).map(t => [t.id, t.dir]));
  if (!entry) {
    // 台账里没有，但目录还带着技能广场标记（台账损坏后重建过等）：不删，告诉用户在哪、怎么处理。
    const name = rules.targetName(id.slice(source.ID_PREFIX.length));
    const orphans = (ctx.targets || []).map(t => path.join(t.dir, name)).filter(d => installer.readOrigin(d, io || fs)?.id === id);
    if (!orphans.length) throw new Error('导入台账里没有这个技能的记录，本机也没找到它导入的目录');
    return { removed: [], kept: orphans.map(dir => ({ target: (ctx.targets.find(t => path.dirname(dir) === t.dir) || {}).id, dir })),
      reasons: [`导入台账里没有这个技能的记录（台账可能重建过），为安全起见没有删除；不需要的话请手动删除：${orphans.join('、')}`] };
  }
  const removed = [], kept = [], reasons = [];
  for (const t of entry.targets) {
    const r = installer.removeDir(t, dirs, id, opt);
    if (r.ok) { if (!r.gone) removed.push({ target: t.target, dir: t.dir }); }
    else { kept.push(t); reasons.push(r.reason); }
  }
  if (kept.length) ledger[id] = { ...entry, targets: kept }; else delete ledger[id];
  installer.writeLedger(ctx.dataDir, ledger, opt);
  return { removed, ...(kept.length ? { kept: kept.map(k => ({ target: k.target, dir: k.dir })), reasons } : {}) };
}

const OPS = { scan, preview, import: importSkill, remove };
module.exports = { OPS, publicItem };
