'use strict';
// R42「版本与回退」隔离截图自查：后台隐藏窗口起隔离 Hub，1440 宽下打开设置菜单 →「🕘 版本与回退」，
// 跑在模拟内源（tests/helpers/openx-release-mock.js）上算出，再注入界面的 app-update:list-versions；不下载、不碰外网。
//   node tests/e2e-r42-version-rollback-cdp.js <截图目录>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { createOpenxReleaseMock } = require('./helpers/openx-release-mock');

// 截图里的「当前版本」用这个 Hub 的真实版本号，内源上再多一个更新的版本。
const CURRENT = require('../package.json').version;
// 内源上比本机新一版（末位 +1），测「比当前新的版本不显示回退」。
const NEWER = CURRENT.replace(/(\d+)$/, n => String(Number(n) + 1));
const RT = { electron: process.versions.electron || '41.2.0', native: {} };

async function mockedLists() {
  const manifestLib = require('../core/app-update/manifest.js');
  manifestLib.currentRuntime = () => RT;
  const { createAppUpdateController } = require('../main/app-update-controller.js');
  const notes = v => [`v${v}：会议页右栏分成两个页签，提问卡写清排队与进度`, `v${v}：修复长会议卡顿`, `v${v}：DSH 上下文按模型目录的输入上限`];
  const releases = [NEWER, CURRENT, '5.6.106', '5.6.105', '5.6.104', '5.6.103', '5.6.102', '5.6.101', '5.6.100', '5.6.99']
    .map(v => ({ version: v, runtime: RT, notes: notes(v) }));
  releases[releases.length - 2].sig = 'none';
  releases[releases.length - 1].sig = 'none';
  const net = createOpenxReleaseMock({ payload: crypto.randomBytes(15 * 1024), releases });
  const mk = (fetchImpl, dataDir) => createAppUpdateController({ app: {}, config: {}, dataDir, currentVersion: CURRENT, fetchImpl,
    manifestPublicKey: net.keys.pub, env: { AI_HUB_OPENX: '1' }, isPackaged: false, logger: { warn() {}, info() {} } });
  const ok = await mk(net.fetchImpl, fs.mkdtempSync(path.join(os.tmpdir(), 'r42-shot-a-'))).listVersions();
  // 真实包大小按 15 MB 显示
  for (const i of ok.items) i.bytes = 15.4 * 1048576;
  require('../core/app-update/openx-source')._reset();
  const down = createOpenxReleaseMock({ payload: Buffer.alloc(2048), releases, down: true });
  const bad = await mk(down.fetchImpl, fs.mkdtempSync(path.join(os.tmpdir(), 'r42-shot-b-'))).listVersions();
  return { ok, bad };
}

(async () => {
  const out = process.argv[2] || path.join(os.tmpdir(), 'r42-shots');
  fs.mkdirSync(out, { recursive: true });
  const lists = await mockedLists();
  assert.equal(lists.ok.ok, true, lists.ok.error);
  assert.equal(lists.bad.ok, false);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r42-'));
  const hub = await launchIsolatedHub({ dataDir, port: 9600 + Math.floor(Math.random() * 300), windowMode: 'hidden', label: 'r42-version-rollback' });
  let page;
  const results = {};
  try {
    page = await connectFirstPage(hub, null, { waitMainMs: 30000 });
    const click = async selector => {
      const point = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('找不到 ${selector.replace(/'/g, '')}');
        el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const shot = async name => {
      const s = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, `20261125-r42-${name}.png`);
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      return file;
    };
    const measure = () => page.eval(`(() => { const d = document.querySelector('.vp-dialog'); const r = d.getBoundingClientRect();
      const inner = [...d.querySelectorAll('.vp-list,.vp-detail,.vp-body,.vp-wrap')].map(e => ({ cls: e.className, over: e.scrollHeight - e.clientHeight }));
      return { dialogH: Math.round(r.height), viewportH: innerHeight, dialogOverflow: d.scrollHeight - d.clientHeight, inner,
        pageOverflow: document.documentElement.scrollHeight - innerHeight }; })()`);
    await page.eval(`new Promise(resolve => { const wait = () => document.getElementById('options-versions') ? resolve(true) : setTimeout(wait, 100); wait(); })`);
    await page.eval(`(() => { const ipc = require('electron').ipcRenderer; const invoke = ipc.invoke.bind(ipc);
      window.__r42 = { list: ${JSON.stringify(lists.ok)} };
      ipc.invoke = (ch, ...a) => ch === 'app-update:list-versions' ? Promise.resolve(window.__r42.list)
        : ch === 'app-update:get-state' ? Promise.resolve({ phase: 'none', current: ${JSON.stringify(CURRENT)}, pinned: null }) : invoke(ch, ...a);
      ipc.emit('app-update:state', {}, { phase: 'none', current: ${JSON.stringify(CURRENT)}, pinned: null }); })()`);
    for (const [w, h] of [[1440, 900], [1440, 800]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await click('#btn-options');
      await sleep(250);
      if (w === 1440 && h === 900) results.menuShot = await shot('settings-menu');
      await click('#options-versions');
      await sleep(600);
      results[`list-${h}`] = { shot: await shot(`list-${w}x${h}`), ...(await measure()) };
      if (h === 900) {
        results.defaultPick = await page.eval(`document.querySelector('[data-vp="ask"]').textContent`);
        await click(`[data-vp="pick"][data-v="${NEWER}"]`);
        await sleep(150);
        results.newerPick = await page.eval(`(() => { const b = document.querySelector('[data-vp="ask"]'); return { text: b.textContent, disabled: b.disabled }; })()`);
        await click(`[data-vp="pick"][data-v="${CURRENT === '5.6.104' ? '5.6.103' : '5.6.104'}"]`);
        await sleep(150);
        await click('[data-vp="ask"]');
        await sleep(300);
        results.confirm = { shot: await shot('confirm-1440x900'), text: await page.eval(`document.querySelector('.vp-confirm').textContent`), ...(await measure()) };
        await click('[data-vp="no"]');
        await sleep(150);
        // 选一个 v5.6.105–107：确认框说明它会自动升回
        await click('[data-vp="pick"][data-v="5.6.106"]');
        await sleep(150);
        await click('[data-vp="ask"]');
        await sleep(250);
        results.confirm106 = { shot: await shot('confirm-v5.6.106-1440x900'), text: await page.eval(`document.querySelector('.vp-confirm').textContent`) };
        await click('[data-vp="no"]');
        // 回退包已下好、待重启（主进程推来的状态）：底部有「取消回退」和「立即重启回退」，顶部不出现「新版本已就绪」
        await page.eval(`require('electron').ipcRenderer.emit('app-update:state', {}, { phase: 'ready', current: ${JSON.stringify(CURRENT)},
          pinned: { version: '5.6.106', pending: true, channel: 'openx' }, rollback: { version: '5.6.106' },
          latest: { version: '5.6.106', rollback: true, notes: [] }, plan: { kind: 'incremental', variant: 'complete', downgrade: true, bytes: 16148070, file: 'AIHubHuawei-5.6.106-update.gz' } })`);
        await sleep(300);
        results.ready = { shot: await shot('rollback-ready-1440x900'), ...(await measure()),
          foot: await page.eval(`document.querySelector('.vp-foot').textContent`),
          readyLine: await page.eval(`!!document.getElementById('hub-update-ready')`) };
        await page.eval(`require('electron').ipcRenderer.emit('app-update:state', {}, { phase: 'none', current: ${JSON.stringify(CURRENT)}, pinned: null })`);
        await sleep(150);
      }
      await page.eval(`document.querySelector('.vp-dialog').close()`);
      await sleep(150);
    }
    // 内源连不上
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.eval(`window.__r42.list = ${JSON.stringify(lists.bad)}`);
    await click('#btn-options');
    await sleep(250);
    await click('#options-versions');
    await sleep(600);
    results.down = { shot: await shot('openx-down-1440x900'), text: await page.eval(`document.querySelector('[data-vp-error]').textContent`), ...(await measure()) };
    fs.writeFileSync(path.join(out, '20261125-r42-ui.json'), JSON.stringify(results, null, 2));
    assert.match(results.ready.foot, /取消回退/); assert.match(results.ready.foot, /立即重启回退/);
    assert.equal(results.ready.readyLine, false, '回退包不当作「新版本已就绪」');
    for (const k of ['list-900', 'list-800', 'confirm', 'down', 'ready']) {
      assert.ok(results[k].dialogOverflow <= 0 && results[k].pageOverflow <= 0, `${k} 出现纵向滚动：${JSON.stringify(results[k])}`);
      for (const i of results[k].inner) if (!/vp-detail/.test(i.cls)) assert.ok(i.over <= 1, `${k} ${i.cls} 溢出 ${i.over}`);
    }
    assert.match(results.confirm.text, /只从公司内源下载/);
    assert.ok(!results.defaultPick.includes(NEWER), '默认选中的是比当前旧的版本');
    assert.equal(results.newerPick.disabled, true);
    assert.match(results.newerPick.text, /检查更新/);
    assert.match(results.confirm106.text, /打开后会照常在后台自动更新回最新版/);
    assert.match(results.down.text, /连不上公司内源/);
    assert.doesNotMatch(JSON.stringify(results), /阿里云|GitHub|镜像/);
    console.log(JSON.stringify(results, null, 1));
  } finally {
    await page?.close();
    try { console.log('teardown', JSON.stringify(await gracefulQuit(hub))); } catch (error) { console.error('teardown 失败（不掩盖上面的结果）：', error.message); }
  }
  console.log('PASS');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
