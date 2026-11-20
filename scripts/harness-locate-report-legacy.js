'use strict';
// 新旧对照 · 旧的一边（2026-11-20，HUB-H 第一期）：只调各 CLI 原来的查找函数，看它们在这台电脑上各自返回什么。
// 可以单独拷到基线代码（v5.6.71 及以前）的 scripts/ 下运行，和新代码里的 scripts/harness-locate-report.js 的 compat 段逐项 diff。
// 只读：不写任何文件、不改环境变量和设置；不起 CLI 进程（旧查找本身只看文件；只有找 Node 时会跑 node --version）。
//
// 用法：node scripts/harness-locate-report-legacy.js [--json]
//   默认打印一张表 + 打码后的 JSON；--json 只打印 JSON。
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const req = rel => require(path.join(ROOT, rel));

function sanitize(text, env = process.env) {
  let s = String(text == null ? '' : text);
  const vars = [['LOCALAPPDATA', env.LOCALAPPDATA], ['APPDATA', env.APPDATA], ['USERPROFILE', env.USERPROFILE || os.homedir()]]
    .filter(([, v]) => v && v.length > 3).sort((a, b) => b[1].length - a[1].length);
  const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [name, value] of vars) for (const v of new Set([value, value.replace(/\\/g, '/'), value.replace(/\\/g, '\\\\')])) s = s.replace(new RegExp(esc(v), 'gi'), `%${name}%`);
  s = s.replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+(?=[\\/])/gi, '$1<user>');
  let user = env.USERNAME || '';
  try { user = user || os.userInfo().username; } catch { /* 读不到 */ }
  if (user && user.length >= 2) s = s.replace(new RegExp(`(^|[\\\\/\\s:"'])${esc(user)}(?=$|[\\\\/\\s."'])`, 'gi'), '$1<user>');
  return s;
}

// 旧入口逐个调一遍；某个函数在这个版本里没有就记 missing，出错记 error，不中断。
function collect(env = process.env) {
  const out = {};
  const call = (key, fn) => {
    try { const v = fn(); out[key] = v === undefined ? null : v; }
    catch (error) { out[key] = { error: String(error && error.message || error).slice(0, 300) }; }
  };
  const setup = () => req('core/community-setup');
  for (const cmd of ['claude', 'codex', 'gemini', 'kimi', 'codeagent', 'node', 'dsh', 'pi', 'agy']) call(`findCommand.${cmd}`, () => setup().findCommand(cmd, env, process.platform));
  call('resolveClaudeExe', () => req('core/account-adapters').resolveClaudeExe(env));
  call('userClaude', () => req('core/cli-tools/registry').userClaude(env));
  call('locateWindowsCodex', () => req('main/codex-windows-command').locateWindowsCodex(env));
  call('resolveWindowsCodex.command', () => req('main/codex-windows-command').resolveWindowsCodex(env).command);
  call('dsh.diagnose', () => {
    const d = req('core/dsh-cli-profile').diagnoseDshRuntime({}, env);
    return { state: d.state, core: d.core && { root: d.core.root, version: d.core.version }, tui: d.tui && { root: d.tui.root, version: d.tui.version }, desktop: d.desktop || null, missing: d.missing, wrong: d.wrong };
  });
  call('dsh.runtimeEntry', () => req('core/dsh-cli-profile').resolveDshCliRuntime({}, env).entryPath);
  call('pi.resolve', () => { const r = req('core/pi-cli-profile').resolvePiRuntime(env); return r && { entryPath: r.entryPath || null, source: r.source || null, version: r.version || null, legacy: !!r.legacy }; });
  call('pi.diagnose', () => { const d = req('core/pi-cli-profile').diagnosePi(env); return { state: d.state, version: d.version || null, entryPath: d.entryPath || null, node: d.node || null }; });
  call('pi.node', () => req('core/pi-cli-profile').nodeFor(env) || null);
  call('antigravity.resolveCommand', () => req('core/antigravity-config').resolveCommand(env));
  call('localNode.findNode22', () => req('core/local-node').findNode({ env, minMajor: 22 }) || null);
  return out;
}

function main() {
  const json = process.argv.includes('--json');
  const t0 = Date.now();
  const compat = collect();
  const report = { kind: 'legacy', at: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, node: process.version, ms: Date.now() - t0, compat };
  const text = sanitize(JSON.stringify(report, null, 2));
  if (!json) {
    console.log('旧查找函数的结果（打码）：');
    for (const [k, v] of Object.entries(compat)) console.log(`  ${k.padEnd(28)} ${sanitize(typeof v === 'string' ? v : JSON.stringify(v))}`);
    console.log('');
  }
  console.log(text);
}

module.exports = { collect, sanitize };
if (require.main === module) main();
