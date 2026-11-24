'use strict';
// 统一给各下载点算「内源现在能不能给这个包」：
//   ok       内源上有这个包（按文件名精确找到，下载后仍按清单核 sha256）
//   partial  多文件组件里内源只有一部分，缺的暂时下不了
//   missing  内源上没有这个包
//   down     连不上内源（多半不在公司网络）；把真实原因写在行里
//   nolist   组件清单读不到，和内源通不通无关
//   checking 正在查（第一次最多等约 3 秒）
//   off      内源不生效（测试开关 AI_HUB_OPENX=0）
// 这里只读、不下载。
// 查找复用 openx-source.js 的列表与详情缓存，同一 Hub 进程里多次调用基本不再联网。

const openxSource = require('./openx-source');

const CACHE_MS = 2 * 60 * 1000;
const cache = new Map();   // key → { at, value }

// 原因写进行里时去掉重复的前缀、限制长度（完整原因在悬停提示和「复制排错信息」里）。
function shortReason(reason) {
  const s = String(reason || '').replace(/^内源连不上[：:]?/, '').replace(/（5 分钟内自动重试）$/, '')
    .replace(/^读不到组件(?:目录|清单)[：:]?（(.*)）$/, '$1').trim();
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

function view(status, extra = {}) {
  const reason = extra.reason ? '：' + shortReason(extra.reason) : '';
  const texts = {
    ok: '公司内源 · 可用',
    partial: `公司内源 · 只有 ${extra.hit || 0}/${extra.total || 0} 个文件，缺的暂时下不了（可能还在同步，请稍后再试）`,
    missing: '公司内源 · 暂缺这个包（可能还在同步，请稍后再试）',
    down: `公司内源 · 连不上${reason}。${openxSource.NETWORK_HINT}`,
    nolist: `组件清单读不到${reason}`,
    checking: '公司内源 · 正在检查…',
    off: '公司内源 · 未生效（测试开关 AI_HUB_OPENX=0）',
    internal: `${extra.internalName || '公司内部源'}（公司内网）`,
  };
  const { env: _env, ...rest } = extra;
  return { id: 'openx', name: '公司内源', status, ok: status === 'ok' || status === 'internal', text: texts[status] || texts.checking, ...rest };
}

// spec：{ files: [文件名…], release: 内源版本名（如 cli-codex-0.167.0）, version, strict }
//   或 { items: [{ file, release, version }…] }（多个文件各在不同内源版本里，如外观包、桌宠角色包）。
function itemsOf(spec) {
  const list = Array.isArray(spec.items) ? spec.items
    : (spec.files || (spec.file ? [spec.file] : [])).map(file => ({ file, release: spec.release, version: spec.version }));
  const seen = new Set();
  return list.filter(i => i && i.file && !seen.has(String(i.file).toLowerCase()) && seen.add(String(i.file).toLowerCase()));
}
async function check(spec = {}, { fetchImpl, env = process.env, timeoutMs = openxSource.REACH_TIMEOUT_MS, now = Date.now, fresh = false } = {}) {
  // 本来就只从公司内部渠道下载的组件（CodeAgent 官方渠道、WeLink 内部 npm）：不查 openx，直接标明来源。
  if (spec.internal) return view('internal', { internalName: String(spec.internal), env });
  const items = itemsOf(spec);
  if (!openxSource.enabled(env)) return view('off', { env });
  if (!items.length || typeof fetchImpl !== 'function') return view('missing', { env, reason: '没有可核对的文件名' });
  const key = JSON.stringify([items, !!spec.strict]);
  const hitCache = cache.get(key);
  if (!fresh && hitCache && now() - hitCache.at < CACHE_MS) return hitCache.value;
  // r60：用户点「重测」时清掉「5 分钟内不再试」的标记，真的再连一次。
  if (fresh) openxSource.clearDown();
  if (openxSource.reachability({ now }) === 'down') { const d = openxSource.diagnostics({ now }).down; return view('down', { env, reason: d && d.reason ? d.reason : openxSource.lastReason() }); }
  let hit = 0, down = false, reason = '';
  for (const item of items) {
    const found = await openxSource.find({ file: item.file, version: item.version, release: item.release, strict: !!spec.strict, fetchImpl, env, timeoutMs, now });
    if (found) { hit += 1; continue; }
    reason = openxSource.lastReason();
    if (/连不上/.test(reason)) { down = true; break; }
  }
  const total = items.length;
  const value = down ? view('down', { env, reason })
    : hit === total ? view('ok', { env, total, hit })
      : hit > 0 ? view('partial', { env, total, hit, reason })
        : view('missing', { env, total, hit: 0, reason });
  cache.set(key, { at: now(), value });
  return value;
}

function _reset() { cache.clear(); }

module.exports = { check, view, shortReason, _reset };
