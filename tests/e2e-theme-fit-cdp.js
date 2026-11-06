'use strict';
// 回归（5.5.10）：新外观在 6 个主题下都能读、都协调。逐个主题冷启动，在主页、会话（卡片工作中 + 问一下抽屉）、账号、会议页里检查：
// 正文文字（颜色 = 该主题 --hw-text-1 / -2 / -on）与实际背景的对比度 ≥ 4.5；深色主题的新外观区域里没有灰白大块（写死的浅色）。
// 隔离数据、后台离屏窗口、假 CodeAgent，不调模型。改前（b0cd7940f）实测：深色会话页 6 处低对比、14 块浅色，会失败。
// 用法：node tests/e2e-theme-fit-cdp.js [--entry <检出>] [--out <目录>]
const assert = require('node:assert/strict');
const path = require('node:path');
const { run, THEMES } = require('./capture-theme-fit-cdp');
const REPO = path.resolve(__dirname, '..');
const opt = { entry: REPO, out: path.join(REPO, 'artifacts', 'theme-fit-e2e-' + Date.now()) };
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = path.resolve(process.argv[i + 1]);

(async () => {
  const result = await run({ ...opt, themes: THEMES, pages: ['home', 'session', 'accounts', 'meeting'], width: 1440, height: 900 });
  assert.ok(result.ok, 'capture finished: ' + (result.error || ''));
  assert.deepEqual(result.errors, [], 'every page opened');
  assert.equal(result.shots.length, THEMES.length * 4);
  const bad = result.shots.filter(s => s.lowCount || s.lightCount).map(s => ({ theme: s.theme, page: s.page, low: s.low.slice(0, 3), light: s.light.slice(0, 3) }));
  for (const s of result.shots) assert.ok(s.checked >= 10, `${s.theme}/${s.page} checked only ${s.checked} text elements`);
  assert.deepEqual(bad, [], 'low-contrast text or light blocks:\n' + JSON.stringify(bad, null, 1));
  console.log(`PASS ${result.shots.length} theme × page checks, ${result.shots.reduce((n, s) => n + s.checked, 0)} text elements ≥ 4.5, no light blocks in dark themes`);
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
