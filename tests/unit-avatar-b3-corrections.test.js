'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { FleetService } = require('../core/avatar/fleet'), F = require('../core/avatar/fleet-rules'), C = require('../core/avatar/corrections');
const { registerAvatarIpc } = require('../main/ipc/avatar-handlers');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-b3-')), owner = 'owner-synthetic';
  const world = { now: Date.now(), owner, sessions: new Map(), closed: [], finals: new Map(), tasks: [], messages: [] };
  const assistant = { settings: () => ({ myName: '测试本人' }), snapshot: () => ({ login: { ok: true, uid: world.owner }, conversations: [], messages: { group: world.messages } }),
    auth: { status: () => ({ state: 'online', login: { ok: true, uid: world.owner } }) }, archive: { owner: () => world.owner, loadIndex: () => ({ names: { 'person-test': '测试同事' } }) } };
  const f = new FleetService({ dataDir: dir, noTimer: true, pollMs: 1, now: () => world.now, getAssistant: () => assistant,
    listBackends: () => ({ rows: world.unavailable ? [] : [{ id: 'personal', usable: true, models: ['test-model'] }] }),
    createSession: async (kind, opts) => { world.sessions.set(opts.id, { ...opts, kind, status: 'idle' }); return { id: opts.id }; },
    getSession: id => world.sessions.get(id), closeSession: async id => { world.closed.push(id); world.sessions.delete(id); },
    sendPrompt: async (id, prompt) => {
      if (world.fail) throw new Error('模型账号未就绪');
      const meta = world.sessions.get(id), file = /再处理 (task-[\w-]+\.json)/.exec(prompt)[1];
      const material = JSON.parse(fs.readFileSync(path.join(meta.cwd, file), 'utf8')); world.tasks.push(material);
      if (world.onAsk) await world.onAsk();
      const marker = /\[分身回执:[^\]]+\]/.exec(prompt)[0];
      world.finals.set(id, { text: JSON.stringify(material.items.map(i => ({ id: i.id, action: 'draft', reply: i.related[0]?.includes('纠错卡') ? '按新口径选择本地导出。' : '旧草稿', confidence: 85, basis: i.related[0] || '测试资料' }))) + marker }); return { ok: true };
    }, lastFinal: id => world.finals.get(id) });
  const av = F.newAvatar({ id: 'avatar-test', tpl: 'blank', now: world.now }, { kind: 'all' });
  f.saveFleet(owner, { avatars: [av], paused: false });
  f.saveState(owner, av.id, { items: { item: { id: 'item', text: '会议纪要导出格式怎么选择？', draft: '旧的错误回答', state: 'ready', group: true, conv: 'group', convName: '测试群', who: '测试同事', lastKey: 'm1', messageKeys: ['m1'], action: 'draft', level: 3 } }, stats: {}, log: [], cursor: {} });
  t.after(() => { f.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { f, av, owner, world, dir, file: f.correctionFile(owner, av.id) };
}
const correction = { reason: 'fact', correctAnswer: '会议纪要导出格式请选本地可编辑文档。' };

test('首次空卡列表，新增原子落盘、快照与规则版本，敏感和空输入拒绝不写盘', async t => {
  const { f, av, owner, file } = setup(t);
  assert.deepEqual(f.correctionsList(av.id).cards, []);
  for (const correctAnswer of ['', '验证码 123456', 'password=secret-value']) await assert.rejects(f.correctItem(av.id, 'item', { ...correction, correctAnswer }), /正确|敏感/);
  assert.equal(fs.existsSync(file), false);
  const out = await f.correctItem(av.id, 'item', { ...correction, redraft: false });
  assert.equal(out.ok, true); assert.equal(out.card.id, 'cor-1'); assert.equal(out.card.version, 1); assert.equal(out.card.active, true);
  assert.equal(C.read(file).length, 1); assert.equal(f.find(owner, av.id).av.rulesVersion, 1);
  assert.equal(f.state(owner, av.id).items.item.oldDraftSnapshot, '旧的错误回答');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp')), []);
  const second = await f.correctItem(av.id, 'item', { ...correction, correctAnswer: '第二张卡按顺序递增。', redraft: false });
  assert.equal(second.card.id, 'cor-2');
});

test('10题回放纠错卡置于旧样例记忆之前，20无关题不召回', async t => {
  const { f, av, owner } = setup(t);
  fs.writeFileSync(path.join(f.work(owner, av.id), 'memory.md'), '会议纪要导出格式：旧错误口径。');
  fs.writeFileSync(path.join(f.work(owner, av.id), 'examples.md'), '会议纪要导出格式：旧范例口径。');
  const out = await f.correctItem(av.id, 'item', { ...correction, redraft: false });
  for (const query of ['会议纪要导出格式怎么选择？', '请问会议纪要导出格式应该如何选择？', '会议纪要如何导出？', '会议纪要导出格式可以选哪个？', '会议纪要导出格式选择', '会议纪要怎么导出格式？', '会议纪要导出格式在哪选择？', '麻烦会议纪要导出格式一下', '会议纪要导出格式的问题', '会议纪要导出格式选项']) {
    const related = f.material(owner, av, [{ id: 'q', text: query, conv: 'group' }]).items[0].related;
    assert.ok(related[0].includes(out.card.id), query); assert.match(related[0], /纠错卡/); assert.ok(related.slice(1).some(x => /旧/.test(x)));
  }
  for (const query of ['午饭订餐', '服务器重启', '账号注册', '请假流程', '代码审查', '硬盘空间', '模型价格', '发票抬头', '培训时间', '网络故障', '签名证书', '蓝牙设备', '权限申请', '项目排期', '积分兑换', '屏幕亮度', '语音识别', '打印机墨盒', '年度预算', '旅行计划'])
    assert.equal(f.material(owner, av, [{ id: 'q', text: query, conv: 'group' }]).items[0].related.some(s => s.includes('纠错卡')), false, query);
});

test('同题立即重答经过真实AgentSessions接线，换旧会话并保留原稿', async t => {
  const { f, av, owner, world } = setup(t);
  world.sessions.set('old-session', { status: 'idle' }); f.mutate(owner, av.id, st => { st.session = { id: 'old-session', questions: 1 }; });
  const out = await f.correctItem(av.id, 'item', correction);
  assert.equal(out.ok, true); assert.equal(out.redraftFailure, undefined); assert.equal(out.redraftResult.draft, '按新口径选择本地导出。');
  assert.ok(world.closed.includes('old-session')); assert.match(out.redraftResult.basis, /纠错卡/);
  assert.equal(f.state(owner, av.id).items.item.oldDraftSnapshot, '旧的错误回答');
  assert.equal(f.state(owner, av.id).session.rulesVersion, 1);
});

test('撤销立即不检索，版本换会话，恢复保留历史版本', async t => {
  const { f, av, owner, world } = setup(t), out = await f.correctItem(av.id, 'item', correction);
  const before = f.state(owner, av.id).session;
  const off = f.correctionToggle(av.id, { cardId: out.card.id, active: false });
  assert.equal(off.card.revokedAt, world.now); assert.equal(off.card.version, 2);
  assert.equal(C.relevant(f.correctionCards(owner, av.id), '会议纪要导出格式怎么选择？').length, 0);
  const next = await f.sessions.ensure(f.find(owner, av.id).av, before, f.work(owner, av.id));
  assert.notEqual(before.id, next.id); assert.ok(world.closed.includes(before.id));
  const on = f.correctionToggle(av.id, { cardId: out.card.id, active: true });
  assert.equal(on.card.version, 3); assert.equal(on.card.revokedAt, 0); assert.equal(C.read(f.correctionFile(owner, av.id)).length, 1);
});

test('模型未就绪或提交失败，卡片和旧稿仍保留并返回failureBox', async t => {
  for (const mode of ['unavailable', 'fail']) {
    const { f, av, owner, world } = setup(t); world[mode] = true;
    const out = await f.correctItem(av.id, 'item', correction);
    assert.equal(out.ok, true); assert.ok(out.redraftFailure.code); assert.ok(Array.isArray(out.redraftFailure.actions));
    assert.equal(f.correctionsList(av.id).cards.length, 1); assert.equal(f.state(owner, av.id).items.item.oldDraftSnapshot, '旧的错误回答');
    assert.ok(out.status.items.some(i => i.id === 'item'), '失败事项留在待确认，前端才能就地展示failureBox');
    assert.equal(world.tasks.length, 0, '失败后不由自动pump重复提交同题');
  }
});

test('改回本群近期消息不信任页面正文，跨群和空编号拒绝；非问我关闭写日志', async t => {
  const { f, av, owner, world } = setup(t);
  world.messages = [{ key: 'm2', text: '安装目录怎么选择？', sender: '另一同事', account: 'peer2', at: world.now }];
  await assert.rejects(f.reassignTarget(av.id, 'item', { action: 'retarget', targetMsgKey: 'outside', redraft: false }), /本群/);
  await f.reassignTarget(av.id, 'item', { action: 'retarget', targetMsgKey: 'm2', targetText: '伪造正文', targetSender: '伪造身份', redraft: false });
  let item = f.state(owner, av.id).items.item; assert.equal(item.text, world.messages[0].text); assert.equal(item.who, '另一同事'); assert.deepEqual(item.messageKeys, ['m2']);
  await f.reassignTarget(av.id, 'item', { action: 'not_for_me' });
  item = f.state(owner, av.id).items.item; assert.equal(item.state, 'dropped'); assert.equal(f.state(owner, av.id).log[0].act, 'not_for_me');
});

test('反馈脱敏真实目录名、姓名、手机号、工号、邮箱、密钥及路径，不发送', t => {
  const { f, av, owner, world } = setup(t);
  const synGh = 'ghp' + '_synthetic123456', synGl = 'glpat' + '-synthetic123456', synAws = 'AKIA' + 'SYNTHETIC1234567';
  f.mutate(owner, av.id, st => { st.items.item.text = `测试同事 联系测试本人 13800138000 138-1234-5678 139 8765 4321 a00123456 lwx1234567 wx123456 12345678 example@local.test sk-synthetic-secret-value ${synGh} ${synGl} ${synAws}`; st.lastError = 'token=private-test-value ' + path.win32.join('C:\\', 'Users', 'someone', 'private'); });
  const out = f.feedbackContext(av.id, 'item'); assert.equal(out.ok, true);
  for (const secret of ['测试同事', '测试本人', owner, '13800138000', '138-1234-5678', '139 8765 4321', 'a00123456', 'lwx1234567', 'wx123456', '12345678', 'example@local.test', 'sk-synthetic-secret-value', synGh, synGl, synAws, 'private-test-value', 'someone']) assert.equal(out.text.includes(secret), false, secret);
  assert.match(out.text, /version/); assert.match(out.text, /同事A/); assert.equal(world.tasks.length, 0);
});

test('外部文件缺失静默空、不建文件；按id最后一条去重，扁平纠正只本地结案且不留幽灵条目', async t => {
  const { f, av, owner, world, dir } = setup(t), files = f.externalFiles(owner);
  assert.match(files.inbox, new RegExp(crypto.createHash('sha256').update(owner).digest('hex').slice(0, 16)));
  assert.deepEqual(f.status().externalItems, []); assert.equal(fs.existsSync(files.inbox), false);
  const row = { id: '20261126-q240', conv: 'group', convName: '合成群', askerName: '测试同事', question: '会议纪要导出格式怎么选择？', answer: '低把握草稿', status: 'pending', basis: ['合成问答卡'], confidence: 45, kind: 'draft', at: world.now };
  fs.mkdirSync(path.dirname(files.inbox), { recursive: true }); fs.writeFileSync(files.inbox, JSON.stringify({ ...row, answer: '前一条' }) + '\n坏行\n' + JSON.stringify(row) + '\n');
  const before = fs.readFileSync(files.inbox, 'utf8'), status = f.status(); assert.equal(status.externalItems.length, 1); assert.equal(status.externalItems[0].draft, '低把握草稿');
  assert.equal(status.externalItems[0].avatarId, av.id); assert.equal(status.items.some(i => i.externalTwin), false);
  const pendingBefore = status.avatars[0].pending;
  const out = await f.correctItem(av.id, row.id, { ...correction, redraft: false });
  assert.equal(out.ok, true); assert.deepEqual(f.status().externalItems, []); assert.equal(fs.readFileSync(files.inbox, 'utf8'), before);
  assert.equal(f.state(owner, av.id).items[row.id], undefined, '外部条目不写进 state.json');
  assert.equal(f.status().avatars[0].pending, pendingBefore, '外部条目纠正后不抬高待确认计数');
  const resolved = JSON.parse(fs.readFileSync(files.resolved, 'utf8')); assert.equal(resolved.status, 'corrected'); assert.equal(resolved.cardId, out.card.id); assert.equal(resolved.answer, correction.correctAnswer);
  assert.equal(world.tasks.length, 0); assert.match(f.sendProblem(owner, av.id, { ...row, externalTwin: true }).error, /不代发/);
  assert.equal(fs.existsSync(path.join(dir, 'twin_events')), false);
  // 外部条目立即重答（成功与失败）后，同样必须清理临时挂载，不在 state.json 残留幽灵条目。
  const row2 = { ...row, id: '20261126-q242' }, row3 = { ...row, id: '20261126-q243' };
  fs.appendFileSync(files.inbox, JSON.stringify(row2) + '\n' + JSON.stringify(row3) + '\n');
  const okRedraft = await f.correctItem(av.id, row2.id, { ...correction, redraft: true });
  assert.equal(okRedraft.ok, true); assert.equal(okRedraft.redraftResult.draft, '按新口径选择本地导出。');
  assert.equal(f.state(owner, av.id).items[row2.id], undefined);
  assert.equal(f.status().avatars[0].pending, pendingBefore);
  world.fail = true;
  const failRedraft = await f.correctItem(av.id, row3.id, { ...correction, redraft: true });
  assert.equal(failRedraft.ok, true); assert.ok(failRedraft.redraftFailure.code);
  assert.equal(f.state(owner, av.id).items[row3.id], undefined);
  assert.equal(f.status().avatars[0].pending, pendingBefore);
});

test('promise投影、已结案过滤、跨owner隔离与all_avatars明确范围', async t => {
  const { f, av, owner, world } = setup(t), files = f.externalFiles(owner);
  fs.mkdirSync(path.dirname(files.inbox), { recursive: true });
  const row = { id: '20261126-q241', conv: 'group', question: '稍后确认是否回复？', status: 'pending', kind: 'promise' };
  fs.writeFileSync(files.inbox, JSON.stringify(row) + '\n'); assert.match(f.status().externalItems[0].why, /承诺/);
  C.resolve(files.resolved, { id: row.id, status: 'corrected' }); assert.deepEqual(f.status().externalItems, []);
  f.mutateFleet(owner, fleet => fleet.avatars.push({ ...av, id: 'second' }));
  await f.correctItem(av.id, 'item', { ...correction, scope: 'all_avatars', redraft: false });
  assert.equal(f.find(owner, 'second').av.rulesVersion, 1); assert.equal(f.correctionCards(owner, 'second').length, 1);
  world.owner = 'other-owner'; assert.deepEqual(f.status().externalItems, []); assert.deepEqual(f.fleet(world.owner).avatars, []);
});

test('纠错文件损坏禁止静默覆盖，IPC五通道都正确接线', async t => {
  const { f, av, file } = setup(t); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{bad-json');
  await assert.rejects(f.correctItem(av.id, 'item', { ...correction, redraft: false }), /读取失败/); assert.equal(fs.readFileSync(file, 'utf8'), '{bad-json');
  const registered = new Map(), calls = [], s = Object.fromEntries(['correctItem', 'correctionsList', 'correctionToggle', 'reassignTarget', 'feedbackContext'].map(key => [key, (...args) => { calls.push([key, ...args]); return { ok: true }; }]));
  registerAvatarIpc({ handle: (key, fn) => registered.set(key, fn) }, () => s);
  for (const name of ['correct-item', 'corrections-list', 'correction-toggle', 'reassign-target', 'feedback-context']) assert.equal((await registered.get('avatar:' + name)(null, { avatarId: 'a', itemId: 'i' })).ok, true);
  assert.equal(calls.length, 5); assert.deepEqual(calls[0].slice(0, 3), ['correctItem', 'a', 'i']);
});

test('试答复用生效纠错卡并在期间撤销时丢弃旧回执', async t => {
  const { f, av, world } = setup(t), out = await f.correctItem(av.id, 'item', { ...correction, redraft: false });
  const good = await f.runTryout(av.id, { question: '会议纪要导出格式怎么选择？' });
  assert.equal(good.ok, true); assert.match(good.result.basis[0], /纠错卡/);
  world.onAsk = () => f.correctionToggle(av.id, { cardId: out.card.id, active: false });
  const stale = await f.runTryout(av.id, { question: '会议纪要导出格式怎么选择？' });
  assert.equal(stale.ok, false); assert.match(stale.error, /口径已更新/);
});

test('已有待生成队列时只立即重答本题，版本变化中的旧正式回执不覆盖纠正', async t => {
  const { f, av, owner, world } = setup(t);
  f.pump = () => {}; // 隔离自动巡检续跑，精确检查本轮回执是否落盘。
  f.mutate(owner, av.id, st => { for (let i = 0; i < 8; i++) st.items['queued' + i] = { ...st.items.item, id: 'queued' + i, state: 'new', at: 1 }; });
  const out = await f.correctItem(av.id, 'item', correction);
  assert.equal(out.redraftResult.draft, '按新口径选择本地导出。'); assert.deepEqual(world.tasks[0].items.map(i => i.id), ['item']);
  world.onAsk = () => f.correctionToggle(av.id, { cardId: out.card.id, active: false });
  f.mutate(owner, av.id, st => { st.items.item.state = 'new'; });
  await f.runAvatar(owner, av.id, { itemId: 'item' });
  const latest = f.state(owner, av.id).items.item;
  assert.equal(latest.state, 'new'); assert.equal(latest.draft, out.redraftResult.draft);
});
