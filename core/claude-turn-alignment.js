'use strict';
// One user UUID owns a reply. Hook IDs are aliases, never a substitute for
// finding that user record in the transcript. Parent links also cover delayed
// writes from an earlier round arriving after the next user message.
const fs = require('node:fs');
const { isToolResultEntry, parseClaudeTranscriptEntries, isClaudeTurnStopReasonTerminal,
  claudeAssistantContentHasAnswerText } = require('./claude-transcript-parser');
const { displayUserText, isSyntheticUserEntry } = require('./synthetic-user-filter');
const { userTextIdentity } = require('./conversation-display');
const { timestampToMs } = require('./transcript-payload-utils');

function textOf(row) {
  const content = row?.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b=>b?.type==='text').map(b=>b.text || '').join('\n') : '';
}
function human(row) {
  const text = textOf(row);
  return row?.type === 'user' && !row.isSidechain && !isToolResultEntry(row)
    && !!text && !isSyntheticUserEntry(row,text)
    && row.origin?.kind !== 'task-notification' && !text.trimStart().startsWith('<task-notification>')
    && !text.trimStart().startsWith('[Request interrupted by user');
}
function promptIdentity(text) { return userTextIdentity(displayUserText(text) || text); }

function selectClaudeTurn(records, options = {}) {
  // Repeated UUIDs are revised snapshots, including a shorter final answer.
  const byId = new Map();
  records.forEach((r,i)=>{
    if(!r || r.isSidechain)return;
    const key=r.uuid || `row:${i}`, previous=byId.get(key);
    if(!previous || timestampToMs(r.timestamp)>=timestampToMs(previous.timestamp))byId.set(key,{...r,_order:i});
  });
  const rows = [...byId.values()];
  const users = rows.filter(human);
  const wanted = options.userRecordId || options.turnId || options.providerTurnId;
  let user = wanted && users.find(r=>r.uuid===wanted || r.promptId===wanted || r.prompt_id===wanted || r.turn_id===wanted);
  const since = Number(options.since) || 0, until = Number(options.untilTs) || Infinity;
  if (!user && !options.userRecordId) {
    const eligible = users.filter(r=>{
      const at=timestampToMs(r.timestamp);
      return (!since || at>=since) && at<until
        && (!options.prompt || promptIdentity(textOf(r))===promptIdentity(options.prompt));
    });
    // A supplied but unknown hook ID needs the prompt to establish its alias.
    if ((!wanted || options.prompt) && eligible.length===1) user=eligible[0];
    else if (!wanted && !since && !options.prompt) user=eligible.at(-1);
  }
  if (!user?.uuid) return {text:'',extractMode:'unmatched_turn',aligned:false,reason:'user_record_not_found'};

  const owners = new Map();
  function owner(row, seen=new Set()) {
    if (!row) return null;
    if (owners.has(row)) return owners.get(row);
    if (human(row)) return row.uuid;
    if (seen.has(row)) return null;
    seen.add(row);
    const parent = row.parentUuid || row.parent_uuid;
    const result = parent ? owner(byId.get(parent),seen)
      : users.filter(u=>u._order<row._order).at(-1)?.uuid;
    owners.set(row,result || null);return result;
  }
  const owned = rows.filter(r=>r.type==='assistant' && owner(r)===user.uuid);
  // Parent-before-child order when links exist; timestamp is a stable fallback
  // for old CodeAgent records without parent links.
  const ordered=[],visiting=new Set(),done=new Set();
  function visit(row) {
    if (!row || done.has(row) || visiting.has(row)) return;
    visiting.add(row);
    const parent=byId.get(row.parentUuid || row.parent_uuid);
    if (parent?.type==='assistant' && owner(parent)===user.uuid) visit(parent);
    visiting.delete(row);done.add(row);ordered.push(row);
  }
  owned.sort((a,b)=>(timestampToMs(a.timestamp)-timestampToMs(b.timestamp)) || a._order-b._order).forEach(visit);
  const last=ordered.at(-1);
  const turns=parseClaudeTranscriptEntries(ordered);
  // A later terminal answer is a revision, not another paragraph of the old
  // answer. Within the final logical run the parser still preserves commentary.
  const text=(turns.filter(t=>t.role==='assistant').at(-1)?.text || '').trim();
  const stopReason=last?.message?.stop_reason || null;
  const terminal=isClaudeTurnStopReasonTerminal(stopReason);
  const final=terminal && claudeAssistantContentHasAnswerText(last?.message?.content);
  const providerError=last?.isApiErrorMessage===true || !!last?.error;
  return {text,source:'manual_claude_transcript',aligned:true,userRecordId:user.uuid,
    promptText:textOf(user),
    turnId:options.providerTurnId || options.turnId || user.uuid,
    submittedAt:timestampToMs(user.timestamp) || null,
    completedAt:timestampToMs(last?.timestamp) || null,recordId:last?.uuid || null,
    ...(providerError ? {errorInfo:String(last.error || textOf(last) || 'provider_error')} : {}),
    stopReason,extractMode:providerError ? 'provider_error' : final ? 'final_answer' : terminal ? 'awaiting_final_text' : 'partial_commentary'};
}

async function readClaudeTurn(file, options={}) {
  const handle=await fs.promises.open(file,'r');
  try {
    const {size}=await handle.stat();
    let bytes=256*1024;
    for (;;) {
      const start=Math.max(0,size-bytes),buf=Buffer.alloc(size-start);
      await handle.read(buf,0,buf.length,start);
      let raw=buf.toString('utf8');
      if(start>0)raw=raw.slice(raw.indexOf('\n')+1);
      const rows=[];
      for(const line of raw.split(/\r?\n/)) {
        if(!line.trim())continue;
        try { rows.push(JSON.parse(line)); } catch { /* A partially flushed line is retried on the next read. */ }
      }
      const result=selectClaudeTurn(rows,options);
      if(result.aligned || start===0)return result;
      bytes*=4;
    }
  } finally {await handle.close();}
}
module.exports={readClaudeTurn,selectClaudeTurn,promptIdentity,isHumanClaudeRecord:human};
