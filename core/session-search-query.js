'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { normalize, termsFor, normalizeSort, documentRank, compareRank, compareResults, rankReason, RANK_VERSION } = require('./session-search-ranking');
const { createSnippet, isCjkAuxTerm, sinceTimestamp } = require('./session-search-index');
const { normalizeProjectFilter, matchesProjectFilter } = require('./session-search-projects');
const { matchesSearchProvider } = require('./session-search-providers');
const DIALOGUE = ['title', 'user', 'assistant'];
// 工具 doc 不在全文索引里，所以它不是一个可检索范围；老请求里的 tool 直接忽略。
const ALL_SCOPES = [...DIALOGUE];
const quote = value => '"' + value.replace(/"/g, '""') + '"';
// 「我的提问 + 最近 N 天」常驻内存（2026-11-05 定为 7 天）。多留 1 天余量，
// 让「最近 7 天」的起点在缓存刷新之间往前漂移时仍被完整覆盖。
const RECENT_USER_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
// 会话表「最近对话时间」平时按新增行增量合并；隔一段时间整表重算一次，纠正删改留下的偏差。
const CATALOG_FULL_RECOMPUTE_MS = 10 * 60 * 1000;
const LAST_CONVERSATION_SQL = `SELECT s.*, (SELECT MAX(timestamp) FROM docs d WHERE d.session_key=s.key AND d.scope IN ('user','assistant') AND d.event_id<>'last-output-preview') AS last_conversation_at FROM sessions s`;

/**
 * 每次搜索都要的两样东西原来是现查的：全部会话及其最近对话时间（实测 ~75ms）、
 * 时间范围内有对话的会话（~50ms）；「我的提问 + 7 天」本身还要走一遍 SQL。
 * 这里把会话目录和最近 8 天的提问正文留在搜索进程里，库有提交时按行号增量同步
 * （改动的行会删掉重插、换新 rowid，见 _updateSourceInPlace），没变化时同步只读两个 PRAGMA。
 */
class SearchCatalogCache {
  constructor(owner, { now = () => Date.now() } = {}) {
    this.owner = owner; this.now = now;
    this.key = null; this.sessions = null; this.lastConversation = new Map();
    this.maxDocId = 0; this.fullAt = 0; this.unknownTimeSources = 0;
    this.recent = new Map(); this.recentList = null; this.recentCutoff = null;
  }
  get ready() { return !!this.sessions; }
  _changeKey(db) {
    const version = db.prepare('PRAGMA data_version').get().data_version;
    const own = db.prepare('SELECT total_changes() AS c').get().c;
    return `${version}:${own}`;
  }
  _buildSessions(rows) {
    const sessions = new Map();
    let unknown = 0;
    for (const row of rows) {
      const last = this.lastConversation.get(row.key);
      const session = sessionFrom({ ...row, last_conversation_at: last ?? null });
      if (!session.lastConversationAt) unknown++;
      sessions.set(row.key, session);
    }
    this.sessions = sessions; this.unknownTimeSources = unknown;
  }
  sync() {
    const db = this.owner && this.owner.db;
    if (!db) return false;
    const now = this.now();
    const key = this._changeKey(db);
    const full = !this.sessions || now - this.fullAt >= CATALOG_FULL_RECOMPUTE_MS;
    const drift = this.recentCutoff == null || now - RECENT_USER_WINDOW_MS - this.recentCutoff >= 60_000;
    if (!full && !drift && key === this.key) return true;
    const maxDocId = Number(db.prepare('SELECT MAX(id) AS m FROM docs').get().m) || 0;
    if (full) {
      const rows = db.prepare(LAST_CONVERSATION_SQL).all();
      this.lastConversation = new Map(rows.map(row => [row.key, row.last_conversation_at == null ? null : Number(row.last_conversation_at)]));
      this._buildSessions(rows);
      this.fullAt = now;
    } else if (key !== this.key) {
      if (maxDocId > this.maxDocId) {
        const added = db.prepare(`SELECT session_key, MAX(timestamp) AS m FROM docs WHERE id>? AND scope IN ('user','assistant') AND event_id<>'last-output-preview' GROUP BY session_key`).all(this.maxDocId);
        for (const row of added) {
          const value = Number(row.m) || 0;
          if (value > (Number(this.lastConversation.get(row.session_key)) || 0)) this.lastConversation.set(row.session_key, value);
        }
      }
      this._buildSessions(db.prepare('SELECT * FROM sessions').all());
    }
    this.maxDocId = maxDocId;
    if (full || drift || key !== this.key) this._syncRecent(db, now);
    this.key = key;
    return true;
  }
  _syncRecent(db, now) {
    const cutoff = now - RECENT_USER_WINDOW_MS;
    const ids = db.prepare("SELECT id FROM docs WHERE scope='user' AND timestamp>=?").all(cutoff).map(row => Number(row.id));
    const wanted = new Set(ids);
    let changed = this.recentList == null;
    for (const id of this.recent.keys()) if (!wanted.has(id)) { this.recent.delete(id); changed = true; }
    const missing = ids.filter(id => !this.recent.has(id));
    const fetch = db.prepare(`SELECT id,session_key,scope,role,speaker,ordinal,timestamp,event_id,text,normalized_text FROM docs WHERE id IN (SELECT value FROM json_each(?))`);
    for (let i = 0; i < missing.length; i += 500) {
      for (const row of fetch.all(JSON.stringify(missing.slice(i, i + 500)))) {
        this.recent.set(Number(row.id), { ...row, id: Number(row.id), timestamp: Number(row.timestamp) || 0, ordinal: row.ordinal });
        changed = true;
      }
    }
    // 查询快照持有的是旧数组；这里只换新数组，不原地改，翻页期间结果不会变。
    if (changed) this.recentList = [...this.recent.values()].sort((a, b) => a.id - b.id);
    this.recentCutoff = cutoff;
  }
  covers(request) {
    return !!this.recentList
      && request.scopes.length === 1 && request.scopes[0] === 'user'
      && request.time.field === 'eventTime' && request.time.from != null && request.time.from >= this.recentCutoff;
  }
  stats() {
    let chars = 0;
    if (this.recentList) for (const doc of this.recentList) chars += doc.text.length + doc.normalized_text.length;
    return { sessions: this.sessions ? this.sessions.size : 0, recentUserDocs: this.recentList ? this.recentList.length : 0, recentUserChars: chars, recentCutoff: this.recentCutoff };
  }
}

function normalizeRequest(request, now = Date.now()) {
  if (String(request.query || '').length > 512) throw new Error('搜索关键词过长（最多 512 个字符）');
  const query = normalize(String(request.query || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
  if(String(request.query||'').trim() && !query) throw new Error('请输入可搜索的文字，控制字符不能作为关键词');
  const time = request.time || {};
  const from = time.from != null ? Number(time.from) : sinceTimestamp(request.timeRange, now);
  const to = time.to != null ? Number(time.to) : from != null ? now : null;
  if ((from != null && !Number.isFinite(from)) || (to != null && !Number.isFinite(to)) || (from != null && to != null && from > to)) throw new Error('时间范围无效');
  const requested = Array.isArray(request.scopes) ? [...new Set(request.scopes)].filter(scope => scope !== 'tool') : [];
  const scopes = requested.length ? requested.sort() : DIALOGUE.slice().sort();
  if (scopes.some(scope=>!ALL_SCOPES.includes(scope))) throw new Error('搜索内容范围无效');
  let filter = null;
  if (request.sessionFilter != null) {
    if (typeof request.sessionFilter !== 'object' || Array.isArray(request.sessionFilter)) throw new Error('Invalid session filter');
    filter = {};
    for (const key of ['hubSessionIds','meetingIds']) {
      const ids = request.sessionFilter[key] || [];
      if (!Array.isArray(ids)) throw new Error('Session filter IDs must be arrays');
      filter[key] = [...new Set(ids.filter(id=>typeof id==='string' && id))].sort();
    }
  }
  const sort = query ? normalizeSort(request.sort, query) : normalizeSort(request.sort === 'relevance' ? 'conversationTime' : request.sort);
  return { query, providers:[...new Set(Array.isArray(request.providers)?request.providers:[])].sort(), scopes,
    project:normalize(request.project), projectFilter:normalizeProjectFilter(request.projectFilter), sessionFilter:filter, sort,
    direction: request.direction || (sort==='title'?'asc':'desc'),
    time:{field:time.field === 'conversationTime' ? 'conversationTime':'eventTime',from,to,timeZone:time.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone},
    limit:Math.min(200,Math.max(1,Number(request.limit || request.pageSize)||50)), now };
}

// 与 SQL 的 substr(text, MAX(1, instr(normalized,term)-100), 500) 逐字一致：SQLite 按字符
// （码点）计数，JS 按 UTF-16 计数，含 emoji 等代理对时两者会差一位，所以只在这种情况换算。
const SURROGATE = /[\uD800-\uDFFF]/;
function sqliteSnippet(text, normalized, hitUnits) {
  if (!SURROGATE.test(text) && !SURROGATE.test(normalized.slice(0, hitUnits))) return text.substr(Math.max(0, hitUnits - 100), 500);
  const start = Math.max(0, Array.from(normalized.slice(0, hitUnits)).length - 100);
  return Array.from(text).slice(start, start + 500).join('');
}

function sessionFrom(row) {
  return { key:row.key, sessionKey:row.key, provider:row.provider, nativeFamily:row.native_family,
    kind:row.kind, title:row.title || '未命名会话', cwd:row.cwd, projectLabel:row.project_label,
    model:row.model, updatedAt:Number(row.updated_at)||0, lastConversationAt:Number(row.last_conversation_at)||null,
    hubSessionId:row.hub_session_id, nativeSessionId:row.native_session_id, meetingId:row.meeting_id,
    transcriptPath:row.transcript_path, codexSessionsRoot:row.codex_sessions_root, codexProfile:row.codex_profile,
    turnCount:Number(row.turn_count)||0 };
}

// One read transaction per live query. Incremental writes can commit while a
// user pages through this frozen snapshot; no missing/repeated rows on refresh.
class QuerySnapshot {
  constructor(owner, request, catalog = null) {
    this.id = randomUUID(); this.request = request; this.lastUsed = Date.now(); this.done = false;
    this.groups = new Map(); this.seen = new Set(); this.users = new Map();
    this.terms = termsFor(request.query).sort((a,b)=>b.length-a.length);
    this.termIndex = 0; this.afterId = 0; this.scanned = 0; this.db = null;
    const cached = !!(catalog && catalog.ready);
    // 内存路径：命中「我的提问 + 最近 7 天以内」时直接扫常驻内存的提问，不走 SQL 正文扫描。
    this.memoryDocs = cached && catalog.covers(request) ? catalog.recentList : null;
    // 摘要（问题/回答前 600 字）只给当前这一页取，不再为全部命中会话逐个回库。
    this.pendingExcerpts = new Map();
    this.path = this.memoryDocs ? 'memory' : cached ? 'sqlite+catalog' : 'sqlite';
    try {
      this.db = new DatabaseSync(owner.databasePath, {readOnly:true});
      this.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA busy_timeout=5000; BEGIN');
      this.db.function('search_features', {deterministic:true}, (text,scope)=>JSON.stringify(documentRank({normalized_text:text,scope},request.query,this.terms)));
      if (cached) {
        this.sessions = catalog.sessions;
        this.unknownTimeSources = catalog.unknownTimeSources;
      } else {
        const rows = this.db.prepare(LAST_CONVERSATION_SQL).all();
        this.sessions = new Map(rows.map(row=>[row.key,sessionFrom(row)]));
        this.unknownTimeSources = rows.filter(row=>!row.last_conversation_at).length;
      }
      const {from,to,field} = request.time;
      this.timed = from != null || to != null;
      this.rangeSessions = this.timed ? (cached ? this.rangeFromCatalog(from ?? 0, to ?? Number.MAX_SAFE_INTEGER)
        : new Set(this.db.prepare(`SELECT DISTINCT session_key FROM docs WHERE scope IN ('user','assistant') AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?`).all(from ?? 0,to ?? Number.MAX_SAFE_INTEGER).map(r=>r.session_key))) : null;
      this.allowed = new Set([...this.sessions.values()].filter(s=>
        matchesSearchProvider(s.provider, request.providers)
        && (!request.project || normalize(`${s.projectLabel||''} ${s.cwd||''}`).includes(request.project))
        && matchesProjectFilter(s.cwd, request.projectFilter)
        && (!request.sessionFilter || request.sessionFilter.hubSessionIds.includes(s.hubSessionId) || request.sessionFilter.meetingIds.includes(s.meetingId))
        && (!this.timed || field!=='conversationTime' || (s.lastConversationAt && s.lastConversationAt >= (from??0) && s.lastConversationAt <= (to??Number.MAX_SAFE_INTEGER)))
      ).map(s=>s.key));
      this.allAllowed = this.allowed.size === this.sessions.size;
      this.auxReady = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='cjkAuxReady'").get()?.value || 'null') === '1';
      // ordinal 在表里排在整段正文之后：按 (session_key, scope, timestamp) 索引取行再读 ordinal，
      // 要把每条长消息的溢出页全读一遍（实测 50 个会话 30~70ms）。固定走 (session_key, ordinal)
      // 索引，ordinal 直接从索引拿，scope/event_id 在正文前面，不碰溢出页。
      this.userStatement = this.db.prepare("SELECT ordinal, event_id FROM docs INDEXED BY idx_docs_session WHERE session_key=? AND scope='user' ORDER BY ordinal,id");
      this.questionStatement = this.db.prepare("SELECT substr(text,1,600) AS text FROM docs INDEXED BY idx_docs_session WHERE session_key=? AND scope='user' AND ordinal=? LIMIT 1");
      this.answerStatement = this.db.prepare("SELECT substr(text,1,600) AS text FROM docs INDEXED BY idx_docs_session WHERE session_key=? AND scope='assistant' AND ordinal>=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1");
      if (request.query && request.scopes.includes('title')) {
        for (const key of this.allowed) {
          const session = this.sessions.get(key);
          if (![key, session.hubSessionId, session.nativeSessionId, session.meetingId].some(id => id && normalize(id) === request.query)) continue;
          if (this.timed && !this.rangeSessions.has(key)) continue;
          const rank = { tier:0, distance:0, field:0, covered:this.terms.map((_,i)=>i) };
          this.groups.set(key, {session, exactId:true, covered:new Set(rank.covered), episodes:new Map(),
            best:{rank,docId:`id:${key}`,eventId:'title',scope:'title',role:'title',timestamp:null,ordinal:-1,text:session.title},
            count:1,newest:null,scopes:new Set(['title']),matchedEventIds:[]});
        }
      }
      if (!this.terms.length) {
        const eventPredicate=this.timed && field==='eventTime'
          ? ` AND ((scope<>'title' AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=?) OR (scope='title' AND session_key IN (SELECT value FROM json_each(?))))` : '';
        const eventArgs=eventPredicate?[from??0,to??Number.MAX_SAFE_INTEGER,JSON.stringify([...this.rangeSessions])]:[];
        const scoped=this.memoryDocs
          ? new Set(this.memoryDocs.filter(d=>d.timestamp>0 && d.timestamp>=(from??0) && d.timestamp<=(to??Number.MAX_SAFE_INTEGER) && d.event_id!=='last-output-preview').map(d=>d.session_key))
          : new Set(this.db.prepare(`SELECT DISTINCT session_key FROM docs WHERE scope IN (${request.scopes.map(()=>'?')})${eventPredicate}`).all(...request.scopes,...eventArgs).map(r=>r.session_key));
        this.finalResults = [...this.allowed].filter(key=>scoped.has(key)).map(key=>{
          const row={...this.sessions.get(key), matchCount:0, titleOnly:true, indexed:true, newestMatchedEventAt:null,
            rank:{tier:4,distance:0,field:0}, matchReasons:['最近对话'],
            bestMatch:{scope:'title',role:'title',eventId:'title',timestamp:null,text:this.sessions.get(key).title},
            questionExcerpt:'', answerExcerpt:''};
          this.pendingExcerpts.set(row,{key,ordinal:Number.MAX_SAFE_INTEGER});
          return row;
        }).sort((a,b)=>compareResults(a,b,request.sort,request.direction));
        this.done=true;
      }
    } catch(error) { this.close(); throw error; }
  }
  // 「时间范围内有对话的会话」：最近对话时间落在范围内的必然有；早于起点的必然没有；
  // 晚于终点的（正在聊、时钟偏差）才逐个回库确认。与原 DISTINCT 全量查询结果一致。
  rangeFromCatalog(from, to) {
    const range = new Set();
    let check = null;
    for (const [key, session] of this.sessions) {
      const last = Number(session.lastConversationAt) || 0;
      if (!last || last < from) continue;
      if (last <= to) { range.add(key); continue; }
      check ||= this.db.prepare(`SELECT 1 FROM docs WHERE session_key=? AND scope IN ('user','assistant') AND event_id<>'last-output-preview' AND timestamp>0 AND timestamp>=? AND timestamp<=? LIMIT 1`);
      if (check.get(key, from, to)) range.add(key);
    }
    return range;
  }
  close() { if(this.db) { try { this.db.close(); } finally { this.db=null; } } }
  userBounds(key, ordinal) {
    let users=this.users.get(key);
    if(!users) { users=this.userStatement.all(key); this.users.set(key,users); }
    let lo=0,hi=users.length;
    while(lo<hi) { const mid=(lo+hi)>>1; if(users[mid].ordinal<=ordinal) lo=mid+1; else hi=mid; }
    return {start:lo?users[lo-1].ordinal:null,end:lo<users.length?users[lo].ordinal:Number.MAX_SAFE_INTEGER};
  }
  // 摘要只要命中位置前后最近的两条提问：已经缓存过整列提问位置就二分，否则只查这两行，
  // 不为一条摘要把长会话的几千条提问位置全部读出来。结果与 userBounds 完全相同。
  boundsAt(key,ordinal) {
    if(this.users.has(key)) return this.userBounds(key,ordinal);
    this.prevUserStatement ||= this.db.prepare("SELECT ordinal FROM docs INDEXED BY idx_docs_session WHERE session_key=? AND ordinal<=? AND scope='user' ORDER BY ordinal DESC LIMIT 1");
    this.nextUserStatement ||= this.db.prepare("SELECT ordinal FROM docs INDEXED BY idx_docs_session WHERE session_key=? AND ordinal>? AND scope='user' ORDER BY ordinal ASC LIMIT 1");
    const prev=this.prevUserStatement.get(key,ordinal), next=this.nextUserStatement.get(key,ordinal);
    return {start:prev?prev.ordinal:null,end:next?next.ordinal:Number.MAX_SAFE_INTEGER};
  }
  excerpts(key,ordinal) {
    const bounds=this.boundsAt(key,ordinal);
    return { questionExcerpt:bounds.start==null?'':this.questionStatement.get(key,bounds.start)?.text||'',
      answerExcerpt:this.answerStatement.get(key,bounds.start??-1,bounds.end)?.text||'' };
  }
  makeStatement() {
    const term=this.terms[this.termIndex], r=this.request;
    const useCjk=isCjkAuxTerm(term) && this.auxReady && r.scopes.every(s=>DIALOGUE.includes(s));
    const table=useCjk?'docs_cjk':Array.from(term).length>=3?'docs_fts':null;
    // Short non-indexable terms scan bounded metadata pages. A WHERE instr +
    // LIMIT would scan the entire text corpus on a zero-hit query before yielding.
    const where=[...(table?[`${table} MATCH ?`]:[]), `${table?table+'.rowid':'d.id'}>?`, `d.scope IN (${r.scopes.map(()=>'?')})`];
    const args=[...(table?[quote(term)]:[]), this.afterId, ...r.scopes];
    const allowed=this.termIndex ? [...this.groups.keys()] : this.allAllowed?null:[...this.allowed];
    if(allowed) { where.push('d.session_key IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(allowed)); }
    if(this.timed && r.time.field==='eventTime') {
      where.push(`((d.scope<>'title' AND d.event_id<>'last-output-preview' AND d.timestamp>0 AND d.timestamp>=? AND d.timestamp<=?) OR (d.scope='title' AND d.session_key IN (SELECT value FROM json_each(?))))`);
      args.push(r.time.from??0,r.time.to??Number.MAX_SAFE_INTEGER,JSON.stringify([...this.rangeSessions]));
    }
    // CROSS JOIN pins the FTS iterator as the driver. A normal JOIN lets SQLite
    // pick scope_time first, turning a selective term into thousands of FTS probes.
    const from=table?`FROM ${table} CROSS JOIN docs d ON d.id=${table}.rowid`:'FROM docs d NOT INDEXED';
    const sql=`SELECT d.id,d.session_key,d.scope,d.role,d.speaker,d.ordinal,d.timestamp,d.event_id,
      search_features(d.normalized_text,d.scope) AS features,
      substr(d.text,MAX(1,instr(d.normalized_text,?)-100),500) AS snippet
      ${from} WHERE ${where.join(' AND ')} ORDER BY ${table?`${table}.rowid`:'d.id'} LIMIT ?`;
    return {statement:this.db.prepare(sql),args:[term,...args],scanAll:!table};
  }
  consume(row) {
    if(this.seen.has(row.id)) return;
    this.seen.add(row.id);
    const feature=typeof row.features==='string'?JSON.parse(row.features):row.features;
    if(!feature.covered.length) return;
    // 会话目录来自缓存时，缓存同步之后才提交的新会话这一轮还没有元数据，下一次搜索就有了。
    if(!this.sessions.has(row.session_key)) return;
    let group=this.groups.get(row.session_key);
    if(!group) {
      group={session:this.sessions.get(row.session_key),covered:new Set(),episodes:new Map(),best:null,count:0,newest:null,scopes:new Set(),matchedEventIds:[]};
      this.groups.set(row.session_key,group);
    }
    feature.covered.forEach(i=>group.covered.add(i));
    group.count++; group.scopes.add(row.scope);
    if(row.scope!=='title' && row.event_id!=='last-output-preview') group.newest=Math.max(group.newest||0,Number(row.timestamp)||0)||null;
    if(group.matchedEventIds.length<30) group.matchedEventIds.push(row.event_id);
    if(row.scope!=='title') {
      // 命中的本身就是一条提问时，它所在的「这一轮」就从它自己开始，不必回库查全部提问的位置。
      const start=row.scope==='user'?row.ordinal:this.userBounds(row.session_key,row.ordinal).start;
      const key=start==null?`event:${row.event_id}`:`user:${start}`;
      let episode=group.episodes.get(key);
      if(!episode) { episode={covered:new Set(),best:null}; group.episodes.set(key,episode); }
      feature.covered.forEach(i=>episode.covered.add(i));
      if(!episode.best || compareRank(feature,episode.best.rank)<0) episode.best={rank:feature,...row};
    }
    if(!group.best || compareRank(feature,group.best.rank)<0 || (compareRank(feature,group.best.rank)===0 && row.timestamp>group.best.timestamp)) {
      group.best={rank:feature,docId:row.id,eventId:row.event_id,scope:row.scope,role:row.role,speaker:row.speaker,
        timestamp:row.scope==='title'?null:Number(row.timestamp)||null,ordinal:row.ordinal,text:row.snippet};
    }
  }
  // 内存路径一次扫完（7 天约 3300 条、350 万字，实测 1~2ms），结果与 SQL 路径同一套
  // documentRank / consume：命中判定、排名、摘要起点（命中词前 100 字）都一致。
  stepMemory() {
    const r=this.request, from=r.time.from??0, to=r.time.to??Number.MAX_SAFE_INTEGER;
    if(this.allowed.size) for(const doc of this.memoryDocs) {
      if(doc.timestamp<=0 || doc.timestamp<from || doc.timestamp>to || doc.event_id==='last-output-preview') continue;
      if(!this.allAllowed && !this.allowed.has(doc.session_key)) continue;
      const text=doc.normalized_text;
      let hit=-1;
      for(const term of this.terms) { hit=text.indexOf(term); if(hit>=0) break; }
      if(hit<0) continue;
      this.consume({...doc,features:documentRank({normalized_text:text,scope:doc.scope},r.query,this.terms),
        snippet:sqliteSnippet(doc.text,text,hit)});
    }
    this.scanned+=this.memoryDocs.length;
    this.termIndex=this.terms.length;
  }
  step(maxDocs) {
    if(this.done) return;
    if(this.memoryDocs) this.stepMemory();
    const started=Date.now(); let processed=0, chars=0;
    while(this.termIndex<this.terms.length && processed<maxDocs && chars<8*1024*1024 && Date.now()-started<160) {
      if(!this.allowed.size || (this.termIndex && !this.groups.size)) { this.termIndex=this.terms.length; break; }
      const {statement,args,scanAll}=this.makeStatement();
      // Many overlapping query terms can make one document expensive. Yield
      // between those documents instead of running 32 UDF calls atomically.
      const batchSize=Math.min(this.terms.length>8?1:32,maxDocs-processed);
      const rows=statement.all(...args,batchSize);
      for(const row of rows) { this.consume(row); this.afterId=row.id; chars+=row.snippet.length; }
      processed+=rows.length; this.scanned+=rows.length;
      if(rows.length<batchSize) { this.termIndex=scanAll?this.terms.length:this.termIndex+1; this.afterId=0; }
    }
    if(this.termIndex>=this.terms.length) {
      this.done=true;
      this.finalResults=this.resultRows();
      // 连接留到最后一页的摘要取完（或快照过期）再关。
      this.seen.clear(); this.groups.clear();
    }
  }
  resultRows() {
    if(this.finalResults) return this.finalResults;
    this.pendingExcerpts.clear(); // 部分结果每轮重建行对象，旧一轮未显示的行不必再记
    const groups=[...this.groups.values()].filter(g=>g.covered.size===this.terms.length);
    const results=groups.map(g=>{
      let best=g.best;
      let rank={...best.rank}; delete rank.covered;
      if(rank.tier>=4) {
        const episodes=[...g.episodes.values()].filter(e=>e.covered.size===this.terms.length).sort((a,b)=>compareRank(a.best.rank,b.best.rank)||b.best.timestamp-a.best.timestamp);
        if(episodes.length) {
          const row=episodes[0].best;
          best={rank:row.rank,docId:row.id,eventId:row.event_id,scope:row.scope,role:row.role,speaker:row.speaker,timestamp:row.timestamp,ordinal:row.ordinal,text:row.snippet};
          rank={tier:3,distance:0,field:row.rank.field};
        }
      }
      const titleOnly=g.scopes.size===1 && g.scopes.has('title');
      const {rank:_rank,docId,...bestMatch}=best;
      const row={...g.session,indexed:true,matchCount:g.count,newestMatchedEventAt:g.newest,
        titleOnly,rank,matchReasons:g.exactId?['会话 ID 精确匹配',...(this.timed?['范围内有对话']:[])]:rankReason(rank,titleOnly,this.timed),matchedEventIds:g.matchedEventIds,
        bestMatch, questionExcerpt:'', answerExcerpt:'', ...(g.excerptId===docId?g.excerpts:{})};
      if(g.excerptId!==docId) this.pendingExcerpts.set(row,{key:g.session.key,ordinal:best.scope==='title'?Number.MAX_SAFE_INTEGER:best.ordinal,group:g,docId});
      return row;
    });
    return results.sort((a,b)=>compareResults(a,b,this.request.sort,this.request.direction));
  }
  response(offset=0) {
    const results=this.resultRows(), r=this.request, shown=results.slice(offset,offset+r.limit);
    for(const row of shown) {
      const pending=this.pendingExcerpts.get(row);
      if(!pending) continue;
      this.pendingExcerpts.delete(row);
      if(!this.db) continue;
      const excerpts=this.excerpts(pending.key,pending.ordinal);
      Object.assign(row,excerpts);
      if(pending.group) {pending.group.excerptId=pending.docId;pending.group.excerpts=excerpts;}
    }
    if(this.done && offset+r.limit>=results.length) {this.close();this.users.clear();this.pendingExcerpts.clear();}
    const providers={},scopes={},projects=new Map();
    for(const result of results) {
      providers[result.provider]=(providers[result.provider]||0)+1;
      const scope=result.bestMatch.scope; scopes[scope]=(scopes[scope]||0)+1;
      const label=result.projectLabel||result.cwd; if(label) projects.set(label,(projects.get(label)||0)+1);
    }
    const cursor=(kind,start)=>Buffer.from(JSON.stringify({id:this.id,kind,offset:start})).toString('base64url');
    return {queryId:this.id,snapshotId:this.id,rankVersion:RANK_VERSION,appliedFilters:r,
      state:this.done?'complete':'partial',total:{value:results.length,relation:this.done?'exact':'lowerBound'},
      totalSessions:results.length,totalMatches:results.reduce((sum,r)=>sum+r.matchCount,0),results:shown,
      truncated:!this.done || results.length>offset+r.limit,truncatedReason:!this.done?'query_guard':results.length>offset+r.limit?'result_limit':null,
      partialReason:this.done?null:'仍在检索同一快照中的其余记录',scannedDocuments:this.scanned,
      continuationCursor:this.done?null:cursor('scan',0),
      nextPageCursor:this.done && offset+r.limit<results.length?cursor('page',offset+r.limit):null,
      coverage:{unknownTimeSources:this.unknownTimeSources},searchPath:this.path,
      facets:{providers,scopes,projects:[...projects].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count)},
    };
  }
}

class SearchCursorStore {
  constructor(owner) { this.owner=owner; this.snapshots=new Map(); this.timer=setInterval(()=>this.expire(),30000); this.timer.unref?.(); this.catalog=new SearchCatalogCache(owner); this.catalogError=null; }
  // 搜索前同步一次（没变化时只读两个 PRAGMA）；后台写入后由引擎提前调用，把同步挪出搜索路径。
  // 同步失败不影响搜索：本次退回原来的现查路径。
  syncCatalog() {
    try { const ok=this.catalog.sync(); this.catalogError=null; return ok; }
    catch(error) { this.catalogError=error.message; this.catalog=new SearchCatalogCache(this.owner); return false; }
  }
  expire() { for(const [id,s] of this.snapshots) if(Date.now()-s.lastUsed>120000) { s.close(); this.snapshots.delete(id); } }
  search(request) {
    const started=Date.now(); this.expire(); let snapshot;
    try {
      let cursor=null;
      if(request.cursor) {
        try { cursor=JSON.parse(Buffer.from(String(request.cursor),'base64url').toString()); } catch { throw new Error('搜索游标无效，请重新搜索'); }
        snapshot=this.snapshots.get(cursor.id);
        if(!snapshot) throw new Error('搜索快照已过期，请重新搜索');
        if(JSON.stringify(normalizeRequest(request,snapshot.request.now))!==JSON.stringify(snapshot.request)) throw new Error('搜索条件已改变，请重新搜索');
        if(!['scan','page'].includes(cursor.kind) || !Number.isInteger(cursor.offset) || cursor.offset<0 || (cursor.kind==='page' && !snapshot.done)) throw new Error('搜索游标无效');
      } else {
        if(this.snapshots.size>=4) { const [id,old]=this.snapshots.entries().next().value; old.close(); this.snapshots.delete(id); }
        const normalized=normalizeRequest(request);
        snapshot=new QuerySnapshot(this.owner,normalized,this.syncCatalog()?this.catalog:null); this.snapshots.set(snapshot.id,snapshot);
      }
      snapshot.lastUsed=Date.now(); snapshot.step(this.owner.maxQueryDocs);
      return {...snapshot.response(cursor?.kind==='page'?cursor.offset:0),requestId:request.requestId,queryMs:Date.now()-started,index:this.owner.getStats()};
    } catch(error) {
      if(snapshot && !snapshot.done) { snapshot.close(); this.snapshots.delete(snapshot.id); }
      return {state:'error',error:error.message,requestId:request.requestId,results:[],totalSessions:0,totalMatches:0,total:{value:0,relation:'lowerBound'},truncated:false,facets:{providers:{},scopes:{},projects:[]},queryMs:Date.now()-started,index:this.owner.getStats()};
    }
  }
  close() { clearInterval(this.timer); for(const snapshot of this.snapshots.values()) snapshot.close(); this.snapshots.clear(); }
}
module.exports={SearchCursorStore,SearchCatalogCache,normalizeRequest,QuerySnapshot,RECENT_USER_WINDOW_MS};
