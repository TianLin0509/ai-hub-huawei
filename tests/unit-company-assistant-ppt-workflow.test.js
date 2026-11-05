'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
const { createPptHandlers } = require('../core/company-assistant/ppt-ipc');
const { spawn } = require('node:child_process');
const { PptImgtext, lookupFrame } = require('../core/company-assistant/ppt-imgtext');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

function protocolLibrary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-search-plan-')), db = path.join(dir, 'doctor.db'); fs.writeFileSync(db, 'fixture');
  const requests = [], a = { dir, settings: () => ({ ppt: { db, doctorExe: process.execPath } }) };
  const doctor = new PptDoctor(a, {
    pptDoctorTrustedExecutable: true,
    pptDoctorArgs: [path.join(__dirname, 'fixtures/ppt-doctor-fake.js')],
    pptEnv: { ...process.env, PPT_DOCTOR_FIXTURE: 'search-plan' },
    pptDoctorSpawn(exe, args, options) {
      requests.push({ action: args[args.indexOf('--hub') + 1], body: JSON.parse(fs.readFileSync(args[args.indexOf('--in') + 1], 'utf8')) });
      assert.equal(options.windowsHide, true);
      return spawn(exe, args, options);
    }
  });
  const ppt = new PptLibrary(a, { pptDoctor: doctor }); t.after(() => ppt.close());
  return { ppt, requests, handlers: createPptHandlers({ ppt }) };
}

for (const query of ['SRS', '信道估计', '  信道 估计  ', '图']) {
  test(`PPT搜索框真实文件协议：${JSON.stringify(query)}转换为非空查询计划`, async t => {
    const { requests, handlers } = protocolLibrary(t);
    const result = await handlers['ppt-search']({ query });
    assert.equal(result.ok, true);
    const searches = requests.filter(r => r.action === 'search');
    assert.equal(searches.length, 1, '每个索引只提交一次Doctor搜索');
    assert.deepEqual(searches[0].body.plan.queries, [{ query: query.trim(), rationale: '' }]);
    assert.ok(searches[0].body.plan.queries.length >= 1 && searches[0].body.plan.queries.length <= 16);
  });
}

test('PPT搜索框空白输入不发送Doctor搜索请求', async t => {
  const { requests, handlers } = protocolLibrary(t);
  await assert.rejects(handlers['ppt-search']({ query: '   ' }), /每组查询/);
  assert.equal(requests.filter(r => r.action === 'search').length, 0);
});

test('Agent多查询保留用途和理由，规范空白后仍只调用一次Doctor', async t => {
  const { ppt, requests } = protocolLibrary(t);
  const question = '寻找信道估计', queries = ['SRS', { query: ' 信道 估计 ', rationale: '中文同义词' }, '相位'];
  assert.equal((await ppt.find({ question, queries })).ok, true);
  const searches = requests.filter(r => r.action === 'search');
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].body.plan, { intent: question, queries: [
    { query: 'SRS', rationale: '' }, { query: '信道 估计', rationale: '中文同义词' }, { query: '相位', rationale: '' }
  ] });
  assert.equal(queries[1].query, ' 信道 估计 ', '不改写调用方的输入对象');
});

const first16 = 'A B C D E F G H I J K L M N O P';
const first16Quoted = first16.split(' ').map(q => `"${q}"`).join(' ');
const queryBounds = [
  ['21词英文', 'We use it to do so as we can and it is not too bad for all of us here now', 'We use it to do so as we can and it is not too bad for'],
  ['17记号', first16 + ' Q', first16],
  ['201汉字', '调'.repeat(201), '调'.repeat(200)],
  ['恰好200字', '调'.repeat(200), '调'.repeat(200)],
  ['恰好16词', first16, first16],
  ['连续引号短语', '"A"“B”「C」《D》"E""F""G""H""I""J""K""L""M""N""O""P""Q"', first16Quoted],
  ['不同引号及空白', ' ＂SRS＂\t\n『信道』\u0085‘估计’\u001c\'phase\' ', '"SRS" "信道" ‘估计’ \'phase\''],
  ['Unicode字符不截断代理对', '𠀀'.repeat(201), '𠀀'.repeat(200)]
];
for (const [label, query, expected] of queryBounds) {
  test(`搜索框和助理find共用Doctor边界：${label}`, async t => {
    const { ppt, requests, handlers } = protocolLibrary(t);
    const folder = path.resolve(os.tmpdir(), '素材');
    assert.equal((await handlers['ppt-search']({ query, folder })).ok, true);
    assert.equal((await ppt.find({ question: '找调度素材', queries: [{ query, rationale: '原词' }, '调度', 'scheduling'] })).ok, true);
    const searches = requests.filter(r => r.action === 'search');
    assert.equal(searches.length, 2, '两个入口各发一次批量请求');
    assert.equal(searches[0].body.plan.queries[0].query, expected);
    assert.deepEqual(searches[0].body.folders, [folder]);
    assert.equal(searches[1].body.plan.queries[0].query, expected);
    assert.equal(searches[1].body.plan.queries[0].rationale, '原词');
    assert.equal(searches[1].body.plan.intent, '找调度素材');
  });
}

test('原词也按边界处理，截短去重后含原词最多16组，调用方计划不变', async t => {
  const { ppt, requests } = protocolLibrary(t);
  const original = '调'.repeat(201);
  const plan = { intent: '原词与扩展词', query: original, queries: [original, '调'.repeat(200),
    ...Array.from({ length: 17 }, (_, i) => ({ query: ` 扩展${i} `, rationale: '同义词' }))] };
  const before = JSON.stringify(plan);
  assert.equal((await ppt.execute('search', { plan })).ok, true);
  const search = requests.filter(r => r.action === 'search');
  assert.equal(search.length, 1);
  assert.equal(search[0].body.plan.query, undefined, '原词已进入queries，不可通过plan.query旁路超限');
  assert.deepEqual(search[0].body.plan.queries, [
    { query: '调'.repeat(200), rationale: '用户原词' },
    ...Array.from({ length: 15 }, (_, i) => ({ query: `扩展${i}`, rationale: '同义词' }))
  ]);
  assert.equal(search[0].body.plan.intent, plan.intent);
  assert.equal(JSON.stringify(plan), before);
});

test('仅引号查询不发送Doctor请求，空计划仍明确拒绝', async t => {
  const { ppt, requests, handlers } = protocolLibrary(t);
  await assert.rejects(handlers['ppt-search']({ query: ' "“”「」《》\' ' }), /每组查询/);
  await assert.rejects(ppt.execute('search', { plan: { queries: [] } }), /queries/);
  assert.equal(requests.filter(r => r.action === 'search').length, 0);
});

test('长英文尾部保留为另一组查询，搜索框和助理都只提交一次计划', async t => {
  const { ppt, requests, handlers } = protocolLibrary(t);
  const prefix = Array.from({ length: 16 }, (_, i) => `absent${i}`).join(' ');
  const query = prefix + ' scheduling throughput';
  await handlers['ppt-search']({ query });
  await ppt.find({ question: '找调度素材', queries: [{ query, rationale: '完整原词' }, 'PF', '调度'] });
  const searches = requests.filter(r => r.action === 'search');
  assert.equal(searches.length, 2);
  assert.deepEqual(searches[0].body.plan.queries.map(q => q.query), [prefix, 'scheduling throughput']);
  assert.deepEqual(searches[1].body.plan.queries.slice(0, 2), [
    { query: prefix, rationale: '完整原词' }, { query: 'scheduling throughput', rationale: '完整原词' }
  ]);
});

test('英文按字符边界整词分组并去重，仍遵守Doctor总查询上限', () => {
  const { queriesFor } = require('../core/company-assistant/ppt-search');
  const words = Array.from({ length: 25 }, (_, i) => `mechanism${String(i).padStart(2, '0')}`);
  const queries = queriesFor({ query: words.join(' ') });
  assert.equal(queries.map(q => q.query).join(' '), words.join(' '));
  assert.ok(queries.every(q => Array.from(q.query).length <= 200 && q.query.split(' ').length <= 16));
  assert.equal(queriesFor({ plan: { queries: [words.join(' '), words.join(' ')] } }).length, queries.length);
  assert.equal(queriesFor({ query: Array.from({ length: 300 }, (_, i) => `q${i}`).join(' ') }).length, 16);
});

test('合法短语和英文撇号保留，短语按一词计算而不拆开', async t => {
  const { ppt, requests } = protocolLibrary(t);
  const longPhrase = '"' + Array.from({ length: 20 }, (_, i) => `p${i}`).join(' ') + '" throughput';
  const queries = ['"cell edge" throughput', "operator's view", longPhrase];
  await ppt.find({ question: '查原词', queries });
  assert.deepEqual(requests.find(r => r.action === 'search').body.plan.queries.map(q => q.query), queries);
});

test('长查询分组不会从中间截断合法短语，超长短语退为有界词组', () => {
  const { queriesFor } = require('../core/company-assistant/ppt-search');
  const prefix = Array.from({ length: 16 }, (_, i) => `q${i}`).join(' ');
  const query = prefix + ' "cell edge" throughput';
  assert.deepEqual(queriesFor({ query }).map(q => q.query), [prefix, '"cell edge" throughput']);
  const longWords = Array.from({ length: 30 }, (_, i) => `mechanism${i}`);
  const split = queriesFor({ query: '"' + longWords.join(' ') + '"' });
  assert.equal(split.map(q => q.query).join(' '), longWords.join(' '));
  assert.ok(split.every(q => !q.query.includes('"') && Array.from(q.query).length <= 200 && q.query.split(' ').length <= 16));
});

test('截图长英文按80字边界拆组，保留尾部关键词', async () => {
  const { ppt, image } = conversion();
  const text = Array.from({ length: 16 }, (_, i) => `absent${i}`).join(' ') + ' scheduling throughput';
  ppt.doctor.call = async (_op, req) => {
    fs.mkdirSync(req.workdir, { recursive: true });
    const seed = path.join(req.workdir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ elements: [{ type: 'text', text }] }));
    return { ok: true, seed };
  };
  const result = await lookupFrame(ppt, { imagePath: image });
  assert.equal(result.queries.join(' '), text);
  assert.ok(result.queries.every(q => Array.from(q).length <= 80 && q.split(' ').length <= 16));
});

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-workflow-')), db = path.join(dir, 'doctor.db'); fs.writeFileSync(db, 'fixture');
  const calls = [], a = { dir, now: Date.now, changed() {}, settings: () => ({ ppt: { db } }) };
  const doctor = { close() {}, async status() { return { ok: true, installed: true, available: true, doctorVersion: 'fixture' }; }, async call(op, req) {
    calls.push({ op, req }); const sid = hash(path.resolve(req.db || db).toLowerCase());
    const ref = { path: path.join(dir, 'original.pptx'), name: 'original.pptx', file_id: 1, page: 1, source_id: sid, index_id: sid, page_hash: 'page-fingerprint', content_hash: 'file-fingerprint' };
    const item = { id: sid + ':1:1', ref, snippet: 'SRS 信道估计', retrieval_score: 1 / 61, matched_queries: [{ query: 'SRS', kind: 'body', rank: 1 }], duplicate_refs: [] };
    if (op === 'status') return { ok: true, indexed_pages: 1, documents: [{ path: ref.path, page_count: 1 }], file_status_counts: [{ status: 'ok', files: 1 }], warnings: [] };
    if (op === 'search') return { ok: true, candidates: [item], queries: [{ query: 'SRS' }], truncated: false, scope: {} };
    if (op === 'read') { assert.equal(req.refs[0].page_hash, 'page-fingerprint'); return { ok: true, pages: [{ ...item, text: 'SRS 信道估计完整正文', text_truncated: false, source_state: 'metadata_matches_index' }], missing: [], scope: {} }; }
    if (op === 'report') return { ok: true, verified_rows: req.decision.results.map(r => ({ ...r, conditions: [] })), recommendations: req.decision.results.map(r => ({ id: r.id })) };
    throw new Error(op);
  } };
  const ppt = new PptLibrary(a, { pptDoctor: doctor }); ppt.process = () => { throw new Error('默认路径不得运行 Python'); };
  return { dir, db, a, ppt, doctor, calls };
}

test('默认Doctor：单次批量search、完整ref读页、本轮证据report，全程不碰系统Python', async () => {
  const { ppt, calls } = library();
  assert.equal((await ppt.refresh()).available, true);
  const result = await ppt.find({ question: '信道估计', queries: ['信道估计', '相位', 'SRS'] });
  assert.equal(calls.filter(c => c.op === 'search').length, 1); assert.equal(calls.find(c => c.op === 'search').req.plan.queries.length, 3);
  assert.equal(result.candidates[0].id.split(':').length, 3);
  ppt.beginTask('task-1'); const read = await ppt.read({ ids: [result.candidates[0].id] });
  const row = { id: read.pages[0].id, use: '介绍估计', reason: '本页包含估计机制', quote: 'SRS 信道估计', conditions: '文字已核对', assessments: [], relevance: '直接适用' };
  await assert.rejects(ppt.execute('report', { decision: { task: { purpose: '介绍' }, results: [row] }, evidence: { pages: [{ ...read.pages[0], text: '伪造正文' }] } }), /实际读到/);
  const report = await ppt.execute('report', { decision: { task: { purpose: '介绍', conditions: [] }, results: [row] } });
  assert.match(report.report, /SRS 信道估计/); assert.equal(calls.filter(c => c.op === 'report').length, 1);
  assert.equal(ppt.takeTaskResult('task-1')[0].page, 1); ppt.close();
});

test('默认Doctor多索引同时启动且部分失败仍有结果；迟到read不写入下一任务', async () => {
  const { ppt, doctor, db, dir } = library();
  fs.mkdirSync(path.dirname(ppt.ownedDb()), { recursive: true }); fs.writeFileSync(ppt.ownedDb(), 'fixture');
  const original = doctor.call.bind(doctor), started = [], releases = [];
  doctor.call = (op, req) => op !== 'search' ? original(op, req) : new Promise((resolve, reject) => { started.push(req.db); releases.push(() => req.db === db ? reject(new Error('损坏索引')) : original(op, req).then(resolve, reject)); });
  const pending = ppt.find({ question: '信道估计', queries: ['信道估计', '相位', 'SRS'] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started.length, 2); releases.forEach(release => release());
  const result = await pending; assert.equal(result.candidates.length, 1); assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /损坏索引/);
  let releaseRead;
  doctor.call = (op, req) => op === 'read' ? new Promise(resolve => { releaseRead = () => original(op, req).then(resolve); }) : original(op, req);
  ppt.beginTask('old'); const read = ppt.read({ ids: [result.candidates[0].id] });
  await new Promise(resolve => setImmediate(resolve)); ppt.beginTask('new'); releaseRead(); await read;
  assert.equal(ppt.taskEvidence.size, 0); ppt.close();
});
test('默认Doctor的documents仍用于旧回答引用核对，无需启用Python旧路径', async () => {
  const { ppt, calls } = library();
  const note = await ppt.citationNote('推荐 original.pptx 第 1 页；另见 original.pptx 第 9 页');
  assert.match(note, /这份文稿只有 1 页/);
  assert.ok(calls.some(call => call.op === 'status' && call.req.includePaths === true));
  ppt.close();
});

test('原页操作先核验引用；复制不污染Agent证据，过期源文件拒绝复制', async () => {
  const { ppt, doctor } = library();
  const id = (await ppt.find({ question: '信道', queries: ['SRS', '信道', '相位'] })).candidates[0].id;
  ppt.beginTask('agent-task');
  const copied = []; ppt.deps.copyPptSlide = async (file, page) => { copied.push({ file, page }); return { ok: true, target: '目标.pptx', page: 2 }; };
  assert.equal((await ppt.copy(id)).page, 2); assert.equal(copied[0].page, 1); assert.equal(ppt.taskEvidence.size, 0);
  let shown; ppt.deps.showPptInFolder = async file => { shown = file; }; await ppt.showFolder(id); assert.equal(shown, copied[0].file);
  await assert.rejects(ppt.convertPage(id), /暂无缓存图片/);
  const call = doctor.call.bind(doctor);
  doctor.call = async (op, request) => { const r = await call(op, request); if (op === 'read') r.pages[0].source_state = 'source_metadata_changed'; return r; };
  await assert.rejects(ppt.copy(id), /源文件已更新/); assert.equal(copied.length, 1);
  ppt.close();
});

test('素材范围进入Doctor单次检索参数，非法相对路径不调用后端', async () => {
  const { createPptHandlers } = require('../core/company-assistant/ppt-ipc');
  const calls = [], handlers = createPptHandlers({ ppt: { execute: (op, args) => { calls.push({ op, args }); return { ok: true }; } } });
  const folder = path.resolve(os.tmpdir(), '素材');
  await handlers['ppt-search']({ query: 'SRS', folder }); assert.deepEqual(calls[0].args.roots, [folder]);
  assert.throws(() => handlers['ppt-search']({ query: 'SRS', folder: '../invalid' }), /有效/);
  assert.equal(calls.length, 1);
});

function conversion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-convert-')), image = path.join(dir, 'slide.png'); fs.writeFileSync(image, 'image fixture');
  const calls = [], a = { dir, now: Date.now, changed() {}, ask: () => ({ id: 'chat-1' }), chat: () => [{ id: 'chat-1', state: 'running' }] };
  const doctor = { async call(op, req) {
    calls.push({ op, req }); fs.mkdirSync(req.workdir, { recursive: true });
    if (op === 'imgtext-seed') { const seed = path.join(req.workdir, 'seed.json'); fs.writeFileSync(seed, JSON.stringify({ elements: [{ type: 'text', text: 'SRS 信道估计', bbox: [0, 0, 100, 20] }] })); return { ok: true, seed, seedHash: 'seed-fingerprint', preview: image }; }
    return { ok: true, pptx: path.join(req.workdir, 'editable.pptx'), preview: image, mode: Object.keys(req.ops).length ? 'agent' : 'image_fallback', pixel_gate: { passed: false }, reviewItems: ['图中文字需核对'] };
  } };
  const ppt = { a, doctor, deps: {}, execute: async (op, args) => ({ ok: true, candidates: [], args }) };
  return { service: new PptImgtext(ppt), ppt, calls, image, a };
}

test('增强转字复用助理，空ops明确图像算法回退，失败可恢复且最多两轮修补', async () => {
  const { service, image, a, calls } = conversion(); a.ask = () => { throw new Error('会话尚未接通'); };
  const job = await service.start(image); assert.equal(job.state, 'error'); assert.ok(job.seed); assert.match(job.error, /未接通/);
  a.ask = () => ({ id: 'chat-1' }); assert.equal((await service.ask(job.id)).state, 'waiting_agent');
  await assert.rejects(service.build({ jobId: job.id, vision: 'unavailable', ops: { fix: { 1: '不应改图' } } }), /空 ops/);
  const result = await service.build({ jobId: job.id, vision: 'unavailable', ops: {} });
  assert.equal(result.state, 'done'); assert.equal(result.result.mode, 'image_fallback'); assert.match(result.step, /复核/);
  await service.build({ jobId: job.id, vision: 'seen', ops: { confirm: [1] } });
  await service.build({ jobId: job.id, vision: 'seen', ops: { confirm: [1] } });
  await assert.rejects(service.build({ jobId: job.id, vision: 'seen', ops: {} }), /两轮修补/);
  assert.equal(calls.filter(c => c.op === 'imgtext-build').length, 3);
});

test('会议截图反查：OCR标题进入素材查询，返回候选而非画面已确认', async () => {
  const { ppt, image } = conversion();
  const result = await lookupFrame(ppt, { imagePath: image, limit: 5 });
  assert.deepEqual(result.queries, ['SRS 信道估计']); assert.equal(result.args.limit, 5); assert.match(result.coverage, /未确认画面一致/);
  await assert.rejects(lookupFrame(ppt, { imagePath: 'https://example/image.png' }), /本机/);
});

test('截图反查的长行分组后再检索，空引号行过滤', async () => {
  const { ppt, image } = conversion();
  ppt.doctor.call = async (_op, req) => {
    fs.mkdirSync(req.workdir, { recursive: true });
    const seed = path.join(req.workdir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ elements: [
      '"“”「」', queryBounds[0][1], queryBounds[1][1], queryBounds[5][1], '短标题'
    ].map((text, i) => ({ type: 'text', text, bbox: [0, i * 20, 200, i * 20 + 15] })) }));
    return { ok: true, seed };
  };
  const result = await lookupFrame(ppt, { imagePath: image });
  assert.deepEqual(result.queries, [queryBounds[0][2], 'all of us here now', first16, first16Quoted, '"Q"', '短标题']);
  assert.deepEqual(result.args.plan.queries, result.queries);
});

test('截图只有引号时仍提示无可检索文字，不提交空查询', async () => {
  const { ppt, image } = conversion();
  ppt.doctor.call = async (_op, req) => {
    fs.mkdirSync(req.workdir, { recursive: true });
    const seed = path.join(req.workdir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ elements: [{ type: 'text', text: ' "“”「」《》 ' }] }));
    return { ok: true, seed };
  };
  ppt.execute = () => { throw new Error('不应执行检索'); };
  assert.equal((await lookupFrame(ppt, { imagePath: image })).code, 'OCR_NO_TEXT');
});

for (const notSent of [true, false]) {
  test(`独立素材AI任务提交被停止：${notSent ? '明确未发送' : '可能已执行'}立即结束，提示重新开始且不自动重发`, async t => {
    const { CompanyAiTasks } = require('../core/company-ai-tasks');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ai-stop-'));
    const sent = [], closed = [], states = [];
    let finalReads = 0;
    const tasks = new CompanyAiTasks({ dataDir, concurrency: 1, pollMs: 5,
      createSession: async () => ({ ok: true }),
      sendPrompt: async id => { sent.push(id); return { ok: true, stopped: true, notSent }; },
      lastFinal: () => { finalReads++; throw Error('停止后不得继续等待答案'); },
      closeSession: async id => { closed.push(id); },
      onChanged: value => states.push(value)
    });
    t.after(() => { tasks.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const expectedMessage = notSent
      ? '已停止：任务还没发给 CodeAgent，可以直接重新开始。'
      : '已停止：停止时任务正在提交，CodeAgent 可能已经执行。需要结果请重新开始（可能会重复执行一次）；不会自动重发。';
    await assert.rejects(tasks.run({ text: '查找素材', timeoutMs: 1000 }), error => {
      assert.equal(error.code, notSent ? 'TASK_NOT_SENT' : 'TASK_DELIVERY_UNCONFIRMED');
      assert.equal(error.notSent, notSent);
      assert.equal(error.stopped, true);
      assert.equal(error.message, expectedMessage);
      return true;
    });
    assert.equal(finalReads, 0); assert.equal(sent.length, 1);
    assert.ok(closed.includes(sent[0]));
    assert.equal(states.at(-1).state, 'cancelled');
    const job = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-ai-tasks', states.at(-1).id, 'task.json'), 'utf8'));
    assert.equal(job.state, 'cancelled');
    assert.equal(job.error, expectedMessage);
    assert.doesNotMatch(job.error, /超时/);
  });
}

for (const receipt of [
  { error: 'prompt-context-failed', message: '准备上下文失败：附件不存在' },
  { error: 'native-recovery-failed', message: '原生连接恢复失败：会话记录不可用' },
  { error: 'send-threw', message: '写入终端失败，确认尚未发送' },
  { error: '连接未就绪，尚未发送' },
]) {
  test(`独立素材AI任务未发送且未停止：保留真实原因 ${receipt.error}`, async t => {
    const { CompanyAiTasks } = require('../core/company-ai-tasks');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ai-not-sent-'));
    const states = [], closed = [];
    let submissions = 0, reads = 0;
    const tasks = new CompanyAiTasks({ dataDir, pollMs: 5,
      createSession: async () => ({ ok: true }),
      sendPrompt: async () => { submissions++; return { ok: false, notSent: true, ...receipt }; },
      lastFinal: () => { reads++; throw Error('明确未发送不得等待答案'); },
      closeSession: async id => closed.push(id), onChanged: value => states.push(value),
    });
    t.after(() => { tasks.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    await assert.rejects(tasks.run({ text: '查找素材', timeoutMs: 1000 }), error => {
      assert.equal(error.message, receipt.message || receipt.error);
      assert.equal(error.code, 'TASK_NOT_SENT');
      assert.equal(error.notSent, true); assert.equal(error.stopped, false);
      assert.doesNotMatch(error.message, /已停止/);
      return true;
    });
    assert.equal(submissions, 1); assert.equal(reads, 0);
    assert.ok(closed.includes(states.at(-1).sessionId));
    const job = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-ai-tasks', states.at(-1).id, 'task.json'), 'utf8'));
    assert.equal(job.state, 'error'); assert.equal(job.error, receipt.message || receipt.error);
  });
}

test('独立素材AI任务正常提交仍等待本任务回执并交付正文', async t => {
  const { CompanyAiTasks } = require('../core/company-ai-tasks');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ai-success-'));
  let final, reads = 0, submissions = 0;
  const tasks = new CompanyAiTasks({ dataDir, pollMs: 5,
    createSession: async () => ({ ok: true }),
    sendPrompt: async (_id, prompt) => { submissions++; final = '已找到素材\n' + prompt.match(/\[任务回执:[^\]]+\]/u)[0]; return { ok: true }; },
    lastFinal: () => { reads++; return { text: final }; }, closeSession: async () => {}
  });
  t.after(() => { tasks.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const result = await tasks.run({ text: '查找素材' });
  assert.equal(result.text, '已找到素材'); assert.equal(submissions, 1); assert.equal(reads, 1);
});
test('转字写任务中断后保留产物并阻止Agent自动重放，页面明确重试才能恢复', async () => {
  const { service, image, ppt } = conversion(), job = await service.start(image);
  const original = ppt.doctor.call; let builds = 0, opened;
  ppt.doctor.call = async (op, req) => {
    if (op === 'imgtext-build' && ++builds === 1) throw Object.assign(new Error('装配中断'), { code: 'REQUEST_INTERRUPTED', resultMayBePartial: true });
    return original(op, req);
  };
  await assert.rejects(service.build({ jobId: job.id, vision: 'seen', ops: { confirm: [1] } }), /手动重试/);
  assert.equal(service.snapshot(job.id).needsOutputCheck, true);
  await assert.rejects(service.build({ jobId: job.id, vision: 'seen', ops: { confirm: [1] } }), /自动装配已暂停/);
  await assert.rejects(service.ask(job.id), /手动重试/); assert.equal(builds, 1);
  ppt.deps.pptOpenWorkdir = async dir => { opened = dir; return ''; };
  await service.openWorkdir(job.id); assert.equal(opened, service.snapshot(job.id).workdir);
  assert.equal((await service.retry(job.id, true)).state, 'done'); assert.equal(builds, 2);
  await assert.rejects(service.retry(job.id), /本轮转字结束/);
});
