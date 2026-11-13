'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubFeedbackService, registerHubFeedbackIpc } = require('../main/hub-feedback-service');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-contact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'profile'));
  const identity = value => fs.writeFileSync(path.join(root, 'profile', 'profile.json'), JSON.stringify({ identity: value }));
  const service = () => createHubFeedbackService({ endpoint: 'https://example.invalid/feedback', info: () => ({ version: '0.0.0' }),
    logsDir: path.join(root, 'logs'), downloadsDir: () => path.join(root, 'downloads'), ...options });
  return { root, identity, service };
}

test('feedback reuses only a cached WeLink login name without making a network request', t => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: () => { calls++; throw Error('unexpected network'); } });
  f.identity({ from: 'welink', uid: 'mock.user', name: '示例用户', email: 'sample@example.com' });
  assert.equal(f.service().preview().contact, 'mock.user');
  assert.equal(calls, 0);
  f.identity({ from: 'system', uid: 'mock.system', name: '系统用户' });
  assert.equal(f.service().preview().contact, '');
  fs.writeFileSync(path.join(f.root, 'profile', 'profile.json'), '{broken');
  assert.equal(f.service().preview().contact, '');
});

test('manual contact survives service restarts, overrides identity, and an explicit clear stays empty', t => {
  const f = fixture(t);
  f.identity({ from: 'welink', uid: 'mock.user' });
  assert.deepEqual(f.service().saveContact({ contact: '  示例联系人  ' }), { ok: true });
  assert.equal(f.service().preview().contact, '示例联系人');
  f.identity({ from: 'welink', uid: 'other.mock' });
  assert.equal(f.service().preview().contact, '示例联系人');
  f.service().saveContact({ contact: '' });
  assert.equal(f.service().preview().contact, '');
});

test('a current local WeLink auth identity is available before the profile has refreshed', t => {
  const f = fixture(t);
  f.identity({ from: 'welink', uid: 'old.mock' });
  const authFile = path.join(f.root, 'company-assistant', 'auth.json');
  fs.mkdirSync(path.dirname(authFile));
  fs.writeFileSync(authFile, JSON.stringify({ state: 'online', login: { ok: true, uid: 'current.mock' } }));
  assert.equal(f.service().preview().contact, 'current.mock');
  fs.writeFileSync(authFile, JSON.stringify({ state: 'needs-scan', login: { ok: false, uid: 'unverified.mock' } }));
  assert.equal(f.service().preview().contact, 'old.mock');
  f.service().saveContact({ contact: 'manual.mock' });
  assert.equal(f.service().preview().contact, 'manual.mock');
});

test('remembering contact bounds local input and does not include the preference in diagnostic files', async t => {
  const f = fixture(t, { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"id":"mock-feedback"}' }) });
  f.service().saveContact({ contact: 'private-local-choice' });
  assert.equal(f.service().preview().items.some(item => /contact/.test(item.name)), false);
  const bundle = require('../core/hub-feedback').collectBundle({ dataDir: f.root, logsDir: path.join(f.root, 'logs') });
  assert.doesNotMatch(bundle.text, /private-local-choice/);
  f.service().saveContact({ contact: 'a\n\u0000' + 'b'.repeat(300) });
  const saved = f.service().preview().contact;
  assert.equal(saved.length, 160);
  assert.equal(/[\x00-\x1f]/.test(saved), false);
  assert.equal(fs.existsSync(path.join(f.root, 'logs')), false, 'remembering a contact produces no diagnostic log');
});

test('send failure remembers the edited contact and local preference storage failure does not block feedback', async t => {
  let offline = true;
  const f = fixture(t, { fetchImpl: async () => {
    if (offline) throw Error('offline');
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"id":"mock-feedback"}' };
  } });
  const result = await f.service().send({ description: '测试发送失败', contact: 'mock.contact' });
  assert.equal(result.ok, false);
  assert.equal(f.service().preview().contact, 'mock.contact');
  const preference = path.join(f.root, 'hub-feedback-contact.json');
  fs.unlinkSync(preference);
  fs.mkdirSync(preference);
  assert.deepEqual(f.service().saveContact({ contact: 'not-saved' }), { ok: false });
  offline = false;
  assert.equal((await f.service().send({ description: '仍可提交', contact: 'not-saved' })).ok, true);
});

test('local-only contact IPC uses the same service preference as preview', t => {
  const f = fixture(t), handlers = new Map();
  registerHubFeedbackIpc({ handle: (name, handler) => handlers.set(name, handler) }, f.service());
  assert.deepEqual(handlers.get('hub-feedback:save-contact')({}, { contact: 'mock.ipc' }), { ok: true });
  assert.equal(handlers.get('hub-feedback:preview')({}, {}).contact, 'mock.ipc');
});
