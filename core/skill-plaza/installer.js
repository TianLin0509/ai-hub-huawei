'use strict';
// 技能广场 · 转换与落位：员工助手技能 → Claude / Codex / CodeAgent 通用 SKILL.md。
// 先写到目标同盘的临时目录再整体改名；任一目标失败或台账没写成就回滚本次已装的；
// 只替换、只删除「带本模块标记 + 同一技能 id + 台账有登记」的目录；路径上任何一级是链接/联接都拒绝。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const rules = require('./rules');
const { inside, LIMIT_FILES, LIMIT_BYTES } = require('./weclaw-source');

const MARK = 'weclaw-skill-plaza';
const ORIGIN_FILE = '_origin.json';
const KEEP_FIELDS = ['name', 'description', 'license'];
const DESC_MAX = 1024;
// SKILL.md 头字段的中文名（界面与迁移说明只显示中文）
const FIELD_LABELS = { name: '技能名', description: '说明（触发条件）', license: '许可证', 'allowed-tools': '允许使用的工具',
  'argument-hint': '参数提示', 'user-invocable': '能否直接点名调用', version: '版本', author: '作者', tags: '标签', model: '指定模型',
  metadata: '附加信息', category: '分类', icon: '图标', 'display-name': '显示名', display_name: '显示名' };

const lstat = (io, p) => { try { return io.lstatSync(p); } catch { return null; } };
const isLinkIo = (io, p) => !!lstat(io, p)?.isSymbolicLink();
const sameDir = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
const realOr = (io, p) => { try { return io.realpathSync.native ? io.realpathSync.native(p) : io.realpathSync(p); } catch { return ''; } };

/** 从 p 起逐级往上直到路径根，找第一个链接/联接；没有返回空串。不存在的级（还没建的目录）跳过。 */
function linkInChain(io, p) {
  let cur = path.resolve(String(p || ''));
  for (;;) {
    if (isLinkIo(io, cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return '';
    cur = up;
  }
}
/** 已存在的目录：真实路径必须和字面路径一致（逐级查之外的兜底，防查完后被换成链接或大小写/短名花招）。 */
function realMismatch(io, p) {
  if (!lstat(io, p)) return '';
  const real = realOr(io, p);
  return real && sameDir(real, p) ? '' : `${p} 的真实位置是 ${real || '（读不出）'}`;
}
/** 目标技能目录（及 dest）从自己到路径根的每一级都不能是链接/联接，真实路径与字面一致。 */
function targetChainProblem(io, base, dest) {
  const link = linkInChain(io, dest || base);
  if (link) return `${link} 是链接/联接`;
  return realMismatch(io, dest || base) || (dest ? realMismatch(io, base) : '');
}

/** 转换方案：头字段对照、迁移说明、目标名、最终产物（含生成文件）的文件数与字节数。preview 与 install 共用，不写盘。 */
function plan(item, { now = new Date() } = {}) {
  const x = item._internal;
  const name = rules.targetName(item.name);
  const notes = [], mapping = [];
  let desc = item.description, descNote = '';
  if (!desc) {
    desc = `（待补）从员工助手导入的技能：${item.displayName || x.sourceName}`;
    descNote = '源技能没写说明，已填占位，需要人工补上「什么时候用这个技能」';
  } else if (desc.length > DESC_MAX) {
    descNote = `说明有 ${desc.length} 字，超过 ${DESC_MAX} 字的上限，已截断`;
    desc = desc.slice(0, DESC_MAX - 1) + '…';
  }
  // 对照表与迁移说明只用中文字段名；原键名放 key，给 _origin.json 和排查用。
  mapping.push({ field: FIELD_LABELS.name, key: 'name', before: String(x.fm.name || ''), after: name,
    note: name !== x.fm.name ? '改成小写字母、数字和连字符，并加 weclaw- 前缀，免得和已有技能撞名' : '' });
  mapping.push({ field: FIELD_LABELS.description, key: 'description', before: String(x.fm.description || ''), after: desc, note: descNote });
  if (x.fm.license) mapping.push({ field: FIELD_LABELS.license, key: 'license', before: x.fm.license, after: x.fm.license, note: '' });
  for (const k of x.order.filter(k => !KEEP_FIELDS.includes(k)))
    mapping.push({ field: FIELD_LABELS[k] || '其他设置', key: k, before: String(x.fm[k]), after: '',
      note: FIELD_LABELS[k] ? '不带过去：Claude、Codex 对这一项的理解和员工助手不同，原值留在来源记录里' : '员工助手专用的设置，不带过去，原值留在来源记录里' });
  const fieldNotes = mapping.filter(m => m.note).map(m => `${m.field}：${m.note}`);
  if (Object.keys(x.meta).length) notes.push('员工助手的技能元数据存进来源记录文件，不带云端存储路径');
  if (x.entryDir !== x.skillRoot) notes.push('源技能多套了一层目录，已拍平');
  if (x.listing.links.length) notes.push(`有 ${x.listing.links.length} 个符号链接/联接没有复制（不跟随链接）`);
  for (const d of item.deps) notes.push(`依赖「${d.label}」：${d.why}（出现在 ${d.files.join('、')}）`);

  let head = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n`;
  if (x.fm.license) head += `license: ${x.fm.license}\n`;
  const fm = {}; for (const k of x.order) fm[k] = x.fm[k];
  const generated = {
    'SKILL.md': `${head}---\n${x.body}`,
    [ORIGIN_FILE]: JSON.stringify({ from: MARK, id: item.id, importedAt: now.toISOString(), source: 'weclaw', sourceSkillDir: x.skillRoot,
      original_frontmatter: fm, skillhub_meta: x.meta, conversion_notes: [...fieldNotes, ...notes], deps: item.deps.map(d => d.key) }, null, 1),
  };
  if (item.deps.length) {
    const lines = ['# 迁移说明（技能广场生成；加载技能时不读本文件）', '',
      '本技能依赖员工助手专属能力，原样放进 Claude/Codex/CodeAgent 会找不到这些工具：', ''];
    for (const d of item.deps) lines.push(`- **${d.label}**：${d.why}。出现在 ${d.files.join('、')}`);
    generated['MIGRATION.md'] = lines.join('\n') + '\n';
  }
  // 最终产物：源文件里与生成文件同名的被替换，按替换后算。
  const copied = x.listing.files.filter(f => !Object.hasOwn(generated, f.rel));
  const fileCount = copied.length + Object.keys(generated).length;
  const totalBytes = copied.reduce((n, f) => n + f.size, 0) + Object.values(generated).reduce((n, t) => n + Buffer.byteLength(t), 0);
  return { name, desc, mapping, migrationNotes: notes, generated, copied, fileCount, totalBytes,
    overLimit: x.listing.tooLarge || fileCount > LIMIT_FILES || totalBytes > LIMIT_BYTES };
}

/** 读目标目录里的标记：本模块装的返回 _origin 内容，否则 null。 */
function readOrigin(dir, io = fs) {
  try {
    if (isLinkIo(io, dir)) return null;
    const o = JSON.parse(io.readFileSync(path.join(dir, ORIGIN_FILE), 'utf8'));
    return o && o.from === MARK ? o : null;
  } catch { return null; }
}

/** 源技能根目录从自己到路径根逐级无链接、真实位置与字面一致（SKILL.md 正文也来自这里，没有要复制的文件也要核）。 */
function checkSourceRoot(io, x) {
  const rootLink = linkInChain(io, x.skillRoot);
  if (rootLink) throw new Error(`源技能目录的路径上出现了链接（${rootLink}），已停止`);
  if (realMismatch(io, x.skillRoot)) throw new Error('源技能目录的真实位置变了，已停止');
}
/** 复制前重新核对源文件：从技能根起每一级都不是链接、中间是目录、末级是普通文件、大小和扫描时一致、真实位置仍在技能根内。 */
function checkSource(io, x, f) {
  const parts = f.rel.split('/');
  if (parts.some(s => !s || s === '.' || s === '..')) throw new Error('技能里有不安全的文件路径，已停止');
  checkSourceRoot(io, x);
  let cur = x.skillRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstat(io, cur);
    if (!st) throw new Error(`源文件 ${f.rel} 在扫描后不见了，请刷新后重试`);
    if (st.isSymbolicLink()) throw new Error(`源文件路径 ${f.rel} 在扫描后出现了链接，已停止`);
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error(`源文件 ${f.rel} 的类型在扫描后变了，已停止`);
    if (i === parts.length - 1 && st.size !== f.size) throw new Error(`源文件 ${f.rel} 在扫描后变了，请刷新后重试`);
  }
  const root = realOr(io, x.skillRoot), real = realOr(io, cur);
  if (!root || !real || !inside(root, real)) throw new Error(`源文件 ${f.rel} 的真实位置不在技能目录里，已停止`);
  return cur;
}

function writeStage(io, item, p, stageDir) {
  const x = item._internal;
  checkSourceRoot(io, x);
  for (const f of p.copied) {
    const src = checkSource(io, x, f), dst = path.join(stageDir, ...f.rel.split('/'));
    if (!inside(stageDir, dst)) throw new Error('技能里有不安全的文件路径，已停止');
    io.mkdirSync(path.dirname(dst), { recursive: true });
    io.copyFileSync(src, dst);
  }
  for (const [rel, text] of Object.entries(p.generated)) io.writeFileSync(path.join(stageDir, rel), text);
}

/** 回滚本次已做的落位；删不掉、挪不回的都列出来，不吞。 */
function rollback(io, done) {
  const residue = [];
  for (const rec of [...done].reverse()) {
    if (rec.stage) { try { io.rmSync(rec.stage, { recursive: true, force: true }); } catch { residue.push({ path: rec.stage, what: '临时目录' }); } }
    if (rec.placed) {
      try { io.rmSync(rec.dest, { recursive: true, force: true }); rec.placed = false; }
      catch { residue.push({ path: rec.dest, what: '本次装的新版（没删掉）' }); }
    }
    if (rec.backup) {
      if (rec.placed) { residue.push({ path: rec.backup, what: '旧版备份（新版没删掉，没法挪回）' }); continue; }
      try { io.renameSync(rec.backup, rec.dest); }
      catch { residue.push({ path: rec.backup, what: `旧版备份（没能挪回 ${rec.dest}）` }); }
    }
  }
  return residue;
}
function rollbackError(reason, residue) {
  if (!residue.length) return Object.assign(new Error(`导入失败，已撤回本次装好的部分：${reason}`), { residue });
  const list = residue.map(r => `${r.what}：${r.path}`).join('；');
  return Object.assign(new Error(`导入失败：${reason}。撤回没有做完，请手动处理：${list}`), { residue });
}

/**
 * 装到多个目标。targets：[{id,label,dir}]；ledgerEntry：台账里这个技能已有的记录（判断能否替换已有目录）。
 * 返回事务 { installed, skipped, commit(), rollback() }：调用方写好台账后 commit（删旧版备份），台账失败就 rollback。
 * 落位过程中出错会自己回滚并抛错（error.residue 列出没清掉的目录）。
 */
function install(item, p, targets, { ledgerEntry = null, fs: io = fs, beforeRename } = {}) {
  const installed = [], skipped = [], done = [];
  const registered = (t, dest) => (ledgerEntry?.targets || []).some(e => e.target === t.id && sameDir(e.dir, dest));
  try {
    for (const t of targets) {
      const dest = path.join(t.dir, p.name);
      if (!sameDir(path.dirname(dest), t.dir) || !rules.TARGET_NAME_RE.test(p.name)) throw new Error('安装目录不安全，已停止');
      const chain = targetChainProblem(io, t.dir, '');
      if (chain) { skipped.push({ target: t.id, reason: `${t.label} 的技能目录路径上有链接（${chain}），为安全起见没有写入` }); continue; }
      const exists = !!lstat(io, dest);
      if (exists) {
        const destProblem = targetChainProblem(io, t.dir, dest);
        const origin = destProblem ? null : readOrigin(dest, io);
        let reason = '';
        if (destProblem) reason = `${t.label} 里同名目录 ${p.name} 不安全（${destProblem}），没有覆盖`;
        else if (!origin) reason = `${t.label} 里已有同名技能 ${p.name}，不是技能广场装的，没有覆盖`;
        else if (origin.id !== item.id) reason = `${t.label} 里 ${p.name} 是从另一个员工助手技能导入的，名字撞了，没有覆盖`;
        else if (!registered(t, dest)) reason = `${t.label} 里 ${p.name} 在导入台账里没有记录，没有覆盖（要重装请先手动删掉这个目录）`;
        if (reason) { skipped.push({ target: t.id, reason }); continue; }
      }
      io.mkdirSync(t.dir, { recursive: true });
      const tag = crypto.randomBytes(4).toString('hex');
      const stage = path.join(t.dir, `.skill-plaza-tmp-${tag}`);
      io.mkdirSync(stage); // 已存在（EEXIST）就直接抛错，不登记，回滚也就绝不会删别人的目录
      const rec = { target: t.id, dest, stage, backup: '', placed: false };
      done.push(rec);
      writeStage(io, item, p, rec.stage);
      if (beforeRename) beforeRename(t.id);
      if (exists) {
        const b = path.join(t.dir, `.skill-plaza-old-${tag}`);
        if (lstat(io, b)) throw new Error(`备份位置 ${b} 已被占用，已停止`);
        io.renameSync(dest, b); rec.backup = b;
      }
      io.renameSync(rec.stage, dest);
      rec.stage = ''; rec.placed = true;
      installed.push({ target: t.id, dir: dest });
    }
  } catch (error) {
    throw rollbackError(error.message, rollback(io, done));
  }
  let settled = false;
  return {
    installed, skipped,
    /** 台账已写好：删旧版备份。删不掉的备份作为提醒返回，不算失败。 */
    commit() {
      if (settled) return []; settled = true;
      const left = [];
      for (const rec of done) if (rec.backup) { try { io.rmSync(rec.backup, { recursive: true, force: true }); } catch { left.push(rec.backup); } }
      return left;
    },
    rollback(reason) {
      if (settled) throw new Error('这次导入已经提交，不能撤回'); settled = true;
      return rollbackError(reason, rollback(io, done));
    },
  };
}

/** 删一个台账里登记的目录：名字合规、在已知目标目录下、路径上没有链接、真实位置对得上、带本模块标记且 id 一致。 */
function removeDir(entry, targetDirs, id, { fs: io = fs } = {}) {
  const dir = path.resolve(String(entry.dir || ''));
  const base = targetDirs[entry.target];
  if (!base || !sameDir(path.dirname(dir), base) || !rules.TARGET_NAME_RE.test(path.basename(dir))) return { ok: false, reason: '登记的位置不在技能目录里，没有删除' };
  const chain = targetChainProblem(io, base, '');
  if (chain) return { ok: false, reason: `技能目录路径上有链接（${chain}），没有删除` };
  if (!lstat(io, dir)) return { ok: true, gone: true };
  const problem = targetChainProblem(io, base, dir);
  if (problem) return { ok: false, reason: `${problem}，没有删除` };
  const origin = readOrigin(dir, io);
  if (!origin || origin.id !== id) return { ok: false, reason: '目录里没有技能广场的标记，可能已被别的方式改过，没有删除' };
  try { io.rmSync(dir, { recursive: true, force: true }); }
  catch (error) { return { ok: false, reason: `删除失败：${error.code || error.message}` }; }
  return { ok: true };
}

// ---- 台账 <数据目录>/skill-plaza/imports.json：{ [id]: { at, source, targets:[{target,dir}] } }
function ledgerPath(dataDir) { return path.join(dataDir, 'skill-plaza', 'imports.json'); }
function validLedger(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  return Object.values(d).every(e => e && typeof e === 'object' && Array.isArray(e.targets)
    && e.targets.every(t => t && typeof t.target === 'string' && typeof t.dir === 'string'));
}
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').slice(0, 18);
/**
 * 读台账。不存在 → {}；没有权限 → 报错；内容损坏 → strict 时把原文件另存为 .corrupt-<时间> 再报错（不当空台账覆盖），
 * 非 strict（只用于列表展示）时当作空台账、不动文件。
 */
function readLedger(dataDir, { strict = false, fs: io = fs } = {}) {
  const file = ledgerPath(dataDir);
  let raw;
  try { raw = io.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {};
    if (!strict) return {};
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error(`没有权限读导入台账 ${file}，请检查 Hub 数据目录的权限`);
    throw new Error(`读不了导入台账 ${file}：${error.code || error.message}`);
  }
  let data = null;
  try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch { data = null; }
  if (validLedger(data)) return data;
  if (!strict) return {};
  // 备份名带毫秒和随机串；用「不覆盖」方式复制（已有同名就换个名再试），复制成功才删原文件。
  let kept = '';
  for (let i = 0; i < 5 && !kept; i++) {
    const name = `${file}.corrupt-${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
    try { io.copyFileSync(file, name, fs.constants.COPYFILE_EXCL); kept = name; }
    catch (error) {
      if (error.code === 'EEXIST') continue;
      throw new Error(`导入台账 ${file} 已损坏，另存也失败了（${error.code || error.message}），这次没有做任何改动`);
    }
  }
  if (!kept) throw new Error(`导入台账 ${file} 已损坏，没找到不重名的备份位置，这次没有做任何改动`);
  try { io.rmSync(file, { force: true }); }
  catch (error) { throw new Error(`导入台账已损坏，已另存为 ${kept}，但原文件删不掉（${error.code || error.message}），这次没有做任何改动`); }
  throw new Error(`导入台账已损坏，原文件另存为 ${kept}，这次没有做任何改动；再操作一次会从空台账开始记`);
}
function writeLedger(dataDir, ledger, { fs: io = fs } = {}) {
  const file = ledgerPath(dataDir);
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try { io.writeFileSync(tmp, JSON.stringify(ledger, null, 2)); io.renameSync(tmp, file); }
  catch (error) { try { io.rmSync(tmp, { force: true }); } catch { /* 临时文件留着也无害 */ } throw new Error(`写导入台账失败：${error.code || error.message}`); }
}

module.exports = { MARK, ORIGIN_FILE, plan, install, removeDir, readOrigin, ledgerPath, readLedger, writeLedger, targetChainProblem, checkSource };
