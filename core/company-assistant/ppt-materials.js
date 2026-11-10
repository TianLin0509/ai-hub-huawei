'use strict';
// PPT 素材（2026-11-10）：只读 PPT Doctor 的素材库，加上用户直接打开的「团队素材包」pptx。
// Doctor 素材库在 %LOCALAPPDATA%\pptx-finder\materials\<id>\（item.json + material.pptx + preview.png），
// Hub 只读不写；Doctor 的命令行联动协议没有素材接口，所以这里直接读它的目录。
// 素材包：一页一个原生形状，备注首行 "PPT Doctor Material v1"，下一段是 JSON {id,name,category}。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MARKER = 'PPT Doctor Material v1';
const MAX_ITEMS = 2000;
const MAX_PACKS = 5;
const CACHE_MS = 5000;
const hashId = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function doctorDataDir(env = process.env) {
  if (env.PPTX_FINDER_DATA_DIR) return env.PPTX_FINDER_DATA_DIR;
  return path.join(env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'pptx-finder');
}

// Doctor 素材库：每个子目录一条；Doctor 的回收站（.trash）和半成品（没有 material.pptx）跳过。
function readDoctorLibrary(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const items = [];
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || items.length >= MAX_ITEMS) continue;
    const folder = path.join(dir, entry.name), pptx = path.join(folder, 'material.pptx');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'item.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch { continue; }
    if (!fs.existsSync(pptx)) continue;
    const preview = path.join(folder, 'preview.png');
    items.push({ id: 'd:' + clean(meta.id || entry.name, 64), name: clean(meta.name, 120) || '未命名素材', category: clean(meta.category, 80) || '未分类',
      created: Number(meta.created) || 0, source: 'doctor', pptx, page: 1, ...(fs.existsSync(preview) ? { preview } : {}) });
  }
  return items;
}

// 素材包：按备注里的标记逐页取名称和分类；没标记的页不算素材。
function readPack(file) {
  const { openZip, readEntry, parseXml } = require('./ppt-slide-preview');
  const zip = openZip(file);
  const text = name => { const buf = readEntry(zip, name); return buf ? buf.toString('utf8') : ''; };
  const rels = part => {
    const relsPart = part.replace(/([^/]+)$/, '_rels/$1.rels');
    const map = new Map();
    for (const m of text(relsPart).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]+)"/) || [])[1], target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1], type = (m[0].match(/\bType="([^"]+)"/) || [])[1] || '';
      if (id && target) map.set(id, { target: path.posix.normalize(path.posix.join(path.posix.dirname(part), target)), type });
    }
    return map;
  };
  const presRels = rels('ppt/presentation.xml');
  const ids = [...text('ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map(m => m[1]);
  const fileKey = hashId(path.resolve(file).toLowerCase());
  const items = [];
  ids.forEach((rid, index) => {
    if (items.length >= MAX_ITEMS) return;
    const slide = presRels.get(rid)?.target;
    if (!slide) return;
    const notes = [...rels(slide).values()].find(r => /notesSlide$/.test(r.type))?.target;
    if (!notes) return;
    const tree = parseXml(text(notes));
    const paras = [];
    (function walk(node) {
      for (const child of node.children || []) {
        if (/(^|:)p$/.test(child.name)) { let s = ''; (function runs(n) { for (const c of n.children || []) { if (/(^|:)t$/.test(c.name)) s += c.text || ''; else runs(c); } })(child); paras.push(s); }
        else walk(child);
      }
    })(tree);
    // 备注里还可能有页码占位符：找到标记后取其后的第一段 JSON。
    const body = paras.join('\n'), at = body.indexOf(MARKER);
    if (at < 0) return;
    const rest = body.slice(at + MARKER.length), open = rest.indexOf('{'), close = rest.lastIndexOf('}');
    let meta;
    try { meta = JSON.parse(rest.slice(open, close + 1)); } catch { return; }
    items.push({ id: `p:${fileKey}:${index + 1}`, name: clean(meta.name, 120) || '未命名素材', category: clean(meta.category, 80) || '未分类',
      created: 0, source: 'pack', pptx: path.resolve(file), page: index + 1 });
  });
  return items;
}

class PptMaterials {
  constructor(library, deps = {}) {
    this.lib = library; this.deps = deps; this.env = deps.pptEnv || process.env;
    this.cache = null; this.busy = false;
  }
  config() { return this.lib.config(); }
  dir() { return this.config().materialsDir || path.join(doctorDataDir(this.env), 'materials'); }
  packs() { return (this.config().materialPacks || []).filter(p => typeof p === 'string' && path.isAbsolute(p)).slice(0, MAX_PACKS); }
  load({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const errors = [];
    let doctor = [];
    try { doctor = readDoctorLibrary(this.dir()); } catch (error) { errors.push(`PPT Doctor 素材库读不出来：${error.message}`); }
    const seen = new Set(doctor.map(i => i.category + '\0' + i.name));
    const packs = [];
    for (const file of this.packs()) {
      try {
        if (!fs.existsSync(file)) { errors.push(`素材包不在了：${path.basename(file)}`); continue; }
        const items = readPack(file);
        packs.push({ file, count: items.length });
        // 同一个素材包已导入 Doctor 时，以 Doctor 那份为准（Doctor 导入会重新编号，只能按分类 + 名称认）。
        for (const it of items) if (!seen.has(it.category + '\0' + it.name)) doctor.push(it);
      } catch (error) { errors.push(`素材包读不出来（${path.basename(file)}）：${error.message}`); }
    }
    const items = doctor.slice(0, MAX_ITEMS);
    const counts = new Map();
    for (const it of items) counts.set(it.category, (counts.get(it.category) || 0) + 1);
    this.cache = { at: Date.now(), items, byId: new Map(items.map(i => [i.id, i])), categories: [...counts].map(([name, count]) => ({ name, count })),
      dir: this.dir(), packs, errors, doctorCount: items.filter(i => i.source === 'doctor').length };
    return this.cache;
  }
  // 界面和 AI 共用：按分类和名称筛。query 按空格拆词，每个词都要出现在名称或分类里。
  list({ query = '', category = '', offset = 0, limit = 60, force = false } = {}) {
    const data = this.load({ force });
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const hits = data.items.filter(i => (!category || i.category === category) && words.every(w => (i.name + ' ' + i.category).toLowerCase().includes(w)));
    const start = Math.max(0, Number(offset) || 0), size = Math.max(1, Math.min(MAX_ITEMS, Number(limit) || 60));
    return { ok: true, total: hits.length, offset: start, items: hits.slice(start, start + size).map(({ pptx, preview, ...rest }) => ({ ...rest, pptx, ...(preview ? { preview } : {}) })),
      categories: data.categories, library: { dir: data.dir, doctorCount: data.doctorCount, packs: data.packs, errors: data.errors, total: data.items.length } };
  }
  get(id) {
    const item = this.load().byId.get(String(id || '')) || this.load({ force: true }).byId.get(String(id || ''));
    if (!item) throw Object.assign(new Error('这个素材已不在素材库里，请刷新'), { code: 'UNKNOWN_MATERIAL' });
    if (!fs.existsSync(item.pptx)) throw Object.assign(new Error('素材文件已被移走，请刷新'), { code: 'UNKNOWN_MATERIAL' });
    return item;
  }
  async preview(id) {
    const item = this.get(id);
    const scene = await this.lib.previewScene(item.pptx, item.page);
    return { ok: true, id: item.id, scene, ...(item.preview ? { image: item.preview } : {}) };
  }
  addPack(file) {
    const resolved = path.resolve(String(file || ''));
    if (!/\.pptx$/i.test(resolved) || !fs.existsSync(resolved)) throw new Error('请选择团队素材包（.pptx）');
    const items = readPack(resolved);
    if (!items.length) throw new Error('这个文件里没有素材标记，不是团队素材包；可在 PPT Doctor 素材库里导出或下载素材包');
    const packs = [resolved, ...this.packs().filter(p => path.resolve(p).toLowerCase() !== resolved.toLowerCase())].slice(0, MAX_PACKS);
    this.lib.a.setSettings({ ppt: { materialPacks: packs } });
    this.cache = null;
    return { ok: true, added: items.length, file: resolved };
  }
  // 用户点「插入到当前 PPT」/「复制形状」时才执行；都会写剪贴板（PowerPoint 跨文稿搬形状只能经剪贴板）。
  async transfer(id, mode) {
    if (this.busy) throw new Error('上一个素材还在处理，请稍等');
    const item = this.get(id);
    this.busy = true;
    try { return await (this.deps.pptMaterialTransfer || transferMaterial)(item.pptx, item.page, mode); }
    finally { this.busy = false; }
  }
}

// PowerShell + PowerPoint COM。insert：贴到当前打开、可编辑的 PPT 的当前页；copy：只放进剪贴板。
// 只关闭本次以只读、无窗口方式打开的素材文稿；用户的文稿和 PowerPoint 本身都不关。
// copy 也要求 PowerPoint 已经开着：剪贴板里的形状由 PowerPoint 按需提供，后台临时启动的实例实测会卡住或退出后丢失剪贴板。
function transferMaterial(file, page, mode) {
  if (process.platform !== 'win32') return Promise.reject(new Error('素材插入需要 Windows 上的 PowerPoint'));
  const insert = mode === 'insert';
  const script = [
    '$ErrorActionPreference="Stop"',
    '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)',
    '$file=[Environment]::GetEnvironmentVariable("HUB_PPT_MATERIAL_FILE")',
    '$page=[int][Environment]::GetEnvironmentVariable("HUB_PPT_MATERIAL_PAGE")',
    '$src=$null',
    'try {',
    insert
      ? 'try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")} catch {throw "先打开要放素材的 PPT"}'
      : 'try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")} catch {throw "先打开 PowerPoint 再复制（剪贴板里的形状要由 PowerPoint 提供）"}',
    ...(insert ? [
      'try {$target=$app.ActivePresentation} catch {throw "先打开要放素材的 PPT"}',
      'if ($null -eq $target) {throw "先打开要放素材的 PPT"}',
      'if ($target.ReadOnly) {throw "当前 PPT 是只读的，请打开可编辑的文稿"}',
      '$slide=$null',
      'try {$slide=$app.ActiveWindow.View.Slide} catch {try {$slide=$app.ActiveWindow.Selection.SlideRange.Item(1)} catch {}}',
      'if ($null -eq $slide) {throw "请先在目标 PPT 里点一下要放素材的那一页"}',
    ] : []),
    // 用户自己开着这份素材文稿时直接用它，且不关（避免关掉用户的窗口和未保存修改）。
    '$own=$null; foreach ($p in $app.Presentations) { if ($p.FullName -eq $file) { $own=$p; break } }',
    'if ($null -ne $own) { $src0=$own } else { $src=$app.Presentations.Open($file,-1,0,0); $src0=$src }',
    'if ($page -lt 1 -or $page -gt $src0.Slides.Count) {throw "素材页码不对，请刷新素材库"}',
    '$shapes=$src0.Slides.Item($page).Shapes',
    'if ($shapes.Count -lt 1) {throw "这个素材是空的"}',
    '$shapes.Range().Copy()',
    '$count=$shapes.Count',
    'if ($null -ne $src) { $src.Close(); $src=$null }',
    ...(insert ? [
      '$pasted=$slide.Shapes.Paste()',
      'try {$pasted.Select()} catch {}',
      '@{ok=$true;mode="insert";target=$target.Name;page=$slide.SlideIndex;count=$pasted.Count}|ConvertTo-Json -Compress',
    ] : [
      '@{ok=$true;mode="copy";count=$count}|ConvertTo-Json -Compress',
    ]),
    '} catch { if ($null -ne $src) { try {$src.Close()} catch {} }; @{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress; exit 1 }',
  ].join('\n');
  return new Promise((resolve, reject) => {
    let settled = false, stdout = '';
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PPT_MATERIAL_FILE: file, HUB_PPT_MATERIAL_PAGE: String(page) } });
    const timer = setTimeout(() => { child.kill(); finish(new Error('PowerPoint 一分钟没有响应，请看一眼目标 PPT 后再试')); }, 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 65536) { child.kill(); finish(new Error('PowerPoint 返回内容异常，请重试')); } });
    child.stderr.resume();
    child.on('error', error => finish(new Error('PowerPoint 联动没能启动：' + error.message)));
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
        if (code !== 0 || result.ok !== true) throw new Error(result.error || 'PowerPoint 没有完成这一步');
        finish(null, result);
      } catch (error) { finish(new Error(error instanceof SyntaxError ? 'PowerPoint 没有返回结果，请看一眼目标 PPT 后再试' : error.message)); }
    });
  });
}

module.exports = { PptMaterials, readDoctorLibrary, readPack, doctorDataDir, transferMaterial, MARKER };
