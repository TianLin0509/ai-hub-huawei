'use strict';
// 2026-11-24 同事反馈：AI 做 PPT 时把用户自己开着的 PPT 全关了，未保存修改可能丢。
// 守住两件事：① Hub 自带的 PPT 脚本不按进程名结束 PowerPoint、不退出 PowerPoint、不关闭全部演示文稿；
// ② 发给 CodeAgent 的做页 / 找页规则和组队技能都带上「只关自己打开的那一份」这条底线。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

const root = path.join(__dirname, '..');
function walk(dir, keep, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '__pycache__') walk(file, keep, out); }
    else if (keep(entry.name)) out.push(file);
  }
  return out;
}
// Hub 里所有会驱动 PowerPoint 的代码与随 Hub 下发给 CodeAgent 的技能文本。
const sources = [
  ...walk(path.join(root, 'core', 'company-assistant'), n => /\.(js|py|ps1|md)$/i.test(n)),
  ...walk(path.join(root, 'core', 'codeagent-skills'), n => /\.(md|py|ps1|js)$/i.test(n)),
  ...walk(path.join(root, 'renderer'), n => /ppt/i.test(n) && /\.js$/i.test(n)),
];
const FORBIDDEN = [
  ['按进程名结束 PowerPoint', /(taskkill|Stop-Process|Get-Process|kill)[^\n]{0,80}POWERPNT/i],
  ['按进程名结束 PowerPoint', /POWERPNT[^\n]{0,80}(Stop-Process|taskkill|\.Kill\(|\.kill\()/i],
  ['退出 PowerPoint 应用', /\$app\.Quit|\bapp\.Quit\s*\(|PowerPoint[^\n]{0,60}\.Quit\s*\(/],
  ['关闭全部演示文稿', /foreach\s*\([^)]*\$app\.Presentations\)\s*\{[^}]*\.Close\(\)/i],
  ['关闭全部演示文稿', /for\s*\(\s*\$i\s*=\s*\$app\.Presentations\.Count[^\n]*\.Close\(\)/i],
  ['关闭当前活动文稿', /ActivePresentation\.Close\s*\(/i],
];

test('静态检查能认出常见的违规写法（样例在运行时拼出，只做字符串匹配）', () => {
  const P = 'POWER' + 'PNT', kill = 'Stop-' + 'Process';
  const samples = [`task${'kill'} /F /IM ${P}.EXE`, `${kill} -Name ${P} -Force`, `Get-Process ${P} | ${kill}`, '$app.' + 'Quit()', 'app.' + 'Quit()',
    'foreach ($p in $app.Presentations) { $p.' + 'Close() }', '$app.ActivePresentation.' + 'Close()'];
  for (const sample of samples) assert.ok(FORBIDDEN.some(([, re]) => re.test(sample)), sample);
  assert.ok(!FORBIDDEN.some(([, re]) => re.test('if ($null -ne $src) { $src.Close(); $src=$null }')), '只关自己打开的那份不算违规');
});

test('Hub 的 PPT 代码与技能文本里没有按进程名结束、退出或关闭全部 PowerPoint 的写法', () => {
  assert.ok(sources.length > 10, '扫描范围不应为空');
  const hits = [];
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [what, re] of FORBIDDEN) if (re.test(text)) hits.push(`${path.relative(root, file)}：${what}`);
  }
  assert.deepEqual(hits, []);
});

test('素材插入只关自己以只读、无窗口方式打开的那一份；用户开着的同一份直接复用不关', () => {
  const src = fs.readFileSync(path.join(root, 'core', 'company-assistant', 'ppt-materials.js'), 'utf8');
  assert.match(src, /foreach \(\$p in \$app\.Presentations\) \{ if \(\$p\.FullName -eq \$file\)/);
  assert.match(src, /\$src=\$app\.Presentations\.Open\(\$file,-1,0,0\)/, 'ReadOnly=-1、Untitled=0、WithWindow=0');
  const closes = src.match(/[$\w.]+\.Close\(\)/g) || [];
  assert.ok(closes.length >= 1);
  assert.deepEqual([...new Set(closes)], ['$src.Close()'], '只关闭本次打开的 $src，不关 $own、$target');
});

test('打开原页只打开或复用那一份，不关闭任何文稿', () => {
  const src = fs.readFileSync(path.join(root, 'core', 'company-assistant', 'ppt-open.js'), 'utf8');
  assert.doesNotMatch(src, /\.Close\(\)|\.Quit\(/);
});

test('发给 CodeAgent 的做页、找页规则和组队技能都带上只关自己那一份的底线', () => {
  const { PPT_INSTRUCTIONS } = require('../core/company-assistant/ppt-instructions');
  for (const text of [PPT_INSTRUCTIONS, require('../core/company-assistant/ppt-instructions').PPT_MAKE_INSTRUCTIONS]) assert.doesNotMatch(text, /只读/, '做页规则不出现这两个字（模型会误以为整个任务只读）');
  const { POWERPOINT_RULE, PPT_MAKE_INSTRUCTIONS } = require('../core/company-assistant/ppt-instructions');
  const { PPT_RULES } = require('../core/company-assistant/service');
  for (const phrase of ['只关闭自己打开的那一份', '不按进程名结束 PowerPoint', '不逐个关闭全部演示文稿', '按 FullName 找同一路径的文件', 'Presentations.Open(路径, -1, 0, 0)', 'finally', '换一个新文件名另存']) {
    assert.ok(POWERPOINT_RULE.includes(phrase), phrase);
  }
  assert.ok(PPT_MAKE_INSTRUCTIONS.includes(POWERPOINT_RULE), '做页规则（skills/ppt-make.md 与做页提问）');
  assert.ok(PPT_RULES.includes(POWERPOINT_RULE), 'PPT 助理会话规则');
  const skill = fs.readFileSync(path.join(root, 'core', 'codeagent-skills', 'company-team', 'SKILL.md'), 'utf8');
  for (const phrase of ['只关自己打开的那一份', '不按进程名结束 PowerPoint', '不逐个关闭全部演示文稿', '按 FullName 找同一路径的文件', 'Open(路径, -1, 0, 0)']) assert.ok(skill.includes(phrase), phrase);
});
