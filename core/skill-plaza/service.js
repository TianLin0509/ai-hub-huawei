'use strict';
// 技能广场服务（2026-11-27）：员工助手 + 本机已装 + AgentCenter 三路汇成一张清单，外加预览、导入、移除、委托。
// 员工助手那一路要递归读写文件，放到 Worker 线程里跑（ops.js / worker.js），主进程不同步阻塞。
// 不联网、不上报；日志只写技能名与结果，不写正文。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const rules = require('./rules');
const source = require('./weclaw-source');
const { OPS } = require('./ops');

const LOCAL_AGENTS = new Set(['claude', 'codex', 'codeagent', 'deepseek', 'deepseek-acp', 'deepseek-claude', 'pi']);
const TARGET_OF_AGENT = agent => (agent === 'claude' ? 'claude' : agent === 'codeagent' ? 'codeagent' : 'agents');
const CACHE_MS = 60 * 1000;
// 读（扫描、预览）超时就停掉 Worker；写（导入、移除）从不强停，只是界面先不等了。
const READ_TIMEOUT_MS = 30000;
const WRITE_UI_WAIT_MS = 120000;
// 导入、移除按数据目录串行：台账是「读→改→写」，并发会丢记录。同一数据目录的多个服务实例也共用一条队列。
const WRITE_QUEUES = new Map();

class SkillPlazaService {
  /**
   * @param {object} o
   * @param {string} o.dataDir Hub 数据目录（台账所在）
   * @param {string} [o.homeDir]
   * @param {() => string|boolean} [o.findInstall] 员工助手安装路径，没装返回空串
   * @param {(refresh:boolean) => Promise<{rows:any[]}>} [o.catalog] 本机已装能力（capability-service）
   * @param {() => void} [o.invalidateCatalog] 导入/移除后清掉本机已装的缓存
   * @param {{status?:Function, list:Function, install:Function}} [o.market] AgentCenter（CodeAgent 本机市场）
   * @param {() => string} [o.codeagentDir] CodeAgent 配置目录
   * @param {(text:string) => void} [o.writeClipboard]
   * @param {(url:string) => Promise<void>} [o.openExternal]
   * @param {() => void} [o.openManage]
   */
  constructor(o) {
    this.dataDir = o.dataDir;
    this.homeDir = o.homeDir || os.homedir();
    this.findInstall = o.findInstall || (() => require('../weclaw-link').findInstall());
    this.catalog = o.catalog || (async () => ({ rows: [] }));
    this.invalidateCatalog = o.invalidateCatalog || (() => {});
    this.market = o.market || null;
    this.codeagentDir = o.codeagentDir || (() => path.join(this.homeDir, '.cac'));
    this.writeClipboard = o.writeClipboard || (() => {});
    this.openExternal = o.openExternal || (async () => { throw new Error('打不开员工助手'); });
    this.openManageImpl = o.openManage || (() => {});
    this.roots = o.roots || null; // 测试用
    this.fs = o.fs || null;       // 测试用：注入 fs 桩做故障注入（会改在本线程跑）
    this.testHooks = null;        // 测试用
    this.inline = o.inline === true;
    this.onChanged = o.onChanged || (() => {});
    this.writeUiWaitMs = o.writeUiWaitMs || WRITE_UI_WAIT_MS;
    this.log = o.log || (msg => console.log('[skill-plaza] ' + msg));
    this.cache = null;
    this.localDirty = false;
    this.generation = 0; // 代次号：每次导入、移除写完就加一（同 capability-service 的 catalogGeneration）
  }

  targets() {
    const h = (...p) => path.join(this.homeDir, ...p);
    const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
    const ca = this.codeagentDir();
    return [
      { id: 'codeagent', label: 'CodeAgent', dir: path.join(ca, 'skills'), present: exists(ca) },
      { id: 'claude', label: 'Claude', dir: h('.claude', 'skills'), present: exists(h('.claude')) },
      { id: 'agents', label: 'Codex · DSH · pi', dir: h('.agents', 'skills'), present: exists(h('.agents')) || exists(h('.codex')) || exists(h('.pi')) },
    ];
  }
  ctx(extra = {}) {
    return { homeDir: this.homeDir, dataDir: this.dataDir, roots: this.roots || source.weclawRoots(this.homeDir), targets: this.targets(), ...extra };
  }

  /** 跑一个重活：正式环境开 Worker；注入了 fs 桩或测试钩子时在本线程跑（函数传不进 Worker）。 */
  run(op, ctx) {
    if (this.inline || this.fs || this.testHooks) {
      return new Promise((resolve, reject) => setImmediate(() => {
        try { resolve(OPS[op](ctx, { fs: this.fs || undefined, hooks: this.testHooks || undefined })); } catch (error) { reject(error); }
      }));
    }
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { op, ctx } });
      let settled = false;
      const done = (error, data) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); error ? reject(error) : resolve(data); };
      // 扫描、预览超时直接停；导入、移除不设超时（停在半路反而留下半截目录），这里的 Promise 只在 Worker 真正结束时才落定。
      const timer = op === 'scan' || op === 'preview' ? setTimeout(() => {
        void worker.terminate();
        done(new Error('读取员工助手技能超时，请刷新重试'));
      }, READ_TIMEOUT_MS) : null;
      timer?.unref?.();
      worker.once('message', r => done(r.ok ? null : Object.assign(new Error(r.error), r.residue ? { residue: r.residue } : {}), r.data));
      worker.once('error', e => done(e));
      worker.once('exit', code => { if (!settled) done(new Error(`技能广场后台任务提前退出（${code}）`)); });
    });
  }

  /**
   * 导入、移除：排进本数据目录的写队列，前一个 Worker 真正结束才开始下一个。
   * 界面最多等 writeUiWaitMs；等不及就先回 { pending:true }（任务照常在后台跑完），
   * 任务真正结束时（不论界面是否还在等）都清缓存并发 skill-plaza:changed 让界面刷新。
   */
  write(op, ctx, label) {
    const key = path.resolve(this.dataDir).toLowerCase();
    const prev = WRITE_QUEUES.get(key) || Promise.resolve();
    const actual = prev.then(() => this.run(op, ctx));
    const settled = actual.then(r => ({ ok: true, r }), error => ({ ok: false, error }));
    const tail = settled.then(({ ok, r, error }) => {
      this.changed();
      try { this.onChanged({ op, id: ctx.id, ok, ...(ok ? {} : { error: error.message }) }); } catch { /* 通知失败不影响结果 */ }
      this.log(`${label}：${ok ? '完成' : '失败'}`);
    });
    WRITE_QUEUES.set(key, tail);
    tail.then(() => { if (WRITE_QUEUES.get(key) === tail) WRITE_QUEUES.delete(key); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ pending: true, installed: [], skipped: [], removed: [],
        message: '仍在后台进行，完成后页面会自动刷新' }), this.writeUiWaitMs);
      timer.unref?.();
      settled.then(({ ok, r, error }) => { clearTimeout(timer); ok ? resolve(r) : reject(error); });
    });
  }
  /** 等本数据目录的写队列全部结束（测试与退出前用）。 */
  whenIdle() { return WRITE_QUEUES.get(path.resolve(this.dataDir).toLowerCase()) || Promise.resolve(); }

  async scanWeclaw() {
    const present = !!this.findInstall();
    if (!present) return { present, roots: [], items: [], ledgerDirs: [] };
    return { present, ...(await this.run('scan', this.ctx())) };
  }

  async scanLocal(refresh, excludeNames) {
    let rows = [];
    try { rows = (await this.catalog(refresh === true))?.rows || []; } catch (error) { this.log('本机已装读取失败：' + error.message); }
    const items = [];
    for (const r of rows) {
      if (r.type !== 'skill' || excludeNames.has(r.name)) continue;
      const sources = (r.sources || []).filter(s => LOCAL_AGENTS.has(s.agent) && !String(s.scope || '').startsWith('project:'));
      if (!sources.length) continue;
      items.push({ id: 'local:' + r.name, source: 'local', name: r.name, displayName: r.displayName || r.name,
        description: String(r.summary || r.description || ''), category: rules.classifyCategory(r.name, r.description),
        use: 'installed', companyOnly: false, deps: [], installedIn: [...new Set(sources.map(s => TARGET_OF_AGENT(s.agent)))],
        path: sources[0].path ? path.dirname(sources[0].path) : undefined });
    }
    return items;
  }

  marketAvailable() {
    if (!this.market) return false;
    try { return typeof this.market.status === 'function' ? this.market.status()?.available === true : true; } catch { return false; }
  }
  async scanMarket() {
    if (!this.marketAvailable()) return { present: false, items: [], reason: '这台电脑没装 CodeAgent，AgentCenter 的技能暂时用不了' };
    let res;
    try { res = await this.market.list(); } catch (error) { return { present: false, items: [], reason: error.message }; }
    if (!res?.available) return { present: false, items: [], reason: res?.reason || '这台电脑没装 CodeAgent，AgentCenter 的技能暂时用不了' };
    const items = (res.rows || []).filter(r => r.type === 'skill').map(r => ({
      id: 'agentcenter:' + r.id, source: 'agentcenter', name: r.name, displayName: r.name, description: r.description || '',
      category: rules.classifyCategory(r.name, r.description), use: r.installed ? 'installed' : 'ok', companyOnly: false, deps: [],
      installedIn: r.installed ? ['codeagent'] : [], version: r.version || undefined, marketId: r.id }));
    return { present: true, items, reason: res.reason || '' };
  }

  async refresh(refresh = false, attempt = 0) {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const generation = this.generation;
    const weclaw = await this.scanWeclaw();
    // 本模块导入的目录会出现在本机已装里，避免同一个技能显示两遍。
    const ours = new Set(weclaw.ledgerDirs || []);
    // 刚导入或移除过：本机已装那一路也要重扫，不用能力目录的旧缓存（否则已删的技能会以「本机·已装」冒出来）。
    const localRefresh = refresh || this.localDirty;
    const [local, market] = await Promise.all([this.scanLocal(localRefresh, ours), this.scanMarket()]);
    const result = { at: Date.now(), weclaw, local, market, byId: new Map([...weclaw.items, ...local, ...market.items].map(i => [i.id, i])) };
    // 扫描期间有导入或移除写完：这次结果可能是写之前的，丢弃——不回写缓存、不清脏标记，按新状态重扫（最多 3 次，之后只返回不缓存）。
    if (generation !== this.generation) return attempt < 3 ? this.refresh(true, attempt + 1) : result;
    this.localDirty = false;
    this.cache = result;
    return this.cache;
  }
  changed() { this.generation++; this.cache = null; this.localDirty = true; try { this.invalidateCatalog(); } catch { /* 清缓存失败下次照样重扫 */ } }

  async list({ refresh } = {}) {
    const c = await this.refresh(refresh === true);
    return {
      items: [...c.weclaw.items, ...c.market.items, ...c.local],
      sources: { weclaw: { present: c.weclaw.present, roots: c.weclaw.roots, count: c.weclaw.items.length },
        local: { count: c.local.length },
        agentcenter: { present: c.market.present, count: c.market.items.length, ...(c.market.present ? {} : { reason: c.market.reason }) } },
      targets: this.targets(), scannedAt: c.at,
    };
  }

  async find(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('请选择一个技能');
    const item = (await this.refresh(false)).byId.get(id);
    if (!item) throw new Error('找不到这个技能，请刷新后重试');
    return item;
  }

  async preview({ id } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('请选择一个技能');
    if (!id.startsWith(source.ID_PREFIX)) throw new Error('只有员工助手的技能需要预览改写');
    if (!this.findInstall()) throw new Error('这台电脑上没找到员工助手');
    return this.run('preview', this.ctx({ id }));
  }

  async import({ id, targets, acknowledgeRewrite } = {}) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('请选择一个技能');
    if (id.startsWith('local:')) throw new Error('这个技能已经装在本机，到「资源 → 工具」里管理');
    if (id.startsWith('agentcenter:')) {
      if (!this.marketAvailable()) throw new Error('这台电脑没装 CodeAgent（或当前版本不支持 AgentCenter），装好 CodeAgent 后点刷新再试');
      const item = await this.find(id);
      const r = await this.market.install(item.marketId);
      this.changed();
      this.log(`AgentCenter 安装 ${item.name}：${r?.installed ? '成功' : '未确认'}`);
      return { installed: r?.installed ? [{ target: 'codeagent', dir: '' }] : [], skipped: r?.installed ? [] : [{ target: 'codeagent', reason: r?.message || 'CodeAgent 未确认安装' }], message: r?.message || '' };
    }
    if (!id.startsWith(source.ID_PREFIX)) throw new Error('找不到这个技能，请刷新后重试');
    if (!this.findInstall()) throw new Error('这台电脑上没找到员工助手');
    const all = this.targets();
    const wanted = Array.isArray(targets) ? [...new Set(targets)] : [];
    if (!wanted.length) throw new Error('请至少选一个安装位置');
    const chosen = [], skipped = [];
    for (const t of wanted) {
      const target = all.find(x => x.id === t);
      if (!target) throw new Error('安装位置无效');
      if (!target.present) skipped.push({ target: t, reason: `本机没有检测到 ${target.label}` });
      else chosen.push(target);
    }
    const res = await this.write('import', this.ctx({ id, chosen, skipped, acknowledgeRewrite: acknowledgeRewrite === true }), `导入 ${id.slice(source.ID_PREFIX.length)}`);
    const { name, ...data } = res;
    return data;
  }

  async remove({ id } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('请选择一个技能');
    if (!id.startsWith(source.ID_PREFIX)) throw new Error('只能移除从员工助手导入的技能；其他技能到「资源 → 工具」里管理');
    return this.write('remove', this.ctx({ id }), `移除 ${id.slice(source.ID_PREFIX.length)}`);
  }

  async delegate({ id } = {}) {
    const item = await this.find(id);
    if (item.source !== 'weclaw') throw new Error('只有员工助手的技能能交给员工助手执行');
    const prompt = `请使用技能「${item.displayName}」（${item.name}）帮我完成：\n（在这里写你要办的事，比如时间、对象、要交付什么）`;
    this.writeClipboard(prompt);
    let opened = false;
    try { await this.openExternal('weclaw://home/chat'); opened = true; } catch { opened = false; }
    this.log(`委托 ${item.name}：${opened ? '已打开员工助手' : '员工助手没打开'}`);
    return { prompt, opened };
  }

  openManage() { this.openManageImpl(); return { opened: true }; }
}

module.exports = { SkillPlazaService, LOCAL_AGENTS };
