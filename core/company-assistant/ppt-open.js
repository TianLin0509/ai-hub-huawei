'use strict';
const { spawn } = require('node:child_process');

// Invoked only by a user's Open-page click, after the index resolves the file.
// Keep existing PowerPoint documents open; neither process nor presentation is closed.
async function openSlide(file, page) {
  if (process.platform !== 'win32' || !/\.pptx?$/i.test(file)) return false;
  const script = [
    '$ErrorActionPreference="Stop"',
    '$file=[Environment]::GetEnvironmentVariable("HUB_PPT_OPEN_FILE")',
    '$page=[int][Environment]::GetEnvironmentVariable("HUB_PPT_OPEN_PAGE")',
    'try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application") } catch { $app=New-Object -ComObject PowerPoint.Application }',
    '$presentation=$null',
    'foreach ($candidate in $app.Presentations) { if ($candidate.FullName -eq $file) { $presentation=$candidate; break } }',
    'if ($null -eq $presentation) { $presentation=$app.Presentations.Open($file,$true,$false,$true) }',
    'if ($page -lt 1 -or $page -gt $presentation.Slides.Count) { throw "索引页码已超出当前文稿，请更新索引" }',
    '$app.Visible=-1',
    '$presentation.Windows.Item(1).Activate()',
    '$presentation.Windows.Item(1).View.GotoSlide($page)',
  ].join('\n');
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, HUB_PPT_OPEN_FILE: file, HUB_PPT_OPEN_PAGE: String(page) } });
    const timeout = setTimeout(() => { child.kill(); resolve(false); }, 60000);
    child.on('error', () => { clearTimeout(timeout); resolve(false); });
    child.on('close', code => { clearTimeout(timeout); resolve(code === 0); });
  });
}

// A user's Copy click inserts into the active editable deck without saving it.
// It never opens/closes the user's other presentations or uses the clipboard.
async function copySlide(file, page) {
  if (process.platform !== 'win32') throw new Error('复制到当前 PPT 需要 Windows PowerPoint');
  if (!/\.pptx?$/i.test(file)) throw new Error('只有 PPT 文稿页面可以复制到当前 PPT');
  if (!Number.isInteger(page) || page < 1) throw new Error('原稿页码无效，请重新检索');
  const script = [
    '$ErrorActionPreference="Stop"',
    '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)',
    'try {',
    'try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")} catch {throw "先打开目标 PPT"}',
    'try {$target=$app.ActivePresentation} catch {throw "先打开目标 PPT"}',
    'if ($null -eq $target) {throw "先打开目标 PPT"}',
    'if ($target.ReadOnly) {throw "当前 PPT 是只读文稿，请先打开可编辑的目标 PPT"}',
    '$slides=$target.Slides',
    'if ($null -eq $slides) {throw "PowerPoint 尚未准备好目标 PPT，请切换到目标文稿后重试"}',
    '$file=[Environment]::GetEnvironmentVariable("HUB_PPT_COPY_FILE")',
    '$page=[int][Environment]::GetEnvironmentVariable("HUB_PPT_COPY_PAGE")',
    '$after=0',
    'if ($slides.Count -gt 0) {try {$after=$app.ActiveWindow.View.Slide.SlideIndex} catch {try {$after=$app.ActiveWindow.Selection.SlideRange.Item(1).SlideIndex} catch {throw "请先在目标 PPT 中选中插入位置那一页"}}}',
    '$inserted=$slides.InsertFromFile($file,$after,$page,$page)',
    'if ($inserted -ne 1) {throw "PowerPoint 未确认插入成功，请检查目标 PPT 后再重试"}',
    '@{ok=$true;page=$after+1;target=$target.Name;sourcePage=$page}|ConvertTo-Json -Compress',
    '} catch { @{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress; exit 1 }',
  ].join('\n');
  return new Promise((resolve, reject) => {
    let settled = false, stdout = '';
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PPT_COPY_FILE: file, HUB_PPT_COPY_PAGE: String(page) } });
    const timer = setTimeout(() => { child.kill(); finish(new Error('复制等待超过一分钟，请先查看目标 PPT，确认未插入后再重试')); }, 60000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 65536) { child.kill(); finish(new Error('复制返回内容异常，请检查目标 PPT 后再重试')); }
    });
    child.stderr.resume();
    child.on('error', error => finish(new Error('PowerPoint 复制未能启动：' + error.message)));
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.trim());
        if (code !== 0 || result.ok !== true) throw new Error(result.error || 'PowerPoint 复制没有完成，请检查目标 PPT');
        finish(null, result);
      } catch (error) { finish(new Error(error instanceof SyntaxError ? 'PowerPoint 未返回复制结果，请检查目标 PPT 后再重试' : error.message)); }
    });
  });
}

module.exports = { openSlide, copySlide };
