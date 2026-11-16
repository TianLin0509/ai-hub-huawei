'use strict';
// 警示色表示需要注意；只有消息生产者明确报告执行错误，才改变类别抬头。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubPetNotices = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const KIND = Object.freeze({ reminder: '重要提醒', digest: '定时汇总', brief: '简报', 'meeting-prep': '会前准备', 'awaiting-reply': '等你回复', 'commitment-due': '答应的事', overbooked: '会议太满', 'day-summary': '下班小结', keyword: '关注词',
    session: '会话完成', web: '网页会话', bridge: '联动消息', 'hub-reminder': '到点提醒', answer: '助理回答', room: '会议室', attendance: '考勤', 'welink-login': 'WeLink', 'pet-role': '形象', disk: '硬盘', update: '新版本', chatter: '', weekly: '周报', growth: '成长' });
  function label(item = {}, fallback = '通知') { return item.err === true ? '出错了' : (KIND[item.kind] || fallback); }
  return { KIND, label };
});
