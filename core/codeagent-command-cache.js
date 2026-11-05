'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readCommands(dataDir, session, { fsModule = fs } = {}) {
  let cache;
  try { cache = JSON.parse(fsModule.readFileSync(path.join(dataDir, 'codeagent-pool', 'codeagent-commands.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch { return []; }
  const entry = cache?.accounts?.[session.codeagentPoolAccount || 'personal'];
  if (cache?.version !== 1 || typeof entry?.version !== 'string' || !entry.version || !Array.isArray(entry.commands)
      || session.codeagentVersion && session.codeagentVersion !== entry.version) return [];
  const name = value => typeof value === 'string' && /^\/?[\w.:-]+$/.test(value) ? value.replace(/^\//, '') : '';
  return entry.commands.filter(row => name(row?.name) && (!row.kind || ['command', 'custom-command', 'skill'].includes(row.kind))).map(row => ({ name: name(row.name),
    aliases: (Array.isArray(row.aliases) ? row.aliases : []).map(name).filter(Boolean), description: typeof row.description === 'string' ? row.description : '', kind: row.kind || 'command' }));
}

module.exports = { readCommands };
