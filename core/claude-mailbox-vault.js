'use strict';
// 账号页 · Claude 账号邮箱保管（2026-10-30）。
// 每个 Claude 账号记一份：登录邮箱、邮箱密码、辅助邮箱及其密码、2FA 密钥、备注；
// 卖家给的其他凭据（Outlook 令牌、Claude 网页登录凭证等）整包加密留存，界面不显示。
// 密码与密钥只以 Electron safeStorage（Windows 下即 DPAPI，绑定当前 Windows 用户）密文落盘，
// 明文只在主进程里解密后写进剪贴板，从不发给界面、日志或聊天。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'claude-mailboxes.json';
const ID = /^[\w-]{1,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const OUTLOOK = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.cn']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
// mail.com sells many vanity domains; only the ones seen on these accounts are listed.
const MAILCOM = new Set(['mail.com', 'gardener.com']);
const ONET = new Set(['onet.pl', 'op.pl', 'onet.eu', 'vp.pl']);
// Must stay in step with MAIL_HOSTS in scripts/vps-login/manager.py and open_url.py.
const MAIL_HOSTS = new Set(['outlook.live.com', 'mail.google.com', 'www.mail.com', 'poczta.onet.pl']);
const SECRET_FIELDS = ['password', 'recoveryPassword', 'totpSecret'];

function providerOf(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  if (OUTLOOK.has(domain) || /^(outlook|hotmail|live)\.[a-z.]+$/.test(domain)) return 'outlook';
  if (GMAIL.has(domain)) return 'gmail';
  if (MAILCOM.has(domain)) return 'mailcom';
  if (ONET.has(domain)) return 'onet';
  return domain ? 'other' : '';
}
// The webmail page that opens inside the account's login environment; '' when we cannot open one.
function mailUrl(email) {
  const kind = providerOf(email);
  if (kind === 'outlook') return 'https://outlook.live.com/mail/0/';
  if (kind === 'gmail') return 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(email);
  if (kind === 'mailcom') return 'https://www.mail.com/';
  if (kind === 'onet') return 'https://poczta.onet.pl/';
  return '';
}
function isMailUrl(value) {
  let u; try { u = new URL(String(value || '')); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && MAIL_HOSTS.has(u.hostname.toLowerCase());
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as Google / Microsoft authenticator apps compute it.
function cleanTotp(value) {
  const s = String(value ?? '').replace(/[\s-]+/g, '').toUpperCase().replace(/=+$/, '');
  if (!s) return '';
  if (!/^[A-Z2-7]{16,128}$/.test(s)) throw new Error('2FA 密钥格式不对：应为 16 位以上的字母和数字 2–7');
  return s;
}
function totp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of cleanTotp(secret)) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest(), o = h[19] & 15;
  return { code: String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'), secondsLeft: 30 - Math.floor(now / 1000) % 30 };
}

function cleanEmail(value, label) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (!EMAIL.test(v)) throw new Error(label + '格式不对：' + v);
  return v;
}
function cleanText(value, max) { return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }

class MailboxVault {
  constructor({ dataDir, safeStorage }) {
    this.file = path.join(dataDir, FILE);
    this.safe = safeStorage;
  }
  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return raw && typeof raw.accounts === 'object' && raw.accounts ? raw : { version: 1, accounts: {} };
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: {} };
      throw new Error('邮箱保管文件读取失败：' + e.message);
    }
  }
  write(db) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  encrypt(text) {
    if (!this.safe?.isEncryptionAvailable?.()) throw new Error('系统加密不可用，密码未保存');
    return this.safe.encryptString(text).toString('base64');
  }
  decrypt(blob) {
    if (!this.safe?.isEncryptionAvailable?.()) throw new Error('系统加密不可用，无法取出密码');
    try { return this.safe.decryptString(Buffer.from(blob, 'base64')); }
    catch { throw new Error('密码无法解密（可能换了 Windows 用户或电脑），请重新填写'); }
  }
  // What the account page shows: never a password or key, only whether one is stored.
  list() {
    const out = {};
    for (const [id, a] of Object.entries(this.read().accounts)) {
      out[id] = {
        email: a.email || '', provider: providerOf(a.email), hasPassword: !!a.password, canOpen: !!mailUrl(a.email),
        recoveryEmail: a.recoveryEmail || '', recoveryProvider: providerOf(a.recoveryEmail), hasRecoveryPassword: !!a.recoveryPassword,
        canOpenRecovery: !!mailUrl(a.recoveryEmail), hasTotp: !!a.totpSecret, hasExtras: !!a.extras, note: a.note || '', updatedAt: a.updatedAt || '',
      };
    }
    return out;
  }
  // Blank secret fields keep the stored value; clearPassword / clearRecoveryPassword / clearTotpSecret remove it.
  save(profileId, input = {}) {
    if (!ID.test(profileId || '')) throw new Error('账号标识无效');
    const db = this.read(), prev = db.accounts[profileId] || {};
    const next = {
      email: cleanEmail(input.email, '登录邮箱'),
      recoveryEmail: cleanEmail(input.recoveryEmail, '辅助邮箱'),
      note: cleanText(input.note, 300),
      updatedAt: new Date().toISOString(),
    };
    const fresh = { ...input, totpSecret: cleanTotp(input.totpSecret) };
    for (const k of SECRET_FIELDS) {
      const clear = 'clear' + k[0].toUpperCase() + k.slice(1);
      if (fresh[k]) next[k] = this.encrypt(String(fresh[k]));
      else if (!input[clear] && prev[k]) next[k] = prev[k];
    }
    if (input.extras && typeof input.extras === 'object' && Object.keys(input.extras).length) next.extras = this.encrypt(JSON.stringify(input.extras));
    else if (prev.extras) next.extras = prev.extras;
    if (!next.recoveryEmail) delete next.recoveryPassword;
    if (!next.email && !next.recoveryEmail && !next.note && !next.password && !next.totpSecret) delete db.accounts[profileId];
    else db.accounts[profileId] = next;
    this.write(db);
    return this.list()[profileId] || null;
  }
  secret(profileId, which = 'main') {
    const a = this.read().accounts[profileId];
    const blob = which === 'recovery' ? a?.recoveryPassword : which === 'totp' ? a?.totpSecret : a?.password;
    if (!blob) throw new Error({ recovery: '还没有保存辅助邮箱密码', totp: '还没有保存 2FA 密钥' }[which] || '还没有保存邮箱密码');
    return this.decrypt(blob);
  }
  totpCode(profileId, now = Date.now()) { return totp(this.secret(profileId, 'totp'), now); }
  target(profileId, which = 'main') {
    const a = this.read().accounts[profileId];
    const email = which === 'recovery' ? a?.recoveryEmail : a?.email;
    if (!email) throw new Error(which === 'recovery' ? '还没有填写辅助邮箱' : '还没有填写登录邮箱');
    const url = mailUrl(email);
    if (!url) throw new Error('这个邮箱还不能一键打开（支持 Outlook / Hotmail、Gmail、mail.com、Onet）；请在登录窗口地址栏手动打开');
    return { email, url };
  }
  // The account file the person keeps (C:\AppData\AccountVault\*.json): one entry per Hub profileId.
  importFile(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error('资料文件读不了：' + e.message); }
    const rows = Array.isArray(raw?.accounts) ? raw.accounts : [];
    if (!rows.length) throw new Error('资料文件里没有 accounts 列表');
    const done = [], skipped = [];
    for (const r of rows) {
      if (!ID.test(r?.profileId || '') || !r.email) { skipped.push(r?.email || r?.profileId || '?'); continue; }
      const note = [r.accountName, r.purchasedAt && '购于 ' + String(r.purchasedAt).slice(0, 10), r.extra && '卖家另给的一串字符用途不明，已加密留存'].filter(Boolean).join(' · ');
      const extras = {};
      for (const k of ['outlookClientId', 'outlookRefreshToken', 'claudeSessionKey', 'sellerNote', 'extra', 'tokenNote', 'purchasedAt', 'accountName']) if (r[k]) extras[k] = r[k];
      this.save(r.profileId, { email: r.email, password: r.password || '', recoveryEmail: r.recoveryEmail || '', recoveryPassword: r.recoveryPassword || '', totpSecret: r.totpSecret || '', note, extras });
      done.push(r.profileId);
    }
    return { imported: done, skipped };
  }
}

module.exports = { MailboxVault, providerOf, mailUrl, isMailUrl, totp, MAIL_HOSTS, FILE };
