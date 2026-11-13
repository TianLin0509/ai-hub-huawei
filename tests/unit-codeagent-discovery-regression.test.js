'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registryInstallDirs } = require('../core/tool-discovery/codeagent-install-dirs');
const { ToolDiscovery } = require('../core/tool-discovery');
const { codeagentAdapter } = require('../core/tool-discovery/tools');
const config = require('../core/codeagent-config');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-discovery-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => config.setDiscoveredCommand(null));
  const make = (...parts) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); return file;
  };
  return { root, make };
}

test('CodeAgent 安装记录：隐藏读取卸载项和 App Paths，中文自定义目录不丢失', { skip: process.platform !== 'win32' }, async t => {
  const { root } = fixture(t);
  const install = path.join(root, '非默认目录', '企业工具');
  const appRoot = path.join(root, '应用路径');
  let calls = 0;
  const dirs = await registryInstallDirs({ env: { USERPROFILE: root }, platform: 'win32', execFileImpl(file, args, opts, cb) {
    calls++;
    assert.equal(opts.windowsHide, true); assert.equal(opts.timeout, 8000);
    assert.match(args.at(-1), /CurrentVersion\\Uninstall/);
    assert.match(args.at(-1), /App Paths/);
    assert.match(args.at(-1), /codeagentcli\.exe/);
    cb(null, Buffer.from(JSON.stringify([
      { location: install, icon: `"${path.join(install, 'bin', 'codeagentcli.exe')}",0` },
      { command: path.join(appRoot, 'codeagent.exe') },
      { location: '%USERPROFILE%\\自定义安装' },
      { location: 'relative' },
    ]), 'utf8').toString('base64'));
  } });
  assert.equal(calls, 1);
  assert.deepEqual(dirs, [install, path.join(install, 'bin'), appRoot, path.join(root, '自定义安装')]);
});

test('CodeAgent 安装记录读不到时仍允许后续目录和 PATH 发现', async () => {
  assert.deepEqual(await registryInstallDirs({ platform: 'win32', execFileImpl(_f, _a, _o, cb) { cb(new Error('policy')); } }), []);
  assert.deepEqual(await registryInstallDirs({ platform: 'linux', execFileImpl() { assert.fail('不应启动'); } }), []);
});

test('CodeAgent 非默认安装只有 bin/codeagentcli.exe 且不在 PATH：发现后记住，重开直接复用', { skip: process.platform !== 'win32' }, async t => {
  const { root, make } = fixture(t);
  const exe = make('custom', '企业工具', 'bin', 'codeagentcli.exe');
  const discovery = new ToolDiscovery({ dataDir: path.join(root, 'hub') });
  const adapter = codeagentAdapter(discovery.store, { env: { PATH: '', USERPROFILE: root }, providerConfig: () => ({}), registryDirs: async () => [], registryInstalls: async () => [path.dirname(path.dirname(exe))] });
  adapter.probe = async () => ({ ok: true, version: '3.2.0' });
  discovery.register('codeagent', adapter);
  const found = await discovery.list('codeagent');
  assert.equal(found.current.path, exe); assert.equal(found.current.via, 'registry');
  assert.equal(config.resolveCodeAgentConfig({ PATH: '', USERPROFILE: root }, {}).command, exe);
  assert.equal(config.codeagentInstallDir({ PATH: '', USERPROFILE: root }), path.dirname(path.dirname(exe)));
  config.setDiscoveredCommand(null);
  const again = new ToolDiscovery({ dataDir: path.join(root, 'hub') });
  again.register('codeagent', codeagentAdapter(again.store, { env: { PATH: '' }, providerConfig: () => ({}) }));
  assert.equal(again.pick('codeagent'), exe);
  assert.equal(config.getDiscoveredCommand(), exe, '扫描前已从上次选择恢复');
});

test('CodeAgent 界面手选优先于 provider 命令；provider 保留为兜底候选', { skip: process.platform !== 'win32' }, async t => {
  const { root, make } = fixture(t);
  const explicit = make('chosen', 'codeagent.cmd');
  const registry = make('registry', 'codeagent.cmd');
  const onPath = make('path', 'codeagent.cmd');
  const d = new ToolDiscovery({ dataDir: path.join(root, 'data') });
  d.store.setChoice('codeagent', onPath); // 用户在选择器里的选择优先于 provider 默认命令。
  const env = { PATH: path.dirname(onPath) }, provider = { command: explicit };
  const adapter = codeagentAdapter(d.store, { env, providerConfig: () => provider, registryDirs: async () => [], registryInstalls: async () => [path.dirname(registry)] });
  adapter.probe = async file => ({ ok: true, version: file === explicit ? '1.2605.01.00' : '3.2.0' });
  d.register('codeagent', adapter);
  assert.equal((await d.list('codeagent')).current.path, onPath);
  assert.equal(config.commandFile(config.resolveCodeAgentConfig(env, provider).command, env), onPath, '实际启动也使用手选程序');
  assert.equal(config.resolveCodeAgentConfig({ ...env, AI_HUB_CODEAGENT_COMMAND: explicit }, provider).command, explicit, '环境变量仍可显式覆盖');
  await d.use('codeagent', explicit);
  assert.equal(config.resolveCodeAgentConfig(env, provider).command, explicit, '再次手选立即切换启动命令');
  const entries = await adapter.list();
  assert.ok(entries.some(e => e.path === explicit), 'provider 命令仍可用作兜底');
  assert.ok(entries.findIndex(e => e.path === registry) < entries.findIndex(e => e.path === onPath && e.via === 'path'));
});

test('CodeAgent 没有界面手选时使用 provider 命令', async t => {
  const { root, make } = fixture(t);
  const explicit = make('provider', 'codeagent.cmd');
  const d = new ToolDiscovery({ dataDir: path.join(root, 'data') });
  const adapter = codeagentAdapter(d.store, { env: { PATH: '' }, providerConfig: () => ({ command: explicit }), registryDirs: async () => [], registryInstalls: async () => [] });
  adapter.probe = async () => ({ ok: true, version: '1.2615.0.0' });
  d.register('codeagent', adapter);
  assert.equal((await d.list('codeagent')).current.path, explicit);
});

test('CodeAgent 显式命令已失效：完整路径和 PATH 命令都退回发现结果', { skip: process.platform !== 'win32' }, t => {
  const { root, make } = fixture(t);
  const discovered = make('working', 'codeagent.cmd');
  for (const command of [path.join(root, 'gone', 'codeagent.cmd'), 'gone-codeagent.exe']) {
    const env = { PATH: '', USERPROFILE: root, AI_HUB_CODEAGENT_COMMAND: command };
    assert.equal(config.resolveCodeAgentConfig(env, {}, { discovered }).command, discovered);
    assert.equal(config.resolveCodeAgentConfig(env, {}, { discovered: null }).command, command, '完全没发现时保留原命令供原位置提示');
  }
});

test('CodeAgent 安装记录指向 bin 主程序时优先复用同安装的入口壳', { skip: process.platform !== 'win32' }, t => {
  const { make } = fixture(t);
  const wrapper = make('install', 'codeagent.bat');
  const exe = make('install', 'bin', 'codeagentcli.exe');
  assert.equal(require('../core/tool-discovery/tools').codeagentIn(path.dirname(exe)), wrapper);
});

test('CodeAgent 相对命令已带 .exe/.cmd 扩展名时按原文件名查 PATH', { skip: process.platform !== 'win32' }, t => {
  const { root, make } = fixture(t);
  const exe = make('bin', 'codeagentcli.exe');
  const cmd = make('bin', 'codeagent.cmd');
  const env = { PATH: path.join(root, 'bin') };
  assert.equal(config.commandFile('codeagentcli.exe', env), exe);
  assert.equal(config.commandFile('codeagent.cmd', env), cmd);
});
