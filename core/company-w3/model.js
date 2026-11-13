'use strict';
// 公司门户首页数据的整理（纯函数，不碰网络和磁盘）：
//   normalize   把页面里取回的原始形状整理成统一的条目；
//   merge       和上一次快照比：哪些是新来的、哪些办完消失了；每条记下第一次见到的时间；
//   noticesFor  该提醒什么：新待办、挂了很久的待办、卡了很久的申请；
//   briefLines  给助理简报用的两三行话。
// 时间一律用门户返回的「YYYY-MM-DD HH:MM:SS」（公司所在时区的墙上时间），按本机时区解析。

const DOC_LABELS = Object.freeze({ policy: '政策与讲话', corporate: '公司文件', bulletins: '公告', xinsheng: '心声热点', hwperson: '人物故事' });
const STALE_TODO_DAYS = [7, 30];   // 待办挂到第 7 天、第 30 天各提醒一次
const STUCK_APPLY_DAYS = [5, 14];  // 申请卡到第 5 天、第 14 天各提醒一次
const DOC_KEEP = 20;

const str = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
function parseTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : 0;
}
function ageDays(time, nowMs) { const t = parseTime(time); return t ? Math.max(0, Math.floor((nowMs - t) / 86400000)) : null; }
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
// 「账号 工号」「账号/账号」这类写法只留人能读的部分；没有姓名时原样保留。
function personLabel(v) { return str(v, 60).replace(/\s+\d{6,}$/, ''); }

function itemFrom(raw, app, kind) {
  const desc = str(raw.taskDesc, 300);
  const id = str(raw.taskUUID, 120) || `${app}|${str(raw.time, 19)}|${desc.slice(0, 40)}`;
  return {
    id, kind, app, title: desc, url: str(raw.taskURL, 600), host: hostOf(raw.taskURL), time: str(raw.time, 19),
    from: personLabel(raw.applicant), handler: personLabel(raw.handler), quickApprove: String(raw.quickApprove) === '1',
  };
}

function normalize(raw, at) {
  const out = { at, ok: false, login: !!raw?.login, me: null, todo: [], apply: [], counts: { todo: 0, apply: 0, task: 0 }, docs: {}, partial: [] };
  if (!raw || !raw.login) return out;
  out.ok = true;
  out.me = raw.me || null;
  for (const [kind, src] of [['todo', raw.todo], ['apply', raw.apply]]) {
    if (!src) { out.partial.push(kind); continue; }
    for (const a of src.apps || []) {
      const app = str(a.app, 80);
      for (const it of a.items || []) out[kind].push(itemFrom(it, app, kind));
      // 没取到，或取到的条数少于这个系统报的条数（分页没取全）：这一类不能拿来判断谁办完了。
      if (a.listed == null || (a.items || []).length < Math.max(Number(a.listed) || 0, Number(a.count) || 0)) out.partial.push(`${kind}:${app}`);
    }
    out.counts[kind] = kind === 'todo' && Number.isFinite(src.count) ? src.count : (src.apps || []).reduce((s, a) => s + (Number(a.count) || 0), 0);
  }
  if (raw.task) out.counts.task = Number(raw.task.count) || 0; else out.partial.push('task');
  if (raw.docs) {
    for (const key of Object.keys(DOC_LABELS)) {
      const list = raw.docs[key]?.[0]?.documents;
      if (!Array.isArray(list)) continue;
      out.docs[key] = list.slice(0, DOC_KEEP).map((d) => ({
        title: str(d.title, 200), code: str(d.code, 60), dept: str(d.deptname, 60), date: str(d.publishdate, 19),
        url: str(d.doc_url || d.url, 600).replace(/^http:/, 'https:'), abstract: str(d.docAbstract, 400),
      }));
    }
  } else out.partial.push('docs');
  return out;
}

// prev：上一次 merge 的结果（或 null）。每条待办和申请带上 firstSeen；done 是这次消失的（办完或被撤回）。
function merge(prev, cur) {
  const snap = { ...cur, added: { todo: [], apply: [], docs: [] }, done: { todo: [], apply: [] }, first: !prev };
  for (const kind of ['todo', 'apply']) {
    const before = new Map((prev?.[kind] || []).map((x) => [x.id, x]));
    const partial = cur.partial.includes(kind) || cur.partial.some((p) => p.startsWith(kind + ':'));
    snap[kind] = cur[kind].map((x) => {
      const old = before.get(x.id);
      before.delete(x.id);
      if (!old && prev) snap.added[kind].push(x.id);
      return { ...x, firstSeen: old?.firstSeen || cur.at, told: old?.told || [] };
    });
    // 这一类没取全时，不把「没看到」当成「办完了」，原样留着等下次。
    if (partial) for (const old of before.values()) snap[kind].push(old);
    else snap.done[kind] = [...before.values()].map((x) => ({ id: x.id, app: x.app, title: x.title }));
  }
  const seenDocs = new Set(Object.values(prev?.docs || {}).flat().map((d) => d.url || d.title));
  for (const key of Object.keys(cur.docs)) {
    if (!prev || !prev.docs?.[key]) continue;
    for (const d of cur.docs[key]) if (!seenDocs.has(d.url || d.title)) snap.added.docs.push({ ...d, cat: key });
  }
  if (cur.partial.includes('docs') && prev) snap.docs = prev.docs;
  return snap;
}

// 返回要发的提醒，并在快照条目上记下已提醒到哪一档（told），同一条同一档只说一次。第一次取数不为存量逐条提醒，只报一个总数。
function noticesFor(snap, nowMs) {
  const out = [];
  const base = { kind: 'w3', notify: true, page: 'w3' };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (snap.first) {
    if (snap.todo.length) out.push({ ...base, id: 'w3-first:' + day, title: `门户上有 ${snap.todo.length} 条待办`, text: oldestLine(snap.todo, nowMs), cta: '看待办' });
    for (const kind of ['todo', 'apply']) for (const x of snap[kind]) x.told = [...(kind === 'todo' ? STALE_TODO_DAYS : STUCK_APPLY_DAYS)].filter((d) => (ageDays(x.time, nowMs) ?? 0) >= d);
    return out;
  }
  const fresh = snap.todo.filter((x) => snap.added.todo.includes(x.id));
  if (fresh.length === 1) out.push({ ...base, id: 'w3-todo:' + fresh[0].id, title: `新待办：${fresh[0].app}`, text: fresh[0].title.slice(0, 120), cta: '看待办' });
  else if (fresh.length > 1) out.push({ ...base, id: 'w3-todo:' + fresh.map((x) => x.id).join(',').slice(0, 100), title: `新来 ${fresh.length} 条待办`, text: fresh.slice(0, 3).map((x) => `${x.app}：${x.title.slice(0, 40)}`).join('；'), cta: '看待办' });
  for (const [kind, steps, word] of [['todo', STALE_TODO_DAYS, '待办挂了'], ['apply', STUCK_APPLY_DAYS, '申请卡了']]) {
    for (const x of snap[kind]) {
      const age = ageDays(x.time, nowMs);
      const step = [...steps].reverse().find((d) => age != null && age >= d && !(x.told || []).includes(d));
      if (!step) continue;
      x.told = [...new Set([...(x.told || []), ...steps.filter((d) => d <= step)])];
      if (kind === 'todo' && snap.added.todo.includes(x.id)) continue; // 刚出现的待办已经按「新待办」说过，不重复说它旧
      const who = kind === 'apply' && x.handler ? `，现在在 ${x.handler} 手上` : '';
      out.push({ ...base, id: `w3-${kind}-stale:${x.id}:${step}`, tone: 'bad', title: `${word} ${age} 天：${x.app}`, text: x.title.slice(0, 100) + who, cta: kind === 'todo' ? '看待办' : '看申请' });
    }
  }
  return out;
}

function oldestLine(todo, nowMs) {
  const aged = todo.map((x) => ({ x, age: ageDays(x.time, nowMs) })).filter((v) => v.age != null).sort((a, b) => b.age - a.age);
  if (!aged.length) return '';
  const old = aged.filter((v) => v.age >= 30).length;
  return `最久的一条已挂 ${aged[0].age} 天（${aged[0].x.app}）` + (old > 1 ? `，${old} 条超过 30 天` : '');
}

// 给助理简报：两三行话，没有内容时返回空数组。
function briefLines(snap, nowMs) {
  if (!snap?.ok) return [];
  const lines = [];
  if (snap.todo.length) lines.push(`门户待办 ${snap.todo.length} 条。${oldestLine(snap.todo, nowMs)}`.trim());
  const stuck = snap.apply.map((x) => ({ x, age: ageDays(x.time, nowMs) })).filter((v) => v.age != null && v.age >= STUCK_APPLY_DAYS[0]).sort((a, b) => b.age - a.age);
  if (stuck.length) lines.push(`你提的申请有 ${stuck.length} 条卡了 ${STUCK_APPLY_DAYS[0]} 天以上：` + stuck.slice(0, 2).map((v) => `${v.x.app}（${v.age} 天${v.x.handler ? '，在 ' + v.x.handler + ' 手上' : ''}）`).join('、'));
  const today = new Date(nowMs); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const speeches = (snap.docs.policy || []).filter((d) => nowMs - parseTime(d.date) < 86400000 * 2 || d.date.startsWith(key));
  if (speeches.length) lines.push(`公司新发 ${speeches.length} 篇讲话：` + speeches.slice(0, 2).map((d) => `《${d.title.slice(0, 36)}》`).join('、'));
  return lines;
}

module.exports = { normalize, merge, noticesFor, briefLines, ageDays, parseTime, personLabel, DOC_LABELS, STALE_TODO_DAYS, STUCK_APPLY_DAYS };
