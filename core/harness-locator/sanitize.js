'use strict';
// 诊断文本打码（接口合同第 4 节）：用户目录写成 %USERPROFILE%，%APPDATA%、%LOCALAPPDATA% 写成变量形式，用户名换成 <user>；
// 不带 key、token、Authorization 一类内容。m2 的一键反馈附带诊断时也用这一份。
const os = require('node:os');
const { envGet } = require('./specs');

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeUser() { try { return os.userInfo().username || ''; } catch { return ''; } }

function sanitizeText(text, { env = process.env, user } = {}) {
  let s = String(text == null ? '' : text);
  const vars = [['LOCALAPPDATA', envGet(env, 'LOCALAPPDATA')], ['APPDATA', envGet(env, 'APPDATA')], ['USERPROFILE', envGet(env, 'USERPROFILE') || os.homedir()]]
    .filter(([, v]) => v && v.length > 3).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of vars) {
    for (const v of new Set([value, value.replace(/\\/g, '/'), value.replace(/\\/g, '\\\\')])) s = s.replace(new RegExp(escapeRe(v), 'gi'), `%${name}%`);
  }
  // 8.3 短名形式的用户目录（C:\Users\ZHANGS~1）和其他盘符下的 Users\<名字>。
  s = s.replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+(?=[\\/])/gi, '$1<user>');
  const name = user === undefined ? (envGet(env, 'USERNAME') || safeUser()) : user;
  if (name && name.length >= 2) s = s.replace(new RegExp(`(^|[\\\\/\\s:：(（"'])${escapeRe(name)}(?=$|[\\\\/\\s.,，)）"'])`, 'gi'), '$1<user>');
  return s
    .replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g, '<key>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <key>')
    .replace(/(authorization|api[-_]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2<key>')
    .replace(/([?&](?:token|key|sig|signature|code|auth)=)[^&\s]+/gi, '$1<key>');
}

module.exports = { sanitizeText };
