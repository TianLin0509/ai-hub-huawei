'use strict';

// 群聊「抢救」下拉（2026-11-24）：隔离 Hub + 假 CLI。群聊状态停在「第 3 轮进行中」（模拟 Hub 重启后轮次悬空、
// 一位成员已交一位没交），真实鼠标点顶栏「抢救 ▾」→ 截图核对 1440×900 下弹层不溢出、顶栏不换行、页面无纵向滚动 →
// 点「强制结束本轮」核对状态文件回到 idle、已交回答还在 → 再点「导出诊断状态」核对文件写到 diagnostics/ 且不含正文。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gc-rescue-${RUN_ID}`);
const DATA_DIR = path.join(TEMP_ROOT, 'hub-data');
const WORK_DIR = path.join(TEMP_ROOT, 'workspace');
const FAKE_BIN_DIR = path.join(TEMP_ROOT, 'fake-bin');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'output', 'playwright', 'group-rescue');
const RESULT_PATH = path.join(ARTIFACT_DIR, `group-rescue-${RUN_ID}.json`);
const MEETING_ID = 'meeting-rescue-e2e';
const MEMBERS = ['member-rescue-a', 'member-rescue-b'];
const DONE_ANSWER = '已交的回答：BLER 收敛到 10% 附近。';
const SECRET_QUESTION = '第三轮问题：私密正文不该进诊断';

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

const stateFile = () => path.join(DATA_DIR, 'arena-prompts', `${MEETING_ID}-groupchat.json`);

function writeFixtures() {
  fs.mkdirSync(FAKE_BIN_DIR, { recursive: true });
  const fakeCliPath = path.join(FAKE_BIN_DIR, 'fake-cli.js');
  fs.writeFileSync(fakeCliPath, "'use strict';\nprocess.stdout.write('[fake-cli]\\r\\n');\nsetInterval(() => {}, 60000);\n", 'utf8');
  for (const provider of ['claude', 'codex']) {
    fs.writeFileSync(path.join(FAKE_BIN_DIR, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fakeCliPath}" ${provider} %*\r\n`, 'utf8');
  }
  for (const dir of [WORK_DIR, CODEX_HOME, DATA_DIR, path.join(DATA_DIR, 'meetings'), path.join(DATA_DIR, 'arena-prompts')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    providers: {
      claude: { backend: 'subscription' },
      codex: { backend: 'subscription', subscription_profile: 'e2e', subscription_profiles: [{ id: 'e2e', label: 'E2E', home: CODEX_HOME }] },
    },
  }, null, 2), 'utf8');
  const now = Date.now();
  const meeting = {
    schemaVersion: 2, id: MEETING_ID, title: '抢救菜单验收', scene: 'general', mode: 'free', groupChat: true,
    groupMode: 'deliberation', workspace: WORK_DIR, workspaceLabel: '抢救', createdAt: now - 60000, updatedAt: now - 60000,
    lastMessageTime: now - 60000, subSessions: [...MEMBERS], slotSpecs: [{ kind: 'claude' }, { kind: 'claude' }], participants: [0, 1],
    answerSource: 'transcript', _cursors: {}, _nextIdx: 0, _timeline: [],
  };
  fs.writeFileSync(path.join(DATA_DIR, 'meetings', `${MEETING_ID}.json`), JSON.stringify(meeting), 'utf8');
  fs.writeFileSync(stateFile(), JSON.stringify({
    schemaVersion: 4, meetingId: MEETING_ID, currentMode: 'group', currentTurn: 3, nextMessageSeq: 4,
    activeRun: { runId: 'run-stuck-3', turnNum: 3, status: 'running', startedAt: now - 20000, updatedAt: now - 20000, dispatchMode: 'group' },
    lastDeliveredIdx: {}, lastDeliveredSeq: {}, memberIdsBySid: {}, attempts: {}, attemptEvents: [], pendingPrompts: {},
    turns: [{ n: 3, userInput: SECRET_QUESTION, by: { [MEMBERS[0]]: DONE_ANSWER }, byStatus: { [MEMBERS[0]]: 'completed' }, createdAt: now - 20000 }],
    messages: [
      { id: 'u3', seq: 1, turnNum: 3, role: 'user', content: SECRET_QUESTION, createdAt: now - 20000 },
      { id: 'a3-a', seq: 2, turnNum: 3, role: 'assistant', sid: MEMBERS[0], memberId: MEMBERS[0], speaker: 'Claude', content: DONE_ANSWER, status: 'completed', createdAt: now - 15000 },
    ],
  }), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify({
    version: 1, cleanShutdown: true, immersiveByMeeting: {}, meetings: [meeting],
    sessions: MEMBERS.map((id, i) => ({ schemaVersion: 1, hubId: id, kind: 'claude', title: `成员${i + 1}`, cwd: WORK_DIR, meetingId: MEETING_ID, lastMessageTime: now - 60000, updatedAt: now - 60000 })),
  }, null, 2), 'utf8');
}

async function clickSelector(client, selector) {
  const box = await waitFor(`${selector} visible and clickable`, () => client.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return (hit === el || el.contains(hit)) ? { x, y } : null; })()`), 15000);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
async function shot(client, name) {
  const s = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(ARTIFACT_DIR, `${name}-${RUN_ID}.png`);
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  return file;
}

async function main() {
  writeFixtures();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
  const result = { runId: RUN_ID, shots: {} };
  let hub = null;
  let client = null;
  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR, port: await reservePort(), label: 'group-rescue', windowMode: 'hidden',
      extraEnv: {
        [pathKey]: `${FAKE_BIN_DIR}${path.delimiter}${process.env[pathKey] || ''}`,
        HUB_CLAUDE_BACKEND: 'subscription', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: 'e2e', HUB_SESSION_SEARCH_PREWARM: '0',
      },
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
    await waitFor('meeting in sidebar', () => client.eval(`!!document.querySelector('[data-meeting-id="${MEETING_ID}"]')`), 60000);
    await clickSelector(client, `[data-meeting-id="${MEETING_ID}"]`);
    await waitFor('group composer', () => client.eval(`activeMeetingId === ${JSON.stringify(MEETING_ID)} && !!document.getElementById('mr-input-box')`));
    await _waitMs(1200);
    result.before = await client.eval(`(() => { const h = document.querySelector('#mr-btn-rescue')?.closest('.mr-header-right'); return {
      stopChip: !!document.querySelector('[data-gc-stop-turn]'),
      button: document.getElementById('mr-btn-rescue')?.textContent || null,
      headerOverflow: h ? h.scrollWidth - h.clientWidth : null,
      buttonHeight: Math.round(document.getElementById('mr-btn-rescue')?.getBoundingClientRect().height || 0),
      headerHeight: Math.round(document.getElementById('mr-btn-rescue')?.closest('.mr-header, header, [class*="header"]')?.getBoundingClientRect().height || 0),
      composerTop: Math.round(document.getElementById('mr-input-box')?.getBoundingClientRect().top || 0),
    }; })()`);
    assert.equal(result.before.button, '抢救 ▾');
    assert.equal(result.before.stopChip, true, '夹具：本轮悬空在进行中');
    // 顶栏右侧按钮区本来就可能有几像素的取整溢出（标题会先收缩）：核对的是「加了抢救按钮不让它变多」。
    result.before.headerOverflowWithoutRescue = await client.eval(`(() => { const b = document.getElementById('mr-btn-rescue'); const h = b.closest('.mr-header-right'); b.style.display = 'none'; const v = h.scrollWidth - h.clientWidth; b.style.display = ''; return v; })()`);
    assert.ok(result.before.headerOverflow <= Math.max(0, result.before.headerOverflowWithoutRescue), `顶栏溢出 ${result.before.headerOverflow}px（不含抢救按钮时 ${result.before.headerOverflowWithoutRescue}px）`);
    result.shots.header = await shot(client, 'rescue-header-1440');

    await clickSelector(client, '#mr-btn-rescue');
    await waitFor('rescue menu', () => client.eval(`!!document.getElementById('mr-rescue-pop')`), 5000);
    // 「重启成员」子列表默认折叠，点一下展开、再点收起（CSS 的 display 曾盖过 [hidden]，折叠态也一直显示）。
    const membersHeight = () => client.eval(`Math.round(document.querySelector('[data-rescue-members]').getBoundingClientRect().height)`);
    result.membersCollapsedHeight = await membersHeight();
    assert.equal(result.membersCollapsedHeight, 0, '打开菜单时成员子列表是折叠的');
    await clickSelector(client, '[data-rescue-toggle="restart"]');
    await _waitMs(200);
    assert.ok(await membersHeight() > 0, '点「重启成员」后展开');
    await clickSelector(client, '[data-rescue-toggle="restart"]');
    await _waitMs(200);
    assert.equal(await membersHeight(), 0, '再点一次收起');
    await clickSelector(client, '[data-rescue-toggle="restart"]');
    await _waitMs(200);
    result.menu = await client.eval(`(() => { const p = document.getElementById('mr-rescue-pop'); const r = p.getBoundingClientRect(); return {
      items: [...p.querySelectorAll('.mr-rescue-row')].map(b => b.textContent.replace(/[ⓘ▸▾]/g, '').trim()),
      members: [...p.querySelectorAll('.mr-rescue-member')].map(b => b.textContent.trim()),
      tips: [...p.querySelectorAll('.mr-rescue-info')].filter(i => (i.getAttribute('title') || '').length > 10).length,
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      docScroll: document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight,
      composerTop: Math.round(document.getElementById('mr-input-box')?.getBoundingClientRect().top || 0),
    }; })()`);
    result.shots.menu = await shot(client, 'rescue-menu-1440');
    assert.deepEqual(result.menu.items, ['强制结束本轮', '跳过未交成员', '重启成员', '回退上一轮', '导出诊断状态']);
    assert.equal(result.menu.members.length, 2);
    assert.equal(result.menu.tips, 5, '每项都有悬停 ⓘ 说明');
    assert.ok(result.menu.inViewport, '弹层完整在 1440×900 视口内');
    assert.ok(result.menu.docScroll <= 0, '页面没有纵向滚动');
    assert.equal(result.menu.composerTop, result.before.composerTop, '打开菜单不挤压输入区');

    await clickSelector(client, '[data-rescue-action="force-settle"]');
    await waitFor('menu closed after force settle', () => client.eval(`!document.getElementById('mr-rescue-pop')`), 8000);
    result.afterSettle = await waitFor('state file idle', () => {
      const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      return st.currentMode === 'idle' ? { mode: st.currentMode, keptAnswer: st.messages.some(m => m.content === DONE_ANSWER), keptQuestion: st.messages.some(m => m.id === 'u3') } : null;
    }, 8000);
    assert.equal(result.afterSettle.keptAnswer, true);
    assert.equal(result.afterSettle.keptQuestion, true);
    result.afterSettleBanner = await waitFor('settle banner', () => client.eval(`document.querySelector('.mr-gc-soft-alert-hint')?.textContent || null`), 5000);
    assert.match(result.afterSettleBanner, /已强制结束本轮/);
    result.afterSettleUi = await waitFor('ui idle', () => client.eval(`(() => document.querySelector('[data-gc-stop-turn]') ? null : { stopChip: false, banner: document.querySelector('.mr-gc-soft-alert-hint')?.textContent || null })()`), 8000);
    result.shots.settled = await shot(client, 'rescue-after-settle-1440');

    await clickSelector(client, '#mr-btn-rescue');
    await waitFor('rescue menu again', () => client.eval(`!!document.getElementById('mr-rescue-pop')`), 5000);
    await clickSelector(client, '[data-rescue-action="export-diagnostics"]');
    result.exportUi = await waitFor('export path shown', () => client.eval(`document.querySelector('.mr-rescue-path')?.textContent || null`), 8000);
    assert.equal(await membersHeight(), 0, '重新打开菜单时成员子列表仍是折叠的');
    result.shots.exported = await shot(client, 'rescue-export-1440');
    const diagDir = path.join(DATA_DIR, 'diagnostics');
    const files = fs.readdirSync(diagDir).filter(f => /-groupchat-[0-9a-f]{8}\.json$/.test(f));
    assert.equal(files.length, 1);
    const text = fs.readFileSync(path.join(diagDir, files[0]), 'utf8');
    assert.ok(!text.includes(SECRET_QUESTION) && !text.includes(DONE_ANSWER) && !text.includes(MEETING_ID), '诊断不含正文与完整编号');
    result.diagnostics = { file: files[0], mode: JSON.parse(text).turn.currentMode, members: JSON.parse(text).members.length };
    assert.equal(result.diagnostics.mode, 'idle');
    assert.deepEqual(result.exc.filter(t => /rescue|meeting-room/.test(t)), [], 'renderer threw');
    result.ok = true;
    console.log(JSON.stringify(result, null, 2));
    console.log('E2E groupchat-rescue: PASS');
  } catch (error) {
    result.ok = false;
    result.error = error && error.stack || String(error);
    if (client) { try { result.shots.fail = await shot(client, 'rescue-fail'); } catch {} }
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
