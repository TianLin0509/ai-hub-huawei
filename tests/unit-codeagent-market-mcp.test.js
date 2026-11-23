'use strict';
// AI 市场下载的 MCP 进资源页并可在 Hub 里开关（WeLink 反馈：资源里一直不显示从 ai-market 下载的 mcp）。
// 市场安装登记在 <配置目录>/inner-installed.json（2026-11-24 公司真机核对）。开关只存 Hub 设置，
// 新开或重启会话时临时注入，绝不改用户自己的 CLI 配置文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectCapabilities } = require('../core/capability-catalog');
const marketMcp = require('../core/codeagent-market-mcp');

const airview = { type: 'stdio', command: 'C:/OCHOME/mcp/airview-mcp-server/run-airview-mcp.cmd', args: [] };
const kia = { command: 'python', args: ['/read_kia_server.py'] };
const registry = {
  mcpServers: {
    'airview-mcp-server': { disabled: true, installedAt: '2026-09-03T12:29:48.989Z', version: '0.0.0' },
    t1: { disabled: true, installedAt: '2026-09-03T12:20:12.758Z', version: '0.0.0' },
  },
  plugins: { 'codebase-win': { disabled: false, version: '1.0.12' } },
  version: 1,
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-market-mcp-'));
  const homeDir = path.join(root, 'home'), accountDir = path.join(homeDir, '.cac');
  const hubDataDir = path.join(root, 'hub'), cwd = path.join(root, 'work');
  for (const dir of [homeDir, accountDir, hubDataDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  const old = Object.fromEntries(['CLAUDE_HUB_DATA_DIR', 'USERPROFILE', 'HOME'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { CLAUDE_HUB_DATA_DIR: hubDataDir, USERPROFILE: homeDir, HOME: homeDir });
  t.after(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  write(path.join(homeDir, '.cac.json'), { mcpServers: { 'airview-mcp-server': airview, 'read-KIA': kia } });
  write(path.join(accountDir, 'inner-installed.json'), registry);
  write(path.join(accountDir, 'settings.json'), { enabledPlugins: { 'codebase-win@aimarket': true } });
  // 用户自己的配置文件：每个用例结束前核对字节与修改时间都没变。
  const userFiles = [path.join(homeDir, '.cac.json'), path.join(accountDir, 'inner-installed.json'), path.join(accountDir, 'settings.json')];
  const snapshot = () => userFiles.map(file => ({ file, body: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs }));
  const config = { configDir: accountDir, command: 'codeagent-probe-not-installed', configDirEnv: 'CODEAGENT3_CONFIG_DIR' };
  const launch = (opts = {}) => require('../core/session-manager')._private.buildCodeAgentPtyLaunch('market-mcp-test', 'codeagent', opts, cwd,
    { USERPROFILE: homeDir, HOME: homeDir }, config);
  const configOf = launch => {
    const m = launch.cmd.match(/--mcp-config (?:'([^']+)'|([^\s]+))/);
    return m ? JSON.parse(fs.readFileSync(m[1] || m[2], 'utf8')).mcpServers : {};
  };
  return { root, homeDir, accountDir, hubDataDir, cwd, snapshot, launch, configOf };
}

test('资源页列出 AI 市场下载的 MCP：名字、来源=AI 市场、状态（有启动配置为已登记，没有为安装待核对）', t => {
  const f = fixture(t);
  const catalog = collectCapabilities({ homeDir: f.homeDir, dataDir: f.hubDataDir, codeagentConfigDir: f.accountDir });
  const av = catalog.rows.find(r => r.id === 'mcp:airview-mcp-server');
  const t1 = catalog.rows.find(r => r.id === 'mcp:t1');
  assert.ok(av && t1, '市场登记的两个 MCP 都要列出');
  const avMarket = av.sources.find(s => s.market === 'aimarket');
  assert.equal(avMarket.path, path.join(f.accountDir, 'inner-installed.json'));
  assert.equal(avMarket.missing, false, '.cac.json 里有启动方式');
  assert.equal(avMarket.installedAt, '2026-09-03T12:29:48.989Z');
  assert.equal(av.origin.kind, 'external', '市场登记 + .cac.json 启动配置不应显示成「来源有差异」');
  assert.match(av.origin.evidence, /AI 市场/);
  assert.equal(t1.sources[0].missing, true, '市场登记了却没有启动配置');
  assert.ok(!catalog.rows.some(r => r.type === 'mcp' && r.name === 'codebase-win'), '插件登记不当成 MCP');
  const kiaRow = catalog.rows.find(r => r.id === 'mcp:read-KIA');
  assert.ok(!kiaRow.sources.some(s => s.market), '自己登记的 MCP 不标 AI 市场');
});

test('开关持久化在 Hub 数据目录，资源页行带上 Hub 开关状态，名字校验', t => {
  const f = fixture(t);
  assert.deepEqual(marketMcp.loadSettings(f.hubDataDir).disabled, []);
  marketMcp.setMarketMcpEnabled(f.hubDataDir, 't1', false);
  marketMcp.setMarketMcpEnabled(f.hubDataDir, 'airview-mcp-server', false);
  marketMcp.setMarketMcpEnabled(f.hubDataDir, 't1', true);
  assert.deepEqual(marketMcp.loadSettings(f.hubDataDir).disabled, ['airview-mcp-server']);
  assert.ok(fs.existsSync(path.join(f.hubDataDir, marketMcp.SETTINGS_FILE)));
  assert.throws(() => marketMcp.setMarketMcpEnabled(f.hubDataDir, 'a,b', false), /名称无效/);
  assert.throws(() => marketMcp.setMarketMcpEnabled(f.hubDataDir, 't1', 'no'), /开启或关闭/);
  const catalog = collectCapabilities({ homeDir: f.homeDir, dataDir: f.hubDataDir, codeagentConfigDir: f.accountDir });
  const rows = marketMcp.decorateCatalogRows(catalog.rows, f.hubDataDir);
  assert.equal(rows.find(r => r.id === 'mcp:airview-mcp-server').hubEnabled, false);
  assert.equal(rows.find(r => r.id === 'mcp:t1').hubEnabled, true);
  assert.equal(rows.find(r => r.id === 'mcp:read-KIA').hubEnabled, undefined, '非市场 MCP 不给开关');
  for (const before of f.snapshot()) assert.equal(fs.readFileSync(before.file, 'utf8'), before.body);
});

test('服务层：只允许开关市场登记里的 MCP，切换后不用重扫就反映到目录', async t => {
  const f = fixture(t);
  const { CapabilityService } = require('../core/capability-service');
  const service = new CapabilityService({ sessionManager: { getAllSessions: () => [] }, dataDir: f.hubDataDir, homeDir: f.homeDir });
  service.codeagentConfigDir = () => f.accountDir;
  service.marketFlagSupport = () => true;
  await assert.rejects(service.setMarketMcpEnabled({ name: 'read-KIA', enabled: false }), /不在 AI 市场/);
  await service.setMarketMcpEnabled({ name: 'airview-mcp-server', enabled: false });
  const catalog = await service.catalog();
  assert.equal(catalog.rows.find(r => r.id === 'mcp:airview-mcp-server').hubEnabled, false);
  const handlers = new Map();
  require('../main/ipc/capability-handlers').registerCapabilityIpc({ handle: (name, fn) => handlers.set(name, fn) }, service);
  const r = await handlers.get('capabilities:market-mcp-toggle')(null, { name: 'airview-mcp-server', enabled: true });
  assert.equal(r.ok, true);
  assert.deepEqual(marketMcp.loadSettings(f.hubDataDir).disabled, []);
});


test('设置读不了不当成空：带出原因；目录行开关置灰、关掉的不算已启用', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.hubDataDir, marketMcp.SETTINGS_FILE), JSON.stringify({ disabled: 'x' }));
  assert.match(marketMcp.loadSettings(f.hubDataDir).error, /读不了/);
  fs.writeFileSync(path.join(f.hubDataDir, marketMcp.SETTINGS_FILE), JSON.stringify({ disabled: ['airview-mcp-server'] }));
  const catalog = collectCapabilities({ homeDir: f.homeDir, dataDir: f.hubDataDir, codeagentConfigDir: f.accountDir });
  const { isActive } = require('../core/capability-view-model');
  const ok = marketMcp.decorateCatalogRows(catalog.rows, f.hubDataDir, { flagSupported: true });
  const av = ok.find(r => r.id === 'mcp:airview-mcp-server');
  assert.deepEqual(av.hubToggle, { supported: true, reason: '' });
  assert.equal(isActive(av), false, 'Hub 里关掉的不算已启用');
  const old = marketMcp.decorateCatalogRows(catalog.rows, f.hubDataDir, { flagSupported: false });
  assert.deepEqual(old.find(r => r.id === 'mcp:t1').hubToggle, { supported: false, reason: '当前 CodeAgent 版本不支持在 Hub 里关闭，升级后可用' });
  assert.equal(marketMcp.launchNotice({ hubOff: ['a'], flagSupported: true }), '');
});

test('mergeDisabledArg 去重、丢掉含逗号空白的名字，空表不加参数', () => {
  assert.deepEqual(marketMcp.mergeDisabledArg(['x'], []), ['x']);
  assert.deepEqual(marketMcp.mergeDisabledArg([], ['a', 'b', 'a', 'bad name', 'c,d']), ['--disabled-mcp-servers', 'a,b']);
});
