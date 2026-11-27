'use strict';
// 打开会话定位到最新提问（2026-11-27）：隔离 Hub + 合成 Claude 记录（CLAUDE_PROXY 指向不可达端口，不调用模型），
// 用真实鼠标点侧栏打开会话，量最新提问离可视区顶部的距离、离底部的距离、是否仍在跟随，并逐个截图。
// 用法：node tests/e2e-card-open-latest-question-cdp.js [输出目录]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), crypto = require('crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const outDir = path.resolve(process.argv[2] || 'artifacts/card-open-latest-question');
const tag = process.env.HUB_E2E_TAG || 'hub';

const para = (label, n) => Array.from({ length: n }, (_, i) => `${label} 第 ${i + 1} 段：这是一段用来撑高度的回答正文，说明结论、依据和下一步，确保整条回答超过一屏。`).join('\n\n');
function transcript(sid, cwd, spec) {
  const lines = []; let n = 0;
  const at = () => new Date(Date.UTC(2026, 10, 27, 8, 0, 0) + (n++) * 1000).toISOString();
  const user = (text) => lines.push({ type: 'user', uuid: crypto.randomUUID(), timestamp: at(), sessionId: sid, cwd, message: { role: 'user', content: text } });
  const answer = (text) => lines.push({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: at(), sessionId: sid, cwd,
    message: { id: 'm' + crypto.randomUUID(), role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const tool = (k) => {
    const id = `t-${k}-${crypto.randomUUID().slice(0, 6)}`;
    lines.push({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: at(), sessionId: sid, cwd,
      message: { id: 'm' + crypto.randomUUID(), role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', content: [{ type: 'text', text: `第 ${k} 步：先查一下相关文件。` }, { type: 'tool_use', id, name: 'Bash', input: { command: `echo step-${k}` } }] } });
    lines.push({ type: 'user', uuid: crypto.randomUUID(), timestamp: at(), sessionId: sid, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `step-${k} ok` }] } });
  };
  for (let t = 1; t <= 3; t++) { user(`${spec.tag} 早先的第 ${t} 个问题`); answer(para(`${spec.tag} 早先回答 ${t}`, 12)); }
  spec.build({ user, answer, tool });
  return lines.map(l => j(l)).join('\n') + '\n';
}
const CASES = [
  { key: 'short', title: '短回答', tag: 'SHORT', build: ({ user, answer }) => { user('LATEST_Q_SHORT 最新提问：短回答'); answer('好的，已改完。'); } },
  { key: 'long', title: '长回答', tag: 'LONG', build: ({ user, answer }) => { user('LATEST_Q_LONG 最新提问：长回答'); answer(para('ANSWER_START_LONG 长回答', 40)); } },
  { key: 'noanswer', title: '还没回答', tag: 'NOANS', build: ({ user }) => { user('LATEST_Q_NOANS 最新提问：还没回答'); } },
  { key: 'longq', title: '超长提问', tag: 'LONGQ', build: ({ user, answer }) => { user('LATEST_Q_LONGQ 超长提问开头\n' + Array.from({ length: 90 }, (_, i) => `需求第 ${i + 1} 条：请注意这一点。`).join('\n')); answer(para('ANSWER_START_LONGQ 回答', 30)); } },
  { key: 'tools', title: '进展卡很多', tag: 'TOOLS', build: ({ user, answer, tool }) => { user('LATEST_Q_TOOLS 最新提问：要跑很多步'); for (let k = 1; k <= 14; k++) tool(k); answer(para('FINAL_TOOLS 结论', 25)); } },
  { key: 'receipts', title: '提问后跟了很多回执', tag: 'RECEIPTS', build: ({ user, answer }) => { user('LATEST_Q_RECEIPTS 最新真实提问：后面跟了很多回执'); answer(para('ANSWER_RECEIPTS 回答', 30)); for (let k = 1; k <= 9; k++) { user(`【公司回执 Q-1127-0${k} · 第 1 轮】回执 ${k}：公司那边回来的结果。`); answer(`收到回执 ${k}。`); } } },
  { key: 'receipts2', title: '提问后跟了更多回执', tag: 'RECEIPTS2', build: ({ user, answer }) => { user('LATEST_Q_RECEIPTS2 最新真实提问：后面跟了 18 条回执'); answer(para('ANSWER_RECEIPTS2 回答', 30)); for (let k = 10; k <= 27; k++) { user(`【公司回执 Q-1127-${k} · 第 1 轮】回执 ${k}：公司那边回来的结果。`); answer(`收到回执 ${k}。`); } } },
  { key: 'notice', title: '末尾是通道回执', tag: 'NOTICE', build: ({ user, answer }) => { user('LATEST_Q_NOTICE 最新真实提问'); answer(para('ANSWER_NOTICE 回答', 30)); user('【公司回执 Q-1127-01 · 第 1 轮】这是公司通道送回来的回执，不算提问。'); answer('收到回执。'); } },
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-open-latest-q-'));
  const data = path.join(root, 'data'), claudeDir = path.join(root, 'claude'), cwd = path.join(root, 'work');
  const tdir = path.join(claudeDir, 'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
  for (const d of [data, cwd, tdir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  const now = Date.now();
  const cases = CASES.map((spec, i) => {
    const sid = crypto.randomUUID(), file = path.join(tdir, sid + '.jsonl');
    fs.writeFileSync(file, transcript(sid, cwd, spec));
    return { ...spec, hubId: `olq-${spec.key}-${now}`, sid, file, order: i };
  });
  fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, cleanShutdown: true, meetings: [], immersiveByMeeting: {}, sessions: cases.map((c, i) => ({
    hubId: c.hubId, title: `${i + 1} ${c.title}`, kind: 'claude', cwd, ccSessionId: c.sid, transcriptPath: c.file, currentModel: { id: 'claude-haiku-4-5-20251001' },
    lastMessageTime: now - i * 1000, updatedAt: now - i * 1000, savedAt: now, schemaVersion: 1 })) }));
  const entryPath = path.join(root, 'foreground-scheduling.cjs');
  fs.writeFileSync(entryPath, `const {app}=require('electron');app.on('browser-window-created',(_e,w)=>w.webContents.setBackgroundThrottling(false));require(${j(path.join(process.env.HUB_ENTRY || path.resolve(__dirname, '..'), 'main-bootstrap.js'))});`);
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_PROXY: 'http://127.0.0.1:9', CLAUDE_HUB_AGENT_RUNTIME: 'pty' };
  const report = { tag, entry: process.env.HUB_ENTRY || 'worktree', results: [], failures: [] };
  let hub = null, c = null;
  const launch = async (label) => {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label, entryPath, extraEnv: env });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const until = async (expr, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch {} await sleep(50); } throw Error('timeout ' + what); };
  const point = async sel => c.eval(`(()=>{const e=document.querySelector(${j(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+Math.min(60,r.width/2),y:r.y+r.height/2};})()`);
  const click = async sel => { const p = await point(sel); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }); for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 }); };
  const wheel = async (deltaY) => { const p = await c.eval(`(()=>{const r=document.getElementById('msg-overlay').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY }); };
  const shot = async name => { const f = path.join(outDir, `20261127-${tag}-${name}.png`); fs.writeFileSync(f, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); return f; };
  const settled = id => `activeSessionId===${j(id)} && currentView==='card' && document.querySelectorAll('#msg-overlay > .turn-card').length>0 && !document.querySelector('#msg-overlay > .card-history-more[disabled]')`;
  // 量：最新真实提问卡（按文字找）离可视区顶部多少、底部还剩多少、是否跟随、回到最新按钮是否显示。
  const measure = (marker) => c.eval(`(()=>{const o=document.getElementById('msg-overlay');const cards=[...o.querySelectorAll(':scope > .turn-card.user')].filter(x=>x.innerText.includes(${j(marker)}));const q=cards.pop();
    const or=o.getBoundingClientRect();const btn=document.getElementById('card-jump-latest');
    return {found:!!q,qTop:q?Math.round(q.getBoundingClientRect().top-or.top):null,qBottom:q?Math.round(q.getBoundingClientRect().bottom-or.top):null,
      gap:Math.round(o.scrollHeight-o.clientHeight-o.scrollTop),clientHeight:o.clientHeight,scrollTop:Math.round(o.scrollTop),following:cardFollowScroll.isFollowing(),
      jumpButton:!!btn&&!btn.hidden,cards:o.querySelectorAll(':scope > .turn-card').length,dataset:document.documentElement.dataset.cardOpenAt||''};})()`);
  const check = (name, ok, detail) => { report.results.push({ name, ok, ...detail }); if (!ok) report.failures.push(name); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + j(detail)); };
  const open = async (x, { first = false } = {}) => {
    await click(`.session-item[data-session-id="${x.hubId}"]`);
    await until(`activeSessionId===${j(x.hubId)}`, 'active ' + x.key);
    if (await c.eval(`currentView!=='card'`)) await c.eval(`applyViewMode('card')`);
    if (first) await until(`(sessions.get(${j(x.hubId)})?.status||'dormant')!=='dormant'`, 'resumed ' + x.key);
    await until(settled(x.hubId), 'cards ' + x.key);
    await sleep(1800); // 过了 1.5 秒排版稳定期再量
  };
  const marker = k => `LATEST_Q_${CASES.find(x => x.key === k).tag}`;
  const byKey = k => cases.find(x => x.key === k);
  try {
    await launch(`open-latest-q-${tag}`);
    await until(`typeof sessions!=="undefined" && ${cases.map(x => `!!document.querySelector('.session-item[data-session-id="${x.hubId}"]')`).join(' && ')}`, 'rows');
    // 1) 逐个首次打开
    for (const x of cases) {
      await open(x, { first: true });
      const m = await measure(marker(x.key));
      const file = await shot(`open-${x.key}`);
      if (x.key === 'long' || x.key === 'notice') check(`${x.title}：提问顶到上方`, m.found && m.qTop >= 4 && m.qTop <= 24 && !m.following && m.jumpButton, { ...m, file });
      else if (x.key === 'short' || x.key === 'noanswer') check(`${x.title}：停在最底下并跟随`, m.found && m.gap <= 3 && m.following && m.qBottom <= m.clientHeight, { ...m, file });
      else if (x.key === 'longq') check(`${x.title}：提问只占上半屏，回答从中部开始`, m.found && m.qBottom > m.clientHeight * 0.4 && m.qBottom <= m.clientHeight * 0.55 && m.qTop < 0, { ...m, file });
      else if (x.key === 'tools') check(`${x.title}：提问顶到上方`, m.found && m.qTop >= 4 && m.qTop <= 24 && !m.following, { ...m, file });
      else if (x.key === 'receipts2') check(`${x.title}：提问在 36 张卡之前，要补载两页才找到`, m.found && m.qTop >= 4 && m.qTop <= 24 && m.cards > 32 && !m.following, { ...m, file });
      else if (x.key === 'receipts') check(`${x.title}：首屏 8 张卡里没有提问，补载更早卡片后定位`, m.found && m.qTop >= 4 && m.qTop <= 24 && m.cards > 8 && !m.following, { ...m, file });
    }
    // 2) 流式：贴底的短回答会话追加长输出，仍跟随到底
    {
      const x = byKey('short');
      await open(x);
      fs.appendFileSync(x.file, j({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: x.sid, cwd,
        message: { id: 'm' + crypto.randomUUID(), role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: para('STREAM_MORE 追加输出', 30) }] } }) + '\n');
      await c.eval(`loadSessionHistoryToOverlay(${j(x.hubId)}, { incremental: true })`);
      await until(`document.getElementById('msg-overlay').innerText.includes('STREAM_MORE')`, 'stream appended', 20000);
      await sleep(600);
      const m = await measure(marker('short'));
      check('流式中（贴底）：新输出到达仍跟随到底', m.gap <= 3 && m.following, { ...m, file: await shot('stream-follow') });
    }
    // 2b) 流式：刚打开（1.5 秒稳定期内）就来了一大段输出，贴底的会话继续跟随，不被拉回提问处
    {
      const x = byKey('noanswer');
      await click(`.session-item[data-session-id="${x.hubId}"]`);
      await until(settled(x.hubId), 'cards noanswer quick');
      fs.appendFileSync(x.file, j({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: x.sid, cwd,
        message: { id: 'm' + crypto.randomUUID(), role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: para('STREAM_QUICK 刚打开就来的输出', 30) }] } }) + '\n');
      await c.eval(`loadSessionHistoryToOverlay(${j(x.hubId)}, { incremental: true })`);
      await until(`document.getElementById('msg-overlay').innerText.includes('STREAM_QUICK')`, 'quick stream appended', 20000);
      await sleep(1800);
      const m = await measure(marker('noanswer'));
      check('流式中（刚打开 1.5 秒内来长输出）：仍贴底跟随', m.gap <= 3 && m.following, { ...m, file: await shot('stream-quick') });
    }
    // 3) 流式：停在提问处（长回答）时追加输出，不拉走、显示回到最新
    {
      const x = byKey('long');
      await open(x);
      const before = await measure(marker('long'));
      fs.appendFileSync(x.file, j({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: x.sid, cwd,
        message: { id: 'm' + crypto.randomUUID(), role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: para('STREAM_LONG 追加', 10) }] } }) + '\n');
      await c.eval(`loadSessionHistoryToOverlay(${j(x.hubId)}, { incremental: true })`);
      await until(`document.getElementById('msg-overlay').innerText.includes('STREAM_LONG')`, 'stream long appended', 20000);
      await sleep(600);
      const m = await measure(marker('long'));
      check('流式中（在读回答开头）：新输出不把人拉走，显示「回到最新」', Math.abs(m.qTop - before.qTop) <= 4 && !m.following && m.jumpButton, { before: before.qTop, ...m, file: await shot('stream-reading') });
    }
    // 4) 手动上滑后切走再切回：保留自己的位置；另一会话重新定位
    {
      const L = byKey('long'), S = byKey('notice');
      await open(L);
      for (let i = 0; i < 4; i++) { await wheel(-500); await sleep(80); }
      await sleep(500);
      const manual = await measure(marker('long'));
      await open(S);
      const other = await measure(marker('notice'));
      await open(L);
      const back = await measure(marker('long'));
      check('切换往返：手动上滑的位置保留，不强行拉回', Math.abs(back.scrollTop - manual.scrollTop) <= 6 && !back.following, { manualTop: manual.scrollTop, backTop: back.scrollTop, file: await shot('roundtrip-manual') });
      check('切换往返：另一会话仍定位到最新提问', other.qTop >= 4 && other.qTop <= 24, other);
      // 点「回到最新」：到底并恢复跟随
      await click('#card-jump-latest');
      await sleep(500);
      const bottom = await measure(marker('long'));
      check('「回到最新」按钮：到底并恢复跟随', bottom.gap <= 3 && bottom.following, bottom);
    }
    // 5) 窗口变矮后打开：按新高度计算
    {
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      await open(byKey('notice'));
      await open(byKey('longq'));
      const m = await measure(marker('longq'));
      check('窗口变矮（1280×700）：超长提问仍只占上半屏', m.qBottom > m.clientHeight * 0.4 && m.qBottom <= m.clientHeight * 0.55, { ...m, file: await shot('resize-longq') });
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }
    // 6) 设置里关掉开关：打开会话照旧滚到底；再打开开关恢复
    {
      await c.eval(`openConfigModal()`);
      await until(`!document.getElementById('config-modal').classList.contains('hidden') && !!document.getElementById('cfg-card-open-at-question')`, 'config modal');
      await sleep(400);
      if (await c.eval(`!!document.getElementById('cfg-tab-display')`)) { await click('#cfg-tab-display'); await sleep(300); }
      await c.eval(`document.getElementById('cfg-card-open-at-question').scrollIntoView({block:'center'})`);
      const settingsShot = await shot('settings-switch');
      // 「一个 Tab 一屏」：量设置正文区溢出多少像素，新开关那一行在与不在各量一次。
      report.settingsOverflow = await c.eval(`(()=>{const v=document.getElementById('config-main-view')||document.querySelector('#config-modal .config-modal-body')||document.querySelector('#config-modal .config-modal');
        const row=document.getElementById('cfg-card-open-at-question').closest('.config-check-grid');const m=()=>v?v.scrollHeight-v.clientHeight:null;const withRow=m();row.style.display='none';const without=m();row.style.display='';return {withRow,without,view:v&&v.id};})()`);
      console.log('settingsOverflow', JSON.stringify(report.settingsOverflow));
      await click('#cfg-card-open-at-question');
      await click('#config-save');
      await until(`document.documentElement.dataset.cardOpenAt==='bottom'`, 'switch saved', 10000);
      await c.eval(`(document.getElementById('config-close')||document.querySelector('#config-modal .config-modal-close'))?.click(); closeConfigModal?.()`).catch(() => {});
      await sleep(300);
      await open(byKey('short'));
      await open(byKey('long'));
      const m = await measure(marker('long'));
      check('开关关闭：打开长回答会话直接滚到底', m.gap <= 3 && m.following, { ...m, settingsShot, file: await shot('switch-off-long') });
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
      check('开关写入 config.json', saved.ui?.card_open_at === 'bottom', { ui: saved.ui });
      await c.eval(`openConfigModal()`);
      await until(`!document.getElementById('config-modal').classList.contains('hidden')`, 'config modal 2');
      if (await c.eval(`!!document.getElementById('cfg-tab-display')`)) { await click('#cfg-tab-display'); await sleep(300); }
      await click('#cfg-card-open-at-question');
      await click('#config-save');
      await until(`document.documentElement.dataset.cardOpenAt==='question'`, 'switch back on', 10000);
      await c.eval(`closeConfigModal?.()`).catch(() => {});
    }
    // 7) 重启后恢复
    {
      await gracefulQuit(hub); hub = null;
      await launch(`open-latest-q-${tag}-restart`);
      await until(`typeof sessions!=="undefined" && !!document.querySelector('.session-item[data-session-id="${byKey('long').hubId}"]')`, 'rows after restart');
      await sleep(1500);
      report.afterRestartActive = await c.eval(`activeSessionId||null`);
      const restoredDataset = await c.eval(`document.documentElement.dataset.cardOpenAt||''`);
      await open(byKey('long'), { first: true });
      const m = await measure(marker('long'));
      check('重启后：开关保持开，打开长回答会话定位到最新提问', restoredDataset === 'question' && m.qTop >= 4 && m.qTop <= 24 && !m.following, { restoredDataset, ...m, file: await shot('restart-long') });
    }
  } catch (error) {
    report.error = String(error && error.stack || error);
    console.error(error);
    try { await shot('error'); } catch {}
  } finally {
    if (hub) await gracefulQuit(hub).catch(() => {});
    const f = path.join(outDir, `20261127-${tag}-report.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    console.log('report', f, 'failures', report.failures.length, report.error ? 'ERROR' : '');
    process.exitCode = report.failures.length || report.error ? 1 : 0;
  }
})();
