'use strict';
// 技能广场 · 员工助手来源：扫三个根目录、读技能、分析依赖与敏感标记。只读，不跟随符号链接/联接。
const fs = require('node:fs');
const path = require('node:path');
const rules = require('./rules');

const LIMIT_FILES = 2000;
const LIMIT_BYTES = 50 * 1024 * 1024;
const TEXT_MAX = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);
const SKIP_FILES = new Set(['_skillhub_meta.json', '.register.json', '.cloud-sync.json']);
const TEXT_EXT = new Set(['.md', '.py', '.js', '.mjs', '.cjs', '.ps1', '.json', '.txt', '.sh', '.ts', '.yaml', '.yml', '.bat', '.cmd']);
const ID_PREFIX = 'weclaw:';

function weclawRoots(homeDir) {
  return [
    path.join(homeDir, '.config', 'weclaw', 'opencode', 'skills'),
    path.join(homeDir, '.skillhub', 'workspace', 'skills'),
    path.join(homeDir, '.config', 'weclaw', 'package', 'default', 'skills'),
  ];
}

const isLink = file => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
/** 防路径穿越：child 必须落在 root 之内。 */
function inside(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 员工助手云端同步的技能常多套一层目录（04_工时填报/itimes-timesheet/SKILL.md）：取最浅的 SKILL.md，最多下探 3 层。 */
function findSkillRoot(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md')) && !isLink(path.join(dir, 'SKILL.md'))) return dir;
  let level = [dir];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next = [];
    for (const d of level) for (const e of listDir(d)) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name), md = path.join(sub, 'SKILL.md');
      if (fs.existsSync(md) && !isLink(md)) return sub;
      next.push(sub);
    }
    level = next.sort();
  }
  return '';
}

function readMeta(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '_skillhub_meta.json'), 'utf8').replace(/^﻿/, '');
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
    delete meta.s3ZipKey; // 云存储对象路径不带走
    return meta;
  } catch { return {}; }
}

/**
 * 列出要复制的文件（相对路径），跳过排除项；遇到符号链接/联接只记下不跟随；超限立即停。
 * 返回 { files:[{rel,size}], links:[rel], tooLarge, fileCount, totalBytes }
 */
function listFiles(root) {
  const files = [], links = [];
  let totalBytes = 0, tooLarge = false;
  const walk = (dir, rel) => {
    for (const e of listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (tooLarge) return;
      const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (!inside(root, abs)) continue;
      if (e.isSymbolicLink()) { links.push(r); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, r); continue; }
      if (!e.isFile() || (!rel && SKIP_FILES.has(e.name)) || SKIP_FILES.has(e.name)) continue;
      let size = 0; try { size = fs.lstatSync(abs).size; } catch { continue; }
      files.push({ rel: r, size }); totalBytes += size;
      if (files.length > LIMIT_FILES || totalBytes > LIMIT_BYTES) tooLarge = true;
    }
  };
  walk(root, '');
  return { files, links, tooLarge, fileCount: files.length, totalBytes };
}

/**
 * 依赖检测用的文本表：每个文件都按文件名参与检测（正文为空串）；小于 2 MB 的文本文件再读正文。
 * 返回 { texts, unscanned }：unscanned 是本该看正文却没看到的文本文件（太大、读失败、技能整体超限）。
 */
function readTexts(root, files, { skipBodies = false, skillMd = '' } = {}) {
  const texts = {}, unscanned = [];
  for (const f of files) {
    texts[f.rel] = '';
    const isText = TEXT_EXT.has(path.extname(f.rel).toLowerCase()) && !f.rel.endsWith('-lock.json');
    if (!isText) continue;
    if (f.rel === 'SKILL.md' && skillMd) { texts[f.rel] = skillMd; continue; }
    if (skipBodies || f.size > TEXT_MAX) { unscanned.push(f.rel); continue; }
    try { texts[f.rel] = fs.readFileSync(path.join(root, ...f.rel.split('/')), 'utf8'); } catch { unscanned.push(f.rel); }
  }
  if (skillMd && !('SKILL.md' in texts)) texts['SKILL.md'] = skillMd;
  return { texts, unscanned };
}

/** 读一个员工助手技能目录（entryDir 是根目录下的一项）。返回 null 表示不是技能或应跳过。 */
function readSkill(rootIndex, root, entryName) {
  const entryDir = path.join(root, entryName);
  if (!inside(root, entryDir) || isLink(entryDir)) return null;
  const skillRoot = findSkillRoot(entryDir);
  if (!skillRoot) return null; // core 这类没有 SKILL.md 的目录
  const meta = { ...readMeta(entryDir), ...readMeta(skillRoot) };
  if (meta.enabled === false || meta.visibility === 'internal') return { skipped: true, entryName };
  let text = '';
  try { text = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'); } catch { return null; }
  const { fm, order, body } = rules.parseFrontmatter(text);
  const listing = listFiles(skillRoot);
  const { texts, unscanned } = readTexts(skillRoot, listing.files, { skipBodies: listing.tooLarge, skillMd: text });
  const deps = rules.detectDeps(texts);
  // 正文没扫到的文本文件不能当成「没依赖」：降为需改写，迁移说明里写原因。
  if (unscanned.length) deps.push({ key: 'unscanned', label: '未检查的文件', tier: 'fix', files: unscanned.slice(0, 5),
    why: `有 ${unscanned.length} 个文本文件${listing.tooLarge ? '（技能整体超限）' : '超过 2 MB 或读不出'}，没有检查正文，无法确认是否依赖员工助手，导入后请人工核对` });
  const sensitive = rules.detectSensitive(texts);
  const sourceName = fm.name || meta.name || path.basename(skillRoot);
  const normalized = rules.slug(sourceName, meta.skillId, path.basename(skillRoot), entryName);
  const description = String(fm.description || meta.description_zh || meta.description || '').trim();
  const displayName = String(meta.display_name || meta.displayName || fm.name || entryName);
  const use = rules.useTier({ names: [normalized, sourceName, entryName, path.basename(skillRoot)], deps });
  return {
    id: ID_PREFIX + normalized, source: 'weclaw', name: normalized, displayName, description,
    category: rules.classifyCategory(`${sourceName} ${displayName} ${entryName}`, description),
    use, companyOnly: Object.keys(sensitive).length > 0, sensitive,
    deps: deps.map(({ key, label, why, files }) => ({ key, label, why, files })),
    installedIn: [], version: meta.version ? String(meta.version) : undefined, path: skillRoot,
    // 以下只在主进程用，不送页面
    _internal: { root, rootIndex, entryDir, skillRoot, fm, order, body, meta, sourceName, listing, tier: use },
  };
}

/** 扫三个根目录，同名按根目录顺序取第一个。 */
function scanWeclaw(homeDir, { roots = weclawRoots(homeDir) } = {}) {
  const items = new Map(), skipped = [];
  roots.forEach((root, index) => {
    if (isLink(root)) return;
    for (const e of listDir(root)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue; // 符号链接/联接 isDirectory() 为假，直接不看
      const item = readSkill(index, root, e.name);
      if (!item) continue;
      if (item.skipped) { skipped.push(item.entryName); continue; }
      if (!items.has(item.id)) items.set(item.id, item);
    }
  });
  return { items: [...items.values()], skipped, roots: roots.filter(r => fs.existsSync(r)) };
}

module.exports = { LIMIT_FILES, LIMIT_BYTES, SKIP_DIRS, SKIP_FILES, ID_PREFIX, weclawRoots, findSkillRoot, readMeta, listFiles, readSkill, scanWeclaw, inside, isLink };
