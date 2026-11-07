'use strict';
// Manual live acceptance (real Claude Code, Haiku, logged-in subscription copied into a private config dir):
//   node tests/e2e-ask-aside-claude-live-cdp.js
// Isolated background Hub → Claude Code PTY session → mouse: send a codeword, open 问一下, ask it back.
// Checks the answer, the engine, that the main transcript did not grow, and that no forked record was left behind.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ask-claude-'));
  const data = path.join(root, 'data'), work = path.join(root, 'work'), task = path.join(work, '20261107-ask-claude'), cfg = path.join(root, 'claude');
  const out = path.resolve(__dirname, '../output/ask-aside-claude-' + Date.now());
  for (const dir of [data, task, cfg, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const src = process.env.HUB_ASK_CLAUDE_SOURCE_DIR || path.join(os.homedir(), '.claude');
  fs.copyFileSync(path.join(src, '.credentials.json'), path.join(cfg, '.credentials.json'));
  const fwd = p => p.split(path.sep).join('/');
  fs.writeFileSync(path.join(cfg, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', projects: { [task]: { hasTrustDialogAccepted: true }, [fwd(task)]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), j({ skipDangerousModePermissionPrompt: true }));
  const codeword = '红杉-' + crypto.randomBytes(2).toString('hex');
  const report = { passed: false, checks: [], out, codeword };
  let hub, c, sid;
  const wait = async (expr, label, ms = 120000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { try { if (await c.eval(expr)) return; } catch { /* loading */ } await sleep(200); }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const pos = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled||e.hidden)throw Error('not clickable '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...pos, button: 'left', clickCount: 1 });
  };
  const snap = async name => fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'ask-claude-live', extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, CLAUDE_CONFIG_DIR: cfg, CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' } });
    c = await connectFirstPage(hub);
    await wait('typeof selectSession === "function" && !!window.__askAsideUi', 'renderer ready');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: { cwd: task, title: '问一下 Claude 验收', model: 'haiku', mcpProfile: 'none', effort: 'low' } })})`);
    sid = created.id; assert.ok(sid, j(created));
    await c.eval(`selectSession(${j(sid)})`);
    await wait(`(()=>{const b=document.querySelector('#terminal-panel .floating-input-box');return b&&b.offsetParent!==null})()`, 'session visible');
    await click('#terminal-panel .floating-input-box');
    await c.send('Input.insertText', { text: `请记住暗号：${codeword}。只回复 OK。` });
    await click('#terminal-panel .floating-input-send');
    await wait(`(()=>{const s=sessions.get(${j(sid)});return s&&/^[0-9a-f-]{36}$/.test(s.ccSessionId||'')})()`, 'native session bound');
    await wait(`(document.querySelector('#msg-overlay')?.innerText||'').includes('OK')`, 'first answer', 180000);
    await wait('!!document.querySelector(".ask-entry") && !document.querySelector(".ask-entry").hidden', '问一下 button visible');
    const projects = path.join(cfg, 'projects');
    const ccSid = await c.eval(`sessions.get(${j(sid)}).ccSessionId`);
    const findJsonl = () => { for (const d of fs.existsSync(projects) ? fs.readdirSync(projects) : []) { const f = path.join(projects, d, ccSid + '.jsonl'); if (fs.existsSync(f)) return f; } return null; };
    for (let i = 0; i < 50 && !findJsonl(); i++) await sleep(200);
    const jsonl = findJsonl(); assert.ok(jsonl, 'main transcript file');
    await sleep(1500);
    const before = fs.statSync(jsonl).size, siblings = fs.readdirSync(path.dirname(jsonl)).filter(n => n.endsWith('.jsonl')).length;
    await click('.ask-entry');
    await wait('!document.querySelector(".ask").hidden', 'drawer open');
    await wait('!document.querySelector(".ask .btn-pri").disabled || document.querySelector(".ask textarea")', 'composer');
    await click('.ask textarea');
    await c.send('Input.insertText', { text: '刚才的暗号是什么？只回暗号。' });
    const started = Date.now();
    await click('.ask .btn-pri');
    await wait('!!document.querySelector(".ask .ask-qa[data-status=done], .ask .ask-qa[data-status=error]")', 'answer', 180000);
    const status = await c.eval('document.querySelector(".ask .ask-qa").dataset.status');
    const text = await c.eval('document.querySelector(".ask").innerText');
    await snap('01-claude-answer');
    assert.equal(status, 'done', text.slice(-400));
    assert.ok(text.includes(codeword), text.slice(-400));
    report.checks.push(`Claude Code 会话点「问一下」${((Date.now() - started) / 1000).toFixed(1)} 秒答出暗号`);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'ask-aside', sid + '.json'), 'utf8'));
    assert.equal(saved.items[0].engine, 'claude');
    await sleep(1500);
    // 主会话终端还开着，Claude Code 自己会往记录尾部补元数据行；只要求旁问的问答没有写进去。
    const appended = fs.readFileSync(jsonl).subarray(before).toString('utf8');
    report.appendedTypes = appended.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line).type; } catch { return '?'; } });
    assert.ok(!appended.includes('刚才的暗号是什么') && !appended.includes('旁听提问'), 'side question leaked into the main transcript');
    assert.equal(fs.readdirSync(path.dirname(jsonl)).filter(n => n.endsWith('.jsonl')).length, siblings, 'a forked record was left behind');
    report.checks.push('主会话记录里没有旁问的问答，也没有留下分叉记录（终端自己补的行：' + report.appendedTypes.join(',') + '）');
    report.passed = true;
    console.log('PASS e2e-ask-aside-claude-live-cdp ' + out + '\n' + report.checks.join('\n'));
  } catch (error) {
    report.error = error.stack;
    try { if (c) { await snap('failure'); report.ui = await c.eval('document.body.innerText.slice(-5000)'); } } catch {}
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), j(report, null, 2), 'utf8');
    if (c) c.close();
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
