'use strict';
// Hidden real Hub + real skill picker; CodeAgent/auth are local protocol fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const pool = require('../core/codeagent-pool');
const bundled = require('../core/codeagent-bundled-skills');
const { writeProbed } = require('../core/codeagent-model-probe');
const repo = path.resolve(__dirname, '..');
const entry = process.env.HUB_TEAM_SKILL_ENTRY || repo;
const packaged = process.argv.includes('--packaged');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-team-skill-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'), personal = path.join(root, 'personal');
const art = process.env.HUB_E2E_ARTIFACT_DIR || path.join(repo, 'artifacts', packaged ? 'team-skill-packaged' : 'team-skill-source');
const model = 'GLM-5.2-WX-Auto', existingId = 'existing01', editedId = 'edited0001';
const file = configDir => path.join(configDir, 'skills', 'company-team', 'SKILL.md');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await fn()) return; await sleep(150); }
  throw Error('Timeout: ' + label);
}
function seed(dir, id) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: id, expiresAt: Date.now() + 3600000 } }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
  writeProbed(path.join(dir, 'hub-models.json'), { models: [model], defaultModel: model, source: 'test-fixture' });
}
async function run() {
  const evidence = { checks: [], root, entry, packaged, realModel: false, externalAccountLogin: false };
  const check = (label, condition = true) => { assert(condition, label); evidence.checks.push(label); };
  fs.mkdirSync(art, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, '.aiwork-root'), '');
  const existing = pool.accountDir(data, existingId), edited = pool.accountDir(data, editedId);
  const scan = path.join(root, 'imports'), importedSource = path.join(scan, '.cac-import');
  seed(personal, 'personal-fixture'); seed(existing, 'existing-fixture'); seed(edited, 'edited-fixture'); seed(importedSource, 'imported-fixture');
  fs.writeFileSync(path.join(pool.poolRoot(data), 'pool.json'), JSON.stringify({ accounts: [{ id: existingId }, { id: editedId }] }));
  bundled.syncCompanyTeamSkill(edited);
  fs.appendFileSync(file(edited), '\nLocal account custom text.\n');
  const editedBefore = fs.readFileSync(file(edited));
  check('startup fixture has no personal or existing-account team skill', !fs.existsSync(file(personal)) && !fs.existsSync(file(existing)));
  let hub, cdp;
  const invoke = (channel, args) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
  try {
    hub = await launchIsolatedHub({ entryPath: entry, cwd: entry, dataDir: data, port: await freePort(), windowMode: 'hidden',
      ...(packaged ? { executablePath: path.join(repo, 'dist/win-unpacked/AI Hub Community.exe') } : {}), extraEnv: {
      AI_HUB_WORKSPACE_ROOT: work, AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: scan,
      CODEAGENT_POOL_FAKE_LOG: path.join(root, 'fixture.jsonl'), CLAUDE_CONFIG_DIR: path.join(root, 'unused-cli'), CODEX_HOME: path.join(root, 'unused-provider'),
    } });
    evidence.pid = hub.pid;
    cdp = await connectFirstPage(hub, target => /index\.html/.test(target.url));
    await wait(() => cdp.eval('typeof selectSession === "function"'), 'renderer ready');
    if (packaged) check('the real packaged app is running from app.asar', await cdp.eval('/app\\.asar/.test(__dirname)'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shipped = fs.readFileSync(bundled.BUNDLE_FILE);
    check('Hub startup installs exact shipped bytes in personal and existing pool skills', fs.readFileSync(file(personal)).equals(shipped) && fs.readFileSync(file(existing)).equals(shipped));
    check('Hub startup preserves edited account skill', fs.readFileSync(file(edited)).equals(editedBefore));
    fs.appendFileSync(file(personal), '\nPersonal custom team instructions.\n');
    const personalCustom = fs.readFileSync(file(personal));
    const imported = await invoke('codeagent-pool:import', { dir: importedSource, note: '技能安装验收' });
    assert(imported.added, imported.error);
    check('new account imported through IPC immediately receives the personal custom skill', fs.readFileSync(file(pool.accountDir(data, imported.added))).equals(personalCustom));
    const click = async selector => {
      await wait(() => cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.hidden&&e.getBoundingClientRect().width>0})()`), selector);
      const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    };
    for (const [label, account] of [['personal', null], ['pool', imported.added], ['existing', existingId], ['edited', editedId]]) {
      const session = await invoke('create-session', { kind: 'codeagent', opts: { cwd: work, title: '组队技能验收-' + label,
        codeagentAccount: account ? 'pool' : 'personal', ...(account ? { codeagentPoolPick: account } : {}), model, codeagentModelPick: true } });
      assert(session?.id, JSON.stringify(session));
      check(label + ' session uses the expected skill content', fs.readFileSync(file(account ? pool.accountDir(data, account) : personal)).equals(account === editedId ? editedBefore : personalCustom));
      const inventory = await invoke('codeagent:skills', { sessionId: session.id });
      check(label + ' session inventory exposes company-team', inventory.ok && inventory.skills.some(skill => skill.name === 'company-team'));
      await cdp.eval(`selectSession(${JSON.stringify(session.id)})`);
      const bar = `.floating-input-bar[data-session-id="${session.id}"]`;
      await click(bar + ' .composer-skills');
      await wait(() => cdp.eval("[...document.querySelectorAll('.fi-skill-picker:not([hidden]) .fi-skill-option')].some(e=>e.textContent.startsWith('/company-team'))"), 'company-team choice');
      fs.writeFileSync(path.join(art, label + '-picker.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await click('.fi-skill-picker:not([hidden]) .fi-skill-option');
      check(label + ' real picker click inserts company-team', await cdp.eval(`!!document.querySelector(${JSON.stringify(bar + ' [data-codeagent-skill="company-team"]')})`));
      check(label + ' skill was installed before the session started', await cdp.eval(`document.querySelector(${JSON.stringify(bar + ' [data-codeagent-skill="company-team"]')}).dataset.late !== 'true'`));
    }
    check('pool launch still preserves the edited account', fs.readFileSync(file(edited)).equals(editedBefore));
    check('personal custom content remains unchanged', fs.readFileSync(file(personal)).equals(personalCustom));
    if (process.platform === 'win32') {
      const script = `$rows=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${Number(hub.pid)}); do { $added=$false; foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId)-and $ids.Add([int]$row.ProcessId)){$added=$true}} } while($added); $visible=@(foreach($processId in $ids){Get-Process -Id $processId -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -ExpandProperty Id}); [pscustomobject]@{ownProcessCount=$ids.Count;visibleCount=$visible.Count}|ConvertTo-Json -Compress`;
      evidence.windows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
      check('own process tree has no visible windows', evidence.windows.visibleCount === 0);
    }
    evidence.ok = true;
  } catch (error) { evidence.ok = false; evidence.error = error.stack; evidence.logTail = error.logTail; process.exitCode = 1; }
  finally {
    if (cdp) await cdp.close();
    if (hub) {
      fs.writeFileSync(path.join(art, 'hub.log'), hub.log().join('\n'));
      try { evidence.exit = await gracefulQuit(hub); }
      catch (error) { evidence.ok = false; evidence.quitError = error.message; process.exitCode = 1; }
      finally {
        // Release the driver's log readers after teardown. Inherited Windows
        // pipe handles can keep the driver alive after the Hub has exited.
        hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); hub.child.stdin?.destroy();
      }
    }
    fs.writeFileSync(path.join(art, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, art, error: evidence.error }));
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
