'use strict';
// 真实验收：群聊「小队模式」（2026-11-19，反馈 1574aa0b）。
// 隔离 Hub、全新数据目录、无头窗口；三位 CodeAgent 成员用替身（tests/fixtures/codeagent-standin，内部跑真 Claude Code；建群不指定模型时用本机 Claude 的默认模型，不是 haiku），
// 会花少量真实 token。全程真实点击与键盘：建群 → 开小队模式 → 发一句话 → 负责人派工 → 成员 2、成员 3 依次做 → 自动交回 → 负责人收口。
// 凭据复制进临时目录，结束后删除；真 Claude 配置不被改动（哈希核对）。
// 用法：node tests/e2e-company-group-squad-real.js   （截图与报告写到 HUB_E2E_ARTIFACT_DIR，默认 artifacts/20261119-group-squad）
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const STANDIN = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const QUESTION = '请按小队流程完成：先让 @m2 只回复三个水果的中文名（一行，用顿号隔开），再让 @m3 把 m2 给的水果名翻译成英文（一行）。两位都交回后，你验收并用一句话汇总给我。';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-squad-'));
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261119-group-squad'); fs.mkdirSync(out, { recursive: true });
  const claudeSource = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const claudeAuth = path.join(claudeSource, '.credentials.json');
  const authBefore = hash(claudeAuth);
  const cac = path.join(root, '.cac'), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
  for (const d of [cac, cwd, dataDir]) fs.mkdirSync(d, { recursive: true });
  const report = { checks: [], screenshots: [], passed: false, providerNetworkTested: true };
  let hub, c;
  const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); assert.ok(ok, name + (detail ? ' :: ' + j(detail) : '')); };
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(400); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); report.screenshots.push(path.join(out, name + '.png')); };
  const click = async selector => {
    const point = await c.eval(`(() => {const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const squad = id => c.eval(`require('electron').ipcRenderer.invoke('squad:view',{meetingId:${j(id)}})`);
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true,
      hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'group squad', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: STANDIN, AI_HUB_CODEAGENT_CONFIG_DIR: cac, AI_HUB_CODEAGENT_SERVE: '0',
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'),
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none') } });
    c = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.openMeetingCreateModal', 'renderer ready');

    // ① 新建群聊：默认两位 CodeAgent，再加一位，共三位。
    await click('#btn-new');
    await until('getComputedStyle(document.getElementById("new-session-menu")).display !== "none"', 'launch center');
    await click('[data-launch-intent="group"]');
    await until(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length === 2`, 'group panel');
    await click('#mcm-add-member');
    await until(`document.querySelectorAll('#meeting-create-modal .mcm-slot').length === 3`, 'third member');
    await click('#meeting-create-modal .mcm-create');
    await until(`!!document.getElementById('mr-btn-add-sub')`, 'meeting room open', 120000);
    const meetingId = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.at(-1).id)`);
    await until(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.at(-1).subSessions.length === 3)`, 'three members', 120000);
    await until(`!!document.getElementById('mr-btn-squad')`, 'squad button');
    check('群聊顶栏有「小队模式」按钮，默认未开启', await c.eval(`document.getElementById('mr-btn-squad').textContent.trim() === '小队模式' && document.getElementById('mr-btn-squad').getAttribute('aria-pressed') === 'false'`));
    const defaultView = await squad(meetingId);
    check('新群默认小队关闭', defaultView.ok && defaultView.config.enabled === false);
    await shot('20261119-squad-01-room-default-1440-roomD');

    // ② 开小队模式：弹层默认负责人是成员 1、6 轮。
    await click('#mr-btn-squad');
    await until(`!!document.getElementById('mr-squad-pop')`, 'squad popover');
    check('弹层默认负责人是第一位成员、最多 6 轮', await c.eval(`document.querySelector('[data-squad-leader]').selectedIndex === 0 && document.querySelector('[data-squad-rounds]').value === '6' && document.querySelectorAll('[data-squad-leader] option').length === 3`));
    await shot('20261119-squad-02-settings-1440-roomD');
    await click('[data-squad-save]');
    await until(`!document.getElementById('mr-squad-pop') && /小队 · 负责人/.test(document.getElementById('mr-btn-squad').textContent)`, 'squad enabled');
    await until(`!!document.querySelector('.mr-squad-strip')`, 'squad strip');
    const lit = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.find(m => m.id === ${j(meetingId)}).participants)`);
    check('开启后只点亮负责人头像', j(lit) === '[0]', lit);
    await shot('20261119-squad-03-enabled-1440-roomD');

    // ③ 发一句话（真实键盘）。等三位成员 CLI 就绪由 Hub 自己处理。
    // 机器很忙时负责人 CLI 可能还没起好（cli_not_ready）：照提示等一会再发一次，最多重发 2 次。
    const send = async () => {
      await click('#mr-input-box');
      await c.send('Input.insertText', { text: QUESTION });
      await click('#mr-send-btn');
    };
    await send();
    const end = Date.now() + 15 * 60_000;
    let view = null, shotMembers = false, resent = 0;
    report.resent = [];
    while (Date.now() < end) {
      view = await squad(meetingId);
      const run = view.run;
      if (run && run.status === 'members' && !shotMembers && run.steps.some(s => s.state === 'running')) {
        await sleep(1500); await shot('20261119-squad-04-members-running-1440-roomD'); shotMembers = true;
      }
      if (run && run.status === 'error' && /CLI 还没启动好/.test(run.note || '') && resent < 2) {
        report.resent.push(run.note); resent += 1;
        await shot(`20261119-squad-cli-not-ready-${resent}-1440-roomD`);
        await sleep(45_000); await send(); await sleep(3000);
        continue;
      }
      if (run && ['done', 'limit', 'stopped', 'error'].includes(run.status)) break;
      await sleep(1500);
    }
    report.finalRun = view && view.run;
    check('小队跑完并由负责人收口', view && view.run && view.run.status === 'done', view && view.run);
    check('负责人至少派了一轮，最后一轮的每一棒都已交回', view.run.round >= 1 && view.run.steps.length >= 1
      && view.run.steps.every(s => s.state === 'done'), view.run.steps);
    check('界面标签用短名「成员 N」，不带自动标题', /^成员 \d$/.test(view.leaderLabel) && view.run.steps.every(s => /^成员 \d$/.test(s.label)), view.leaderLabel);
    const state = await c.eval(`require('electron').ipcRenderer.invoke('groupchat:get-state',{meetingId:${j(meetingId)}}).catch(e=>({error:e.message}))`);
    const messages = (state && (state.messages || state.state?.messages)) || [];
    report.messages = messages.map(m => ({ role: m.role, speaker: m.speaker, kind: m.dispatch && m.dispatch.kind, note: !!m.systemNote, text: String(m.content || '').slice(0, 160) }));
    const cards = messages.filter(m => m.dispatch && m.dispatch.kind === 'squad').map(m => String(m.content || '').split(/\r?\n/)[0]);
    check('每一棒在群里都有一行「负责人派给 @X：任务」', cards.length >= 2 && cards.every(t => /^负责人派给 @成员 \d：/.test(t)), cards);
    const backs = messages.filter(m => m.dispatch && m.dispatch.kind === 'squad-notice');
    check('成员做完后 Hub 自动交回负责人', backs.length >= 1 && backs.length === view.run.round, backs.length);
    const answers = messages.filter(m => m.role === 'assistant' && String(m.content || '').trim());
    const said = sid => answers.some(m => m.sid === sid);
    const sids = await c.eval(`require('electron').ipcRenderer.invoke('get-meetings').then(l => l.find(m => m.id === ${j(meetingId)}).subSessions)`);
    check('成员 2、成员 3 都交了非空回答，最后一条是负责人的收口', said(sids[1]) && said(sids[2]) && answers.at(-1).sid === sids[0], answers.map(m => m.speaker));
    await sleep(1500);
    await shot('20261119-squad-05-done-1440-roomD');
    await c.eval(`document.querySelector('.mr-gc-scroll, #mr-gc-messages, .mr-gc-list')?.scrollTo?.(0,0)`).catch(() => {});
    await shot('20261119-squad-06-done-top-1440-roomD');
    check('真 Claude 凭据未被改动', hash(claudeAuth) === authBefore);
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    if (c) await shot('20261119-squad-failure-1440-roomD').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (c) c.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
    fs.writeFileSync(path.join(out, '20261119-squad-e2e-roomD.json'), JSON.stringify(report, null, 2));
    try { fs.rmSync(path.join(root, '.cac', '.credentials.json'), { force: true }); } catch {}
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error ? String(report.error).split('\n')[0] : undefined, out }, null, 2));
  }
}
main();
