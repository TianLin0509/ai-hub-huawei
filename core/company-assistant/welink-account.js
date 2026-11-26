'use strict';
// 换过工号的同事（2026-11-24 R32）：WeLink 桌面端已经登成新工号，welink-cli 却还拿着旧工号的令牌。
// welink-cli 每次发请求都要向本机桌面端（127.0.0.1:14114）取签名：签名是新工号的、令牌是旧工号的，WeLink 网关
// （mcloud/mag/ProxyForText）对不上就拒，CLI 只回一句「proxy failed」；而 auth status 只看令牌没过期，照样说已登录。
// 所以身份以桌面端当前登录的账号为准，两边对不上就请本人「清除并重新扫码」，不再拿旧令牌续期。
//
// 两个本机来源（2026-11-24 在公司黄区真机 WeLink 7.39 上只读核实）：
//   桌面端：%APPDATA%\WeLink_Desktop\appdata\logininfo.txt，一行 loginAccount=<账号>，每次登录改写；
//           读不到时看 %APPDATA%\WeLink_Desktop\UserData\ 下按账号命名的目录，取 user.db 最新的那个。
//   命令行：%USERPROFILE%\.welink-cli\credentials.json 里的 uid（w3Account 可能为空）。只取账号这一个字段，不碰令牌。
const fs = require('node:fs');
const path = require('node:path');

const ACCOUNT = /^[A-Za-z]{0,3}\d{5,10}$|^[A-Za-z][\w.-]{1,39}$/;
const norm = v => String(v || '').trim().toLowerCase();
const valid = v => ACCOUNT.test(String(v || '').trim()) && !/^(?:null|none|undefined)$/i.test(String(v || '').trim());
// 同一个人的工号有几种写法：8 位纯数字（00200002）与带首字母的 W3 账号（x00200002）、合作方 wx1234567 与 lwx1234567。
// 数字部分相同、且一方没有字母前缀或一方前缀是另一方的结尾，就算同一个账号（审查 #1：否则会反复让人重登）。
const EMP = /^([a-z]{0,3})(\d{5,10})$/;
function same(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ma = EMP.exec(na), mb = EMP.exec(nb);
  if (!ma || !mb || ma[2] !== mb[2]) return false;
  return !ma[1] || !mb[1] || ma[1].endsWith(mb[1]) || mb[1].endsWith(ma[1]);
}

function appData(env) { return env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : ''); }

function clientAccount({ env = process.env, fsModule = fs } = {}) {
  const root = appData(env);
  if (!root) return null;
  const desk = path.join(root, 'WeLink_Desktop');
  try {
    // 兼容 UTF-16 存的文件；= 两侧只认行内空白，值为空时不跨行取到下一行的词（审查 #2）。
    const raw = fsModule.readFileSync(path.join(desk, 'appdata', 'logininfo.txt'));
    const utf16 = raw.length > 1 && (raw[0] === 0xff && raw[1] === 0xfe || raw.includes(0));
    const text = (utf16 ? raw.toString('utf16le') : raw.toString('utf8')).replace(/\0/g, '');
    const m = /^[ \t\uFEFF]*loginAccount[ \t]*=[ \t]*["']?([^\s"']+)["']?/im.exec(text);
    if (m && valid(m[1])) return { account: m[1].trim(), via: 'logininfo' };
  } catch { /* 没装桌面端或从没登录过 */ }
  try {
    const dir = path.join(desk, 'UserData');
    let best = null;
    for (const e of fsModule.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[A-Za-z]{0,3}\d{5,10}$/.test(e.name)) continue;
      let at = 0;
      try { at = fsModule.statSync(path.join(dir, e.name, 'user.db')).mtimeMs; } catch { continue; }
      if (!best || at > best.at) best = { account: e.name, at };
    }
    if (best) return { account: best.account, via: 'userdata' };
  } catch { /* 读不了就算不知道 */ }
  return null;
}

function cliAccount({ env = process.env, fsModule = fs } = {}) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) return null;
  try {
    const j = JSON.parse(fsModule.readFileSync(path.join(home, '.welink-cli', 'credentials.json'), 'utf8'));
    const account = [j && j.uid, j && j.w3Account].find(valid);
    return account ? { account: String(account).trim(), via: 'credentials' } : null;
  } catch { return null; }
}

// 两边都读到且不一样才算对不上；任一边读不到就不下结论（不因为没装桌面端就拦住同事）。
// cli 可传 auth status 读到的 UID（更准），没有再用 credentials.json。
function mismatch({ client, cli }) {
  const a = client && (client.account || client), b = cli && (cli.account || cli);
  if (!valid(a) || !valid(b) || same(a, b)) return null;
  return { client: String(a).trim(), cli: String(b).trim(),
    text: `WeLink 命令行还登着旧账号 ${String(b).trim()}，电脑上的 WeLink 现在是 ${String(a).trim()}`,
    next: '点「重新登录」：Hub 先清掉命令行里旧账号的登录，再出二维码，用手机 WeLink（新账号）扫一下即可。' };
}

function read({ env = process.env, fsModule = fs, cliUid = '' } = {}) {
  const client = clientAccount({ env, fsModule });
  const cli = valid(cliUid) ? { account: String(cliUid).trim(), via: 'auth-status' } : cliAccount({ env, fsModule });
  return { client, cli, mismatch: mismatch({ client, cli }) };
}

module.exports = { clientAccount, cliAccount, mismatch, read, norm, same };
