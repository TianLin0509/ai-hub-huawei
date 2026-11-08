'use strict';
// 首次准备（2026-11-07 用户：第一次会话后台在点信任、选模型，前台像卡住）。真实隐藏 Hub + 假 CodeAgent（tests/fixtures/codeagent-trust-standin）：
//   auto：信任框带光标 → Hub 自动点掉，卡片底部指示条写「确认目录信任 ✓」；
//   stuck：信任框没有光标标记 → 8 秒后提示条请用户到「后台」点 Yes，用户回车后指示条更新为 ✓；
// 两种都检查：配置目录第一次用（没有 .cac.json）时，CLI 建好状态文件后 Hub 补写了信任。
// 用法：node tests/e2e-codeagent-first-run-trust-cdp.js <auto|stuck> [产物目录]
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const mode = process.argv[2] === 'stuck' ? 'stuck' : 'auto';
const out = path.resolve(process.argv[3] || `artifacts/20261107-codeagent-first-run-${mode}`);
const repo = path.resolve(__dirname, '..');
const j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-first-run-')), data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.join(root, 'personal');
  for (const dir of [data, work, cfg]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const result = { mode, passed: false, checks: [], screenshots: [], phases: [] };
  const save = () => fs.writeFileSync(path.join(out, `20261107-first-run-${mode}.json`), JSON.stringify(result, null, 2));
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await port(), windowMode: 'hidden', label: 'CodeAgent first run ' + mode, extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-trust-standin', 'codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_CONFIG_ENV: 'FAKE_CA_CONFIG_DIR', AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      AI_HUB_CODEAGENT_SERVE: '0', FAKE_TRUST_MODE: mode, FAKE_INPUT_LOG: path.join(root, 'fake-input.jsonl'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'),
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const wait = async (expression, name, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expression)) return; await _waitMs(200); } throw Error('timeout: ' + name); };
    const shot = async name => { await _waitMs(300); const d = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(d.data, 'base64')); result.screenshots.push(name + '.png'); save(); };
    await wait(`typeof ipcRenderer !== 'undefined' && typeof selectSession === 'function'`, 'renderer ready');
    await c.eval(`(() => { window.__phases = []; window.__notices = []; window.__toasts = []; try { const o = showToast; showToast = (t, l) => { window.__toasts.push(String(t)); return o(t, l); }; } catch (e) { window.__toasts.push('hook-failed ' + e.message); } ipcRenderer.on('codeagent-launch-phase', (_e, p) => window.__phases.push(p)); ipcRenderer.on('session-notice', (_e, p) => window.__notices.push(p)); return true; })()`);
    const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd: work, mcpProfile: 'none' } })})`);
    assert.ok(created && created.id, 'session created: ' + j(created));
    const sid = created.id, q = j(sid);
    await c.eval(`selectSession(${q})`);
    // 像新用户一样：会话一开就在输入框里打「你好」回车（真实输入路径，卡片和指示条由界面自己生成）。
    await c.eval(`applyViewMode('card'), true`);
    await wait(`!!document.querySelector('.floating-input-box')`, 'composer');
    await c.eval(`(() => { const box = document.querySelector('.floating-input-box'); box.focus(); const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await c.send('Input.insertText', { text: '你好' });
    await _waitMs(300);
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await wait(`window.__phases.some(p => /确认目录信任/.test(p.label))`, 'trust detected phase');
    result.checks.push('信任框出现后，界面收到「确认目录信任…」进度');
    if (mode === 'stuck') {
      await wait(`window.__phases.some(p => /需要你在「后台」点一下/.test(p.label))`, 'stuck phase', 30000);
      await wait(`window.__notices.some(n => n.persistent && /Yes, I trust this folder/.test(n.message))`, 'stuck notice', 5000);
      await wait(`/需要你在「后台」点一下/.test(document.querySelector('.streaming-indicator[data-session-id=${q}]')?.dataset.label || '')`, 'indicator shows stuck', 15000);
      result.stuckIndicator = await c.eval(`document.querySelector('.streaming-indicator[data-session-id=${q}]')?.dataset.label || ''`);
      result.stuckCards = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card').length`);
      result.stuckPhasesSoFar = await c.eval(`window.__phases.map(p => p.label)`);
      result.stuckState = await c.eval(`(() => { const s = sessions.get(${q}); return { status: s.status, source: s.cardWorkingSource || null, since: s.cardWorkingSince || null, runtime: getSessionRuntimeTruth(s).state, composer: document.querySelector('.floating-input-box')?.innerText || '', toasts: window.__toasts, notices: window.__notices.map(n => n.message) }; })()`);
      await shot('20261107-first-run-stuck-1440');
      result.stuckIndicatorAfterShot = await c.eval(`document.querySelector('.streaming-indicator[data-session-id=${q}]')?.dataset.label || ''`);
      result.checks.push('自动点不掉时：8 秒后常驻提示请用户到「后台」点 Yes，指示条同步写明');
      // 用户迟迟没去点（超过「启动中」15 秒有效期）：指示条仍在、仍写着要点信任、秒数还在走。
      await _waitMs(12000);
      await c.eval(`_updateStreamingIndicator(${q}), true`);
      result.stuckIndicatorLate = await c.eval(`document.querySelector('.streaming-indicator[data-session-id=${q}]')?.dataset.label || ''`);
      assert.match(result.stuckIndicatorLate, /需要你在「后台」点一下/);
      assert.match(result.stuckIndicatorLate, /已等 (1[6-9]|[2-9]\d|\d{3,}) 秒/);
      result.checks.push('超过 15 秒仍未点：指示条留着并继续计时 — ' + result.stuckIndicatorLate);
      await c.eval(`ipcRenderer.send('terminal-input', { sessionId: ${q}, data: 'y' }), true`);
    }
    await wait(`window.__phases.some(p => /确认目录信任 ✓/.test(p.label))`, 'trust done phase', 30000);
    result.checks.push(mode === 'auto' ? 'Hub 自动点掉信任框，进度更新为 ✓' : '用户在后台回车后，进度更新为 ✓');
    await wait(`/确认目录信任 ✓/.test(document.querySelector('.streaming-indicator[data-session-id=${q}][data-launch-phase]')?.dataset.label || '')`, 'indicator with phase', 30000);
    await _waitMs(2200); // 让「已等 N 秒」走过几秒，确认每秒在刷新
    result.indicator = await c.eval(`document.querySelector('.streaming-indicator[data-session-id=${q}]')?.dataset.label || ''`);
    assert.match(result.indicator, /已等 ([2-9]|\d{2,}) 秒/);
    assert.match(result.indicator, /准备 CodeAgent：/);
    assert.match(result.indicator, /已等 \d+/);
    await shot(`20261107-first-run-${mode}-1440`);
    result.checks.push('卡片底部指示条：' + result.indicator);
    // 补写信任：假 CLI 启动时才建出 .cac.json，Hub 在它建好 1.5 秒后补上这个目录的信任。
    const key = path.resolve(work).replace(/\\/g, '/');
    for (const end = Date.now() + 15000; Date.now() < end; await _waitMs(300)) {
      try { const st = JSON.parse(fs.readFileSync(path.join(cfg, '.cac.json'), 'utf8')); if (st.projects && st.projects[key] && st.projects[key].hasTrustDialogAccepted === true) { result.backfilled = true; break; } } catch { /* 还在写 */ }
    }
    assert.equal(result.backfilled, true, '.cac.json 建好后补写了信任');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, '.cac.json'), 'utf8')).numStartups, 1, 'CLI 自己写的内容保留');
    result.checks.push('配置目录第一次用：CLI 建好 .cac.json 后 Hub 补写信任，原有内容保留');
    // 信任框点掉之前，假 CLI 只能收到一次回车（auto：Hub 的自动确认；stuck：测试替用户按的），不能有「你好」或 /model 敲进框里。
    const inputs = fs.readFileSync(path.join(root, 'fake-input.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    result.inputsBeforeTrust = inputs.filter(x => !x.trusted).map(x => x.data);
    assert.deepEqual(result.inputsBeforeTrust.join('').replace(/\x1b\[[AB]/g, ''), mode === 'stuck' ? 'y' : '\r', 'only the trust confirmation reaches the dialog: ' + j(result.inputsBeforeTrust));
    result.checks.push('信任框在时没有任何字被敲进框里（第一句和选模型都等框点掉）');
    // 选模型对假 CLI 不会成功，回退后第一句仍按「CodeAgent 当前模型」照常发出，并且是在信任框点掉之后。
    for (const end = Date.now() + 90000; Date.now() < end; await _waitMs(500)) {
      const all = fs.readFileSync(path.join(root, 'fake-input.jsonl'), 'utf8');
      if (/你好/.test(all)) { result.helloDelivered = true; break; }
    }
    assert.equal(result.helloDelivered, true, '第一句「你好」在信任框点掉后送进了 CLI');
    result.checks.push('第一句「你好」在信任框点掉后送进了 CLI');
    result.finalCards = await c.eval(`document.querySelectorAll('#msg-overlay .turn-card').length`);
    result.finalToasts = await c.eval(`window.__toasts`);
    result.phases = await c.eval(`window.__phases`);
    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    try { result.phases = await c.eval(`window.__phases`); } catch { /* 页面已断 */ }
    try { const d = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `20261107-first-run-${mode}-failed.png`), Buffer.from(d.data, 'base64')); } catch { /* 截不到 */ }
  } finally {
    save();
    try { if (c) c.close(); } catch { /* ignore */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
    if (process.env.KEEP_FIRST_RUN_ROOT === "1") console.log("kept " + root); else try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 进程可能还占着 */ }
    console.log(JSON.stringify({ mode, passed: result.passed, checks: result.checks.length, error: result.error ? result.error.split('\n')[0] : undefined }));
    process.exit(result.passed ? 0 : 1);
  }
})();
