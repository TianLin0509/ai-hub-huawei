'use strict';
// Keep the explicit test selection outside cmd.exe's 8191-character command line.
// Node launches the runner directly; test scope and runner options stay unchanged.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = require('../tests/unit-test-files.json');
const root = path.resolve(__dirname, '..');
const result = spawnSync(process.execPath, [
  '--require', './core/fs-rename-retry-register.js', '--test',
  '--test-concurrency=4', ...process.argv.slice(2), ...files,
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
