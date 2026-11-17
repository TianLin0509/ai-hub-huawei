'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { PptMap } = require('../core/company-assistant/ppt-map-job');
const { createCodeAgentChannel } = require('../core/company-assistant/ppt-map-model');
const M = require('../core/company-assistant/ppt-map');

// 虚构库：每份稿若干页；第 1 页封面，其余页标题决定类型。拿不准的页（标题不命中任何规则）交模型。
function makeLibrary(dir, files) {
  const calls = { catalog: 0, read: 0, readFiles: new Set() };
  const lib = {
    a: { dir, now: () => Date.now(), changed() {} },
    config: () => ({}),
    sources: () => [{ id: 's1', label: 'Hub 素材目录' }],
    status: () => ({ roots: [dir], indexing: { state: 'done' } }),
    previewScene: async (file, page) => ({ file, page, shapes: [] }),
    async execute(op, args) {
      if (op === 'catalog') {
        calls.catalog++;
        const items = files.map((f, i) => ({ file_id: i + 1, name: f.name, path: f.path, page_count: f.pages.length, status: 'ok', indexed_at: f.indexedAt || 1, sourceId: 's1' }));
        const start = args.offset || 0, page = items.slice(start, start + args.limit);
        return { ok: true, items: page, has_more: start + args.limit < items.length, next_offset: start + page.length };
      }
      if (op === 'read') {
        calls.read++;
        return { ok: true, pages: args.ids.map(id => { const [, fid, pg] = id.split(':'); const f = files[Number(fid) - 1]; calls.readFiles.add(f.name);
          return { id, text: f.pages[Number(pg) - 1], ref: { path: f.path, name: f.name, page: Number(pg) } }; }) };
      }
      throw new Error('unexpected ' + op);
    },
  };
  return { lib, calls };
}
const deck = (name, titles, extra = {}) => ({ name, path: 'D:/lib/' + name, pages: ['封面\n' + name, ...titles.map(t => t + '\n这一页讲了很多正文内容，用来凑够长度判断。')], ...extra });
// 模型桩：每页判「仿真与验证」，引文取页文字前 6 个字
function modelStub(log = []) {
  return {
    probe: async () => ({ available: true, model: 'stub-model' }),
    run: async prompt => {
      log.push(prompt);
      const out = [];
      for (const m of prompt.matchAll(/### id=(\S+)[^\n]*\n([^\n]*)/g)) out.push({ id: m[1], pageType: '仿真与验证', topics: ['节能'], quote: '这一页讲了很多' });
      return JSON.stringify(out);
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-map-job-'));
const wait = async map => { while (map.running) await map.running; return map.state(); };

test('首次进入：读目录→规则先判→拿不准的交模型；树是主题→材料类型→文件，页可翻页', async () => {
  const dir = tmp(), files = [deck('20261101-节能方案评审.pptx', ['节能方案架构', '仿真结果与增益', '杂项一', '杂项二']), deck('调度例会周报W45.pptx', ['调度进展与计划', '杂项三'])];
  const { lib, calls } = makeLibrary(dir, files), log = [];
  const map = new PptMap(lib, { pptMapChannel: modelStub(log) });
  map.start();
  const s = await wait(map);
  assert.equal(s.job.state, 'done', s.job.error);
  assert.equal(s.files, 2); assert.equal(s.pages, 8);
  assert.equal(s.job.modelCalls, 1, '拿不准的页合成一批送模型');
  assert.equal(s.job.modelPages, 3);
  assert.equal(s.counts.model, 3);
  assert.equal(log.length, 1); assert.ok(!log[0].includes('节能方案架构'), '规则确定的页不送模型');
  const tree = map.tree();
  const topic = tree.nodes.find(n => n.key === '节能');
  assert.ok(topic, '按主题分组'); assert.equal(topic.children[0].kind, 'deckType'); assert.equal(topic.children[0].children[0].kind, 'file');
  const pages = map.pages({ node: topic.id, offset: 0, limit: 2 });
  assert.equal(pages.items.length, 2); assert.ok(pages.total >= 3, '汇总节点不列封面'); assert.ok(pages.items.every(p => p.pageType !== '封面目录'));
  const fileNode = topic.children[0].children[0];
  assert.equal(map.pages({ node: fileNode.id, limit: 50 }).total, 5, '文件节点列全部页');
  const byType = map.tree({ group: 'pageType' });
  assert.ok(byType.nodes.some(n => n.key === '仿真与验证' && n.children.length >= 1), '可切换按页面类型分组');
  // 预览只给库地图里有的页
  assert.equal((await map.preview(pages.items[0].id)).ok, true);
  await assert.rejects(map.preview('s1:999:1'), /不在库地图里/);
  // 第二次：没变的文件不读页、不调模型
  const reads = calls.read;
  map.start(); const s2 = await wait(map);
  assert.equal(calls.read, reads, '没变的文件不再读页'); assert.equal(s2.job.modelCalls, 0); assert.equal(s2.job.filesTodo, 0);
  // 改了一份稿：只读这一份
  files[1].indexedAt = 2; files[1].pages[2] = '新的杂项四\n这一页讲了很多正文内容，用来凑够长度判断。'; calls.readFiles.clear();
  map.start(); const s3 = await wait(map);
  assert.deepEqual([...calls.readFiles], ['调度例会周报W45.pptx']); assert.equal(s3.job.filesTodo, 1); assert.equal(s3.job.modelPages, 1);
  // 结果缓存在数据目录，新实例直接可用
  const again = new PptMap(lib, { pptMapChannel: modelStub() });
  assert.equal(again.state().pages, 8); assert.ok(fs.existsSync(path.join(dir, 'ppt-map', 'map.json')) && fs.existsSync(path.join(dir, 'ppt-map', 'labels.json')));
});

test('CodeAgent 不可用：只用规则分类并说明原因；不每次重读；CodeAgent 恢复后补判拿不准的页', async () => {
  const dir = tmp(), files = [deck('a.pptx', ['方案架构', '杂项一']), deck('b.pptx', ['杂项二'])];
  const { lib, calls } = makeLibrary(dir, files);
  let available = false;
  const stub = modelStub();
  const channel = { probe: async () => available ? { available: true } : { available: false, reason: '这台电脑没找到 CodeAgent 命令行，先只用规则分类' }, run: stub.run };
  const map = new PptMap(lib, { pptMapChannel: channel });
  map.start(); const s = await wait(map);
  assert.equal(s.job.state, 'done'); assert.equal(s.job.ruleOnly, true); assert.match(s.job.reason, /没找到 CodeAgent/);
  assert.equal(s.channel.available, false); assert.equal(s.job.modelCalls, 0); assert.equal(s.counts.uncertain, 2, '拿不准的页标出来');
  const reads = calls.read;
  map.start(); await wait(map);
  assert.equal(calls.read, reads, '只用规则判完的文件，CodeAgent 仍不可用时不再重读');
  available = true; map.start(); const s3 = await wait(map);
  assert.equal(s3.job.ruleOnly, false); assert.equal(s3.job.filesTodo, 2, 'CodeAgent 能用了：只用规则判过的文件补判'); assert.equal(s3.job.modelPages, 2); assert.equal(s3.counts.uncertain, 0);
});

test('CodeAgent 中途调不通（没登录 / 没权限）：本次剩下的退回只用规则，原因写清楚', async () => {
  const dir = tmp(), files = [deck('a.pptx', ['杂项一'])];
  const { lib } = makeLibrary(dir, files);
  const channel = { probe: async () => ({ available: true }), run: async () => { throw Object.assign(new Error('CodeAgent 调不通（试了 x、y）：请先登录'), { channelDown: true }); } };
  const map = new PptMap(lib, { pptMapChannel: channel });
  map.start(); const s = await wait(map);
  assert.equal(s.job.state, 'done'); assert.equal(s.job.ruleOnly, true); assert.match(s.job.reason, /请先登录/); assert.equal(s.channel.available, false);
});

test('随时取消：当前批次停下，已判完的保留；再点更新只做剩下的', async () => {
  const dir = tmp();
  const files = Array.from({ length: 6 }, (_, i) => deck(`稿${i}.pptx`, Array.from({ length: 40 }, (_, k) => `杂项${i}-${k}`)));
  const { lib } = makeLibrary(dir, files);
  let calls = 0, release;
  const stub = modelStub();
  const channel = { probe: async () => ({ available: true }), run: async (prompt, { signal }) => {
    calls++;
    if (calls === 2) { await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve); }); if (signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true }); }
    return stub.run(prompt);
  } };
  const map = new PptMap(lib, { pptMapChannel: channel });
  map.start();
  while (calls < 2) await new Promise(r => setTimeout(r, 5));
  assert.equal(map.cancel().job.state, 'canceling');
  const s = await wait(map);
  assert.equal(s.job.state, 'canceled'); assert.ok(s.job.modelCalls < 15, '取消后不再发新批次');
  assert.ok(s.counts.model >= 20, '取消前判完的批次已保存');
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'ppt-map', 'labels.json'), 'utf8'));
  assert.ok(Object.keys(store.pending).length >= 1, '没判完的文件记为待续');
  calls = 10; map.start(); const s2 = await wait(map);
  assert.equal(s2.job.state, 'done'); assert.equal(s2.counts.uncertain, 0);
  assert.equal(s.job.modelPages - 20 + s2.job.modelPages, 240, '已判完的页走缓存，只把剩下的页送模型');
  release?.();
});

test('用户改节点名、把文件拖到别的节点：记在 edits.json，重新分类（含强制全量）不被覆盖', async () => {
  const dir = tmp(), files = [deck('节能方案评审.pptx', ['节能方案架构']), deck('调度方案汇报.pptx', ['调度方案设计'])];
  const { lib } = makeLibrary(dir, files);
  const map = new PptMap(lib, { pptMapChannel: modelStub() });
  map.start(); await wait(map);
  map.rename({ dim: 'topic', key: '节能', to: '绿色基站项目' });
  assert.throws(() => map.rename({ dim: 'topic', key: '调度与资源分配', to: '绿色基站项目' }), /已经有/);
  const file = 'D:/lib/调度方案汇报.pptx';
  map.move({ path: file, topic: '节能', deckType: '评审决策' });
  const check = m => {
    const t = m.tree().nodes.find(n => n.key === '节能');
    assert.equal(t.label, '绿色基站项目');
    const d = t.children.find(c => c.key === '评审决策');
    assert.ok(d.children.some(f => f.path === file && f.moved), '拖过去的文件在新节点下');
    assert.ok(!m.tree().nodes.some(n => n.key === '调度与资源分配' && n.children.some(c => c.children.some(f => f.path === file))));
  };
  check(map);
  map.start({ force: true }); await wait(map);
  check(map);
  check(new PptMap(lib, { pptMapChannel: modelStub() }));
  // 拖回原位：改动去掉
  const original = map.map.files[file];
  map.move({ path: file, topic: original.primaryTopic, deckType: original.deckType });
  assert.equal(map.edits.moves[file], undefined);
  map.rename({ dim: 'topic', key: '节能', to: '' });
  assert.equal(map.tree().nodes.find(n => n.key === '节能').label, '节能');
  assert.throws(() => map.move({ path: file, topic: '不存在的主题' }), /没有这个主题/);
});

test('抽查 50 页：分层抽、不抽封面；逐页标对错，得出「N 个里几个对」', async () => {
  const dir = tmp();
  const files = Array.from({ length: 8 }, (_, i) => deck(`稿${i}.pptx`, Array.from({ length: 10 }, (_, k) => k % 2 ? `方案架构${k}` : `杂项${i}-${k}`)));
  const { lib } = makeLibrary(dir, files);
  const map = new PptMap(lib, { pptMapChannel: modelStub() });
  map.start(); await wait(map);
  const r = map.startReview({ n: 50 }).review;
  assert.equal(r.items.length, 50); assert.ok(r.items.every(i => i.pageType !== '封面目录'));
  assert.ok(new Set(r.items.map(i => i.by)).size >= 2, '规则和模型都抽到');
  r.items.forEach((item, i) => map.verdict({ id: item.id, pageType: i < 43 ? 'right' : 'wrong', topics: i === 0 ? 'skip' : 'right' }));
  const scores = map.reviewState().review.scores;
  const all = scores.find(s => s.dimension === 'pageType' && s.by === '全部');
  assert.equal(all.text, '50 个里 43 个对'); assert.ok(all.ci[0] > 0.7 && all.ci[1] < 0.95);
  assert.equal(scores.find(s => s.dimension === 'topics' && s.by === '全部').n, 49, '跳过的不算');
  assert.ok(scores.some(s => s.by === 'model') && scores.some(s => s.by === 'rule'), '分来源算');
  assert.throws(() => map.verdict({ id: 'x', pageType: 'right' }), /不在本轮/);
  assert.equal(new PptMap(lib, {}).reviewState().review.items.length, 50, '抽查进度存盘');
});

test('没有索引：开始时就地说明要先建索引', () => {
  const { lib } = makeLibrary(tmp(), []);
  lib.sources = () => [];
  const map = new PptMap(lib, { pptMapChannel: modelStub() });
  assert.equal(map.state().needsIndex, true);
  assert.throws(() => map.start(), /先建索引/);
});

test('模型通道：真 cmd 子进程（隐藏窗口）；第一个模型不通换下一个；全部不通给出原因', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmp(), bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'stub.js'), `
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: -p --model --output-format --effort --max-turns --disable-update'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
if (model === 'bad-model' || process.env.STUB_ALL_BAD || require('node:fs').existsSync(__dirname + '/down.flag')) { console.error('model ' + model + ' not permitted'); process.exit(3); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'model=' + model + ' len=' + input.length + ' fmt=' + args.includes('json') }));
});`);
  fs.writeFileSync(path.join(bin, 'codeagent.cmd'), `@"${process.execPath}" "%~dp0stub.js" %*\r\n`);
  const command = path.join(bin, 'codeagent.cmd');
  const make = env => createCodeAgentChannel({ dataDir: dir, models: ['bad-model'], env: { ...process.env, ...env }, findCommand: () => command,
    resolveConfig: () => ({ command, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: path.join(dir, 'cac') }) });
  const ch = make({});
  assert.equal((await ch.probe()).available, true);
  const text = await ch.run('判一下这些页 中文');
  assert.match(text, /^model=deepseek-v4\.1-flash-1017 len=\d+ fmt=true$/, '第一个模型不通，换下一个');
  assert.equal(ch.model(), 'deepseek-v4.1-flash-1017');
  // 调通过的模型后来不通了（如权限被收回）：接着试其余候选，全不通 → channelDown；下次更新（probe）重新试，恢复后照常用
  fs.writeFileSync(path.join(bin, 'down.flag'), '1');
  await assert.rejects(ch.run('x'), e => e.channelDown && /not permitted/.test(e.message));
  fs.unlinkSync(path.join(bin, 'down.flag'));
  await assert.rejects(ch.run('x'), e => e.channelDown, '同一次更新里不再反复试');
  await ch.probe();
  assert.match(await ch.run('x'), /^model=/, '下次更新重新试，恢复后照常用');
  const down = make({ STUB_ALL_BAD: '1' });
  await assert.rejects(down.run('x'), e => e.channelDown && /调不通/.test(e.message) && /not permitted/.test(e.message));
  const missing = createCodeAgentChannel({ dataDir: dir, findCommand: () => null });
  assert.deepEqual(await missing.probe(), { available: false, reason: '这台电脑没找到 CodeAgent 命令行，先只用规则分类' });
  // 取消：结束整个进程树
  fs.writeFileSync(path.join(bin, 'stub.js'), `if (process.argv.includes('--help')) { console.log('-p'); process.exit(0); } setTimeout(() => {}, 60000);`);
  const slow = make({}), ac = new AbortController();
  const t0 = Date.now(), pending = slow.run('x', { signal: ac.signal });
  setTimeout(() => ac.abort(), 800);
  await assert.rejects(pending, e => e.aborted);
  assert.ok(Date.now() - t0 < 20000);
});

// ---- r28g2 审查返工（m82 探针 F1–F6 转成的防回归单测；撤掉对应修复会失败）
function probeLib(pages) {
  const dir = tmp();
  const file = { path: 'D:/fictional/稿.pptx', name: '稿.pptx', file_id: 1, sourceId: 's', page_count: pages.length, indexed_at: 1 };
  const calls = { read: 0, catalog: 0 };
  const lib = { a: { dir, now: () => Date.now() }, config: () => ({}), sources: () => [{ id: 's' }], status: () => ({}),
    execute: async (op, args) => {
      if (op === 'catalog') { calls.catalog++; return { items: [file] }; }
      calls.read++;
      return { pages: args.ids.map(id => { const p = +id.split(':')[2]; return { id, text: pages[p - 1], ref: { path: file.path, name: file.name, page: p } }; }) };
    } };
  return { lib, file, calls, dir };
}
const rulesOnly = { probe: async () => ({ available: false, reason: 'only rules' }) };
const runOnceMap = async m => { m.start(); await m.running; return m.state(); };
const LONG = '这是足够长的正文用于展示架构中的各个组成部分。';

test('r28g2 F1 待人工页：按页面类型分组时树上的数和点进去取到的页一致，且文件节点 id 不重复', async () => {
  const { lib, file } = probeLib(['封面', '整体情况\n这一页没有明确分类关键词而且正文足够长。', '另一个情况\n这一页也没有明确分类关键词而且正文足够长。']);
  // 第 2 页模型漏判（→ 待人工），第 3 页判「其他」
  const m = new PptMap(lib, { pptMapChannel: { probe: async () => ({ available: true }), run: async () => JSON.stringify([{ id: 's:1:3', pageType: '其他', topics: [], quote: '这一页也没有明确' }]) } });
  await runOnceMap(m); await runOnceMap(m);
  assert.equal(m.map.files[file.path].pages[1].pageType, '待人工');
  const nodes = m.tree({ group: 'pageType' }).nodes;
  for (const node of nodes) {
    assert.equal(m.pages({ node: node.id }).total, node.pages, `「${node.label}」树上计数 = 取到的页数`);
    for (const child of node.children) assert.equal(m.pages({ node: child.id }).total, child.pages);
  }
  const ids = nodes.flatMap(n => n.children.map(c => c.id));
  assert.equal(new Set(ids).size, ids.length, '文件节点 id 不重复');
  assert.ok(nodes.some(n => n.key === '待人工' && n.pages === 1));
});

test('r28g2 F2 只改材料类型不清掉用户之前锁定的主题；稿子变了主题仍按用户的', async () => {
  const pages = ['封面', '调度方案与架构\n' + LONG]; pages.push(pages[1]);
  const { lib, file } = probeLib(pages);
  const m = new PptMap(lib, { pptMapChannel: rulesOnly }); await runOnceMap(m);
  m.move({ path: file.path, topic: '节能' });
  pages[1] = pages[2] = '节能方案与架构\n' + LONG; file.indexed_at = 2; await runOnceMap(m);
  assert.equal(m.map.files[file.path].primaryTopic, '节能');
  m.move({ path: file.path, deckType: '例会周报' });
  assert.equal(m.edits.moves[file.path].topic, '节能', '改材料类型时主题锁保留');
  pages[1] = pages[2] = '信道方案与架构\n' + LONG; file.indexed_at = 3; await runOnceMap(m);
  assert.deepEqual([m.placeOf(m.map.files[file.path]).topic, m.placeOf(m.map.files[file.path]).deckType], ['节能', '例会周报']);
  // 明确恢复自动：该维度传 null
  m.move({ path: file.path, topic: null });
  assert.equal(m.placeOf(m.map.files[file.path]).topic, '信道与感知');
  assert.equal(m.edits.moves[file.path].deckType, '例会周报');
});

test('r28g2 F3 map.json 写盘中断：重启后增量更新会把缺结果的文件重做，不永久漏掉', async () => {
  const { lib, file, dir } = probeLib(['封面', '方案与架构\n' + LONG]);
  const m = new PptMap(lib, { pptMapChannel: rulesOnly }); const save = m.save.bind(m); let once = true;
  m.save = () => { if (once) { once = false; throw new Error('simulated map.json write interruption'); } save(); };
  assert.equal((await runOnceMap(m)).job.state, 'error');
  assert.ok(!fs.existsSync(path.join(dir, 'ppt-map', 'map.json')));
  // 人为制造「labels 有完成记录、map 没结果」的最坏状态（旧写盘顺序会出现）
  m.store.data.files[file.path] = M.doneKey(M.fileKey(file), M.compile().version); m.store.save();
  const next = new PptMap(lib, { pptMapChannel: rulesOnly }); const s = await runOnceMap(next);
  assert.equal(s.job.state, 'done'); assert.equal(s.job.filesTodo, 1); assert.equal(s.files, 1); assert.equal(s.pages, 2);
  // 同一进程里接着点更新也能补上（不靠重启）
  const m2 = new PptMap(lib, { pptMapChannel: rulesOnly }); delete m2.map.files[file.path];
  assert.equal((await runOnceMap(m2)).job.filesTodo, 1);
});

test('r28g2 F4 取消后不再读同一份稿后面的分块', async () => {
  const { lib, calls } = probeLib(Array.from({ length: 161 }, (_, i) => i === 0 ? '封面' : '方案与架构\n' + LONG));
  const execute = lib.execute; let m;
  lib.execute = async (op, args) => { const r = await execute(op, args); if (op === 'read' && calls.read === 1) m.cancel(); return r; };
  m = new PptMap(lib, { pptMapChannel: rulesOnly }); const s = await runOnceMap(m);
  assert.equal(s.job.state, 'canceled'); assert.equal(calls.read, 1, '取消后不再发读页请求');
  assert.equal(m.store.data.files['D:/fictional/稿.pptx'], undefined, '读了一半的稿不记完成');
  assert.equal(s.files, 0);
});

test('r28g2 F5 索引只返回部分页：不记完成、说明原因，下次更新补读', async () => {
  const { lib, file } = probeLib(['封面', '方案与架构\n' + LONG, '方案与架构\n这是另一页' + LONG]);
  const execute = lib.execute; let partial = true;
  lib.execute = async (op, args) => { const r = await execute(op, args); return op === 'read' && partial ? { pages: r.pages.slice(0, 2), missing: [{ page: 3, reason: 'not found' }] } : r; };
  const m = new PptMap(lib, { pptMapChannel: rulesOnly });
  const first = await runOnceMap(m);
  assert.equal(first.pages, 2); assert.ok(first.job.errors.some(e => /1 页没读到/.test(e)), first.job.errors.join('；'));
  assert.equal(m.store.data.files[file.path], undefined); assert.deepEqual(m.store.data.pending[file.path].pages.map(p => p.page), [3]);
  partial = false; const second = await runOnceMap(m);
  assert.equal(second.job.filesTodo, 1); assert.equal(second.pages, 3); assert.equal(second.job.errors.length, 0);
});

test('r28g2 F6 换候选模型重试：调用次数和送页数按真实起进程的次数算，预算按不同页数扣', async () => {
  const { EventEmitter } = require('node:events');
  const { lib } = probeLib(['封面', '整体情况\n这一页没有明确分类关键词而且正文足够长。']); let actual = 0;
  const spawnImpl = (_exe, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: () => queueMicrotask(() => {
      if (args.join(' ').includes('--help')) { child.stdout.emit('data', '-p --output-format --effort --max-turns --disable-update'); child.emit('close', 0); return; }
      actual++;
      if (actual === 1) { child.stderr.emit('data', 'not permitted'); child.emit('close', 3); }
      else { child.stdout.emit('data', JSON.stringify({ type: 'result', result: JSON.stringify([{ id: 's:1:2', pageType: '结论摘要', topics: [], quote: '这一页没有明确分类' }]) })); child.emit('close', 0); }
    }) }; return child; };
  const ch = createCodeAgentChannel({ dataDir: lib.a.dir, spawnImpl, findCommand: () => 'codeagent', resolveConfig: () => ({ command: 'codeagent' }) });
  const m = new PptMap(lib, { pptMapChannel: ch }); const s = await runOnceMap(m);
  assert.equal(actual, 2);
  assert.equal(s.job.modelCalls, 2); assert.equal(s.job.modelPages, 2); assert.equal(s.job.modelBatches, 1);
});

