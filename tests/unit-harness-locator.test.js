'use strict';
// 定位中心单测（2026-11-20，HUB-H 第一期 A 线）：每个用例造一种同事电脑的环境（临时目录当假文件系统、假注册表、假的起进程），
// 逐一断言「找得到、结论对、启动命令和试跑命令一致」。路径里故意带中文和空格。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessLocator } = require('../core/harness-locator/locator');

const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

function sandbox(t, { pathDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-同事 环境-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'Users', '张 三');
  const env = {
    USERPROFILE: home, USERNAME: '张 三', APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ProgramFiles: path.join(root, 'Program Files'), PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', PATH: pathDirs.join(';'),
    AI_HUB_CLI_TOOLS_DIR: path.join(root, 'hub-tools'), ComSpec: 'cmd.exe',
  };
  const behaviors = new Map(); // 小写路径 → ({ args, node }) => 结果
  const calls = [];
  const sb = {
    root, home, env, behaviors, calls, registry: [], hub: {}, codeagentInstalls: [], config: {},
    p: (...parts) => path.join(root, ...parts),
    file(file, content = '') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; },
    on(file, fn) { behaviors.set(path.resolve(file).toLowerCase(), fn); return file; },
    native(file, version, extra = {}) { sb.file(file, MZ); return sb.on(file, () => ({ code: 0, stdout: `${extra.prefix || ''}${version}\n`, stderr: '', ms: 30 })); },
    node(dir, version) { const f = path.join(dir, 'node.exe'); sb.file(f, MZ); sb.on(f, () => ({ code: 0, stdout: `v${version}\n`, stderr: '', ms: 20 })); return f; },
    // npm 全局装的包：<prefix>\<cmd>.cmd + .ps1 命令壳，包在 <prefix>\node_modules\<pkg>，bin 指向 binRel。
    npmPackage(prefix, { cmd, pkg, version, binRel = 'cli.js', engines, deps, shimRoot = prefix, nodeModules, behavior } = {}) {
      const pkgDir = path.join(nodeModules || path.join(prefix, 'node_modules'), ...pkg.split('/'));
      sb.file(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version, bin: { [cmd]: binRel }, ...(engines ? { engines: { node: engines } } : {}), ...(deps ? { dependencies: deps } : {}) }));
      const script = sb.file(path.join(pkgDir, binRel), '#!/usr/bin/env node\n');
      const rel = path.relative(shimRoot, script);
      sb.file(path.join(shimRoot, cmd + '.cmd'), `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`);
      sb.file(path.join(shimRoot, cmd + '.ps1'), `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe"  "$basedir/${rel.replace(/\\/g, '/')}" $args\n`);
      sb.on(script, behavior || (() => ({ code: 0, stdout: `${version}\n`, stderr: '', ms: 40 })));
      return { pkgDir, script, shim: path.join(shimRoot, cmd + '.cmd') };
    },
    dshFull(prefix, { version = '0.2.2', tuiVersion = '0.16.1', engines = '>=22', peers, behavior, base } = {}) {
      const core = sb.npmPackage(prefix, { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version, binRel: 'lib/bin.js', engines, behavior });
      if (base !== false) sb.file(path.join(core.pkgDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version }));
  sb.file(path.join(prefix, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'),
        JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: tuiVersion, peerDependencies: peers || { '@deepseek-ai/dsh': `^${version}` } }));
      return core;
    },
    locator(opts = {}) {
      const run = async spec => {
        calls.push({ command: spec.command, args: [...spec.args], shell: spec.shell || '' });
        if (spec.args[0] === '--require') spec = { ...spec, args: spec.args.slice(2) };
        // 模拟 DSH 的 --dump-config：按 profile 的 bundles 解析，先看 profile 的 node_modules（链到全局目录），再看核心自己的 node_modules。
        if (spec.args.includes('--dump-config') && spec.env && spec.env.DSH_HOME) {
          const prof = path.join(spec.env.DSH_HOME, 'profiles', 'hub-cli');
          const bundles = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8')).dsh.profile.bundles;
          const coreDir = path.resolve(path.dirname(spec.args[0]), '..');
          const missing = bundles.filter(b => ![path.join(prof, 'node_modules'), path.join(coreDir, 'node_modules')].some(d => fs.existsSync(path.join(d, ...b.split('/'), 'package.json'))));
          return missing.length ? { code: 1, stdout: '', stderr: `dsh: Cannot find package '${missing[0]}'`, ms: 40, errno: '', error: '', timedOut: false }
            : { code: 0, stdout: bundles.map(b => `# == ${b}`).join('\n'), stderr: 'dsh: [@deepseek-harness-tui/dsh-tui] patch: entry "tool-ralph" not found', ms: 60, errno: '', error: '', timedOut: false };
        }
        const isScript = spec.args[0] && /\.(?:c|m)?js$/i.test(spec.args[0]);
        const key = path.resolve(isScript ? spec.args[0] : spec.command).toLowerCase();
        const fn = behaviors.get(key);
        if (!fn) return { code: null, errno: 'ENOENT', error: 'spawn ENOENT', stdout: '', stderr: '', ms: 5, timedOut: false };
        const r = await fn({ args: isScript ? spec.args.slice(1) : spec.args, node: isScript ? spec.command : null, spec });
        return { code: 0, errno: '', error: '', stdout: '', stderr: '', ms: 30, timedOut: false, ...r };
      };
      return new HarnessLocator({ env, platform: 'win32', run, dataDir: path.join(root, 'hub-data'), isCompany: () => false, sleep: async () => {},
        readRegistryPath: async () => sb.registry, readCodeagentInstalls: async () => sb.codeagentInstalls, hubManaged: id => sb.hub[id] || null, readConfig: () => sb.config, tmpDir: root, ...opts });
    },
  };
  return sb;
}

// 「启动命令和试跑命令一致」：试跑记录里有一条正好是 launchSpec + 试跑参数。
function assertSameCommand(sb, locator, id, probeArgs = ['--version']) {
  const launch = locator.launchSpec(id);
  assert.ok(launch, `${id} 应给出启动命令`);
  const want = JSON.stringify([launch.command.toLowerCase(), [...launch.args, ...probeArgs]]);
  assert.ok(sb.calls.some(c => JSON.stringify([c.command.toLowerCase(), c.args]) === want), `${id} 的试跑命令应与启动命令一致：${want}\n实际：${JSON.stringify(sb.calls.map(c => [c.command, c.args]))}`);
  return launch;
}

// ---------- DSH ----------

test('环境 1：DSH npm 版装齐（核心 + 界面包）→ 能用，启动命令是 node + 包里的 bin', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs');
  sb.node(nodeDir, '24.12.0');
  sb.env.PATH = nodeDir;
  const npm = path.join(sb.env.APPDATA, 'npm');
  const core = sb.dshFull(npm);
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.path, core.shim);
  assert.equal(r.chosen.source, 'npm-prefix');
  assert.equal(r.chosen.runtime.kind, 'node');
  assert.equal(r.chosen.version, '0.2.2');
  const launch = assertSameCommand(sb, loc, 'dsh');
  assert.equal(launch.args[0], core.script);
});

test('环境 2：只装了 DSH 桌面版 → 认出 host-commands 里最新一代的命令，能跑但缺终端界面包，说清缺什么并给一键补齐', async t => {
  const sb = sandbox(t);
  const gens = path.join(sb.env.APPDATA, 'DSH Desktop', 'host-commands', 'desktop', 'generations');
  const old = sb.file(path.join(gens, 'aaa-old', 'bin', 'dsh.cmd'), '@echo off\r\nset "DSH_HOME=x"\r\n"C:\\Users\\x\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe" "C:\\x\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
  const past = new Date(Date.now() - 3600e3); fs.utimesSync(path.dirname(path.dirname(old)), past, past);
  const fresh = sb.file(path.join(gens, 'bbb-new', 'bin', 'dsh.cmd'), fs.readFileSync(old));
  sb.on(fresh, () => ({ code: 0, stdout: 'Active code page: 65001\r\n0.2.2\r\n' }));
  sb.on(old, () => ({ code: 9009, stdout: '', stderr: "'x' is not recognized as an internal or external command" }));
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.candidates[0].path, fresh, '最新一代排第一');
  assert.equal(r.chosen.path, fresh);
  assert.equal(r.chosen.source, 'dsh-desktop');
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'missing-tui');
  assert.match(r.reason, /桌面版.*终端界面包/);
  assert.ok(r.fixes.some(f => f.act === 'harness-repair'));
  assert.equal(r.candidates.find(c => c.path === old).reasonCode, 'spawn-failed');
  const launch = assertSameCommand(sb, loc, 'dsh');
  assert.equal(launch.shell, 'cmd');
});

test('环境 3：DSH 桌面版 + Hub 一键装的终端版 → 用 Hub 那份（能用排在跑不起来前面）', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.env.APPDATA, 'DSH Desktop', 'cli', 'g1', 'bin', 'dsh.exe'), '0.2.2');
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  const hubDir = sb.p('hub-tools', 'dsh', '0.2.1');
  const core = sb.dshFull(hubDir, { version: '0.2.1-rc.2' });
  sb.hub.dsh = { dir: hubDir, version: '0.2.1-rc.2', bin: null };
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'hub-managed');
  assert.equal(r.chosen.path, core.script);
  assert.equal(r.candidates.length, 2);
  assertSameCommand(sb, loc, 'dsh');
});

test('环境 4：DSH 源码自建（npm link 到源码目录，界面包在工作区 node_modules）→ 能用', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  const repo = sb.p('src', 'dsh 源码');
  const pkgDir = path.join(repo, 'packages', 'dsh');
  sb.file(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0-dev', bin: { dsh: 'lib/bin.js' } }));
  const script = sb.file(path.join(pkgDir, 'lib', 'bin.js'), '');
  sb.file(path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.3.0-dev' }));
  sb.file(path.join(repo, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.17.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.3.0-0' } }));
  const npm = path.join(sb.env.APPDATA, 'npm');
  fs.mkdirSync(path.join(npm, 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.symlinkSync(pkgDir, path.join(npm, 'node_modules', '@deepseek-ai', 'dsh'), 'junction');
  sb.file(path.join(npm, 'dsh.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
  sb.on(path.join(npm, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), () => ({ stdout: '0.3.0-dev\n' }));
  sb.on(script, () => ({ stdout: '0.3.0-dev\n' }));
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.version, '0.3.0-dev');
});

test('环境 5：DSH 内源版（公司 npm 源装到 .npmrc 指定的目录，包入口不在 lib/bin.js）→ 按包的 bin 找到，能用', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  const prefix = sb.p('D盘', 'nodejs', 'node_global');
  sb.file(path.join(sb.home, '.npmrc'), `@codehub:registry=https://example.invalid/\r\nprefix=${prefix}\r\n`);
  const core = sb.npmPackage(prefix, { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.2-hw.1', binRel: 'dist/cli.mjs' });
  sb.file(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-hw.1' }));
  sb.file(path.join(prefix, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.16.1', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.2-0' } }));
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'npmrc-prefix');
  assert.equal(r.chosen.entry, core.script);
  assertSameCommand(sb, loc, 'dsh');
  // 建会话用的 DSH 运行环境也按 bin 找到入口（不再只认 lib/bin.js）。
  const profile = require('../core/dsh-cli-profile');
  assert.equal(profile.diagnoseDshRuntime({}, sb.env).core.entryPath, core.script);
});

test('环境 6：DSH 只装了核心没装界面包 → 跑不起来（missing-tui），给一键补齐', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  sb.npmPackage(path.join(sb.env.APPDATA, 'npm'), { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.2', binRel: 'lib/bin.js' });
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'missing-tui');
  assert.match(r.reason, /缺终端界面包/);
  assert.deepEqual(r.fixes.map(f => f.act).slice(0, 1), ['harness-repair']);
});

test('环境 7：DSH 核心和界面包声明的版本范围对不上（如内源预发布版本）→ 只提示、以试跑为准，试跑通过判能用', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { version: '1.0.0-htrunk.1', peers: { '@deepseek-ai/dsh': '^0.2.2' } });
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.match(r.reason, /不在界面包声明的版本范围内/);
});

test('环境 8：Node 太旧（本机只有 22.11，DSH 要 24.9）→ 版本太低，人话写清两个版本', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.11.0'); sb.env.PATH = nodeDir;
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { engines: '>=24.9.0' });
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'too-old');
  assert.equal(r.reasonCode, 'node-too-old');
  assert.equal(r.reason, '本机 Node 是 22.11，DSH 0.2.2 要 24.9 以上');
  assert.ok(!sb.calls.some(c => /bin\.js$/i.test(c.args[0] || '')), 'Node 不够新时不去试跑');
});

test('环境 9：本机 Node 22.11 不够、CodeAgent 自带 Node 24.12 够 → 自动借用，并写明用的是哪份', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.11.0'); sb.env.PATH = nodeDir;
  const borrowed = sb.node(path.join(sb.home, 'OCHOME', 'node-v24.12.0'), '24.12.0');
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { engines: '>=24.9.0' });
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.runtime.node, borrowed);
  assert.equal(r.chosen.runtime.nodeVersion, '24.12.0');
  assert.equal(r.chosen.runtime.nodeSource, '借用 CodeAgent 自带的 Node');
  const launch = assertSameCommand(sb, loc, 'dsh');
  assert.equal(launch.command, borrowed);
  assert.equal(launch.node.source, '借用 CodeAgent 自带的 Node');
});

test('环境 10：没装任何 Node → 跑不起来（no-node），不去试跑', async t => {
  const sb = sandbox(t);
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'));
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'no-node');
});

// ---------- 异常 ----------

test('环境 11：npm 占位 exe（安装脚本被禁，claude.exe 是文本）→ 跑不起来（placeholder-exe），不起进程', async t => {
  const sb = sandbox(t);
  const f = sb.file(path.join(sb.home, '.local', 'bin', 'claude.exe'), 'placeholder: run postinstall');
  const r = await sb.locator().locate('claude', { fresh: true });
  assert.equal(r.chosen.path, f);
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'placeholder-exe');
  assert.equal(sb.calls.length, 0);
});

test('环境 12：起进程报「不是有效的 Win32 程序」→ 也判占位 exe', async t => {
  const sb = sandbox(t);
  const f = sb.file(path.join(sb.home, '.local', 'bin', 'claude.exe'), MZ);
  sb.on(f, () => ({ code: null, errno: 'UNKNOWN', error: 'spawn UNKNOWN' }));
  const r = await sb.locator().locate('claude', { fresh: true });
  assert.equal(r.reasonCode, 'placeholder-exe');
  assert.equal(sb.calls.length, 2, '1 秒内的快速失败重试 1 次');
});

test('环境 13：被组策略拦下 → 跑不起来（policy-blocked），不悄悄换别的', async t => {
  const sb = sandbox(t);
  const dir = sb.p('Program Files', 'CodeAgentCLI');
  const bat = sb.file(path.join(dir, 'codeagent.bat'), '@echo off\r\n');
  sb.env.PATH = dir;
  sb.on(bat, () => ({ code: 1, stdout: '', stderr: '此程序被组策略阻止。有关详细信息，请与系统管理员联系。' }));
  const loc = sb.locator();
  const r = await loc.locate('codeagent', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'policy-blocked');
  assert.match(r.reason, /组策略/);
  assert.equal(assertSameCommand(sb, loc, 'codeagent').shell, 'cmd');
});

test('环境 14：试跑超时 → 暂时不可用，沿用上次能用的结论，不判成没装', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  let slow = false;
  const pi = sb.npmPackage(path.join(sb.env.APPDATA, 'npm'), { cmd: 'pi', pkg: '@earendil-works/pi-coding-agent', version: '1.5.2', binRel: 'dist/bundle/cli.js',
    behavior: () => slow ? { code: null, timedOut: true, errno: 'ETIMEDOUT', ms: 10000 } : { stdout: '1.5.2\n' } });
  const loc = sb.locator();
  const first = await loc.locate('pi', { fresh: true });
  assert.equal(first.verdict, 'ok');
  slow = true;
  const changes = [];
  loc.onChange((id, res) => changes.push([id, res.verdict]));
  const second = await loc.locate('pi', { fresh: true });
  assert.equal(second.verdict, 'unavailable');
  assert.equal(second.reasonCode, 'timeout');
  assert.equal(second.chosen.path, pi.shim);
  assert.equal(second.chosen.version, '1.5.2');
  assert.deepEqual(second.lastOk && second.lastOk.path, pi.shim);
  assert.deepEqual(changes, [['pi', 'unavailable']]);
});

test('环境 15：命令壳指向的程序不在了（退出码 9009）→ 跑不起来（spawn-failed）', async t => {
  const sb = sandbox(t);
  const dir = sb.p('tools', 'gemini 目录');
  const shim = sb.file(path.join(dir, 'gemini.cmd'), '@echo off\r\n"C:\\gone\\gemini-launcher.exe" %*\r\n');
  sb.env.PATH = dir;
  sb.on(shim, () => ({ code: 9009, stderr: "'C:\\gone\\gemini-launcher.exe' is not recognized as an internal or external command" }));
  const r = await sb.locator().locate('gemini', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'spawn-failed');
});

// ---------- 路径 ----------

test('环境 16：中文和空格路径里的 npm 版 Claude（JS 入口）→ 能用，启动命令带完整路径', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.19.0'); sb.env.PATH = nodeDir;
  const c = sb.npmPackage(path.join(sb.env.APPDATA, 'npm'), { cmd: 'claude', pkg: '@anthropic-ai/claude-code', version: '2.1.50', binRel: 'cli.js', behavior: () => ({ stdout: '2.1.50 (Claude Code)\n' }) });
  const loc = sb.locator();
  const r = await loc.locate('claude', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.ok(/张 三/.test(r.chosen.path));
  const launch = assertSameCommand(sb, loc, 'claude');
  assert.equal(launch.args[0], c.script);
});

test('环境 17：npm 新版 Claude 的 claude.cmd 直接转发到包里的原生 claude.exe → 用原生程序，账号页也拿到 exe', async t => {
  const sb = sandbox(t);
  const npm = path.join(sb.env.APPDATA, 'npm');
  const exe = sb.native(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), '2.1.322 (Claude Code)');
  sb.file(path.join(npm, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  const loc = sb.locator();
  const r = await loc.locate('claude', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.runtime.kind, 'native');
  assert.equal(assertSameCommand(sb, loc, 'claude').command, exe);
});

test('环境 18：同一个 CLI 装了好几份（npm 版 + 官方原生版）→ 各自试跑带结论，按原来的顺序 npm 优先', async t => {
  const sb = sandbox(t);
  const official = sb.native(path.join(sb.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'codex-cli 0.167.0');
  const npm = path.join(sb.env.APPDATA, 'npm');
  const pkg = path.join(npm, 'node_modules', '@openai', 'codex');
  sb.file(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0', bin: { codex: 'bin/codex.js' } }));
  sb.file(path.join(pkg, 'bin', 'codex.js'), '');
  const vendorExe = sb.native(path.join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'), 'codex-cli 0.169.0');
  sb.file(path.join(npm, 'codex.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const loc = sb.locator();
  const r = await loc.locate('codex', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every(c => c.verdict === 'ok'), JSON.stringify(r.candidates.map(c => [c.path, c.verdict, c.reason])));
  assert.equal(r.chosen.path, path.join(npm, 'codex.cmd'));
  assert.equal(r.chosen.version, '0.169.0');
  assert.equal(assertSameCommand(sb, loc, 'codex').command, vendorExe, 'npm 版直接跑包里自带的原生 codex.exe');
  assert.ok(r.candidates.some(c => c.path === official));
});

test('环境 19：只在注册表最新 PATH 里（装完没重启 Hub）→ 找得到，来源写注册表 PATH', async t => {
  const sb = sandbox(t);
  const dir = sb.p('新装的', 'kimi', 'bin');
  sb.native(path.join(dir, 'kimi.exe'), 'kimi, version 0.27.0');
  sb.registry = [dir];
  const loc = sb.locator();
  const r = await loc.locate('kimi', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'registry-path');
  assertSameCommand(sb, loc, 'kimi');
});

test('环境 20：pnpm 全局装的 pi（入口不是 dist/bundle/cli.js）→ 解析命令壳找到真实入口，能用', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  const pnpmHome = path.join(sb.env.LOCALAPPDATA, 'pnpm');
  sb.env.PNPM_HOME = pnpmHome;
  const pi = sb.npmPackage(pnpmHome, { cmd: 'pi', pkg: '@earendil-works/pi-coding-agent', version: '1.6.0', binRel: 'dist/cli.js', nodeModules: path.join(pnpmHome, 'global', '5', 'node_modules'), engines: '>=22.19.0' });
  const loc = sb.locator();
  const r = await loc.locate('pi', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'pnpm');
  assert.equal(r.chosen.entry, pi.script);
  assertSameCommand(sb, loc, 'pi');
});

test('环境 21：volta 管理的 gemini（volta 的原生转发程序）和 volta 的 Node → 能用', async t => {
  const sb = sandbox(t);
  const volta = path.join(sb.env.LOCALAPPDATA, 'Volta');
  sb.native(path.join(volta, 'bin', 'gemini.exe'), '0.62.0');
  const r = await sb.locator().locate('gemini', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'volta');
  const { nodeCandidates } = require('../core/harness-locator/node-pick');
  const voltaNode = sb.node(path.join(volta, 'tools', 'image', 'node', '24.1.0'), '24.1.0');
  assert.ok(nodeCandidates({ env: sb.env, fs, platform: 'win32' }).some(c => c.file === voltaNode && c.source === 'volta'));
});

test('环境 22：nvm 目录里的 npm 版 Claude（命令壳旁边自带 node.exe）→ 用旁边那份 Node', async t => {
  const sb = sandbox(t);
  const v = path.join(sb.env.APPDATA, 'nvm', 'v22.19.0');
  const nodeExe = sb.node(v, '22.19.0');
  sb.npmPackage(v, { cmd: 'claude', pkg: '@anthropic-ai/claude-code', version: '2.0.0', binRel: 'cli.js' });
  const loc = sb.locator();
  const r = await loc.locate('claude', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'nvm');
  assert.equal(r.chosen.runtime.node, nodeExe);
  assert.equal(r.chosen.runtime.nodeSource, '命令壳旁边自带的 Node');
  assertSameCommand(sb, loc, 'claude');
});

test('环境 23：fnm 装的 pi → 认 fnm 的 node-versions 目录', async t => {
  const sb = sandbox(t);
  const inst = path.join(sb.env.APPDATA, 'fnm', 'node-versions', 'v24.1.0', 'installation');
  sb.node(inst, '24.1.0');
  sb.npmPackage(inst, { cmd: 'pi', pkg: '@earendil-works/pi-coding-agent', version: '1.5.2', binRel: 'dist/bundle/cli.js' });
  const r = await sb.locator().locate('pi', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'fnm');
});

test('环境 24：Claude 官方安装器（~\\.local\\bin\\claude.exe）→ 能用，来源官方安装器', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322 (Claude Code)');
  const loc = sb.locator();
  const r = await loc.locate('claude', { fresh: true });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.chosen.source, 'official');
  assertSameCommand(sb, loc, 'claude');
});

test('环境 25：Codex 官方安装器（%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin）→ 能用', async t => {
  const sb = sandbox(t);
  const exe = sb.native(path.join(sb.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'codex-cli 0.167.0');
  const loc = sb.locator();
  const r = await loc.locate('codex', { fresh: true });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.chosen.source, 'official');
  assert.equal(assertSameCommand(sb, loc, 'codex').command, exe);
});

// ---------- 手动路径 ----------

test('环境 26：手动指定的路径试跑通过 → 保存并生效，重启后还在', async t => {
  const sb = sandbox(t);
  const exe = sb.native(sb.p('我的工具', 'agy.exe'), '1.5.13');
  const loc = sb.locator();
  const r = await loc.setManualPath('antigravity', exe);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.chosen.source, 'manual');
  const again = sb.locator();
  assert.equal(again.manualPath('antigravity'), exe);
  assert.equal(again.peek('antigravity').chosen.path, exe, '重启后 peek 立即给出上次的结论');
  assertSameCommand(sb, loc, 'antigravity');
  const cleared = await loc.clearManualPath('antigravity');
  assert.notEqual(cleared.chosen && cleared.chosen.source, 'manual');
});

test('环境 27：手动指定的路径跑不起来 → 如实报 manual-path-failed，不保存，不换成别的', async t => {
  const sb = sandbox(t);
  const good = sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  const bad = sb.file(sb.p('坏的', 'claude.exe'), 'not a program');
  const loc = sb.locator();
  await loc.locate('claude', { fresh: true });
  const r = await loc.setManualPath('claude', bad);
  assert.equal(r.reasonCode, 'manual-path-failed');
  assert.equal(r.chosen.path, bad);
  assert.match(r.reason, /你指定的.*跑不起来|没通过试跑/);
  assert.equal(loc.manualPath('claude'), '');
  assert.equal(loc.peek('claude').chosen.path, good, '缓存里还是原来能用的那份');
});

test('环境 28：CodeAgent 原来的手动路径（tool-discovery.json）迁到定位中心，不丢', async t => {
  const sb = sandbox(t);
  const exe = sb.native(sb.p('D盘', 'CodeAgentCLI', 'codeagent.exe'), 'codeagent 1.2615.02.05');
  sb.file(sb.p('hub-data', 'tool-discovery.json'), JSON.stringify({ choices: { codeagent: exe }, last: {} }));
  const loc = sb.locator();
  const r = await loc.locate('codeagent', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'manual');
  assert.equal(loc.manualPath('codeagent'), exe);
});

// ---------- 其他 ----------

test('环境 29：什么都没装 → 没找到，列出查过的位置，给安装和手动选择按钮', async t => {
  const sb = sandbox(t);
  sb.file(path.join(sb.home, '.npmrc'), 'prefix=${USERPROFILE}\\npm-global\r\n');
  const r = await sb.locator().locate('pi', { fresh: true });
  assert.equal(r.verdict, 'not-found');
  assert.ok(r.checked.some(c => c.label.includes('.npmrc') && c.path === path.join(sb.home, 'npm-global')));
  assert.ok(r.checked.some(c => c.source === undefined && /pnpm/.test(c.label)));
  assert.deepEqual(r.fixes.map(f => f.act), ['pi-install', 'harness-pick', 'recheck']);
});

test('环境 30：只装了 DSH 界面包没装核心 → 跑不起来（missing-core）', async t => {
  const sb = sandbox(t);
  const npm = path.join(sb.env.APPDATA, 'npm');
  sb.file(path.join(npm, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.16.1', peerDependencies: {} }));
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'missing-core');
});

test('环境 31：旧包名 @mariozechner/pi-coding-agent → 版本太低，提示装新包', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  sb.npmPackage(path.join(sb.env.APPDATA, 'npm'), { cmd: 'pi', pkg: '@mariozechner/pi-coding-agent', version: '0.9.0', binRel: 'dist/cli.js' });
  const r = await sb.locator().locate('pi', { fresh: true });
  assert.equal(r.verdict, 'too-old');
  assert.match(r.reason, /旧包/);
});

// ---------- 刷新与诊断 ----------

test('选中的路径消失 → 2 分钟轮询只看文件、自愈重查，并通知界面', async t => {
  const sb = sandbox(t);
  const a = sb.native(path.join(sb.home, '.local', 'bin', 'kimi.exe'), '0.27.0');
  const loc = sb.locator();
  const r = await loc.locate('kimi', { fresh: true });
  assert.equal(r.chosen.path, a);
  const changes = [];
  loc.onChange((id, res) => changes.push([id, res.verdict]));
  fs.rmSync(a);
  const before = sb.calls.length;
  await loc.poll();
  assert.equal(loc.peek('kimi').verdict, 'not-found');
  assert.deepEqual(changes, [['kimi', 'not-found']]);
  assert.equal(sb.calls.length, before, '轮询不起进程（文件没了也就不用试跑）');
});

test('2 分钟轮询：没找到的 CLI 后来出现在 PATH 上 → 自动查到', async t => {
  const sb = sandbox(t);
  const loc = sb.locator();
  assert.equal((await loc.locate('kimi', { fresh: true })).verdict, 'not-found');
  const dir = sb.p('后装的');
  sb.native(path.join(dir, 'kimi.exe'), '0.28.0');
  sb.env.PATH = dir;
  await loc.poll();
  assert.equal(loc.peek('kimi').verdict, 'ok');
});

test('并发试跑不超过 4 个', async t => {
  const sb = sandbox(t);
  let active = 0, peak = 0;
  const dir = sb.p('many');
  sb.env.PATH = dir;
  for (const id of ['claude', 'codex', 'gemini', 'kimi', 'agy', 'dsh', 'pi', 'codeagent']) {
    sb.file(path.join(dir, id + '.exe'), MZ);
    sb.on(path.join(dir, id + '.exe'), async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return { stdout: '1.0.0\n' }; });
  }
  await sb.locator().locateAll({ fresh: true });
  assert.ok(peak <= 4 && peak >= 2, `并发峰值 ${peak}`);
});

test('诊断文本：列出查过的位置，用户名和用户目录打码，不带环境变量的值', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  sb.env.SECRET_TOKEN = 'sk-abcdefghijklmnop';
  const loc = sb.locator();
  await loc.locate('claude', { fresh: true });
  await loc.locate('pi', { fresh: true });
  const text = loc.diagnosisText(['claude', 'pi']);
  assert.match(text, /Claude Code：能用/);
  assert.match(text, /%USERPROFILE%\\\.local\\bin\\claude\.exe/);
  assert.match(text, /查过的位置/);
  assert.match(text, /\[没有\] npm 全局目录/);
  assert.ok(!text.includes('张 三'), '用户名已打码');
  assert.ok(!text.includes('sk-abcdefghijklmnop'));
});

test('启动 1 秒内：新实例直接从 state.json 给出上次的结论（不起进程）', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  await sb.locator().locate('claude', { fresh: true });
  const calls = sb.calls.length;
  const t0 = Date.now();
  const fresh = sb.locator();
  const peek = fresh.peek('claude');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(peek.verdict, 'ok');
  assert.equal(sb.calls.length, calls);
});

// ---------- 旧入口转调 ----------

test('旧入口转调：findCommand / locateWindowsCodex / resolveClaudeExe / userClaude / resolvePiRuntime 拿到定位中心同一份结果', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0');
  sb.env.PATH = nodeDir;
  const npm = path.join(sb.env.APPDATA, 'npm');
  const exe = sb.native(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), '2.1.322');
  sb.file(path.join(npm, 'claude.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  const pnpmHome = path.join(sb.env.LOCALAPPDATA, 'pnpm');
  sb.env.PNPM_HOME = pnpmHome;
  const pi = sb.npmPackage(pnpmHome, { cmd: 'pi', pkg: '@earendil-works/pi-coding-agent', version: '1.6.0', binRel: 'dist/cli.js', nodeModules: path.join(pnpmHome, 'global', '5', 'node_modules') });
  const codexShim = sb.file(path.join(pnpmHome, 'codex.cmd'), '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const env = { ...sb.env };
  assert.equal(require('../core/community-setup').findCommand('claude', env, 'win32'), path.join(npm, 'claude.cmd'));
  assert.equal(require('../core/account-adapters').resolveClaudeExe(env), exe);
  assert.deepEqual(require('../core/cli-tools/registry').userClaude(env), { dir: npm, onPath: false });
  assert.deepEqual(require('../main/codex-windows-command').locateWindowsCodex(env), { kind: 'npm', shim: codexShim, source: 'pnpm' });
  const rt = require('../core/pi-cli-profile').resolvePiRuntime(env);
  assert.equal(rt.entryPath, pi.script);
});

test('体检：各 CLI 那一行带 extra.locate，cause 是 reason、fixes 是定位中心给的按钮', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.11.0'); sb.env.PATH = nodeDir;
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { engines: '>=24.9.0' });
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  const loc = sb.locator();
  const { probeList } = require('../core/env-check');
  const probes = probeList({ env: sb.env, platform: 'win32', locator: loc, kindAllowed: id => ['claude', 'deepseek-acp'].includes(id), getConfig: () => ({}) });
  const rows = Object.fromEntries(await Promise.all(probes.filter(p => ['claude', 'dsh'].includes(p.id)).map(async p => [p.id, await p.run()])));
  assert.equal(rows.claude.status, 'ok');
  assert.equal(rows.claude.extra.locate.verdict, 'ok');
  assert.equal(rows.dsh.status, 'warn');
  assert.equal(rows.dsh.extra.locate.reasonCode, 'node-too-old');
  assert.equal(rows.dsh.cause, '本机 Node 是 22.11，DSH 0.2.2 要 24.9 以上');
  assert.ok(rows.dsh.fixes.some(f => f.act === 'harness-repair'));
  const nodeRow = await probes.find(p => p.id === 'node').run();
  assert.equal(nodeRow.extra.locate.verdict, 'ok');
  assert.equal(nodeRow.extra.locate.chosen.path, path.join(nodeDir, 'node.exe'));
});

test('env-check:fix 收到 harness-* 动作时转给定位中心（选文件取消返回 canceled）', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  const loc = sb.locator();
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  require('../main/ipc/env-check-handlers').registerEnvCheckIpc(ipcMain, { dataDir: () => sb.p('hub-data'), version: () => 't', isCompany: () => false, assistant: () => null, locator: () => loc });
  const recheck = await handlers['env-check:fix'](null, { id: 'claude', act: 'harness-clear-manual' });
  assert.equal(recheck.ok, true);
  assert.equal(recheck.locate.verdict, 'ok');
  const ipc = {};
  require('../main/ipc/harness-locator-handlers').registerHarnessLocatorIpc({ handle: (n, fn) => { ipc[n] = fn; } }, { locator: loc, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
  assert.equal(await ipc['harness:pick-path'](null, { id: 'claude' }), null);
  assert.equal((await ipc['harness:peek-all'](null)).claude.verdict, 'ok');
  assert.match((await ipc['harness:diagnosis'](null, { ids: ['claude'] })).text, /Claude Code：能用/);
  const bad = await ipc['harness:locate'](null, { id: 'nope' });
  assert.equal(bad.ok, false);
});

test('环境 32：公司内部源装的 DSH（1.0.0-htrunk.1，没有界面包）→ 版本照常认，缺界面包时说清是内部源没有、按钮是一键补齐', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.14.0'); sb.env.PATH = nodeDir;
  sb.npmPackage(path.join(sb.env.APPDATA, 'npm'), { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '1.0.0-htrunk.1', binRel: 'lib/bin.js', engines: '>=24.9.0' });
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.chosen.version, '1.0.0-htrunk.1');
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'missing-tui');
  assert.match(r.reason, /公司内部 npm 源没有 DSH 界面包/);
  assert.equal(r.fixes[0].act, 'harness-repair');
  assert.ok(!r.fixes.some(f => /npm/.test(f.label)));
});

test('engines 的最低 Node 自己解析（不依赖 semver 包）', () => {
  const { requiredNode } = require('../core/harness-locator/node-pick');
  assert.equal(requiredNode('22.0.0', { node: '>=24.9.0' }), '24.9.0');
  assert.equal(requiredNode('18.0.0', { node: '^22.19 || >=24' }), '22.19.0');
  assert.equal(requiredNode('22.19.0', { node: '>=18' }), '22.19.0');
  assert.equal(requiredNode('', { node: '>= 20.x' }), '20.0.0');
});

test('安装失败的 407 / 404 翻成人话', () => {
  const { humanInstallError } = require('../main/ipc/harness-locator-handlers');
  assert.match(humanInstallError('npm ERR! code E407'), /公司代理要求登录（407）/);
  assert.match(humanInstallError('npm ERR! code E404 Not Found'), /没有这个包（404）/);
});

test('环境 33：DSH 核心找不到 Hub 会话要的 @deepseek-ai/dsh-base → 跑不起来，说清缺哪个组件', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.14.0'); sb.env.PATH = nodeDir;
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { version: '1.0.0-htrunk.1', peers: { '@deepseek-ai/dsh': '>=0.2.0-0' }, base: false });
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'broken');
  assert.equal(r.reasonCode, 'missing-core');
  assert.match(r.reason, /组装失败.*dsh-base.*公司内部源的改造版/);
});

test('环境 34：DSH NEXT 与上游桌面壳（ELECTRON_RUN_AS_NODE）→ 认出，按 cmd 原样跑，不拆成本机 Node', async t => {
  const sb = sandbox(t);
  const next = sb.file(path.join(sb.env.APPDATA, 'DSH NEXT', 'cli', 'abc123', 'bin', 'dsh.cmd'), '@echo off\r\ncall "%~dp0node.cmd" "%~dp0..\..\..\app\lib\desktop-cli.js" %*\r\n');
  sb.on(next, () => ({ stdout: '2.0.24-next\n' }));
  const up = sb.file(path.join(sb.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\..\..\..\DeepSeek Harness.exe" "%~dp0..\..\..\app.asar\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*\r\n');
  sb.on(up, () => ({ stdout: '0.2.2\n' }));
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  const paths = r.candidates.map(c => c.path);
  assert.ok(paths.includes(next) && paths.includes(up), JSON.stringify(paths));
  assert.ok(r.candidates.every(c => c.launchKind === 'cmd' && c.source === 'dsh-desktop'));
  assert.equal(r.reasonCode, 'missing-tui');
  assert.equal(assertSameCommand(sb, loc, 'dsh').shell, 'cmd');
});

test('环境 35：Node 装在 Program Files 但不在 PATH（黄区实测）→ Node 那一行也找得到，和 DSH / pi 用的是同一份', async t => {
  const sb = sandbox(t);
  const nodeExe = sb.node(sb.p('Program Files', 'nodejs'), '24.14.0');
  const r = await sb.locator().locate('node', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.path, nodeExe);
  assert.equal(r.chosen.source, 'known-dir');
});

test('环境 36：Hub 一键装的 DSH（0.2.1-rc.2 + 界面包 0.16.1，扁平目录）→ 按 hub-cli 组装成功，能用（黄区倒退的回归）', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.14.0'); sb.env.PATH = nodeDir;
  const hubDir = sb.p('hub-tools', 'dsh', '0.2.1-rc.2');
  sb.npmPackage(hubDir, { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.1-rc.2', binRel: 'lib/bin.js' });
  sb.file(path.join(hubDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.2' }));
  const tuiDir = path.join(hubDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  sb.file(path.join(tuiDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.16.1', peerDependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.2', '@deepseek-ai/dsh-app-boot': '^0.1.0' } }));
  fs.mkdirSync(path.join(tuiDir, 'tui-profile'), { recursive: true });
  sb.hub.dsh = { dir: hubDir, version: '0.2.1-rc.2', bin: null };
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'hub-managed');
  assert.equal(r.chosen.dsh.boot.ok, true);
  const boot = sb.calls.find(c => c.args.includes('--dump-config'));
  assert.ok(boot, '跑过 hub-cli 组装检查');
  assert.deepEqual(boot.args.slice(-3), ['--profile', 'hub-cli', '--dump-config']);
  if (boot.args[0] === '--require') assert.ok(fs.existsSync(boot.args[1]), '--require 的补丁文件真实存在：' + boot.args[1]);
  assertSameCommand(sb, loc, 'dsh');
  assert.equal(fs.readdirSync(sb.root).filter(n => n.startsWith('hub-harness-dsh-')).length, 0, '临时 DSH_HOME 用完删掉');
  assert.ok(fs.existsSync(path.join(hubDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), '只摘链接，不删 Hub 自管目录');
});

test('环境 37：npm 全局装的 dsh 0.2.2 + dsh-tui 0.20 启动器（插件在核心自己的 node_modules、界面本体没装）→ 组装成功，能用', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.14.0'); sb.env.PATH = nodeDir;
  const prefix = path.join(sb.env.APPDATA, 'npm');
  const core = sb.npmPackage(prefix, { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.2-rc.5', binRel: 'lib/bin.js', engines: '>=24.9.0' });
  sb.file(path.join(core.pkgDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.5' }));
  const tuiDir = path.join(prefix, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  sb.file(path.join(tuiDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.20.2', bin: { 'dsh-tui': './bin/dsh-tui.js' },
    peerDependencies: { '@deepseek-ai/dsh-app-boot': '^0.1.0', '@deepseek-ai/dsh-atomic-write': '^0.1.0' } }));
  fs.mkdirSync(path.join(tuiDir, 'tui-profile'), { recursive: true });
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.doesNotMatch(r.reason, /插件|界面本体/);
  assertSameCommand(sb, loc, 'dsh');
});

// ---------- 2026-11-21 Codex 审查返工：每条都是「撤掉修复就会失败」的用例 ----------
test('返工 1：本机 Node 22 + 借用 CodeAgent 的 Node 24 → 建 DSH 会话的命令里用的就是试跑那份 Node 24', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.11.0'); sb.env.PATH = nodeDir;
  const borrowed = sb.node(path.join(sb.home, 'OCHOME', 'node-v24.12.0'), '24.12.0');
  const core = sb.dshFull(path.join(sb.env.APPDATA, 'npm'), { engines: '>=24.9.0' });
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.chosen.runtime.node, borrowed);
  const idx = require('../core/harness-locator');
  const orig = idx.launchSpec;
  idx.launchSpec = (id, o) => loc.launchSpec(id, o);
  t.after(() => { idx.launchSpec = orig; });
  const bridge = sb.p('bridge'); sb.file(path.join(bridge, 'package.json'), '{}');
  const config = { companyCli: true, dshBackend: 'api', dshApiBaseUrl: 'http://own.example.test/v1', dshApiKey: 'k-test', dshApiModel: 'm1',
    acp: { providers: { 'deepseek-acp': { entryPath: core.script, bridgePath: bridge } } } };
  const options = require('../core/acp-profiles').buildAcpOptions('deepseek-acp', { id: 'fix-1', cwd: sb.root }, config, sb.p('hub-data'), sb.env);
  const launch = options.launch || options;
  assert.equal(path.resolve(launch.command).toLowerCase(), borrowed.toLowerCase(), `建会话用的 Node：${launch.command}`);
});

test('返工 2：手选路径 A 跑不起来、环境变量指定的 B 能用 → 手选只试 A，如实失败，不保存', async t => {
  const sb = sandbox(t);
  const good = sb.native(sb.p('环境变量的', 'claude.exe'), '2.1.322');
  sb.env.AI_HUB_CLAUDE_PATH = good;
  const bad = sb.file(sb.p('坏的', 'claude.exe'), 'not a program');
  const loc = sb.locator();
  const r = await loc.setManualPath('claude', bad);
  assert.equal(r.reasonCode, 'manual-path-failed');
  assert.notEqual(r.verdict, 'ok');
  assert.equal(r.chosen.path, bad);
  assert.equal(r.candidates.length, 1, '只试跑手选的那一份');
  assert.equal(loc.manualPath('claude'), '');
});

test('返工 3：退出码 1 但输出里带版本号 → 不算能用（broken，带输出首行）', async t => {
  const sb = sandbox(t);
  const exe = sb.file(sb.p('工具', 'agy.exe'), MZ);
  sb.on(exe, () => ({ code: 1, stdout: '1.5.13\n', stderr: 'Error: config broken\n' }));
  const r = await sb.locator().setManualPath('antigravity', exe);
  assert.notEqual(r.verdict, 'ok');
  const c = r.candidates[0];
  assert.equal(c.verdict, 'broken');
  assert.match(c.reason, /退出码 1）：Error: config broken/);
});

test('返工 4：手选的 DSH 因 Node 太旧根本没跑 → 不保存手选路径', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '22.11.0'); sb.env.PATH = nodeDir;
  const core = sb.dshFull(sb.p('我的 dsh'), { engines: '>=24.9.0' });
  const loc = sb.locator();
  const r = await loc.setManualPath('dsh', core.shim);
  assert.equal(r.verdict, 'too-old', r.reason);
  assert.equal(loc.manualPath('dsh'), '', 'Node 太旧时不保存');
});

test('返工 5：Codex 只有 codex.ps1 / 只在 node_modules 里有包 → 旧入口也拿到定位中心解析好的 codex.exe', async t => {
  for (const variant of ['ps1', 'pkg-only']) {
    const sb = sandbox(t);
    const npm = path.join(sb.env.APPDATA, 'npm');
    const pkg = path.join(npm, 'node_modules', '@openai', 'codex');
    sb.file(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0', bin: { codex: 'bin/codex.js' } }));
    sb.file(path.join(pkg, 'bin', 'codex.js'), '');
    const vendorExe = sb.native(path.join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'), 'codex-cli 0.169.0');
    if (variant === 'ps1') sb.file(path.join(npm, 'codex.ps1'), '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args\n');
    const env = { ...sb.env };
    const cmd = require('../main/codex-windows-command');
    const found = cmd.locateWindowsCodex(env);
    assert.ok(found, `${variant}：旧入口不应返回 null`);
    assert.equal(found.command, vendorExe, variant);
    assert.equal(cmd.resolveWindowsCodex(env).command, vendorExe, variant);
  }
});

test('返工 6：安装失败原话只有 404（没有 Not Found 字样）也翻成人话', () => {
  const { humanInstallError } = require('../main/ipc/harness-locator-handlers');
  assert.match(humanInstallError("npm ERR! 404  '@deepseek-harness-tui/dsh-tui@0.16.1' is not in this registry."), /没有这个包（404）/);
  assert.equal(humanInstallError('took 14045 ms'), 'took 14045 ms', '数字里夹着的 404 不误判');
});

test('返工 7：一次体检只跑一轮定位——只调一次 locateAll，每个 CLI 只试跑一次', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'));
  const claude = sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  const loc = sb.locator();
  let all = 0, single = 0;
  const origAll = loc.locateAll.bind(loc), origOne = loc.locate.bind(loc);
  loc.locateAll = opts => { all++; return origAll(opts); };
  loc.locate = (id, opts) => { if (opts && opts.reason === 'open' && loc.enabled(id)) single++; return origOne(id, opts); };
  const { probeList } = require('../core/env-check');
  const ctx = { env: sb.env, platform: 'win32', locator: loc, kindAllowed: () => true, getConfig: () => ({}) };
  const probes = probeList(ctx).filter(p => ['claude', 'dsh', 'node'].includes(p.id));
  for (const p of probes) await p.run(); // 逐行跑（最容易重复试跑的顺序）
  assert.equal(all, 1, '一次体检只调一次 locateAll');
  assert.equal(single, IDS_COUNT(loc), '每个已启用的 CLI 只查一次（都在 locateAll 那一轮里），各行不再单独重查');
  const claudeRuns = sb.calls.filter(c => path.resolve(c.command).toLowerCase() === claude.toLowerCase() && c.args.includes('--version')).length;
  assert.equal(claudeRuns, 1, 'Claude 只试跑一次');
});
function IDS_COUNT(loc) { return loc.specs.filter(s => loc.enabled(s.id)).length; }

test('返工 8：诊断里的进程 PATH 只列打码后的目录（用户目录写成 %USERPROFILE%），不带其他环境变量的值', async t => {
  const sb = sandbox(t);
  const bin = path.join(sb.home, '.local', 'bin');
  sb.native(path.join(bin, 'claude.exe'), '2.1.322');
  sb.env.PATH = [bin, sb.p('tools')].join(';');
  sb.env.MY_PRIVATE_SETTING = 'value-should-not-show';
  const loc = sb.locator();
  await loc.locate('claude', { fresh: true });
  const text = loc.diagnosisText(['claude']);
  const line = text.split('\n').find(l => l.startsWith('进程 PATH'));
  assert.ok(line.includes('%USERPROFILE%' + path.sep + '.local' + path.sep + 'bin'), line);
  assert.ok(!line.includes('张 三'));
  assert.ok(!text.includes('value-should-not-show'));
});

test('返工 10：harness:set-path（CodeAgent 切版本）→ 不弹框，ok 才保存，失败如实返回结论', async t => {
  const sb = sandbox(t);
  const a = sb.native(sb.p('CodeAgent 1', 'codeagent.exe'), 'codeagent 1.2615.02.05');
  const b = sb.native(sb.p('CodeAgent 2', 'codeagent.exe'), 'codeagent 1.2620.01.01');
  sb.env.PATH = [path.dirname(a), path.dirname(b)].join(';');
  const loc = sb.locator();
  await loc.locate('codeagent', { fresh: true });
  const ipc = {};
  let dialogs = 0;
  require('../main/ipc/harness-locator-handlers').registerHarnessLocatorIpc({ handle: (n, fn) => { ipc[n] = fn; } }, { locator: loc, showOpenDialog: async () => { dialogs++; return { canceled: true }; } });
  const r = await ipc['harness:set-path'](null, { id: 'codeagent', path: a });
  assert.equal(dialogs, 0, '不弹选文件框');
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.path, a);
  assert.equal(loc.manualPath('codeagent'), a);
  const bad = await ipc['harness:set-path'](null, { id: 'codeagent', path: sb.file(sb.p('坏的', 'codeagent.exe'), 'not a program') });
  assert.equal(bad.reasonCode, 'manual-path-failed');
  assert.equal(loc.manualPath('codeagent'), a, '失败不改已保存的');
  assert.equal((await ipc['harness:set-path'](null, { id: 'nope', path: a })).ok, false);
});

// ---------- 显式配置（2026-11-21 接回改版前认的设置和环境变量；指定的优先、独占，不行就如实报） ----------

const NODE_CONFIGURED_LABEL = 'Hub 设置里指定的 Node（nodePath）';
function dshEnv(sb) {
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.12.0'); sb.env.PATH = nodeDir;
  return { npm: sb.dshFull(path.join(sb.env.APPDATA, 'npm')) }; // 机器上另有一份 npm 全局装的 DSH（不该被选）
}

test('显式 1：Hub 设置 acp.providers.deepseek-acp.cliRoot 指定 DSH 目录 → 只认它（不用 npm 全局那份），来源 setting', async t => {
  const sb = sandbox(t);
  dshEnv(sb);
  const root = sb.p('指定的 dsh 目录');
  const core = sb.dshFull(root, { version: '0.2.2-rc.5' });
  sb.config = { acp: { providers: { 'deepseek-acp': { cliRoot: root } } } };
  const loc = sb.locator();
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'setting');
  assert.equal(r.chosen.path, core.script);
  assert.equal(r.candidates.length, 1, '只认指定的那一份');
  assert.equal(assertSameCommand(sb, loc, 'dsh').args[0], core.script);
});

test('显式 2：环境变量 AI_HUB_DSH_CLI_ROOT 指定 DSH 目录 → 只认它；设置里的 cliRoot 排在它前面', async t => {
  const sb = sandbox(t);
  dshEnv(sb);
  const envRoot = sb.p('环境变量的 dsh');
  const envCore = sb.dshFull(envRoot, { version: '0.2.2-rc.5' });
  sb.env.AI_HUB_DSH_CLI_ROOT = envRoot;
  let r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'env-override');
  assert.equal(r.chosen.path, envCore.script);
  assert.equal(r.candidates.length, 1);
  const setRoot = sb.p('设置的 dsh');
  const setCore = sb.dshFull(setRoot);
  sb.config = { acp: { providers: { 'deepseek-acp': { cliRoot: setRoot } } } };
  r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.chosen.source, 'setting');
  assert.equal(r.chosen.path, setCore.script);
});

test('显式 3：AI_HUB_DSH_CLI_ROOT 指向的目录里没有 DSH → 如实报（不悄悄换成 npm 全局那份），查找记录写明', async t => {
  const sb = sandbox(t);
  dshEnv(sb);
  const empty = sb.p('空的 dsh 目录'); fs.mkdirSync(empty, { recursive: true });
  sb.env.AI_HUB_DSH_CLI_ROOT = empty;
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.notEqual(r.verdict, 'ok');
  assert.equal(r.candidates.length, 0, '不掺进 npm 全局那份');
  assert.ok(r.checked.some(c => c.path === empty && /目录在，但里面没有 @deepseek-ai\/dsh/.test(c.note)), JSON.stringify(r.checked));
});

test('显式 4：指定的 DSH 目录是空的、Hub 一键装过一份 → 允许用 Hub 那份（和改版前一致，「一键补齐」装好立即生效）', async t => {
  const sb = sandbox(t);
  dshEnv(sb);
  const empty = sb.p('空的 dsh 目录'); fs.mkdirSync(empty, { recursive: true });
  sb.config = { acp: { providers: { 'deepseek-acp': { cliRoot: empty } } } };
  const hubDir = sb.p('hub-tools', 'dsh', '0.2.2');
  const core = sb.dshFull(hubDir);
  sb.hub.dsh = { dir: hubDir, version: '0.2.2', bin: null };
  const r = await sb.locator().locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'hub-managed');
  assert.equal(r.chosen.path, core.script);
  assert.ok(!r.candidates.some(c => c.source === 'npm-prefix'), '仍不掺进 npm 全局那份');
});

test('显式 5：Hub 设置 acp.providers.deepseek-acp.nodePath 指定 Node → 试跑和建会话都只用它；它太旧就如实报，不换别的 Node', async t => {
  const sb = sandbox(t);
  dshEnv(sb); // PATH 上有 Node 24.12
  const mine = sb.node(sb.p('我的 node'), '24.9.0');
  sb.config = { acp: { providers: { 'deepseek-acp': { nodePath: mine } } } };
  const loc = sb.locator();
  let r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  const launch = assertSameCommand(sb, loc, 'dsh');
  assert.equal(launch.command, mine);
  assert.equal(launch.node.source, NODE_CONFIGURED_LABEL);
  const old = sb.node(sb.p('旧 node'), '20.10.0');
  sb.config = { acp: { providers: { 'deepseek-acp': { nodePath: old } } } };
  r = await sb.locator().locate('dsh', { fresh: true });
  assert.notEqual(r.verdict, 'ok');
  assert.match(r.reason, /Node 是 20\.10/);
});

test('显式 6：CODEX_INSTALL_DIR 指定目录 → 只认那里的 codex.exe（不用官方安装器那份）', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'codex-cli 0.167.0');
  const dir = sb.p('公司 codex');
  const exe = sb.native(path.join(dir, 'codex.exe'), 'codex-cli 0.150.0');
  sb.env.CODEX_INSTALL_DIR = dir;
  const loc = sb.locator();
  const r = await loc.locate('codex', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'env-override');
  assert.equal(r.chosen.path, exe);
  assert.equal(r.candidates.length, 1);
  assert.equal(assertSameCommand(sb, loc, 'codex').command, exe);
});

test('显式 7：AI_HUB_ANTIGRAVITY_COMMAND 给完整路径 → 只认它；给命令名 → 按这个名字在 PATH 里找', async t => {
  const sb = sandbox(t);
  const pathDir = sb.p('PATH 目录');
  sb.native(path.join(pathDir, 'agy.exe'), '1.5.10');
  const renamed = sb.native(path.join(pathDir, 'agy-dev.exe'), '1.6.0');
  sb.env.PATH = pathDir;
  const full = sb.native(sb.p('指定的', 'agy.exe'), '1.5.13');
  sb.env.AI_HUB_ANTIGRAVITY_COMMAND = full;
  let r = await sb.locator().locate('antigravity', { fresh: true });
  assert.equal(r.chosen.source, 'env-override');
  assert.equal(r.chosen.path, full);
  assert.equal(r.candidates.length, 1);
  sb.env.AI_HUB_ANTIGRAVITY_COMMAND = 'agy-dev';
  r = await sb.locator().locate('antigravity', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.path, renamed);
});

test('显式 8：没有 LOCALAPPDATA 时按 AI_HUB_ANTIGRAVITY_HOME 找 <它>\\AppData\\Local\\agy\\bin（改版前 antigravity-config 的规则）', async t => {
  const sb = sandbox(t);
  delete sb.env.LOCALAPPDATA;
  const agyHome = sb.p('另一个主目录');
  const exe = sb.native(path.join(agyHome, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), '1.5.13');
  sb.env.AI_HUB_ANTIGRAVITY_HOME = agyHome;
  const r = await sb.locator().locate('antigravity', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'official');
  assert.equal(r.chosen.path, exe);
});

test('显式 9：AI_HUB_CODEAGENT_COMMAND 给完整路径 → 只认它（不按「取最新」换成另一份）', async t => {
  const sb = sandbox(t);
  const newer = sb.native(sb.p('CodeAgent 新', 'codeagent.exe'), 'codeagent 1.2620.01.01');
  sb.env.PATH = path.dirname(newer);
  const mine = sb.native(sb.p('CodeAgent 指定', 'codeagent.exe'), 'codeagent 1.2615.02.05');
  sb.env.AI_HUB_CODEAGENT_COMMAND = mine;
  const loc = sb.locator();
  const r = await loc.locate('codeagent', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.source, 'env-override');
  assert.equal(r.chosen.path, mine);
  assert.equal(r.candidates.length, 1);
  assertSameCommand(sb, loc, 'codeagent');
});

test('显式 10：Hub 设置 providers.codeagent.command 给完整路径 → 只认它；路径已经不在 → 当没指定，照常自动找', async t => {
  const sb = sandbox(t);
  const auto = sb.native(sb.p('CodeAgent 自动', 'codeagent.exe'), 'codeagent 1.2620.01.01');
  sb.env.PATH = path.dirname(auto);
  const mine = sb.native(sb.p('CodeAgent 设置的', 'codeagent.exe'), 'codeagent 1.2615.02.05');
  sb.config = { providers: { codeagent: { command: mine } } };
  let r = await sb.locator().locate('codeagent', { fresh: true });
  assert.equal(r.chosen.source, 'setting');
  assert.equal(r.chosen.path, mine);
  assert.equal(r.candidates.length, 1);
  sb.config = { providers: { codeagent: { command: sb.p('已删掉', 'codeagent.exe') } } };
  r = await sb.locator().locate('codeagent', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  assert.equal(r.chosen.path, auto);
});

test('追加 1：「重新体检」真重测——env-check:run 收 {fresh} 传给那一轮 locateAll；打开体检（fresh:false）复用缓存', async t => {
  const sb = sandbox(t);
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322');
  const loc = sb.locator();
  const seen = [];
  const origAll = loc.locateAll.bind(loc);
  loc.locateAll = opts => { seen.push(opts.fresh); return origAll(opts); };
  // 一层：体检那一轮按 ctx.locateFresh 调 locateAll。
  const envCheck = require('../core/env-check');
  const runRow = async locateFresh => {
    const ctx = { env: sb.env, platform: 'win32', locator: loc, kindAllowed: () => true, getConfig: () => ({}), locateRound: {}, locateFresh };
    await envCheck.probeList(ctx).find(p => p.id === 'claude').run();
  };
  await runRow(true);
  const runsAfterFresh = sb.calls.length;
  await runRow(false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(sb.calls.length, runsAfterFresh, '打开体检复用 2 分钟内的结论，不再试跑');
  await runRow(true);
  assert.ok(sb.calls.length > runsAfterFresh, '重新体检真的重新试跑');
  // 二层：IPC 把 {fresh} 透传进体检；不传按 true。
  const got = [];
  const orig = envCheck.runEnvCheck;
  envCheck.runEnvCheck = async ctx => { got.push(ctx.locateFresh); return { items: [] }; };
  t.after(() => { envCheck.runEnvCheck = orig; });
  const handlers = {};
  require('../main/ipc/env-check-handlers').registerEnvCheckIpc({ handle: (n, fn) => { handlers[n] = fn; } }, { dataDir: () => sb.p('hub-data'), version: () => 't', isCompany: () => false, assistant: () => null, locator: () => loc });
  await handlers['env-check:run'](null, { fresh: false });
  await handlers['env-check:run'](null, { fresh: true });
  await handlers['env-check:run'](null);
  assert.deepEqual(got, [false, true, true]);
  // 打开体检还在跑时点了「重新体检」：不共用那一次，等它完再真重测一轮。
  got.length = 0;
  const a = handlers['env-check:run'](null, { fresh: false });
  const b = handlers['env-check:run'](null, { fresh: true });
  await Promise.all([a, b]);
  assert.deepEqual(got, [false, true]);
});

test('e2e 隔离：测试实例（CLAUDE_HUB_E2E_FAKE_HOME / WINDOW_MODE）不读真机注册表和假 HOME 外的安装目录；PATH、假 HOME 里的照常', async t => {
  const sb = sandbox(t);
  const machine = sb.p('真机', 'bin');
  sb.native(path.join(machine, 'claude.exe'), '2.1.322');
  sb.registry = [machine];
  const pfNode = sb.p('Program Files', 'nodejs'); sb.node(pfNode, '24.12.0'); // 假 HOME 外的本机 Node
  sb.dshFull(path.join(sb.env.APPDATA, 'npm'));
  // 正式实例：注册表 PATH 和 Program Files 里的都认（行为不变）。
  let r = await sb.locator().locate('claude', { fresh: true });
  assert.equal(r.chosen && r.chosen.source, 'registry-path');
  assert.equal((await sb.locator().locate('dsh', { fresh: true })).verdict, 'ok');
  for (const flag of [['CLAUDE_HUB_E2E_FAKE_HOME', '1'], ['CLAUDE_HUB_E2E_WINDOW_MODE', 'background']]) {
    delete sb.env.CLAUDE_HUB_E2E_FAKE_HOME; delete sb.env.CLAUDE_HUB_E2E_WINDOW_MODE;
    sb.env[flag[0]] = flag[1];
    r = await sb.locator().locate('claude', { fresh: true });
    assert.equal(r.verdict, 'not-found', `${flag[0]}：不认注册表 PATH 里的`);
    const dsh = await sb.locator().locate('dsh', { fresh: true });
    assert.notEqual(dsh.verdict, 'ok', `${flag[0]}：不借 Program Files 里的 Node`);
    const own = sb.locator({ readRegistryPath: undefined, readCodeagentInstalls: undefined });
    assert.deepEqual(await own.readRegistryPath(), [], '默认不读注册表');
    assert.deepEqual(await own.readCodeagentInstalls(), []);
  }
  sb.env.PATH = pfNode; // 测试自己放进 PATH 的照常
  assert.equal((await sb.locator().locate('dsh', { fresh: true })).verdict, 'ok');
  sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322'); // 假 HOME 里的官方目录照常
  assert.equal((await sb.locator().locate('claude', { fresh: true })).chosen.source, 'official');
});

// 2026-11-21 公开版用词合规：内部 npm 源不再按公司域名认，改成「registry= 不是公网 npm 就算内部源」。
test('.npmrc 的 registry 不是公网 npm（npmjs / npmmirror 等）就当内部源；只有作用域源或没有 .npmrc 不算', t => {
  const { internalNpmRegistry } = require('../core/harness-locator/launch');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-npmrc-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { USERPROFILE: home };
  const rc = text => fs.writeFileSync(path.join(home, '.npmrc'), text);
  assert.equal(internalNpmRegistry(env), false, '没有 .npmrc');
  for (const [text, want] of [
    ['registry=https://registry.npmjs.org/\n', false],
    ['registry = "https://registry.npmmirror.com"\r\n', false],
    ['registry=https://registry.npm.taobao.org/\n', false],
    ['@codehub:registry=https://example.invalid/\nprefix=D:\npm\n', false],
    ['registry=https://repo.example.internal/artifactory/api/npm/npm-remote/\n', true],
    ['registry=https://registry.npmjs.org/\nregistry=http://10.1.2.3:8081/npm/\n', true],
  ]) { rc(text); assert.equal(internalNpmRegistry(env), want, text); }
});

test('安装版：交给系统 Node 的补丁文件走 app.asar.unpacked（系统 Node 读不了 asar），开发目录原样', () => {
  const { unpackedPath } = require('../core/harness-locator/locator');
  const sep = path.win32.sep;
  const packed = ['C:', 'Program Files', 'AI Hub', 'resources', 'app.asar', 'core', 'dsh-windows-link-retry.cjs'].join(sep);
  const unpacked = ['C:', 'Program Files', 'AI Hub', 'resources', 'app.asar.unpacked', 'core', 'dsh-windows-link-retry.cjs'].join(sep);
  assert.equal(unpackedPath(packed), unpacked);
  assert.equal(unpackedPath(unpacked), unpacked, '已经是 unpacked 的不再改');
  assert.equal(unpackedPath('/opt/hub/resources/app.asar/core/x.cjs'), '/opt/hub/resources/app.asar.unpacked/core/x.cjs');
  const dev = path.join(__dirname, '..', 'core', 'dsh-windows-link-retry.cjs');
  assert.equal(unpackedPath(dev), dev, '开发目录没有 app.asar，原样返回');
  const unpack = require('../package.json').build.asarUnpack;
  assert.ok(unpack.includes('core/dsh-windows-link-retry.cjs'), '打包时确实把补丁解压出来');
});

test('安装版试跑 DSH：--require 的补丁指向 app.asar.unpacked，不指向系统 Node 读不了的 app.asar', async t => {
  const sb = sandbox(t);
  const nodeDir = sb.p('Program Files', 'nodejs'); sb.node(nodeDir, '24.14.0'); sb.env.PATH = nodeDir;
  const hubDir = sb.p('hub-tools', 'dsh', '0.2.1-rc.2');
  sb.npmPackage(hubDir, { cmd: 'dsh', pkg: '@deepseek-ai/dsh', version: '0.2.1-rc.2', binRel: 'lib/bin.js' });
  sb.file(path.join(hubDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.2' }));
  const tuiDir = path.join(hubDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  sb.file(path.join(tuiDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.16.1', peerDependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.2', '@deepseek-ai/dsh-app-boot': '^0.1.0' } }));
  fs.mkdirSync(path.join(tuiDir, 'tui-profile'), { recursive: true });
  sb.hub.dsh = { dir: hubDir, version: '0.2.1-rc.2', bin: null };
  const resources = sb.p('Programs', 'AI Hub', 'resources');
  const loc = sb.locator({ runtimeDir: path.join(resources, 'app.asar', 'core') });
  const r = await loc.locate('dsh', { fresh: true });
  assert.equal(r.verdict, 'ok', r.reason);
  const boot = sb.calls.find(c => c.args.includes('--dump-config'));
  assert.equal(boot.args[0], '--require');
  assert.equal(boot.args[1], path.join(resources, 'app.asar.unpacked', 'core', 'dsh-windows-link-retry.cjs'));
});

test('定时复查（R40b）：程序文件没动就沿用上次试跑结论，不起 --version；改了文件或过了 1 小时就真跑', async t => {
  const sb = sandbox(t);
  const exe = sb.native(path.join(sb.home, '.local', 'bin', 'claude.exe'), '2.1.322 (Claude Code)');
  let clock = Date.now();
  const loc = sb.locator({ now: () => clock });
  assert.equal((await loc.locate('claude', { fresh: true })).verdict, 'ok');
  const probes = () => sb.calls.filter(c => c.command.toLowerCase() === exe.toLowerCase()).length;
  const first = probes();
  assert.ok(first >= 1);
  clock += 10 * 60000; await loc.recheckAll();
  assert.equal(probes(), first, '文件没动：复查不起子进程');
  assert.equal(loc.cache.get('claude').verdict, 'ok', '沿用的结论仍是能用');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(exe, later, later);
  clock += 10 * 60000; await loc.recheckAll();
  assert.equal(probes(), first + 1, '原地升级（修改时刻变了）：复查真跑一次');
  clock += 61 * 60000; await loc.recheckAll();
  assert.equal(probes(), first + 2, '超过 1 小时：即使文件没动也真跑一次');
});
