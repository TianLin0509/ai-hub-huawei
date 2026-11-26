'use strict';
// 归档按原目录分组（2026-11-26）：归档 → 归档页按目录分组、可折叠 → 恢复回原目录 → 原目录已删时放回「未分类」并提示 → 重启后仍保留。
// 隔离 Hub、全新数据目录；会话用 PowerShell，不发任何模型请求。手动运行，不在 npm test 清单里。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/20261126-archive-folders-ui');
const report = { ok: false, checks: [], screenshots: [] };
function freePort() {
  return new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  }); });
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-archive-folders-'));
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
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    report.screenshots.push(path.join(out, name + '.png'));
  }
  const stored = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'sidebar-folders.json'), 'utf8')); } catch { return { folders: [], assignments: {} }; } };
  const folderOf = id => cdp.eval(`document.querySelector('#session-list [data-session-id="${id}"]')?.closest('.sidebar-folder')?.querySelector('.sidebar-folder-name')?.textContent || ''`);
  const archiveGroups = () => cdp.eval(`[...document.querySelectorAll('#search-results .session-search-archive-group')].map(g => ({ name: g.querySelector('.session-search-archive-group-name').textContent, deleted: !!g.querySelector('.session-search-archive-group-note'), rows: g.querySelectorAll('.session-search-result').length, count: g.querySelector('.session-search-archive-group-count').textContent }))`);
  const archiveCount = () => cdp.eval(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent || ''`);
  // 改写隔离数据目录里这几个会话的活动时间（只动测试自己建的临时目录）。
  function ageSessions(dir, idSet, at) {
    let changed = 0;
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      if (idSet.has(node.hubId) || idSet.has(node.id)) {
        for (const field of ['createdAt', 'lastMessageTime', 'lastCompletedAt', 'runStartedAt', 'lastRunStartedAt', 'updatedAt']) if (field in node || field === 'createdAt') node[field] = at;
        changed++;
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
    };
    const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (['sessions', 'meetings'].includes(entry.name) || folder === dir) walk(full); continue; }
      if (!entry.name.endsWith('.json') || entry.name === 'sidebar-folders.json') continue;
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
    await until(`!!document.querySelector('#session-list [data-folder-create]')`, 'sidebar ready');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // PowerShell 会话没有对话记录，全文索引建好后不会返回它们；这里让检索按归档页给出的会话清单原样返回标题行（与索引未就绪时的标题层同形），分组和恢复都走真实界面代码。
    await cdp.eval(`(() => { const ipc = require('electron').ipcRenderer, original = ipc.invoke.bind(ipc);
      ipc.invoke = async (channel, ...args) => {
        if (channel !== 'search-past-sessions' || !args[0]?.sessionFilter) return original(channel, ...args);
        const results = (args[0].sessionFilter.hubSessionIds || []).map(id => { const s = sessions.get(id) || {}; return { hubSessionId: id, meetingId: null, sessionKey: 'live-session:' + id, key: 'live-session:' + id,
          title: s.title || id, provider: 'other', cwd: s.cwd, titleOnly: true, matchCount: 1, bestMatch: { eventId: null, scope: 'title', role: 'title', text: s.title || id } }; });
        return { results, totalSessions: results.length, state: 'complete', queryId: 'fixture-' + Date.now() };
      }; return true; })()`);
  }
  async function openArchive() {
    await click('#session-list .session-archive-entry');
    await until(`!!document.querySelector('#search-results .session-search-archive-group')`, 'archive grouped', 30000);
  }
  async function closeArchive() {
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await cdp.eval(`window.hubWorkspaces?.close?.('review')`).catch(() => {});
    await sleep(500);
  }
  // 用户在归档页里选中一行，按 Ctrl+Enter 打开（与点「打开」同一条恢复路径）。
  async function restoreFromArchive(title) {
    await openArchive();
    const index = await cdp.eval(`[...document.querySelectorAll('#search-results .session-search-result')].find(r => r.querySelector('.session-search-result-title').textContent === ${JSON.stringify(title)})?.dataset.resultIndex`);
    assert.ok(index !== undefined, '归档页里能找到 ' + title);
    await cdp.eval(`document.querySelector('#search-results [data-result-index="${index}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  }
  try {
    await launch('archive-folders-1');
    // 准备：三个 PowerShell 会话，两个目录；甲 → 接口项目，乙 → 临时调研，丙 留在未分类。
    const ids = await cdp.eval(`(async () => { const ipc = require('electron').ipcRenderer;
      const make = async title => { const s = await ipc.invoke('create-session', 'powershell'); const id = s.id || s.hubId || s; await ipc.invoke('rename-session', { sessionId: id, title }).catch(() => {}); return id; };
      return { a: await make('甲-接口联调'), b: await make('乙-调研笔记'), c: await make('丙-随手记') }; })()`);
    await until(`['${ids.a}','${ids.b}','${ids.c}'].every(id => document.querySelector('#session-list [data-session-id="' + id + '"]'))`, 'rows rendered');
    const titles = await cdp.eval(`(() => { const m = {}; for (const id of ['${ids.a}','${ids.b}','${ids.c}']) m[id] = document.querySelector('#session-list [data-session-id="' + id + '"] .sl-title')?.textContent || ''; return m; })()`);
    const folders = await cdp.eval(`(async () => { const f = window.__hubSidebarFolders;
      let s = await f.create('接口项目'); const a = s.folders.find(x => x.name === '接口项目').id;
      s = await f.create('临时调研'); const b = s.folders.find(x => x.name === '临时调研').id;
      await f.assign('session:${ids.a}', a); await f.assign('session:${ids.b}', b); return { a, b }; })()`);
    await until(`document.querySelector('#session-list [data-session-id="${ids.b}"]')?.closest('.sidebar-folder')?.dataset.sidebarFolder === '${folders.b}'`, 'assigned');
    await shot('20261126-archive-01-before-archive-1440');

    // 1. 休眠三个会话（侧栏「休眠」按钮用的同一个接口），再把它们的活动时间拨回 3 天前：归档区收的是一天以上没动的会话。
    await cdp.eval(`(async () => { const ipc = require('electron').ipcRenderer; for (const id of ['${ids.a}','${ids.b}','${ids.c}']) await ipc.invoke('suspend-session', { sessionId: id }); })()`);
    await sleep(1500);
    await gracefulQuit(hub); try { cdp?.close?.(); } catch { /* closed */ }
    const aged = ageSessions(data, new Set([ids.a, ids.b, ids.c]), Date.now() - 2 * 86400000);
    assert.ok(aged > 0, '找到了要拨回时间的会话记录');
    await launch('archive-folders-aged');
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '3'`, 'three archived', 30000);
    check('三个会话都进了归档（入口计数 3）', await archiveCount() === '3');
    check('归档后目录归属仍在数据文件里', stored().assignments['session:' + ids.a] === folders.a && stored().assignments['session:' + ids.b] === folders.b);

    // 2. 归档页按原目录分组：目录顺序同侧栏，「未分类」在最后，没有会话的组不出现。
    await openArchive();
    let groups = await archiveGroups();
    check('归档页按原目录分成 3 组：接口项目 / 临时调研 / 未分类', JSON.stringify(groups.map(g => g.name)) === JSON.stringify(['接口项目', '临时调研', '未分类']));
    check('每组 1 个会话', groups.every(g => g.rows === 1 && g.count === '1'));
    await shot('20261126-archive-02-grouped-1440');
    // 折叠一组：行收起、数量仍显示；再展开。
    await click('#search-results .session-search-archive-group[data-archive-group="' + folders.a + '"] .session-search-archive-group-header');
    await until(`document.querySelector('#search-results .session-search-archive-group[data-archive-group="${folders.a}"]')?.querySelectorAll('.session-search-result').length === 0`, 'collapsed');
    check('点组标题可以折叠，折叠后仍显示数量', (await archiveGroups())[0].count === '1');
    await shot('20261126-archive-03-collapsed-1440');
    // 焦点在搜索框时按上下键，只在看得见的行之间走，不会选中折叠起来的会话。
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
      await cdp.eval(`document.getElementById('search-query').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
      await sleep(150);
      check('搜索框按 ' + key + ' 后选中的是可见行', await cdp.eval(`(() => { const r = document.querySelector('#search-results .session-search-result.active'); return !!r && !r.closest('[data-archive-group="${folders.a}"]'); })()`));
    }
    await click('#search-results .session-search-archive-group[data-archive-group="' + folders.a + '"] .session-search-archive-group-header');
    await until(`document.querySelector('#search-results .session-search-archive-group[data-archive-group="${folders.a}"]')?.querySelectorAll('.session-search-result').length === 1`, 'expanded');
    await closeArchive();

    // 3. 恢复甲：回到「接口项目」。
    await restoreFromArchive(titles[ids.a]);
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '2'`, 'restored a', 30000);
    check('恢复后甲回到原目录「接口项目」', await folderOf(ids.a) === '接口项目');
    await shot('20261126-archive-04-restored-to-folder-1440');

    // 4. 删除目录「临时调研」（乙在归档里）：确认框写明归档仍按原目录名列出。
    await cdp.eval(`document.querySelector('#session-list .sidebar-folder[data-sidebar-folder="${folders.b}"] [data-folder-action="remove"]').click()`);
    await until(`!!document.querySelector('dialog.hub-dialog')`, 'confirm dialog');
    check('删除确认框提示归档仍按原目录名列出', await cdp.eval(`document.querySelector('dialog.hub-dialog .hub-dialog-body').textContent.includes('按原目录名列出')`));
    await cdp.eval(`document.querySelector('dialog.hub-dialog .hub-button-primary').click()`);
    await until(`!document.querySelector('#session-list .sidebar-folder[data-sidebar-folder="${folders.b}"]')`, 'folder removed');
    check('数据文件记下了乙的原目录名', stored().removed?.['session:' + ids.b]?.name === '临时调研');
    await openArchive();
    groups = await archiveGroups();
    check('归档页里「临时调研」组仍在，并标「原目录已删除」', groups.some(g => g.name === '临时调研' && g.deleted && g.rows === 1));
    await shot('20261126-archive-05-deleted-folder-group-1440');
    await closeArchive();

    // 5. 重启 Hub：分组、原目录名、折叠以外的数据都还在。
    await gracefulQuit(hub); try { cdp?.close?.(); } catch { /* closed */ }
    await launch('archive-folders-2');
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '2'`, 'archive after restart', 30000);
    await openArchive();
    groups = await archiveGroups();
    check('重启后归档页仍是「临时调研（原目录已删除）」+「未分类」', JSON.stringify(groups.map(g => [g.name, g.deleted])) === JSON.stringify([['临时调研', true], ['未分类', false]]));
    check('重启后甲仍在「接口项目」', await folderOf(ids.a) === '接口项目');
    // 只切换侧栏「3 天」视图（乙两天前活动过，会出现在 3 天里）不算恢复：不提示，也不清原目录名。
    await closeArchive();
    await cdp.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '3 天' && b.offsetParent)?.click()`);
    await until(`!!document.querySelector('#session-list [data-session-id="${ids.b}"]')`, 'b visible in 3-day view');
    await sleep(1500);
    check('切到「3 天」视图不提示、不清原目录名', !(await cdp.eval(`(document.getElementById('gc-fork-toast')?.textContent || '').includes('已放回')`)) && stored().removed?.['session:' + ids.b]?.name === '临时调研');
    await cdp.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '今天' && b.offsetParent)?.click()`);
    await sleep(800);
    await openArchive();
    await shot('20261126-archive-06-after-restart-1440');
    await closeArchive();

    // 6. 恢复乙：原目录已删 → 放回「未分类」并提示一行。
    await restoreFromArchive(titles[ids.b]);
    await until(`document.querySelector('#session-list .session-archive-entry .archive-count')?.textContent === '1'`, 'restored b', 30000);
    await until(`(document.getElementById('gc-fork-toast')?.textContent || '').includes('已放回')`, 'toast', 10000);
    check('提示「原目录“临时调研”已删除，已放回“未分类”」', await cdp.eval(`document.getElementById('gc-fork-toast').textContent.includes('临时调研')`));
    check('乙回到「未分类」', await folderOf(ids.b) === '未分类');
    await shot('20261126-archive-07-restored-fallback-1440');
    await until(`true`, 'noop');
    for (const end = Date.now() + 5000; stored().removed?.['session:' + ids.b] && Date.now() < end;) await sleep(100);
    check('提示过后原目录记录清掉', !stored().removed?.['session:' + ids.b]);
    report.ok = true;
  } catch (error) {
    try { await shot('20261126-archive-zz-failure'); report.failureDom = await cdp.eval(`({ overlay: !!document.querySelector('#search-modal:not([hidden])'), results: document.querySelector('#search-results')?.textContent.slice(0, 400), dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.textContent.slice(0, 200)) })`); } catch { /* best effort */ }
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, '20261126-archive-folders-e2e.json'), JSON.stringify(report, null, 2));
    try { cdp?.close?.(); } catch { /* already closed */ }
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}
main().then(() => { console.log(`PASS ${report.checks.length} checks`); process.exit(0); }, error => { console.error('FAIL', error.stack || error.message, '\nchecks passed:', report.checks.length); process.exit(1); });
