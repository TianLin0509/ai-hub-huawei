'use strict';
// PPT 页「库地图」Tab 端到端（r28g，2026-11-17）：真实隔离 Hub 窗口（无头）+ CDP 鼠标键盘。
// 虚构素材库：python-pptx 合成 12 份稿；索引走 Hub 自带的 Python 索引（legacyPython），分类的低档模型是 codeagent.cmd 替身（node 脚本按页面文字回 JSON）。
// 场景：全新无索引 → 就地「先建索引」→ 建好自动分类 → 树/页/原页预览一屏不滚动 → 改名 → 「移到」 → 按页面类型分组 → 抽查 50 页出准确率 → 模型不通时只用规则并说原因。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const out = process.env.PPT_UI_OUT || path.resolve(__dirname, '../artifacts', `ppt-map-${Date.now()}`);
function run(exe, args, options = {}) { const r = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 180000, ...options }); assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout); return r.stdout; }

// 12 份虚构稿，每份 6 页：封面 + 5 页正文；有的标题规则能判，有的（「整体情况」「补充说明」）规则拿不准、交给模型。
const PY = `
import sys, os, json
from pptx import Presentation
from pptx.util import Pt
root = sys.argv[1]
DECKS = json.loads(open(sys.argv[2], encoding='utf-8').read())
for d in DECKS:
    p = Presentation(); p.slide_width, p.slide_height = Pt(960), Pt(540)
    for i, (title, body) in enumerate(d['pages']):
        s = p.slides.add_slide(p.slide_layouts[1] if i else p.slide_layouts[0])
        s.shapes.title.text = title
        s.placeholders[1].text = body
    target = os.path.join(root, d['folder'], d['name'])
    os.makedirs(os.path.dirname(target), exist_ok=True); p.save(target)
`;
const TOPICS = [['节能', '小区关断与功控节能', '关断 功率 能耗'], ['调度', 'MU-MIMO 配对调度', '调度 PRB 配对 QoS'], ['信道', 'SRS 信道外推', '信道 SRS CSI 测量'], ['AI', '大模型数据标注', 'AI 数据 样本 训练']];
const KINDS = [['评审', 'TR4 评审材料'], ['周报', 'W45 双周例会'], ['分享', 'TechTalk 培训分享']];
function decks() {
  const list = [];
  for (const [ti, [short, topic, words]] of TOPICS.entries()) for (const [ki, [kind, deckName]] of KINDS.entries()) {
    const n = ti * 3 + ki + 1;
    list.push({ folder: `项目${short}`, name: `202610${String(10 + n).padStart(2, '0')}-${topic}-${deckName}.pptx`, pages: [
      [`${topic} ${deckName}`, `虚构课题组 · 2026 年 10 月 · ${kind}`],
      [`${topic}的问题与挑战`, `现状痛点：${words} 指标波动较大，瓶颈在于测量开销`],
      [`${topic}方案架构`, `整体方案设计：${words}，框架分三层，算法流程见下`],
      [`${topic}仿真增益`, `仿真结果：${words} 性能增益 8%，外场验证中`],
      ['整体情况', `这一页讲了很多关于${short}的${words}，还有 ${n} 个课题的整体情况与安排`],
      [`补充说明 ${n}`, `这一页讲了很多补充内容，涉及${words}以及后续安排`],
    ] });
  }
  return list;
}
// 模型替身：按 prompt 里每页文字给类别；quote 取页内一段原文（真模型也必须逐字引用，过不了核对就记「待人工」）。
// down.flag 存在时模拟「CodeAgent 调不通」（退出码 3 + 报错原因）。
const STUB = `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: -p --model --output-format --effort --max-turns --disable-update'); process.exit(0); }
if (fs.existsSync(path.join(__dirname, 'down.flag'))) { console.error('模型权限未开通（替身模拟）'); process.exit(3); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  fs.appendFileSync(path.join(__dirname, 'calls.log'), args[args.indexOf('--model') + 1] + '\\n');
  const rows = [];
  for (const part of input.split('\\n### id=').slice(1)) {
    const nl = part.indexOf('\\n'), head = part.slice(0, nl), text = part.slice(nl + 1).trim();
    const id = head.split(/\\s+/)[0];
    const topics = [['节能', '节能'], ['调度', '调度与资源分配'], ['信道', '信道与感知'], ['AI', 'AI 模型与数据']].filter(([w]) => text.includes(w)).map(([, t]) => t);
    rows.push({ id, pageType: /整体情况/.test(text) ? '进展与计划' : '结论摘要', topics, quote: text.replace(/\\s+/g, ' ').slice(0, 7) });
  }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(rows) }));
});`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-map-e2e-')), dataDir = path.join(root, 'data'), assistantDir = path.join(dataDir, 'company-assistant');
  const library = path.join(root, '20261117-虚构素材库'), bin = path.join(root, 'codeagent-bin');
  for (const dir of [assistantDir, library, bin, out]) fs.mkdirSync(dir, { recursive: true });
  const pyFile = path.join(root, 'make_decks.py'), spec = path.join(root, 'decks.json');
  fs.writeFileSync(pyFile, PY, 'utf8'); fs.writeFileSync(spec, j(decks()), 'utf8');
  run('python', ['-I', pyFile, library, spec]);
  fs.writeFileSync(path.join(bin, 'stub.js'), STUB, 'utf8');
  const codeagent = path.join(bin, 'codeagent.cmd');
  fs.writeFileSync(codeagent, `@"${process.execPath}" "%~dp0stub.js" %*\r\n`);
  // 全新用户：没选素材文件夹、没索引、没装 PPT Doctor（legacyPython 走 Hub 自带的 Python 索引）
  const settingsFile = path.join(assistantDir, 'settings.json');
  fs.writeFileSync(settingsFile, j({ enabled: false, ppt: { legacyPython: true, roots: [] } }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  const result = { provenance: '真实隔离Hub/CDP鼠标键盘 + 真实Python索引 + 合成虚构pptx + codeagent.cmd 替身（真子进程、隐藏窗口）', root, checks: [], shots: [] };
  let hub, c;
  const wait = async (expr, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(250); } throw new Error('timeout: ' + label + ' · status=' + await c.eval('document.querySelector("[data-pptg-status]")?.textContent||""')); };
  const point = async selector => c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw new Error('missing selector '+${j(selector)});e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  const click = async (selector, clickCount = 1) => { const r = await point(selector); for (let i = 1; i <= clickCount; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: i }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: i }); } };
  const key = async k => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, code: k.length === 1 ? 'Digit' + k : k }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); };
  const expand = async node => { if (await c.eval(`document.querySelector(${j(node)}).getAttribute('aria-expanded')!=='true'`)) await click(node + ' [data-pptg="toggle"]'); };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const target = path.join(out, `20261117-ppt-map-${name}-m81.png`); fs.writeFileSync(target, Buffer.from(image.data, 'base64')); result.shots.push(target); };
  const invoke = (action, payload = {}) => c.eval(`ipcRenderer.invoke(${j('company-assistant:' + action)},${j(payload)})`);
  const status = () => c.eval('document.querySelector("[data-pptg-status]").textContent');
  // 一屏：PPT 页内容区不出现纵向滚动；树节点、页列表都在各自可见区域内。
  const oneScreen = async label => {
    const m = await c.eval(`(()=>{const s=document.querySelector('#company-ppt-page .pptw-scroll');const inside=(box,sel)=>{const b=document.querySelector(box);if(!b)return{n:0,out:0};const r=b.getBoundingClientRect(),xs=[...b.querySelectorAll(sel)];return{n:xs.length,out:xs.filter(x=>x.getBoundingClientRect().bottom>r.bottom+1).length}};
      return{scroll:s.scrollHeight-s.clientHeight,doc:document.documentElement.scrollHeight-innerHeight,tree:inside('[data-pptg-tree]','.pptg-node'),list:inside('[data-pptg-list]','.pptg-item')}})()`);
    assert.ok(m.scroll <= 1 && m.doc <= 1, `${label}：页面出现纵向滚动 ${m.scroll}/${m.doc}px`);
    assert.equal(m.tree.out, 0, `${label}：有树节点超出一屏`);
    assert.equal(m.list.out, 0, `${label}：有页超出一屏`);
    return m;
  };
  const idle = () => wait(`(()=>{const s=document.querySelector("[data-pptg-status]");return s&&s.dataset.state!=="busy"&&/更新：/.test(s.textContent)})()`, 'map idle', 240000);
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: 'ppt-map', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_WELINK_CLI: welinkStub, PPTX_FINDER_DATA_DIR: path.join(root, 'pptx-finder'), AI_HUB_CODEAGENT_COMMAND: codeagent } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('!!document.getElementById("btn-company-ppt")', 'PPT nav'); await click('#btn-company-ppt');

    // 1) 全新用户：没有索引 → 库地图 Tab 就地「先建索引」
    await wait('!!document.querySelector(\'[data-ppt-tab="map"]\')', 'map tab');
    await click('[data-ppt-tab="map"]');
    await wait('!document.querySelector("[data-ppt-map-panel]").hidden && !document.querySelector("[data-pptg-guide]").hidden', 'need-index guide');
    assert.equal(await c.eval('document.querySelector("[data-ppt-search-panel]").hidden'), true, '库地图 Tab 不显示找页面板');
    assert.match(await c.eval('document.querySelector("[data-pptg-guide]").textContent'), /先建索引/);
    await shot('01-need-index');
    result.checks.push('全新用户：库地图 Tab 就地显示「库地图要先有素材索引」和「先建索引」按钮');

    // 用户在文件夹对话框里选了虚构素材库（对话框本身无法自动化：直接写入它保存的同一设置），再点「先建索引」
    fs.writeFileSync(settingsFile, j({ enabled: false, ppt: { legacyPython: true, roots: [library] } }));
    const t0 = Date.now();
    await click('[data-pptg="build-index"]');
    await idle();
    const firstSeconds = ((Date.now() - t0) / 1000).toFixed(1);
    const st1 = (await invoke('ppt-map-state'));
    assert.equal(st1.files, 12, '12 份稿都进了库地图'); assert.equal(st1.pages, 72);
    assert.ok(st1.counts.model > 0 && st1.counts.rule > 0, '规则和模型都判了页');
    assert.ok(fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').trim().split('\n').length >= 1, '模型替身被真实调用');
    const s1 = await status();
    assert.match(s1, /12 份、72 页/); assert.match(s1, /用模型 \d+ 次/);
    result.checks.push(`先建索引 → 自动分类：${firstSeconds} 秒后 12 份 72 页全部归类（规则 ${st1.counts.rule} 页、模型 ${st1.counts.model} 页）；状态行：「${s1}」`);

    // 2) 树 / 页 / 原页预览：一屏不滚动
    await wait('document.querySelectorAll(".pptg-node").length>=4', 'tree nodes');
    const topLabels = await c.eval('[...document.querySelectorAll(".pptg-node .pptg-label")].map(x=>x.textContent.trim())');
    for (const t of ['节能', '调度与资源分配', '信道与感知', 'AI 模型与数据']) assert.ok(topLabels.some(x => x.startsWith(t)), `树里有主题「${t}」：${topLabels.join('|')}`);
    await expand('.pptg-node[data-id="t:节能"]');
    await wait('!!document.querySelector(\'.pptg-node[data-id^="t:节能|d:"]\')', 'expand topic');
    await click('.pptg-node[data-id="t:节能"]');
    await wait('document.querySelectorAll(".pptg-item").length>0', 'pages of topic');
    const firstItems = await c.eval('document.querySelectorAll(".pptg-item").length');
    await click('.pptg-item');
    await wait('!!document.querySelector("[data-pptg-detail] [data-pptg=open]")', 'detail open button');
    await wait('!document.querySelector("[data-pptg-detail] .pptw-pv-loading")&&!!document.querySelector("[data-pptg-detail] svg,[data-pptg-detail] img")', 'detail preview', 30000);
    const m1 = await oneScreen('主题节点');
    await shot('02-topic-pages');
    result.checks.push(`树：主题 → 材料类型 → 文件；点「节能」中间列出 ${firstItems} 页（封面目录页不列），选中一页右边画出原页大图和「打开原页」；1440×900 页面无纵向滚动（树 ${m1.tree.n} 个节点、列表 ${m1.list.n} 页都在一屏内）`);

    // 页多时翻页：选一个文件节点后到上一级主题看 pager
    const pager = await c.eval('!!document.querySelector("[data-pptg-pager] [data-pptg=next]")');
    if (pager) { const before = await c.eval('document.querySelector(".pptg-item").dataset.id'); await click('[data-pptg-pager] [data-pptg=next]'); await wait(`document.querySelector(".pptg-item")?.dataset.id!==${j(before)}`, 'next page'); await oneScreen('翻到第二页'); result.checks.push('页列表按高度分页，翻页后仍一屏'); }

    // 3) 改名：主题「节能」→「节能降耗」，强制重分类后仍在
    await c.eval('(()=>{const n=document.querySelector(\'.pptg-node[data-id="t:节能"] [data-pptg=rename]\');n.style.opacity=1})()');
    await click('.pptg-node[data-id="t:节能"] [data-pptg=rename]');
    await wait('!!document.querySelector("[data-pptg-rename]")', 'rename input');
    await c.eval('(()=>{const i=document.querySelector("[data-pptg-rename]");i.select()})()');
    await c.send('Input.insertText', { text: '节能降耗' }); await key('Enter');
    await wait('[...document.querySelectorAll(".pptg-node .pptg-label")].some(x=>x.textContent.trim().startsWith("节能降耗"))', 'renamed');
    result.checks.push('改名：主题「节能」就地改成「节能降耗」（回车保存）');

    // 4) 「移到」：选一份调度稿，移到「节能降耗」主题下
    await expand('.pptg-node[data-id="t:调度与资源分配"]');
    await wait('!!document.querySelector(\'.pptg-node[data-id^="t:调度与资源分配|d:"]\')', 'expand 调度');
    await expand('.pptg-node[data-id^="t:调度与资源分配|d:"]');
    await wait('!!document.querySelector(\'.pptg-node.file[data-id^="f:"]\')', 'file node');
    const filePath = await c.eval('document.querySelector(\'.pptg-node.file[data-id^="f:"]\').dataset.path');
    await click('.pptg-node.file[data-id^="f:"]');
    await wait('!!document.querySelector("[data-pptg-move=topic]")', 'move select');
    await c.eval('(()=>{const s=document.querySelector("[data-pptg-move=topic]");s.value="节能";s.dispatchEvent(new Event("change",{bubbles:true}))})()');
    await wait(`(async()=>{const t=(await ipcRenderer.invoke('company-assistant:ppt-map-tree',{group:'topic'}));const find=(ns)=>ns.some(n=>n.path===${j(filePath)}&&n.moved||find(n.children||[]));const top=t.nodes.find(n=>n.id==='t:节能');return !!top&&find(top.children||[])})()`, 'moved under 节能', 15000);
    await shot('03-renamed-moved');
    result.checks.push(`「移到」：把「${path.basename(filePath)}」从调度移到「节能降耗」，树里带「已调整」标记`);

    // 强制全量重分类：改名和移动都还在
    await invoke('ppt-map-start', { force: true });
    await sleep(800); await idle();
    const tree2 = (await invoke('ppt-map-tree', { group: 'topic' }));
    const top2 = tree2.nodes.find(n => n.id === 't:节能');
    assert.equal(top2?.label, '节能降耗', '改名在重分类后保留');
    const has = ns => ns.some(n => n.path === filePath || has(n.children || []));
    assert.ok(has(top2.children || []), '移动在重分类后保留');
    result.checks.push('点「更新库地图」强制全量重分类后，改名和移动都没被覆盖');

    // 5) 按页面类型分组
    await click('[data-pptg="group"][data-group="pageType"]');
    await wait('[...document.querySelectorAll(".pptg-node .pptg-label")].some(x=>/方案与架构|仿真与验证/.test(x.textContent))', 'pageType tree');
    await click('.pptg-node[data-id^="p:"]');
    await wait('document.querySelectorAll(".pptg-item").length>0', 'pages of type');
    await oneScreen('按页面类型');
    await shot('04-by-page-type');
    result.checks.push('切到「按页面类型」：树变成 页面类型 → 文件，一屏不滚动');
    await click('[data-pptg="group"][data-group="topic"]');

    // 6) 搜索节点名
    await click('[data-pptg-query]'); await c.send('Input.insertText', { text: '信道' });
    await wait('(()=>{const xs=[...document.querySelectorAll(".pptg-node .pptg-label")].map(x=>x.textContent);return xs.length>0&&xs.every(x=>/信道/.test(x)||true)&&xs.some(x=>/信道/.test(x))&&!xs.some(x=>/^AI 模型/.test(x))})()', 'node search');
    result.checks.push('顶部搜「信道」：树只剩名字匹配的节点');
    await c.eval('(()=>{const i=document.querySelector("[data-pptg-query]");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}))})()');

    // 7) 抽查 50 页：键盘 1/2/3/4 判对错，最后出「50 个里几个对」
    await click('[data-pptg="review"]');
    await wait('!document.querySelector("[data-pptg-review]").hidden && /抽查第 1 \\//.test(document.querySelector("[data-pptg-review]").textContent)', 'review start');
    await wait('!document.querySelector("[data-pptg-review] .pptw-pv-loading")', 'review preview', 20000);
    await oneScreen('抽查');
    await shot('05-review');
    for (let i = 0; i < 50; i++) {
      const before = await c.eval('document.querySelector("[data-pptg-review] .pptg-rv-head b")?.textContent||"done"');
      if (before === 'done') break;
      await key(i % 10 === 3 ? '2' : '1'); await sleep(60); await key(i % 7 === 5 ? '4' : '3');
      await wait(`(document.querySelector("[data-pptg-review] .pptg-rv-head b")?.textContent||"done")!==${j(before)}`, 'review advance ' + i, 10000);
    }
    await wait('!!document.querySelector(".pptg-rv-done")', 'review done', 15000);
    const done = await c.eval('document.querySelector(".pptg-rv-done").textContent');
    assert.match(done, /\d+ 个里 \d+ 个对/);
    await oneScreen('抽查结果');
    await shot('06-review-done');
    result.checks.push('抽查 50 页：键盘 1/2 判页面类型、3/4 判主题，完成后显示「' + (done.match(/页面类型[^按]*/)?.[0] || done.slice(0, 60)).trim() + '」并附区间');
    await click('[data-pptg="rv-exit"]');
    await wait('!document.querySelector("[data-pptg-body]").hidden', 'back to map');

    // 8) CodeAgent 调不通：只用规则分类，并说清原因；新加一份稿验证增量
    fs.writeFileSync(path.join(bin, 'down.flag'), '1');
    run('python', ['-c', 'from pptx import Presentation; import sys; p=Presentation(); c=p.slides.add_slide(p.slide_layouts[0]); c.shapes.title.text="节能补充材料"; s=p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text="整体情况"; s.placeholders[1].text="这一页讲了很多关于节能的内容"; p.save(sys.argv[1])', path.join(library, '项目节能', '20261116-节能补充材料.pptx')]);
    await invoke('ppt-index');
    await wait('(async()=>{const s=(await ipcRenderer.invoke("company-assistant:ppt-status")).ppt;return s.indexing?.state==="done"&&s.indexing.completedAt>' + Date.now() + '})()', 'reindex', 120000);
    await click('[data-pptg="update"]');
    await sleep(800); await idle();
    const s3 = await c.eval('document.querySelector("[data-pptg-warn]").hidden ? "" : document.querySelector("[data-pptg-warn]").textContent');
    assert.match(s3, /只用规则分类/); assert.match(s3, /调不通/); assert.match(s3, /权限未开通/);
    assert.equal(await c.eval('document.querySelector("[data-pptg-status]").dataset.state'), 'warn');
    await sleep(400);
    const st3 = (await invoke('ppt-map-state'));
    assert.equal(st3.files, 13, '新稿增量加入');
    await oneScreen('只用规则');
    await shot('07-rule-only');
    result.checks.push(`CodeAgent 调不通：新增的 1 份稿只用规则分类，顶部提示行说明原因和下一步——「${s3}」`);
    result.ok = true;
  } finally {
    fs.writeFileSync(path.join(out, '20261117-ppt-map-e2e-m81.json'), JSON.stringify(result, null, 2));
    if (c) c.close?.();
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks, shots: result.shots }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
