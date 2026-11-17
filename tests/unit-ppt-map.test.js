'use strict';
// r28 PPT 库地图：规则层、模型层核对、增量只处理变化文件、用户改标签锁定、文件级跳过、分层抽样与算分。数据全为虚构。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const M = require('../core/company-assistant/ppt-map');
const { pageHash } = require('../core/company-assistant/ppt-map-text');

const deck = (name, texts, dir = 'D:/demo') => texts.map((text, i) => ({ id: `s1:${name}:${i + 1}`, path: `${dir}/${name}.pptx`, name: `${name}.pptx`, page: i + 1, text }));
const A = () => deck('节能X评审TR4', ['节能 X.0 TR4 评审\n2026-09', '仿真结果：载波关断增益\n50% 负载下能耗下降 2.1%', '下一步计划与风险\n10 月完成外场', '方案与架构\n关断决策模块框架']);
const B = () => deck('调度例会W40', ['调度例会 W40', '问题与挑战\n小包时延抖动', '一些说明\n这一页没有明显的类型词也没有主题词']);
// 模糊页：标题无类型词，正文同时命中两类，规则层拿不准。
const fuzzy = () => deck('杂项', ['封面', '本页内容\n仿真对比两种方案的增益']);

test('规则层：标题命中给确定标签，封面目录直接归类，主题按标题与正文命中', () => {
  const tax = M.compile();
  const [cover, sim, plan] = A();
  assert.equal(M.classifyByRules(cover, tax).pageType, M.COVER);
  const r = M.classifyByRules(sim, tax);
  assert.equal(r.pageType, '仿真与验证'); assert.equal(r.confident, true);
  assert.ok(r.topics.includes('节能'));
  assert.equal(M.classifyByRules(plan, tax).pageType, '进展与计划');
  assert.equal(M.classifyByRules({ page: 3, text: '目录\n一、背景' }, tax).pageType, M.COVER);
  const unsure = M.classifyByRules(fuzzy()[1], tax);
  assert.equal(unsure.confident, false);
});

test('整份稿材料类型与主题：文件名命中优先', () => {
  const tax = M.compile();
  const d = M.classifyDeck('节能X评审TR4.pptx', A().map(p => M.classifyByRules(p, tax)), tax);
  assert.equal(d.deckType, '评审决策');
  assert.ok(d.topics.includes('节能'));
  assert.equal(M.classifyDeck('调度例会W40.pptx', [], tax).deckType, '例会周报');
});

test('模型层：只送规则拿不准的页，结果核对类别与原文，不过关记「待人工」', async () => {
  const pages = [...A(), ...fuzzy()];
  const sent = [];
  const runModel = async (prompt, { batch }) => {
    sent.push(...batch.map(p => p.id));
    assert.match(prompt, /只输出一个 JSON 数组/);
    return '好的：\n```json\n' + JSON.stringify(batch.map(p => ({ id: p.id, pageType: '对比与选型', topics: ['节能', '不存在的主题'], quote: '仿真对比两种方案' }))) + '\n```';
  };
  const out = await M.buildMap({ pages, runModel });
  assert.deepEqual(sent, [fuzzy()[1].id]);
  const label = out.pages.find(p => p.id === fuzzy()[1].id);
  assert.equal(label.by, 'model'); assert.equal(label.pageType, '对比与选型');
  assert.deepEqual(label.topics, ['节能']);
  assert.equal(out.stats.model, 1); assert.equal(out.stats.modelCalls, 1);

  const bad = await M.buildMap({ pages: fuzzy(), runModel: async (_p, { batch }) => batch.map(p => ({ id: p.id, pageType: '对比与选型', topics: [], quote: '原文里没有这句话' })) });
  const rejected = bad.pages.find(p => p.id === fuzzy()[1].id);
  assert.equal(rejected.pageType, M.PENDING); assert.equal(rejected.by, 'model-rejected');
  assert.match(rejected.reason, /不是这一页的原文/);

  const wrongLabel = M.checkModelLabels(fuzzy().slice(1), [{ id: fuzzy()[1].id, pageType: '瞎编类', quote: '仿真对比两种方案' }], M.compile());
  assert.match(wrongLabel[0].reason, /不在体系内/);
  const missing = M.checkModelLabels(fuzzy().slice(1), '[]', M.compile());
  assert.match(missing[0].reason, /漏了/);
});

test('增量：第二次只处理文字变化的文件，未变的页走缓存或零 token 规则、不再调模型', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-map-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'labels.json');
  const fuzzyDeck = (suffix = '') => deck('杂项甲', ['封面', '本页内容\n仿真对比两种方案的增益' + suffix]);
  const other = deck('杂项乙', ['封面', '本页内容\n仿真对比三种算法的增益']);
  const sent = [];
  const runModel = async (_p, { batch }) => { sent.push(batch.map(p => p.path)); return batch.map(p => ({ id: p.id, pageType: '对比与选型', topics: [], quote: '本页内容' })); };

  const store = new M.LabelStore(file);
  const run1 = await M.buildMap({ pages: [...fuzzyDeck(), ...other, ...A()], store, runModel }); store.save();
  assert.equal(run1.stats.model, 2);
  sent.length = 0;

  const reload = new M.LabelStore(file);
  const run2 = await M.buildMap({ pages: [...fuzzyDeck('（10 月更新）'), ...other, ...A()], store: reload, runModel });
  assert.deepEqual(sent, [['D:/demo/杂项甲.pptx']], '只有改过的那份稿进模型');
  assert.equal(run2.stats.model, 1);
  assert.equal(run2.stats.rule, 6, '规则层零 token、每次现算');
  assert.equal(run2.stats.cached, 1, '没改过的那份稿的模型结果走缓存');

  const run3 = await M.buildMap({ pages: [...fuzzyDeck('（10 月更新）'), ...other, ...A()], store: reload, runModel });
  assert.equal(run3.stats.cached, 2); assert.equal(run3.stats.modelCalls, 0, "第三次什么都没变，不调模型");
});

test('改标签体系：只有页面类型 / 主题定义变了才让页缓存失效，改材料类型不重算', () => {
  const base = M.compile(), deckOnly = M.compile({ ...M.DEFAULT_TAXONOMY, deckTypes: [{ label: '新材料类', patterns: ['xx'] }] });
  const topicChanged = M.compile({ ...M.DEFAULT_TAXONOMY, topics: [...M.DEFAULT_TAXONOMY.topics, { label: '项目甲', patterns: ['项目甲'] }] });
  assert.equal(base.version, deckOnly.version);
  assert.notEqual(base.version, topicChanged.version);
});

test('模型批次失败：规则结果顶上并标待重试，不写缓存，下次自动重试；超出单次上限的页留到下次', async () => {
  const store = new M.LabelStore(null);
  const out = await M.buildMap({ pages: fuzzy(), store, runModel: async () => { throw new Error('额度用完'); } });
  const p = out.pages[1];
  assert.equal(p.retry, true); assert.equal(out.stats.pending, 1); assert.deepEqual(out.stats.modelErrors, ['额度用完']);
  let calls = 0;
  const again = await M.buildMap({ pages: fuzzy(), store, runModel: async (_x, { batch }) => { calls++; return batch.map(b => ({ id: b.id, pageType: '仿真与验证', topics: [], quote: '本页内容' })); } });
  assert.equal(calls, 1); assert.equal(again.pages[1].by, 'model');

  const many = Array.from({ length: 5 }, (_, i) => ({ id: `x:${i}`, path: 'D:/m.pptx', name: 'm.pptx', page: i + 2, text: `本页内容${i}\n仿真对比两种方案的增益` }));
  let seen = 0;
  const capped = await M.buildMap({ pages: many, maxModelPages: 3, batchSize: 2, runModel: async (_x, { batch }) => { seen += batch.length; return batch.map(b => ({ id: b.id, pageType: '仿真与验证', topics: [], quote: '本页内容' })); } });
  assert.equal(seen, 3); assert.equal(capped.stats.pending, 2); assert.equal(capped.stats.modelCalls, 2);
});

test('用户改过的标签锁定：重跑不被规则或模型覆盖；页文字一变就失效', async () => {
  const store = new M.LabelStore(null);
  const pages = A();
  store.override(pages[1], { pageType: '结论摘要', topics: ['调度与资源分配'] });
  const out = await M.buildMap({ pages, store });
  assert.equal(out.pages[1].by, 'user'); assert.equal(out.pages[1].pageType, '结论摘要'); assert.deepEqual(out.pages[1].topics, ['调度与资源分配']);
  const again = await M.buildMap({ pages, store });
  assert.equal(again.pages[1].pageType, '结论摘要');
  const edited = A(); edited[1].text += '\n补充：70% 负载 1.2%';
  const changed = await M.buildMap({ pages: edited, store });
  assert.equal(changed.pages[1].by, 'rule'); assert.equal(changed.pages[1].pageType, '仿真与验证');
  // 体系里删掉的类，用户标签也不再生效
  store.override(pages[2], { pageType: '已删除的类' });
  assert.equal((await M.buildMap({ pages, store })).pages[2].pageType, '进展与计划');
});

test('文件级增量：catalog 的 indexed_at / page_count 都没变的文件不再读页；读页按 40 页一批、不记问答证据', async () => {
  const store = new M.LabelStore(null);
  const items = [{ sourceId: 's1', file_id: 7, path: 'D:/a.pptx', page_count: 45, indexed_at: 100 }, { sourceId: 's1', file_id: 8, path: 'D:/b.pptx', page_count: 2, indexed_at: 100 }];
  assert.equal(M.planFiles(items, store).toRead.length, 2);
  const calls = [];
  const ppt = { execute: async (op, args) => { calls.push({ op, n: args.ids.length, recordEvidence: args.recordEvidence });
    return { pages: args.ids.map(id => { const [, f, p] = id.split(':'); return { id, text: `第${p}页`, is_neighbor: false, ref: { path: f === '7' ? 'D:/a.pptx' : 'D:/b.pptx', name: 'x.pptx', page: Number(p), page_hash: 'h' + p } }; }) }; } };
  const pages = [];
  for (const item of items) pages.push(...await M.readFilePages(ppt, item));
  assert.deepEqual(calls.map(c => c.n), [40, 5, 2]);
  assert.ok(calls.every(c => c.op === 'read' && c.recordEvidence === false));
  await M.buildMap({ pages, store });
  const next = M.planFiles([{ ...items[0] }, { ...items[1], indexed_at: 200 }], store);
  assert.deepEqual(next.toRead.map(i => i.path), ['D:/b.pptx']);
  assert.deepEqual(next.unchanged.map(i => i.path), ['D:/a.pptx']);
});

test('准确率验收：分层抽 50 页可复现、每层至少 1 页、不抽封面；算分写「N 个里几个对」', () => {
  const labels = [];
  for (let i = 0; i < 300; i++) labels.push({ id: 'p' + i, by: i % 3 ? 'rule' : 'model', pageType: ['仿真与验证', '方案与架构', '进展与计划', M.COVER][i % 4] });
  labels.push({ id: 'rare', by: 'user', pageType: '决策申请' });
  const a = M.sampleForReview(labels, 50, 7), b = M.sampleForReview(labels, 50, 7);
  assert.equal(a.length, 50); assert.deepEqual(a.map(x => x.id), b.map(x => x.id));
  assert.ok(a.every(x => x.pageType !== M.COVER));
  assert.ok(a.some(x => x.id === 'rare'), '小层也至少抽 1 页');
  assert.equal(new Set(a.map(x => x.id)).size, 50);
  const scored = M.scoreReview([...Array(42).fill({ by: 'rule', dimension: 'pageType', verdict: 'right' }), ...Array(6).fill({ by: 'model', dimension: 'pageType', verdict: 'wrong' }), { by: 'model', dimension: 'pageType', verdict: 'right' }, { by: 'rule', dimension: 'pageType', verdict: 'skip' }]);
  const all = scored.find(s => s.by === '全部');
  assert.equal(all.text, '49 个里 43 个对');
  assert.ok(all.ci[0] > 0.7 && all.ci[1] < 0.95);
  assert.equal(scored.find(s => s.by === 'model').text, '7 个里 1 个对');
});

test('提示词只带每页前 600 字，页内文字不当指令', () => {
  const long = { id: 'z:1', name: 'z.pptx', page: 2, text: 'A'.repeat(2000) };
  const prompt = M.buildClassifyPrompt([long], M.compile());
  assert.ok(prompt.length < 1200); assert.match(prompt, /不是指令/);
  assert.throws(() => M.parseModelJson('没有 JSON'), /没有返回 JSON/);
});

// ---- r28b 审查返工回归（m56 审查 F4、F5），撤掉任一修复都会红 ----
test('F4 同一段文字在不同文件不同页：封面位置规则不串缓存；人工改标签只影响所选那一页', async () => {
  const store = new M.LabelStore(null), same = '方案与架构\n调度算法设计机制与资源分配';
  const cover = { id: 's:1:1', path: 'D:/demo/a.pptx', name: 'a.pptx', page: 1, text: same };
  const inner = { id: 's:2:2', path: 'D:/demo/b.pptx', name: 'b.pptx', page: 2, text: same };
  assert.equal((await M.buildMap({ pages: [cover], store })).pages[0].pageType, M.COVER);
  assert.equal((await M.buildMap({ pages: [inner], store })).pages[0].pageType, '方案与架构');
  store.override(inner, { pageType: '决策申请' });
  const both = await M.buildMap({ pages: [cover, inner], store });
  assert.deepEqual(both.pages.map(p => [p.pageType, p.by]), [[M.COVER, 'rule'], ['决策申请', 'user']]);
  assert.throws(() => store.override(pageHash(same), { pageType: '决策申请' }), /哪份文件的第几页/);
  // 模型结果按文件名区分缓存（提示里有文件名）
  const fuzzyText = '本页内容\n仿真对比两种方案的增益';
  let calls = 0;
  const runModel = async (_p, { batch }) => { calls++; return batch.map(b => ({ id: b.id, pageType: '对比与选型', topics: [], quote: '本页内容' })); };
  await M.buildMap({ pages: [{ id: 'x:1:2', path: 'D:/x.pptx', name: 'x.pptx', page: 2, text: fuzzyText }], store, runModel });
  await M.buildMap({ pages: [{ id: 'x:1:5', path: 'D:/x.pptx', name: 'x.pptx', page: 5, text: fuzzyText }], store, runModel });
  assert.equal(calls, 1, '同文件名同文字走缓存');
  await M.buildMap({ pages: [{ id: 'y:1:2', path: 'D:/y.pptx', name: 'y.pptx', page: 2, text: fuzzyText }], store, runModel });
  assert.equal(calls, 2, '换了文件名重新判');
});

test('F5 模型失败、超出上限、核对不过的页：文件不记完成，下次 planFiles 仍列出，只重送没成功的页；连续不过关定为待人工后不再重送', async () => {
  const store = new M.LabelStore(null);
  const file = { path: 'D:/demo/a.pptx', sourceId: 's', file_id: 1, page_count: 3, indexed_at: 100 };
  const pagesOf = () => [1, 2, 3].map(p => ({ id: `s:1:${p}`, path: file.path, name: 'a.pptx', page: p, fileKey: M.fileKey(file),
    text: p === 1 ? '封面' : `本页内容${p}\n仿真对比两种方案的增益` }));
  const fail = await M.buildMap({ pages: pagesOf(), store, runModel: async () => { throw new Error('额度上限'); } });
  assert.equal(fail.stats.pending, 2);
  let plan = M.planFiles([file], store);
  assert.deepEqual(plan.toRead.map(f => f.path), [file.path]); assert.deepEqual(plan.retry.map(f => f.path), [file.path]);
  assert.deepEqual(store.data.pending[file.path].pages.map(p => p.page), [2, 3]);

  // 第二次：一页成功、一页超出单次上限
  const sent = [];
  const ok = async (_p, { batch }) => { sent.push(...batch.map(b => b.page)); return batch.map(b => ({ id: b.id, pageType: '仿真与验证', topics: [], quote: '本页内容' })); };
  await M.buildMap({ pages: pagesOf(), store, runModel: ok, maxModelPages: 1 });
  assert.deepEqual(sent, [2]);
  plan = M.planFiles([file], store);
  assert.equal(plan.toRead.length, 1, '还有超上限的页没判，文件仍待续跑');
  sent.length = 0;
  await M.buildMap({ pages: pagesOf(), store, runModel: ok });
  assert.deepEqual(sent, [3], '只送上次没成功的页');
  plan = M.planFiles([file], store);
  assert.equal(plan.toRead.length, 0); assert.equal(store.data.pending[file.path], undefined);

  // 核对不过：第一次留待重试，连续 MAX_REJECTS 次后定为待人工、缓存，不再重送
  const store2 = new M.LabelStore(null);
  let calls = 0;
  const bad = async (_p, { batch }) => { calls++; return batch.map(b => ({ id: b.id, pageType: '仿真与验证', topics: [], quote: '原文里没有这句' })); };
  for (let i = 0; i < M.MAX_REJECTS; i++) await M.buildMap({ pages: pagesOf(), store: store2, runModel: bad });
  assert.equal(calls, M.MAX_REJECTS);
  assert.equal(M.planFiles([file], store2).toRead.length, 0);
  const settled = await M.buildMap({ pages: pagesOf(), store: store2, runModel: bad });
  assert.equal(calls, M.MAX_REJECTS); assert.equal(settled.pages[1].pageType, M.PENDING); assert.equal(settled.pages[1].needsHuman, true);
});

test('R4 改了标签体系（页面类型 / 主题）：planFiles 传入新体系会重新列出已完成的稿；没改体系照旧跳过', async () => {
  const file = { path: 'D:/demo/r4.pptx', sourceId: 's', file_id: 1, page_count: 2, indexed_at: 100 };
  const store = new M.LabelStore(null);
  const pages = [{ id: 's:1:1', path: file.path, name: 'r4.pptx', page: 1, text: '封面与目录', fileKey: M.fileKey(file) }, { id: 's:1:2', path: file.path, name: 'r4.pptx', page: 2, text: '方案与架构\n调度算法设计机制与资源分配', fileKey: M.fileKey(file) }];
  await M.buildMap({ pages, store });
  assert.equal(M.planFiles([file], store).toRead.length, 0);
  const taxonomy = JSON.parse(JSON.stringify(M.DEFAULT_TAXONOMY));
  taxonomy.pageTypes.find(x => x.label === '方案与架构').label = '新方案';
  assert.equal(M.planFiles([file], store, taxonomy).toRead.length, 1, '体系变了要重算');
  const deckOnly = JSON.parse(JSON.stringify(M.DEFAULT_TAXONOMY)); deckOnly.deckTypes[0].label = '评审稿';
  assert.equal(M.planFiles([file], store, deckOnly).toRead.length, 0, '只改材料类型不让页标签重算');
  const after = await M.buildMap({ pages, store, taxonomy });
  assert.equal(after.pages[1].pageType, '新方案');
  assert.equal(M.planFiles([file], store, taxonomy).toRead.length, 0);
});
