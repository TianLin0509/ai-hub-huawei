'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isExecutablePath, confirmIfExecutable } = require('../renderer/executable-path.js');

test('A2-09 可执行类文件被识别（大小写、末尾空格点号）', () => {
  for (const p of ['D:\\a\\setup.exe','./run.CMD', 'C:/x/y.bat', 'a.ps1', 'x.msi', 'link.lnk', 'a.vbs', 'setup.exe. ']) {
    assert.equal(isExecutablePath(p), true, p);
  }
});

test('A2-09 普通文档不触发确认', () => {
  for (const p of ['D:\\a\\报告.md', 'a.pdf', 'b.xlsx', 'exe', '.exe', 'C:\\dir.exe\\readme.txt', '']) {
    assert.equal(isExecutablePath(p), false, p);
  }
});

test('A2-09 所有来自回答的链接入口都先确认再打开', () => {
  for (const [file, opener] of [
    ['renderer.js', "ipcRenderer.invoke('open-path', fullPath)"],
    ['assistant-page.js', "ipcRenderer.invoke('open-path', file)"],
    ['path-link-context-menu.js', "ipcRenderer.invoke('open-path', t.absPath)"],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8');
    const i = src.indexOf('confirmIfExecutable('), j = src.indexOf(opener);
    assert.ok(i > 0 && j > i, file);
  }
});

test('A2-09 可执行文件用户不同意就不打开，普通文件不问', async () => {
  let asked = 0;
  const answer = value => async () => { asked += 1; return value; };
  assert.equal(await confirmIfExecutable('a.md', answer(false)), true);
  assert.equal(asked, 0);
  assert.equal(await confirmIfExecutable('a.exe', answer(false)), false);
  assert.equal(await confirmIfExecutable('a.exe', answer(true)), true);
  assert.equal(asked, 2);
});
