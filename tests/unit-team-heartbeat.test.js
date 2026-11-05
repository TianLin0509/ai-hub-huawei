'use strict';
// 组队心跳与投递可靠性（2026-11-03 用户）：运行中却长时间无输出、会话离线时提醒负责人；
// 明确没发出去的消息自动退避重发，用完后自动重启一次；不叫醒的留言超时或攒满后顺带送达。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');

const MIN = 60 * 1000;

function harness(t, { submit, restart } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-hb-'));
  const sessions = new Map([['lead-0001', { id: 'lead-0001', title: '总控', kind:'codeagent', cwd: dataDir, status: 'idle' }]]);
  const busy = new Set(), sent = [], lastOut = new Map(), restarts = [];
  const clock = { t: 1_800_000_000_000 };
  let n = 0;
  const service = createTeamService({
    getHubDataDir: () => dataDir, getConfig: () => ({}), now: () => clock.t,
    sessionManager: {
      getSession: id => sessions.get(id) || null, isAgentTurnActive: id => busy.has(id),
      getGroupChatLastActivity: id => lastOut.get(id) || 0,
    },
    logger: { warn() {} },
    createSession: async request => {
      const id = `member-${++n}xx`;
      const s = { id, kind:'codeagent', title: request.opts.title, status: 'idle' };
      sessions.set(id, s); return s;
    },
    submitPrompt: async (sessionId, text) => {
      const r = submit ? submit(sessionId, text) : { ok: true };
      if (r.ok !== false) sent.push({ sessionId, text });
      return r;
    },
    restartSession: async id => { restarts.push(id); return restart ? restart(id) : { ok: true }; },
    listAccounts: () => ({ recommendedId:'acc-a', rows:[{id:'acc-a',usable:true,models:['GLM-5.2'],modelsAuthoritative:true}] }),
    commandPath: () => 'C:/hub/team/hub-team.cmd',
  });
  const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(r => setImmediate(r)); await service.flush('lead-0001'); } };
  t.after(async()=>{service.freeze();service.stop();await settle();assert.equal(path.dirname(dataDir),os.tmpdir());fs.rmSync(dataDir,{recursive:true,force:true});});
  const readTeam = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'teams', 'lead-0001.json'), 'utf8'));
  return { service, sessions, busy, sent, lastOut, restarts, clock, settle, readTeam };
}
async function oneMember(h) {
  const { planId } = await h.service.invoke('lead-0001', 'propose', { goal: 'g', members: [{ role: 'r', task: 't' }] });
  await h.service.decide({ leadSid: 'lead-0001', planId, approve: true });
  await h.settle();
  h.sent.length = 0;
}
const hubNotes = h => h.readTeam().messages.filter(m => m.from === 'hub' && m.to === 'lead');

test('running member with no terminal output for 10 minutes alerts the lead once per silent stretch', async t => {
  const h = harness(t);
  await oneMember(h);
  h.busy.add('member-1xx');
  h.lastOut.set('member-1xx', h.clock.t);
  h.clock.t += 9 * MIN; h.service.watch();
  assert.equal(hubNotes(h).filter(m => /可能卡住/.test(m.text)).length, 0, '9 分钟不报');
  h.clock.t += 2 * MIN; h.service.watch(); h.service.watch();
  const stalls = hubNotes(h).filter(m => /可能卡住/.test(m.text));
  assert.equal(stalls.length, 1, '同一段静默只报一次');
  assert.match(stalls[0].text, /m1.*11 分钟.*restart --member m1/);
  assert.notEqual(stalls[0].wake, false, '提醒要叫醒负责人');
  // 恢复输出后再次静默，算新的一段。
  h.lastOut.set('member-1xx', h.clock.t);
  h.service.watch();
  h.clock.t += 11 * MIN; h.service.watch();
  assert.equal(hubNotes(h).filter(m => /可能卡住/.test(m.text)).length, 2);
  // 输出正常的运行中成员不报。
  const status = await h.service.invoke('lead-0001', 'status');
  assert.equal(status.members.find(m => m.memberId === 'm1').runtime.lastOutputMinAgo, 11);
});

test('idle or actively printing members never raise stall alerts', async t => {
  const h = harness(t);
  await oneMember(h);
  h.lastOut.set('member-1xx', h.clock.t - 60 * MIN);
  h.service.watch();
  h.busy.add('member-1xx'); h.lastOut.set('member-1xx', h.clock.t - 30 * 1000);
  h.service.watch();
  assert.equal(hubNotes(h).filter(m => /可能卡住/.test(m.text)).length, 0);
});

test('a member whose session vanished with queued mail is reported after 3 minutes, once', async t => {
  const h = harness(t);
  await oneMember(h);
  h.sessions.delete('member-1xx');
  await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '继续做 B' });
  await h.settle();
  h.clock.t += 2 * MIN; h.service.watch();
  assert.equal(hubNotes(h).filter(m => /不在运行/.test(m.text)).length, 0);
  h.clock.t += 2 * MIN; h.service.watch(); h.service.watch();
  const notes = hubNotes(h).filter(m => /不在运行/.test(m.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /1 条消息送不到/);
});

test('notSent deliveries back off 1/3/10 minutes, then auto-restart once, then fail and tell the lead', async t => {
  let fail = false;
  const h = harness(t, { submit: sid => (sid === 'member-1xx' && fail ? { ok: false, notSent: true, error: 'cli-not-ready', message: '助理启动尚未完成' } : { ok: true }) });
  await oneMember(h);
  fail = true;
  const { messageId } = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '保留正文' });
  const msg = () => h.readTeam().messages.find(m => m.id === messageId);
  await h.settle();
  assert.equal(msg().state, 'queued'); assert.equal(msg().retries, 1);
  for (const [wait, retries] of [[1, 2], [3, 3]]) {
    h.clock.t += wait * MIN - 1000; await h.settle();
    assert.equal(msg().retries, retries - 1, '退避时间未到不重发');
    h.clock.t += 1000; await h.settle();
    assert.equal(msg().retries, retries);
  }
  h.clock.t += 10 * MIN; await h.settle();
  assert.deepEqual(h.restarts, ['member-1xx'], '重发用完后自动重启一次');
  assert.equal(msg().state, 'queued'); assert.equal(msg().restarted, true);
  assert.ok(hubNotes(h).some(m => /已自动重启它一次/.test(m.text)));
  // 重启后又一轮退避仍失败：不再重启，判失败并告诉负责人。
  for (const wait of [1, 1, 3, 10]) { h.clock.t += wait * MIN; await h.settle(); }
  assert.equal(h.restarts.length, 1);
  assert.equal(msg().state, 'failed');
  assert.ok(hubNotes(h).some(m => /没送达/.test(m.text)));
});

for (const [label, receipt] of [
  ['residual code', { code: 'codeagent-input-residual' }],
  ['residual error', { error: 'codeagent-input-residual' }],
  ['draft message', { message: '终端输入框有未发送内容，请先处理' }],
  ['clearance not confirmed', { message: '尚未确认终端输入已清空，请到终端确认' }],
  ['clearance error', { error: '尚未确认终端输入已清空，请到终端确认' }],
  ['input changed', { message: '终端输入已变化或无法确认，请重新取回' }],
]) {
  test(`exhausted delivery preserves user input and only alerts the lead: ${label}`, async t => {
    let blocked = false, attempts = 0, draft = '用户尚未发出的草稿';
    const h = harness(t, {
      submit: sid => {
        if (sid !== 'member-1xx' || !blocked) return { ok: true };
        attempts++;
        return { ok: false, notSent: true, ...receipt };
      },
      restart: () => { draft = ''; return { ok: true }; },
    });
    await oneMember(h); blocked = true;
    const { messageId } = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '保留待发团队消息' });
    await h.settle();
    for (const mins of [1, 3, 10]) { h.clock.t += mins * MIN; await h.settle(); }
    assert.deepEqual(h.restarts, [], '输入待处理不能通过重启清空');
    assert.equal(draft, '用户尚未发出的草稿');
    const msg = h.readTeam().messages.find(m => m.id === messageId);
    assert.equal(msg.state, 'failed');
    assert.equal(msg.text, '保留待发团队消息');
    assert.equal(msg.retries, 3);
    assert.ok(!msg.restarted);
    assert.ok(!h.readTeam().members[0].autoRestartAt, '不消耗自动重启额度');
    const notes = hubNotes(h).filter(m => /没送达/.test(m.text));
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /m1.*终端输入.*未自动重启/);
    assert.notEqual(notes[0].wake, false, '通知负责人处理');
    h.clock.t += 31 * MIN; await h.settle();
    assert.equal(attempts, 4, '退避耗尽后不再重发或重启');
    assert.equal(hubNotes(h).filter(m => /没送达/.test(m.text)).length, 1);
    assert.deepEqual(h.restarts, []);
  });
}

test('clearing a draft during backoff delivers the queued message once without restarting', async t => {
  let blocked = false;
  const h = harness(t, { submit: sid => sid === 'member-1xx' && blocked
    ? { ok: false, notSent: true, code: 'codeagent-input-residual' } : { ok: true } });
  await oneMember(h); blocked = true;
  const { messageId } = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '草稿处理后继续' });
  await h.settle();
  assert.equal(h.readTeam().messages.find(m => m.id === messageId).state, 'queued');
  blocked = false; h.clock.t += MIN; await h.settle();
  assert.equal(h.readTeam().messages.find(m => m.id === messageId).state, 'sent');
  assert.equal(h.sent.filter(s => s.sessionId === 'member-1xx').length, 1);
  assert.deepEqual(h.restarts, []);
  assert.equal(hubNotes(h).filter(m => /没送达|自动重启/.test(m.text)).length, 0);
});

test('a draft discovered after launch retries prevents the pending automatic restart', async t => {
  let receipt = { ok: true };
  const h = harness(t, { submit: sid => sid === 'member-1xx' ? receipt : { ok: true } });
  await oneMember(h);
  receipt = { ok: false, notSent: true, error: 'cli-not-ready' };
  const { messageId } = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: '启动后已有草稿' });
  await h.settle();
  for (const mins of [1, 3]) { h.clock.t += mins * MIN; await h.settle(); }
  receipt = { ok: false, notSent: true, code: 'codeagent-input-residual' };
  h.clock.t += 10 * MIN; await h.settle();
  assert.deepEqual(h.restarts, []);
  assert.equal(h.readTeam().messages.find(m => m.id === messageId).state, 'failed');
  assert.match(hubNotes(h).find(m => /没送达/.test(m.text)).text, /未自动重启/);
});

test('a notSent delivery that later succeeds is sent once; plain failures and unconfirmed are not retried', async t => {
  let mode = 'ok';
  const h = harness(t, { submit: sid => {
    if (sid !== 'member-1xx') return { ok: true };
    if (mode === 'notSent') { mode = 'ok'; return { ok: false, notSent: true, error: 'cli-not-ready' }; }
    if (mode === 'plain') return { ok: false, error: '未写入' };
    return { ok: true };
  } });
  await oneMember(h);
  mode = 'notSent';
  const first = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: 'A' });
  await h.settle();
  h.clock.t += MIN; await h.settle();
  assert.equal(h.readTeam().messages.find(m => m.id === first.messageId).state, 'sent');
  assert.equal(h.sent.filter(s => s.sessionId === 'member-1xx').length, 1);
  mode = 'plain';
  const second = await h.service.invoke('lead-0001', 'send', { to: 'm1', message: 'B' });
  await h.settle();
  assert.equal(h.readTeam().messages.find(m => m.id === second.messageId).state, 'unconfirmed', '可能已写入的失败不自动重发');
  assert.equal(h.restarts.length, 0);
});

test('no-wake notes reach an idle lead after 30 minutes or once 8 pile up', async t => {
  const h = harness(t);
  await oneMember(h);
  await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '进度 10%', wake: false });
  await h.settle();
  h.clock.t += 29 * MIN; await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 0);
  h.clock.t += MIN; await h.settle();
  const toLead = h.sent.filter(s => s.sessionId === 'lead-0001');
  assert.equal(toLead.length, 1); assert.match(toLead[0].text, /进度 10%/);

  for (let i = 0; i < 7; i++) await h.service.invoke('member-1xx', 'send', { to: 'lead', message: `进度 ${i}`, wake: false });
  await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 1, '7 条不送');
  await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '进度 7', wake: false });
  await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 2, '攒满 8 条送达');
  // 负责人忙时仍然等。
  h.busy.add('lead-0001');
  await h.service.invoke('member-1xx', 'send', { to: 'lead', message: '进度 8', wake: false });
  h.clock.t += 31 * MIN; await h.settle();
  assert.equal(h.sent.filter(s => s.sessionId === 'lead-0001').length, 2);
});

test('explicit stops and ambiguous receipts never enter automatic retry', async t => {
  let result = {ok:true}, attempts=0;
  const h=harness(t,{submit:sid=>{if(sid==='member-1xx'){attempts++;return result;}return{ok:true};}});
  await oneMember(h);
  for(const receipt of [{ok:false,notSent:true,stopped:true},{ok:false,unconfirmed:true},{ok:true,stopped:true,notSent:false}]){
    result=receipt;const before=attempts;
    const r=await h.service.invoke('lead-0001','send',{to:'m1',message:'receipt case'});
    await h.settle();h.clock.t+=60*MIN;await h.settle();
    assert.equal(attempts,before+1);
    assert.equal(h.readTeam().messages.find(m=>m.id===r.messageId).state,receipt.notSent?'failed':'unconfirmed');
  }
  assert.equal(h.restarts.length,0);
});

test('a failed restart does not claim success or restart again inside thirty minutes',async t=>{
  let fail=false;
  const h=harness(t,{submit:sid=>sid==='member-1xx'&&fail?{ok:false,notSent:true}:{ok:true},restart:()=>({ok:false})});
  await oneMember(h);fail=true;
  const exhausted=async()=>{
    const r=await h.service.invoke('lead-0001','send',{to:'m1',message:'restart failure'});
    await h.settle();for(const mins of [1,3,10]){h.clock.t+=mins*MIN;await h.settle();}
    return h.readTeam().messages.find(m=>m.id===r.messageId);
  };
  assert.equal((await exhausted()).state,'failed');assert.equal(h.restarts.length,1);
  assert.equal((await exhausted()).state,'failed');assert.equal(h.restarts.length,1);
  assert.ok(!hubNotes(h).some(m=>/已自动重启它一次/.test(m.text)));
  const saved=h.readTeam().members[0];assert.ok(saved.autoRestartAt);assert.equal(saved.autoRestartConfirmed,false);
});
