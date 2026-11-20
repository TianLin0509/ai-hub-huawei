'use strict';
// 本机 CLI 诊断界面 · 真数据走查（2026-11-21，HUB-H 第一期 A 线）：隔离 Hub 数据目录，但 PATH / HOME 用本机真实环境，不打桩。
// 1) 体检里各 CLI 的结论卡与「查过 N 处」；2) 展开后「收起」按钮在首屏；3) 启动中心徽标；
// 4) 只给这个 Hub 进程设 NPM_CONFIG_PREFIX 指向一个临时目录：起始为空（pi 没找到），中途把预先装好 pi 的目录挪进来，
//    对 pi 重新检测，看启动中心徽标经 harness:changed 就地变化、体检出现 pi「能用」卡。不改全局 npm 设置。
// 用法：node tests/e2e-harness-real-cdp.js --pi-stage <已用 npm i -g --prefix 装好 pi 的目录> [--out <截图目录>]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ''; };
const out = path.resolve(arg('--out') || path.join(__dirname, '..', '.shots'));
const stage = path.resolve(arg('--pi-stage') || '');
const report = { ok: false, checks: [], fails: [], screenshots: [], rows: {}, badges: {} };
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  if (!fs.existsSync(path.join(stage, 'pi.cmd'))) throw new Error('--pi-stage 下没有 pi.cmd：' + stage);
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-real-'));
  const prefix = path.join(path.dirname(stage), 'pi-prefix-live');
  if (fs.existsSync(prefix)) throw new Error('临时 npm 目录已存在，先确认后再删：' + prefix);
  let hub, cdp;
  const check = (name, value, detail) => { (value ? report.checks : report.fails).push(detail ? `${name}（${detail}）` : name); console.log(value ? '✓' : '✗', name, detail || ''); };
  async function until(expression, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await cdp.eval(expression).catch(() => false)) return true; await sleep(150); }
    console.log('… 等待超时：' + label); return false;
  }
  async function click(selector) {
    const point = await cdp.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('找不到 '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(200);
  }
  async function shot(name) {
    await sleep(300);
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `20261121-harness-real-${name}.png`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    report.screenshots.push(file); console.log('  截图', file);
  }
  const rowsNow = () => cdp.eval(`[...document.querySelectorAll('.ec-list [data-hx-verdict]')].map(r => ({ id: r.dataset.ecId, verdict: r.dataset.hxVerdict,
    name: r.querySelector('.ec-name')?.childNodes[0]?.textContent.trim(), tag: r.querySelector('.hx-verdict')?.textContent.trim(), reason: r.querySelector('.ec-detail')?.textContent.trim() }))`);
  async function collectRows() {
    const tabs = await cdp.eval(`[...document.querySelectorAll('[data-ec-tab]')].map(b => b.dataset.ecTab)`);
    for (const t of tabs) { await click(`[data-ec-tab="${t}"]`); for (const r of await rowsNow()) report.rows[r.id] = { ...r, tab: t }; }
    return tabs;
  }
  const badges = () => cdp.eval(`Object.fromEntries([...document.querySelectorAll('.new-session-option[data-kind]')].map(b => { const s = b.querySelector('.company-cli-status'); return [b.dataset.kind, { harness: b.dataset.harness || '', installed: b.dataset.installed || '', badge: s && !s.hidden ? s.textContent.trim() : '' }]; }))`);
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), label: 'harness-real-m2', extraEnv: { NPM_CONFIG_PREFIX: prefix, AI_HUB_CODEAGENT_SERVE: '0' } });
    cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
    await until('!!window.__envCheck && !!document.getElementById("btn-new")', 'renderer ready', 90000);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('window.innerWidth === 1440', 'viewport 1440');
    await cdp.eval(`window.__hxChanged = []; require('electron').ipcRenderer.on('harness:changed', (_e, p) => window.__hxChanged.push([p.id, p.result && p.result.verdict]))`);

    // 1) 体检：真实结论卡
    await cdp.eval('window.__envCheck.open({ tab: "components" })');
    await until(`!document.querySelector('[data-ec="rerun"]')?.disabled && document.querySelectorAll('.ec-list [data-hx-verdict]').length > 0`, '体检出结论', 180000);
    const tabs = await collectRows();
    console.log(JSON.stringify(report.rows, null, 1));
    const want = { ok: ['claude', 'codex', 'gemini', 'kimi', 'antigravity', 'node'], notFound: ['dsh', 'pi', 'codeagent'] };
    const byLocate = await cdp.eval(`require('electron').ipcRenderer.invoke('harness:peek-all').then(r => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, v && v.verdict])))`);
    report.locate = byLocate; console.log('定位中心：', JSON.stringify(byLocate));
    // 公司版不启用 Gemini / Kimi / Antigravity，定位中心不查它们（peek 为 null），记为说明不算失败。
    report.notes = [];
    for (const id of want.ok) {
      if (byLocate[id] === null || byLocate[id] === undefined) { report.notes.push(`${id}：这个版本没启用，定位中心不查`); console.log('…', id, '未启用，跳过'); continue; }
      check(`${id} 定位结论为「能用」`, byLocate[id] === 'ok', byLocate[id]);
    }
    for (const id of want.notFound) check(`${id} 定位结论为「没找到」`, byLocate[id] === 'not-found', byLocate[id]);
    const rowFor = id => Object.values(report.rows).find(r => r.id === id || r.id === ({ dsh: 'deepseek' }[id]) || (r.name || '').toLowerCase().includes(id));
    // 每个有定位结论的行都要有卡；卡上的标签和定位中心一致。
    for (const [id, v] of Object.entries(byLocate)) { if (!v) continue;
      if (id === 'node' && !Object.values(report.rows).some(x => x.id === 'node')) { report.notes.push('node：体检的 Node.js 行没带 extra.locate（m1 侧），仍按旧样式显示'); console.log('… node 行没带定位结论'); continue; } const r = Object.values(report.rows).find(x => x.verdict === v && rowFor(id) === x); check(`${id} 体检里有结论卡`, !!r, r ? `${r.tab} · ${r.tag}` : '没找到对应行'); }

    // 2) pi（没找到）：展开查过的位置；收起按钮在首屏
    const pi = rowFor('pi');
    if (pi) {
      await click(`[data-ec-tab="${pi.tab}"]`);
      if (!(await cdp.eval(`!!document.querySelector('[data-ec-id="${pi.id}"].expanded')`))) await click(`[data-ec-toggle="${pi.id}"]`);
      if (await cdp.eval(`!!document.querySelector('[data-ec-id="${pi.id}"] [data-hx-checked]')`)) await click(`[data-ec-id="${pi.id}"] [data-hx-checked]`);
      const checked = await cdp.eval(`[...document.querySelectorAll('[data-ec-id="${pi.id}"] ol.hx-checked li')].map(li => li.textContent.trim().replace(/\\s+/g, ' '))`);
      report.piChecked = checked;
      check('pi「没找到」卡列出查过的位置', checked.length >= 3, `${checked.length} 处`);
      const fit = await cdp.eval(`(() => { const box = document.querySelector('.ec-body').getBoundingClientRect(); const ol = document.querySelector('[data-ec-id="${pi.id}"] ol.hx-checked').getBoundingClientRect(); const head = document.querySelector('[data-ec-toggle="${pi.id}"]').getBoundingClientRect();
        return { list: ol.bottom <= box.bottom + 1, head: head.top >= box.top - 1 && head.bottom <= box.bottom + 1 }; })()`);
      check('展开查过的位置后，列表和「收起」都在可见区', fit.list && fit.head, JSON.stringify(fit));
      await shot('01-pi-not-found-checked');
    }
    // 收起按钮可见：逐个展开每个结论卡（含列表最下面的），检查行头的「收起」在可见区内。
    const visible = [];
    for (const t of tabs) {
      await click(`[data-ec-tab="${t}"]`);
      const ids = await cdp.eval(`[...document.querySelectorAll('.ec-list [data-hx-verdict]')].map(r => r.dataset.ecId)`);
      for (const id of ids) {
        if (await cdp.eval(`!!document.querySelector('[data-ec-id="${id}"].expanded')`)) await click(`[data-ec-toggle="${id}"]`);
        await cdp.eval(`document.querySelector('.ec-body').scrollTop = 0`);
        await click(`[data-ec-toggle="${id}"]`);
        const seen = await cdp.eval(`(() => { const b = document.querySelector('[data-ec-toggle="${id}"]'); const box = document.querySelector('.ec-body').getBoundingClientRect(); const r = b.getBoundingClientRect();
          return b.textContent.trim() === '收起' && r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.bottom <= innerHeight; })()`);
        visible.push([id, seen]);
        await click(`[data-ec-toggle="${id}"]`);
      }
    }
    report.collapseVisible = visible;
    check('每张结论卡展开后「收起」在首屏', visible.length > 0 && visible.every(v => v[1]), visible.filter(v => !v[1]).map(v => v[0]).join(',') || `${visible.length} 张`);
    // 末尾一张展开着截图
    const last = visible[visible.length - 1];
    if (last) { await click(`[data-ec-toggle="${last[0]}"]`); await shot('02-last-card-expanded'); await click(`[data-ec-toggle="${last[0]}"]`); }
    const okRow = rowFor('claude');
    if (okRow) { await click(`[data-ec-tab="${okRow.tab}"]`); await cdp.eval(`document.querySelector('.ec-body').scrollTop = 0`); await click(`[data-ec-toggle="${okRow.id}"]`); await shot('03-claude-ok-card'); await click(`[data-ec-toggle="${okRow.id}"]`); }
    // 复制诊断（只截获，不写系统剪贴板）
    await cdp.eval(`window.__copied = []; navigator.clipboard.writeText = async t => { window.__copied.push(t); }`);
    await click('[data-ec="copy-diag"]');
    await until('window.__copied.length > 0', '复制全部诊断', 15000);
    const diag = await cdp.eval('window.__copied[0] || ""');
    report.diagSample = diag.split(/\r?\n/).filter(l => /Users|USERPROFILE|<user>/i.test(l)).slice(0, 6);
    check('复制全部诊断有内容', diag.length > 500, `${Buffer.byteLength(diag)} 字节`);
    check('诊断里没有真实用户名', !diag.toLowerCase().includes(os.userInfo().username.toLowerCase()));
    await cdp.eval(`document.querySelector('[data-ec="close"]').click()`);

    // 3) 启动中心徽标（装 pi 之前）
    await click('#btn-new');
    await until(`[...document.querySelectorAll('.new-session-option[data-kind]')].some(b => b.dataset.harness)`, '徽标按定位结论画', 30000);
    await sleep(800);
    report.badges.before = await badges();
    console.log('徽标（前）：', JSON.stringify(report.badges.before));
    check('启动中心 pi 显示「未安装」', report.badges.before.pi && report.badges.before.pi.harness === 'not-found' && /未安装/.test(report.badges.before.pi.badge), JSON.stringify(report.badges.before.pi));
    check('启动中心 claude 无徽标', report.badges.before.claude && !report.badges.before.claude.badge);
    await shot('04-launch-badges-before-pi');

    // 4) 把装好 pi 的目录挪进 NPM_CONFIG_PREFIX，菜单开着，对 pi 重新检测 → harness:changed → 徽标就地变化
    fs.renameSync(stage, prefix);
    const t0 = Date.now();
    const piResult = await cdp.eval(`require('electron').ipcRenderer.invoke('harness:locate', { id: 'pi', fresh: true }).then(r => ({ verdict: r.verdict, reason: r.reason, source: r.chosen && r.chosen.source, version: r.chosen && r.chosen.version }))`);
    report.piAfter = piResult; console.log('pi 重新检测：', JSON.stringify(piResult), `${Date.now() - t0} ms`);
    check('pi 装进临时 npm 目录后结论为「能用」', piResult.verdict === 'ok', `${piResult.source || ''} v${piResult.version || ''}`);
    await until(`window.__hxChanged.some(c => c[0] === 'pi' && c[1] === 'ok')`, 'harness:changed(pi)', 15000);
    check('收到 harness:changed（pi → 能用）', await cdp.eval(`window.__hxChanged.some(c => c[0] === 'pi' && c[1] === 'ok')`));
    const menuOpen = await cdp.eval(`(() => { const m = document.getElementById('new-session-menu'); return !!m && getComputedStyle(m).display !== 'none'; })()`);
    await until(`document.querySelector('.new-session-option[data-kind="pi"]')?.dataset.harness === 'ok'`, 'pi 徽标更新', 10000);
    report.badges.after = await badges();
    console.log('徽标（后）：', JSON.stringify(report.badges.after), '菜单一直开着：', menuOpen);
    check('菜单不重开，pi 徽标就地消失（能用）', menuOpen && report.badges.after.pi && report.badges.after.pi.harness === 'ok' && !report.badges.after.pi.badge, JSON.stringify(report.badges.after.pi));
    await shot('05-launch-badges-after-pi');
    await cdp.eval(`document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    // 5) 体检里 pi 变成「能用」卡
    await cdp.eval('window.__envCheck.open({ focus: "pi" })');
    await until(`!document.querySelector('[data-ec="rerun"]')?.disabled`, '体检完成', 180000);
    await until(`document.querySelector('[data-hx-verdict="ok"][data-ec-id="${pi ? pi.id : 'pi'}"]')`, 'pi 能用卡', 30000);
    const piCard = await cdp.eval(`(() => { const r = document.querySelector('[data-ec-id="${pi ? pi.id : 'pi'}"]'); return r && { verdict: r.dataset.hxVerdict, tag: r.querySelector('.hx-verdict')?.textContent.trim(), meta: r.querySelector('.hx-meta')?.textContent.trim(), expanded: r.classList.contains('expanded') }; })()`);
    report.piCard = piCard;
    check('体检里 pi 显示「能用」卡', piCard && piCard.verdict === 'ok', piCard && `${piCard.tag} · ${piCard.meta}`);
    if (piCard && !piCard.expanded) await click(`[data-ec-toggle="${pi ? pi.id : 'pi'}"]`);
    await shot('06-pi-ok-card');
    report.ok = report.fails.length === 0;
  } finally {
    if (cdp) await cdp.close?.().catch?.(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
    // 挪回原处，临时 npm 目录不留在新位置。
    try { if (fs.existsSync(prefix) && !fs.existsSync(stage)) fs.renameSync(prefix, stage); } catch (error) { console.warn('挪回 pi 目录失败：', error.message); }
    fs.writeFileSync(path.join(out, '20261121-harness-real-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(report.ok ? '全部通过' : `有 ${report.fails.length} 项没过：\n  ` + report.fails.join('\n  '));
  if (!report.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
