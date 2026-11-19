'use strict';
// 2026-11-20 运行时风暴排查：后台身份核对在两个 .claude.json 都没变时不再整份解析；任何一个变了照常核对。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { identityDrift } = require('../core/claude-account-runtime');
const { globalConfigPath } = require('../core/claude-account-credentials');

test('文件没变时复用「一致」结论；账号文件改了立即重新核对出不一致', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'rt'), profileHome = path.join(dir, 'acct');
  fs.mkdirSync(home); fs.mkdirSync(profileHome, { recursive: true });
  const src = globalConfigPath(profileHome); fs.mkdirSync(path.dirname(src), { recursive: true });
  const ident = { oauthAccount: { accountUuid: 'A' }, userID: 'u1' };
  fs.writeFileSync(src, JSON.stringify(ident));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ ...ident, big: 'x'.repeat(1000) }));
  const profile = { id: 'p1', home: profileHome };
  assert.equal(identityDrift(home, profile), null);
  const reads = []; const orig = fs.readFileSync;
  fs.readFileSync = function (...a) { reads.push(String(a[0])); return orig.apply(this, a); };
  try { assert.equal(identityDrift(home, profile), null); } finally { fs.readFileSync = orig; }
  assert.equal(reads.filter(f => f.endsWith('.claude.json')).length, 0, '没变时不再读');
  fs.writeFileSync(src, JSON.stringify({ oauthAccount: { accountUuid: 'B' }, userID: 'u2-longer' }));
  const drift = identityDrift(home, profile);
  assert.ok(drift && drift.want.oauthAccount.accountUuid === 'B');
});
