'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { connectCDP } = require('./cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const [browser, profile] = process.argv.slice(2);
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-component-update',
    '--remote-debugging-port=0', '--window-size=1400,1000', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  let client;
  const closed = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await connectCDP(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    reply({ ready: true });
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.close) break;
      try { reply({ value: await client.eval(request.expression) }); }
      catch (error) { reply({ error: error.message }); }
    }
  } finally {
    try { await client?.send('Browser.close', {}, { timeoutMs: 5000 }); } catch {}
    await client?.close();
    await Promise.race([closed, sleep(5000)]);
    if (child.exitCode === null) child.kill(); // Only the process this test launched.
    process.stdin.pause();
  }
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
