'use strict';
// Publish one verified batch. A durable snapshot lets a failed job be rerun
// without mixing rebuilt binaries with metadata from the previous attempt.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const CHECKSUMS = 'SHA256SUMS.txt';
const MARKER = '.release-snapshot.json';
const DEFAULTS = { totalTimeoutMs: 25 * 60_000, uploadTimeoutMs: 5 * 60_000, apiTimeoutMs: 45_000, attempts: 3, lookupDelayMs: 3_000 };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const safeName = name => typeof name === 'string' && name && !/^[-.]/.test(name)
  && !/[\\/#:\r\n\0]/.test(name) && path.basename(name) === name;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function requireFact(ok, message) { if (!ok) throw new Error(message); }
function requiredNames(tag) {
  const version = tag.slice(1);
  return [`AIHubHuawei-Setup-${version}.exe`, `AIHubHuawei-${version}-win-x64.zip`,
    `AIHubHuawei-source-${version}.zip`, 'install-release.ps1', 'release-manifest.json'];
}
function parseChecksums(text, tag) {
  const entries = new Map();
  for (const line of String(text).trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    requireFact(match && safeName(match[2]) && match[2] !== CHECKSUMS, 'Invalid release checksum entry');
    requireFact(!entries.has(match[2]), 'Duplicate release checksum entry');
    entries.set(match[2], match[1]);
  }
  for (const name of requiredNames(tag)) requireFact(entries.has(name), `Missing release checksum: ${name}`);
  return entries;
}
function readIdentity(dir, tag) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8'));
  requireFact(manifest.version === tag.slice(1) && shaPattern.test(manifest.sourceSha), 'Release manifest identity is invalid');
  return { sourceSha: manifest.sourceSha, version: manifest.version };
}
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function readPlan(dir, tag) {
  const raw = fs.readFileSync(path.join(dir, CHECKSUMS), 'utf8');
  const checksums = parseChecksums(raw, tag);
  checksums.set(CHECKSUMS, hash(raw));
  const assets = [];
  for (const [name, sha256] of checksums) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    requireFact(stat.isFile() && !stat.isSymbolicLink(), `Release asset is not a regular file: ${name}`);
    requireFact(await hashFile(file) === sha256, `Release checksum mismatch: ${name}`);
    assets.push({ name, bytes: stat.size, sha256 });
  }
  return assets;
}
async function snapshotBatch({ dir, cacheRoot, repo, tag, sourceSha, log }) {
  const snapshot = path.join(cacheRoot, ...repo.split('/'), tag);
  if (fs.existsSync(snapshot)) {
    requireFact(!fs.lstatSync(snapshot).isSymbolicLink(), 'Release snapshot must not be a link');
    let marker;
    try { marker = JSON.parse(fs.readFileSync(path.join(snapshot, MARKER), 'utf8')); }
    catch { throw new Error('Release snapshot is incomplete; it was not reused'); }
    requireFact(marker.schema === 1 && marker.repo === repo && marker.tag === tag && marker.sourceSha === sourceSha,
      'Release snapshot belongs to a different tag or commit');
    const assets = await readPlan(snapshot, tag);
    requireFact(readIdentity(snapshot, tag).sourceSha === sourceSha, 'Release snapshot manifest belongs to a different commit');
    requireFact(JSON.stringify(marker.assets) === JSON.stringify(assets), 'Release snapshot failed integrity verification');
    log('已复用同一标签、提交的完整资产快照，继续补传缺项。');
    return { dir: snapshot, assets };
  }
  const assets = await readPlan(dir, tag);
  const staging = snapshot + '.part-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(staging, { recursive: true });
  for (const asset of assets) fs.copyFileSync(path.join(dir, asset.name), path.join(staging, asset.name));
  requireFact(JSON.stringify(await readPlan(staging, tag)) === JSON.stringify(assets), 'Release snapshot copy verification failed');
  requireFact(readIdentity(staging, tag).sourceSha === sourceSha, 'Release snapshot manifest belongs to a different commit');
  fs.writeFileSync(path.join(staging, MARKER), JSON.stringify({ schema: 1, repo, tag, sourceSha, assets }) + '\n', 'utf8');
  fs.renameSync(staging, snapshot);
  log(`已保存并校验 ${assets.length} 个资产的完整快照；失败后可续传。`);
  return { dir: snapshot, assets };
}
function cleanupSnapshot({ snapshot, cacheRoot, repo, tag, sourceSha, log }) {
  // Only this successful batch is eligible. Never scan or age out other tags.
  if (!snapshot || !fs.existsSync(snapshot)) return;
  try {
    const expected = path.resolve(cacheRoot, ...repo.split('/'), tag);
    requireFact(path.resolve(snapshot) === expected && !fs.lstatSync(snapshot).isSymbolicLink(), 'Snapshot cleanup path is invalid');
    const relative = path.relative(fs.realpathSync(cacheRoot), fs.realpathSync(snapshot));
    requireFact(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Snapshot is outside the dedicated cache');
    const marker = JSON.parse(fs.readFileSync(path.join(snapshot, MARKER), 'utf8'));
    requireFact(marker.schema === 1 && marker.repo === repo && marker.tag === tag && marker.sourceSha === sourceSha, 'Snapshot cleanup marker does not match');
    fs.rmSync(snapshot, { recursive: true });
    log('本次发布已完成，已清理当前标签的资产快照。');
  } catch {
    log('发布已完成；资产快照保留在专属缓存中，未自动清理。');
  }
}
function remoteMatches(remote, local) {
  return remote?.state === 'uploaded' && remote.size === local.bytes && remote.digest === 'sha256:' + local.sha256;
}

async function publishRelease(options = {}, deps = {}) {
  const config = { ...DEFAULTS, ...options };
  const env = deps.env || process.env;
  const { repo = env.GH_REPO, tag = env.RELEASE_TAG } = config;
  requireFact(typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)
    && repo.split('/').every(part => part !== '.' && part !== '..'), 'GH_REPO must be owner/repository');
  requireFact(typeof tag === 'string' && /^v\d+\.\d+\.\d+$/.test(tag), 'RELEASE_TAG must be vX.Y.Z');
  for (const key of ['totalTimeoutMs', 'uploadTimeoutMs', 'apiTimeoutMs', 'attempts']) requireFact(Number.isSafeInteger(config[key]) && config[key] > 0, `Invalid ${key}`);
  const dir = path.resolve(config.dir || path.join(__dirname, '..', 'dist'));
  const cacheRoot = path.resolve(config.cacheRoot || env.AI_HUB_RELEASE_ASSET_CACHE
    || path.join(env.RUNNER_TOOL_CACHE || os.tmpdir(), 'aihub-release-assets'));
  const { sourceSha } = readIdentity(dir, tag);
  if (env.GITHUB_SHA) requireFact(sourceSha === env.GITHUB_SHA, 'Release manifest does not match the CI commit');
  const run = deps.run || ((args, opts) => spawnSync('gh', args, opts));
  const now = deps.now || Date.now, sleep = deps.sleep || delay, log = deps.log || console.log;
  const deadline = now() + config.totalTimeoutMs;
  function gh(args, timeoutMs = config.apiTimeoutMs) {
    const remaining = deadline - now();
    requireFact(remaining > 0, 'Publish time budget exhausted; draft and snapshot retained for retry');
    const result = run(args, { cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      windowsHide: true, timeout: Math.min(timeoutMs, remaining), stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) {
      const timeout = result.error?.code === 'ETIMEDOUT';
      const error = new Error(timeout ? 'GitHub request timed out' : `GitHub request failed (exit ${result.status ?? 'unknown'})`);
      error.notFound = !timeout && /\bHTTP 404\b/.test(String(result.stderr || ''));
      throw error;
    }
    return String(result.stdout || '');
  }
  function release() {
    try {
      // GitHub's releases/tags/{tag} endpoint never returns drafts (404), so look the tag up in the release list,
      // which does include drafts for a token with push access.
      const list = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`]));
      requireFact(Array.isArray(list), 'GitHub release list response is invalid');
      const r = list.find(item => item && item.tag_name === tag);
      if (!r) return null;
      requireFact(r.tag_name === tag && Number.isSafeInteger(r.id) && r.id > 0 && Array.isArray(r.assets), 'GitHub release response is invalid');
      return r;
    } catch (error) { if (error.notFound) return null; throw error; }
  }
  function remoteText(name) {
    return gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--output', '-']);
  }
  function verifyPublished(r) {
    const manifestText = remoteText('release-manifest.json'), checksumsText = remoteText(CHECKSUMS);
    const manifest = JSON.parse(manifestText);
    requireFact(manifest.version === tag.slice(1) && manifest.sourceSha === sourceSha, 'Published release belongs to a different commit');
    const expected = parseChecksums(checksumsText, tag);
    requireFact(expected.get('release-manifest.json') === hash(manifestText), 'Published release manifest checksum mismatch');
    expected.set(CHECKSUMS, hash(checksumsText));
    requireFact(r.assets.length === expected.size, 'Published release has assets outside its checksum set');
    for (const [name, sha256] of expected) {
      const matches = r.assets.filter(asset => asset.name === name);
      requireFact(matches.length === 1 && matches[0].state === 'uploaded' && matches[0].digest === 'sha256:' + sha256,
        `Published asset could not be verified: ${name}`);
      const declared = manifest.assets?.find(asset => asset.name === name);
      if (declared) requireFact(matches[0].size === declared.bytes && sha256 === declared.sha256, `Published asset size or checksum mismatch: ${name}`);
    }
    log('远端已是完整发布，校验了原批次的清单、提交和资产摘要，无需重新上传。');
  }

  let current = release();
  if (current && current.draft === false) {
    verifyPublished(current);
    cleanupSnapshot({ snapshot: path.join(cacheRoot, ...repo.split('/'), tag), cacheRoot, repo, tag, sourceSha, log });
    return { ok: true, alreadyPublished: true, uploaded: [], skipped: current.assets.map(asset => asset.name) };
  }
  const batch = await snapshotBatch({ dir, cacheRoot, repo, tag, sourceSha, log });
  if (!current) {
    try { gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--prerelease', '--title', `AI Hub Community ${tag}`, '--notes', 'Windows x64.']); }
    catch (error) { current = release(); if (!current) throw error; }
    // A freshly created draft can take a few seconds to appear in the release list.
    for (let i = 0; !current && i < 5; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, config.lookupDelayMs));
      current = release();
    }
  }
  requireFact(current?.draft === true, 'Release must remain a draft while assets are incomplete');
  const expectedNames = new Set(batch.assets.map(asset => asset.name));
  requireFact(current.assets.every(asset => expectedNames.has(asset.name)), 'Draft contains assets outside the verified batch');
  const uploaded = [], skipped = [];
  for (const [index, asset] of batch.assets.entries()) {
    let complete = false;
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
      try {
        current = release();
        requireFact(current?.draft === true, 'Release changed while uploading; draft and snapshot retained');
        const matches = current.assets.filter(remote => remote.name === asset.name);
        requireFact(matches.length <= 1, `Duplicate remote asset: ${asset.name}`);
        const remote = matches[0];
        if (remoteMatches(remote, asset)) {
          log(`资产 ${index + 1}/${batch.assets.length} ${asset.name} 已完整上传，跳过。`);
          skipped.push(asset.name); complete = true; break;
        }
        if (remote) {
          requireFact(remote.state !== 'uploaded', `Existing uploaded asset differs from the verified batch: ${asset.name}`);
          requireFact(Number.isSafeInteger(remote.id) && remote.id > 0, 'Incomplete remote asset id is invalid');
          gh(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${remote.id}`]);
        }
        log(`资产 ${index + 1}/${batch.assets.length} ${asset.name}（${asset.bytes} 字节）：第 ${attempt}/${config.attempts} 次上传，单次最多 ${Math.ceil(config.uploadTimeoutMs / 60_000)} 分钟。`);
        gh(['release', 'upload', tag, path.join(batch.dir, asset.name), '--repo', repo], config.uploadTimeoutMs);
        current = release();
        requireFact(current?.draft === true && remoteMatches(current.assets.find(remote => remote.name === asset.name), asset), `Uploaded asset failed verification: ${asset.name}`);
        uploaded.push(asset.name); complete = true; break;
      } catch (error) {
        // The server may have completed an upload whose response was lost.
        if (attempt === config.attempts || now() >= deadline) {
          throw new Error(`${asset.name}: ${error.message}; draft and verified snapshot retained for retry`);
        }
        log(`${asset.name} 未完成：${error.message}；稍后只重试这一项。`);
        const waitMs = Math.min(5000 * attempt, Math.max(0, deadline - now()));
        if (waitMs) await sleep(waitMs);
      }
    }
    requireFact(complete, `Release asset incomplete: ${asset.name}`);
  }
  current = release();
  requireFact(current?.draft === true && current.assets.length === batch.assets.length
    && batch.assets.every(asset => remoteMatches(current.assets.find(remote => remote.name === asset.name), asset)),
    'Final release asset verification failed; draft retained');
  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${current.id}`, '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false']);
  current = release();
  requireFact(current?.draft === false && current.assets.length === batch.assets.length
    && batch.assets.every(asset => remoteMatches(current.assets.find(remote => remote.name === asset.name), asset)),
  'Release publication was not confirmed; snapshot retained');
  cleanupSnapshot({ snapshot: batch.dir, cacheRoot, repo, tag, sourceSha, log });
  log(current.prerelease ? '全部资产校验完成，已发布为预发布版，等待后续验收转正。' : '全部资产校验完成，后续验收已将版本转正。');
  return { ok: true, alreadyPublished: false, uploaded, skipped };
}

if (require.main === module) {
  publishRelease().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error('Publish stopped: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = { CHECKSUMS, MARKER, DEFAULTS, parseChecksums, readPlan, snapshotBatch, cleanupSnapshot, remoteMatches, publishRelease };
