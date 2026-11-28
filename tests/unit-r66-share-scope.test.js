'use strict';
// R66-5（2026-11-28 同事反馈看到提示后先把 Everyone 分享禁掉了）：社区·我的团队「一键新建共享」不再给 Everyone，
// 只给已登录的用户（S-1-5-11）；团队设置页显示信箱所在共享现在给了谁。全部为合成数据，不动本机共享。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const L = require('../core/community-crew/lan-share');
const { createCrewService } = require('../core/community-crew/service');

// 假 PowerShell：记下脚本，按给定输出退出。
function fakeSpawn(stdout, calls) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    calls.push(Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le'));
    setImmediate(() => { child.stdout.end(stdout); child.stderr.end(); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
}

test('一键新建共享：目录与共享都只授权「已登录的用户」S-1-5-11，不再授权 Everyone S-1-1-0', async () => {
  const calls = [];
  const made = await L.createShare({ dir: 'D:\\AIHubCommunity', spawnImpl: fakeSpawn('0', calls) });
  assert.equal(made.name, L.NEW_SHARE_NAME);
  const outer = calls[0];
  const inner = Buffer.from(outer.match(/'-EncodedCommand','([^']+)'/)[1], 'base64').toString('utf16le');
  assert.match(inner, /S-1-5-11/);
  assert.match(inner, /icacls \$p \/grant '\*S-1-5-11:\(OI\)\(CI\)RX'/);
  assert.match(inner, /New-SmbShare .* -ReadAccess \$readers/);
  assert.doesNotMatch(inner, /S-1-1-0/);
  assert.equal(L.READER_SID, 'S-1-5-11');
});

test('共享权限归档：Everyone / 匿名 / 来宾 = 所有人；已登录用户、域用户 = 已登录的同事；其余 = 指定的人', () => {
  assert.equal(L.shareScope([{ sid: 'S-1-1-0', account: 'Everyone' }]).level, 'everyone');
  assert.equal(L.shareScope([{ sid: 'S-1-5-11', account: 'NT AUTHORITY\\Authenticated Users' }, { sid: 'S-1-5-32-546', account: 'BUILTIN\\Guests' }]).level, 'everyone');
  assert.equal(L.shareScope([{ sid: 'S-1-1-0', account: 'Everyone', allow: false }, { sid: 'S-1-5-11', account: 'x' }]).level, 'signed-in', '拒绝项不算放开');
  assert.equal(L.shareScope([{ sid: 'S-1-5-21-111-222-333-513', account: 'CORP\\Domain Users' }]).level, 'signed-in');
  const limited = L.shareScope([{ sid: 'S-1-5-21-111-222-333-1001', account: String.raw`CORP\z00123` }]);
  assert.equal(limited.level, 'limited'); assert.equal(limited.label, '只给了：z00123');
  assert.equal(L.shareScope([]).level, 'unknown');
});

test('查共享权限：只读 Get-SmbShareAccess，按 SID 归档（中文 Windows 组名本地化也不影响）', async () => {
  const calls = [];
  const out = JSON.stringify([{ sid: 'S-1-1-0', account: '所有人', allow: true, right: 2 }]);
  const entries = await L.shareAccess("工作 'X'", { spawnImpl: fakeSpawn(out, calls) });
  assert.match(calls[0], /Get-SmbShareAccess -Name '工作 ''X'''/);
  assert.doesNotMatch(calls[0], /Grant|Revoke|Set-Smb|New-Smb|icacls/);
  assert.deepEqual(entries, [{ sid: 'S-1-1-0', account: '所有人', allow: true, right: 2 }]);
  assert.equal(L.shareScope(entries).level, 'everyone');
});

test('团队快照带上信箱所在共享的范围：先显示查询中，查到后通知界面重画；已有共享不改', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r66-share-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shareDir = path.join(root, 'share'); fs.mkdirSync(shareDir);
  const events = [], asked = [];
  const shareTools = { ...L,
    listShares: async () => [{ name: 'Work', path: shareDir }],
    createShare: async () => { throw new Error('不该被调用'); },
    shareAccess: async name => { asked.push(name); return [{ sid: 'S-1-1-0', account: 'Everyone', allow: true, right: 2 }]; },
  };
  const svc = createCrewService({ dataDir: path.join(root, 'data'), isEnabled: () => true, profile: () => ({ nick: '甲' }), shareTools, ipCandidates: () => ['10.0.0.1'],
    emit: (type, data) => events.push({ type, data }), timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} }, logger: { warn() {} } });
  const r = await svc.handlers['detect-share']({});
  assert.equal(r.ok, true);
  assert.equal(svc.handlers.snapshot().shareScope, null);
  for (let i = 0; i < 10; i += 1) await new Promise(res => setImmediate(res));
  assert.deepEqual(asked, ['Work']);
  assert.ok(events.some(e => e.type === 'update'));
  assert.equal(svc.handlers.snapshot().shareScope.level, 'everyone');
  svc.handlers.snapshot();
  assert.equal(asked.length, 1, '10 分钟内不重复查');
});

test('团队设置页：所有人能打开时标红并说明怎么收窄；其他范围照实显示', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'community-crew.js'), 'utf8');
  assert.match(src, /function shareScopeLine\(snap\)/);
  assert.match(src, /\$\{shareScopeLine\(snap\)\}/);
  assert.match(src, /sc\.level === 'everyone'/);
});
