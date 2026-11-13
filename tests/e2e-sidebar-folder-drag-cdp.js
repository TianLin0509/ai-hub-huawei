'use strict';
// 侧栏拖拽归类（2026-11-13）：把会话、群聊整行拖到目录上，或拖到「＋ 新建目录」上先建再放。
// 隔离 Hub、全新数据目录；拖拽用 CDP 的拖拽拦截走真实的 dragstart → dragover → drop，不占用真实鼠标。
// 会话用 PowerShell，不发任何模型请求。手动运行，不在 npm test 清单里。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261113-folder-drag-ui');
const report = { ok: false, checks: [], screenshots: [] };
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-folder-drag-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  for (const dir of [home, data, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(root, 'workspaces/group')]) fs.mkdirSync(dir, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0' };
  let hub, cdp, intercepted = null;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(100); }
    throw new Error('Timeout: ' + label);
  }
  const center = selector => cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing ' + ${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden ' + ${JSON.stringify(selector)});return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  async function click(selector) {
    const point = await center(selector);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  // 按住一行拖到目标上方并停住（还没松手），返回松手用的函数。
  async function dragOver(fromSelector, toSelector) {
    const from = await center(fromSelector);
    intercepted = null;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...from });
    for (let step = 1; step <= 4 && !intercepted; step++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: from.x + step * 6, y: from.y + step * 6 });
      await sleep(80);
    }
    for (const end = Date.now() + 3000; !intercepted && Date.now() < end;) await sleep(50);
    assert.ok(intercepted, '按住这一行拖动后，浏览器开始了拖拽：' + fromSelector);
    const data = intercepted, to = await center(toSelector);
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', data, ...to });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', data, ...to });
    return async () => {
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', data, ...to });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...to });
    };
  }
  const drag = async (from, to) => (await dragOver(from, to))();
  async function shot(name) {
    await sleep(200);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    report.screenshots.push(name + '.png');
  }
  async function nameDialog(text) {
    await until(`!!document.querySelector('.hub-name-dialog input')`, 'name dialog');
    await cdp.eval(`document.querySelector('.hub-name-dialog input').focus()`);
    await cdp.send('Input.insertText', { text });
    await click('.hub-name-dialog button.primary');
    await until(`!document.querySelector('.hub-name-dialog')`, 'name dialog closed');
  }
  const folderOf = id => cdp.eval(`document.querySelector('#session-list [data-session-id="${id}"], #session-list [data-meeting-id="${id}"]')?.closest('.sidebar-folder')?.querySelector('.sidebar-folder-name')?.textContent || ''`);
  const row = id => `#session-list [data-session-id="${id}"], #session-list [data-meeting-id="${id}"]`;
  const folder = name => cdp.eval(`[...document.querySelectorAll('#session-list .sidebar-folder')].find(f => f.querySelector('.sidebar-folder-name').textContent === ${JSON.stringify(name)})?.dataset.sidebarFolder || ''`);
  const stored = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'sidebar-folders.json'), 'utf8')); } catch { return { folders: [], assignments: {} }; } };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'folder-drag', extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    cdp.ws.on('message', raw => { try { const msg = JSON.parse(raw.toString()); if (msg.method === 'Input.dragIntercepted') intercepted = msg.params.data; } catch { /* not a drag event */ } });
    await until(`!!document.querySelector('#session-list [data-folder-create]')`, 'sidebar ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Input.setInterceptDrags', { enabled: true });

    // 准备：两个 PowerShell 会话、一个空群聊（本地夹具，不启动任何 AI）、一个目录「接口项目」。
    const ids = await cdp.eval(`(async () => { const ipc = require('electron').ipcRenderer;
      const a = await ipc.invoke('create-session', 'powershell'), b = await ipc.invoke('create-session', 'powershell');
      const g = await ipc.invoke('create-meeting', { title: '拖拽测试群', workspace: ${JSON.stringify(path.join(root, 'workspaces/group'))}, slots: [] });
      return { a: a.id || a.hubId || a, b: b.id || b.hubId || b, g: g.id }; })()`);
    await until(`!!document.querySelector('#session-list [data-session-id="${ids.a}"]') && !!document.querySelector('#session-list [data-session-id="${ids.b}"]') && !!document.querySelector('#session-list [data-meeting-id="${ids.g}"]')`, 'rows rendered');
    await click('#session-list [data-folder-create]');
    await nameDialog('接口项目');
    await until(`[...document.querySelectorAll('#session-list .sidebar-folder-name')].some(n => n.textContent === '接口项目')`, 'folder created');
    const project = await folder('接口项目');
    check('会话和群聊这一行可以拖', await cdp.eval(`['${ids.a}','${ids.b}','${ids.g}'].every(id => document.querySelector('#session-list [data-session-id="' + id + '"], #session-list [data-meeting-id="' + id + '"]').draggable)`));
    await shot('20261113-folder-drag-01-before-1440');

    // 1. 把会话拖到目录上：拖过去时目录高亮，松手后会话进了这个目录，并写进了数据文件。
    const release = await dragOver(row(ids.a), `#session-list .sidebar-folder[data-sidebar-folder="${project}"]`);
    check('拖到目录上方时，这个目录高亮', await cdp.eval(`document.querySelector('#session-list .sidebar-folder[data-sidebar-folder="${project}"]').classList.contains('drop-target') && document.getElementById('session-list').classList.contains('folder-dragging')`));
    await shot('20261113-folder-drag-02-hover-1440');
    await release();
    await until(`document.querySelector('#session-list [data-session-id="${ids.a}"]')?.closest('.sidebar-folder')?.dataset.sidebarFolder === '${project}'`, 'session moved');
    check('松手后会话进了「接口项目」', await folderOf(ids.a) === '接口项目');
    check('松手后高亮消失', await cdp.eval(`!document.querySelector('#session-list .drop-target') && !document.getElementById('session-list').classList.contains('folder-dragging')`));
    check('归属写进了数据文件', stored().assignments['session:' + ids.a] === project);
    check('没拖的会话还在「未分类」', await folderOf(ids.b) === '未分类');

    // 2. 群聊整行同样能拖。
    await drag(row(ids.g), `#session-list .sidebar-folder[data-sidebar-folder="${project}"]`);
    await until(`document.querySelector('#session-list [data-meeting-id="${ids.g}"]')?.closest('.sidebar-folder')?.dataset.sidebarFolder === '${project}'`, 'group moved');
    check('群聊拖进了「接口项目」', stored().assignments['meeting:' + ids.g] === project);
    await shot('20261113-folder-drag-03-moved-1440');

    // 3. 目录折叠着也能放：拖到目录标题上。
    await click(`#session-list .sidebar-folder[data-sidebar-folder="${project}"] .sidebar-folder-toggle`);
    await until(`!document.querySelector('#session-list .sidebar-folder[data-sidebar-folder="${project}"] .sidebar-folder-body')`, 'folder collapsed');
    await drag(row(ids.b), `#session-list .sidebar-folder[data-sidebar-folder="${project}"] .sidebar-folder-toggle`);
    await until(`document.querySelector('#session-list .sidebar-folder[data-sidebar-folder="${project}"] .sidebar-folder-count')?.textContent === '3'`, 'collapsed folder count');
    check('拖到折叠的目录标题上也能放进去（数量变成 3）', stored().assignments['session:' + ids.b] === project);
    await click(`#session-list .sidebar-folder[data-sidebar-folder="${project}"] .sidebar-folder-toggle`);
    await until(`!!document.querySelector('#session-list [data-session-id="${ids.b}"]')`, 'folder expanded');

    // 4. 拖回「未分类」。这时「未分类」是空的、排在被拖那一行的上方：拖动开始时页面不能有任何挪位，否则浏览器会取消拖拽。
    await drag(row(ids.b), '#session-list .sidebar-folder[data-sidebar-folder="unclassified"]');
    await until(`document.querySelector('#session-list [data-session-id="${ids.b}"]')?.closest('.sidebar-folder')?.dataset.sidebarFolder === 'unclassified'`, 'back to unclassified');
    check('拖回「未分类」后归属清掉', !('session:' + ids.b in stored().assignments));

    // 5. 拖到「＋ 新建目录」上：弹出起名框，保存后新目录里就是这个会话。
    await drag(row(ids.b), '#session-list [data-folder-create]');
    await nameDialog('临时调研');
    await until(`document.querySelector('#session-list [data-session-id="${ids.b}"]')?.closest('.sidebar-folder')?.querySelector('.sidebar-folder-name')?.textContent === '临时调研'`, 'created and moved');
    check('拖到「新建目录」上：建好目录并直接放进去', stored().folders.some(f => f.name === '临时调研' && stored().assignments['session:' + ids.b] === f.id));

    // 6. 原有操作不受影响：点一下仍是打开会话；1440×900 下侧栏没有横向溢出。
    await click(`#session-list [data-session-id="${ids.a}"]`);
    await until(`document.querySelector('#session-list [data-session-id="${ids.a}"]')?.classList.contains('selected')`, 'click selects');
    check('点一下仍然是打开会话', true);
    check('侧栏没有横向溢出', await cdp.eval(`(() => { const l = document.getElementById('session-list'); return l.scrollWidth <= l.clientWidth + 1; })()`));
    await shot('20261113-folder-drag-04-final-1440');
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(out, '20261113-folder-drag-e2e.json'), JSON.stringify(report, null, 2));
    try { cdp?.close?.(); } catch { /* already closed */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().then(() => { console.log(`PASS ${report.checks.length} checks`); process.exit(0); }, error => { console.error('FAIL', error.message, '\nchecks passed:', report.checks.length); process.exit(1); });
