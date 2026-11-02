'use strict';

function messageCoverage(scope) {
  if (!scope) return null;
  const rotation = scope.rotating ? `${scope.priorityPending ? '可能有新消息的会话正优先更新' : '已优先核对可能有新消息的会话'}，其余定期核对（本轮更新 ${scope.completed || 0}/${scope.scheduled ?? scope.known ?? 0} 个会话）${scope.neverFetched ? `；${scope.neverFetched} 个会话尚未首次取到` : ''}` : '';
  const reasons = [scope.stale ? '最近会话查询失败，显示上次记录' : '', scope.rateLimited ? `WeLink 限流，已取 ${scope.completed || 0} 个会话，其余下轮继续` : scope.partial ? `${scope.partial} 个会话未取全` : '',
    !scope.rateLimited ? rotation : '',
    scope.listFull ? `最近会话返回 ${scope.listed || scope.listCap} 个，可能达到接口上限，未知会话仍可能遗漏` : '', scope.directoryFallback ? '已退回兼容查询，覆盖待核对' : '', scope.limited ? `按设置只查询最近 ${scope.maxConversations} 个会话` : '',
    scope.directoryInvalid ? `${scope.directoryInvalid} 条会话目录记录无法解析` : '', (scope.conversations || []).some(c => c.unknownTime) ? '部分消息缺少时间，无法确认是否覆盖所选时段' : ''].filter(Boolean);
  const rotating = rotation && !scope.rateLimited && !scope.partial && !scope.stale && !scope.directoryFallback && !scope.directoryInvalid && !(scope.conversations || []).some(c => c.unknownTime);
  return { status: rotating ? 'rotating' : reasons.length ? 'partial' : 'complete', ...(scope.rateLimited ? { reason: 'rate-limited' } : rotating ? { reason: 'rotation' } : {}), reasonLabel: reasons.join('；') };
}

function queryStatus(coverage, error, count) {
  if (coverage?.status === 'failed' || !coverage && error) return { label: '查询失败', color: 'warn', detail: error?.text || coverage?.reasonLabel || '' };
  if (coverage?.status === 'partial') return { label: '未取全', color: 'warn', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'rotating') return { label: '轮转中', color: 'ok', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'complete') return { label: `已取到 ${count ?? 0} 条`, color: 'ok', detail: '' };
  return { label: '', color: '', detail: '尚未确认' };
}

const errorMatches = (name, error) => error.label.startsWith(name) || name === '消息' && error.label.startsWith('最近会话');

function queryRows(data) {
  const errors = data.errors || [];
  return [['会议', data.counts?.meetings, data.meetingCoverage], ['日程', data.counts?.calendar, data.calendarCoverage],
    ['消息', data.counts?.messages, messageCoverage(data.scope)], ['未读邮件', data.counts?.mails, data.mailCoverage]]
    .map(([name, count, coverage]) => ({ name, ...queryStatus(coverage, errors.find(error => errorMatches(name, error)), count) }));
}

function refreshNotice(data) {
  const rows = queryRows(data);
  for (const error of data.errors || []) if (!rows.some(row => errorMatches(row.name, error))) rows.push({ name: error.label, ...queryStatus(null, error) });
  const failed = [...new Set(rows.filter(row => row.label === '查询失败').map(row => row.name))];
  const partial = [...new Set(rows.filter(row => row.label === '未取全').map(row => row.name))];
  return [failed.length ? `有 ${failed.length} 项没取到：${failed.join('、')}` : '', partial.length ? `有 ${partial.length} 项未取全：${partial.join('、')}` : ''].filter(Boolean).join('；');
}

module.exports = { messageCoverage, queryStatus, queryRows, refreshNotice };
