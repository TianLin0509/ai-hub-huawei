'use strict';

// An account switch relaunches Claude with --resume <old> --fork-session. The
// fork's file starts at the last compaction, so the conversation before it
// stays only in the previous file. A runtime home belongs to one Hub session
// and keeps those earlier files beside the current one.
//
// A file only counts as an ancestor when the descendant's opening entries name
// one of its message ids. A /clear in the same home shares none and stays apart.

const fs = require('fs');
const path = require('path');

const HOME_PATTERN = /^(.*[\\/]claude-account-runtimes[\\/][^\\/]+)[\\/]projects[\\/][^\\/]+[\\/][^\\/]+\.jsonl$/i;
const HEAD_BYTES = 512 * 1024;
const HEAD_ENTRIES = 40;
const MAX_ANCESTORS = 12;

function runtimeHomeOf(transcriptPath) {
  return String(transcriptPath || '').match(HOME_PATTERN)?.[1] || null;
}
function isRuntimeHome(dir) {
  return /[\\/]claude-account-runtimes[\\/][^\\/]+[\\/]?$/i.test(String(dir || ''));
}

function transcriptsInHome(home) {
  const rows = [];
  let projects = [];
  try { projects = fs.readdirSync(path.join(home, 'projects'), { withFileTypes: true }); } catch { return rows; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(home, 'projects', project.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0) rows.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  return rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function headMessageIds(file) {
  const fd = fs.openSync(file, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    text = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0));
  } finally { fs.closeSync(fd); }
  const ids = new Set();
  let entries = 0;
  for (const line of text.split('\n')) {
    if (entries >= HEAD_ENTRIES) break;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry?.uuid) continue;
    entries++;
    for (const id of [entry.uuid, entry.logicalParentUuid]) if (id) ids.add(id);
  }
  return [...ids];
}

function namesAny(file, ids) {
  const content = fs.readFileSync(file);
  return ids.some(id => content.includes(`"uuid":"${id}"`));
}

// The head of a transcript never changes, so a found parent stays valid. A
// miss is only remembered until another file appears in the home.
const parentCache = new Map();
function parentOf(file, older) {
  const key = path.resolve(file).toLowerCase();
  const known = parentCache.get(key);
  if (known?.parent) return known.parent;
  if (known && known.olderCount === older.length) return null;
  const ids = headMessageIds(file);
  const parent = ids.length ? [...older].reverse().find(row => namesAny(row.file, ids))?.file || null : null;
  parentCache.set(key, { parent, olderCount: older.length });
  return parent;
}

// Oldest first, excluding the transcript itself.
function ancestorTranscripts(transcriptPath) {
  const home = runtimeHomeOf(transcriptPath);
  if (!home) return [];
  const rows = transcriptsInHome(home);
  const chain = [];
  let current = path.resolve(transcriptPath);
  while (chain.length < MAX_ANCESTORS) {
    const self = rows.find(row => path.resolve(row.file).toLowerCase() === current.toLowerCase());
    if (!self) break;
    const older = rows.filter(row => row.mtimeMs < self.mtimeMs);
    const parent = older.length ? parentOf(current, older) : null;
    if (!parent) break;
    chain.unshift(parent);
    current = path.resolve(parent);
  }
  return chain;
}

// Between the relaunch and the first prompt the fork's file does not exist yet.
// Short probes run inside a session also land in this home, under their own
// project folder; without a bound path the main conversation is the largest.
function restingTranscript(home, transcriptPath) {
  const rows = transcriptsInHome(home);
  if (transcriptPath) {
    const dir = path.resolve(path.dirname(transcriptPath)).toLowerCase();
    return rows.filter(row => path.resolve(path.dirname(row.file)).toLowerCase() === dir).at(-1)?.file || null;
  }
  return rows.sort((a, b) => b.size - a.size)[0]?.file || null;
}

// The same message in both files keeps its id or, when Claude rewrote it, its
// time and text. Repeated text at other times ("继续") is a different message.
function turnKey(turn) {
  return `${turn.role}|${turn.ts}|${String(turn.text || '').slice(0, 120)}`;
}
function prependAncestorTurns(ancestorTurns, turns) {
  const ids = new Set(turns.map(turn => turn.id));
  const keys = new Set(turns.map(turnKey));
  const prefix = [];
  for (const turn of ancestorTurns) {
    if (!turn?.role || ids.has(turn.id) || keys.has(turnKey(turn))) continue;
    ids.add(turn.id);
    keys.add(turnKey(turn));
    prefix.push(turn);
  }
  return prefix.concat(turns);
}

module.exports = { ancestorTranscripts, isRuntimeHome, prependAncestorTurns, restingTranscript, runtimeHomeOf };
