'use strict';
// CodeAgent / Claude 会话记录所在目录（2026-10-30 从公司联动的回执读取里抽出，子任务进度等公共功能共用）：
// 绑定的记录所在目录，加上「号的配置目录\projects\<工作目录 slug>」（工作目录的真实路径不同就两种都查）。
const fs = require('node:fs');
function projectSlugOf(cwd) { return require('node:path').resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-'); }
function transcriptDirs(meta, fsModule = fs) {
  const path = require('node:path');
  const dirs = [];
  if (meta?.transcriptPath) dirs.push(path.dirname(meta.transcriptPath));
  const configDir = meta?.codeagentConfigDir;
  if (configDir && meta?.cwd) {
    const forms = [path.resolve(String(meta.cwd))];
    try { const real = fsModule.realpathSync.native ? fsModule.realpathSync.native(forms[0]) : fsModule.realpathSync(forms[0]); if (real && real.toLowerCase() !== forms[0].toLowerCase()) forms.push(real); } catch { /* 目录不在了：只按原写法 */ }
    for (const form of forms) dirs.push(path.join(configDir, 'projects', projectSlugOf(form)));
  }
  const seen = new Set();
  return dirs.filter(d => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
const MAX_SCAN_FILES = 12;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
function candidateTranscripts(meta, since, fsModule = fs) {
  const path = require('node:path');
  const out = [];
  for (const dir of transcriptDirs(meta, fsModule)) {
    let names; try { names = fsModule.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let st; try { st = fsModule.statSync(file); } catch { continue; }
      if (st.mtimeMs < since || st.size > MAX_SCAN_BYTES) continue;
      if (!out.some(x => x.file.toLowerCase() === file.toLowerCase())) out.push({ file, mtime: st.mtimeMs, size: st.size });
    }
  }
  const bound = String(meta?.transcriptPath || '').toLowerCase();
  return out.sort((a, b) => Number(b.file.toLowerCase() === bound) - Number(a.file.toLowerCase() === bound) || b.mtime - a.mtime).slice(0, MAX_SCAN_FILES);
}
module.exports = { projectSlugOf, transcriptDirs, candidateTranscripts, MAX_SCAN_FILES, MAX_SCAN_BYTES };
