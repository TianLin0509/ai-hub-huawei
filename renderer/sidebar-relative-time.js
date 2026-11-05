'use strict';

// Compact sidebar labels; full timestamps remain available in the row tooltip.
// The company shell (data-hw-shell) uses Chinese words in the body font instead of the monospace "NOW / 5M".
const chineseShell = () => typeof document !== 'undefined' && !!document.documentElement?.dataset?.hwShell;
function sidebarRelativeTime(ts, now = Date.now(), { chinese = chineseShell() } = {}) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '—';
  const minutes = Math.max(0, Math.floor((now - Number(ts)) / 60000));
  if (chinese) {
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时`;
    return `${Math.floor(minutes / 1440)} 天`;
  }
  if (minutes < 1) return 'NOW';
  if (minutes < 60) return `${minutes}M`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}H`;
  return `${Math.floor(minutes / 1440)}D`;
}

module.exports = { sidebarRelativeTime };
