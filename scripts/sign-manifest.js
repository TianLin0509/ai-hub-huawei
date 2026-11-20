'use strict';
// 版本清单离线签名（rsi-e 返工，2026-11-21）：给 latest.json 生成 latest.json.sig（Ed25519，base64）。
// Hub 只对「从公司内源读到的清单」验签（core/app-update/manifest-signing.js），外网清单不验，所以：
// 私钥不存在时只跳过签名并打警告，不挡发版——这一版内源清单兜底不生效（客户端当内源没有清单，行为同以前），其余一切照常。
// 私钥位置：~/.config/hubh-release/manifest-ed25519.key（PKCS8 PEM，只在发版机本地，不进仓库、不进日志）；
// 可用 AI_HUB_MANIFEST_SIGNING_KEY 指向别处。用法：node scripts/sign-manifest.js <latest.json> [...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signManifest, verifyManifest } = require('../core/app-update/manifest-signing');

const keyPath = (env = process.env) => env.AI_HUB_MANIFEST_SIGNING_KEY || path.join(os.homedir(), '.config', 'hubh-release', 'manifest-ed25519.key');

// 返回 { signed:true, sig } 或 { signed:false, reason }。签完立刻用内置公钥验一遍：私钥和 Hub 内置公钥不配对时不留 .sig（留了也验不过）。
function signFile(file, { env = process.env, log = console } = {}) {
  const kp = keyPath(env);
  // 上一次构建留下的 .sig 先删：这次没签成就不能让旧签名跟着新清单发出去。
  fs.rmSync(file + '.sig', { force: true });
  let pem;
  try { pem = fs.readFileSync(kp, 'utf8'); }
  catch (_) {
    const reason = `没找到版本清单签名私钥，跳过签名（这一版公司内源清单兜底不生效，发版照常）：${kp}`;
    log.warn('WARNING: ' + reason);
    return { signed: false, reason };
  }
  const raw = fs.readFileSync(file);
  const sig = signManifest(raw, pem);
  if (!verifyManifest(raw, sig)) {
    const reason = '签名私钥和 Hub 内置公钥不配对，没有写 .sig（发版照常，内源清单兜底不生效）';
    log.warn('WARNING: ' + reason);
    return { signed: false, reason };
  }
  fs.writeFileSync(file + '.sig', sig);
  return { signed: true, sig };
}

module.exports = { signFile, keyPath };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('用法：node scripts/sign-manifest.js <latest.json> [...]'); process.exit(2); }
  for (const f of files) {
    const r = signFile(f);
    console.log(r.signed ? `已签名：${f}.sig` : `未签名：${f}`);
  }
}
