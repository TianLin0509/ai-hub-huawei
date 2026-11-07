'use strict';
// 外部工具自动发现与多版本选择（2026-11-07，5.5.24「不再莫名报错」第一层：装了的工具自动找到，找到多个版本才让用户选）。
// 每个工具注册一个适配器（core/tool-discovery/tools.js）：list() 给出候选路径，probe() 读版本并判断能不能用，
// getConfigured / setConfigured 读写用户的选择（welink-cli、PPT Doctor 沿用它们原来的设置项；CodeAgent 存在本文件管的 tool-discovery.json）。
// 选择规则见 candidates.choose。扫描结果缓存 10 分钟；扫描在后台跑，同步调用方用 pick() 取上次的结果。
const fs = require('node:fs');
const path = require('node:path');
const { collectCandidates, choose } = require('./candidates');

const SCAN_TTL_MS = 10 * 60 * 1000;

// tool-discovery.json：{ choices: { codeagent: 路径 }, last: { <工具>: 上次自动选中的路径 } }。
// last 让 Hub 重启后、第一次扫描完成前也能直接用上次选中的那份。
function createStore(dataDir) {
  const file = dataDir ? path.join(dataDir, 'tool-discovery.json') : null;
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    if (!data || typeof data !== 'object') data = {};
    data.choices ||= {}; data.last ||= {};
    return data;
  };
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      require('../atomic-write').writeFileAtomic(fs, file, JSON.stringify(load(), null, 2));
    } catch (error) { console.warn('[tool-discovery] 保存选择失败：' + error.message); }
  };
  return {
    choice: id => String(load().choices[id] || ''),
    setChoice(id, value) { const d = load(); if (value) d.choices[id] = value; else delete d.choices[id]; save(); },
    last: id => String(load().last[id] || ''),
    setLast(id, value) { const d = load(); if ((d.last[id] || '') === (value || '')) return; if (value) d.last[id] = value; else delete d.last[id]; save(); },
  };
}

class ToolDiscovery {
  constructor({ dataDir = null, now = Date.now, onChanged = () => {} } = {}) {
    this.store = createStore(dataDir);
    this.now = now;
    this.listeners = new Set([onChanged]);
    this.onChanged = id => { for (const fn of this.listeners) { try { fn(id); } catch { /* 界面没开 */ } } };
    this.adapters = new Map();
    this.state = new Map(); // id → { decision, at, scanning: Promise|null, error }
  }
  register(id, adapter) {
    this.adapters.set(id, adapter);
    // 上次选中的那份还在就先用上（同步调用方马上能拿到），扫描完成后再按规则更新。
    const last = this.store.last(id);
    if (last && adapter.onPick && fs.existsSync(last)) adapter.onPick(last);
    return this;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  has(id) { return this.adapters.has(id); }
  adapter(id) {
    const a = this.adapters.get(id);
    if (!a) throw Object.assign(new Error('这个工具在本机版本里不可用'), { code: 'TOOL_UNKNOWN' });
    return a;
  }
  // 当前选中的路径（同步，不扫描）：这次扫描的结果；还没扫过就用上次记下的。文件已经不在了返回 ''。
  pick(id) {
    const st = this.state.get(id);
    const file = st?.decision?.pick?.path || this.store.last(id);
    return file && fs.existsSync(file) ? file : '';
  }
  // 扫描并按规则选定。force：不用缓存；deep：允许工具做更慢的查找（目前只有 welink-cli 的全盘找）。
  async list(id, { force = false, deep = false } = {}) {
    const adapter = this.adapter(id);
    const st = this.state.get(id) || {};
    if (st.scanning) { await st.scanning; return this.summary(id); }
    const configuredNow = adapter.getConfigured?.() || '';
    const fresh = st.decision && this.now() - st.at < SCAN_TTL_MS && st.configured === configuredNow;
    if (!force && !deep && fresh) return this.summary(id);
    const scanning = (async () => {
      const entries = await adapter.list({ deep });
      const candidates = await collectCandidates(entries, { probe: file => adapter.probe(file) });
      return this.apply(id, candidates);
    })();
    this.state.set(id, { ...st, scanning });
    this.onChanged(id);
    try { await scanning; }
    catch (error) { this.state.set(id, { ...this.state.get(id), error: error.message }); }
    finally { this.state.set(id, { ...this.state.get(id), scanning: null }); this.onChanged(id); }
    return this.summary(id);
  }
  apply(id, candidates) {
    const adapter = this.adapter(id);
    const configured = adapter.getConfigured?.() || '';
    const decision = choose(candidates, configured);
    // 只有 1 个、或多份同版本：自动用，写回设置。用户指定的路径失效且出现多个版本：清掉失效的那条，先用最新的，等用户选。
    if (decision.writeBack && decision.pick && decision.pick.path !== configured) adapter.setConfigured?.(decision.pick.path);
    else if (decision.configuredMissing && !decision.writeBack) adapter.setConfigured?.('');
    const file = decision.pick?.path || '';
    this.store.setLast(id, file);
    adapter.onPick?.(file);
    this.state.set(id, { ...this.state.get(id), decision, at: this.now(), error: null, configured: adapter.getConfigured?.() || '' });
    return decision;
  }
  // 用户在选择器里选了一份：必须是能用的候选（不在扫描结果里的先单独校验一次）。
  async use(id, file) {
    const adapter = this.adapter(id);
    const target = String(file || '').trim();
    if (!target || !path.isAbsolute(target)) throw new Error('请选择一个完整路径');
    let candidates = this.state.get(id)?.decision?.candidates || [];
    const { realKey } = require('./candidates');
    if (!candidates.some(c => realKey(c.path) === realKey(target))) {
      const extra = await collectCandidates([{ path: target, via: 'manual' }], { probe: f => adapter.probe(f) });
      if (!extra.length) throw new Error('这个程序打不开或校验没通过，请换一个');
      candidates = [...candidates, { ...extra[0], order: candidates.length }];
    }
    adapter.setConfigured(target);
    this.apply(id, candidates);
    this.onChanged(id);
    return this.summary(id);
  }
  // 给界面看的摘要（不带内部字段）。needsPick：找到多个不同版本、用户还没选过，页面出「点此切换」的提示。
  summary(id) {
    const adapter = this.adapter(id);
    const st = this.state.get(id) || {};
    const d = st.decision;
    const current = d?.pick || null;
    const recommended = d?.candidates?.[0]?.path || '';
    return {
      ok: true, tool: id, label: adapter.label || id, scanning: !!st.scanning, scannedAt: st.at || null, error: st.error || null,
      reason: d?.reason || null, configuredMissing: !!d?.configuredMissing, versions: d?.versions || 0,
      needsPick: d?.reason === 'newest',
      current: current ? { path: current.path, version: current.version, via: current.via } : null,
      candidates: (d?.candidates || []).map(c => ({ path: c.path, version: c.version, via: c.via, recommended: c.path === recommended, current: c.path === current?.path })),
    };
  }
}

module.exports = { ToolDiscovery, createStore, SCAN_TTL_MS };
