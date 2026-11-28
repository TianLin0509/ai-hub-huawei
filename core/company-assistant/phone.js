'use strict';
// 手机 WeLink 对话（2026-10-18 用户定）：手机上永远只和公司「助理」说话，助理用 hub-tools.js 的工具去管其他会话。
//   收：每 6 秒查一次这个群的新消息，与其他 Hub 请求共用队列，避免叠加请求触发限流。
//   发：Hub 只往这个群发文字（welink.js 的 sendAllowed 只放行选定的群号）；助理会话本身仍然只读、不发消息。
//   防误触发（借鉴同事的 WeRemoteControl）：只认本人账号发的；Hub 自己发的都带「【助理】」开头并记下，不当成指令；
//     同一条只处理一次；超过 120 秒的旧消息不执行（Hub 重启时不补跑积压）；每分钟最多 20 条。
//   推送：助理发过话、新建的会话（或让它盯的）答完或卡住时推到群里；其他会话卡住时也推，但电脑前 5 分钟内有人操作就不推。
// 2026-11-27 可选「WeLink 私聊助理（beta）」（welink-bot.js）：用户主动点「绑定到 WeLink」扫码后才启用，手机上私聊这个助手即可，不用建群；
//   没绑定的用户一切照旧（专用群方式、设置内容、网络请求都和以前一样）。网关主动推消息过来，不用轮询。
// 2026-11-27 回落：选了私聊助理但它离线超过 2 分钟、且以前配过专用群时，临时改回群轮询（60 秒一次）；私聊助理一恢复就停。
//   切换时往群里推一行；回落期间群里问的只回群里，私聊里问的仍只回私聊（不互相串）。
const crypto = require('node:crypto');
const welink = require('./welink');
const { FALLBACK_POLL_MS, OFFLINE_TEXT, RECOVERED_TEXT, quietGapMs } = require('../welink-native/fallback');
const BOT_DOWN_MS = 2 * 60000, BOT_QUEUE_MAX = 20, BOT_QUEUE_TTL_MS = 2 * 3600000, SESSION_LIST_TTL_MS = 30 * 60000;

const PREFIX = '【助理】';
const DEFAULT_PHONE = Object.freeze({ enabled: false, groupId: '', groupName: '', pushWatched: true, pushStuck: true, since: 0, extraIds: Object.freeze([]) });
const POLL_MS = 6000, WATCH_TICK_MS = 10000;
const FRESH_MS = 120000, RATE_PER_MIN = 20, CHUNK = 1500, ACK_MS = 20000, AT_DESK_S = 300, WATCH_TTL_MS = 24 * 3600000;
const PHONE_NOTE = '（这句是我在手机 WeLink 上发的，你的回答会由 Hub 发回我手机：先说结论，尽量 300 字以内，不用表格。）';
// 手机页「回答风格：完整」（2026-11-27，默认仍是简洁）：不限字数，只要求手机上好读。
const PHONE_NOTE_FULL = '（这句是我在手机 WeLink 上发的，你的回答会由 Hub 发回我手机：先说结论，再把理由和细节完整讲清楚，分段写，不用表格。）';
const NON_TEXT_HINT = '现在只看得懂文字消息，图片和文件请在电脑上处理。';
// 手机上的斜杠命令（借鉴 CodeAgent /welink）：没识别的斜杠开头的话照常当问题交给助理。
const COMMANDS_HELP = ['可用命令：', '/new 开始新话题（不再带前面的对话）', '/model 看助理用的模型，/model 2 改用第 2 个', '/dir 看工作目录', '/session 列出 Hub 里的会话，/session 2 接着做XX 把话交给第 2 个会话', '/help 看这份说明'].join('\n');
const WELCOME = '手机对话已接通。在这个群里直接跟我说话就行，例如「现在有哪些会话在跑？」「让某某会话接着做，做完告诉我」。会话做完或卡住时我也会在这里提醒你。';

function normalizeExtraIds(value) {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\r\n]+/) : [];
  return [...new Set(entries.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))];
}
const EMPLOYEE_ID = /^[a-zA-Z]?([0-9]{8})$/;
function validateExtraIds(value) {
  if (value != null && typeof value !== 'string' && !Array.isArray(value) || Array.isArray(value) && value.some(x => typeof x !== 'string'))
    throw new Error('额外账号请填写 8 位数字工号，不要带字母；多个工号用换行或逗号分隔');
  const ids = normalizeExtraIds(value);
  if (ids.length > 5) throw new Error('额外账号最多填写 5 个');
  const invalid = ids.filter(id => !/^[0-9]{8}$/.test(id));
  if (invalid.length) throw new Error(`额外账号格式不正确：${invalid.map(id => `「${id.slice(0, 40)}」`).join('、')}。请只填写 8 位数字工号，不要带字母，前导零要保留`);
  return ids;
}
// 手机收消息和群成员展示共用；别名只用于匹配，不改登录身份。
function isOwnAccount(account, uid, extraIds = []) {
  const sender = String(account ?? '').trim();
  const automatic = String(uid ?? '').trim();
  if (automatic && sender === automatic) return true;
  const ids = normalizeExtraIds(extraIds);
  if (ids.includes(sender)) return true; // 兼容此前已保存的账号写法。
  const digits = EMPLOYEE_ID.exec(sender)?.[1];
  // 仅手动授权列表兼容带字母/不带字母的写法；空列表仍按真实 UID 精确匹配。
  return !!digits && ids.some(id => EMPLOYEE_ID.exec(id)?.[1] === digits);
}

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// 截短但保留换行（推到手机的会话回答要分段好读）。
const clip = (s, n) => { s = String(s ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const digest = t => crypto.createHash('sha256').update(String(t || '').replace(/\s+/g, '')).digest('hex').slice(0, 16);
// 手机上看 Markdown 符号很乱：去掉加粗、标题井号、代码围栏，保留换行和列表。
function plain(md) {
  return String(md || '').replace(/\r/g, '').replace(/^```[^\n]*\n?/gm, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1（$2）').replace(/\n{3,}/g, '\n\n').trim();
}
// 长回答按段落切成几条（单条上限没实测过，按 1500 字保守切）。
function chunks(text, max = CHUNK) {
  const out = []; let cur = '';
  for (const para of String(text || '').split(/\n/)) {
    let p = para;
    while (p.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(p.slice(0, max)); p = p.slice(max); }
    if ((cur ? cur.length + 1 : 0) + p.length > max) { out.push(cur); cur = p; } else cur = cur ? cur + '\n' + p : p;
  }
  if (cur.trim()) out.push(cur);
  return out.filter(x => x.trim());
}

class PhoneChannel {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.now = assistant.now;
    this.timers = []; this.polling = false; this.watching = false; this.outbox = Promise.resolve(); this.backoffUntil = 0;
    // 2026-11-20 运行时风暴排查：每 6 秒起一次 welink-cli，开着手机对话就是每小时约 600 次。群里安静久了放慢：
    // 10 分钟没有新消息（谁发的都算）、Hub 也没往群里发，改 15 秒一查；30 分钟改 30 秒；一有新消息或 Hub 发了话立刻回到 6 秒。
    this.lastTalkAt = this.now(); this.lastPollStartAt = 0;
    this.botDownSince = 0; this.fallingBack = false;
  }
  settings() { return { ...DEFAULT_PHONE, ...(this.a.settings().phone || {}) }; }
  // 手机提问附带的说明：默认简洁；用户在手机页选了「完整」才放开字数。
  askNote(p = this.settings()) { return p.style === 'full' ? PHONE_NOTE_FULL : PHONE_NOTE; }
  // 接通方式：只有用户自己绑定并选了私聊助理（transport 存成 'bot'）才走私聊；其余一律是原来的专用群方式。
  transport(p = this.settings()) { return p.transport === 'bot' ? 'bot' : 'group'; }
  viaBot(p = this.settings()) { return this.transport(p) === 'bot'; }
  active() { const p = this.settings(); return !!(p.enabled && (this.viaBot(p) ? this.a.bot?.hasCred() : p.groupId)); }
  peekChannel(p = this.settings()) {
    if (!this.active()) return 'off';
    if (!this.viaBot(p)) return 'group';
    // 私聊助理此刻已经连上，就算巡检还没来得及切回，也按私聊算（不再执行群里的话、提醒不再发群）。
    return this.fallingBack && p.groupId && this.a.bot?.status?.().phase !== 'ready' ? 'group-fallback' : 'bot';
  }
  // 巡检（poll 每 6 秒调一次）：更新「私聊助理从什么时候起不在线」，满 2 分钟切入回落、恢复切回；切换时往群里推一行，
  // 恢复时补发排队的私聊消息。有写盘和推群，所以只在巡检里调，状态页用 peekChannel。
  channel(p = this.settings()) {
    if (!this.active()) { this.botDownSince = 0; this.fallingBack = false; return 'off'; }
    if (!this.viaBot(p)) { this.fallingBack = false; return 'group'; }
    const ready = this.a.bot?.status?.().phase === 'ready';
    if (ready) this.botDownSince = 0; else if (!this.botDownSince) this.botDownSince = this.now();
    const fallback = !!p.groupId && !ready && this.now() - this.botDownSince >= BOT_DOWN_MS;
    if (fallback !== this.fallingBack) {
      this.fallingBack = fallback;
      // 切入回落：从「现在」起收，只执行这之后发到群里的话（离线前和私聊期间群里的旧消息不补执行）。
      if (fallback) { this.fallbackSince = this.now(); this.save({ cursor: '', cursorGroup: '' }); }
      if (p.groupId) void this.send(fallback ? OFFLINE_TEXT : RECOVERED_TEXT, 'info', p.groupId);
    }
    if (ready && (this.state().botQueue || []).length) this.flushBotQueue();
    return fallback ? 'group-fallback' : 'bot';
  }
  // 私聊助理离线时没发出去的私聊消息（私聊里问的回答、没有群可回落时的提醒）：排队等它恢复再发。
  // 丢弃策略：最多留 20 条、超过 2 小时的不再发（过时的回答和提醒发出去反而误导），丢掉的在往来里记一行。
  queueBot(body, kind, entry) {
    const now = this.now();
    this.update(cur => ({ botQueue: [...(cur.botQueue || []), { body, kind, entry: entry || null, at: now }].slice(-BOT_QUEUE_MAX) }));
  }
  flushBotQueue() {
    const now = this.now(), all = this.state().botQueue || [];
    this.save({ botQueue: [] });
    const fresh = all.filter(x => now - x.at <= BOT_QUEUE_TTL_MS);
    if (all.length > fresh.length) this.note('out', `私聊助理离线期间有 ${all.length - fresh.length} 条超过 2 小时，没再发`, 'stale');
    for (const x of fresh) void this.sendBot(x.body, x.kind, x.entry);
  }
  state() { return { cursor: '', cursorGroup: '', me: '', meAt: 0, sent: [], seen: [], inbound: [], log: [], watches: {}, stuck: {}, pending: {}, lastPollAt: null, lastOkAt: null, lastError: '', groupCheck: null, ...this.a.read('phone.json', {}) }; }
  save(patch) { const s = { ...this.state(), ...patch }; this.a.write('phone.json', s); return s; }
  // 读、改、存一气呵成（中间没有 await）：收消息、盯会话、助理工具三处都会改这份状态，不能拿旧副本覆盖别人的改动。
  update(fn) { return this.save(fn(this.state())); }
  note(dir, text, kind = '') {
    const st = this.state();
    this.save({ log: [{ at: this.now(), dir, kind, text: short(text, 300) }, ...st.log].slice(0, 40) });
    this.a.changed();
  }

  start() {
    if (this.deps.noTimer) return;
    this.timers.push(setInterval(() => { void this.poll().catch(() => {}); }, POLL_MS));
    this.timers.push(setInterval(() => { void this.watchTick().catch(e => console.warn('[company-phone] watch', e.message)); }, WATCH_TICK_MS));
  }
  close() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  // 私聊身份更严（审查复核 #5）：只认登录守护此刻确认在线的账号，不用快照和 1 小时缓存兜底；
  //   没有登录守护的场合（单测）才看快照。
  async meStrict() {
    const auth = this.a.auth?.status?.();
    if (this.a.auth) {
      if (auth?.state === 'online' && auth.login?.ok && auth.login.uid) return auth.login.uid;
      throw new Error('WeLink 命令行没有确认在线，私聊暂停');
    }
    const snap = this.a.snapshot();
    if (snap?.login?.ok && snap.login.uid) return snap.login.uid;
    throw new Error('WeLink 没登录');
  }
  // 本人账号：取数时 auth status 读到的 UID；群里只有它发的消息才交给助理。
  async me() {
    // R32 换过工号：命令行还登着旧账号时不认旧账号（缓存的也不认），等本人在助理页重新登录。
    const auth = this.a.auth?.status?.();
    if (auth?.state === 'account-mismatch') throw new Error('WeLink 命令行还登着旧账号，手机对话暂停；在助理页点「重新登录」后自动恢复');
    // 刚重新登录：登录守护里已是新账号，快照和 1 小时缓存可能还是旧的，以守护为准（审查 #6）。
    if (auth?.state === 'online' && auth.login?.ok && auth.login.uid) {
      if (this.state().me !== auth.login.uid) this.save({ me: auth.login.uid, meAt: this.now() });
      return auth.login.uid;
    }
    const snap = this.a.snapshot();
    if (snap?.login?.ok && snap.login.uid) return snap.login.uid;
    const st = this.state();
    if (st.me && this.now() - st.meAt < 3600000) return st.me;
    const r = await this.a.welink(['auth', 'status'], { priority: 'phone' });
    const login = welink.loginState(r.stdout + '\n' + r.stderr);
    if (!login.ok || !login.uid) throw new Error('WeLink 没登录或登录过期，手机对话暂停；在助理页扫码登录后自动恢复');
    this.save({ me: login.uid, meAt: this.now() });
    return login.uid;
  }

  // ---- 收 ----
  async poll() {
    const channel = this.channel();
    if (channel === 'off' || channel === 'bot') { this.wasActive = false; return; }
    if (!this.wasActive) { this.wasActive = true; this.lastTalkAt = this.now(); } // 刚开启手机对话：从正常节奏起步，不沿用 Hub 启动以来的安静时长
    if (this.polling || this.now() < this.backoffUntil) return;
    const fallback = channel === 'group-fallback', groupOut = fallback ? this.settings().groupId : '';
    const gap =fallback ? FALLBACK_POLL_MS : quietGapMs(this.now() - this.lastTalkAt);
    if (gap && this.now() - this.lastPollStartAt < gap - 500) return;
    this.lastPollStartAt = this.now();
    this.polling = true;
    const p = this.settings(), now = this.now();
    try {
      const me = await this.me();
      const st = this.state();
      const fresh = st.cursorGroup !== p.groupId || !st.cursor;
      const args = ['im', 'query-history-message', '--group-id', p.groupId, '--query-count', fresh ? '10' : '30'];
      // help 里写 0 是更新的，公司实测正好相反：1 才是「比这条更新的」（Q-1018-04 第 2 轮）。
      if (!fresh) args.push('--message-id', st.cursor, '--query-direction', '1');
      const r = await this.a.welink(args, { timeoutMs: 20000, priority: 'phone' });
      if (this.peekChannel() !== channel) return;
      const list = welink.groupMessages(r.stdout);
      if (list == null) throw new Error(short(r.stderr || r.stdout || 'welink-cli 没有输出', 160));
      const cursor = fresh ? null : BigInt(st.cursor);
      const seen = new Set(st.seen), sent = st.sent.filter(x => now - x.at < 30 * 60000);
      let inbound = st.inbound.filter(t => now - t < 60000), top = cursor, throttled = false;
      const added = {};
      for (const m of list) {
        if (top === null || m.n > top) top = m.n;
        if ((cursor !== null && m.n <= cursor) || seen.has(m.id)) continue;
        seen.add(m.id);
        if (!fresh || (m.at && now - m.at < FRESH_MS)) this.lastTalkAt = this.now(); // 首次取历史时只认 2 分钟内的新消息
        const text = m.text.trim();
        if (!text) continue;
        // 小微助手和别人的消息不理；记在往来里并写明发件账号：真机上要是本人账号和发件人格式对不上，一眼能看出来。
        if (!isOwnAccount(m.sender, me, p.extraIds)) { this.note('in', `${short(text, 40)}（${m.sender || '未知账号'} 发的，你的账号是 ${me}）如果这是你本人，可在手机设置里添加该账号。`, 'other'); continue; }
        if (text.startsWith(PREFIX) || sent.some(x => x.hash === digest(text))) continue; // Hub 自己发出去的
        // 只认开启（或换群）之后发的，关掉期间发的重新开启后也不补执行；平时超过 120 秒的旧消息不执行（时间以 WeLink 服务器为准）。
        if (m.at ? m.at < (p.since || 0) : fresh) continue;
        if (fallback && m.at && m.at < (this.fallbackSince || 0)) continue; // 回落前发到群里的不补执行
        if (m.at && now - m.at > FRESH_MS) { this.note('in', text, 'stale'); continue; }
        if (m.type && !/TEXT/i.test(m.type)) { this.note('in', '（' + m.type + '）', 'unsupported'); void this.send(NON_TEXT_HINT, 'info', groupOut); continue; }
        if (inbound.length >= RATE_PER_MIN) { if (!throttled) { throttled = true; void this.send(`一分钟内超过 ${RATE_PER_MIN} 条，先歇一下，这条没处理。`, 'info', groupOut); } this.note('in', text, 'throttled'); continue; }
        inbound.push(now);
        this.note('in', text);
        if (this.command(text, reply => this.send(reply, 'info', fallback ? p.groupId : ''), { group: fallback ? p.groupId : '' })) continue;
        const item = this.a.ask(text, { via: 'phone' });
        added[item.id] = { at: now, acked: false, ...(fallback ? { group: p.groupId } : {}) };
        this.update(cur => ({ pending: { ...cur.pending, ...added } }));
      }
      this.save({ cursor: top === null ? '' : String(top), cursorGroup: p.groupId, seen: [...seen].slice(-300), inbound, lastPollAt: now, lastOkAt: now, lastError: '' });
      this.backoffUntil = 0;
    } catch (error) {
      this.save({ lastPollAt: now, lastError: error.message });
      this.backoffUntil = this.now() + 60000; // 出错（多半是登录过期）时一分钟后再试
      this.a.changed();
    } finally { this.polling = false; }
  }

  // 专属助手收到私聊（网关推来的，不用轮询）。只认本人：用 WeLink 登录账号确认（与群方式同一套）；
  //   读不到登录账号或账号对不上时一律不执行，只记一行（2026-11-27 审查：不再认「第一个说话的人」，也不沿用旧主人）。
  async receive({ text, sender, entry, messageId, nonText = false }) {
    if (!this.active() || !this.viaBot()) return;
    const p = this.settings(), body = String(text || '').trim();
    if (!body && !nonText) return;
    const bot = this.a.bot, gen = bot.gen;
    // 路由在第一次等待之前就记下：连着两条消息时，各自的回答回到各自那一轮。
    const r0 = entry && bot.state().routes[entry], route = r0 ? { tsid: r0.tsid, wsid: r0.wsid } : null;
    // 网关重投同一条消息只执行一次。
    if (messageId) { const seen = this.state().botSeen || []; if (seen.includes(messageId)) return; this.save({ botSeen: [...seen, messageId].slice(-200) }); }
    let login = '';
    try { login = await this.meStrict(); } catch { login = ''; /* 没确认在线、账号对不上：都不执行 */ }
    if (bot.gen !== gen || !this.active() || !this.viaBot()) return; // 查身份期间关掉了：这条不再执行
    const bs = bot.state();
    const owner = login || '';
    if (login && bs.owner !== login) bot.save({ owner: login });
    if (!owner || !isOwnAccount(sender, owner, p.extraIds)) { this.note('in', `${short(body, 40)}（${sender || '未知账号'} 发的，${owner ? '你的账号是 ' + owner : '还确认不了你的账号：在助理页登录 WeLink 后自动恢复'}）如果这是你本人，可在下面添加该账号。`, 'other'); return; }
    if (entry) bot.save({ last: entry });
    const now = this.now(), st = this.state();
    const inbound = st.inbound.filter(t => now - t < 60000);
    if (inbound.length >= RATE_PER_MIN) { this.note('in', body, 'throttled'); void this.sendBot(`一分钟内超过 ${RATE_PER_MIN} 条，先歇一下，这条没处理。`, 'info', entry); return; }
    inbound.push(now);
    this.save({ inbound, lastPollAt: now, lastOkAt: now, lastError: '' });
    if (!body) { this.note('in', '（不是文字）', 'unsupported'); void this.sendBot(NON_TEXT_HINT, 'info', route || entry); return; }
    this.note('in', body);
    if (this.command(body, reply => this.sendBot(reply, 'info', route || entry), { route })) return;
    const item = this.a.ask(body, { via: 'phone' });
    // 记下这一问从哪个对话来：回答回到原对话，不跟着「最近私聊」跑。
    this.update(cur => ({ pending: { ...cur.pending, [item.id]: { at: now, acked: false, ...(route ? { entry: route } : {}) } } }));
  }

  // ---- 斜杠命令 ----
  // 认出就回一行并返回 true；不是命令（或不认识的斜杠命令）返回 false，照常交给助理。
  command(text, reply, { group = '', route = null } = {}) {
    const m = /^\/(new|clear|model|dir|session|sessions|help)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
    if (!m) return false;
    const name = m[1].toLowerCase(), arg = String(m[2] || '').trim();
    try {
      if (name === 'help') { void reply(COMMANDS_HELP); return true; }
      if (name === 'new' || name === 'clear') {
        this.save({ resetAt: this.now() });
        void reply('好，接下来是新话题，不再带前面的对话。');
        return true;
      }
      if (name === 'dir') {
        const wd = this.a.userWorkDir?.() || {};
        void reply([`助理的工作目录：${this.a.dir || '（未知）'}`, `你的工作目录：${wd.path || (wd.missing ? `之前选的 ${wd.missing} 已不存在` : '还没有（可在助理设置里选）')}`].join('\n'));
        return true;
      }
      if (name === 'model') return this.modelCommand(arg, reply);
      return this.sessionCommand(arg, reply, { group, route });
    } catch (error) {
      void reply(`${'/' + name} 没办成：${short(error.message, 120)}`);
      return true;
    }
  }
  modelCommand(arg, reply) {
    if (typeof this.a.modelSettings !== 'function') return false;
    const info = this.a.modelSettings('personal'), C = require('../codeagent-model-choice');
    const options = (info.options || []).slice(0, 12), cur = info.choice?.model || '';
    // 同名模型可能挂在不同供应商下：「当前」要模型和供应商都对上（没记供应商的旧选择只比模型）。
    const curProvider = info.choice?.codeagentModelProvider || '';
    const isCur = o => o.id === cur && (!curProvider || (o.provider || '') === curProvider);
    if (!arg) {
      const list = options.map((o, i) => `${i + 1}. ${o.label || o.id}${isCur(o) ? '（当前）' : ''}`);
      void reply([cur ? `助理现在用：${cur}` : '助理现在用默认模型', ...(list.length ? ['可选：', ...list, '回「/model 编号」改用'] : ['还没有可选的模型清单，在电脑上的助理设置里看'])].join('\n'));
      return true;
    }
    const hit = options[Number(arg) - 1] || options.find(o => o.id === arg);
    if (!hit) { void reply(`没有「${short(arg, 30)}」这个选项，回 /model 看清单`); return true; }
    this.a.setModelChoice({ account: 'personal', value: C.choiceValue(hit) });
    void reply(`好，之后改用 ${hit.label || hit.id}（正在答的这一问不受影响）。`);
    return true;
  }
  sessionCommand(arg, reply, { group = '', route = null } = {}) {
    const tools = this.a.tools;
    if (!tools || typeof tools.rows !== 'function') { void reply('现在看不到 Hub 会话列表'); return true; }
    const STATE = { running: '在跑', stuck: '卡住等你', reply: '等你回复', idle: '空闲', closed: '已关闭' };
    const label = r => r.label || STATE[r.state] || '状态未知';
    // 只列、只认此刻打开着的会话：编号不会指到早已休眠或关掉的会话上。
    const rows = tools.rows({ closed: 0 }).filter(r => r.open !== false).slice(0, 10);
    const n = /^(\d{1,2})(?:\s+([\s\S]+))?$/.exec(arg);
    if (!n) {
      this.save({ sessionList: rows.map(r => r.id), sessionListAt: this.now() });
      void reply(rows.length ? ['Hub 里的会话：', ...rows.map((r, i) => `${i + 1}. ${short(r.title || r.id, 30)}（${label(r)}）`), '回「/session 编号 要它做的事」交给那个会话（清单 30 分钟内有效）'].join('\n') : 'Hub 里现在没有打开的会话');
      return true;
    }
    // 编号对应的是上次 /session 列出的清单；超过 30 分钟就作废，免得隔天按旧编号指错会话。
    const st = this.state();
    if (!st.sessionList || this.now() - (Number(st.sessionListAt) || 0) > SESSION_LIST_TTL_MS) { void reply('会话清单过期了（超过 30 分钟），先回 /session 看最新的'); return true; }
    const id = st.sessionList[Number(n[1]) - 1], r = id && rows.find(x => x.id === id);
    if (!r) { void reply('没有这个编号，或那个会话已经关掉了，先回 /session 看最新清单'); return true; }
    if (!n[2]) { void reply(`第 ${n[1]} 个是「${short(r.title || r.id, 40)}」（${label(r)}）。回「/session ${n[1]} 要它做的事」交给它`); return true; }
    // 接续交给助理用会话工具办（推进、盯着、做完推回手机），和直接说「让某某会话接着做」走同一条路。
    const item = this.a.ask(`请让会话「${r.title || r.id}」（会话编号 ${r.id}）接着做下面这件事，做完或卡住时告诉我：\n${n[2].trim()}`, { via: 'phone' });
    const now = this.now();
    this.update(cur => ({ pending: { ...cur.pending, [item.id]: { at: now, acked: false, ...(route ? { entry: route } : {}), ...(group ? { group } : {}) } } }));
    return true;
  }

  // ---- 发 ----
  send(text, kind = 'answer', targetGroup = '') {
    const p = this.settings();
    if (!targetGroup && this.viaBot(p)) { if (this.peekChannel(p) === 'group-fallback') targetGroup = p.groupId; else return this.sendBot(text, kind); }
    if (targetGroup) p.groupId = targetGroup;
    if (!p.groupId) return Promise.resolve(false);
    const parts = chunks(plain(text));
    this.lastTalkAt = this.now();
    this.outbox = this.outbox.then(async () => {
      for (let i = 0; i < parts.length; i += 1) {
        const body = PREFIX + (parts.length > 1 ? `（${i + 1}/${parts.length}）` : '') + parts[i];
        try {
          const r = await this.a.welink(['im', 'send-to-group', '--group-id', p.groupId, '--text', body], { sendGroup: p.groupId, timeoutMs: 30000, priority: 'phone' });
          if (r.code !== 0) throw new Error(short(r.stderr || r.stdout || '发送命令失败', 160));
          const receipt = welink.parseJson(r.stdout), code = receipt?.code ?? receipt?.resultCode ?? receipt?.error?.error_code;
          if (receipt?.ok === false || receipt?.success === false || code !== undefined && !['0', '200'].includes(String(code)))
            throw new Error(short(receipt?.error?.error_msg || receipt?.message || receipt?.resultContext || `发送业务码 ${code}`, 160));
          this.update(cur => ({ sent: [...cur.sent.filter(x => this.now() - x.at < 30 * 60000), { hash: digest(body), at: this.now() }].slice(-100) }));
          this.note('out', body, kind);
        } catch (error) {
          this.save({ lastError: '发到手机没成功：' + error.message });
          this.note('out', body, 'failed');
          return false;
        }
      }
      return true;
    }).catch(() => false);
    return this.outbox;
  }
  // 专属助手：私聊里的消息天然分得清谁发的，不用加「【助理】」前缀。助手只能回到用户私聊过的对话，没说过话之前发不出去。
  sendBot(text, kind, entry = null) {
    const parts = chunks(plain(text));
    this.outbox = this.outbox.then(() => {
      for (let i = 0; i < parts.length; i += 1) {
        const body = (parts.length > 1 ? `（${i + 1}/${parts.length}）` : '') + parts[i];
        if (!this.a.bot?.reply(entry, body)) {
          const bs = this.a.bot?.status() || {};
          // 私聊助理没连上：这条和后面几段排队，等恢复再发（不丢、不串到群里）。
          if (bs.phase !== 'ready' && (entry || bs.talked)) {
            for (let j = i; j < parts.length; j += 1) this.queueBot((parts.length > 1 ? `（${j + 1}/${parts.length}）` : '') + parts[j], kind, entry);
            this.note('out', body, 'queued');
            return false;
          }
          this.save({ lastError: bs.phase !== 'ready' ? '私聊助理还没连上 WeLink，连上后再发' : '还没在 WeLink 上和私聊助理说过话：先私聊它一句，之后就能收到提醒' });
          this.note('out', body, 'failed');
          return false;
        }
        this.note('out', body, kind);
      }
      return true;
    }).catch(() => false);
    return this.outbox;
  }
  // 手机问的那句答完（或没答上）：把回答发回群里。
  // silent：关助理时停下的这一问只撤掉待回、不往手机发（R66）。
  settle(item, { silent = false } = {}) {
    const p = item && this.state().pending[item.id];
    if (!p) return;
    this.update(cur => { const pending = { ...cur.pending }; delete pending[item.id]; return { pending }; });
    if (silent) return;
    const text = item.state === 'done' ? item.phoneText || item.a : '这句没答上：' + short(item.error || '原因不明', 120) + '。可以再说一次。';
    const kind = item.state === 'done' ? 'answer' : 'error';
    // 私聊里问的只回私聊：答完前改回了专用群，这条不往群里发（群里的人看不到上下文，也可能不止本人），只记一行。
    if (p.entry) { if (this.viaBot()) void this.sendBot(text, kind, p.entry); else this.note('out', text, 'failed'); return; }
    // 回落期间在群里问的：回答回到群里（私聊助理这时多半还没恢复）。
    void this.send(text, kind, p.group || '');
  }

  // ---- 盯会话 ----
  watch(id, { baseline = null, title = '', why = '' } = {}) {
    this.update(cur => ({ watches: { ...cur.watches, [id]: { at: this.now(), baseline, title, why } } }));
  }
  // 没开手机对话时（5.6.2）：盯着的会话做完或卡住改弹电脑桌面通知；「没盯的会话卡住」只推手机，电脑上 Hub 本身已有提示。
  async watchTick() {
    const phone = this.active();
    if (this.watching || (!phone && !Object.keys(this.state().watches).length)) return;
    this.watching = true;
    try {
      const p = { ...this.settings(), ...(phone ? {} : { pushWatched: true, pushStuck: false }) }, now = this.now();
      let ack = 0; const ackGroups = new Set();
      this.update(cur => {
        const pending = { ...cur.pending };
        for (const [id, x] of Object.entries(pending)) {
          if (now - x.at > 30 * 60000) delete pending[id];
          else if (!x.acked && now - x.at > ACK_MS) { pending[id] = { ...x, acked: true }; if (x.group) ackGroups.add(x.group); else ack += 1; }
        }
        return { pending };
      });
      if (ack) void this.send('收到，正在处理…', 'ack');
      for (const g of ackGroups) void this.send('收到，正在处理…', 'ack', g);
      const tools = this.a.tools, st = this.state();
      const watches = { ...st.watches }, stuck = { ...st.stuck }, dropped = new Set();
      if (tools) {
        const rows = tools.rows({ closed: 0 }), byId = new Map(rows.map(r => [r.id, r]));
        for (const [id, w] of Object.entries(watches)) {
          if (now - w.at > WATCH_TTL_MS) { dropped.add(id); continue; }
          const r = byId.get(id);
          if (!r || r.state === 'running') continue;
          if (r.state === 'stuck') { if (p.pushWatched) await this.pushStuck(r, stuck); continue; }
          const final = tools.lastFinal(id);
          if (final && final.id !== w.baseline && String(final.text || '').trim()) {
            dropped.add(id);
            if (p.pushWatched) void this.tell(`「${r.title}」这一轮答完了：\n${clip(plain(final.text), 600)}`, 'done', r);
          }
        }
        const idle = typeof this.deps.systemIdleSeconds === 'function' ? Number(this.deps.systemIdleSeconds()) : Infinity;
        if (p.pushStuck && idle >= AT_DESK_S) for (const r of rows) if (r.state === 'stuck' && !watches[r.id]) await this.pushStuck(r, stuck);
        for (const id of Object.keys(stuck)) if (byId.get(id)?.state !== 'stuck') delete stuck[id];
      }
      // 期间助理可能又盯上了别的会话：以最新状态为底，只删这一轮处理掉的。
      this.update(cur => { const next = { ...cur.watches }; for (const id of dropped) if (next[id] && next[id].at <= (watches[id]?.at ?? Infinity)) delete next[id]; return { watches: next, stuck }; });
    } finally { this.watching = false; }
  }
  // 推给用户：手机对话开着发手机群，没开发到提醒总线（桌面通知、桌宠）。
  tell(text, kind, r) {
    if (this.active()) return this.send(text, kind, this.peekChannel() === 'group-fallback' ? this.settings().groupId : ''); // 回落期间发群
    const cut = text.indexOf('\n');
    return this.a.bus?.publish({ id: `session-${kind}:${r.id}:${this.now()}`, kind: 'session', notify: true, title: cut < 0 ? text : text.slice(0, cut), text: cut < 0 ? '' : text.slice(cut + 1) });
  }
  async pushStuck(r, stuck) {
    if (stuck[r.id]) return;
    stuck[r.id] = this.now();
    const screen = await this.a.tools.screen(r.id);
    const tail = (screen || []).filter(l => l.trim()).slice(-10).join('\n');
    void this.tell(`「${r.title}」卡住了，在等你：\n${r.waitingText || tail || '（看不到终端画面）'}\n\n直接回我怎么处理就行，例如「${short(r.title, 10)} 选 1」或「先停下」。`, 'stuck', r);
  }

  // ---- 设置页用 ----
  async checkGroup(groupId = this.settings().groupId) {
    if (!groupId) throw new Error('请先填群 ID');
    const r = await this.a.welink(['im', 'query-group-member', '--group-id', String(groupId)], { timeoutMs: 20000, priority: 'phone' });
    const members = welink.groupMembers(r.stdout);
    if (!members.length && r.code !== 0) throw new Error(short(r.stderr || r.stdout || '没查到群成员', 160));
    let me = ''; try { me = await this.me(); } catch { /* 没登录也能看成员 */ }
    const others = members.filter(m => !isOwnAccount(m.account, me, this.settings().extraIds));
    const check = { at: this.now(), groupId: String(groupId), count: members.length, names: members.map(m => m.name || m.account).slice(0, 10), ok: members.length <= 2,
      note: members.length <= 2 ? '群里只有你和' + (others[0]?.name || '小微助手') + '，可以用。' : `群里有 ${members.length} 个成员（${others.map(m => m.name || m.account).slice(0, 5).join('、')}）。别人也能看到 Hub 发的回答，建议先把同事移出群。` };
    this.save({ groupCheck: check });
    return check;
  }
  status() {
    const p = this.settings(), st = this.state();
    return { settings: p, transport: this.transport(p), channel: this.peekChannel(p), bot: this.a.bot?.status() || null, active: this.active(), lastPollAt: st.lastPollAt, lastOkAt: st.lastOkAt, lastError: st.lastError, log: st.log.slice(0, 15),
      watching: Object.entries(st.watches).map(([id, w]) => ({ id, title: w.title, at: w.at })), pending: Object.keys(st.pending).length, groupCheck: st.groupCheck };
  }
}

module.exports = { POLL_MS, PhoneChannel, DEFAULT_PHONE, PREFIX, PHONE_NOTE, PHONE_NOTE_FULL, NON_TEXT_HINT, WELCOME, plain, chunks, normalizeExtraIds, validateExtraIds, isOwnAccount };
