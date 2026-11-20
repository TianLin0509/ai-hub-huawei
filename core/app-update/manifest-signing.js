'use strict';
// 版本清单离线签名（rsi-e 返工，2026-11-21）：只用于「从公司内源读版本清单」这条兜底路径。
// 内源上谁都可能传文件，单凭清单格式对、版本号对得上，不能证明清单是发版机出的；所以内源清单必须附带
// latest.json.sig（Ed25519 对 latest.json 原始字节的签名，base64 文本），用下面内置的公钥验过才采信。
// 私钥只在发版机本地（~/.config/hubh-release/manifest-ed25519.key），不进仓库、不进公开版。
// 外网（GitHub、阿里云）清单路径不验签，行为不变，老客户端不受影响。
const crypto = require('node:crypto');

// Ed25519 公钥（SPKI DER，base64）。换私钥时同时换这里，并发一版。
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAe9xVv8wMVy5UJ1VXVsTjTig7ltIPHtX+WAnBq5mdBjI=';
const SIG_FILE_SUFFIX = '.sig';

function toKey(publicKey) {
  if (publicKey && typeof publicKey === 'object' && publicKey.type === 'public') return publicKey;
  return crypto.createPublicKey({ key: Buffer.from(String(publicKey || PUBLIC_KEY_B64), 'base64'), format: 'der', type: 'spki' });
}

// raw：清单原始字节（Buffer）；sigText：.sig 文件内容（base64）。返回 true / false，不抛错。
function verifyManifest(raw, sigText, publicKey) {
  try {
    const sig = Buffer.from(String(sigText || '').trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'), toKey(publicKey), sig);
  } catch (_) { return false; }
}

// 发版端用：privateKeyPem 为 PKCS8 PEM。返回 base64 签名文本（带换行）。
function signManifest(raw, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'), key).toString('base64') + '\n';
}

module.exports = { verifyManifest, signManifest, PUBLIC_KEY_B64, SIG_FILE_SUFFIX };
