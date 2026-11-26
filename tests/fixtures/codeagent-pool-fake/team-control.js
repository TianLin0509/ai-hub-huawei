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

  const stopFixture = process.env.CODEAGENT_TEAM_STOP_FIXTURE === '1';
  let held = null, escapeCount = 0;
  const writeAnswer = (uuid, text) => fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId, cwd,
    uuid: randomUUID(), parentUuid: uuid, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'fixture-no-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n');
  if (stopFixture) setInterval(() => {
    const release = path.join(dir, `${sid}.release-late`);
    if (!held || !fs.existsSync(release)) return;
    fs.unlinkSync(release); writeAnswer(held.uuid, 'STOP_FIXTURE_OLD_LATE_ANSWER');
    fs.writeFileSync(path.join(dir, `${sid}.late-written`), JSON.stringify(held)); held = null;
  }, 100);
  // CODEAGENT_TEAM_FAKE_GUIDE=1: stand-in for a model that obeys the launch system prompt (R47 team guide).
  // If the --append-system-prompt-file it was launched with carries the team guide and the user asks for a team,
  // it runs the production hub-team CLI (status → accounts → propose); otherwise it answers alone.
  // No real model is involved; this only proves the guide reaches the CLI and the team path is reachable.
  function followTeamGuide(text) {
    const argv = process.argv.slice(2), at = argv.indexOf('--append-system-prompt-file');
    let system = '';
    try { system = at >= 0 ? fs.readFileSync(argv[at + 1], 'utf8') : ''; } catch { system = ''; }
    // Follow the guide literally: the company-team skill in this account's skills/, and the Hub data dir team\hub-team.cmd via PowerShell
    // (same call shape as the skill's section 0), not the source script.
    const hubData = process.env.CLAUDE_HUB_DATA_DIR || path.join(process.env.USERPROFILE || '', '.ai-hub-community');
    const teamCommand = path.join(hubData, 'team', 'hub-team.cmd');
    const skillFile = path.join(process.env.CODEAGENT3_CONFIG_DIR || '', 'skills', 'company-team', 'SKILL.md');
    let skill = '';
    try { skill = fs.readFileSync(skillFile, 'utf8'); } catch { skill = ''; }
    const record = { sid, text, systemFile: at >= 0 ? argv[at + 1] : null, guide: system.includes('## 组队指路'),
      skillFile, skillReadable: /name:\s*company-team/.test(skill), teamCommand, teamCommandExists: fs.existsSync(teamCommand), steps: [] };
    const cli = args => {
      const quoted = args.map(a => "'" + String(a).replace(/'/g, "''") + "'").join(' ');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & $env:HUB_TEAM_COMMAND ${quoted}`],
        { env: { ...process.env, HUB_TEAM_COMMAND: teamCommand }, encoding: 'utf8', timeout: 45000, windowsHide: true });
      record.steps.push({ args, code: r.status, out: String(r.stdout || '').slice(0, 4000), err: String(r.stderr || '').slice(0, 2000) });
      return r;
    };
    let answer = '没有收到组队指路，这件事我自己来做。';
    if (record.guide && record.skillReadable && record.teamCommandExists) {
      cli(['status']); cli(['accounts']);
      const planFile = path.join(dir, `${sid}.plan.json`);
      fs.writeFileSync(planFile, JSON.stringify({ goal: text.slice(0, 200), members: [
        { role: '实现', task: '按负责人的接口约定实现功能并自测', title: '实现-夹具', worktree: false },
        { role: '审查', task: '独立审查实现并给出问题清单', title: '审查-夹具', worktree: false }] }), 'utf8');
      const r = cli(['propose', '--plan-file', planFile]);
      answer = r.status === 0 ? `已按组队指路提交组队计划：${String(r.stdout || '').trim().slice(0, 300)}` : `组队计划提交失败：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`;
    }
    fs.writeFileSync(path.join(dir, `${sid}.guide.json`), JSON.stringify(record, null, 2));
    return answer;
  }
  let pending = '', typed = '', pasting = false;
  function submit() {
    const text = typed.trim(); typed = '';
    if (!text) { prompt(); return; }
    if (text === '/model') { menu(); return; }
    const uuid = randomUUID();
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId, cwd, uuid,
      timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n');
    fireHook('UserPromptSubmit', 'prompt', { prompt: text, prompt_id: uuid });
    if (stopFixture && text.includes('STOP_FIXTURE_HOLD')) {
      held = { uuid, text }; fs.writeFileSync(path.join(dir, `${sid}.held`), JSON.stringify(held));
      // A real CLI puts the live activity footer at the bottom of the current
      // screen. Draw it before its tool hook so Stop cannot race the repaint.
      process.stdout.write('\x1b[2J\x1b[H  CodeAgent (fake)\x1b[999;1H⠋ Running');
      fireHook('PreToolUse', 'tool-start', { tool_name: 'Bash', tool_use_id: 'fixture-wait-' + uuid,
        tool_input: { command: 'fixture wait for cancellation' } });
      return;
    }
    if (process.env.CODEAGENT_TEAM_FAKE_GUIDE === '1' && /组.{0,2}队/.test(text)) {
      writeAnswer(uuid, followTeamGuide(text));
      fireHook('Stop', 'stop'); prompt(); return;
    }
    writeAnswer(uuid, stopFixture && text.includes('STOP_FIXTURE_NEXT') ? 'STOP_FIXTURE_CURRENT_ANSWER' : '夹具已收到消息。');
    fireHook('Stop', 'stop');
    prompt();
  }
  process.stdin.on('data', chunk => {
    pending += chunk.toString('utf8');
    while (pending.length) {
      if (pending.startsWith('\x1b')) {
        // Synchronous hook execution may buffer both Stop keys in one chunk.
        // Count keys after parsing, rather than treating a data event as one key.
        if (stopFixture && !pasting && (pending.length === 1 || pending[1] !== '[')) {
          escapeCount++; pending = pending.slice(1); typed = ''; prompt();
          fs.writeFileSync(path.join(dir, `${sid}.escaped`), JSON.stringify({ count: escapeCount })); continue;
        }
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
