'use strict';
// 升级进度小窗真实窗口实测（2026-11-16 r19）。-Snapshot 单测只覆盖画面；这里在私有桌面上真的弹出小窗（用户屏幕看不到），
// 用 UI Automation 走一遍：显示、0.4 秒刷新、最小化后又点图标被拉回、按钮写 decision.json、关窗写默认决定、完成/放弃/替换脚本消失后自动关。
// 同一套检查再跑两遍：WPF 加载失败退回 WinForms、界面字体缺失。用法：node tests/e2e-upgrade-window-live.js
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const { PROGRESS_UI } = require('../core/app-update/progress-ui');
if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upwin-'));
const ui = path.join(work, 'upgrade-progress.ps1'); fs.writeFileSync(ui, '\uFEFF' + PROGRESS_UI, 'utf8');
const out = path.join(work, 'results.json'), flash = path.join(work, 'flash.json');
const PS = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const r = spawnSync('python', [path.join(__dirname, 'helpers', 'window-flash-watch.py'), '--out', flash, '--grace-ms', '1500', '--',
  PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(__dirname, 'helpers', 'upgrade-window-live-driver.ps1'), '-Ui', ui, '-Work', work, '-Out', out],
  { windowsHide: true, encoding: 'utf8', timeout: 300000 });
const f = JSON.parse(fs.readFileSync(flash, 'utf8'));
const res = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
const bad = res.filter(x => !x.ok);
for (const x of res) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.check} ${x.detail}`);
console.log(`私有桌面=${f.privateDesktop} 检查 ${res.length} 项，失败 ${bad.length} 项`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(r.status === 0 && f.privateDesktop && res.length >= 50 && !bad.length ? 0 : 1);
