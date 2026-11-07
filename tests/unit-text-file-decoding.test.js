'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { decodeTextBuffer } = require('../core/text-file-decoding.js');

const text = '小区,吞吐量\n上海浦东,123.4\n';
const gbkText = '中文,123\n';
const gbk = Buffer.from('d6d0cec42c3132330a', 'hex');

test('A2-13 GBK 回退', () => {
  assert.deepEqual(decodeTextBuffer(gbk), { content: gbkText, encoding: 'gbk' });
});

test('A2-13 UTF-16 LE/BE（带 BOM）', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.deepEqual(decodeTextBuffer(le), { content: text, encoding: 'utf-16le' });
  const be = Buffer.from(Buffer.from(text, 'utf16le')).swap16();
  assert.deepEqual(decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), { content: text, encoding: 'utf-16be' });
});

test('A2-13 UTF-8 带 BOM 去掉 BOM，普通 UTF-8 不变', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  assert.deepEqual(decodeTextBuffer(bom), { content: '{"a":1}', encoding: 'utf-8' });
  assert.deepEqual(decodeTextBuffer(Buffer.from(text)), { content: text, encoding: 'utf-8' });
});

test('A2-13 read-file 处理器返回解码后的内容和编码', async () => {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { shell: {}, clipboard: {}, nativeImage: {} };
    return origLoad.call(this, request, ...rest);
  };
  try {
    const { registerPathIpc } = require('../main/ipc/path-handlers.js');
    const handlers = new Map();
    registerPathIpc({ handle: (name, fn) => handlers.set(name, fn) }, {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-enc-'));
    const file = path.join(dir, 'excel.csv');
    fs.writeFileSync(file, gbk);
    const result = await handlers.get('read-file')({}, file);
    assert.equal(result.content, gbkText);
    assert.equal(result.encoding, 'gbk');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    Module._load = origLoad;
  }
});
