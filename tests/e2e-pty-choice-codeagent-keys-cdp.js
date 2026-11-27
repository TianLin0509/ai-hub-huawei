'use strict';
// CodeAgent 方向键菜单在卡片里能点、能用键盘选（2026-11-27，11-24 群里反馈「CodeAgent 弹出的选项在 Hub 里点不了」）。
// 真实隐藏 Hub + 假 CodeAgent（tests/fixtures/codeagent-permission-standin，FAKE_MENU_STYLE=codeagent：选项不带编号、
//   第一道：卡片输入框上方出现一行选项，鼠标点「Reject」→ CLI 收到 ↓↓回车；
//   第二道：焦点在空输入框里，按 ↓ → 卡片上高亮移到第 2 项；再按回车 → CLI 收到 ↓回车，Hub 没把空消息发出去，全程停在卡片视图。
// 用法：node tests/e2e-pty-choice-codeagent-keys-cdp.js [产物目录]（截图另存到 PTY_CHOICE_SHOT_DIR，默认同产物目录）
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/20261127-pty-choice-codeagent-keys');
const repo = path.resolve(__dirname, '..');
const j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
const readLog = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const shotDir = process.env.PTY_CHOICE_SHOT_DIR || out;
  fs.mkdirSync(shotDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-choice-ca-')), data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.join(root, 'personal');
  for (const dir of [data, work, cfg]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const logFile = path.join(root, 'input.jsonl');
  const result = { passed: false, checks: [], screenshots: [] };
  const save = () => fs.writeFileSync(path.join(out, '20261127-pty-choice-codeagent-keys.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await port(), windowMode: 'hidden', label: 'pty choice codeagent keys', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-permission-standin', 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_CONFIG_ENV: 'FAKE_CA_CONFIG_DIR', AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      AI_HUB_CODEAGENT_SERVE: '0', FAKE_MENU_DELAY_MS: '40000', FAKE_MENU_GAP_MS: '1500', FAKE_MENU_STYLE: 'codeagent', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      FAKE_INPUT_LOG: logFile,
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expression, name, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expression)) return; await _waitMs(200); } throw Error('timeout: ' + name); };
    const capture = async () => { for (let i = 0; ; i += 1) { try { return await c.send('Page.captureScreenshot', { format: 'png' }); } catch (e) { if (i >= 4) throw e; await _waitMs(500); } } };
    const shot = async name => { await _waitMs(300); const d = await capture(); const f = path.join(shotDir, name + '.png'); fs.writeFileSync(f, Buffer.from(d.data, 'base64')); result.screenshots.push(f); save(); };
    const clickEl = async selector => {
      const box = await c.eval(`(() => { const r = document.querySelector(${j(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      assert.ok(box, 'clickable: ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    };
    const key = async (name, code, vk, text) => {
      await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    };
    await wait(`typeof ipcRenderer !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready');

    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, mcpProfile: 'none', permissionMode: 'default' } })})`);
    assert.ok(created && created.id, 'session created: ' + j(created));
    const sid = created.id;
    await c.eval(`selectSession(${j(sid)})`);
    await c.eval(`applyViewMode('card'), true`);
    await wait(`!!document.querySelector('.floating-input-box')`, 'composer');
    const row = `.card-view-active .pty-choice-inline[data-mode="menu"]:not([hidden])`;
    await wait(`document.querySelectorAll(${j(row + ' .pty-choice-option')}).length === 3`, 'inline menu row (codeagent style)', 90000);
    result.rowA = await c.eval(`(() => { const el = document.querySelector(${j(row)}); const r = el.getBoundingClientRect();
      return { question: el.querySelector('.pty-choice-question').textContent, options: [...el.querySelectorAll('.pty-choice-option')].map(b => b.textContent),
        selected: el.querySelector('.pty-choice-option[data-selected="1"]')?.dataset.key || null, hint: el.querySelector('.pty-choice-keys')?.textContent || '', height: r.height, width: r.width }; })()`);
    assert.equal(result.rowA.question, '允许执行 dir？');
    assert.deepEqual(result.rowA.options, ['Allow once', 'Allow always', 'Reject']);
    assert.equal(result.rowA.selected, '1');
    assert.ok(result.rowA.height <= 26, '一行高：' + result.rowA.height);
    result.checks.push(`无编号 CodeAgent 菜单认出：${result.rowA.question} ${result.rowA.options.join(' / ')}，提示「${result.rowA.hint}」（高 ${result.rowA.height}px、宽 ${Math.round(result.rowA.width)}px）`);
    await shot('20261127-r52-codeagent-menu-card-1440');
    await clickEl(row + ' .pty-choice-option[data-key="3"]');
    for (let k = 0; k < 20; k += 1) { await _waitMs(150); const n = await c.eval(`[...document.querySelectorAll('.pty-choice-note')].map(x => x.textContent).join('|')`); if (n) { result.noteAfterClick = n; break; } }
    for (const end = Date.now() + 15000; Date.now() < end && !readLog(logFile).some(x => x.chosen); await _waitMs(200));
    const first = readLog(logFile).find(x => x.chosen);
    assert.ok(first, 'CLI 收到选择');
    assert.equal(first.chosen, '3'); assert.deepEqual(first.keys, ['\x1b[B', '\x1b[B', '\r']);
    result.checks.push('鼠标点「Reject」→ CLI 收到 ↓↓回车，选中第 3 项');

    // 第二道：键盘
    await wait(`document.querySelectorAll(${j(row + ' .pty-choice-option')}).length === 3 && document.querySelector(${j(row + ' .pty-choice-option[data-selected="1"]')})?.dataset.key === '1'`, 'second menu row', 30000);
    await clickEl('.card-view-active .floating-input-box');
    assert.equal(await c.eval(`document.activeElement?.classList?.contains('floating-input-box') && !document.activeElement.textContent.trim()`), true, '焦点在空输入框');
    await key('ArrowDown', 'ArrowDown', 40);
    await wait(`document.querySelector(${j(row + ' .pty-choice-option[data-selected="1"]')})?.dataset.key === '2'`, 'highlight moved to 2 via keyboard', 10000);
    result.checks.push('空输入框里按 ↓ → 卡片上高亮移到第 2 项（终端光标跟着动）');
    await shot('20261127-r52-codeagent-menu-keyboard-1440');
    await key('Enter', 'Enter', 13, '\r');
    for (const end = Date.now() + 15000; Date.now() < end && readLog(logFile).filter(x => x.chosen).length < 2; await _waitMs(200));
    const second = readLog(logFile).filter(x => x.chosen)[1];
    assert.ok(second, 'CLI 收到键盘选择');
    assert.equal(second.chosen, '2'); assert.deepEqual(second.keys, ['\x1b[B', '\r']);
    result.inputAfter = await c.eval(`document.querySelector('.card-view-active .floating-input-box')?.textContent || ''`);
    assert.equal(result.inputAfter.trim(), '', '回车没有往输入框里塞换行');
    result.secondMenuInput = readLog(logFile).filter(x => x.menu === 1 && x.data != null).map(x => x.data);
    assert.ok(result.secondMenuInput.every(d => /^(?:\x1b\[[AB]|\r)+$/.test(d)), '第二道菜单期间终端只收到方向键和回车：' + j(result.secondMenuInput));
    result.checks.push('再按回车 → CLI 收到 ↓回车，选中第 2 项；没有发出消息');
    await wait(`!document.querySelector(${j(row)})`, 'row gone after answers', 15000);
    assert.equal(await c.eval('currentView'), 'card');
    result.checks.push('答完提示条收起，全程停在卡片视图');
    await shot('20261127-r52-codeagent-menu-after-1440');
    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    result.log = readLog(logFile);
    try { result.debug = await c.eval(`(async () => { const s = sessions.get(activeSessionId); const t = getSessionRuntimeTruth(s); return { runtime: { state: t.state, source: t.source, detail: t.detail }, view: currentView, note: [...document.querySelectorAll('.pty-choice-note')].map(n => n.textContent), read: await ipcRenderer.invoke('pty-choice:read', { sessionId: activeSessionId }) }; })()`); } catch (e) { result.debug = String(e); }
    try { const d = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261127-pty-choice-codeagent-failed.png'), Buffer.from(d.data, 'base64')); } catch { /* 截不到 */ }
  } finally {
    save();
    try { if (c) c.close(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程可能还占着 */ }
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error ? result.error.split('\n')[0] : undefined }));
    process.exit(result.passed ? 0 : 1);
  }
})();
