'use strict';
// 用户确认过的「模型替代」（2026-11-12，同事反馈助理问答反复弹「原模型不可用」）：
// 新会话没有指定模型时，Hub 按 CodeAgent 配置里的默认模型固定会话；这个默认模型用不了时会弹框让用户换一个。
// 助理问答每问开一个新会话、还会预开下一个，而 Hub 选完模型后又会把 CodeAgent 的默认模型守回原值，
// 于是每个新会话都固定到同一个用不了的模型，用户每问一次就要再选一次。
// 这里记下「原模型 → 用户选的替代模型」，之后只由默认模型推出来的新会话直接用替代模型；用户明确指定的模型不受影响。
// 文件：Hub 数据目录 codeagent-model-replacements.json，{ "<原模型小写>": { from, to, at } }。
const fs = require('fs');
const path = require('path');

const FILE = 'codeagent-model-replacements.json';
const MAX_ENTRIES = 20;
const key = model => String(model || '').trim().toLowerCase();

function readAll(dataDir) {
  if (!dataDir) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

function recordReplacement(dataDir, from, to, now = Date.now()) {
  const models = require('./codeagent-models');
  if (!dataDir || !models.isSafeModelId(from) || !models.isSafeModelId(to) || key(from) === key(to)) return false;
  const all = readAll(dataDir);
  // 新的替代链要接上：A→B 之后又 B→C，A 也直接指向 C；指回自己的删掉。
  for (const [k, row] of Object.entries(all)) {
    if (row && key(row.to) === key(from)) row.to = to;
    if (row && key(row.to) === k) delete all[k];
  }
  all[key(from)] = { from: String(from), to: String(to), at: new Date(now).toISOString() };
  delete all[key(to)];
  const kept = Object.entries(all).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || ''))).slice(0, MAX_ENTRIES);
  const file = path.join(dataDir, FILE), tmp = file + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

// 原模型有替代时返回替代模型名；清单可靠（authoritative）时替代模型必须在清单里，原模型仍在清单里也照样替代
// （用户已经明确换过一次，不再为同一个模型反复问）。
function replacementFor(dataDir, model, { models: list = [], authoritative = false } = {}) {
  const row = readAll(dataDir)[key(model)];
  if (!row || typeof row.to !== 'string' || !require('./codeagent-models').isSafeModelId(row.to)) return '';
  if (!authoritative) return row.to;
  return (list || []).find(id => key(id) === key(row.to)) || '';
}

module.exports = { FILE, recordReplacement, replacementFor };
