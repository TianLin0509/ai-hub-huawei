'use strict';
// Real isolated Electron, composer clicks and PTY stop; local CLI controls only
// the delayed provider records. No account credentials or model calls are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-stop-'));
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts'));
const WORK = path.join(ROOT, 'work'), CONFIG = path.join(ROOT, 'codeagent'), CONTROL = path.join(ROOT, 'control');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  for (const dir of [OUT, WORK, CONFIG, CONTROL]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(CONFIG, '.credentials.json'), j({ idaasOAuth: { xAuthToken: 'fixture-only', accountId: 'stop-fixture', expiresAt: Date.now() + 3600000 } }));
  fs.writeFileSync(path.join(CONFIG, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  require('../core/codeagent-model-probe').writeProbed(path.join(CONFIG, 'hub-models.json'), { models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  const evidence = { root: ROOT, checks: [], model: 'none; local CLI fixture and real UI/PTY stop' };
  const dropStop = process.argv.includes('--mutation-drop-stop');
  if (dropStop) evidence.mutation = 'replace the real stop IPC with a no-op receipt';
  let hub, c, failure;
  const wait = async (fn, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); } throw Error('timeout: ' + label); };
  const until = (expr, label, ms) => wait(() => c.eval(expr), label, ms);
  const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
  const click = async selector => {
    const p = await until(`(()=>{const e=document.querySelector(${j(selector)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  const enterPrompt = async text => {
    await click('.floating-input-box');
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.send('Input.insertText', { text }); await click('.floating-input-send');
  };
  const ok = label => { evidence.checks.push(label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(ROOT, 'data'), port: await port(), windowMode: 'hidden', label: 'team-stop', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.resolve(__dirname, 'fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: CONFIG,
      CODEAGENT_TEAM_FAKE_CONTROL_DIR: CONTROL, CODEAGENT_TEAM_STOP_FIXTURE: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CODEAGENT_POOL_FAKE_LOG: path.join(OUT, 'fixture-hooks.jsonl'),
      CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'),
    } });
    c = await connectFirstPage(hub);
    await until('typeof sessions!=="undefined" && typeof selectSession==="function"', 'renderer');
    if (dropStop) await c.eval(`(()=>{const original=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>channel==='codeagent:input-stop'?Promise.resolve({ok:true}):original(channel,...args)})()`);
    const created = await c.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'codeagent', opts: { cwd: WORK, mcpProfile: 'none', codeagentAccount: 'personal' } })})`);
    assert.ok(created.id, j(created)); const sid = created.id, q = j(sid); evidence.sid = sid;
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.ready`)), 'CLI ready');
    await c.eval(`selectSession(${q});applyViewMode('card')`);
    await shot('01-ready');
    await enterPrompt('STOP_FIXTURE_HOLD');
    const held = await wait(() => { const f = path.join(CONTROL, `${sid}.held`); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')); }, 'first prompt accepted');
    try { await until(`getSessionRuntimeTruth(sessions.get(${q})).state==='running'`, 'first turn running'); }
    catch (error) {
      evidence.runtime = await c.eval(`({session:sessions.get(${q}),truth:getSessionRuntimeTruth(sessions.get(${q})),screen:window.__hubE2E.terminalBufferText(${q})})`);
      throw error;
    }
    await until(`window.__hubE2E.terminalBufferText(${q}).includes('⠋ Running')`, 'live running footer');
    await click('.floating-input-stop.visible');
    await wait(() => { const f = path.join(CONTROL, `${sid}.escaped`); return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).count >= 2; }, 'stop reached CLI twice');
    await until(`document.querySelector('#msg-overlay .turn-card.user[data-stopped="true"]')?.innerText.includes('STOP_FIXTURE_HOLD')`, 'stopped card marked');
    ok('real Stop click sends ESC to the CLI and marks the original question stopped');
    await shot('02-stopped');
    await enterPrompt('STOP_FIXTURE_NEXT');
    await until(`document.querySelector('#msg-overlay')?.innerText.includes('STOP_FIXTURE_CURRENT_ANSWER')`, 'new answer rendered');
    const bound = await c.eval(`({path:sessions.get(${q}).transcriptPath})`);
    assert.ok(bound.path); evidence.transcriptPath = bound.path;
    const rows = fs.readFileSync(bound.path, 'utf8').trim().split('\n').map(JSON.parse);
    const current = rows.find(r => r.type === 'user' && r.message?.content === 'STOP_FIXTURE_NEXT'); assert.ok(current?.uuid);
    fs.writeFileSync(path.join(CONTROL, `${sid}.release-late`), 'release');
    await wait(() => fs.existsSync(path.join(CONTROL, `${sid}.late-written`)), 'late old answer written');
    // Exercise the production same-turn reader against the exact transcript the
    // real renderer and PTY hooks use; timestamps deliberately arrive out of order.
    const alignment = require('../core/claude-turn-alignment');
    const [oldAnswer, newAnswer] = await Promise.all([
      alignment.readClaudeTurn(bound.path, { userRecordId: held.uuid }),
      alignment.readClaudeTurn(bound.path, { userRecordId: current.uuid }),
    ]);
    assert.equal(oldAnswer.text, 'STOP_FIXTURE_OLD_LATE_ANSWER');
    assert.equal(newAnswer.text, 'STOP_FIXTURE_CURRENT_ANSWER');
    assert.notEqual(oldAnswer.userRecordId, newAnswer.userRecordId);
    evidence.turns = { old: oldAnswer, current: newAnswer };
    ok('the production same-turn reader keeps late old and current answers under distinct user UUIDs');
    await until(`document.querySelector('#msg-overlay')?.innerText.includes('STOP_FIXTURE_OLD_LATE_ANSWER')`, 'renderer consumed the late answer');
    const cards = await c.eval(`([...document.querySelectorAll('#msg-overlay .turn-card')].map(card=>({id:card.dataset.turnId,role:card.classList.contains('user')?'user':'assistant',text:card.innerText})))`);
    evidence.cards = cards;
    await shot('03-late-old-answer');
    const holdIndex = cards.findIndex(card=>card.role==='user' && card.text.includes('STOP_FIXTURE_HOLD'));
    const nextIndex = cards.findIndex(card=>card.role==='user' && card.text.includes('STOP_FIXTURE_NEXT'));
    const oldIndex = cards.findIndex(card=>card.role==='assistant' && card.text.includes('STOP_FIXTURE_OLD_LATE_ANSWER'));
    const currentIndex = cards.findIndex(card=>card.role==='assistant' && card.text.includes('STOP_FIXTURE_CURRENT_ANSWER'));
    assert.ok(holdIndex>=0 && nextIndex>holdIndex, 'both original questions are rendered in order');
    assert.ok(oldIndex>holdIndex && oldIndex<nextIndex, 'late old answer must remain beneath its original stopped question');
    assert.ok(currentIndex>nextIndex && currentIndex!==oldIndex, 'current answer has a separate card under the current question');
    assert.ok(!cards[currentIndex].text.includes('STOP_FIXTURE_OLD_LATE_ANSWER'), 'old output cannot be appended as the newest current answer');
    ok('real cards keep the late old reply under the stopped question and the current reply under the new question');
    evidence.uiChecksPassed = true;
  } catch (error) {
    failure = error; evidence.error = error.stack;
    if (c) await shot('failure').catch(e => { evidence.screenshotError = String(e); });
  } finally {
    try { if (c) await c.close(); } catch (e) { failure ||= e; evidence.cdpCloseError = String(e); }
    try { if (hub) evidence.exit = await gracefulQuit(hub); } catch (e) { failure ||= e; evidence.quitError = String(e); }
    if (hub) { fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log().join('\n')); hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); hub.child.stdin?.destroy(); }
    evidence.ok = evidence.uiChecksPassed === true && !failure;
    fs.writeFileSync(path.join(OUT, '20261105-team-stop-evidence-s3.json'), j(evidence));
  }
  if (failure) throw failure;
  console.log('PASS stop and late answer: ' + evidence.checks.length + ' checks; ' + OUT);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
