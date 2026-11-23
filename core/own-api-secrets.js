'use strict';
// 自有接口的存储边界：内存沿用原字段，磁盘只写 safeStorage 密文，失败不降级为明文。
const KEY_NEEDED = '这个接口的 Key 无法解密，请重新填写并点「保存并继续」。';
function safeStorage() { try { return require('electron').safeStorage; } catch { return null; } }
function encrypt(key) {
  const safe = module.exports.safeStorage();
  if (!safe?.isEncryptionAvailable?.()) throw new Error('系统密钥加密不可用，无法保存 API Key');
  return safe.encryptString(key).toString('base64');
}
function openSecret(value, key = 'apiKey', cipher = 'encryptedApiKey') {
  const next = { ...value };
  delete next[key + 'NeedsInput'];
  if (Object.hasOwn(next, cipher)) {
    try {
      // 有密文时不回退到同文件里的旧明文，防止错用另一个账号的 Key。
      if (typeof next[cipher] !== 'string' || !next[cipher]) throw new Error('invalid ciphertext');
      next[key] = module.exports.safeStorage().decryptString(Buffer.from(next[cipher], 'base64'));
      if (!next[key]) throw new Error('empty key');
      delete next[cipher];
    } catch { next[key] = ''; next[key + 'NeedsInput'] = true; }
  }
  return next;
}
function sealSecret(value, key = 'apiKey', cipher = 'encryptedApiKey') {
  const next = { ...value };
  if (next[key]) next[cipher] = encrypt(next[key]);
  delete next[key];
  delete next[key + 'NeedsInput'];
  return next;
}
function mapConfig(raw, transform) {
  const next = { ...raw, ...(raw.providers ? { providers: { ...raw.providers } } : {}) };
  for (const kind of ['claude', 'codex']) {
    const p = raw.providers?.[kind];
    if (!p) continue;
    const out = transform(p, 'api_key', 'encrypted_api_key');
    if (p.own_api) out.own_api = transform(p.own_api, 'api_key', 'encrypted_api_key');
    if (Array.isArray(p.api_profiles)) out.api_profiles = p.api_profiles.map(v => transform(v));
    next.providers[kind] = out;
  }
  if (raw.acp?.companyApi) {
    const p = raw.acp.companyApi;
    const out = transform(p);
    if (p.own_api) out.own_api = transform(p.own_api, 'api_key', 'encrypted_api_key');
    next.acp = { ...raw.acp, companyApi: out };
  }
  return next;
}
const openConfig = raw => mapConfig(raw, openSecret);
const sealConfig = raw => mapConfig(raw, sealSecret);
function hasPlaintext(raw) {
  let found = false;
  mapConfig(raw, (value, key = 'apiKey') => { if (Object.hasOwn(value, key)) found = true; return value; });
  return found;
}
function assertReadable(value, key = 'apiKey') {
  if (value?.[key + 'NeedsInput']) throw new Error(KEY_NEEDED);
}
module.exports = { safeStorage, KEY_NEEDED, openSecret, sealSecret, openConfig, sealConfig, hasPlaintext, assertReadable };
