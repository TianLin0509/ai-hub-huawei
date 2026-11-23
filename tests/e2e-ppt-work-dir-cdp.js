'use strict';
// 隐藏隔离 Hub，真实设置 IPC 与键鼠操作；Doctor 和 PPT 内容使用合成夹具。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/20261123-ppt-workdir-codex');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-root-ui-')), dataDir = path.join(root, 'data'), aDir = path.join(dataDir, 'company-assistant');
  const doctorDir = path.join(root, 'doctor'), exe = path.join(doctorDir, 'PPT-Doctor.exe');
  fs.mkdirSync(aDir, { recursive: true }); fs.mkdirSync(doctorDir);
  const compile = spawnSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/reference:System.Web.Extensions.dll', '/out:' + exe, path.join(__dirname, 'fixtures/ppt-doctor-ui.cs')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);
  fs.writeFileSync(path.join(doctorDir, 'hub-api.json'), JSON.stringify({ apiVersion: 1, executable: 'PPT-Doctor.exe',
    exeSha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), capabilities: ['status'] }));
  fs.writeFileSync(path.join(doctorDir, 'fixture.json'), JSON.stringify({ status: { available: false, indexed_pages: 0, file_status_counts: [], documents: [], warnings: [] } }));
  fs.writeFileSync(path.join(aDir, 'settings.json'), JSON.stringify({ enabled: false, ppt: { doctorExe: exe } }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const oldFile = path.join(aDir, 'old-ppt.txt'); fs.writeFileSync(oldFile, '旧数据原地保留');
  const result = { passed: false, checks: [], root }; let hub, c;
  const until = async expr => { for (const end = Date.now() + 30000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('等待超时：' + expr); };
  const invoke = (action, value) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(action)},${JSON.stringify(value)})`);
  const click = async sel => {
    await until(`!!document.querySelector(${JSON.stringify(sel)})`);
    const p = await c.eval(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
  };
  const fill = async text => {
    await click('[data-ppt-work-input]');
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.insertText', { text });
  };
  const shot = async name => { const png = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `20261123-ppt-workdir-${name}-codex.png`), Buffer.from(png.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'ppt-work-dir', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: '', AI_HUB_LEGACY_WORKSPACE_ROOTS: '', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'),
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false }, foreign: { ok: false } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!document.getElementById("btn-company-ppt")'); await click('#btn-company-ppt');
    await until('!!document.querySelector("[data-ppt-work-dir]")'); await click('.pptw-settings summary');
    await until('document.querySelector("[data-ppt-work-input]").dataset.loaded === "1"');
    assert.equal(await c.eval('document.querySelector("[data-ppt-work-dir]").textContent'), aDir);
    result.checks.push('未配工作根时保持原位置，设置说明收在 ⓘ');
    const chosen = path.join(root, 'work'); fs.mkdirSync(chosen);
    assert.equal((await invoke('save-hub-config', { defaultWorkspaceRoot: chosen })).success, true);
    await click('[data-ppt="work-dir-reset"]');
    await until(`document.querySelector('[data-ppt-work-dir]').textContent === ${JSON.stringify(path.join(chosen, 'ppt'))}`);
    result.checks.push('跟随 v5.6.79 默认工作目录，立即对新任务生效');
    await fill('relative'); await click('[data-ppt="work-dir-save"]');
    await until('document.querySelector("[data-ppt-work-dir-error]").textContent.includes("完整路径")');
    const blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, '保留');
    await fill(blocked); await click('[data-ppt="work-dir-save"]');
    await until('document.querySelector("[data-ppt-work-dir-error]").textContent.includes("不可写")');
    await shot('不可写提示'); result.checks.push('相对路径和不可写目录在设置旁提示，不保存失败值');
    const separate = path.join(root, 'separate'); await fill(separate); await click('[data-ppt="work-dir-save"]');
    await until(`document.querySelector('[data-ppt-work-dir]').textContent === ${JSON.stringify(separate)}`);
    await shot('已保存');
    const made = await invoke('company-assistant:ppt-make-skeletons');
    const page = await invoke('company-assistant:ppt-make-example', { skeletonId: made.skeletons[0].id });
    assert.equal(page.ok, true, page.error); assert.ok(page.job.path.startsWith(path.join(separate, 'ppt-make')));
    assert.ok(fs.existsSync(page.job.path));
    assert.equal(fs.readFileSync(oldFile, 'utf8'), '旧数据原地保留');
    assert.equal(JSON.parse(fs.readFileSync(path.join(aDir, 'settings.json'))).ppt.doctorExe, exe);
    result.checks.push('真实生成样例 PPTX 到新目录，旧数据和 Doctor 程序位置保持不变');
    const bounds = await c.eval('(()=>{const p=document.querySelector(".company-ppt-page"),s=document.querySelector(".pptw-settings-pop");return {scroll:p.scrollHeight,height:p.clientHeight,bottom:s.getBoundingClientRect().bottom,view:innerHeight};})()');
    assert.ok(bounds.scroll <= bounds.height + 2, JSON.stringify(bounds));
    assert.ok(bounds.bottom <= bounds.view, JSON.stringify(bounds)); result.checks.push('1440×900 设置与 PPT 页面一屏可见');
    result.passed = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; if (c) await shot('失败').catch(() => {}); }
  finally {
    c?.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261123-ppt-workdir-验收-codex.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
