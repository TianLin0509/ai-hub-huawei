'use strict';
// CLI capabilities use the existing bounded, hidden --help/--version probe.
// The synchronous readers never launch a process; unavailable help keeps the
// previous launch behavior. Ranges record compatibility checks, not login or
// model availability. Claude bounds were checked against help fixtures only.
const probes = require('./codeagent-capabilities');
const semver = require('semver');
const TESTED_RANGES = Object.freeze({
  claude: Object.freeze({ min: '2.1.50', max: '2.1.269', evidence: 'help-fixtures' }),
  codex: Object.freeze({ min: '0.159.0', max: '0.169.0', evidence: 'editor-handoff' }),
  dsh: null,
});
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const dshNodes = new Map();

function selectedDsh({ env = process.env, forProbe = false } = {}) {
  const config = require('./hub-config').getConfig();
  const runtime = require('./dsh-cli-profile').resolveDshCliRuntime(config?.acp?.providers?.['deepseek-acp'] || {}, env);
  let node = config?.acp?.nodePath;
  if (!node && config.companyCli && ['proxy', 'api'].includes(config.dshBackend)) {
    if (forProbe) node = require('./cli-tools/registry').managedBin('node', env) || require('./local-node').findNode({env});
    else node = dshNodes.get(runtime.entryPath);
  }
  if (node) dshNodes.set(runtime.entryPath, node);
  const packageFile = require('node:path').join(runtime.modules, '@deepseek-ai/dsh/package.json');
  const version = JSON.parse(require('node:fs').readFileSync(packageFile, 'utf8')).version || '';
  return { runtime, version, invocation: node ? {file:node, args:[runtime.entryPath], env, identityFiles:[packageFile]} : null };
}

function providerForKind(kind) {
  const base = String(kind || '').replace(/-resume$/, '');
  if (base === 'claude' || base === 'deepseek-claude') return 'claude';
  if (base === 'codex' || base === 'deepseek') return 'codex';
  if (base === 'dsh' || base === 'deepseek-acp') return 'dsh';
  return base === 'codeagent' ? 'codeagent' : null;
}
function commandForKind(kind, { env = process.env, platform = process.platform } = {}) {
  const provider = providerForKind(kind);
  if (provider === 'codeagent') return require('./codeagent-config').resolveCodeAgentConfig(env).command;
  if (provider === 'codex' && platform === 'win32') {
    try { return require('../main/codex-windows-command').resolveWindowsCodex(env).command; }
    catch { return null; }
  }
  if (provider === 'dsh') {
    try { return selectedDsh({env}).runtime.entryPath; } catch { return null; }
  }
  return provider;
}
function prepareForKind(kind, options) {
  if (providerForKind(kind) === 'dsh') {
    return Promise.resolve().then(() => {
      const selected = selectedDsh({env:options?.env,forProbe:true});
      return selected.invocation ? probes.prepare(selected.runtime.entryPath, {...options,invocation:selected.invocation}) : undefined;
    }).catch(() => {});
  }
  try { const command = commandForKind(kind, options); return command ? probes.prepare(command, options) : Promise.resolve(); }
  catch { return Promise.resolve(); }
}
function compareVersion(a, b) {
  return semver.compare(a, b);
}
function optionValues(help, flag) {
  const lines = String(help || '').split(/\r?\n/);
  const start = lines.findIndex(line => probes.flagListed(line, flag));
  if (start < 0) return [];
  let block = lines[start];
  for (let i = start + 1; i < lines.length && !/^\s*(?:-\w,?\s+)?--[a-z]/i.test(lines[i]); i++) block += ' ' + lines[i];
  // Commander prints (choices: "low", "medium", "high"); earlier builds
  // list (low, medium, high). Read explicit enumerations only.
  const groups = [...block.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map(match => match[1] || match[2]);
  if (flag === '--effort') {
    for (const group of groups) {
      const found = EFFORTS.filter(value => new RegExp('(?:^|[^a-z])' + value + '(?:[^a-z]|$)', 'i').test(group));
      if (found.length >= 2) return found;
    }
    return [];
  }
  const choices = /choices:\s*([^)]*)/i.exec(block)?.[1];
  return choices ? [...choices.matchAll(/["']([^"']+)["']/g)].map(match => match[1]) : [];
}
function selectEffort(requested, help) {
  if (!help) return requested;
  if (!probes.flagListed(help, '--effort')) return null;
  const values = optionValues(help, '--effort');
  if (!values.length || values.includes(requested)) return requested;
  const rank = EFFORTS.indexOf(requested);
  return rank < 0 ? null : EFFORTS.slice(0, rank + 1).reverse().find(value => values.includes(value)) || null;
}
function snapshot(kind, { env = process.env, platform = process.platform, command = commandForKind(kind, {env, platform}), ...options } = {}) {
  const provider = providerForKind(kind);
  if (provider === 'dsh') {
    try {
      const selected = selectedDsh({env});
      const help = selected.invocation ? probes.readHelp(selected.runtime.entryPath,{...options,platform,invocation:selected.invocation}) : '';
      const flags = [...new Set(help.match(/--[a-z][a-z0-9-]*/g) || [])];
      const values = Object.fromEntries(flags.map(flag => [flag, optionValues(help,flag)]).filter(([,choices])=>choices.length));
      return { provider, command:selected.runtime.entryPath, version:help?(probes.cachedVersion(selected.runtime.entryPath)||selected.version):selected.version, help, flags, values, tested:null, compatibilityNotice:'', probeStatus:help?'selected-help':'unknown-help' };
    } catch { return { provider, command: null, version: '', help: '', flags: [], values: {}, tested: null, compatibilityNotice: '' }; }
  }
  if (!provider || !command) return { version: '', flags: [], values: {}, tested: null, compatibilityNotice: '' };
  const help = probes.readHelp(command, { ...options, platform });
  // A replaced executable invalidates both the help and its version. Unknown
  // help must not make the new process inherit the old version's policy.
  const version = help ? probes.cachedVersion(command) : '';
  const flags = [...new Set(String(help).match(/--[a-z][a-z0-9-]*/g) || [])];
  const values = Object.fromEntries(flags.map(flag => [flag, optionValues(help, flag)]).filter(([, choices]) => choices.length));
  const range = TESTED_RANGES[provider];
  const tested = semver.valid(version) && range ? compareVersion(version, range.min) >= 0 && compareVersion(version, range.max) <= 0 : null;
  return { provider, command, version, help, flags, values, tested,
    compatibilityNotice: tested === false ? `CLI 版本 ${version} 未经测试，已用兼容方式启动` : '' };
}
function claudeEffort(requested) {
  return selectEffort(requested, probes.readHelp('claude'));
}
function effortNotice(requested) {
  const effective = claudeEffort(requested);
  if (effective === requested) return '';
  return effective ? `当前 Claude CLI 不支持 ${requested} 思考档，本次使用不高于请求的最高档 ${effective}`
    : '当前 Claude CLI 不支持 --effort，本次沿用 CLI 默认思考档';
}
function filterArgs(kind, args, options) {
  const state = snapshot(kind, options);
  const filtered = probes.filterArgs(args, state.help);
  if (state.provider !== 'claude') return filtered;
  const effortAt = filtered.args.indexOf('--effort');
  if (effortAt >= 0) {
    const value = filtered.args[effortAt + 1];
    if (value === undefined || String(value).startsWith('--')) filtered.args.splice(effortAt, 1);
    else {
      const effective = selectEffort(value, state.help);
      if (effective === null) filtered.args.splice(effortAt, 2);
      else filtered.args[effortAt + 1] = effective;
    }
  }
  return filtered;
}
module.exports = { TESTED_RANGES, providerForKind, commandForKind, prepareForKind, snapshot, optionValues, selectEffort, claudeEffort, effortNotice, filterArgs };
