'use strict';
// 设置页「负责人组队自动批准」开关（2026-11-18）：全新数据目录默认勾选；取消勾选保存后
// config.json 写 team.autoApproveLeads=false，再打开仍是关；重新勾选写回 true。真实隔离 Electron、无头。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const outIndex = process.argv.indexOf('--out');
const ART = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(REPO, 'artifacts', `team-auto-approve-setting-${Date.now()}`));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'team-auto-approve-'));
const DATA = path.join(ROOT, 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
async function wait(fn, label, ms = 30000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(200); } throw Error(`Timeout ${label}${last ? ': ' + last.message : ''}`); }
const readTeam = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8').replace(/^﻿/, '')).team; } catch { return undefined; } };

async function run() {
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(ART, { recursive: true });
  let hub, cdp, failure;
  const ok = (label, condition = true) => { assert(condition, label); console.log('PASS ' + label); };
  try {
    hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), windowMode: 'hidden' });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await wait(() => cdp.eval("typeof openConfigModal==='function' && !!document.getElementById('cfg-team-auto-approve')"), 'renderer ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const open = async () => {
      await cdp.eval('openConfigModal()');
      await wait(() => cdp.eval("!document.getElementById('config-modal').classList.contains('hidden') && !document.getElementById('config-save').disabled"), 'config modal open');
    };
    const checked = () => cdp.eval("document.getElementById('cfg-team-auto-approve').checked");
    const save = async () => {
      await cdp.eval("document.getElementById('config-save').click()");
      await wait(() => cdp.eval("document.getElementById('config-modal').classList.contains('hidden') || getComputedStyle(document.getElementById('config-save-msg')).display!=='none'"), 'saved');
    };
    await open();
    ok('全新用户：开关默认勾选', await checked());
    const box = await cdp.eval("(()=>{const e=document.getElementById('cfg-team-auto-approve-field');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {w:r.width,h:r.height,text:e.innerText}})()");
    ok('开关可见且文案为「负责人组队自动批准」', box.w > 0 && box.h > 0 && box.text.includes('负责人组队自动批准'));
    await sleep(300);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(ART, '20261118-hubh-team-auto-approve-setting-1440.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('SHOT ' + shotPath);
    await cdp.eval("document.getElementById('cfg-team-auto-approve').click()");
    await save();
    ok('取消勾选并保存后写 team.autoApproveLeads=false', readTeam()?.autoApproveLeads === false);
    await open();
    ok('重新打开设置仍为关', (await checked()) === false);
    await cdp.eval("document.getElementById('cfg-team-auto-approve').click()");
    await save();
    ok('再勾选保存写回 true', readTeam()?.autoApproveLeads === true);
  } catch (error) { failure = error; }
  finally {
    try { cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(error => { console.warn('teardown: ' + error.message); });
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  }
  if (failure) throw failure;
  console.log('ALL PASS');
}
run().catch(error => { console.error(error); process.exit(1); });
