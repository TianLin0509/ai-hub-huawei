'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('signed room component: next-room recovery, initial timing, status retries and advance days', () => {
  for (const file of ['room-next-room-test.py', 'room-control-advance-days-test.py']) {
    const result = spawnSync(process.env.MSZ_PYTHON || 'python', [path.join(__dirname, file)], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
  }
});
