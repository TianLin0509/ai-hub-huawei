'use strict';
// PPT 页版式预览（2026-11-08）：直接读 pptx 画出原稿版式；以及 AI 找页的真实调用轨迹。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { buildSlideScene, createSlidePreviewer } = require('../core/company-assistant/ppt-slide-preview');
const { sceneSvg } = require('../renderer/ppt-slide-svg');

// 最小 zip 写入（deflate），只为造测试用的 pptx。
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
function makeDeck(file) {
  const titleSp = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>SRS 信道估计原理 &amp; 增益</a:t></a:r></a:p></p:txBody></p:sp>';
  const box = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="R"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="2743200"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="2000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>边缘 +30%</a:t></a:r></a:p></p:txBody></p:sp>';
  const num = '<p:sp><p:nvSpPr><p:cNvPr id="4" name="N"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:fld id="{1}" type="slidenum"><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>';
  const slide = n => `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${n === 2 ? titleSp + box + num : ''}</p:spTree></p:cSld></p:sld>`;
  writeZip(file, {
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(rel('rId2', 'slide', 'slides/slide1.xml'), rel('rId3', 'slide', 'slides/slide7.xml')),
    'ppt/slides/slide1.xml': slide(1),
    'ppt/slides/slide7.xml': slide(2),
    'ppt/slides/_rels/slide7.xml.rels': rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')),
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="11277600" cy="762000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F7F8FA"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="9" name="Bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6600000"/><a:ext cx="12192000" cy="258000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="C7000B"/></a:solidFill></p:spPr></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600" b="1"><a:solidFill><a:srgbClr val="C7000B"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(rel('rId1', 'theme', '../theme/theme1.xml')),
    'ppt/theme/theme1.xml': `<?xml version="1.0"?><a:theme ${NS}><a:themeElements><a:clrScheme name="t"><a:dk1><a:srgbClr val="1F2329"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="3478F6"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
  });
}

test('读 pptx 画出原稿版式：页序按 sldIdLst、标题位置继承版式、字号颜色继承母版、母版图形与背景、主题色', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-preview-')), file = path.join(dir, '20261108-测试稿.pptx');
  makeDeck(file);
  const scene = buildSlideScene(file, 2);
  assert.equal(scene.pages, 2);
  assert.deepEqual([scene.w, scene.h], [960, 540]);
  assert.equal(scene.bg.color, '#F7F8FA');
  const title = scene.items.find(i => i.role === 'title');
  assert.ok(title, '标题来自幻灯片自己的占位符');
  assert.deepEqual([title.x, title.y, title.w], [36, 18, 888], '没写位置的占位符按版式里的位置画');
  assert.equal(title.paras[0].runs[0].text, 'SRS 信道估计原理 & 增益');
  assert.equal(title.paras[0].runs[0].sz, 36);
  assert.equal(title.paras[0].runs[0].color, '#C7000B');
  assert.ok(scene.items.some(i => i.t === 'box' && i.fill === '#C7000B' && i.y === 519.7), '母版上的底栏图形画出来');
  const box = scene.items.find(i => i.t === 'box' && i.shape === 'round');
  assert.ok(box && /^#[0-9A-F]{6}$/.test(box.fill) && box.fill !== '#3478F6', '主题色按 lumMod 调暗');
  assert.ok(scene.items.some(i => i.t === 'text' && i.paras[0].runs[0].text === '2'), '页码域换成真实页码');
  const svg = sceneSvg(scene);
  assert.match(svg, /^<svg[^>]+viewBox="0 0 960 540"/);
  assert.match(svg, /SRS 信道估计原理 &amp; 增益/);
  assert.match(svg, /边缘 \+30%/);
  assert.throws(() => buildSlideScene(file, 3), e => e.code === 'PAGE_OUT_OF_RANGE');
  assert.throws(() => buildSlideScene(path.join(dir, 'old.ppt'), 1), e => e.code === 'UNSUPPORTED_FORMAT');
});

test('预览带缓存：同一页第二次不重读，文稿改了自动失效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-preview-cache-')), file = path.join(dir, 'deck.pptx');
  makeDeck(file);
  const previewer = createSlidePreviewer({ cacheDir: path.join(dir, 'cache') });
  const a = await previewer.scene(file, 2), b = await previewer.scene(file, 2);
  assert.equal(a, b);
  assert.equal(fs.readdirSync(path.join(dir, 'cache')).filter(f => f.endsWith('.json')).length, 1);
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);
  assert.notEqual(await previewer.scene(file, 2), a);
});

test('PptLibrary：预览只给检索返回过的页；AI 找页的 find / read / report 记成真实轨迹', async () => {
  const { PptLibrary } = require('../core/company-assistant/ppt-library');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-lib-')), file = path.join(dir, 'deck.pptx');
  makeDeck(file);
  const lib = new PptLibrary({ dir, settings: () => ({ ppt: {} }) }, { pptDoctor: { status: async () => ({ ok: true }) }, pptPreviewShrink: null });
  await assert.rejects(() => lib.preview('nope'), e => e.code === 'UNKNOWN_PAGE');
  lib.references.set('s:1:2', { path: file, page: 2, name: 'deck.pptx' });
  const r = await lib.preview('s:1:2');
  assert.equal(r.ok, true); assert.equal(r.scene.page, 2);
  lib.beginTask('job-1', 'chat-1');
  lib.traceEvent({ kind: 'find', queries: ['SRS', '信道估计'], total: 12 });
  lib.traceEvent({ kind: 'read', pages: [{ id: 's:1:2', name: 'deck.pptx', page: 2 }] });
  assert.deepEqual(lib.trace('chat-1').events.map(e => e.kind), ['find', 'read']);
  lib.takeTaskResult('job-1');
  lib.traceEvent({ kind: 'read', pages: [] });
  assert.equal(lib.trace('chat-1').events.length, 2, '任务结束后不再记');
  assert.equal(lib.trace('other'), null);
});
