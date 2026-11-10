'use strict';
// Real Main creation, PTY submission, hooks, history rendering and Hub restart.
// The existing local CodeAgent protocol fixture replaces the model/remote CLI.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => {
  const port = s.address().port; s.close(() => resolve(port)); }); });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-lifecycle-gui-'));
  const dataDir = path.join(root, 'data'), configDir = path.join(root, 'account'), cwd = path.join(root, 'project');
  const control = path.join(root, 'control'), cliLog = path.join(root, 'fixture.jsonl');
  const wrapper = path.join(root, 'fixture.js'), command = path.join(root, 'fixture.cmd');
  // The shared fixture's interactive mode deliberately runs forever. Answer
  // discovery probes here so probe processes cannot outlive this test.
  fs.writeFileSync(wrapper, `if(process.argv.includes('--version')){console.log('CodeAgent local-fixture');}
else if(process.argv.includes('--help')){console.log('--resume <uuid> --model <model> --fork-session');}
else require(${JSON.stringify(path.resolve('tests/fixtures/codeagent-pool-fake/codeagent-fake.js'))});`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${wrapper}" %*\r\n`);
  const out = path.resolve('artifacts/prefix-lifecycle-gui');
  for (const dir of [cwd, configDir, control, out, path.join(dataDir, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID(), nativeId = randomUUID(), rows = [];
  const file = path.join(configDir, 'projects', require('../core/claude-prefix-fork').projectSlug(cwd), nativeId + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let parentUuid = null;
  for (let n = 0; n < 4; n++) {
    const user = 'msg_' + (n * 2 + 1).toString(16).padStart(48, '0');
    const answer = 'msg_' + (n * 2 + 2).toString(16).padStart(48, '0');
    rows.push({ type: 'user', uuid: user, parentUuid, sessionId: nativeId, cwd,
      timestamp: new Date(1700000000000 + n * 2000).toISOString(), message: { role: 'user', content: 'synthetic question ' + n } });
    rows.push({ type: 'assistant', uuid: answer, parentUuid: user, sessionId: nativeId, cwd,
      timestamp: new Date(1700000001000 + n * 2000).toISOString(), message: { role: 'assistant', id: answer,
        content: [{ type: 'text', text: 'synthetic answer ' + n }], stop_reason: 'end_turn' } }); parentUuid = answer;
  }
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const original = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const record = { schemaVersion: 1, hubId: id, title: 'PREFIX LIFECYCLE', kind: 'codeagent', cwd,
    ccSessionId: nativeId, transcriptPath: file, agentRuntime: 'pty', status: 'dormant',
    currentModel: { id: 'GLM-5.2-WX-Auto' }, createdAt: Date.now(), updatedAt: Date.now(), lastMessageTime: Date.now() };
  fs.writeFileSync(path.join(dataDir, 'sessions', id + '.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true, sessions: [record], meetings: [] }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ providers: { codeagent: { configDir } } }));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
    xAuthToken: 'local-fixture-only', accountId: 'prefix-fixture', expiresAt: Date.now() + 3600e3 } }));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(configDir, 'hub-models.json'), {
    models: ['GLM-5.2-WX-Auto'], defaultModel: 'GLM-5.2-WX-Auto', source: 'test-fixture' });
  const report = { providerNetworkTested: false, protocolFixture: true, checks: [] };
  let hub, c;
  const wait = async (fn, label) => {
    for (let n = 0; n < 200; n++) { const value = await fn(); if (value) return value; await pause(150); }
    throw Error('Timed out: ' + label);
  };
  const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
  const click = async selector => {
    await c.eval(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const point = await wait(() => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`), selector);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  };
  const start = async () => {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'prefix-lifecycle', extraEnv: {
      CLAUDE_HUB_E2E: '1',
      AI_HUB_WORKSPACE_ROOT: cwd, AI_HUB_CODEAGENT_CONFIG_DIR: configDir,
      AI_HUB_CODEAGENT_COMMAND: command,
      CODEAGENT_POOL_FAKE_LOG: cliLog, CODEAGENT_TEAM_FAKE_CONTROL_DIR: control,
      CLAUDE_HUB_CODEAGENT_STARTUP_PROBE: '0', AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'empty-scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    } });
    c = await connectFirstPage(hub);
    await wait(() => c.eval('document.readyState === "complete"'), 'renderer ready');
  };
  const select = async sid => click(`.session-item[data-session-id="${sid}"]`);
  const cardSelector = sid => `#msg-overlay .turn-card[data-session-id="${sid}"]`;
  const checkCards = async (sid, rounds) => {
    await wait(async () => {
      const count = await c.eval(`document.querySelectorAll(${JSON.stringify(cardSelector(sid))}).length`);
      if (count < rounds * 2 && await c.eval('!!document.querySelector("#msg-overlay .card-history-more")')) await click('#msg-overlay .card-history-more');
      return count === rounds * 2;
    }, `unique cards ${rounds} rounds`);
    const facts = await c.eval(`(()=>{const cards=[...document.querySelectorAll(${JSON.stringify(cardSelector(sid))})];return {ids:cards.map(e=>e.dataset.turnId),text:cards.map(e=>e.innerText).join(' | '),buttons:cards.flatMap(e=>[...e.querySelectorAll('[data-action="fork-before-turn"]')]).filter(b=>!b.hidden).length};})()`);
    assert.equal(new Set(facts.ids).size, rounds * 2); assert.doesNotMatch(facts.text, /分支前/); assert.equal(facts.buttons, rounds);
  };
  const branch = async (source, index, rounds) => {
    const before = new Set((await invoke('get-sessions')).map(s => s.id));
    await select(source);
    const selector = cardSelector(source) + ' [data-action="fork-before-turn"]';
    const turnId = await wait(() => c.eval(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>!e.hidden)[${index}];return b&&!b.disabled?b.closest('.turn-card').dataset.turnId:null;})()`), 'branch ready');
    // History refresh may replace the DOM between selection and pointer input.
    // Address the stable native turn instead of a marker on a disposable node.
    const bodyCard = cardSelector(source) + `[data-turn-id=${JSON.stringify(turnId)}]`;
    await click(bodyCard + ' .card-actions-more');
    await click(bodyCard + ' .card-actions-popover [data-action="fork-before-turn"]');
    const child = await wait(async () => (await invoke('get-sessions')).find(s => !before.has(s.id) && s.branchSourceSessionId === source), 'child created');
    await checkCards(child.id, rounds);
    assert.ok(child.codeagentPrefixFork); assert.notEqual(child.ccSessionId, nativeId);
    assert.equal(fs.readFileSync(child.transcriptPath, 'utf8').trim().split('\n').length, rounds * 2);
    await wait(() => fs.existsSync(path.join(control, child.id + '.ready')), 'fixture CLI ready');
    return child;
  };
  const send = async (child, text, rounds) => {
    const bar = `.floating-input-bar[data-session-id="${child.id}"]`;
    await click(bar + ' .floating-input-box'); await c.send('Input.insertText', { text }); await click(bar + ' .floating-input-send');
    await wait(() => fs.readFileSync(child.transcriptPath, 'utf8').includes(text), 'PTY received prompt');
    await checkCards(child.id, rounds);
    await pause(800); await checkCards(child.id, rounds);
  };
  try {
    await start(); await select(id); await checkCards(id, 4);
    const middle = await branch(id, 1, 2); await send(middle, 'lifecycle new middle', 3);
    report.checks.push('Middle branch owns two rounds and shows each once after a real PTY prompt submission');
    const nested = await branch(middle.id, 0, 1);
    assert.equal(middle.title, '分支1: PREFIX LIFECYCLE');
    assert.equal(nested.title, '分支1: 分支1: PREFIX LIFECYCLE');
    assert.equal(nested.codeagentPrefixFork.sourceNativeSessionId, middle.ccSessionId);
    report.checks.push('An original copied round can branch again using the child transcript as its source');
    const last = await branch(id, 3, 4); await send(last, 'lifecycle new final', 5);
    report.checks.push('Final-round branch owns the complete record and adds only one new round after sending');
    assert.deepEqual(fs.readFileSync(file), original); assert.equal(fs.statSync(file).mtimeMs, mtime);
    const launches = fs.readFileSync(cliLog, 'utf8').trim().split('\n').map(JSON.parse).filter(v => v.hubSession && v.args);
    assert.ok(launches.length >= 3);
    assert.ok(launches.some(v => v.hubSession === id && v.args.includes(nativeId)));
    assert.ok(launches.every(v => v.args.includes('--resume') && !v.args.includes('--fork-session')));
    c.close(); c = null; await gracefulQuit(hub); hub = null;
    await start();
    const savedNested = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions', nested.id + '.json'), 'utf8'));
    assert.equal(savedNested.title, nested.title);
    for (const [child, rounds] of [[middle, 3], [nested, 1], [last, 5]]) {
      await select(child.id); await checkCards(child.id, rounds);
      await wait(() => c.eval(`[...document.querySelectorAll(${JSON.stringify(cardSelector(child.id) + ' [data-action="fork-before-turn"]')})].every(b=>!b.disabled)`), 'restarted branch actions');
    }
    report.checks.push('After a full Hub restart, all three branches keep unique cards and branch actions');
    const nextNested = await branch(middle.id, 0, 1);
    assert.equal(nextNested.title, '分支2: 分支1: PREFIX LIFECYCLE');
    report.checks.push('Nested titles retain the full parent prefix and sibling numbering continues after Hub restart');
    const screenshot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'after-restart.png'), Buffer.from(screenshot.data, 'base64'));
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (c) c.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
