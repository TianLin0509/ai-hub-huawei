'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only inspect package definitions; never import user-installed plugin code in Main.
function schemaAcceptsNative(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.properties?.mode) return schemaAcceptsNative(schema.properties.mode);
  if (schema.const !== undefined) return schema.const === 'native';
  if (Array.isArray(schema.enum)) return schema.enum.includes('native');
  if (schema.anyOf || schema.oneOf) {
    const choices = (schema.anyOf || schema.oneOf).map(schemaAcceptsNative);
    return choices.includes(true) ? true : choices.length && choices.every(value => value === false) ? false : null;
  }
  if (schema.type === 'null') return false;
  if (schema.type === 'string' || schema.type?.includes?.('string')) return true;
  return null;
}
function objectFields(source, start) {
  const fields = [];
  let depth = 0, quote = '', field = start, comment = '';
  for (let i = start; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment === '//') { if (ch === '\n') comment = ''; continue; }
    if (comment === '/*') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && (next === '/' || next === '*')) { comment = ch + next; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) { fields.push(source.slice(field, i)); return fields; }
      depth--;
    } else if (ch === ',' && depth === 0) { fields.push(source.slice(field, i)); field = i + 1; }
  }
  return [];
}
function modeAcceptsNative(mode) {
  if (!mode) return null;
  // dsh-tools 0.2.2 起 mode 字段改成 z.never()（说明写「Removed. Mount a native or PTC tool executor instead.」）：
  // 再写 mode:'native' 会让 tools 插件校验失败、DSH 整个起不来（2026-11-20 隔离 E2E 实测：「DSH CLI 启动未确认」）。
  if (/\b(?:Schema|z|s)\.never\s*\(/.test(mode)) return false;
  if (/\b(?:Schema|z|s)\.(?:string|String)\s*\(/.test(mode)) return true;
  if (/['"]native['"]/.test(mode)) return true;
  if (/\b(?:nullable|null|enum|union|const|literal)\b/i.test(mode)) return false;
  return null;
}
function sourceAcceptsNative(source) {
  // In the tools package, Config is the plugin configuration schema. Never use
  // a mode field from a tool argument, result type, or other earlier object.
  const configs = /\b(?:ToolsConfig|Config|ConfigSchema|toolsConfig|configSchema)\s*=\s*(?:(?:Schema|z|s)\.(?:object|Object)\s*\(\s*)?\{/g;
  const results = [];
  for (const match of source.matchAll(configs)) {
    const fields = objectFields(source, match.index + match[0].length);
    for (const field of fields) {
      const mode = /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:mode|"mode"|'mode')\s*:\s*([\s\S]*)$/.exec(field);
      if (mode) results.push(modeAcceptsNative(mode[1]));
    }
  }
  return results.length && results.every(value => value === results[0]) ? results[0] : null;
}
function installedToolsNativeSupport({ modules, entryPath } = {}) {
  const roots = [];
  if (modules) roots.push(modules);
  if (entryPath) {
    let dir = path.dirname(entryPath);
    for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (path.basename(dir) === 'node_modules') roots.push(dir);
  }
  for (const root of [...new Set(roots)]) {
    const dir = path.join(root, '@deepseek-ai', 'dsh-tools');
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const candidates = ['config.schema.json', 'schema.json', 'lib/config.schema.json', 'lib/schema.json', 'lib/config.js', 'lib/index.js', 'dist/index.js', pkg.main];
    for (const rel of candidates.filter(Boolean)) {
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir) + path.sep)) continue;
      try {
        if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
        const source = fs.readFileSync(file, 'utf8');
        const result = /\.json$/i.test(file) ? schemaAcceptsNative(JSON.parse(source)) : sourceAcceptsNative(source);
        if (result !== null) return result;
      } catch { /* Another installed layout may expose the definition. */ }
    }
  }
  return null;
}
function companyToolsPatch(runtime) {
  // Unknown layouts retain the old launch behavior; omit only a known rejection.
  return installedToolsNativeSupport(runtime) === false ? [] : [{ id: 'tools', config: { mode: 'native' } }];
}
module.exports = { schemaAcceptsNative, sourceAcceptsNative, installedToolsNativeSupport, companyToolsPatch };
