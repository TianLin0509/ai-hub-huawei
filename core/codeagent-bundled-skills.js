'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

// Kept inside core so full installs and app.asar updates carry the same resource.
const TEAM_SKILL = 'company-team';
const TEAM_SKILL_VERSION = '0.4.0';
const BUNDLE_FILE = path.join(__dirname, 'codeagent-skills', TEAM_SKILL, 'SKILL.md');
const MARKER_FILE = '.hub-managed';
const hash = content => createHash('sha256').update(content).digest('hex');
// Exact original v0.2 text, with LF and CRLF respectively. Only pool copies
// without a marker may be adopted; a near match or any other version is not.
const LEGACY_V02_HASHES = new Set([
  '1ddc26517692c7e9d220706c776a38ab38d088d2b774e543e3c2cf2851744d97',
  '25df11faf3483abd122705438d00da74515f06f9b2dd8ddde32a64388cc7faf9',
]);

function enabled(distribution = require('./distribution')) {
  return distribution.target === 'company' && distribution.featureEnabled('leadTeam');
}

function stat(file, fsModule) {
  try { return fsModule.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function atomicWrite(file, content, fsModule) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fsModule.writeFileSync(temporary, content, { flag: 'wx' });
    fsModule.renameSync(temporary, file);
  } finally {
    try { fsModule.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function installDirectory(directory, content, marker, fsModule) {
  const parent = path.dirname(directory);
  fsModule.mkdirSync(parent, { recursive: true });
  // Hidden staging directories are not returned by the skill catalog. Publish
  // the complete pair once; a failed write must not claim the user's skill path.
  const temporary = fsModule.mkdtempSync(path.join(parent, `.${TEAM_SKILL}-`));
  try {
    fsModule.writeFileSync(path.join(temporary, 'SKILL.md'), content, { flag: 'wx' });
    fsModule.writeFileSync(path.join(temporary, MARKER_FILE), marker, { flag: 'wx' });
    if (stat(directory, fsModule)) throw Object.assign(new Error('Skill directory appeared during installation'), { code: 'EEXIST' });
    fsModule.renameSync(temporary, directory);
  } finally {
    // Only remove files from the staging directory created by this call.
    for (const name of ['SKILL.md', MARKER_FILE]) {
      try { fsModule.unlinkSync(path.join(temporary, name)); } catch { /* retry does not depend on staging cleanup */ }
    }
    try { fsModule.rmdirSync(temporary); } catch { /* an unpublished directory stays hidden */ }
  }
}

const validRevision = value => value && typeof value.version === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 || '');
const validMarker = value => value?.owner === 'ai-hub' && value.skill === TEAM_SKILL && value.schema === 1
  && validRevision(value) && (value.pending === undefined || validRevision(value.pending));
const markerText = (version, sha256, pending) => JSON.stringify({
  schema: 1, owner: 'ai-hub', skill: TEAM_SKILL, version, sha256, ...(pending ? { pending } : {}),
}, null, 2) + '\n';

function personalSkillContent(configDir, fsModule) {
  if (!configDir) return null;
  const directory = path.join(configDir, 'skills', TEAM_SKILL), file = path.join(directory, 'SKILL.md');
  const dirStat = stat(directory, fsModule), fileStat = stat(file, fsModule);
  if (!dirStat || !fileStat) return null;
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw Object.assign(new Error('Personal skill is not a regular file'), { code: 'UNSAFE_SKILL_SOURCE' });
  }
  const content = fsModule.readFileSync(file), sha256 = hash(content);
  if (LEGACY_V02_HASHES.has(sha256)) return null;
  const markerFile = path.join(directory, MARKER_FILE), markerStat = stat(markerFile, fsModule);
  let marker;
  if (markerStat?.isFile() && !markerStat.isSymbolicLink()) {
    try { marker = JSON.parse(fsModule.readFileSync(markerFile, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  // An unfinished Hub update is still managed, not a personal customization.
  return validMarker(marker) && (sha256 === marker.sha256 || sha256 === marker.pending?.sha256) ? null : content;
}

// An unmanaged directory or a changed/deleted managed file belongs to the user.
// Failures are local to this account and must not prevent Hub/account startup.
function syncCompanyTeamSkill(configDir, {
  distribution = require('./distribution'), fsModule = fs, logger = console,
  bundleFile = BUNDLE_FILE, version = TEAM_SKILL_VERSION,
  personalDir = null, allowLegacy = false,
} = {}) {
  if (!enabled(distribution)) return { status: 'disabled' };
  if (!configDir) return { status: 'not-configured' };
  const directory = path.join(configDir, 'skills', TEAM_SKILL);
  const finish = (status, reason) => {
    const result = { status, directory, ...(reason ? { reason } : {}) };
    if (status === 'preserved' || status === 'error') {
      try { logger?.warn?.(`[codeagent-skills] ${TEAM_SKILL}: ${reason}; ${directory}`); } catch { /* logging only */ }
    }
    return result;
  };
  try {
    if (personalDir && require('./codeagent-config').dirsOverlap(personalDir, configDir, { fsModule })) {
      return finish('preserved', 'overlapping-personal-directory');
    }
    const dirStat = stat(directory, fsModule);
    if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) return finish('preserved', 'linked-or-invalid-directory');
    const file = path.join(directory, 'SKILL.md'), markerFile = path.join(directory, MARKER_FILE);
    let previous, legacyAdoption = false;
    if (dirStat) {
      const markerStat = stat(markerFile, fsModule), fileStat = stat(file, fsModule);
      if (!markerStat) {
        if (!allowLegacy || !fileStat?.isFile() || fileStat.isSymbolicLink()) return finish('preserved', 'unmanaged');
        const sha256 = hash(fsModule.readFileSync(file));
        if (!LEGACY_V02_HASHES.has(sha256)) return finish('preserved', 'unmanaged');
        previous = { version: '0.2', sha256 };
        legacyAdoption = true;
      } else {
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) return finish('preserved', 'unmanaged');
        try { previous = JSON.parse(fsModule.readFileSync(markerFile, 'utf8')); } catch { return finish('preserved', 'invalid-marker'); }
        if (!validMarker(previous)) return finish('preserved', 'invalid-marker');
      }
      if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) return finish('preserved', 'changed-or-missing-skill');
      const currentHash = hash(fsModule.readFileSync(file));
      if (currentHash !== previous.sha256) {
        if (currentHash !== previous.pending?.sha256) return finish('preserved', 'user-modified');
        // The skill replacement succeeded but final marker publication did not.
        previous = { ...previous, ...previous.pending };
      }
    }
    const personalContent = personalSkillContent(personalDir, fsModule);
    const content = personalContent || fsModule.readFileSync(bundleFile), sha256 = hash(content);
    const targetVersion = personalContent ? 'personal' : version;
    if (previous?.sha256 === sha256 && previous.version === targetVersion && !previous.pending && !legacyAdoption) return finish('current');
    const marker = markerText(targetVersion, sha256);
    if (!dirStat) {
      installDirectory(directory, content, marker, fsModule);
    } else {
      if (previous.sha256 !== sha256) {
        // Persist both known Hub revisions before replacing the file. Any
        // interruption can retry, even after the bundle changes again; edits
        // matching neither revision remain user-owned. Adoption is restricted
        // to the explicit legacy pool allowlist above.
        atomicWrite(markerFile, markerText(previous.version, previous.sha256, { version: targetVersion, sha256 }), fsModule);
        atomicWrite(file, content, fsModule);
      }
      atomicWrite(markerFile, marker, fsModule);
    }
    return finish(previous ? 'updated' : 'installed');
  } catch (error) { return finish('error', error.code || 'sync-failed'); }
}

function syncCompanyTeamSkills({ dataDir, personalDir, ...options }) {
  if (!enabled(options.distribution)) return [];
  const pool = require('./codeagent-pool');
  const results = [], seen = new Set();
  const key = dir => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  if (personalDir) {
    seen.add(key(personalDir));
    results.push(syncCompanyTeamSkill(personalDir, { ...options, personalDir: null, allowLegacy: false }));
  }
  for (const account of pool.readRegistry(dataDir).accounts) {
    const dir = pool.accountDir(dataDir, account.id);
    if (seen.has(key(dir))) continue;
    seen.add(key(dir));
    results.push(syncCompanyTeamSkill(dir, { ...options, personalDir, allowLegacy: true }));
  }
  return results;
}

module.exports = { TEAM_SKILL, TEAM_SKILL_VERSION, BUNDLE_FILE, MARKER_FILE, enabled, syncCompanyTeamSkill, syncCompanyTeamSkills };
