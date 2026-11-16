'use strict';
// 版本选择与回退（2026-11-16）：默认仍跟随最新版；有人觉得新版不好时，可以从镜像上还在的旧版里挑一个回退。
//   - versions.json：和 latest.json 放同一目录，由发版跟发上传后按镜像实际目录生成（只列确实还在的版本）。
//     { schema:1, versions:[{ version, publishedAt, runtime, incremental:{file,bytes,sha256}, notes? }] }
//   - 只列和本机 Electron / 原生依赖一致的版本：回退只换 app.asar 和程序文件，运行时不同的旧版装上去起不来。
//   - 回退一律走完整更新包（不走差量小包），回退前把设置和本地数据库等小文件备份到 backups/rollback-<时间>/。
//   - 回退成功后写「固定版本」：自动更新和更新提醒暂停，界面常驻「回到最新版」。
const fs = require('fs');
const path = require('path');
const { parseVersion, compareVersions, sameRuntime } = require('./manifest');

const PIN_FILE = 'pinned-version.json';
const BACKUP_DIR = 'backups';
const RESTORE_MARK = 'restore-pending.json';
const SHA = /^[a-f0-9]{64}$/;
const FILE = /^[A-Za-z0-9._-]{1,120}$/;

// 清单地址 …/latest.json → 同目录 …/versions.json。
function versionsUrl(manifestUrl) { return String(manifestUrl || '').replace(/latest\.json(\?.*)?$/, 'versions.json'); }

function validateVersions(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!doc || doc.schema !== 1 || !Array.isArray(doc.versions)) throw new Error('版本列表的格式不认识');
  const out = [];
  for (const v of doc.versions.slice(0, 100)) {
    const inc = v && v.incremental;
    if (!v || !parseVersion(v.version) || !v.runtime || !/^\d+\.\d+\.\d+/.test(String(v.runtime.electron || ''))) continue;
    if (!inc || !FILE.test(String(inc.file || '')) || !Number.isInteger(inc.bytes) || inc.bytes < 1024 || !SHA.test(String(inc.sha256 || ''))) continue;
    out.push({ version: String(v.version).replace(/^v/, ''), publishedAt: String(v.publishedAt || ''),
      runtime: { electron: String(v.runtime.electron), native: v.runtime.native && typeof v.runtime.native === 'object' ? { ...v.runtime.native } : {} },
      incremental: { file: inc.file, bytes: inc.bytes, sha256: inc.sha256 },
      notes: Array.isArray(v.notes) ? v.notes.map(String).slice(0, 30) : [],
      // 这一版自己认识哪些回退相关的能力（2026-11-16 审查 P1-3）：version-pin = 认识「固定版本」，回退后不提醒、常驻「回到最新版」。
      capabilities: Array.isArray(v.capabilities) ? v.capabilities.map(String).slice(0, 20) : [] });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

// 界面要的列表：每版标出能不能装（运行时一致）、是不是当前版本，附该版说明和「之后修了什么」（比它新、不超过最新版的各版说明）。
function buildCatalog(versions, { current, runtime, history = [] }) {
  const notesOf = v => { const h = history.find(e => e.version === v.version); return h ? h.notes : v.notes; };
  const latest = versions[0] ? versions[0].version : null;
  const items = versions.map(v => {
    const compatible = sameRuntime(v.runtime, runtime);
    const later = versions.filter(x => compareVersions(x.version, v.version) > 0)
      .concat(history.filter(h => compareVersions(h.version, v.version) > 0 && !versions.some(x => x.version === h.version)
        && (!latest || compareVersions(h.version, latest) <= 0)))
      .sort((a, b) => compareVersions(b.version, a.version))
      .map(x => ({ version: x.version, notes: notesOf(x) }));
    return { version: v.version, publishedAt: v.publishedAt, bytes: v.incremental.bytes, current: v.version === current, latest: v.version === latest, supportsPin: v.capabilities.includes('version-pin'),
      compatible, why: compatible ? '' : (v.runtime.electron !== runtime.electron ? `底层运行时不同（Electron ${v.runtime.electron}）` : '终端组件等原生依赖不同'),
      notes: notesOf(v), laterFixes: later };
  });
  return { latest, items: items.filter(i => i.compatible), hidden: items.filter(i => !i.compatible).map(i => ({ version: i.version, why: i.why })) };
}

// 回退用的「目标清单」：只带完整更新包，交给 planUpdate(…, { allowDowngrade:true })。
function targetManifest(entry) {
  return { schema: 1, quiet: false, version: entry.version, publishedAt: entry.publishedAt, notes: entry.notes || [], runtime: entry.runtime,
    incremental: entry.incremental, incrementalDelta: null, installer: null, rollback: true };
}

// —— 固定版本 ——
function pinPath(dataDir) { return path.join(dataDir, 'app-update', PIN_FILE); }
function readPin(dataDir) {
  try { const raw = JSON.parse(fs.readFileSync(pinPath(dataDir), 'utf8')); return raw && parseVersion(raw.version) ? raw : null; } catch (_) { return null; }
}
function writePin(dataDir, pin) {
  const file = pinPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(pin, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
  return pin;
}
function clearPin(dataDir) { try { fs.rmSync(pinPath(dataDir), { force: true }); } catch (_) {} }
// 启动时核对：固定的版本就是当前版本才算固定成功；回退没换上（替换脚本自己回滚了）就清掉，返回 { pin, failed }。
// 只有替换脚本明确报告这次回退失败才算失败；回退到不认识固定状态的老版本、之后又升回来时，静默清掉即可。
function settlePin(dataDir, current, lastResult = null) {
  const pin = readPin(dataDir);
  if (!pin) return { pin: null, failed: null };
  if (pin.version === current) {
    if (pin.pending) { delete pin.pending; pin.activeAt = new Date().toISOString(); writePin(dataDir, pin); }
    return { pin, failed: null };
  }
  if (pin.pending && lastResult && lastResult.version === pin.version && lastResult.ok === false) { clearPin(dataDir); return { pin: null, failed: pin }; }
  // 用户自己装了别的版本（例如手动下载安装包）：固定失去意义，回到跟随最新版。
  clearPin(dataDir);
  return { pin: null, failed: null };
}

// —— 回退前备份：设置与本地数据库等小文件 ——
// 数据目录下两层内的 .json/.sqlite/.db/.flag/.txt 等，单个 ≤20 MB、合计 ≤200 MB；跳过备份目录、更新暂存、日志、缓存。
// SQLite 库（2026-11-16 审查 P1-2）：Hub 运行时库可能开着、带 WAL；逐个复制主库和 -wal/-shm 不是同一时刻的样子。
// 改用 VACUUM INTO 取一致快照并 quick_check 校验，-wal/-shm/-journal 不单独复制；任何一个库快照失败，整份备份作废并如实报错。
const KEEP_EXT = /\.(json|sqlite|db|flag|txt|ini|yaml|yml)$/i;
const SIDE = ['-wal', '-shm', '-journal'];
const SKIP_DIR = /^(backups|app-update|logs?|cache|caches|Cache|GPUCache|Code Cache|crashpad|Crashpad|tmp|temp|node_modules|blob_storage|Session Storage|Local Storage|IndexedDB|Service Worker)$/i;
function isSqliteFile(file) {
  try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b.toString('latin1') === 'SQLite format 3\0'; } finally { fs.closeSync(fd); } } catch (_) { return false; }
}
function collectSmallFiles(dataDir, { maxFile = 20 * 1024 * 1024, maxTotal = 200 * 1024 * 1024, depth = 2 } = {}) {
  const files = [], skipped = []; let total = 0;
  const walk = (dir, rel, level) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (level < depth && !SKIP_DIR.test(e.name)) walk(abs, r, level + 1); continue; }
      if (!e.isFile() || !KEEP_EXT.test(e.name)) continue;
      let size = 0; try { size = fs.statSync(abs).size; } catch (_) { continue; }
      if (size > maxFile || total + size > maxTotal) { skipped.push({ rel: r, bytes: size }); continue; }
      total += size; files.push({ rel: r, bytes: size, ...(isSqliteFile(abs) ? { sqlite: true } : {}) });
    }
  };
  walk(dataDir, '', 0);
  return { files, total, skipped };
}
function snapshotSqlite(src, dest) {
  const { DatabaseSync } = require('node:sqlite');
  fs.rmSync(dest, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
  const check = new DatabaseSync(dest, { readOnly: true });
  try { const row = check.prepare('PRAGMA quick_check').get(); const v = row && Object.values(row)[0]; if (v !== 'ok') throw new Error(`快照校验没通过（${v}）`); }
  finally { check.close(); }
}
// 同一数据目录里别的 Hub 是否还活着（按 control/<pid>.json 登记 + 进程存活判断；r16 返工2）。
// 回退前备份和还原都要求数据库没有别的写入者；检测到就不执行，就地提示先关掉另一个窗口。
function otherActiveHubs(dataDir, { selfPid = process.pid, alive = pidAlive } = {}) {
  const dir = path.join(dataDir, 'control');
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
  const pids = [];
  for (const n of names) {
    let pid = 0; try { pid = Number(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).pid) || 0; } catch (_) { continue; }
    if (pid && pid !== selfPid && alive(pid)) pids.push(pid);
  }
  return pids;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const OTHER_HUB_MSG = '请先关闭另一个 Hub 窗口再回退';
function assertNoOtherHub(dataDir, opts) {
  const pids = otherActiveHubs(dataDir, opts);
  if (!pids.length) return;
  const e = new Error(`另一个 Hub 窗口正在使用同一份数据（进程 ${pids.join('、')}），${OTHER_HUB_MSG}`); e.code = 'other-instance'; throw e;
}
// 唯一新目录：同一秒已有同名目录（含正在读取的来源）就往后顺延一秒；mkdir 不带 recursive，已存在即失败，不复用任何已有目录。
function createStampedDir(root, prefix, now) {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 600; i += 1) {
    const dir = path.join(root, `${prefix}-${stamp(new Date(now.getTime() + i * 1000))}`);
    try { fs.mkdirSync(dir); return dir; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('备份目录名用尽');
}
function stamp(now = new Date()) { const p = n => String(n).padStart(2, '0'); return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`; }
const relPath = (base, rel) => path.join(base, ...rel.split('/'));
function backupForRollback(dataDir, { from, to, now = new Date(), snapshot = snapshotSqlite } = {}) {
  const { files, total, skipped } = collectSmallFiles(dataDir);
  const dir = createStampedDir(path.join(dataDir, BACKUP_DIR), 'rollback', now);
  const errors = [];
  for (const f of files) {
    const src = relPath(dataDir, f.rel), dest = relPath(path.join(dir, 'files'), f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { if (f.sqlite) snapshot(src, dest); else fs.copyFileSync(src, dest); }
    catch (error) { errors.push(`${f.rel}：${error.message}`); }
  }
  if (errors.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    const e = new Error(`回退前备份没有完成，已停止回退：${errors.slice(0, 3).join('；')}`); e.code = 'backup-failed'; throw e;
  }
  const info = { schema: 1, kind: 'rollback', from, to, at: now.toISOString(), files: files.length, bytes: total, skipped: skipped.length };
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({ ...info, list: files, skippedList: skipped }, null, 2), 'utf8');
  return { dir, ...info };
}
function listBackups(dataDir) {
  const root = path.join(dataDir, BACKUP_DIR);
  let names = []; try { names = fs.readdirSync(root).filter(n => /^(rollback|restore-point)-\d{8}-\d{6}$/.test(n)); } catch (_) { return []; }
  return names.sort((a, b) => b.slice(-15).localeCompare(a.slice(-15))).map(n => {
    try { const doc = JSON.parse(fs.readFileSync(path.join(root, n, 'backup.json'), 'utf8')); delete doc.list; delete doc.skippedList; delete doc.absent; return { dir: path.join(root, n), name: n, ...doc }; } catch (_) { return null; }
  }).filter(Boolean);
}
// 一键还原：数据库此刻可能开着，只登记「下次启动时还原」，由 applyPendingRestore 在打开任何数据库前执行。
function scheduleRestore(dataDir, backupDir) {
  const root = path.resolve(dataDir, BACKUP_DIR);
  if (!path.resolve(backupDir).startsWith(root + path.sep) || !fs.existsSync(path.join(backupDir, 'backup.json'))) throw new Error('找不到这份备份');
  fs.writeFileSync(path.join(dataDir, BACKUP_DIR, RESTORE_MARK), JSON.stringify({ dir: path.resolve(backupDir), at: new Date().toISOString(), attempts: 0 }), 'utf8');
  return { scheduled: true, dir: backupDir };
}
const RESULT_FILE = 'restore-result.json';
function readRestoreResult(dataDir) { try { return JSON.parse(fs.readFileSync(path.join(dataDir, BACKUP_DIR, RESULT_FILE), 'utf8')); } catch (_) { return null; } }
// 还原（2026-11-16 审查 P1-1）：不让新数据丢失——先把当前要被替换的文件（含库的 -wal/-shm）原样存成独立恢复点，
// 恢复点也出现在备份列表里、可再还原回来；整批成功才消费还原标记，中途失败把动过的文件按恢复点改回原样。
// 失败的标记保留重试，连续 3 次失败或备份本身损坏才放弃（改名 restore-failed.json）。
function applyPendingRestore(dataDir, { now = new Date(), copy = fs.copyFileSync, others = otherActiveHubs } = {}) {
  const root = path.resolve(dataDir, BACKUP_DIR);
  const mark = path.join(root, RESTORE_MARK);
  let req; try { req = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch (_) { return null; }
  // 另一个 Hub 还开着同一份数据：一个文件都不动，标记原样保留（不计失败次数），关掉它后下次启动再还原。
  const busy = others(dataDir);
  if (busy.length) {
    const result = { ok: false, waiting: true, reason: `另一个 Hub 窗口正在使用同一份数据（进程 ${busy.join('、')}），还原没有执行；请先关闭另一个 Hub 窗口，再重启这个 Hub` };
    try { fs.writeFileSync(path.join(root, RESULT_FILE), JSON.stringify({ ...result, at: now.toISOString() }, null, 2), 'utf8'); } catch (_) {}
    return result;
  }
  const finish = result => {
    try { fs.writeFileSync(path.join(root, RESULT_FILE), JSON.stringify({ ...result, at: now.toISOString() }, null, 2), 'utf8'); } catch (_) {}
    try {
      if (result.ok) fs.rmSync(mark, { force: true });
      else {
        const attempts = (Number(req && req.attempts) || 0) + 1;
        if (attempts >= 3 || result.fatal) fs.renameSync(mark, path.join(root, 'restore-failed.json'));
        else fs.writeFileSync(mark, JSON.stringify({ ...req, attempts }), 'utf8');
      }
    } catch (_) {}
    return result;
  };
  if (!req || !path.resolve(String(req.dir || '')).startsWith(root + path.sep)) return finish({ ok: false, fatal: true, reason: '还原请求不合规' });
  let doc; try { doc = JSON.parse(fs.readFileSync(path.join(req.dir, 'backup.json'), 'utf8')); } catch (_) { return finish({ ok: false, fatal: true, reason: '备份清单读不到' }); }
  const list = (doc.list || []).filter(f => { const r = String(f.rel || ''); return r && !r.split('/').includes('..') && !path.isAbsolute(r); });
  const missing = list.filter(f => !fs.existsSync(relPath(path.join(req.dir, 'files'), f.rel)));
  if (missing.length) return finish({ ok: false, fatal: true, reason: `备份里缺文件：${missing[0].rel}` });
  // 要动的目标：备份里的文件 + 库的旁路文件（备份里的库是一致快照，现有 -wal/-shm 留着会叠加到还原后的库上）。
  const inList = new Set(list.map(f => f.rel));
  const removeRels = [];
  // 恢复点记下的「还原前不存在」的文件：再还原这个恢复点时删掉它们（删前照样先存进新恢复点）。只认登记过的，不碰未登记的新文件。
  for (const r of (Array.isArray(doc.absent) ? doc.absent : [])) {
    const rel = String(r || '');
    if (rel && !rel.split('/').includes('..') && !path.isAbsolute(rel) && !inList.has(rel) && !removeRels.includes(rel) && fs.existsSync(relPath(dataDir, rel))) removeRels.push(rel);
  }
  for (const f of list) if (f.sqlite) for (const sfx of SIDE) if (!inList.has(f.rel + sfx) && fs.existsSync(relPath(dataDir, f.rel + sfx))) removeRels.push(f.rel + sfx);
  const touched = [...list.map(f => f.rel), ...removeRels];
  // 恢复点：当前样子原样存下（启动时库还没打开，主库与旁路文件一起复制是一致的）。
  let pointDir = '';
  const saved = [], absent = [];
  try {
    pointDir = createStampedDir(root, 'restore-point', now);
    for (const rel of touched) {
      const cur = relPath(dataDir, rel);
      if (!fs.existsSync(cur)) { absent.push(rel); continue; }
      const dest = relPath(path.join(pointDir, 'files'), rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(cur, dest);
      saved.push({ rel, bytes: fs.statSync(cur).size, ...(isSqliteFile(cur) ? { sqlite: true } : {}) });
    }
    fs.writeFileSync(path.join(pointDir, 'backup.json'), JSON.stringify({ schema: 1, kind: 'restore-point', from: doc.to || '', to: doc.from || '', at: now.toISOString(),
      files: saved.length, bytes: saved.reduce((n, f) => n + f.bytes, 0), source: path.basename(req.dir), list: saved, absent }, null, 2), 'utf8');
  } catch (error) {
    if (pointDir) try { fs.rmSync(pointDir, { recursive: true, force: true }); } catch (_) {}
    return finish({ ok: false, reason: `还原前保存当前文件失败，没有改动任何文件：${error.message}` });
  }
  const done = [];
  try {
    for (const rel of removeRels) { done.push(rel); fs.rmSync(relPath(dataDir, rel), { force: true }); }
    for (const f of list) {
      const dest = relPath(dataDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      done.push(f.rel);
      copy(relPath(path.join(req.dir, 'files'), f.rel), dest + '.restore-tmp');
      fs.renameSync(dest + '.restore-tmp', dest);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const rel of done) {
      const dest = relPath(dataDir, rel);
      try {
        fs.rmSync(dest + '.restore-tmp', { force: true });
        if (absent.includes(rel)) fs.rmSync(dest, { force: true });
        else fs.copyFileSync(relPath(path.join(pointDir, 'files'), rel), dest);
      } catch (_) { rollbackErrors.push(rel); }
    }
    return finish({ ok: false, reason: `还原中途失败（${error.message}），${rollbackErrors.length ? `有 ${rollbackErrors.length} 个文件没能改回，恢复点在 ${path.basename(pointDir)}` : '已全部改回还原前的样子'}`, restorePoint: pointDir });
  }
  return finish({ ok: true, restored: list.length, dir: req.dir, restorePoint: pointDir });
}

module.exports = { PIN_FILE, versionsUrl, validateVersions, buildCatalog, targetManifest, readPin, writePin, clearPin, settlePin,
  collectSmallFiles, isSqliteFile, otherActiveHubs, assertNoOtherHub, OTHER_HUB_MSG, snapshotSqlite, backupForRollback, listBackups, scheduleRestore, applyPendingRestore, readRestoreResult };
