'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const bundled = require('../core/codeagent-bundled-skills');
const pool = require('../core/codeagent-pool');
const { scanCodeAgentSkills } = require('../core/capability-catalog');

const company = { target: 'company', featureEnabled: () => true };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-skill-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config'), warnings = [];
  return { root, configDir, options: { distribution: company, logger: { warn: message => warnings.push(message) } }, warnings };
}
const skillDir = configDir => path.join(configDir, 'skills', 'company-team');
const skillFile = configDir => path.join(skillDir(configDir), 'SKILL.md');
const markerFile = configDir => path.join(skillDir(configDir), bundled.MARKER_FILE);
const digest = value => createHash('sha256').update(value).digest('hex');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

test('fresh install carries the shipped skill, ownership/version/hash and catalog metadata without changing other skills', t => {
  const f = fixture(t), other = path.join(f.configDir, 'skills', 'my-skill', 'SKILL.md');
  write(other, 'user content');
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).status, 'installed');
  const bytes = fs.readFileSync(skillFile(f.configDir));
  assert.deepEqual(bytes, fs.readFileSync(bundled.BUNDLE_FILE));
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(f.configDir))), {
    schema: 1, owner: 'ai-hub', skill: 'company-team', version: bundled.TEAM_SKILL_VERSION, sha256: digest(bytes),
  });
  const listed = scanCodeAgentSkills(f.configDir).skills.find(item => item.name === 'company-team');
  assert.match(listed.description, /组队/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'user content');
});

test('repeat startup is read-only and an unchanged managed skill upgrades while preserving sibling files', t => {
  const f = fixture(t);
  bundled.syncCompanyTeamSkill(f.configDir, f.options);
  const file = skillFile(f.configDir), marker = markerFile(f.configDir);
  fs.utimesSync(file, 100, 100); fs.utimesSync(marker, 100, 100);
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).status, 'current');
  assert.equal(fs.statSync(file).mtimeMs, 100000);
  assert.equal(fs.statSync(marker).mtimeMs, 100000);
  const upgraded = path.join(f.root, 'next-skill.md');
  const text = fs.readFileSync(file, 'utf8') + '\nUpdated bundled instructions.\n';
  write(upgraded, text); write(path.join(skillDir(f.configDir), 'my-notes.md'), 'keep notes');
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, bundleFile: upgraded, version: '0.4.0' }).status, 'updated');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(JSON.parse(fs.readFileSync(marker)).version, '0.4.0');
  assert.equal(fs.readFileSync(path.join(skillDir(f.configDir), 'my-notes.md'), 'utf8'), 'keep notes');
});

test('existing unmarked or empty skill directories are user-owned even if the content matches the bundle', t => {
  const f = fixture(t);
  fs.mkdirSync(skillDir(f.configDir), { recursive: true });
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'unmanaged');
  assert.equal(fs.existsSync(skillFile(f.configDir)), false);
  fs.copyFileSync(bundled.BUNDLE_FILE, skillFile(f.configDir));
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'unmanaged');
  assert.equal(fs.existsSync(markerFile(f.configDir)), false);
  assert.equal(f.warnings.length, 2);
});

test('failed first installation publishes neither an incomplete skill nor an ownership marker and can retry', t => {
  for (const failure of ['partial-skill-write', 'marker-write', 'publish']) {
    const f = fixture(t), fault = Object.create(fs);
    fault.writeFileSync = (file, content, options) => {
      if (failure === 'marker-write' && path.basename(file) === bundled.MARKER_FILE) throw Object.assign(new Error(failure), { code: 'EPERM' });
      if (failure === 'partial-skill-write' && path.basename(file) === 'SKILL.md') {
        fs.writeFileSync(file, 'partial', options);
        throw Object.assign(new Error(failure), { code: 'EIO' });
      }
      return fs.writeFileSync(file, content, options);
    };
    fault.renameSync = (source, target) => {
      if (failure === 'publish' && target === skillDir(f.configDir)) throw Object.assign(new Error(failure), { code: 'EPERM' });
      return fs.renameSync(source, target);
    };
    assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, fsModule: fault }).status, 'error', failure);
    assert.equal(fs.existsSync(skillDir(f.configDir)), false, failure);
    assert.deepEqual(scanCodeAgentSkills(f.configDir).skills, [], failure);
    assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).status, 'installed', failure);
    assert.deepEqual(fs.readFileSync(skillFile(f.configDir)), fs.readFileSync(bundled.BUNDLE_FILE));
  }
});

function failUpgrade(configDir, failure) {
  const fault = Object.create(fs);
  let markerWrites = 0;
  fault.renameSync = (source, target) => {
    if (target === markerFile(configDir)) markerWrites += 1;
    if ((target === markerFile(configDir) && markerWrites === (failure === 'prepare-marker' ? 1 : failure === 'commit-marker' ? 2 : -1))
      || (failure === 'replace-skill' && target === skillFile(configDir))) throw Object.assign(new Error(failure), { code: 'EPERM' });
    return fs.renameSync(source, target);
  };
  fault.writeFileSync = (file, content, options) => {
    if (failure === 'partial-skill-write' && path.basename(file).startsWith('SKILL.md.')) {
      fs.writeFileSync(file, 'partial', options);
      throw Object.assign(new Error(failure), { code: 'EIO' });
    }
    return fs.writeFileSync(file, content, options);
  };
  return fault;
}

test('interrupted upgrades recover after every write boundary, including when the next startup ships a newer bundle', t => {
  for (const failure of ['prepare-marker', 'partial-skill-write', 'replace-skill', 'commit-marker']) {
    for (const skipVersion of [false, true]) {
      const f = fixture(t), next = path.join(f.root, 'v2.md'), newest = path.join(f.root, 'v3.md');
      bundled.syncCompanyTeamSkill(f.configDir, f.options);
      const original = fs.readFileSync(skillFile(f.configDir));
      write(next, Buffer.concat([original, Buffer.from('\nVersion two.\n')]));
      write(newest, Buffer.concat([original, Buffer.from('\nVersion three.\n')]));
      const options = { ...f.options, bundleFile: next, version: '0.4.0' };
      assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...options, fsModule: failUpgrade(f.configDir, failure) }).status, 'error', failure);
      const current = fs.readFileSync(skillFile(f.configDir));
      assert(current.equals(original) || current.equals(fs.readFileSync(next)), 'a partial file must never replace the installed skill');
      const recovery = skipVersion ? { ...f.options, bundleFile: newest, version: '0.5.0' } : options;
      assert.equal(bundled.syncCompanyTeamSkill(f.configDir, recovery).status, 'updated', failure);
      assert.deepEqual(fs.readFileSync(skillFile(f.configDir)), fs.readFileSync(recovery.bundleFile));
      const marker = JSON.parse(fs.readFileSync(markerFile(f.configDir)));
      assert.equal(marker.version, recovery.version);
      assert.equal(marker.pending, undefined);
      assert.equal(marker.sha256, digest(fs.readFileSync(skillFile(f.configDir))));
      assert.equal(bundled.syncCompanyTeamSkill(f.configDir, recovery).status, 'current');
    }
  }
});

test('recovery does not take over content the user edited after an interrupted upgrade', t => {
  const f = fixture(t), next = path.join(f.root, 'next.md');
  bundled.syncCompanyTeamSkill(f.configDir, f.options);
  write(next, fs.readFileSync(skillFile(f.configDir), 'utf8') + '\nNew instructions.\n');
  const options = { ...f.options, bundleFile: next, version: '0.4.0' };
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...options, fsModule: failUpgrade(f.configDir, 'commit-marker') }).status, 'error');
  fs.appendFileSync(skillFile(f.configDir), '\nUser changes after the interrupted update.\n');
  const content = fs.readFileSync(skillFile(f.configDir)), marker = fs.readFileSync(markerFile(f.configDir));
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, options).reason, 'user-modified');
  assert.deepEqual(fs.readFileSync(skillFile(f.configDir)), content);
  assert.deepEqual(fs.readFileSync(markerFile(f.configDir)), marker);
});

test('user edits, removed skills and malformed ownership markers are preserved with a reason in the log', t => {
  const f = fixture(t);
  bundled.syncCompanyTeamSkill(f.configDir, f.options);
  const originalMarker = fs.readFileSync(markerFile(f.configDir));
  fs.appendFileSync(skillFile(f.configDir), '\nUser changes.');
  const changed = fs.readFileSync(skillFile(f.configDir));
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'user-modified');
  assert.deepEqual(fs.readFileSync(skillFile(f.configDir)), changed);
  assert.deepEqual(fs.readFileSync(markerFile(f.configDir)), originalMarker);
  fs.unlinkSync(skillFile(f.configDir));
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'changed-or-missing-skill');
  assert.equal(fs.existsSync(skillFile(f.configDir)), false);
  fs.writeFileSync(markerFile(f.configDir), '{invalid');
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'invalid-marker');
  assert.match(f.warnings.join('\n'), /user-modified/);
});

test('a linked skill directory is not followed or taken over', t => {
  const f = fixture(t), outside = path.join(f.root, 'elsewhere');
  write(path.join(outside, 'SKILL.md'), 'user skill');
  fs.mkdirSync(path.dirname(skillDir(f.configDir)), { recursive: true });
  fs.symlinkSync(outside, skillDir(f.configDir), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, f.options).reason, 'linked-or-invalid-directory');
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'user skill');
  assert.equal(fs.existsSync(path.join(outside, bundled.MARKER_FILE)), false);
});

test('non-company and disabled-team builds neither read the bundle nor create account directories', t => {
  const f = fixture(t);
  for (const distribution of [{ target: 'personal', featureEnabled: () => true }, { target: 'company', featureEnabled: () => false }]) {
    const options = { ...f.options, distribution, bundleFile: path.join(f.root, 'missing') };
    assert.equal(bundled.syncCompanyTeamSkill(f.configDir, options).status, 'disabled');
    assert.deepEqual(bundled.syncCompanyTeamSkills({ dataDir: f.root, personalDir: f.configDir, ...options }), []);
  }
  assert.equal(fs.existsSync(f.configDir), false);
});

test('startup sync covers personal and all registered pool accounts, and one user-owned skill does not block the rest', t => {
  const f = fixture(t), dataDir = path.join(f.root, 'hub');
  write(path.join(pool.poolRoot(dataDir), 'pool.json'), JSON.stringify({ accounts: [{ id: 'first001' }, { id: 'second02' }] }));
  const first = pool.accountDir(dataDir, 'first001'), second = pool.accountDir(dataDir, 'second02');
  write(skillFile(first), 'custom account instructions');
  const results = bundled.syncCompanyTeamSkills({ dataDir, personalDir: f.configDir, ...f.options });
  assert.deepEqual(results.map(row => row.status), ['installed', 'preserved', 'installed']);
  assert.equal(fs.readFileSync(skillFile(first), 'utf8'), 'custom account instructions');
  assert.equal(scanCodeAgentSkills(second).skills[0].name, 'company-team');
});

test('accounts added after startup receive the skill immediately', t => {
  const f = fixture(t);
  const id = pool.addAccount(f.root, { note: 'new account' });
  const configDir = pool.accountDir(f.root, id);
  assert.equal(scanCodeAgentSkills(configDir).skills.find(item => item.name === 'company-team').name, 'company-team');
  assert.equal(fs.existsSync(markerFile(configDir)), true);
});

test('personal-to-pool startup copying cannot bypass the managed skill edit check', t => {
  const f = fixture(t), target = path.join(f.root, 'pool-account');
  bundled.syncCompanyTeamSkill(f.configDir, f.options);
  bundled.syncCompanyTeamSkill(target, f.options);
  fs.appendFileSync(skillFile(f.configDir), '\nPersonal custom instructions.');
  fs.appendFileSync(skillFile(target), '\nPool custom instructions.');
  // Windows treats a user-renamed Company-Team directory as the same skill.
  if (process.platform === 'win32') fs.renameSync(skillDir(f.configDir), path.join(f.configDir, 'skills', 'Company-Team'));
  const before = fs.readFileSync(skillFile(target)), marker = fs.readFileSync(markerFile(target));
  const other = path.join('skills', 'regular', 'SKILL.md');
  write(path.join(f.configDir, other), 'ordinary skill');
  const result = pool.syncSharedConfig(f.configDir, target, fs, { routeSwitch: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(fs.readFileSync(skillFile(target)), before);
  assert.deepEqual(fs.readFileSync(markerFile(target)), marker);
  assert.equal(fs.readFileSync(path.join(target, other), 'utf8'), 'ordinary skill');
  const freshTarget = path.join(f.root, 'fresh-pool');
  pool.syncSharedConfig(f.configDir, freshTarget, fs, { routeSwitch: false });
  assert.deepEqual(fs.readFileSync(skillFile(freshTarget)), fs.readFileSync(skillFile(f.configDir)));
  assert.equal(JSON.parse(fs.readFileSync(markerFile(freshTarget))).version, 'personal');
});

test('unmarked and edited personal skills propagate at startup while pool-owned edits remain intact', t => {
  for (const marked of [false, true]) {
    const f = fixture(t), dataDir = path.join(f.root, 'hub');
    const ids = ['managed1', 'newacct1', 'custom01'];
    write(path.join(pool.poolRoot(dataDir), 'pool.json'), JSON.stringify({ accounts: ids.map(id => ({ id })) }));
    const [managed, fresh, edited] = ids.map(id => pool.accountDir(dataDir, id));
    bundled.syncCompanyTeamSkill(managed, f.options);
    bundled.syncCompanyTeamSkill(edited, f.options);
    fs.appendFileSync(skillFile(edited), '\nPool-owned notes.\n');
    const editedBefore = fs.readFileSync(skillFile(edited));
    if (marked) bundled.syncCompanyTeamSkill(f.configDir, f.options);
    write(skillFile(f.configDir), '---\nname: company-team\n---\nPersonal instructions one.\n');
    const sync = () => bundled.syncCompanyTeamSkills({ dataDir, personalDir: f.configDir, ...f.options });
    sync();
    for (const dir of [managed, fresh]) assert.deepEqual(fs.readFileSync(skillFile(dir)), fs.readFileSync(skillFile(f.configDir)));
    fs.appendFileSync(skillFile(f.configDir), '\nPersonal instructions two.\n');
    sync();
    for (const dir of [managed, fresh]) assert.deepEqual(fs.readFileSync(skillFile(dir)), fs.readFileSync(skillFile(f.configDir)));
    assert.deepEqual(fs.readFileSync(skillFile(edited)), editedBefore);
    assert.equal(JSON.parse(fs.readFileSync(markerFile(managed))).version, 'personal');
    const id = pool.addAccount(dataDir, { personalDir: f.configDir });
    assert.deepEqual(fs.readFileSync(skillFile(pool.accountDir(dataDir, id))), fs.readFileSync(skillFile(f.configDir)));
  }
});

test('an unfinished managed personal upgrade is not treated as a user customization', t => {
  const f = fixture(t), next = path.join(f.root, 'next.md'), target = path.join(f.root, 'pool');
  bundled.syncCompanyTeamSkill(f.configDir, f.options);
  write(next, fs.readFileSync(bundled.BUNDLE_FILE, 'utf8') + '\nAnother Hub revision.\n');
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, bundleFile: next, version: '0.4.0',
    fsModule: failUpgrade(f.configDir, 'commit-marker') }).status, 'error');
  assert.equal(bundled.syncCompanyTeamSkill(target, { ...f.options, personalDir: f.configDir }).status, 'installed');
  assert.deepEqual(fs.readFileSync(skillFile(target)), fs.readFileSync(bundled.BUNDLE_FILE));
  assert.notEqual(JSON.parse(fs.readFileSync(markerFile(target))).version, 'personal');
});

const legacyText = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'company-team-v02.md'), 'utf8').replace(/\r\n/g, '\n');

test('s1: exact LF or CRLF personal v0.2 stays untouched while fresh pools receive the shipped skill', t => {
  const f = fixture(t), lf = legacyText(), bundle = fs.readFileSync(bundled.BUNDLE_FILE);
  for (const [label, text] of [['lf', lf], ['crlf', lf.replace(/\n/g, '\r\n')]]) {
    const personalDir = path.join(f.root, label, 'personal'), dataDir = path.join(f.root, label, 'hub');
    const id = 'fresh01', target = pool.accountDir(dataDir, id);
    write(skillFile(personalDir), text);
    write(path.join(pool.poolRoot(dataDir), 'pool.json'), JSON.stringify({ accounts: [{ id }] }));
    const [personal, account] = bundled.syncCompanyTeamSkills({ dataDir, personalDir, ...f.options });
    assert.equal(personal.reason, 'unmanaged', label);
    assert.equal(account.status, 'installed', label);
    assert.deepEqual(fs.readFileSync(skillFile(personalDir)), Buffer.from(text), label);
    assert.equal(fs.existsSync(markerFile(personalDir)), false, label);
    assert.deepEqual(fs.readFileSync(skillFile(target)), bundle, label);
    assert.equal(JSON.parse(fs.readFileSync(markerFile(target))).version, bundled.TEAM_SKILL_VERSION, label);
    // A real personal edit must still propagate; the exception is exact bytes only.
    write(skillFile(personalDir), text + ' ');
    bundled.syncCompanyTeamSkills({ dataDir, personalDir, ...f.options });
    assert.deepEqual(fs.readFileSync(skillFile(target)), Buffer.from(text + ' '), label);
    assert.equal(JSON.parse(fs.readFileSync(markerFile(target))).version, 'personal', label);
  }
});

test('only exact LF or CRLF v0.2 pool copies can be adopted; personal and unknown unmarked copies are preserved', t => {
  const f = fixture(t), lf = legacyText();
  for (const [label, text] of [['lf', lf], ['crlf', lf.replace(/\n/g, '\r\n')]]) {
    const target = path.join(f.root, label);
    write(skillFile(target), text);
    write(path.join(skillDir(target), 'notes.txt'), 'leave this alone');
    assert.equal(bundled.syncCompanyTeamSkill(target, f.options).reason, 'unmanaged');
    assert.equal(bundled.syncCompanyTeamSkill(target, { ...f.options, allowLegacy: true }).status, 'updated');
    assert.deepEqual(fs.readFileSync(skillFile(target)), fs.readFileSync(bundled.BUNDLE_FILE));
    assert.equal(fs.readFileSync(path.join(skillDir(target), 'notes.txt'), 'utf8'), 'leave this alone');
  }
  for (const [label, text] of [['changed', lf + ' '], ['current-unmarked', fs.readFileSync(bundled.BUNDLE_FILE)]]) {
    const target = path.join(f.root, label);
    write(skillFile(target), text);
    assert.equal(bundled.syncCompanyTeamSkill(target, { ...f.options, allowLegacy: true }).reason, 'unmanaged');
    assert.equal(fs.existsSync(markerFile(target)), false);
    assert.deepEqual(fs.readFileSync(skillFile(target)), Buffer.from(text));
  }
});

test('legacy pool adoption can follow the personal source and recover a failed final marker write', t => {
  const f = fixture(t), target = path.join(f.root, 'legacy');
  write(skillFile(f.configDir), '---\nname: company-team\n---\nPersonal custom skill.\n');
  write(skillFile(target), legacyText());
  const options = { ...f.options, personalDir: f.configDir, allowLegacy: true };
  assert.equal(bundled.syncCompanyTeamSkill(target, { ...options, fsModule: failUpgrade(target, 'commit-marker') }).status, 'error');
  assert.equal(bundled.syncCompanyTeamSkill(target, options).status, 'updated');
  assert.deepEqual(fs.readFileSync(skillFile(target)), fs.readFileSync(skillFile(f.configDir)));
  assert.equal(JSON.parse(fs.readFileSync(markerFile(target))).pending, undefined);
});

test('personal v0.2 remains user-owned at startup and overlapping directories cannot be adopted', t => {
  const f = fixture(t), dataDir = path.join(f.root, 'hub'), id = 'legacy01';
  write(skillFile(f.configDir), legacyText());
  write(path.join(pool.poolRoot(dataDir), 'pool.json'), JSON.stringify({ accounts: [{ id }] }));
  bundled.syncCompanyTeamSkills({ dataDir, personalDir: f.configDir, ...f.options });
  assert.equal(fs.existsSync(markerFile(f.configDir)), false);
  assert.deepEqual(fs.readFileSync(skillFile(pool.accountDir(dataDir, id))), fs.readFileSync(bundled.BUNDLE_FILE));
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, personalDir: f.configDir, allowLegacy: true }).reason, 'overlapping-personal-directory');
  assert.equal(fs.existsSync(markerFile(f.configDir)), false);
});

test('an unreadable personal source does not replace a pool skill with the bundle', t => {
  const f = fixture(t), target = path.join(f.root, 'pool'), fault = Object.create(fs);
  write(skillFile(f.configDir), 'Personal customized skill.');
  bundled.syncCompanyTeamSkill(target, { ...f.options, personalDir: f.configDir });
  const before = fs.readFileSync(skillFile(target)), marker = fs.readFileSync(markerFile(target));
  fault.readFileSync = (file, options) => {
    if (file === skillFile(f.configDir)) throw Object.assign(new Error('source denied'), { code: 'EACCES' });
    return fs.readFileSync(file, options);
  };
  assert.equal(bundled.syncCompanyTeamSkill(target, { ...f.options, personalDir: f.configDir, fsModule: fault }).reason, 'EACCES');
  assert.deepEqual(fs.readFileSync(skillFile(target)), before);
  assert.deepEqual(fs.readFileSync(markerFile(target)), marker);
});

test('missing bundle or an unwritable account reports an error without interrupting the caller', t => {
  const f = fixture(t);
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, bundleFile: path.join(f.root, 'missing') }).status, 'error');
  assert.equal(fs.existsSync(f.configDir), false);
  const deniedFs = Object.create(fs);
  deniedFs.mkdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal(bundled.syncCompanyTeamSkill(f.configDir, { ...f.options, fsModule: deniedFs }).reason, 'EACCES');
  assert.match(f.warnings.join('\n'), /EACCES/);
});

test('shipped instructions match current paths/CLI and contain no workstation or unrelated-provider guidance', () => {
  const text = fs.readFileSync(bundled.BUNDLE_FILE, 'utf8');
  assert.match(text, /^---\r?\nname: company-team\r?\ndescription:/);
  assert.match(text, /CLAUDE_HUB_DATA_DIR/);
  assert.match(text, /\.ai-hub-community/);
  assert.doesNotMatch(text, /\.claude-session-hub|ai-peers|Codex|C:[\\/]Users[\\/]|D:[\\/]AIWork|\u7530\u54e5|\u6d3e\u6d3b/);
  const { buildRequest } = require('../scripts/hub-team');
  for (const action of ['status', 'accounts']) assert.equal(buildRequest([action]).action, action);
  assert.equal(buildRequest(['send', '--to', 'lead', '--message', 'done', '--no-wake']).args.wake, false);
  assert.equal(buildRequest(['allow', '--a', 'm1', '--b', 'm2']).args.memberA, 'm1');
  for (const action of ['restart', 'dismiss']) assert.equal(buildRequest([action, '--member', 'm1']).args.memberId, 'm1');
});
