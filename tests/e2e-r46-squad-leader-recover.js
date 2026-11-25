'use strict';
// R46 真实验收：小队负责人 CLI 掉线 → 一键「重启负责人并继续」；Hub 重启后没跑完的子任务显示「已中断」。
// R46 acceptance: squad leader CLI exits → one-click restart & resume; after a Hub restart unfinished subagents show as interrupted.
// 隔离 Hub、全新数据目录、隐藏窗口（不抢焦点）；两位 CodeAgent 成员用替身（tests/fixtures/codeagent-standin，内部跑真 Claude Code，
// 配置目录 settings.json 指定 haiku），会花少量真实 token。凭据复制进临时目录，结束后删除，真 Claude 凭据哈希核对不变。
// 场景 A：第一句让负责人直接答 → 在负责人终端输入 /exit 让 CLI 退回 PowerShell → 第二句要求派工 → 小队停下并出现按钮 → 点按钮 → 负责人重启、派工、收口。
// 场景 B：给负责人的记录目录放 3 个子 Agent 记录（2 个没写完、1 个写完）→ 卡片视图显示「2 个子任务进行中」→ 关掉 Hub 再用同一数据目录启动 → 同一会话显示「2 个子任务已中断」。
// 用法：node tests/e2e-r46-squad-leader-recover.js   （截图与报告写到 HUB_E2E_ARTIFACT_DIR，默认 artifacts/20261126-r46）
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const Q1 = '这是连通性测试：不要派工，直接回复「收到」两个字。';
const Q2 = '请按小队流程完成：让 @m2 只回复「苹果」两个字。交回后你验收，并用一句话汇总给我。';

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'subagents') walk(p, out); } else if (/\.jsonl$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r46-'));
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261126-r46'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeAuth = path.join(claudeSource, '.credentials.json');
  const authBefore = hash(claudeAuth);
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data');
  for (const d of [cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  const report = { checks: [], screenshots: [], passed: false, providerNetworkTested: true, steps: [] };
  let hub, c;
  const step = s => { report.steps.push(`${new Date().toISOString().slice(11, 19)} ${s}`); console.log('[r46]', s); };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); assert.ok(ok, name + (detail ? ' :: ' + j(detail) : '')); };
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(400); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); report.screenshots.push(f); };
  const click = async selector => {
    const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const squad = id => c.eval(`require('electron').ipcRenderer.invoke('squad:view',{meetingId:${j(id)}})`);
  const env = {
    AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_CODEAGENT_SERVE: '0', CODEAGENT_STANDIN_NO_CHROME: '1',
    CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
    HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
  };
  const launch = async label => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label, extraEnv: env });
    c = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.openMeetingCreateModal', 'renderer ready', 90000);
  };
  const sendGroup = async text => {
    await click('#mr-input-box');
    await c.send('Input.insertText', { text });
    await click('#mr-send-btn');
  };
  const waitRun = async (meetingId, want, ms) => {
    const end = Date.now() + ms;
    let v = null;
    while (Date.now() < end) {
      v = await squad(meetingId);
      if (v.run && want.includes(v.run.status)) return v.run;
      await sleep(1500);
    }
    throw Error('squad run timeout: ' + j(v && v.run));
  };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    await launch('r46 squad leader recover');
    step('Hub 已启动');
    // 建群（默认两位 CodeAgent）并开小队模式。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await click('[data-launch-intent="group"]');
    await until(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length === 2`, 'group panel');
    await click('#meeting-create-modal .mcm-create');
    await until(`!!document.getElementById('mr-btn-add-sub')`, 'meeting room open', 120000);
    const meetingId = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.at(-1).id)`);
    await until(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.at(-1).subSessions.length === 2)`, 'two members', 120000);
    const sids = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.find(m => m.id === ${j(meetingId)}).subSessions)`);
    report.sids = sids;
    await until(`!!document.getElementById('mr-btn-squad')`, 'squad button');
    await click('#mr-btn-squad');
    await until(`!!document.getElementById('mr-squad-pop')`, 'squad popover');
    await click('[data-squad-save]');
    await until(`!!document.querySelector('.mr-squad-strip')`, 'squad strip');
    step('小队已开启');

    // 第一句：负责人直接答（让它有一段可恢复的会话历史）。机器忙时 CLI 可能没起好，按原有提示重发最多 2 次。
    await sendGroup(Q1);
    let run1 = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      run1 = await waitRun(meetingId, ['done', 'limit', 'error'], 6 * 60_000);
      if (run1.status !== 'error') break;
      step('第一句没接住，45 秒后重发：' + run1.note);
      await sleep(45_000); await sendGroup(Q1);
    }
    check('第一句负责人直接答复', run1.status === 'done', run1);
    await sleep(3000);

    // 场景 A：负责人 CLI 退回 PowerShell。
    step('在负责人终端输入 /exit');
    await c.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${j(sids[0])},data:'/exit'})`);
    await sleep(1200);
    await c.eval(`require('electron').ipcRenderer.send('terminal-input',{sessionId:${j(sids[0])},data:'\\r'})`);
    await sleep(10_000);
    await sendGroup(Q2);
    const halted = await waitRun(meetingId, ['error', 'done', 'limit'], 4 * 60_000);
    report.halted = halted;
    check('负责人 CLI 退出后小队停下，并标为可一键重启接续', halted.status === 'error' && halted.recoverable === true && halted.restartLeader === true, halted);
    await until(`!!document.querySelector('.mr-squad-strip [data-squad-resume]')`, 'resume button');
    const stripText = await c.eval(`document.querySelector('.mr-squad-strip').innerText`);
    report.stripHalted = stripText;
    check('小队条上就地一行说明 + 「重启负责人并继续」按钮', /CLI 掉线了/.test(stripText) && /重启负责人并继续/.test(stripText), stripText);
    await sleep(800);
    await shot('20261126-r46-A1-leader-cli-exited-1440');

    step('点「重启负责人并继续」');
    await click('.mr-squad-strip [data-squad-resume]');
    await until(`!document.querySelector('.mr-squad-strip [data-squad-resume]')`, 'resume accepted', 15000);
    await sleep(1500);
    await shot('20261126-r46-A2-restarting-1440');
    const finalRun = await waitRun(meetingId, ['done', 'limit', 'error'], 12 * 60_000);
    report.finalRun = finalRun;
    check('重启后负责人接着派工，成员交回，负责人收口', finalRun.status === 'done' && finalRun.round >= 1 && finalRun.steps.every(s => s.state === 'done'), finalRun);
    const state = await c.eval(`require('electron').ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(meetingId)}}).catch(e=>({error:e.message}))`);
    const messages = (state && (state.messages || state.state?.messages)) || [];
    report.messages = messages.map(m => ({ role: m.role, speaker: m.speaker, kind: m.dispatch && m.dispatch.kind, note: !!m.systemNote, text: String(m.content || '').slice(0, 160) }));
    const userMsgs = messages.filter(m => m.role === 'user' && !m.dispatch && String(m.content || '').includes('苹果'));
    check('用户的第二句只出现一次（重发不重复显示）', userMsgs.length === 1, userMsgs.length);
    const resendCards = messages.filter(m => m.dispatch && /^Hub 重发给负责人/.test(String(m.content || '')));
    check('重发时群里只放一行说明，不把负责人协议全文画成卡片', resendCards.length === 1
      && !/小队模式 · 你是负责人/.test(String(resendCards[0].content || '')), resendCards.map(m => String(m.content || '').slice(0, 80)));
    await sleep(1500);
    await shot('20261126-r46-A3-resumed-done-1440');

    // 场景 B：负责人记录目录里放 3 个子 Agent 记录。
    const transcripts = walk(path.join(cac, 'projects')).filter(f => fs.readFileSync(f, 'utf8').includes('你是负责人'))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    check('找到负责人的会话记录', transcripts.length >= 1, transcripts);
    const leaderTranscript = transcripts[0];
    const subDir = path.join(path.dirname(leaderTranscript), path.basename(leaderTranscript, '.jsonl'), 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const now = new Date().toISOString();
    const line = o => JSON.stringify({ ...o, timestamp: now }) + '\n';
    const editing = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'D:/work/out_nonno_b06.json' } }] } });
    fs.writeFileSync(path.join(subDir, 'agent-r46a.jsonl'), line({ type: 'user', message: { content: '改配置' } }) + editing);
    fs.writeFileSync(path.join(subDir, 'agent-r46b.jsonl'), line({ type: 'user', message: { content: '跑仿真' } }) + editing);
    fs.writeFileSync(path.join(subDir, 'agent-r46c.jsonl'), line({ type: 'user', message: { content: '读代码' } })
      + line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '读完了' }] } }));
    report.subagentDir = subDir;
    step('已放 3 个子 Agent 记录：' + subDir);

    await c.eval(`selectSession(${j(sids[0])})`);
    await until(`(document.getElementById('subagent-progress-line')?.innerText || '').includes('2 个子任务进行中')`, 'progress running', 30000);
    report.progressBefore = await c.eval(`document.getElementById('subagent-progress-line').innerText`);
    check('Hub 重启前：卡片显示「2 个子任务进行中」', /2 个子任务进行中/.test(report.progressBefore), report.progressBefore);
    await sleep(800);
    await shot('20261126-r46-B1-before-hub-restart-running-1440');

    step('关闭 Hub，用同一数据目录重启');
    // 退出时 Hub 要等两个 CodeAgent 终端收尾，CDP 可能先断开，测试工具会改为结束这个子进程：
    // 这也等于 Hub 被强行关掉，同样是要验证的场景，记下是哪一种。
    // Shutdown may outlive the CDP listener and the harness then terminates the child; that equals a forced Hub kill, also a target scenario.
    try { await gracefulQuit(hub); report.firstQuit = 'graceful'; }
    catch (error) {
      if (hub.isAlive && hub.isAlive()) throw error;
      report.firstQuit = 'forced: ' + error.message;
    }
    c.close?.(); c = null; hub = null;
    await sleep(3000);
    await launch('r46 after restart');
    await c.eval(`selectSession(${j(sids[0])})`);
    await until(`(document.getElementById('subagent-progress-line')?.innerText || '').includes('已中断')`, 'progress interrupted', 120000);
    report.progressAfter = await c.eval(`document.getElementById('subagent-progress-line').innerText`);
    check('Hub 重启后：同一会话显示「2 个子任务已中断 · 1 个已完成」，不再一直进行中',
      /^2 个子任务已中断/.test(report.progressAfter) && /1 个已完成/.test(report.progressAfter) && !/进行中/.test(report.progressAfter), report.progressAfter);
    await sleep(800);
    await shot('20261126-r46-B2-after-hub-restart-interrupted-1440');

    // 群里小队条：Hub 重启后不残留「进行中」。
    await c.eval(`(window.openMeetingPanel || window.MeetingRoom?.openMeeting || (()=>{}))(${j(meetingId)})`).catch(() => {});
    await c.eval(`document.querySelector('[data-meeting-id=${j(meetingId)}]')?.click()`).catch(() => {});
    await sleep(3000);
    const after = await squad(meetingId);
    report.squadAfterRestart = after.run;
    check('Hub 重启后小队不残留进行中的轮次', !after.run || !['leader', 'members', 'handback'].includes(after.run.status), after.run);
    if (await c.eval(`!!document.querySelector('.mr-squad-strip')`).catch(() => false)) await shot('20261126-r46-B3-room-after-hub-restart-1440');
    check('真 Claude 凭据未被改动', hash(claudeAuth) === authBefore);
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (c) await shot('20261126-r46-failure-1440').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (c) c.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, '20261126-r46-e2e-report.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(path.join(root, '.cac', '.credentials.json'), { force: true }); } catch {}
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error ? String(report.error).split('\n')[0] : undefined, out }, null, 2));
  }
}
main();
