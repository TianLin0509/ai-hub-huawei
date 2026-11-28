'use strict';
// 社区·我的团队（2026-11-28）：两台「电脑」用本机临时目录模拟各自的共享文件夹，走一遍
// 建团队 → 邀请 → 加入 → 互相发现 → 广播 → 提问（起草 / 自动答 / 拒绝）→ 回信 → 加密分享文件夹 → 取回 → 撤回。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const seal = require('../core/community-crew/seal');
const { createCrewService, classify, parseCommand, strictest, insideRoot } = require('../core/community-crew/service');

const testBase = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(testBase, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(testBase, 'crew-tests-'));
test.after(() => { assert.ok(insideRoot(testBase, testRoot)); fs.rmSync(testRoot, { recursive: true, force: true }); });
const tmp = name => fs.mkdtempSync(path.join(testRoot, `crew-${name}-`));

function machine(name, ip, net, options = {}) {
  const shareDir = tmp(name + '-share');
  const dataDir = tmp(name + '-data');
  net[ip] = { name: 'S_' + name, path: shareDir };
  const shareTools = {
    listShares: async () => [{ name: 'S_' + name, path: shareDir }],
    pickShare: (shares) => shares[0] || null,
    createShare: async () => { throw new Error('不该被调用'); },
    boxDir: s => path.join(s.path, 'ai-hub-community'),
    peerBoxDir: (peerIp, share) => { const n = net[peerIp]; if (!n || n.name !== share) return path.join(os.tmpdir(), 'no-such-host-' + peerIp); return path.join(n.path, 'ai-hub-community'); },
    inboundSmbPeers: async () => (options.inbound ? options.inbound() : []),
    powershell: async script => { const m = script.match(/net view \\\\\\\\([\d.]+)|net view \\\\([\d.]+)/); const host = m && (m[1] || m[2]); return host && net[host] ? `共享名  类型\r\n${net[host].name}   Disk\r\n命令成功完成。` : ''; },
  };
  const events = [], notices = [], prompts = [], warnings = [];
  let offset = 0, on = true;
  const svc = createCrewService({ dataDir, probeSmb: options.probeSmb, now: () => Date.now() + offset, isEnabled: () => on, profile: () => ({ nick: name, pet: '03-penguin', petName: name + '的宠' }), shareTools, ipCandidates: () => [ip],
    emit: (t, d) => events.push({ t, d }), notify: n => notices.push(n), runModel: async p => { prompts.push(p); return options.runModel ? options.runModel(p) : svc.modelReply || '草稿：好的（待补充）'; },
    selfStyle: options.selfStyle, selfGuard: options.selfGuard,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} }, logger: { warn(...args) { warnings.push(args); } } });
  return { svc, h: svc.handlers, events, notices, prompts, dataDir, shareDir, shareTools, warnings,
    advance: ms => { offset += ms; }, enable: value => { on = value; } };
}

test('加密：信件与文件都能原样解开，钥匙不对解不开', async () => {
  const k = seal.newKey();
  assert.deepEqual(seal.openJson(k, seal.sealJson(k, { a: '中文', n: 1 })), { a: '中文', n: 1 });
  assert.throws(() => seal.openJson(seal.newKey(), seal.sealJson(k, { a: 1 })));
  const d = tmp('seal');
  const src = path.join(d, 'a.bin'); fs.writeFileSync(src, Buffer.alloc(300000, 7));
  await seal.sealFile(k, src, path.join(d, 'a.enc'));
  await seal.openFile(k, path.join(d, 'a.enc'), path.join(d, 'a.out'));
  assert.ok(fs.readFileSync(path.join(d, 'a.out')).equals(fs.readFileSync(src)));
  assert.equal(seal.normCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(seal.prettyCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('来信分类：收信方取更严的类别，发信方改不松', () => {
  assert.equal(classify('六小区零授权是不是缺配置？'), 'ask');
  assert.equal(classify('调度方案本周进展到哪了？'), 'progress');
  assert.equal(classify('帮我看一下 PR #213 能不能合？'), 'review');
  assert.equal(classify('帮我跑一组仿真，20 个种子'), 'task');
  assert.equal(classify('他这个月表现怎么样？'), 'person');
  assert.equal(strictest('ask', 'person'), 'person');
  assert.equal(strictest('task', 'ask'), 'task');
});

test('对桌宠说：分享、提问、广播三种解析', () => {
  const members = [{ id: 'm1', nick: '李工' }, { id: 'm2', nick: '张工' }];
  const s = parseCommand('把 D:\\SRS脚本 分享给李工，用法是 python run.py --cfg 六小区', members);
  assert.deepEqual([s.kind, s.to, s.dir, s.use], ['share', 'm1', 'D:\\SRS脚本', 'python run.py --cfg 六小区']);
  const a = parseCommand('问问张工 SRS 周期的现网经验值', members);
  assert.deepEqual([a.kind, a.to, a.text], ['ask', 'm2', 'SRS 周期的现网经验值']);
  const b = parseCommand('告诉大家我今晚挂仿真，明早出结果', members);
  assert.deepEqual([b.kind, b.text], ['say', '我今晚挂仿真，明早出结果']);
  for (const text of ['问问陌生成员 周期是多少', '帮我问一下 周期是多少', '去问 周期是多少']) {
    const result = parseCommand(text, members);
    assert.equal(result.kind, 'ask'); assert.equal(result.to, ''); assert.ok(result.text);
  }
});

test('两台电脑：邀请入队、互相发现、广播、提问回信、分享与撤回', async () => {
  const net = {};
  const A = machine('甲', '10.1.1.1', net), B = machine('乙', '10.1.1.2', net);
  assert.equal((await A.h['detect-share']()).ok, true);
  assert.equal((await B.h['detect-share']()).ok, true);
  const { crew } = await A.h['new-crew']({ name: '调度小组' });
  const inv = await A.h.invite({ crewId: crew.id, forName: '乙', ip: '10.1.1.2' });
  assert.match(inv.message, /\\\\10\.1\.1\.1\\S_甲/);
  assert.match(inv.message, /[A-Z0-9]{4}-[A-Z0-9]{4}/);
  // 邀请码错了进不来
  await assert.rejects(B.h.join({ text: inv.message.replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/, 'ZZZZ-ZZZZ') }), /没找到这个邀请/);
  B.advance(17000);
  const j = await B.h.join({ text: inv.message });
  assert.equal(j.name, '调度小组');
  // 甲按邀请时填的 IP 去乙的共享里找到乙
  await A.svc.pollOnce();
  let snapA = A.svc.snapshot().crews[0];
  assert.equal(snapA.members.length, 2);
  const bId = snapA.members.find(m => !m.me).id;
  await B.svc.pollOnce();
  const snapB = B.svc.snapshot().crews[0];
  const aId = snapB.members.find(m => !m.me).id;
  assert.equal(snapB.members.find(m => !m.me).nick, '甲');
  // 乙入队时的「我加入团队啦」甲收到了；名片读到后乙在线
  await A.svc.pollOnce();
  snapA = A.svc.snapshot().crews[0];
  assert.ok(snapA.items.some(i => i.type === 'say' && i.text.includes('加入')));
  assert.equal(snapA.members.find(m => m.id === bId).online, true);
  assert.equal(snapA.members.find(m => m.id === bId).nick, '乙');

  // 广播
  await A.h.say({ crewId: crew.id, text: '今晚挂仿真' });
  await B.svc.pollOnce();
  assert.ok(B.events.some(e => e.t === 'event' && e.d.kind === 'say' && e.d.text === '今晚挂仿真'));

  // 提问：没配可外答资料 → 起草等本人确认（调了一次模型起草）
  await A.h.ask({ crewId: crew.id, to: bId, text: 'SRS 周期现网用多少？' });
  await B.svc.pollOnce();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.type === 'ask')?.draft);
  let ask = B.svc.snapshot().crews[0].items.find(i => i.type === 'ask');
  assert.equal(ask.status, 'wait');
  assert.match(ask.draft, /草稿/);
  assert.ok(B.notices.some(n => /等你确认/.test(n.title)));
  await B.h['answer-draft']({ crewId: crew.id, id: ask.id, text: '20/40/80 ms 三档' });
  await A.svc.pollOnce();
  const mine = A.svc.snapshot().crews[0].items.find(i => i.type === 'ask' && i.mine);
  assert.equal(mine.answer.text, '20/40/80 ms 三档');

  // 配了资料 → 自动作答，资料原文进了提示词
  const mat = tmp('mat'); fs.writeFileSync(path.join(mat, '口径.md'), 'SRS 周期：现网 20/40/80 ms');
  await B.h['set-settings']({ answerDir: mat });
  B.svc.modelReply = '现网 20/40/80 ms，出处：口径.md';
  await A.h.ask({ crewId: crew.id, to: bId, text: '再问一次 SRS 周期？' });
  await B.svc.pollOnce();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.text === '再问一次 SRS 周期？')?.status === 'auto');
  assert.ok(B.prompts.some(p => p.includes('SRS 周期：现网 20/40/80 ms') && p.includes('再问一次')));
  ask = B.svc.snapshot().crews[0].items.find(i => i.type === 'ask' && i.text === '再问一次 SRS 周期？');
  assert.equal(ask.status, 'auto');

  // 问人的评价 → 直接拒绝，不调模型
  const before = B.prompts.length;
  await A.h.ask({ crewId: crew.id, to: bId, text: '丙这个月表现怎么样？', intent: 'ask' });
  await B.svc.pollOnce();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.text.includes('表现'))?.status === 'rejected');
  ask = B.svc.snapshot().crews[0].items.find(i => i.type === 'ask' && i.text.includes('表现'));
  assert.equal(ask.status, 'rejected');
  assert.equal(B.prompts.length, before);

  // 分享文件夹：加密进甲的信箱，乙自动取回、内容一致；信箱里看不到明文
  const dir = tmp('src');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'run.py'), 'print("六小区")');
  fs.writeFileSync(path.join(dir, 'sub', 'cfg.txt'), 'seed=1..20');
  fs.mkdirSync(path.join(dir, '.git')); fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
  const pv = await A.h['share-preview']({ dir });
  assert.equal(pv.count, 2);
  const sent = await A.h['share-send']({ crewId: crew.id, dir, to: bId, use: 'python run.py', days: 7 });
  const blobs = path.join(A.shareDir, 'ai-hub-community', 'crews', crew.id);
  const allText = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else allText.push(fs.readFileSync(p).toString('latin1')); } })(blobs);
  assert.ok(!allText.some(t => t.includes('seed=1..20')), '信箱里不能有明文');
  await B.svc.pollOnce();
  await new Promise(r => setTimeout(r, 200));
  const got = B.svc.snapshot().crews[0].items.find(i => i.type === 'share');
  assert.equal(got.local.state, 'done');
  assert.equal(fs.readFileSync(path.join(got.local.path, 'sub', 'cfg.txt'), 'utf8'), 'seed=1..20');
  assert.equal(got.share.use, 'python run.py');
  // 撤回：甲的密文删掉，乙收到撤回
  await A.h['share-revoke']({ crewId: crew.id, id: sent.id });
  assert.equal(fs.existsSync(path.join(blobs, A.svc._state().me.id, 'blobs', sent.share.id)), false);
  await B.svc.pollOnce();
  assert.equal(B.svc.snapshot().crews[0].items.find(i => i.type === 'share').revoked, true);

  // 改成员 IP：手动改过的不被对方名片覆盖
  await A.h['set-member']({ crewId: crew.id, memberId: bId, ip: '10.9.9.9' });
  const t = await A.h['test-member']({ crewId: crew.id, memberId: bId });
  assert.equal(t.ok, false);
  assert.equal(A.svc.snapshot().crews[0].members.find(m => m.id === bId).ip, '10.9.9.9');
  assert.ok(aId);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setImmediate(r));
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('等待操作完成超时');
}
async function pair(options = {}) {
  const net = {}, A = machine('发送端', '10.2.1.1', net), B = machine('接收端', '10.2.1.2', net, options);
  await A.h['detect-share'](); await B.h['detect-share']();
  await A.h['new-crew']({ name: '测试团队' });
  const crew = A.svc._state().crews[0];
  const bCrew = { ...crew, members: [{ id: A.svc._state().me.id, nick: '发送端', ip: '10.2.1.1', share: 'S_发送端' }], invites: [] };
  B.svc._state().crews.push(bCrew);
  crew.members.push({ id: B.svc._state().me.id, nick: '接收端', ip: '10.2.1.2', share: 'S_接收端' });
  await A.svc.publishAll(); await B.svc.publishAll();
  return { A, B, crew, bCrew };
}
let feedTick = 0;
const mailbox = (machine, crewId) => path.join(machine.shareDir, 'ai-hub-community', 'crews', crewId, machine.svc._state().me.id);
function feed(A, crew, items) {
  const file = path.join(mailbox(A, crew.id), 'feed.bin');
  fs.writeFileSync(file, seal.sealJson(crew.key, { items }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + ++feedTick * 1000));
}
const message = (A, type, extra = {}) => ({ id: require('node:crypto').randomBytes(8).toString('hex'), at: Date.now(), from: A.svc._state().me.id, to: '*', type, ...extra });

test('固定根校验：恶意邀请、成员及分享标识和路径被拒绝且不越界写盘', async () => {
  const { A, B, crew } = await pair();
  const root = path.join(B.dataDir, 'community', 'crew');
  assert.equal(insideRoot(root, root + '-other/file'), false);
  assert.equal(insideRoot(root, path.join(root, '..', 'escape')), false);
  assert.equal(insideRoot(root.toUpperCase(), path.join(root, 'received', 'file')), true);
  const stateFile = path.join(root, 'state.json');
  await B.h['set-settings']({});
  const before = fs.readFileSync(stateFile, 'utf8');
  assert.throws(() => B.h.leave({ crewId: '../../escape' }), /标识/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  const inv = await A.h.invite({ crewId: crew.id });
  const invFile = path.join(A.shareDir, 'ai-hub-community', 'invites', seal.inviteId(inv.code) + '.bin');
  const original = seal.openJson(seal.inviteKey(inv.code), fs.readFileSync(invFile));
  for (const pack of [{ ...original, crewId: '../../escape' }, { ...original, from: { ...original.from, id: '/../../' } }]) {
    fs.writeFileSync(invFile, seal.sealJson(seal.inviteKey(inv.code), pack));
    await assert.rejects(B.h.join({ text: inv.message }), /标识无效/);
  }
  const cardFile = path.join(mailbox(A, crew.id), 'card.bin');
  const card = seal.openJson(crew.key, fs.readFileSync(cardFile));
  card.roster = [{ id: '../../escape', ip: '10.2.1.3', share: 'public' }];
  fs.writeFileSync(cardFile, seal.sealJson(crew.key, card));
  const badRels = ['/root', 'C:/escape', '../escape', 'a/../escape', 'a//b', 'a/', 'a:stream', '\\\\host\\share', 'a\\..\\escape', '.. /escape', 'a./b'];
  const shares = badRels.map(rel => message(A, 'share', { share: { id: 'abcdef123456', name: '恶意', size: 0, files: [{ rel, size: 0 }] } }));
  shares.push(message(A, 'share', { share: { id: '/../..', name: '恶意', size: 0, files: [{ rel: 'state.json', size: 0 }] } }));
  for (const size of [-1, 0.5, '0', null]) shares.push(message(A, 'share', { share: { id: 'abcdef123456', name: '恶意', size, files: [{ rel: 'state.json', size: 0 }] } }));
  feed(A, crew, shares);
  await B.svc.pollOnce(); await turn();
  assert.equal(B.svc._state().crews[0].members.length, 1);
  assert.equal(B.svc.snapshot().crews[0].items.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'received')), false);
  assert.equal(fs.existsSync(path.join(B.dataDir, 'escape')), false);
  assert.ok(B.warnings.length >= shares.length);
});

test('邀请：12 位随机码、8 位旧格式解析，用过的仍可多人用，过期的密文实际删除', async () => {
  const net = {}, A = machine('邀请端', '10.3.1.1', net), B = machine('入队端', '10.3.1.2', net);
  await A.h['detect-share'](); await B.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '邀请测试' });
  const inv = await A.h.invite({ crewId: crew.id, ip: '10.3.1.2' });
  assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(seal.newInviteCode().length, 12);
  const expected = require('node:crypto').scryptSync(seal.normCode(inv.code), 'hub-crew-invite-id', 16).toString('hex');
  assert.equal(seal.inviteId(inv.code), expected);
  const file = path.join(A.shareDir, 'ai-hub-community', 'invites', expected + '.bin');
  const pack = seal.openJson(seal.inviteKey(inv.code), fs.readFileSync(file));
  const oldCode = 'ABCD2345';
  fs.writeFileSync(path.join(path.dirname(file), seal.inviteId(oldCode) + '.bin'), seal.sealJson(seal.inviteKey(oldCode), pack));
  await B.h.join({ text: `地址 \\\\10.3.1.1\\S_邀请端 邀请码 ${seal.prettyCode(oldCode)}` });
  await turn();
  await A.svc.pollOnce();
  assert.ok(A.svc._state().crews[0].members.some(m => m.id === B.svc._state().me.id), '按邀请填的 IP 找到入队的人');
  assert.equal(fs.existsSync(file), true, '一条邀请到期前可多人使用');
  const expired = await A.h.invite({ crewId: crew.id });
  const expiredFile = path.join(path.dirname(file), seal.inviteId(expired.code) + '.bin');
  assert.equal(fs.existsSync(expiredFile), true);
  A.advance(8 * 86400000);
  await A.svc.pollOnce();
  assert.equal(fs.existsSync(expiredFile), false);
});

test('实际字节限额：size=0 的超大分享自动取回被 300 MB 上限中止并清理 part', async () => {
  const { A, B, crew } = await pair();
  const id = 'ab1234567890abcd', src = path.join(tmp('large'), 'large.dat');
  const handle = fs.openSync(src, 'w'); fs.ftruncateSync(handle, 300 * 1024 ** 2 + 1); fs.closeSync(handle);
  const blobs = path.join(mailbox(A, crew.id), 'blobs', id); fs.mkdirSync(blobs, { recursive: true });
  await seal.sealFile(crew.key, src, path.join(blobs, '0.bin'));
  const item = message(A, 'share', { share: { id, name: '大文件', size: 0, files: [{ rel: 'large.dat', size: 0 }] } });
  feed(A, crew, [item]); await B.svc.pollOnce();
  const local = () => B.svc.snapshot().crews[0].items.find(i => i.id === item.id)?.local;
  await until(() => local()?.state === 'error');
  assert.match(local().error, /实际大小超过接收上限/);
  assert.equal(fs.existsSync(path.join(local().path, 'large.dat')), false);
  assert.equal(fs.existsSync(path.join(local().path, 'large.dat.part')), false);
});

test('同一分享并发取回复用同一个 Promise，文件只解密一次', async t => {
  const { A, B, crew } = await pair();
  const id = 'abcdef0011223344', source = path.join(tmp('small'), 'data'); fs.writeFileSync(source, '实际字节');
  const blobs = path.join(mailbox(A, crew.id), 'blobs', id); fs.mkdirSync(blobs, { recursive: true });
  await seal.sealFile(crew.key, source, path.join(blobs, '0.bin'));
  const item = message(A, 'share', { share: { id, name: '手动取回', size: 301 * 1024 ** 2, files: [{ rel: 'a.txt', size: 0 }] } });
  feed(A, crew, [item]); await B.svc.pollOnce();
  const gate = deferred(), entered = deferred(), original = seal.openFile; let calls = 0;
  t.mock.method(seal, 'openFile', async (...args) => { calls++; entered.resolve(); await gate.promise; return original(...args); });
  const p1 = B.h['share-fetch']({ crewId: crew.id, id: item.id });
  const p2 = B.h['share-fetch']({ crewId: crew.id, id: item.id });
  assert.equal(p1, p2); await entered.promise;
  assert.equal(B.h['share-fetch']({ crewId: crew.id, id: item.id }), p1);
  gate.resolve(); const result = await p1;
  assert.equal(calls, 1); assert.equal(fs.readFileSync(path.join(result.path, 'a.txt'), 'utf8'), '实际字节');
});

test('离线：模型返回后不写 feed 或 card，不把迟到的答案留待下次发布', async () => {
  const gate = deferred(), entered = deferred();
  const { A, B, crew } = await pair({ runModel: () => { entered.resolve(); return gate.promise; } });
  const mat = tmp('material'); fs.writeFileSync(path.join(mat, 'answer.txt'), '可外答资料');
  await B.h['set-settings']({ answerDir: mat });
  const box = mailbox(B, crew.id), beforeFeed = fs.readFileSync(path.join(box, 'feed.bin')), beforeCard = fs.readFileSync(path.join(box, 'card.bin'));
  feed(A, crew, [message(A, 'ask', { text: '口径是什么？', to: B.svc._state().me.id })]);
  const polling = B.svc.pollOnce(); await entered.promise;
  B.enable(false); gate.resolve('迟到的答案'); await polling; await turn();
  // 名片在线时会写一次「收到、起草中」的回执；离线之后不再有任何写入，回执里也不会出现已答。
  const offlineCard = fs.readFileSync(path.join(box, 'card.bin')); void beforeCard;
  await B.svc.publishAll();
  assert.deepEqual(fs.readFileSync(path.join(box, 'feed.bin')), beforeFeed);
  assert.deepEqual(fs.readFileSync(path.join(box, 'card.bin')), offlineCard);
  const rx = seal.openJson(crew.key, offlineCard).rx[A.svc._state().me.id];
  assert.ok(!Object.values(rx.asks).includes('auto'));
  assert.ok(!B.svc.snapshot().crews[0].items.some(i => i.type === 'answer'));
  B.enable(true); await B.svc.publishAll();
  assert.ok(!seal.openJson(crew.key, fs.readFileSync(path.join(box, 'feed.bin'))).items.some(i => i.type === 'answer'));
});

test('持久去重：日志裁剪并重启后，旧提问不会再次调模型', async () => {
  const { A, B, crew } = await pair();
  const first = message(A, 'ask', { text: '同一个问题' });
  feed(A, crew, [first]); await B.svc.pollOnce();
  assert.equal(B.prompts.length, 1);
  feed(A, crew, Array.from({ length: 410 }, (_, i) => message(A, 'say', { text: String(i) })));
  await B.svc.pollOnce();
  assert.ok(!B.svc.snapshot().crews[0].items.some(i => i.id === first.id));
  const seenFile = path.join(B.dataDir, 'community', 'crew', `seen-${crew.id}.json`);
  assert.ok(JSON.parse(fs.readFileSync(seenFile, 'utf8'))[`${first.from}:${first.id}`]);
  let calls = 0;
  const restarted = createCrewService({ dataDir: B.dataDir, shareTools: B.shareTools, ipCandidates: () => ['10.2.1.2'], runModel: async () => { calls++; return '重复'; }, logger: { warn() {} } });
  feed(A, crew, [first]); await restarted.pollOnce();
  assert.equal(calls, 0);
  assert.ok(!restarted.snapshot().crews[0].items.some(i => i.id === first.id));
});

test('发布队列：旧 feed 写入延迟时，两次快速广播最终都对外可见', async t => {
  const { A, B, crew } = await pair();
  const original = fs.promises.writeFile, gate = deferred(), entered = deferred(); let blocked = false;
  t.mock.method(fs.promises, 'writeFile', async (file, ...args) => {
    if (!blocked && String(file).includes('feed.bin.') && insideRoot(A.shareDir, String(file))) { blocked = true; entered.resolve(); await gate.promise; }
    return original(file, ...args);
  });
  const first = A.h.say({ crewId: crew.id, text: '第一条广播' }); await entered.promise;
  const second = A.h.say({ crewId: crew.id, text: '第二条广播' }); await turn(); gate.resolve();
  await Promise.all([first, second]); await B.svc.pollOnce();
  const texts = B.svc.snapshot().crews[0].items.map(i => i.text);
  assert.ok(texts.includes('第一条广播')); assert.ok(texts.includes('第二条广播'));
});

test('接收总上限按实际字节执行，虚报为零仍不能越过 10 GB', async t => {
  const { A, B, crew } = await pair();
  const root = path.join(B.dataDir, 'community', 'crew', 'received'); fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, '已有数据'); fs.writeFileSync(marker, 'x');
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => String(file) === marker ? { size: 10 * 1024 ** 3 - 4 } : stat(file, ...args));
  const id = 'abcdef0000001111', source = path.join(tmp('total-cap'), 'data'); fs.writeFileSync(source, '12345678');
  const blobs = path.join(mailbox(A, crew.id), 'blobs', id); fs.mkdirSync(blobs, { recursive: true });
  await seal.sealFile(crew.key, source, path.join(blobs, '0.bin'));
  const item = message(A, 'share', { share: { id, name: '总量检查', size: 0, files: [{ rel: 'a.txt', size: 0 }] } });
  feed(A, crew, [item]); await B.svc.pollOnce();
  const local = () => B.svc.snapshot().crews[0].items.find(i => i.id === item.id)?.local;
  await until(() => local()?.state === 'error');
  assert.match(local().error, /实际大小超过接收上限/);
  assert.equal(fs.existsSync(path.join(local().path, 'a.txt.part')), false);
  assert.equal(fs.existsSync(path.join(local().path, 'a.txt')), false);
});

test('UNC 挂起：超时仍占名额、全局最多四个、失败退避后再试', async t => {
  const net = {}, B = machine('本机', '10.8.1.1', net);
  await B.h['detect-share'](); await B.h['new-crew']({ name: '断网测试' });
  const crew = B.svc._state().crews[0];
  for (let i = 1; i <= 6; i++) crew.members.push({ id: `abcdef00${i}`, ip: `10.8.0.${i}`, share: 'public' });
  await B.svc.publishAll();
  const originalStat = fs.promises.stat, originalRead = fs.promises.readFile, entered = deferred();
  const gates = []; let calls = 0, hanging = true;
  const remote = file => String(file).includes('no-such-host-10.8.0.');
  t.mock.method(fs.promises, 'stat', (file, ...args) => {
    if (!remote(file)) return originalStat(file, ...args);
    calls++;
    if (!hanging) return Promise.reject(Object.assign(new Error('无法连接'), { code: 'EHOSTUNREACH' }));
    const gate = deferred(); gates.push(gate); if (gates.length === 4) entered.resolve(); return gate.promise;
  });
  t.mock.method(fs.promises, 'readFile', (file, ...args) => remote(file) ? Promise.reject(new Error('连接已断')) : originalRead(file, ...args));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = B.svc.pollOnce(); await entered.promise;
  assert.equal(calls, 4);
  t.mock.timers.tick(10001); await first;
  B.advance(17000); await B.svc.pollOnce(); assert.equal(calls, 4, '超时后底层未结束，不新增请求');
  hanging = false;
  for (const gate of gates) gate.resolve({ mtimeMs: 1, size: 0 });
  await turn(); await turn();
  // 先前四个请求的退避时间已过；本轮失败后再次立即轮询仍不得重试。
  await B.svc.pollOnce(); const afterRetry = calls;
  assert.ok(afterRetry > 4); await B.svc.pollOnce();
  const afterOtherPeers = calls; await B.svc.pollOnce(); assert.equal(calls, afterOtherPeers);
  B.advance(300001); await B.svc.pollOnce(); assert.ok(calls > afterOtherPeers);
  t.mock.timers.reset();
});

test('主进程拦截遗留 Codex 和 DSH 选择：有 CodeAgent 时回退，没有时不调用模型', async t => {
  const { A, B, crew } = await pair();
  const material = tmp('main-material'); fs.writeFileSync(path.join(material, 'answer.txt'), '只依据资料回复');
  await B.h['set-settings']({ answerDir: material });
  const tools = require('../core/community-crew/lan-share');
  t.mock.method(tools, 'boxDir', B.shareTools.boxDir);
  t.mock.method(tools, 'peerBoxDir', B.shareTools.peerBoxDir);
  t.mock.method(require('../core/company-ai-policy'), 'assertExternalAiAllowed', () => {});
  let backend = 'codex';
  t.mock.method(require('../core/feature-agent-choice'), 'resolve', () => ({ selected: { kind: backend, model: 'old' } }));
  let installed = true; const calls = [];
  t.mock.method(require('../core/community-setup'), 'findCommand', kind => installed && kind === 'codeagent' ? 'fake-codeagent' : '');
  t.mock.method(require('../core/feature-agent-run'), 'run', async (selected, _prompt, options) => { assert.equal(options.crew, true); calls.push(selected); return '资料中的答案'; });
  const main = require('../main/community-crew-service').createCommunityCrewMain({ dataDir: B.dataDir, isEnabled: () => true, logger: { warn() {} } });
  feed(A, crew, [message(A, 'ask', { text: '第一问' })]); await main.pollOnce();
  await until(() => main.snapshot().crews[0].items.find(i => i.text === '第一问')?.status === 'auto');
  assert.deepEqual(calls.map(c => c.kind), ['codeagent']);
  backend = 'deepseek-acp';
  feed(A, crew, [message(A, 'ask', { text: 'DSH 旧选择' })]); await main.pollOnce();
  await until(() => main.snapshot().crews[0].items.find(i => i.text === 'DSH 旧选择')?.status === 'auto');
  assert.deepEqual(calls.map(c => c.kind), ['codeagent', 'codeagent']);
  installed = false;
  feed(A, crew, [message(A, 'ask', { text: '第二问' })]); await main.pollOnce();
  await until(() => main.snapshot().crews[0].items.find(i => i.text === '第二问')?.status === 'wait');
  assert.equal(calls.length, 2);
  assert.equal(main.snapshot().crews[0].items.find(i => i.text === '第二问').status, 'wait');
});

test('分享中切离线：首个文件结束后停止后续文件，不发布清单并清理密文', async t => {
  const { A, crew } = await pair();
  const source = tmp('offline-share'); fs.writeFileSync(path.join(source, 'a.txt'), 'a'); fs.writeFileSync(path.join(source, 'b.txt'), 'b');
  const oldFeed = fs.readFileSync(path.join(mailbox(A, crew.id), 'feed.bin'));
  const original = seal.sealFile; let calls = 0;
  t.mock.method(seal, 'sealFile', async (...args) => { calls++; await original(...args); A.enable(false); });
  await assert.rejects(A.h['share-send']({ crewId: crew.id, dir: source }), /纯离线/);
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(path.join(mailbox(A, crew.id), 'feed.bin')), oldFeed);
  assert.deepEqual(fs.readdirSync(path.join(mailbox(A, crew.id), 'blobs')), []);
});

test('445 探测失败：轮询、测试成员和取回均不访问对端文件，并执行退避', async t => {
  let online = true, probes = 0;
  const { A, B, crew } = await pair({ probeSmb: async () => { probes++; return online; } });
  const item = message(A, 'share', { share: { id: 'abcdef0012345678', name: '离线分享', size: 301 * 1024 ** 2, files: [{ rel: 'a.txt', size: 0 }] } });
  feed(A, crew, [item]); await B.svc.pollOnce();
  online = false; probes = 0; let remoteFs = 0;
  for (const name of ['stat', 'readFile', 'open', 'readdir']) {
    const original = fs.promises[name];
    t.mock.method(fs.promises, name, (file, ...args) => { if (insideRoot(A.shareDir, String(file))) remoteFs++; return original(file, ...args); });
  }
  await B.svc.pollOnce();
  assert.equal(probes, 1); assert.equal(remoteFs, 0);
  assert.equal(B.svc.snapshot().crews[0].members.find(m => !m.me).online, false);
  await B.svc.pollOnce(); assert.equal(probes, 1, '退避期间不重探测');
  B.advance(17000);
  const result = await B.h['test-member']({ crewId: crew.id, memberId: A.svc._state().me.id });
  assert.equal(result.ok, false); assert.match(result.error, /445/);
  B.advance(33000);
  await assert.rejects(B.h['share-fetch']({ crewId: crew.id, id: item.id }), /445/);
  assert.equal(probes, 3); assert.equal(remoteFs, 0);
});

test('SMB 探测：连接成功、错误和超时都销毁 socket', async t => {
  const net = require('node:net'), { EventEmitter } = require('node:events');
  let socket;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.destroyed = false; }
    connect(port, ip) { assert.equal(port, 445); assert.equal(ip, '10.0.0.1'); }
    destroy() { this.destroyed = true; }
  }
  t.mock.method(net, 'Socket', function () { return new Socket(); });
  const { probeSmb } = require('../core/community-crew/lan-share');
  for (const event of ['connect', 'error']) {
    const pending = probeSmb('10.0.0.1'); socket.emit(event);
    assert.equal(await pending, event === 'connect'); assert.equal(socket.destroyed, true);
  }
  assert.equal(await probeSmb('10.0.0.1', 5), false); assert.equal(socket.destroyed, true);
});

test('名片 IP：可达地址不被虚拟网卡覆盖；断连后确认候选；手工地址始终优先', async () => {
  const { A, B, crew, bCrew } = await pair();
  await A.h['set-me']({ ipOverride: '10.99.99.99' });
  await A.svc.publishAll();
  await B.svc.pollOnce();
  const peer = bCrew.members[0];
  assert.equal(peer.ip, '10.2.1.1'); assert.equal(peer.candidateIp, '10.99.99.99');
  const resolvePeer = B.shareTools.peerBoxDir;
  B.shareTools.peerBoxDir = (ip, share) => ip === '10.99.99.99' ? resolvePeer('10.2.1.1', share) : path.join(testRoot, 'missing-peer');
  await B.svc.pollOnce(); assert.equal(peer.ip, '10.99.99.99');
  for (const field of ['manualIp', 'ipOverride']) {
    peer.ip = '10.2.1.1'; peer[field] = true; B.advance(300001);
    await B.svc.pollOnce(); assert.equal(peer.ip, '10.2.1.1'); delete peer[field];
  }
});

test('分享清单：空项整条丢弃，非法项不移位，显式序号按原始密文读取', async () => {
  const { A, B, crew } = await pair();
  const id = 'aabbccdd00112233', base = { id, name: '原序号', size: 0 };
  const bad = [undefined, null, {}, { ...base, files: [] }, { ...base, files: [null] },
    { ...base, files: [{ rel: '../bad', size: 0 }, { rel: 'ok.txt', size: 0 }] },
    { ...base, files: [{ rel: 'ok.txt', size: 0, n: -1 }] },
    { ...base, files: [{ rel: 'a', size: 0, n: 1 }, { rel: 'b', size: 0, n: 1 }] }];
  feed(A, crew, bad.map(share => message(A, 'share', { share })));
  await B.svc.pollOnce(); assert.equal(B.svc.snapshot().crews[0].items.length, 0);
  const dir = path.join(mailbox(A, crew.id), 'blobs', id); fs.mkdirSync(dir, { recursive: true });
  for (const [n, text] of [[0, '错误内容'], [2, '第二份'], [5, '第五份']]) {
    const source = path.join(tmp('numbered'), 'data'); fs.writeFileSync(source, text);
    await seal.sealFile(crew.key, source, path.join(dir, `${n}.bin`));
  }
  const item = message(A, 'share', { share: { ...base, files: [{ rel: 'five.txt', size: 0, n: 5 }, { rel: 'two.txt', size: 0, n: 2 }] } });
  feed(A, crew, [item]); await B.svc.pollOnce();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.id === item.id)?.local?.state === 'done');
  const received = B.svc.snapshot().crews[0].items.find(i => i.id === item.id);
  assert.deepEqual(received.share.files.map(f => f.n), [5, 2]);
  assert.equal(fs.readFileSync(path.join(received.local.path, 'five.txt'), 'utf8'), '第五份');
  assert.equal(fs.readFileSync(path.join(received.local.path, 'two.txt'), 'utf8'), '第二份');
});

test('邀请码：优先标签、限定字符表，团队名和共享名不被误认', async t => {
  const net = {}, A = machine('码源', '10.7.1.1', net), B = machine('入队', '10.7.1.2', net);
  await A.h['detect-share'](); await B.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: 'ABCDEFGHABCD' });
  const inv = await A.h.invite({ crewId: crew.id });
  const pathFor = B.shareTools.peerBoxDir;
  B.shareTools.peerBoxDir = (ip, share) => pathFor(ip, share === 'ABCDEFGH' ? 'S_码源' : share);
  await B.h.join({ text: inv.message.replace('S_码源', 'ABCDEFGH') });
  assert.equal(B.svc.snapshot().crews[0].id, crew.id);
  let reads = 0;
  const original = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (...args) => { reads++; return original(...args); });
  for (const text of ['团队 ABCDEFGH 地址 \\\\10.7.1.1\\ABCDEFGH', '团队 ABCD-EFGH 地址 \\\\10.7.1.1\\ABCDEFGH', '团队「ABCDEFGHABCD」 地址 \\\\10.7.1.1\\ABCDEFGH',
    '地址 \\\\10.7.1.1\\ABCDEFGH 邀请码 ABCD-EFG0-ABCD', '地址 \\\\10.7.1.1\\ABCDEFGH 邀请码 ABCD-EFGI']) {
    await assert.rejects(B.h.join({ text }), /没认出地址和邀请码/);
  }
  assert.equal(reads, 0);
});

test('模型队列：慢模型不挡轮询，自动回答失败只调用一次并转人工', async () => {
  const gate = deferred(), entered = deferred();
  const { A, B, crew } = await pair({ runModel: () => { entered.resolve(); return gate.promise; } });
  const mat = tmp('queue-material'); fs.writeFileSync(path.join(mat, 'answer.txt'), '可外答资料');
  await B.h['set-settings']({ answerDir: mat });
  const ask = message(A, 'ask', { text: '资料口径？' });
  feed(A, crew, [ask]); await B.svc.pollOnce(); await entered.promise;
  const broadcast = message(A, 'say', { text: '模型还没结束时收到的广播' });
  feed(A, crew, [ask, broadcast]); await B.svc.pollOnce();
  assert.ok(B.svc.snapshot().crews[0].items.some(i => i.id === broadcast.id));
  assert.equal(B.prompts.length, 1);
  gate.resolve('');
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.id === ask.id)?.status === 'wait');
  await turn(); assert.equal(B.prompts.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(B.dataDir, 'community', 'crew', `log-${crew.id}.json`)));
  assert.equal(saved.items.find(i => i.id === ask.id).status, 'wait');
});

test('多团队邀请分别节流，过期分享撤回落盘并发布', async () => {
  const net = {}, A = machine('邀请端', '10.6.1.1', net), B = machine('成员端', '10.6.1.2', net);
  await A.h['detect-share'](); await B.h['detect-share']();
  const crews = [];
  for (const name of ['团队一', '团队二']) {
    await A.h['new-crew']({ name }); const crew = A.svc._state().crews.at(-1); crews.push(crew);
    crew.invites.push({ inviteId: require('node:crypto').randomBytes(16).toString('hex'), ip: '10.6.1.2', share: 'S_成员端', at: Date.now() });
    const dir = path.join(B.shareDir, 'ai-hub-community', 'crews', crew.id, B.svc._state().me.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'card.bin'), seal.sealJson(crew.key, { v: 1, id: B.svc._state().me.id, nick: '成员端' }));
  }
  await A.svc.pollOnce();
  assert.ok(crews.every(c => c.members.some(m => m.id === B.svc._state().me.id)));
  const source = tmp('expire-share'); fs.writeFileSync(path.join(source, 'a.txt'), '快照');
  const sent = await A.h['share-send']({ crewId: crews[0].id, dir: source, days: 1 });
  A.advance(2 * 86400000); await A.svc.pollOnce();
  const saved = JSON.parse(fs.readFileSync(path.join(A.dataDir, 'community', 'crew', `log-${crews[0].id}.json`)));
  assert.equal(saved.items.find(i => i.id === sent.id).expired, true);
  const published = seal.openJson(crews[0].key, fs.readFileSync(path.join(mailbox(A, crews[0].id), 'feed.bin')));
  assert.ok(published.items.some(i => i.type === 'unshare' && i.ref === sent.share.id));
});

test('团队模型：空模型也用 bare、禁用记忆、tools 为空，其他功能参数不变', async t => {
  const runner = require('../core/feature-agent-run'), specs = [];
  t.mock.method(require('../core/codeagent-config'), 'resolveCodeAgentConfig', () => ({ command: 'fake' }));
  const options = { dataDir: tmp('model-args'), env: {}, findCommand: () => 'fake', runOnce: async spec => {
    specs.push(spec);
    return { code: 0, stdout: spec.args.includes('--help') ? '--tools --bare --strict-mcp-config --mcp-config --settings' : '模型回答' };
  } };
  await runner.run({ kind: 'codeagent', model: '' }, '问题', { ...options, crew: true });
  const args = specs.at(-1).args;
  assert.equal(specs.at(-1).env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.ok(args.includes('--bare')); assert.ok(!args.includes('--model'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  await runner.run({ kind: 'codeagent', model: '' }, '其他功能', options);
  assert.ok(!specs.at(-1).args.includes('--bare'));
  assert.equal(specs.at(-1).env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  for (const kind of ['codex', 'deepseek-acp']) await assert.rejects(runner.run({ kind }, '问题', { ...options, crew: true }), /关闭全部工具/);
  const choices = require('../core/feature-agent-choice');
  const backends = ['codeagent', 'claude', 'codex', 'deepseek-acp'].map(kind => ({ kind, available: true, models: [{ id: 'test-model', source: 'gateway' }] }));
  t.mock.method(require('../core/company-api-config'), 'isCompany', () => true);
  for (const kind of ['codex', 'deepseek-acp']) {
    const selected = { kind, model: 'test-model', source: 'gateway' };
    assert.doesNotThrow(() => choices.set(options.dataDir, 'help', selected, { backends }));
    assert.throws(() => choices.set(options.dataDir, 'crew', selected, { backends }), /可用/);
  }
});

test('自动重绘保留焦点、已失焦修改和未提交回信草稿', () => {
  const { hasPendingEdits } = require('../renderer/community-editing');
  const input = { tagName: 'INPUT', value: '', defaultValue: '', dataset: {} };
  const root = { ownerDocument: { activeElement: input }, contains: el => el === input, querySelectorAll: () => [input] };
  assert.equal(hasPendingEdits(root), true);
  root.ownerDocument.activeElement = null; assert.equal(hasPendingEdits(root), false);
  input.value = '未提交的签名'; assert.equal(hasPendingEdits(root), true);
  input.defaultValue = input.value; assert.equal(hasPendingEdits(root), false);
  input.dataset.slot = 'draft'; assert.equal(hasPendingEdits(root), true);
});

// 2026-11-28 用户反馈：建团队后几个人加入了，队长一个都看不到（新成员看得到老成员，反过来看不到）。
// 实际用法是一条邀请发到群里、不填 IP；队长只能靠「谁正连着我的共享」认出入队的人。
test('一条邀请多人加入、不填 IP：队长和老成员都能看到每个新成员', async () => {
  const net = {};
  const joinerIps = ['10.9.1.2', '10.9.1.3', '10.9.1.4'];
  const A = machine('队长', '10.9.1.1', net, { inbound: () => joinerIps });
  const Js = joinerIps.map((ip, i) => machine('队员' + (i + 1), ip, net));
  await A.h['detect-share'](); for (const J of Js) await J.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '一条邀请' });
  const inv = await A.h.invite({ crewId: crew.id }); // 不填名字和 IP，发到群里
  for (const J of Js) await J.h.join({ text: inv.message });
  await A.svc.pollOnce();
  const snapA = A.svc.snapshot().crews[0];
  assert.deepEqual(snapA.members.filter(m => !m.me).map(m => m.nick).sort(), ['队员1', '队员2', '队员3']);
  // 老成员（先入队的队员1）也能经队长的名单看到后来的人
  await Js[0].svc.pollOnce(); await Js[0].svc.pollOnce();
  assert.equal(Js[0].svc.snapshot().crews[0].members.length, 4);
  // 名片读到后在线
  await A.svc.pollOnce();
  assert.ok(A.svc.snapshot().crews[0].members.filter(m => !m.me).every(m => m.online));
});

test('发现入队：别的电脑伪造的目录（解不开名片）不会被当成成员', async () => {
  const net = {};
  const A = machine('队长二', '10.9.2.1', net, { inbound: () => ['10.9.2.9'] });
  const X = machine('路人', '10.9.2.9', net);
  await A.h['detect-share'](); await X.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '防伪造' });
  await A.h.invite({ crewId: crew.id });
  const fake = path.join(X.shareDir, 'ai-hub-community', 'crews', crew.id, 'abcdef0123456789');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'card.bin'), seal.sealJson(seal.newKey(), { v: 1, id: 'abcdef0123456789', nick: '冒充' }));
  await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.length, 1);
});

test('退出：其他人读到退出名片后都把他移出，别人名单里的旧记录不会再拉回来', async () => {
  const net = {}, ips = ['10.9.3.2', '10.9.3.3'];
  const A = machine('队长三', '10.9.3.1', net, { inbound: () => ips });
  const [B, C] = ips.map((ip, i) => machine('成员' + (i + 1), ip, net));
  for (const M of [A, B, C]) await M.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '退出测试' });
  const inv = await A.h.invite({ crewId: crew.id });
  await B.h.join({ text: inv.message }); await C.h.join({ text: inv.message });
  await A.svc.pollOnce();
  for (const M of [B, C]) { await M.svc.pollOnce(); await M.svc.pollOnce(); }
  assert.equal(B.svc.snapshot().crews[0].members.length, 3);
  await C.h.leave({ crewId: crew.id });
  await A.svc.pollOnce(); await B.svc.pollOnce(); await B.svc.pollOnce();
  const cId = C.svc._state().me.id;
  for (const M of [A, B]) assert.ok(!M.svc.snapshot().crews[0].members.some(m => m.id === cId));
  assert.equal(fs.existsSync(path.join(mailbox(C, crew.id), 'feed.bin')), false, '退出后信件删掉，只留退出名片');
});

test('在线：对方电脑时钟慢 10 分钟，名片照常读到仍显示在线', async () => {
  const { A, B } = await pair();
  B.advance(-10 * 60000); await B.svc.publishAll();
  await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.find(m => !m.me).online, true);
});

test('退出不复活：退出前生成的邀请里还有他，后来的人入队也不会把他拉回任何人的名单', async () => {
  const net = {}, ips = ['10.9.4.2', '10.9.4.3', '10.9.4.4'];
  const A = machine('队长四', '10.9.4.1', net, { inbound: () => ips });
  const [B, C, D] = ips.map((ip, i) => machine('员' + (i + 1), ip, net));
  for (const M of [A, B, C, D]) await M.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '不复活' });
  const inv1 = await A.h.invite({ crewId: crew.id });
  await B.h.join({ text: inv1.message }); await C.h.join({ text: inv1.message });
  await A.svc.pollOnce();
  const inv2 = await A.h.invite({ crewId: crew.id }); // 名单里已有 C
  await C.h.leave({ crewId: crew.id });
  for (const M of [A, B, C, D]) M.advance(31000); await A.svc.pollOnce(); await B.svc.pollOnce(); await B.svc.pollOnce();
  delete net['10.9.4.3']; // C 退出后关机：后来的 D 读不到他的退出名片
  await D.h.join({ text: inv2.message });
  for (let k = 0; k < 3; k++) { for (const M of [A, B, C, D]) M.advance(31000); for (const M of [A, B, D]) await M.svc.pollOnce(); }
  const cId = C.svc._state().me.id;
  for (const M of [A, B, D]) assert.ok(!M.svc.snapshot().crews[0].members.some(m => m.id === cId), '已退出的人不应出现在名单里');
  assert.equal(A.svc.snapshot().crews[0].members.length, 3);
});

test('对方有读不了的共享：不退避，接着试后面真正放信箱的共享', async () => {
  const net = {};
  const A = machine('队长五', '10.9.5.1', net, { inbound: () => ['10.9.5.2'] });
  const J = machine('多共享', '10.9.5.2', net);
  await A.h['detect-share'](); await J.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '多共享' });
  const inv = await A.h.invite({ crewId: crew.id });
  await J.h.join({ text: inv.message });
  const bad = tmp('bad-share'); fs.mkdirSync(path.join(bad, 'ai-hub-community', 'crews'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'ai-hub-community', 'crews', crew.id), '不是目录');
  const peerBoxDir = A.shareTools.peerBoxDir;
  A.shareTools.peerBoxDir = (ip, share) => (share === 'Users' ? path.join(bad, 'ai-hub-community') : peerBoxDir(ip, share));
  A.shareTools.powershell = async () => 'Users   Disk\r\nS_多共享   Disk\r\n';
  await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.length, 2);
});

test('老成员换了 IP：队长按入站连接认出同一个人并更新地址', async () => {
  const net = {}; let inbound = ['10.9.6.2'];
  const A = machine('队长六', '10.9.6.1', net, { inbound: () => inbound });
  const B = machine('换网', '10.9.6.2', net);
  await A.h['detect-share'](); await B.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '换 IP' });
  await B.h.join({ text: (await A.h.invite({ crewId: crew.id })).message });
  await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.find(m => !m.me).ip, '10.9.6.2');
  net['10.9.6.22'] = net['10.9.6.2']; delete net['10.9.6.2']; inbound = ['10.9.6.22'];
  A.advance(31000); await A.svc.pollOnce();
  const b = A.svc.snapshot().crews[0].members.find(m => !m.me);
  assert.equal(A.svc.snapshot().crews[0].members.length, 2);
  assert.equal(b.ip, '10.9.6.22');
});

test('退出后重新入队：即使队友电脑时钟快 10 分钟，也不会被别人的退出记录再踢出去', async () => {
  const net = {}, ips = ['10.9.7.2', '10.9.7.3'];
  const A = machine('队长七', '10.9.7.1', net, { inbound: () => ips });
  const [B, C] = ips.map((ip, i) => machine('七' + (i + 1), ip, net));
  for (const M of [A, B, C]) await M.h['detect-share']();
  B.advance(10 * 60000); // B 的时钟快 10 分钟
  const { crew } = await A.h['new-crew']({ name: '重入队' });
  const inv = await A.h.invite({ crewId: crew.id });
  await B.h.join({ text: inv.message }); await C.h.join({ text: inv.message });
  const step = async () => { for (const M of [A, B, C]) M.advance(31000); for (const M of [A, B, C]) await M.svc.pollOnce(); };
  await step(); await step();
  await C.h.leave({ crewId: crew.id });
  await step(); await step();
  const cId = C.svc._state().me.id;
  assert.ok(!B.svc.snapshot().crews[0].members.some(m => m.id === cId));
  await C.h.join({ text: inv.message });
  for (let k = 0; k < 4; k++) await step();
  for (const M of [A, B]) assert.ok(M.svc.snapshot().crews[0].members.some(m => m.id === cId), '重新入队后应能看到');
});

test('入站发现：入队者信箱还没写好时先扑空，30 秒后再试就能找到，不被长时间冷却挡住', async () => {
  const net = {};
  const A = machine('队长八', '10.9.8.1', net, { inbound: () => ['10.9.8.2'] });
  const J = machine('晚到', '10.9.8.2', net);
  await A.h['detect-share'](); await J.h['detect-share']();
  const { crew } = await A.h['new-crew']({ name: '扑空重试' });
  const inv = await A.h.invite({ crewId: crew.id });
  await A.svc.pollOnce(); // 这时对方还没入队：扑空
  await J.h.join({ text: inv.message });
  A.advance(31000); await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.length, 2);
});

// 蒸馏自己（2026-11-28）：团队代答接入本人口吻。关着时与原来逐字一致；开着带口吻、标「桌宠代答」；出口失败即关（审查修复）。
test('蒸馏自己·团队代答：关时提示逐字一致；开时带口吻；口吻版被拦退回通用回答且通用回答也要过闸；都不合格转本人', async () => {
  const question = 'SRS 周期多少？';
  async function askOnce(options) {
    const { A, B, crew } = await pair(options);
    const mat = tmp('sd-mat'); fs.writeFileSync(path.join(mat, '口径.md'), 'SRS 周期：现网 20/40/80 ms');
    await B.h['set-settings']({ answerDir: mat });
    await A.h.ask({ crewId: crew.id, to: B.svc._state().me.id, text: question });
    await B.svc.pollOnce();
    const got = () => B.svc.snapshot().crews[0].items.find(i => i.type === 'ask' && i.text === question);
    await until(() => ['auto', 'wait'].includes(got()?.status) && (got().status === 'wait' || got().reply));
    // 读接收端自己记下的回信（发出去的就是这段），不依赖发送端轮询的时机。
    return { B, crew, status: got().status, answer: got().reply?.text, item: got() };
  }
  const style = { toneText: '消息一半不超过 6 字；先给判断再说理由', examples: ['看情况吧', '我瞅瞅'] };
  const runModel = p => (p.includes('【说话口吻】') ? '就 20/40/80' : '现网 20/40/80 ms，出处：口径.md');
  const base = await askOnce({ runModel });
  const off = await askOnce({ runModel, selfStyle: () => null, selfGuard: () => { throw new Error('关着不该过闸'); } });
  assert.deepEqual(off.B.prompts, base.B.prompts, '关着时提示与原来逐字一致');
  assert.equal(off.answer, base.answer);
  assert.ok(!base.B.prompts[0].includes('口吻'));

  const guarded = [];
  const on = await askOnce({ runModel, selfStyle: () => style, selfGuard: async t => { guarded.push(t); return { ok: true }; } });
  assert.equal(on.B.prompts.length, 1);
  assert.match(on.B.prompts[0], /【说话口吻】[\s\S]*先给判断再说理由[\s\S]*看情况吧/);
  assert.deepEqual(guarded, ['就 20/40/80']);
  assert.equal(on.answer, '【桌宠代答】就 20/40/80');

  // 口吻版被拦 → 通用回答也过闸，过了才发（同样标识）
  const seen = [];
  const fallback = await askOnce({ runModel, selfStyle: () => style, selfGuard: t => { seen.push(t); return { ok: !t.startsWith('就') }; } });
  assert.equal(fallback.B.prompts.length, 2, '拦下后再问一次通用回答');
  assert.equal(fallback.B.prompts[1], base.B.prompts[0], '退回的就是原来的通用提示');
  assert.deepEqual(seen, ['就 20/40/80', base.answer], '通用回答同样过闸');
  assert.equal(fallback.answer, '【桌宠代答】' + base.answer);

  // 两次都不合格 / 检查器不可用 / 检查器出错 → 不发，转本人
  for (const selfGuard of [() => ({ ok: false, hit: 'verbatim' }), () => ({ ok: false, hit: 'unavailable' }), () => { throw new Error('坏了'); }]) {
    const r = await askOnce({ runModel, selfStyle: () => style, selfGuard });
    assert.equal(r.status, 'wait');
    assert.equal(r.answer, undefined, '没有发出任何回信');
    assert.ok(r.B.notices.some(n => /等你确认/.test(n.title)));
  }
});

test('蒸馏自己·确认发送：用本人口吻代写、没改就发的草稿过出口检查，不合格不发；本人改过的照发', async () => {
  const style = { toneText: '先给判断再说理由', examples: [] };
  let pass = false;
  const { A, B, crew } = await pair({ runModel: () => '草稿：看情况（待补充）', selfStyle: () => style, selfGuard: async () => ({ ok: pass }) });
  await A.h.ask({ crewId: crew.id, to: B.svc._state().me.id, text: '帮我看下这周进展？' });
  await B.svc.pollOnce();
  const got = () => B.svc.snapshot().crews[0].items.find(i => i.type === 'ask' && i.text === '帮我看下这周进展？');
  await until(() => got()?.draft);
  assert.equal(got().draftStyled, true);
  await assert.rejects(B.h['answer-draft']({ crewId: crew.id, id: got().id }), /没有发出/);
  assert.equal(got().reply, undefined);
  await B.h['answer-draft']({ crewId: crew.id, id: got().id, text: '我自己改过的回复' });
  assert.equal(got().reply.text, '我自己改过的回复');
  pass = true;
});

test('对桌宠说：口语提问也认得出（你去问下、麻烦帮我问问），只有一位成员时不用选人', () => {
  const one = [{ id: 'aaaaaaaa11111111', nick: '小猫·2A05' }];
  const two = one.concat([{ id: 'bbbbbbbb22222222', nick: '老王' }]);
  for (const text of ['你去问下 今天周几？', '麻烦帮我问问今天周几', '替我问一下：今天周几', '去问今天周几', '问下今天周几']) {
    const r = parseCommand(text, one);
    assert.equal(r.kind, 'ask', text); assert.equal(r.to, one[0].id, text); assert.match(r.text, /^今天周几/, text);
  }
  assert.equal(parseCommand('你去问下 今天周几？', two).to, '', '两位以上没点名时让用户选');
  assert.equal(parseCommand('问下老王 SRS 周期多少？', two).to, two[1].id);
  assert.equal(parseCommand('老王，SRS 周期现网多少？', two).kind, 'ask', '点名加问号也算提问');
  assert.equal(parseCommand('问题已经定位了，明早合入', two).kind, 'say');
  assert.equal(parseCommand('告诉大家 谁能问下老王？', two).kind, 'say');
  assert.equal(parseCommand('今晚挂仿真', two).kind, 'say');
});

test('回执：对方收到公告、提问处理到哪一步、agent 正在起草，提问方都看得到', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const { A, B, crew } = await pair({ runModel: async () => { await gate; return '草稿：周六'; } });
  await A.h.say({ crewId: crew.id, text: '今晚挂仿真' });
  let say = A.svc.snapshot().crews[0].items.find(i => i.type === 'say');
  assert.deepEqual(say.delivery, { total: 1, read: 0 }, '对方没读前显示未收到');
  await B.svc.pollOnce(); await A.svc.pollOnce();
  say = A.svc.snapshot().crews[0].items.find(i => i.type === 'say');
  assert.equal(say.delivery.read, 1, '对方读到后显示已收到');
  const bId = B.svc._state().me.id;
  await A.h.ask({ crewId: crew.id, to: bId, text: '今天周几？' });
  await B.svc.pollOnce();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.type === 'ask')?.status === 'wait');
  await A.svc.pollOnce();
  let ask = A.svc.snapshot().crews[0].items.find(i => i.type === 'ask');
  assert.equal(ask.delivery.step, 'drafting', '对方 agent 起草中');
  assert.equal(A.svc.snapshot().crews[0].members.find(m => m.id === bId).agent.state, 'drafting');
  release();
  await until(() => B.svc.snapshot().crews[0].items.find(i => i.type === 'ask')?.draft);
  await turn(); await B.svc.publishAll(); await A.svc.pollOnce();
  ask = A.svc.snapshot().crews[0].items.find(i => i.type === 'ask');
  assert.equal(ask.delivery.step, 'wait', '起草完，等对方确认');
  assert.ok(A.svc.snapshot().crews[0].members.find(m => m.id === bId).ver !== undefined);
});

test('对桌宠说：不吞问句首字、句中提到同事不当私信、只喊名字不寄空问题', () => {
  const one = [{ id: 'aaaaaaaa11111111', nick: '小猫·2A05' }];
  const two = one.concat([{ id: 'bbbbbbbb22222222', nick: '老王' }]);
  assert.equal(parseCommand('问下老王，他的分支合了吗？', two).text, '他的分支合了吗？');
  assert.equal(parseCommand('老王，他的参数发出来了吗？', two).text, '他的参数发出来了吗？');
  assert.equal(parseCommand('你去问下，他们今天开会吗？', one).text, '他们今天开会吗？');
  assert.equal(parseCommand('你去问下 一下子跑多少种子？', one).text, '一下子跑多少种子？');
  assert.equal(parseCommand('你去问他一下，今天周几？', one).text, '今天周几？');
  const mid = parseCommand('今晚谁跟老王一起值班？', two);
  assert.equal(mid.kind, 'say', '句中提到同事不当私信');
  const q2 = parseCommand('问下 今天谁跟老王值班', two);
  assert.equal(q2.to, ''); assert.equal(q2.text, '今天谁跟老王值班');
  assert.equal(parseCommand('你去问下老王', two).text, '', '只喊名字不寄');
  assert.equal(parseCommand('@老王 SRS 周期多少？', two).to, two[1].id);
  for (const t of ['请你去问下 今天周几？', '你去帮我问下 今天周几？', '你帮我去问下 今天周几？']) assert.equal(parseCommand(t, one).kind, 'ask', t);
  for (const t of ['问卷大家今天填一下', '问答库更新了']) assert.equal(parseCommand(t, two).kind, 'say', t);
  assert.equal(parseCommand('问下 今天周几', [{ id: 'cccccccc33333333', nick: '我', me: true }].concat(one)).to, one[0].id, '列表里含本人也不算');
});

test('回执不乒乓：两边只是互读名片时，不会每轮都重写自己的名片', async () => {
  const { A, B, crew } = await pair();
  await A.svc.pollOnce(); await B.svc.pollOnce(); await A.svc.pollOnce();
  const card = f => fs.statSync(path.join(mailbox(f, crew.id), 'card.bin')).mtimeMs;
  const a0 = card(A), b0 = card(B);
  await new Promise(r => setTimeout(r, 30));
  for (let k = 0; k < 3; k++) { await A.svc.pollOnce(); await B.svc.pollOnce(); }
  assert.equal(card(A), a0); assert.equal(card(B), b0);
});

test('对方起草中关机：提问方不会一直显示「正在起草」', async () => {
  const gate = deferred(), entered = deferred();
  const { A, B, crew } = await pair({ runModel: () => { entered.resolve(); return gate.promise; } });
  const bId = B.svc._state().me.id;
  await A.h.ask({ crewId: crew.id, to: bId, text: '今天周几？' });
  const p = B.svc.pollOnce(); await entered.promise; await p;
  await A.svc.pollOnce();
  assert.equal(A.svc.snapshot().crews[0].members.find(m => m.id === bId).agent.state, 'drafting');
  A.advance(6 * 60000); // B 关机：名片不再更新
  assert.equal(A.svc.snapshot().crews[0].members.find(m => m.id === bId).agent.state, 'idle');
  assert.notEqual(A.svc.snapshot().crews[0].items.find(i => i.type === 'ask').delivery.step, 'drafting');
  gate.resolve('');
});

test('版本：成员页能看到自己和对方的 AI HUB 版本号', async () => {
  const { A, B } = await pair();
  await A.svc.pollOnce();
  const ver = require('../package.json').version;
  const ms = A.svc.snapshot().crews[0].members;
  assert.equal(ms.find(m => m.me).ver, ver);
  assert.equal(ms.find(m => !m.me).ver, ver);
  void B;
});
