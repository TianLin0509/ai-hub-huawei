'use strict';
// Isolated Hub + fixture CLIs. No API request or real account is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-api-profiles-e2e-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(bin, 'fixture.ps1'), `param([string]$Kind,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if($Rest -contains '--version'){Write-Output '1.0.0';exit}
$model='';for($i=0;$i -lt $Rest.Count-1;$i++){if($Rest[$i] -eq '--model'){$model=$Rest[$i+1]}}
$record=@{kind=$Kind;model=$model;home=$env:CODEX_HOME;claudeHome=$env:CLAUDE_CONFIG_DIR;endpoint=$env:ANTHROPIC_BASE_URL;keyOne=($env:ANTHROPIC_AUTH_TOKEN -eq 'fixture-one');keyTwo=($env:ANTHROPIC_AUTH_TOKEN -eq 'fixture-two')}
[IO.File]::AppendAllText((Join-Path $env:HUB_API_PROFILE_TRACES ($Kind+'.jsonl')),(($record|ConvertTo-Json -Compress)+[Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
Write-Host 'Fixture ready';while($null -ne [Console]::In.ReadLine()){}
`);
  for (const kind of ['codex', 'claude']) fs.writeFileSync(path.join(bin, kind + '.cmd'),
    `@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0fixture.ps1" -Kind ${kind} %*\r\n`);
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const report = { ok: false, root, checks: [], providerNetworkTested: false };
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(100); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('hidden control');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  }
  async function key(key, code, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', {
      type, key, code, modifiers, windowsVirtualKeyCode: { a: 65, End: 35, Enter: 13 }[key] });
  }
  async function input(name, text) {
    await click('#company-api-dialog [name="' + name + '"]');
    await key('a', 'KeyA', 2); await cdp.send('Input.insertText', { text });
  }
  try {
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'api-profiles', extraEnv: {
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0',
      PATH: [bin, system, path.join(system, 'WindowsPowerShell/v1.0')].join(';'), HUB_API_PROFILE_TRACES: root,
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: '', ANTHROPIC_BASE_URL: '',
      OPENAI_API_KEY: '', HUB_CODEX_API_KEY: '', HUB_CLAUDE_API_KEY: '',
    } });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'ready');
    for (const kind of ['codex', 'claude']) {
      await cdp.eval(`window.__companyApiOpen(${JSON.stringify(kind)})`);
      await until('!!document.querySelector("[data-api-profile]")', 'profile form');
      for (const label of ['one', 'two']) {
        await click('[data-api-profile]'); await key('End', 'End'); await key('Enter', 'Enter');
        await until('!!document.querySelector("[name=label]")', 'new profile');
        await input('label', label);
        await input('baseURL', 'https://' + label + '.example.test/v1');
        await input('apiKey', 'fixture-' + label); await input('model', 'Internal/' + label);
        await click('#company-api-dialog [type=submit]');
        await until('document.querySelector("form [role=status]")?.textContent.startsWith("已保存")', 'saved');
        check(kind + ' key cleared ' + label, await cdp.eval('document.querySelector("[name=apiKey]").value === ""'));
      }
      const options = await cdp.eval('require("electron").ipcRenderer.invoke("company-api:get")');
      const profiles = options.providers[kind].apiProfiles;
      check(kind + ' two redacted profiles', profiles.length === 2 && !JSON.stringify(profiles).includes('fixture-'));
      check(kind + ' form fits viewport', await cdp.eval('(()=>{const e=document.querySelector("#company-api-dialog"),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1})()'));
      await click('.company-api-close');
      for (const profile of profiles) {
        await click('#btn-new'); await click('.new-session-option[data-kind="' + kind + '"]');
        await until(`!!document.querySelector('[data-model-card="api:${profile.id}"]')`, 'account card');
        await click('[data-model-card="api:' + profile.id + '"]');
        await click('#new-session-submit');
        const traceFile = path.join(root, kind + '.jsonl');
        const deadline = Date.now() + 30000;
        let trace;
        while (Date.now() < deadline) {
          if (fs.existsSync(traceFile)) trace = fs.readFileSync(traceFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).find(row => row.model === profile.model);
          if (trace) break; await sleep(100);
        }
        check(kind + ' launched ' + profile.label, !!trace);
        const catalog = await cdp.eval(`(async()=>{const ipc=require('electron').ipcRenderer;const sessions=await ipc.invoke('get-sessions');const s=sessions.find(item=>item.kind===${JSON.stringify(kind)}&&item.cliApiProfileId===${JSON.stringify(profile.id)});if(!s)throw Error('missing profile metadata');return ipc.invoke('session:local-models',{sessionId:s.id})})()`);
        check(kind + ' own session catalog ' + profile.label, catalog.ok && catalog.models[0].id === profile.model);
        if (kind === 'claude') {
          check('Claude endpoint ' + profile.label, trace.endpoint === profile.baseURL && trace[profile.label === 'one' ? 'keyOne' : 'keyTwo']);
          check('Claude isolated home ' + profile.label, trace.claudeHome.includes(profile.id));
        } else {
          check('Codex isolated home ' + profile.label, trace.home.includes(profile.id));
          const config = fs.readFileSync(path.join(trace.home, 'config.toml'), 'utf8');
          check('Codex endpoint ' + profile.label, config.includes(profile.baseURL));
          check('Codex key ' + profile.label, JSON.parse(fs.readFileSync(path.join(trace.home, 'auth.json'))).OPENAI_API_KEY === 'fixture-' + profile.label);
        }
      }
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(root, 'hub.log'), hub.log().join('\n'));
      const exit = await gracefulQuit(hub); report.exit = exit;
      hub.child.stdout?.destroy(); hub.child.stderr?.destroy();
      report.ok = report.ok && exit.exitCode === 0 && !exit.forced;
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
