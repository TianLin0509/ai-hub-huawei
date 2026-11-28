'use strict';
// 一键归档（2026-11-28）真实界面：老用户升级冻结原归档 → 不再自动归档 → 一键归档弹窗选时长和准则、预览数量 → 归档 → 从归档页打开即放回 → 重启仍在 → 可选自动归档。
// 隔离 Hub、全新数据目录；会话用 PowerShell，不发任何模型请求。手动运行，不在 npm test 清单里。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261128-manual-archive-ui');
const report = { ok: false, checks: [], screenshots: [] };
const DAY = 86400000;
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-manual-archive-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  for (const dir of [home, data, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local'), path.join(root, 'workspaces')]) fs.mkdirSync(dir, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
    AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'codeagent'), AI_HUB_CODEAGENT_SERVE: '0' };
  let hub, cdp;
  const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return; await sleep(150); }
    throw new Error('Timeout: ' + label);
  }
  const center = selector => cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing ' + ${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden ' + ${JSON.stringify(selector)});return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  async function click(selector) {
    const point = await center(selector);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await sleep(350);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    report.screenshots.push(path.join(out, name + '.png'));
  }
  const archiveFile = path.join(data, 'sidebar-archive.json');
  const stored = () => { try { return JSON.parse(fs.readFileSync(archiveFile, 'utf8')); } catch { return null; } };
  const archiveCount = () => cdp.eval(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent || ''`);
  const rowVisible = id => cdp.eval(`!!document.querySelector('#session-list [data-session-id="${id}"]')`);
  const previewCount = () => cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog .sa-count strong')?.textContent || ''`);
  function ageSessions(dir, ages) {
    let changed = 0;
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      const at = ages[node.hubId] ?? ages[node.id];
      if (at) {
        for (const field of ['createdAt', 'lastMessageTime', 'lastCompletedAt', 'runStartedAt', 'lastRunStartedAt', 'updatedAt']) if (field in node || field === 'createdAt') node[field] = at;
        changed++;
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
    };
    const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (['sessions', 'meetings'].includes(entry.name) || folder === dir) walk(full); continue; }
      if (!entry.name.endsWith('.json') || /^sidebar-/.test(entry.name)) continue;
      let json; try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const before = changed; visit(json);
      if (changed > before) fs.writeFileSync(full, JSON.stringify(json));
    } };
    walk(dir);
    return changed;
  }
  async function launch(label) {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: env });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until(`!!document.querySelector('#session-list .session-archive-quick')`, 'sidebar ready', 90000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`window.__hubSidebarArchive?.loaded?.()`, 'archive loaded');
    // PowerShell 会话没有对话记录：让检索按归档页给出的会话清单原样返回标题行（同 e2e-archive-folders-cdp.js），恢复走真实界面代码。
    await cdp.eval(`(() => { const ipc = require('electron').ipcRenderer, original = ipc.invoke.bind(ipc);
      ipc.invoke = async (channel, ...args) => {
        if (channel !== 'search-past-sessions' || !args[0]?.sessionFilter) return original(channel, ...args);
        const results = (args[0].sessionFilter.hubSessionIds || []).map(id => { const s = sessions.get(id) || {}; return { hubSessionId: id, meetingId: null, sessionKey: 'live-session:' + id, key: 'live-session:' + id,
          title: s.title || id, provider: 'other', cwd: s.cwd, titleOnly: true, matchCount: 1, bestMatch: { eventId: null, scope: 'title', role: 'title', text: s.title || id } }; });
        return { results, totalSessions: results.length, state: 'complete', queryId: 'fixture-' + Date.now() };
      }; return true; })()`);
  }
  async function restoreFromArchive(title) {
    await click('#session-list .session-archive-entry');
    await until(`!!document.querySelector('#search-results .session-search-result')`, 'archive list', 30000);
    await shot('20261128-archive-07-archive-page-1440');
    const index = await cdp.eval(`[...document.querySelectorAll('#search-results .session-search-result')].find(r => r.querySelector('.session-search-result-title').textContent === ${JSON.stringify(title)})?.dataset.resultIndex`);
    assert.ok(index !== undefined, '归档页里能找到 ' + title);
    await cdp.eval(`document.querySelector('#search-results [data-result-index="${index}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  }
  async function quit() { await gracefulQuit(hub); try { cdp?.close?.(); } catch { /* closed */ } hub = null; }
  try {
    await launch('manual-archive-1');
    const ids = await cdp.eval(`(async () => { const ipc = require('electron').ipcRenderer;
      const make = async title => { const s = await ipc.invoke('create-session', 'powershell'); const id = s.id || s.hubId || s; await ipc.invoke('rename-session', { sessionId: id, title }).catch(() => {}); return id; };
      const r = { a: await make('甲-两天前的联调'), b: await make('乙-五天前的调研'), c: await make('丙-十天前的周报'), d: await make('丁-刚刚的会话') };
      for (const id of [r.a, r.b, r.c, r.d]) await ipc.invoke('suspend-session', { sessionId: id });
      return r; })()`);
    await sleep(1500);
    await quit();
    // 模拟老版本用户：会话活动时间拨回去，且还没有归档文件（升级前的版本没有它）。
    check('拨回了 3 个会话的活动时间', ageSessions(data, { [ids.a]: Date.now() - 2 * DAY, [ids.b]: Date.now() - 5 * DAY, [ids.c]: Date.now() - 10 * DAY }) >= 3);
    fs.rmSync(archiveFile, { force: true });

    // 1. 升级后第一次启动：原来已在归档里的（闲置超过 1 天）冻结为已归档，侧栏不突然冒出旧会话。
    await launch('manual-archive-upgrade');
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '3'`, 'migrated 3', 30000);
    const migrated = stored();
    check('升级迁移：甲乙丙 3 个进了归档，丁留在侧栏', Object.keys(migrated.records).length === 3 && await rowVisible(ids.d) && !(await rowVisible(ids.a)));
    check('升级迁移：自动归档默认关闭', migrated.auto.enabled === false && migrated.migratedAt > 0);
    check('范围页签里不再有「今天 / 3 天」，改为「全部」', await cdp.eval(`(() => { const t = [...document.querySelectorAll('[data-session-days]')].map(b => b.textContent.trim()); return t.includes('全部') && !t.includes('今天') && !t.includes('3 天'); })()`));
    await shot('20261128-archive-01-after-upgrade-1440');

    // 2. 不再自动归档：把三个都放回侧栏后，重启也不会因为「超过 24 小时」被收走。
    await cdp.eval(`window.__hubSidebarArchive.restore(['session:${ids.a}','session:${ids.b}','session:${ids.c}'])`);
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '0'`, 'restored all');
    await quit();
    await launch('manual-archive-no-auto');
    await sleep(1500);
    check('重启后 10 天没动的会话仍在侧栏（默认不自动归档）', await archiveCount() === '0' && await rowVisible(ids.c) && await rowVisible(ids.a));
    await shot('20261128-archive-02-sidebar-no-auto-1440');

    // 3. 一键归档弹窗：默认 24 小时，预览 3 个；切 3 天 → 2；7 天 → 1；自定义 4 天 → 2；
    //    把乙放进目录并勾「保留已放进目录的会话」→ 预览少 1。
    const folderId = await cdp.eval(`(async () => { const f = window.__hubSidebarFolders; const s = await f.create('接口项目'); const id = s.folders.find(x => x.name === '接口项目').id; await f.assign('session:${ids.b}', id); return id; })()`);
    await until(`document.querySelector('#session-list [data-session-id="${ids.b}"]')?.closest('.sidebar-folder')?.dataset.sidebarFolder === '${folderId}'`, 'assigned');
    await click('#session-list .session-archive-quick');
    await until(`!!document.querySelector('dialog.sidebar-archive-dialog[open]')`, 'dialog open');
    check('弹窗默认选中 24 小时', await cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog [data-preset="24h"]').getAttribute('aria-checked') === 'true'`));
    check('24 小时预览 3 个', await previewCount() === '3');
    check('预览列表列出最久没动的丙在第一位', await cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog .sa-list li .sa-item-title')?.textContent.includes('丙')`));
    check('自动归档勾选框默认不勾', await cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog [data-auto]').checked === false`));
    await shot('20261128-archive-03-dialog-24h-1440');
    await click('dialog.sidebar-archive-dialog [data-preset="3d"]');
    check('3 天预览 2 个', await previewCount() === '2');
    await click('dialog.sidebar-archive-dialog [data-preset="7d"]');
    check('7 天预览 1 个', await previewCount() === '1');
    await click('dialog.sidebar-archive-dialog [data-preset="custom"]');
    await cdp.eval(`(() => { const d = document.querySelector('dialog.sidebar-archive-dialog'); const i = d.querySelector('.sa-custom input'); i.value = '4'; d.querySelector('.sa-custom select').value = 'day'; d.querySelector('.sa-custom select').dispatchEvent(new Event('change')); i.dispatchEvent(new Event('input')); })()`);
    check('自定义 4 天预览 2 个', await previewCount() === '2');
    await cdp.eval(`(() => { const i = document.querySelector('dialog.sidebar-archive-dialog .sa-custom input'); i.value = '0'; i.dispatchEvent(new Event('input')); })()`);
    check('自定义填 0 时给出提示、归档按钮不可点', await cdp.eval(`(() => { const d = document.querySelector('dialog.sidebar-archive-dialog'); return d.querySelector('.sa-error').textContent.includes('1 小时') && d.querySelector('[data-act="apply"]').disabled; })()`));
    await click('dialog.sidebar-archive-dialog [data-preset="3d"]');
    await click('dialog.sidebar-archive-dialog [data-rule="keepFoldered"]');
    check('勾「保留已放进目录的会话」后 3 天预览 1 个', await previewCount() === '1');
    await shot('20261128-archive-04-dialog-3d-keep-folder-1440');
    await click('dialog.sidebar-archive-dialog [data-rule="keepFoldered"]');
    check('取消勾选后回到 2 个，按钮写「归档 2 个」', await previewCount() === '2' && await cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog [data-act="apply"]').textContent === '归档 2 个'`));
    await click('dialog.sidebar-archive-dialog [data-act="apply"]');
    await until(`!document.querySelector('dialog.sidebar-archive-dialog')`, 'dialog closed');
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '2'`, 'archived 2');
    check('归档后乙丙离开侧栏，甲丁留下', !(await rowVisible(ids.b)) && !(await rowVisible(ids.c)) && await rowVisible(ids.a) && await rowVisible(ids.d));
    check('归档后乙的目录归属不变', JSON.parse(fs.readFileSync(path.join(data, 'sidebar-folders.json'), 'utf8')).assignments['session:' + ids.b] === folderId);
    check('自动归档仍关闭，上次的选择（3 天）记住了', stored().auto.enabled === false && stored().auto.hours === 72);
    await shot('20261128-archive-05-after-archive-1440');

    // 4. 重启：归档仍在；再打开弹窗沿用 3 天。
    await quit();
    await launch('manual-archive-restart');
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '2'`, 'after restart', 30000);
    check('重启后仍是 2 个归档', !(await rowVisible(ids.c)));

    // 5. 从归档点开 = 放回侧栏（走 revealSearchItem，与归档页「打开」同一路径）。
    const titleC = await cdp.eval(`sessions.get('${ids.c}')?.title || ''`);
    await restoreFromArchive(titleC);
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '1'`, 'restored c');
    check('从归档页打开丙后，丙回到侧栏、归档记录删除', await rowVisible(ids.c) && !stored().records['session:' + ids.c]);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await cdp.eval(`window.hubWorkspaces?.close?.('review')`).catch(() => {});
    await sleep(500);

    // 6. 可选自动归档：勾上「以后按此规则自动归档」+ 24 小时 → 甲（2 天）和丙（10 天）自动进归档；再关掉就回来。
    await click('#session-list .session-archive-quick');
    await until(`!!document.querySelector('dialog.sidebar-archive-dialog[open]')`, 'dialog open 2');
    check('再次打开沿用上次的 3 天', await cdp.eval(`document.querySelector('dialog.sidebar-archive-dialog [data-preset="3d"]').getAttribute('aria-checked') === 'true'`));
    await click('dialog.sidebar-archive-dialog [data-preset="24h"]');
    await click('dialog.sidebar-archive-dialog [data-auto]');
    await shot('20261128-archive-06-dialog-auto-on-1440');
    await click('dialog.sidebar-archive-dialog [data-act="apply"]');
    await until(`!document.querySelector('dialog.sidebar-archive-dialog')`, 'dialog closed 2');
    // 甲 2 天没动 → 自动进归档；丙刚从归档打开过，若打开时唤醒刷新了活动时间就留在侧栏。
    await until(`Number(document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent) >= 2 && !document.querySelector('#session-list [data-session-id="${ids.a}"]')`, 'auto on');
    check('开启自动归档后，甲（2 天没动）被自动收进归档，丁留在侧栏', await rowVisible(ids.d));
    await shot('20261128-archive-08-auto-on-sidebar-1440');
    check('开启自动归档后保存为开启、24 小时', stored().auto.enabled === true && stored().auto.hours === 24);
    await cdp.eval(`window.__hubSidebarArchive.setAuto(false, { hours: 24 })`);
    await until(`!!document.querySelector('#session-list [data-session-id="${ids.d}"]')`, 'd visible');
    await sleep(1200);
    // 点「归档」时预览里的甲已被直接归档（有记录），所以关掉自动归档后甲仍在归档；之后新闲置的不会再被收走。
    check('关掉自动归档后已归档的不动、丁仍在侧栏', stored().auto.enabled === false && !!stored().records['session:' + ids.a] && !(await rowVisible(ids.a)) && await rowVisible(ids.d));

    // 7. 审查修复回归：只因自动归档而在归档里的会话仍是弹窗候选；停在「置顶」页签也能预览；关掉自动归档时按所选规则记成手动归档，不会全部弹回侧栏。
    await cdp.eval(`(async () => { const a = window.__hubSidebarArchive; await a.restore(['session:${ids.a}','session:${ids.b}','session:${ids.c}']); await a.setAuto(true, { hours: 24 }); })()`);
    await until(`Number(document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent) >= 2`, 'auto-only archived');
    const autoOnly = Number(await archiveCount());
    check('自动归档收走的没有手动记录', Object.keys(stored().records).length === 0);
    await click('[data-session-days="pinned"]');
    await click('#session-list .session-archive-quick');
    await until(`!!document.querySelector('dialog.sidebar-archive-dialog[open]')`, 'dialog open 3');
    check('停在「置顶」页签时预览仍包含自动归档收走的会话', Number(await previewCount()) === autoOnly);
    await click('dialog.sidebar-archive-dialog [data-auto]');
    await click('dialog.sidebar-archive-dialog [data-act="apply"]');
    await until(`!document.querySelector('dialog.sidebar-archive-dialog')`, 'dialog closed 3');
    await click('[data-session-days="all"]');
    await sleep(1200);
    check('关掉自动归档后这些会话记成手动归档，没有弹回侧栏', stored().auto.enabled === false && Object.keys(stored().records).length === autoOnly && Number(await archiveCount()) === autoOnly && !(await rowVisible(ids.a)));
    report.ok = true;
  } catch (error) {
    try { await shot('20261128-archive-zz-failure'); } catch { /* best effort */ }
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, '20261128-manual-archive-e2e.json'), JSON.stringify(report, null, 2));
    try { cdp?.close?.(); } catch { /* already closed */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().then(() => { console.log(`PASS ${report.checks.length} checks`); process.exit(0); }, error => { console.error('FAIL', error.stack || error.message, '\nchecks passed:', report.checks.length); process.exit(1); });
