'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../core/avatar/fleet-rules');

const authority = { authorities: [{ id: 'expert', name: '答疑人' }] };
const msg = (key, text, at = 1000, extra = {}) => ({ key, text, at, sender: '提问人', account: 'asker', ...extra });
const item = (extra = {}) => ({ id: 'group:q1', group: true, firstKey: 'q1', lastKey: 'q1', at: 1000, action: 'draft', level: 3, flags: [], ...extra });
const history = (id, a, t, at, extra = {}) => ({ id, a, t, at, ...extra });

test('原误结案反转：本人无关发言保留待办，只有引用本题的本人/权威答复才结案', () => {
  const question = msg('q1', '导出按钮在哪里？');
  const aside = msg('a1', '午饭改到另一栋楼。', 2000, { mine: true });
  assert.equal(F.answeredAfter([question, aside], item(), authority), null);
  assert.deepEqual(F.maybeAnswered([question, aside], item(), authority), { by: 'me', at: 2000, snippet: '午饭改到另一栋楼。' });
  const reply = msg('a2', '在页面右上角的菜单里。', 3000, { account: 'expert', sender: '答疑人', replyTo: 'q1' });
  assert.equal(F.answeredAfter([question, aside, reply], item(), authority).by, '答疑人');
  assert.equal(F.answeredAfter([question, { ...reply, account: 'other' }], item(), authority), null);
});

test('同一题连续消息的内部引用有效，旧事项首尾引用兼容；私聊不要求引用', () => {
  const rows = [msg('q1', '导出按钮在哪里？'), msg('q2', '希望带上批注。', 1100), msg('q3', '导出成可编辑格式。', 1200), msg('a1', '在导出菜单中选择需要的格式。', 1300, { mine: true, replyTo: 'q2' })];
  assert.equal(F.answeredAfter(rows, item({ lastKey: 'q3', at: 1200, messageKeys: ['q1', 'q2', 'q3'] }), authority).by, 'me');
  assert.equal(F.answeredAfter(rows, item({ lastKey: 'q3', at: 1200 }), authority), null);
  assert.equal(F.answeredAfter(rows, item({ lastKey: 'q3', at: 1200, group: false }), authority).by, 'me');
  assert.equal(F.answeredAfter([msg('q1', '问题'), msg('r', '已处理。', 2000, { mine: true, replyTo: 'q1' })], item(), authority).by, 'me');
});

test('可能已回复提示仅采无引用的本人/权威发言，并过滤敏感正文', () => {
  const rows = [msg('q1', '导出按钮在哪里？'), msg('a1', '请核对验证码后继续。', 2000, { account: 'expert', sender: '答疑人' }), msg('a2', '另一条问题的回答。', 3000, { mine: true, replyTo: 'another-question' })];
  assert.deepEqual(F.maybeAnswered(rows, item(), authority), { by: '答疑人', at: 2000, snippet: '［这条涉及敏感内容，已略去］' });
  assert.equal(F.maybeAnswered(rows, item({ group: false }), authority), null);
});

test('原无依据草稿反转：零/负/缺失把握且空依据均转提醒，点名重写也不绕过', () => {
  for (const confidence of [0, -1, '0', null, undefined]) {
    for (const asked of [false, true]) {
      const out = F.applyResult(item({ asked }), { action: 'draft', reply: '这是没有依据的合成回答。', confidence, basis: '   ' }, { hideModel: true });
      assert.equal(out.state, 'remind');
      assert.equal(out.draft, '');
      assert.equal(out.lowConfidenceFallback, true);
      assert.equal(out.why, '依据不足，转你处理');
      if (asked) assert.equal(out.asked, false);
    }
  }
  const supported = F.applyResult(item({ lowConfidenceFallback: true }), { action: 'draft', reply: '在导出菜单选择格式。', confidence: 80, basis: '使用说明第2节' }, { hideModel: true });
  assert.equal(supported.state, 'ready');
  assert.equal(supported.lowConfidenceFallback, false);
  assert.equal(F.applyResult(item(), { action: 'skip', confidence: 0, basis: '' }, {}).state, 'skipped');
  assert.match(F.applyResult(item({ asked: true }), { action: 'draft', reply: '', why: '没看懂问题' }, {}).why, /没写出可用的草稿/);
});

test('原误配问答卡反转：无关权威邻接消息不入卡，明确引用在多话题中仍准确', () => {
  const rows = [history('q1', 'asker', '导出按钮在哪里？', 1000), history('n1', 'expert', '午饭拼单请到另一个群登记。', 2000), history('q2', 'other', '账号设置怎么打开？', 2500), history('r1', 'expert', '在页面右上角的菜单里。', 3000, { replyTo: 'q1' })];
  assert.deepEqual(F.minePairs(rows.slice(0, 2), { owner: 'self', authorities: authority.authorities }).pairs, []);
  const out = F.minePairs(rows, { owner: 'self', authorities: authority.authorities });
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].q, '导出按钮在哪里？');
  assert.equal(out.pairs[0].a, '在页面右上角的菜单里。');
});

test('原敏感问答和检索注入反转：题或答敏感不入卡，敏感资料不成为依据', () => {
  const rows = [history('s1', 'asker', '薪酬审批应该如何填写？', 1000), history('a1', 'expert', '测试字段在占位模板第二列。', 2000, { replyTo: 's1' }), history('s2', 'asker', '导出按钮在哪里？', 3000), history('a2', 'expert', '请核对验证码后继续导出。', 4000, { replyTo: 's2' })];
  assert.equal(F.minePairs(rows, { owner: 'self', authorities: authority.authorities }).pairs.length, 0);
  assert.deepEqual(F.related(['导出流程需要核对验证码后继续。', '导出流程：在菜单里选择所需格式。'], '导出流程', 12), ['导出流程：在菜单里选择所需格式。']);
  assert.deepEqual(F.related(['［这条涉及敏感内容，已略去］'], '已略去', 12), []);
  assert.deepEqual(F.related(['凭据字段只用测试占位值。'], '怎么获取验证码？', 12), []);
});

test('权威发现只数有明确答复关联的记录，旁观转述不抢走真实权威答案', () => {
  const rows = [];
  for (let n = 0; n < 3; n++) {
    rows.push(history('q' + n, 'asker', `导出格式${n}应该怎么选择？`, n * 10000));
    rows.push(history('noise' + n, 'other', '今天的活动报名已经开始了。', n * 10000 + 100));
    rows.push(history('r' + n, 'expert', '在导出格式菜单选择对应项目。', n * 10000 + 200, { replyTo: 'q' + n }));
  }
  const out = F.minePairs(rows, { owner: 'self' });
  assert.deepEqual(out.top.map(row => [row.id, row.n]), [['expert', 3]]);
  assert.equal(out.pairs.length, 3);
  assert.ok(out.pairs.every(row => row.by === 'expert'));
  const untrusted = rows.concat(history('late', 'expert', '在导出设置菜单里选择对应格式。', 1000, { replyTo: 'q0' }));
  assert.equal(F.minePairs(untrusted, { owner: 'self', authorities: [{ id: 'other' }] }).pairs.length, 0);
});

test('旧舍入消息编号只在唯一关联时兼容，准确的相邻长整数保持分开', () => {
  const original = '1795618000000000001', next = '1795618000000000002', rounded = String(Number(original));
  const q = history(original, 'asker', '导出按钮在哪里？', 1000);
  const answer = history('answer', 'expert', '在页面右上角的菜单里。', 2000, { replyTo: rounded });
  assert.equal(F.minePairs([q, answer], { owner: 'self', authorities: authority.authorities }).pairs.length, 1);
  const q2 = history(next, 'other', '账号设置应该怎么打开？', 1100);
  assert.equal(F.minePairs([q, q2, answer], { owner: 'self', authorities: authority.authorities }).pairs.length, 0);
  const exact = { ...answer, replyTo: next };
  assert.equal(F.minePairs([q, q2, exact], { owner: 'self', authorities: authority.authorities }).pairs[0].q, q2.t);
});

const topics = ['导出格式', '安装目录', '登录入口', '模型选择', '升级检查', '文件夹设置', '批注保留', '纪要列表', '消息查询', '主题设置'];
for (const [index, topic] of topics.entries()) {
  test(`多话题样例${index + 1}：${topic}无关本人发言不结案`, () => {
    const rows = [msg('q1', `${topic}应该怎么处理？`), msg('other-q', '另一位同事的文件放哪里？', 1001), msg('aside', '收到，午后再看另一份材料。', 1002, { mine: true })];
    assert.equal(F.answeredAfter(rows, item(), authority), null);
    assert.equal(F.maybeAnswered(rows, item(), authority).by, 'me');
  });
  test(`同毫秒样例${index + 1}：${topic}引用编号分清两道题`, () => {
    const q1 = `q${index}-first`, q2 = `q${index}-second`;
    const rows = [msg(q1, `${topic}应该怎么处理？`), msg(q2, '另一项配置应该怎么处理？'), msg('r', `打开${topic}菜单后选择所需项目。`, 1000, { mine: true, replyTo: q2 })];
    assert.equal(F.answeredAfter(rows, item({ firstKey: q1, lastKey: q1 }), authority), null);
    assert.equal(F.answeredAfter(rows, item({ firstKey: q2, lastKey: q2 }), authority).by, 'me');
  });
  test(`知识关联样例${index + 1}：${topic}明确引用只归本题`, () => {
    const rows = [history('q1', 'asker', `${topic}应该怎么处理？`, 1000), history('q2', 'other', '另一项配置应该怎么处理？', 1100), history('notice', 'expert', '今天的会议地点改在另一栋楼。', 1200), history('r', 'expert', `打开${topic}菜单后选择所需项目。`, 1300, { replyTo: 'q1' })];
    const pairs = F.minePairs(rows, { owner: 'self', authorities: authority.authorities }).pairs;
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].q, `${topic}应该怎么处理？`);
    assert.equal(pairs[0].a, `打开${topic}菜单后选择所需项目。`);
  });
}

test('真实归档行不带 replyTo，仍可恢复强关联历史问答并发现答疑人', () => {
  const { WelinkArchive } = require('../core/company-assistant/archive');
  const at = Date.UTC(2026, 10, 25), raw = [];
  for (const [i, topic] of ['导出格式', '安装目录', '升级检查'].entries()) {
    raw.push({ msgId: `q${i}`, sender: 'asker', serverSendTime: at + i * 10000, content: `${topic}应该怎么处理？` });
    raw.push({ msgId: `aside${i}`, sender: 'expert', serverSendTime: at + i * 10000 + 1000, content: '午饭拼单请到另一个群登记。' });
    raw.push({ msgId: `a${i}`, sender: 'expert', serverSendTime: at + i * 10000 + 2000, content: `打开${topic}菜单后选择所需项目。`, replyTo: `q${i}` });
  }
  const rows = WelinkArchive.prototype.rows.call({}, { chatInfo: raw }, { id: 'test-group', group: true }, 'self');
  assert.equal(rows.length, 9); assert.ok(rows.every(r => r.replyTo === undefined));
  const out = F.minePairs(rows, { owner: 'self' });
  assert.equal(out.pairs.length, 3); assert.deepEqual(out.top.map(p => [p.id, p.n]), [['expert', 3]]);
  assert.ok(out.pairs.every(p => !p.a.includes('午饭')));
});

test('无引用回答按主题配对，不跟随最近的无关问题或相邻闲聊', () => {
  const rows = [history('q1', 'asker', '导出格式应该怎么选择？', 1000), history('q2', 'other', '安装目录应该怎么选择？', 1100),
    history('aside', 'expert', '午饭拼单请到另一个群登记。', 1200), history('a1', 'expert', '在导出格式菜单选择 Word 文档。', 1300),
    history('a2', 'expert', '安装目录在高级选项中指定。', 1400)];
  const out = F.minePairs(rows, { owner: 'self', authorities: authority.authorities });
  assert.deepEqual(out.pairs.map(p => [p.q, p.a]), [[rows[0].t, rows[3].t], [rows[1].t, rows[4].t]]);
});

test('明确引用优先于更早的词面答案，不把已回答题的重复答案改配弱相关题', () => {
  const rows = [history('q1', 'asker', '导出格式应该怎么选择？', 1000), history('q2', 'other', '导出格式批注应该怎么保留？', 1100),
    history('fallback', 'expert', '在导出格式菜单选择 Word 文档。', 1200),
    history('explicit', 'expert', '在页面右上角的菜单里。', 1300, { replyTo: 'q1' })];
  const pairs = F.minePairs(rows, { owner: 'self', authorities: authority.authorities }).pairs;
  assert.equal(pairs.length, 1); assert.equal(pairs[0].a, rows[3].t);
});

test('错误引用不退回猜测，主题相同的两个未决问题有歧义就不入卡', () => {
  const q = history('q1', 'asker', '导出格式应该怎么选择？', 1000), a = history('a', 'expert', '在导出格式菜单选择 Word 文档。', 2000);
  assert.equal(F.minePairs([q, { ...a, replyTo: 'missing' }], { owner: 'self', authorities: authority.authorities }).pairs.length, 0);
  assert.equal(F.minePairs([q, { ...q, id: 'q2', a: 'other', at: 1100 }, a], { owner: 'self', authorities: authority.authorities }).pairs.length, 0);
});

test('无引用兜底仍限制本人或权威、时间、敏感内容，泛化套话和追问不入卡', () => {
  const q = history('q', 'asker', '导出格式应该怎么选择？', 1000), a = history('a', 'expert', '在导出格式菜单选择 Word 文档。', 2000);
  const opts = { owner: 'self', authorities: authority.authorities };
  for (const bad of [{ ...a, a: 'other' }, { ...a, at: 999 }, { ...a, at: 1801001 },
    { ...a, t: '导出格式需要核对验证码后继续。' }, { ...a, t: '我也不知道导出格式怎么选择。' },
    { ...a, t: '在页面右上角的菜单里。' }]) assert.equal(F.minePairs([q, bad], opts).pairs.length, 0);
  const mine = { ...a, a: 'self', m: 1 };
  assert.equal(F.minePairs([q, mine], { owner: 'self' }).pairs.length, 1);
  assert.equal(F.minePairs([q, { ...a, a: q.a }], { owner: 'self' }).pairs.length, 0);
  assert.equal(F.minePairs([history('q2', 'asker', '这个功能应该怎么操作？', 1000), a], opts).pairs.length, 0);
});

test('长归档跨日重复问题不干扰当前问答，输入乱序也只关联回答之前半小时', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => history(`old-${i}`, 'asker', '导出格式应该怎么选择？', i * 3600000));
  const q = history('current', 'asker', '导出格式应该怎么选择？', 1000 * 3600000);
  const a = history('answer', 'expert', '在导出格式菜单选择 Word 文档。', q.at + 1000);
  const pairs = F.minePairs([a, ...rows.reverse(), q], { owner: 'self', authorities: authority.authorities }).pairs;
  assert.equal(pairs.length, 1); assert.equal(pairs[0].at, q.at);
});
