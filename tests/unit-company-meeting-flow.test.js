'use strict';
const assert = require('node:assert/strict');
const { flowEntries, meetingNavigation } = require('../renderer/company-meeting-flow');
const meeting = {
  startedAt: 100000, capturedMs: 20000, state: 'ended',
  events: [
    { seq: 3, kind: 'mark', at: 15000, text: '需要补测' },
    { seq: 1, kind: 'slide', at: 1000 },
    { seq: 2, kind: 'transcript', at: 7000, text: '算法 A 暂不采用' },
    { seq: 4, kind: 'audio', at: 1000 },
  ],
  answers: [
    { id: 'during', queuedAt: 110000, at: 140000, q: '谁负责？' },
    { id: 'after', queuedAt: 130000, q: '复盘一下' },
    { id: 'legacy', q: '旧问题没有时间' },
  ],
};
const rows = flowEntries(meeting);
assert.deepEqual(rows.map(r => r.key), ['event-1','event-2','question-during','event-3','question-after','question-legacy']);
assert.equal(rows[2].at, 10000, 'anchor the question to when it was asked, not its later answer');
assert.equal(rows[4].afterMeeting, true);
assert.equal(rows[5].at, null, 'missing timestamps must not masquerade as meeting start');
assert.equal(rows[2].afterMeeting, false, 'a slow answer does not turn a live question into a post-meeting question');
assert.equal(meetingNavigation(meeting).kind, 'time');
assert.deepEqual(meetingNavigation(meeting).items.map(t => t.seq), [1,3]);
const topics = meetingNavigation({ ...meeting, summary: '## 议题\n- 算法取舍 [事件 2]\n- 待补测 [事件 3]\n- 无效引用 [事件 999]\n## 结论\n继续验证 [事件 1]' });
assert.equal(topics.kind, 'topics');
assert.deepEqual(topics.items, [{title:'算法取舍',seq:2,at:7000},{title:'待补测',seq:3,at:15000}]);
assert.equal(meetingNavigation({ ...meeting, summary: '## 结论\n继续验证 [事件 1]' }).kind, 'time');
assert.equal(meetingNavigation({ ...meeting, summary: '## 没有出处的标题\n无法定位' }).kind, 'time');
assert.deepEqual(flowEntries(null), []);
console.log('meeting flow: source ordering, question timing, grounded topics and legacy fallback PASS');
