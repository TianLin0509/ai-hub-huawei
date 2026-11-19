'use strict';
// 「在跑一览」界面截图（2026-11-20）：隔离数据目录、隐藏窗口、假 CodeAgent；1440×900。
//   node tests/capture-running-overview-cdp.js --out <新目录>
// 截三张：侧栏按钮、真实隔离 Hub 数据打开的一览、排版样张（同一套界面，数据换成合成的多组会话，看满屏时的样子）。
// 另核对：弹窗和页面都没有纵向滚动；点一行能跳到该会话。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

function seed(dir) {
  const { writeProbed } = require(path.join(REPO, 'core/codeagent-model-probe'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'capture-personal', expiresAt: Date.now() + 86400000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
}

// 合成样张：用真实的 buildRunningOverview 生成，只换输入。
const SAMPLE = `(() => {
  const { buildRunningOverview } = require(${JSON.stringify(path.join(REPO, 'core/running-overview.js'))});
  const now = Date.now(), M = 60000, H = 60 * M;
  const S = (id, title, kind, out, f) => ({ s: { id, title, kind, lastOutputAt: now - out }, f: { kind, ...f } });
  const list = [
    S('w1', '周报整理', 'CodeAgent', 2 * M, { needsInput: true, busy: true }),
    S('w2', '仿真配置复核', 'CodeAgent', 6 * M, {}),
    S('w3', '接口文档改版', 'pi', 12 * M, { needsInput: true }),
    S('x1', '批量回归测试', 'CodeAgent', 52 * M, { busy: true }),
    S('x2', '数据清洗脚本', 'CodeAgent', 2.5 * H, {}),
    S('r1', '组队负责人：评审材料', 'CodeAgent', 1 * M, { busy: true }),
    S('r2', '成员 m1：图表重绘', 'CodeAgent', 3 * M, { busy: true }),
    S('r3', '成员 m2：数据核对', 'CodeAgent', 4 * M, { busy: true }),
    S('r4', '长文翻译', 'DeepSeek', 2 * M, { busy: true }),
    S('d1', '会议纪要', 'CodeAgent', 18 * M, { completed: true }),
    S('d2', '代码走查', 'Claude', 40 * M, { completed: true }),
    S('d3', '日志分析', 'Codex', 95 * M, { completed: true }),
  ];
  const cards = [
    { sessionId: 'w2', mtimeMs: now - 6 * M, plain: { status: '顺利', line: '两套配置都跑完了', decision: { question: '按方案 A 还是 B 出报告', recommendation: 'A' } } },
    { sessionId: 'x2', mtimeMs: now - 2.5 * H, plain: { status: '顺利', line: '清洗到第 3 批，共 5 批' } },
    { sessionId: 'x1', mtimeMs: now - 4 * H, plain: { status: '顺利', line: '跑全量回归，预计 20 分钟' } },
    { sessionId: 'r1', mtimeMs: now - 10 * M, plain: { status: '顺利', line: '3 名成员在做，已完成 1 项，还剩 2 项' } },
    { sessionId: 'r2', mtimeMs: now - 8 * M, plain: { status: '有风险', line: '第二张图数据缺一列，在补' } },
    { sessionId: 'd1', mtimeMs: now - 18 * M, plain: { status: '已完成', line: '纪要已写好，待你过目' } },
  ];
  const teams = [{ leadSid: 'r1', members: [{ memberId: 'm1', sid: 'r2', status: 'active' }, { memberId: 'm2', sid: 'r3', status: 'active' }] }];
  const facts = new Map(list.map(x => [x.s.id, x.f]));
  const rest = Array.from({ length: 9 }, (_, i) => ({ id: 'z' + i, title: '其余' + i, lastOutputAt: now - 30 * H }));
  return buildRunningOverview({ sessions: [...list.map(x => x.s), ...rest], cards, teams, now, facts: s => facts.get(s.id) || {} });
})()`;

async function run(out) {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-running-overview-')), data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
  for (const dir of [data, work, path.join(root, 'scan')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  seed(personal);
  const evidence = { root, shots: [], rendererErrors: [], startedAt: new Date().toISOString() };
  const extraEnv = { AI_HUB_WORKSPACE_ROOT: work, HUB_SESSION_SEARCH_DISABLE_NATIVE: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
    AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/help-ask-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: personal,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'), CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fake.jsonl'),
    CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex') };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'running-overview-capture', extraEnv });
    c = await connectFirstPage(hub);
    c.ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') evidence.rendererErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); } catch {} });
    await c.send('Runtime.enable');
    const wait = async (expr, label, timeout = 30000) => {
      let last; for (const end = Date.now() + timeout; Date.now() < end;) { try { const v = await c.eval(expr); if (v) return v; } catch (e) { last = e.message; } await sleep(200); }
      throw Error('Timeout ' + label + (last ? ': ' + last : ''));
    };
    const click = async selector => {
      const xy = await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`, 'clickable ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...xy });
    };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('typeof selectSession === "function" && !!document.getElementById("btn-running-overview")', 'renderer ready');
    await sleep(1500);
    const shot = async name => {
      // 新建会话时 Hub 弹的模型提示会盖住右上角，截图前点掉（只点「知道了」）。
      await c.eval(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='知道了'&&b.offsetParent).forEach(b=>b.click())`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1430, y: 890 });
      await sleep(400);
      const image = Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      const file = path.join(out, `20261120-running-overview-${name}-1440-m2.png`);
      fs.writeFileSync(file, image); evidence.shots.push(file);
      evidence['scroll-' + name] = await c.eval(`({doc:document.documentElement.scrollHeight>innerHeight,dialog:(()=>{const d=document.querySelector('.ro-dialog');return d?{scroll:d.scrollHeight>d.clientHeight,lists:[...d.querySelectorAll('.ro-list')].some(l=>l.scrollHeight>l.clientHeight+1)}:null})()})`);
    };
    // 真实隔离数据：两个假 CodeAgent 会话 + 一个 PowerShell。
    const ids = [];
    for (const [kind, title] of [['codeagent', '示例：周报整理'], ['codeagent', '示例：数据核对'], ['powershell', '示例：终端']]) {
      const created = await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({ kind, opts: { cwd: work, title } })})`);
      if (created?.id) ids.push(created.id);
    }
    evidence.created = ids.length;
    await sleep(4000);
    evidence.buttonRect = await c.eval(`(()=>{const r=document.getElementById('btn-running-overview').getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})()`);
    evidence.detailBar = await c.eval(`[...document.querySelector('.session-detail-bar').children].map(e=>{const r=e.getBoundingClientRect();return (e.id||e.className)+':'+[r.x,r.y,r.width,r.height].map(Math.round).join(',')+(getComputedStyle(e).display==='none'?':none':'')})`);
    await shot('sidebar');
    await click('#btn-running-overview');
    await wait(`document.querySelector('.ro-dialog .ro-col')`, 'overview open');
    await sleep(600);
    evidence.real = await c.eval(`ipcRenderer.invoke('running-overview:get').then(r=>({counts:r.counts,rows:r.rows.map(x=>[x.title,x.group,x.state]),bytes:r.bytes,text:r.text}))`);
    await shot('real');
    // 点一行跳到该会话（真实数据里有行时）。
    const rowId = await c.eval(`document.querySelector('.ro-row')?.dataset.sessionId || null`);
    evidence.style = await c.eval(`(()=>{const col=document.querySelector('.ro-col');const cs=getComputedStyle(col);return {colBorder:cs.borderRightColor+' '+cs.borderRightWidth,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent-blue'),line:getComputedStyle(document.documentElement).getPropertyValue('--ro-line')}})()`);
    if (rowId) {
      evidence.hit = await c.eval(`(()=>{const r=document.querySelector('.ro-row').getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h?(h.className||h.tagName)+'|'+(h.closest('.ro-row')?'in-row':'outside'):null})()`);
      await click('.ro-row');
      await sleep(1200);
      evidence.jump = await c.eval(`({closed:!document.querySelector('.ro-overlay'),active:typeof activeSessionId!=='undefined'?activeSessionId:null,expected:${JSON.stringify(rowId)}})`);
    }
    await c.eval(`window.__runningOverview.close()`);
    // 排版样张：同一界面，invoke 换成合成数据（真实 buildRunningOverview 生成）。
    await c.eval(`(()=>{const orig=ipcRenderer.invoke.bind(ipcRenderer);window.__roOrig=orig;ipcRenderer.invoke=(ch,...a)=>ch==='running-overview:get'?Promise.resolve({ok:true,...${SAMPLE}}):orig(ch,...a);return true})()`);
    await click('#btn-running-overview');
    await wait(`document.querySelectorAll('.ro-row').length>=8`, 'sample rendered');
    await sleep(500);
    evidence.leadBadge = await c.eval(`(()=>{const b=document.querySelector('.ro-team-lead');if(!b)return null;const r=b.getBoundingClientRect(),cs=getComputedStyle(b);return {rect:[r.x,r.y,r.width,r.height].map(Math.round),color:cs.color,display:cs.display,text:b.textContent}})()`);
    evidence.sampleText = await c.eval(`(${SAMPLE}).text`);
    await shot('layout');
    await c.eval(`window.__runningOverview.close()`);
  } finally {
    try { c?.ws?.close(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => { evidence.quitError = e.message; });
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, '20261120-running-overview-evidence-m2.json'), JSON.stringify(evidence, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  return evidence;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(REPO, 'artifacts', 'running-overview-' + Date.now());
  run(out).then(e => { console.log(JSON.stringify({ shots: e.shots, errors: e.rendererErrors.length, jump: e.jump, scroll: Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith('scroll-'))) }, null, 2)); })
    .catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
}
module.exports = { run };
