'use strict';
// PPT 库地图（r28g，2026-11-17 选定树形目录）：后台增量分类 + 树形目录 + 用户改名 / 拖动 + 抽查 50 页。
// 流程：读索引目录（catalog，只读）→ 按文件增量（没变的文件不读页）→ 读页 → 规则先判、拿不准的交低档模型（ppt-map.js）→ 存本机。
// 文件按组处理（约 200 页一组），每组判完立即落盘：取消、关 Hub 都不丢已判完的部分，下次只做剩下的。
// 存储都在 PPT 工作目录/ppt-map/：labels.json（逐页缓存）、map.json（树用的结果）、edits.json（用户改名与拖动）、review.json（抽查）。
// 用户改动单独存，分类只写 map.json，所以增量分类永远不会覆盖用户的改动。
const fs = require('node:fs');
const path = require('node:path');
const M = require('./ppt-map');

const GROUP_PAGES = 200;
const UNSORTED = '未归类';
const DIMS = ['topic', 'deckType', 'pageType'];
const PAGE_TYPE_KEYS = new Set([...M.DEFAULT_TAXONOMY.pageTypes.map(c => c.label), M.OTHER, M.PENDING, M.COVER]);
const norm = file => path.resolve(String(file || '')).replace(/\\/g, '/').toLowerCase();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('[ppt-map] 读不了', path.basename(file), error.message); return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

class PptMap {
  constructor(library, deps = {}) {
    this.lib = library; this.deps = deps;
    this.dir = path.join(require('./ppt-work-dir').workDir(library.a), 'ppt-map');
    this.store = new M.LabelStore(path.join(this.dir, 'labels.json'));
    this.map = readJson(this.file('map.json'), null) || { files: {} };
    this.edits = this.normEdits(readJson(this.file('edits.json'), {}));
    this.review = readJson(this.file('review.json'), null);
    this.job = { state: 'idle' };
    this.channelInfo = null;
    this.abort = null;
    this.reindex();
  }
  file(name) { return path.join(this.dir, name); }
  now() { return this.lib.a.now ? this.lib.a.now() : Date.now(); }
  changed() { try { this.lib.a.changed?.(); } catch { /* 界面没开 */ } }
  normEdits(e) { return { renames: { topic: { ...(e?.renames?.topic || {}) }, deckType: { ...(e?.renames?.deckType || {}) }, pageType: { ...(e?.renames?.pageType || {}) } }, moves: { ...(e?.moves || {}) } }; }
  reindex() { this.pageIndex = new Map(); for (const f of Object.values(this.map.files || {})) for (const p of f.pages || []) this.pageIndex.set(p.id, { path: f.path, page: p.page }); }
  channel() {
    if (this.deps.pptMapChannel) return this.deps.pptMapChannel;
    if (!this.defaultChannel) {
      const models = [this.lib.config().mapModel].filter(Boolean);
      this.defaultChannel = require('./ppt-map-model').createCodeAgentChannel({ dataDir: this.lib.a.dir, cwdRoot: path.dirname(this.dir), choiceDataDir: this.lib.a.deps?.dataDir, models });
    }
    return this.defaultChannel;
  }

  // ---- 状态（界面每秒轮询一次，只回小数据）
  state() {
    const files = Object.values(this.map.files || {});
    const pages = files.reduce((n, f) => n + (f.pages?.length || 0), 0);
    const count = pred => files.reduce((n, f) => n + (f.pages || []).filter(pred).length, 0);
    const lib = this.lib.status();
    const needsIndex = !this.lib.sources().length;
    return { ok: true, job: { ...this.job, ...(this.job.state === 'running' || this.job.state === 'canceling' ? { elapsedMs: this.now() - this.job.startedAt } : {}) },
      built: !!this.map.updatedAt, updatedAt: this.map.updatedAt || null, files: files.length, pages,
      counts: { model: count(p => p.by === 'model'), rule: count(p => p.by === 'rule'), user: count(p => p.by === 'user'), uncertain: count(p => p.uncertain), needsHuman: count(p => p.needsHuman) },
      channel: this.channelInfo, needsIndex, index: { roots: lib.roots || [], indexing: lib.indexing?.state === 'indexing', message: lib.indexing?.message || '' },
      review: this.review ? { total: this.review.items.length, done: Object.keys(this.review.verdicts || {}).length } : null };
  }

  // ---- 增量分类
  start({ force = false } = {}) {
    if (this.running) return this.state();
    const dir = path.join(require('./ppt-work-dir').workDir(this.lib.a, { writable: true }), 'ppt-map');
    if (dir !== this.dir) {
      this.dir = dir;
      this.store = new M.LabelStore(path.join(dir, 'labels.json'));
      this.map = readJson(this.file('map.json'), null) || { files: {} };
      this.edits = this.normEdits(readJson(this.file('edits.json'), {}));
      this.review = readJson(this.file('review.json'), null);
      this.defaultChannel = null;
      this.reindex();
    }
    if (!this.lib.sources().length) throw new Error('还没有 PPT 文字索引：先在这里点「先建索引」，建好后库地图会自动更新');
    this.abort = new AbortController();
    this.job = { state: 'running', phase: '读取素材目录', startedAt: this.now(), filesTotal: 0, filesTodo: 0, filesDone: 0, pagesDone: 0, modelCalls: 0, modelPages: 0, modelFailedBatches: 0, modelError: '', ruleOnly: false, reason: '', errors: [] };
    this.changed();
    this.running = this.run({ force, signal: this.abort.signal })
      .then(() => { this.job = { ...this.job, state: this.abort.signal.aborted ? 'canceled' : 'done', phase: '', finishedAt: this.now(), elapsedMs: this.now() - this.job.startedAt }; })
      .catch(error => { this.job = { ...this.job, state: 'error', phase: '', error: error.message, finishedAt: this.now(), elapsedMs: this.now() - this.job.startedAt }; })
      .finally(() => { this.running = null; this.abort = null; this.changed(); });
    return this.state();
  }
  cancel() {
    if (!this.running || !this.abort) return this.state();
    this.abort.abort(); this.job = { ...this.job, state: 'canceling', phase: '正在停下（当前这一步做完就停）' }; this.changed();
    return this.state();
  }
  async catalog(signal = null) {
    const items = [], seen = new Set(), errors = [];
    for (const source of this.lib.sources()) {
      try {
        for (let offset = 0, guard = 0; offset != null && guard < 2000 && !signal?.aborted; guard++) {
          const r = await this.lib.execute('catalog', { sourceId: source.id, offset, limit: 100 });
          for (const item of r.items || []) {
            const key = norm(item.path);
            if (!item.path || !(item.page_count > 0) || seen.has(key)) continue;
            seen.add(key); items.push({ ...item, sourceId: item.sourceId || source.id });
          }
          offset = r.has_more ? (r.next_offset ?? offset + (r.items || []).length) : null;
        }
      } catch (error) { errors.push(`${source.label}：${error.message}`); }
    }
    return { items, errors };
  }
  async run({ force, signal }) {
    const { items, errors } = await this.catalog(signal);
    if (signal.aborted) return;
    if (!items.length && errors.length) throw new Error('读不到素材目录：' + errors.join('；'));
    this.job.errors = errors;
    this.job.phase = '检查 CodeAgent';
    let probe;
    try { probe = await this.channel().probe({ signal }); } catch (error) { probe = { available: false, reason: 'CodeAgent 检查失败：' + error.message }; }
    if (signal.aborted) return;
    this.channelInfo = { available: !!probe.available, reason: probe.reason || '', model: probe.model || '', checkedAt: this.now() };
    let ruleOnly = !probe.available;
    this.job.ruleOnly = ruleOnly; this.job.reason = probe.reason || '';
    if (force) { this.store.data.files = {}; this.store.data.pending = {}; }
    // r28g2：完成记录要和 map.json 里的结果对得上才算数（两份文件写盘中途断了、或上次只读到部分页时会对不上），对不上的重做
    for (const item of items) if (this.store.data.files[item.path] && !this.complete(item)) delete this.store.data.files[item.path];
    const plan = M.planFiles(items, this.store, M.DEFAULT_TAXONOMY, { ruleOnly });
    // 库里已删掉的文件：从结果和完成记录里去掉（读目录有来源出错时不删，免得误删）
    if (!errors.length) {
      const live = new Set(items.map(i => i.path));
      for (const p of Object.keys(this.map.files)) if (!live.has(p)) delete this.map.files[p];
      for (const p of Object.keys(this.store.data.files)) if (!live.has(p)) delete this.store.data.files[p];
      for (const p of Object.keys(this.store.data.pending)) if (!live.has(p)) delete this.store.data.pending[p];
    }
    Object.assign(this.job, { filesTotal: items.length, filesTodo: plan.toRead.length, filesUnchanged: plan.unchanged.length, phase: plan.toRead.length ? '读页并分类' : '没有新增或改动的文件' });
    this.changed();
    let budget = Number(this.lib.config().mapMaxModelPages) || 2000;
    const runModel = async (prompt, opts) => {
      try { return await this.channel().run(prompt, opts); }
      catch (error) {
        if (error.channelDown && !ruleOnly) { ruleOnly = true; this.job.ruleOnly = true; this.job.reason = error.message; this.channelInfo = { ...this.channelInfo, available: false, reason: error.message }; }
        throw error;
      }
    };
    for (let i = 0; i < plan.toRead.length && !signal.aborted;) {
      const group = [];
      let pages = 0;
      while (i < plan.toRead.length && (pages < GROUP_PAGES || !group.length) && !signal.aborted) {
        const item = plan.toRead[i++];
        this.job.current = item.name;
        try { const read = await M.readFilePages(this.lib, item, { signal }); group.push({ item, missing: read.missing || [], pages: read.map(p => ({ ...p, fileId: item.file_id, sourceId: item.sourceId })) }); pages += read.length; }
        catch (error) { if (error.aborted) break; this.job.errors.push(`${item.name}：${error.message}`); }
      }
      if (!group.length) continue;
      const all = group.flatMap(g => g.pages);
      const result = await M.buildMap({ pages: all, store: this.store, runModel: ruleOnly ? null : runModel, ruleOnly, signal, maxModelPages: Math.max(0, budget),
        onProgress: ({ done }) => { this.job.batchPagesDone = done; } });
      budget -= result.stats.modelUniquePages;
      this.job.modelCalls += result.stats.modelCalls; this.job.modelPages += result.stats.modelPages; this.job.modelBatches = (this.job.modelBatches || 0) + result.stats.modelBatches;
      // 有页没读到的稿：读到的页照常显示，但不记完成，没读到的页码记进待重试，下次更新再读
      for (const g of group) if (g.missing.length) {
        delete this.store.data.files[g.item.path];
        this.store.data.pending[g.item.path] = { fileKey: M.fileKey(g.item), pages: g.missing };
        this.job.errors.push(`${g.item.name}：有 ${g.missing.length} 页没读到（第 ${g.missing.slice(0, 5).map(m => m.page).join('、')}${g.missing.length > 5 ? ' 等' : ''} 页），下次更新再试`);
      }
      // 单批失败（如超时）：这些页先按规则放着、下次更新自动重送；状态行要说出来，不能只显示「用模型 N 次」
      const batchErrors = result.stats.modelErrors;
      if (batchErrors.length) { this.job.modelFailedBatches += batchErrors.length; this.job.modelError = batchErrors[batchErrors.length - 1]; }
      this.merge(group, result);
      this.job.filesDone += group.length; this.job.pagesDone += all.length;
      // 先写结果 map.json、再写完成记录 labels.json：中途断了只会多重做，不会有「记了完成却没结果」
      this.save(); this.store.save();
    }
    this.job.current = '';
    this.map.updatedAt = this.now();
    this.save();
  }
  merge(group, result) {
    const byId = new Map(result.pages.map(p => [p.id, p]));
    const decks = new Map(result.decks.map(d => [d.path, d]));
    for (const { item, pages } of group) {
      const deck = decks.get(item.path) || { deckType: M.OTHER, topics: [], primaryTopic: '' };
      this.map.files[item.path] = { path: item.path, name: item.name, sourceId: item.sourceId, fileId: item.file_id, pageCount: item.page_count, indexedAt: item.indexed_at ?? null,
        deckType: deck.deckType, topics: deck.topics, primaryTopic: deck.primaryTopic || '',
        pages: pages.map(p => { const r = byId.get(p.id) || {}; return { id: p.id, page: p.page, title: r.title || '', pageType: r.pageType || M.OTHER, topics: r.topics || [], by: r.by || 'rule',
          ...(r.uncertain ? { uncertain: true } : {}), ...(r.needsHuman ? { needsHuman: true } : {}), ...(r.retry ? { retry: true } : {}), ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}), ...(r.sourceState ? { sourceState: r.sourceState } : {}) }; }) };
    }
    this.reindex();
  }
  save() { writeJson(this.file('map.json'), this.map); }
  // 这份稿在 map.json 里的结果是否完整、且对应当前索引版本（页数、索引时间都对得上，每页都有结果）
  complete(item) {
    const f = this.map.files?.[item.path];
    return !!f && f.pageCount === item.page_count && (f.indexedAt ?? null) === (item.indexed_at ?? null) && (f.pages || []).length === item.page_count;
  }

  // ---- 树：主题 → 材料类型 → 文件；或 页面类型 → 文件。名字按用户改名显示，拖动过的文件按用户放的位置。
  label(dim, key) { return this.edits.renames[dim][key] || key || UNSORTED; }
  placeOf(f) { const m = this.edits.moves[f.path] || {}; return { topic: m.topic ?? f.primaryTopic ?? '', deckType: m.deckType ?? f.deckType ?? M.OTHER, moved: !!this.edits.moves[f.path] }; }
  options() {
    const T = M.DEFAULT_TAXONOMY;
    const opt = (dim, keys) => keys.map(key => ({ key, label: this.label(dim, key) }));
    return { topic: opt('topic', [...T.topics.map(c => c.label), '']), deckType: opt('deckType', [...T.deckTypes.map(c => c.label), M.OTHER]),
      pageType: opt('pageType', [...T.pageTypes.map(c => c.label), M.OTHER, M.PENDING, M.COVER]) };
  }
  // 挂树和取页用同一个归类：体系里没有的页面类型都算「其他」（r28g2：免得树上有数、点进去取不出页）
  typeKey(p) { return PAGE_TYPE_KEYS.has(p.pageType) ? p.pageType : M.OTHER; }
  tree({ group = 'topic' } = {}) {
    const files = Object.values(this.map.files || {}).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const fileNode = (f, id, pages) => ({ id, kind: 'file', path: f.path, label: f.name, pages, uncertain: (f.pages || []).filter(p => p.uncertain || p.needsHuman).length, moved: !!this.edits.moves[f.path], deckType: this.placeOf(f).deckType });
    const options = this.options();
    if (group === 'pageType') {
      const nodes = options.pageType.map(o => ({ id: 'p:' + o.key, kind: 'pageType', key: o.key, label: o.label, children: [], pages: 0 }));
      const byKey = new Map(nodes.map(n => [n.key, n]));
      for (const f of files) {
        const counts = new Map();
        for (const p of f.pages || []) { const k = this.typeKey(p); counts.set(k, (counts.get(k) || 0) + 1); }
        for (const [type, n] of counts) {
          const node = byKey.get(type);
          node.children.push(fileNode(f, `p:${node.key}|f:${f.path}`, n)); node.pages += n;
        }
      }
      return { ok: true, group, options, nodes: nodes.filter(n => n.children.length), updatedAt: this.map.updatedAt || null };
    }
    const topics = new Map(options.topic.map(o => [o.key, { id: 't:' + o.key, kind: 'topic', key: o.key, label: o.label, children: new Map(), pages: 0, files: 0 }]));
    for (const f of files) {
      const place = this.placeOf(f), topic = topics.get(place.topic) || topics.get('');
      const dkey = place.deckType;
      if (!topic.children.has(dkey)) topic.children.set(dkey, { id: `t:${topic.key}|d:${dkey}`, kind: 'deckType', topic: topic.key, key: dkey, label: this.label('deckType', dkey), children: [], pages: 0 });
      const d = topic.children.get(dkey), n = (f.pages || []).length;
      d.children.push(fileNode(f, 'f:' + f.path, n)); d.pages += n; topic.pages += n; topic.files++;
    }
    const nodes = [...topics.values()].filter(t => t.files).sort((a, b) => (a.key === '') - (b.key === '') || b.files - a.files)
      .map(t => ({ ...t, children: [...t.children.values()].sort((a, b) => b.children.length - a.children.length) }));
    return { ok: true, group, options, nodes, updatedAt: this.map.updatedAt || null };
  }
  // 选中节点的页（翻页取）。汇总节点（主题、材料类型、页面类型）不列封面目录页；单个文件列全部页。
  pages({ node = '', offset = 0, limit = 24, deckType = '' } = {}) {
    const files = Object.values(this.map.files || {}).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    let list = [];
    const take = (f, pred) => { for (const p of f.pages || []) if (pred(p)) list.push(this.pageView(f, p)); };
    const m = String(node).match(/^(t|p|f):(.*?)(?:\|(d|f):(.*))?$/s);
    if (!m) throw new Error('没有这个节点');
    const [, kind, key, subKind, sub] = m;
    const deckOk = f => !deckType || this.placeOf(f).deckType === deckType;
    if (kind === 'f') { const f = this.map.files[key]; if (f) take(f, () => true); }
    else if (kind === 'p') { for (const f of files) if ((subKind !== 'f' || f.path === sub) && (subKind === 'f' || deckOk(f))) take(f, p => this.typeKey(p) === key); }
    else for (const f of files) {
      const place = this.placeOf(f);
      if (place.topic !== key && !(key === '' && !this.options().topic.some(o => o.key === place.topic))) continue;
      if (subKind === 'd' ? place.deckType !== sub : !deckOk(f)) continue;
      take(f, p => p.pageType !== M.COVER);
    }
    const start = Math.max(0, Number(offset) || 0), size = Math.min(200, Math.max(1, Number(limit) || 24));
    return { ok: true, total: list.length, offset: start, items: list.slice(start, start + size) };
  }
  pageView(f, p) {
    return { id: p.id, path: f.path, name: f.name, page: p.page, title: p.title, pageType: p.pageType, pageTypeLabel: this.label('pageType', p.pageType), topics: p.topics,
      topicLabels: (p.topics || []).map(t => this.label('topic', t)), by: p.by, ...(p.uncertain ? { uncertain: true } : {}), ...(p.needsHuman ? { needsHuman: true } : {}),
      ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}), deckType: this.label('deckType', this.placeOf(f).deckType) };
  }
  // 预览：只画库地图里有的页（不接受界面传来的任意路径）
  async preview(id) {
    const ref = this.pageIndex.get(String(id || ''));
    if (!ref) throw Object.assign(new Error('这页不在库地图里，请更新库地图'), { code: 'UNKNOWN_PAGE' });
    return { ok: true, id: String(id), scene: await this.lib.previewScene(ref.path, ref.page) };
  }

  // ---- 用户改名、拖动（单独存，增量分类不覆盖）
  rename({ dim, key, to } = {}) {
    if (!DIMS.includes(dim)) throw new Error('只能改主题、材料类型或页面类型的名字');
    const keys = this.options()[dim].map(o => o.key);
    if (!keys.includes(key)) throw new Error('没有这个节点');
    const name = String(to ?? '').trim();
    if (name.length > 30) throw new Error('名字最多 30 个字');
    if (name && this.options()[dim].some(o => o.key !== key && o.label === name)) throw new Error(`已经有叫「${name}」的节点了`);
    if (!name || name === key) delete this.edits.renames[dim][key]; else this.edits.renames[dim][key] = name;
    this.saveEdits();
    return { ok: true };
  }
  move({ path: file, topic, deckType } = {}) {
    const f = this.map.files[file];
    if (!f) throw new Error('库地图里没有这个文件，请更新库地图');
    const o = this.options(), { at: _at, ...patch } = this.edits.moves[file] || {};
    if (topic !== undefined && topic !== null) { if (!o.topic.some(x => x.key === topic)) throw new Error('没有这个主题'); patch.topic = topic; }
    if (deckType !== undefined && deckType !== null) { if (!o.deckType.some(x => x.key === deckType)) throw new Error('没有这个材料类型'); patch.deckType = deckType; }
    // 本次明确改的那一维，拖回系统原本判的位置（或传 null）＝恢复自动；没改的那一维原样保留（r28g2：改材料类型不能清掉主题锁）
    if (topic !== undefined && (topic === null || topic === (f.primaryTopic || ''))) delete patch.topic;
    if (deckType !== undefined && (deckType === null || deckType === f.deckType)) delete patch.deckType;
    if (Object.keys(patch).length) this.edits.moves[file] = { ...patch, at: this.now() }; else delete this.edits.moves[file];
    this.saveEdits();
    return { ok: true, place: this.placeOf(f) };
  }
  saveEdits() { writeJson(this.file('edits.json'), this.edits); this.changed(); }

  // ---- 抽查：按「来源 × 页面类型」分层抽 n 页（封面目录不抽），逐页判对错，算「N 个里几个对」
  startReview({ n = 50 } = {}) {
    const all = [];
    for (const f of Object.values(this.map.files || {})) for (const p of f.pages || []) all.push({ ...p, path: f.path, name: f.name });
    const seed = this.now() % 2147483647;
    const picked = M.sampleForReview(all, Math.max(1, Math.min(200, Number(n) || 50)), seed);
    if (!picked.length) throw new Error('库地图里还没有可抽查的页，先更新库地图');
    this.review = { seed, createdAt: this.now(), items: picked.map(p => ({ id: p.id, path: p.path, name: p.name, page: p.page, title: p.title, pageType: p.pageType, topics: p.topics, by: p.by })), verdicts: {} };
    writeJson(this.file('review.json'), this.review);
    return this.reviewState();
  }
  verdict({ id, pageType, topics } = {}) {
    if (!this.review) throw new Error('还没有开始抽查');
    if (!this.review.items.some(i => i.id === id)) throw new Error('这页不在本轮抽查里');
    const ok = v => v === undefined || ['right', 'wrong', 'skip'].includes(v);
    if (!ok(pageType) || !ok(topics)) throw new Error('只能标对、错或跳过');
    const v = { ...(this.review.verdicts[id] || {}) };
    if (pageType !== undefined) v.pageType = pageType;
    if (topics !== undefined) v.topics = topics;
    this.review.verdicts[id] = v;
    writeJson(this.file('review.json'), this.review);
    return this.reviewState();
  }
  reviewState() {
    if (!this.review) return { ok: true, review: null };
    const rows = [];
    for (const item of this.review.items) {
      const v = this.review.verdicts[item.id] || {};
      if (v.pageType) rows.push({ by: item.by, dimension: 'pageType', verdict: v.pageType });
      if (v.topics) rows.push({ by: item.by, dimension: 'topics', verdict: v.topics });
    }
    const items = this.review.items.map(i => ({ ...i, pageTypeLabel: this.label('pageType', i.pageType), topicLabels: (i.topics || []).map(t => this.label('topic', t)), verdict: this.review.verdicts[i.id] || {} }));
    return { ok: true, review: { createdAt: this.review.createdAt, items, scores: M.scoreReview(rows) } };
  }
  close() { this.abort?.abort(); }
}

module.exports = { PptMap, UNSORTED, GROUP_PAGES };
