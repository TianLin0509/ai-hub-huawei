'use strict';

// 群聊输入框按 Enter 发送（2026-11-23 维护人实测：新版回车变换行、发不出去）。
// 隔离 Hub + 假 CLI + 休眠群聊；点输入框、打字、按 Enter 都是 CDP 真实输入，发送被拦截后核对原文，
// 同时核对 Shift+Enter 仍是换行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gc-enter-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = process.env.HUB_ENTER_E2E_OUT || path.join(ROOT, 'output', 'playwright', 'group-enter');
const RESULT_PATH = path.join(ARTIFACT_DIR, `group-enter-${RUN_ID}.json`);
const MEETING_ID = 'meeting-paste-chip-e2e';
const MEMBER_ID = 'member-paste-chip-e2e';
const ANSWER_TEXT = '回答文件里的正文：MCS 选择偏保守。';
const TRANSCRIPT_ANSWER = '会话记录里的回答：OLLA 偏移量持续下调。';
const OTHER_SESSION_ID = 'hub-claude-paste-other';

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
      // 第 2 轮：成员在会话里答完了，但没写回答文件
      { type: 'user', uuid: 'u2', timestamp: new Date(now - 25000).toISOString(), message: { role: 'user', content: '第二轮问题' } },
      { type: 'assistant', uuid: 'a2', timestamp: new Date(now - 20000).toISOString(), message: { role: 'assistant', model: 'claude-haiku', stop_reason: 'end_turn', content: [{ type: 'text', text: TRANSCRIPT_ANSWER }] } },
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
  // 第 1 轮：成员已把回答写进回答文件（Hub 启动前就写好，不会再有文件事件），卡片只能靠「打开群聊时核对一次」读到。
  // 打开群聊这一步中途抛错时，卡片会一直停在「还没交」（维护人 11-23 实测的第二个问题）。
  const answerDir = path.join(DATA_DIR, 'task-docs', MEETING_ID, 'answers', 'turn-1', MEMBER_ID);
  fs.mkdirSync(answerDir, { recursive: true });
  fs.writeFileSync(path.join(answerDir, '回答.md'), ANSWER_TEXT, 'utf8');
  const answerDir2 = path.join(DATA_DIR, 'task-docs', MEETING_ID, 'answers', 'turn-2', MEMBER_ID);
  fs.mkdirSync(path.join(DATA_DIR, 'arena-prompts'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'arena-prompts', `${MEETING_ID}-groupchat.json`), JSON.stringify({
    meetingId: MEETING_ID, currentMode: 'idle', currentTurn: 2, nextMessageSeq: 5,
    turns: [{ n: 1, userInput: '第一轮问题', by: {}, byStatus: { [MEMBER_ID]: 'completed' }, createdAt: now - 50000 },
      { n: 2, userInput: '第二轮问题', by: {}, byStatus: { [MEMBER_ID]: 'completed' }, createdAt: now - 30000 }],
    messages: [
      { id: 'u1', seq: 1, turnNum: 1, role: 'user', content: '第一轮问题', createdAt: now - 50000 },
      { id: 'a1-member', seq: 2, turnNum: 1, role: 'assistant', sid: MEMBER_ID, memberId: MEMBER_ID, speaker: 'Claude', content: '', status: 'handed_off', createdAt: now - 40000 },
      { id: 'u2', seq: 3, turnNum: 2, role: 'user', content: '第二轮问题', createdAt: now - 30000 },
      { id: 'a2-member', seq: 4, turnNum: 2, role: 'assistant', sid: MEMBER_ID, memberId: MEMBER_ID, speaker: 'Claude', content: '', status: 'handed_off', createdAt: now - 20000 },
    ],
    answerFiles: {
      1: { [MEMBER_ID]: { kind: 'plain', dir: answerDir, ready: path.join(answerDir, '回答.md'), memberId: MEMBER_ID, speaker: 'Claude', at: now - 50000 } },
      2: { [MEMBER_ID]: { kind: 'plain', dir: answerDir2, ready: path.join(answerDir2, '回答.md'), memberId: MEMBER_ID, speaker: 'Claude', at: now - 30000 } },
    },
  }), 'utf8');
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

async function pressEnter(client, modifiers = 0) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await client.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await reservePort(), label: 'group-enter', windowMode: 'hidden',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e', HUB_SESSION_SEARCH_PREWARM: '0',
      },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor('meeting in sidebar', () => client.eval(`!!document.querySelector('[data-meeting-id="${MEETING_ID}"]')`));
    // 收集渲染进程报错：这次的根因就是输入框初始化中途抛 ReferenceError，Enter 监听没挂上。
    result.exc = [];
    client.ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString());
        if (m.method === 'Runtime.exceptionThrown') result.exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') result.exc.push(m.params.args.map(a => a.value || a.description).join(' '));
      } catch {}
    });
    await client.send('Runtime.enable');
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    await waitFor('group composer', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.getElementById('mr-input-box')`));
    await _waitMs(800);
    // 问题 2：已交的回答要显示出来，不能停在「还没交」。
    result.answerCard = await waitFor('answer card shows the delivered file', () => client.eval(`(() => {
      const card = document.querySelector('.mr-gc-msg.ai[data-source-sid="${MEMBER_ID}"]');
      return card && card.textContent.includes(${JSON.stringify(ANSWER_TEXT)}) ? card.dataset.answerState : null;
    })()`), 12000).catch(async error => {
      result.answerCardText = await client.eval(`document.querySelector('.mr-gc-msg.ai')?.textContent?.trim().slice(0, 120) || null`);
      throw error;
    });
    assert.equal(result.answerCard, 'delivered');
    // 第 2 轮成员已答完但没写回答文件：卡片是「还没交」，必须给「提取」，点了从会话记录取回并写进回答文件。
    const card2 = `.mr-gc-msg.ai[data-source-sid="${MEMBER_ID}"][data-read-turn="2"]`;
    result.turn2Before = await waitFor('turn 2 card offers extract', () => client.eval(`(() => {
      const card = document.querySelector(${JSON.stringify(card2)});
      const btn = card?.querySelector('[data-gc-sync-fallback="transcript"]');
      return btn ? { placeholder: card.querySelector('.mr-gc-empty-placeholder')?.textContent || null, button: btn.textContent } : null;
    })()`), 10000);
    assert.equal(result.turn2Before.placeholder, '还没交');
    // 提取读的是在线成员绑定的会话记录：先像用户点成员一样把休眠成员唤醒（PATH 里的假 CLI 接住）。
    result.wake = await client.eval(`(async () => {
      const { ipcRenderer } = require('electron');
      const meta = sessions.get(${JSON.stringify(MEMBER_ID)});
      const r = await ipcRenderer.invoke('resume-session', meta);
      return { ok: !!r && r.ok !== false, status: sessions.get(${JSON.stringify(MEMBER_ID)})?.status || null };
    })()`);
    await waitFor('member awake', () => client.eval(`(() => { const s = sessions.get(${JSON.stringify(MEMBER_ID)}); return !!s && s.status !== 'dormant'; })()`), 15000);
    await _waitMs(1500);
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      const original = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = async (channel, ...rest) => {
        const r = await original(channel, ...rest);
        if (channel === 'groupchat-manual-extract') window.__extractResult = r;
        return r;
      };
    })()`);
    await client.eval(`document.querySelector(${JSON.stringify(card2)}).scrollIntoView({ block: 'center' })`);
    await _waitMs(300);
    const extractShot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, `group-extract-button-${RUN_ID}.png`), Buffer.from(extractShot.data, 'base64'));
    // 真实鼠标点「提取」（按钮在卡片操作行上直接可见，不在「更多」菜单里）。
    await clickSelector(client, `${card2} [data-gc-sync-fallback="transcript"]`);
    result.turn2After = await waitFor('turn 2 card shows extracted answer', () => client.eval(`(() => {
      const card = document.querySelector(${JSON.stringify(card2)});
      return card && card.textContent.includes(${JSON.stringify(TRANSCRIPT_ANSWER)}) ? card.dataset.answerState : null;
    })()`), 15000).catch(async error => {
      result.turn2Extract = await client.eval('window.__extractResult || null');
      throw error;
    });
    assert.equal(result.turn2After, 'delivered');
    result.turn2File = fs.readFileSync(path.join(DATA_DIR, 'task-docs', MEETING_ID, 'answers', 'turn-2', MEMBER_ID, '回答.md'), 'utf8').trim();
    assert.equal(result.turn2File, TRANSCRIPT_ANSWER);
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      window.__groupTurns = [];
      window.__keyTrace = [];
      document.addEventListener('keydown', e => { if (e.key === 'Enter') window.__keyTrace.push({ phase: 'doc-bubble', prevented: e.defaultPrevented, target: e.target.id || e.target.className }); });
      window.addEventListener('keydown', e => { if (e.key === 'Enter') window.__keyTrace.push({ phase: 'win-capture', target: e.target.id || e.target.className }); }, true);
      window.addEventListener('error', e => window.__keyTrace.push({ phase: 'error', message: e.message }));
      const original = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = (channel, payload, ...rest) => {
        if (channel === 'groupchat:turn') { window.__groupTurns.push(payload); return Promise.resolve({ ok: true, status: 'completed', turnNum: 2 }); }
        return original(channel, payload, ...rest);
      };
    })()`);
    await clickSelector(client, '#mr-input-box');
    await client.send('Input.insertText', { text: '第一行' });
    await pressEnter(client, 8); // Shift+Enter：换行
    await client.send('Input.insertText', { text: '第二行' });
    await _waitMs(200);
    result.beforeSend = await client.eval(`readContenteditablePlainText(document.getElementById('mr-input-box'))`);
    await pressEnter(client);
    await _waitMs(500);
    result.keyTrace = await client.eval('window.__keyTrace');
    result.afterSend = await client.eval(`readContenteditablePlainText(document.getElementById('mr-input-box'))`);
    const turn = await waitFor('group turn dispatched by Enter', () => client.eval('window.__groupTurns && window.__groupTurns[0]'), 8000);
    result.sent = turn.userInput;
    assert.deepEqual(result.exc.filter(t => /meeting-room|ReferenceError/.test(t)), [], 'group composer setup threw');
    assert.equal(result.sent, ['第一行', '第二行'].join(String.fromCharCode(10)));

    // 普通会话输入框同样按 Enter 发送（核对没被同一类问题波及）。
    await client.eval(`(() => {
      const { ipcRenderer } = require('electron');
      window.__sessionSends = [];
      const original = ipcRenderer.invoke.bind(ipcRenderer);
      ipcRenderer.invoke = (channel, payload, ...rest) => {
        if (channel === 'session:send-prompt') { window.__sessionSends.push(payload); return Promise.resolve({ ok: true, status: 'confirmed' }); }
        return original(channel, payload, ...rest);
      };
    })()`);
    await clickSelector(client, `[data-session-id="${OTHER_SESSION_ID}"]`);
    await waitFor('session composer', () => client.eval(`(() => {
      const el = [...document.querySelectorAll('.floating-input-box')].find(e => e.getBoundingClientRect().width > 0 && e.getAttribute('contenteditable') !== 'false');
      if (!el) return null; el.focus(); return true;
    })()`), 20000);
    await client.send('Input.insertText', { text: '普通会话回车发送' });
    await pressEnter(client);
    result.sessionSend = await waitFor('session prompt sent by Enter', () => client.eval('window.__sessionSends[0] && window.__sessionSends[0].text'), 10000);
    assert.equal(result.sessionSend, '普通会话回车发送');
    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E group-enter-send: PASS');
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    try { result.keyTrace = result.keyTrace || await client.eval('window.__keyTrace'); result.afterSend = result.afterSend ?? await client.eval(`readContenteditablePlainText(document.getElementById('mr-input-box'))`); } catch {}
    if (client) { try { const s = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ARTIFACT_DIR, `group-enter-fail-${RUN_ID}.png`), Buffer.from(s.data, 'base64')); } catch {} }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main();
