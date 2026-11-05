'use strict';
// 「问一下」抽屉截图：已答完（早先一条折叠）+ 思考中 + 出错，1440 与 1280。--entry 可指向改前的检出做对照。
// 隔离数据、后台离屏窗口、假 CodeAgent；问答内容由页面内推送注入，不调模型。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'ask-bubble-' + Date.now()), tag: 'after' };
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

async function run() {
  fs.mkdirSync(opt.out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ask-bubble-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, personal, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'bubble-personal', expiresAt: Date.now() + 86400000 } }));
  const result = { entry: path.resolve(opt.entry), shots: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: path.resolve(opt.entry), cwd: path.resolve(opt.entry), dataDir: data, port: await freePort(), windowMode: 'background', label: 'ask-bubble', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
      AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'),
      CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    } });
    c = await connectFirstPage(hub);
    const wait = async (expr, label, timeout = 30000) => {
      for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch { /* loading */ } await sleep(150); }
      throw Error('Timeout ' + label);
    };
    await wait('typeof selectSession === "function" && !!window.__askAsideUi', 'renderer ready');
    const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind: 'codeagent', opts: { cwd: work, title: '周期方案重构', codeagentAccount: 'personal' } })})`);
    await c.eval(`selectSession(${JSON.stringify(created.id)})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'session visible');
    const t = m => new Date(Date.now() - m * 60000).toISOString();
    const A1 = { id: 'q1', q: '现在卡在哪？', a: '没有卡住。正在跑 `npm test` 的第二组，前面 412 条都过了。\n\n剩下的主要是会议页的端到端测试，通常 2 分钟左右。跑完会先看失败项再决定要不要改。', status: 'done', at: t(2), wall_s: 41 };
    const A0 = { id: 'q0', q: '为什么这么做？', a: '因为旧的调度入口在两个地方各算一遍优先级，结果不一致。这一轮先把计算收口到 `scheduler/priority.js`，再让两个入口都调它。\n\n收口后旧分支只剩兼容用，下一轮删除。', status: 'done', at: t(9), wall_s: 34 };
    // s1 要求的四态：已答 / 思考中 / 出错 / 折叠（早先一条折叠 + 最新一条展开）
    const states = {
      answered: [A1],
      thinking: [{ id: 'q2', q: '还要多久？', status: 'running', at: t(0.4), startedAt: t(0.4) }],
      error: [{ id: 'q3', q: '为什么这么做？', status: 'error', error: '会话的账号额度用完了', at: t(0.2) }],
      fold: [A0, A1],
    };
    for (const width of [1440, 1280]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 860, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      await c.eval('window.__askAsideUi.hide();window.__askAsideUi.open()');
      await wait(`!document.querySelector('.ask').hidden`, 'drawer open');
      await sleep(1500);
      for (const [name, items] of Object.entries(states)) {
        await c.eval(`ipcRenderer.emit('ask-aside:changed',{},${JSON.stringify({ sessionId: created.id, supported: true, account: 'personal', items })})`);
        await sleep(700);
        const file = `${opt.tag}-${name}-${width}.png`;
        fs.writeFileSync(path.join(opt.out, file), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        const probe = await c.eval(`(()=>{const dr=document.querySelector('.ask').getBoundingClientRect();const more=[...document.querySelectorAll('.ask [data-more]')].filter(m=>!m.hidden).length;const a=[...document.querySelectorAll('.ask .ask-a')].pop(),q=[...document.querySelectorAll('.ask .ask-q p')].pop();const cs=a&&getComputedStyle(a);const sizes=new Set();for(const e of document.querySelectorAll('.ask *')){if(e.offsetParent!==null&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))sizes.add(getComputedStyle(e).fontSize)}return {drawer:{x:dr.x,y:dr.y,w:dr.width,h:dr.height},moreShown:more,answerBg:cs&&cs.backgroundColor,answerRadius:cs&&cs.borderRadius,answerLeft:a&&Math.round(a.getBoundingClientRect().left-document.querySelector('.ask-b').getBoundingClientRect().left),questionBg:q&&getComputedStyle(q).backgroundColor,fontSizes:[...sizes].sort()}})()`);
        result.shots.push({ file, width, state: name, ...probe });
      }
    }
    result.ok = true;
  } catch (error) { result.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally {
    if (hub) { try { await gracefulQuit(hub); } catch { /* best effort */ } hub.child?.stdout?.destroy(); hub.child?.stderr?.destroy(); hub.child?.stdin?.destroy(); }
    try { await c?.close(); } catch { /* closed */ }
    fs.writeFileSync(path.join(opt.out, `${opt.tag}-ask-bubble.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: !!result.ok, out: opt.out }));
  }
}
run();
