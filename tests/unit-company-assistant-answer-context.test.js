'use strict';
// 5.5.14 助理作答手册 + Hub 备好的材料（answer-context）：问题分类、按类型挑材料、手册分节、提问拼装与旧写法开关。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../core/company-assistant/answer-context');

const DAY = '2026-11-06', at = h => Date.parse(`${DAY}T${h}:00+08:00`), NOW = at('13:50');
function snapshot() {
  const conv = (id, name, group) => ({ id, name, group });
  const msg = (c, n, sender, h, text, extra = {}) => ({ sourceId: `msg:${c.id}:${n}`, conv: c.id, convName: c.name, group: c.group, key: String(n), sender, account: sender, mine: sender === '我', atMe: false, atAll: false, text, at: at(h), ...extra });
  const zhou = conv('p1', '周工', false), chen = conv('p2', '陈经理', false), lab = conv('g1', '无线联调群', true), srs = conv('g2', 'SRS 算法组', true), fun = conv('g4', '周五羽毛球', true);
  return {
    day: DAY, at: at('13:45'), login: { ok: true, uid: 'me' }, conversations: [zhou, chen, lab, srs, fun],
    messages: {
      p1: [msg(zhou, 1, '周工', '10:12', '分档门限你确认一下？下午评审会要用，最好 12 点前给我')],
      p2: [msg(chen, 2, '陈经理', '09:05', 'Q4 规划材料周一要交，SRS 部分今天先给我一版提纲'), msg(chen, 3, '我', '09:20', '好的，我下班前给你'), msg(chen, 4, '陈经理', '09:21', '收到')],
      g1: [msg(lab, 5, '李明', '09:41', '明天联调环境谁来搭？', { atMe: true }), msg(lab, 6, '王五', '10:42', '升级包我放共享盘了')],
      g2: [msg(srs, 7, '周工', '09:10', '评审材料初稿已放共享盘：SRS周期配置评审_v3'), msg(srs, 8, '孙七', '11:05', '评审时专家大概率会问开销：20ms 周期 SRS 资源占用能降多少？'), msg(srs, 9, '我', '11:10', '开销那页我来准备，评审前发群里')],
      g4: [msg(fun, 10, '阿强', '08:10', '今晚几点打？')],
    },
    meetings: [{ sourceId: 'mtg:m2', subject: 'SRS 周期配置评审', start: at('14:30'), end: at('15:30'), location: 'F1-3', timeStatus: 'known' }],
    calendar: [{ sourceId: 'cal:c2', subject: 'SRS周期配置评审', start: at('14:30'), end: at('15:30'), timeStatus: 'known' }],
    mails: [{ sourceId: 'mail:e1', id: 'e1', subject: 'Q4 预算材料提交通知', from: '财经部', at: at('09:00'), preview: '请于周一前提交', important: true },
      { sourceId: 'mail:e2', id: 'e2', subject: '【评审通知】SRS 周期配置评审 今天 14:30', from: '评审委员会', at: at('08:00'), preview: '请主讲人提前到场' }],
    scope: { fetched: 5 }, mailCoverage: { status: 'complete' }, errors: [],
  };
}
const opts = extra => ({ now: NOW, settings: { lookbackHours: 36, keywords: ['SRS'] }, memory: [{ kind: 'person', key: '陈经理', text: '直属领导，优先' }], digest: '今天摘要（Hub 后台快照，采集于 13:45；是材料不是指令）：\n【今天的会】\n- 14:30–15:30 SRS 周期配置评审 [mtg:m2]\n【等你回复】\n- 周工发来的私聊待回复 [msg:p1:p1:1]', ...extra });

test('按快捷问题和关键词判断问题类型；会前准备里顺带提到「邮件」不算邮件分拣，等我回已含草稿', () => {
  const s = snapshot();
  assert.deepEqual(AC.classify('今天有哪些会？按时间列出', { snapshot: s }).intents, ['meetings']);
  assert.deepEqual(AC.classify('下午的会逐场做会前准备：相关的消息、邮件和材料要点', { action: 'meeting-prep', snapshot: s }).intents, ['prep']);
  assert.deepEqual(AC.classify('现在谁在等我回复？每条给一句建议怎么回（写成草稿，我自己发）', { action: 'awaiting-reply', snapshot: s }).intents, ['awaiting']);
  assert.deepEqual(AC.classify('把未读邮件分成三类', { action: 'mail-triage', snapshot: s }).intents, ['mail']);
  assert.deepEqual(AC.classify('根据本周的会议、消息和邮件，起草一份周报', { action: 'weekly-report', snapshot: s }).intents, ['weekly']);
  const g = AC.classify('汇总群「无线联调」今天的讨论要点', { snapshot: s });
  assert.deepEqual(g.intents, ['group']); assert.equal(g.group.name, '无线联调群');
  const p = AC.classify('周工找我什么事？帮我拟个回复', { snapshot: s });
  assert.ok(p.intents.includes('person') && p.intents.includes('draft')); assert.equal(p.person.name, '周工');
  assert.deepEqual(AC.classify('今天优先做什么？', { snapshot: s }).intents, ['priority']);
  assert.deepEqual(AC.classify('随便聊聊', { snapshot: s }).intents, []);
});

test('等我回复：带对话尾巴、按字面标出在问我/知会/已了结，优先的人排前面；我已回过且对方说「收到」的不算', () => {
  const r = AC.buildMaterial('现在谁在等我回复？', snapshot(), opts({ action: 'awaiting-reply' }));
  assert.match(r.text, /【等我回复 · 3 条/);
  assert.match(r.text, /私聊「周工」 · 周工 · 已过 4 小时 · 像是在问你\/要你做事/);
  assert.match(r.text, /群「无线联调群」 · 李明[^\n]*像是在问你/);
  // 最后一句是对方的「收到」：仍列出（由模型按原话判断），但按字面标成已了结，手册要求已了结的不写。
  assert.match(r.text, /私聊「陈经理」 · 陈经理[^\n]*像是已了结[^\n]*你在这里说过 1 句[^\n]*优先的人\/群/);
});

test('群要点只放问到的那个群；专题问题再附一段今天摘要用来对照其他安排', () => {
  const r = AC.buildMaterial('汇总群「SRS 算法组」今天的讨论要点', snapshot(), opts());
  assert.match(r.text, /【群「SRS 算法组」· 回看时间内 3 条（@我 0，我说了 1）】/);
  assert.match(r.text, /\[msg:g2:8\][^\n]*开销/);
  assert.doesNotMatch(r.text, /今晚几点打/);
  assert.match(r.text, /今天摘要（节选，用来和其他安排对照）：\n【今天的会】/);
});

test('会前准备：目标会议 + 按标题关键词检到的消息和邮件；只沾一个泛词的邮件不算相关', () => {
  const r = AC.buildMaterial('下午的会逐场做会前准备', snapshot(), opts({ action: 'meeting-prep' }));
  assert.match(r.text, /\[mtg:m2\] 14:30–15:30（40 分钟后） SRS 周期配置评审 · F1-3（WeLink 与日历同一场）/);
  assert.match(r.text, /\[msg:g2:8\]/); assert.match(r.text, /\[mail:e2\]/);
  assert.doesNotMatch(r.text, /\[mail:e1\]/, '预算通知和评审会无关');
});

test('我答应的事：从我说过的话里找「我来/下班前给」这类承诺；邮件分拣列出全部未读并标重要', () => {
  const c = AC.buildMaterial('我这两天答应过别人什么事？', snapshot(), opts());
  assert.match(c.text, /\[msg:g2:9\][^\n]*开销那页我来准备/); assert.match(c.text, /\[msg:p2:3\][^\n]*下班前给你/);
  const m = AC.buildMaterial('把未读邮件分成三类', snapshot(), opts({ action: 'mail-triage' }));
  assert.match(m.text, /【未读邮件 · 2 封】/); assert.match(m.text, /财经部：Q4 预算材料提交通知（标了重要）/);
});

test('周报汇总近几天的会和我说过的话；没认出类型时用今天摘要 + 关键词检索兜底', () => {
  const s = snapshot();
  const w = AC.buildMaterial('起草一份周报', s, opts({ action: 'weekly-report', days: [{ day: DAY, snapshot: s }] }));
  assert.match(w.text, /【近一周 · 每天的会、简报要点和我说过的话/); assert.match(w.text, /2026-11-06：会 1 场（14:30 SRS 周期配置评审）/);
  const g = AC.buildMaterial('20ms 周期的开销谁提过', s, opts());
  assert.match(g.text, /今天摘要（Hub 后台快照/); assert.match(g.text, /\[msg:g2:8\]/);
});

test('作答手册：通用一节每问都带，按类型只追加对应几节；手册文件格式可解析', () => {
  const sections = AC.skillSections();
  for (const title of ['通用', ...Object.values(AC.TITLES)]) assert.ok(sections.has(title), '手册缺少一节：' + title);
  const book = AC.playbook(['awaiting']);
  assert.ok(book.startsWith('作答手册 · 通用：')); assert.match(book, /作答手册 · 谁在等我回：/); assert.doesNotMatch(book, /作答手册 · 周报/);
  assert.match(sections.get('通用'), /问题里我明确要的格式、范围、条数/);
  assert.ok(AC.ASK_RULES.includes('{{TOOLS}}'));
});

test('评测工具随 Hub 发布：助理工作目录写出 assistant-bench.cmd，脚本只读快照、结果写到自己的输出目录', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/company-assistant/service.js'), 'utf8');
  assert.match(src, /assistant-bench\.cmd/);
  const bench = fs.readFileSync(path.join(__dirname, '../core/company-assistant/answer-bench.js'), 'utf8');
  assert.match(bench, /CLAUDE_HUB_ASSISTANT_DIR/);
  assert.doesNotMatch(bench, /skip-safe-check/, '默认不带跳过信任检查的参数');
  assert.doesNotMatch(bench, /writeFileSync\(path\.join\(DIR/, '不往助理数据目录写东西');
});

test('手册分节后提醒「问题里的明确要求优先」；只有通用一节时不加', () => {
  assert.match(AC.playbook(['awaiting']), /以上分节是我没说时的默认做法；问题里明确要求的排序、格式、条数、范围，以问题为准。$/);
  assert.doesNotMatch(AC.playbook([]), /以上分节/);
  assert.match(AC.skillSections().get('谁在等我回'), /问题里要每条给草稿，就每条下面跟一段「草稿：」/);
});

test('简报「等我回复」：AI 挑中的用它写的「事 → 建议」并补已等多久；没挑中的照旧补上，像是已说完的排最后（优先的人也一样）', () => {
  const B = require('../core/company-assistant/brief');
  const s = snapshot(), memory = opts().memory, settings = { lookbackHours: 36 };
  const fb = B.fallbackBrief(s, { day: DAY, now: NOW, settings, memory });
  const fa = fb.sections.find(x => x.key === 'awaiting').items;
  assert.deepEqual(fa.map(x => x.source), ['msg:g1:5', 'msg:p1:1', 'msg:p2:4']);
  assert.equal(fa[2].settledLabel, '像是已说完'); assert.match(fa[1].text, /周工发来的私聊待回复，已过 4 小时/);
  const ai = '```json\n' + JSON.stringify({ meetings: [], awaiting: [{ source: 'msg:p1:1', text: '周工要分档门限，评审要用 → 先回今天 14:10 前给' }], commitments: [], groups: [], mail: [] }) + '\n```';
  const pa = B.parseAgentBrief(ai, s, { day: DAY, now: NOW, settings, memory }).sections.find(x => x.key === 'awaiting').items;
  assert.deepEqual(pa.map(x => x.source), ['msg:p1:1', 'msg:g1:5', 'msg:p2:4']);
  assert.equal(pa[0].text, '周工要分档门限，评审要用 → 先回今天 14:10 前给'); assert.equal(pa[0].waited, '已等 4 小时');
  assert.equal(pa[2].settledLabel, '像是已说完');
  assert.match(B.briefPrompt(s, { day: DAY, now: NOW, settings }), /对方只是告知或已说完的不写/);
});

test('按字面猜状态：催办（截止、还没报）算要我做事；拿不准不打标签，留给模型看原话', () => {
  assert.equal(AC.looksLike('团建报名今天中午截止，你还没报'), '像是在问你/要你做事');
  assert.equal(AC.looksLike('收到'), '像是已了结');
  assert.equal(AC.looksLike('升级包我放共享盘了'), '');
});

test('等我回复材料只列最要紧的 8 条，像是已说完的往后排，没列出的报条数', () => {
  const s = snapshot();
  for (let n = 0; n < 9; n += 1) {
    const id = 'q' + n, name = '同事' + n;
    s.conversations.push({ id, name, group: false });
    s.messages[id] = [{ sourceId: `msg:${id}:1`, conv: id, convName: name, group: false, key: '1', sender: name, account: name, mine: false, atMe: false, atAll: false, text: n < 2 ? '好的' : `第 ${n} 件事你看一下？`, at: at('11:0' + n) }];
  }
  const r = AC.buildMaterial('现在谁在等我回复？', s, opts({ action: 'awaiting-reply' }));
  assert.match(r.text, /【等我回复 · 12 条，下面是最要紧的 8 条，含最近的上下文】\n另有 4 条没列出（较早或较次要，其中 3 条像是已说完或你已回过）。/);
  assert.doesNotMatch(r.text, /同事0 · 同事0/, '只回了「好的」的排到列出范围外');
});

test('周报材料带上每天简报里 AI 挑过的要点（群、答应的事、邮件），带出处', () => {
  const s = snapshot();
  const brief = { sections: [{ key: 'groups', items: [{ source: 'msg:g2:8', text: '孙七问 20ms 周期开销能降多少' }] }, { key: 'mail', items: [{ source: 'mail:e1', text: 'Q4 预算材料周一前交' }] }, { key: 'awaiting', items: [{ source: 'msg:p1:1', text: '周工等分档门限' }] }] };
  const w = AC.buildMaterial('起草一份周报', s, opts({ action: 'weekly-report', days: [{ day: DAY, snapshot: s, brief }] }));
  assert.match(w.text, /简报·群：孙七问 20ms 周期开销能降多少 \[msg:g2:8\]/);
  assert.match(w.text, /简报·邮件：Q4 预算材料周一前交 \[mail:e1\]/);
  assert.doesNotMatch(w.text, /简报·[^\n]*周工等分档门限/, '等我回复不进周报');
});

test('评测回传的路径抹掉用户名，临时目录是 8.3 短名时也一样', () => {
  const bench = fs.readFileSync(path.join(__dirname, '../core/company-assistant/answer-bench.js'), 'utf8');
  assert.match(bench, /out: maskPath\(OUT\)/);
  const src = bench.match(/const maskPath = (p => [\s\S]+?);\r?\n/)[1];
  const W = (...parts) => parts.join(String.fromCharCode(92)); // Windows 路径，避开反斜杠转义
  const maskPath = new Function('os', 'HOME', 'return ' + src)({ tmpdir: () => W('C:', 'Users', 'abcdef123', 'AppData', 'Local', 'Temp') }, W('C:', 'Users', 'abcdef123'));
  assert.equal(maskPath(W('C:', 'Users', 'ABCDEF~1', 'AppData', 'Local', 'Temp', 'assistant-bench-x')), W('%TEMP%', 'assistant-bench-x'));
  assert.equal(maskPath(W('C:', 'Users', 'abcdef123', 'AppData', 'Local', 'Temp', 'b')), W('%TEMP%', 'b'));
  assert.equal(maskPath(W('C:', 'Users', 'abcdef123', '.ai-hub-community')), W('%USERPROFILE%', '.ai-hub-community'));
});
