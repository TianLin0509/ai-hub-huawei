'use strict';
// PPT 页「素材」Tab（2026-11-10）：读 PPT Doctor 素材库与团队素材包、筛选分页数据、插入调用、AI 查素材工具，以及素材预览要用到的形状细节。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { PptMaterials, readPack, readDoctorLibrary, MARKER, TEAM_PACK_FILE } = require('../core/company-assistant/ppt-materials');
const { buildSlideScene } = require('../core/company-assistant/ppt-slide-preview');
const { sceneSvg, presetPoints } = require('../renderer/ppt-slide-svg');
const { TOOLSETS, toolsFor } = require('../core/company-assistant/mcp');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function writeZip(file, parts) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (...items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const para = text => `<a:p><a:r><a:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}</a:t></a:r></a:p>`;
const notesXml = paras => `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld></a:p></p:txBody></p:sp><p:sp><p:txBody><a:bodyPr/>${paras.map(para).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
const SHAPES = {
  // 自定义形状：屋顶形轮廓 + 两色线性渐变（90°，上到下）
  cust: '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Roof"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:custGeom><a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="0" y="100"/></a:moveTo><a:lnTo><a:pt x="20" y="0"/></a:lnTo><a:lnTo><a:pt x="180" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="190" y="0"/><a:pt x="200" y="50"/><a:pt x="200" y="100"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="F2F2F2"/></a:gs><a:gs pos="100000"><a:srgbClr val="BFBFBF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></p:spPr></p:sp>',
  hex: '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Hex"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm flipH="1"><a:off x="5080000" y="1270000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="hexagon"><a:avLst><a:gd name="adj" fmla="val 30000"/><a:gd name="vf" fmla="val 115470"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="C7000B"/></a:solidFill></p:spPr></p:sp>',
  formula: '<p:sp><p:nvSpPr><p:cNvPr id="4" name="F"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm><a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="l" y="t"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="333333"/></a:solidFill></p:spPr></p:sp>',
};
function makePack(file, slides) {
  const parts = {
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(...slides.map((_, i) => rel(`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`))),
  };
  slides.forEach((s, i) => {
    parts[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.shapes || ''}</p:spTree></p:cSld></p:sld>`;
    if (s.notes) {
      parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels(rel('rId9', 'notesSlide', `../notesSlides/notesSlide${i + 1}.xml`));
      parts[`ppt/notesSlides/notesSlide${i + 1}.xml`] = notesXml(s.notes);
    }
  });
  writeZip(file, parts);
}
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-materials-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const meta = obj => [MARKER, JSON.stringify(obj)];

test('素材包：按备注标记逐页取名称与分类；页码占位符在前也认；没标记、JSON 坏的页不算素材', t => {
  const dir = tmp(t), file = path.join(dir, '20261110-团队素材包.pptx');
  makePack(file, [
    { shapes: SHAPES.cust, notes: meta({ id: 'a1', name: '灰渐变屋顶栏头', category: '栏头与标题条' }) },
    { shapes: SHAPES.hex, notes: ['普通备注，不是素材'] },
    { shapes: SHAPES.hex, notes: [MARKER, '{坏的 JSON'] },
    { shapes: SHAPES.hex, notes: meta({ id: 'a4', name: '红色六边形' }) },
  ]);
  const items = readPack(file);
  assert.deepEqual(items.map(i => [i.name, i.category, i.page, i.source]), [['灰渐变屋顶栏头', '栏头与标题条', 1, 'pack'], ['红色六边形', '未分类', 4, 'pack']]);
  assert.ok(items.every(i => i.pptx === path.resolve(file) && /^p:[0-9a-f]{16}:\d+$/.test(i.id)));
});

test('Doctor 素材库：读 item.json；回收站、缺 material.pptx、坏 JSON 跳过；有 preview.png 就带上', t => {
  const dir = tmp(t);
  const put = (name, item, files = ['material.pptx']) => { const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true }); if (item) fs.writeFileSync(path.join(d, 'item.json'), typeof item === 'string' ? item : JSON.stringify(item)); for (const f of files) fs.writeFileSync(path.join(d, f), 'x'); };
  put('aaa', { id: 'aaa', name: '蓝色胶囊', category: '编号·标签·胶囊', created: 5 }, ['material.pptx', 'preview.png']);
  put('bbb', { id: 'bbb', name: '没有文件' }, []);
  put('ccc', '{坏');
  put('.trash', { id: 'zzz', name: '已删除' });
  const items = readDoctorLibrary(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'd:aaa');
  assert.equal(items[0].preview, path.join(dir, 'aaa', 'preview.png'));
  assert.deepEqual(readDoctorLibrary(path.join(dir, '不存在')), []);
});

function fixture(t, { doctor = [], packs = [] } = {}) {
  const dir = tmp(t), lib = path.join(dir, 'materials'), settings = { ppt: {} }, calls = [];
  for (const m of doctor) { const d = path.join(lib, m.id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'item.json'), JSON.stringify(m)); fs.writeFileSync(path.join(d, 'material.pptx'), 'x'); }
  const library = { config: () => settings.ppt, a: { dir: path.join(dir, 'assistant'), setSettings: patch => { settings.ppt = { ...settings.ppt, ...patch.ppt }; } }, previewScene: async (file, page) => ({ w: 960, h: 540, items: [], file, page }) };
  const materials = new PptMaterials(library, { pptEnv: { PPTX_FINDER_DATA_DIR: dir }, pptMaterialTransfer: async (file, page, mode) => { calls.push({ file, page, mode }); return { ok: true, mode, target: '目标.pptx', page: 3, count: 1 }; } });
  const packFiles = packs.map((slides, i) => { const f = path.join(dir, `pack${i}.pptx`); makePack(f, slides); return f; });
  return { dir, lib, settings, materials, calls, packFiles };
}

test('素材库合并：Doctor 优先、素材包补齐（同分类同名去重）；分类计数；按名称和分类筛；分页偏移', async t => {
  const f = fixture(t, {
    doctor: [{ id: 'd1', name: '灰渐变屋顶栏头', category: '栏头与标题条' }, { id: 'd2', name: '红色箭头', category: '箭头与流程' }],
    packs: [[
      { shapes: SHAPES.cust, notes: meta({ name: '灰渐变屋顶栏头', category: '栏头与标题条' }) },
      { shapes: SHAPES.hex, notes: meta({ name: '蓝色光带', category: '光带·托板·展台' }) },
      { shapes: SHAPES.hex, notes: meta({ name: '三段箭头', category: '箭头与流程' }) },
    ]],
  });
  assert.equal(f.materials.list().library.total, 2, '没打开素材包时只有 Doctor 素材');
  const added = f.materials.addPack(f.packFiles[0]);
  assert.equal(added.added, 3);
  assert.deepEqual(f.settings.ppt.materialPacks, [path.resolve(f.packFiles[0])], '打开过的素材包记进设置，下次启动还在');
  const all = f.materials.list();
  assert.equal(all.total, 4, '重复的屋顶栏头只留 Doctor 那份');
  assert.deepEqual(all.categories.find(c => c.name === '箭头与流程'), { name: '箭头与流程', count: 2 });
  assert.equal(all.library.doctorCount, 2);
  assert.deepEqual(f.materials.list({ category: '箭头与流程' }).items.map(i => i.name).sort(), ['三段箭头', '红色箭头']);
  assert.deepEqual(f.materials.list({ query: '光带' }).items.map(i => i.name), ['蓝色光带'], '名称或分类里含词即命中');
  assert.deepEqual(f.materials.list({ query: '箭头 三段' }).items.map(i => i.name), ['三段箭头'], '多个词都要命中');
  assert.equal(f.materials.list({ offset: 3, limit: 2 }).items.length, 1);
  assert.throws(() => f.materials.addPack(path.join(f.dir, 'nope.pptx')), /团队素材包/);
  const plain = path.join(f.dir, 'plain.pptx'); makePack(plain, [{ shapes: SHAPES.hex, notes: ['普通备注'] }]);
  assert.throws(() => f.materials.addPack(plain), /不是团队素材包/);
});

test('插入与复制：只接受素材库里的编号，按素材文件和页码交给 PowerPoint；同时只处理一个', async t => {
  const f = fixture(t, { packs: [[{ shapes: SHAPES.hex, notes: meta({ name: 'A', category: 'X' }) }, { shapes: SHAPES.hex, notes: meta({ name: 'B', category: 'X' }) }]] });
  f.materials.addPack(f.packFiles[0]);
  const b = f.materials.list({ query: 'B' }).items[0];
  const r = await f.materials.transfer(b.id, 'insert');
  assert.equal(r.target, '目标.pptx');
  assert.deepEqual(f.calls, [{ file: path.resolve(f.packFiles[0]), page: 2, mode: 'insert' }]);
  await assert.rejects(f.materials.transfer('p:不存在:1', 'copy'), /不在素材库/);
  let release;
  f.materials.deps.pptMaterialTransfer = () => new Promise(resolve => { release = resolve; });
  const first = f.materials.transfer(b.id, 'copy');
  await assert.rejects(f.materials.transfer(b.id, 'copy'), /上一个素材还在处理/);
  release({ ok: true }); await first;
  const preview = await f.materials.preview(b.id);
  assert.deepEqual([preview.scene.file, preview.scene.page], [path.resolve(f.packFiles[0]), 2]);
});

test('AI 联动：PPT 素材助理的工具集里有 ppt_materials，只读', () => {
  assert.ok(TOOLSETS.ppt.includes('ppt_materials'));
  const tool = toolsFor('ppt').find(x => x.name === 'ppt_materials');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['category', 'limit', 'offset', 'query']);
  assert.ok(!TOOLSETS.desk.includes('ppt_materials'), '电脑助理不挂素材工具');
});

test('素材预览细节：自定义形状轮廓、渐变、预置六边形调整值与翻转；公式点读不出时退回矩形；fit 只框住形状', t => {
  const dir = tmp(t), file = path.join(dir, 'shapes.pptx');
  makePack(file, [{ shapes: SHAPES.cust + SHAPES.hex + SHAPES.formula, notes: meta({ name: 'x' }) }]);
  const scene = buildSlideScene(file, 1);
  const [roof, hex, formula] = scene.items;
  assert.equal(roof.path.length, 1);
  assert.match(roof.path[0].d, /^M0 100L20 0L180 0C190 0 200 50 200 100Z$/, '路径坐标按形状大小换成磅（200×100 磅）');
  assert.deepEqual(roof.grad, { stops: [[0, '#F2F2F2'], [1, '#BFBFBF']], ang: 90 });
  assert.equal(roof.fill, '#BFBFBF', '老渲染仍有中间色可用');
  assert.equal(hex.prst, 'hexagon');
  assert.deepEqual(hex.adj, [0.3, 1.1547]);
  assert.equal(hex.flipH, true);
  assert.equal(formula.path, undefined, '路径里有公式名时不硬画');
  const svg = sceneSvg(scene, { fit: true });
  assert.match(svg, /<linearGradient id="g[^"]+" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#F2F2F2"\/><stop offset="1" stop-color="#BFBFBF"\/>/);
  assert.match(svg, /<path d="M0 100L20 0L180 0C190 0 200 50 200 100Z" fill="url\(#g/);
  assert.match(svg, /translate\(100 0\) scale\(-1 1\)/, '水平翻转绕形状自身');
  const vb = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(vb[2] < 700 && vb[3] < 300 && vb[0] < 0, 'fit 视口只框住形状并留边：' + vb.join(' '));
  assert.match(sceneSvg(scene), /viewBox="0 0 960 540"/, '不 fit 时仍是整页');
  assert.deepEqual(presetPoints('hexagon', 100, 100, [0.3]).map(p => p.map(Math.round)), [[30, 0], [70, 0], [100, 50], [70, 100], [30, 100], [0, 50]]);
  assert.deepEqual(presetPoints('downArrow', 50, 100, null).map(p => p.map(Math.round))[3], [25, 100], '下箭头尖在底边中点');
  assert.equal(presetPoints('cloud', 10, 10, null), null);
});

test('同一个素材包里同分类同名的两个变体都保留（只和 Doctor 素材去重）', t => {
  const f = fixture(t, { packs: [[{ shapes: SHAPES.hex, notes: meta({ name: '光带', category: '光带·托板·展台' }) }, { shapes: SHAPES.cust, notes: meta({ name: '光带', category: '光带·托板·展台' }) }]] });
  f.materials.addPack(f.packFiles[0]);
  assert.equal(f.materials.list({ query: '光带' }).total, 2);
});

test('fit 只框幻灯片自己的形状，母版装饰不把预览缩小', () => {
  const scene = { w: 960, h: 540, slideItems: 1, items: [{ t: 'box', x: 0, y: 500, w: 960, h: 40, fill: '#C7000B' }, { t: 'box', x: 400, y: 200, w: 100, h: 50, fill: '#3478F6' }] };
  const vb = sceneSvg(scene, { fit: true }).match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(vb[2] < 200 && vb[1] > 150, vb.join(' '));
});

test('团队素材包一键下载：换源、两层校验、装好即出现；与手动打开的素材包并存；有新版时提示更新并可升级', async t => {
  const crypto = require('node:crypto'), sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
  const f = fixture(t, { packs: [[{ shapes: SHAPES.hex, notes: meta({ name: '我自己的卡片', category: '容器与卡片' }) }]] });
  const publish = (version, slides) => {
    const pptx = path.join(f.dir, `team-${version}.pptx`), zip = path.join(f.dir, `team-${version}.zip`);
    makePack(pptx, slides); writeZip(zip, { [TEAM_PACK_FILE]: fs.readFileSync(pptx) });
    const archive = fs.readFileSync(zip);
    return { archive, manifest: { version, kind: 'materials', files: { [TEAM_PACK_FILE]: { hash: sha(fs.readFileSync(pptx)) } }, archive: { name: 'component.zip', hash: sha(archive) } } };
  };
  let live = publish('1.0.0', [{ shapes: SHAPES.cust, notes: meta({ name: '灰渐变屋顶栏头', category: '栏头与标题条' }) }, { shapes: SHAPES.hex, notes: meta({ name: '蓝色光带', category: '光带·托板·展台' }) }]);
  let tamper = false;
  const asked = [];
  f.materials.deps.pptTeamPackUrls = ['https://bad.example/m/', 'https://good.example/m/'];
  f.materials.deps.pptDownloadFetch = async url => {
    asked.push(url);
    if (url.startsWith('https://bad.example/')) return new Response('<html>拦截页</html>', { status: 200 });
    if (url.endsWith('component.json')) return new Response(JSON.stringify(live.manifest));
    return new Response(tamper ? Buffer.concat([live.archive, Buffer.from('x')]) : live.archive);
  };
  assert.equal(f.materials.list().library.teamPack.installed, null);
  tamper = true;
  await assert.rejects(f.materials.installTeamPack(), /校验不一致/);
  assert.equal(f.materials.list({ force: true }).library.total, 0, '校验不过时什么都不落地');
  tamper = false;
  const r = await f.materials.installTeamPack();
  assert.deepEqual({ version: r.version, items: r.items }, { version: '1.0.0', items: 2 });
  assert.ok(asked.includes('https://bad.example/m/component.json') && asked.includes('https://good.example/m/component.zip'), '第一个源给拦截页时换下一个源');
  assert.deepEqual(fs.readdirSync(f.materials.teamPackDir()).sort(), ['installed.json', TEAM_PACK_FILE], '不留下载临时文件');
  f.materials.addPack(f.packFiles[0]);
  const all = f.materials.list();
  assert.equal(all.library.total, 3, '团队素材包 + 手动打开的素材包');
  assert.deepEqual(f.settings.ppt.materialPacks, [f.packFiles[0]], '设置里只记用户手动打开的素材包');
  assert.equal((await f.materials.checkTeamPack()).update, false);
  // 发布新版：重新查到后提示更新，升级后内容整体替换
  live = publish('1.1.0', [{ shapes: SHAPES.hex, notes: meta({ name: '新编号圆', category: '编号·标签·胶囊' }) }]);
  f.materials.latest = null;
  const check = await f.materials.checkTeamPack();
  assert.deepEqual({ installed: check.installed, latest: check.latest, update: check.update }, { installed: '1.0.0', latest: '1.1.0', update: true });
  await f.materials.installTeamPack();
  const after = f.materials.list();
  assert.deepEqual(after.items.map(i => i.name).sort(), ['我自己的卡片', '新编号圆']);
  assert.equal(after.library.teamPack.update, false);
});
