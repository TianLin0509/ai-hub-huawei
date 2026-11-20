'use strict';
// DSH 会话启动检查（2026-11-21，HUB-H 第一期）：按 Hub 建 DSH 会话的同一套代码（core/dsh-cli-profile.js → core/acp-profiles.js）
// 在隔离目录里组装 hub-cli profile，再跑同一条命令，只把会话外壳 dsh-cli-launch.mjs 换回它包着的核心入口、末尾加 --dump-config
// （DSH 组装完 profile 树就退出，不连模型、不起界面）。看 bundles（@deepseek-ai/dsh-base + 界面包）能不能都解析到。
// 只依赖 Node 内置模块和仓库里的 core/；只写 --dsh-home 指定的目录，不碰用户自己的 ~/.dsh、全局 npm 和 PATH。
//
// 用法：node scripts/dsh-hub-boot-check.js --dsh-home <隔离目录> [--prefix <用户 npm 装法的目录>] [--hub-tools <Hub 的 tools 目录>] [--node <node.exe>]
//   --prefix     ① 用户 npm 装法：npm -g --prefix 装出来的目录（顶层有 node_modules\@deepseek-ai\dsh）
//   --hub-tools  ② Hub 自管那份：<Hub 数据目录>\tools（默认用本机 Hub 的数据目录）；给 none 跳过
//   --node       用哪份 Node 跑（默认按定位中心的同一套清单挑 24.9 以上的）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const req = rel => require(path.join(ROOT, rel));

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

function run(command, args, env, cwd, timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise(resolve => {
    execFile(command, args, { env, cwd, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : String(error.code || error.signal || 'error')) : 0, killed: !!(error && error.killed),
        stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - t0 });
    });
  });
}

function pickNode(explicit) {
  if (explicit) return explicit;
  const locator = req('core/harness-locator').get();
  const { nodeCandidates } = req('core/harness-locator/node-pick');
  const ctx = locator.ctx(req('core/harness-locator/specs').spec('dsh'));
  const local = req('core/local-node');
  for (const c of nodeCandidates(ctx)) if (local.versionAtLeast(local.nodeVersion(c.file), '24.9.0')) return c.file;
  return '';
}

async function check(label, cliRoot, { dshHome, node, toolsDir }) {
  const out = { case: label, cliRoot, ok: false };
  const caseDir = path.join(dshHome, label);
  fs.mkdirSync(caseDir, { recursive: true });
  const env = { ...process.env, AI_HUB_CLI_TOOLS_DIR: toolsDir || path.join(caseDir, 'tools'), CLAUDE_HUB_DATA_DIR: caseDir };
  delete env.AI_HUB_DSH_CLI_ROOT;
  const model = (() => { try { return req('core/acp-model-catalog').acpModelOptions('deepseek-acp')[0].id; } catch { return 'deepseek-v4-flash'; } })();
  const config = { acp: { apiKey: 'boot-check-placeholder-not-a-key', nodePath: node, providers: { 'deepseek-acp': { cliRoot, model } } } };
  let options;
  try {
    const profile = req('core/dsh-cli-profile');
    const d = profile.diagnoseDshRuntime({ cliRoot }, env);
    out.diagnose = { state: d.state, core: d.core && d.core.version, tui: d.tui && d.tui.version, missing: (d.missing || []).length };
    options = profile.buildDshCliOptions('deepseek-acp', { id: 'boot-check-' + label, cwd: caseDir }, config, caseDir, env);
  } catch (error) { out.stage = '组装'; out.error = String(error.message || error).slice(0, 600); return out; }
  const launch = options.launch;
  // 会话外壳 dsh-cli-launch.mjs 要等界面起来才返回；这里直接跑它包着的核心入口（AI_HUB_DSH_CLI_ENTRY），其余参数、环境完全一样。
  const args = launch.args.map(a => /dsh-cli-launch\.mjs$/i.test(a) ? launch.env.AI_HUB_DSH_CLI_ENTRY : a).concat(['--dump-config']);
  out.command = [launch.command, ...args].join(' ');
  out.dshHome = launch.env.DSH_HOME;
  const r = await run(launch.command, args, launch.env, caseDir);
  const text = r.stdout + '\n' + r.stderr;
  out.exit = r.code; out.ms = r.ms; out.timedOut = r.killed;
  out.bundles = { 'dsh-base': /dsh-base/.test(r.stdout), tui: /dsh-tui/.test(r.stdout) };
  out.ok = r.code === 0 && out.bundles['dsh-base'] && out.bundles.tui;
  out.keyError = (text.match(/^.*(?:Error|error|Cannot find|找不到|失败).*$/m) || [''])[0].trim().slice(0, 400);
  out.stdoutHead = r.stdout.split(/\r?\n/).slice(0, 25).join('\n');
  out.stderrHead = r.stderr.split(/\r?\n/).slice(0, 15).join('\n');
  return out;
}

async function main() {
  const dshHome = arg('--dsh-home');
  if (!dshHome) { console.error('请用 --dsh-home 指定一个隔离目录（脚本只写这里）'); process.exitCode = 2; return; }
  const home = path.resolve(dshHome);
  const node = pickNode(arg('--node'));
  if (!node) { console.error('没找到 24.9 以上的 Node，用 --node 指定'); process.exitCode = 2; return; }
  const results = [];
  const prefix = arg('--prefix');
  if (prefix) results.push(await check('user-npm', path.resolve(prefix), { dshHome: home, node }));
  const hubTools = arg('--hub-tools');
  if (hubTools !== 'none') {
    const toolsDir = hubTools ? path.resolve(hubTools) : path.join(req('core/data-dir').getHubDataDir(), 'tools');
    let dir = null;
    try { dir = req('core/cli-tools/registry').managedDshRoot({ ...process.env, AI_HUB_CLI_TOOLS_DIR: toolsDir }); } catch { dir = null; }
    results.push(dir ? await check('hub-managed', dir, { dshHome: home, node, toolsDir: path.join(home, 'hub-managed', 'tools') })
      : { case: 'hub-managed', ok: false, error: `${toolsDir} 里没有 Hub 一键安装的 DSH` });
  }
  const report = { kind: 'dsh-hub-boot-check', at: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, node, results };
  let text = JSON.stringify(report, null, 2);
  try { text = req('core/harness-locator/sanitize').sanitizeText(text); } catch { /* 打码模块不在时原样输出 */ }
  for (const r of results) console.log(`${r.ok ? '[成功]' : '[失败]'} ${r.case}：${r.ok ? `--dump-config 解析到 dsh-base 和界面包（${r.ms} ms）` : (r.error || r.keyError || `退出码 ${r.exit}`)}`);
  console.log('');
  console.log(text);
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
