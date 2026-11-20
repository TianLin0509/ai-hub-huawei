'use strict';

// 群聊引用（与单会话卡片引用同一套，card-quote.js）：隔离 Hub + 假 CLI + 休眠群聊（不唤醒真实 CLI）。
// 群聊回答卡是注入的样例 DOM（带真实成员 sid）；拖选、浮标、点击、打字、发送都是 CDP 真实输入，
// 发送被拦截（不派发给成员）后核对发出的原文。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gc-quote-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = process.env.HUB_QUOTE_E2E_OUT || path.join(ROOT, 'output', 'playwright', 'group-quote');
const RESULT_PATH = path.join(ARTIFACT_DIR, `group-quote-${RUN_ID}.json`);
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `groupchat-paste-chip-${RUN_ID}.png`);
const MEETING_ID = 'meeting-paste-chip-e2e';
const MEMBER_ID = 'member-paste-chip-e2e';
const OTHER_SESSION_ID = 'hub-claude-paste-other';
const LINES = 3000;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
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
  // 假 CLI 保持运行：一退出会话就变「异常」，群聊项点了也不再切回（时序相关的假失败）。
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetInterval(() => {}, 60000);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
  for (const dir of [WORK_DIR, CODEX_HOME, DATA_DIR, path.join(DATA_DIR, 'meetings')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');
  const now = Date.now();
  // 成员要有原生会话 ID 才能被唤醒（由 PATH 里的假 CLI 接住），否则会弹「唤醒失败」挡住输入框。
  const memberSid = '66666666-6666-4666-8666-666666666666';
  const otherSid = '77777777-7777-4777-8777-777777777777';
  const claudeDir = path.join(TEMP_ROOT, 'claude-projects', 'gc-paste');
  fs.mkdirSync(claudeDir, { recursive: true });
  const transcriptFor = sid => {
    const file = path.join(claudeDir, `${sid}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00Z', message: { role: 'user', content: '你好' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-09-25T10:00:01Z', message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: '你好' }] } },
    ].map(row => JSON.stringify({ ...row, sessionId: sid, cwd: WORK_DIR })).join('\n') + '\n', 'utf8');
    return file;
  };
  const memberTranscript = transcriptFor(memberSid);
  const otherTranscript = transcriptFor(otherSid);
  const meeting = {
    schemaVersion: 2, id: MEETING_ID, title: '粘贴块群聊验收', scene: 'general', mode: 'free', groupChat: true,
    groupMode: 'deliberation', workspace: WORK_DIR, workspaceLabel: '粘贴块', createdAt: now - 60000, updatedAt: now - 60000,
    lastMessageTime: now - 60000, subSessions: [MEMBER_ID], slotSpecs: [{ kind: 'claude' }], participants: [0],
    _cursors: { [MEMBER_ID]: 0 }, _nextIdx: 0, _timeline: [],
  };
  fs.writeFileSync(path.join(DATA_DIR, 'meetings', `${MEETING_ID}.json`), JSON.stringify(meeting), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1, cleanShutdown: true, immersiveByMeeting: {}, meetings: [meeting],
    sessions: [
      { schemaVersion: 1, hubId: MEMBER_ID, kind: 'claude', title: '群聊成员', cwd: WORK_DIR, meetingId: MEETING_ID, ccSessionId: memberSid, transcriptPath: memberTranscript, lastMessageTime: now - 60000, updatedAt: now - 60000 },
      { schemaVersion: 1, hubId: OTHER_SESSION_ID, kind: 'claude', title: '别的会话', cwd: WORK_DIR, ccSessionId: otherSid, transcriptPath: otherTranscript, lastMessageTime: now - 30000, updatedAt: now - 30000 },
    ],
  }, null, 2), 'utf8');
}

const INSTALL_PROBE = `(() => {
  if (window.__pasteProbe) return true;
  const probe = { total: 0, max: 0, count: 0 };
  new PerformanceObserver(list => { for (const e of list.getEntries()) { probe.total += e.duration; probe.max = Math.max(probe.max, e.duration); probe.count += 1; } }).observe({ entryTypes: ['longtask'] });
  window.__pasteProbe = probe;
  window.__takeProbe = () => { const s = { total: Math.round(probe.total), max: Math.round(probe.max), count: probe.count }; probe.total = 0; probe.max = 0; probe.count = 0; return s; };
  return true;
})()`;

async function clickSelector(client, selector) {
  // 等到元素可见且没被遮挡再点（群聊面板打开后有一段布局/成员唤醒的过渡）。
  const box = await waitFor(`${selector} visible and clickable`, () => client.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return (hit === el || el.contains(hit)) ? { x, y } : null; })()`), 15000);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function typeKeys(client, text) {
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

const readBox = client => client.eval(`(() => {
  const box = document.getElementById('mr-input-box');
  return { chips: box.querySelectorAll('.fi-paste-chip').length, nodes: box.getElementsByTagName('*').length,
    full: readContenteditablePlainText(box), label: box.querySelector('.fi-paste-chip')?.dataset.label || null };
})()`);

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, note: '群聊卡片是注入的样例 DOM（带真实成员 sid）；选区、浮标、点击、输入框、发送拦截都是真实界面路径' };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await reservePort(), label: 'group-quote', windowMode: 'hidden',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e', HUB_SESSION_SEARCH_PREWARM: '0',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('meeting in sidebar', () => client.eval(`!!document.querySelector('[data-meeting-id="${MEETING_ID}"]')`));
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    await waitFor('group composer', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.getElementById('mr-input-box')`));
    await _waitMs(800);

    // 注入一张群聊回答卡（与渲染器产出的结构一致：.mr-gc-msg.ai[data-source-sid] 内 .gc-journal-text）
    const target = await client.eval(`(() => {
      const host = document.querySelector('.mr-gc-messages') || document.getElementById('mr-input-row')?.parentNode;
      const card = document.createElement('div');
      card.className = 'mr-gc-msg ai';
      card.dataset.sourceSid = ${JSON.stringify(MEMBER_ID)};
      card.dataset.readTurn = '1';
      card.style.cssText = 'padding:12px 16px;margin:12px;max-width:640px';
      card.innerHTML = '<div class="gc-journal-text"><p>结论：吞吐下降主要来自 MCS 选择偏保守。</p><p>OLLA 偏移量一直往下走，平均 MCS 掉了约 2 阶。</p></div>';
      host.prepend(card);
      card.scrollIntoView({ block: 'center' });
      const node = card.querySelectorAll('p')[1].firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 1);
      const a = range.getBoundingClientRect();
      range.setStart(node, node.data.length - 1); range.setEnd(node, node.data.length);
      const b = range.getBoundingClientRect();
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    })()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x1, y: target.y1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x1, y: target.y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x1 + (target.x2 - target.x1) * i / 8, y: target.y1 + (target.y2 - target.y1) * i / 8, button: 'left', buttons: 1 });
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x2, y: target.y2, button: 'left', clickCount: 1 });
    const float = await waitFor('group float quote button', () => client.eval(`(() => {
      const b = document.getElementById('mr-gc-quote-float-btn');
      if (!b || b.style.display === 'none') return null;
      const r = b.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent, single: document.querySelectorAll('.card-quote-float:not([hidden])').length } : null;
    })()`), 5000);
    result.floatText = float.text;
    assert.equal(float.text, '❝ 引用');
    const floatShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, '20261121-group-quote-float.png'), Buffer.from(floatShot.data, 'base64'));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: float.x, y: float.y });
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, x: float.x, y: float.y, button: 'left', clickCount: 1 });
    await waitFor('quote chip in group composer', () => client.eval(`!!document.querySelector('#mr-input-box .fi-paste-chip[data-kind="quote"]')`), 5000);
    result.oldChipRow = await client.eval(`(() => { const r = document.getElementById('mr-quote-chips-row'); return !!r && r.style.display !== 'none' && r.children.length > 0; })()`);
    assert.equal(result.oldChipRow, false, 'old above-composer chip row is no longer used');
    await client.send('Input.insertText', { text: '为什么 OLLA 会一直往下走？' });
    await _waitMs(300);
    result.label = await client.eval(`document.querySelector('#mr-input-box .fi-paste-chip').dataset.label`);
    assert.match(result.label, /第1轮/);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, '20261121-group-quote-composer.png'), Buffer.from(shot.data, 'base64'));

    // 真实点击发送：拦截 groupchat:turn，核对发给成员的原文
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      window.__groupTurns = [];
      const original = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = (channel, payload, ...rest) => {
        if (channel === 'groupchat:turn') { window.__groupTurns.push(payload); return Promise.resolve({ ok: true, status: 'completed', turnNum: 2 }); }
        return original(channel, payload, ...rest);
      };
    })()`);
    await clickSelector(client, '#mr-send-btn');
    const turn = await waitFor('group turn dispatched', () => client.eval('window.__groupTurns && window.__groupTurns[0]'), 10000);
    result.sent = turn.userInput;
    assert.match(result.sent, /^> 引用自【[^】]*第1轮 · 回答片段】：\n> OLLA 偏移量一直往下走，平均 MCS 掉了约 2 阶。\n\n+为什么 OLLA 会一直往下走？$/);
    assert.ok(!/基于以下引用追问/.test(result.sent), 'old quote wrapper is gone');
    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E group-quote: PASS');
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    if (client) { try { const s = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ARTIFACT_DIR, '20261121-group-quote-fail.png'), Buffer.from(s.data, 'base64')); } catch {} }
    console.error(result.error);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main();
