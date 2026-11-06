'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const D = require('./data');
const { createPriorityMatcher, prioritize } = require('./memory-priority');
const { withWelinkPriority } = require('./welink-gate');
const HOUR = 3600000;
const TTL = HOUR;
function queryRange(args, now) {
  const period = args.period || (args.kind === 'meetings' ? 'today' : 'last24h');
  const day = D.dayKey(now), midnight = Date.parse(day + 'T00:00:00+08:00');
  let start, end;
  if (period === 'today') { start = midnight; end = midnight + 24 * HOUR; }
  else if (period === 'yesterday') { start = midnight - 24 * HOUR; end = midnight; }
  else if (period === 'last24h') { start = now - 24 * HOUR; end = now; }
  else if (period === 'custom') {
    const parse = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) ? D.timeValue(x).at : NaN;
    start = parse(args.start); end = parse(args.end);
  } else throw new Error('period 只能是 today/last24h/yesterday/custom');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 7 * 24 * HOUR) throw new Error('查询范围必须带时区、起点早于终点，单次最多 7 天');
  return { start, end, timeZone: 'Asia/Shanghai', startDisplay: D.displayTime(start), endDisplay: D.displayTime(end), endExclusive: true, period };
}
class AssistantQuery {
  // 查询范围按会话记（5.5.11）：每个问题一个会话，几条队列可能同时在答；工具调用带着调用方会话编号，记到对应的任务上。
  constructor(assistant) { this.a = assistant; this.dir = path.join(assistant.dir, 'queries'); this.pending = null; this.tasks = new Map(); }
  beginTask(id, sessionId) { if (sessionId) this.tasks.set(sessionId, { id, coverage: new Map() }); }
  captureCoverage(queryId, lines, ctx = {}, summary = null) {
    const task = ctx.sessionId && this.tasks.get(ctx.sessionId);
    if (task) task.coverage.set(queryId, { lines, ok: summary ? summary.ok !== false : true, line: summary?.line || '' });
  }
  // 回答不再插「Hub 核实的查询范围」前缀（5.5.11，用户拍板 L1）：范围由页面显示在气泡底部一行；没取全时这一行变橙、不折叠。
  // 手机回答没有页面，由服务在末尾补一句范围。
  finishAnswer(id, text = '', sessionId = null) {
    const key = sessionId || [...this.tasks.entries()].find(([, t]) => t.id === id)?.[0];
    const task = key && this.tasks.get(key);
    if (!task || task.id !== id) return { text, coverage: null, lines: [] };
    this.tasks.delete(key);
    const entries = [...task.coverage.values()];
    if (!entries.length) return { text, coverage: null, lines: [] };
    const ok = entries.every(x => x.ok), lines = entries.flatMap(x => x.lines);
    const shortLines = [...new Set(entries.filter(x => ok || !x.ok).map(x => x.line).filter(Boolean))];
    return { text, lines, coverage: { ok, line: shortLines.slice(0, 2).join('；') || (ok ? '已查询' : '部分数据没取全'), details: lines } };
  }
  file(id) { if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('查询编号无效'); return path.join(this.dir, id + '.json'); }
  owner() { return this.a.auth ? this.a.auth.status()?.login?.uid || null : this.a.snapshot()?.login?.uid || null; }
  ownSnapshot() {
    const snap = this.a.snapshot();
    if (!snap?.login?.uid || snap.login.uid !== this.owner()) throw new Error('快照登录身份与当前账号不一致，请先重新查询');
    return snap;
  }
  load(id) {
    let data; try { data = JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { throw new Error('查询记录不存在，请重新查询'); }
    if (data.expiresAt <= this.a.now()) throw new Error('查询分页已过期，请重新查询以取得一致的数据');
    const owner = this.owner();
    if (!data.owner || !owner || owner !== data.owner) throw new Error('WeLink 登录身份已改变或尚未核实，请重新查询');
    return data;
  }
  save(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(data.id), JSON.stringify(data), 'utf8');
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < Date.now() - TTL) fs.unlinkSync(file); } catch { /* 不影响查询 */ }
    }
  }
  page(data, offset, limit) {
    const items = data.items.slice(offset, offset + limit).map(row => {
      if (data.kind !== 'messages') return row;
      const { content, text, ...small } = row;
      return { ...small, preview: D.short(text || row.preview, 180), textLength: String(text || '').length, readRequired: String(text || '').length > 180 || !text };
    });
    const next = offset + items.length;
    return { queryId: data.id, kind: data.kind, scope: data.scope, range: data.range, capturedAt: data.capturedAt,
      coverage: data.coverage, counts: data.counts, total: data.items.length, offset, items,
      nextCursor: next < data.items.length ? `${data.id}:${next}` : null,
      note: 'nextCursor 非空且需要更多时再翻页；是否查全以 coverage 为准。' };
  }
  async execute(args = {}) {
    const op = args.op || 'list';
    if (op === 'read') {
      const data = args.queryId ? this.load(args.queryId) : null;
      const row = data ? [...data.items, ...(data.context || [])].find(x => x.sourceId === args.sourceId) : D.sourceIndex(this.ownSnapshot()).get(String(args.sourceId))?.item;
      if (!row) throw new Error('这条出处不存在或不属于这次查询；先 list 后用返回的 queryId/sourceId 读取');
      if (!row.sourceId.startsWith('msg:')) return { item: row, note: '时间来自原始字段的统一换算，不自行换算或重写。' };
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), text = String(row.text || (typeof row.content === 'string' ? row.content : JSON.stringify(row.content || '')));
      const { content, ...item } = row;
      return { item: { ...item, text: text.slice(offset, offset + 6000) }, offset, textLength: text.length, nextOffset: offset + 6000 < text.length ? offset + 6000 : null };
    }
    if (op !== 'list') throw new Error('查询操作只能是 list/read');
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)));
    if (args.cursor) {
      const m = /^([a-f0-9-]{36}):(\d+)$/.exec(String(args.cursor));
      if (!m) throw new Error('分页游标无效，请原样使用 nextCursor');
      return this.page(this.load(m[1]), Number(m[2]), limit);
    }
    const kind = args.kind || 'messages';
    if (!['messages', 'meetings'].includes(kind)) throw new Error('kind 只能是 messages/meetings');
    const scope = args.scope || 'private_mentions';
    if (!['all', 'private_mentions', 'private', 'mentions'].includes(scope)) throw new Error('scope 无效');
    const range = queryRange({ ...args, kind }, this.a.now());
    // 多次工具调用顺序取数，避免同一个 CLI/缓存出现并发写入。
    const previous = this.pending, initialOwner = this.owner();
    const work = (async () => { if (previous) await previous.catch(() => {}); return this.a.collectQuery(kind, range); })();
    this.pending = work;
    let snap; try { snap = await work; } finally { if (this.pending === work) this.pending = null; }
    if (snap.login?.ok && (!snap.login.uid || snap.login.uid !== this.owner() || initialOwner && initialOwner !== snap.login.uid))
      throw new Error('取数期间 WeLink 登录身份改变或尚未核实，请重新查询');
    const inRange = at => Number.isFinite(at) && at >= range.start && at < range.end;
    let items, counts, coverage;
    if (kind === 'messages') {
      const all = Object.values(snap.messages || {}).flat().filter(x => inRange(x.at));
      const match = (query, values) => !query || values.some(x => String(x || '').toLowerCase().includes(String(query).toLowerCase()));
      const selected = all.filter(x => scope === 'all' || scope === 'private' && !x.group || scope === 'mentions' && x.group && (x.atMe || x.atAll) || scope === 'private_mentions' && (!x.group || x.atMe || x.atAll))
        .filter(x => !args.categories || !x.group && args.categories.includes('私聊') || x.group && (args.categories.includes('全部群消息') || x.atMe && args.categories.includes('@我') || x.atAll && args.categories.includes('@所有人')))
        .filter(x => match(args.person, [x.sender, x.senderName, x.account, !x.group && x.convName]) && match(args.group, [x.group && x.conv, x.group && x.convName]));
      const memories = this.a.memory?.active() || [], priority = createPriorityMatcher(memories);
      const sources = new Map((snap.scope?.conversations || []).map(conv => [conv.id, conv]));
      items = prioritize(selected.sort((a, b) => a.at - b.at || a.sourceId.localeCompare(b.sourceId)), memories)
        .map(x => ({ ...x, priority: priority(x), timeDisplay: D.displayTime(x.at), dataSource: sources.get(x.conv)?.dataSource,
          capturedAt: sources.get(x.conv)?.capturedAt ?? null, cachedAt: sources.get(x.conv)?.cachedAt ?? null }));
      counts = { all: all.length, private: all.filter(x => !x.group).length, atMe: all.filter(x => x.group && x.atMe).length, atAll: all.filter(x => x.group && x.atAll).length };
      const sc = snap.scope || {}, unknownTime = (sc.conversations || []).reduce((n, c) => n + (c.unknownTime || 0), 0);
      const complete = snap.login?.ok && !sc.partial && !sc.neverFetched && !sc.priorityPending && !sc.limited && (!sc.stale || sc.cached) && !sc.directoryInvalid && !sc.directoryFallback && !unknownTime;
      coverage = { status: complete ? 'complete' : 'partial', discovery: sc.listFull ? 'recent-list-capped' : sc.stale ? 'failed' : 'available-conversations',
        knownConversations: sc.known || sc.listed || 0, scanned: sc.fetched || 0, unknownTime, partialConversations: sc.partial || 0, directoryInvalid: sc.directoryInvalid || 0,
        realtime: sc.realtime || 0, fromCache: sc.fromCache || 0,
        limitation: (sc.queryFallback ? '后台缓存为空，本次改为查询全部可发现会话。' : sc.fromCache ? `本次实时补查变化和置顶会话，其余 ${sc.fromCache} 个会话沿用后台缓存，时间见各会话来源。` : '')
          + (sc.listFull ? `本轮最近会话返回 ${sc.listed || sc.listCap} 个，可能达到接口上限；目录外从未发现的会话无法保证覆盖。` : '')
          + (sc.directoryFallback ? '较大范围查询失败，已退回兼容查询，覆盖仍待核对。' : '')
          + (sc.directoryInvalid ? `${sc.directoryInvalid} 条会话目录记录无法识别，未覆盖对应会话。` : ''),
        details: sc.conversations || [], errors: snap.errors || [] };
    } else {
      const meetings = (snap.meetings || []).filter(x => D.eventInRange(x, range)), calendar = (snap.calendar || []).filter(x => D.eventInRange(x, range));
      items = [...meetings, ...calendar]
        .sort((a, b) => (a.start || Infinity) - (b.start || Infinity));
      const unknownTime = items.filter(D.eventTimeUnknown).length;
      counts = { meetings: meetings.length, calendar: calendar.length, unknownTime };
      coverage = { status: snap.login?.ok && snap.meetingCoverage?.status === 'complete' && snap.calendarCoverage?.status === 'complete' && !unknownTime ? 'complete' : 'partial',
        meeting: snap.meetingCoverage || { status: 'failed' }, calendar: snap.calendarCoverage || { status: 'failed' }, unknownTime, errors: snap.errors || [],
        note: 'WeLink 会议与邮箱日程分别查询；一个源成功不等于另一个源成功。两源记录可能对应同一场会，未证实共享身份前分别保留。日期/时间待核对项不认作确定在此范围内。' };
    }
    const data = { id: randomUUID(), owner: snap.login?.uid || null, capturedAt: this.a.now(), expiresAt: this.a.now() + TTL, kind, scope, range, items, counts, coverage,
      context: kind === 'messages' ? Object.values(snap.messages || {}).flat() : undefined };
    this.save(data);
    return this.page(data, 0, limit);
  }
  localTime(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d)?)?$/.test(text)) return text.slice(0, 10) + 'T' + (text.slice(11) || '00:00:00') + '+08:00';
    return text;
  }
  async inbox(args = {}, ctx = {}) {
    let scope = 'private_mentions';
    const scopes = Array.isArray(args.scope) ? args.scope : ['私聊', '@我', '@所有人'];
    if (scopes.includes('全部群消息')) scope = 'all';
    else if (!scopes.includes('私聊')) scope = 'mentions';
    else if (!scopes.includes('@我') && !scopes.includes('@所有人')) scope = 'private';
    const now = this.a.now(), hours = Number(args.hours ?? 24);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('hours 必须在 0 到 168 之间');
    const end = args.until ? this.localTime(args.until) : new Date(now).toISOString(), endAt = D.timeValue(end).at;
    if (!Number.isFinite(endAt)) throw new Error('查询结束时间无效，请使用实际日期和上海时间');
    const page = await this.execute({ ...args, op: 'list', kind: 'messages', scope, categories: scopes, period: 'custom',
      start: args.since ? this.localTime(args.since) : new Date(endAt - hours * HOUR).toISOString(), end });
    const { coverage: c, range: r } = page;
    const complete = c.status === 'complete';
    const header = `覆盖：${r.startDisplay} 至 ${r.endDisplay}（终点不含，上海时间）；已查 ${c.scanned} 个会话；${complete ? c.fromCache ? '已取得实时及缓存结果，缓存部分本次未实时核对' : '可发现会话的消息已翻页覆盖' : '可能不全'}。${c.limitation || ''}${c.partialConversations ? ` ${c.partialConversations} 个会话未取全。` : ''}${c.unknownTime ? ` ${c.unknownTime} 条时间未确认。` : ''}`;
    const counts = `本次筛选已取到 ${page.total} 条；私聊 ${page.counts.private} 条，群 @我 ${page.counts.atMe} 条，@所有人 ${page.counts.atAll} 条。`;
    const span = args.since ? `${r.startDisplay} 起` : `最近 ${hours} 小时`;
    const errors = c.errors.map(e => `取数问题：${e.label} ${e.text}`);
    this.captureCoverage(page.queryId, [header, counts, ...errors], ctx, complete
      ? { ok: true, line: `${span} · ${c.scanned} 个会话 · ${page.total} 条` }
      : { ok: false, line: c.partialConversations ? `有 ${c.partialConversations} 个会话没取全，可能漏了消息` : `${span}的消息可能不全` });
    // 每条一行，不再附整份会话清单（5.5.11：每页省 1–2 万字）；采集方式和时间在范围说明里。
    const lines = page.items.map(m => `${m.priority ? '★ ' : ''}${m.group ? (m.atMe ? '群@我' : m.atAll ? '群@所有人' : '群') : '私聊'}「${D.short(m.convName, 20)}」${D.clock(m.at)} ${m.sender}：${D.short(m.preview, 100)} [${m.sourceId}]${m.dataSource && m.dataSource !== 'realtime' ? `（缓存；采集时间 ${Number.isFinite(m.capturedAt) ? D.clock(m.capturedAt) : '未知'}）` : ''}${m.readRequired ? '（长，需读全文）' : ''}`);
    this.a.memory?.touch(JSON.stringify({ person: args.person, group: args.group }));
    return { text: [header, counts, ...lines, ...errors].join('\n'), queryId: page.queryId, nextCursor: page.nextCursor, total: page.total };
  }
  async meetings(args = {}, ctx = {}) {
    const date = args.date || '今天', today = D.dayKey(this.a.now());
    const day = date === '今天' ? today : date === '明天' ? D.dayKey(Date.parse(today + 'T00:00:00+08:00') + 24 * HOUR) : date;
    const start = this.localTime(args.from || day), startMs = D.timeValue(start).at;
    if (!Number.isFinite(startMs)) throw new Error('会议查询日期无效，请使用今天、明天或实际 YYYY-MM-DD 日期');
    const end = args.to ? this.localTime(args.to) : new Date(startMs + 24 * HOUR).toISOString();
    const page = await this.execute({ ...args, op: 'list', kind: 'meetings', period: 'custom', start, end, limit: 50 });
    const c = page.coverage;
    const sourceStatus = (label, value) => `${label}：${value.status === 'complete' ? '已完成当前条件下的查询' : '未取全'}${value.reasonLabel ? '（' + value.reasonLabel + '）' : ''}`;
    const queryTypes = c.meeting.queryTypes || String(c.meeting.queryType || '').split(',').filter(Boolean);
    const category = type => ({ '1': '待参加', '2': '已结束' })[type] || `类型 ${type}`;
    // 同名同时段的 WeLink 会议与日历合成一行（用户 11-05 定「2 合并」）。
    const rows = D.mergeMeetings(page.items), merged = rows.filter(m => m.merged).length;
    const lines = rows.map(m => `${m.displayRange || m.display || `${m.startDisplay || '时间待核对'} – ${m.endDisplay || '结束时间待核对'}`} ${m.subject}${m.location ? ' · ' + m.location : ''} · ${m.merged ? 'WeLink + 日历' : m.sourceId.startsWith('cal:') ? '日历' : 'WeLink'} [${m.sourceId}]`);
    const complete = c.status === 'complete';
    const summary = [`覆盖：${page.range.startDisplay} 至 ${page.range.endDisplay}（上海时间）；${sourceStatus('WeLink 会议', c.meeting)}；${sourceStatus('邮箱日程', c.calendar)}。`,
      `范围说明：WeLink ${queryTypes.length ? '只含' + queryTypes.map(category).join('和') + '会议' : '会议类型未确认'}，其他类型不在本次范围。`,
      `找到 ${page.total} 条记录：WeLink ${page.counts.meetings} 条、日历 ${page.counts.calendar} 条${merged ? `；主题和时间相同的 ${merged} 场已合并成一行，两条原始记录都保留在出处里` : ''}${c.unknownTime ? `；${c.unknownTime} 条时间待核对` : ''}。`];
    const label = args.from ? '指定时段' : date === '今天' || date === '明天' ? date : day;
    const errors = c.errors.map(e => `取数问题：${e.label} ${e.text}`);
    this.captureCoverage(page.queryId, [...summary, ...errors], ctx, complete
      ? { ok: true, line: `${label} · WeLink 会议 ${page.counts.meetings} 条、日历 ${page.counts.calendar} 条${merged ? `，同一场会已合并 ${merged} 场` : ''}` }
      : { ok: false, line: `${label}的会议或日历没取全${c.unknownTime ? `，${c.unknownTime} 条时间待核对` : ''}` });
    return { text: [...summary, ...lines, ...errors].join('\n'), queryId: page.queryId, nextCursor: page.nextCursor, total: page.total,
      note: '时间和主题照上面的行写；时间待核对的单列。' };
  }
  // 在后台快照里找消息（5.5.11 新增）：welink-cli 不能按关键字或时间搜消息，只能逐个会话翻；
  // 快照每 10 分钟更新一次，按人、群、关键字在本机筛，几毫秒出结果。更早的或要实时的，用 welink_inbox。
  async find(args = {}, ctx = {}) {
    const person = String(args.person || '').trim(), group = String(args.group || '').trim(), keyword = String(args.keyword || '').trim();
    if (!person && !group && !keyword) throw new Error('至少给一个条件：person（人）、group（群）或 keyword（关键字）');
    const snap = this.ownSnapshot(), now = this.a.now(), settings = this.a.settings?.() || {};
    const lookback = Number(settings.lookbackHours) || 36;
    const hours = Math.max(1, Math.min(168, Number(args.hours) || lookback));
    const endAt = args.until ? D.timeValue(this.localTime(args.until)).at : now;
    const startAt = args.since ? D.timeValue(this.localTime(args.since)).at : endAt - hours * HOUR;
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error('时间范围无效，请用上海时间 YYYY-MM-DD HH:mm');
    const has = (q, values) => !q || values.some(v => String(v || '').toLowerCase().includes(q.toLowerCase()));
    const rows = Object.values(snap.messages || {}).flat().filter(m => Number.isFinite(m.at) && m.at >= startAt && m.at < endAt)
      .filter(m => has(person, [m.sender, m.senderName, m.account, !m.group && m.convName]) && has(group, [m.group && m.convName, m.group && m.conv]) && has(keyword, [m.text, m.preview]));
    const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 12)));
    const picked = [...rows].sort((a, b) => b.at - a.at).slice(0, limit).sort((a, b) => a.at - b.at);
    const sc = snap.scope || {}, fresh = now - (snap.at || 0) <= 30 * 60000;
    const partial = !!(sc.partial || sc.neverFetched || sc.limited);
    const older = startAt < (snap.at || now) - lookback * HOUR;
    const desc = [person && `人「${person}」`, group && `群「${group}」`, keyword && `关键字「${keyword}」`].filter(Boolean).join('、');
    const details = [`在后台快照里按${desc}查找：${D.displayTime(startAt)} 至 ${D.displayTime(endAt)}；快照采集于 ${D.displayTime(snap.at)}，覆盖 ${sc.fetched || (snap.conversations || []).length} 个会话。`,
      `命中 ${rows.length} 条，列出最近 ${picked.length} 条。`,
      ...(partial ? [`快照里有 ${sc.partial || 1} 个会话没取全，可能漏消息；要现场查用 welink_inbox。`] : []),
      ...(older ? [`起点早于快照的回看范围（${lookback} 小时），更早的消息要用 welink_inbox 现场查。`] : []),
      ...(!fresh ? ['快照已超过 30 分钟没更新，最新消息可能没包含。'] : [])];
    const ok = !partial && fresh && !older;
    this.captureCoverage(`find:${now}:${desc}`, details, ctx, { ok, line: ok ? `快照 ${D.clock(snap.at)} · ${desc} · 命中 ${rows.length} 条`
      : partial ? `快照里有会话没取全，${desc}可能漏了消息` : older ? '更早的消息不在快照里' : '快照不是最新的，最新消息可能没包含' });
    const lines = picked.map(m => `${m.group ? '群「' + D.short(m.convName, 20) + '」' : '私聊「' + D.short(m.convName, 20) + '」'}${D.displayTime(m.at)} ${m.mine ? '我' : m.sender}：${D.short(m.text || m.preview, 150)} [${m.sourceId}]`);
    return { text: [...details, ...lines].join('\n'), total: rows.length, note: '要读全文或前后文用 welink_message({ids:[出处编号]})。' };
  }
  // 邮件（5.5.11 新增）：未读直接读快照；关键字用 welink-cli 的 mail list --query（公司 1.0.14 实测可用，Q-1105-05）。
  async mail(args = {}, ctx = {}) {
    const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 10))), query = String(args.query || '').trim();
    let mails, details, ok = true, line;
    if (!query) {
      const snap = this.ownSnapshot(), cov = snap.mailCoverage || {}, all = snap.mails || [];
      mails = all.slice(0, limit);
      ok = cov.status === 'complete';
      details = [`未读邮件来自后台快照（采集于 ${D.displayTime(snap.at)}）：共 ${all.length} 封，列出 ${mails.length} 封。${ok ? '' : '未读邮件没取全' + (cov.reasonLabel ? '（' + cov.reasonLabel + '）' : '') + '。'}`];
      line = ok ? `未读邮件 ${all.length} 封 · 快照 ${D.clock(snap.at)}` : '未读邮件没取全';
    } else {
      if (query.length > 200 || /[\r\n]/.test(query)) throw new Error('搜索词太长或含换行');
      const Q = require('./queries');
      let raw = null, error = '';
      try { raw = await withWelinkPriority('user', () => Q.readJson(a => this.a.welink(a), ['mail', 'list', '--query', query, '--max', String(limit)], {})); }
      catch (e) { error = e.message; }
      mails = raw ? D.mails(raw).slice(0, limit) : [];
      ok = !!raw;
      details = [raw ? `按「${query}」搜邮件（welink-cli mail list --query，实时）：找到 ${mails.length} 封。` : `按「${query}」搜邮件失败：${D.short(error, 160)}`];
      line = raw ? `邮件搜索「${D.short(query, 20)}」· ${mails.length} 封` : '邮件搜索失败';
    }
    this.captureCoverage(`mail:${this.a.now()}:${query}`, details, ctx, { ok, line });
    const lines = mails.map(m => `${m.at ? D.displayTime(m.at) : '时间未知'} ${m.from || '发件人未知'}：${m.subject}${m.important ? '（重要）' : ''}${m.preview ? ' —— ' + D.short(m.preview, 150) : ''} [${m.sourceId}]`);
    return { text: [...details, ...lines].join('\n'), total: mails.length };
  }
  async message(args = {}) {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length || ids.length > 10) throw new Error('每次读取 1 到 10 条消息');
    const data = args.queryId ? this.load(args.queryId) : null;
    const rows = data?.context || data?.items || Object.values(this.ownSnapshot().messages || {}).flat();
    const parts = [];
    for (const sourceId of ids) {
      const found = await this.execute({ op: 'read', sourceId, queryId: args.queryId, offset: args.offset });
      const row = found.item, same = rows.filter(x => x.conv === row.conv).sort((a, b) => a.at - b.at), ix = same.findIndex(x => x.sourceId === sourceId);
      const adjacent = ix < 0 ? [] : same.slice(Math.max(0, ix - 3), ix + 4).filter(x => x.sourceId !== sourceId);
      parts.push({ sourceId, text: `${D.displayTime(row.at)} ${row.sender}：${row.text}`, nextOffset: found.nextOffset,
        contextRefs: adjacent.map(x => ({ sourceId: x.sourceId, account: x.account, at: x.at, sender: x.sender, conv: x.conv })),
        context: adjacent.map(x => `${D.displayTime(x.at)} ${x.sender}：${D.short(x.text || x.preview, 200)} [${x.sourceId}]`), note: '上下文为同次查询已取到的相邻消息；不足三条时不编造。' });
    }
    return { items: parts };
  }
}
module.exports = { AssistantQuery, queryRange, TTL };
