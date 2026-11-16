'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const compat = require('../core/dsh-tools-compat');
const npm = require('../core/cli-tools/npm-fallback');
const { createCliInstaller } = require('../core/cli-tools/installer');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, data = '{}') => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  return { root, put };
}
for (const [label, mode, expected] of [['accepts native', { enum: ['native', null] }, true], ['nullable only', { type: 'null' }, false]]) {
  test('company route reads installed schema and ' + label, t => {
    const { root, put } = fixture(t);
    put('node_modules/@deepseek-ai/dsh/lib/bin.js');
    put('node_modules/@deepseek-ai/dsh-tui/package.json');
    put('node_modules/@deepseek-ai/dsh-tools/package.json');
    put('node_modules/@deepseek-ai/dsh-tools/schema.json', JSON.stringify({ properties: { mode } }));
    require('../core/company-model-proxy').ensureEndpoint(root);
    const opts = require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp', { id: 'schema-session', cwd: root }, {
      companyCli: true, dshBackend: 'proxy', acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { cliRoot: root } } },
    }, root, { PATH: process.env.PATH });
    const patchFile = opts.launch.args[opts.launch.args.indexOf('--patch') + 1];
    const patches = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
    assert.equal(patches.some(p => p.id === 'tools' && p.config.mode === 'native'), expected);
    const profile = JSON.parse(fs.readFileSync(path.join(opts.home, '.dsh/profiles/hub-cli/package.json'), 'utf8'));
    assert.ok(profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-tui'));
  });
}
test('source schema handles multiline enum and nullable definitions without executing plugin code', () => {
  assert.equal(compat.sourceAcceptsNative("const Config = Schema.object({ mode: Schema.union([\n Schema.const('native'), Schema.const(null)\n]), other: Schema.string() });"), true);
  assert.equal(compat.sourceAcceptsNative("const Config = Schema.object({ mode: Schema.const(null), other: Schema.const('native') });"), false);
  assert.deepEqual(compat.companyToolsPatch({}), [{ id: 'tools', config: { mode: 'native' } }]);
  assert.equal(compat.sourceAcceptsNative("const unrelated = { mode: Schema.string() }; const Config = Schema.object({ mode: Schema.const(null) });"), false);
  assert.equal(compat.sourceAcceptsNative("const unrelated = { mode: Schema.const(null) }; const Config = Schema.object({ nested: { mode: Schema.const(null) }, mode: Schema.string() });"), true);
  assert.equal(compat.sourceAcceptsNative("const unrelated = { mode: Schema.const(null) };"), null);
  assert.equal(compat.sourceAcceptsNative("const Config = Schema.object({ mode: Schema.const(null) }); const tool = { config: { mode: Schema.string() } };"), false);
  assert.equal(compat.sourceAcceptsNative("const tool = { config: { mode: Schema.const(null) } };"), null);
  assert.equal(compat.schemaAcceptsNative({ anyOf: [{ $ref: '#/$defs/mode' }, { type: 'null' }] }), null);
});
function mockNpm(f) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'view') return args.length === 3 ? '0.3.0' : '{"version":"0.3.0"}';
    if (args[0] === 'install') {
      // 全局模式（--global）和 npm 一样：模块进全局布局的 node_modules，命令入口 dsh.cmd 生成在全局目录本身。
      const target = args[args.indexOf('--prefix') + 1], global = args.includes('--global');
      const layout = global ? npm.globalLayout(target) : { modules: path.join(target, 'node_modules'), shims: [] };
      const prefix = path.relative(f.root, layout.modules);
      f.put(path.join(prefix, '@deepseek-ai/dsh/lib/bin.js'));
      f.put(path.join(prefix, '@deepseek-ai/dsh/package.json'), '{"version":"0.3.0"}');
      f.put(path.join(prefix, '@deepseek-harness-tui/dsh-tui/package.json'), '{"version":"0.3.0"}');
      f.put(path.join(prefix, '@deepseek-ai/dsh-tui/package.json'), '{"version":"0.3.0"}');
      for (const shim of layout.shims) f.put(path.relative(f.root, shim), '@echo off');
      return 'installed';
    }
    if (args[0] === 'prefix') return f.root;
    throw new Error('unexpected npm call');
  };
  return { calls, run };
}
test('DSH failed component route retries once via npm and keeps user registry/proxy settings', async t => {
  const f = fixture(t), m = mockNpm(f), states = [];
  const env = { ...process.env, AI_HUB_CLI_TOOLS_DIR: path.join(f.root, 'tools'), NPM_CONFIG_REGISTRY: 'https://user-source.invalid/', HTTPS_PROXY: 'http://user-proxy.invalid:8080' };
  const installer = createCliInstaller({ env, npmRun: m.run, onState: state => states.push(state) });
  const result = await installer.install('dsh');
  assert.equal(result.tools.dsh.phase, 'done');
  assert.equal(result.tools.dsh.source, 'user-npm');
  assert.equal(states.some(s => s.tools.dsh.phase === 'npm-fallback'), true);
  const target = path.join(env.AI_HUB_CLI_TOOLS_DIR, 'dsh', 'user-npm');
  assert.deepEqual(m.calls.map(c => c.args), [ ['view', '@deepseek-ai/dsh', 'version'], ['view', '@deepseek-ai/dsh-tui@0.3.0', 'version', 'peerDependencies', '--json'], ['install', '--prefix', target, '@deepseek-ai/dsh@0.3.0', '@deepseek-ai/dsh-tui@0.3.0'] ]);
  assert.equal(require('../core/cli-tools/registry').managedDshRoot(env), target);
  assert.equal(m.calls.every(c => c.options.env === env), true);
  assert.equal(env.NPM_CONFIG_REGISTRY, 'https://user-source.invalid/');
  assert.equal((await installer.install('codex')).tools.codex.phase, 'error');
  assert.equal(m.calls.length, 3, 'normal other CLI installation never changes route');
});
test('explicit DSH repair fixes the user npm install directly, without a component mirror', async t => {
  const f = fixture(t), m = mockNpm(f);
  const result = await createCliInstaller({ env: { ...process.env, AI_HUB_CLI_TOOLS_DIR: path.join(f.root, 'tools') }, getDshEntry: () => ({ cliRoot: f.root }), npmRun: m.run }).install('dsh', { repair: true });
  assert.equal(result.tools.dsh.phase, 'done');
  assert.equal(m.calls.length, 3);
  assert.deepEqual(m.calls.at(-1).args.slice(0, 4), ['install', '--global', '--prefix', f.root]);
});

test('repair root resolution failure reports an error without launching npm', async t => {
  const f = fixture(t), calls = [];
  t.mock.method(require('../core/dsh-cli-profile'), 'resolveDshCliRuntime', () => { throw new Error('selected runtime missing'); });
  const result = await createCliInstaller({ env: { AI_HUB_CLI_TOOLS_DIR: path.join(f.root, 'tools') }, npmRun: async args => calls.push(args) }).install('dsh', { repair: true });
  assert.equal(result.tools.dsh.phase, 'error');
  assert.match(result.tools.dsh.error, /selected runtime missing/);
  assert.deepEqual(calls, []);
});

test('npm fallback rejects missing or relative target before any npm call', async () => {
  for (const targetRoot of [undefined, null, '', 'relative']) {
    await assert.rejects(npm.installDshWithUserNpm({ targetRoot, run: () => assert.fail('must not launch npm') }), /显式指定绝对路径/);
  }
});
test('published legacy TUI scope uses its own version and pins all missing DSH peers to the CLI release', async t => {
  const f = fixture(t), calls = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === 'view' && args[1] === '@deepseek-ai/dsh') return '0.2.2-rc.1';
    if (args[0] === 'view' && args[1].startsWith('@deepseek-ai/dsh-tui@')) throw Object.assign(new Error('E404'), { stderr: 'E404 Not found' });
    if (args[0] === 'view') return JSON.stringify({ version: '0.20.1', peerDependencies: {
      '@deepseek-ai/dsh-user-questions': '0.2.1-rc.2 || 0.2.2-rc.1', '@deepseek-ai/dsh-llm-pi-ai': '0.2.2-rc.1', react: '^19.0.0',
    } });
    if (args[0] === 'install') {
      f.put('node_modules/@deepseek-ai/dsh/lib/bin.js'); f.put('node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.2-rc.1"}');
      f.put('node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{"version":"0.20.1"}');
      for (const p of ['dsh-user-questions', 'dsh-llm-pi-ai']) f.put('node_modules/@deepseek-ai/' + p + '/package.json', '{"version":"0.2.2-rc.1"}');
      return '';
    }
    return f.root;
  };
  const result = await npm.installDshWithUserNpm({ run, targetRoot: f.root });
  assert.equal(result.tuiName, '@deepseek-harness-tui/dsh-tui');
  assert.deepEqual(calls.find(a => a[0] === 'install'), ['install', '--prefix', f.root, '@deepseek-ai/dsh@0.2.2-rc.1', '@deepseek-harness-tui/dsh-tui@0.20.1', '@deepseek-ai/dsh-user-questions@0.2.2-rc.1', '@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1']);
});
test('npm process is hidden, uses user home and passes cancellation without shell setting overrides', async t => {
  const f = fixture(t), controller = new AbortController();
  const env = { PATH: '', USERPROFILE: f.root, npm_config_registry: 'user-value' };
  let observed;
  const output = await npm.runNpm(['view', '@deepseek-ai/dsh', 'version'], { env, signal: controller.signal, platform: 'win32',
    exec: (file, args, options, callback) => { observed = { file, args, options }; callback(null, '0.3.0', ''); } });
  assert.equal(output, '0.3.0');
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.cwd, f.root);
  assert.equal(observed.options.env, env);
  assert.match(observed.args.at(-1), /& npm 'view' '@deepseek-ai\/dsh' 'version'/);
});
test('PowerShell npm shim cancellation terminates this invocation tree and rejects without leaving npm running', async t => {
  const f = fixture(t), controller = new AbortController(), killed = [];
  const child = { pid: 87654 };
  const pending = npm.runNpm(['install', '--global', 'fixture'], { env: { PATH: '', USERPROFILE: f.root }, signal: controller.signal, platform: 'win32',
    exec: () => child, kill: (got, platform) => killed.push([got.pid, platform]) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(killed, [[87654, 'win32']]);
  let command;
  npm.killNpmTree(child, 'win32', (file, args, options) => { command = { file, args, options }; });
  assert.deepEqual(command, { file: 'taskkill.exe', args: ['/PID', '87654', '/T', '/F'], options: { windowsHide: true } });
});
test('npm cancellation waits until the tree termination finishes before releasing the install slot', async t => {
  const f = fixture(t), controller = new AbortController();
  let completeKill, settled = false;
  const pending = npm.runNpm(['install'], { env: { PATH: '', USERPROFILE: f.root }, signal: controller.signal, platform: 'win32',
    exec: () => ({ pid: 12345 }), kill: () => new Promise(resolve => { completeKill = resolve; }) });
  const caught = pending.catch(error => { settled = true; assert.equal(error.name, 'AbortError'); });
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  completeKill();
  await caught;
  assert.equal(settled, true);
});
test('repair retains selected non-global runtime and fills missing same-family plugin there', async t => {
  const f = fixture(t), calls = [];
  f.put('node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.put('node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.1-rc.2"}');
  f.put('node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{"version":"0.16.1"}');
  const env = { ...process.env, AI_HUB_CLI_TOOLS_DIR: path.join(f.root, 'tools') };
  const npmRun = async args => {
    calls.push(args);
    if (args[0] === 'view') return '{"version":"0.16.1","peerDependencies":{"@deepseek-ai/dsh-user-questions":"0.2.1-rc.2"}}';
    assert.deepEqual(args.slice(0, 4), ['install', '--global', '--prefix', f.root]);
    f.put('node_modules/@deepseek-ai/dsh-user-questions/package.json', '{"version":"0.2.1-rc.2"}');
    f.put('dsh.cmd', '@echo off');
    return '';
  };
  const entry = { cliRoot: f.root };
  const result = await createCliInstaller({ env, npmRun, getDshEntry: () => entry }).install('dsh', { repair: true });
  assert.equal(result.tools.dsh.phase, 'done');
  assert.equal(result.tools.dsh.version, '0.2.1-rc.2');
  assert.deepEqual(calls, [['view', '@deepseek-harness-tui/dsh-tui@0.16.1', 'version', 'peerDependencies', '--json'],
    ['install', '--global', '--prefix', f.root, '@deepseek-ai/dsh@0.2.1-rc.2', '@deepseek-harness-tui/dsh-tui@0.16.1', '@deepseek-ai/dsh-user-questions@0.2.1-rc.2']]);
  const picked = require('../core/dsh-cli-profile').resolveDshCliRuntime(entry, env);
  assert.equal(picked.root, f.root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(picked.modules, '@deepseek-ai/dsh-user-questions/package.json'), 'utf8')).version, '0.2.1-rc.2');
});
test('new core with old TUI selects latest compatible TUI from actual npm peer metadata and fills all matching peers', async t => {
  const f = fixture(t), calls = [];
  f.put('node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.put('node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.2-rc.1"}');
  f.put('node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{"version":"0.16.1"}');
  const oldMeta = require('./fixtures/dsh-tui/0.16.1.json');
  const newMeta = require('./fixtures/dsh-tui/0.20.1.json');
  const run = async args => {
    calls.push(args);
    if (args[0] === 'view') return JSON.stringify(args[1].endsWith('@0.16.1') ? oldMeta : newMeta);
    for (const spec of args.slice(3)) {
      const split = spec.lastIndexOf('@');
      f.put('node_modules/' + spec.slice(0, split) + '/package.json', JSON.stringify({ version: spec.slice(split + 1) }));
    }
    return '';
  };
  const result = await npm.installDshWithUserNpm({ targetRoot: f.root, run });
  assert.equal(result.version, '0.2.2-rc.1');
  assert.equal(result.tuiVersion, '0.20.1');
  assert.deepEqual(calls.slice(0, 2).map(a => a[1]), ['@deepseek-harness-tui/dsh-tui@0.16.1', '@deepseek-harness-tui/dsh-tui']);
  const install = calls.find(a => a[0] === 'install');
  assert.equal(install.includes('@deepseek-harness-tui/dsh-tui@0.16.1'), false);
  assert.ok(install.includes('@deepseek-harness-tui/dsh-tui@0.20.1'));
  assert.ok(install.includes('@deepseek-ai/dsh-user-questions@0.2.2-rc.1'));
  assert.ok(install.includes('@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1'));
  assert.equal(install.filter(a => /^@deepseek-ai\/dsh-/.test(a)).length, 37);
});
test('latest TUI still incompatible reports organization mismatch before changing selected runtime', async t => {
  const f = fixture(t), calls = [];
  f.put('node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.2-rc.1"}');
  f.put('node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{"version":"0.16.1"}');
  const run = async args => {
    calls.push(args);
    return JSON.stringify({ version: args[1].endsWith('@0.16.1') ? '0.16.1' : '0.20.1', peerDependencies: { '@deepseek-ai/dsh-user-questions': '0.2.1-rc.2' } });
  };
  await assert.rejects(npm.installDshWithUserNpm({ targetRoot: f.root, run }), /组织版本不匹配/);
  assert.equal(calls.some(a => a[0] === 'install'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'node_modules/@deepseek-harness-tui/dsh-tui/package.json'), 'utf8')).version, '0.16.1');
});
for (const range of ['^0.2.1-rc.1', '~0.2.1-rc.1', '*', '>=0.2.0']) test('valid semver ' + range + ' retains compatible installed TUI', async t => {
  const f = fixture(t), calls = [];
  f.put('node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.put('node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.1-rc.2"}');
  f.put('node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{"version":"0.16.1"}');
  const run = async args => {
    calls.push(args);
    if (args[0] === 'view') return JSON.stringify({ version: '0.16.1', peerDependencies: { '@deepseek-ai/dsh-user-questions': range } });
    f.put('node_modules/@deepseek-ai/dsh-user-questions/package.json', '{"version":"0.2.1-rc.2"}');
    return '';
  };
  assert.equal((await npm.installDshWithUserNpm({ targetRoot: f.root, run })).tuiVersion, '0.16.1');
  assert.equal(calls.filter(a => a[0] === 'view').length, 1);
});
test('missing dependency error includes paired-install hint and adjacent existing repair action', t => {
  const f = fixture(t);
  const { DshCliSession } = require('../core/dsh-cli-session');
  const session = new DshCliSession({ home: f.root, id: 'missing', launch: { args: [] } });
  session.output = "Error: Cannot find package '@deepseek-ai/dsh-user-questions'";
  session.fail(new Error('DSH CLI 已退出'));
  assert.match(session.runtime.reason, /@deepseek-ai\/dsh 和 @deepseek-harness-tui\/dsh-tui/);
  const html = require('../renderer/hub-error-card').html({ area: 'session-create', details: session.runtime.reason });
  assert.match(html, /data-hub-err-act="known:dsh-repair"/);
  assert.match(html, /一键修复 DSH/);
});
