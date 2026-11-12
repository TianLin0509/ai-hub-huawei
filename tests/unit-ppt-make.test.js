'use strict';
// PPT 页「做页」Tab（2026-11-11）：骨架全部能生成且能被版式预览读回；团队素材包按名称取形状；任务流（模型回包为夹具）；产物只留最近 30 个。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PptMake, listSkeletons, prune, CATEGORIES, KEEP_FILES } = require('../core/company-assistant/ppt-make');
const engine = require('../core/company-assistant/ppt-make-engine');
const { buildSlideScene, openZip, readEntry } = require('../core/company-assistant/ppt-slide-preview');
const { sceneSvg } = require('../renderer/ppt-slide-svg');
const { MARKER, TEAM_PACK_FILE } = require('../core/company-assistant/ppt-materials');
const { PPT_MAKE_INSTRUCTIONS } = require('../core/company-assistant/ppt-instructions');
const { TOOLSETS, toolsFor } = require('../core/company-assistant/mcp');
const { createPptHandlers } = require('../core/company-assistant/ppt-ipc');

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-make-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// 假的助理与 PPT 库：只留做页用到的几样。提问、打开、插入都记下来不真做。
function fixture(t) {
  const dir = tmp(t), asks = [], chats = [], calls = [];
  const a = { dir, now: () => Date.now(), changed() {}, chat: () => chats,
    ask(text, options) { const item = { id: 'chat-' + (chats.length + 1), q: text, state: 'queued' }; chats.push(item); asks.push({ text, options }); return item; } };
  const ppt = { a, deps: { openPpt: async file => { calls.push(['open', file]); return ''; }, copyPptSlide: async (file, page) => { calls.push(['insert', file, page]); return { ok: true, page: 4, target: '汇报稿.pptx' }; }, showPptInFolder: async file => { calls.push(['folder', file]); } },
    materials: { teamPackFile: () => path.join(dir, 'ppt-team-materials', TEAM_PACK_FILE) },
    previewScene: async (file, page) => buildSlideScene(file, page) };
  const make = new PptMake(ppt); ppt.make = make;
  return { dir, a, ppt, make, asks, chats, calls };
}
const pptxIn = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.pptx')).sort() : [];

// ---- 合成团队素材包：一页一个素材，备注里是标记 + JSON
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const rels = items => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"/>`).join('')}</Relationships>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHAPES = {
  head: '<p:sp><p:nvSpPr><p:cNvPr id="2" name="栏头"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="2540000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>栏头文字</a:t></a:r></a:p></p:txBody></p:sp>',
  icon: '<p:pic><p:nvPicPr><p:cNvPr id="3" name="图标"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
  group: '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="组合"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="254000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="254000"/></a:xfrm></p:grpSpPr><p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="内层"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="6" name="箭头"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="254000"/></a:xfrm><a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom></p:spPr></p:sp></p:grpSp></p:grpSp><p:sp><p:nvSpPr><p:cNvPr id="7" name="不属于素材的第二个形状"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>',
};
function writeTeamPack(file, slides) {
  const files = [
    { name: 'ppt/presentation.xml', data: `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])) },
    { name: 'ppt/media/image1.png', data: PNG },
  ];
  slides.forEach((s, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>${s.shape}</p:spTree></p:cSld></p:sld>` });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([['rId9', 'notesSlide', `../notesSlides/notesSlide${i + 1}.xml`], ['rId2', 'image', '../media/image1.png']]) });
    files.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${MARKER}</a:t></a:r></a:p><a:p><a:r><a:t>${JSON.stringify({ id: 'm' + i, name: s.name, category: '测试' }).replace(/"/g, '&quot;')}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>` });
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, engine.zip(files));
}
const PACK = [{ name: '红色栏头', shape: SHAPES.head }, { name: '小图标', shape: SHAPES.icon }, { name: '组合箭头', shape: SHAPES.group }, { name: '红色栏头', shape: SHAPES.icon }];
const page = body => ({ title: '测试页：一行写完的结论', col: [body] });

test('骨架：目录里每个 json 都列出，说明字段齐全，示意内容能生成且能被版式预览读回', async t => {
  const f = fixture(t), list = f.make.listSkeletons();
  assert.ok(list.length >= 5);
  assert.deepEqual(list.map(s => s.id).sort(), fs.readdirSync(path.join(__dirname, '../core/company-assistant/ppt-make-skeletons')).filter(n => n.endsWith('.json')).sort().map(n => n.slice(0, -5)));
  // 按分类的论证顺序排，每个骨架都属于五类之一
  const ranks = list.map(s => CATEGORIES.indexOf(s.category));
  assert.ok(ranks.every(r => r >= 0), '分类都在五类里');
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '按分类顺序排');
  for (const s of list) {
    assert.ok(s.name && s.fit && s.chain && s.spec.title, `${s.id} 说明字段齐全`);
    assert.ok(!Object.keys(s.spec).some(k => k.startsWith('_')), `${s.id} 示意内容不带说明字段`);
    const { job } = f.make.example(s.id);
    assert.equal(job.state, 'done'); assert.equal(job.kind, 'example');
    assert.ok(Array.isArray(job.report.warnings) && Array.isArray(job.report.imageSlots) && job.report.chars > 0);
    const scene = buildSlideScene(job.path, 1);
    assert.ok(scene.w > 0 && scene.h > 0 && Math.abs(scene.w / scene.h - 16 / 9) < 0.01, `${s.id} 是 16:9`);
    assert.ok(scene.items.length > 5, `${s.id} 读回了形状`);
    assert.match(sceneSvg(scene), /^<svg /);
    assert.ok((await f.make.preview(job.id)).scene.items.length > 5);
  }
  // 样例放 examples 子目录，不占用户生成的那 30 个
  assert.equal(pptxIn(path.join(f.make.dir(), 'examples')).length, list.length);
  assert.equal(pptxIn(f.make.dir()).length, 0);
  assert.throws(() => f.make.example('没有这个骨架'), /找不到这个骨架/);
  // 目录是现读的：以后加骨架不用改代码
  const extra = tmp(t);
  fs.writeFileSync(path.join(extra, 'b.json'), '﻿' + JSON.stringify({ _骨架: '乙', _适用: '用途', _论证链: '甲 → 乙', title: '标题' }));
  fs.writeFileSync(path.join(extra, 'a.json'), JSON.stringify({ _骨架: '甲', _适用: '用途', _论证链: '甲 → 乙', title: '标题' }));
  fs.writeFileSync(path.join(extra, 'readme.txt'), '不是骨架');
  assert.deepEqual(listSkeletons(extra).map(s => [s.id, s.name, s.category]), [['a', '甲', '其他'], ['b', '乙', '其他']]);
  fs.writeFileSync(path.join(extra, 'c.json'), JSON.stringify({ _骨架: '丙', _适用: '用途', _论证链: '甲 → 乙', _分类: '盘点与总结', title: '标题' }));
  fs.writeFileSync(path.join(extra, 'd.json'), JSON.stringify({ _骨架: '丁', _适用: '用途', _论证链: '甲 → 乙', _分类: '现状与问题', title: '标题' }));
  assert.deepEqual(listSkeletons(extra).map(s => s.id), ['d', 'c', 'a', 'b'], '分类顺序在前，没写分类的排最后');
});

test('下载整套模板：全部骨架生成一份多页 pptx，同名覆盖，能被版式预览逐页读回，不进 30 个淘汰', async t => {
  const f = fixture(t), handlers = createPptHandlers({ ppt: f.ppt }), list = f.make.listSkeletons();
  const { job } = await handlers['ppt-make-pack']();
  assert.equal(job.path, path.join(f.make.dir(), `通用汇报页模板包-${list.length}页.pptx`));
  assert.deepEqual([job.kind, job.state, job.pages], ['pack', 'done', list.length]);
  const presentation = readEntry(openZip(job.path), 'ppt/presentation.xml').toString('utf8');
  assert.equal((presentation.match(/<p:sldId /g) || []).length, list.length, '页数等于骨架数');
  for (let page = 1; page <= list.length; page++) assert.ok(buildSlideScene(job.path, page).items.length > 5, `第 ${page} 页读回了形状`);
  assert.equal(f.asks.length, 0, '不经模型');
  const again = (await handlers['ppt-make-pack']()).job;
  assert.equal(again.path, job.path);
  assert.deepEqual(pptxIn(f.make.dir()), [path.basename(job.path)], '同名覆盖，只有一份');
  assert.deepEqual(await handlers['ppt-make-open']({ jobId: again.id }), { ok: true, path: job.path });
  prune(f.make.dir(), 0);
  assert.ok(fs.existsSync(job.path), '模板包不参与淘汰');
});

test('素材查找：没下载团队素材包返回 null 并在提醒里写明；下载后按名称取形状、宽高和图片', t => {
  const f = fixture(t), file = f.ppt.materials.teamPackFile();
  assert.equal(f.make.material('红色栏头'), null);
  const none = f.make.render(page({ type: 'material', name: '红色栏头' }));
  assert.match(none.report.warnings.join('；'), /素材库里没有「红色栏头」/);

  writeTeamPack(file, PACK);
  const head = f.make.material('红色栏头');
  assert.ok(head.xml.startsWith('<p:sp>') && head.xml.endsWith('</p:sp>') && head.xml.includes('栏头文字'));
  assert.deepEqual([head.w, head.h, head.media], [2540000, 381000, {}], '同名素材取第一个');
  const icon = f.make.material('小图标');
  assert.ok(icon.xml.startsWith('<p:pic>'));
  assert.deepEqual(icon.media, { rId2: ['image1.png', PNG.toString('base64')] });
  const group = f.make.material('组合箭头');
  assert.ok(group.xml.startsWith('<p:grpSp>') && group.xml.endsWith('</p:grpSp></p:grpSp>'), '嵌套组合取到最外层的结束标签');
  assert.ok(!group.xml.includes('不属于素材'));
  assert.deepEqual([group.w, group.h], [1270000, 254000]);
  assert.equal(f.make.material('没有这个素材'), null);

  const made = f.make.render(page({ row: [{ type: 'material', name: '红色栏头', text: '新栏头' }, { type: 'material', name: '小图标' }] }));
  assert.deepEqual(made.report.warnings, []);
  assert.deepEqual(made.report.materials, ['红色栏头', '小图标']);
  const zip = openZip(made.path), slide = readEntry(zip, 'ppt/slides/slide1.xml').toString('utf8');
  assert.ok(slide.includes('新栏头') && !slide.includes('栏头文字'));
  assert.ok(readEntry(zip, 'ppt/media/image1.png').equals(PNG), '素材里的图片跟着进了生成的文稿');
  assert.ok(buildSlideScene(made.path, 1).items.length > 2);

  // 素材包更新后按新的读
  writeTeamPack(file, [{ name: '新素材', shape: SHAPES.head }]);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(f.make.material('小图标'), null);
  assert.ok(f.make.material('新素材'));
});

test('任务流：建任务 → 提问带骨架、材料和规则 → 模型提交 → 生成；有提醒让模型改，最多两轮，最后一版照常交付', async t => {
  const f = fixture(t), sk = f.make.listSkeletons()[0];
  assert.throws(() => f.make.start({ skeletonId: sk.id, brief: '  ' }), /先写一句/);
  assert.throws(() => f.make.start({ skeletonId: '没有', brief: '内容' }), /找不到这个骨架/);
  assert.equal(f.asks.length, 0);

  const { job } = f.make.start({ skeletonId: sk.id, brief: '三项措施叠加，指标提升 XX%' });
  assert.equal(job.state, 'waiting_agent'); assert.equal(job.chatId, 'chat-1');
  const { text, options } = f.asks[0];
  assert.deepEqual(options, { entry: 'ppt', taskTitle: 'PPT 做页 · ' + sk.name.slice(0, 18) });
  for (const part of ['做页任务', `jobId=${job.id}`, sk.name, sk.fit, sk.chain, '三项措施叠加，指标提升 XX%', PPT_MAKE_INSTRUCTIONS, JSON.stringify(sk.spec), 'ppt_make(jobId, spec)']) assert.ok(text.includes(part), '提问里带：' + part.slice(0, 20));
  assert.equal(f.make.status(job.id).state, 'waiting_agent');

  // 第 1 次提交：句末有句号 → 返回提醒，页面已经能看到这一版
  const bad = page({ type: 'text', items: ['指标提升明显。'] });
  const first = f.make.submit({ jobId: job.id, spec: bad });
  assert.equal(first.ok, true); assert.match(first.warnings.join('；'), /句号/); assert.match(first.note, /再提交一次/);
  let now = f.make.status(job.id);
  assert.deepEqual([now.state, now.submits, now.rev], ['revising', 1, 1]);
  assert.ok(fs.existsSync(now.path) && now.path === first.path && path.dirname(now.path) === f.make.dir());
  assert.match(path.basename(now.path), /^\d{8}-\d{6}-\d{3}-测试页\.pptx$/);
  // 第 2 次：模型把对象写成了 JSON 字符串也收；仍有提醒
  const second = f.make.submit({ jobId: job.id, spec: JSON.stringify(bad) });
  assert.match(second.note, /再提交一次/);
  // 第 3 次（第 2 轮修改）仍有提醒：交付并说明轮次用完
  const third = f.make.submit({ jobId: job.id, spec: bad });
  assert.match(third.note, /修改轮次已用完/);
  now = f.make.status(job.id);
  assert.deepEqual([now.state, now.submits, now.rev, now.report.warnings.length], ['done', 3, 3, 1]);
  assert.throws(() => f.make.submit({ jobId: job.id, spec: bad }), /已经结束/);

  // 没有提醒：一次就完成
  const clean = f.make.start({ skeletonId: sk.id, brief: '内容' }).job;
  const ok = f.make.submit({ jobId: clean.id, spec: page({ type: 'image', placeholder: '指标对比曲线' }) });
  assert.deepEqual([ok.warnings, ok.note], [[], undefined]);
  assert.deepEqual(f.make.status(clean.id).report.imageSlots, ['指标对比曲线']);
  assert.equal(f.make.status(clean.id).state, 'done');

  assert.throws(() => f.make.submit({ jobId: '不存在', spec: bad }), /找不到这次做页任务/);
  const loose = f.make.start({ skeletonId: sk.id, brief: '内容' }).job;
  assert.throws(() => f.make.submit({ jobId: loose.id, spec: 42 }), /页面说明对象/);
  assert.equal(f.make.status(loose.id).submits, 0);
});

test('任务流：助理收工时还没提交算失败并写明原因；修改途中收工则交付已生成的那一版', t => {
  const f = fixture(t), sk = f.make.listSkeletons()[0];
  const silent = f.make.start({ skeletonId: sk.id, brief: '内容' }).job;
  f.chats[0].state = 'done';
  assert.deepEqual([f.make.status(silent.id).state, f.make.status(silent.id).error], ['error', '助理这一轮没有提交页面内容']);
  const broken = f.make.start({ skeletonId: sk.id, brief: '内容' }).job;
  Object.assign(f.chats[1], { state: 'error', error: 'CodeAgent 没有启动' });
  assert.equal(f.make.status(broken.id).error, 'CodeAgent 没有启动');

  const revising = f.make.start({ skeletonId: sk.id, brief: '内容' }).job;
  f.make.submit({ jobId: revising.id, spec: page({ type: 'text', items: ['有句号。'] }) });
  assert.throws(() => f.make.rerender(revising.id, page({ type: 'gap' })), /助理还在写/);
  f.chats[2].state = 'done';
  const done = f.make.status(revising.id);
  assert.deepEqual([done.state, done.report.warnings.length, fs.existsSync(done.path)], ['done', 1, true]);
});

test('手改页面说明后重新生成；改过的样例算用户自己的页', t => {
  const f = fixture(t), sk = f.make.listSkeletons()[0];
  const example = f.make.example(sk.id).job;
  const edited = f.make.rerender(example.id, { ...sk.spec, title: '手改页：标题换了' }).job;
  assert.deepEqual([edited.kind, edited.state, edited.rev, edited.spec.title], ['make', 'done', 2, '手改页：标题换了']);
  assert.equal(path.dirname(edited.path), f.make.dir());
  assert.match(path.basename(edited.path), /-手改页\.pptx$/);
  assert.throws(() => f.make.rerender(example.id, '不是对象'), /JSON 对象/);
});

test('产物只留最近 30 个：超出的删最旧的；样例单独计数；PowerPoint 的锁文件不算', t => {
  const f = fixture(t), dir = f.make.dir();
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 34; i++) fs.writeFileSync(path.join(dir, `20261101-0000${String(i).padStart(2, '0')}-000-旧页${i}.pptx`), 'x');
  fs.writeFileSync(path.join(dir, '~$20261101-000000-000-旧页0.pptx'), 'lock');
  fs.writeFileSync(path.join(dir, '说明.txt'), 'x');
  const made = f.make.render(page({ type: 'gap' }), { name: '新页' });
  const left = pptxIn(dir).filter(n => !n.startsWith('~$'));
  assert.equal(left.length, KEEP_FILES);
  assert.equal(left[0], '20261101-000005-000-旧页5.pptx', '最旧的 5 个被删');
  assert.equal(left[left.length - 1], path.basename(made.path));
  assert.ok(fs.existsSync(path.join(dir, '~$20261101-000000-000-旧页0.pptx')) && fs.existsSync(path.join(dir, '说明.txt')));
  prune(dir, 2);
  assert.equal(pptxIn(dir).filter(n => !n.startsWith('~$')).length, 2);
});

test('界面通道与工具：样例、预览、打开、插入、所在文件夹；ppt_make 挂在 PPT 工具集并分发到做页任务', async t => {
  const f = fixture(t), handlers = createPptHandlers({ ppt: f.ppt });
  const list = await handlers['ppt-make-skeletons']();
  assert.ok(list.ok && list.skeletons.length >= 5 && list.skeletons[0].chain);
  const { job } = await handlers['ppt-make-example']({ skeletonId: list.skeletons[1].id });
  assert.equal((await handlers['ppt-make-status']({ jobId: job.id })).job.path, job.path);
  assert.ok((await handlers['ppt-make-preview']({ jobId: job.id })).scene.items.length > 5);
  assert.deepEqual(await handlers['ppt-make-open']({ jobId: job.id }), { ok: true, path: job.path });
  assert.deepEqual(await handlers['ppt-make-insert']({ jobId: job.id }), { ok: true, page: 4, target: '汇报稿.pptx' });
  await handlers['ppt-make-folder']({ jobId: job.id });
  assert.deepEqual(f.calls, [['open', job.path], ['insert', job.path, 1], ['folder', job.path]]);
  const again = await handlers['ppt-make-rerender']({ jobId: job.id, spec: page({ type: 'gap' }) });
  assert.equal(again.job.rev, 2);
  fs.rmSync(again.job.path);
  await assert.rejects(handlers['ppt-make-open']({ jobId: job.id }), /文件已不在/);

  assert.ok(TOOLSETS.ppt.includes('ppt_make'));
  const tool = toolsFor('ppt').find(x => x.name === 'ppt_make');
  assert.deepEqual(tool.inputSchema.required, ['jobId', 'spec']);
  assert.equal(tool.inputSchema.properties.spec.type, 'object');
  assert.ok(!toolsFor('desk').some(x => x.name === 'ppt_make'));
  const { HubTools } = require('../core/company-assistant/hub-tools');
  const tools = new HubTools({ dir: f.dir, ppt: f.ppt, toolsetFor: id => (id === 'ppt-session' ? 'ppt' : null), state: () => ({}), now: () => Date.now(), changed() {} });
  const started = f.make.start({ skeletonId: list.skeletons[0].id, brief: '内容' }).job;
  const result = await tools.invoke({ name: 'ppt_make', arguments: { jobId: started.id, spec: page({ type: 'gap' }) }, callerSessionId: 'ppt-session' });
  assert.deepEqual([result.ok, result.warnings, fs.existsSync(result.path)], [true, [], true]);
  await assert.rejects(tools.invoke({ name: 'ppt_make', arguments: {}, callerSessionId: 'someone-else' }), /只有公司助理会话/);
});

test('粘贴页面说明直接生成（不经助理）；结构不对时说人话；写法说明带骨架、规则和示意内容', async t => {
  const f = fixture(t), handlers = createPptHandlers({ ppt: f.ppt }), sk = f.make.listSkeletons()[2];
  const { job } = await handlers['ppt-make-render']({ spec: page({ type: 'image', placeholder: '结果对比图' }), skeletonId: sk.id });
  assert.deepEqual([job.kind, job.state, job.skeleton, job.report.imageSlots], ['make', 'done', sk.name, ['结果对比图']]);
  assert.equal(path.dirname(job.path), f.make.dir());
  assert.equal(f.asks.length, 0, '不给助理会话发提问');
  assert.equal((await handlers['ppt-make-render']({ spec: page({ type: 'gap' }) })).job.skeleton, '粘贴的页面说明');
  const before = f.make.jobs.size;
  assert.throws(() => f.make.renderSpec({ spec: page({ type: 'bars', series: [{ label: '甲' }, null] }) }), /页面说明的结构不对.*对照骨架示意内容/);
  assert.throws(() => f.make.renderSpec({ spec: '文字' }), /JSON 对象/);
  assert.equal(f.make.jobs.size, before, '没生成出来的不留任务');
  const guide = (await handlers['ppt-make-guide']({ skeletonId: sk.id })).text;
  for (const part of ['只输出一个 JSON 对象', sk.name, sk.fit, sk.chain, PPT_MAKE_INSTRUCTIONS, JSON.stringify(sk.spec), '【我要讲的内容】']) assert.ok(guide.includes(part), part.slice(0, 20));
});

test('做页规则：只通过 ppt_make 产出文件，不带只读限制', () => {
  assert.match(PPT_MAKE_INSTRUCTIONS, /只通过 ppt_make 产出/);
  assert.match(PPT_MAKE_INSTRUCTIONS, /不改用户的其他文件/);
  assert.doesNotMatch(PPT_MAKE_INSTRUCTIONS, /只读/);
  for (const part of ['定位语：结论', '{r:…}', '{b:…}', '{y:…}', '"type":"image"', '"type":"material"', 'ppt_materials', '「XX」']) assert.ok(PPT_MAKE_INSTRUCTIONS.includes(part), part);
});
