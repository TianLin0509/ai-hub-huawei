'use strict';
// 静态扫：core/welink-native/ 下的代码没有任何落盘写入，也不打印用户输入；
// 动态查：认出 /welink 之后用户在终端里敲的凭据，探测器一个字都不留。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWelinkLinkDetector } = require('../core/welink-native/link-detector');

const DIR = path.join(__dirname, '..', 'core', 'welink-native');
const sources = () => fs.readdirSync(DIR).filter(f => f.endsWith('.js')).map(f => ({ f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));

test('原生通道代码不落盘写任何文件', () => {
  const write = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|renameSync|copyFile)\b|\.write\(\s*['"]|safeStorage|encryptString/;
  for (const { f, text } of sources()) assert.equal(write.test(text), false, `${f} 不应写文件或加密存凭据`);
});

test('原生通道代码不出现凭据字段，也不把用户输入或屏幕内容打进日志', () => {
  // 代码里的变量、对象键（屏幕标签原文 'AppKey:' 这类字符串不算）
  const cred = /(?<!['"\w])(?:app_?id|app_?key|app_?secret|access_?key|secret_?key)\s*[:=]/i;
  const logInput = /console\.\w+\([^)]*\b(?:data|line|tail|text|screen)\b/;
  for (const { f, text } of sources()) {
    assert.equal(cred.test(text), false, `${f} 不应有凭据字段`);
    assert.equal(logInput.test(text), false, `${f} 不应打印用户输入或屏幕`);
  }
});

test('认出 /welink 之后用户敲的 APPID / APPKEY 不留在探测器状态里', () => {
  const d = createWelinkLinkDetector({ dataDir: null });
  const type = s => { for (const ch of s) d.noteInput('s1', ch); d.noteInput('s1', '\r'); };
  type('/welink');
  type('APPID-1234567890');
  type('APPKEY-SECRET-abcdef');
  const entry = d._sessions.get('s1');
  assert.equal(entry.armed, true);
  assert.equal(entry.line, '');
  const dump = JSON.stringify([...d._sessions.values()]) + JSON.stringify(d.status('s1'));
  assert.equal(/APPID-1234567890|APPKEY-SECRET/.test(dump), false);
});
