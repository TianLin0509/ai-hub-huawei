'use strict';
// 新旧对照 · 新的一边（2026-11-20，HUB-H 第一期）：不依赖 Electron，用 Node 直接跑定位中心，输出打码的 JSON 和一张人能看的表。
// compat 段用和 scripts/harness-locate-report-legacy.js 完全相同的调用（旧函数现在转调定位中心），同一台电脑上两边的 compat 可以直接 diff。
// 只读：不写任何文件（定位中心不落盘）、不改环境变量和设置；会用将来启动的同一条命令跑一次各 CLI 的 --version（隐藏窗口、10 秒超时）。
//
// 用法：node scripts/harness-locate-report.js [--json] [--ids dsh,pi] [--data-dir <Hub 数据目录>]
//   --data-dir  读这个目录里的手动路径（harness-locator/state.json、tool-discovery.json），只读不写；默认不读。
//   想让定位中心多看一个 npm 目录：设环境变量 NPM_CONFIG_PREFIX=<目录> 再运行（不改全局 npm 设置）。
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
  const json = process.argv.includes('--json');
  const ids = (arg('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
  const dataDir = arg('--data-dir');
  const harness = require(path.join(ROOT, 'core', 'harness-locator'));
  const locator = harness.configure({ dataDir: dataDir ? path.resolve(dataDir) : null });
  locator.saveState = () => {}; // 只读
  const t0 = Date.now();
  const results = await locator.locateAll({ fresh: true, reason: 'manual', ...(ids.length ? { ids } : {}) });
  const ms = Date.now() - t0;
  const compat = require(path.join(ROOT, 'scripts', 'harness-locate-report-legacy.js')).collect();
  const slim = {};
  for (const [id, r] of Object.entries(results)) {
    slim[id] = { verdict: r.verdict, reasonCode: r.reasonCode, reason: r.reason, chosen: r.chosen, launch: locator.launchSpec(id) ? (({ command, args, shell, node }) => ({ command, args, shell, node }))(locator.launchSpec(id)) : null,
      candidates: r.candidates.map(c => ({ path: c.path, source: c.source, verdict: c.verdict, reasonCode: c.reasonCode, version: c.version, node: c.runtime && c.runtime.node, nodeVersion: c.runtime && c.runtime.nodeVersion, reason: c.reason })),
      checked: r.checked, fixes: r.fixes.map(f => f.act), durationMs: r.durationMs };
  }
  const report = { kind: 'harness-locator', at: new Date().toISOString(), platform: `${process.platform} ${os.release()}`, node: process.version, ms, results: slim, compat };
  const text = harness.sanitizeText(JSON.stringify(report, null, 2));
  if (!json) {
    const V = { ok: '能用', unavailable: '暂时不可用', 'too-old': '版本太低', broken: '跑不起来', 'not-found': '没找到' };
    console.log(`定位中心结果（${ms} ms，打码）：`);
    console.log(['CLI'.padEnd(12), '结论'.padEnd(8), '版本'.padEnd(14), '来源'.padEnd(16), '路径 · 说明'].join(' '));
    for (const [id, r] of Object.entries(results)) {
      const c = r.chosen || {};
      const node = c.runtime && c.runtime.node ? ` · Node ${c.runtime.nodeVersion || '?'}（${c.runtime.nodeSource}）` : '';
      console.log(harness.sanitizeText([id.padEnd(12), (V[r.verdict] || r.verdict).padEnd(8), String(c.version || '').padEnd(14), String(c.source || '').padEnd(16),
        `${c.path || ''}${node}${r.verdict !== 'ok' ? ' · ' + r.reason : ''}${r.candidates.length > 1 ? ` · 共 ${r.candidates.length} 份` : ''}`].join(' ')));
    }
    console.log('');
    console.log(locator.diagnosisText(Object.keys(results)));
    console.log('');
  }
  console.log(text);
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
