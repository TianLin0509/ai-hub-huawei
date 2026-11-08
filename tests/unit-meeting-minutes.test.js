'use strict';
// 纪要按条目增量更新：合并、删除、编号走样、一句「本轮无更新」不能清空纪要；问答带上更早的相关原话。
const assert = require('node:assert/strict');
const test = require('node:test');
const minutes = require('../core/company-assistant/meeting-minutes');
const { relevant } = require('../core/company-assistant/meeting-context');

test('只回改动的条目：新增、修改、删除都合并进原纪要，按类排好', () => {
  let s = minutes.apply('', '- [T1] 吞吐下降排查 [事件 3]\n- [D1] 步长回退到 0.5 [事件 9]\n- [Q1] PF 权重是否要改（王磊提议）[事件 5]\n本轮小结：定了步长').summary;
  assert.equal(s, '## 议题\n- [T1] 吞吐下降排查 [事件 3]\n## 决定\n- [D1] 步长回退到 0.5 [事件 9]\n## 待确认\n- [Q1] PF 权重是否要改（王磊提议）[事件 5]');
  const r = minutes.apply(s, '- [D1] 步长定为 0.4（原定 0.5，30:12 李娜提出修改）[事件 9][事件 30]\n- [A1] 刘洋｜按 0.4 回归｜下周二前 [事件 31]\n- [Q1] 删除\n本轮小结：步长改成 0.4');
  assert.equal(r.changed, 3); assert.equal(r.note, '步长改成 0.4');
  assert.match(r.summary, /\[D1\] 步长定为 0.4（原定 0.5/); assert.match(r.summary, /## 行动项\n- \[A1\] 刘洋/); assert.doesNotMatch(r.summary, /PF 权重/);
  assert.match(r.summary, /\[T1\] 吞吐下降排查/, '没提到的条目原样保留');
});

test('一句「本轮无更新」或格式走样不清空已有纪要', () => {
  const s = '## 决定\n- [D1] 先做固定秩四仿真 [事件 12]';
  for (const reply of ['本轮无更新\n本轮小结：无', '本轮讨论了一些闲话，没有新内容。', '']) assert.equal(minutes.apply(s, reply).summary, s);
  assert.equal(minutes.apply('', '会议刚开始，还在寒暄。').summary, '会议刚开始，还在寒暄。', '纪要为空时先留下模型的整段');
  assert.equal(minutes.apply('', '本轮无更新').summary, '');
});

test('模型不守编号、但写了整份分区纪要：按小标题认成条目，长度不够不收', () => {
  const current = '## 决定\n- [D1] 先做固定秩四仿真 [事件 12]';
  const whole = '## 议题\n- 吞吐下降排查 [事件 3]\n\n## 决定\n1. 先做固定秩四仿真 [事件 12]\n2. 步长定为 0.4 [事件 30]\n\n**行动项**\n- 刘洋｜按 0.4 回归｜下周二前 [事件 31]\n本轮小结：补了行动项';
  const r = minutes.apply(current, whole);
  assert.equal(r.summary, '## 议题\n- [T1] 吞吐下降排查 [事件 3]\n## 决定\n- [D1] 先做固定秩四仿真 [事件 12]\n- [D2] 步长定为 0.4 [事件 30]\n## 行动项\n- [A1] 刘洋｜按 0.4 回归｜下周二前 [事件 31]');
  const long = '## 决定\n' + Array.from({ length: 30 }, (_, i) => `- [D${i + 1}] 决定${i + 1}`).join('\n');
  assert.equal(minutes.apply(long, '## 决定\n- 只剩一条\n## 行动项\n- 一条').summary, long, '比原来短一半以上不当成整份重写');
});

test('编号写法走样也认：[T-1]、**[D2]**、[A 3]：', () => {
  const items = minutes.parse('- [T-1] a\n**[D2]** b\n- [A 3]：c\n1. [Q4] d\n2、F5 e\n普通一行 [事件 2]');
  assert.deepEqual([...items.keys()], ['T1', 'D2', 'A3', 'Q4', 'F5']);
});

test('不带方括号的「- T1 内容」也认（GLM 常这么写），正文里的 F1 分数不误认', () => {
  const r = minutes.apply('', '- T1 今日三议题 [事件 10]\n- **A4**：发言人5｜整理日志｜周四前 [事件 69]\n- D3：统一 32 用户 [事件 74]\nF1 分数提升了\n本轮小结：开场');
  assert.deepEqual([...minutes.parse(r.summary).keys()], ['T1', 'D3', 'A4']);
  assert.doesNotMatch(r.summary, /分数/);
});

test('界面和导出不显示条目编号', () => {
  assert.equal(minutes.display('## 决定\n- [D1] 先做仿真 [事件 2]'), '## 决定\n- 先做仿真 [事件 2]');
});

test('问一下：按字面重合挑出更早的相关原话', () => {
  const ev = [
    { seq: 1, kind: 'transcript', text: '王磊建议改 PF 权重试试' },
    { seq: 2, kind: 'transcript', text: '今天咖啡机坏了' },
    { seq: 3, kind: 'transcript', text: 'OLLA 步长先回退到零点五' },
    { seq: 4, kind: 'slide', file: 'page-4.jpg' },
  ];
  assert.deepEqual(relevant('王磊对 PF 权重的建议是什么', ev).map(e => e.seq), [1]);
  assert.deepEqual(relevant('OLLA 步长定了多少', ev).map(e => e.seq), [3]);
  assert.deepEqual(relevant('？？', ev), []);
});
