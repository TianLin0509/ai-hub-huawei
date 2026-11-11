'use strict';
// Real renderer + settings IPC + disk persistence; isolated data, no login or messages.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/phone-extra-ids-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-phone-extra-ids-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  // Do not prefill phone settings: verify first use with an empty data directory.
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  const result = { passed: false, testRoot: root, checks: [], fixture: 'isolated Hub, real settings IPC, synthetic IDs, no login/messages' };
  let hub, c;
  const stop = async () => { if (hub) { result.teardown = await gracefulQuit(hub); hub = null; } if (c) { await c.close(); c = null; } };
  try {
    for (let round = 0; round < 2; round++) {
      hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'phone-extra-ids', extraEnv: {
        AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
        AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
        CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
        CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
        CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: path.join(root, 'welink-commands.jsonl'),
        CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
      } });
      c = await connectFirstPage(hub);
      await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
      const until = async expr => { for (const end = Date.now() + 20000; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('Timeout: ' + expr); };
      const click = async selector => {
        await until(`!!document.querySelector(${JSON.stringify(selector)})`);
        const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
      };
      await click('#btn-company-assistant');
      await click('[data-ca="settings"]');
      await click('.ca-tabs [data-ca="settings-tab:phone"]');
      const selector = '[data-f="phone-extraIds"]';
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      const value = () => c.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
      const type = async text => {
        await click(selector);
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
        await c.send('Input.insertText', { text });
      };
      const settingsFile = path.join(dataDir, 'company-assistant', 'settings.json');
      const savedIds = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).phone.extraIds;
      if (round === 0) {
        assert.equal(await value(), '');
        assert.ok(await c.eval(`document.querySelector('#ca-phone-extra-ids-help').textContent.includes('把新工号填在这里')`));
        assert.ok(await c.eval(`document.querySelector('#ca-phone-extra-ids-help').textContent.includes('8 位数字')`));
        assert.ok(await c.eval(`document.querySelector('#ca-phone-extra-ids-help').textContent.includes('不要带字母')`));
        assert.equal(await c.eval(`document.querySelector(${JSON.stringify(selector)}).closest('fieldset').querySelector('legend').textContent`), '额外属于我的账号');
        await type(' 00123456, 00123456\n 00876543\n00000001 , ');
        await click('[data-x="phone-save"]');
        await until(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify('00123456\n00876543\n00000001')}`);
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        assert.deepEqual(saved.phone.extraIds, ['00123456', '00876543', '00000001']);
        assert.equal(saved.phone.enabled, false);
        result.checks.push('empty first use, clean account title, eight-digit IDs saved via real IPC, normalized settings on disk');
        // 后台工具发现可能独立更新 cliPath；这里只比较本次表单负责的完整 phone 设置。
        const beforeInvalid = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).phone;
        await type('z00123456, Z00123456, bad, 123456');
        await click('[data-x="phone-save"]');
        await until(`document.querySelector('#ca-phone-extra-ids-error').textContent.includes('bad')`);
        assert.ok(await c.eval(`(()=>{const e=document.querySelector('#ca-phone-extra-ids-error');const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})()`), 'inline error is visible, not behind the sticky save buttons');
        assert.ok(await c.eval(`document.querySelector('#ca-phone-extra-ids-error').textContent.includes('123456')`));
        for (const invalid of ['z00123456', 'Z00123456'])
          assert.ok(await c.eval(`document.querySelector('#ca-phone-extra-ids-error').textContent.includes(${JSON.stringify(invalid)})`));
        assert.equal(await value(), 'z00123456, Z00123456, bad, 123456', 'invalid input stays editable');
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).phone, beforeInvalid);
        const invalidShot = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, 'phone-invalid.png'), Buffer.from(invalidShot.data, 'base64'));
        await click('[data-f="phone-group"]');
        await c.send('Input.insertText', { text: '123' });
        await click('[data-x="phone-connect"]');
        await until(`document.querySelector('[data-slot="phone-connect-result"]').textContent.includes('格式不正确')`);
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).phone, beforeInvalid, 'invalid connect never changes phone settings');
        result.checks.push('invalid save/connect rejected before sending, inline error, input and previous settings retained');
        await type('00123456\n00876543\n00000001');
        assert.equal(await c.eval(`document.querySelector('#ca-phone-extra-ids-error').textContent`), '');
        await click('[data-x="phone-save"]');
        await until(`!document.querySelector('[data-x="phone-save"]').disabled`);
        assert.deepEqual(savedIds(), ['00123456', '00876543', '00000001']);
      } else {
        assert.equal(await value(), '00123456\n00876543\n00000001');
        result.checks.push('full Hub restart retains saved extra IDs in the real phone settings page');
        await type(' ,\n ');
        await click('[data-x="phone-save"]');
        await until(`document.querySelector(${JSON.stringify(selector)})?.value===''`);
        assert.deepEqual(savedIds(), []);
        result.checks.push('clearing the list persists an empty array');
      }
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, `phone-${round}.png`), Buffer.from(shot.data, 'base64'));
      await stop();
    }
    const log = path.join(root, 'welink-commands.jsonl');
    const commands = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    assert.ok(commands.every(args => !(args[0] === 'auth' && args[1] === 'login') && args[1] !== 'send-to-group'));
    result.checks.push('no WeLink login or message send commands'); result.passed = true;
  } catch (error) {
    result.error = error.stack; process.exitCode = 1;
    if (c) try { const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {}
  }
  finally { await stop(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})();
