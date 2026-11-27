'use strict';
// 社区 › 广场 / 我的团队 真界面验收（2026-11-28）：同一台电脑起两个隔离 Hub（隐藏窗口、各自数据目录），
// 用两个本地文件夹假装两台电脑的共享（AI_HUB_CREW_FAKE_NET，只在隔离实例生效），按真实操作路径走一遍：
//   甲：广场（排行榜数据用 mock）→ 点桌宠 → 打听工作被拒；我的团队：自动用上共享 → 建团队 → 生成邀请；
//   乙：粘贴邀请加入；甲：广播、分享文件夹（确认卡 → 送达）、问乙；乙：收到分享并取回、来信起草后寄出；甲：看到回信。
// 每步截图（1440×900），检查渲染错误与主区域不出纵向滚动条。
// 用法：node tests/e2e-community-crew-cdp.js --out <新目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const mock = require('./fixtures/community-board-mock');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

const boardMock = board => `(()=>{
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__cmyOrig) ipcRenderer.__cmyOrig = ipcRenderer.invoke.bind(ipcRenderer);
  window.__cmyBoard = ${JSON.stringify(board)};
  ipcRenderer.invoke = (ch, ...a) => {
    if (!String(ch).startsWith('community:')) return ipcRenderer.__cmyOrig(ch, ...a);
    if (ch === 'community:get-board') return Promise.resolve(JSON.parse(JSON.stringify(window.__cmyBoard)));
    if (ch === 'community:get-settings') return Promise.resolve({ ok: true, enabled: true });
    return Promise.resolve({ ok: true });
  };
  return true;
})()`;

async function start(name, root, netFile, out, evidence) {
  const data = path.join(root, name + '-data');
  fs.mkdirSync(data, { recursive: true });
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'community-crew-' + name, extraEnv: {
    CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js'),
    AI_HUB_CREW_FAKE_NET: netFile, AI_HUB_CREW_NO_MODEL: '1',
  } });
  const c = await connectFirstPage(hub);
  c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(name + ': ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } catch { /* 非 JSON */ } });
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const wait = async (expr, label, timeout = 40000) => { for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* 页面还没好 */ } await sleep(250); } throw new Error(name + ' 等待超时：' + label); };
  const shot = async file => { await sleep(700); fs.writeFileSync(path.join(out, file + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); evidence.steps.push('shot ' + file); };
  const click = sel => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
  const type = (sel, text) => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.focus();e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const ipc = (ch, req) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)}, ${JSON.stringify(req || {})})`);
  return { hub, c, wait, shot, click, type, ipc };
}

async function run() {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'community-crew-' + Date.now()));
  fs.mkdirSync(out, { recursive: true });
  const evidence = { steps: [], rendererErrors: [], checks: {}, failures: [] };
  const expect = (ok, msg) => { if (!ok) evidence.failures.push(msg); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crew-e2e-'));
  const shareA = path.join(root, 'share-A'), shareB = path.join(root, 'share-B');
  fs.mkdirSync(shareA); fs.mkdirSync(shareB);
  const map = { '10.1.1.1': { name: 'S_A', path: shareA }, '10.1.1.2': { name: 'S_B', path: shareB } };
  const netA = path.join(root, 'netA.json'), netB = path.join(root, 'netB.json');
  fs.writeFileSync(netA, JSON.stringify({ self: '10.1.1.1', net: map }));
  fs.writeFileSync(netB, JSON.stringify({ self: '10.1.1.2', net: map }));
  const srcDir = path.join(root, 'SRS脚本');
  fs.mkdirSync(path.join(srcDir, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'run.py'), 'print("六小区对齐")\n');
  fs.writeFileSync(path.join(srcDir, 'cfg', 'seeds.txt'), 'seed=1..20\n');

  let A, B;
  try {
    A = await start('甲', root, netA, out, evidence);
    B = await start('乙', root, netB, out, evidence);
    for (const X of [A, B]) await X.wait(`!!document.getElementById('btn-community')`, 'entry');
    await A.c.eval(boardMock(mock.board()));
    await B.c.eval(boardMock(mock.board()));

    // ---- 甲：广场 ----
    await A.c.eval(`localStorage.setItem('community.sub','square')`);
    await A.click('#btn-community');
    await A.wait(`document.querySelectorAll('#community-page .cmy-sub[data-sub="square"].on .cc-pet').length>=5`, 'plaza pets');
    await sleep(5000);
    await A.shot('01-广场');
    evidence.checks.plazaPets = await A.c.eval(`document.querySelectorAll('#community-page .cmy-sub[data-sub="square"] .cc-pet').length`);
    await A.c.eval(`(()=>{const p=[...document.querySelectorAll('#community-page .cmy-sub[data-sub="square"] .cc-pet')].find(e=>!e.classList.contains('me'));p.click();return true})()`);
    await A.wait(`!!document.querySelector('#community-page [data-sq="probe"]')`, 'pet card');
    await A.click('#community-page [data-sq="probe"]');
    // 串门是动画：先走过去、问一句，再出带锁的拒绝气泡；气泡显示几秒后会消失，所以边等边查。
    evidence.checks.lockBubble = false;
    for (let k = 0; k < 40 && !evidence.checks.lockBubble; k++) { await sleep(250); evidence.checks.lockBubble = await A.c.eval(`!!document.querySelector('#community-page .cc-bub.lock.show')`); }
    await A.shot('02-广场-打听工作被拒');
    expect(evidence.checks.lockBubble, '广场打听工作没有出现带锁的拒绝气泡');

    // ---- 甲：我的团队 → 自动用上共享 → 建团队 ----
    await A.click('#community-page [data-cmy-sub="crew"]');
    await A.wait(`!!document.querySelector('#community-page [data-slot="newname"]')`, 'start setup');
    await A.shot('03-团队-首次进入');
    await A.type('#community-page [data-slot="newname"]', '调度算法小组');
    await A.click('#community-page [data-cc="create"]');
    await A.wait(`!!document.querySelector('#community-page [data-slot="invname"]')`, 'members tab');
    await A.type('#community-page [data-slot="invname"]', '乙');
    await A.type('#community-page [data-slot="invip"]', '10.1.1.2');
    await A.click('#community-page [data-cc="invite"]');
    const message = await A.wait(`(()=>{const e=document.querySelector('#community-page .cc-recv [data-i18n-skip]');return e&&e.textContent})()`, 'invite message');
    evidence.checks.invite = message;
    await A.shot('04-团队-生成邀请');

    // ---- 乙：粘贴邀请加入 ----
    await B.c.eval(`localStorage.setItem('community.sub','crew')`);
    await B.click('#btn-community');
    await B.click('#community-page [data-cmy-sub="crew"]');
    await B.wait(`!!document.querySelector('#community-page .cmy-sub.on[data-sub="crew"] [data-slot="joinText"]')`, 'join box');
    await B.type('#community-page [data-slot="joinText"]', message);
    await B.shot('05-乙-粘贴邀请');
    await B.click('#community-page [data-cc="dojoin"]');
    await B.wait(`document.querySelectorAll('#community-page .cmy-sub[data-sub="crew"] .cc-pet').length>=2`, 'B joined');

    // 甲发现乙（邀请时填的 IP → 去乙的共享里找）
    for (let k = 0; k < 8; k++) { await A.ipc('community-crew:poll-now'); await B.ipc('community-crew:poll-now'); if (await A.c.eval(`document.querySelectorAll('#community-page .cmy-sub[data-sub="crew"] .cc-pet').length>=2`)) break; await sleep(3000); }
    await A.wait(`document.querySelectorAll('#community-page .cmy-sub[data-sub="crew"] .cc-pet').length>=2`, 'A sees B', 60000);
    await A.ipc('community-crew:poll-now'); await B.ipc('community-crew:poll-now');
    await sleep(800);
    await A.shot('06-甲-乙入队了');

    // ---- 甲：广播 ----
    await A.type('#community-page [data-slot="cmd"]', '告诉大家我今晚挂仿真，明早出结果');
    await A.click('#community-page [data-cc="run"]');
    await sleep(1200);
    await B.ipc('community-crew:poll-now');
    await B.wait(`[...document.querySelectorAll('#community-page .cc-board p')].some(p=>p.textContent.includes('挂仿真'))`, 'B board shows broadcast');
    await B.shot('07-乙-看到公告');

    // ---- 甲：分享文件夹 ----
    await A.type('#community-page [data-slot="cmd"]', `把 ${srcDir} 分享给乙，用法是 python run.py --cfg 六小区`);
    await A.click('#community-page [data-cc="run"]');
    await A.wait(`!!document.querySelector('#community-page .cc-confirm.show')`, 'confirm card');
    await A.shot('08-甲-分享确认卡');
    await A.click('#community-page [data-cc="cfok"]');
    await sleep(3200);
    await A.shot('09-甲-桌宠送文件');
    await B.ipc('community-crew:poll-now');
    await B.click('#community-page [data-tab="share"]');
    const recvPath = await B.wait(`(()=>{const b=document.querySelector('#community-page [data-cc="openpath"]');return b&&b.dataset.path})()`, 'B received share', 60000);
    evidence.checks.received = recvPath;
    expect(fs.existsSync(path.join(recvPath, 'cfg', 'seeds.txt')) && fs.readFileSync(path.join(recvPath, 'cfg', 'seeds.txt'), 'utf8') === 'seed=1..20\n', '乙取回的文件内容不对');
    await sleep(2500);
    await B.shot('10-乙-收到分享');

    // ---- 甲：问乙；乙：起草后寄出；甲：看到回信 ----
    await A.type('#community-page [data-slot="cmd"]', '问问乙 SRS 周期现网用多少？');
    await A.click('#community-page [data-cc="run"]');
    await sleep(800);
    // 没认出人名时会弹「问谁？」让选人（不会误发成全员广播）。
    if (await A.c.eval(`!!document.querySelector('#community-page [data-cc="pickask"]')`)) { await A.shot('11a-甲-问谁'); await A.click('#community-page [data-cc="pickask"]'); }
    await sleep(1500);
    await B.ipc('community-crew:poll-now');
    await B.click('#community-page [data-tab="mail"]');
    await B.wait(`!!document.querySelector('#community-page [data-mail]')`, 'B mail row');
    await B.click('#community-page [data-mail]');
    await B.wait(`!!document.querySelector('#community-page [data-slot="draft"]')`, 'B draft box');
    await B.type('#community-page [data-slot="draft"]', '现网常用 20/40/80 ms 三档，按速率分档。');
    await B.shot('11-乙-来信等确认');
    await B.click('#community-page [data-cc="sendreply"]');
    await sleep(800);
    evidence.checks.replyToast = await B.c.eval(`document.querySelector('#community-page .cc-toast')?.textContent || ''`);
    expect(evidence.checks.replyToast.includes('已寄出'), '乙寄出回信失败：' + evidence.checks.replyToast);
    await A.click('#community-page [data-tab="mail"]');
    let gotAnswer = false;
    for (let k = 0; k < 8 && !gotAnswer; k++) {
      await A.ipc('community-crew:poll-now');
      await sleep(1500);
      if (await A.c.eval(`!!document.querySelector('#community-page [data-cc="mailback"]')`)) await A.click('#community-page [data-cc="mailback"]');
      await A.wait(`!!document.querySelector('#community-page [data-mail]')`, 'A mail row');
      await A.click('#community-page [data-mail]');
      gotAnswer = await A.c.eval(`[...document.querySelectorAll('#community-page .cc-thread .tx')].some(e=>e.textContent.includes('20/40/80'))`);
    }
    evidence.checks.answerPolls = gotAnswer;
    await A.wait(`[...document.querySelectorAll('#community-page .cc-thread .tx')].some(e=>e.textContent.includes('20/40/80'))`, 'A sees answer');
    await A.shot('12-甲-收到回信');

    // ---- 一屏检查 ----
    evidence.checks.scroll = await A.c.eval(`(()=>{const p=document.getElementById('community-page');const sub=p.querySelector('.cmy-sub.on');return {page:p.scrollHeight>p.clientHeight+1,sub:sub?sub.scrollHeight>sub.clientHeight+1:null}})()`);
    expect(!evidence.checks.scroll.page, '社区页出现纵向滚动');
    await A.click('#community-page [data-cmy-sub="board"]');
    await sleep(600);
    await A.shot('13-排行榜子页');
  } catch (e) {
    evidence.failures.push('流程中断：' + e.message);
    try { if (A) await A.shot('xx-甲-中断时'); } catch { /* 截不了 */ }
    try { if (B) await B.shot('xx-乙-中断时'); } catch { /* 截不了 */ }
  } finally {
    for (const X of [A, B]) { try { X?.c?.close?.(); } catch { /* 已断开 */ } if (X?.hub) await gracefulQuit(X.hub).catch(() => {}); }
  }
  if (evidence.rendererErrors.length) evidence.failures.push('渲染进程报错 ' + evidence.rendererErrors.length + ' 条');
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ out, failures: evidence.failures, rendererErrors: evidence.rendererErrors.slice(0, 5), checks: evidence.checks }, null, 2));
  process.exitCode = evidence.failures.length ? 1 : 0;
}

run().catch(e => { console.error(e); process.exit(1); });
