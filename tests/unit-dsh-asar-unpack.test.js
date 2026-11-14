'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { dshRuntimeFile } = require('../core/acp-profiles');
const { HELPER } = require('../core/app-update/apply');

const source = fs.readFileSync(path.join(root, 'core/acp-profiles.js'), 'utf8');
const names = [...source.matchAll(/dshRuntimeFile\('([^']+)'\)/g)].map(m => m[1]);

test('安装版里 DSH 用的文件指向解包目录', () => {
  const base = 'C:\\Program Files\\AI Hub Community\\resources\\app.asar\\core';
  assert.strictEqual(path.win32.normalize(dshRuntimeFile('a.cjs', base).replace(/\//g, '\\')),
    'C:\\Program Files\\AI Hub Community\\resources\\app.asar.unpacked\\core\\a.cjs');
});

test('外部 Node 加载的文件都在 asarUnpack 里，且实际存在', () => {
  assert.ok(names.length >= 5);
  const unpack = require('../package.json').build.asarUnpack;
  for (const name of names) {
    assert.ok(unpack.includes('core/' + name), name + ' 没有解包');
    assert.ok(fs.existsSync(path.join(root, 'core', name)), name + ' 不存在');
  }
  assert.doesNotMatch(source, /path\.join\(__dirname,\s*'[^']*\.(cjs|mjs)'\)/);
});

test('更新脚本只在没有开着的 Hub 窗口时清理残留，且只清 Hub 自己的 exe', () => {
  // 2026-11-13：「开着的 Hub」改由 Others-Now 判断（含最小化到托盘的；WMI 不可用时同一 exe 都算可能开着的 Hub，先问再关）。
  const body = HELPER.match(/function Stop-Orphans\(\$all = \$false\) \{[\s\S]*?\r?\n\}/)[0];
  assert.match(body, /Others-Now/);
  assert.match(HELPER, /function Others-Now \{[^\n]*Get-OtherMains/);
  assert.match(HELPER, /\$_\.Main -or -not \$script:snapWmi/);
  assert.match(body, /\$all -or \$_\.Path -ieq \[string\]\$p\.exe/);
  // 先清同一 exe 的残留，再等安装目录里的其他程序，最后才替换。
  assert.ok(HELPER.indexOf('\nStop-Orphans') < HELPER.indexOf('$leftDeadline = '));
  assert.ok(HELPER.indexOf('\nStop-Orphans') < HELPER.indexOf('$r = Do-Replace'));
});

test('枚举进程时目标恰好退出，更新脚本不会崩', () => {
  assert.doesNotMatch(HELPER, /\$_\.Path\.StartsWith/);
});
