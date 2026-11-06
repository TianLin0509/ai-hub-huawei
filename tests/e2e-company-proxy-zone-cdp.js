'use strict';
// Company model proxy, zone and first-time signer initialization on the real Settings path, in an isolated Hub
// (hidden window, own data dir and CDP port). The proxy runs the real upstream path (no mock) against a synthetic
// CodeAgent install and adapter package (tests/helpers/company-proxy-fake-adapter.js):
//   Settings -> own API -> Claude Code -> company model -> save
//   -> nothing names the zone: the dialog says it was not recognised and asks to choose (proxy not ready)
//   -> pick 绿区 in 所在区域 -> proxy restarts, first-time signer init runs once (hidden CLI) -> running,
//      the dialog says "用的是绿区（你在这里选的）" and that the first-time initialization finished.
//   node tests/e2e-company-proxy-zone-cdp.js   (artifacts: HUB_E2E_ARTIFACT_DIR or artifacts/company-proxy-zone)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { buildFakeCodeAgent, cliRuns } = require('./helpers/company-proxy-fake-adapter');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/company-proxy-zone');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const report = { ok: false, checks: [], screenshots: [] };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  if (process.platform !== 'win32') { console.log(JSON.stringify({ ok: true, skipped: 'windows only' })); return; }
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-zone-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), temp = path.join(root, 'temp');
  for (const dir of [home, data, temp, path.join(home, '.cac'), path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  const fake = buildFakeCodeAgent(root);
  fs.mkdirSync(path.join(data, 'company-model-proxy'), { recursive: true });
  fs.writeFileSync(path.join(data, 'company-model-proxy', 'upstream.json'), JSON.stringify({ adapterPackage: fake.adapter, codeagentDir: fake.codeagentDir,
    codeagentVersion: '9.1.2', signerCacheEnv: 'FAKE_AUTH_DIR', reuseSignerCaches: false }, null, 2));
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0', AI_HUB_COMPANY_PROXY_MOCK: '0',
    FAKE_CLI_REPORT: fake.cliReport, CODEAGENT3_CONFIG_DIR: path.join(home, '.cac'),
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(250);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = `${stamp}-proxy-zone-${name}-claude.png`;
    fs.writeFileSync(path.join(out, file), Buffer.from(image.data, 'base64'));
    report.screenshots.push(path.join(out, file));
  }
  const dialogText = 'document.getElementById("company-api-dialog")?.innerText || ""';
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'company-proxy-zone', windowMode: 'hidden', extraEnv: env });
    for (const end = Date.now() + 30000; !cdp;) {
      try { cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url)); }
      catch (error) { if (Date.now() > end) throw error; await sleep(500); }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__companyApiOpen && !!window.WorkspaceController', 'renderer ready');
    await click('#btn-options'); await click('#options-settings');
    await until('!document.getElementById("config-modal").classList.contains("hidden")', 'settings');
    await click('#company-api-settings-open');
    await until('!!document.querySelector("#company-api-dialog [data-api-mode]")', 'API dialog');
    await click('[data-api-kind="claude"]');
    await click('[data-api-mode="proxy"]');
    await until('!!document.querySelector("#company-api-dialog [data-proxy-form]")', 'proxy form');
    await click('#company-api-dialog [type="submit"]');
    await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.startsWith("已保存")', 'save');
    // 1. Not recognised: plain words, a dropdown, proxy not ready.
    await until('document.querySelector("#company-api-dialog [data-zone-state]")?.dataset.zoneState === "unknown"', 'zone unknown shown', 40000);
    check('识别不出区域：弹窗写明没识别出来并请用户选择', await cdp.eval(`${dialogText}.includes("还没识别出你所在的区域（蓝区 / 绿区 / 黄区），请在下面选择")`));
    check('识别不出区域：反代显示「公司上游未就绪」，不默默用某个区', await cdp.eval('document.querySelector("#company-api-dialog [data-proxy-state]")?.dataset.proxyState === "not-ready"'));
    check('区域下拉有自动识别 / 蓝区 / 绿区 / 黄区', await cdp.eval(`[...document.querySelectorAll('#company-api-dialog [name=zone] option')].map(o=>o.textContent).join('|')==='自动识别（读 CodeAgent 的配置）|蓝区|绿区|黄区'`));
    check('识别不出区域时还没跑过 CodeAgent 命令行', cliRuns(fake.cliReport).length === 0);
    await shot('unknown-1440');
    // 2. Pick green in the dropdown.
    await cdp.eval(`(()=>{const s=document.querySelector('#company-api-dialog [name=zone]');s.value='green';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.querySelector("#company-api-dialog [role=status]")?.textContent.startsWith("区域已保存")', 'zone saved', 30000);
    await until(`document.querySelector("#company-api-dialog [data-proxy-state]")?.dataset.proxyState === "running" && ${dialogText}.includes("用的是绿区（你在这里选的）")`, 'running with green', 60000);
    check('选了绿区：弹窗写明「用的是绿区（你在这里选的）」', true);
    check('选了绿区：反代运行中', await cdp.eval(`${dialogText}.includes("反代运行中")`));
    await until(`${dialogText}.includes("首次签名初始化已完成")`, 'first init note', 20000);
    check('弹窗写明首次签名初始化已完成及用时', await cdp.eval(`/首次签名初始化已完成（用时约 \\d+ 秒）/.test(${dialogText})`));
    check('下拉框停在「绿区」', await cdp.eval('document.querySelector("#company-api-dialog [name=zone]").value === "green"'));
    const upstream = JSON.parse(fs.readFileSync(path.join(data, 'company-model-proxy', 'upstream.json'), 'utf8'));
    check('选择写进 upstream.json（zone=green，zoneChosenBy=settings），其他配置保留', upstream.zone === 'green' && upstream.zoneChosenBy === 'settings' && upstream.adapterPackage === fake.adapter);
    const runs = cliRuns(fake.cliReport);
    report.cliRuns = runs;
    check('首次初始化：CodeAgent 命令行只跑了 1 次', runs.length === 1);
    check('首次初始化：命令行没有可见窗口', /consoleWindow=0 visible=0/.test(runs[0] || ''));
    check('签名缓存写进 Hub 数据目录', fs.existsSync(path.join(data, 'company-model-proxy', 'signer-cache', 'codeagent-version-stamp')));
    await shot('green-1440');
    report.uiChecksPassed = true;
  } catch (error) {
    report.error = error.stack;
    if (cdp) await shot('failure').catch(() => {});
    throw error;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    if (hub) {
      fs.writeFileSync(path.join(out, `${stamp}-proxy-zone-hub-claude.log`), hub.log().join('\n'));
      try { report.exit = await gracefulQuit(hub); } catch (error) { report.teardownError = error.stack; }
      finally { hub.child.stdout?.destroy(); hub.child.stderr?.destroy(); }
      try { fs.copyFileSync(path.join(data, 'diagnostics', 'company-model-proxy.log'), path.join(out, `${stamp}-proxy-zone-process-claude.log`)); } catch { /* not started */ }
    }
    report.ok = !!report.uiChecksPassed && report.exit?.exitCode === 0 && !report.exit.forced && !report.teardownError;
    fs.writeFileSync(path.join(out, `${stamp}-proxy-zone-e2e-result-claude.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, screenshots: report.screenshots.length, exit: report.exit, error: (report.error || report.teardownError || '').split('\n')[0] }));
    if (!report.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
