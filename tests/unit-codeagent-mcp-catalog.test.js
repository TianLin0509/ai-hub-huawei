'use strict';
// 资源页列 CodeAgent 的 MCP（2026-11-22 同事反馈「CodeAgent 上有的 MCP 资源页看不到」）：
// 默认目录 ~/.cac 时 CodeAgent 把登记的 MCP 写在用户目录根下的 ~/.cac.json，原来只读 ~/.cac/.cac.json；
// 状态文件带会话历史常超 2 MB，原来超过就整份跳过。另：号池登录窗口写明密码交给谁、凭证存在哪。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectCapabilities } = require('../core/capability-catalog');
const { loginHint, cmdEchoText } = require('../core/codeagent-pool');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ca-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mcpNames = catalog => catalog.rows.filter(r => r.type === 'mcp' && r.agents.includes('codeagent')).map(r => r.name).sort();

test('CodeAgent MCP registered in home-root ~/.cac.json (top level and project local) shows in the resource catalog', t => {
  const dir = temp(t), home = path.join(dir, 'home'), config = path.join(home, '.cac'), project = path.join(dir, 'proj');
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(config, '.cac.json'), JSON.stringify({ mcpServers: { 'in-config-dir': { command: 'node' } } }));
  fs.writeFileSync(path.join(home, '.cac.json'), JSON.stringify({
    mcpServers: { 'read-KIA': { command: 'npx', args: ['kia'] }, 'w3-search': { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    projects: { [project]: { mcpServers: { 'local-only': { command: 'node' } } } },
  }));
  const catalog = collectCapabilities({ homeDir: home, dataDir: path.join(dir, 'data'), codeagentConfigDir: config, projects: [{ cwd: project, kind: 'codeagent' }] });
  assert.deepEqual(mcpNames(catalog), ['in-config-dir', 'local-only', 'read-KIA', 'w3-search']);
  const kia = catalog.rows.find(r => r.id === 'mcp:read-KIA');
  assert.equal(kia.sources[0].path, path.join(home, '.cac.json'));
  assert.equal(kia.sources[0].enabled, true);
});

test('a CodeAgent state file larger than 2 MB (session history) is still read for MCP entries', t => {
  const dir = temp(t), home = path.join(dir, 'home'), config = path.join(home, '.cac');
  fs.mkdirSync(config, { recursive: true });
  const history = 'x'.repeat(3 * 1024 * 1024);
  fs.writeFileSync(path.join(home, '.cac.json'), JSON.stringify({ mcpServers: { big: { command: 'node' } }, projects: { 'C:\\old': { history: [history] } } }));
  const catalog = collectCapabilities({ homeDir: home, dataDir: path.join(dir, 'data'), codeagentConfigDir: config });
  assert.deepEqual(mcpNames(catalog), ['big']);
  assert.doesNotMatch(catalog.warnings.join('\n'), /超过 2 MB/);
});

test('a non-default CodeAgent config dir does not pick up the home-root ~/.cac.json', t => {
  const dir = temp(t), home = path.join(dir, 'home'), config = path.join(dir, 'pool', 'acct1');
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(config, '.cac.json'), JSON.stringify({ mcpServers: { own: { command: 'node' } } }));
  fs.writeFileSync(path.join(dir, 'pool', '.cac.json'), JSON.stringify({ mcpServers: { parent: { command: 'node' } } }));
  const catalog = collectCapabilities({ homeDir: home, dataDir: path.join(dir, 'data'), codeagentConfigDir: config });
  assert.deepEqual(mcpNames(catalog), ['own']);
});

test('pool login window says the password goes only to CodeAgent and where the credential is stored', () => {
  const pool = loginHint(String.raw`D:\hub-data\R&D\accounts\a1`);
  assert.match(pool, /AI Hub 不读取、不保存、不外传密码/);
  // 合法路径字符 & 要转义后原样显示（D:\R&D 不能变成 D:\RD），也不能截断 cmd 命令
  assert.ok(pool.includes(String.raw`只存在本机这个目录：D:\hub-data\R^&D\accounts\a1`));
  assert.doesNotMatch(pool.replace(/ & echo/g, '').replace(/\^&/g, ''), /&/);
  assert.match(pool, /不用浏览器授权/);
  const personal = loginHint(String.raw`D:\hub-data\.cac`, { personal: true });
  assert.match(personal, /个人账号重新登录/);
  assert.doesNotMatch(personal, /号池用账号密码/);
});

test('escaped directory survives the two cmd layers of the login window unchanged', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  for (const dir of [String.raw`D:\R&D\a`, String.raw`D:\x^y\100%\(b)`, String.raw`D:\p%PATH%q`]) {
    // 与 openLoginWindow 同样的两层：外层 cmd /d /s /c，内层引号里的 cmd（这里用 /c 代替 start + /k，不开窗口）。
    const line = `cmd.exe /c "echo DIR=${cmdEchoText(dir)} & echo."`;
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', line], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(r.stdout.split(/\r?\n/)[0].trim(), 'DIR=' + dir);
  }
});
