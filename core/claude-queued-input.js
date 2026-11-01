'use strict';

// Claude 2.1.310 persists an absorbed mid-turn human prompt as an attachment,
// alongside tool results. The rendered system reminder is transport scaffolding;
// the original prompt and receipt identity live in attachment itself.
function queuedHumanEntry(entry) {
  const a = entry?.attachment;
  if (entry?.type !== 'attachment' || entry.isSidechain || a?.type !== 'queued_command'
      || a.origin?.kind !== 'human' || a.humanTurn !== true || a.commandMode !== 'prompt') return null;
  const content = a.prompt;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;
  const raw = typeof content === 'string' ? content
    : content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
  const visible = require('./synthetic-user-filter').displayUserText(raw);
  const hasImage = Array.isArray(content) && content.some(b => b?.type === 'image');
  if (visible === null || (!visible.trim() && !hasImage)) return null;
  const uuid = a.source_uuid || a.delivery_id || entry.uuid;
  if (typeof uuid !== 'string' || !uuid) return null;
  return {type:'user',uuid,timestamp:a.timestamp || entry.timestamp,
    message:{role:'user',content},isQueuedSupplement:true};
}

function* withQueuedHumanInputs(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const user = queuedHumanEntry(entry);
    if (user) {
      const aliases = ['source:' + user.uuid];
      if (entry.attachment.delivery_id) aliases.push('delivery:' + entry.attachment.delivery_id);
      if (entry.uuid) aliases.push('attachment:' + entry.uuid);
      const duplicate = aliases.some(id => seen.has(id));
      aliases.forEach(id => seen.add(id));
      if (!duplicate) yield user;
    } else {
      if (entry?.type === 'user' && entry.uuid) {
        const id = 'source:' + entry.uuid;
        if (seen.has(id)) continue;
        seen.add(id);
      }
      yield entry;
    }
  }
}

module.exports = {queuedHumanEntry, withQueuedHumanInputs};
