'use strict';

// 群聊回答卡片三态（2026-11-23 群聊体验修复）：隔离 Hub + 3 位模拟成员，按真实推送事件驱动
// 「进行中 → 部分完成 → 全部完成」，核对每张卡片的状态与按钮，并各截一张 1440×900 图。
// 群聊状态由渲染进程的 groupchat:get-state 返回值叠加本轮假状态（主进程侧逻辑另有单测）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gc-card-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const ARTIFACT_DIR = process.env.HUB_GC_CARD_E2E_OUT || path.join(ROOT, 'output', 'playwright', 'group-answer-card');
const RESULT_PATH = path.join(ARTIFACT_DIR, `group-answer-card-${RUN_ID}.json`);
const MEETING_ID = 'meeting-answer-card-e2e';
const MEMBERS = [
  { hubId: 'member-card-a', title: '链路自适应分析', ccSessionId: '11111111-1111-4111-8111-111111111111' },
  { hubId: 'member-card-b', title: '调度器复核', ccSessionId: '22222222-2222-4222-8222-222222222222' },
  { hubId: 'member-card-c', title: '仿真配置检查', ccSessionId: '33333333-3333-4333-8333-333333333333' },
];
const QUESTION = '小区边缘用户 MCS 偏保守，OLLA 步长该怎么调？';
const ANSWER_A = '**结论**：把 OLLA 上调步长从 0.5 dB 降到 0.3 dB，下调保持 1 dB。\n\n依据：边缘用户 BLER 目标 10% 时，上调过快会引发反复回退。';
const STREAM_B = '先看调度侧：边缘用户的 RB 分配比例在高负载时被压到 12%，MCS 保守与可用 RB 少叠加，';
const ANSWER_B = '调度侧没有问题：高负载时边缘用户 RB 占比 12% 属正常范围，MCS 偏保守主要来自链路自适应。';
const ANSWER_C = '仿真配置核对完毕：信道模型 UMa、负载 70%，与现网经验值一致，可以直接复现。';

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

function answerEntry(member) {
  const dir = path.join(DATA_DIR, 'task-docs', MEETING_ID, 'answers', 'turn-1', member.hubId);
  return { kind: 'plain', dir, ready: path.join(dir, '回答.md'), memberId: member.hubId, speaker: member.title, at: Date.now() };
}

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetInterval(() => {}, 60000);\n", 'utf8');
  fs.writeFileSync(path.join(FAKE_BIN_DIR, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fakeCliPath}" claude %*\r\n`, 'utf8');
  for (const dir of [WORK_DIR, DATA_DIR, path.join(DATA_DIR, 'meetings'), path.join(DATA_DIR, 'arena-prompts')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({ providers: { claude: { backend: 'subscription' } } }, null, 2), 'utf8');
  const now = Date.now();
  const claudeDir = path.join(TEMP_ROOT, 'claude-projects', 'gc-card');
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessions = MEMBERS.map(member => {
    const transcript = path.join(claudeDir, `${member.ccSessionId}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u0', timestamp: new Date(now - 90000).toISOString(), sessionId: member.ccSessionId, cwd: WORK_DIR, message: { role: 'user', content: '准备' } }) + '\n', 'utf8');
    return { schemaVersion: 1, hubId: member.hubId, kind: 'claude', title: member.title, cwd: WORK_DIR, meetingId: MEETING_ID, ccSessionId: member.ccSessionId, transcriptPath: transcript, lastMessageTime: now - 60000, updatedAt: now - 60000 };
  });
  const meeting = {
    schemaVersion: 2, id: MEETING_ID, title: 'OLLA 步长讨论', scene: 'general', mode: 'free', groupChat: true,
    groupMode: 'deliberation', workspace: WORK_DIR, workspaceLabel: 'OLLA', createdAt: now - 60000, updatedAt: now - 60000,
    lastMessageTime: now - 60000, subSessions: MEMBERS.map(m => m.hubId), slotSpecs: MEMBERS.map(() => ({ kind: 'claude' })),
    participants: [0, 1, 2], _cursors: Object.fromEntries(MEMBERS.map(m => [m.hubId, 0])), _nextIdx: 0, _timeline: [],
  };
  fs.writeFileSync(path.join(DATA_DIR, 'meetings', `${MEETING_ID}.json`), JSON.stringify(meeting), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'arena-prompts', `${MEETING_ID}-groupchat.json`), JSON.stringify({
    meetingId: MEETING_ID, currentMode: 'idle', currentTurn: 1, nextMessageSeq: 2, turns: [],
    messages: [{ id: 'u1', seq: 1, turnNum: 1, role: 'user', content: QUESTION, createdAt: now - 40000 }],
    answerFiles: { 1: Object.fromEntries(MEMBERS.map(m => [m.hubId, answerEntry(m)])) },
  }), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, immersiveByMeeting: {}, meetings: [meeting], sessions }, null, 2), 'utf8');
}

async function clickSelector(client, selector) {
  const box = await waitFor(`${selector} clickable`, () => client.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return (hit === el || el.contains(hit)) ? { x, y } : null; })()`), 15000);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

// 渲染进程：叠加本轮假状态、发推送事件。
const INSTALL = `(() => {
  const { ipcRenderer } = require('electron');
  window.__gcOverlay = null; window.__gcRev = 1000;
  const original = ipcRenderer.invoke.bind(ipcRenderer);
  ipcRenderer.invoke = async (channel, ...rest) => {
    const r = await original(channel, ...rest);
    if (channel === 'groupchat:get-state' && r && window.__gcOverlay && rest[0]?.meetingId === ${JSON.stringify(MEETING_ID)}) {
      return { ...r, ...JSON.parse(JSON.stringify(window.__gcOverlay)), revision: window.__gcRev };
    }
    return r;
  };
  window.__gcPush = (channel, payload) => { window.__gcRev += 1; ipcRenderer.emit(channel, {}, { meetingId: ${JSON.stringify(MEETING_ID)}, revision: window.__gcRev, ...payload }); };
  return true;
})()`;

const CARD_INFO = `(() => [...document.querySelectorAll('.mr-gc-msg.ai')].map(card => ({
  sid: card.dataset.sourceSid, id: card.dataset.gcMsgId, running: card.dataset.answerRunning,
  status: card.querySelector('.mr-gc-answer-status')?.textContent || '',
  body: (card.querySelector('.gc-journal-text')?.textContent || '').trim().slice(0, 60),
  exposed: [...card.querySelectorAll('.gc-journal-actions > button')].map(b => b.textContent.trim()).filter(t => t && t !== '复制'),
  more: [...card.querySelectorAll('.gc-journal-menu-body button')].map(b => b.textContent.trim()),
  cursor: !!card.querySelector('.mr-ft-cursor'),
})))()`;

const LANE_INFO = `(() => { const lane = document.querySelector('.mr-gc-thread > .mr-turn-lane.is-compact'); return lane ? { text: lane.textContent.replace(/\\s+/g, ' ').trim(), height: Math.round(lane.getBoundingClientRect().height) } : null; })()`;

async function shot(client, name) {
  await client.eval(`(() => { const box = document.querySelector('.mr-gc-messages'); if (box) box.scrollTop = box.scrollHeight; })()`);
  await _waitMs(400);
  const s = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(ARTIFACT_DIR, `20261123-群聊回答卡片-${name}.png`);
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  return file;
}

const byId = (cards, hubId) => cards.find(c => c.sid === hubId) || {};

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, shots: {} };
  let hub = null, client = null;
  const [A, B, C] = MEMBERS.map(m => m.hubId);
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await reservePort(), label: 'group-answer-card', windowMode: 'hidden',
      extraEnv: { [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`, HUB_CLAUDE_BACKEND: 'subscription', HUB_SESSION_SEARCH_PREWARM: '0' },
    });
    await _waitMs(1000);
    client = await connectFirstPage(hub, target => target.type === 'page' && /index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    result.exc = [];
    client.ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString());
        if (m.method === 'Runtime.exceptionThrown') result.exc.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      } catch {}
    });
    await client.send('Runtime.enable');
    await waitFor('meeting in sidebar', () => client.eval(`!!document.querySelector('[data-meeting-id="${MEETING_ID}"]')`));
    await client.eval(INSTALL);
    const now = Date.now();
    // ① 进行中：A 在思考（读文件中）、B 正在流式输出、C 的输入卡在 CLI 输入框
    await client.eval(`window.__gcOverlay = ${JSON.stringify({ currentMode: 'parallel', currentTurn: 1, turns: [] })}`);
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    await waitFor('group panel', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.querySelector('.mr-gc-messages')`));
    await _waitMs(1200);
    const activity = [{ phase: 'activity', role: 'assistant', text: '', toolCalls: [{ name: 'Read', input: { file_path: 'olla_config.yaml' }, status: 'running' }] }];
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: A, status: 'thinking', text: '', displayMessages: activity })})`);
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: B, status: 'streaming', text: STREAM_B })})`);
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: C, status: 'thinking', text: '' })})`);
    await client.eval(`window.__gcPush('groupchat-send-stuck', ${JSON.stringify({ turnNum: 1, sid: C })})`);
    await _waitMs(600);
    const s1 = await client.eval(CARD_INFO);
    result.running = { cards: s1, lane: await client.eval(LANE_INFO) };
    assert.equal(byId(s1, A).status, '思考中');
    assert.doesNotMatch(byId(s1, A).body, /还没交/);
    assert.ok(!byId(s1, A).exposed.includes('提取'), '还在跑的成员不给提取');
    assert.equal(byId(s1, B).status, '正在发言');
    assert.match(byId(s1, B).body, /RB 分配比例/);
    assert.equal(byId(s1, C).status, '输入未提交');
    assert.ok(byId(s1, C).exposed.includes('再次发送'));
    assert.ok(result.running.lane && /本轮/.test(result.running.lane.text), '本轮进度默认可见');
    assert.ok(result.running.lane.height <= 44, `本轮进度只占一行（${result.running.lane.height}px）`);
    result.shots.running = await shot(client, '1进行中');

    // ② 部分完成：A 已交（回答文件），B 仍在写，C 本轮报错（额度用尽）。整轮尚未结算。
    fs.mkdirSync(answerEntry(MEMBERS[0]).dir, { recursive: true });
    fs.writeFileSync(answerEntry(MEMBERS[0]).ready, ANSWER_A, 'utf8');
    await client.eval(`window.__gcOverlay.messages = ${JSON.stringify([
      { id: 'u1', seq: 1, turnNum: 1, role: 'user', content: QUESTION, createdAt: now - 40000 },
      { id: `a1-${A}`, seq: 2, turnNum: 1, role: 'assistant', sid: A, memberId: A, speaker: MEMBERS[0].title, content: ANSWER_A, status: 'completed', answer: { state: 'delivered', outcome: 'ready', at: now }, sourcePrompt: QUESTION, createdAt: now },
      { id: `a1-${C}`, seq: 3, turnNum: 1, role: 'assistant', sid: C, memberId: C, speaker: MEMBERS[2].title, content: '', status: 'errored', failure: { code: 'quota_exceeded', detail: 'You have hit your usage limit.' }, sourcePrompt: QUESTION, createdAt: now },
    ])}`);
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: A, status: 'completed', text: '' })})`);
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: C, status: 'errored', text: '', failure: { code: 'quota_exceeded' } })})`);
    await client.eval(`window.__gcPush('groupchat-partial-update', ${JSON.stringify({ turnNum: 1, sid: B, status: 'streaming', text: STREAM_B + '再看 BLER 收敛曲线……' })})`);
    await client.eval(`window.__gcPush('groupchat:answer-file', {})`);
    await _waitMs(800);
    const s2 = await client.eval(CARD_INFO);
    result.partial = { cards: s2, lane: await client.eval(LANE_INFO) };
    assert.match(byId(s2, A).body, /OLLA 上调步长/);
    assert.equal(byId(s2, A).status, '');
    assert.equal(byId(s2, B).status, '正在发言');
    assert.match(byId(s2, C).body, /额度已用尽/);
    assert.ok(byId(s2, C).exposed.includes('重试'), '报错的成员直接给「重试」');
    assert.ok(byId(s2, C).exposed.includes('提取'), '先停下的成员不必等最慢的人就有「提取」');
    assert.ok(byId(s2, A).more.includes('重新发送'), '已交的成员「重新发送」在更多里');
    assert.ok(byId(s2, A).more.includes('复制本轮 Prompt'));
    assert.ok(!byId(s2, A).exposed.some(t => /Prompt/.test(t)), '卡片头不再平铺复制 Prompt');
    // 等太久提醒：弹出后紧接着一次整块刷新，横幅仍在（以前同一帧就被抹掉）
    await client.eval(`window.__gcPush('groupchat-soft-alert', ${JSON.stringify({ turnNum: 1, sid: B, label: '调度器复核', level: 't1', mode: 'parallel' })})`);
    await client.eval(`window.__gcPush('groupchat:answer-file', {})`);
    await _waitMs(700);
    result.softBanner = await client.eval(`(() => { const b = document.getElementById('mr-gc-soft-alert-banner'); return b ? { shown: getComputedStyle(b).display !== 'none', text: b.textContent.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' ') } : null; })()`);
    assert.ok(result.softBanner && result.softBanner.shown && /已等待/.test(result.softBanner.text), '等太久提醒经整块刷新后仍可见');
    result.shots.partial = await shot(client, '2部分完成');

    // ③ 全部完成：三位都交了，整轮结算
    await client.eval(`(() => {
      const o = window.__gcOverlay; o.currentMode = 'idle';
      o.turns = [{ n: 1, userInput: ${JSON.stringify(QUESTION)}, by: {}, byStatus: ${JSON.stringify({ [A]: 'completed', [B]: 'completed', [C]: 'completed' })}, createdAt: ${now} }];
      o.messages = o.messages.filter(m => m.sid !== ${JSON.stringify(C)});
      o.messages.push(${JSON.stringify({ id: `a1-${B}`, seq: 4, turnNum: 1, role: 'assistant', sid: B, memberId: B, speaker: MEMBERS[1].title, content: ANSWER_B, status: 'completed', answer: { state: 'delivered', outcome: 'ready', at: now }, createdAt: now })});
      o.messages.push(${JSON.stringify({ id: `a1-${C}`, seq: 5, turnNum: 1, role: 'assistant', sid: C, memberId: C, speaker: MEMBERS[2].title, content: ANSWER_C, status: 'completed', answer: { state: 'delivered', outcome: 'ready', at: now }, createdAt: now })});
    })()`);
    await client.eval(`window.__gcPush('groupchat-turn-complete', { turnNum: 1 })`);
    await client.eval(`window.__gcPush('groupchat:answer-file', {})`);
    await _waitMs(1000);
    const s3 = await client.eval(CARD_INFO);
    result.done = { cards: s3, lane: await client.eval(LANE_INFO) };
    for (const [sid, text] of [[A, /OLLA/], [B, /调度侧没有问题/], [C, /仿真配置核对完毕/]]) {
      assert.match(byId(s3, sid).body, text);
      assert.equal(byId(s3, sid).status, '');
      assert.equal(byId(s3, sid).cursor, false);
    }
    assert.equal(result.done.lane, null, '全部完成后紧凑进度收起');
    result.done.banner = await client.eval(`getComputedStyle(document.getElementById('mr-gc-soft-alert-banner')).display`);
    assert.equal(result.done.banner, 'none', '本轮结束后等太久提醒自动收起');
    result.shots.done = await shot(client, '3全部完成');
    // @点名：输入框里写 @m2，「目标」芯片跟着变成 1/3 点名
    await clickSelector(client, '#mr-input-box');
    await client.send('Input.insertText', { text: '@m2 再核对一下 RB 占比' });
    result.mention = await waitFor('target chip follows @mention', () => client.eval(`(() => { const t = document.querySelector('#mr-input-preflight, .mr-input-preflight')?.textContent || document.body.textContent; const m = t.match(new RegExp('目标[ ]*([0-9]+/[0-9]+[^目]{0,6})')); return m && /点名/.test(m[1]) ? m[1].trim() : null; })()`), 8000);
    assert.match(result.mention, /^1\/3/);
    result.shots.mention = await shot(client, '4点名目标');
    assert.deepEqual(result.exc.filter(t => /meeting-room|answer-card/.test(t)), [], '渲染进程无报错');
    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E group-answer-card: PASS');
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    try { result.cardsAtFailure = await client.eval(CARD_INFO); } catch {}
    if (client) { try { const s = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ARTIFACT_DIR, `group-answer-card-fail-${RUN_ID}.png`), Buffer.from(s.data, 'base64')); } catch {} }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    if (client) { try { client.close(); } catch {} }
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
  }
}

main();
