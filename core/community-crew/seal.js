'use strict';
// 社区·我的团队（2026-11-28）：团队内容的加密。
// 信箱放在成员各自共享出来的文件夹里，同一个共享里别的同事也可能读得到，所以凡是团队内容一律用团队钥匙加密（AES-256-GCM），
// 只有拿到邀请、知道钥匙的成员能解开。文件格式：魔数 HCR1 + 12 字节 IV + 密文 + 16 字节认证标签。
// 邀请包另用「邀请码」派生的钥匙加密（scrypt），对方凭 IP + 邀请码取回团队钥匙。
const crypto = require('node:crypto');
const fs = require('node:fs');
const { pipeline, finished } = require('node:stream/promises');
const { once } = require('node:events');
const { Transform } = require('node:stream');

const MAGIC = Buffer.from('HCR1');
const IV_LEN = 12, TAG_LEN = 16, HEAD = MAGIC.length + IV_LEN;

const newKey = () => crypto.randomBytes(32).toString('base64url');
const keyBuf = key => {
  const b = Buffer.from(String(key || ''), 'base64url');
  if (b.length !== 32) throw new Error('团队钥匙无效');
  return b;
};

function seal(key, data) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf(key), iv);
  const body = Buffer.concat([c.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

function open(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEAD + TAG_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是团队信件');
  const iv = buf.subarray(MAGIC.length, HEAD), tag = buf.subarray(buf.length - TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(key), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(HEAD, buf.length - TAG_LEN)), d.final()]);
}

const sealJson = (key, obj) => seal(key, JSON.stringify(obj));
const openJson = (key, buf) => JSON.parse(open(key, buf).toString('utf8'));

// 大文件流式加解密：不整份读进内存。
async function sealFile(key, src, dst) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf(key), iv);
  const out = fs.createWriteStream(dst);
  const done = finished(out);
  try {
    out.write(Buffer.concat([MAGIC, iv]));
    for await (const chunk of fs.createReadStream(src)) {
      if (!out.write(c.update(chunk))) await once(out, 'drain');
    }
    out.write(c.final());
    out.end(c.getAuthTag());
    await done;
  } catch (e) { out.destroy(); done.catch(() => {}); throw e; }
}

async function openFile(key, src, dst, { maxBytes = Infinity } = {}) {
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new Error('文件接收上限无效');
  const fh = await fs.promises.open(src, 'r');
  let head, tag, size;
  try {
    size = (await fh.stat()).size;
    if (size < HEAD + TAG_LEN) throw new Error('文件不完整');
    head = Buffer.alloc(HEAD); await fh.read(head, 0, HEAD, 0);
    tag = Buffer.alloc(TAG_LEN); await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { await fh.close(); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是团队文件');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(key), head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  const tmp = dst + '.part';
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, cb) {
    bytes += chunk.length;
    cb(bytes > maxBytes ? new Error('文件实际大小超过接收上限') : null, bytes > maxBytes ? undefined : chunk);
  } });
  try {
    if (size - TAG_LEN > HEAD) await pipeline(fs.createReadStream(src, { start: HEAD, end: size - TAG_LEN - 1 }), d, limit, fs.createWriteStream(tmp));
    else { d.final(); fs.writeFileSync(tmp, Buffer.alloc(0)); }
    fs.renameSync(tmp, dst);
    return bytes;
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 没写出来 */ } throw e; }
}

// 邀请码：12 位，去掉易混的字符；旧的 8 位码仍可解析。
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  const b = crypto.randomBytes(12);
  return Array.from(b, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
const normCode = code => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const prettyCode = code => { const c = normCode(code); return [8, 12].includes(c.length) ? c.match(/.{4}/g).join('-') : c; };
// 文件名与钥匙使用不同标签做昂贵派生，避免文件名提供廉价的离线校验。
const inviteId = code => crypto.scryptSync(normCode(code), 'hub-crew-invite-id', 16).toString('hex');
const inviteKey = code => crypto.scryptSync(normCode(code), 'hub-crew-invite-key', 32).toString('base64url');

module.exports = { newKey, seal, open, sealJson, openJson, sealFile, openFile, newInviteCode, normCode, prettyCode, inviteId, inviteKey, CODE_ALPHABET };
