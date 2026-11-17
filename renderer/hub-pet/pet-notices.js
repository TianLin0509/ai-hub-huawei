'use strict';
// 警示色表示需要注意；只有消息生产者明确报告执行错误，才改变类别抬头。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubPetNotices = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const KIND = Object.freeze({ reminder: '重要提醒', digest: '定时汇总', brief: '简报', 'meeting-prep': '会前准备', 'awaiting-reply': '等你回复', 'commitment-due': '答应的事', overbooked: '会议太满', 'day-summary': '下班小结', keyword: '关注词',
    session: '会话完成', web: '网页会话', bridge: '联动消息', 'hub-reminder': '到点提醒', answer: '助理回答', room: '会议室', attendance: '考勤', 'welink-login': 'WeLink', 'pet-role': '形象', disk: '硬盘', update: '新版本', chatter: '', weekly: '周报', growth: '成长' });
  function label(item = {}, fallback = '通知') { return item.err === true ? '出错了' : (KIND[item.kind] || fallback); }
  // 事件道具（2026-11-17 r27c）：正在说的这条配哪件道具。出错只认 err:true；警示色（磁盘、考勤等）不算出错。
  const DONE = { session: 1, web: 1, answer: 1 };
  function prop(item) {
    if (!item) return '';
    if (item.err === true) return 'err';
    if (item.kind === 'disk') return 'disk';
    if (item.kind === 'update') return 'gift';
    if (item.kind === 'awaiting-reply') return 'wait';
    return DONE[item.kind] && item.tone !== 'bad' ? 'done' : '';
  }
  // 身上常驻的道具：说话的道具优先；没在说时，开会戴耳机，额度低头顶亮低电量。
  // 安静档（r27d）：不挂事件道具和低电量，只亮小圆点；开会耳机照旧（会议规则单独约定）。
  function stateProp(state = {}) {
    if (state.peeking) return '';
    if (state.mode === 'quiet') return state.meeting === true ? 'meeting' : '';
    return prop(state.bubble) || (state.meeting === true ? 'meeting' : state.quotaLow === true ? 'battery' : '');
  }
  return { KIND, label, prop, stateProp };
});
