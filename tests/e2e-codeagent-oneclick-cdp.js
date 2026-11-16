'use strict';
// CodeAgent 一键安装 / 升级的真实界面走查（2026-11-16）：隐藏的隔离 Hub + 真实鼠标点击。
//   1. 没装、本机也没有安装包：安装说明里点「一键安装」→ 提示并亮出「打开官方下载页」（不真的打开网页窗口）；
//   2. 账号页没装时有「一键安装」按钮；
//   3. 装上（假 CLI 文件）后账号页显示版本和「一键升级」，点下去真实走 IPC → 隐藏运行 `<cli> update --force` → 回报「已是最新版」。
// 用法：node tests/e2e-codeagent-oneclick-cdp.js <输出目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/codeagent-oneclick');
const repo = path.resolve(__dirname, '..');
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
const windows = pid => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'helpers/reskin-window-audit.ps1'), '-RootProcessId', String(pid)], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ca-oneclick-')), data = path.join(root, 'data'), work = path.join(root, 'work');
  for (const dir of [data, work, path.join(root, 'personal'), path.join(root, 'scan')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const command = path.join(root, 'codeagent-fixture.cmd'), log = path.join(root, 'fixture-calls.txt');
  const result = { passed: false, root, checks: [], screenshots: [], windowAudits: [] };
  const save = () => fs.writeFileSync(path.join(out, 'oneclick.json'), JSON.stringify(result, null, 2));
  let hub, c;
  const audit = () => { const record = windows(hub.pid); result.windowAudits.push(record); save(); assert.deepEqual(record.visible, [], '不能出现可见窗口'); };
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await port(), windowMode: 'hidden', label: 'CodeAgent oneclick', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: command, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, errorCode: 'offline_test', error: '离线界面测试' }, foreign: { ok: false, errorCode: 'offline_test', error: '离线界面测试' } }),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub); audit();
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const wait = async (expression, name, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expression)) return; await _waitMs(150); } throw Error('timeout: ' + name); };
    const click = async selector => {
      await wait(`(()=>{const e=${q(selector)};if(!e||e.disabled)return false;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return r.width>0&&r.height>0;})()`, selector);
      const xy = await c.eval(`(()=>{const e=${q(selector)},r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    const shot = async name => { await _waitMs(200); const img = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(img.data, 'base64')); result.screenshots.push(path.join(out, name + '.png')); save(); };

    await wait(`!!window.LaunchCenter && ${q('[data-provider="codeagent"]')}?.dataset.installed==='0'`, 'missing CLI');
    await click('[data-provider="codeagent"] button');
    await wait(`${q('#codeagent-install-guide')}?.open`, 'guide');
    await click('#codeagent-install-guide [data-setup="install"]');
    await wait(`/官方下载页/.test(${q('#codeagent-install-guide [role="status"]')}?.textContent) && !${q('#codeagent-install-guide [data-setup="csop"]')}.hidden`, 'need-download state');
    result.guideStatus = await c.eval(`${q('#codeagent-install-guide [role="status"]')}.textContent`);
    await shot('20261116-r25-guide-need-download-1440');
    result.checks.push('没装且无安装包：一键安装给出「打开官方下载页」并显示该按钮');
    await click('#codeagent-install-guide .company-api-close');

    await click('#btn-rail-accounts');
    await wait(`!!${q('#codeagent-accounts-page [data-ca="install-oneclick"]')}`, 'account install button');
    await shot('20261116-r25-accounts-missing-1440');
    result.checks.push('账号页没装时有「一键安装」');

    fs.writeFileSync(command, `@echo off\r\necho %* >> "${log}"\r\necho 1.2615.02.03 (codeAgentCLI)\r\nexit /b 0\r\n`);
    await click('[data-ca="check-install"]');
    await wait(`!!${q('#codeagent-accounts-page [data-ca-install-slot] [data-ca="install-oneclick"]')}`, 'upgrade slot');
    result.slotBefore = await c.eval(`${q('[data-ca-install-slot]')}.textContent`);
    await click('[data-ca-install-slot] [data-ca="install-oneclick"]');
    await wait(`/已是最新版|升级完成/.test(${q('[data-ca-install-slot]')}?.textContent || '')`, 'upgrade result', 60000);
    result.slotAfter = await c.eval(`${q('[data-ca-install-slot]')}.textContent`);
    result.fixtureCalls = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(result.fixtureCalls.some(line => /update --force/.test(line)), '真的调用了 update --force');
    await shot('20261116-r25-accounts-upgraded-1440');
    result.noScroll = await c.eval(`(()=>{const p=${q('#codeagent-accounts-page .caa-page')}||${q('#codeagent-accounts-page')};return p.scrollHeight<=p.clientHeight+2;})()`);
    result.checks.push('已装：一键升级经真实 IPC 隐藏运行 update --force 并回报结果');
    audit(); result.passed = true; save();
  } catch (error) {
    result.error = error.stack; save();
    if (c) try { const img = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(img.data, 'base64')); } catch {}
    process.exitCode = 1;
  } finally { if (c) await c.close(); if (hub) result.teardown = await gracefulQuit(hub); save(); fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write(JSON.stringify({ passed: result.passed, checks: result.checks, out, error: result.error || null }) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
