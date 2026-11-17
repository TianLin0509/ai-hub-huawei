'use strict';
// DSH 分情况识别（2026-11-17）：同事反馈「装了 DSH 却显示没装」。以前只认同一目录里核心 + 界面包，
// 只装核心、只装桌面版、核心与界面包分装两处的一律判「没装」，也不说缺什么；一键修复还直接改用户的全局 npm。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = require('../core/dsh-cli-profile');

const V = '0.2.2-rc.1';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diag-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const saved = process.env.USERPROFILE;
  process.env.USERPROFILE = home; // ~/.dsh/hub-cli-runtime.json 指到空目录
  t.after(() => { if (saved === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved; fs.rmSync(root, { recursive: true, force: true }); });
  const put = (rel, body = '{}') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const core = (dir, version = V) => { put(`${dir}/node_modules/@deepseek-ai/dsh/lib/bin.js`, ''); put(`${dir}/node_modules/@deepseek-ai/dsh/package.json`, JSON.stringify({ version })); };
  const tui = (dir, { peers = true, range = V } = {}) => {
    put(`${dir}/node_modules/@deepseek-harness-tui/dsh-tui/package.json`, JSON.stringify({ version: '0.20.1',
      peerDependencies: { '@deepseek-ai/dsh-user-questions': range, '@deepseek-ai/dsh-llm-pi-ai': range, '@deepseek-ai/cordis': '^4.0.1' } }));
    if (peers) for (const p of ['dsh-user-questions', 'dsh-llm-pi-ai']) put(`${dir}/node_modules/@deepseek-ai/${p}/package.json`, JSON.stringify({ version: V }));
  };
  const env = extra => ({ PATH: '', APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    USERPROFILE: home, AI_HUB_CLI_TOOLS_DIR: path.join(root, 'tools'), ...extra });
  return { root, home, put, core, tui, env, npm: 'AppData/Roaming/npm', programs: rel => `AppData/Local/Programs/${rel}` };
}

test('只装了核心（npm i -g @deepseek-ai/dsh）：说清在哪找到了核心、缺终端界面包', t => {
  const f = fixture(t);
  f.core(f.npm);
  const d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'core-no-tui');
  assert.equal(d.core.root, path.join(f.root, f.npm));
  const msg = profile.describeRuntimeIssue(d);
  assert.match(msg, /找到了 DSH 核心 v0\.2\.2-rc\.1/);
  assert.match(msg, /缺终端界面包（TUI/);
  assert.ok(msg.includes(path.join(f.root, f.npm)), msg);
  assert.throws(() => profile.resolveDshCliRuntime({}, f.env()), /请先安装 DSH CLI 终端运行环境：找到了 DSH 核心/);
});

test('只装了界面包：说清缺 DSH 核心', t => {
  const f = fixture(t);
  f.tui(f.npm);
  const d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'tui-no-core');
  assert.match(profile.describeRuntimeIssue(d), /找到了终端界面包（TUI）.*缺 DSH 核心/);
});

test('只装了 DSH 桌面版：认出桌面版，并明确说桌面版不是终端版，报错卡给「一键安装终端版」和「装到我的全局 npm」', t => {
  const f = fixture(t);
  f.put(f.programs('DeepSeek Harness/resources/app.asar'), 'asar');
  f.put(f.programs('DeepSeek Harness/DeepSeek Harness.exe'), 'MZ');
  const d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'desktop-only');
  assert.equal(d.desktop.dir, path.join(f.root, f.programs('DeepSeek Harness')));
  let message = '';
  try { profile.resolveDshCliRuntime({}, f.env()); } catch (e) { message = e.message; }
  assert.match(message, /找到了 DSH 桌面版.*桌面版不是终端版/);
  const known = require('../core/known-issues').matchKnownIssue({ area: 'session-create', details: message });
  assert.equal(known.id, 'dsh-package-mismatch');
  assert.equal(known.title, '装的是 DSH 桌面版，Hub 要用终端版');
  assert.equal(known.action.act, 'known:dsh-repair');
  assert.deepEqual(known.more.map(a => a.act), ['known:dsh-repair-global']);
  const html = require('../renderer/hub-error-card').html({ area: 'session-create', details: message });
  assert.match(html, /data-hub-err-act="known:dsh-repair"/);
  assert.match(html, /data-hub-err-act="known:dsh-repair-global"/);
  assert.match(html, /一键安装终端版/);
});

test('桌面版错误卡在短路径及超过 80 字符的空格、中文长路径下都提供安装按钮', () => {
  const dirs = ['D:\\DSH',
    'C:\\Users\\' + 'Long Profile Name '.repeat(8) + '\\AppData\\Local\\Programs\\DeepSeek Harness',
    'D:\\研发项目\\' + '较长的安装目录\\'.repeat(20) + 'DeepSeek Harness'];
  for (const dir of dirs) {
    const details = profile.describeRuntimeIssue({ state: 'desktop-only', desktop: { dir } });
    const known = require('../core/known-issues').matchKnownIssue({ area: 'session-create', details });
    assert.ok(known, `desktop error must match at path length ${dir.length}`);
    assert.equal(known.id, 'dsh-package-mismatch');
    assert.equal(known.title, '装的是 DSH 桌面版，Hub 要用终端版');
    assert.equal(known.action.act, 'known:dsh-repair');
    const html = require('../renderer/hub-error-card').html({ area: 'session-create', details });
    assert.match(html, /data-hub-err-act="known:dsh-repair"/);
    assert.match(html, /data-hub-err-act="known:dsh-repair-global"/);
    assert.match(html, /一键安装终端版/);
  }
});

test('桌面版注册到 PATH 的 dsh 命令（resources\\runtime\\cli）也认作桌面版，不当成终端版', t => {
  const f = fixture(t);
  const cli = path.dirname(f.put('Apps/DSH/resources/runtime/cli/bin/dsh.cmd', '@echo off'));
  const d = profile.diagnoseDshRuntime({}, f.env({ PATH: cli, LOCALAPPDATA: '' }));
  assert.equal(d.state, 'desktop-only');
  assert.equal(d.desktop.dir, path.join(f.root, 'Apps', 'DSH'));
});

test('核心在 A、界面包在 B（%LOCALAPPDATA%\\Programs 下两个目录）：配上并由 Hub 链接起来，不动用户目录', t => {
  const f = fixture(t);
  f.core(f.programs('dsh-core'));
  f.tui(f.programs('dsh-tui'));
  const env = f.env();
  const d = profile.diagnoseDshRuntime({}, env);
  assert.equal(d.state, 'split');
  assert.match(profile.describeRuntimeIssue(d), /版本配套，Hub 会把两边接起来用/);
  const runtime = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.ok(runtime.modules.startsWith(path.join(f.root, 'tools', 'dsh', 'paired-')), runtime.modules);
  assert.equal(runtime.entryPath, path.join(f.root, f.programs('dsh-core'), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  assert.equal(fs.realpathSync(path.join(runtime.modules, '@deepseek-harness-tui', 'dsh-tui')), fs.realpathSync(path.join(f.root, f.programs('dsh-tui'), 'node_modules', '@deepseek-harness-tui', 'dsh-tui')));
  assert.equal(fs.realpathSync(path.join(runtime.modules, '@deepseek-ai', 'dsh')), fs.realpathSync(path.join(f.root, f.programs('dsh-core'), 'node_modules', '@deepseek-ai', 'dsh')));
  assert.equal(runtime.tuiPackage, '@deepseek-harness-tui/dsh-tui');
  assert.deepEqual(fs.readdirSync(path.join(f.root, f.programs('dsh-core'), 'node_modules')), ['@deepseek-ai'], '用户目录没有被写入');
});

test('B 里的界面包缺同代插件时不硬配，讲清缺哪几个', t => {
  const f = fixture(t);
  f.core(f.programs('dsh-core'));
  f.tui(f.programs('dsh-tui'), { peers: false });
  const d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'incomplete');
  assert.deepEqual(d.missing, ['@deepseek-ai/dsh-user-questions', '@deepseek-ai/dsh-llm-pi-ai']);
  assert.match(profile.describeRuntimeIssue(d), /同代插件缺 2 个：@deepseek-ai\/dsh-user-questions、@deepseek-ai\/dsh-llm-pi-ai/);
  assert.throws(() => profile.resolveDshCliRuntime({}, f.env()), /请先安装 DSH CLI/);
});

test('同一目录缺插件：照旧可启动但标明缺什么；Hub 一键安装好之后改用 Hub 那份，不被半成品挡住', t => {
  const f = fixture(t);
  f.core(f.npm); f.tui(f.npm, { peers: false });
  let d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'incomplete');
  assert.equal(d.runtime.root, path.join(f.root, f.npm), '和以前一样仍交给它启动');
  // Hub 一键安装（签名整合包）落地。
  f.core('tools/dsh/9.9.9'); f.tui('tools/dsh/9.9.9');
  f.put('tools/installed.json', JSON.stringify({ schema: 1, tools: { dsh: { version: '9.9.9', dir: 'dsh/9.9.9' } } }));
  d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'ready');
  assert.equal(d.source, 'hub');
  assert.equal(profile.resolveDshCliRuntime({}, f.env()).root, path.join(f.root, 'tools', 'dsh', '9.9.9'));
});

test('核心版本不在界面包声明的范围里：判「版本不配套」', t => {
  const f = fixture(t);
  f.core(f.npm, '0.1.0'); f.tui(f.npm);
  const d = profile.diagnoseDshRuntime({}, f.env());
  assert.equal(d.state, 'mismatch');
  assert.match(profile.describeRuntimeIssue(d), /DSH 核心 v0\.1\.0.*版本不配套/);
});

test('体检：分情况显示「在哪找到了什么、缺什么」，公开版也给一键补齐和「装到我的全局 npm」', async t => {
  const f = fixture(t);
  f.core(f.npm);
  const envCheck = require('../core/env-check');
  const run = async env => (await envCheck.runEnvCheck({ platform: 'win32', env, isCompany: false,
    setup: { findCommand: () => null, findGitBash: () => null }, kindAllowed: id => id === 'deepseek-acp',
    runVersion: async () => ({ ok: true, version: '22.0.0' }) })).items.find(i => i.id === 'dsh');
  const item = await run(f.env());
  assert.equal(item.status, 'warn');
  assert.match(item.detail, /找到了 DSH 核心.*缺终端界面包/);
  assert.deepEqual(item.fixes.map(x => x.act), ['dsh-install', 'dsh-install-global', 'recheck']);
  f.tui(f.npm);
  const ok = await run(f.env());
  assert.equal(ok.status, 'ok');
  assert.ok(ok.detail.includes(path.join(f.root, f.npm)), ok.detail);
});

// 模拟真实 npm：@deepseek-ai/dsh-tui 在 npm 上不存在（E404），界面包是 @deepseek-harness-tui/dsh-tui；install 按参数落包。
function fakeNpm(calls, prefix, options) {
  return async args => {
    calls.push(args);
    if (args[0] === 'prefix') return prefix + '\n';
    if (args[0] === 'view' && args[1] === '@deepseek-ai/dsh') return V;
    if (args[0] === 'view' && args[1].startsWith('@deepseek-ai/dsh-tui')) throw Object.assign(new Error('E404'), { stderr: 'npm error code E404' });
    if (args[0] === 'view') return JSON.stringify({ version: '0.20.1', peerDependencies: { '@deepseek-ai/dsh-user-questions': V } });
    // 和 npm 一样：--global 时模块进全局布局、命令入口 dsh.cmd 生成在全局目录本身；局部模式只进 <目录>/node_modules。
    const at0 = args.indexOf('--prefix'), target = args[at0 + 1], global = args.includes('--global');
    const layout = global ? require('../core/cli-tools/npm-fallback').globalLayout(target) : { modules: path.join(target, 'node_modules'), shims: [] };
    if (global && !(options && options.noShim)) for (const shim of layout.shims) { fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.writeFileSync(shim, '@echo off'); }
    for (const spec of args.slice(at0 + 2)) {
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at), version = spec.slice(at + 1);
      const dir = path.join(layout.modules, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(name.endsWith('dsh-tui') ? { version, peerDependencies: { '@deepseek-ai/dsh-user-questions': V } } : { version }));
      if (name === '@deepseek-ai/dsh') { fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), ''); }
    }
    return '';
  };
}

test('一键补齐默认不碰用户的全局 npm；明确点「装到我的全局 npm」才装进 npm 全局目录', async t => {
  const { createCliInstaller } = require('../core/cli-tools/installer');
  const f = fixture(t);
  const calls = [];
  const prefix = path.join(f.root, 'npm-global');
  // 用户自己装了一份缺插件的：默认的一键补齐走 Hub 自管目录（这里没有下载源，退到 Hub 目录里的 npm），用户目录不动。
  f.core(f.npm); f.tui(f.npm, { peers: false });
  const env = f.env();
  const hub = await createCliInstaller({ env, npmRun: fakeNpm(calls, prefix) }).install('dsh');
  assert.equal(hub.tools.dsh.phase, 'done', hub.tools.dsh.error);
  const installs = calls.filter(a => a[0] === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0][2], path.join(f.root, 'tools', 'dsh', 'user-npm'));
  assert.equal(calls.some(a => a[0] === 'prefix'), false);
  assert.equal(fs.existsSync(path.join(f.root, f.npm, 'node_modules', '@deepseek-ai', 'dsh-user-questions')), false, '用户目录没被改');
  assert.equal(profile.diagnoseDshRuntime({}, env).source, 'hub', '装好后用 Hub 那份');
  // 「装到我的全局 npm」且用户已有一份：补进用户那个目录。
  calls.length = 0;
  const fix = await createCliInstaller({ env, npmRun: fakeNpm(calls, prefix) }).install('dsh', { repair: true, target: 'user-global' });
  assert.equal(fix.tools.dsh.phase, 'done', fix.tools.dsh.error);
  assert.deepEqual(calls.at(-1).slice(0, 4), ['install', '--global', '--prefix', path.join(f.root, f.npm)]);
  // 什么都没装、明确选「装到我的全局 npm」：问 npm 的全局目录，装进去。
  const g = fixture(t);
  calls.length = 0;
  const glob = await createCliInstaller({ env: g.env(), npmRun: fakeNpm(calls, prefix) }).install('dsh', { repair: true, target: 'user-global' });
  assert.equal(glob.tools.dsh.phase, 'done', glob.tools.dsh.error);
  assert.deepEqual(calls[0], ['prefix', '-g']);
  assert.deepEqual(calls.at(-1).slice(0, 5), ['install', '--global', '--prefix', prefix, '@deepseek-ai/dsh@' + V]);
});

test('会话启动报缺插件：错误里写出缺哪几个、从哪个目录启动的', () => {
  const { DshCliSession } = require('../core/dsh-cli-session');
  const session = new DshCliSession({ home: os.tmpdir(), id: 'diag', launch: { args: [] } });
  session.output = "failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-user-questions' imported from C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-harness-tui\\dsh-tui\\lib\\x.js\n"
    + "Cannot find package '@deepseek-ai/dsh-llm-pi-ai' imported from C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@deepseek-harness-tui\\dsh-tui\\lib\\y.js";
  session.fail(new Error('DSH CLI 已退出'));
  assert.match(session.runtime.reason, /缺同代插件 @deepseek-ai\/dsh-user-questions、@deepseek-ai\/dsh-llm-pi-ai/);
  assert.match(session.runtime.reason, /启动目录 C:\\Users\\u\\AppData\\Roaming\\npm/);
  assert.match(session.runtime.reason, /不改你的全局 npm/);
});

// ---------- r26a 审查返工（2026-11-17）----------
test('设置里指定了用户全局目录（缺 TUI）：默认「一键补齐」只装 Hub 自管目录，不写用户目录；装好后改用 Hub 那份', async t => {
  const { createCliInstaller } = require('../core/cli-tools/installer');
  const f = fixture(t);
  f.core(f.npm);
  const pinned = path.join(f.root, f.npm), env = f.env(), calls = [];
  const before = fs.readdirSync(path.join(pinned, 'node_modules', '@deepseek-ai'));
  const entry = { cliRoot: pinned };
  assert.equal(profile.diagnoseDshRuntime(entry, env).state, 'configured-incomplete');
  const r = await createCliInstaller({ env, getDshEntry: () => entry, npmRun: fakeNpm(calls, path.join(f.root, 'npm-global')) }).install('dsh');
  assert.equal(r.tools.dsh.phase, 'done', r.tools.dsh.error);
  const installs = calls.filter(a => a[0] === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0][installs[0].indexOf('--prefix') + 1], path.join(f.root, 'tools', 'dsh', 'user-npm'), '装进 Hub 自管目录');
  assert.deepEqual(fs.readdirSync(path.join(pinned, 'node_modules', '@deepseek-ai')), before, '用户全局目录没被写入');
  assert.equal(fs.existsSync(path.join(pinned, 'node_modules', '@deepseek-harness-tui')), false);
  const d = profile.diagnoseDshRuntime(entry, env);
  assert.equal(d.state, 'ready');
  assert.equal(d.source, 'hub');
  assert.match(d.configuredIssue, /设置里指定的目录/);
  assert.equal(profile.resolveDshCliRuntime(entry, env).root, path.join(f.root, 'tools', 'dsh', 'user-npm'), '装好立即生效');
  // 体检：指定目录不完整、Hub 自管已装好 → 正常并说明改用了 Hub 那份。
  const run = async () => (await require('../core/env-check').runEnvCheck({ platform: 'win32', env, isCompany: false,
    getConfig: () => ({ acp: { providers: { 'deepseek-acp': entry } } }),
    setup: { findCommand: () => null, findGitBash: () => null }, kindAllowed: id => id === 'deepseek-acp',
    runVersion: async () => ({ ok: true, version: '22.0.0' }) })).items.find(i => i.id === 'dsh');
  const item = await run();
  assert.equal(item.status, 'ok');
  assert.match(item.detail, /已改用 Hub 这份/);
});

test('体检：设置里指定的目录不完整时，补那个目录的按钮写明目标路径', async t => {
  const f = fixture(t);
  f.core(f.npm);
  const entry = { cliRoot: path.join(f.root, f.npm) };
  const item = (await require('../core/env-check').runEnvCheck({ platform: 'win32', env: f.env(), isCompany: false,
    getConfig: () => ({ acp: { providers: { 'deepseek-acp': entry } } }),
    setup: { findCommand: () => null, findGitBash: () => null }, kindAllowed: id => id === 'deepseek-acp',
    runVersion: async () => ({ ok: true, version: '22.0.0' }) })).items.find(i => i.id === 'dsh');
  assert.equal(item.status, 'warn');
  assert.equal(item.fixes[0].label, '一键补齐（Hub 自管）');
  assert.ok(item.fixes[1].label.includes(entry.cliRoot), item.fixes[1].label);
});

test('核心在 A、界面包在 B：B 删掉一个包、A 有同名包时，再建会话不报 EEXIST，自动换成指向 A 的链接', t => {
  const f = fixture(t);
  const a = f.programs('dsh-core'), b = f.programs('dsh-tui');
  f.core(a); f.tui(b);
  f.put(`${b}/node_modules/@deepseek-ai/dsh-base/package.json`, JSON.stringify({ version: V, from: 'B' }));
  f.put(`${a}/node_modules/@deepseek-ai/dsh-base/package.json`, JSON.stringify({ version: V, from: 'A' }));
  // B 自己也带一份旧核心：拼接目录里的核心必须是 A 那份（入口指向 A）。
  f.put(`${b}/node_modules/@deepseek-ai/dsh/package.json`, JSON.stringify({ version: '0.1.0' }));
  const env = f.env();
  const read = (runtime, name) => JSON.parse(fs.readFileSync(path.join(runtime.modules, name, 'package.json'), 'utf8'));
  const first = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.equal(read(first, '@deepseek-ai/dsh-base').from, 'B');
  assert.equal(read(first, '@deepseek-ai/dsh').version, V, '核心取 A');
  fs.rmSync(path.join(f.root, b, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true });
  const second = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.equal(read(second, '@deepseek-ai/dsh-base').from, 'A');
  assert.equal(read(second, '@deepseek-harness-tui/dsh-tui').version, '0.20.1');
  // 第三次（清单没变）复用同一个目录。
  assert.equal(profile.pairedModules(profile.resolveDshCliRuntime({}, env), env).modules, second.modules);
  // 清理拼接目录只摘链接，不伤用户目录。
  assert.equal(fs.existsSync(path.join(f.root, a, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json')), true);
});

test('同一份拼接目录里有链接失效（目标被删又装回别处）：整体原子重建，不报 EEXIST', t => {
  const f = fixture(t);
  const a = f.programs('dsh-core'), b = f.programs('dsh-tui');
  f.core(a); f.tui(b);
  const env = f.env();
  const first = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  // 摘掉一条链接、换成指向不存在目录的失效链接，模拟用户整理目录后的残留。
  const at = path.join(first.modules, '@deepseek-ai', 'dsh-user-questions');
  fs.unlinkSync(at);
  fs.symlinkSync(path.join(f.root, 'gone'), at, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.existsSync(at), false);
  const again = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.equal(again.modules, first.modules);
  assert.equal(JSON.parse(fs.readFileSync(path.join(again.modules, '@deepseek-ai', 'dsh-user-questions', 'package.json'), 'utf8')).version, V);
  assert.deepEqual(fs.readdirSync(path.dirname(first.root)).filter(n => /\.(tmp|old)-/.test(n)), [], '临时与挪开的目录都清掉了');
});

test('「装到我的全局 npm」用 npm 全局模式，装完全局目录里有 dsh.cmd；没生成命令入口就报错不谎称成功', async t => {
  const { createCliInstaller } = require('../core/cli-tools/installer');
  const npmLib = require('../core/cli-tools/npm-fallback');
  const f = fixture(t), calls = [];
  const prefix = path.join(f.root, 'npm-global');
  const r = await createCliInstaller({ env: f.env(), npmRun: fakeNpm(calls, prefix) }).install('dsh', { repair: true, target: 'user-global' });
  assert.equal(r.tools.dsh.phase, 'done', r.tools.dsh.error);
  const install = calls.find(a => a[0] === 'install');
  assert.deepEqual(install.slice(0, 4), ['install', '--global', '--prefix', prefix]);
  for (const shim of npmLib.globalLayout(prefix).shims) assert.equal(fs.existsSync(shim), true, shim);
  // npm 没生成命令入口（例如还是局部模式）：不能报成功。
  const g = fixture(t), calls2 = [];
  const prefix2 = path.join(g.root, 'npm-global');
  const bad = await createCliInstaller({ env: g.env(), npmRun: fakeNpm(calls2, prefix2, { noShim: true }) }).install('dsh', { repair: true, target: 'user-global' });
  assert.equal(bad.tools.dsh.phase, 'error');
  assert.match(bad.tools.dsh.error, /全局命令入口/);
  // Hub 自管目录仍用局部模式，不带 --global。
  const h = fixture(t), calls3 = [];
  await createCliInstaller({ env: h.env(), npmRun: fakeNpm(calls3, prefix) }).install('dsh');
  assert.equal(calls3.find(a => a[0] === 'install').includes('--global'), false);
});

// r26a3 复审：A 或 B 里多装一个无关包、核心或界面包升级后，原会话要能恢复，旧拼接目录不能被按时间清掉。
const dshConfig = { acp: { nodePath: process.execPath, apiKey: 'offline-fixture', providers: { 'deepseek-acp': { model: 'fixture-model' } } } };
function splitFixture(t) {
  const f = fixture(t);
  const a = f.programs('dsh-core'), b = f.programs('dsh-tui');
  f.core(a); f.tui(b);
  f.put(`${b}/node_modules/@deepseek-ai/dsh-base/package.json`, JSON.stringify({ name: '@deepseek-ai/dsh-base', version: V, main: 'index.js' }));
  f.put(`${b}/node_modules/@deepseek-ai/dsh-base/index.js`, 'module.exports = "fixture-base";');
  return { f, a, b, env: f.env(), data: path.join(f.root, 'data') };
}
const profileLinkOf = built => path.join(built.home, '.dsh', 'profiles', 'hub-cli', 'node_modules');

test('拼接目录只认核心与界面包（路径加版本）：A 多装一个无关包不换目录，旧会话 profile 仍能加载模块，过期也不按时间清理', t => {
  const { f, a, env } = splitFixture(t);
  const first = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(first.root, old, old);
  f.put(`${a}/node_modules/new-unrelated-package/package.json`, JSON.stringify({ name: 'new-unrelated-package', version: '1.0.0' }));
  const second = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.equal(second.root, first.root, '无关包不改变拼接目录');
  assert.equal(fs.existsSync(path.join(second.modules, 'new-unrelated-package', 'package.json')), true, '同名目录已补上新链接');
  // 核心升级：换新目录，但旧目录（可能还有会话 profile 指着）原样保留，即便已超过一天。
  fs.utimesSync(first.root, old, old);
  f.put(`${a}/node_modules/@deepseek-ai/dsh/package.json`, JSON.stringify({ version: '0.2.2' }));
  f.tui(f.programs('dsh-tui'), { range: '>=0.2.2-rc.1' });
  const third = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.notEqual(third.root, first.root, '核心版本变了换新目录');
  assert.equal(require(path.join(first.modules, '@deepseek-ai', 'dsh-base')), 'fixture-base', '旧目录仍可解析');
});

test('恢复原 DSH 会话：A 多装无关包、核心升级、profile 链接失效，都把链接原子换成当前目录，不报「链接不一致」', t => {
  const { f, a, env, data } = splitFixture(t);
  const opts = { id: 'existing-hub-session', cwd: f.root };
  const first = profile.buildDshCliOptions('deepseek-acp', opts, dshConfig, data, env);
  const link = profileLinkOf(first);
  f.put(`${a}/node_modules/new-unrelated-package/package.json`, JSON.stringify({ version: '1.0.0' }));
  const resumed = profile.buildDshCliOptions('deepseek-acp', { ...opts, acpSid: 'saved-dsh-session' }, dshConfig, data, env);
  assert.equal(fs.realpathSync(profileLinkOf(resumed)), fs.realpathSync(link));
  // 核心升级：拼接目录换了，原会话恢复时 profile 链接跟着换到新目录。
  f.put(`${a}/node_modules/@deepseek-ai/dsh/package.json`, JSON.stringify({ version: '0.2.2' }));
  f.tui(f.programs('dsh-tui'), { range: '>=0.2.2-rc.1' });
  const current = profile.pairedModules(profile.resolveDshCliRuntime({}, env), env);
  assert.notEqual(fs.realpathSync(link), fs.realpathSync(current.modules));
  profile.buildDshCliOptions('deepseek-acp', { ...opts, acpSid: 'saved-dsh-session' }, dshConfig, data, env);
  assert.equal(fs.realpathSync(link), fs.realpathSync(current.modules));
  assert.equal(require(path.join(link, '@deepseek-ai', 'dsh-base')), 'fixture-base');
  // profile 链接指向已不存在的目录（失效链接）：同样换掉，不报 EEXIST。
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(f.root, 'gone'), link, process.platform === 'win32' ? 'junction' : 'dir');
  profile.buildDshCliOptions('deepseek-acp', { ...opts, acpSid: 'saved-dsh-session' }, dshConfig, data, env);
  assert.equal(fs.realpathSync(link), fs.realpathSync(current.modules));
  assert.deepEqual(fs.readdirSync(path.dirname(link)).filter(n => /\.(tmp|old)-/.test(n)), [], '临时链接都清掉了');
});
