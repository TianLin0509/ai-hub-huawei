'use strict';
// 英文覆盖率与词典质量（2026-11-20）：
// - core/i18n/scope.json 列出的文件里，界面中文都要在英文词典里有译文；每组允许的漏翻数（allowMissing）只许减不许增，
//   第一期完成时全部为 0。新增界面文字忘了加英文，这里就失败。
// - 英文词典里不能夹中文；句式两边的 {n} 占位要一一对应；同一原文在不同词典文件里不能给出不同译文。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ex = require('../scripts/i18n-extract.js');
const scope = ex.loadScope();
const DICT_DIR = path.join(ROOT, 'core/i18n/locales/en');

test('第一期范围：漏翻数不超过各组允许值', () => {
  const report = [];
  for (const [group, files] of Object.entries(scope.groups)) {
    // 公开版会裁掉个别成员版文件，不存在的跳过
    const present = files.filter(f => fs.existsSync(path.join(ROOT, f)));
    const missing = ex.missingEntries(present.flatMap(ex.extractFile));
    const unique = [...new Set(missing.map(m => m.text))];
    const allow = (scope.allowMissing && scope.allowMissing[group]) || 0;
    if (unique.length > allow) {
      report.push(`${group}：漏翻 ${unique.length} 条，允许 ${allow}。例：\n  ` +
        missing.slice(0, 8).map(m => `${m.file}:${m.line} ${m.text}`).join('\n  '));
    }
  }
  assert.strictEqual(report.length, 0, '下列文字没有英文译文（补进 core/i18n/locales/en/*.json，或确属不翻的登记到 core/i18n/ignore.json）：\n' + report.join('\n'));
});

test('英文词典：无中文、占位对应、同一原文译法一致', () => {
  const seen = new Map();
  const problems = [];
  for (const file of fs.readdirSync(DICT_DIR).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(DICT_DIR, file), 'utf8'));
    for (const [src, dst] of Object.entries(data)) {
      if (src.startsWith('//')) continue;
      if (typeof dst !== 'string' || !dst.trim()) { problems.push(`${file} 空译文：${src}`); continue; }
      if (/[㐀-鿿豈-﫿]/.test(dst)) problems.push(`${file} 译文含中文：${src} → ${dst}`);
      const a = (src.match(/\{\d+\}/g) || []).sort().join();
      const b = (dst.match(/\{\d+\}/g) || []).sort().join();
      if (a !== b) problems.push(`${file} 占位不对应：${src} → ${dst}`);
      if (seen.has(src) && seen.get(src).dst !== dst) problems.push(`${file} 与 ${seen.get(src).file} 译法不同：${src}`);
      seen.set(src, { file, dst });
    }
  }
  assert.deepStrictEqual(problems, []);
});
