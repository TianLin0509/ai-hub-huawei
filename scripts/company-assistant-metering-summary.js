'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getHubDataDir } = require('../core/data-dir');

async function summarize(dir, date) {
  const groups = new Map(), flags = [];
  const names = (await fs.promises.readdir(dir)).filter(n => /^metering-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  for (const name of names) {
    const day = name.slice(9, 19);
    if (date && date !== day) continue;
    const lines = (await fs.promises.readFile(path.join(dir, name), 'utf8')).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { flags.push({ day, line: i + 1, reason: 'invalid-json' }); continue; }
      const key = day + '/' + r.type;
      const g = groups.get(key) || { day, type: r.type, tasks: 0, failed: 0, measuredTokens: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0, measuredContext: 0, contextChange: 0, compacted: 0, unavailable: 0 };
      g.tasks++; if (r.result !== 'success') g.failed++;
      if (r.tokens) { g.measuredTokens++; for (const k of ['input', 'output', 'cached', 'cacheWrite', 'total']) g[k] += r.tokens[k]; }
      if (r.contextBefore && r.contextAfter) { g.measuredContext++; g.contextChange += r.contextAfter.contextUsed - r.contextBefore.contextUsed; }
      if (r.compacted) g.compacted++;
      const reasons = Object.values(r.reasons || {}).filter(Boolean);
      if (reasons.length) g.unavailable++;
      if (r.compacted || reasons.length) flags.push({ day, taskId: r.taskId, type: r.type, compacted: r.compacted, reasons });
      groups.set(key, g);
    }
  }
  return { groups: [...groups.values()].map(g => ({ ...g, ...(!g.measuredTokens ? { input: null, output: null, cached: null, cacheWrite: null, total: null } : {}), ...(!g.measuredContext ? { contextChange: null } : {}) })), flags };
}

if (require.main === module) {
  const dir = process.argv[2] || path.join(getHubDataDir(), 'company-assistant');
  summarize(dir, process.argv[3]).then(r => console.log(JSON.stringify(r, null, 2))).catch(() => { console.error('无法读取计量目录，请检查路径和权限。'); process.exitCode = 1; });
}
module.exports = { summarize };
