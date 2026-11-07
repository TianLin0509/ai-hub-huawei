'use strict';

// 预览读文本文件：先认 BOM（UTF-8 / UTF-16 LE / BE），再严格解 UTF-8，失败回退 GBK。
// 返回 { content, encoding }；encoding 用于在预览里告诉用户实际用了什么编码。
function decodeTextBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    if (body.length % 2) body.fill(0, body.length - 1);
    body.swap16();
    return { content: body.toString('utf16le'), encoding: 'utf-16be' };
  }
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    try {
      return { content: new TextDecoder('gbk').decode(buf), encoding: 'gbk' };
    } catch {
      return { content: buf.toString('utf8'), encoding: 'utf-8' };
    }
  }
}

module.exports = { decodeTextBuffer };
