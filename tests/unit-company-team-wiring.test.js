'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { handleTeamRequest } = require('../main/team/route');
const { canWakeTeamSession } = require('../main/team/wake');
const { scrubParentControlEnv } = require('./helpers/hub-launcher');

test('team route binds the caller identity before dispatching a command', async () => {
  const teamTokenFor = sid => createHmac('sha256', 'local-test-secret').update(sid).digest('hex');
  const calls = [];
  const service = { invoke: async (...args) => { calls.push(args); return { ok: true }; } };
  const parsed = { token: 'hook-fixture', sessionId: 'lead-fixture', teamToken: teamTokenFor('lead-fixture'), action: 'status', args: {} };
  const request = value => handleTeamRequest({ parsed: value, hookToken: 'hook-fixture', teamTokenFor, service });
  for (const invalid of [
    { ...parsed, sessionId: 'member-fixture' },
    { ...parsed, teamToken: undefined },
    { ...parsed, teamToken: 'bad' },
    { ...parsed, token: 'wrong-hook' },
  ]) assert.equal((await request(invalid)).statusCode, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request(parsed)).statusCode, 200);
  assert.deepEqual(calls, [['lead-fixture', 'status', {}]]);
});

test('team wake does not revive a user-closed session', () => {
  assert.equal(canWakeTeamSession('member', [{ hubId: 'member', suspendReason: 'user-close' }], null), false);
  assert.equal(canWakeTeamSession('member', [], null), false);
  assert.equal(canWakeTeamSession('member', [{ hubId: 'member' }], { status: 'idle' }), false);
  assert.equal(canWakeTeamSession('member', [{ hubId: 'member' }], { status: 'dormant' }), true);
});

test('isolated Hub cannot inherit the parent session team identity', () => {
  const env = scrubParentControlEnv({ CLAUDE_HUB_TEAM_TOKEN: 'parent-fixture', CLAUDE_HUB_SESSION_ID: 'parent', KEEP_FIXTURE: 'yes' });
  assert.equal(env.CLAUDE_HUB_TEAM_TOKEN, undefined);
  assert.equal(env.CLAUDE_HUB_SESSION_ID, undefined);
  assert.equal(env.KEEP_FIXTURE, 'yes');
});
