'use strict';

// 卡片引用：隔离 Hub + 假 CLI（不花额度），在单会话卡片视图里
//   1) 点整卡「引用」→ 输入框出现引用芯片；
//   2) 用鼠标拖选卡片里的一段 → 浮出「❝ 引用」→ 真实鼠标点击 → 第二个芯片；
//   3) 接着打字，读输入框「将要发送的文字」，核对格式与顺序；
//   4) 悬停芯片看预览，退格整块删除；
//   5) 浅色 1440 宽、深色、窄宽 900 三张截图。
// 鼠标与键盘都用 CDP Input.dispatch*，属于浏览器层真实输入；不碰系统剪贴板。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-card-quote-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = process.env.HUB_QUOTE_E2E_OUT || path.join(ROOT, 'output', 'playwright', 'card-quote');
const SESSION_ID = 'hub-claude-quote-target';
const CLAUDE_SID = '66666666-6666-4666-8666-666666666666';
const ANSWER = [
  '结论：这次吞吐下降主要来自 MCS 选择偏保守。',
  '',
  '1. BLER 目标从 10% 收紧到 5%，OLLA 的偏移量一直往下走，平均 MCS 掉了约 2 阶。',
  '2. 调度器在小包场景下优先保时延，RB 利用率只有 62%。',
  '',
  '建议先把 BLER 目标恢复到 10%，再看 RB 利用率是否回升。',
].join('\n');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await _waitMs(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetTimeout(() => process.exit(0), 120);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`),
      `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
  for (const dir of [WORK_DIR, CODEX_HOME, DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');
  const claudeDir = path.join(TEMP_ROOT, 'claude-projects', 'quote-e2e');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudePath = path.join(claudeDir, `${CLAUDE_SID}.jsonl`);
  fs.writeFileSync(claudePath, [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-20T06:30:00Z', message: { role: 'user', content: '帮我看看这次吞吐为什么掉了' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-11-20T06:32:00Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: ANSWER }] } },
  ].map(row => JSON.stringify({ ...row, sessionId: CLAUDE_SID, cwd: WORK_DIR })).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1, cleanShutdown: true,
    sessions: [{ schemaVersion: 1, hubId: SESSION_ID, kind: 'claude', title: 'Claude 引用测试', cwd: WORK_DIR,
      ccSessionId: CLAUDE_SID, transcriptPath: claudePath, lastMessageTime: Date.now() - 60_000, updatedAt: Date.now() - 60_000 }],
    meetings: [], immersiveByMeeting: {},
  }, null, 2), 'utf8');
}

const settle = client => client.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 80))))');

async function click(client, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

async function shot(client, name) {
  const file = path.join(ARTIFACT_DIR, `20261120-card-quote-${name}.png`);
  const data = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
  return file;
}

const ANSWER_CARD = ".msg-overlay .turn-card:not(.user)";

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = Number(process.env.HUB_QUOTE_E2E_PORT) || await reservePort();
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, shots: {} };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port, label: 'card-quote',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e',
        HUB_SESSION_SEARCH_PREWARM: '0',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('session loaded', () => client.eval(`sessions.has(${JSON.stringify(SESSION_ID)})`));
    await client.eval(`selectSession(${JSON.stringify(SESSION_ID)})`);
    await waitFor('composer', () => client.eval("!!document.querySelector('.floating-input-box')"));
    await waitFor('answer card', () => client.eval(`!!document.querySelector(${JSON.stringify(ANSWER_CARD + ' .turn-body')}) && document.querySelector(${JSON.stringify(ANSWER_CARD + ' .turn-body')}).textContent.includes('BLER')`), 30000);
    await settle(client);

    // 1) 整卡引用：先悬停卡片让操作区出现，再真实点击「引用」
    const btn = await client.eval(`(() => {
      const card = document.querySelector(${JSON.stringify(ANSWER_CARD)});
      card.scrollIntoView({ block: 'center' });
      const r = card.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + 20 };
    })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.cx, y: btn.cy });
    await settle(client);
    const qb = await client.eval(`(() => {
      const b = document.querySelector(${JSON.stringify(ANSWER_CARD + ' [data-action="quote"]')});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && getComputedStyle(b).visibility !== 'hidden' };
    })()`);
    assert.ok(qb, 'answer card has a 引用 button');
    result.quoteButtonVisibleOnHover = qb.visible;
    if (qb.visible) await click(client, qb.x, qb.y);
    else await client.eval(`document.querySelector(${JSON.stringify(ANSWER_CARD + ' [data-action="quote"]')}).click()`);
    await waitFor('first quote chip', () => client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip[data-kind=\"quote\"]').length === 1"));

    // 2) 选中一段：用鼠标从「BLER」拖到这一行末尾
    const drag = await client.eval(`(() => {
      const body = document.querySelector(${JSON.stringify(ANSWER_CARD + ' .turn-body')});
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) { if (node.data.includes('BLER 目标从')) break; }
      if (!node) return null;
      const start = node.data.indexOf('BLER 目标从');
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 1);
      const a = range.getBoundingClientRect();
      const endIdx = node.data.indexOf('2 阶') + 3;
      range.setStart(node, endIdx - 1); range.setEnd(node, endIdx);
      const b = range.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    })()`);
    assert.ok(drag, 'found the passage to select');
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1, y: drag.y1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x1, y: drag.y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x1 + (drag.x2 - drag.x1) * i / 8, y: drag.y1 + (drag.y2 - drag.y1) * i / 8, button: 'left', buttons: 1 });
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x2, y: drag.y2, button: 'left', clickCount: 1 });
    const floatBtn = await waitFor('float quote button', () => client.eval(`(() => {
      const b = document.querySelector('.card-quote-float');
      if (!b || b.hidden) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel: String(getSelection()) };
    })()`), 5000);
    result.selectedText = floatBtn.sel;
    result.shots.floatButton = await shot(client, 'float-button-light');
    await click(client, floatBtn.x, floatBtn.y);
    await waitFor('second quote chip', () => client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip[data-kind=\"quote\"]').length === 2"));

    // 3) 接着打字（中文用 insertText，等同输入法上屏）
    await client.send('Input.insertText', { text: '第 2 条里 OLLA 为什么会一直往下走？' });
    await settle(client);
    const outgoing = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
    result.outgoing = outgoing;
    assert.match(outgoing, /^> 引用自【[^】]*回答 · 11-20 \d\d:32】：\n> 结论：这次吞吐下降/, 'whole-card quote first');
    assert.match(outgoing, /\n> 引用自【[^】]*回答片段 · 11-20 \d\d:32】：\n> BLER 目标从 10% 收紧到 5%[^\n]*2 阶\n\n+第 2 条里 OLLA/, 'selection quote then the question');
    result.shots.chipsLight = await shot(client, 'chips-light-1440');

    // 4) 悬停芯片看预览
    const chipPos = await client.eval(`(() => { const r = document.querySelectorAll('.floating-input-box .fi-paste-chip')[1].getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chipPos.x, y: chipPos.y });
    await waitFor('preview', () => client.eval("(() => { const p = document.querySelector('.fi-paste-preview'); return p && !p.hidden && p.dataset.kind === 'quote'; })()"), 5000);
    result.previewTitle = await client.eval("document.querySelector('.fi-paste-preview-head strong').textContent");
    result.previewBody = await client.eval("document.querySelector('.fi-paste-preview-body').textContent");
    assert.ok(!result.previewBody.startsWith('>'), 'preview shows the passage itself, not the > markup');
    result.shots.preview = await shot(client, 'preview-light');
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });

    // 5) 深色、窄宽
    await client.eval("themeController.setTheme('dark')");
    await settle(client);
    result.shots.chipsDark = await shot(client, 'chips-dark-1440');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
    await settle(client);
    result.chipFitsNarrow = await client.eval("[...document.querySelectorAll('.floating-input-box .fi-paste-chip')].every(c => c.getBoundingClientRect().right <= document.querySelector('.floating-input-box').getBoundingClientRect().right + 1)");
    result.shots.narrowDark = await shot(client, 'chips-dark-900');
    await client.eval("themeController.setTheme('codex')");

    result.composerDom = await client.eval("[...document.querySelector('.floating-input-box').childNodes].map(n => n.nodeType === 3 ? JSON.stringify(n.data) : '<' + n.nodeName + (n.className ? '.' + n.className : '') + '>').join(' ')");
    // 6) 退格整块删除：光标在问题前面时，退格删掉第二个引用
    await client.eval(`(() => {
      const box = document.querySelector('.floating-input-box'); box.focus();
      // 光标放在问题那一行的行首（用户点在问题前面再按退格的样子）
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) { if (node.data.includes('第 2 条')) break; }
      const range = document.createRange();
      range.setStart(node, node.data.indexOf('第 2 条'));
      range.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await settle(client);
    // 芯片后面跟着一个换行：第一下退格删换行，第二下整块删芯片。
    result.backspaces = 1;
    result.chipsAfterBackspace = await client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip').length");
    if (result.chipsAfterBackspace === 2) {
      await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await settle(client);
      result.backspaces = 2;
      result.chipsAfterBackspace = await client.eval("document.querySelectorAll('.floating-input-box .fi-paste-chip').length");
    }
    assert.equal(result.chipsAfterBackspace, 1, 'backspace removes the whole quote chip');
    result.afterDelete = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
    assert.ok(result.afterDelete.includes('第 2 条里 OLLA') && !result.afterDelete.includes('回答片段'), 'question kept, quote gone');

    // 7) 光标停在一句话中间时引用（独立审查提出的场景）：引用必须另起一行，不能把原句拆成「请解释> 引用自」
    await client.eval(`(() => {
      const box = document.querySelector('.floating-input-box'); box.focus();
      document.execCommand('selectAll'); document.execCommand('delete');
      document.execCommand('insertText', false, '请解释这个结论');
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) { if (node.data.includes('请解释')) break; }
      const range = document.createRange(); range.setStart(node, node.data.indexOf('这个')); range.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      document.querySelector(${JSON.stringify(ANSWER_CARD + ' [data-action="quote"]')}).click();
    })()`);
    await settle(client);
    result.midCaret = await client.eval("readContenteditablePlainText(document.querySelector('.floating-input-box'))");
    assert.match(result.midCaret, /^请解释\n> 引用自【[^】]*】：\n> 结论[\s\S]*\n\n+这个结论$/, 'quote starts on its own line and the sentence continues after it');

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error.stack || String(error);
    if (client) { try { result.shots.failure = await shot(client, 'failure'); } catch {} }
  } finally {
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
    const file = path.join(ARTIFACT_DIR, `20261120-card-quote-result-${RUN_ID}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: result.ok, file, error: result.error && result.error.split('\n')[0] }));
    if (!result.ok) process.exitCode = 1;
  }
}

main();
