'use strict';
// Real Hub window + file IPC; Doctor responses are explicitly synthetic.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const port = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const out = process.env.PPT_UI_OUT || path.resolve(__dirname, '../artifacts', `ppt-ui-${Date.now()}`);
const nativeOpen = process.env.PPT_UI_NATIVE_OPEN === '1';
function run(exe, args, options = {}) { const r = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options }); assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout); return r.stdout; }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ui-m1-')), dataDir = path.join(root, 'data'), assistantDir = path.join(dataDir, 'company-assistant'), doctorDir = path.join(root, 'doctor');
  for (const dir of [assistantDir, doctorDir, out]) fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(doctorDir, 'PPT-Doctor.exe'), db = path.join(root, 'index.db'), file = path.join(root, '20261102-PPT-Hub-界面测试-m1.pptx');
  const targetFile = path.join(root, '20261102-PPT-Hub-复制目标-m1.pptx');
  run(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/reference:System.Web.Extensions.dll', '/out:' + exe, path.join(__dirname, 'fixtures/ppt-doctor-ui.cs')]);
  run('python', ['-c', 'from pptx import Presentation; import sys; r=Presentation(); [(lambda s,i: (setattr(s.shapes.title,"text",["Overview","SRS channel estimation","Closing"][i]),setattr(s.placeholders[1],"text","SRS preserves complex channel phase.")))(r.slides.add_slide(r.slide_layouts[1]),i) for i in range(3)]; r.save(sys.argv[1])', file]);
  fs.writeFileSync(db, 'synthetic Doctor index marker');
  const source = hash(path.resolve(db).toLowerCase()).slice(0, 16), id = `${source}:1:2`, ref = { source_id: source, index_id: source, file_id: 1, page: 2, path: file, name: path.basename(file), page_hash: 'page-fixture', content_hash: hash(fs.readFileSync(file)) };
  const item = { id, ref, snippet: 'SRS preserves complex channel phase.', text_chars: 36, retrieval_score: 1 / 61, matched_queries: [{ query: 'SRS', kind: 'body', rank: 1 }], duplicate_refs: [], thumbnail: null };
  const fixture = {
    status: { available: true, indexPath: db, indexUpdatedAt: Date.now(), indexed_pages: 3, file_status_counts: [{ status: 'ok', files: 1 }], documents: [{ path: file, page_count: 3 }], scope: { index_id: source }, warnings: [] },
    search: { candidates: [item], queries: [{ query: 'SRS' }], truncated: false, scope: { index_id: source } },
    read: { pages: [{ ...item, text: 'SRS preserves complex channel phase.', text_truncated: false, source_state: 'metadata_matches_index' }], missing: [], scope: { index_id: source }, truncated: false },
  };
  fs.writeFileSync(path.join(doctorDir, 'fixture.json'), j(fixture));
  fs.writeFileSync(path.join(doctorDir, 'hub-api.json'), j({ apiVersion: 1, executable: 'PPT-Doctor.exe', exeSha256: hash(fs.readFileSync(exe)), capabilities: ['status', 'search', 'read'] }));
  fs.writeFileSync(path.join(assistantDir, 'settings.json'), j({ enabled: false, ppt: { doctorExe: exe, db, roots: [root] } }));
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), j({ assistant: true, forum: false }));
  const welinkStub = path.join(root, 'welink-disabled.js');
  fs.writeFileSync(welinkStub, 'process.stdout.write(JSON.stringify({ authenticated: false, loggedIn: false }));');
  const result = { provenance: '真实隔离Hub/CDP鼠标键盘 + 假Doctor文件协议 + 合成PPT；非公司环境或真实Doctor', nativePowerPoint: nativeOpen, root, checks: [], shots: [] };
  let hub, c;
  const wait = async (expr, label, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(300); } throw new Error('timeout: ' + label); };
  const click = async selector => { const r = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw new Error('missing selector');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button: 'left', clickCount: 1 }); };
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const target = path.join(out, `20261102-ppt-${name}-m1.png`); fs.writeFileSync(target, Buffer.from(image.data, 'base64')); result.shots.push(target); };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'hidden', label: 'ppt-page-m1', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_WELINK_CLI: welinkStub } });
    c = await connectFirstPage(hub); await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await wait('!!document.getElementById("btn-company-ppt")', 'PPT nav'); await click('#btn-company-ppt');
    await wait('document.querySelector("[data-ppt-status]")?.dataset.state === "ready"', 'Doctor status');
    await wait('document.getElementById("btn-company-ppt").getAttribute("aria-current")==="page"', 'PPT navigation selection');
    assert.equal(await c.eval('document.getElementById("btn-company-ppt").getAttribute("aria-current")'), 'page');
    await click('[data-ppt-query]'); await c.send('Input.insertText', { text: 'SRS' }); await click('[data-ppt-search]');
    await wait('document.querySelectorAll("[data-ppt-result]").length===1', 'search result'); await shot('search');
    result.checks.push('公司开关下PPT左栏、Doctor状态、键盘检索、真实文件与第2页结果卡');
    assert.equal(await c.eval('document.querySelectorAll("[data-ppt-folder] option").length >= 2'), true);
    assert.equal(await c.eval('document.querySelector("[data-ppt-detail]").textContent.includes("第 2 页")'), true);
    assert.equal(await c.eval('document.querySelector("[data-ppt-detail]").getBoundingClientRect().left > document.querySelector("[data-ppt-results]").getBoundingClientRect().right'), true);
    await click('[data-ppt="convert-mode"]'); await wait('!document.querySelector("[data-ppt-convert-panel]").hidden', 'convert view'); await shot('convert');
    await click('[data-ppt="search-mode"]'); await wait('!document.querySelector("[data-ppt-search-panel]").hidden', 'search view');
    result.checks.push('A结构：素材范围、左结果右详情、转字与检索独立切换');
    if (nativeOpen) {
      await click('[data-ppt="open"]'); await wait('/已打开到第2页|已打开文件/.test(document.querySelector("[data-ppt-notice]").textContent)', 'PowerPoint slide or explicit fallback', 90000);
      result.openNotice = await c.eval('document.querySelector("[data-ppt-notice]").textContent');
      if (/已打开到第2页/.test(result.openNotice)) {
      const script = '$ErrorActionPreference="Stop"; $app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application"); $p=@($app.Presentations)|Where-Object {$_.FullName -eq $env:PPT_UI_FILE}; if(!$p){throw "presentation missing"}; $p.Windows.Item(1).View.Slide.SlideIndex';
      const actual = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, env: { ...process.env, PPT_UI_FILE: file } });
      assert.equal(Number(actual.trim()), 2); result.checks.push('真实PowerPoint打开合成测试文稿并COM确认当前页=2');
      } else { result.checks.push('原页打开回退提示可见；本环境未确认自动跳页'); }
      if (process.env.PPT_UI_COPY_CANDIDATE === '1') {
      // Candidate stays hidden until successful native verification. Only this
      // generated target may be changed when explicitly testing the candidate.
      await c.eval('document.querySelector("[data-ppt=copy]").hidden=false');
      const openTarget = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $app=New-Object -ComObject PowerPoint.Application; $p=$app.Presentations.Add(0); if($null -eq $p){throw "fixture presentation missing"}; for($n=1;$n -le 3;$n++){[void]$p.Slides.Add($n,12)}; if($p.Slides.Count -ne 3){throw "fixture slide count"}; $p.SaveAs($env:PPT_UI_TARGET); if($p.ReadOnly){throw "fixture target is read-only"}; $app.Visible=-1; $window=$p.NewWindow(); $window.Activate(); $window.View.GotoSlide(1)';
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(openTarget, 'utf16le').toString('base64')], { env: { ...process.env, PPT_UI_TARGET: targetFile } });
      const targetHash = hash(fs.readFileSync(targetFile));
      await click('[data-ppt="copy"]'); await wait('!document.querySelector("[data-ppt=copy]").disabled', 'copy current slide', 90000);
      assert.match(await c.eval('document.querySelector("[data-ppt-notice]").textContent'), /已复制到/);
      const verifyCopy = '$ErrorActionPreference="Stop"; $app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application"); $p=@($app.Presentations)|Where-Object {$_.FullName -eq $env:PPT_UI_TARGET}; if(!$p){throw "target missing"}; if($p.Slides.Count -ne 4){throw "copy count"}; if($p.Slides.Item(2).Shapes.Title.TextFrame.TextRange.Text -ne "SRS channel estimation"){throw "copy content"}; $p.Saved -eq 0';
      assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(verifyCopy, 'utf16le').toString('base64')], { timeout: 15000, env: { ...process.env, PPT_UI_TARGET: targetFile } }).trim(), 'True');
      assert.equal(hash(fs.readFileSync(file)), ref.content_hash); assert.equal(hash(fs.readFileSync(targetFile)), targetHash);
      result.checks.push('真实复制按钮：当前第1页后插入SRS第2页；目标3→4页，源文件和目标磁盘文件未改写');
      } else { assert.equal(await c.eval('document.querySelector("[data-ppt=copy]").hidden'), true); result.checks.push('复制候选尚未完成真实验收，入口隐藏'); }
    }
    // 5.5.11 起助理页不再放 PPT 素材库入口（左栏已有 PPT 页）：确认没有入口，再从左栏回到 PPT 页。
    await click('#btn-company-assistant'); await wait('!document.getElementById("company-assistant-page").hidden', 'assistant page');
    assert.equal(await c.eval('!!document.querySelector("#company-assistant-page [data-ca=ppt-assist]")'), false);
    await click('#btn-company-ppt'); await wait('!document.getElementById("company-ppt-page").hidden', 'rail back to PPT');
    result.checks.push('助理页没有PPT素材库入口；从左栏回到PPT页，检索仍保留');
    // Exercise final report layout without issuing another paid model request.
    // The separate real-Agent smoke validates actual MCP find/read/report.
    const reportFixture = { id: 'ui-report-fixture', state: 'done', a: '**已核验 1 页**\n\n| 原页 | 原文 |\n|---|---|\n| SRS 第2页 | 保留复数信道相位 |', pptResults: [{ id, name: ref.name, path: file, page: 2, reason: '原文包含信道相位' }] };
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer); window.__pptRestoreInvoke=()=>{ipcRenderer.invoke=invoke}; ipcRenderer.invoke=async(channel,args)=>{if(channel==='company-assistant:ppt-ask')return{ok:true,item:{id:'ui-report-fixture'}}; const r=await invoke(channel,args);if(channel==='company-assistant:ppt-page-state'&&args?.chatId==='ui-report-fixture')r.chat=${j(reportFixture)};return r;};})()`);
    await click('[data-ppt="ask"]'); await wait('!document.querySelector("[data-ppt-report]").hidden', 'report result');
    assert.equal(await c.eval('document.querySelector("[data-ppt-report]").open'), false);
    await shot('report-collapsed'); await click('[data-ppt-report] summary');
    assert.equal(await c.eval('document.querySelectorAll(".pptw-report-body table").length'), 1); await shot('report-expanded');
    await c.eval('window.__pptRestoreInvoke();delete window.__pptRestoreInvoke');
    result.checks.push('核验报告默认折叠、完整Markdown表格可展开（Agent回包夹具；另有真实Agent烟测）');
    const interrupted = { id: 'interrupted-ui-fixture', state: 'error', seed: {}, error: 'Doctor任务中断，请检查已有产物', needsOutputCheck: true };
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__pptRestoreInvoke=()=>{ipcRenderer.invoke=invoke};window.__pptRecoveryCalls=[];window.__pptRecoveryJob=${j(interrupted)};ipcRenderer.invoke=(channel,args)=>{if(channel==='company-assistant:ppt-pick-image')return Promise.resolve({ok:true,imagePath:'fixture.png'});if(channel==='company-assistant:ppt-imgtext-start')return Promise.resolve(window.__pptRecoveryJob);if(channel==='company-assistant:ppt-imgtext-status')return Promise.resolve({ok:true,job:window.__pptRecoveryJob});if(channel==='company-assistant:ppt-imgtext-workdir'){window.__pptRecoveryCalls.push('workdir');return Promise.resolve({ok:true})}if(channel==='company-assistant:ppt-imgtext-retry'){window.__pptRecoveryCalls.push('retry');window.__pptRecoveryJob={...window.__pptRecoveryJob,state:'done',needsOutputCheck:false,error:'',step:'恢复夹具已完成'};return Promise.resolve(window.__pptRecoveryJob)}return invoke(channel,args)}})()`);
    await click('[data-ppt="convert-mode"]'); await click('[data-ppt="image"]');
    assert.equal(await c.eval('document.querySelector("[data-ppt-report]").hidden'), true, '检索报告不能挤进转字工作区');
    await wait('!!document.querySelector("[data-ppt=conversion-workdir]")', 'interrupted write recovery');
    assert.match(await c.eval('document.querySelector("[data-ppt=conversion-retry]").textContent'), /已检查产物/);
    await shot('interrupted-recovery'); await click('[data-ppt="conversion-workdir"]'); await click('[data-ppt="conversion-retry"]');
    assert.deepEqual(await c.eval('window.__pptRecoveryCalls'), ['workdir', 'retry']);
    await wait('!!document.querySelector("[data-conversion-state=done]")', 'explicit manual recovery'); await sleep(1800);
    await click('[data-ppt="search-mode"]'); await c.eval('window.__pptRestoreInvoke();delete window.__pptRestoreInvoke');
    result.checks.push('中断转字显示产物目录与人工重试，实际点击顺序通过（故障回包与打开目录为夹具；后端防Agent重放另有单测）');
    fs.unlinkSync(path.join(doctorDir, 'hub-api.json')); await click('.pptw-settings summary'); await click('[data-ppt="refresh"]'); await wait('/请升级/.test(document.querySelector("[data-ppt-status]").textContent)', 'upgrade preflight'); await shot('upgrade');
    result.checks.push('能力标记缺失：不启动旧Doctor并显示升级入口');
    await c.eval(`(()=>{const invoke=ipcRenderer.invoke.bind(ipcRenderer);window.__pptDownloadCalls=[];ipcRenderer.invoke=(channel,args)=>{if(channel==='company-assistant:ppt-download-doctor'){window.__pptDownloadCalls.push(args.source);return Promise.resolve(args.source==='mirror'?{ok:false,error:'镜像下载暂不可用（故障夹具），请使用GitHub备用'}:{ok:true})}return invoke(channel,args)}})()`);
    await click('[data-ppt-status] [data-ppt="download"]'); await wait('/镜像下载暂不可用/.test(document.querySelector("[data-ppt-notice]").textContent)', 'mirror failure is visible');
    assert.deepEqual(await c.eval('window.__pptDownloadCalls'), ['mirror']);
    await click('[data-ppt-status] [data-ppt="download-backup"]'); assert.deepEqual(await c.eval('window.__pptDownloadCalls'), ['mirror', 'github']);
    result.checks.push('下载主入口明确走镜像；失败可见，用户点GitHub备用才切源（浏览器打开由夹具代替，解析镜像URL另有单测）');
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    if (c) { try { result.lastNotice = await c.eval('document.querySelector("[data-ppt-notice]")?.textContent'); await shot('failed'); } catch (captureError) { result.captureError = captureError.message; } }
    throw error;
  } finally {
    if (nativeOpen) {
      const script = '$ErrorActionPreference="Stop"; try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")} catch {if($_.Exception.HResult -eq -2147221021){exit 0}; throw}; for($i=$app.Presentations.Count;$i -ge 1;$i--){$p=$app.Presentations.Item($i); if(!$p.FullName){throw "Cannot verify presentation identity for cleanup"}; if($p.FullName -eq $env:PPT_UI_FILE -or $p.FullName -eq $env:PPT_UI_TARGET){if(!$p.ReadOnly){$p.Saved=-1}; $p.Close()}}';
      try { run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, env: { ...process.env, PPT_UI_FILE: file, PPT_UI_TARGET: targetFile } }); }
      catch (error) { result.cleanupError = error.message; result.ok = false; }
    }
    if (c) await c.close(); if (hub) await gracefulQuit(hub);
    fs.writeFileSync(path.join(out, '20261102-ppt-ui-evidence-m1.json'), JSON.stringify(result, null, 2));
  }
  if (result.cleanupError) throw new Error('测试文稿未确认关闭：' + result.cleanupError);
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
