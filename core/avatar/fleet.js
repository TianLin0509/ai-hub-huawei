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

const WIDE_MS = 120000, WIDE_PER_TICK = 4, WIDE_LIST = 50, WIDE_PENDING_MAX = WIDE_LIST, WIDE_FAIL_MAX = 3;
const TICK_MS = 30000, BATCH = 5, LOOKBACK_MS = 2 * 3600000, HOT_PER_TICK = 6, MAX_PARALLEL = 2, DAILY_ITEMS = 150, KEEP_LOG = 200, KEEP_LIVE = 200, HISTORY_DAYS = 90, MEMORY_TTL_MS = 86400000;
const OPEN = new Set(['new', 'drafting', 'ready', 'remind']), INBOX = new Set(['ready', 'remind']);
const TEXT_FILE = /\.(?:md|txt|csv|json|log)$/i;
const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const sleepTurn = () => new Promise(resolve => setImmediate(resolve));
const slowed = ms => { try { return require('../optional-features').slowedMs(ms); } catch { return ms; } };

class FleetService {
  constructor(deps) {
    this.d = deps; this.now = deps.now || (() => Date.now());
    this.legacy = new AvatarService({ dataDir: deps.dataDir, getAssistant: deps.getAssistant, runAi: deps.runAi, now: this.now, noTimer: true });
    this.sessions = new AgentSessions({ dataDir: deps.dataDir, createSession: deps.createSession, sendPrompt: deps.sendPrompt, lastFinal: deps.lastFinal, getSession: deps.getSession, closeSession: deps.closeSession, readTerminalScreen: deps.readTerminalScreen, pollMs: deps.pollMs, now: this.now, pickAccount: model => this.pickAccount(model) });
    this.timer = null; this.ticking = false; this.running = new Set(); this.sending = new Set(); this.live = new Map(); this.hotAt = 0; this.prep = null; this.readError = ''; this.lastError = ''; this.recovered = new Set();
  }
  assistant() { return this.legacy.assistant(); }
  // 和 legacy.owner() 同一规则（快照里的登录号优先，其次档案），但快照走下面带缓存的 snapshot()：原来每拍为取一个工号整份解析一次当天快照。
  owner() {
    const snap = this.snapshot();
    if (snap?.login?.ok && snap.login.uid) return String(snap.login.uid);
    try { return this.assistant()?.archive?.owner?.() || null; } catch { return null; }
  }
  need() { const o = this.owner(); if (!o) throw new Error('还没确认 WeLink 登录，请先在助理页登录'); return o; }
  changed() { try { this.d.onChanged?.(); } catch { /* 页面没开 */ } }
  // 30 秒巡检（2026-11-23 开销优化）：一个分身都没有时巡检自己停下，不再每 30 秒读一遍配置；
  // 新建分身（任何写回 fleet.json 的操作）时由 saveFleet 重新拉起。没有分身本来就不列最近会话、不读群。
  start() { this.started = true; this.armTimer(); }
  armTimer() { if (this.d.noTimer || this.timer || !this.started) return; this.timer = setInterval(() => this.timerTick(), TICK_MS); this.timer.unref?.(); }
  // 定时巡检受低开销模式管（2026-11-25 R40b）：开着时 30 秒一拍放慢到 2 分钟（盯指定群、看最近会话同比放慢）；
  // 用户在页面上的操作（新建、改配置、重新检查登录）照旧立即跑一拍。
  timerTick() {
    const now = this.now();
    if (now - (this.timerAt || 0) < slowed(TICK_MS) - 1000) return;
    this.timerAt = now;
    void this.tick().catch(e => { this.lastError = e.message; });
  }
  idleStop() { clearInterval(this.timer); this.timer = null; }
  close() { this.started = false; this.idleStop(); }
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
  saveFleet(owner, fleet) { this.legacy.write(owner, 'fleet.json', fleet); this.saves = (this.saves || 0) + 1; if (fleet?.avatars?.length) this.armTimer(); }
  // memo：巡检里同步处理各分身的那一段（不跨 await）同一个分身的状态只读一次盘（2026-11-25 R40b）。原来查「这件事在不在别的分身手上」
  // 时每条候选都把其他分身的 state.json 各读一遍（N 个分身 O(N²) 次读盘 + 解析）；写回时同步更新这份。
  state(owner, id) {
    const key = owner + '|' + id;
    if (this.memo?.has(key)) return this.memo.get(key);
    const st = { cursor: {}, items: {}, log: [], stats: {}, session: null, memoryAt: 0, memoryLines: 0, ...this.legacy.read(owner, path.join('agents', id, 'state.json'), {}) };
    this.memo?.set(key, st);
    return st;
  }
  saveState(owner, id, st) { this.legacy.write(owner, path.join('agents', id, 'state.json'), st); this.memo?.set(owner + '|' + id, st); this.saves = (this.saves || 0) + 1; }
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
  // 当天消息快照（raw-日期.json，可达几 MB）：文件大小和修改时刻都没变就用上次解析好的（2026-11-25 R40b），原来每 30 秒整份重读重解析。
  snapshot() {
    try {
      const a = this.assistant();
      if (!a?.snapshot) return null;
      if (typeof a.file !== 'function') return a.snapshot() || null;
      const file = a.file(`raw-${D.dayKey(typeof a.now === 'function' ? a.now() : this.now())}.json`);
      let key = '';
      try { const st = fs.statSync(file); key = `${file}|${st.size}|${st.mtimeMs}`; } catch { key = ''; }
      if (key && this.snapCache?.key === key) return this.snapCache.snap;
      const snap = a.snapshot() || null;
      this.snapCache = key && snap ? { key, snap } : null;
      return snap;
    } catch { return null; }
  }
  conversationsOf(snap, fleet) {
    const map = new Map((snap?.conversations || []).map(c => [c.id, c]));
    for (const av of fleet.avatars) for (const t of av.targets || []) if (!map.has(t.id)) map.set(t.id, { id: t.id, name: t.name, group: t.type === 'group' });
    for (const c of this.wideConvs?.values() || []) if (!map.has(c.id)) map.set(c.id, c);
    return [...map.values()];
  }
  merge(id, list) {
    const known = this.live.get(id) || new Map();
    for (const m of list || []) known.set(m.key, m);
    const rows = [...known.values()].sort((a, b) => (a.at || 0) - (b.at || 0) || D.idCmp(a.key, b.key)).slice(-KEEP_LIVE);
    this.live.set(id, new Map(rows.map(m => [m.key, m])));
    return rows;
  }
  messages(id) { return [...(this.live.get(id)?.values() || [])]; }
  hotIds(fleet) { return new Set(fleet.avatars.filter(v => v.enabled && v.kind === 'pick').flatMap(v => v.targets.filter(t => t.action !== 'watch').map(t => t.id))); }
  // 指定的群和人轮流增量读，每轮最多 6 个；被限流就停在这一轮。
  async readHot(owner, fleet, convs) {
    const hot = [...this.hotIds(fleet)];
    if (!hot.length) { this.readError = ''; return; }
    // 2026-11-20 运行时风暴排查：原来只有限流才停，登录过期、CLI 坏了时每 30 秒照样连起 6 次 welink-cli 全失败。
    // 现在：单个群读不了只跳过它（不挡后面的群）；限流或命令本身出错就停在这一轮；
    // 一轮里一个都没读成才按连续失败轮数退避（1、2、4… 分钟，最长 10 分钟）；读成功一次就恢复。
    if (this.now() < (this.readBackoffUntil || 0)) return; // 退避期间保留上次的出错原因给页面看
    this.readError = '';
    const names = D.namesOf(convs), count = Math.min(hot.length, HOT_PER_TICK);
    let tried = 0, ok = 0, done = 0;
    for (let i = 0; i < count; i += 1) {
      done = i + 1;
      const id = hot[(this.hotAt + i) % hot.length], conv = convs.find(c => c.id === id); if (!conv) continue;
      tried += 1;
      const got = await this.readOne(owner, conv, names);
      if (got === 'ok') ok += 1; else if (got === 'stop') break;
    }
    if (tried && !ok) { this.readFails = (this.readFails || 0) + 1; this.readBackoffUntil = this.now() + Math.min(600000, 60000 * 2 ** (this.readFails - 1)); }
    else if (ok) this.readFails = 0;
    // 从停下的下一个接着读，出错的那个不会每轮都排在最前面。
    this.hotAt = (this.hotAt + done) % hot.length;
  }

  // 「全部会话 / 全部群 / 全部私聊」范围的分身原来只靠助理快照（工作日 10 分钟一轮、周末 2 小时、夜里不取），
  // 群里 @我 之后要等很久才起草，周末几乎不动（2026-11-22 反馈「起草慢」「设了只 @我 也不起草」）。
  // 现在每 2 分钟看一次最近会话列表（1 次请求），排上来的会话进「待补」队列，每轮最多读 4 个；第一轮只记顺序不读。
  // 待补队列覆盖完整列表页，旧的未读项优先：超出本轮名额、限流中断的下轮接着读；失败 3 次冷却后重新入队（R-08）。
  // 置顶会话来新消息时排序不变，看不出来：每轮在名额里留 1 个给置顶区轮转，置顶 N 个时每个最长 N×2 分钟被看一次（R-09）。
  wideKinds(fleet) {
    const kinds = new Set();
    for (const v of fleet.avatars) if (v.enabled && v.kind !== 'pick' && v.action !== 'watch') kinds.add(v.kind);
    return kinds;
  }
  async readWide(owner, fleet, hot) {
    const kinds = this.wideKinds(fleet), a = this.assistant();
    if (!kinds.size || !a?.welink) return;
    const now = this.now();
    if (now - (this.wideAt || 0) < slowed(WIDE_MS) || now < (this.readBackoffUntil || 0) || a.refreshing) return;
    this.wideAt = now;
    let list;
    try {
      const r = await a.welink(['im', 'query-recent-conversation', '--count', String(WIDE_LIST)], { priority: 'background', timeoutMs: 20000 });
      const raw = r.code === 0 ? welink.parseJsonBig(r.stdout) : null;
      list = raw && D.conversationRecords(raw) !== null ? D.conversations(raw) : null;
      if (!list) { this.readError = welink.friendlyError(r.stderr || r.stdout || '读取最近会话失败'); return; }
    } catch (e) { this.readError = e.code === WELINK_RATE_LIMITED ? 'WeLink 限流，稍后自动继续' : e.message; return; }
    this.wideConvs = new Map(list.map(c => [c.id, c]));
    const order = list.map(c => c.id), prev = this.wideOrder;
    const { conversationOrderChanges } = require('../company-assistant/service');
    const changes = prev?.length ? conversationOrderChanges(prev, order, this.widePinned || 0) : null;
    this.wideOrder = order; if (changes) this.widePinned = changes.pinnedHead;
    if (!changes) return;
    const inScope = c => !!c && !hot.has(c.id) && (kinds.has('all') || (c.group ? kinds.has('groups') : kinds.has('dm')));
    const dead = this.wideDead || (this.wideDead = new Map()); // 连续失败 3 次的会话：30 分钟内不再试
    const pending = (this.widePending || []).filter(x => inScope(this.wideConvs.get(x.id)));
    for (const [id, until] of dead) if (until <= now) {
      dead.delete(id); this.wideFails?.delete(id);
      if (inScope(this.wideConvs.get(id)) && !pending.some(x => x.id === id)) pending.push({ id, fails: 0 });
    }
    for (const id of changes.changed) if (inScope(this.wideConvs.get(id)) && !dead.has(id) && !pending.some(x => x.id === id)) pending.push({ id, fails: 0 });
    this.widePending = pending.slice(0, WIDE_PENDING_MAX);
    // 置顶区：本轮名额里留 1 个，按上次读到的位置往后轮
    const pins = order.slice(0, this.widePinned || 0).filter(id => inScope(this.wideConvs.get(id)) && !dead.has(id));
    const pinAt = pins.length ? ((this.widePinAt ?? -1) + 1) % pins.length : -1, pin = pinAt >= 0 ? pins[pinAt] : null;
    const batch = this.widePending.slice(0, pin && !this.widePending.slice(0, WIDE_PER_TICK).some(x => x.id === pin) ? WIDE_PER_TICK - 1 : WIDE_PER_TICK).map(x => x.id);
    if (pin && !batch.includes(pin)) batch.push(pin);
    const names = D.namesOf(list);
    for (const id of batch) {
      const got = await this.readOne(owner, this.wideConvs.get(id), names, 20);
      if (got === 'stop') break; // 限流：全部留在队列里；没读到的置顶下轮还从它开始
      if (id === pin) this.widePinAt = pinAt;
      const i = this.widePending.findIndex(x => x.id === id);
      if (got === 'ok') { if (i >= 0) this.widePending.splice(i, 1); this.wideFails?.delete(id); continue; }
      // 失败的排到队尾，不挡后面；累计 3 次放弃，30 分钟后再给机会
      const fails = (this.wideFails?.get(id) || 0) + 1;
      (this.wideFails || (this.wideFails = new Map())).set(id, fails);
      if (i >= 0) { const x = this.widePending.splice(i, 1)[0]; if (fails < WIDE_FAIL_MAX) this.widePending.push(x); }
      if (fails >= WIDE_FAIL_MAX) { dead.set(id, now + 30 * 60000); this.wideFails.delete(id); }
    }
  }
  // 增量读一个会话：'ok' 读成、'fail' 这个会话没读成、'stop' 限流或命令出错，本轮不再读。
  async readOne(owner, conv, names, count = 50) {
    const a = this.assistant(), newest = this.messages(conv.id).at(-1)?.key;
    const args = ['im', 'query-history-message', conv.group ? '--group-id' : '--user-account', conv.id, '--query-count', String(newest ? 50 : count), ...(newest ? ['--message-id', newest, '--query-direction', '1'] : [])];
    try {
      // msgId 是超过 JS 安全整数的长整数，必须和助理快照一样按 parseJsonBig 原样保留：
      // 用普通 JSON.parse 会被四舍五入成另一个编号，快照里那份和这里读到的同一条消息就成了两条（R36：盯消息每条显示两次），增量游标也会错位。
      const r = await a.welink(args, { priority: 'background', timeoutMs: 20000 }), raw = welink.parseJsonBig(r.stdout);
      if (r.code !== 0 || !raw) { this.readError = welink.friendlyError(r.stderr || r.stdout || '读取消息失败'); return 'fail'; }
      this.merge(conv.id, D.messages(raw, conv, owner, { myName: this.myName(), names }));
      return 'ok';
    } catch (e) { this.readError = e.code === WELINK_RATE_LIMITED ? 'WeLink 限流，稍后自动继续' : e.message; return 'stop'; }
  }

  // ---- 每轮 ----
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      const owner = this.owner(); if (!owner) return;
      let fleet = this.fleet(owner); if (!fleet.avatars.length) { this.idleStop(); return; }
      // 从 closeIdle 之前开始数写盘：收空闲会话时写的事项状态也要通知页面（R40b 审查）。
      const savesBefore = this.saves || 0, errorBefore = this.readError;
      await this.closeIdle(owner, fleet);
      fleet = this.fleet(owner); if (fleet.paused) return;
      const snap = this.snapshot();
      // 快照没换（同一份解析结果）就不再逐条并入：并入是幂等的，重做只是白费。
      if (snap !== this.mergedSnap) { for (const [id, list] of Object.entries(snap?.messages || {})) this.merge(id, list); this.mergedSnap = snap; }
      await this.readHot(owner, fleet, this.conversationsOf(snap, fleet));
      if (this.wideKinds(fleet).size) await this.readWide(owner, fleet, this.hotIds(fleet));
      fleet = this.fleet(owner); if (fleet.paused) return; // 读消息期间可能暂停或改了配置
      const roster = this.legacy.roster(owner), convs = this.conversationsOf(snap, fleet);
      let accounts;
      this.memo = new Map();
      try {
        for (const av of fleet.avatars.filter(v => v.enabled)) { this.recover(owner, av.id); this.absorb(owner, fleet, av, convs, roster); }
        this.pump(owner, fleet);
        accounts = fleet.avatars.flatMap(v => Object.values(this.state(owner, v.id).items).filter(i => OPEN.has(i.state)).map(i => i.account));
      } finally { this.memo = null; }
      void this.legacy.lookupTitles(owner, accounts).then(found => { if (found) this.changed(); }).catch(() => {});
      // 这一拍写过事项、配置，或读消息的出错状态变了才通知页面（原来每 30 秒无条件广播，页面开着时每次整页重读）。
      if ((this.saves || 0) !== savesBefore || this.readError !== errorBefore) this.changed();
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
        if (this.heal(st, fleet, av, conv, list, item)) dirty = true;
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
        const holder = fleet.avatars.filter(v => v.id !== av.id).map(v => ({ id: v.id, item: findItem(this.state(owner, v.id).items, c) })).find(x => x.item && x.item.state !== 'moved');
        if (!holder) { this.upsert(st, c, roster); continue; }
        if (OPEN.has(holder.item.state)) { this.mutate(owner, holder.id, other => this.upsert(other, c, roster)); continue; }
        const covered = D.sameMsgKey(holder.item.lastKey, c.lastKey) || holder.item.state === 'sent' && (holder.item.sentAt || 0) >= (c.at || 0);
        if (!covered) this.upsert(st, c, roster);
      }
      if (hold) continue;
      st.cursor[conv.id] = Math.max(...fresh.map(m => m.at || 0), cursor); dirty = true;
    }
    if (dirty) this.saveState(owner, av.id, st);
  }
  upsert(st, c, roster) {
    const old = this.claim(st, c);
    if (old && D.sameMsgKey(old.lastKey, c.lastKey)) { if (old.id === c.id) Object.assign(old, contentOf(c)); return; }
    const g = F.gate(c, roster), item = { ...c, level: g.level, flags: g.flags, tries: 0, draft: '', why: '', createdAt: old?.createdAt || this.now() };
    if (g.level <= 1) { this.note(st, item, 'skip', '跳过', g.reason || '只看不处理'); return; }
    if (g.level === 2 && g.capped) { Object.assign(item, { state: 'remind', why: g.reason }); this.count(st, 'remind'); this.note(st, item, 'remind', '等你处理', g.reason); }
    else item.state = 'new';
    st.items[c.id] = item;
  }

  // ---- R36 旧数据自愈 ----
  // v5.6.102 及以前，分身增量读把长整数消息编号四舍五入了，state.json 里事项的 id/firstKey/lastKey 可能是舍入后的写法，
  // 正文里同一句还可能拼了两遍。现在消息表里全是原样编号：按同一条消息认回旧事项，改记到原样编号下，正文按现有消息重算。
  // 正在起草或发送的先不动（它们按旧编号回写），下一轮再处理。
  movable(item) { return item.state !== 'drafting' && !this.sending.has(item.id); }
  rekey(st, item, c) {
    if (item.id === c.id) return item;
    delete st.items[item.id];
    if (st.items[c.id]) return st.items[c.id]; // 升级后已按原样编号又生成过一份：留那份，旧的去掉
    item.id = c.id; st.items[c.id] = item; return item;
  }
  claim(st, c) {
    if (st.items[c.id]) return st.items[c.id];
    const old = findItem(st.items, c);
    if (!old) return null;
    return this.movable(old) ? this.rekey(st, old, c) : old;
  }
  heal(st, fleet, av, conv, list, item) {
    if (!this.movable(item) || list.some(m => m.key === item.lastKey) || !list.some(m => D.sameMsgKey(m.key, item.lastKey))) return false;
    const since = list.filter(m => (m.at || 0) >= (item.since || item.at || 0));
    const c = F.candidates(av, fleet.avatars, conv, list, since).find(x => D.sameMsgKey(x.firstKey, item.firstKey) || D.sameMsgKey(x.lastKey, item.lastKey));
    if (!c) { item.lastKey = list.find(m => D.sameMsgKey(m.key, item.lastKey)).key; return true; } // 已有人接了等情况：只把编号对齐，后面照常结案
    Object.assign(this.rekey(st, item, c), contentOf(c));
    return true;
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
    return { avatar: av.name, items: items.map(item => ({ id: item.id, where: item.group ? `群「${item.convName}」` : '私聊', who: item.who, isLeader: (item.flags || []).includes('leader'), atMe: !!item.atMe, allowed: item.asked ? ['draft'] : item.level >= 3 ? ['draft', 'remind', 'skip'] : ['remind', 'skip'], ...(item.asked ? { ownerAsked: true } : {}),
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
        st.providerRepair = null;
      });
    } catch (e) {
      if (this.exists(owner, id)) {
        const stale = this.mutate(owner, id, st => {
          for (const p of pending) {
            const item = st.items[p.id]; if (!item || item.state !== 'drafting') continue;
            item.tries = (item.tries || 0) + 1;
            if (item.tries >= 2) { Object.assign(item, { state: 'remind', asked: false, why: '分身没处理成：' + short(e.message, 80) }); this.note(st, item, 'remind', '等你处理', item.why); } else item.state = 'new';
          }
          st.lastError = short(e.message, 160);
          st.providerRepair = e.providerRepair || null;
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
    // 以前暂停时也照收：事项转成「排队」后从待确认里消失、永远不处理，页面像没反应。
    const fleet = this.fleet(owner), av = fleet.avatars.find(v => v.id === avatarId);
    if (fleet.paused) throw new Error('分身已全部暂停，先在左侧点「全部恢复」再让它起草');
    if (av && !av.enabled) throw new Error(`分身「${av.name}」已暂停，先点「恢复」再让它起草`);
    // asked：本人点名要草稿。模型只能写草稿，写不出来要说明原因（见 fleet-rules.applyResult）。
    Object.assign(item, { state: 'new', level: 3, action: 'draft', draft: '', tries: 0, asked: true }); this.saveState(owner, avatarId, st);
    const queued = this.running.has(avatarId);
    void this.runAvatar(owner, avatarId);
    return { ...this.status(), queued };
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
      const receipt = welink.parseJsonBig(r.stdout), code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
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
    const r = await a.welink(args, { recall: { conv: item.conv, messageId: item.messageId }, timeoutMs: 30000, priority: 'user' }), receipt = welink.parseJsonBig(r.stdout), code = receipt?.code ?? receipt?.resultCode;
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
    // 群/人名单来自助理的 WeLink 消息快照（2026-11-20：群友截图「还没读到群，请稍等」一直不变）。
    // 读不到时说清是哪一种：没登录 WeLink、助理还没取到会话、还是取数出错；界面据此提示并自动重试。
    // R34（2026-11-24 WeLink 反馈「展示不了群和人，过一会儿出来了」）：当天快照要等助理整轮 WeLink 取数跑完才落盘，
    // 新的一天或刚启动时要等几分钟。读到过的名单按账号存一份（targets-cache.json），当天快照还没有时先给上次的
    // （没有缓存就找前几天的快照），标 stale 让界面写明「正在后台刷新」；当天快照一出来就换成新的。
    const owner0 = this.owner();
    if (!owner0) return { ok: true, groups: [], people: [], ready: false, reason: '还没确认 WeLink 登录：先到左侧「助理」页扫码登录，登录后这里会自动出现群' };
    const owner = owner0, snap0 = this.snapshot();
    // 当天快照也要是这个账号的：同一天切了号、旧号快照还在时，不能把旧号的名单当成新号的写进缓存。
    const hasRows = snap => !!snap && (!snap.login?.uid || snap.login.uid === owner) && Array.isArray(snap.conversations) && snap.conversations.length > 0;
    if (!hasRows(snap0)) {
      const login = this.login();
      const reasonKind = !login.ok ? 'login' : this.readError ? 'error' : 'waiting';
      const reason = reasonKind === 'login' ? `${login.reason}（到左侧「助理」页重新登录）`
        : reasonKind === 'error' ? `读 WeLink 消息出错：${this.readError}` : '助理还没取到 WeLink 会话列表，一般 1 分钟内就有，这里会自动刷新';
      const cached = this.cachedTargets(owner, hasRows);
      if (cached) return { ok: true, ready: true, stale: true, at: cached.at, groups: cached.groups, people: cached.people, reason, reasonKind };
      return { ok: true, groups: [], people: [], ready: false, reason, reasonKind };
    }
    const { groups, people } = this.targetRows(owner, snap0);
    const at = snap0.at || this.now();
    try {
      const old = this.legacy.read(owner, 'targets-cache.json', null);
      if (!old || old.at !== at) this.legacy.write(owner, 'targets-cache.json', { at, groups, people });
    } catch { /* 缓存写不了只影响下次的首屏 */ }
    return { ok: true, ready: true, at, groups, people };
  }
  targetRows(owner, snap) {
    const roster = this.legacy.roster(owner), titles = this.legacy.read(owner, 'titles.json', {});
    const rows = (snap?.conversations || []).map(c => ({ id: c.id, name: c.name || c.id, type: c.group ? 'group' : 'user', count: (snap.messages?.[c.id] || []).length, title: titles[c.id]?.title || '', leader: !!roster.people?.[c.id]?.protected }));
    return { groups: rows.filter(r => r.type === 'group'), people: rows.filter(r => r.type === 'user') };
  }
  cachedTargets(owner, hasRows) {
    try {
      const saved = this.legacy.read(owner, 'targets-cache.json', null);
      if (saved && Array.isArray(saved.groups) && (saved.groups.length || saved.people?.length)) return { at: saved.at || 0, groups: saved.groups, people: saved.people || [] };
    } catch { /* 缓存坏了就当没有 */ }
    try {
      const a = this.assistant();
      // 只翻最近 4 天（含今天）：快照文件带消息正文，可能很大，界面等待时每 5 秒会来读一次。
      for (const day of (a?.snapshotDays?.() || []).slice(0, 4)) {
        const old = a.snapshot(day);
        if (hasRows(old) && old.login?.uid === owner) return { at: old.at || 0, ...this.targetRows(owner, old) };
      }
    } catch { /* 读不到前几天的快照就没有可先显示的 */ }
    return null;
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
    if (fleet.avatars.length) this.armTimer();   // 换了登录账号、新账号下有分身：打开页面时巡检恢复
    const avatars = fleet.avatars.map(av => {
      const st = this.state(owner, av.id), stats = st.stats.day === this.today() ? st.stats : {}, open = Object.values(st.items).filter(i => INBOX.has(i.state));
      for (const item of open) items.push({ ...item, avatarId: av.id, avatarName: av.name, prefixed: !!F.TEMPLATES[av.tpl]?.prefixed, prefix: av.prefix, flags: [...new Set([...(item.flags || []), ...R.decide(item, roster).flags])] });
      const working = Object.values(st.items).filter(i => ['new', 'drafting'].includes(i.state)).length;
      const code = fleet.paused ? 'paused' : !av.enabled ? 'off' : !login.ok ? 'waiting' : st.lastError ? 'error' : 'on';
      return { ...av, state: { code, text: { paused: '已暂停', off: '已暂停', waiting: '等 WeLink 登录', error: '遇到问题', on: this.running.has(av.id) || working ? '处理中' : '运行中' }[code], error: st.lastError || '', providerRepair: st.providerRepair || null }, pending: open.length, working,
        stats: { read: stats.read || 0, model: stats.model || 0, ready: stats.ready || 0, remind: stats.remind || 0, sent: stats.sent || 0 }, memoryLines: st.memoryLines || 0, examples: exampleCount(path.join(this.home(owner, av.id), 'work', 'examples.md')),
        session: { id: st.session?.id || '', alive: this.sessions.alive(st.session?.id), questions: st.session?.questions || 0 }, log: st.log.slice(0, 80),
        owners: Object.fromEntries((av.targets || []).map(t => [t.id, F.ownerOf(fleet.avatars, av, t)])) };
    });
    return { ok: true, available: true, beta: true, paused: fleet.paused, login, snapAt: snap?.at || 0, readError: this.readError, lastError: this.lastError, prep: this.prep, avatars, items: items.sort((x, y) => (y.at || 0) - (x.at || 0)), backends: this.backends() };
  }
}
// 事项里随消息变化的部分（不含状态、草稿、理由）。
function contentOf(c) {
  const { firstKey, lastKey, since, at, count, text, sensitive, auto, hasNonText, onlyNonText, senders, atMe } = c;
  return { firstKey, lastKey, since, at, count, text, sensitive, auto, hasNonText, onlyNonText, senders, atMe };
}
// 按原样编号找事项；找不到再认同会话、首条是同一条消息（四舍五入写法）的旧事项。
function findItem(items, c) { return items[c.id] || Object.values(items).find(x => x.conv === c.conv && x.state !== 'moved' && D.sameMsgKey(x.firstKey, c.firstKey)) || null; }
function findMessageId(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return '';
  for (const k of ['msgId', 'msg_id', 'messageId', 'message_id']) if (v[k] != null && String(v[k])) return String(v[k]);
  for (const x of Object.values(v)) { const hit = findMessageId(x, depth + 1); if (hit) return hit; }
  return '';
}
function exampleCount(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }

module.exports = { FleetService, findMessageId, TICK_MS };
