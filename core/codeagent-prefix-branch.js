'use strict';
const fs = require('node:fs');
const path = require('node:path');

function prefixBranch(session) {
  const value = session?.codeagentPrefixFork;
  return /^codeagent(?:-resume)?$/.test(session?.kind || '') && value?.version === 1 ? value : null;
}

function unusedEmptyPrefix(session) {
  return prefixBranch(session)?.empty === true && !session.codeagentPrefixFork.newSessionId
    && !['runStartedAt', 'lastRunStartedAt', 'lastCompletedAt', 'lastPrompt', 'lastOutputPreview'].some(key => {
      const value = session[key];
      return typeof value === 'string' ? !!value.trim() && value.trim() !== '0' : !!value;
    });
}

// A SessionStart hook can announce an ID before the CLI creates its file.
// Only ENOENT is evidence of absence; an unreadable/empty record is not.
function missingPrefixChild(session, child, fsModule = fs) {
  const branch = prefixBranch(session);
  if (!branch?.configDir || !session.cwd) return false;
  const projects = path.join(branch.configDir, 'projects');
  const absent = file => {
    try { fsModule.lstatSync(file); return false; }
    catch (error) { return error.code === 'ENOENT'; }
  };
  const expected = path.join(projects, path.resolve(session.cwd).replace(/[^A-Za-z0-9]/g, '-'), child + '.jsonl');
  if (session.transcriptPath && path.resolve(session.transcriptPath).toLowerCase() !== path.resolve(expected).toLowerCase()) return false;
  if (!absent(expected)) return false;
  try {
    return fsModule.readdirSync(projects, { withFileTypes: true }).every(entry => !entry.isDirectory()
      || absent(path.join(projects, entry.name, child + '.jsonl')));
  } catch (error) { return error.code === 'ENOENT'; }
}

function logPrefixRecovery(session, result, reason, dataDir) {
  const branch = prefixBranch(session);
  try {
    const dir = path.join(dataDir, 'logs'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'codeagent-prefix-fork.log'), JSON.stringify({ at: new Date().toISOString(),
      source: branch.sourceSessionId?.slice(0, 8) || null, cutUserUuid: branch.cutUserUuid,
      newSessionId: session.ccSessionId || branch.newSessionId, keptLines: 0, droppedLines: 0, result, reason }) + '\n');
  } catch { console.warn('[prefix-fork] diagnostic write failed'); }
}

module.exports = { prefixBranch, unusedEmptyPrefix, missingPrefixChild, logPrefixRecovery };
