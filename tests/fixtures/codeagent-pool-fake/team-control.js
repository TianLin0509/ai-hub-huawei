'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

module.exports = ({ sessionId, transcript, cwd, fireHook, prompt, menu }) => {
  const dir = process.env.CODEAGENT_TEAM_FAKE_CONTROL_DIR;
  const sid = process.env.CLAUDE_HUB_SESSION_ID;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.ready`), JSON.stringify({ sid, sessionId }));
  // Requests contain only CLI argv. Authentication stays in this process's
  // inherited environment, exactly as a tool run by the CodeAgent CLI would.
  setInterval(() => {
    const file = path.join(dir, `${sid}.request`);
    if (!fs.existsSync(file)) return;
    const req = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../../scripts/hub-team.js'), ...req.args],
      { env: process.env, encoding: 'utf8', timeout: 25000, windowsHide: true });
    const out = path.join(dir, `${sid}.${req.id}.response`);
    fs.writeFileSync(out + '.tmp', JSON.stringify({ code: r.status, out: r.stdout, err: r.stderr, error: r.error?.message }));
    fs.renameSync(out + '.tmp', out);
  }, 150);

  let pending = '', typed = '', pasting = false;
  function submit() {
    const text = typed.trim(); typed = '';
    if (!text) { prompt(); return; }
    if (text === '/model') { menu(); return; }
    const uuid = randomUUID();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid,
      timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
    fireHook('UserPromptSubmit', 'prompt', { prompt: text, prompt_id: uuid });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId, cwd, uuid: randomUUID(), parentUuid: uuid,
      timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'fixture-no-model',
        content: [{ type: 'text', text: '夹具已收到消息。' }], stop_reason: 'end_turn' } }) + '\n');
    fireHook('Stop', 'stop');
    prompt();
  }
  process.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    while (pending.length) {
      if (pending.startsWith('\x1b')) {
        if (/^\x1b(?:\[[0-9;]*)?$/.test(pending)) return;
        const sequence = pending.match(/^\x1b\[[0-9;]*[A-Za-z~]/)?.[0];
        if (sequence) {
          if (sequence === '\x1b[200~') pasting = true;
          if (sequence === '\x1b[201~') pasting = false;
          pending = pending.slice(sequence.length); continue;
        }
        typed = ''; pending = pending.slice(1); prompt(); continue;
      }
      const ch = pending[0]; pending = pending.slice(1);
      if ((ch === '\r' || ch === '\n') && !pasting) submit();
      else if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1);
      else typed += ch;
    }
  });
};
