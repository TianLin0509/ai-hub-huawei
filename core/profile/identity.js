'use strict';
// 「个人」页认人（2026-11-12）：开箱即用，不让用户填。先用本机已有的信息立刻给出一个名字，再后台问 WeLink 拿中文名、工号、部门、职位。
// 顺序：WeLink 登录账号（onebox user-info → search person 按账号查本人 → contact detail 补姓名）→ 助理设置里存过的名字 →
// 编码助手账号的工号 → Git 用户名 → 系统用户名。只读，不触发扫码登录；拿到后存进 profile.json，7 天内不再问。
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REFRESH_MS = 7 * 86400000;
const RETRY_MS = 30 * 60000;
const text = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function parse(stdout) {
  const s = String(stdout || '').trim();
  try { return JSON.parse(s); } catch { /* 前面可能带提示行 */ }
  const i = s.indexOf('{');
  if (i >= 0) { try { return JSON.parse(s.slice(i)); } catch { /* 不是 JSON */ } }
  return null;
}
function gitUserName() {
  try { const r = spawnSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); return r.status === 0 ? text(r.stdout, 40) : ''; } catch { return ''; }
}
const pick = (objs, keys) => { for (const o of objs) if (o && typeof o === 'object') for (const k of keys) { const v = text(typeof o[k] === 'number' ? String(o[k]) : o[k], 200); if (v) return v; } return ''; };

// 本机立刻能拿到的：不联网、不起 welink-cli。
function localIdentity({ assistantSettings = () => ({}), codeAccount = () => '', gitName = gitUserName, osName = () => os.userInfo().username } = {}) {
  const safe = fn => { try { return fn(); } catch { return ''; } };
  const settings = safe(assistantSettings) || {};
  const workId = text(safe(codeAccount), 40), git = text(safe(gitName), 40), user = text(safe(osName), 40);
  const name = text(settings.myName, 40) || git || workId || user;
  return { name, workId: workId || '', email: text(settings.email, 120), dept: '', uid: '', from: text(settings.myName, 40) ? 'assistant' : git ? 'git' : workId ? 'code-account' : 'system' };
}

// 问 WeLink。welink(args) 返回 { stdout }；任何一步失败都退回已有信息，不抛错。
// 字段口径按公司真机实测（2026-11-11）：search person 的结果在 search_cli_person.data 里，带 chineseName、englishName、
// employeeNumber、deptName（部门）、departmentName（部门全路径）、appointPos（职位）；按登录账号搜，再用工号数字对上本人。
const digits = v => String(v || '').replace(/\D/g, '').replace(/^0+/, '');
function people(raw) {
  const found = [];
  const walk = (v, depth) => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) { if (x && typeof x === 'object' && !Array.isArray(x) && (x.chineseName || x.welinkId || x.employeeNumber)) found.push(x); else walk(x, depth + 1); } return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(raw, 0);
  return found;
}
async function welinkIdentity(welink) {
  const out = { name: '', englishName: '', uid: '', workId: '', dept: '', deptPath: '', title: '', email: '' };
  const call = async args => { try { return parse((await welink(args)).stdout); } catch { return null; } };
  const info = await call(['onebox', 'user-info']);
  const boxes = [info, info?.data, info?.user];
  out.name = pick(boxes, ['name', 'chineseName']);
  out.uid = pick(boxes, ['loginName', 'w3Account', 'account']);
  out.email = pick(boxes, ['email', 'mail']);
  if (!out.uid && !out.name) return null;
  const take = hit => {
    out.name = text(hit.chineseName, 40) || out.name; out.englishName = text(hit.englishName, 60) || out.englishName;
    out.dept = pick([hit], ['deptName']) || out.dept; out.deptPath = pick([hit], ['departmentName']) || out.deptPath;
    out.title = pick([hit], ['appointPos']) || out.title; out.workId = pick([hit], ['employeeNumber', 'workId']) || out.workId;
  };
  const known = () => digits(out.uid) || digits(out.workId);
  const mine = list => { const d = known(); return (d && list.find(p => digits(p.employeeNumber) === d || digits(p.workId) === d)) || null; };
  // 只搜到一个人时：他的工号和已知的对不上就不认（宁可不补部门，也不认错人）
  const only = list => { if (list.length !== 1) return null; const d = known(), theirs = digits(list[0].employeeNumber) || digits(list[0].workId); return d && theirs && d !== theirs ? null : list[0]; };
  const safeUid = /^[\w.-]{2,40}$/.test(out.uid);
  if (safeUid) { const list = people(await call(['search', 'person', '--text', out.uid])); const hit = mine(list) || only(list); if (hit) take(hit); }
  if (safeUid && (!out.name || !out.workId)) {
    const detail = await call(['contact', 'detail', out.uid]);
    const me = (detail?.users || []).find(u => [u?.w3Account, u?.personAccount].includes(out.uid));
    if (me) { out.name = text(me.chineseName, 40) || out.name; out.englishName = text(me.englishName, 60) || out.englishName; out.workId = out.workId || text(me.workId, 40) || text(me.employeeNumber, 40); }
  }
  if (!out.dept && out.name.length >= 2) {
    // 按账号没搜到：按姓名搜，同名的人可能不止一个，工号对得上才认；只搜到一个同名的也认。
    const same = people(await call(['search', 'person', '--text', out.name])).filter(p => text(p.chineseName, 40) === out.name);
    const hit = mine(same) || only(same);
    if (hit) take(hit);
  }
  return out;
}

// 合并出最终身份并判断要不要再问 WeLink。
async function resolveIdentity({ cached, local, welink, now = Date.now(), force = false }) {
  const base = { ...local };
  const fresh = cached && cached.from === 'welink' && now - (cached.at || 0) < REFRESH_MS;
  if (fresh && !force) return { ...base, ...cached };
  if (!welink || (!force && cached && cached.from !== 'welink' && now - (cached.triedAt || 0) < RETRY_MS)) return { ...base, ...(cached && cached.from === 'welink' ? cached : {}), triedAt: cached?.triedAt || 0, at: cached?.at || now };
  const w = await welinkIdentity(welink);
  if (!w) return { ...base, ...(cached && cached.from === 'welink' ? cached : {}), triedAt: now, at: cached?.at || now };
  return { name: w.name || base.name, englishName: w.englishName, uid: w.uid, workId: w.workId || base.workId, dept: w.dept, deptPath: w.deptPath, title: w.title, email: w.email || base.email, from: 'welink', at: now, triedAt: now };
}

module.exports = { localIdentity, welinkIdentity, resolveIdentity, parse };
