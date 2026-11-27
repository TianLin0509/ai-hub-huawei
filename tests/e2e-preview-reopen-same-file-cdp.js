'use strict';
// R54：对话里点文件链接打开右侧预览 → 关掉 → 再点同一个文件，必须再次打开。
// 真实隔离 Hub、隐藏窗口，不调用模型、不碰生产数据。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/preview-reopen-same-file-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-reopen-')), data = path.join(root, 'data'), work = path.join(root, 'workspace');
  for (const d of [data, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'optional-features.json'), JSON.stringify({ assistant: false, forum: false }));
  const file = path.join(work, 'reopen-demo.md');
  fs.writeFileSync(file, '# 再开测试\n\n' + 'very-long-line-'.repeat(60) + '\n');
  const logFile = path.join(work, 'long-line-demo.log');
  fs.writeFileSync(logFile, ['short line', 'WRAPME-' + 'x'.repeat(600) + '-END', 'last line', ''].join('\n'));
  // 一个已结束的 Claude 会话，助手回复里带文件路径：卡片视图会把它包成 a.rt-file-link
  const SID = 'hub-claude-preview-reopen', CC = '77777777-7777-4777-8777-777777777777';
  const tdir = path.join(root, 'claude-projects', 'reopen'); fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, CC + '.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-27T01:00:00Z', message: { role: 'user', content: '把结果写到文件里' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-11-27T01:01:00Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '已写好：' + file + ' ，请查看。' }] } },
  ].map(r => JSON.stringify({ ...r, sessionId: CC, cwd: work })).join('\n') + '\n');
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {},
    sessions: [{ schemaVersion: 1, hubId: SID, kind: 'claude', title: '预览再开测试', cwd: work, ccSessionId: CC, transcriptPath: transcript, lastMessageTime: Date.now() - 60000, updatedAt: Date.now() - 60000 }] }));
  const result = { passed: false, checks: [], root }; let hub, c;
  const until = async (expr, ms = 25000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(150); } throw Error('Timeout: ' + expr); };
  const click = async sel => {
    await until(`!!document.querySelector(${JSON.stringify(sel)})`);
    const p = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,onTarget:!!hit&&(hit===e||e.contains(hit))};})()`);
    // 点之前确认鼠标落点就在目标上：落点被别的东西挡住（例如会话区被藏起来、链接尺寸为 0）就是要抓的问题本身
    assert.equal(p.onTarget, true, `click target not hittable: ${sel}`);
    delete p.onTarget;
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
  };
  const shot = async name => { await _waitMs(300); const png = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.data, 'base64')); };
  const shown = `(()=>{const p=document.getElementById('preview-panel');return !!p&&p.style.display!=='none'&&(document.getElementById('preview-body')?.innerText||'').includes('再开测试');})()`;
  const hidden = `(()=>{const p=document.getElementById('preview-panel');return !p||p.style.display==='none';})()`;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'preview-reopen', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: '', AI_HUB_LEGACY_WORKSPACE_ROOTS: '', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
      HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline fixture' }, foreign: { ok: false, error: 'offline fixture' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof openPathInHub === "function"', 30000);
    await until(`sessions.has(${JSON.stringify(SID)})`, 30000);
    await c.eval(`selectSession(${JSON.stringify(SID)})`);
    await until(`!!document.querySelector('.msg-overlay .turn-card:not(.user) a.rt-file-link')`, 30000);
    await _waitMs(1500); // 卡片首屏渲染后还会再排一次版，等它稳定
    for (let round = 1; round <= 4; round += 1) {
      await _waitMs(800); // 人手点的间隔
      await click('.msg-overlay .turn-card:not(.user) a.rt-file-link');
      await until(shown);
      result.checks.push(`round ${round}: opened`);
      if (round === 1) await shot('01-opened-1440');
      await click('#preview-close');
      await until(hidden);
      await until(`(()=>{const a=document.querySelector('.msg-overlay .turn-card:not(.user) a.rt-file-link');return !!a&&a.getBoundingClientRect().width>0;})()`, 5000);
      result.checks.push(`round ${round}: closed, conversation visible`);
    }
    // 预览里的长行：自动换行或有横向滚动条，二选一都行，不能被裁掉看不到
    await click('.msg-overlay .turn-card:not(.user) a.rt-file-link'); await until(shown);
    const overflow = await c.eval(`(()=>{const b=document.getElementById('preview-body');const w=[...b.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+2&&getComputedStyle(e).overflowX==='hidden');return {bodyOverflowX:getComputedStyle(b).overflowX,clipped:w.length,bodyScroll:b.scrollWidth>b.clientWidth};})()`);
    result.overflow = overflow;
    await shot('02-reopened-1440');
    // 代码 / 纯文本预览：长行自动换行，续行对齐在行号右边，不出横向溢出
    await c.eval(`openPathInHub(${JSON.stringify(logFile)}, { preview: true })`);
    await until(`(document.querySelector('#preview-body .preview-code')?.innerText||'').includes('WRAPME')`);
    result.codeWrap = await c.eval(`(()=>{const pre=document.querySelector('#preview-body .preview-code');const row=pre.querySelectorAll('.preview-code-line')[1];const num=row.querySelector('.preview-line-num');const range=document.createRange();range.selectNodeContents(row.lastChild);const rects=[...range.getClientRects()];const nr=num.getBoundingClientRect();return {overflow:pre.scrollWidth-pre.clientWidth,lines:rects.length,textLeft:Math.round(rects[0].left),contLeft:Math.round(rects[rects.length-1].left),numRight:Math.round(nr.right)};})()`);
    assert.ok(result.codeWrap.overflow <= 1, 'code preview overflows horizontally');
    assert.ok(result.codeWrap.lines >= 2, 'long line did not wrap');
    assert.ok(Math.abs(result.codeWrap.contLeft - result.codeWrap.textLeft) <= 1, 'continuation line not aligned with text');
    assert.ok(result.codeWrap.contLeft >= result.codeWrap.numRight - 1, 'continuation line runs under the line numbers');
    await shot('03-code-wrap-1440');
    result.passed = true;
  } catch (error) {
    result.error = String(error && error.stack || error);
    try { result.diag = await c.eval(`(()=>{const p=document.getElementById('preview-panel');const w=document.querySelector('.session-workspace');return {preview:p&&p.style.display,workspaceHidden:!!(w&&w.hidden),terminal:document.getElementById('terminal-panel')?.style.display};})()`); } catch (e) { result.diagError = String(e); }
    try { if (c) await shot('99-failure'); } catch {}
  } finally {
    try { c?.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => { result.quitError = String(e); });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  }
})();
