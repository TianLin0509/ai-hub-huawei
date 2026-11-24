'use strict';
// 全量单测的文件清单：自动发现，不再手写维护（2026-11-24：手写清单 19% 的提交都要改它，仍漏了 34 个单测）。
// 范围：tests/unit-*.test.js / .mjs，加 tools/public-edition/*.test.js（公开树里没有这个目录，自然跳过）。
// 公开树裁掉的测试文件不在树里，同样自然跳过；不用另外维护公开版清单。
const fs = require('node:fs');
const path = require('node:path');

// 确实不该进全量的文件，每条写明原因。新加单测默认进全量，不用登记。
const EXCLUDE = {
};

function pick(root, dir, re) {
  let names;
  try { names = fs.readdirSync(path.join(root, dir)); } catch { return []; }
  return names.filter(name => re.test(name)).sort().map(name => `${dir}/${name}`);
}

function listUnitTests(root = path.resolve(__dirname, '..')) {
  return [...pick(root, 'tests', /^unit-.*\.test\.m?js$/), ...pick(root, 'tools/public-edition', /\.test\.js$/)]
    .filter(file => !Object.prototype.hasOwnProperty.call(EXCLUDE, file));
}

module.exports = { listUnitTests, EXCLUDE };
