'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PhoneChannel, normalizeExtraIds, validateExtraIds, isOwnAccount } = require('../core/company-assistant/phone');
const { CompanyAssistant } = require('../core/company-assistant/service');

function fixture(extraIds, uid = 'old001') {
  const now = Date.now(), files = {}, asked = [], commands = [];
  let messages = [], members = [];
  const a = { now: () => now, snapshot: () => ({ login: { ok: true, uid } }),
    settings: () => ({ phone: { enabled: true, groupId: '123', since: now - 10000, ...(extraIds === undefined ? {} : { extraIds }) } }),
    read: (name, fallback) => files[name] ?? fallback, write: (name, value) => { files[name] = value; }, changed() {},
    ask: text => { asked.push(text); return { id: String(asked.length) }; },
    welink: async args => {
      commands.push(args);
      assert.equal(args[0], 'im', 'fixture must never login or change identity');
      assert.ok(['query-history-message', 'query-group-member'].includes(args[1]), 'no outgoing messages');
      return { code: 0, stdout: JSON.stringify(args[1] === 'query-group-member' ? members : { chatInfo: messages }), stderr: '' };
    } };
  const phone = new PhoneChannel(a, { noTimer: true });
  return { phone, asked, files, commands, a,
    messages: senders => { messages = senders.map((sender, i) => ({ msgId: String(i + 1), sender, content: 'question-' + i, contentType: 'TEXT', serverSendTime: now })); },
    members: value => { members = value; } };
}

test('extra IDs normalize lines/commas, trim, remove blanks and duplicates, preserve spelling', () => {
  assert.deepEqual(normalizeExtraIds(' m00123, m00123\r\n\n M00123，00123 , 123 '), ['m00123', 'M00123', '00123', '123']);
  assert.deepEqual(normalizeExtraIds([' a ', '', ' ', 'a', null, 123, 'A']), ['a', 'A']);
  assert.deepEqual(normalizeExtraIds(null), []);
});

test('shared matcher preserves exact matching for legacy non-employee IDs', () => {
  assert.equal(isOwnAccount(' old001 ', ' old001\n'), true);
  assert.equal(isOwnAccount('\tnew001 ', 'old001', [' new001 ']), true);
  for (const sender of ['NEW001', '001', 'new1', '', ' ']) assert.equal(isOwnAccount(sender, 'old001', ['new001', '']), false);
});

test('extra ID validation only accepts eight digits, preserves zeros and removes empty/duplicate entries', () => {
  assert.deepEqual(validateExtraIds(' 00123456, 00123456\r\n00876543，00000001, , '),
    ['00123456', '00876543', '00000001']);
  assert.deepEqual(validateExtraIds([' 00123456 ', '', ' ', '00123456']), ['00123456']);
  for (const empty of ['', ' ,\r\n， ', [], null, undefined]) assert.deepEqual(validateExtraIds(empty), []);
});

test('extra ID validation allows at most five distinct nonempty employee IDs', () => {
  const five = ['00000001', '00000002', '00000003', '00000004', '00000005'];
  assert.deepEqual(validateExtraIds(five), five);
  assert.deepEqual(validateExtraIds(` ${five.join(',')} , 00000001\n , `), five);
  for (const six of [[...five, '00000006'], [...five, '00000006'].join('\n')])
    assert.throws(() => validateExtraIds(six), { message: '额外账号最多填写 5 个' });
});

test('extra ID validation rejects malformed IDs and reports invalid entries instead of dropping them', () => {
  for (const invalid of ['z00123456', 'Z00123456', 'm00876543', '123456', '0012345', '000123456', 'zz00123456', 'z0012 3456', 'z-00123456',
    'z00123456@example.com', '工00123456', '００１２３４５６', 'z00123456;00123456', '0012\t3456', '<b>00123456</b>']) {
    assert.throws(() => validateExtraIds(`00876543,${invalid}`), e => e.message.includes(invalid) && /8 位数字/.test(e.message));
  }
  assert.throws(() => validateExtraIds('bad,wrong'), /「bad」、「wrong」/);
  for (const invalid of [123456, {}, ['00123456', 123456]]) assert.throws(() => validateExtraIds(invalid), /额外账号/);
});

test('numeric manual IDs and legacy prefixed IDs match sender variants without broadening automatic identity', () => {
  for (const saved of ['00123456', 'z00123456', 'Z00123456']) {
    for (const sender of ['00123456', 'z00123456', 'Z00123456', 'm00123456'])
      assert.equal(isOwnAccount(` ${sender}\n`, 'm00876543', [` ${saved} `]), true, `${saved} -> ${sender}`);
    for (const sender of ['00123457', '123456', 'z123456', '000123456', 'zz00123456', '', ' '])
      assert.equal(isOwnAccount(sender, 'm00876543', [saved]), false, sender);
    assert.equal(isOwnAccount('m00876543', 'm00876543', [saved]), true);
  }
  assert.equal(isOwnAccount('00123456', 'z00123456', []), false, 'empty manual list keeps old behavior');
  assert.equal(isOwnAccount('Z00123456', 'z00123456', []), false);
  assert.equal(isOwnAccount(' z00123456 ', ' z00123456 ', []), true);
});

test('previously saved prefixed IDs are retained but must be corrected before saving the phone page', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-eight-digit-upgrade-'));
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null });
  t.after(() => { a.digest.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.write('settings.json', { enabled: false, phone: { enabled: false, extraIds: ['z00123456'] } });
  const before = fs.readFileSync(a.file('settings.json'), 'utf8');
  assert.deepEqual(a.settings().phone.extraIds, ['z00123456']);
  assert.equal(isOwnAccount('z00123456', 'other', a.settings().phone.extraIds), true);
  await assert.rejects(a.setPhone({ extraIds: ['z00123456'] }), /不要带字母/);
  assert.equal(fs.readFileSync(a.file('settings.json'), 'utf8'), before);
  const saved = await a.setPhone({ extraIds: ['00123456'] });
  assert.equal(saved.ok, true);
  assert.deepEqual(a.settings().phone.extraIds, ['00123456']);
});

test('poll and group check both accept the same manual ID variants and reject other digit sequences', async () => {
  for (const extraIds of [['00123456'], ['z00123456']]) {
    const f = fixture(extraIds, ' m00876543 ');
    const senders = ['z00123456 ', '00123456', 'Z00123456', ' m00876543', '00123457'];
    f.messages(senders); await f.phone.poll();
    assert.deepEqual(f.asked, ['question-0', 'question-1', 'question-2', 'question-3']);
    f.members(senders.map((account, i) => ({ account, name: i === 4 ? 'Other person' : 'Own account' })));
    const checked = await f.phone.checkGroup();
    assert.match(checked.note, /Other person/);
    assert.doesNotMatch(checked.note, /Own account/);
    assert.equal(await f.phone.me(), ' m00876543 ');
    assert.equal(f.phone.state().me, '', 'real UID/cache are not rewritten');
  }
});

for (const extraIds of [undefined, []]) test(`legacy/empty list keeps automatic UID and rejects other accounts (${JSON.stringify(extraIds)})`, async () => {
  const f = fixture(extraIds); f.messages(['old001', 'new001']); await f.phone.poll();
  assert.deepEqual(f.asked, ['question-0']);
  const rejected = f.phone.state().log.find(x => x.kind === 'other');
  assert.equal(rejected.text, 'question-1（new001 发的，你的账号是 old001）如果这是你本人，可在手机设置里添加该账号。');
});

test('poll accepts extra IDs and automatic UID; trims sender and UID; preserves deduplication', async () => {
  const f = fixture(['new001', ' new001 ', ''], ' old001 ');
  f.messages(['new001 ', ' old001', 'NEW001', '001']); await f.phone.poll();
  assert.deepEqual(f.asked, ['question-0', 'question-1']);
  await f.phone.poll(); assert.equal(f.asked.length, 2);
  assert.equal(await f.phone.me(), ' old001 ', 'matching must not rewrite the actual UID');
  assert.equal(f.phone.state().me, '', 'no identity cache was written');
});

test('poll still excludes old messages and Hub echoes for extra accounts', async () => {
  const f = fixture(['new001']);
  f.a.welink = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ chatInfo: [
    { msgId: '1', sender: 'new001', content: 'old', serverSendTime: Date.now() - 180000 },
    { msgId: '2', sender: 'new001', content: '【助理】echo', serverSendTime: Date.now() },
  ] }) });
  await f.phone.poll(); assert.deepEqual(f.asked, []);
});

test('group member classification uses the same trimmed automatic and extra identities as poll', async () => {
  const f = fixture(['new001']);
  f.members([{ account: ' new001 ', name: 'New owner' }, { account: 'old001 ', name: 'Old owner' }, { account: 'bot', name: 'Bot' }]);
  const result = await f.phone.checkGroup();
  assert.equal(result.count, 3, 'physical group size must not change');
  assert.match(result.note, /（Bot）/);
  assert.doesNotMatch(result.note, /New owner|Old owner/);
  const empty = fixture([]);
  empty.members([{ account: 'new001', name: 'Other' }, { account: 'bot', name: 'Bot' }]);
  assert.match((await empty.phone.checkGroup()).note, /Other/);
});

test('settings persist normalized extra IDs across recreation, preserve other settings and allow clearing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-extra-ids-'));
  const make = () => new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null });
  const a = make();
  t.after(() => { a.digest.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.write('phone.json', { me: 'old001', meAt: 123 });
  const before = fs.readFileSync(a.file('phone.json'), 'utf8');
  const saved = await a.setPhone({ extraIds: ' 00123456, 00123456\n , 00876543\n00000001 ', pushStuck: false });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.phone.settings.extraIds, ['00123456', '00876543', '00000001']);
  const b = make(); t.after(() => b.digest.close());
  assert.deepEqual(b.phone.settings().extraIds, ['00123456', '00876543', '00000001']);
  b.setSettings({ phone: { pushWatched: false } });
  assert.deepEqual(b.phone.settings().extraIds, ['00123456', '00876543', '00000001']);
  assert.equal(b.phone.settings().pushStuck, false);
  assert.equal(fs.readFileSync(a.file('phone.json'), 'utf8'), before);
  b.setSettings({ phone: { extraIds: [' ', '', '00123456', ' 00123456'] } });
  assert.deepEqual(b.phone.settings().extraIds, ['00123456']);
  b.setSettings({ phone: { extraIds: '' } }); assert.deepEqual(b.phone.settings().extraIds, []);
});

test('invalid settings leave disk and identity untouched and never send a welcome message', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-id-validation-'));
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, resolveCli: () => null });
  t.after(() => { a.digest.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.setSettings({ phone: { extraIds: ['00123456'], pushStuck: false } });
  a.write('phone.json', { me: 'z00876543', meAt: 123 });
  const settingsBefore = fs.readFileSync(a.file('settings.json'), 'utf8');
  const identityBefore = fs.readFileSync(a.file('phone.json'), 'utf8');
  let sent = 0;
  a.phone.send = async () => { sent++; return true; };
  for (const patch of [
    { extraIds: '00123456,bad', pushStuck: true },
    { enabled: true, groupId: '123', extraIds: '00123456,bad' },
  ]) {
    await assert.rejects(a.setPhone(patch), /「bad」/);
    assert.equal(fs.readFileSync(a.file('settings.json'), 'utf8'), settingsBefore);
    assert.equal(fs.readFileSync(a.file('phone.json'), 'utf8'), identityBefore);
  }
  for (const extraIds of ['z00123456', 'Z00123456', 'm00123456']) {
    await assert.rejects(a.setPhone({ enabled: true, groupId: '123', extraIds }), /不要带字母/);
    assert.equal(fs.readFileSync(a.file('settings.json'), 'utf8'), settingsBefore);
    assert.equal(fs.readFileSync(a.file('phone.json'), 'utf8'), identityBefore);
  }
  assert.throws(() => a.setSettings({ enabled: true, phone: { extraIds: ['bad'] } }), /「bad」/);
  assert.equal(fs.readFileSync(a.file('settings.json'), 'utf8'), settingsBefore);
  assert.equal(sent, 0);
  const saved = await a.setPhone({ extraIds: ['00123456'], enabled: true, groupId: '123' });
  assert.equal(saved.ok, true, 'a rejected save does not block the next valid save');
  assert.equal(sent, 1);
  assert.equal(a.phone.state().me, 'z00876543');
  assert.equal(a.phone.state().meAt, 123);
});
