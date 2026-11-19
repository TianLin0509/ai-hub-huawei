'use strict';
// 「分身」Beta 服务（2026-11-19 起成员版、公开版都带）。接替原来的「替身」页，原替身的名单、职级和人设继续沿用。
//   读消息：助理的消息快照 + 对「指定群或人」每 30 秒增量读取，全部走 Hub 同一个 WeLink 限流队列。
//   分诊：程序决定一条消息归哪个分身、最多做到哪一步（fleet-rules.js）。
//   思考：每个分身一个常驻 CodeAgent 会话，只产出判断和草稿（agent-session.js）。
//   发送：这一版只有本人在页面上点「发送」这一条路，收信方取自事项记录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./fleet-rules');
const R = require('./rules');
const { AvatarService } = require('./service');
const { AgentSessions, IDLE_MS } = require('./agent-session');
const welink = require('../company-assistant/welink');
const D = require('../company-assistant/data');
const { WELINK_RATE_LIMITED } = require('../company-assistant/welink-gate');

const TICK_MS = 30000, BATCH = 5, LOOKBACK_MS = 2 * 3600000, HOT_PER_TICK = 6, MAX_PARALLEL = 2, DAILY_ITEMS = 150, KEEP_LOG = 200, KEEP_LIVE = 200, HISTORY_DAYS = 90, MEMORY_TTL_MS = 86400000;
const OPEN = new Set(['new', 'drafting', 'ready', 'remind']), INBOX = new Set(['ready', 'remind']);
const TEXT_FILE = /\.(?:md|txt|csv|json|log)$/i;
const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const sleepTurn = () => new Promise(resolve => setImmediate(resolve));

class FleetService {
  constructor(deps) {
    this.d = deps; this.now = deps.now || (() => Date.now());
    this.legacy = new AvatarService({ dataDir: deps.dataDir, getAssistant: deps.getAssistant, runAi: deps.runAi, now: this.now, noTimer: true });
    this.sessions = new AgentSessions({ createSession: deps.createSession, sendPrompt: deps.sendPrompt, lastFinal: deps.lastFinal, getSession: deps.getSession, closeSession: deps.closeSession, pollMs: deps.pollMs, now: this.now, pickAccount: model => this.pickAccount(model) });
    this.timer = null; this.ticking = false; this.running = new Set(); this.sending = new Set(); this.live = new Map(); this.hotAt = 0; this.prep = null; this.readError = ''; this.lastError = ''; this.recovered = new Set();
  }
  assistant() { return this.legacy.assistant(); }
  owner() { return this.legacy.owner(); }
  need() { const o = this.owner(); if (!o) throw new Error('还没确认 WeLink 登录，请先在助理页登录'); return o; }
  changed() { try { this.d.onChanged?.(); } catch { /* 页面没开 */ } }
  start() { if (this.d.noTimer || this.timer) return; this.timer = setInterval(() => { void this.tick().catch(e => { this.lastError = e.message; }); }, TICK_MS); this.timer.unref?.(); }
  close() { clearInterval(this.timer); this.timer = null; }
  pickAccount(model) {
    const rows = this.backends().rows.filter(r => r.pool && r.usable && (!model || r.models.some(m => m.toLowerCase() === model.toLowerCase())));
    return rows.sort((a, b) => (a.activeSessions || 0) - (b.activeSessions || 0))[0]?.id || '';
  }
  backends() { try { return this.d.listBackends?.() || { rows: [] }; } catch { return { rows: [] }; } }

  // ---- 存储 ----
  home(owner, id) { return path.dirname(this.legacy.file(owner, path.join('agents', id, 'x'))); }
  work(owner, id) { const dir = path.join(this.home(owner, id), 'work'); fs.mkdirSync(dir, { recursive: true }); return dir; }
  fleet(owner) {
    const saved = this.legacy.read(owner, 'fleet.json', null);
    return saved ? { version: 1, paused: false, avatars: [], ...saved } : this.migrate(owner);
  }
  saveFleet(owner, fleet) { this.legacy.write(owner, 'fleet.json', fleet); }
  state(owner, id) { return { cursor: {}, items: {}, log: [], stats: {}, session: null, memoryAt: 0, memoryLines: 0, ...this.legacy.read(owner, path.join('agents', id, 'state.json'), {}) }; }
  saveState(owner, id, st) { this.legacy.write(owner, path.join('agents', id, 'state.json'), st); }
  // 读最新、改、写回都在同一拍里完成：跨 await 不能拿着旧的整份数据写回，否则会盖掉期间别的操作。
  mutate(owner, id, fn) { const st = this.state(owner, id), out = fn(st); this.saveState(owner, id, st); return out; }
  mutateFleet(owner, fn) { const fleet = this.fleet(owner), out = fn(fleet); this.saveFleet(owner, fleet); return out; }
  exists(owner, id) { return this.fleet(owner).avatars.some(v => v.id === id); }
  // 用过替身的人：人设、暂停状态和未处理完的事项搬进一个「帮我起草回复」分身。原文件不动。
  migrate(owner) {
    const old = this.legacy.settings(owner), fleet = { version: 1, paused: !!(old.enabled && old.paused), avatars: [] };
    if (old.enabled) {
      const av = F.newAvatar({ id: this.newId(), tpl: 'draft', now: this.now(), persona: old.prompts.persona || '', prefix: this.defaultPrefix() }, { notes: old.prompts.scene || '' });
      fleet.avatars.push(av);
      const st = this.state(owner, av.id), legacy = this.legacy.state(owner);
      for (const item of Object.values(legacy.items)) {
        const base = { ...item, action: 'draft', atMe: !!item.group || !!item.atMe };
        if (['ready', 'remind'].includes(item.state)) st.items[item.id] = { ...base, level: item.state === 'ready' ? 3 : 2, why: item.need || '从替身搬来的待处理事项' };
        else if (['new', 'drafting'].includes(item.state)) st.items[item.id] = { ...base, state: 'new', level: 3, tries: 0 };
      }
      this.saveState(owner, av.id, st);
    }
    this.saveFleet(owner, fleet);
    return fleet;
  }
  newId() { return 'v' + crypto.randomBytes(5).toString('hex'); }
  myName() { try { return this.assistant()?.settings?.().myName || ''; } catch { return ''; } }
  defaultPrefix() { const n = this.myName(); return F.prefixOf(n ? `${n}的数字分身` : '我的数字分身'); }
  today() { return D.dayKey(this.now()); }
  count(st, key, n = 1) { const day = this.today(); if (st.stats.day !== day) st.stats = { day, read: 0, model: 0, ready: 0, remind: 0, sent: 0 }; st.stats[key] = (st.stats[key] || 0) + n; }
  note(st, item, act, result, why = '') {
    st.log.unshift({ at: this.now(), itemId: item.id, where: item.group ? item.convName : '私聊', who: item.who, text: short(item.text, 120), act, confidence: item.confidence || 0, result, why: short(why, 160) });
    st.log.length = Math.min(st.log.length, KEEP_LOG);
  }

  // ---- 读消息 ----
  snapshot() { try { return this.assistant()?.snapshot?.() || null; } catch { return null; } }
  conversationsOf(snap, fleet) {
    const map = new Map((snap?.conversations || []).map(c => [c.id, c]));
    for (const av of fleet.avatars) for (const t of av.targets || []) if (!map.has(t.id)) map.set(t.id, { id: t.id, name: t.name, group: t.type === 'group' });
    return [...map.values()];
  }
  merge(id, list) {
    const known = this.live.get(id) || new Map();
    for (const m of list || []) known.set(m.key, m);
    const rows = [...known.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-KEEP_LIVE);
    this.live.set(id, new Map(rows.map(m => [m.key, m])));
    return rows;
  }
  messages(id) { return [...(this.live.get(id)?.values() || [])]; }
  // 指定的群和人轮流增量读，每轮最多 6 个；被限流就停在这一轮。
  async readHot(owner, fleet, convs) {
    const a = this.assistant(), hot = [...new Set(fleet.avatars.filter(v => v.enabled && v.kind === 'pick').flatMap(v => v.targets.filter(t => t.action !== 'watch').map(t => t.id)))];
    this.readError = '';
    if (!hot.length) return;
    const names = D.namesOf(convs), count = Math.min(hot.length, HOT_PER_TICK);
    for (let i = 0; i < count; i += 1) {
      const id = hot[(this.hotAt + i) % hot.length], conv = convs.find(c => c.id === id); if (!conv) continue;
      const newest = this.messages(id).at(-1)?.key;
      const args = ['im', 'query-history-message', conv.group ? '--group-id' : '--user-account', id, '--query-count', '50', ...(newest ? ['--message-id', newest, '--query-direction', '1'] : [])];
      try {
        const r = await a.welink(args, { priority: 'background', timeoutMs: 20000 }), raw = welink.parseJson(r.stdout);
        if (r.code !== 0 || !raw) { this.readError = welink.friendlyError(r.stderr || r.stdout || '读取消息失败'); continue; }
        this.merge(id, D.messages(raw, conv, owner, { myName: this.myName(), names }));
      } catch (e) { this.readError = e.code === WELINK_RATE_LIMITED ? 'WeLink 限流，稍后自动继续' : e.message; if (e.code === WELINK_RATE_LIMITED) break; }
    }
    this.hotAt = (this.hotAt + count) % hot.length;
  }

  // ---- 每轮 ----
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      const owner = this.owner(); if (!owner) return;
      let fleet = this.fleet(owner); if (!fleet.avatars.length) return;
      await this.closeIdle(owner, fleet);
      fleet = this.fleet(owner); if (fleet.paused) return;
      const snap = this.snapshot();
      for (const [id, list] of Object.entries(snap?.messages || {})) this.merge(id, list);
      await this.readHot(owner, fleet, this.conversationsOf(snap, fleet));
      fleet = this.fleet(owner); if (fleet.paused) return; // 读消息期间可能暂停或改了配置
      const roster = this.legacy.roster(owner), convs = this.conversationsOf(snap, fleet);
      for (const av of fleet.avatars.filter(v => v.enabled)) { this.recover(owner, av.id); this.absorb(owner, fleet, av, convs, roster); }
      this.pump(owner, fleet);
      const accounts = fleet.avatars.flatMap(v => Object.values(this.state(owner, v.id).items).filter(i => OPEN.has(i.state)).map(i => i.account));
      void this.legacy.lookupTitles(owner, accounts).then(found => { if (found) this.changed(); }).catch(() => {});
      this.changed();
    } finally { this.ticking = false; }
  }
  // Hub 重启前没处理完的事项重新排队。
  recover(owner, id) {
    if (this.recovered.has(id)) return; this.recovered.add(id);
    if (!this.running.has(id)) this.mutate(owner, id, st => { for (const item of Object.values(st.items)) if (item.state === 'drafting') item.state = 'new'; });
  }
  pump(owner, fleet) {
    if (fleet.paused) return;
    for (const av of fleet.avatars) {
      if (this.running.size >= MAX_PARALLEL) break;
      if (av.enabled && !this.running.has(av.id) && Object.values(this.state(owner, av.id).items).some(i => i.state === 'new')) void this.runAvatar(owner, av.id);
    }
  }
  // 范围变了：还没处理完的事项交给现在负责的分身，一条消息只留一份。
  reassign(owner, fleet, av, st) {
    let dirty = false;
    for (const item of Object.values(st.items)) {
      if (!['new', 'ready', 'remind'].includes(item.state) || this.sending.has(item.id)) continue; // 正在发送的不转
      const route = F.routeMessage(fleet.avatars, { conv: item.conv, group: !!item.group, account: item.account, atMe: !!item.atMe });
      if (route?.avatar.id === av.id) continue;
      if (route && route.action !== 'watch') {
        this.mutate(owner, route.avatar.id, other => {
          const have = other.items[item.id];
          if (have && have.state !== 'moved') return; // 对方已有这条（待办或已处理完），不重复
          const level = Math.min(item.level || 3, F.LEVEL[route.action]), downgrade = item.state === 'ready' && level < 3;
          other.items[item.id] = { ...item, action: route.action, level, ...(downgrade ? { state: 'remind', draft: '', why: '现在由只提醒的分身负责，请你看一下' } : {}) };
        });
        item.state = 'moved'; this.note(st, item, 'moved', `转给「${route.avatar.name}」`);
      } else { item.state = 'moved'; this.note(st, item, 'moved', '已不在生效范围'); }
      dirty = true;
    }
    return dirty;
  }
  absorb(owner, fleet, av, convs, roster) {
    const st = this.state(owner, av.id); let dirty = this.reassign(owner, fleet, av, st);
    for (const conv of convs) {
      const list = this.messages(conv.id); if (!list.length) continue;
      const cursor = st.cursor[conv.id] ?? (av.createdAt - LOOKBACK_MS), fresh = list.filter(m => (m.at || 0) > cursor);
      for (const item of Object.values(st.items)) {
        if (item.conv !== conv.id || !OPEN.has(item.state)) continue;
        const done = F.answeredAfter(list, item, av);
        if (done) { item.state = 'answered'; this.note(st, item, 'answered', done.by === 'me' ? '你已回复' : `${done.by} 已回答`); dirty = true; }
      }
      if (!fresh.length) continue;
      const mine = fresh.filter(m => !m.mine && F.routeMessage(fleet.avatars, { ...m, conv: conv.id, group: !!conv.group })?.avatar.id === av.id).length;
      if (mine) this.count(st, 'read', mine);
      // 同一件事全局只留一份：发送中的先不动（游标不前进，下一轮再看）；别的分身手上的，把新消息并到那一份，归属由 reassign 转交。
      let hold = false;
      for (const c of F.candidates(av, fleet.avatars, conv, list, fresh)) {
        if (this.sending.has(c.id)) { hold = true; continue; }
        const holder = fleet.avatars.filter(v => v.id !== av.id).map(v => ({ id: v.id, item: this.state(owner, v.id).items[c.id] })).find(x => x.item && x.item.state !== 'moved');
        if (!holder) { this.upsert(st, c, roster); continue; }
        if (OPEN.has(holder.item.state)) { this.mutate(owner, holder.id, other => this.upsert(other, c, roster)); continue; }
        const covered = holder.item.lastKey === c.lastKey || holder.item.state === 'sent' && (holder.item.sentAt || 0) >= (c.at || 0);
        if (!covered) this.upsert(st, c, roster);
      }
      if (hold) continue;
      st.cursor[conv.id] = Math.max(...fresh.map(m => m.at || 0), cursor); dirty = true;
    }
    if (dirty) this.saveState(owner, av.id, st);
  }
  upsert(st, c, roster) {
    const old = st.items[c.id];
    if (old && old.lastKey === c.lastKey) return;
    const g = F.gate(c, roster), item = { ...c, level: g.level, flags: g.flags, tries: 0, draft: '', why: '', createdAt: old?.createdAt || this.now() };
    if (g.level <= 1) { this.note(st, item, 'skip', '跳过', g.reason || '只看不处理'); return; }
    if (g.level === 2 && g.capped) { Object.assign(item, { state: 'remind', why: g.reason }); this.count(st, 'remind'); this.note(st, item, 'remind', '等你处理', g.reason); }
    else item.state = 'new';
    st.items[c.id] = item;
  }

  // ---- 交给分身会话 ----
  writeRules(owner, av, st) { fs.writeFileSync(path.join(this.work(owner, av.id), 'rules.md'), F.rulesMarkdown(av, { memoryLines: st.memoryLines, sources: av.sources }), 'utf8'); }
  knowledge(owner, av) {
    const lines = [], add = text => { for (const l of String(text).split(/\r?\n/)) { const t = l.trim(); if (t.length >= 8) lines.push(t.slice(0, 500)); } };
    try { add(fs.readFileSync(path.join(this.work(owner, av.id), 'memory.md'), 'utf8')); } catch { /* 没有历史问答 */ }
    try { add(fs.readFileSync(path.join(this.work(owner, av.id), 'examples.md'), 'utf8')); } catch { /* 还没有改稿 */ }
    for (const s of av.sources || []) {
      if (s.type !== 'file' || !TEXT_FILE.test(s.path)) continue;
      try { if (fs.statSync(s.path).size <= 2000000) add(fs.readFileSync(s.path, 'utf8')); } catch { /* 文件被移走了 */ }
    }
    return lines.slice(-6000);
  }
  material(owner, av, items) {
    const lines = this.knowledge(owner, av);
    return { avatar: av.name, items: items.map(item => ({ id: item.id, where: item.group ? `群「${item.convName}」` : '私聊', who: item.who, isLeader: (item.flags || []).includes('leader'), atMe: !!item.atMe, allowed: item.level >= 3 ? ['draft', 'remind', 'skip'] : ['remind', 'skip'],
      incoming: F.safeText(item.text, 1200), history: this.messages(item.conv).slice(-20).map(m => `${m.displayTime || ''} ${m.sender}：${F.safeText(m.text || m.preview, 300)}`), related: F.related(lines, item.text, 12) })) };
  }
  async runAvatar(owner, id) {
    if (this.running.has(id)) return;
    this.running.add(id);
    let pending = [];
    try {
      const fleet = this.fleet(owner), av = fleet.avatars.find(v => v.id === id); if (!av || !av.enabled || fleet.paused) return;
      pending = this.mutate(owner, id, st => {
        this.count(st, 'model', 0);
        const rows = Object.values(st.items).filter(i => i.state === 'new').sort((a, b) => a.at - b.at).slice(0, BATCH);
        if ((st.stats.model || 0) >= DAILY_ITEMS) { for (const p of rows) Object.assign(p, { state: 'remind', why: '今天的处理量已到上限，这条请你看一下' }); return []; }
        for (const p of rows) p.state = 'drafting';
        return rows.map(p => ({ ...p }));
      });
      if (!pending.length) return;
      this.changed();
      const dir = this.work(owner, id), before = this.state(owner, id); this.writeRules(owner, av, before);
      const session = await this.sessions.ensure(av, before.session, dir);
      if (!this.exists(owner, id)) { await this.sessions.close(session.id); return; }
      this.mutate(owner, id, st => { st.session = session; });
      const file = `task-${this.now()}.json`, target = path.join(dir, file);
      fs.writeFileSync(target, JSON.stringify(this.material(owner, av, pending), null, 1), 'utf8');
      let raw; try { raw = await this.sessions.ask(session, file); } finally { fs.rmSync(target, { force: true }); }
      const results = F.parseResults(raw);
      if (!this.exists(owner, id)) return;
      this.mutate(owner, id, st => {
        for (const p of pending) {
          const item = st.items[p.id]; if (!item || item.state !== 'drafting') continue;
          if (item.lastKey !== p.lastKey) { item.state = 'new'; continue; }
          Object.assign(item, F.applyResult(item, results.get(p.id), av), { draftedAt: this.now() });
          this.count(st, 'model');
          if (item.state === 'ready') { this.count(st, 'ready'); this.note(st, item, 'draft', '等你确认', item.why); }
          else if (item.state === 'remind') { this.count(st, 'remind'); this.note(st, item, 'remind', '等你处理', item.why); }
          else this.note(st, item, 'skip', '跳过', item.why);
        }
        if (st.session?.id === session.id) st.session = { ...st.session, questions: (st.session.questions || 0) + pending.length, lastAt: this.now() };
        st.lastError = '';
      });
    } catch (e) {
      if (this.exists(owner, id)) {
        const stale = this.mutate(owner, id, st => {
          for (const p of pending) {
            const item = st.items[p.id]; if (!item || item.state !== 'drafting') continue;
            item.tries = (item.tries || 0) + 1;
            if (item.tries >= 2) { Object.assign(item, { state: 'remind', why: '分身没处理成：' + short(e.message, 80) }); this.note(st, item, 'remind', '等你处理', item.why); } else item.state = 'new';
          }
          st.lastError = short(e.message, 160);
          if (!e.restart) return '';
          const sid = st.session?.id || ''; st.session = null; return sid;
        });
        await this.sessions.close(stale);
      }
    } finally {
      this.running.delete(id); this.changed();
      try { this.pump(owner, this.fleet(owner)); } catch { /* 下一轮再说 */ }
    }
  }
  async closeIdle(owner, fleet) {
    for (const av of fleet.avatars) {
      const st = this.state(owner, av.id);
      if (st.session?.id && !this.running.has(av.id) && this.now() - (st.session.lastAt || 0) > IDLE_MS) { this.mutate(owner, av.id, s => { s.session = null; }); await this.sessions.close(st.session.id); }
      else if (this.now() - (st.memoryAt || 0) > MEMORY_TTL_MS && F.TEMPLATES[av.tpl]?.memory) this.buildMemory(owner, av);
    }
  }
  // 从群档案抽问答，写成分身工作目录里的 memory.md。
  buildMemory(owner, av) {
    const a = this.assistant(), since = this.now() - HISTORY_DAYS * 86400000, snap = this.snapshot();
    let names = {}; try { names = a?.archive?.loadIndex?.(owner)?.names || {}; } catch { /* 档案还没建 */ }
    const direct = D.namesOf(snap?.conversations || []), nameOf = id => names[id] || direct.get(id) || id, lines = [];
    let top = [];
    for (const t of (av.targets || []).filter(x => x.type === 'group')) {
      let rows = []; try { rows = a?.archive?.read?.(owner, t.id, { since }) || []; } catch { /* 用实时消息 */ }
      if (!rows.length) rows = this.messages(t.id).map(m => ({ id: m.key, at: m.at || 0, a: m.account, t: m.text || '', ...(m.mine ? { m: 1 } : {}) }));
      const mined = F.minePairs(rows, { owner, nameOf, authorities: av.authorities });
      top = top.concat(mined.top);
      for (const p of mined.pairs) lines.push(`- ${D.dayKey(p.at)} ${t.name} 问（${p.asker}）：${p.q} ｜ 答（${p.name}）：${p.a}`);
    }
    fs.writeFileSync(path.join(this.work(owner, av.id), 'memory.md'), lines.join('\n'), 'utf8');
    const st = this.state(owner, av.id); st.memoryAt = this.now(); st.memoryLines = lines.length; this.saveState(owner, av.id, st);
    return { lines: lines.length, top };
  }

  // ---- 页面操作 ----
  find(owner, id) { const fleet = this.fleet(owner), av = fleet.avatars.find(v => v.id === id); if (!av) throw new Error('找不到这个分身'); return { fleet, av }; }
  step(i) { if (this.prep) { this.prep.at = i; this.changed(); } return sleepTurn(); }
  async create(input = {}) {
    const owner = this.need(), tpl = F.TEMPLATES[input.tpl] ? input.tpl : 'blank', t = F.TEMPLATES[tpl];
    if (this.prep) throw new Error('上一个分身还在创建，请稍等');
    const av = F.newAvatar({ id: this.newId(), tpl, now: this.now(), prefix: this.defaultPrefix() }, input);
    if (av.kind === 'pick' && !av.targets.length) throw new Error('至少选一个群或人');
    this.prep = { name: av.name, at: 0, steps: ['确认 WeLink 账号', t.memory ? '读取群历史，提取问答' : '读取最近的消息', '生成你的说话习惯', '启动分身会话'] };
    try {
      await this.step(0); await this.step(1);
      let mined = null; if (t.memory) mined = this.buildMemory(owner, av);
      if (mined && !av.authorities.length) av.authorities = mined.top.slice(0, 3).map(x => ({ id: x.id, name: x.name, type: 'user' }));
      await this.step(2);
      if (!av.persona) { let texts = []; try { texts = this.legacy.myTexts(owner); } catch { /* 档案还没建 */ } av.persona = R.personaFrom(texts); }
      this.mutateFleet(owner, fleet => { fleet.avatars.push(av); }); this.legacy.audit(owner, { op: 'avatar-create', tpl });
      await this.step(3);
      void this.warm(owner, av.id); void this.tick().catch(e => { this.lastError = e.message; });
      return { ...this.status(), createdId: av.id };
    } finally { this.prep = null; this.changed(); }
  }
  async warm(owner, id) {
    try {
      const { av } = this.find(owner, id), st = this.state(owner, id); this.writeRules(owner, av, st);
      const session = await this.sessions.ensure(av, st.session, this.work(owner, id));
      if (!this.exists(owner, id)) { await this.sessions.close(session.id); return; }
      this.mutate(owner, id, now => { now.session = session; now.lastError = ''; });
    } catch (e) { if (this.exists(owner, id)) this.mutate(owner, id, st => { st.lastError = short(e.message, 160); }); }
    this.changed();
  }
  async update(id, patch = {}) {
    const owner = this.need(); let before, next;
    this.mutateFleet(owner, fleet => {
      const at = fleet.avatars.findIndex(v => v.id === id); if (at < 0) throw new Error('找不到这个分身');
      before = fleet.avatars[at]; next = F.applyPatch(before, patch); fleet.avatars[at] = next;
    });
    if ('backend' in patch && JSON.stringify(before.backend) !== JSON.stringify(next.backend)) {
      await this.sessions.close(this.mutate(owner, id, st => { const sid = st.session?.id || ''; st.session = null; return sid; }));
    }
    if (F.TEMPLATES[next.tpl]?.memory && ('targets' in patch || 'authorities' in patch)) this.buildMemory(owner, next);
    void this.tick().catch(e => { this.lastError = e.message; });
    return this.status();
  }
  async remove(id) {
    const owner = this.need(), { av } = this.find(owner, id), sid = this.state(owner, id).session?.id;
    this.mutateFleet(owner, fleet => { fleet.avatars = fleet.avatars.filter(v => v.id !== id); });
    await this.sessions.close(sid);
    fs.rmSync(this.home(owner, id), { recursive: true, force: true }); this.legacy.audit(owner, { op: 'avatar-remove', tpl: av.tpl });
    return this.status();
  }
  pauseAll(paused = true) { const owner = this.need(), fleet = this.fleet(owner); fleet.paused = !!paused; this.saveFleet(owner, fleet); this.legacy.audit(owner, { op: paused ? 'avatar-pause-all' : 'avatar-resume-all' }); return this.status(); }
  regeneratePersona(id) { const owner = this.need(), { fleet, av } = this.find(owner, id); let texts = []; try { texts = this.legacy.myTexts(owner); } catch { /* 档案还没建 */ } const persona = R.personaFrom(texts); if (!persona) throw new Error('你的历史发言还不够，先手动写几句'); av.persona = persona; this.saveFleet(owner, fleet); return this.status(); }
  item(owner, avatarId, itemId) { const st = this.state(owner, avatarId), item = st.items[itemId]; if (!item) throw new Error('这条已经处理过了'); return { st, item }; }
  finish(avatarId, itemId, state, result, why = '') { const owner = this.need(), { st, item } = this.item(owner, avatarId, itemId); if (!OPEN.has(item.state)) throw new Error('这条已经处理过了'); item.state = state; this.note(st, item, state === 'dropped' ? 'dropped' : 'done', result, why); this.saveState(owner, avatarId, st); return this.status(); }
  drop(avatarId, itemId) { return this.finish(avatarId, itemId, 'dropped', '已丢弃'); }
  done(avatarId, itemId) { return this.finish(avatarId, itemId, 'done', '已处理'); }
  remindOnly(avatarId, itemId) { const owner = this.need(), { st, item } = this.item(owner, avatarId, itemId); Object.assign(item, { state: 'remind', draft: '', why: '你改成了只提醒' }); this.saveState(owner, avatarId, st); return this.status(); }
  async redraft(avatarId, itemId) {
    const owner = this.need(), { st, item } = this.item(owner, avatarId, itemId);
    if (item.sensitive) throw new Error('这条涉及敏感内容，分身不起草，请你亲自回复');
    if (item.onlyNonText) throw new Error('对方发的是图片或文件，分身看不到内容');
    Object.assign(item, { state: 'new', level: 3, action: 'draft', draft: '', tries: 0 }); this.saveState(owner, avatarId, st);
    void this.runAvatar(owner, avatarId); return this.status();
  }
  repliedAlready(item) { return F.answeredAfter(this.messages(item.conv), item, { authorities: [] })?.by === 'me'; }
  // 发送前的检查：进队列时查一次，轮到真正执行时再查一次（排队期间可能暂停了、本人回了、对方被认出是上级）。
  sendProblem(owner, avatarId, item, body, ackRisk) {
    const fleet = this.fleet(owner), av = fleet.avatars.find(v => v.id === avatarId);
    if (fleet.paused) return { error: '分身已全部暂停，恢复后才能发送' };
    if (!av) return { error: '找不到这个分身' };
    if (!av.enabled) return { error: '这个分身已暂停，恢复后才能发送' };
    if (!INBOX.has(this.state(owner, avatarId).items[item.id]?.state)) return { error: '这条已经转给别的分身或处理过了' };
    if (this.repliedAlready(item)) return { error: '你已经在 WeLink 里回过这条了，没有重复发送', replied: true };
    const flags = R.decide(item, this.legacy.roster(owner)).flags;
    if (R.commitRisk(body) && flags.some(f => f === 'leader' || f === 'leader-present') && !ackRisk) return { error: '这句话在向上级应承一件事。确认要这样发，请再点一次。', needAck: true };
    return null;
  }
  // 本人点了「发送」。收信方取自事项记录，页面传不进来。
  async send(avatarId, itemId, text, { ackRisk = false } = {}) {
    const owner = this.need(), { av } = this.find(owner, avatarId), { item } = this.item(owner, avatarId, itemId), a = this.assistant();
    if (!INBOX.has(item.state)) throw new Error('这条已经处理过了');
    const body = String(text ?? '').trim();
    if (!body) throw new Error('草稿是空的');
    if (body.length > 2000) throw new Error('超过 2000 字，请在 WeLink 里直接发');
    const first = this.sendProblem(owner, avatarId, item, body, ackRisk);
    if (first?.needAck) return { ok: false, needAck: true, error: first.error };
    if (first?.replied) this.mutate(owner, avatarId, st => { const cur = st.items[itemId]; cur.state = 'answered'; this.note(st, cur, 'answered', '你已回复'); });
    if (first) throw new Error(first.error);
    if (this.sending.has(itemId)) throw new Error('这条正在发送，请稍等');
    this.sending.add(itemId);
    try {
      const full = F.TEMPLATES[av.tpl]?.prefixed ? `${F.MARK}【${av.prefix}】${body}` : body;
      const args = item.group ? ['im', 'send-to-group', '--group-id', item.conv, '--text', R.cliText(full)] : ['im', 'send-to-user', '--receiver', item.conv, '--text', R.cliText(full)];
      const beforeRun = () => { const bad = this.sendProblem(owner, avatarId, item, body, ackRisk); if (bad) throw Object.assign(new Error(bad.needAck ? '对方刚被识别为上级，这句话在应承一件事，没有发出；确认要这样发，请再点一次发送' : bad.error), { needAck: !!bad.needAck }); };
      let r;
      try { r = await a.welink(args, { ...(item.group ? { sendGroup: item.conv } : { sendUser: item.conv }), timeoutMs: 30000, priority: 'user', beforeRun }); }
      catch (e) { if (e.needAck) return { ok: false, needAck: true, error: e.message }; throw e; }
      const receipt = welink.parseJson(r.stdout), code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
      if (r.code !== 0 || receipt?.ok === false || receipt?.success === false || code !== undefined && !['0', '200'].includes(String(code))) throw new Error('没发出去：' + short(welink.friendlyError(receipt?.error?.error_msg || receipt?.message || r.stderr || r.stdout || '发送命令失败'), 160));
      const done = this.mutate(owner, avatarId, st => {
        const cur = st.items[itemId] || item, edited = !!cur.draft && R.clean(cur.draft) !== R.clean(body);
        st.items[itemId] = cur; Object.assign(cur, { state: 'sent', sentAt: this.now(), sentText: full, messageId: findMessageId(receipt) });
        this.count(st, 'sent'); this.note(st, cur, 'sent', '你已发送', edited ? '你改过，已存为范例' : '原样发送'); st.log[0].canRecall = !!cur.messageId;
        return { cur, edited };
      });
      if (done.edited) fs.appendFileSync(path.join(this.work(owner, avatarId), 'examples.md'), `- 收到：${short(R.clean(done.cur.text), 200)} ｜ 草稿：${short(R.clean(done.cur.draft), 200)} ｜ 本人定稿：${short(R.clean(body), 300)}\n`, 'utf8');
      this.legacy.audit(owner, { op: 'avatar-send', len: full.length, edited: done.edited });
      return { ok: true, edited: done.edited, canRecall: !!done.cur.messageId, ...this.status() };
    } finally { this.sending.delete(itemId); }
  }
  async recall(avatarId, itemId) {
    const owner = this.need(), { item } = this.item(owner, avatarId, itemId), a = this.assistant();
    if (item.state !== 'sent') throw new Error('这条没有发出去');
    if (!item.messageId) throw new Error('WeLink 没返回消息编号，请到 WeLink 里手动撤回');
    const args = ['im', 'recall-message', item.group ? '--group-id' : '--user-account', item.conv, '--message-id', item.messageId];
    const r = await a.welink(args, { recall: { conv: item.conv, messageId: item.messageId }, timeoutMs: 30000, priority: 'user' }), receipt = welink.parseJson(r.stdout), code = receipt?.code ?? receipt?.resultCode;
    if (r.code !== 0 || receipt?.ok === false || code !== undefined && !['0', '200'].includes(String(code))) throw new Error('撤回失败：' + short(welink.friendlyError(receipt?.message || r.stderr || r.stdout || '可能已超过撤回时限'), 120));
    this.mutate(owner, avatarId, st => {
      const cur = st.items[itemId]; if (cur) cur.state = 'recalled';
      for (const row of st.log) if (row.itemId === itemId && row.act === 'sent') { row.canRecall = false; row.result = '已撤回'; }
      this.note(st, cur || item, 'recalled', '已撤回');
    });
    return this.status();
  }
  async recheckLogin() { const a = this.assistant(); await a?.auth?.check?.({ force: true }); void this.tick().catch(e => { this.lastError = e.message; }); return this.status(); }
  sessionOf(avatarId) { const owner = this.need(), id = this.state(owner, avatarId).session?.id; return { ok: true, sessionId: id && this.sessions.alive(id) ? id : '' }; }

  targets() {
    const owner = this.need(), snap = this.snapshot(), roster = this.legacy.roster(owner), titles = this.legacy.read(owner, 'titles.json', {});
    const rows = (snap?.conversations || []).map(c => ({ id: c.id, name: c.name || c.id, type: c.group ? 'group' : 'user', count: (snap.messages?.[c.id] || []).length, title: titles[c.id]?.title || '', leader: !!roster.people?.[c.id]?.protected }));
    return { ok: true, groups: rows.filter(r => r.type === 'group'), people: rows.filter(r => r.type === 'user') };
  }
  login() {
    const a = this.assistant(), auth = a?.auth?.status?.(), snap = this.snapshot();
    const ok = auth ? !['needs-scan', 'renewing'].includes(auth.state) && auth.login?.ok !== false : !!snap?.login?.ok;
    return { ok, reason: ok ? '' : auth?.error || 'WeLink 没有登录，分身暂时读不到消息' };
  }
  status() {
    const a = this.assistant(); if (!a) return { ok: true, available: false, reason: '公司助理还没准备好' };
    const owner = this.owner();
    if (!owner) return { ok: true, available: false, reason: '还没确认 WeLink 登录，请先在助理页登录', beta: true };
    const fleet = this.fleet(owner), snap = this.snapshot(), login = this.login(), items = [], roster = this.legacy.roster(owner);
    const avatars = fleet.avatars.map(av => {
      const st = this.state(owner, av.id), stats = st.stats.day === this.today() ? st.stats : {}, open = Object.values(st.items).filter(i => INBOX.has(i.state));
      for (const item of open) items.push({ ...item, avatarId: av.id, avatarName: av.name, prefixed: !!F.TEMPLATES[av.tpl]?.prefixed, prefix: av.prefix, flags: [...new Set([...(item.flags || []), ...R.decide(item, roster).flags])] });
      const working = Object.values(st.items).filter(i => ['new', 'drafting'].includes(i.state)).length;
      const code = fleet.paused ? 'paused' : !av.enabled ? 'off' : !login.ok ? 'waiting' : st.lastError ? 'error' : 'on';
      return { ...av, state: { code, text: { paused: '已暂停', off: '已暂停', waiting: '等 WeLink 登录', error: '遇到问题', on: this.running.has(av.id) || working ? '处理中' : '运行中' }[code], error: st.lastError || '' }, pending: open.length, working,
        stats: { read: stats.read || 0, model: stats.model || 0, ready: stats.ready || 0, remind: stats.remind || 0, sent: stats.sent || 0 }, memoryLines: st.memoryLines || 0, examples: exampleCount(path.join(this.home(owner, av.id), 'work', 'examples.md')),
        session: { id: st.session?.id || '', alive: this.sessions.alive(st.session?.id), questions: st.session?.questions || 0 }, log: st.log.slice(0, 80),
        owners: Object.fromEntries((av.targets || []).map(t => [t.id, F.ownerOf(fleet.avatars, av, t)])) };
    });
    return { ok: true, available: true, beta: true, paused: fleet.paused, login, snapAt: snap?.at || 0, readError: this.readError, lastError: this.lastError, prep: this.prep, avatars, items: items.sort((x, y) => (y.at || 0) - (x.at || 0)), backends: this.backends() };
  }
}
function findMessageId(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return '';
  for (const k of ['msgId', 'msg_id', 'messageId', 'message_id']) if (v[k] != null && String(v[k])) return String(v[k]);
  for (const x of Object.values(v)) { const hit = findMessageId(x, depth + 1); if (hit) return hit; }
  return '';
}
function exampleCount(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }

module.exports = { FleetService, findMessageId, TICK_MS };
