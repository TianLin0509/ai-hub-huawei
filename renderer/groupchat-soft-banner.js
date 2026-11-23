'use strict';
// 群聊顶部横幅（等太久提醒、操作失败提示）按群聊记住：面板每次整块重绘都照着重新画出来，
// 不会刚弹出就被下一次刷新抹掉；用户点 × 才收起。「等太久」类提醒在本轮结束后自动收起。

function createSoftBannerStore() {
  const byMeeting = new Map();
  function html(meetingId, mode) {
    const cur = byMeeting.get(meetingId);
    if (cur && cur.kind === 'soft' && (!mode || mode === 'idle')) byMeeting.delete(meetingId);
    const b = byMeeting.get(meetingId);
    return `<div id="mr-gc-soft-alert-banner" class="mr-gc-soft-alert-banner${b && b.cls ? ' ' + b.cls : ''}" style="display:${b ? 'flex' : 'none'}">${b ? b.html : ''}</div>`;
  }
  // entry: { kind: 'soft' | 'notice', cls, html }；传 null 收起。
  function set(meetingId, entry) {
    if (!meetingId) return;
    if (entry) byMeeting.set(meetingId, entry); else byMeeting.delete(meetingId);
  }
  // 把当前记住的横幅写到已经在页面上的横幅元素上（不必整块重绘）。
  function paint(meetingId, el) {
    if (!el) return false;
    const b = byMeeting.get(meetingId);
    el.className = `mr-gc-soft-alert-banner${b && b.cls ? ' ' + b.cls : ''}`;
    el.innerHTML = b ? b.html : '';
    el.style.display = b ? 'flex' : 'none';
    return true;
  }
  return { html, set, paint, get: id => byMeeting.get(id) || null };
}

module.exports = { createSoftBannerStore };
