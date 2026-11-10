'use strict';
// PPT 页「素材」Tab 端到端（2026-11-10）：真实隔离 Hub 窗口（无头）+ CDP 鼠标键盘；假 Doctor 文件协议；素材库与素材包是 python-pptx 合成的 pptx。
// PPT_MATERIAL_PACK=<团队素材包.pptx> 时改用真实素材包截图（文件只在本机读，不进仓库）。插入到 PowerPoint 的回包是夹具（真实 COM 另行验证）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const out = process.env.PPT_UI_OUT || path.resolve(__dirname, '../artifacts', `ppt-materials-${Date.now()}`);
function run(exe, args, options = {}) { const r = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, ...options }); assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout); return r.stdout; }

// 合成素材：Doctor 素材库 3 个（每个一份单页 material.pptx），素材包 40 页（4 类，用来翻页）。
const PY = `
import json, sys, os
from pptx import Presentation
from pptx.util import Pt
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
kind, target = sys.argv[1], sys.argv[2]
SHAPES = [MSO_SHAPE.CHEVRON, MSO_SHAPE.ROUNDED_RECTANGLE, MSO_SHAPE.RIGHT_ARROW, MSO_SHAPE.HEXAGON, MSO_SHAPE.OVAL, MSO_SHAPE.PENTAGON]
COLORS = ['C7000B', '3478F6', '7F7F7F', 'F2A900']
def deck():
    p = Presentation(); p.slide_width, p.slide_height = Pt(960), Pt(540); return p
def add(p, i, name, cat):
    s = p.slides.add_slide(p.slide_layouts[6])
    sh = s.shapes.add_shape(SHAPES[i % len(SHAPES)], Pt(380), Pt(230), Pt(200), Pt(80))
    sh.fill.solid(); sh.fill.fore_color.rgb = RGBColor.from_string(COLORS[i % len(COLORS)])
    sh.text_frame.text = name[:6]
    s.notes_slide.notes_text_frame.text = 'PPT Doctor Material v1\\n' + json.dumps({'id': 'm%d' % i, 'name': name, 'category': cat}, ensure_ascii=False)
if kind == 'doctor':
    for i, (name, cat) in enumerate([('红色栏头', '栏头与标题条'), ('蓝色圆角卡片', '容器与卡片'), ('灰色三段箭头', '箭头与流程')]):
        d = os.path.join(target, 'f%032x' % (i + 1)); os.makedirs(d)
        p = deck(); add(p, i, name, cat); p.save(os.path.join(d, 'material.pptx'))
        json.dump({'id': 'f%032x' % (i + 1), 'name': name, 'category': cat, 'created': 1}, open(os.path.join(d, 'item.json'), 'w', encoding='utf-8'), ensure_ascii=False)
else:
    p = deck(); cats = ['栏头与标题条', '箭头与流程', '编号·标签·胶囊', '光带·托板·展台']
    for i in range(40): add(p, i, '合成素材%02d' % (i + 1), cats[i % 4])
    p.save(target)
`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-materials-e2e-')), dataDir = path.join(root, 'data'), assistantDir = path.join(dataDir, 'company-assistant'), doctorDir = path.join(root, 'doctor');
  const finderDir = path.join(root, 'pptx-finder'), materialsDir = path.join(finderDir, 'materials'), staging = path.join(root, 'staging');
  for (const dir of [assistantDir, doctorDir, materialsDir, staging, out]) fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(doctorDir, 'PPT-Doctor.exe'), db = path.join(root, 'index.db'), deckFile = path.join(root, '20261110-素材Tab-测试稿.pptx');
  run(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/reference:System.Web.Extensions.dll', '/out:' + exe, path.join(__dirname, 'fixtures/ppt-doctor-ui.cs')]);
  const pyFile = path.join(root, 'make_materials.py'); fs.writeFileSync(pyFile, PY, 'utf8');
  run('python', ['-I', pyFile, 'doctor', staging]);
  const pack = process.env.PPT_MATERIAL_PACK || path.join(root, '20261110-合成素材包.pptx');
  if (!process.env.PPT_MATERIAL_PACK) run('python', ['-I', pyFile, 'pack', pack]);
  run('python', ['-c', 'from pptx import Presentation; import sys; r=Presentation(); s=r.slides.add_slide(r.slide_layouts[1]); s.shapes.title.text="Overview"; r.save(sys.argv[1])', deckFile]);
  fs.writeFileSync(db, 'synthetic Doctor index marker');
  const fixture = { status: { available: true, indexPath: db, indexUpdatedAt: Date.now(), indexed_pages: 1, file_status_counts: [{ status: 'ok', files: 1 }], documents: [{ path: deckFile, page_count: 1 }], scope: {}, warnings: [] }, search: { candidates: [], queries: [], truncated: false, scope: {} }, read: { pages: [], missing: [], scope: {}, truncated: false } };
  fs.writeFileSync(path.join(doctorDir, 'fixture.json'), j(fixture));
  fs.writeFileSync(path.join(doctorDir, 'hub-api.json'), j({ apiVersion: 1, executable: 'PPT-Doctor.exe', exeSha256: hash(fs.readFileSync(exe)), capabilities: ['status', 'search', 'read'] }));
  fs.writeFileSync(path.join(assistantDir, 'settings.json'), j({ enabled: false, ppt: { doctorExe: exe, db, roots: [root] } }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  const result = { provenance: '真实隔离Hub/CDP鼠标键盘 + 假Doctor文件协议 + 合成素材pptx' + (process.env.PPT_MATERIAL_PACK ? '（素材包为本机真实团队素材包）' : '') + '；插入PowerPoint回包为夹具', root, checks: [], shots: [] };
  let hub, c;
  const wait = async (expr, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(250); } throw new Error('timeout: ' + label); };
  const click = async selector => { const r = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw new Error('missing selector '+${j(selector)});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 }); };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const target = path.join(out, `20261110-ppt-materials-${name}-claude.png`); fs.writeFileSync(target, Buffer.from(image.data, 'base64')); result.shots.push(target); };
  // 一屏：PPT 页内容区不出现纵向滚动，网格里的卡片都在网格可见区域内。
  const oneScreen = async label => {
    const m = await c.eval(`(()=>{const s=document.querySelector('#company-ppt-page .pptw-scroll'),g=document.querySelector('[data-pptm-grid]'),gb=g.getBoundingClientRect();const cards=[...g.querySelectorAll('.pptm-card')];return{scroll:s.scrollHeight-s.clientHeight,cards:cards.length,outside:cards.filter(x=>x.getBoundingClientRect().bottom>gb.bottom+1).length}})()`);
    assert.ok(m.scroll <= 1, `${label}：页面出现纵向滚动 ${m.scroll}px`);
    assert.equal(m.outside, 0, `${label}：有卡片超出一屏`);
    return m;
  };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: 'ppt-materials', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_WELINK_CLI: welinkStub, PPTX_FINDER_DATA_DIR: finderDir } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('!!document.getElementById("btn-company-ppt")', 'PPT nav'); await click('#btn-company-ppt');
    await wait('document.querySelector("[data-ppt-status]")?.dataset.state === "ready"', 'Doctor status');

    // 1) 全新用户：素材库空 → 就地引导，主按钮打开 Doctor 下载团队素材包
    await click('[data-ppt-tab="materials"]');
    await wait('!document.querySelector("[data-ppt-materials-panel]").hidden && !!document.querySelector(".pptm-guide")', 'empty guide');
    assert.equal(await c.eval('document.querySelector("[data-ppt-search-panel]").hidden'), true, '素材 Tab 不显示找页面板');
    assert.match(await c.eval('document.querySelector(".pptm-guide").textContent'), /打开 PPT Doctor 下载团队素材包/);
    assert.match(await c.eval('document.querySelector(".pptm-guide").textContent'), /已有素材包文件/);
    await shot('01-empty');
    result.checks.push('空素材库：素材 Tab 就地显示引导卡，一键打开 Doctor 下载素材包 + 直接打开素材包文件');

    // 2) 用户在 Doctor 里导入后（这里直接写进 Doctor 素材库目录），不用刷新，5 秒内自动出现
    for (const name of fs.readdirSync(staging)) fs.renameSync(path.join(staging, name), path.join(materialsDir, name));
    await wait('document.querySelectorAll(".pptm-card").length===3', 'doctor materials auto appear', 15000);
    await wait('[...document.querySelectorAll(".pptm-card .pptm-thumb")].every(t=>t.querySelector("svg path,svg polygon,svg rect+*"))', 'svg previews', 20000);
    assert.equal(await c.eval('document.querySelectorAll(".pptm-cat").length'), 4, '全部 + 3 个分类');
    assert.match(await c.eval('document.querySelector("[data-pptm-detail]").textContent'), /PPT Doctor 素材库/);
    await shot('02-doctor-library');
    result.checks.push('Doctor 素材库：导入后无需手动刷新，3 个素材按分类出现，读 material.pptx 画出形状预览');

    // 3) 打开团队素材包（拖入同一入口），翻页、分类、筛选都在一屏内
    const added = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-material-pick-pack',{file:${j(pack)}})`);
    assert.ok(added.ok && added.added >= 40, '素材包读到素材');
    await click('[data-pptm="refresh"]');
    await wait('!!document.querySelector("[data-pptm-pager] [data-pptm=next]")', 'pager');
    await wait('[...document.querySelectorAll(".pptm-card .pptm-thumb")].every(t=>!t.querySelector(".pptw-pv-loading"))', 'pack previews', 30000);
    const m1 = await oneScreen('全部素材首页');
    await shot('03-all');
    const pageText = await c.eval('document.querySelector("[data-pptm-pager] span").textContent');
    await click('[data-pptm="next"]'); await wait(`document.querySelector("[data-pptm-pager] span").textContent!==${j(pageText)}`, 'next page');
    await oneScreen('翻到第二页');
    result.checks.push(`素材包：读到 ${added.added} 个；每页 ${m1.cards} 张按高度算、可翻页，1440×900 下页面无纵向滚动`);
    await click('.pptm-cat[data-cat="箭头与流程"]');
    const cat = await c.eval('document.querySelector(".pptm-cat.on span").textContent');
    await wait(`[...document.querySelectorAll(".pptm-card")].length>0`, 'category filter');
    await click('.pptm-card:nth-child(2)');
    await wait(`document.querySelector("[data-pptm-detail] .pptw-tag").textContent===${j(cat)}`, 'detail category');
    await wait('!document.querySelector("[data-pptm-detail] .pptw-pv-loading")', 'detail preview', 20000);
    await oneScreen('分类筛选');
    await shot('04-category-detail');
    await click('[data-pptm-query]'); await c.send('Input.insertText', { text: '箭头' });
    await wait('[...document.querySelectorAll(".pptm-card")].every(x=>/箭头/.test(x.title))&&document.querySelectorAll(".pptm-card").length>0||!!document.querySelector("[data-pptm-grid] .pptw-empty")', 'name filter');
    result.checks.push(`分类「${cat}」筛选、选中显示大图与来源；名称筛选「箭头」只剩匹配项`);
    await click('.pptm-cat[data-cat=""]');
    await c.eval('(()=>{const i=document.querySelector("[data-pptm-query]");i.value="";i.dispatchEvent(new Event("input"))})()');
    await sleep(400);

    // 4) 一键插入：点按钮 → 主进程按素材文件与页码调 PowerPoint（回包为夹具，真实 COM 另验）
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__mCalls=[];ipcRenderer.invoke=(ch,a)=>{if(ch==='company-assistant:ppt-material-insert'||ch==='company-assistant:ppt-material-copy'){window.__mCalls.push([ch,a.id]);return Promise.resolve(ch.endsWith('insert')?{ok:true,mode:'insert',target:'汇报稿.pptx',page:3,count:1}:{ok:true,mode:'copy',count:1})}return invoke(ch,a)}})()`);
    await click('.pptm-card:nth-child(1)');
    const picked = await c.eval('document.querySelector(".pptm-card.on").dataset.id');
    await click('[data-pptm="insert"]');
    await wait('/已插入到「汇报稿.pptx」第 3 页/.test(document.querySelector("[data-ppt-notice]").textContent)', 'insert notice');
    await click('[data-pptm="copy"]');
    await wait('/Ctrl\\+V/.test(document.querySelector("[data-ppt-notice]").textContent)', 'copy notice');
    assert.deepEqual(await c.eval('window.__mCalls'), [['company-assistant:ppt-material-insert', picked], ['company-assistant:ppt-material-copy', picked]]);
    await shot('05-inserted');
    result.checks.push('选中素材 → 插入到当前 PPT / 复制形状：按选中编号调用，结果提示写明目标文稿和页码');

    // 5) 切回找页：找页面板照旧，素材面板隐藏
    await click('[data-ppt-tab="find"]');
    await wait('document.querySelector("[data-ppt-materials-panel]").hidden && !document.querySelector("[data-ppt-search-panel]").hidden', 'back to find');
    result.checks.push('切回「找页」Tab：原找页界面不受影响');
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    if (c) { try { result.lastNotice = await c.eval('document.querySelector("[data-ppt-notice]")?.textContent'); await shot('failed'); } catch (captureError) { result.captureError = captureError.message; } }
    throw error;
  } finally {
    if (c) await c.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261110-ppt-materials-evidence-claude.json'), JSON.stringify(result, null, 2));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 隔离目录删不掉时留在系统临时目录 */ }
  }
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
