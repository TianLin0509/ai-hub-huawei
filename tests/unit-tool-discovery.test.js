'use strict';
// 外部工具自动发现与多版本选择（2026-11-07，5.5.24）：用假目录和假程序覆盖 0 个、1 个、多个不同版本、多个同版本、
// 已指定的路径失效后回到扫描；以及 CodeAgent 的扫描范围、welink-cli 全盘找收集多个结果、PPT Doctor 指定失效后回扫描。
// 假程序都是 .js（用 Hub 自己的 Node 跑）或调用 Node 的 .cmd，不碰真实的 welink-cli / CodeAgent / PPT Doctor。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../core/tool-discovery/candidates');
const { ToolDiscovery } = require('../core/tool-discovery');
const tools = require('../core/tool-discovery/tools');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
// 假程序：--version 打印给定版本；version 为 null 时退出码 1、什么都不打（= 跑不起来）。
function fakeTool(dir, name, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, version == null ? 'process.exit(1);\n' : `process.stdout.write(${JSON.stringify(version + '\n')}, () => process.exit(0));\n`);
  return file;
}
// 假 CodeAgent：codeagent.cmd 调用 Node 跑旁边的脚本（PATH 里不需要有 node）。
function fakeCodeAgent(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake.js'), `process.stdout.write(${JSON.stringify(version + ' (codeAgentCLI)\n')}, () => process.exit(0));\n`);
  fs.writeFileSync(path.join(dir, 'codeagent.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "%~dp0fake.js" %*\r\n`);
  return path.join(dir, 'codeagent.cmd');
}
const probe = file => C.probeVersion(file, { timeoutMs: 15000 });
// 内存里的适配器：候选来自给定列表，设置存在变量里。
function memoryAdapter(entries, configured = '') {
  const box = { configured, writes: [] };
  box.adapter = { label: '测试工具', list: async () => entries(), probe, getConfigured: () => box.configured, setConfigured: f => { box.configured = f; box.writes.push(f); } };
  return box;
}

test('版本比较：逐段按数字比，缺段当 0，读不懂的排最后', () => {
  assert.equal(C.compareVersions('1.2615.02.01', '1.2615.2.1'), 0);
  assert.equal(C.compareVersions('1.0.20', '1.0.14'), 1);
  assert.equal(C.compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(C.compareVersions(null, '0.0.1'), -1);
});

test('choose：0 个 / 1 个 / 多个不同版本 / 多个同版本 / 已指定 / 已指定失效', () => {
  const c = (p, version, order) => ({ path: p, version, order, key: p.toLowerCase() });
  assert.equal(C.choose([]).reason, 'none');
  const one = C.choose([c('C:\\a\\x.exe', '1.0.0', 0)]);
  assert.equal(one.reason, 'only'); assert.equal(one.writeBack, true);
  const multi = C.choose([c('C:\\a\\x.exe', '1.0.14', 0), c('C:\\b\\x.exe', '1.0.20', 1), c('C:\\c\\x.exe', null, 2)]);
  assert.equal(multi.reason, 'newest'); assert.equal(multi.pick.path, 'C:\\b\\x.exe'); assert.equal(multi.writeBack, false); assert.equal(multi.versions, 3);
  assert.deepEqual(multi.candidates.map(x => x.version), ['1.0.20', '1.0.14', null]);
  const same = C.choose([c('C:\\b\\x.exe', '2.0.0', 1), c('C:\\a\\x.exe', '2.0', 0)]);
  assert.equal(same.reason, 'same'); assert.equal(same.pick.path, 'C:\\a\\x.exe', '同版本按发现顺序（优先级）取第一个');
  const kept = C.choose([c('C:\\a\\x.exe', '1.0.14', 0), c('C:\\b\\x.exe', '1.0.20', 1)], 'C:\\a\\x.exe');
  assert.equal(kept.reason, 'configured'); assert.equal(kept.pick.path, 'C:\\a\\x.exe');
  const gone = C.choose([c('C:\\a\\x.exe', '1.0.14', 0)], 'C:\\gone\\x.exe');
  assert.equal(gone.configuredMissing, true); assert.equal(gone.reason, 'only'); assert.equal(gone.pick.path, 'C:\\a\\x.exe');
});

test('collectCandidates：读出版本、按真实路径去重、过滤掉跑不起来的', async () => {
  const root = tmp('tool-disc-collect-');
  const a = fakeTool(path.join(root, 'a'), 'tool.js', '1.0.14');
  const b = fakeTool(path.join(root, 'b'), 'tool.js', '1.0.20');
  const broken = fakeTool(path.join(root, 'c'), 'tool.js', null);
  const dupe = process.platform === 'win32' ? a.toUpperCase() : a;
  const list = await C.collectCandidates([a, { path: dupe, via: 'path' }, b, broken, path.join(root, 'missing.js'), 'relative.js'], { probe });
  assert.deepEqual(list.map(x => [path.basename(path.dirname(x.path)), x.version]), [['a', '1.0.14'], ['b', '1.0.20']]);
});

test('ToolDiscovery：0 个 → 无；1 个 → 自动用并写回；多个不同版本 → 先用最新并提示；用户选完不再提示', async () => {
  const root = tmp('tool-disc-flow-');
  let entries = [];
  const box = memoryAdapter(() => entries);
  const d = new ToolDiscovery({ dataDir: root }).register('t', box.adapter);
  let s = await d.list('t', { force: true });
  assert.equal(s.current, null); assert.equal(s.needsPick, false); assert.deepEqual(box.writes, []);

  const old = fakeTool(path.join(root, 'old'), 'tool.js', '1.0.14');
  entries = [old];
  s = await d.list('t', { force: true });
  assert.equal(s.reason, 'only'); assert.equal(s.current.path, old); assert.deepEqual(box.writes, [old]);

  const neu = fakeTool(path.join(root, 'new'), 'tool.js', '1.0.20');
  entries = [old, neu];
  box.configured = ''; // 还没选过
  s = await d.list('t', { force: true });
  assert.equal(s.reason, 'newest'); assert.equal(s.needsPick, true); assert.equal(s.current.version, '1.0.20');
  assert.equal(d.pick('t'), neu, '同步调用方拿到最新的那份');
  assert.deepEqual(s.candidates.map(x => [x.version, x.recommended, x.current]), [['1.0.20', true, true], ['1.0.14', false, false]]);

  s = await d.use('t', old);
  assert.equal(s.reason, 'configured'); assert.equal(s.needsPick, false); assert.equal(s.current.path, old); assert.equal(box.configured, old);
  await assert.rejects(d.use('t', path.join(root, 'nope.js')), /打不开|校验/);
});

test('ToolDiscovery：多份同版本按优先级取一份、写回、不提示', async () => {
  const root = tmp('tool-disc-same-');
  const first = fakeTool(path.join(root, 'p1'), 'tool.js', '3.1.0');
  const second = fakeTool(path.join(root, 'p2'), 'tool.js', '3.1.0');
  const box = memoryAdapter(() => [first, second]);
  const s = await new ToolDiscovery({ dataDir: root }).register('t', box.adapter).list('t');
  assert.equal(s.reason, 'same'); assert.equal(s.needsPick, false); assert.equal(s.current.path, first); assert.equal(box.configured, first);
});

test('ToolDiscovery：用户指定的路径被卸载后自动回到扫描，不一直报错', async () => {
  const root = tmp('tool-disc-gone-');
  const chosen = fakeTool(path.join(root, 'chosen'), 'tool.js', '2.0.0');
  const other = fakeTool(path.join(root, 'other'), 'tool.js', '1.5.0');
  const box = memoryAdapter(() => [box.configured, other].filter(Boolean), chosen);
  const d = new ToolDiscovery({ dataDir: root }).register('t', box.adapter);
  let s = await d.list('t');
  assert.equal(s.reason, 'configured'); assert.equal(s.current.path, chosen);
  fs.rmSync(path.dirname(chosen), { recursive: true, force: true });
  s = await d.list('t'); // 设置没变但文件没了：缓存仍在 10 分钟内，pick() 已经不返回失效路径
  assert.equal(d.pick('t') === chosen, false);
  s = await d.list('t', { force: true });
  assert.equal(s.configuredMissing, true); assert.equal(s.current.path, other); assert.equal(box.configured, other, '只剩 1 个可用：自动换上并写回');
});

test('ToolDiscovery：CodeAgent 的选择存在 tool-discovery.json，重启后先用上次选中的那份', async () => {
  const root = tmp('tool-disc-store-');
  const a = fakeTool(path.join(root, 'a'), 'tool.js', '1.0.0');
  const picked = [];
  const d = new ToolDiscovery({ dataDir: root });
  d.register('t', { list: async () => [a], probe, getConfigured: () => d.store.choice('t'), setConfigured: f => d.store.setChoice('t', f), onPick: f => picked.push(f) });
  await d.list('t');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'tool-discovery.json'), 'utf8'));
  assert.equal(saved.choices.t, a); assert.equal(saved.last.t, a);
  const again = [];
  const d2 = new ToolDiscovery({ dataDir: root });
  d2.register('t', { list: async () => [], probe, getConfigured: () => d2.store.choice('t'), setConfigured: () => {}, onPick: f => again.push(f) });
  assert.deepEqual(again, [a]); assert.equal(d2.pick('t'), a);
});

test('CodeAgent：除 PATH 外也查 npm 全局目录和常用安装目录；同一目录只算一份；读出各自版本', { skip: process.platform !== 'win32' }, async () => {
  const root = tmp('tool-disc-ca-');
  const onPath = fakeCodeAgent(path.join(root, 'bin-old'), '1.2615.02.01');
  fs.writeFileSync(path.join(root, 'bin-old', 'codeagent.bat'), '@echo off\r\n'); // 同目录的另一种包装，不重复计
  const npmDir = path.join(root, 'npm-global');
  const viaNpm = fakeCodeAgent(npmDir, '1.2620.01.00');
  const localApp = path.join(root, 'local');
  const viaInstall = fakeCodeAgent(path.join(localApp, 'Programs', 'CodeAgent CLI', 'bin'), '1.2620.01.00');
  const env = { PATH: path.join(root, 'bin-old'), npm_config_prefix: npmDir, LOCALAPPDATA: localApp, USERPROFILE: root, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec };
  const store = require('../core/tool-discovery').createStore(root);
  const adapter = tools.codeagentAdapter(store, { env, registryDirs: async () => [], registryInstalls: async () => [] });
  const entries = await adapter.list();
  const files = entries.map(e => e.path);
  assert.ok(files.includes(onPath) && files.includes(viaNpm) && files.includes(viaInstall));
  assert.equal(files.filter(f => path.dirname(f) === path.join(root, 'bin-old')).length, 1);
  const list = await C.collectCandidates(entries, { probe: f => adapter.probe(f) });
  assert.deepEqual(list.map(x => x.version).sort(), ['1.2615.02.01', '1.2620.01.00', '1.2620.01.00']);
  const decision = C.choose(list);
  assert.equal(decision.reason, 'newest'); assert.equal(decision.pick.version, '1.2620.01.00');
});

test('codeagent-config：自动发现的结果只在 PATH 上不是同一份时才换成完整路径；指定的完整路径失效时回到发现结果', () => {
  const config = require('../core/codeagent-config');
  const root = tmp('tool-disc-cfg-');
  const onPath = fakeCodeAgent(path.join(root, 'p'), '1.0.0');
  const other = fakeCodeAgent(path.join(root, 'q'), '2.0.0');
  const env = { PATH: path.join(root, 'p'), USERPROFILE: root };
  assert.equal(config.resolveCodeAgentConfig(env, {}, { decision: null, discovered: null }).command, 'codeagent');
  assert.equal(config.resolveCodeAgentConfig(env, {}, { decision: null, discovered: onPath }).command, 'codeagent', '同一份仍用命令名');
  assert.equal(config.resolveCodeAgentConfig(env, {}, { decision: null, discovered: other }).command, other);
  const gone = path.join(root, 'gone', 'codeagent.cmd');
  assert.equal(config.resolveCodeAgentConfig({ ...env, AI_HUB_CODEAGENT_COMMAND: gone }, {}, { decision: null, discovered: other }).command, other);
  assert.equal(config.resolveCodeAgentConfig({ ...env, AI_HUB_CODEAGENT_COMMAND: gone }, {}, { decision: null, discovered: null }).command, gone, '没有发现结果时保持原样（照旧报未安装）');
});

test('welink-cli 全盘找：注册表 PATH 和 npm prefix 各找到一份时都收集下来', async () => {
  const W = require('../core/company-assistant/welink');
  const root = tmp('tool-disc-welink-');
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'welink-cli.exe'), ''); }
  const execFileImpl = (file, args, opts, cb) => {
    if (path.basename(file).toLowerCase() === 'powershell.exe') return cb(null, Buffer.from(JSON.stringify({ u: a, m: null }), 'utf8').toString('base64'));
    if (file === 'cmd.exe') return cb(null, b + '\r\n');
    return cb(null, '');
  };
  const found = await W.findCliDeep({ env: {}, execFileImpl, roots: [] });
  assert.equal(found.path, path.join(a, 'welink-cli.exe'));
  assert.deepEqual(found.paths.map(p => [p.path, p.via]), [[path.join(a, 'welink-cli.exe'), 'path'], [path.join(b, 'welink-cli.exe'), 'npm']]);
});

test('PPT Doctor：指定的程序被卸载后回到自动发现，不再一直报「不存在」', async () => {
  const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
  const root = tmp('tool-disc-ppt-');
  const found = path.join(root, 'PPT-Doctor.exe'); fs.writeFileSync(found, '');
  const asked = [];
  const toolDiscovery = { has: id => id === 'ppt-doctor', list: async id => { asked.push(id); return { current: { path: found } }; } };
  const doctor = new PptDoctor({ dir: root, settings: () => ({ ppt: { doctorExe: path.join(root, 'gone', 'PPT-Doctor.exe') } }) }, { toolDiscovery });
  try { assert.equal(await doctor.discover(), found); assert.deepEqual(asked, ['ppt-doctor']); }
  finally { doctor.close(); }
  const none = new PptDoctor({ dir: root, settings: () => ({ ppt: { doctorExe: path.join(root, 'gone', 'PPT-Doctor.exe') } }) }, { toolDiscovery: { has: () => true, list: async () => ({ current: null }) } });
  try { await assert.rejects(none.discover(), e => e.code === 'DOCTOR_NOT_FOUND' && /已经不在/.test(e.message)); }
  finally { none.close(); }
});

test('版本选择器：只有多个不同版本且没选过时才出提示；切换入口在有多份时出现', () => {
  const picker = require('../renderer/tool-version-picker');
  const base = { tool: 'codeagent', current: { path: 'C:\\b\\codeagent.cmd', version: '1.2620.01.00' }, candidates: [{ path: 'C:\\b\\codeagent.cmd', version: '1.2620.01.00' }, { path: 'C:\\a\\codeagent.cmd', version: '1.2615.02.01' }] };
  const hint = picker.hintHtml({ ...base, needsPick: true });
  assert.match(hint, /找到 2 个版本的 CodeAgent，当前用 v1\.2620\.01\.00/);
  assert.match(hint, /data-tvp-open="codeagent"/);
  assert.equal(picker.hintHtml({ ...base, needsPick: false }), '');
  assert.match(picker.switchHtml({ ...base, needsPick: false }), /切换版本（2 个）/);
  assert.equal(picker.switchHtml({ ...base, candidates: base.candidates.slice(0, 1) }), '');
  assert.equal(picker.hintHtml(null), '');
});

// 2026-11-12 同事：设置里自动记下的是 UniAssistant 自带的 welink-cli 1.0.16，npm 升到 1.0.20 后 Hub 仍用旧版、扫码失败。
test('choose：自动记下的旧路径遇到更高版本时换成新版并写回；用户亲手选的不动', () => {
  const c = (p, version, order) => ({ path: p, version, order, key: p.toLowerCase() });
  const list = [c('C:/UniAssistant/welink-cli.exe', '1.0.16', 0), c('C:/npm/welink-cli.exe', '1.0.20', 1)];
  const auto = C.choose(list, 'C:/UniAssistant/welink-cli.exe', { configuredByUser: false });
  assert.equal(auto.reason, 'upgraded'); assert.equal(auto.pick.path, 'C:/npm/welink-cli.exe'); assert.equal(auto.writeBack, true);
  const manual = C.choose(list, 'C:/UniAssistant/welink-cli.exe', { configuredByUser: true });
  assert.equal(manual.reason, 'configured'); assert.equal(manual.pick.path, 'C:/UniAssistant/welink-cli.exe');
  const sameVersion = C.choose([c('C:/a/x.exe', '1.0.20', 0), c('C:/b/x.exe', '1.0.20', 1)], 'C:/b/x.exe', { configuredByUser: false });
  assert.equal(sameVersion.reason, 'configured', '版本一样就不折腾');
});

// 2026-11-12 同事：设置里记成了 WeLink 桌面客户端 WeLinkPC.exe，Hub 每次读版本都启动它，单实例客户端就把主窗口弹出来（约每 10 分钟一次）。
test('welink-cli：桌面客户端 WeLinkPC.exe 不运行、不当候选，设置里记错的会被清掉', async () => {
  const W = require('../core/company-assistant/welink');
  const dir = tmp('hub-welinkpc-');
  const client = path.join(dir, 'WeLinkPC.exe');
  fs.writeFileSync(client, 'not a cli');
  assert.equal(W.isCliFile(client), false);
  assert.equal(W.isCliFile(String.raw`C:\npm\node_modules\@welink\welink-cli\welink-cli.exe`), true);
  assert.equal(W.isCliFile(String.raw`C:\Program Files (x86)\WeLink_Desktop\WeLinkPC.exe`), false);
  assert.equal(W.resolveCli({ configured: client, env: { PATH: '' } }) === client, false, 'resolveCli 不能把客户端当 CLI');
  const settings = { cliPath: client, cliPathManual: false };
  const service = { settings: () => settings, setSettings: p => Object.assign(settings, p) };
  const adapter = tools.welinkAdapter(service, { env: { PATH: '' }, registryDirs: async () => [] });
  const probed = [];
  const realProbe = adapter.probe;
  adapter.probe = f => { probed.push(f); return realProbe(f); };
  const d = new ToolDiscovery({ dataDir: dir });
  d.register('welink', adapter);
  const s = await d.list('welink', { force: true });
  assert.equal(s.current, null);
  assert.deepEqual(probed, [], '客户端一次都不能被启动');
  assert.equal(settings.cliPath, '', '记错的路径被清掉，下次不再碰它');
  await assert.rejects(d.use('welink', client), /打不开|校验/);
});
