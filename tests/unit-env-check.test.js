'use strict';
// 环境体检（5.5.24，core/env-check.js）：各项并行、单项超时不拖整页、红黄绿判定、脱敏复制文本。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const envCheck = require('../core/env-check');

function fakeSetup(found = {}) {
  return { findCommand: cmd => found[cmd] || null, findGitBash: () => found.bash || null };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'env-check-'));

test('没有系统 Node 的新用户：原生工具不提醒，只有依赖 Node 的 npm 工具才提醒', async t => {
  const dir = tmp();
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, '@echo off\nnode "%~dp0\\node_modules\\tool\\cli.js" %*');
  const check = async found => (await envCheck.runEnvCheck({ platform: 'win32', env: {},
    setup: fakeSetup(found), kindAllowed: id => ['claude', 'codex', 'gemini', 'deepseek-acp'].includes(id),
    resolveDsh: () => null, runVersion: async () => ({ ok: true, version: '22.0.0' }),
  })).items.find(i => i.id === 'node');
  const fresh = await check({ claude: path.join(dir, 'claude.exe'), codex: path.join(dir, 'codex.exe') });
  assert.equal(fresh.status, 'off'); assert.equal(fresh.detail, '没装，用到时再装'); assert.deepEqual(fresh.fixes || [], []);
  assert.match(fresh.cause, /一键安装 DSH 会自动准备 Node/);
  for (const id of ['claude', 'gemini', 'dsh']) {
    const missing = await check({ [id]: shim });
    assert.equal(missing.status, 'warn', id); assert.match(missing.detail, new RegExp(id));
  }
  assert.equal((await check({ codex: shim })).status, 'off', 'npm Codex 由 Hub 直接运行包内原生程序');
  fs.writeFileSync(path.join(dir, 'node.exe'), 'local runtime');
  assert.equal((await check({ claude: shim })).status, 'off', '启动器自带 Node 时不要求系统安装');
  const manualDsh = async config => (await envCheck.runEnvCheck({ platform: 'win32', env: {}, setup: fakeSetup({}),
    kindAllowed: id => id === 'deepseek-acp', resolveDsh: () => ({ root: dir, modules: dir }), getConfig: () => config,
  })).items.find(i => i.id === 'node');
  assert.equal((await manualDsh({})).status, 'warn', '手动装 DSH 运行环境但没有 Node 时提醒');
  assert.equal((await manualDsh({ acp: { nodePath: path.join(dir, 'node.exe') } })).status, 'off', 'DSH 已配置独立 Node 时不要求系统安装');
});

test('全都装好：各项为正常，版本和路径写进说明', async () => {
  const dataDir = tmp();
  const r = await envCheck.runEnvCheck({
    platform: 'win32', dataDir, isCompany: true, version: '5.5.24',
    setup: fakeSetup({ claude: 'C:\\x\\claude.exe', codex: 'C:\\x\\codex.exe', node: 'C:\\x\\node.exe', codeagent: 'C:\\x\\codeagent.exe', bash: 'C:\\Git\\bin\\bash.exe' }),
    runVersion: async file => ({ ok: true, version: file.includes('node') ? '22.1.0' : '1.2.3' }),
    codeagentVersion: async () => '1.2616.0.0', codeagentCommand: () => 'codeagent',
    resolveDsh: () => ({ root: 'C:\\dsh', modules: 'C:\\dsh\\node_modules' }),
    proxy: () => ({ enabled: true, status: { state: 'running', port: 18080 } }),
    appUpdate: () => ({ probeSources: async () => ({ sources: [{ id: 'a', name: '阿里云', ok: true, version: '5.5.24' }, { id: 'g', name: 'GitHub', ok: true, version: '5.5.23' }] }) }),
  });
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  for (const id of ['codeagent', 'claude', 'codex', 'dsh', 'git-bash', 'node', 'company-proxy', 'app-update', 'disk', 'data-dir']) assert.ok(by[id], '缺少 ' + id);
  for (const id of ['codeagent', 'claude', 'codex', 'dsh', 'git-bash', 'node', 'company-proxy', 'app-update', 'data-dir']) assert.equal(by[id].status, 'ok', id + '：' + by[id].detail);
  assert.match(by.claude.detail, /v1\.2\.3/);
  assert.match(by['app-update'].detail, /最新 v5\.5\.24/);
  assert.equal(r.counts.bad, 0);
  assert.equal(fs.readdirSync(dataDir).length, 0, '写入测试不留文件');
});

test('缺东西：CodeAgent 没装在公司版是红，Claude 没装但缺 Git Bash 只是黄；修复按钮带上', async () => {
  const r = await envCheck.runEnvCheck({ platform: 'win32', isCompany: true, setup: fakeSetup({}), runVersion: async () => ({ ok: false, error: 'x' }) });
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.codeagent.status, 'bad');
  assert.ok(by.codeagent.fixes.some(f => f.act === 'recheck'));
  assert.equal(by.claude.status, 'warn');
  assert.equal(by.claude.fixes[0].act, 'open-cli-install');
  assert.equal(by['git-bash'].status, 'warn');
  assert.ok(by.codeagent.cause && by.codeagent.steps.length);
});

test('装了 Claude 却没有 Git Bash：黄（Claude 会改用 PowerShell）；公司版带一键安装；CodeAgent 版本太旧：黄', async () => {
  const r = await envCheck.runEnvCheck({ platform: 'win32', isCompany: true, setup: fakeSetup({ claude: 'C:\\c.exe', codeagent: 'C:\\ca.exe' }),
    runVersion: async () => ({ ok: true, version: '2.0.0' }), codeagentVersion: async () => '1.2600.0.0', codeagentCommand: () => 'codeagent' });
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by['git-bash'].status, 'warn');
  assert.match(by['git-bash'].detail, /改用 PowerShell/);
  assert.equal(by['git-bash'].fixes[0].act, 'git-install');
  assert.equal(by.codeagent.status, 'warn'); assert.match(by.codeagent.detail, /太旧/);
});

test('单项卡住只把那一项标成「没查完」，整页按时返回', async () => {
  const started = Date.now();
  const r = await envCheck.runEnvCheck({ platform: 'linux', setup: fakeSetup({ node: '/usr/bin/node' }), kindAllowed: () => false,
    runVersion: () => new Promise(() => {}) }, { timeoutMs: 150 });
  assert.ok(Date.now() - started < 2000);
  const node = r.items.find(i => i.id === 'node');
  assert.equal(node.status, 'warn'); assert.equal(node.timedOut, true);
});

test('一项抛错不影响其他项', async () => {
  const r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: id => id === 'claude', setup: { findCommand: cmd => { if (cmd === 'claude') throw new Error('炸了'); return '/usr/bin/node'; }, findGitBash: () => null },
    runVersion: async () => ({ ok: true, version: '22.0.0' }) });
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.claude.status, 'warn'); assert.match(by.claude.cause, /炸了/);
  assert.equal(by.node.status, 'ok');
});

test('没有助理、没有一键更新、非公司版：WeLink/PPT Doctor/反代/更新源都不出现，CodeAgent 没装只算不适用', async () => {
  const r = await envCheck.runEnvCheck({ platform: 'win32', isCompany: false, setup: fakeSetup({}), runVersion: async () => ({ ok: false }) });
  const ids = r.items.map(i => i.id);
  for (const id of ['welink', 'ppt-doctor', 'company-proxy', 'app-update']) assert.ok(!ids.includes(id), id);
  assert.equal(r.items.find(i => i.id === 'codeagent').status, 'off');
});

test('WeLink 与 PPT Doctor：没找到是红、登录过期是黄、PPT Doctor 太旧是黄', async () => {
  const assistant = (cli, authText, doctor) => ({ cli: () => cli, auth: { status: () => ({ state: 'unknown' }) },
    rawWelink: async args => (args[0] === '--version' ? { code: 0, stdout: 'welink-cli 1.0.20' } : { code: 0, stdout: authText, stderr: '' }),
    findCli: async () => ({ state: 'notfound' }), ppt: { doctor: { status: async () => doctor } } });
  let r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({}), assistant: () => assistant('', '', { state: 'missing' }) });
  let by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.welink.status, 'bad'); assert.equal(by.welink.fixes[0].act, 'welink-find');
  assert.equal(by['ppt-doctor'].status, 'warn'); assert.equal(by['ppt-doctor'].fixes[0].act, 'doctor-install');
  r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({}), assistant: () => assistant('C:\\w\\welink-cli.exe', 'User Token: EXPIRED', { state: 'upgrade', error: '请升级' }) });
  by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.welink.status, 'warn'); assert.match(by.welink.detail, /过期/); assert.match(by.welink.detail, /v1\.0\.20/);
  assert.equal(by['ppt-doctor'].status, 'warn'); assert.match(by['ppt-doctor'].detail, /太旧/);
  r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({}), assistant: () => assistant('C:\\w\\welink-cli.exe', 'User Token: VALID\nUID: abc', { state: 'ready', version: '2.0.6' }) });
  by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.welink.status, 'ok'); assert.equal(by['ppt-doctor'].status, 'ok'); assert.match(by['ppt-doctor'].detail, /2\.0\.6/);
});

test('更新源：全部连不上是红，一个连不上是黄；反代各状态', async () => {
  const run = (sources, proxyStatus) => envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({ node: '/n' }), runVersion: async () => ({ ok: true, version: '22.0.0' }),
    appUpdate: () => ({ probeSources: async () => ({ sources }) }), proxy: () => proxyStatus });
  let r = await run([{ name: 'A', ok: false, reason: '连接超时' }, { name: 'B', ok: false, blocked: true }], { enabled: false, status: { state: 'stopped' } });
  let by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by['app-update'].status, 'bad'); assert.match(by['app-update'].cause, /确认页/);
  assert.equal(by['company-proxy'].status, 'off');
  r = await run([{ name: 'A', ok: true, version: '1.0.0' }, { name: 'B', ok: false, reason: '连接超时' }], { enabled: true, status: { state: 'failed', message: '没能启动' } });
  by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by['app-update'].status, 'warn');
  assert.equal(by['company-proxy'].status, 'bad'); assert.equal(by['company-proxy'].fixes[0].act, 'proxy-restart');
  r = await run([], { enabled: true, status: { state: 'not-ready', code: 'INITIALIZING' } });
  by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by['company-proxy'].status, 'warn');
});

test('数据目录写不进去：红', async () => {
  const file = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({}), runVersion: async () => ({ ok: false }), dataDir: path.join(file, 'sub') });
  const item = r.items.find(i => i.id === 'data-dir');
  assert.equal(item.status, 'bad');
});

test('复制的体检结果：红黄在前，路径里的用户目录、用户名、邮箱、密钥都脱敏', () => {
  // 夹具里的用户目录和邮箱在运行时拼出来：源码里直接写完整的用户目录、邮箱，会被公开版审计当成泄露拦下。
  const user = 'zhang' + 'san';
  const home = ['C:', 'Users', user].join('\\');
  const text = envCheck.formatReport({ at: Date.UTC(2026, 10, 7), version: '5.5.24', counts: { ok: 1, warn: 0, bad: 1 }, items: [
    { id: 'claude', name: 'Claude Code', status: 'ok', detail: 'v2.0.0 · ' + home + '\\.local\\bin\\claude.exe' },
    { id: 'welink', name: 'welink-cli', status: 'bad', detail: '没找到', cause: '邮箱 ' + user + '@' + 'corp.example.com 用户 ' + user, raw: 'Bearer abcdefghijkl sk-ant-abcdefghijklmnop https://x/y?token=secret' },
  ] }, { home, user });
  const lines = text.split('\n');
  assert.match(lines[0], /环境体检 · v5\.5\.24/);
  assert.ok(text.indexOf('welink-cli') < text.indexOf('Claude Code'), '有问题的排在前面');
  assert.ok(!/zhangsan/i.test(text), text);
  assert.ok(!text.includes('secret') && !text.includes('abcdefghijklmnop'), text);
  assert.match(text, /~\\\.local\\bin\\claude\.exe/);
});

test('版本号解析与带超时的取版本（隐藏窗口、超时返回失败）', async () => {
  assert.equal(envCheck.parseVersion('2.0.31 (Claude Code)'), '2.0.31');
  assert.equal(envCheck.parseVersion('codex-cli 0.167.0'), '0.167.0');
  assert.equal(envCheck.parseVersion('v22.11.0'), '22.11.0');
  let options = null;
  const r = await envCheck.runVersion('C:\\x\\tool.exe', { timeoutMs: 50, execFileImpl: (file, args, opts) => { options = opts; return { pid: 0 }; } });
  assert.equal(r.ok, false); assert.match(r.error, /没返回/);
  assert.equal(options.windowsHide, true);
  const ok = await envCheck.runVersion(process.execPath, { timeoutMs: 8000 });
  assert.equal(ok.ok, true); assert.equal(ok.version, process.versions.node);
});

test('PPT Doctor 版本：显示程序版本 doctorVersion，不显示内置引擎的 version', async () => {
  const assistant = { cli: () => '', auth: { status: () => ({ state: 'unknown' }) }, rawWelink: async () => ({ code: 1, stdout: '' }),
    findCli: async () => ({ state: 'notfound' }), ppt: { doctor: { status: async () => ({ state: 'ready', version: '0.4.0', doctorVersion: '2.0.7' }) } } };
  const r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: fakeSetup({}), assistant: () => assistant });
  const it = r.items.find(i => i.id === 'ppt-doctor');
  assert.match(it.detail, /v2\.0\.7/); assert.doesNotMatch(it.detail, /0\.4\.0/);
});
