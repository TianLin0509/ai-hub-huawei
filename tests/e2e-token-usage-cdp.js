'use strict';
// 账号页「账号 / Token 开销」切换：全新数据目录、隔离 Hub、真实点击；统计线程在 Electron 里真实跑。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const write = (file, line) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(line) + '\n'); };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihubh-token-e2e-')), data = path.join(root, 'data'), home = path.join(root, 'home');
  const out = process.env.TOKEN_E2E_OUT || path.join(root, 'shots'); fs.mkdirSync(out, { recursive: true });
  const timestamp = new Date(Date.now() - 60000).toISOString();
  const msg = (id, model, cached) => ({ type: 'assistant', timestamp, message: { id, model, usage: { input_tokens: 10, cache_read_input_tokens: cached, cache_creation_input_tokens: 1e6, output_tokens: 2e6 } } });
  write(path.join(home, '.cac', 'projects', 'p', 'a.jsonl'), msg('m1', 'GLM-5.2', 5e8));
  write(path.join(data, 'codeagent-pool', 'accounts', 'p1', 'projects', 'p', 'b.jsonl'), msg('m2', 'GLM-5.2', 1e8));
  write(path.join(home, '.claude', 'projects', 'p', 'c.jsonl'), msg('m3', 'internal', 1e7));
  let hub, cdp;
  const until = async (expr, label, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { if (await cdp.eval('Boolean(' + expr + ')')) return; } throw Error('超时：' + label); };
  const click = async selector => {
    await until('!!document.querySelector(' + JSON.stringify(selector) + ')', selector);
    const box = await cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    await sleep(120);
  };
  const snap = async name => { const v = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(v.data, 'base64')); };
  const text = () => cdp.eval('document.querySelector(".caa-main").innerText');
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), entryPath: path.resolve(__dirname, '..'), cwd: path.resolve(__dirname, '..'), windowMode: 'hidden', label: 'aihubh-token', extraEnv: { CLAUDE_HUB_HOME_DIR: home, AI_HUB_WORKSPACE_ROOT: root, AI_HUB_CODEAGENT_COMMAND: path.resolve(__dirname, 'fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(home, '.cac') } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('document.getElementById("btn-rail-accounts")', '界面初始化');
    await cdp.eval('document.getElementById("btn-rail-accounts").click()');
    await until('document.querySelector("#codeagent-accounts-page:not([hidden]) .caa-view-tabs")', '账号页 tab');
    assert.equal(await cdp.eval('document.querySelector(".caa-view-tabs [aria-selected=true]").dataset.view'), 'accounts', '默认仍是原账号页');
    await until('document.querySelector(".caa-list")', '原账号列表');
    await snap('01-accounts');
    await click('[data-ca="view"][data-view="token"]');
    await until('document.querySelector(".atk-stats")', '首次打开自动统计完成', 60000);
    let page = await text();
    assert.match(page, /CodeAgent/); assert.match(page, /我的账号/); assert.match(page, /已移出号池的账号/); assert.match(page, /GLM-5\.2/); assert.match(page, /Claude/);
    assert.equal(await cdp.eval('document.querySelector(".caa-main").scrollWidth-document.querySelector(".caa-main").clientWidth<=0'), true, '不横向溢出');
    await snap('02-token');
    await click('[data-ca="token-metric"][data-v="net"]');
    await until('document.querySelector("[data-ca=token-metric][data-v=net]").getAttribute("aria-pressed")==="true"', '切口径');
    assert.notEqual(await text(), page, '切换口径后数字要变');
    await snap('03-token-net');
    await click('[data-ca="token-sync"]');
    await until('!document.querySelector("[data-ca=token-sync]").disabled && document.querySelector(".atk-sync span").innerText.includes("已统计")', '手动统计', 60000);
    await click('[data-ca="view"][data-view="accounts"]');
    await until('document.querySelector(".caa-list") && !document.querySelector(".atk-stats")', '切回账号');
    console.log('PASS');
  } finally {
    if (cdp) await cdp.close?.();
    if (hub) await gracefulQuit(hub);
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
