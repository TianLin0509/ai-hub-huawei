'use strict';

// Dependency-free source guard for runtime child_process calls, including injected runners.
const fs = require('node:fs');
const path = require('node:path');

function mask(source) {
  // Keep offsets and newlines so diagnostics point to the original call. Quoted
  // command text is data, not another child_process call in this module.
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    s => s.replace(/[^\n]/g, ' '));
}

function argumentsAt(code, start) {
  const args = [];
  let from = start + 1, depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === ')' && depth === 0) { args.push([from, i]); return args; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { args.push([from, i]); from = i + 1; }
  }
  return [];
}

function objectAt(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  return '';
}

function scanSource(source, file = '') {
  if (!/require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source)) return [];
  const code = mask(source);
  const aliases = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
    'spawnImpl', 'spawnFn', 'execFileImpl', 'execFileAsync']);
  // Destructured aliases and injected defaults (run = execFile, exec = cp.execFile).
  for (const m of code.matchAll(/\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|fork)\s*:\s*(\w+)/g)) aliases.add(m[1]);
  for (const m of code.matchAll(/\b(\w+)\s*=\s*(?:(?:\w+\.)?\w+\s*\|\|\s*)?(?:\w+\.)?(spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\b/g)) aliases.add(m[1]);
  // Local command wrappers are checked at their child_process invocation, not
  // once again at every domain call site.
  const wrappers = new Set();
  for (const m of code.matchAll(/\bfunction\s+(\w+)\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g)) wrappers.add(m[1] || m[2]);
  for (const m of code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*?\|\|\s*\(\(/g)) wrappers.add(m[1]);
  for (const m of code.matchAll(/\b(\w+)\s*=\s*(\w+)\s*[,})]/g)) if (wrappers.has(m[2])) wrappers.add(m[1]);
  for (const name of wrappers) aliases.delete(name);
  const objects = new Map();
  for (const m of code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*\{/g)) objects.set(m[1], objectAt(code, m.index + m[0].length - 1));
  function resolveOption(option, seen = new Set()) {
    if (/^\w+$/.test(option.trim())) {
      const id = option.trim();
      if (seen.has(id)) return '';
      seen.add(id);
      return resolveOption(objects.get(id) || '', seen);
    }
    return option.replace(/\.\.\.\s*(\w+)/g, (_, id) => resolveOption(id, new Set(seen)));
  }
  const issues = [];
  for (const m of code.matchAll(/\b(\w+)\s*\(/g)) {
    if (!aliases.has(m[1])) continue;
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    if (['exec', 'run'].includes(m[1]) && /\.\s*$/.test(before) && !/(?:cp|childProcess|child_process)\.\s*$/.test(before)) continue;
    // Ignore declarations, and domain operations named fork (session branching).
    if (/\b(?:function|async)\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (m[1] === 'fork' && /\.\s*$/.test(before) && !/(?:childProcess|cp)\.$/.test(before)) continue;
    const args = argumentsAt(code, m.index + m[0].lastIndexOf('('));
    if (!args.length) continue;
    // spawnServe and other domain wrappers receive one specification object;
    // they are not Node's command/arguments/options API.
    if (args.length === 1 && m[1] === 'spawnImpl') continue;
    // A definition's argument list ends in {, whereas a call's does not.
    if (/^\s*\{/.test(code.slice(args.at(-1)[1] + 1))) continue;
    const option = args.slice(1, 4).map(([a, b]) => resolveOption(code.slice(a, b))).find(a => /\bwindowsHide\s*:/.test(a));
    const rawCall = source.slice(m.index, args.at(-1)[1] + 1);
    // These are user-requested GUI programs, never background console probes.
    // Keep the exact existing visible launch; widening this list requires review.
    const gui = (file === 'core/account-browser.js' && m[1] === 'spawn' && /windowsHide\s*:\s*false/.test(rawCall) && /--new-window/.test(rawCall))
      || (file === 'core/company-assistant/ppt-ipc.js' && m[1] === 'spawn' && /^spawn\(exe,\s*\[\]/.test(rawCall) && /windowsHide\s*:\s*false/.test(rawCall))
      || (file === 'core/personal-chrome.js' && m[1] === 'spawn' && /windowsHide\s*:\s*false/.test(rawCall) && /launchArgs\(identityId/.test(rawCall))
      || (file === 'core/hub-chrome.js' && m[1] === 'spawn' && /windowsHide\s*:\s*!options\?\.visible/.test(rawCall))
      || (file === 'core/aliyun-console.js' && m[1] === 'spawn' && /windowsHide\s*:\s*!visible\s*\|\|\s*this\.parkVisible\(\)/.test(rawCall));
    if (!gui && (!option || !/\bwindowsHide\s*:\s*true\b/.test(option))) {
      issues.push({ file, line: source.slice(0, m.index).split('\n').length, call: m[1] });
    }
  }
  return issues;
}

function scanTree(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'vendor', 'lite-vendor', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:c?js|mjs)$/.test(entry.name)) files.push(full);
    }
  }
  for (const dir of ['main', 'core', 'scripts', 'renderer']) walk(path.join(root, dir));
  for (const name of fs.readdirSync(root)) if (/\.(?:c?js|mjs)$/.test(name)) files.push(path.join(root, name));
  return files.flatMap(file => scanSource(fs.readFileSync(file, 'utf8'), path.relative(root, file).replace(/\\/g, '/')));
}

if (require.main === module) {
  const issues = scanTree(path.resolve(__dirname, '..'));
  console.log(JSON.stringify(issues, null, 2));
  process.exitCode = issues.length ? 1 : 0;
}
module.exports = { scanSource, scanTree };
