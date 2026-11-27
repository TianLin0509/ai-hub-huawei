'use strict';
// 卡片视图里直接回答终端授权菜单（2026-11-24 一键反馈 v5.6.99）。真实隐藏 Hub + 假 CodeAgent（tests/fixtures/codeagent-permission-standin）：
//   A 会话（权限档 default）：卡片输入框上方出现一行小字选项，鼠标点「允许」→ CLI 收到回车；第二道点「拒绝」→ CLI 收到 ↓↓回车；
//                             提示条是普通文档流里的一行（不是盖住对话的浮层），全程不切到终端视图。
//   B 会话（权限档全部放开）：同样的授权菜单由 Hub 按设置直接允许，卡片上不出现提示条。
// 用法：node tests/e2e-pty-choice-card-cdp.js [产物目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'artifacts/20261124-pty-choice-card');
const repo = path.resolve(__dirname, '..');
const j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
const readLog = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-choice-')), data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.join(root, 'personal');
  for (const dir of [data, work, cfg]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  // 两个会话共用一个假 CLI 和同一份按键记录，按先后顺序区分
  const logA = path.join(root, 'input.jsonl');
  const result = { passed: false, checks: [], screenshots: [] };
  const save = () => fs.writeFileSync(path.join(out, '20261124-pty-choice-card.json'), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await port(), windowMode: 'hidden', label: 'pty choice card', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-permission-standin', 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_CONFIG_ENV: 'FAKE_CA_CONFIG_DIR', AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      AI_HUB_CODEAGENT_SERVE: '0', FAKE_MENU_DELAY_MS: '40000', FAKE_MENU_GAP_MS: '1500', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      FAKE_INPUT_LOG: logA,
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expression, name, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expression)) return; await _waitMs(200); } throw Error('timeout: ' + name); };
    // 隐藏窗口偶尔截不到图（Unable to capture screenshot），重试几次
    const capture = async () => { for (let i = 0; ; i += 1) { try { return await c.send('Page.captureScreenshot', { format: 'png' }); } catch (e) { if (i >= 4) throw e; await _waitMs(500); } } };
    const shot = async name => { await _waitMs(300); const d = await capture(); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(d.data, 'base64')); result.screenshots.push(path.join(out, name + '.png')); save(); };
    const clickEl = async selector => {
      const box = await c.eval(`(() => { const r = document.querySelector(${j(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      assert.ok(box, 'clickable: ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    };
    await wait(`typeof ipcRenderer !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready');

    // ---- A：权限档 default，卡片里点选项 ----
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, mcpProfile: 'none', permissionMode: 'default' } })})`);
    assert.ok(created && created.id, 'session created: ' + j(created));
    const sid = created.id, q = j(sid);
    await c.eval(`selectSession(${q})`);
    await c.eval(`applyViewMode('card'), true`);
    await wait(`!!document.querySelector('.floating-input-box')`, 'composer');
    const row = `.card-view-active .pty-choice-inline[data-mode="menu"]:not([hidden])`;
    await wait(`!!document.querySelector(${j(row)}) && document.querySelectorAll(${j(row + ' .pty-choice-option')}).length === 3`, 'inline menu row', 90000);
    result.rowA = await c.eval(`(() => { const el = document.querySelector(${j(row)}); const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { question: el.querySelector('.pty-choice-question').textContent, options: [...el.querySelectorAll('.pty-choice-option')].map(b => b.textContent),
        height: r.height, width: r.width, shadow: cs.boxShadow, fontSize: cs.fontSize, background: cs.backgroundColor, view: currentView,
        composerBottom: document.querySelector('.terminal-panel.card-view-active .composer')?.getBoundingClientRect().bottom, viewport: innerHeight }; })()`);
    assert.equal(result.rowA.question, '允许执行 dir？');
    assert.deepEqual(result.rowA.options, ['允许', '允许且不再询问', '拒绝']);
    assert.ok(result.rowA.height <= 26, '一行高：' + result.rowA.height);
    assert.equal(result.rowA.shadow, 'none', '不是带阴影的浮层');
    assert.ok(result.rowA.width < 700, '只有文字那么宽：' + result.rowA.width);
    assert.ok(result.rowA.composerBottom <= result.rowA.viewport, '输入框没被挤出窗口');
    assert.equal(result.rowA.fontSize, '12px');
    result.checks.push('卡片输入框上方出现一行小字：' + result.rowA.question + ' ' + result.rowA.options.join(' / ') + `（高 ${result.rowA.height}px、宽 ${Math.round(result.rowA.width)}px，无阴影，输入框未被挤压）`);
    const outDir = process.env.PTY_CHOICE_SHOT_DIR || out;
    fs.mkdirSync(outDir, { recursive: true });
    { const d = await capture(); const f = path.join(outDir, '20261124-r24-card-inline-choice-1440.png'); fs.writeFileSync(f, Buffer.from(d.data, 'base64')); result.screenshots.push(f); }
    await clickEl(row + ' .pty-choice-option[data-key="1"]');
    for (const end = Date.now() + 15000; Date.now() < end && !readLog(logA).some(x => x.chosen); await _waitMs(200));
    const first = readLog(logA).find(x => x.chosen);
    assert.ok(first, 'CLI 收到选择');
    assert.equal(first.chosen, '1'); assert.deepEqual(first.keys, ['\r']);
    result.checks.push('点「允许」→ CLI 收到回车，选中第 1 项 ' + j(first.label));
    // 第二道：点「拒绝」，需要 ↓↓回车
    await wait(`/del commands/.test(document.querySelector(${j(row + ' .pty-choice-option[data-key="2"]')})?.title || '')`, 'second menu row', 30000);
    await _waitMs(400);
    await clickEl(row + ' .pty-choice-option[data-key="3"]');
    for (const end = Date.now() + 15000; Date.now() < end && readLog(logA).filter(x => x.chosen).length < 2; await _waitMs(200));
    const second = readLog(logA).filter(x => x.chosen)[1];
    assert.ok(second, 'CLI 收到第二次选择');
    assert.equal(second.chosen, '3'); assert.deepEqual(second.keys, ['\x1b[B', '\x1b[B', '\r']);
    result.checks.push('第二道点「拒绝」→ CLI 收到 ↓↓回车，选中第 3 项 ' + j(second.label));
    await wait(`!document.querySelector(${j(row)})`, 'row gone after answers', 15000);
    result.viewAfter = await c.eval('currentView');
    assert.equal(result.viewAfter, 'card');
    result.checks.push('答完提示条收起，全程停在卡片视图');
    await shot('20261124-r24-card-after-answer-1440');
    { const f = path.join(outDir, '20261124-r24-card-after-answer-1440.png'); fs.copyFileSync(path.join(out, '20261124-r24-card-after-answer-1440.png'), f); }

    // ---- B：权限档全部放开，Hub 直接允许 ----
    // A 的两道都答完后才开 B，B 收到的按键就是记录里的下一条选择
    const before = readLog(logA).filter(x => x.chosen).length;
    const createdB = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, mcpProfile: 'none', permissionMode: 'bypassPermissions' } })})`);
    assert.ok(createdB && createdB.id, 'session B created');
    const qb = j(createdB.id);
    await c.eval(`selectSession(${qb})`);
    await c.eval(`applyViewMode('card'), true`);
    let sawRow = false;
    for (const end = Date.now() + 90000; Date.now() < end && readLog(logA).filter(x => x.chosen).length < before + 1; await _waitMs(150)) {
      if (await c.eval(`!!document.querySelector(${j(row)})`)) sawRow = true;
    }
    const auto = readLog(logA).filter(x => x.chosen)[before];
    assert.ok(auto, '全部放开的会话：授权被自动答掉');
    assert.equal(auto.chosen, '1'); assert.deepEqual(auto.keys, ['\r']);
    result.autoSawRow = sawRow;
    result.checks.push('全部放开的会话：Hub 按设置自动选「Yes」' + (sawRow ? '（自动答前提示条闪现过）' : '，卡片上没出现提示条'));
    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    result.log = readLog(logA);
    try { result.debug = await c.eval(`(async () => { const s = sessions.get(activeSessionId); const t = getSessionRuntimeTruth(s); return { runtime: { state: t.state, source: t.source, detail: t.detail }, agentRuntime: s.agentRuntime, backend: s.runtimeBackend || null, status: s.status, view: currentView, read: await ipcRenderer.invoke('pty-choice:read', { sessionId: activeSessionId }), tail: (typeof extractTailLines === 'function' ? extractTailLines(activeSessionId, 14) : null) }; })()`); } catch (e) { result.debug = String(e); }
    try { const d = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261124-pty-choice-failed.png'), Buffer.from(d.data, 'base64')); } catch { /* 截不到 */ }
  } finally {
    save();
    try { if (c) c.close(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程可能还占着 */ }
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, error: result.error ? result.error.split('\n')[0] : undefined }));
    process.exit(result.passed ? 0 : 1);
  }
})();
