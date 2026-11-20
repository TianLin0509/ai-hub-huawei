'use strict';
// 一键反馈改走 WeLink（2026-11-21）：一键发送（welink-cli 私聊维护人）、复制并打开 WeLink、精简正文、找 WeLink 客户端。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubFeedbackService } = require('../main/hub-feedback-service');
const FW = require('../core/hub-feedback-welink');
const W = require('../core/company-assistant/welink');

function fixture(t, { welink, edition = 'member' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'main.log'), ['启动完成', 'Error: spawn codex ENOENT token=abcdefghijk', '正常一行', 'CodeAgent 回答失败：超时'].join('\n'));
  let intranetCalls = 0;
  const svc = createHubFeedbackService({
    edition, endpoint: 'https://me.example.invalid/x', info: () => ({ version: '5.6.70', edition: '测试·成员版', platform: 'win32 10' }),
    logsDir: logs, downloadsDir: () => path.join(root, 'downloads'), logger: { warn() {} },
    fetchImpl: async () => { throw new Error('不该走阿里云'); },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'] }) },
    intranetFetch: async () => { intranetCalls++; throw new Error('不该走内网收件机'); },
    welink,
  });
  return { root, svc, intranetCalls: () => intranetCalls };
}
function fakeWelink({ cli = true, receipt = { code: 0 }, exitCode = 0 } = {}) {
  const calls = { run: [], clip: [], open: 0 };
  return { calls, w: { to: FW.MAINTAINER_WELINK, hasCli: () => cli, parseJson: W.parseJson,
    run: async (args, opts) => { calls.run.push({ args, opts }); W.checkArgs(args, { sendUser: opts.sendUser }); return { code: exitCode, stdout: JSON.stringify(receipt), stderr: exitCode ? 'not logged in' : '' }; },
    writeClipboard: async text => { calls.clip.push(text); return { ok: true }; },
    openDesktop: async () => { calls.open++; return { ok: true, via: 'protocol' }; } } };
}

test('member edition reports WeLink mode with the maintainer account and whether welink-cli exists', async t => {
  const { w } = fakeWelink({ cli: false });
  const f = fixture(t, { welink: w });
  assert.deepEqual(await f.svc.welinkState(), { ok: true, enabled: true, to: 'l00807938', cli: false });
  const plain = fixture(t, {});
  assert.equal((await plain.svc.welinkState()).enabled, false, '没配 welink（主仓库）保持旧行为');
});

test('one-click send DMs the maintainer through welink-cli with a redacted compact text, never touching the intranet receiver', async t => {
  const fk = fakeWelink();
  const f = fixture(t, { welink: fk.w });
  const r = await f.svc.sendWelink({ description: '会话卡片不显示回答', contact: '张三' });
  assert.equal(r.ok, true);
  assert.equal(fk.calls.run.length, 1);
  const { args, opts } = fk.calls.run[0];
  assert.deepEqual(args.slice(0, 4), ['im', 'send-to-user', '--receiver', 'l00807938']);
  assert.equal(opts.sendUser, 'l00807938', '白名单只放行这个收信账号');
  const text = args[5];
  assert.match(text, /会话卡片不显示回答/);
  assert.match(text, /5\.6\.70/);
  assert.match(text, /spawn codex ENOENT/);
  assert.doesNotMatch(text, /abcdefghijk/, '日志里的令牌已脱敏');
  assert.ok(text.length <= FW.MAX_CHARS);
  assert.ok(fs.existsSync(r.savedTo), '完整诊断包仍存到下载');
  assert.equal(f.intranetCalls(), 0);
  const mine = f.svc.mine();
  assert.equal(mine.items[0].status, 'delivered');
  assert.equal(mine.items[0].via, 'welink');
});

test('send failure (not logged in / business error / no cli) returns a reason and the compact text for the copy fallback', async t => {
  const a = fixture(t, { welink: fakeWelink({ exitCode: 1 }).w });
  const r1 = await a.svc.sendWelink({ description: 'x' });
  assert.equal(r1.ok, false); assert.match(r1.reason, /not logged in/); assert.ok(r1.text);
  const b = fixture(t, { welink: fakeWelink({ receipt: { code: 4001, message: '账号不存在' } }).w });
  const r2 = await b.svc.sendWelink({ description: 'x' });
  assert.equal(r2.ok, false); assert.match(r2.reason, /账号不存在/);
  const c = fixture(t, { welink: fakeWelink({ cli: false }).w });
  const r3 = await c.svc.sendWelink({ description: 'x' });
  assert.equal(r3.noCli, true);
  assert.equal((await c.svc.sendWelink({ description: '  ' })).ok, false, '空描述不发');
});

test('long descriptions are split into numbered parts within the chunk size', async t => {
  const fk = fakeWelink();
  const f = fixture(t, { welink: fk.w });
  const desc = Array.from({ length: 60 }, (_, i) => `第 ${i} 行：` + '现象描述'.repeat(10)).join('\n');
  const r = await f.svc.sendWelink({ description: desc });
  assert.equal(r.ok, true);
  assert.ok(fk.calls.run.length >= 2);
  for (const [i, c] of fk.calls.run.entries()) {
    assert.ok(c.args[5].startsWith(`（${i + 1}/${fk.calls.run.length}）`));
    assert.ok(c.args[5].length <= FW.CHUNK + 10);
  }
});

test('copy-and-open writes the compact text to the clipboard and opens the WeLink client', async t => {
  const fk = fakeWelink({ cli: false });
  const f = fixture(t, { welink: fk.w });
  const r = await f.svc.copyOpenWelink({ description: '模型列表是空的' });
  assert.equal(r.copied, true); assert.equal(r.opened, true); assert.equal(r.to, 'l00807938');
  assert.equal(fk.calls.clip.length, 1); assert.match(fk.calls.clip[0], /模型列表是空的/);
  assert.equal(fk.calls.open, 1);
  assert.equal(fk.calls.run.length, 0, '不调用 welink-cli');
});

test('compact text keeps the description first and trims old error lines to fit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wl-c-'));
  try {
    fs.writeFileSync(path.join(root, 'a.log'), Array.from({ length: 50 }, (_, i) => `Error ${i} ` + 'x'.repeat(200)).join('\n'));
    const t1 = FW.compactFeedback({ info: { version: '1' }, description: '描述', logsDir: root, maxChars: 900 });
    assert.ok(t1.length <= 900); assert.match(t1, /描述/); assert.match(t1, /Error 49/, '最新的报错优先保留');
    const t2 = FW.compactFeedback({ info: {}, description: '长'.repeat(5000), logsDir: root, maxChars: 900 });
    assert.ok(t2.length <= 900); assert.match(t2, /描述过长已截断/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('finds WeLinkPC.exe from the welink: protocol registration, else install dirs, else Start Menu shortcuts', async () => {
  const exe = 'C:\\Program Files (x86)\\WeLink_Desktop\\WeLinkPC.exe';
  const regOut = `\r\nHKEY_CLASSES_ROOT\\welink\\shell\\open\\command\r\n    (默认)    REG_SZ    "${exe}" "%1"\r\n`;
  assert.equal(FW.exeFromCommand(regOut), exe);
  const fsReg = { existsSync: p => p === exe, readdirSync: () => [] };
  const reg = await FW.findWelinkDesktop({ env: {}, fsModule: fsReg, execFileImpl: (_c, _a, _o, cb) => cb(null, regOut) });
  assert.deepEqual(reg, { path: exe, via: 'protocol' });
  const noReg = (_c, _a, _o, cb) => cb(new Error('not found'));
  const dirExe = path.join('C:\\PF86', 'WeLinkPC', 'WeLinkPC.exe');
  const byDir = await FW.findWelinkDesktop({ env: { 'ProgramFiles(x86)': 'C:\\PF86' }, fsModule: { existsSync: p => p === dirExe, readdirSync: () => [] }, execFileImpl: noReg });
  assert.equal(byDir.path, dirExe);
  const menu = path.join('C:\\PD', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const ent = (name, dir = false) => ({ name, isDirectory: () => dir });
  const tree = { [menu]: [ent('WeLink Meeting', true), ent('WeLink_Desktop', true)], [path.join(menu, 'WeLink Meeting')]: [ent('WeLink Meeting.lnk')], [path.join(menu, 'WeLink_Desktop')]: [ent('WeLink Desktop.lnk')] };
  const byLnk = await FW.findWelinkDesktop({ env: { ProgramData: 'C:\\PD' }, fsModule: { existsSync: () => false, readdirSync: d => { if (!tree[d]) throw new Error('nope'); return tree[d]; } }, execFileImpl: noReg });
  assert.equal(byLnk.path, path.join(menu, 'WeLink_Desktop', 'WeLink Desktop.lnk'), '跳过 WeLink Meeting');
});
