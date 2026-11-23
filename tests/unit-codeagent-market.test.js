'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const market = require('../core/codeagent-market');
const { runSkillCommand } = require('../core/codeagent-skill-install');
const { collectCapabilities } = require('../core/capability-catalog');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agentcenter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'home with space', '.cac');
  const manifest = path.join(configDir, 'plugins', 'marketplaces', 'aimarket', '.cac-plugin', 'marketplace.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ plugins: [{ name: 'diagram', version: '1.0', author: { name: '团队' } }],
    skills: [{ name: 'brief', description: '生成简报' }], mcps: [{ name: 'search' }] }));
  return { root, configDir, manifest };
}

test('解析市场清单：三类条目、作者、版本、混合列表、BOM 与去重', () => {
  const rows = market.parseMarketplace('\uFEFF' + JSON.stringify({
    name: 'aimarket', plugins: [{ name: 'toolbox', version: '2', author: { name: 'team' }, description: '说明' }],
    skills: [{ id: 'skill-id', name: '技能', author: '张三' }],
    mcps: [{ name: 'search' }], items: [{ type: 'skill', id: 'skill-id', name: '技能', version: '3' },
      { type: 'skill', name: 'x & calc' }, { type: 'agent', name: 'not-supported' }],
  }));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(row => row.type === 'plugin'), { id: 'plugin:toolbox', installId: 'toolbox', name: 'toolbox',
    type: 'plugin', version: '2', author: 'team', description: '说明' });
  assert.equal(rows.find(row => row.type === 'skill').version, '3');
  assert.equal(market.parseMarketplace([{ name: 'one', kind: 'skills' }])[0].type, 'skill');
  assert.throws(() => market.parseMarketplace('{bad private body'), /格式无效/);
  assert.throws(() => market.parseMarketplace(null), /格式无效/);
});

test('市场文件按本机标准路径读取，缺失与损坏就地给原因，不泄露文件内容', async t => {
  const f = fixture(t);
  assert.equal((await market.readMarketplace(f.configDir)).length, 3);
  fs.renameSync(f.manifest, path.join(path.dirname(path.dirname(f.manifest)), 'marketplace.json'));
  assert.equal((await market.readMarketplace(f.configDir)).length, 3);
  await assert.rejects(market.readMarketplace(path.join(f.root, 'empty')), /还没有 AI 市场副本/);
  fs.writeFileSync(path.join(path.dirname(path.dirname(f.manifest)), 'marketplace.json'), 'private-invalid-json');
  await assert.rejects(market.readMarketplace(f.configDir), error => /格式无效/.test(error.message) && !error.message.includes('private'));
});

test('类型必须是允许表自身的字符串键，原型链键与非字符串不参与排序', () => {
  const badTypes = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 1, {}, [], false];
  const rows = market.parseMarketplace({ skills: badTypes.map((type, i) => ({ type, name: 'bad-' + i })),
    items: badTypes.map((kind, i) => ({ kind, name: 'other-' + i })).concat({ type: 'skill', name: 'valid' }) });
  assert.deepEqual(rows.map(row => row.name), ['valid']);
});

test('条目数限制跨所有类型累计，字段有界且安装标识不会截断执行', () => {
  const entries = Array.from({ length: market.MAX_MARKET_ITEMS }, (_, i) => ({ type: 'skill', name: 'item-' + i }));
  assert.equal(market.parseMarketplace(entries).length, market.MAX_MARKET_ITEMS);
  assert.throws(() => market.parseMarketplace({ skills: entries, mcps: [{ name: 'extra' }] }), /超过 5000 条/);
  const row = market.parseMarketplace({ skills: [{ id: 'valid', name: '名'.repeat(1000), version: 'v'.repeat(1000),
    author: { name: 'a'.repeat(1000) }, description: 'd'.repeat(10000) }, { name: 'x'.repeat(251) }] })[0];
  assert.equal(row.name.length, 250);assert.equal(row.version.length, 80);
  assert.equal(row.author.length, 160);assert.equal(row.description.length, 2000);assert.equal(row.installId, 'valid');
  assert.equal(market.parseMarketplace({ skills: [{ name: 'x'.repeat(251) }] }).length, 0);
});

test('读清单先 stat：超过 8 MB 时不读文件；刚好 8 MB 可以读取', async () => {
  const calls = [];
  const fake = size => ({ stat: async () => { calls.push('stat');return { size }; },
    readFile: async () => { calls.push('read');return '{"skills":[{"name":"valid"}]}'; } });
  await assert.rejects(market.readMarketplace('fake', { fsModule: fake(market.MAX_MARKET_BYTES + 1) }), /超过 8 MB/);
  assert.deepEqual(calls, ['stat']);calls.length = 0;
  assert.equal((await market.readMarketplace('fake', { fsModule: fake(market.MAX_MARKET_BYTES) })).length, 1);
  assert.deepEqual(calls, ['stat', 'read']);
});

test('首个候选 JSON 损坏时继续读下一个，全损坏时只回安全原因', async t => {
  const f = fixture(t), fallback = path.join(path.dirname(path.dirname(f.manifest)), 'marketplace.json');
  fs.writeFileSync(f.manifest, '{private-invalid-json');
  fs.writeFileSync(fallback, '{"skills":[{"name":"fallback"}]}');
  assert.deepEqual((await market.readMarketplace(f.configDir)).map(row => row.name), ['fallback']);
  fs.writeFileSync(fallback, '{another-private-invalid');
  await assert.rejects(market.readMarketplace(f.configDir), error => error.code === 'MARKET_JSON_INVALID' && !error.message.includes('private'));
});

test('可用性探测不读市场、不扫描目录、不启动 CLI，探测异常时不可用', () => {
  for (const [available, expected] of [[() => true, true], [() => false, false], [() => { throw Error('配置损坏'); }, false]]) {
    const service = new market.CodeAgentMarket({ available, config: () => assert.fail('不应读清单'),
      catalog: () => assert.fail('不应扫描目录'), run: () => assert.fail('不应启动 CLI') });
    assert.equal(service.status().available, expected);
  }
});

test('已装判定仅认同一配置的 CodeAgent 用户条目；停用仍是已装，缺文件不算', t => {
  const { configDir } = fixture(t), item = { type: 'plugin', name: 'one', installId: 'one' };
  const source = { agent: 'codeagent', scope: 'user', path: path.join(configDir, 'plugins', 'cache', 'aimarket', 'one', '1'), enabled: false };
  const rows = changes => [{ type: 'plugin', name: 'one@aimarket', sources: [{ ...source, ...changes }] }];
  assert.equal(market.isMarketInstalled(item, rows({}), configDir), true);
  for (const changes of [{ missing: true }, { agent: 'claude' }, { scope: 'project:x' }, { scope: 'profile:x' }, { path: path.join(configDir + '-other', 'settings.json') }, { path: path.join(configDir, 'settings.json') }])
    assert.equal(market.isMarketInstalled(item, rows(changes), configDir), false);
  assert.equal(market.isMarketInstalled({ type: 'mcp', name: 'lookup', installId: 'lookup' }, [
    { type: 'mcp', name: 'lookup', sources: [{ ...source, path: path.join(path.dirname(configDir), '.cac.json') }] },
  ], configDir), true);
});

test('安装命令固定类型、个人范围，禁止从清单注入命令', () => {
  assert.deepEqual(market.installArgs({ type: 'skill', installId: 'one@2' }), ['skills', 'add', 'one@2', '--scope', 'global']);
  assert.deepEqual(market.installArgs({ type: 'plugin', installId: 'one' }), ['plugin', 'install', 'one@aimarket', '--scope', 'user']);
  assert.deepEqual(market.installArgs({ type: 'mcp', installId: 'one' }), ['mcp', 'add', 'one', '--scope', 'user']);
  for (const id of ['--help', 'x & calc', 'x%PATH%', '../x', 'x\ny']) assert.throws(() => market.installArgs({ type: 'skill', installId: id }));
  assert.throws(() => market.installArgs({ type: 'agent', installId: 'x' }));
  const calls = [], args = market.installArgs({ type: 'plugin', installId: 'one' });
  market.launchMarketCommand('D:\\fake bin\\codeagent.cmd', args, {}, { platform: 'win32', spawnImpl: (...call) => calls.push(call) });
  assert.equal(calls[0][0], 'cmd.exe');assert.equal(calls[0][2].windowsHide, true);
  assert.match(calls[0][1].at(-1), /call "D:\\fake bin\\codeagent.cmd" plugin install one@aimarket/);
  assert.throws(() => market.launchMarketCommand('codeagent', ['mcp', 'remove', 'one'], {}));
  assert.throws(() => market.launchMarketCommand('codeagent & calc', args, {}));
});

test('缺少 CodeAgent 或不支持的发行版只给提示，安装不启动 CLI', async () => {
  const service = new market.CodeAgentMarket({ available: () => false, config: () => assert.fail('不应读目录'), run: () => assert.fail('不应启动') });
  assert.equal((await service.list()).available, false);
  await assert.rejects(service.install('skill:one'), /无法使用/);
});

test('假 CLI 真进程安装三类条目，随后由能力目录读回，重复安装不再运行', async t => {
  const f = fixture(t), script = path.join(f.root, 'fake-cli.cjs');
  // 使用独立临时配置；假 CLI 和真实 CLI 一样只负责写自己的安装记录。
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');
const [kind,op,id,...flags]=process.argv.slice(2),dir=process.env.CODEAGENT3_CONFIG_DIR;
if(process.env.FAKE_FAIL){console.error('network ECONNREFUSED');process.exit(9);}
if(kind==='skills'){fs.mkdirSync(path.join(dir,'skills',id),{recursive:true});fs.writeFileSync(path.join(dir,'skills',id,'SKILL.md'),'---\\nname: '+id+'\\ndescription: fake installed\\n---\\n');}
if(kind==='plugin'){fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabledPlugins:{[id]:true}}));const p=path.join(dir,'plugins','cache','aimarket',id.split('@')[0],'1','.cac-plugin');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'plugin.json'),JSON.stringify({name:id.split('@')[0]}));}
if(kind==='mcp'){fs.writeFileSync(path.join(dir,'.cac.json'),JSON.stringify({mcpServers:{[id]:{command:'fake'}}}));}
console.log('installed');`);
  const command = path.join(f.root, 'fake-codeagent.cmd');
  fs.writeFileSync(command, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
  const scan = async () => collectCapabilities({ homeDir: path.dirname(f.configDir), dataDir: path.join(f.root, 'data'), codeagentConfigDir: f.configDir });
  let calls = 0, invalidations = 0;
  const service = new market.CodeAgentMarket({ config: () => ({ command, configDir: f.configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR' }),
    available: () => true, catalog: scan, invalidate: () => invalidations++,
    run: (...args) => { calls++; return runSkillCommand(...args); } });
  if (process.platform !== 'win32') t.skip('Windows cmd 包装器真进程验证');
  else {
    await assert.rejects(runSkillCommand(command, market.installArgs({type:'skill',installId:'brief'}), {cwd:f.configDir,
      env:{...process.env,CODEAGENT3_CONFIG_DIR:f.configDir,FAKE_FAIL:'1'}}, {launch:market.launchMarketCommand}), /ECONNREFUSED/);
    for (const id of ['skill:brief', 'plugin:diagram', 'mcp:search']) assert.equal((await service.install(id)).installed, true);
    assert.equal(invalidations, 3);
    assert.ok((await service.list()).rows.every(row => row.installed));
    assert.equal((await service.install('skill:brief')).alreadyInstalled, true);assert.equal(calls, 3);
  }
});

test('CLI 非零退出可重试，锁会释放；请求不得指定任意条目或安装目录', async t => {
  const f = fixture(t);let fails = true, calls = 0;
  const service = new market.CodeAgentMarket({ config: () => ({ command: 'fake', configDir: f.configDir }),
    available: () => true, catalog: async () => ({ rows: [] }), invalidate() {},
    run: async () => { calls++; if (fails) throw Error('unauthorized 401'); } });
  await assert.rejects(service.install('skill:not-in-market'), /条目已变化/);assert.equal(calls, 0);
  await assert.rejects(service.install('skill:brief'), /登录或授权/);
  fails = false;assert.equal((await service.install('skill:brief')).installed, false);assert.equal(calls, 2);
});

test('安装并发时不重复写配置，超时后终止假 CLI 并给可重试原因', async t => {
  const f = fixture(t);let finish;
  const service = new market.CodeAgentMarket({ config: () => ({ command: 'fake', configDir: f.configDir }),
    available: () => true, catalog: async () => ({ rows: [] }), invalidate() {},
    run: () => new Promise(resolve => { finish = resolve; }) });
  const first = service.install('skill:brief');
  await assert.rejects(service.install('mcp:search'), /正在安装/);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish({});await first;
  let killed = false;
  const child = new EventEmitter();child.stdout = new EventEmitter();child.stderr = new EventEmitter();
  await assert.rejects(runSkillCommand('fake', ['mcp','add','search','--scope','user'], {}, {
    launch: () => child, timeoutMs: 5, terminate: () => { killed = true; },
  }), error => { assert.match(market.installFailure(error), /超时/);return true; });
  assert.equal(killed, true);
  assert.match(market.installFailure({ code: 'ENOENT' }), /找不到 CodeAgent/);
  assert.match(market.installFailure(Error('ENOTFOUND')), /公司内网/);
  assert.match(market.installFailure(Error('unknown option')), /unknown option/);
});

test('IPC 市场列表、安装以及异常都保持统一响应格式', async () => {
  const handlers = new Map();
  require('../main/ipc/capability-handlers').registerCapabilityIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    market: { status: () => ({ available: true }), list: async () => ({ rows: [] }), install: async id => { if (id !== 'skill:one') throw Error('请选择市场条目');return { installed: true }; } },
  });
  assert.deepEqual(await handlers.get('capabilities:market-status')(), { ok: true, data: { available: true } });
  assert.deepEqual(await handlers.get('capabilities:market')(), { ok: true, data: { rows: [] } });
  assert.equal((await handlers.get('capabilities:market-install')(null, { id: 'skill:one' })).data.installed, true);
  assert.equal((await handlers.get('capabilities:market-install')(null, {})).ok, false);
});
