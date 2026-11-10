#!/usr/bin/env node
'use strict';

// Run the exported tree's own dependency installation and test command. Never
// borrow node_modules from the source checkout: that can hide export defects.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..');
// Machine ledger location comes from the CI step environment (AI_HUB_MACHINE_SLOTS); absent means no ledger.
const LEDGER = process.env.AI_HUB_MACHINE_SLOTS || null;

function readArgs(argv) {
  const args = { execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--tree' || key === '--log-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${key}`);
      args[key === '--tree' ? 'tree' : 'logDir'] = path.resolve(argv[++i]);
    } else if (key === '--execute-in-slot') args.execute = true;
    else if (key === '--require-ledger') args.requireLedger = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.tree) throw new Error('--tree is required');
  return args;
}

function validateTree(tree, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Public-tree test gate requires Windows (owned-process watchdog).');
  for (const file of ['package.json', 'package-lock.json']) {
    if (!fs.statSync(path.join(tree, file)).isFile()) throw new Error(`Missing public-tree file: ${file}`);
  }
  if (!JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).scripts?.test) {
    throw new Error('Exported package.json has no test command');
  }
  const modules = path.join(tree, 'node_modules');
  let modulesStat;
  try { modulesStat = fs.lstatSync(modules); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (modulesStat?.isSymbolicLink()) {
    throw new Error('Refusing npm ci on linked node_modules');
  }
}

function phasePlans(tree, source = SOURCE) {
  const watchdog = path.join(source, 'tests', 'helpers', 'test-budget.py');
  return [
    { name: 'install', seconds: 600, npm: ['ci', '--prefer-offline', '--no-audit', '--no-fund'] },
    { name: 'test', seconds: 1800, npm: ['test'] }, // 2026-11-08：机器满载时 900 秒误超时
  ].map(phase => ({ ...phase, command: 'python', args: [watchdog, '--timeout-seconds', String(phase.seconds),
    '--label', `public-${phase.name}`, '--', 'npm.cmd', ...phase.npm], cwd: tree }));
}

function statusOf(result) {
  if (result.error || result.signal) return 125;
  return Number.isInteger(result.status) ? result.status : 125;
}

function executePhases({ tree, logDir }, { spawn = spawnSync, log = console.log } = {}) {
  const result = { ok: false, exitCode: 125, phase: 'install', tree, logDir, phases: [] };
  fs.mkdirSync(logDir, { recursive: true });
  for (const phase of phasePlans(tree)) {
    const stdout = path.join(logDir, `${phase.name}-stdout.log`);
    const stderr = path.join(logDir, `${phase.name}-stderr.log`);
    const out = fs.openSync(stdout, 'w'), err = fs.openSync(stderr, 'w');
    const started = Date.now();
    let run;
    log(`[public-tests] ${phase.name}: budget ${phase.seconds}s; cwd=${tree}`);
    try {
      run = spawn(phase.command, phase.args, { cwd: tree, windowsHide: true,
        stdio: ['ignore', out, err], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    } catch (error) {
      run = { status: null, error };
    } finally {
      fs.closeSync(out); fs.closeSync(err);
    }
    const detail = { name: phase.name, exitCode: statusOf(run), elapsedMs: Date.now() - started,
      stdout, stderr, ...(run.error ? { error: run.error.message } : {}), ...(run.signal ? { signal: run.signal } : {}) };
    result.phases.push(detail);
    result.phase = phase.name; result.exitCode = detail.exitCode;
    // Keep the complete phase output both in artifacts and in the CI log.
    process.stdout.write(fs.readFileSync(stdout)); process.stderr.write(fs.readFileSync(stderr));
    log(`[public-tests] ${phase.name}: exit=${detail.exitCode}; elapsedMs=${detail.elapsedMs}`);
    if (detail.exitCode !== 0) break;
  }
  result.ok = result.phases.length === 2 && result.exitCode === 0;
  fs.writeFileSync(path.join(logDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function runPublicTree({ tree, logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tests-')), execute = false,
  requireLedger = Boolean(process.env.AI_HUB_MACHINE_SLOTS) },
  { spawn = spawnSync, ledger = LEDGER, platform = process.platform, log = console.log } = {}) {
  tree = path.resolve(tree); logDir = path.resolve(logDir);
  validateTree(tree, platform);
  fs.mkdirSync(logDir, { recursive: true });
  if (execute) return executePhases({ tree, logDir }, { spawn, log });
  const ledgerAvailable = Boolean(ledger && fs.existsSync(ledger));
  if (requireLedger && !ledgerAvailable) throw new Error('Required machine ledger is unavailable');
  if (!ledgerAvailable) return executePhases({ tree, logDir }, { spawn, log });
  const file = path.join(logDir, 'result.json');
  // A caller may reuse an artifact directory; never accept an older run's pass.
  if (fs.existsSync(file)) fs.unlinkSync(file);
  log('[public-tests] queue-wait: 4 cores; install/test budgets start after admission');
  // 内存按实测申报（公开树安装 + 单测，峰值与成员版单测相当，约 0.7 GB）；CI 里用 AI_HUB_LEDGER_LABEL 标成 HUB-H CI 的步骤。
  const run = spawn('python', [ledger, 'run', '--cores', '4', '--mem', '1', '--label', process.env.AI_HUB_LEDGER_LABEL || 'public-tree-tests', '--',
    process.execPath, __filename, '--tree', tree, '--log-dir', logDir, '--execute-in-slot'],
  { cwd: SOURCE, windowsHide: true, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const exitCode = statusOf(run);
  let result;
  if (fs.existsSync(file)) result = JSON.parse(fs.readFileSync(file, 'utf8'));
  else result = { ok: false, exitCode: exitCode || 125, phase: 'queue', tree, logDir, phases: [] };
  if (exitCode !== 0 || run.error || run.signal) {
    result.ok = false; result.exitCode = exitCode || 125;
    if (run.error) result.error = run.error.message;
    if (run.signal) result.signal = run.signal;
  }
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (require.main === module) {
  try {
    const result = runPublicTree(readArgs(process.argv.slice(2)));
    console.log('[public-tests] ' + JSON.stringify(result));
    process.exitCode = result.ok ? 0 : result.exitCode || 1;
  } catch (error) {
    console.error('[public-tests] ' + error.message); process.exitCode = 125;
  }
}

module.exports = { readArgs, validateTree, phasePlans, statusOf, executePhases, runPublicTree };
