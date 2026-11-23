'use strict';
// 模型名统一对照（2026-11-23 WeLink 3 人反馈：切模型失败、组队成员建不出来）。
//
// 同一个模型在 Hub 里有三种写法：带线路前缀（ascend/GLM-5.2）、账号清单的内部 id（maas-glm-5.2-volcengine-codeagent）、
// CodeAgent 菜单的显示名（GLM-5.2(Volcano-MaaS)）。以前各处拿一种写法原样去另一处按字符串找，找不到就失败。
// 这里是唯一的对照入口，按下面的顺序认：
//   1. 原样相同（不分大小写、去掉首尾空白）；
//   2. 归一后相同：去线路前缀、全角括号与空白归一、只比字母数字；
//   3. 已知目录（账号 serve 清单的 id ↔ 显示名）里能对上；
//   4. 词元等价：拆成词元、去掉无区分度的词（maas、codeagent 等），双方词元一一对上；词元只认完全相同、版本号相同，
//      或同在下面明确列出的一组供应商别名里（volcano ↔ volcengine）。不按「前几个字母相同」猜（Qwen3-Coder ≠ Qwen3-Code）；
//   5. 都不行时，可选在同家族、同版本号（主版本与小版本都相同）、Auto 与非 Auto 一致的候选里挑最接近的一个，
//      返回 kind:'similar'，调用方须在界面说明「已改用 X」。几个候选同分（同版本多条线路、没指定线路）返回 kind:'ambiguous'，
//      不取第一项；同家族只有别的版本时返回 kind:'none' 并带 sameFamily，调用方按账号默认模型处理并说明。
// 模型本身不建对照表：只认上面这些规则、供应商别名和调用方给的目录（账号清单的内部 id ↔ 显示名）。

const NOISE = new Set(['maas', 'codeagent', 'codeagentcli', 'cli', 'api', 'model']);
// 同一家供应商（线路）的不同拼法：只认这里明确列出的。
const VENDOR_ALIASES = [['volcano', 'volcengine', 'volc'], ['tencent', 'tencentcloud'], ['aliyun', 'alibaba', 'alibabacloud']];
const vendorGroup = token => VENDOR_ALIASES.findIndex(group => group.includes(token));

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }

// 去掉线路前缀（ascend/、w3/ 等，取最后一个 / 之后）、全角括号转半角、空白收紧、小写。
function normalizeName(value) {
  const text = clean(value).split('/').pop()
    .replace(/（/g, '(').replace(/）/g, ')').replace(/【/g, '[').replace(/】/g, ']')
    .replace(/\s+/g, ' ').replace(/\s*([()[\]\-_·])\s*/g, '$1');
  return text.toLowerCase().trim();
}
const compactKey = value => normalizeName(value).replace(/[^a-z0-9.一-鿿]+/g, '');

// 词元：按非字母数字切开，字母和版本号粘在一起的（glm5.2、v4.1、m2.7）拆成字母 + 数字两段。
function tokens(value) {
  const out = [];
  for (const raw of normalizeName(value).split(/[^a-z0-9.一-鿿]+/)) {
    const part = raw.replace(/^\.+|\.+$/g, '');
    if (!part || NOISE.has(part)) continue;
    const glued = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(part);
    if (glued && glued[1].length >= 2) out.push(glued[1], glued[2]);
    else out.push(part);
  }
  return out;
}
const isVersion = token => /^[vm]?\d+(?:\.\d+)*$/.test(token);
const versionOf = list => (list.find(isVersion) || '').replace(/^[vm]/, '');
// 家族：第一个非版本的字母词（glm / deepseek / minimax / qwen …）。
function familyOf(value) {
  const list = Array.isArray(value) ? value : tokens(value);
  return list.find(token => /^[a-z]/.test(token) && !isVersion(token)) || '';
}
function tokenEqual(a, b) {
  if (a === b) return true;
  if (isVersion(a) && isVersion(b)) return a.replace(/^[vm]/, '') === b.replace(/^[vm]/, '');
  const group = vendorGroup(a);
  return group >= 0 && group === vendorGroup(b);
}
// 两组词元一一对上（顺序无关）。
function tokensEquivalent(a, b) {
  if (!a.length || a.length !== b.length) return false;
  const left = b.slice();
  for (const token of a) {
    const at = left.findIndex(other => tokenEqual(token, other));
    if (at < 0) return false;
    left.splice(at, 1);
  }
  return true;
}

// 两个写法是不是同一个模型（不含相近替代）。
function sameModel(a, b) {
  if (!clean(a) || !clean(b)) return false;
  if (clean(a).toLowerCase() === clean(b).toLowerCase()) return true;
  if (compactKey(a) && compactKey(a) === compactKey(b)) return true;
  return tokensEquivalent(tokens(a), tokens(b));
}

// 目录：[{ id, label }]（账号 serve 清单的 details、菜单解析结果等）。返回和 name 是同一模型的所有写法。
function spellings(name, catalog = []) {
  const out = [clean(name)].filter(Boolean);
  for (const row of Array.isArray(catalog) ? catalog : []) {
    const id = clean(row && row.id), label = clean(row && row.label);
    if (!id || !label) continue;
    if ([id, label].some(value => out.some(known => known.toLowerCase() === value.toLowerCase() || compactKey(known) === compactKey(value)))) {
      for (const value of [id, label]) if (!out.some(known => known.toLowerCase() === value.toLowerCase())) out.push(value);
    }
  }
  return out;
}

// 相近度：只在同家族、版本号完全相同（主版本与小版本）、Auto 与非 Auto 一致时才算候选，否则 -Infinity；
// 共有词元加分，候选里多出来的词扣分。
const hasAuto = list => list.includes('auto');
function similarity(want, candidate) {
  const a = tokens(want), b = tokens(candidate);
  const family = familyOf(a);
  if (!family || familyOf(b) !== family) return -Infinity;
  const va = versionOf(a), vb = versionOf(b);
  if (!va || va !== vb || hasAuto(a) !== hasAuto(b)) return -Infinity;
  let score = 0;
  const rest = b.filter(token => token !== family && !isVersion(token));
  const wantRest = a.filter(token => token !== family && !isVersion(token));
  for (const token of wantRest) if (rest.some(other => tokenEqual(token, other))) score += 1;
  for (const token of rest) if (!wantRest.some(other => tokenEqual(token, other))) score -= 0.5;
  return score;
}

// 在 candidates（字符串数组）里找 want。返回：
//   { index, name, kind: 'exact' | 'normalized' | 'catalog' | 'equivalent' | 'similar' }，或
//   { index: -1, name: '', kind: 'none', options }（options 是可选项，报错时列出来）。
// allowSimilar：精确查不到时是否按相近度挑同家族的一个；多个候选同分取列表里靠前的那个（菜单顺序）。
function resolveName(want, candidates, { catalog = [], allowSimilar = false } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).map(clean);
  const target = clean(want);
  const hit = (index, kind) => ({ index, name: list[index], kind });
  const none = { index: -1, name: '', kind: 'none', options: list.filter(Boolean) };
  if (!target) return none;
  const unique = indexes => (indexes.length === 1 ? indexes[0] : -1);
  let index = unique(list.map((name, i) => name.toLowerCase() === target.toLowerCase() ? i : -1).filter(i => i >= 0));
  if (index >= 0) return hit(index, 'exact');
  index = unique(list.map((name, i) => compactKey(name) && compactKey(name) === compactKey(target) ? i : -1).filter(i => i >= 0));
  if (index >= 0) return hit(index, 'normalized');
  const aliases = spellings(target, catalog).slice(1);
  if (aliases.length) {
    index = unique(list.map((name, i) => aliases.some(alias => alias.toLowerCase() === name.toLowerCase() || compactKey(alias) === compactKey(name)) ? i : -1).filter(i => i >= 0));
    if (index >= 0) return hit(index, 'catalog');
  }
  const wantTokens = tokens(target);
  index = unique(list.map((name, i) => tokensEquivalent(wantTokens, tokens(name))
    || aliases.some(alias => tokensEquivalent(tokens(alias), tokens(name))) ? i : -1).filter(i => i >= 0));
  if (index >= 0) return hit(index, 'equivalent');
  const family = familyOf(wantTokens);
  const sameFamily = family ? list.filter(name => name && familyOf(name) === family) : [];
  if (!allowSimilar) return { ...none, sameFamily };
  let best = [], bestScore = -Infinity;
  list.forEach((name, i) => {
    // 菜单截断显示的名字（以 … 或 ... 结尾）看不全，不拿来做相近替代；截断名的唯一命中由菜单选择自己的规则处理。
    if (/(?:…|\.\.\.)$/.test(name)) return;
    const score = Math.max(similarity(target, name), ...aliases.map(alias => similarity(alias, name)));
    if (!Number.isFinite(score)) return;
    if (score > bestScore) { best = [i]; bestScore = score; } else if (score === bestScore) best.push(i);
  });
  if (best.length === 1) return hit(best[0], 'similar');
  if (best.length > 1) return { index: -1, name: '', kind: 'ambiguous', candidates: best.map(i => list[i]), options: none.options, sameFamily };
  return { ...none, sameFamily };
}

// 只认同一模型（不做相近替代）时的便捷写法：返回 candidates 里对应的那个写法，找不到返回 ''。
function findSame(want, candidates, options = {}) {
  return resolveName(want, candidates, { ...options, allowSimilar: false }).name || '';
}

// 一行说明：相近替代、或没有可替代的同版本模型而沿用账号默认模型时，界面显示。
function substitutionNote(from, to) { return `模型菜单里没有 ${from}，已改用最接近的 ${to}`; }
function fallbackNote(from, resolved) {
  if (resolved && resolved.kind === 'ambiguous') return `模型菜单里没有 ${from}，同版本有多条线路（${resolved.candidates.join('、')}），没指定线路，沿用账号默认模型`;
  const others = (resolved && resolved.sameFamily) || [];
  return `模型菜单里没有 ${from}${others.length ? `（同家族只有 ${others.join('、')}，版本或 Auto 不同，不自动替换）` : ''}，沿用账号默认模型`;
}

module.exports = { normalizeName, compactKey, tokens, familyOf, sameModel, spellings, similarity, resolveName, findSame, substitutionNote, fallbackNote };
