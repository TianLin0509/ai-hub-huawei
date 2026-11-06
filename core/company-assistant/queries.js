'use strict';
const W = require('./welink');
const D = require('./data');
const { WELINK_RATE_LIMITED } = require('./welink-gate');
const MEETING_PAGE_MAX = 30;
const CALENDAR_MAX = 500;
const MAIL_PAGE_SIZE = 100;
const MAIL_MAX = 500;
const CALENDAR_NON_JSON = 'WELINK_CALENDAR_NON_JSON';
const CALENDAR_TABLE_UPGRADE = 'welink-cli 返回了无法解析的表格，请升级：npm install -g @welink/welink-cli@latest（1.0.19 已验证正常）';
const FORMAT_UNSUPPORTED = 'WELINK_FORMAT_UNSUPPORTED';
const formatRejected = r => !!r && Number(r.code) !== 0 && (Number(r.code) === 109
  || /arguments?\s+were\s+not\s+expected|unrecognized\s+(?:option|argument)|no\s+such\s+option|unknown\s+option/i.test(String(r.stderr || '') + String(r.stdout || '')));
const meetingPageSize = value => Number.isFinite(Number(value)) ? Math.max(1, Math.min(MEETING_PAGE_MAX, Math.floor(Number(value)))) : MEETING_PAGE_MAX;

const calendarTableHeader = lines => lines.findIndex((line, i) => ['Subject', 'Start', 'End', 'ItemId'].every(key => new RegExp(`\\b${key}\\b`, 'i').test(line))
  && /^\s*[-=]+(?:[\s+|]+[-=]+)*\s*$/.test(lines[i + 1] || ''));
function parseCalendarTable(output) {
  const lines = String(output || '').trim().split(/\r?\n/), header = calendarTableHeader(lines);
  if (header < 0) return null;
  const rows = lines.slice(header + 2).filter(line => line.trim()), events = [], separators = new Set(), timeFormats = new Set();
  let tableInvalid = 0;
  for (const line of rows) {
    separators.add(line.includes('|') ? 'pipe' : / {2,}/.test(line) ? 'multi-space' : 'single-space');
    const times = [...line.matchAll(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?(?:Z|[+-]\d{2}:\d{2})?\b/gi)];
    for (const time of times) timeFormats.add(time[0].replace(/\d/g, '#').toUpperCase());
    if (times.length < 2) { tableInvalid += 1; continue; }
    const [start, end] = times.slice(-2), endAt = end.index + end[0].length, last = /\S+\s*$/.exec(line);
    const hasId = last && last.index >= endAt, token = hasId ? last[0].trim() : '';
    const tail = line.slice(endAt, hasId ? last.index : line.length).trim().split(/ {2,}/);
    events.push({ subject: line.slice(0, start.index).trim(), start: start[0], end: end[0], location: tail.length >= 3 ? tail[0] : '', itemId: /(?:\.\.\.|…)$/.test(token) ? '' : token });
  }
  return { events, tableInvalid, tableFormat: { totalRows: rows.length, parsedRows: events.length, invalidRows: tableInvalid, separators: [...separators].sort(), timeFormats: [...timeFormats].sort() } };
}

function readableError(value, depth = 0) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || depth >= 3) return '';
  // 不把整份错误响应写入界面（可能附带账号/请求上下文），只取明确的错误说明。
  for (const key of ['message', 'msg', 'error_msg', 'description', 'reason', 'detail']) {
    const text = readableError(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

// 命令执行成功、业务成功、JSON 可读是三个条件。联系人成功码为 0，会议为 200。
async function readJson(run, args, { diagnose = async () => {} } = {}) {
  const command = args.slice(0, 2).join(' ');
  let result = await run(args);
  const checkExit = r => {
    if (r.code === null || r.code !== undefined && Number(r.code) !== 0) throw new Error(String(r.stderr || r.stdout || `查询退出码 ${r.code}`).trim());
  };
  checkExit(result);
  // Q-1021-07：仅 calendar list 的成功空结果是纯文本；不接受其他命令或失败退出。
  if (command === 'calendar list' && [0, '0'].includes(result.code) && String(result.stdout || '').trim() === 'No events found.') return [];
  let data = W.parseJsonBig(result.stdout);
  const calendarNonJson = data == null && command === 'calendar list';
  const lines = calendarNonJson ? String(result.stdout || '').trim().split(/\r?\n/) : [];
  const calendarTable = calendarNonJson && calendarTableHeader(lines) >= 0;
  const table = calendarTable ? parseCalendarTable(result.stdout) : null;
  if (calendarNonJson) await diagnose(command, null, table ? { tableFormat: table.tableFormat } : undefined);
  if (data == null && !args.includes('--format') && (!calendarNonJson || calendarTable)) {
    if (calendarTable) {
      // 旧 CLI 可能不支持 --format；不能用重试错误覆盖原始非 JSON 情况。
      try {
        const retry = await run([...args, '--format', 'json']);
        checkExit(retry); result = retry; data = W.parseJsonBig(result.stdout);
      } catch (error) { if (error.code === WELINK_RATE_LIMITED) throw error; /* 不支持 --format 时解析首次表格 */ }
    } else {
      // 1.0.20 删掉了 mail / calendar 的 --format（传了就退出码 109「arguments were not expected」，Q-1106-06）：
      // 说清楚是新版格式还没适配，不把英文原文抛给用户。
      const retry = await run([...args, '--format', 'json']);
      if (formatRejected(retry)) throw Object.assign(new Error(`${command} 的输出格式这一版 Hub 还没适配（welink-cli 新版去掉了 --format），这一项暂时取不到`), { code: FORMAT_UNSUPPORTED });
      result = retry; checkExit(result); data = W.parseJsonBig(result.stdout);
    }
  }
  if (command === 'calendar list' && [0, '0'].includes(result.code) && String(result.stdout || '').trim() === 'No events found.') return [];
  if (calendarTable && (!data || typeof data !== 'object')) {
    if (table.events.length) return { events: table.events, tableInvalid: table.tableInvalid };
    throw Object.assign(new Error(CALENDAR_TABLE_UPGRADE), { code: CALENDAR_NON_JSON, tableInvalid: table.tableInvalid });
  }
  if (!data || typeof data !== 'object') throw new Error(String(result.stderr || result.stdout || '查询没有返回 JSON').trim());
  const code = data.code ?? data.resultCode ?? data.error?.error_code;
  // Q-1021-08：会话目录成功码是 IM.0000；仅对该命令接受，不能放开所有 IM 错误。
  const allowed = command === 'contact detail' ? ['0'] : command === 'meeting query-list' ? ['200']
    : command === 'im query-recent-conversation' ? ['0', '200', 'IM.0000'] : ['0', '200'];
  if (code !== undefined && !allowed.includes(String(code))) {
    const detail = [data.message, data.resultContext, data.error?.error_msg].map(x => readableError(x)).find(Boolean);
    throw new Error(`${command} 查询业务码 ${code}${detail ? '：' + detail : ''}`);
  }
  return data;
}

function meetingType(value) {
  const type = String(value);
  if (!['1', '2'].includes(type)) throw new Error('会议查询类型只能为待参加（1）或已结束（2）');
  return type;
}
const meetingTypeLabel = type => type === '2' ? '已结束' : '待参加';

function meetingArgs(now, page = 1, size = MEETING_PAGE_MAX, range = null, type = '1') {
  type = meetingType(type);
  const begin = range?.start ?? Date.parse(D.dayKey(now) + 'T00:00:00+08:00');
  const end = (range?.end ?? begin + 86400000) - 1;
  return ['meeting', 'query-list', '--page', String(page), '--size', String(meetingPageSize(size)), '--meeting-start-time', String(begin), '--meeting-end-time', String(end), '--type', type, '--meeting-sort', 'asc'];
}

async function collectMeetings(runJson, now, { size = MEETING_PAGE_MAX, maxPages = 30, range = null, type = '1', diagnose = async () => {} } = {}) {
  type = meetingType(type);
  size = meetingPageSize(size); // 参数与短页判断必须使用同一个实际页大小。
  const found = new Map(), instances = new Map();
  const coverage = { status: 'partial', reason: 'page-limit', pages: 0, total: null, invalid: 0, instances: 0, versionConflicts: 0, scope: `指定日期范围内${meetingTypeLabel(type)}的 WeLink 会议（type=${type}）`, queryType: type, queryTypes: [type] };
  for (let page = 1; page <= maxPages; page += 1) {
    let raw;
    try { raw = await runJson(`${meetingTypeLabel(type)}会议`, meetingArgs(now, page, size, range, type)); }
    catch (error) {
      if (error.code !== WELINK_RATE_LIMITED) throw error;
      coverage.status = 'deferred'; coverage.reason = 'rate-limited'; break;
    }
    coverage.pages += 1;
    if (!raw) { coverage.reason = 'query-failed'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    // Q-1021-09：成功空页省略列表字段；只接受与本次请求匹配的已核实包络。
    const emptyPage = raw.code === 200 && raw.data && !Array.isArray(raw.data)
      && raw.data.total === 0 && raw.data.page === page && raw.data.size === size
      && !Object.prototype.hasOwnProperty.call(raw.data, 'data');
    if (!Array.isArray(raw.data?.data) && !emptyPage) { await diagnose('meeting query-list', raw); coverage.reason = 'invalid-shape'; coverage.status = found.size ? 'partial' : 'failed'; break; }
    const records = emptyPage ? [] : raw.data.data, rows = D.meetings(raw);
    const previous = found.size;
    // 完全相同记录的分页重叠可消除；同编号的不同实例/记录版本全部保留。
    for (const row of rows) {
      found.set(row.sourceId, { ...row, queryTypes: [type] });
      const id = row.occurrenceId || row.sourceId, versions = instances.get(id) || new Set();
      const previousVersions = versions.size;
      versions.add(row.sourceId); instances.set(id, versions);
      if (previousVersions === 1 && versions.size === 2) coverage.versionConflicts += 1;
    }
    coverage.instances = instances.size;
    coverage.invalid += records.length - rows.length;
    coverage.timeUnknown = (coverage.timeUnknown || 0) + rows.filter(D.eventTimeUnknown).length;
    const total = Number(raw.data.total);
    // 越界空页报告 total=0，并不表示前页的正总数消失；取不足时仍须报 early-end。
    if (raw.data.total != null && Number.isFinite(total) && total >= 0
      && !(records.length === 0 && total === 0 && coverage.total > 0)) coverage.total = total;
    if (rows.length && found.size === previous) { coverage.reason = 'repeated-page'; break; }
    // 总数可能包含分页重叠，记录版本数也不是独立实例数；满页继续取到真实边界。
    if (records.length < size) { coverage.reason = 'exhausted'; break; }
  }
  if (coverage.reason === 'exhausted') {
    const fewer = coverage.total !== null && instances.size < coverage.total;
    const more = coverage.total !== null && instances.size > coverage.total;
    coverage.status = coverage.invalid || coverage.timeUnknown || coverage.versionConflicts || fewer || more ? 'partial' : 'complete';
    coverage.reason = coverage.timeUnknown ? 'unknown-time' : coverage.invalid ? 'invalid-record' : coverage.versionConflicts ? 'version-conflict' : fewer ? 'early-end' : more ? 'total-mismatch' : 'exhausted';
  }
  coverage.reasonLabel = { 'rate-limited': 'WeLink 限流，已保留上次结果', 'page-limit': '会议超过本轮分页上限', 'query-failed': '会议查询失败，日历仍可补充', 'invalid-shape': '会议返回结构与已核对接口不一致',
    'invalid-record': '部分会议缺少时间或编号', 'unknown-time': '部分会议的时间或时区待核对', 'early-end': '会议实例数少于接口报告的总数', 'total-mismatch': '会议实例数超过接口报告的总数，查询期间数据可能变化',
    'version-conflict': `${coverage.versionConflicts} 个会议实例存在不同记录版本，待核对`, 'repeated-page': '会议接口重复返回已取得的记录', exhausted: '会议查询完成' }[coverage.reason];
  if (coverage.versionConflicts && coverage.reason !== 'version-conflict') coverage.reasonLabel += `；${coverage.versionConflicts} 个会议实例存在不同记录版本，待核对`;
  return { meetings: [...found.values()].sort((a, b) => a.start - b.start), coverage };
}

async function collectMeetingAgenda(runJson, now, options = {}) {
  // Q-1021-09：type1 不包含已结束会议；分别查两类，不能把 type4 推断为仅本人。
  const queryTypes = ['1', '2'], found = new Map(), instances = new Map(), byType = {};
  for (const type of queryTypes) {
    const result = await collectMeetings(runJson, now, { ...options, type });
    byType[type] = result.coverage;
    for (const row of result.meetings) {
      const prior = found.get(row.sourceId);
      found.set(row.sourceId, { ...row, queryTypes: [...new Set([...(prior?.queryTypes || []), type])] });
      const id = row.occurrenceId || row.sourceId, versions = instances.get(id) || new Set();
      versions.add(row.sourceId); instances.set(id, versions);
    }
  }
  const meetings = [...found.values()].sort((a, b) => a.start - b.start);
  const parts = Object.values(byType), versionConflicts = [...instances.values()].filter(x => x.size > 1).length;
  const complete = parts.every(x => x.status === 'complete') && !versionConflicts;
  const failed = parts.every(x => x.status === 'failed');
  const queryFailed = parts.every(x => x.reason === 'query-failed');
  const limited = parts.some(x => x.reason === 'rate-limited');
  const status = limited ? 'deferred' : complete ? 'complete' : failed ? 'failed' : 'partial';
  return { meetings, coverage: {
    status, reason: limited ? 'rate-limited' : versionConflicts ? 'version-conflict' : complete ? 'exhausted' : queryFailed ? 'query-failed' : failed ? 'category-failed' : 'category-incomplete',
    reasonLabel: limited ? 'WeLink 限流，已保留上次结果' : queryTypes.map(type => `${meetingTypeLabel(type)}：${byType[type].reasonLabel}`).join('；')
      + (versionConflicts ? `；${versionConflicts} 个会议实例存在不同记录版本，待核对` : ''),
    pages: parts.reduce((sum, x) => sum + x.pages, 0),
    // 状态切换时两类可能重叠；总数不能简单相加，各类接口总数留在 byType 中。
    total: complete ? instances.size : null, instances: instances.size,
    invalid: parts.reduce((sum, x) => sum + x.invalid, 0), timeUnknown: meetings.filter(D.eventTimeUnknown).length, versionConflicts,
    scope: '指定日期范围内待参加及已结束的 WeLink 会议（type=1,2）', queryType: queryTypes.join(','), queryTypes, byType,
  } };
}

async function collectCalendar(runJson, range, { diagnose = async () => {} } = {}) {
  // calendar list 使用日期边界，至少覆盖到下一天；最终按精确窗口过滤。
  const start = D.dayKey(range.start), endDay = D.dayKey(range.end);
  const end = Date.parse(endDay + 'T00:00:00+08:00') < range.end ? D.dayKey(range.end + 86400000) : endDay;
  let raw;
  try { raw = await runJson('日程', ['calendar', 'list', '--start', start, '--end', end, '--max', String(CALENDAR_MAX)]); }
  catch (error) {
    if (error.code !== CALENDAR_NON_JSON) throw error;
    return { events: [], coverage: { status: 'failed', reason: 'non-json', reasonLabel: error.message, records: error.tableInvalid || 0, invalid: error.tableInvalid || 0 } };
  }
  if (!raw) return { events: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: 'Exchange 日程查询失败' } };
  const records = D.recordsAt ? D.recordsAt(raw, ['events', 'items', 'value', 'calendars', 'data']) : recordsAt(raw);
  if (records === null) { await diagnose('calendar list', raw); return { events: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '无法识别日程结构；不能当作没有日程' } }; }
  const tableInvalid = Number.isInteger(raw.tableInvalid) && raw.tableInvalid >= 0 ? raw.tableInvalid : 0;
  const cancelled = records.filter(D.isCancelledCalendarEvent).length;
  const all = D.calendarEvents(raw), recordCount = records.length + tableInvalid, invalid = records.length - cancelled - all.length + tableInvalid;
  const unknownTime = all.filter(D.eventTimeUnknown).length;
  const envelopes = [raw, raw.data, raw.result, raw.data?.result].filter(x => x && typeof x === 'object');
  const total = envelopes.map(x => x.total ?? x.count).find(x => x != null);
  const flag = x => x === true || x === 'true' || x === 1;
  const hasMore = envelopes.some(x => flag(x.hasMore) || flag(x.has_more) || x.nextLink || x.next_link || x.next_cursor || x['@odata.nextLink'])
    || total != null && (!Number.isFinite(Number(total)) || Number(total) > records.length);
  const limited = recordCount >= CALENDAR_MAX;
  const coverage = { status: invalid || unknownTime || hasMore || limited ? 'partial' : 'complete', records: recordCount, cancelled, invalid, unknownTime, limited, limit: CALENDAR_MAX,
    reason: hasMore ? 'more-records' : limited ? 'result-limit' : invalid ? 'invalid-record' : unknownTime ? 'unknown-time' : 'exhausted',
    reasonLabel: hasMore ? '接口还有日程，分页协议尚未核实' : limited ? `已达到日程 ${CALENDAR_MAX} 条返回上限，可能还有记录；分页协议尚未核实` : invalid ? `${invalid} 条日程无法解析` : unknownTime ? `${unknownTime} 条日程时间待核对` : '日程查询完成' };
  if (Object.prototype.hasOwnProperty.call(raw, 'tableInvalid')) {
    if (invalid && coverage.reason !== 'invalid-record') coverage.reasonLabel += `；${invalid} 条日程无法解析`;
    if (unknownTime && coverage.reason !== 'unknown-time') coverage.reasonLabel += `；${unknownTime} 条日程时间待核对`;
  }
  if (cancelled) coverage.reasonLabel += `；已过滤 ${cancelled} 条已取消日程`;
  return { events: all.filter(x => D.eventInRange(x, range)), coverage };
}
function recordsAt(raw) {
  if (Array.isArray(raw)) return raw.every(x => x && typeof x === 'object') ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['events', 'items', 'value', 'calendars', 'data']) if (raw[key] !== undefined) { const found = recordsAt(raw[key]); if (found !== null) return found; }
  return null;
}
function mailRecords(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['mails', 'messages', 'items', 'value', 'data']) if (raw[key] !== undefined) { const found = mailRecords(raw[key]); if (found !== null) return found; }
  return null;
}
function mailResult(raw) {
  if (!raw) return { mails: [], coverage: { status: 'failed', reason: 'query-failed', reasonLabel: '未读邮件查询失败' } };
  const records = mailRecords(raw);
  if (records === null) return { mails: [], coverage: { status: 'failed', reason: 'invalid-shape', reasonLabel: '未读邮件结构无法识别' } };
  const mails = D.mails(raw), total = raw.total ?? raw.data?.total;
  const limited = records.length >= 20 || raw.hasMore === true || raw.data?.hasMore === true || total != null && Number(total) > records.length;
  return { mails, coverage: { status: limited ? 'partial' : 'complete', records: records.length, limit: 20,
    reason: limited ? 'preview-limit' : 'exhausted', reasonLabel: limited ? `已取 ${records.length} 封；当前为未读预览，不能视为全部未读` : `取到 ${records.length} 封未读邮件` } };
}

async function collectMails(runJson, { diagnose = async () => {} } = {}) {
  const found = new Map();
  const coverage = { status: 'partial', reason: 'result-limit', pages: 0, records: 0, rawCount: 0, limit: MAIL_MAX, pageSize: MAIL_PAGE_SIZE };
  let offset = 0;
  while (offset < MAIL_MAX) {
    const raw = await runJson('未读邮件', ['mail', 'list', '--is-read', '0', '--max', String(MAIL_PAGE_SIZE), '--offset', String(offset)]);
    coverage.pages += 1;
    if (!raw) { coverage.status = found.size ? 'partial' : 'failed'; coverage.reason = 'query-failed'; coverage.failedPage = coverage.pages; break; }
    const records = mailRecords(raw);
    if (records === null || !records.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
      await diagnose('mail list', raw);
      coverage.status = found.size ? 'partial' : 'failed'; coverage.reason = 'invalid-shape'; break;
    }
    const previous = found.size;
    for (const row of D.mails(records)) if (!found.has(row.id) && found.size < MAIL_MAX) found.set(row.id, row);
    offset += records.length; coverage.rawCount = offset;
    if (records.length && found.size === previous) { coverage.reason = 'repeated-page'; break; }
    if (offset >= MAIL_MAX) break;
    if (records.length < MAIL_PAGE_SIZE) {
      const total = raw.total ?? raw.data?.total;
      const hasMore = raw.hasMore === true || raw.data?.hasMore === true || total != null && Number(total) > found.size;
      coverage.status = hasMore ? 'partial' : 'complete'; coverage.reason = hasMore ? 'early-end' : 'exhausted'; break;
    }
  }
  coverage.records = found.size;
  coverage.reasonLabel = {
    'query-failed': found.size ? `已取 ${found.size} 封；第 ${coverage.failedPage} 页查询失败，未读邮件未取全` : '未读邮件查询失败',
    'invalid-shape': `已取 ${found.size} 封；无法识别未读邮件结构，未读邮件未取全`,
    'repeated-page': `已取 ${found.size} 封；接口重复返回邮件，未读邮件未取全`,
    'result-limit': `已取 ${found.size} 封；已达 ${MAIL_MAX} 封取数上限，可能还有未读邮件`,
    'early-end': `已取 ${found.size} 封；接口仍报告有邮件，未读邮件未取全`,
    exhausted: `取到 ${found.size} 封未读邮件`,
  }[coverage.reason];
  // 只使用 D.mails 已有的时间转换结果；未知时间最后放置，稳定排序保留其原顺序。
  const mails = [...found.values()].sort((a, b) => Number.isFinite(a.at) && Number.isFinite(b.at) ? b.at - a.at : Number.isFinite(a.at) ? -1 : Number.isFinite(b.at) ? 1 : 0);
  return { mails, coverage };
}

module.exports = { readJson, parseCalendarTable, meetingArgs, collectMeetings, collectMeetingAgenda, collectCalendar, mailResult, collectMails, CALENDAR_NON_JSON };
