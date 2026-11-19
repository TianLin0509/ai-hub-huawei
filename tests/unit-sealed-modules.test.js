'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MODULE = path.join(__dirname, '..', 'core', 'sealed-modules.js');
const sealed = require(MODULE);
const PARAMS = { v: 1, kdf: 'scrypt', N: 1024, r: 8, p: 1, salt: '00112233445566778899aabbccddeeff' };
const CODE = 'testunlockx';
const fileProtector = { available: () => false };

// 造一个最小「统一包」：shared.js 公开版不注册功能，密文里的成员版会 require 只在密文里的 secret.js。
function makeApp({ tamper = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-app-'));
  fs.mkdirSync(path.join(root, 'core', 'sealed'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared.js'), "module.exports = { edition: 'public', features: [] };\n");
  fs.writeFileSync(path.join(root, sealed.PARAMS_REL), JSON.stringify(PARAMS));
  const key = sealed.deriveKey(CODE, PARAMS);
  const files = {
    'shared.js': "const s = require(__dirname + '/secret'); module.exports = { edition: 'member', features: [s.name, require(__dirname + '/data.json').x] };\n",
    'secret.js': "module.exports = { name: 'special', registered: true };\n",
    'data.json': '{"x": 7}',
    'renderer/page.css': 'body{color:red}',
  };
  const payload = { v: 1, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])), features: { memberUpgrade: false }, materialize: [] };
  const bundle = sealed.seal(payload, key);
  if (tamper) bundle[bundle.length - 5] ^= 0x01;
  fs.writeFileSync(path.join(root, sealed.BUNDLE_REL), bundle);
  return { root, key };
}
// 在子进程里装载并汇报：是否接管、shared.js 是哪一版、secret.js 能否加载、开关覆盖。
function probe(root, dataDir) {
  const script = `
    const sealed = require(${JSON.stringify(MODULE)});
    const st = sealed.installMain({ root: ${JSON.stringify(root)}, dataDir: ${JSON.stringify(dataDir)}, protector: { available: () => false } });
    let secret = null; try { secret = require(${JSON.stringify(path.join(root, 'secret'))}).name; } catch (e) { secret = e.code; }
    const shared = require(${JSON.stringify(path.join(root, 'shared.js'))});
    console.log(JSON.stringify({ st, shared, secret, memberUpgrade: sealed.featureOverride('memberUpgrade'), css: sealed.readText(${JSON.stringify(path.join(root, 'renderer', 'page.css'))}) }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true }).trim());
}
const tmpData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-data-'));

test('加解密：同钥匙同明文得同密文；错钥匙、被改都解不开', () => {
  const key = crypto.randomBytes(32);
  const payload = { v: 1, files: { 'a.js': Buffer.from('x').toString('base64') } };
  const a = sealed.seal(payload, key), b = sealed.seal(payload, key);
  assert.ok(a.equals(b), '确定性（差量更新友好）');
  assert.deepStrictEqual(sealed.open(a, key).files, payload.files);
  assert.strictEqual(sealed.open(a, crypto.randomBytes(32)), null);
  const t = Buffer.from(a); t[t.length - 1] ^= 1;
  assert.strictEqual(sealed.open(t, key), null);
  assert.strictEqual(sealed.open(Buffer.from('garbage'), key), null);
  assert.ok(!a.includes(Buffer.from('a.js')), '密文里看不到文件名');
});

test('没钥匙：不接管，加密模块加载不到，共用文件是公开版', () => {
  const { root } = makeApp();
  const r = probe(root, tmpData());
  assert.deepStrictEqual(r.st, { present: true, loaded: false, reason: 'no-key' });
  assert.strictEqual(r.shared.edition, 'public');
  assert.strictEqual(r.secret, 'MODULE_NOT_FOUND');
  assert.strictEqual(r.memberUpgrade, undefined);
  assert.strictEqual(r.css, null);
});

test('口令错：不存钥匙、仍不接管；口令对：存钥匙，下次启动直接接管成员版', async () => {
  const { root, key } = makeApp();
  const dataDir = tmpData();
  const wrong = await sealed.unlockWithCode('wrongcodexx', { root, dataDir, protector: fileProtector });
  assert.strictEqual(wrong.ok, false); assert.strictEqual(wrong.reason, 'wrong');
  assert.strictEqual(sealed.hasCachedKey(dataDir), false);
  assert.strictEqual(probe(root, dataDir).st.loaded, false);
  assert.strictEqual((await sealed.unlockWithCode('abc', { root, dataDir, protector: fileProtector })).reason, 'format');
  const right = await sealed.unlockWithCode(CODE.toUpperCase(), { root, dataDir, protector: fileProtector });
  assert.deepStrictEqual(right, { ok: true, store: 'file' });
  assert.ok(sealed.readCachedKey(dataDir, fileProtector).equals(key));
  const cacheText = fs.readFileSync(path.join(dataDir, sealed.CACHE_FILE), 'utf8');
  assert.ok(!cacheText.includes(CODE), '缓存里没有口令原文');
  const r = probe(root, dataDir);
  assert.strictEqual(r.st.loaded, true);
  assert.strictEqual(r.shared.edition, 'member');
  assert.deepStrictEqual(r.shared.features, ['special', 7]);
  assert.strictEqual(r.secret, 'special');
  assert.strictEqual(r.memberUpgrade, false);
  assert.strictEqual(r.css, 'body{color:red}');
});

test('已有缓存钥匙（成员迁移来的）：不用口令直接接管', async () => {
  const { root, key } = makeApp();
  const dataDir = tmpData();
  assert.deepStrictEqual(await sealed.cacheKey(key, { dataDir, protector: fileProtector }), { ok: true, store: 'file' });
  assert.deepStrictEqual(await sealed.cacheKey(key, { dataDir, protector: fileProtector }), { ok: true, store: 'existing' });
  assert.strictEqual(probe(root, dataDir).st.loaded, true);
});

test('密文被改：有钥匙也安全失败，不接管、不抛错', async () => {
  const { root, key } = makeApp({ tamper: true });
  const dataDir = tmpData();
  await sealed.cacheKey(key, { dataDir, protector: fileProtector });
  const r = probe(root, dataDir);
  assert.deepStrictEqual(r.st, { present: true, loaded: false, reason: 'bad-key-or-bundle' });
  assert.strictEqual(r.shared.edition, 'public');
  assert.strictEqual(r.secret, 'MODULE_NOT_FOUND');
  assert.strictEqual((await sealed.unlockWithCode(CODE, { root, dataDir: tmpData(), protector: fileProtector })).reason, 'wrong');
});

test('没有密文的版本（源码树、旧版）：什么都不做', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-none-'));
  fs.writeFileSync(path.join(root, 'shared.js'), "module.exports = { edition: 'plain' };\n");
  fs.writeFileSync(path.join(root, 'secret.js'), "module.exports = { name: 'disk' };\n");
  const r = probe(root, tmpData());
  assert.deepStrictEqual(r.st, { present: false, loaded: false, reason: 'absent' });
  assert.strictEqual(r.shared.edition, 'plain');
});

test('DPAPI 存取（Windows）：存进去的不是钥匙明文，能取回同一把', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = tmpData();
  const key = crypto.randomBytes(32);
  assert.strictEqual(await sealed.writeCachedKey(dataDir, key), 'dpapi');
  const raw = fs.readFileSync(path.join(dataDir, sealed.CACHE_FILE), 'utf8');
  assert.ok(!raw.includes(key.toString('base64')) && !raw.includes(key.toString('hex')));
  assert.ok(sealed.readCachedKey(dataDir).equals(key));
});

// 审查 P2-1：DPAPI 不可用时的明文后备文件，Windows 上必须收成只有当前用户能读（原来只设 mode 0600，实测仍继承 Users/Authenticated Users）。
test('明文后备（Windows）：钥匙文件 ACL 只有当前用户、不继承', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = tmpData();
  const key = crypto.randomBytes(32);
  assert.strictEqual(await sealed.writeCachedKey(dataDir, key, fileProtector), 'file');
  const file = path.join(dataDir, sealed.CACHE_FILE);
  const script = "$g=[IO.File]::GetAccessControl([Console]::In.ReadToEnd().Trim());$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
    "$ids=@($g.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique);" +
    "ConvertTo-Json -Compress @{protected=$g.AreAccessRulesProtected;me=$me;ids=$ids}";
  const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: file, encoding: 'utf8', windowsHide: true }).trim());
  assert.strictEqual(acl.protected, true, '不继承父目录权限');
  assert.deepStrictEqual([].concat(acl.ids), [acl.me], '只有当前用户一条');
  assert.ok(!fs.readdirSync(dataDir).some(n => n.endsWith('.tmp')), '不留中间文件');
  assert.ok(sealed.readCachedKey(dataDir, fileProtector).equals(key));
});

function aclOf(file) {
  const script = "$g=[IO.File]::GetAccessControl([Console]::In.ReadToEnd().Trim());$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
    "$ids=@($g.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object -Unique);" +
    "ConvertTo-Json -Compress @{protected=$g.AreAccessRulesProtected;me=$me;ids=$ids}";
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { input: file, encoding: 'utf8', windowsHide: true }).trim());
}
function assertExclusive(dataDir, key, label) {
  const file = path.join(dataDir, sealed.CACHE_FILE);
  const acl = aclOf(file);
  assert.strictEqual(acl.protected, true, label + '：不继承父目录权限');
  assert.deepStrictEqual([].concat(acl.ids), [acl.me], label + '：只有当前用户一条');
  assert.ok(!fs.readdirSync(dataDir).some(n => n.endsWith('.tmp')), label + '：不留中间文件');
  assert.ok(sealed.readCachedKey(dataDir, fileProtector).equals(key), label + '：能取回同一把');
}

// 审查 P2-1 并发（m165 复现）：A 收紧占位后、写 K 之前，B 开始保存。原来共用 <pid>.tmp，B 删掉重建 A 的占位，最终文件继承 Users 可读。
test('明文后备并发（Windows）：A 锁好占位后 B 插进来，最终文件仍只有当前用户', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = tmpData();
  const key = crypto.randomBytes(32);
  let second;
  const first = { available: () => false, lockdown: async p => {
    const locked = await sealed.lockToCurrentUser(p);
    second = sealed.writeCachedKey(dataDir, key, fileProtector);
    await new Promise(r => setTimeout(r, 50));
    return locked;
  } };
  assert.strictEqual(await sealed.writeCachedKey(dataDir, key, first), 'file');
  assert.strictEqual(await second, 'file');
  assertExclusive(dataDir, key, '交错保存');
});

test('明文后备并发（Windows）：8 路同时保存，最终文件 ACL 独占、无中间文件残留', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = tmpData();
  const key = crypto.randomBytes(32);
  const results = await Promise.all(Array.from({ length: 8 }, () => sealed.writeCachedKey(dataDir, key, fileProtector)));
  assert.ok(results.every(r => r === 'file' || r === null), String(results));
  assert.ok(results.includes('file'), '至少一路存下');
  assertExclusive(dataDir, key, '8 路并发');
});

test('明文后备：写进 K 后核验不过，删掉中间文件、不落明文', async () => {
  const dataDir = tmpData();
  const key = crypto.randomBytes(32);
  const seen = [];
  const verifyFails = { available: () => false, lockdown: async () => true, verify: async p => { seen.push(fs.readFileSync(p, 'utf8')); return false; } };
  assert.strictEqual(await sealed.writeCachedKey(dataDir, key, verifyFails), null);
  assert.ok(seen.length === 1 && seen[0].includes(key.toString('base64')), '核验发生在写入 K 之后');
  assert.deepStrictEqual(fs.readdirSync(dataDir), [], '既没有钥匙文件也没有中间文件');
  let calls = 0;
  const finalFails = { available: () => false, lockdown: async () => true, verify: async () => ++calls === 1 };
  assert.strictEqual(await sealed.writeCachedKey(dataDir, key, finalFails), null, '改名后的最终文件核验不过，同样视为不可用');
  assert.deepStrictEqual(fs.readdirSync(dataDir), []);
});

test('明文后备：ACL 收不住就不落 K，解锁提示重输口令', async () => {
  const { root } = makeApp();
  const dataDir = tmpData();
  const cannotLock = { available: () => false, lockdown: async () => false };
  assert.strictEqual(await sealed.writeCachedKey(dataDir, crypto.randomBytes(32), cannotLock), null);
  assert.deepStrictEqual(fs.readdirSync(dataDir), [], '既没有钥匙文件也没有中间文件');
  const r = await sealed.unlockWithCode(CODE, { root, dataDir, protector: cannotLock });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'store-failed'); assert.match(r.message, /重新输入口令/);
  assert.strictEqual((await sealed.cacheKey(crypto.randomBytes(32), { dataDir, protector: cannotLock })).ok, false);
  assert.strictEqual(sealed.hasCachedKey(dataDir), false);
  assert.strictEqual(probe(root, dataDir).st.loaded, false);
  const dpapiThrows = { available: () => true, protect: async () => { throw new Error('dpapi down'); }, lockdown: async () => false };
  assert.strictEqual(await sealed.writeCachedKey(dataDir, crypto.randomBytes(32), dpapiThrows), null, 'DPAPI 报错 + 收不住，同样不落明文');
});
