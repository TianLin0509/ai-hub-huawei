'use strict';
// r54 E2E：真实隔离 Hub（后台无窗）+ 真实 PPT Doctor 2.1.x（复制一份并去掉安装包自带的识别组件，等同基础版）
// + 隔离的 Doctor 数据目录里放旧识别组件 v1.0.0 + 真实下载源（公司内源 → 阿里云 → GitHub，按 Hub 的统一下载器）。
// 只替身了系统「选择图片」对话框（直接给图片路径）。截图写到 R54_OUT（默认 D:/Temp/r54-e2e）。
// 场景 A：点转可编辑 → 开工前拦下、原地【一键更新】→ 真实下载换上 v1.2.0 → 自动接着识别。
// 场景 B：组件被换回旧版后再装配 → Doctor 真实报 OCR_COMPONENT_TOO_OLD → 只显示【一键更新并继续】→ 更新后自动续跑装配出 PPT。
// 前提：本机装有 PPT Doctor（%LOCALAPPDATA%\Programs\PPT-Doctor）且 %LOCALAPPDATA%\pptx-finder\ocr 是旧组件（或用 R54_OLD_OCR 指定）。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const LOCAL = process.env.LOCALAPPDATA;
const DOCTOR_SRC = process.env.R54_DOCTOR_DIR || path.join(LOCAL, 'Programs', 'PPT-Doctor');
const OLD_OCR = process.env.R54_OLD_OCR || path.join(LOCAL, 'pptx-finder', 'ocr');
const out = process.env.R54_OUT || 'D:/Temp/r54-e2e';
function robocopy(from, to, extra = []) {
  const r = spawnSync('robocopy.exe', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', ...extra], { windowsHide: true, encoding: 'utf8', timeout: 600000 });
  assert.ok(r.status !== null && r.status < 8, `robocopy 失败（${r.status}）：${r.stdout}${r.stderr}`);
}
function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
const marker = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8')); } catch { return null; } };

async function main() {
  assert.ok(fs.existsSync(path.join(DOCTOR_SRC, 'PPT-Doctor.exe')), '本机没有 PPT Doctor：' + DOCTOR_SRC);
  assert.equal(marker(OLD_OCR)?.assistApiVersion, undefined, '需要一份旧识别组件（没有 assistApiVersion）：' + OLD_OCR);
  fs.mkdirSync(out, { recursive: true });
  const root = path.join(out, 'run-' + Date.now()), dataDir = path.join(root, 'hub-data'), assistantDir = path.join(dataDir, 'company-assistant');
  const doctorDir = path.join(root, 'doctor'), doctorData = path.join(root, 'pptx-data'), oldCopy = path.join(root, 'ocr-old');
  for (const dir of [assistantDir, doctorData]) fs.mkdirSync(dir, { recursive: true });
  const result = { provenance: '真实隔离Hub（后台无窗）/CDP点击 + 真实PPT Doctor（去掉安装包自带组件=基础版）+ 旧组件v1.0.0 + 真实下载源；只替身了选图对话框', root, checks: [], shots: [], timings: {} };
  // 基础版 Doctor：复制安装目录，但不带 _internal\ocr（安装包自带的新组件），让 Doctor 读数据目录里的旧组件。
  robocopy(DOCTOR_SRC, doctorDir, ['/XD', path.join(DOCTOR_SRC, '_internal', 'ocr')]);
  robocopy(OLD_OCR, path.join(doctorData, 'ocr')); robocopy(OLD_OCR, oldCopy);
  const exe = path.join(doctorDir, 'PPT-Doctor.exe');
  // 一张带中英文的 PPT 截图。
  const image = path.join(root, '20261119-r54-slide.png');
  const py = spawnSync('python', ['-c', `from PIL import Image, ImageDraw, ImageFont
im=Image.new('RGB',(1280,720),'white'); d=ImageDraw.Draw(im)
big=ImageFont.truetype(r'C:/Windows/Fonts/msyh.ttc',56); small=ImageFont.truetype(r'C:/Windows/Fonts/msyh.ttc',34)
d.text((80,70),'SRS 信道估计方案对比',fill='black',font=big)
d.rectangle((80,200,600,560),outline=(52,120,246),width=4); d.text((110,240),'方案 A：LS 估计',fill='black',font=small); d.text((110,300),'吞吐提升 12%',fill='black',font=small)
d.rectangle((680,200,1200,560),outline=(52,120,246),width=4); d.text((710,240),'方案 B：MMSE 估计',fill='black',font=small); d.text((710,300),'误码率下降 30%',fill='black',font=small)
im.save(r'${image.replace(/\\/g, '/')}')`], { windowsHide: true, encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  fs.writeFileSync(path.join(assistantDir, 'settings.json'), j({ enabled: false, ppt: { doctorExe: exe } }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  let hub, c;
  const wait = async (expr, label, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(400); } throw new Error('timeout: ' + label); };
  const click = async selector => { const r = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw new Error('missing selector ${selector.replace(/'/g, '')}');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`); for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const target = path.join(out, `20261119-r54-${name}.png`); fs.writeFileSync(target, Buffer.from(image.data, 'base64')); result.shots.push(target); };
  const state = () => c.eval('document.querySelector("[data-conversion-state]")?.dataset.conversionState || ""');
  const buttons = () => c.eval('[...document.querySelectorAll(".pptw-conv-actions button")].map(b=>b.dataset.ppt+":"+b.textContent.trim())');
  const sideText = () => c.eval('document.querySelector("[data-ppt-conv-side]").textContent');
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: 'ppt-ocr-r54', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', PPTX_FINDER_DATA_DIR: doctorData, HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_WELINK_CLI: welinkStub } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait('!!document.getElementById("btn-company-ppt")', 'PPT nav'); await click('#btn-company-ppt');
    await wait('["ready","empty"].includes(document.querySelector("[data-ppt-status]")?.dataset.state)', 'Doctor status', 90000);
    const status = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-status')`);
    assert.equal(status.ppt.ocr?.assistAvailable, false, '真实 Doctor 报旧组件不支持增强转字'); assert.equal(status.ppt.ocr?.version, marker(OLD_OCR).version);
    result.checks.push(`真实 Doctor ${status.ppt.doctorVersion || ''} 状态：识别组件 v${status.ppt.ocr.version}，assistAvailable=false`);
    // 只替身选图对话框。
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__r54Restore=()=>{ipcRenderer.invoke=invoke};ipcRenderer.invoke=(ch,a)=>ch==='company-assistant:ppt-pick-image'?Promise.resolve({ok:true,imagePath:${j(image)}}):invoke(ch,a)})()`);
    await click('[data-ppt="convert-mode"]'); await wait('!document.querySelector("[data-ppt-convert-panel]").hidden', 'convert view');

    // ---- 场景 A：开工前拦下
    let t0 = Date.now();
    await click('[data-ppt="image"]');
    await wait('document.querySelector("[data-conversion-state]")?.dataset.conversionState==="needs_component"', 'precheck needs_component', 60000);
    result.timings.precheckMs = Date.now() - t0;
    assert.deepEqual(await buttons(), ['conversion-update-component:一键更新']);
    assert.match(await c.eval('document.querySelector(".pptw-conv-status").textContent'), /增强转字要先更新识别组件（约 82 MB，一键完成）/);
    assert.match(await sideText(), /v1\.0\.0 版本较旧/);
    assert.ok(!fs.existsSync(path.join(dataDir, 'company-assistant', 'ppt-imgtext')) || !fs.readdirSync(path.join(dataDir, 'company-assistant', 'ppt-imgtext')).some(d => fs.existsSync(path.join(dataDir, 'company-assistant', 'ppt-imgtext', d, 'seed.json'))), '开工前拦下：没有生成 OCR 初稿');
    assert.equal(await c.eval('document.documentElement.scrollHeight<=window.innerHeight+1'), true, '1440×900 一屏不滚动');
    await shot('A1-precheck'); result.checks.push(`A 开工前：${result.timings.precheckMs} ms 内停在「需要更新」，只有【一键更新】，没有识别、没有叫 CodeAgent`);
    t0 = Date.now();
    await click('[data-ppt="conversion-update-component"]');
    await wait('document.querySelector("[data-conversion-state]")?.dataset.conversionState==="updating"', 'updating');
    await wait('/%/.test(document.querySelector("[data-ppt=conversion-update-component]")?.textContent||"")', 'download progress', 120000).catch(() => {});
    await shot('A2-updating');
    await wait('!["updating","needs_component"].includes(document.querySelector("[data-conversion-state]")?.dataset.conversionState)', 'update finished', 900000);
    result.timings.updateMs = Date.now() - t0;
    const afterA = await state();
    result.afterUpdateState = afterA; result.afterUpdateError = await c.eval('document.querySelector(".pptw-conv-status b").textContent');
    const installed = marker(path.join(doctorData, 'ocr'));
    assert.equal(installed?.assistApiVersion, 1, '数据目录里换上了支持增强转字的组件'); assert.match(installed.version, /^1\.2\./);
    assert.deepEqual(fs.readdirSync(doctorData).filter(n => /^\.hub-ocr-|hub-old/.test(n)), [], '临时目录与旧组件已清理');
    assert.ok(['seeding', 'waiting_agent', 'error', 'building', 'done'].includes(afterA), afterA);
    await wait('["waiting_agent","error","done"].includes(document.querySelector("[data-conversion-state]")?.dataset.conversionState)', 'seed after update', 180000);
    const jobA = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-imgtext-status',{jobId:document.querySelector('[data-ppt-conversion]').dataset.jobId})`);
    assert.ok(jobA.job.seed?.seed && fs.existsSync(jobA.job.seed.seed), '更新后自动接着识别，生成了 OCR 初稿（没有重新选图）');
    await shot('A3-after-update');
    result.checks.push(`A 一键更新：${(result.timings.updateMs / 1000).toFixed(1)} 秒真实下载并换上识别组件 v${installed.version}，随后自动识别出初稿；当前状态 ${jobA.job.state}${jobA.job.error ? '（' + jobA.job.error + '）' : ''}`);

    // ---- 场景 B：装配时才发现组件过旧
    // 先让 A 停下（没有 CodeAgent 的隔离环境里 ask 会报错；有的话等它）；然后把组件换回旧版，点「先用 OCR 初稿装配」。
    await wait('document.querySelector("[data-conversion-state]")?.dataset.conversionState==="error"', 'A stops (no CodeAgent in isolated Hub)', 180000);
    assert.ok((await buttons()).some(b => b.startsWith('conversion-fallback')), 'A 停下后有「先用 OCR 初稿装配」');
    fs.renameSync(path.join(doctorData, 'ocr'), path.join(root, 'ocr-new')); robocopy(oldCopy, path.join(doctorData, 'ocr'));
    await click('[data-ppt="conversion-fallback"]');
    await wait('document.querySelector("[data-conversion-state]")?.dataset.conversionState==="needs_component"', 'build-time TOO_OLD', 180000);
    assert.deepEqual(await buttons(), ['conversion-update-component:一键更新并继续'], '只剩一个【一键更新并继续】，没有必然失败的两个按钮');
    assert.match(await c.eval('document.querySelector(".pptw-conv-status").textContent'), /一键更新后自动接着装配/);
    await shot('B1-build-too-old'); result.checks.push('B 装配时：真实 Doctor 报 OCR_COMPONENT_TOO_OLD → 界面只显示【一键更新并继续】');
    t0 = Date.now();
    await click('[data-ppt="conversion-update-component"]');
    await wait('document.querySelector("[data-conversion-state]")?.dataset.conversionState==="done"', 'resume build done', 900000);
    result.timings.updateAndBuildMs = Date.now() - t0;
    const jobB = await c.eval(`ipcRenderer.invoke('company-assistant:ppt-imgtext-status',{jobId:document.querySelector('[data-ppt-conversion]').dataset.jobId})`);
    assert.ok(jobB.job.result?.pptx && fs.existsSync(jobB.job.result.pptx), '续跑装配产出了可编辑 PPT');
    assert.equal(marker(path.join(doctorData, 'ocr'))?.assistApiVersion, 1);
    await shot('B2-resumed-done');
    result.checks.push(`B 一键更新并继续：${(result.timings.updateAndBuildMs / 1000).toFixed(1)} 秒后自动装配完成，产物 ${jobB.job.result.pptx}`);
    await c.eval('window.__r54Restore()');
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    if (c) { try { result.lastState = await state(); result.lastButtons = await buttons(); result.lastSide = await sideText(); await shot('failed'); } catch (e) { result.captureError = e.message; } }
    throw error;
  } finally {
    if (c) await c.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261119-r54-e2e-evidence.json'), JSON.stringify(result, null, 2));
    // 本次复制的 Doctor 与组件都可重建：跑完删掉（截图与证据 JSON 保留在 out 根目录）。
    if (!process.env.R54_KEEP) { try { rmrf(root); } catch (e) { console.warn('临时目录未删干净：' + e.message); } }
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
