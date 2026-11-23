'use strict';
// 单测替身只验证存储协议，真实 Windows DPAPI 由隔离 Electron 验收。
const crypto = require('node:crypto');
const key = crypto.randomBytes(32);
module.exports = {
  isEncryptionAvailable: () => true,
  encryptString(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(buffer) {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
  },
};
