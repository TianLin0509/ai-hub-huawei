'use strict';
// Real isolated Hub, hidden window, no model calls or production data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/work-file-root-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-root-ui-')), data = path.join(root, 'data'), chosen = path.join(root, '新工作文件');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const result = { passed: false, checks: [], root }; let hub, c;
  const launch = async () => {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'work-file-root', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: '', AI_HUB_LEGACY_WORKSPACE_ROOTS: '',
      AI_HUB_CODEAGENT_COMMAND: path.join(root, 'missing-cli.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline fixture' }, foreign: { ok: false, error: 'offline fixture' } }),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof openConfigModal === "function"');
  };
  const until = async expr => { for (const end = Date.now() + 25000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('Timeout: ' + expr); };
  const click = async sel => {
    await until(`!!document.querySelector(${JSON.stringify(sel)})`);
    const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
  };
  const fill = async text => {
    await click('#cfg-work-file-root');
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.insertText', { text });
  };
  const shot = async name => { await _waitMs(200); const png = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.data, 'base64')); };
  const form = () => c.eval("require('electron').ipcRenderer.invoke('get-hub-config-raw')");
  try {
    await launch(); await until('typeof openConfigModal === "function"'); const before = await form();
    assert.equal(before.workFileRoot, '');
    assert.equal(before.workFileRootActive, '');
    const oldFile = path.join(before.workspaceRootEffective, 'keep.txt'); fs.mkdirSync(path.dirname(oldFile), { recursive: true }); fs.writeFileSync(oldFile, 'old content');
    result.checks.push('fresh defaults unchanged');
    await until('typeof openConfigModal === "function"'); await c.eval('openConfigModal()');
    await click('#cfg-tab-advanced');
    await until('document.querySelector("#cfg-work-file-root").getBoundingClientRect().width > 0');
    assert.ok(await c.eval('document.querySelector("#cfg-work-file-root-field").innerText.includes("已有内容留在原处，可手动移动")'));
    assert.ok(await c.eval('document.querySelector("#cfg-work-file-original").options.length >= 7'));
    await shot('settings-default-1440');
    await fill('relative-folder'); await click('#config-save');
    await until('document.querySelector("#config-save-msg").classList.contains("error")');
    assert.equal((await form()).workFileRoot, ''); result.checks.push('invalid path rejected without saving');
    await shot('settings-invalid-1440');
    // Click the actual original-folder button for a missing folder: error is local,
    // no Explorer window is launched and no empty original folder is created.
    await c.eval(`(()=>{const s=document.querySelector('#cfg-work-file-original');const p=${JSON.stringify(path.join(data, 'company-assistant', 'workspace'))};s.value=Array.from(s.options).find(o=>o.textContent===p).value;})()`);
    await click('#cfg-work-file-open-original');
    await until('document.querySelector("#cfg-work-file-root-status").innerText.includes("原目录无法打开")');
    result.checks.push('open-original failure shown inline');
    await fill(chosen);
    assert.equal(await c.eval('document.querySelector("#cfg-work-file-root").value'), chosen, 'typed absolute root');
    await click('#config-save');
    await until('document.querySelector("#config-save-msg").classList.contains("success")');
    const saved = await form(); assert.equal(saved.workFileRoot, chosen); assert.equal(saved.workFileRootActive, '');
    assert.equal(saved.workspaceRootEffective, before.workspaceRootEffective, 'running jobs not redirected');
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'old content');
    assert.deepEqual(fs.readdirSync(chosen), [], 'validation leaves no probe files or migrated content');
    result.checks.push('saved with real disk/write validation; original content unchanged; restart pending');
    await shot('settings-saved-1440');
    c.close(); c = null; await gracefulQuit(hub); hub = null;
    await launch(); const after = await form();
    assert.equal(after.workFileRootActive, chosen); assert.equal(after.workspaceRootEffective, path.join(chosen, 'workspaces'));
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'old content');
    await c.eval('openConfigModal()'); await click('#cfg-tab-advanced'); await shot('settings-after-restart-1440');
    result.checks.push('restart activates new auto workspace, old content stays put');
    c.close(); c = null; await gracefulQuit(hub); hub = null;
    fs.renameSync(chosen, chosen + '-offline');
    await launch(); const fallback = await form();
    assert.equal(fallback.workFileRoot, chosen, 'saved setting remains available for recovery');
    assert.equal(fallback.workFileRootActive, '');
    assert.equal(fallback.workspaceRootEffective, before.workspaceRootEffective);
    assert.match(fallback.workFileRootInvalid, /ENOENT/);
    assert.equal(fs.existsSync(chosen), false, 'startup must not recreate missing root');
    await c.eval('openConfigModal()'); await click('#cfg-tab-advanced');
    await until('document.querySelector("#cfg-work-file-root-status").innerText.includes("已恢复原默认位置")');
    assert.equal(await c.eval('document.querySelector("#cfg-work-file-root-pick").innerText'), '重新选择');
    await shot('settings-missing-root-1440');
    result.checks.push('missing root falls back on restart; inline reason and choose-again button shown');
    await c.eval("require('electron').ipcRenderer.invoke('i18n:set-language', 'en')");
    await until('document.querySelector("#cfg-work-file-root-status").innerText.includes("Hub is using the original default locations")');
    assert.equal(await c.eval('document.querySelector("#cfg-work-file-root-pick").innerText'), 'Choose again');
    assert.doesNotMatch(await c.eval('document.querySelector("#cfg-work-file-root-status").innerText'), /[\u3400-\u9fff]/);
    result.checks.push('fallback reason and recovery button translated to English');
    result.passed = true;
  } catch (e) {
    result.error = e.stack; result.logTail = hub?.log?.().slice(-35).join('\n');
    try { result.ui = await c.eval('({message:document.querySelector("#config-save-msg")?.innerText,root:document.querySelector("#cfg-work-file-root")?.value})'); await shot('settings-failure-1440'); } catch {}
    process.exitCode = 1;
  }
  finally {
    c?.close(); if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, 'work-file-root-cdp.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error, out }));
})();
