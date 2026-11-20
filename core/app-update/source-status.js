'use strict';
// 下载源状态（r58，2026-11-19 用户定：凡是会从阿里云下载的地方，界面上都要先看到「公司内源」并优先走内源）。
// 统一给各下载点算「内源现在能不能给这个包」：
//   ok       内源上有这个包（按文件名精确找到，下载后仍按清单核 sha256）
//   partial  多文件组件里内源只有一部分，缺的那几个走备用源
//   missing  内源上没有这个包，整包走备用源
//   down     连不上内源（多半不在公司网络），走备用源；r60 起把真实原因写在行里
//   nolist   下载清单/组件目录读不到（如公司网络拦了阿里云），和内源通不通无关
//   checking 正在查（第一次最多等约 3 秒）
//   off      内源被关掉了（排查开关 AI_HUB_OPENX=0）
// 真正的下载仍由 downloader.js 的 downloadWithFallback 完成（内源 → 备用源），这里只读、不下载、不改顺序。
// 查找复用 openx-source.js 的列表与详情缓存，同一 Hub 进程里多次调用基本不再联网。

const openxSource = require('./openx-source');

const CACHE_MS = 2 * 60 * 1000;
const cache = new Map();   // key → { at, value }

const FALLBACK_NAME = '阿里云';

// 原因写进行里时去掉重复的前缀、限制长度（完整原因在悬停提示和「复制排错信息」里）。
function shortReason(reason) {
  const s = String(reason || '').replace(/^内源连不上[：:]?/, '').replace(/（5 分钟内自动重试）$/, '')
    .replace(/^读不到组件(?:目录|清单)[：:]?（(.*)）$/, '$1').trim();
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

function view(status, extra = {}) {
  const fallback = extra.fallback || FALLBACK_NAME;
  const texts = {
    ok: '公司内源 · 可用（优先从内源下载）',
    partial: `公司内源 · 有 ${extra.hit || 0}/${extra.total || 0} 个文件，其余走${fallback}`,
    missing: `公司内源 · 暂缺这个包，本次走${fallback}`,
    down: `公司内源 · 连不上${extra.reason ? '：' + shortReason(extra.reason) : ''}（不在公司网络时正常），本次走${fallback}`,
    nolist: `下载清单读不到${extra.reason ? '：' + shortReason(extra.reason) : ''}（不是内源的问题）`,
    checking: '公司内源 · 正在检查…',
    off: `公司内源 · 已关闭，本次走${fallback}`,
    internal: `${extra.internalName || '公司内部源'}（公司内网，不经阿里云）`,
  };
  return { id: 'openx', name: '公司内源', status, ok: status === 'ok' || status === 'internal', text: texts[status] || texts.checking, fallback, ...extra };
}

// spec：{ files: [文件名…], release: 内源版本名（如 cli-codex-0.167.0）, version, strict, fallback: 备用源的显示名 }
//   或 { items: [{ file, release, version }…] }（多个文件各在不同内源版本里，如外观包、桌宠角色包）。
function itemsOf(spec) {
  const list = Array.isArray(spec.items) ? spec.items
    : (spec.files || (spec.file ? [spec.file] : [])).map(file => ({ file, release: spec.release, version: spec.version }));
  const seen = new Set();
  return list.filter(i => i && i.file && !seen.has(String(i.file).toLowerCase()) && seen.add(String(i.file).toLowerCase()));
}
async function check(spec = {}, { fetchImpl, env = process.env, timeoutMs = openxSource.REACH_TIMEOUT_MS, now = Date.now, fresh = false } = {}) {
  // 本来就只从公司内部渠道下载的组件（CodeAgent 官方渠道、WeLink 内部 npm）：不查 openx，直接标明来源。
  if (spec.internal) return view('internal', { internalName: String(spec.internal), fallback: spec.internal });
  const items = itemsOf(spec);
  const fallback = spec.fallback || FALLBACK_NAME;
  if (!openxSource.enabled(env)) return view('off', { fallback });
  if (!items.length || typeof fetchImpl !== 'function') return view('missing', { fallback, reason: '没有可核对的文件名' });
  const key = JSON.stringify([items, !!spec.strict]);
  const hitCache = cache.get(key);
  if (!fresh && hitCache && now() - hitCache.at < CACHE_MS) return hitCache.value;
  // r60：用户点「重测」时清掉「5 分钟内不再试」的标记，真的再连一次。
  if (fresh) openxSource.clearDown();
  if (openxSource.reachability({ now }) === 'down') { const d = openxSource.diagnostics({ now }).down; return view('down', { fallback, reason: d && d.reason ? d.reason : openxSource.lastReason() }); }
  let hit = 0, down = false, reason = '';
  for (const item of items) {
    const found = await openxSource.find({ file: item.file, version: item.version, release: item.release, strict: !!spec.strict, fetchImpl, env, timeoutMs, now });
    if (found) { hit += 1; continue; }
    reason = openxSource.lastReason();
    if (/连不上/.test(reason)) { down = true; break; }
  }
  const total = items.length;
  const value = down ? view('down', { fallback, reason })
    : hit === total ? view('ok', { fallback, total, hit })
      : hit > 0 ? view('partial', { fallback, total, hit, reason })
        : view('missing', { fallback, total, hit: 0, reason });
  cache.set(key, { at: now(), value });
  return value;
}

// 下载结果里的来源（downloader 的返回值）翻成一句话，给「刚才从哪下的」那一行用。
function resultText(result) {
  if (!result || !result.ok) return '';
  if (result.source && result.source.id === 'openx') return '本次从公司内源下载';
  if (result.reused) return '';
  const name = result.source && result.source.name ? result.source.name : FALLBACK_NAME;
  const why = result.openx && result.openx.reason ? `（内源：${result.openx.reason}）` : '';
  return `本次从${name}下载${why}`;
}

function _reset() { cache.clear(); }

module.exports = { check, view, resultText, shortReason, FALLBACK_NAME, _reset };
