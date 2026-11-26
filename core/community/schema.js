'use strict';
// 社区心跳的字段白名单与清洗（2026-11-24）：发送端构建和收件机接收共用这一份，任何不在白名单里的字段一律丢弃。
// 心跳只有这些：版本、桌宠种类、等级、成就数、本周经验、本周 Token（按千取整）、工作日连胜、近 7 天活跃天数、
// 过去一小时是否亲自用过（0/1）、自选或自动生成的昵称。不含姓名、工号、部门、机器名、路径、对话、使用时段与分功能用量。
const MAX_LEVEL = 60;
const NICK_MAX = 12;
const EDITIONS = ['public', 'member'];
const LIMITS = Object.freeze({ lv: [1, MAX_LEVEL], ach: [0, 500], wxp: [0, 1e6], wtok: [0, 1e10], streak: [0, 3660], days7: [0, 7], act: [0, 1] });
const ID_RE = /^[0-9a-f]{32}$/;
const PET_RE = /^[a-z][a-z0-9-]{0,23}$/;
const VER_RE = /^\d{1,4}(\.\d{1,5}){0,3}([-+][0-9A-Za-z.-]{1,16})?$/;
const MAX_BODY_BYTES = 2048;
// 「后台」自检的失败原因计数（2026-11-26 经确认开启上报）：{ d: 当天日期, c: { '入口:原因': 次数 } }。
// 只有入口名和原因类别这两个固定词，加次数；不带会话编号、报错原文、用户信息。最多 24 项、每项 ≤1000。
const DG_KEY_RE = /^[a-z][a-z-]{0,15}:[a-z][a-z-]{0,19}$/;
const DG_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DG_MAX_KEYS = 24;

// 只认字符串和数字：对象、数组一律当空值。对象可以自带坏掉的 toString（JSON 里写 {"toString":null}），
// 直接 String()/Number() 会抛错（审查 P1，2026-11-24）。
const str = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function clampInt(value, [lo, hi]) {
  const n = Math.floor(typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// 控制字符、零宽字符与文字方向控制符（按码位拼出，源码里不放这些不可见字符）。
const STRIP_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

// 去掉控制字符、零宽与方向控制字符，压掉多余空白，最多 12 个字（按字符算，不按字节）。
function cleanNick(value) {
  const text = str(value)
    .replace(STRIP_RE, '')
    .replace(/\s+/g, ' ').trim();
  return [...text].slice(0, NICK_MAX).join('').trim();
}

function cleanDiag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = str(value.d);
  if (!DG_DAY_RE.test(d) || !value.c || typeof value.c !== 'object' || Array.isArray(value.c)) return null;
  const c = {};
  let n = 0;
  for (const [k, v] of Object.entries(value.c)) {
    if (n >= DG_MAX_KEYS) break;
    if (!DG_KEY_RE.test(k)) continue;
    const x = clampInt(v, [0, 1000]);
    if (x > 0) { c[k] = x; n += 1; }
  }
  return n ? { d, c } : null;
}

// 接收端用：不合格返回 null（编号不对就整条丢弃），其余字段钳制到合理范围。
function sanitizePulse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const iid = str(body.iid).toLowerCase();
  if (!ID_RE.test(iid)) return null;
  const out = {
    v: 1, iid,
    ed: EDITIONS.includes(body.ed) ? body.ed : 'member',
    ver: VER_RE.test(str(body.ver)) ? str(body.ver) : '',
    nick: cleanNick(body.nick),
    pet: PET_RE.test(str(body.pet)) ? str(body.pet) : '',
  };
  for (const [k, range] of Object.entries(LIMITS)) out[k] = clampInt(body[k], range);
  out.wtok = Math.round(out.wtok / 1000) * 1000;
  const dg = cleanDiag(body.dg);
  if (dg) out.dg = dg;
  return out;
}

module.exports = { MAX_LEVEL, NICK_MAX, LIMITS, EDITIONS, MAX_BODY_BYTES, ID_RE, PET_RE, VER_RE, DG_MAX_KEYS, cleanNick, cleanDiag, sanitizePulse, clampInt };
