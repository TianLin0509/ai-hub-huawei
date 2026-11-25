'use strict';
// Owned tree fixture: both processes self-expire even when a cancellation assertion fails.
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),90000)'], { windowsHide: true, stdio: 'ignore' });
process.stdin.resume();
child.on('error', () => process.exit(2));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', grandchildPid: child.pid }) + '\n');
setTimeout(() => process.exit(0), 90000);
