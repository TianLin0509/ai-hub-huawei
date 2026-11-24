'use strict';
// Keep the explicit test selection outside cmd.exe's 8191-character command line.
// Node launches the runner directly; test scope and runner options stay unchanged.
// 2026-11-24：发版预检里整套单测 4 并发跑，机器忙时每趟都有 1 条不同的计时类测试超时，连挡 4 趟班次。
// 首轮失败的测试文件，等首轮结束后逐个单独重跑一次；重跑仍失败才算失败（真回归每次都会挂）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = require('../tests/unit-test-files.json');
const root = path.resolve(__dirname, '..');
const extra = process.argv.slice(2);
const reporter = './scripts/unit-failed-files-reporter.js';   // 相对 cwd；Windows 绝对路径会被当成 URL 协议
const failedOut = path.join(os.tmpdir(), `unit-failed-files-${process.pid}.json`);
const run = (args, concurrency) => spawnSync(process.execPath, [
  '--require', './core/fs-rename-retry-register.js', '--test', `--test-concurrency=${concurrency}`,
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  `--test-reporter=${reporter}`, `--test-reporter-destination=${failedOut}`,
  ...args,
], { cwd: root, stdio: 'inherit', windowsHide: true });
const readFailed = () => { try { return JSON.parse(fs.readFileSync(failedOut, 'utf8')); } catch { return null; } };

let result = run([...extra, ...files], 4);
if (result.error) console.error(result.error.message);
let code = Number.isInteger(result.status) ? result.status : 1;
const failed = code !== 0 ? readFailed() : [];
if (code !== 0 && Array.isArray(failed) && failed.length > 0 && failed.length <= 5) {
  const opts = extra.filter(a => a.startsWith('--'));
  console.log(`\n[run-unit-tests] 首轮 ${failed.length} 个测试文件有失败，逐个单独重跑一次：`);
  const still = [];
  for (const f of failed) {
    const r = run([...opts, f], 1);
    const ok = r.status === 0;
    console.log(`[run-unit-tests] ${ok ? '重跑通过' : '重跑仍失败'}：${path.relative(root, f)}`);
    if (!ok) still.push(f);
  }
  code = still.length ? 1 : 0;
  if (!still.length) console.log('[run-unit-tests] 首轮失败项单独重跑全部通过，按负载导致的偶发失败处理。');
}
try { fs.unlinkSync(failedOut); } catch {}
process.exitCode = code;
