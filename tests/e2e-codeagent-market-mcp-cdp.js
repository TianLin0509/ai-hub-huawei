'use strict';
// 资源页里 AI 市场下载的 MCP：隔离 Hub、真实鼠标点开关，核对来源标记、开关状态、Hub 设置落盘、用户配置文件不变。
// 用法：node tests/e2e-codeagent-market-mcp-cdp.js [输出目录]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
async function main() {
  const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'hub-market-mcp-cdp-out'));
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-market-mcp-cdp-'));
  const home = path.join(root, 'home'), config = path.join(home, '.cac'), data = path.join(root, 'data');
  fs.mkdirSync(config, { recursive: true });
  const userFiles = {
    [path.join(home, '.cac.json')]: { mcpServers: { 'airview-mcp-server': { type: 'stdio', command: 'run-airview-mcp.cmd', args: [] }, 'read-KIA': { command: 'python', args: ['kia.py'] } } },
    [path.join(config, 'inner-installed.json')]: { mcpServers: { 'airview-mcp-server': { disabled: true, installedAt: '2026-09-03T12:29:48.989Z', version: '0.0.0' } }, version: 1 },
  };
  for (const [file, body] of Object.entries(userFiles)) fs.writeFileSync(file, JSON.stringify(body, null, 2));
  const before = Object.keys(userFiles).map(file => [file, fs.readFileSync(file, 'utf8')]);
  const fake = path.join(root, 'fake-cli.cjs'), command = path.join(root, 'codeagent.cmd');
  fs.writeFileSync(fake, `const a=process.argv.slice(2);if(a.includes('--version')){console.log('1.2615.02.05');process.exit(0);}console.log('Usage: codeagent [options]\\n--model --disabled-mcp-servers');`);
  fs.writeFileSync(command, '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n');
  const checks = [], report = { simulatedCli: true, checks };
  let hub, cdp;
  const until = async (expression, label) => {
    for (const end = Date.now() + 30000; Date.now() < end;) { if (await cdp.eval(expression)) return;await sleep(150); }
    throw Error('等待超时：' + label);
  };
  const click = async selector => {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('找不到 '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'market-mcp', extraEnv: {
      USERPROFILE: home, HOME: home, CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1',
      AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: config,
      AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    } });
    cdp = await connectFirstPage(hub, null, { waitMainMs: 15000 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('window.hubWorkspaces && document.querySelector("#scene-rail")?.dataset.railGroupsInstalled === "true"', '导航就绪');
    await until('document.querySelector("#btn-rail-group-rules")?.getBoundingClientRect().width > 0', '规则分组入口');
    const groupPoint = await cdp.eval('(()=>{const r=document.querySelector("#btn-rail-group-rules").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...groupPoint });
    await until('document.querySelector("#btn-rail-capabilities")?.getBoundingClientRect().width > 0', '资源入口');
    await click('#btn-rail-capabilities');
    await until('document.querySelector(\'[data-cp-row="mcp:airview-mcp-server"]\')', '市场 MCP 出现在资源页');
    assert.match(await cdp.eval('document.querySelector(\'[data-cp-row="mcp:airview-mcp-server"]\').textContent'), /AI 市场/);
    assert.doesNotMatch(await cdp.eval('document.querySelector(\'[data-cp-row="mcp:read-KIA"]\')?.textContent || ""'), /AI 市场/);
    checks.push('资源页列出 airview-mcp-server 并标「AI 市场」，自己登记的 read-KIA 不标');
    // 关掉后不算「已启用」：先切到「全部（含停用）」再操作，关掉后条目仍在眼前。
    await cdp.eval('(()=>{const s=document.querySelector("#cp-scope");s.value="all";s.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await until('document.querySelector(\'[data-cp-row="mcp:airview-mcp-server"]\')', '切到全部范围');
    await click('[data-cp-row="mcp:airview-mcp-server"]');
    await until('document.querySelector("[data-cp-mcp-toggle]")?.getAttribute("aria-checked") === "true"', '开关默认开启');
    const hint = await cdp.eval('document.querySelector(".cp-market-mcp-toggle")?.innerHTML || ""');
    assert.match(hint, /下次新开或重启会话生效/);
    checks.push('详情里有「在 Hub 会话中启用」开关，ⓘ 说明下次新开或重启会话生效');
    await click('[data-cp-mcp-toggle]');
    await until('document.querySelector("[data-cp-mcp-toggle]")?.getAttribute("aria-checked") === "false"', '点击后关闭');
    await until('document.querySelector("#capability-page")?.textContent.includes("下次新开或重启会话生效")', '保存提示');
    assert.match(await cdp.eval('document.querySelector(\'[data-cp-row="mcp:airview-mcp-server"]\').textContent'), /Hub 已关闭/);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'codeagent-market-mcp.json'), 'utf8'));
    assert.deepEqual(saved.disabled, ['airview-mcp-server']);
    checks.push('真实点击关闭：按钮变「已关闭」，列表标「Hub 已关闭」，设置写进 Hub 数据目录');
    const toggleRow = await cdp.eval('(()=>{const r=document.querySelector(".cp-market-mcp-toggle").getBoundingClientRect();return r.height;})()');
    assert.ok(toggleRow < 48, '开关应是一行：' + toggleRow);
    checks.push('开关是一行（高 ' + Math.round(toggleRow) + 'px），说明只在 ⓘ 里');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    report.screenshot = path.join(output, '20261124-market-mcp-toggle-1440x900.png');
    fs.writeFileSync(report.screenshot, Buffer.from(shot.data, 'base64'));
    await click('[data-cp-action=refresh]');
    await until('!document.querySelector("#capability-page .cp-progress") && document.querySelector("[data-cp-mcp-toggle]")?.getAttribute("aria-checked") === "false"', '刷新后仍为关闭');
    await click('[data-cp-mcp-toggle]');
    await until('document.querySelector("[data-cp-mcp-toggle]")?.getAttribute("aria-checked") === "true"', '再次开启');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'codeagent-market-mcp.json'), 'utf8')).disabled, []);
    checks.push('刷新后状态保持；再点开启后设置清空');
    for (const [file, body] of before) assert.equal(fs.readFileSync(file, 'utf8'), body, file + ' 被改了');
    checks.push('用户的 .cac.json 与 inner-installed.json 一字未改');
    report.ok = true;
  } catch (error) {
    report.ok = false;report.error = error.stack;
    if (cdp) {
      report.ui = await cdp.eval('document.body.innerText.slice(0,1200)').catch(() => null);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot) fs.writeFileSync(path.join(output, '20261124-market-mcp-失败.png'), Buffer.from(shot.data, 'base64'));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, '20261124-market-mcp-cdp.json'), JSON.stringify(report, null, 2));
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub, { allowAlreadyExited: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.stack);process.exitCode = 1; });
